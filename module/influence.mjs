/* global game, canvas, Hooks, PIXI, foundry */
/**
 * influence.mjs
 * ----------------------------------------------------------------------------
 * Influence Line Tracker (refactored)
 *
 * - Uses a global hash (InfluenceIndex) built from ALL character sheets.
 * - Draws lines for both PCs and NPCs on hover:
 *     • Green  : hovered has Influence over other
 *     • Red    : other has Influence over hovered
 *     • Yellow : mutual
 * - Keeps fuzzy matching exactly as requested (see helpers/influence.mjs).
 * - Efficient: single Graphics layer; constant-pixel width lines; cached keys.
 * - No reliance on per-hover actor scanning.
 *
 * Bonus: when character Influence is edited anywhere, helpers sync the
 *        opposite character's sheet entry automatically where applicable.
 */

import {
  NS,
  InfluenceIndex,
  compositeKey,
  registerInfluenceHelpers
} from "./helpers/influence.mjs";

// Settings (client)
const KEY_ENABLED = "influenceLinesEnabled";
const KEY_HALF_OPACITY = "influenceLinesHalfOpacity";

// Colors
const COLOR_OUT = 0x4CAF50; // green
const COLOR_IN  = 0x9C27B0; // red
const COLOR_MUT = 0x2196F3; // yellow

const InfluenceLines = {
  container: null,
  currentHoverTokenId: null,

  get enabled() {
    return game.settings.get(NS, KEY_ENABLED) === true;
  },

  get alpha() {
    return game.settings.get(NS, KEY_HALF_OPACITY) ? 0.25 : 0.5;
  },

  ensureContainer() {
    if (!canvas?.stage) return;

    // Replace any previous container (scene change, etc.)
    if (this.container && this.container.parent) {
      this.container.parent.removeChild(this.container);
      try { this.container.destroy({ children: true }); } catch (_) {}
      this.container = null;
    }

    this.container = new PIXI.Container();
    this.container.label = "masks-influence-lines";
    this.container.eventMode = "none";
    this.container.interactiveChildren = false;
    canvas.stage.addChild(this.container);
  },

  clear() {
    if (!this.container) return;
    this.container.removeChildren().forEach(c => { try { c.destroy(); } catch (_) {} });
  },

  /** Draw connections from hovered token to all other tokens. */
  drawFor(token) {
    if (!canvas?.stage || !this.enabled || !token?.actor) return;

    this.clear();

    // Build others list (any actor type); NPC↔NPC lines won't exist but check is cheap.
    const placeables = canvas.tokens?.placeables ?? [];
    const others = placeables.filter(t => t.id !== token.id && t.visible && t.actor);
    if (!others.length) return;

    // Prepare graphics
    const g = new PIXI.Graphics();
    this.container.addChild(g);

    // Keep line width constant in screen pixels
    const desiredPx = 4;
    const w = desiredPx / Math.max(0.0001, canvas.stage.scale.x);

    const aKey = InfluenceIndex.tokenKey(token);

    for (const other of others) {
      const bKey = InfluenceIndex.tokenKey(other);

      // From hovered -> other?
      const out = InfluenceIndex.hasEdgeFromKeyToKey(aKey, bKey);
      // other -> hovered?
      const inn = InfluenceIndex.hasEdgeFromKeyToKey(bKey, aKey);

      let color = null;
      if (out && inn) color = COLOR_MUT;
      else if (out)   color = COLOR_OUT;
      else if (inn)   color = COLOR_IN;

      if (!color) continue;

      const p1 = token.center;
      const p2 = other.center;

      g.lineStyle({ color, width: w, alpha: this.alpha, alignment: 0.5, cap: "round", join: "round" });
      g.moveTo(p1.x, p1.y);
      g.lineTo(p2.x, p2.y);

      // Subtle endpoints
      const r = (desiredPx * 0.5) / Math.max(0.0001, canvas.stage.scale.x);
      g.beginFill(color, Math.min(this.alpha, 0.7));
      g.drawCircle(p1.x, p1.y, r);
      g.drawCircle(p2.x, p2.y, r);
      g.endFill();
    }
  },

  _redrawIfActive() {
    if (!this.currentHoverTokenId) return;
    const tok = canvas.tokens?.get(this.currentHoverTokenId);
    if (!tok || !tok.actor) {
      this.clear();
      return;
    }
    this.drawFor(tok);
  }
};

/* --------------------------------- Hooks ---------------------------------- */

Hooks.once("init", () => {
  // Settings
  game.settings.register(NS, KEY_ENABLED, {
    name: "Influence Lines",
    hint: "Show Influence connections when hovering any token (PC or NPC).",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => {
      InfluenceLines.clear();
      InfluenceLines.currentHoverTokenId = null;
    }
  });

  game.settings.register(NS, KEY_HALF_OPACITY, {
    name: "Influence Lines: Half Opacity",
    hint: "Render lines at reduced opacity so they don’t dominate the scene.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => InfluenceLines._redrawIfActive()
  });

  // Ensure helpers are ready (minimal no-op, but makes intent explicit)
  registerInfluenceHelpers();
});

Hooks.once("ready", () => {
  InfluenceLines.ensureContainer();

  // Fresh container and clear caches when the canvas is ready or changes
  Hooks.on("canvasReady", () => {
    InfluenceLines.ensureContainer();
    InfluenceLines.clear();
    InfluenceIndex.invalidateAllTokens();
  });

  // Hover behavior — now works for both PCs and NPCs
  Hooks.on("hoverToken", (token, hovered) => {
    if (!InfluenceLines.enabled) {
      InfluenceLines.clear();
      InfluenceLines.currentHoverTokenId = null;
      return;
    }
    if (hovered) {
      InfluenceLines.currentHoverTokenId = token?.id ?? null;
      InfluenceLines.drawFor(token);
    } else {
      if (InfluenceLines.currentHoverTokenId === token?.id) {
        InfluenceLines.currentHoverTokenId = null;
      }
      InfluenceLines.clear();
    }
  });

  // If tokens move, transform, rename, or actors update, refresh active lines.
  Hooks.on("updateToken", (doc, changes) => {
    // If the token's name changed, invalidate its cached key.
    if (changes?.name !== undefined) InfluenceIndex.invalidateToken(doc.id);
    InfluenceLines._redrawIfActive();
  });
  Hooks.on("controlToken",   () => InfluenceLines._redrawIfActive());
  Hooks.on("refreshToken",   () => InfluenceLines._redrawIfActive());
  Hooks.on("deleteToken",    () => InfluenceLines._redrawIfActive());

  Hooks.on("updateActor", (actor, changes) => {
    // If names changed, token keys that reference this actor may need invalidation.
    const nameChanged = changes.name !== undefined ||
      foundry.utils.getProperty(changes, "system.attributes.realName.value") !== undefined;
    if (nameChanged) {
      // Invalidate all tokens of this actor on the current scene
      for (const t of (canvas.tokens?.placeables ?? [])) {
        if (t?.actor?.id === actor.id) InfluenceIndex.invalidateToken(t.id);
      }
    }
    // Edges map is rebuilt inside the helpers when relevant; just re-draw if active
    InfluenceLines._redrawIfActive();
  });
});
