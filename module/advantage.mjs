/* global Hooks, ui, canvas, game, foundry */

/**
 * forward-ongoing-tools.mjs
 * ---------------------------------------------------------------------------
 * Token tools to add/remove PbtA "Forward" and "Ongoing" resources.
 * - v13+ style injection: controls.tokens.tools["key"] = {...}
 * - Acts on the user's currently selected token(s) only.
 * - Writes only when the user can edit the token's Actor (owner or GM).
 * - Shift-click = ±5, regular click = ±1. Values are clamped to >= 0.
 *
 * Data paths (from attached actor JSON):
 *   - system.resources.forward.value
 *   - system.resources.ongoing.value
 */

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

    const path = (r) => `system.resources.${r}.value`;
    const clamp = (n) => Math.max(0, Number.isFinite(n) ? Math.floor(n) : 0);

    /** Build updates and remember before/after for summary */
    const updates = [];
    const changes = []; // {label, before, after, res}

    for (const { actor, label } of actorById.values()) {
      const before = Number(foundry.utils.getProperty(actor, path(resource)) ?? 0);
      const after = clamp(before + delta);
      if (after === before) continue;
      updates.push(actor.update({ [path(resource)]: after }));
      changes.push({ label, before, after, res: resource });
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
    const lines = changes.slice(0, 4).map(c => `• ${c.label}: ${c.before} → ${c.after}`).join("\n");
    const more = changes.length > 4 ? `\n…and ${changes.length - 4} more.` : "";
    ui.notifications?.info?.(`${resLabel(resource)} ${verb}\n${lines}${more}`);

    // No need to ping chat; keep it quiet like other quick controls.
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
    const step = 1
    ResourceTools.adjust(resource, sign * step);
  };

  addTool("forwardAdd", {
    layer: "tokens",
    name: "forwardAdd",
    title: "Add +1 Forward",
    icon: "fa-solid fa-forward",
    button: true,
    visible: true,
    onClick: withDelta("forward", +1)
  });

  addTool("ongoingAdd", {
    layer: "tokens",
    name: "ongoingAdd",
    title: "Add +1 Ongoing",
    icon: "fa-solid fa-chevrons-right",
    button: true,
    visible: true,
    onClick: withDelta("ongoing", +1)
  });

  addTool("forwardRemove", {
    layer: "tokens",
    name: "forwardRemove",
    title: "Remove 1 Forward",
    icon: "fa-solid fa-backward",
    button: true,
    visible: true,
    onClick: withDelta("forward", -1)
  });

  addTool("ongoingRemove", {
    layer: "tokens",
    name: "ongoingRemove",
    title: "Remove 1 Ongoing",
    icon: "fa-solid fa-chevrons-left",
    button: true,
    visible: true,
    onClick: withDelta("ongoing", -1)
  });
});
