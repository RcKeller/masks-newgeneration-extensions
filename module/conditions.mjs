/* global Hooks, game, foundry, ActiveEffect, canvas */
/**
 * status-fx.mjs
 * ----------------------------------------------------------------------------
 * Automatic token status icons for Masks conditions (Afraid, Angry, Guilty,
 * Hopeless, Insecure). Uses native ActiveEffects with custom `statuses` tags,
 * so they render in the token's overlay using Foundry's built-in mechanism.
 *
 * ✅ v13+ APIs only
 * ✅ Works with Characters and NPCs
 * ✅ Works with linked and unlinked tokens (synthetic Actors)
 * ✅ Permission-aware: only GM or sheet owner writes
 * ✅ Efficient: delta-based (create/delete only when needed), batched I/O,
 *    and change detection keyed specifically to the conditions path
 */

const NS = "masks-newgeneration-extensions";

/** Icons to display for each condition (paths provided by user). */
const MANAGED = Object.freeze({
  Afraid: {
    id: `${NS}-afraid`,
    name: "Afraid",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/suspicious-%23ffffff-%233da7db.svg"
  },
  Angry: {
    id: `${NS}-angry`,
    name: "Angry",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/enrage-%23ffffff-%233da7db.svg"
  },
  Guilty: {
    id: `${NS}-guilty`,
    name: "Guilty",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/liar-%23ffffff-%233da7db.svg"
  },
  Hopeless: {
    id: `${NS}-hopeless`,
    name: "Hopeless",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/dunce-cap-%23ffffff-%233da7db.svg"
  },
  Insecure: {
    id: `${NS}-insecure`,
    name: "Insecure",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/screaming-%23ffffff-%233da7db.svg"
  }
});

/** Internal: flag marker to identify effects created by this module (nice to have). */
const FX_FLAG = "autoConditionEffect";

/** Quick permission check: only GM or Actor owner should write. */
function canWrite(actor) {
  return game.user?.isGM || actor?.isOwner === true;
}

/** Robust change detector: did any nested Conditions option value change? */
function didConditionsChange(changes, basePath = "system.attributes.conditions.options") {
  const flat = foundry.utils.flattenObject(changes || {});
  // Matches "system.attributes.conditions.options" and any deeper keys under it
  for (const k of Object.keys(flat)) {
    if (k === basePath || k.startsWith(`${basePath}.`)) return true;
  }
  // Also detect TokenDocument actorData overrides (for synthetic actors)
  const tokenBase = `actorData.${basePath}`;
  for (const k of Object.keys(flat)) {
    if (k === tokenBase || k.startsWith(`${tokenBase}.`)) return true;
  }
  return false;
}

/**
 * Extract the boolean state for a given condition key ("Afraid", …) from
 * an Actor. Works with both Character and NPC examples:
 *  system.attributes.conditions.options is an object keyed "0","1",...
 *  with entries like { label: "Afraid (-2 ...)", value: false }
 */
function getConditionState(actor, condKey) {
  const opts = foundry.utils.getProperty(actor, "system.attributes.conditions.options");
  if (!opts || typeof opts !== "object") return false;

  const want = String(condKey).trim().toLowerCase();
  for (const entry of Object.values(opts)) {
    const label = String(entry?.label ?? "").toLowerCase().trim();
    // Normalize away anything in parentheses, e.g., "Afraid (-2 to engage)"
    const base = label.split("(")[0].trim();
    if (base === want) return !!entry?.value;
  }
  return false;
}

/** Return a map of current managed statusId -> ActiveEffect id present on the actor. */
function readCurrentManagedEffects(actor) {
  /** @type {Map<string,string>} */
  const map = new Map();
  if (!actor?.effects) return map;

  const managedIds = new Set(Object.values(MANAGED).map(m => m.id));
  for (const eff of actor.effects) {
    // Prefer explicit module flag; otherwise, detect by statuses membership
    const ours = eff.getFlag(NS, FX_FLAG) === true ||
                 (Array.isArray(eff.statuses) && eff.statuses.some(s => managedIds.has(s)));
    if (!ours) continue;

    // Map every managed status present on the effect (normally just one)
    for (const s of eff.statuses ?? []) {
      if (managedIds.has(s)) map.set(s, eff.id);
    }
  }
  return map;
}

/**
 * Core: compute delta and apply minimal create/delete to reflect the current
 * Conditions on the actor.
 */
async function syncConditionEffects(actor) {
  if (!actor) return;
  if (!canWrite(actor)) return;

  // Delta: what is present vs. what *should* be present
  const current = readCurrentManagedEffects(actor);
  const toCreate = [];
  const toDelete = [];

  for (const [key, def] of Object.entries(MANAGED)) {
    const shouldBeActive = getConditionState(actor, key);
    const hasNow = current.has(def.id);

    if (shouldBeActive && !hasNow) {
      toCreate.push({
        name: def.name,
        img: def.img,
        statuses: [def.id],      // tag with our unique statusId
        origin: actor.uuid,
        transfer: false,         // actor-level only; never transfer via items
        disabled: false,
        flags: { [NS]: { [FX_FLAG]: true } }
      });
    } else if (!shouldBeActive && hasNow) {
      toDelete.push(current.get(def.id));
    }
  }

  if (!toCreate.length && !toDelete.length) return; // nothing to do

  try {
    // Batch writes are efficient and minimize renders
    if (toCreate.length) {
      await ActiveEffect.create(toCreate, { parent: actor, keepId: false });
    }
    if (toDelete.length) {
      const uniqueIds = [...new Set(toDelete)];
      await actor.deleteEmbeddedDocuments("ActiveEffect", uniqueIds);
    }
  } catch (err) {
    console.error(`[${NS}] Condition effect sync failed for ${actor.name}`, err);
  }
}

/* ------------------------------------------------------------------------ */
/* Small scheduler to collapse rapid toggles into one write per Actor        */
/* ------------------------------------------------------------------------ */
const _pending = new Map(); // actor.id -> timerId

function queueSync(actor, delay = 25) {
  if (!actor) return;
  const id = actor.id ?? actor.parent?.id ?? actor.uuid;
  if (!id) return;
  if (_pending.has(id)) {
    clearTimeout(_pending.get(id));
  }
  const tid = setTimeout(async () => {
    _pending.delete(id);
    await syncConditionEffects(actor);
  }, Math.max(10, delay));
  _pending.set(id, tid);
}

/* ------------------------------------------------------------------------ */
/* Hooks                                                                     */
/* ------------------------------------------------------------------------ */

Hooks.once("ready", () => {
  // Keep in lock-step with sheet edits on ANY actor (Characters & NPCs; linked or synthetic)
  Hooks.on("updateActor", (actor, changes) => {
    if (!didConditionsChange(changes)) return;
    queueSync(actor);
  });

  // Safety net for edge paths that write Conditions through Token actorData overrides.
  Hooks.on("updateToken", (tokenDoc, changes) => {
    if (!didConditionsChange(changes)) return;
    const actor = tokenDoc?.actor;
    if (actor) queueSync(actor);
  });

  // Initial pass: sync all world actors (PCs/NPCs). Only GM runs this to avoid duplication.
  if (game.user?.isGM) {
    const tasks = [];
    for (const a of game.actors?.contents ?? []) {
      tasks.push(syncConditionEffects(a));
    }
    // Also sweep currently drawn tokens (unlinked/synthetic actors live here)
    for (const t of canvas.tokens?.placeables ?? []) {
      if (t?.actor) tasks.push(syncConditionEffects(t.actor));
    }
    Promise.allSettled(tasks).then(() =>
      console.log(`[${NS}] Initial condition icon sync complete.`)
    );
  }

  // When the canvas is (re)ready (scene swap), sweep visible tokens (covers synthetic actors)
  Hooks.on("canvasReady", () => {
    if (!game.user?.isGM) return; // keep it to a single writer
    const tasks = [];
    for (const t of canvas.tokens?.placeables ?? []) {
      if (t?.actor) tasks.push(syncConditionEffects(t.actor));
    }
    Promise.allSettled(tasks);
  });

  // New actors created during play (e.g., spawned NPCs) — GM syncs once.
  Hooks.on("createActor", (actor) => {
    if (game.user?.isGM) queueSync(actor, 1);
  });

  // New tokens dropped onto scene — GM syncs once (covers synthetic actor case).
  Hooks.on("createToken", (tokenDoc) => {
    if (!game.user?.isGM) return;
    if (tokenDoc?.actor) queueSync(tokenDoc.actor, 1);
  });
});
