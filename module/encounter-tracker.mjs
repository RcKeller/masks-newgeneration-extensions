/* global game, ui, Hooks, foundry */

/**
 * pbta-round-acted.mjs
 * ---------------------------------------------------------------------------
 * PbtA "acted this round" marker for the Combat Tracker.
 *
 * - Hover a combatant row to reveal a Font Awesome checkbox near the avatar.
 * - Clicking toggles a per-combatant flag for the *current* round.
 * - Marked combatants get the native "hide" class applied (row disappears).
 * - Marks are round-scoped: when the combat round advances, rows reappear.
 * - Works for GMs and players; players without permission GM‑relay the change.
 *
 * Storage:
 *   flags[masks-newgeneration-extensions].pbtaGoneRound = <roundNumber>
 */

(() => {
  const NS        = "masks-newgeneration-extensions";
  const SOCKET_NS = "module.masks-newgeneration-extensions";
  const FLAG_GONE = "pbtaGoneRound";
  const BTN_CLASS = "pbta-gone-toggle";

  /** Track in-flight writes to prevent rapid double-toggles. */
  const pending = new Set(); // combatantId strings

  /* ------------------------------ Utilities ------------------------------ */

  function currentCombat(app) {
    return app?.viewed ?? game.combats?.active ?? null;
  }

  function canEditCombatant(cbt) {
    return game.user?.isGM || cbt?.isOwner === true;
  }

  function isGoneThisRound(cbt, round) {
    const n = Number(cbt?.getFlag(NS, FLAG_GONE) ?? NaN);
    return Number.isFinite(n) && n === Number(round);
  }

  async function persistMark(cbt, round, gone) {
    if (!cbt) return false;
    try {
      if (gone) {
        await cbt.setFlag(NS, FLAG_GONE, Number(round));
      } else {
        await cbt.unsetFlag(NS, FLAG_GONE);
      }
      return true;
    } catch (err) {
      console.error(`[${NS}] Failed to toggle acted mark for ${cbt.name}`, err);
      ui.notifications?.error?.("Couldn’t update acted mark (see console).");
      return false;
    }
  }

  function requestGMMark({ combatId, combatantId, round, gone }) {
    try {
      game.socket?.emit(SOCKET_NS, {
        action: "pbtaMarkGone",
        combatId, combatantId, round, gone
      });
    } catch (err) {
      console.warn(`[${NS}] Socket emit failed; cannot relay acted mark.`, err);
    }
  }

  function updateRowUI(li, cbt, goneNow) {
    // Maintain Foundry's "hide" usage. Also preserve real token hidden state.
    const trulyHidden = !!cbt?.hidden;
    li.classList.toggle("hide", !!goneNow || trulyHidden);
    // Update the button icon + tooltip for current state.
    const btn = li.querySelector(`.${BTN_CLASS}`);
    if (btn) {
      btn.classList.toggle("fa-solid", !!goneNow);
      btn.classList.toggle("fa-regular", !goneNow);
      btn.classList.toggle("fa-square-check", !!goneNow);
      btn.classList.toggle("fa-square", !goneNow);
      const ttl = goneNow ? "Unmark (acted this round)" : "Mark acted this round";
      btn.title = ttl;
      btn.setAttribute("aria-label", ttl);
      btn.setAttribute("data-tooltip", ttl);
    }
  }

  /* -------------------------- DOM Decoration ----------------------------- */

  function ensureButtons(app, htmlRoot) {
    const root = Array.isArray(htmlRoot) ? htmlRoot[0] : (htmlRoot?.[0] ?? htmlRoot);
    if (!root) return;

    const combat = currentCombat(app);
    if (!combat) return;

    const items = root.querySelectorAll?.("li.combatant[data-combatant-id]") ?? [];
    for (const li of items) {
      const id = li.dataset.combatantId;
      if (!id) continue;
      const cbt = combat.combatants?.get?.(id);
      if (!cbt) continue;

      // Ensure one (and only one) overlay button exists per row.
      let btn = li.querySelector(`.${BTN_CLASS}`);
      if (!btn) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.action = "pbtaMarkGone";
        btn.className = `inline-control combatant-control icon ${BTN_CLASS} fa-regular fa-square`;
        // Insert after the avatar for a natural look; fallback to prepend.
        const img = li.querySelector(".token-image");
        if (img && img.parentElement === li) img.insertAdjacentElement("afterend", btn);
        else li.insertAdjacentElement("afterbegin", btn);
      }

      // Refresh icon + hide class for the current round.
      const gone = isGoneThisRound(cbt, combat.round);
      updateRowUI(li, cbt, gone);
    }

    // Attach a single delegated click handler per render root.
    if (!root.dataset.pbtaGoneBound) {
      root.addEventListener("click", async (ev) => {
        const target = ev.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.dataset.action !== "pbtaMarkGone") return;

        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();

        const li = target.closest?.("li.combatant[data-combatant-id]");
        const tracker = root.closest?.("#combat") ?? root;
        const appInst = app; // use the one passed to render hook

        const combat = currentCombat(appInst);
        if (!li || !combat) return;

        const id = li.dataset.combatantId;
        const cbt = combat.combatants?.get?.(id);
        if (!cbt) return;

        if (pending.has(id)) return; // ignore spam while an update is in-flight
        pending.add(id);
        target.disabled = true;
        target.setAttribute("aria-busy", "true");

        const desired = !isGoneThisRound(cbt, combat.round);

        if (canEditCombatant(cbt)) {
          const ok = await persistMark(cbt, combat.round, desired);
          if (ok) {
            // The tracker usually re-renders automatically; force a cheap refresh just in case.
            ui.combat?.render?.(false);
          }
        } else {
          requestGMMark({ combatId: combat.id, combatantId: id, round: combat.round, gone: desired });
          // We rely on updateCombatant from the GM to refresh the UI.
        }

        // Safety: clear pending if nothing arrived within a short window.
        setTimeout(() => {
          pending.delete(id);
          target.disabled = false;
          target.removeAttribute("aria-busy");
        }, 2000);
      }, { capture: true });
      root.dataset.pbtaGoneBound = "1";
    }
  }

  /* -------------------------------- Hooks -------------------------------- */

  Hooks.once("ready", () => {
    // GM socket: perform writes when relayed by players w/o permission.
    try {
      game.socket?.on(SOCKET_NS, async (data) => {
        if (!data || data.action !== "pbtaMarkGone") return;
        if (!game.user?.isGM) return;

        const { combatId, combatantId, round, gone } = data;
        const combat = game.combats?.get?.(combatId) ?? game.combats?.active;
        const cbt = combat?.combatants?.get?.(combatantId);
        if (!combat || !cbt) return;

        await persistMark(cbt, round, !!gone);
        // GM update will fan-out; no need to message back.
      });
    } catch (err) {
      console.warn(`[${NS}] Socket unavailable; acted marks require direct permission for players.`, err);
    }
  });

  Hooks.on("renderCombatTracker", (app, html /*, data */) => {
    try { ensureButtons(app, html); }
    catch (err) { console.error(`[${NS}] renderCombatTracker decorate failed`, err); }
  });

  Hooks.on("updateCombatant", (doc, changes) => {
    // If our flag or visibility changed, refresh.
    const flagChanged = foundry.utils.getProperty(changes, `flags.${NS}.${FLAG_GONE}`) !== undefined;
    const hiddenChanged = Object.prototype.hasOwnProperty.call(changes, "hidden");
    if (flagChanged || hiddenChanged) ui.combat?.render?.(false);
    // Clear any pending lock for this id.
    try {
      pending.delete(doc.id);
      // The button element will be recreated by render; nothing else to do.
    } catch (_) { /* no-op */ }
  });

  Hooks.on("updateCombat", (doc, changes) => {
    // New round ⇒ recompute acted state ⇒ rows unhide naturally.
    if (Object.prototype.hasOwnProperty.call(changes, "round")) {
      ui.combat?.render?.(false);
    }
  });

  // Keep UI consistent when the active combat changes.
  Hooks.on("deleteCombat", () => ui.combat?.render?.(false));
  Hooks.on("createCombat", () => ui.combat?.render?.(false));
})();
