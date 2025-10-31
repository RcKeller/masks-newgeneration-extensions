/* module/round-participation.mjs
   Foundry VTT v13+ — "Has Gone This Round" marker for the Combat Tracker

   What it does:
   - Adds a Font Awesome checkbox control to every combatant row in the Combat Tracker.
   - Clicking the control marks/unmarks that combatant as "has gone this round".
   - Marked combatants get the native `hide` class applied to their <li> (so they dim/grey using Foundry styles).
   - Marks are stored on the active Combat as flags, keyed by round, so everyone (GM + players) stays in sync.
   - When the round changes, marks are tracked per‑round automatically (new round = fresh list unless re-marked).
   - Works for both GMs and players: players will auto‑relay their toggle to the GM over socket if they lack write permission.

   Installation:
   - Drop this file into your module and add `"./module/round-participation.mjs"` to your module's `esmodules` list
     (or import it from an existing aggregator like `masks-extensions.mjs`).

   Notes:
   - We intentionally re-use native CSS classes and button styles: `combatant-control icon`, `inline-control`, and `hide`.
   - We do not change token visibility. Adding/removing the `hide` class here is purely a per-round UI affordance.
*/

/* global Hooks, game, ui, foundry */

const NS         = "masks-newgeneration-extensions";     // module namespace
const FLAG_KEY   = "roundParticipation";                 // Combat flag key: { [round:number]: string[] (combatantIds) }
const SOCKET_NS  = "module.masks-newgeneration-extensions"; // reuse a standard socket channel name

/** Utility: robustly get the Combat document currently shown by the tracker. */
function getViewedCombat(trackerApp) {
  // Foundry v13+ keeps the selected combat in `viewed` on the app; fall back to active combat.
  return trackerApp?.viewed ?? trackerApp?.combat ?? game.combats?.active ?? null;
}

/** Read a deep‑cloned participation map from the Combat flags. */
function readMap(combat) {
  return foundry.utils.deepClone(combat?.getFlag(NS, FLAG_KEY) || {});
}

/** Write a new participation map, attempting locally and falling back to GM relay when needed. */
async function writeMap(combat, map) {
  if (!combat) return false;

  // If we can update directly, do it.
  if (game.user?.isGM || combat.isOwner) {
    try {
      await combat.setFlag(NS, FLAG_KEY, map);
      return true;
    } catch (err) {
      console.error(`[${NS}] Failed to write participation map to Combat`, err);
      ui.notifications?.error?.("Couldn’t update round participation (see console).");
      return false;
    }
  }

  // Player fallback: relay to GM over socket.
  try {
    game.socket?.emit(SOCKET_NS, {
      action: "rbp:setMap",
      combatId: combat.id,
      map
    });
    return true;
  } catch (err) {
    console.warn(`[${NS}] Socket relay failed; participation may not sync.`, err);
    return false;
  }
}

/** Return a Set of combatant ids marked as "gone" for the provided round. */
function getGoneSetForRound(combat, round) {
  const map = readMap(combat);
  const arr = Array.isArray(map?.[round]) ? map[round] : [];
  return new Set(arr.filter(Boolean));
}

/** Save a Set back for the provided round (preserving other rounds). */
async function setGoneSetForRound(combat, round, goneSet) {
  const map = readMap(combat);
  map[round] = Array.from(goneSet);
  // (Optional) Light pruning: keep only a handful of recent rounds to avoid unbounded growth.
  const rounds = Object.keys(map).map(n => Number(n)).filter(Number.isFinite).sort((a,b)=>a-b);
  const MAX_ROUNDS_TO_KEEP = 20;
  while (rounds.length > MAX_ROUNDS_TO_KEEP) {
    const drop = String(rounds.shift());
    if (drop !== String(round)) delete map[drop];
  }
  return writeMap(combat, map);
}

/** Toggle a combatant id's participation for the current round. */
async function toggleGone(combat, combatantId) {
  if (!combat || !combatantId) return false;
  const round = Number(combat.round || 0);
  const set = getGoneSetForRound(combat, round);
  if (set.has(combatantId)) set.delete(combatantId);
  else set.add(combatantId);
  return setGoneSetForRound(combat, round, set);
}

/** Is the combatant actually hidden (GM eye‑slash)? If so, we shouldn't remove the native 'hide' class. */
function isActuallyTokenHidden(combat, combatantId) {
  try {
    const c = combat?.combatants?.get?.(combatantId);
    return !!c?.hidden;
  } catch (_e) {
    return false;
  }
}

/** Build (or update) the per‑row checkbox button and apply the 'hide' class appropriately. */
function applyRowState(combat, rowEl) {
  const li = rowEl;
  const cId = li?.dataset?.combatantId;
  if (!cId) return;

  const controls = li.querySelector(".combatant-controls");
  if (!controls) return;

  const round = Number(combat?.round || 0);
  const gone = getGoneSetForRound(combat, round).has(cId);

  // Ensure our control exists exactly once.
  let btn = controls.querySelector("button[data-action='pbtaToggleRoundGone']");
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.action = "pbtaToggleRoundGone";
    btn.className = "inline-control combatant-control icon";
    // Delegate click handler at the controls container (so re-renders don't multiply listeners)
    controls.addEventListener("click", async (ev) => {
      const target = ev.target.closest("button[data-action='pbtaToggleRoundGone']");
      if (!target) return;
      ev.stopPropagation();
      ev.preventDefault();

      const liEl = target.closest("li.combatant");
      const id = liEl?.dataset?.combatantId;
      const tracker = ui.combat; // Active tracker application
      const combatDoc = getViewedCombat(tracker?.app ?? tracker); // safe fallback
      if (!combatDoc || !id) return;

      const ok = await toggleGone(combatDoc, id);
      if (!ok) return;

      // Immediate local feedback (server echo will also re-render, but no harm).
      updateButtonAndRow(combatDoc, liEl);
    }, { passive: true });
    controls.prepend(btn); // First button to keep it easy to hit
  }

  // Apply current state to button + row (icon + tooltip + 'hide' class).
  updateButtonAndRow(combat, li);
}

/** Update button icon/tooltip and the row 'hide' class, in-place. */
function updateButtonAndRow(combat, li) {
  const cId = li?.dataset?.combatantId;
  if (!cId) return;

  const round = Number(combat?.round || 0);
  const goneSet = getGoneSetForRound(combat, round);
  const isGone = goneSet.has(cId);

  const btn = li.querySelector("button[data-action='pbtaToggleRoundGone']");
  if (btn) {
    // Reset icon classes to match native style
    btn.classList.remove("fa-regular", "fa-solid", "fa-square", "fa-square-check", "active");
    if (isGone) {
      btn.classList.add("fa-solid", "fa-square-check", "active");
      btn.setAttribute("data-tooltip", "Unmark (show again this round)");
      btn.setAttribute("aria-label", "Unmark participant this round");
    } else {
      btn.classList.add("fa-regular", "fa-square");
      btn.setAttribute("data-tooltip", "Mark as gone this round");
      btn.setAttribute("aria-label", "Mark participant as gone this round");
    }
  }

  // Only manipulate the 'hide' class for our per‑round state. If the token is actually hidden,
  // keep the native 'hide' in place regardless of our flag.
  const tokenHidden = isActuallyTokenHidden(combat, cId);
  if (isGone) {
    li.classList.add("hide");
    li.dataset.pbtaRoundGone = "true";
  } else {
    li.dataset.pbtaRoundGone = "false";
    if (!tokenHidden) {
      // Only remove if we were the reason it's there (best-effort guard)
      li.classList.remove("hide");
    }
  }
}

/** Decorate all rows in a given tracker render with our control + state. */
function decorateTracker(app, html) {
  const combat = getViewedCombat(app);
  if (!combat) return;
  const root = html?.[0] ?? html; // jQuery or HTMLElement
  if (!root) return;

  const rows = root.querySelectorAll?.("li.combatant") ?? [];
  for (const li of rows) applyRowState(combat, li);
}

/** GM-side socket handler to perform writes on behalf of players. */
function registerGMSocket() {
  try {
    game.socket?.on(SOCKET_NS, async (data) => {
      if (!data || data.action !== "rbp:setMap") return;
      if (!game.user?.isGM) return;

      const combat = game.combats?.get?.(data.combatId);
      if (!combat) return;

      const map = data.map ?? {};
      try {
        await combat.setFlag(NS, FLAG_KEY, map);
      } catch (err) {
        console.error(`[${NS}] GM relay failed to set participation map`, err);
      }
    });
  } catch (err) {
    console.warn(`[${NS}] Socket unavailable; player relays disabled.`, err);
  }
}

/* ------------------------------ Hooks Wiring ------------------------------ */

Hooks.on("renderCombatTracker", (app, html /*, data */) => {
  try { decorateTracker(app, html); }
  catch (err) { console.error(`[${NS}] Failed decorating Combat Tracker`, err); }
});

Hooks.on("updateCombat", (combat, changes) => {
  // If the round or turn advances, refresh the tracker state to reflect a new per‑round set.
  if (changes.round !== undefined || changes.turn !== undefined || changes.combatants !== undefined) {
    // Let Foundry do its re-render; this hook is just to ensure our state stays in sync
    // if we're on a custom tracker that doesn't auto-render. As a fallback, nudge the UI.
    try { ui.combat?.render?.(); } catch (_) { /* ignore */ }
  }
});

Hooks.on("updateCombatant", () => {
  try { ui.combat?.render?.(); } catch (_) { /* ignore */ }
});
Hooks.on("createCombatant", () => {
  try { ui.combat?.render?.(); } catch (_) { /* ignore */ }
});
Hooks.on("deleteCombatant", () => {
  try { ui.combat?.render?.(); } catch (_) { /* ignore */ }
});

Hooks.once("ready", () => {
  registerGMSocket();
});

export {}; // keep module scope clean
