/* global game, ui, Hooks, ChatMessage, CONST, canvas, foundry, Dialog */

/**
 * tools.mjs — Quick Influence (Scene Controls v2)
 * -----------------------------------------------------------------------------
 * Four one-click actions that do not require multi-select:
 *   • Give them influence over you  (target ⇒ you)
 *   • Gain influence over them      (you ⇒ target)
 *   • Give & receive                (mutual)
 *   • Remove both                   (clear both flags)
 *
 * Source:
 *   - If you have exactly one controlled token, that's your source.
 *   - Otherwise we use your assigned user character (actor); a token is optional.
 *
 * Target:
 *   - If you have exactly one targeted token, we use that.
 *   - Else if you hold Shift while clicking a tool, we enter a temporary
 *     "click a token" mode (works even if you can't control the token).
 *   - Otherwise we prompt with a small picker dialog listing visible tokens.
 *
 * Permissions:
 *   - We always write the side(s) you can edit.
 *   - Optionally (setting) relay to GM over socket to apply the counterpart.
 *   - If GM relay is disabled or unavailable, we rely on the symmetry sync
 *     in helpers/influence.mjs to finish the other side shortly after.
 *
 * Performance:
 *   - No global scans. Only reads/writes the two involved actors’ flags.
 */

import {
  normalize,
  candidateTokenNames,
  InfluenceIndex
} from "./helpers/influence.mjs";

const NS            = "masks-newgeneration-extensions";           // module namespace (settings)
const FLAG_SCOPE    = "masks-newgeneration-unofficial";           // where Influence arrays live
const FLAG_KEY      = "influences";
const KEY_ANNOUNCE  = "announceInfluenceChanges";                  // world setting for chat announces
const KEY_PREFER_TGT= "quickInfluencePreferTarget";                // client: use current target first
const KEY_USE_GM    = "quickInfluenceUseGMRelay";                  // world: GM-hop for counterpart
const SOCKET_NS     = "module.masks-newgeneration-extensions";     // GM relay channel

/* -------------------------------- Utilities ------------------------------- */

function readInfluences(actor) {
  return foundry.utils.deepClone(actor.getFlag(FLAG_SCOPE, FLAG_KEY) || []);
}

function pickStorageName(actor, token) {
  const cands = candidateTokenNames(actor, token);
  return cands[0] || actor?.name || token?.document?.name || "Unknown";
}

function ensureEntry(arr, nameToMatch) {
  const want = normalize(nameToMatch);
  const idx = arr.findIndex(e => normalize(e?.name) === want);
  if (idx >= 0) return { idx, obj: arr[idx] };

  const obj = {
    id: (foundry.utils.randomID?.(16) ?? Math.random().toString(36).slice(2)),
    name: nameToMatch,
    hasInfluenceOver: false,   // "they → me"
    haveInfluenceOver: false,  // "me → them"
    locked: false
  };
  arr.push(obj);
  return { idx: arr.length - 1, obj };
}

function stateSymbol(e) {
  const out = !!e?.haveInfluenceOver; // me → them
  const inn = !!e?.hasInfluenceOver;  // them → me
  if (out && inn) return "⬌";
  if (out) return "⬆";
  if (inn) return "⬇";
  return "x";
}

function canEditActor(actor) {
  return game.user?.isGM || actor?.isOwner === true;
}

async function writeInfluencesIfChanged(actor, beforeArr, afterArr) {
  // Cheap structural compare to avoid redundant writes
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

function mutateSide(inflArr, counterpartyName, which) {
  // which: "gt"|"lt"|"eq"|"reset"
  const { idx, obj } = ensureEntry(inflArr, counterpartyName);
  const prev = { has: !!obj.hasInfluenceOver, have: !!obj.haveInfluenceOver };

  if (obj.locked === true && which !== "reset") {
    return { changed: false, prev, now: prev, pruned: false };
  }

  if (which === "gt") {
    obj.haveInfluenceOver = true;      // me → them
  } else if (which === "lt") {
    obj.hasInfluenceOver = true;       // them → me
  } else if (which === "eq") {
    obj.haveInfluenceOver = true;
    obj.hasInfluenceOver = true;
  } else if (which === "reset") {
    obj.haveInfluenceOver = false;
    obj.hasInfluenceOver = false;
  }

  let pruned = false;
  if (!obj.hasInfluenceOver && !obj.haveInfluenceOver && obj.locked !== true) {
    inflArr.splice(idx, 1);
    pruned = true;
  }

  const now = { has: !!obj.hasInfluenceOver, have: !!obj.haveInfluenceOver };
  return { changed: prev.has !== now.has || prev.have !== now.have || pruned, prev, now, pruned };
}

async function announceChange(srcName, tgtName, beforeSym, afterSym) {
  if (!game.settings.get(NS, KEY_ANNOUNCE)) return;
  const who = game.user?.name ?? "Player";
  const badge = (s) => {
    const css = "display:inline-block;padding:0 .35rem;border-radius:.25rem;font-weight:700;";
    if (s === "⬆") return `<span style="${css}background:#4CAF50;color:#fff">${s}</span>`;
    if (s === "⬇") return `<span style="${css}background:#9C27B0;color:#fff">${s}</span>`;
    if (s === "⬌") return `<span style="${css}background:#2196F3;color:#fff">${s}</span>`;
    return `<span style="${css}background:#F44336;color:#fff">${s}</span>`;
  };
  let title = "Influence Change";
  switch (afterSym) {
    case "⬆": title = `${srcName} gains Influence over ${tgtName}`; break;
    case "⬇": title = `${srcName} gives Influence to ${tgtName}`; break;
    case "⬌": title = `${srcName} and ${tgtName}<br/>share Influence`; break;
    default: title = `${srcName} and ${tgtName}<br/>do not share Influence`; break;
  }
  let content = `<h6>${badge(afterSym)} ${title}</h6>`
  if (beforeSym !== "x" && beforeSym !== afterSym) content += `<b>Previous:</b> <em>${srcName}</em> ${badge(beforeSym)} <em>${tgtName}</em>`
  await ChatMessage.create({
    // content: `
    // <h6>${badge(afterSym)} ${title}</h6>
    // <b>Previous:</b> ${srcName} ${badge(beforeSym)} ${tgtName}</em>`,
    content,
    type: CONST.CHAT_MESSAGE_TYPES.OTHER
  });
}

function requestGMApply(payload) {
  try { game.socket?.emit(SOCKET_NS, payload); }
  catch (_) { /* swallow; symmetry sync is a fallback */ }
}

/* ------------------------------- Targeting -------------------------------- */

async function pickTargetViaDialog(excludeTokenId = null) {
  const toks = (canvas.tokens?.placeables ?? [])
    .filter(t => !!t.actor && t.visible && t.id !== excludeTokenId);

  if (toks.length === 0) return null;

  const options = toks.map(t => {
    
    const rn = foundry.utils.getProperty(t.actor, "system.attributes.realName.value");
    const lbl = `${t.actor?.name || t.name} (${rn || t.document?.name})`;
    return `<option value="${t.id}">${foundry.utils.escapeHTML(lbl)}</option>`;
  }).join("");

  return new Promise((resolve) => {
    const content = `
      <form>
        <p>Select a target token:</p>
        <div class="form-group">
          <label>Target</label>
          <select name="tok">${options}</select>
        </div>
      </form>`;
    // eslint-disable-next-line no-new
    new Dialog({
      title: "Choose Target",
      content,
      buttons: {
        ok: {
          label: "Use",
          callback: html => {
            const id = html[0].querySelector("select[name='tok']")?.value;
            resolve(canvas.tokens?.get(id) || null);
          }
        },
        cancel: { label: "Cancel", callback: () => resolve(null) }
      },
      default: "ok",
      close: () => resolve(null)
    }).render(true);
  });
}

async function pickTargetByClick(timeoutMs = 10000, hint = "Click a token to choose it as target…") {
  ui.notifications?.info?.(hint);
  return new Promise((resolve) => {
    let resolved = false;
    const done = (tok) => {
      if (resolved) return;
      resolved = true;
      try { Hooks.off("clickToken", handler); } catch (_) {}
      resolve(tok);
    };
    const handler = (token /*, event */) => done(token);
    Hooks.once("clickToken", handler);
    // Timeout safeguard
    setTimeout(() => done(null), Math.max(1000, timeoutMs));
  });
}

/* ------------------------------- Core Object ------------------------------ */

const QuickInfluence = {
  /**
   * Entry point for the four tools.
   * directive ∈ {"lt","gt","eq","reset"}
   * - lt   : Give them influence over you  (target ⇒ you)
   * - gt   : Gain influence over them      (you ⇒ target)
   * - eq   : Give & receive                (mutual)
   * - reset: Remove both
   */
  async run(directive, evt) {
    // 1) Resolve source (you)
    const src = await this._resolveSource();
    if (!src) return;

    // 2) Resolve target
    const preferTarget = game.settings.get(NS, KEY_PREFER_TGT) === true;
    const shiftPick    = !!evt?.shiftKey; // force one-click pick this time

    let targetToken = null;

    // Prefer exactly one targeted token if enabled
    if (preferTarget) {
      const targets = Array.from(game.user?.targets ?? []);
      if (targets.length === 1) targetToken = targets[0];
    }

    // If still none and Shift held, do a one-time click-pick
    if (!targetToken && shiftPick) {
      targetToken = await pickTargetByClick(10000);
    }

    // If still none, prompt a small picker dialog
    if (!targetToken) {
      targetToken = await pickTargetViaDialog(src.token?.id ?? null);
    }

    if (!targetToken?.actor) {
      ui.notifications?.warn?.("No target chosen.");
      return;
    }

    // 3) Apply
    await this._applyPair(src.actor, src.token, targetToken.actor, targetToken, directive);
  },

  async _resolveSource() {
    const controlled = canvas.tokens?.controlled ?? [];
    if (controlled.length === 1 && controlled[0]?.actor) {
      return { token: controlled[0], actor: controlled[0].actor };
    }

    // Use the user's assigned character as source (token optional)
    const myActor = game.user?.character;
    if (myActor) {
      const tok = (canvas.tokens?.placeables ?? []).find(t => t?.actor?.id === myActor.id) || null;
      return { token: tok ?? null, actor: myActor };
    }

    // As a last resort, try any owned token in the scene (first match)
    const owned = (canvas.tokens?.placeables ?? []).find(t => t.actor && t.actor.isOwner);
    if (owned) return { token: owned, actor: owned.actor };

    ui.notifications?.warn?.("Select your character token or set your User Character first.");
    return null;
  },

  /**
   * Core apply for a pair with a chosen directive.
   * Writes to Character sheets only; NPCs don’t store influence arrays.
   * Will GM-hop the counterpart write if configured and needed.
   */
  async _applyPair(actorA, tokA, actorB, tokB, directive) {
    const useGMRelay = game.settings.get(NS, KEY_USE_GM) === true;

    const aIsChar = actorA.type === "character";
    const bIsChar = actorB.type === "character";
    if (!aIsChar && !bIsChar) {
      ui.notifications?.warn?.("At least one side must be a Character.");
      return;
    }

    const aBefore = aIsChar ? readInfluences(actorA) : null;
    const bBefore = bIsChar ? readInfluences(actorB) : null;
    const aAfter  = aBefore ? foundry.utils.deepClone(aBefore) : null;
    const bAfter  = bBefore ? foundry.utils.deepClone(bBefore) : null;

    const nameAforB = pickStorageName(actorA, tokA);
    const nameBforA = pickStorageName(actorB, tokB);

    // Apply local mutations (mirror on B)
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
      if (directive === "gt") whichB = "lt";
      else if (directive === "lt") whichB = "gt";
      else if (directive === "eq") whichB = "eq";
      const st = mutateSide(bAfter, nameAforB, whichB);
      if (st.prev) bPrevSym = stateSymbol({ hasInfluenceOver: st.prev.has, haveInfluenceOver: st.prev.have });
      if (st.now)  bNowSym  = stateSymbol({ hasInfluenceOver: st.now.has,  haveInfluenceOver: st.now.have  });
    }

    // Attempt writes we’re allowed to do; optionally GM‑relay the rest
    const tasks = [];
    const gmPayload = { action: "applyPair", srcId: actorA.id, tgtId: actorB.id, directive };

    if (aIsChar) {
      if (canEditActor(actorA)) {
        tasks.push(writeInfluencesIfChanged(actorA, aBefore, aAfter));
      } else if (useGMRelay) {
        gmPayload.aAfter = aAfter;
      }
    }
    if (bIsChar) {
      if (canEditActor(actorB)) {
        tasks.push(writeInfluencesIfChanged(actorB, bBefore, bAfter));
      } else if (useGMRelay) {
        gmPayload.bAfter = bAfter;
      }
    }

    if (useGMRelay && ((aIsChar && !canEditActor(actorA)) || (bIsChar && !canEditActor(actorB)))) {
      requestGMApply(gmPayload);
    }

    try {
      await Promise.all(tasks);
    } catch (err) {
      console.error(`[${NS}] Failed to set Influence`, err);
      ui.notifications?.error?.("Couldn’t update Influence (see console).");
      return;
    }

    // Proactively ask helpers to sync (harmless if one side is NPC)
    try { await InfluenceIndex?.syncCharacterPairFlags?.(actorA); } catch (_) { /* no-op */ }

    // Announce (prefer the A line)
    if (aIsChar) {
      const aLabel = actorA.name ?? tokA?.document?.name ?? "A";
      await announceChange(aLabel, nameBforA, aPrevSym, aNowSym);
    } else if (bIsChar) {
      const bLabel = actorB.name ?? tokB?.document?.name ?? "B";
      await announceChange(bLabel, nameAforB, bPrevSym, bNowSym);
    }
  },

  /** GM-side socket application for counterpart writes. */
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
    const aAfter  = aIsChar ? (data.aAfter ?? aBefore) : null;
    const bAfter  = bIsChar ? (data.bAfter ?? bBefore) : null;

    const tasks = [];
    if (aIsChar && aAfter) tasks.push(writeInfluencesIfChanged(actorA, aBefore, aAfter));
    if (bIsChar && bAfter) tasks.push(writeInfluencesIfChanged(actorB, bBefore, bAfter));
    try { await Promise.all(tasks); }
    catch (err) { console.error(`[${NS}] GM relay failed`, err); }
  }
};

/* ------------------------------- Scene Controls --------------------------- */

Hooks.on("getSceneControlButtons", (controls) => {
  controls.tokens.tools.influenceGainOverThem = {
    layer: "tokens",
    name: "influenceGainOverThem",
    title: "Gain Influence over target",
    icon: "fa-solid fa-up",
    button: true,
    onClick: (evt) => QuickInfluence.run("gt", evt), // you ⇒ target
    visible: true
  }
  controls.tokens.tools.influenceMutual = {
    layer: "tokens",
    name: "influenceMutual",
    title: "Share Mutual Influence",
    icon: "fa-solid fa-left-right",
    button: true,
    onClick: (evt) => QuickInfluence.run("eq", evt), // mutual
    visible: true
  }

  controls.tokens.tools.influenceGiveThemOverYou = {
    layer: "tokens",
    name: "influenceGiveThemOverYou",
    title: "Give Influence to target",
    icon: "fa-solid fa-down",
    button: true,
    onClick: (evt) => QuickInfluence.run("lt", evt), // target ⇒ you
    visible: true
  }

  controls.tokens.tools.influenceClear = {
    layer: "tokens",
    name: "influenceClear",
    title: "Reset Influence between targets",
    icon: "fa-solid fa-rotate-left",
    button: true,
    onClick: (evt) => QuickInfluence.run("reset", evt), // clear
    visible: true
  }
});

/* ------------------------------- Hooks & Settings ------------------------- */

Hooks.once("init", () => {
  // Announce-to-chat toggle (world)
  if (!game.settings.settings.has(`${NS}.${KEY_ANNOUNCE}`)) {
    game.settings.register(NS, KEY_ANNOUNCE, {
      name: "Announce Influence changes to chat",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });
  }

  // Prefer target (client)
  if (!game.settings.settings.has(`${NS}.${KEY_PREFER_TGT}`)) {
    game.settings.register(NS, KEY_PREFER_TGT, {
      name: "Quick Influence: Prefer current target",
      hint: "If exactly one token is targeted, use it automatically as the target.",
      scope: "client",
      config: true,
      type: Boolean,
      default: true
    });
  }

  // GM relay (world)
  if (!game.settings.settings.has(`${NS}.${KEY_USE_GM}`)) {
    game.settings.register(NS, KEY_USE_GM, {
      name: "Quick Influence: Ask GM to apply counterpart",
      hint: "If you lack permission to edit the other sheet, relay the counterpart update to the GM. Disable this to only write your side and rely on symmetry sync.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });
  }
});

Hooks.once("ready", () => {
  // GM-side socket: perform counterpart writes on behalf of players
  try {
    game.socket?.on(SOCKET_NS, (data) => QuickInfluence._gmApplyFromSocket(data));
  } catch (err) {
    console.warn(`[${NS}] Socket unavailable; GM relay disabled.`, err);
  }
});
