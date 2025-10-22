/* global game, ui, Hooks, ChatMessage, CONST, renderTemplate, canvas, foundry, PIXI */

/// MASKS: Influence HUD (click-to-set > < = ⟲)
/// Standalone module that renders a small HUD right under the Team HUD.
/// - Source: scene token whose Actor is type "character" (PC only)
/// - Target: ANY scene token (PC or NPC)
/// - Buttons: > (green), < (red), = (yellow), ⟲ reset
///
/// Storage: updates sourceActor.flags["masks-newgeneration-unofficial"].influences
///   - haveInfluenceOver: source has over target  (">")
///   - hasInfluenceOver:  target has over source  ("<")
///
/// Announces to chat with old → new state (optional, default on).
///
/// This file does not modify your existing code; it mounts and manages its own root.

const NS = "masks-newgeneration-extensions";

// Reuse the same pos setting key as Team HUD so both align to the same corner.
const KEY_POSITION = "hudPosition"; // (client) "bottom-left" | "top-left" | "top-right"
// Our own settings
const KEY_ENABLED  = "influenceHudEnabled";        // (client) toggle HUD display
const KEY_ANNOUNCE = "announceInfluenceChanges";   // (world) post chat messages

const OWNER = (CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3);

// Colors (match your hover lines)
const COLOR_OUT = "#26b231"; // >
const COLOR_IN  = "#ce0707"; // <
const COLOR_MUT = "#ee9b3a"; // =

const TPL = `modules/${NS}/templates/influence-hud.html`;

const InfluenceHUD = {
  root: null,
  _srcTokenId: null,
  _tgtTokenId: null,
  _renderQueued: false,

  get _enabled() {
    return game.settings.get(NS, KEY_ENABLED) === true;
  },

  applyPosition() {
    if (!this.root) return;
    const pos = game.settings.get(NS, KEY_POSITION);
    this.root.classList.remove("pos-bottom-left", "pos-top-left", "pos-top-right");
    this.root.classList.add(`pos-${pos}`);
  },

  /** Mount under the Team HUD, if present; otherwise attach to #ui-top */
  async mount() {
    // Remove previous
    this.root?.remove();

    if (!this._enabled) return;

    const uiTop = document.getElementById("ui-bottom") ?? document.body;

    this.root = document.createElement("section");
    this.root.id = "masks-influence-hud";
    this.applyPosition();

    // Prefer directly under Team HUD if present
    const team = document.getElementById("masks-team-hud");
    if (team?.parentElement) {
      team.insertAdjacentElement("afterend", this.root);
    } else {
      uiTop.appendChild(this.root);
    }

    await this.render();
    this._registerHooks();
  },

  /** Return Token from id */
  _tok(id) { return id ? canvas.tokens?.get(id) : null; },

  /** Build select lists */
  _buildLists() {
    const placeables = canvas.tokens?.placeables ?? [];
    const pcs = placeables.filter(t => t?.actor?.type === "character");
    const all = placeables.filter(t => t?.actor);

    // Pick sensible defaults
    const ctrl = canvas.tokens?.controlled?.[0];
    if (!this._srcTokenId || !this._tok(this._srcTokenId)?.actor || this._tok(this._srcTokenId)?.actor?.type !== "character") {
      this._srcTokenId = ctrl?.actor?.type === "character" ? ctrl.id : pcs[0]?.id ?? null;
    }
    if (!this._tgtTokenId || !this._tok(this._tgtTokenId)?.actor) {
      // Prefer "not the same as source"
      this._tgtTokenId = all.find(t => t.id !== this._srcTokenId)?.id ?? null;
    }

    const toLabel = (t) => {
      const an = t.actor?.name ?? "";
      const tn = t.document?.name ?? an ?? t.name ?? "Token";
      const rn = foundry.utils.getProperty(t.actor, "system.attributes.realName.value");
      const bits = [an];
      // if (an && an !== tn) bits.push(`(${an})`);
      // if (rn && rn !== an && rn !== tn) bits.push(`— ${rn}`);
      if (rn && rn !== an && rn !== tn) bits.push(`(${rn})`);
      if (!bits.includes(tn) && !tn.includes('The')) bits.push(`@${tn}`);
      return bits.join(" ");
    };

    const sources = pcs.map(t => ({ id: t.id, label: toLabel(t), selected: t.id === this._srcTokenId }));
    const targets = all.map(t => ({ id: t.id, label: toLabel(t), selected: t.id === this._tgtTokenId }));
    const srcTok  = this._tok(this._srcTokenId);
    const canAct  = !!(srcTok?.actor?.isOwner || game.user.isGM);

    return { sources, targets, canAct };
  },

  async render() {
    if (!this.root || !this._enabled) return;

    const data = this._buildLists();

    const html = await renderTemplate(TPL, data);
    this.root.innerHTML = html;
    this._activateListeners();
  },

  _activateListeners() {
    const q = (sel) => this.root?.querySelector(sel);

    // Selects
    q("select[name='src']")?.addEventListener("change", (ev) => {
      this._srcTokenId = ev.currentTarget.value || null;
      this._queueRender();
    });

    q("select[name='tgt']")?.addEventListener("change", (ev) => {
      this._tgtTokenId = ev.currentTarget.value || null;
      this._queueRender();
    });

    // Action buttons
    ["gt", "lt", "eq", "reset"].forEach(act => {
      q(`[data-action='${act}']`)?.addEventListener("click", () => this._applyAction(act));
    });
  },

  _queueRender() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    setTimeout(async () => {
      await this.render();
      this._renderQueued = false;
    }, 10);
  },

  // ---------- Influence logic ----------

  /** Normalizer must match your hover-lines module */
  _normalizeString(s) {
    if (!s) return "";
    return String(s).toLowerCase().replace(/the|lady|sir/g, "").replace(/\s+/g, "");
  },

  /** Compose a set of candidate display names for an actor/token */
  _candidateNames(actor, token) {
    const names = [];
    if (actor?.name) names.push(actor.name);
    const rn = foundry.utils.getProperty(actor, "system.attributes.realName.value");
    if (rn) names.push(rn);
    const tn = token?.document?.name;
    if (tn) names.push(tn);
    // De-dup while preserving order
    return [...new Set(names.filter(Boolean))];
  },

  /** Fetch a deep clone of the current influences array from an actor */
  _getInfluences(actor) {
    const arr = foundry.utils.getProperty(actor, "flags.masks-newgeneration-unofficial.influences") || [];
    return foundry.utils.deepClone(arr);
  },

  _stateSymbol(entry) {
    const out = !!entry?.haveInfluenceOver;
    const inn = !!entry?.hasInfluenceOver;
    if (out && inn) return "=";
    if (out) return "&gt;";
    if (inn) return "&lt;";
    return "—";
  },

  async _applyAction(action) {
    const srcTok = this._tok(this._srcTokenId);
    const tgtTok = this._tok(this._tgtTokenId);
    const srcActor = srcTok?.actor;
    const tgtActor = tgtTok?.actor;

    if (!srcActor || !tgtActor) {
      ui.notifications?.warn?.("Pick both a source (PC) and a target (PC or NPC).");
      return;
    }
    if (!(srcActor.isOwner || game.user.isGM)) {
      ui.notifications?.warn?.("You don’t have permission to edit Influence for that character.");
      return;
    }

    // Build name matching set
    const candidates = this._candidateNames(tgtActor, tgtTok);
    const candKeys = candidates.map(n => this._normalizeString(n)).filter(Boolean);
    if (!candKeys.length) {
      ui.notifications?.warn?.("Couldn’t derive a usable name for the target to store in Influence.");
      return;
    }

    // Current influences
    const current = this._getInfluences(srcActor);
    const findIndex = () => {
      return current.findIndex(e => candKeys.includes(this._normalizeString(e?.name)));
    };

    let idx = findIndex();
    if (idx < 0 && action !== "reset") {
      // Create a new entry on demand
      current.push({
        id: (foundry.utils.randomID?.(16) ?? Math.random().toString(36).slice(2)),
        name: candidates[0],
        hasInfluenceOver: false,
        haveInfluenceOver: false,
        locked: false
      });
      idx = current.length - 1;
    }

    const beforeEntry = idx >= 0 ? foundry.utils.deepClone(current[idx]) : { hasInfluenceOver: false, haveInfluenceOver: false, name: candidates[0] };
    const before = this._stateSymbol(beforeEntry);

    // Apply
    if (idx >= 0) {
      if (current[idx].locked === true) {
        ui.notifications?.warn?.("That Influence is locked and cannot be changed.");
        return;
      }

      switch (action) {
        case "gt": current[idx].haveInfluenceOver = true; break;
        case "lt": current[idx].hasInfluenceOver = true; break;
        case "eq":
          current[idx].haveInfluenceOver = true;
          current[idx].hasInfluenceOver = true;
          break;
        case "reset":
          // If we found a matching entry, clear it; if nothing matched, nothing to reset.
          if (idx >= 0) {
            current[idx].haveInfluenceOver = false;
            current[idx].hasInfluenceOver = false;
          }
          break;
      }

      // If both false and not locked, prune the entry to keep lists tidy
      if (idx >= 0 && !current[idx].haveInfluenceOver && !current[idx].hasInfluenceOver && current[idx].locked !== true) {
        current.splice(idx, 1);
      }
    }

    // Write back to the actor flag
    try {
      await srcActor.setFlag("masks-newgeneration-unofficial", "influences", current);
      const afterEntry = (() => {
        const j = findIndex();
        return j >= 0 ? current[j] : { hasInfluenceOver: false, haveInfluenceOver: false, name: candidates[0] };
      })();
      const after = this._stateSymbol(afterEntry);

      // Announce
      if (game.settings.get(NS, KEY_ANNOUNCE)) {
        const srcName = srcActor.name ?? srcTok.document?.name ?? "Source";
        const tgtName = candidates[0] ?? tgtActor.name ?? tgtTok.document?.name ?? "Target";
        const who = game.user?.name ?? "Player";

        const badge = (s) => {
          if (s === "&gt;") return `<span style="display:inline-block;padding:0 .35rem;border-radius:.25rem;background:${COLOR_OUT};color:#fff;font-weight:700">${s}</span>`;
          if (s === "&lt;") return `<span style="display:inline-block;padding:0 .35rem;border-radius:.25rem;background:${COLOR_IN};color:#fff;font-weight:700">${s}</span>`;
          if (s === "=")    return `<span style="display:inline-block;padding:0 .35rem;border-radius:.25rem;background:${COLOR_MUT};color:#000;font-weight:700">${s}</span>`;
          return `<span style="display:inline-block;padding:0 .35rem;border-radius:.25rem;background:#666;color:#fff;font-weight:700">${s}</span>`;
        };

        await ChatMessage.create({
          content: `<b>Influence</b>: <em>${srcName}</em> ${badge(before)} <em>${tgtName}</em> → <em>${srcName}</em> ${badge(after)} <em>${tgtName}</em> <span class="color-muted">— set by ${who}</span>`,
          type: CONST.CHAT_MESSAGE_TYPES.OTHER
        });
      }
    } catch (err) {
      console.error(`[${NS}] Failed to update Influence`, err);
      ui.notifications?.error?.("Couldn’t update the Influence entry.");
    }

    // Refresh our UI
    this._queueRender();
  },

  _registerHooks() {
    // Re-render when relevant state changes
    Hooks.on("canvasReady", () => this._queueRender());
    Hooks.on("createToken", () => this._queueRender());
    Hooks.on("updateToken", () => this._queueRender());
    Hooks.on("deleteToken", () => this._queueRender());
    Hooks.on("controlToken", () => this._queueRender());
    Hooks.on("updateActor", (actor, changes) => {
      // If influences changed on our selected source, refresh
      const srcActor = this._tok(this._srcTokenId)?.actor;
      if (srcActor && actor.id === srcActor.id) {
        const flagChanged = foundry.utils.getProperty(changes, "flags.masks-newgeneration-unofficial.influences") !== undefined;
        if (flagChanged) this._queueRender();
      }
    });
  }
};

// ----- Settings & lifecycle -----
Hooks.once("init", () => {
  // Toggle HUD (client setting so each user can choose to show/hide)
  game.settings.register(NS, KEY_ENABLED, {
    name: "Influence HUD",
    hint: "Show a small Influence control bar under the Team HUD.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => InfluenceHUD.mount?.()
  });

  // Announce to chat (world)
  game.settings.register(NS, KEY_ANNOUNCE, {
    name: "Announce Influence changes to chat",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
});

Hooks.once("ready", async () => {
  await InfluenceHUD.mount();
  // Keep position in sync with the existing Team HUD setting
  Hooks.on("updateSetting", (setting) => {
    if (setting.key === `${NS}.${KEY_POSITION}`) {
      InfluenceHUD.applyPosition?.();
    }
  });
});
