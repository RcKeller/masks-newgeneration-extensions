/* global Hooks, ui, canvas, game, foundry */

/**
 * forward-ongoing-tools.mjs
 * ---------------------------------------------------------------------------
 * Token tools to add/remove PbtA "Forward" and "Ongoing" resources.
 * - v13+ style injection: controls.tokens.tools["key"] = {...}
 * - Acts on the user's currently selected token(s) only.
 * - Writes only when the user can edit the token's Actor (owner or GM).
 * - Shift-click = ±5, regular click = ±1.
 * - Clamping rules:
 *     • Ongoing is clamped to >= 0
 *     • Forward may go negative (to simulate disadvantage)
 * - Shared cap:
 *     • A world setting limits (Forward + Ongoing) to a maximum.
 *     • If you're at that shared cap and attempt to add Ongoing, the tool
 *       will *trade* 1 Forward for +1 Ongoing (repeat per step).
 *
 * Data paths (from attached actor JSON):
 *   - system.resources.forward.value
 *   - system.resources.ongoing.value
 */

const NS = "masks-newgeneration-extensions";
const KEY_SHARED_CAP = "forwardOngoingSharedCap";

// -- Settings (world)
Hooks.once("init", () => {
  if (!game.settings.settings.has?.(`${NS}.${KEY_SHARED_CAP}`)) {
    game.settings.register(NS, KEY_SHARED_CAP, {
      name: "Shared Cap: Forward + Ongoing",
      hint: "Maximum total bonus from Forward + Ongoing. When at this cap and adding Ongoing, the tool will reduce Forward by 1 for each +1 Ongoing you add.",
      scope: "world",
      config: true,
      type: Number,
      default: 3
    });
  }
});

const ResourceTools = {
  /**
   * Adjust a resource for all selected tokens.
   * @param {"forward"|"ongoing"} resource
   * @param {number} delta  positive or negative step
   */
  async adjust(resource, delta) {
    const tokens = Array.from(canvas.tokens?.controlled ?? []).filter(t => t?.actor);
    if (tokens.length === 0) {
      ui.notifications?.warn?.("Select at least one token first.");
      return;
    }

    // Deduplicate actors to avoid double writes for multiple linked tokens.
    const actorById = new Map();
    const denied = [];
    for (const t of tokens) {
      const a = t.actor;
      if (!a) continue;
      if (game.user?.isGM || a.isOwner === true) {
        if (!actorById.has(a.id)) actorById.set(a.id, { actor: a, label: a.name ?? t.document?.name ?? "Actor" });
      } else {
        denied.push(t.document?.name ?? t.name ?? a.name ?? "Token");
      }
    }

    if (actorById.size === 0) {
      ui.notifications?.warn?.("You don't have permission to edit any of the selected token(s).");
      return;
    }

    const pathF = `system.resources.forward.value`;
    const pathO = `system.resources.ongoing.value`;

    // Read setting; guard for non-number or unset
    const capRaw = Number(game.settings.get(NS, KEY_SHARED_CAP));
    const CAP = Number.isFinite(capRaw) ? Math.max(0, Math.floor(capRaw)) : 3;

    // Helpers
    const readInt = (obj, p) => Math.floor(Number(foundry.utils.getProperty(obj, p) ?? 0)) || 0;

    /**
     * Compute updated Forward/Ongoing for a single actor.
     * Rules:
     *  - Ongoing >= 0 at all times.
     *  - Forward can be negative.
     *  - Sum(F + O) may not exceed CAP.
     *  - When adding Ongoing and at CAP, convert 1 Forward -> +1 Ongoing per step.
     *  - When adding Forward and sum would exceed CAP, clamp the increase (no conversion of Ongoing).
     */
    const compute = (F, O, which, d) => {
      let f = Math.floor(F) || 0;
      let o = Math.max(0, Math.floor(O) || 0);

      if (which === "ongoing") {
        if (d > 0) {
          let steps = d;
          while (steps-- > 0) {
            if ((f + o) < CAP) {
              o += 1;
            } else {
              // At cap: trade 1 Forward for +1 Ongoing
              f -= 1;
              o += 1;
            }
          }
        } else if (d < 0) {
          o = Math.max(0, o + d);
        }
      } else {
        // which === "forward"
        if (d > 0) {
          const room = Math.max(0, CAP - (f + o));
          const add = Math.min(d, room);
          f += add;
        } else if (d < 0) {
          f += d; // allow going negative
        }
      }

      // Final guards
      o = Math.max(0, Math.floor(o));
      f = Math.floor(f);
      return { f, o };
    };

    /** Build updates and remember before/after for summary */
    const updates = [];
    const changes = []; // {label, fBefore, fAfter, oBefore, oAfter, res}

    for (const { actor, label } of actorById.values()) {
      const fBefore = readInt(actor, pathF);
      const oBefore = readInt(actor, pathO);

      const { f: fAfter, o: oAfter } = compute(fBefore, oBefore, resource, delta);

      // Only update if something actually changed
      if (fAfter === fBefore && oAfter === oBefore) continue;

      const payload = {};
      if (fAfter !== fBefore) payload[pathF] = fAfter;
      if (oAfter !== oBefore) payload[pathO] = oAfter;

      updates.push(actor.update(payload));
      changes.push({ label, fBefore, fAfter, oBefore, oAfter, res: resource });
    }

    if (updates.length === 0) {
      ui.notifications?.info?.("Nothing to change.");
      return;
    }

    try {
      await Promise.allSettled(updates);
    } catch (err) {
      console.error("[forward-ongoing-tools] Failed to update resource(s).", err);
      ui.notifications?.error?.("Couldn’t update Forward/Ongoing (see console).");
      return;
    }

    // Summarize result
    const resLabel = (r) => r === "forward" ? "Forward" : "Ongoing";
    const verb = delta > 0 ? `+${delta}` : `${delta}`;
    const lines = changes.slice(0, 4)
      .map(c => `• ${c.label}: F ${c.fBefore} → ${c.fAfter} / O ${c.oBefore} → ${c.oAfter}`)
      .join("\n");
    const more = changes.length > 4 ? `\n…and ${changes.length - 4} more.` : "";
    ui.notifications?.info?.(`${resLabel(resource)} ${verb}\n${lines}${more}`);
  }
};

/* --------------------- Scene Controls (v13+ injection) -------------------- */

Hooks.on("getSceneControlButtons", (controls) => {
  if (!controls?.tokens?.tools) return;

  const addTool = (key, def) => {
    // Avoid accidentally overwriting if another module keyed the same name
    if (!controls.tokens.tools[key]) controls.tokens.tools[key] = def;
  };

  // Helper: generate onClick using shift for ±5
  const withDelta = (resource, sign) => (evt) => {
    const step = evt?.shiftKey ? 5 : 1;
    ResourceTools.adjust(resource, sign * step);
  };

  addTool("forwardAdd", {
    layer: "tokens",
    name: "forwardAdd",
    title: "Add +1 Forward to selected token(s)",
    icon: "fa-solid fa-plus",
    button: true,
    visible: true,
    onClick: withDelta("forward", +1)
  });

  addTool("forwardRemove", {
    layer: "tokens",
    name: "forwardRemove",
    title: "Remove 1 Forward from selected token(s)",
    icon: "fa-solid fa-minus",
    button: true,
    visible: true,
    onClick: withDelta("forward", -1)
  });

  addTool("ongoingAdd", {
    layer: "tokens",
    name: "ongoingAdd",
    title: "Add +1 Ongoing to selected token(s) (trades 1 Forward if at cap)",
    icon: "fa-solid fa-layer-plus",
    button: true,
    visible: true,
    onClick: withDelta("ongoing", +1)
  });

  addTool("ongoingRemove", {
    layer: "tokens",
    name: "ongoingRemove",
    title: "Remove 1 Ongoing from selected token(s)",
    icon: "fa-solid fa-layer-minus",
    button: true,
    visible: true,
    onClick: withDelta("ongoing", -1)
  });
});
