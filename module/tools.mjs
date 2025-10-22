/* global game, ui, Hooks, ChatMessage, CONST, canvas, foundry */

/**
 * tools.mjs — Quick Influence (Scene Controls)
 * -----------------------------------------------------------------------------
 * A lightweight, toggleable control group in the Foundry Scene Controls bar
 * with two actions:
 *   • Create Influence (writes to both character sheets when applicable)
 *   • Remove Influence  (clears on both sides, prunes unlocked empties)
 *
 * Key points:
 * - No HUD, no multi-select templates; just Foundry's controls + a tiny dialog.
 * - Fuzzy name matching identical to the InfluenceIndex helpers.
 * - Writes are limited to the two involved actors (fast; no global scans).
 * - If a player can’t update the counterpart sheet, a GM socket hop is used.
 * - Symmetric updates honored whenever both sides are Characters.
 */

import {
  normalize,                 // same fuzzy logic used by InfluenceIndex
  candidateTokenNames,       // actor+token candidate display names
  InfluenceIndex             // optional use; we rely mainly on direct writes
} from "./helpers/influence.mjs";

const NS          = "masks-newgeneration-extensions";   // our module namespace (settings)
const FLAG_SCOPE  = "masks-newgeneration-unofficial";   // where Influence arrays are stored
const FLAG_KEY    = "influences";
const KEY_ANNOUNCE = "announceInfluenceChanges";        // world setting for chat announces
const SOCKET_NS   = "module.masks-newgeneration-extensions"; // GM hop channel

const OWNER = (CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3);

/* -------------------------------- Utilities ------------------------------- */

/** Read (deep-cloned) Influence array from an actor. */
function readInfluences(actor) {
  return foundry.utils.deepClone(actor.getFlag(FLAG_SCOPE, FLAG_KEY) || []);
}

/** Return a best label to store for "counterparty" names (actor+token). */
function pickStorageName(actor, token) {
  // Prefer actor.name, then realName if provided, else token display name.
  const cands = candidateTokenNames(actor, token);
  return cands[0] || actor?.name || token?.document?.name || "Unknown";
}

/** Find (or create) an influence entry by fuzzy name in an array. */
function ensureEntry(arr, nameToMatch) {
  const want = normalize(nameToMatch);
  let idx = arr.findIndex(e => normalize(e?.name) === want);
  if (idx >= 0) return { idx, obj: arr[idx] };

  const obj = {
    id: (foundry.utils.randomID?.(16) ?? Math.random().toString(36).slice(2)),
    name: nameToMatch,
    hasInfluenceOver: false,
    haveInfluenceOver: false,
    locked: false
  };
  arr.push(obj);
  return { idx: arr.length - 1, obj };
}

/** Convert flags to a compact symbol for chat. */
function stateSymbol(e) {
  const out = !!e?.haveInfluenceOver; // this actor has influence over other
  const inn = !!e?.hasInfluenceOver;  // the other has influence over this actor
  if (out && inn) return "=";
  if (out) return ">";
  if (inn) return "<";
  return "—";
}

/** Permission check: can the current user update this actor? */
function canEditActor(actor) {
  return game.user?.isGM || actor?.isOwner === true;
}

/** Compact announce helper. */
async function announceChange(srcName, tgtName, beforeSym, afterSym) {
  if (!game.settings.get(NS, KEY_ANNOUNCE)) return;
  const who = game.user?.name ?? "Player";
  const badge = (s) => {
    const css = "display:inline-block;padding:0 .35rem;border-radius:.25rem;font-weight:700;";
    if (s === ">") return `<span style="${css}background:#26b231;color:#fff">${s}</span>`;
    if (s === "<") return `<span style="${css}background:#ce0707;color:#fff">${s}</span>`;
    if (s === "=") return `<span style="${css}background:#ee9b3a;color:#000">${s}</span>`;
    return `<span style="${css}background:#666;color:#fff">${s}</span>`;
  };

  await ChatMessage.create({
    content: `<b>Influence</b>: <em>${srcName}</em> ${badge(beforeSym)} <em>${tgtName}</em> → <em>${srcName}</em> ${badge(afterSym)} <em>${tgtName}</em> <span class="color-muted">— set by ${who}</span>`,
    type: CONST.CHAT_MESSAGE_TYPES.OTHER
  });
}

/** Small direction prompt using classic Dialog (stable across v13+). */
async function promptDirection(srcLabel, tgtLabel) {
  return new Promise((resolve) => {
    const content = `
      <form class="flexcol" style="gap:.5rem">
        <p>Choose Influence direction between <b>${srcLabel}</b> and <b>${tgtLabel}</b>:</p>
        <label><input type="radio" name="dir" value="gt" checked> ${srcLabel} has Influence over ${tgtLabel} (<b>&gt;</b>)</label>
        <label><input type="radio" name="dir" value="lt"> ${tgtLabel} has Influence over ${srcLabel} (<b>&lt;</b>)</label>
        <label><input type="radio" name="dir" value="eq"> Mutual Influence (<b>=</b>)</label>
      </form>
    `;
    // eslint-disable-next-line no-new
    new Dialog({
      title: "Set Influence Direction",
      content,
      buttons: {
        ok: {
          label: "Apply",
          callback: (html) => {
            const val = html[0].querySelector("input[name='dir']:checked")?.value || "gt";
            resolve(val);
          }
        },
        cancel: { label: "Cancel", callback: () => resolve(null) }
      },
      default: "ok",
      close: () => resolve(null)
    }).render(true);
  });
}

/** Apply one side of a pair: set or clear flags for (actorA vs counterpartyName). */
function mutateSide(inflArr, counterpartyName, which) {
  // which: "gt" => this.haveInfluenceOver=true
  //        "lt" => this.hasInfluenceOver=true
  //        "eq" => both true
  //        "reset" => both false (then prune if not locked)
  const { idx, obj } = ensureEntry(inflArr, counterpartyName);
  const prev = { has: !!obj.hasInfluenceOver, have: !!obj.haveInfluenceOver };

  if (obj.locked === true && which !== "reset") {
    // Locked entries cannot be altered (other than clearing with reset if desired)
    return { changed: false, prev, now: prev, pruned: false };
  }

  if (which === "gt") {
    obj.haveInfluenceOver = true;
  } else if (which === "lt") {
    obj.hasInfluenceOver = true;
  } else if (which === "eq") {
    obj.hasInfluenceOver = true;
    obj.haveInfluenceOver = true;
  } else if (which === "reset") {
    obj.hasInfluenceOver = false;
    obj.haveInfluenceOver = false;
  }

  // Prune empty, unlocked rows
  let pruned = false;
  if (!obj.hasInfluenceOver && !obj.haveInfluenceOver && obj.locked !== true) {
    inflArr.splice(idx, 1);
    pruned = true;
  }

  const now = {
    has: !!obj.hasInfluenceOver,
    have: !!obj.haveInfluenceOver
  };

  return {
    changed: prev.has !== now.has || prev.have !== now.have || pruned,
    prev, now, pruned
  };
}

/** Write influences safely (returns boolean changed). */
async function writeInfluencesIfChanged(actor, beforeArr, afterArr) {
  // Shallow compare lengths and key bits to avoid redundant writes
  const sameLen = beforeArr.length === afterArr.length;
  let equal = sameLen;
  if (equal) {
    for (let i = 0; i < beforeArr.length; i++) {
      const a = beforeArr[i], b = afterArr[i];
      if (!a || !b) { equal = false; break; }
      if (normalize(a.name) !== normalize(b.name) ||
          !!a.hasInfluenceOver !== !!b.hasInfluenceOver ||
          !!a.haveInfluenceOver !== !!b.haveInfluenceOver ||
          !!a.locked !== !!b.locked) { equal = false; break; }
    }
  }
  if (equal) return false;

  await actor.setFlag(FLAG_SCOPE, FLAG_KEY, afterArr);
  return true;
}

/** Best‑effort GM hop for updates a non‑GM user lacks permission to perform. */
function requestGMApply(payload) {
  try {
    game.socket?.emit(SOCKET_NS, payload);
  } catch (_) {
    // If socket fails, we'll rely on the local half only.
  }
}

/* ------------------------------- Core Object ------------------------------ */

const QuickInfluence = {
  /**
   * Validate selection; return [tokA, tokB] or null.
   */
  _pairFromSelection() {
    const selected = canvas.tokens?.controlled ?? [];
    if (selected.length !== 2) {
      ui.notifications?.warn?.("Select exactly two tokens (source and target).");
      return null;
    }
    // Stable order is not guaranteed; order only matters for the direction label text.
    return [selected[0], selected[1]];
  },

  /**
   * Create (set) Influence between two selected tokens.
   * Prompts for direction; updates both character sheets when applicable.
   */
  async create() {
    const pair = this._pairFromSelection();
    if (!pair) return;

    const [tokA, tokB] = pair;
    const actorA = tokA?.actor;
    const actorB = tokB?.actor;
    if (!actorA || !actorB) {
      ui.notifications?.warn?.("Both tokens must have actors.");
      return;
    }

    const aLabel = actorA.name ?? tokA.document?.name ?? "A";
    const bLabel = actorB.name ?? tokB.document?.name ?? "B";

    const dir = await promptDirection(aLabel, bLabel);
    if (!dir) return; // cancelled

    await this._applyPair(actorA, tokA, actorB, tokB, dir);
  },

  /**
   * Remove Influence between the two selected tokens (both directions).
   */
  async remove() {
    const pair = this._pairFromSelection();
    if (!pair) return;

    const [tokA, tokB] = pair;
    const actorA = tokA?.actor;
    const actorB = tokB?.actor;
    if (!actorA || !actorB) {
      ui.notifications?.warn?.("Both tokens must have actors.");
      return;
    }

    await this._applyPair(actorA, tokA, actorB, tokB, "reset");
  },

  /**
   * Core apply for a pair with a chosen directive: "gt" | "lt" | "eq" | "reset".
   * Writes only to Character actors; NPCs don’t store Influence nodes.
   * If only one side is a Character, the single sheet is updated appropriately.
   * When the current user lacks permission for a side, ask GM over socket.
   */
  async _applyPair(actorA, tokA, actorB, tokB, directive) {
    // Decide which sub-actions to apply to each sheet
    // "gt"   => on A: have=true for B; on B (if Character): has=true for A
    // "lt"   => on A: has=true for B;  on B (if Character): have=true for A
    // "eq"   => both
    // "reset"=> both false on both sides

    const aIsChar = actorA.type === "character";
    const bIsChar = actorB.type === "character";

    if (!aIsChar && !bIsChar) {
      ui.notifications?.warn?.("At least one token must be a Character (PC).");
      return;
    }

    const aBefore = aIsChar ? readInfluences(actorA) : null;
    const bBefore = bIsChar ? readInfluences(actorB) : null;

    const aAfter = aBefore ? foundry.utils.deepClone(aBefore) : null;
    const bAfter = bBefore ? foundry.utils.deepClone(bBefore) : null;

    const nameAforB = pickStorageName(actorA, tokA);
    const nameBforA = pickStorageName(actorB, tokB);

    // Apply mutations
    let aPrevSym = "—", aNowSym = "—";
    let bPrevSym = "—", bNowSym = "—";

    if (aIsChar) {
      const whichA =
        directive === "gt" ? "gt" :
        directive === "lt" ? "lt" :
        directive === "eq" ? "eq" : "reset";
      const st = mutateSide(aAfter, nameBforA, whichA);
      if (st.prev) aPrevSym = stateSymbol({ hasInfluenceOver: st.prev.has, haveInfluenceOver: st.prev.have });
      if (st.now)  aNowSym  = stateSymbol({ hasInfluenceOver: st.now.has,  haveInfluenceOver: st.now.have  });
    }

    if (bIsChar) {
      let whichB = "reset";
      if (directive === "gt") whichB = "lt";       // mirror
      else if (directive === "lt") whichB = "gt";  // mirror
      else if (directive === "eq") whichB = "eq";
      const st = mutateSide(bAfter, nameAforB, whichB);
      if (st.prev) bPrevSym = stateSymbol({ hasInfluenceOver: st.prev.has, haveInfluenceOver: st.prev.have });
      if (st.now)  bNowSym  = stateSymbol({ hasInfluenceOver: st.now.has,  haveInfluenceOver: st.now.have  });
    }

    // Write, respecting permissions; GM-hop if needed.
    const tasks = [];
    const gmPayload = { action: "applyPair", srcId: actorA.id, tgtId: actorB.id, directive };

    if (aIsChar) {
      if (canEditActor(actorA)) {
        tasks.push(writeInfluencesIfChanged(actorA, aBefore, aAfter));
      } else {
        gmPayload.aAfter = aAfter; // include full arr so GM doesn't recompute names
      }
    }
    if (bIsChar) {
      if (canEditActor(actorB)) {
        tasks.push(writeInfluencesIfChanged(actorB, bBefore, bAfter));
      } else {
        gmPayload.bAfter = bAfter;
      }
    }

    // If there are sides we couldn't write, ask the GM to perform them.
    if ((!canEditActor(actorA) && aIsChar) || (!canEditActor(actorB) && bIsChar)) {
      requestGMApply(gmPayload);
    }

    try {
      await Promise.all(tasks);
    } catch (err) {
      console.error(`[${NS}] Failed to write Influence flags`, err);
      ui.notifications?.error?.("Couldn’t update Influence (see console).");
      return;
    }

    // Kick the InfluenceIndex to rebuild lazily via hooks; optionally ask it
    // to sync the pair immediately (harmless if one side was NPC).
    try { await InfluenceIndex?.syncCharacterPairFlags?.(actorA); } catch (_) { /* no-op */ }

    // Announce – prefer the A-line as main text; include only if at least one side changed
    if (aIsChar) {
      const aLabel = actorA.name ?? tokA.document?.name ?? "A";
      const bLabel = nameBforA ?? actorB.name ?? tokB.document?.name ?? "B";
      await announceChange(aLabel, bLabel, aPrevSym, aNowSym);
    } else if (bIsChar) {
      const bLabel = actorB.name ?? tokB.document?.name ?? "B";
      const aLabel = nameAforB ?? actorA.name ?? tokA.document?.name ?? "A";
      await announceChange(bLabel, aLabel, bPrevSym, bNowSym);
    }
  },

  /** GM-side handler for socket operations. */
  async _gmApplyFromSocket(data) {
    if (!game.user?.isGM) return;
    if (data?.action !== "applyPair") return;

    const actorA = game.actors?.get(data.srcId);
    const actorB = game.actors?.get(data.tgtId);
    if (!actorA || !actorB) return;

    const aIsChar = actorA.type === "character";
    const bIsChar = actorB.type === "character";

    const aBefore = aIsChar ? readInfluences(actorA) : null;
    const bBefore = bIsChar ? readInfluences(actorB) : null;

    // If arrays were provided by the requester, trust them; else recompute.
    const aAfter = aIsChar ? (data.aAfter ?? aBefore) : null;
    const bAfter = bIsChar ? (data.bAfter ?? bBefore) : null;

    const tasks = [];
    if (aIsChar && aAfter) tasks.push(writeInfluencesIfChanged(actorA, aBefore, aAfter));
    if (bIsChar && bAfter) tasks.push(writeInfluencesIfChanged(actorB, bBefore, bAfter));
    try {
      await Promise.all(tasks);
    } catch (err) {
      console.error(`[${NS}] GM socket apply failed`, err);
    }
  }
};

/* ------------------------------- Scene Controls --------------------------- */

// Hooks.on("getSceneControlButtons", (controls) => {
//   // Avoid duplicates if re-rendered
//   if (controls.some(c => c.name === "masksQuickInfluence")) return;

//   controls.push({
//     name: "masksQuickInfluence",
//     title: "Quick Influence",
//     icon: "fa-solid fa-people-arrows",
//     layer: "tokens",
//     visible: true,
//     tools: [
//       {
//         name: "createInfluence",
//         title: "Create Influence (updates both sheets if applicable)",
//         icon: "fa-solid fa-user-plus",
//         button: true,
//         onClick: () => QuickInfluence.create()
//       },
//       {
//         name: "removeInfluence",
//         title: "Remove Influence (clears both sides if applicable)",
//         icon: "fa-solid fa-user-minus",
//         button: true,
//         onClick: () => QuickInfluence.remove()
//       }
//     ],
//     activeTool: "createInfluence"
//   });
// });
Hooks.on("getSceneControlButtons", (controls) => {
  
  controls.tokens.tools.createInfluence = {
    name: "masksQuickInfluence",
    layer: "tokens",
    visible: true,
    name: "createInfluence",
    title: "Create Influence (updates both sheets if applicable)",
    icon: "fa-solid fa-user-plus",
    button: true,
    onClick: () => QuickInfluence.create()
  }
  controls.tokens.tools.removeInfluence = {
        name: "removeInfluence",

        layer: "tokens",
        title: "Remove Influence (clears both sides if applicable)",
        icon: "fa-solid fa-user-minus",
        button: true,
        onClick: () => QuickInfluence.remove()
      }

});

/* ------------------------------- Hooks & Settings ------------------------- */

Hooks.once("init", () => {
  // World setting: announce to chat on changes
  if (!game.settings.settings.has(`${NS}.${KEY_ANNOUNCE}`)) {
    game.settings.register(NS, KEY_ANNOUNCE, {
      name: "Announce Influence changes to chat",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });
  }
});

Hooks.once("ready", () => {
  // GM socket listener for permission escalations
  try {
    game.socket?.on(SOCKET_NS, (data) => QuickInfluence._gmApplyFromSocket(data));
  } catch (err) {
    console.warn(`[${NS}] Socket unavailable; GM-hop disabled.`, err);
  }
});
