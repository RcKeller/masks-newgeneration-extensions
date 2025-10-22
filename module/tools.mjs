/* MASKS: Influence Tools (Drag-to-Edit)
 * Adds two toggle tools to the Token controls:
 * - Influence+ (toggle): drag A → B to toggle A has Influence over B. Shift = toggle mutual (both ways).
 * - Influence− (toggle): drag A → B to remove A has Influence over B. Shift = remove mutual.
 *
 * Storage model (unchanged, per Players.txt):
 *   flags["masks-newgeneration-unofficial"].influences = Array<{ id?, name, haveInfluenceOver?, hasInfluenceOver?, locked? }>
 *
 * Chat announces show old/new states for A→B and B→A.
 *
 * Safe by permissions: updates the side you can write; attempts to update the mirrored side too.
 */

/* global game, ui, Hooks, canvas, ChatMessage, CONST, foundry, PIXI */

(() => {
  'use strict';

  const NS = "masks-newgeneration-extensions";
  const FLAG_NS = "masks-newgeneration-unofficial";
  const FLAG_KEY = "influences";

  // ---- Settings keys
  const KEY_TOOL_ENABLED   = "influenceToolsEnabled";       // world
  const KEY_ALLOW_PLAYERS  = "playersCanEditInfluence";     // world
  const KEY_ANNOUNCE_CHAT  = "announceInfluenceChanges";    // world
  const KEY_ONLY_CHAR_SRC  = "influenceOnlyCharacters";     // client

  // ---- Colors
  const COLOR_DRAG = 0xee9b3a; // same yellow used for mutual in hover-lines

  // ---- Utility: string normalization for matching ("the", "lady", "sir", whitespace removed; lowercase)
  function normalizeString(s) {
    if (!s) return "";
    return String(s).toLowerCase().replace(/the|lady|sir/g, "").replace(/\s+/g, "");
  }

  // Build a composite, match-friendly key for an actor/token
  function actorKeyNormalized(actor, token) {
    const bits = [];
    if (token?.document?.name) bits.push(token.document.name);
    if (actor?.name) bits.push(actor.name);
    const realName = foundry.utils.getProperty(actor, "system.attributes.realName.value");
    if (realName) bits.push(realName);
    return normalizeString(bits.filter(Boolean).join("|"));
  }

  // Canonical pretty-name we store in 'name' for influence entries
  function canonicalStoreNameForActor(actor, token) {
    // Prefer token name if present, else actor name; keep pretty cased for display
    return token?.document?.name || actor?.name || "";
  }

  function getInfluenceArray(actor) {
    return (foundry.utils.getProperty(actor, `flags.${FLAG_NS}.${FLAG_KEY}`) ?? []).slice();
  }

  function findByNormalizedName(arr, targetNorm) {
    if (!targetNorm) return null;
    for (const e of arr) {
      const n = normalizeString(e?.name ?? "");
      if (n && n.includes(targetNorm)) return e;
    }
    return null;
  }

  async function saveInfluences(actor, arr) {
    return actor.setFlag(FLAG_NS, FLAG_KEY, arr);
  }

  // Compute pair state booleans (A over B, B over A)
  function readPairState(actorA, actorB, tokA, tokB) {
    const arrA = getInfluenceArray(actorA);
    const arrB = getInfluenceArray(actorB);
    const keyA = actorKeyNormalized(actorA, tokA);
    const keyB = actorKeyNormalized(actorB, tokB);

    const entryA = findByNormalizedName(arrA, keyB);
    const entryB = findByNormalizedName(arrB, keyA);

    const aOverB = entryA?.haveInfluenceOver === true;
    const bOverA = entryB?.haveInfluenceOver === true;
    return { aOverB, bOverA };
  }

  // Apply a single-direction change "A has Influence over B" -> boolean newValue
  async function setAOverB(actorA, actorB, tokA, tokB, newValue) {
    const arrA = getInfluenceArray(actorA);
    const arrB = getInfluenceArray(actorB);

    const keyA = actorKeyNormalized(actorA, tokA);
    const keyB = actorKeyNormalized(actorB, tokB);
    const storeB = canonicalStoreNameForActor(actorB, tokB);
    const storeA = canonicalStoreNameForActor(actorA, tokA);

    let aChanged = false, bChanged = false;

    // On A: haveInfluenceOver about B
    let aEntry = findByNormalizedName(arrA, keyB);
    if (!aEntry) {
      aEntry = { id: foundry.utils.randomID?.(16) ?? crypto.randomUUID?.() ?? Math.random().toString(36).slice(2), name: storeB, haveInfluenceOver: !!newValue };
      arrA.push(aEntry);
      aChanged = true;
    } else if ((aEntry.haveInfluenceOver ?? false) !== !!newValue) {
      aEntry.haveInfluenceOver = !!newValue;
      aChanged = true;
    }

    // Clean A entry if both flags false → remove it to keep tidy
    if (aEntry && aEntry.haveInfluenceOver !== true && aEntry.hasInfluenceOver !== true) {
      const idx = arrA.indexOf(aEntry);
      if (idx >= 0) { arrA.splice(idx, 1); aChanged = true; }
    }

    // On B: hasInfluenceOver about A (mirrored)
    let bEntry = findByNormalizedName(arrB, keyA);
    if (!bEntry) {
      if (newValue) {
        bEntry = { id: foundry.utils.randomID?.(16) ?? crypto.randomUUID?.() ?? Math.random().toString(36).slice(2), name: storeA, hasInfluenceOver: true };
        arrB.push(bEntry);
        bChanged = true;
      }
    } else if ((bEntry.hasInfluenceOver ?? false) !== !!newValue) {
      bEntry.hasInfluenceOver = !!newValue;
      bChanged = true;
    }

    if (bEntry && bEntry.haveInfluenceOver !== true && bEntry.hasInfluenceOver !== true) {
      const idx = arrB.indexOf(bEntry);
      if (idx >= 0) { arrB.splice(idx, 1); bChanged = true; }
    }

    let errors = [];
    if (aChanged) {
      try { await saveInfluences(actorA, arrA); } catch (e) { errors.push(`Couldn’t update ${actorA.name}`); }
    }
    if (bChanged) {
      try { await saveInfluences(actorB, arrB); } catch (e) { errors.push(`Couldn’t update ${actorB.name}`); }
    }
    return errors;
  }

  async function announceChange(actorA, actorB, tokA, tokB, before, after, partial) {
    if (!game.settings.get(NS, KEY_ANNOUNCE_CHAT)) return;
    const from = game.user?.name ?? "Player";

    const as = (v) => v ? "✓" : "—";
    const deltaA = (before.aOverB === after.aOverB) ? "" : ` (${after.aOverB ? "+A→B" : "−A→B"})`;
    const deltaB = (before.bOverA === after.bOverA) ? "" : ` (${after.bOverA ? "+B→A" : "−B→A"})`;
    const partialNote = partial ? ` <em class="color-muted">(partial: lacking permission to update one side)</em>` : "";

    const content = `
      <b>Influence</b> changed by <b>${foundry.utils.escapeHTML(from)}</b><br/>
      <div>
        <b>${foundry.utils.escapeHTML(tokA?.document?.name || actorA.name)}</b> ⇄
        <b>${foundry.utils.escapeHTML(tokB?.document?.name || actorB.name)}</b>
      </div>
      <div>
        <span style="color:#26b231">A→B</span>: ${as(before.aOverB)} → <b>${as(after.aOverB)}</b>${deltaA}<br/>
        <span style="color:#ce0707">B→A</span>: ${as(before.bOverA)} → <b>${as(after.bOverA)}</b>${deltaB}
      </div>${partialNote}
    `;

    await ChatMessage.create({ content, type: CONST.CHAT_MESSAGE_TYPES.OTHER });
  }

  // ---- Drag tool runtime
  const InfluenceDrag = {
    _mode: null, // "add" | "remove" | null
    _active: false,
    _source: null,
    _sourceToken: null,
    _graphics: null,
    _helpRoot: null,

    get isEnabled() {
      return game?.settings?.get(NS, KEY_TOOL_ENABLED) === true;
    },

    _cursor(on) {
      document.body.classList.toggle("masks-influence-cursor", !!on);
    },

    _mountHelp() {
      // Render a tiny inline tip HUD while active
      if (this._helpRoot) return;
      const uiTop = document.getElementById("ui-top") ?? document.body;
      const el = document.createElement("section");
      el.id = "masks-influence-help";
      uiTop.appendChild(el);
      fetch(`modules/${NS}/templates/influence-help.html`)
        .then(r => r.text())
        .then(html => { el.innerHTML = html; })
        .catch(() => { el.innerHTML = `<div class="panel faded-ui"><span class="tag">Influence</span><span>Drag from a token to another. <b>Shift</b>=mutual.</span></div>`; });
      this._helpRoot = el;
    },

    _unmountHelp() {
      this._helpRoot?.remove();
      this._helpRoot = null;
    },

    activate(mode) {
      if (!this.isEnabled) return;
      this._mode = mode; // "add" | "remove"
      this._active = true;
      this._cursor(true);
      this._mountHelp();

      // Drawing container
      if (!this._graphics) {
        this._graphics = new PIXI.Graphics();
        this._graphics.label = "masks-influence-drag";
        this._graphics.eventMode = "none";
        canvas.stage.addChild(this._graphics);
      }

      // Listeners
      canvas.stage.on("pointerdown", this._onDown, this);
      canvas.stage.on("pointermove", this._onMove, this);
      canvas.stage.on("pointerup", this._onUp, this);
      canvas.stage.on("rightdown", this.deactivate, this);
    },

    deactivate() {
      this._active = false;
      this._mode = null;
      this._source = null;
      this._sourceToken = null;
      this._graphics?.clear();
      if (this._graphics && this._graphics.parent) this._graphics.parent.removeChild(this._graphics);
      try { this._graphics?.destroy(); } catch (_) {}
      this._graphics = null;

      canvas.stage.off("pointerdown", this._onDown, this);
      canvas.stage.off("pointermove", this._onMove, this);
      canvas.stage.off("pointerup", this._onUp, this);
      canvas.stage.off("rightdown", this.deactivate, this);

      this._cursor(false);
      this._unmountHelp();
    },

    _screenToWorld(ev) {
      return ev.data.getLocalPosition(canvas.app.stage);
    },

    _tokenAt(world) {
      const arr = (canvas.tokens?.placeables ?? []).slice().reverse(); // top-most first
      return arr.find(t => t.bounds?.contains(world.x, world.y));
    },

    _onDown(ev) {
      if (!this._active || ev?.data?.button !== 0) return;
      const world = this._screenToWorld(ev);
      const tok = this._tokenAt(world);
      if (!tok?.actor) return;

      // Only allow character sources (client pref), unless GM
      const onlyChars = game.settings.get(NS, KEY_ONLY_CHAR_SRC);
      const type = tok.actor?.type ?? tok.document?.actor?.type;
      if (!game.user.isGM && onlyChars && type !== "character") {
        ui.notifications?.warn?.("Influence tool: only character tokens can be the source (see client setting).");
        return;
      }

      // Permission gate for players
      if (!game.user.isGM && !game.settings.get(NS, KEY_ALLOW_PLAYERS)) {
        ui.notifications?.warn?.("Players cannot edit Influence right now (disabled in settings).");
        return;
      }

      this._source = tok.actor;
      this._sourceToken = tok;
      this._graphics?.clear();
      ev.stopPropagation();
    },

    _onMove(ev) {
      if (!this._active || !this._source) return;
      const g = this._graphics;
      g.clear();

      const p1 = this._sourceToken.center;
      const p2 = this._screenToWorld(ev);

      const desiredPx = 3;
      const widthWorld = desiredPx / Math.max(0.0001, canvas.stage.scale.x);

      g.lineStyle({ color: COLOR_DRAG, width: widthWorld, alpha: 0.6, cap: "round", join: "round" });
      g.moveTo(p1.x, p1.y);
      g.lineTo(p2.x, p2.y);

      const endR = (desiredPx * 0.6) / Math.max(0.0001, canvas.stage.scale.x);
      g.beginFill(COLOR_DRAG, 0.6);
      g.drawCircle(p1.x, p1.y, endR);
      g.endFill();
    },

    async _onUp(ev) {
      if (!this._active || !this._source) return;
      const tokA = this._sourceToken;
      const actorA = this._source;

      const world = this._screenToWorld(ev);
      const tokB = this._tokenAt(world);
      const actorB = tokB?.actor;

      this._graphics?.clear();

      if (!actorB || tokB?.id === tokA?.id) {
        // Cancel quietly
        this._source = null;
        this._sourceToken = null;
        return;
      }

      // Compute before state
      const before = readPairState(actorA, actorB, tokA, tokB);

      const mutual = ev?.data?.originalEvent?.shiftKey === true;
      let partial = false;

      // Apply direction A→B
      if (this._mode === "add") {
        const toggled = !before.aOverB;
        const errs = await setAOverB(actorA, actorB, tokA, tokB, toggled);
        partial ||= errs.length > 0;
      } else if (this._mode === "remove") {
        const errs = await setAOverB(actorA, actorB, tokA, tokB, false);
        partial ||= errs.length > 0;
      }

      // Mutual second direction B→A
      if (mutual) {
        if (this._mode === "add") {
          const toggledBA = !before.bOverA;
          const errs2 = await setAOverB(actorB, actorA, tokB, tokA, toggledBA);
          partial ||= errs2.length > 0;
        } else if (this._mode === "remove") {
          const errs2 = await setAOverB(actorB, actorA, tokB, tokA, false);
          partial ||= errs2.length > 0;
        }
      }

      const after = readPairState(actorA, actorB, tokA, tokB);
      await announceChange(actorA, actorB, tokA, tokB, before, after, partial);

      // Reset for next drag
      this._source = null;
      this._sourceToken = null;
    }
  };

  // ---- Scene controls integration
  function injectControls(controls) {
    if (!game.settings.get(NS, KEY_TOOL_ENABLED)) return;

    const tokenCtl = controls.find(c => c.name === "token");
    if (!tokenCtl) return;

    // A tiny local helper to toggle tool state and set up runtime
    const makeTool = (name, title, icon, mode) => ({
      name,
      title,
      icon,
      toggle: true,
      active: false,
      visible: true,
      onClick: (active) => {
        // deactivate previous, then activate if requested
        InfluenceDrag.deactivate();
        tokenCtl.tools?.forEach(t => { if (t.name.startsWith("masks-influence-")) t.active = false; });
        if (active) {
          // Players gate (world setting)
          if (!game.user.isGM && !game.settings.get(NS, KEY_ALLOW_PLAYERS)) {
            ui.notifications?.warn?.("Players cannot edit Influence right now (disabled in settings).");
            return;
          }
          InfluenceDrag.activate(mode);
        }
      }
    });

    tokenCtl.tools.push(
      makeTool("masks-influence-add", "Influence+ (drag to toggle; Shift for mutual)", "fas fa-link", "add"),
      makeTool("masks-influence-remove", "Influence− (drag to remove; Shift removes mutual)", "fas fa-unlink", "remove")
    );
  }

  // ---- Settings & Hooks
  Hooks.once("init", () => {
    game.settings.register(NS, KEY_TOOL_ENABLED, {
      name: "Enable Influence Tools (drag-to-edit)",
      hint: "Adds Influence+ and Influence− tools to the Token controls. Toggle to drag from one token to another.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      onChange: () => ui.controls?.initialize()
    });

    game.settings.register(NS, KEY_ALLOW_PLAYERS, {
      name: "Players can edit Influence",
      hint: "If disabled, only the GM can use the Influence tools.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(NS, KEY_ANNOUNCE_CHAT, {
      name: "Announce Influence changes to chat",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(NS, KEY_ONLY_CHAR_SRC, {
      name: "Influence Tools: Only allow characters as drag source (per user)",
      scope: "client",
      config: true,
      type: Boolean,
      default: true
    });
  });

  Hooks.on("getSceneControlButtons", injectControls);

  Hooks.on("canvasReady", () => {
    // Safety: if the scene reloads while active, ensure we don't leave listeners behind
    InfluenceDrag.deactivate();
  });
})();
