/* MASKS: Influence Lines (Hover)
 * Draws lines between the hovered CHARACTER token and all other tokens based on Influence.
 * - Green: hovered character has Influence over them
 * - Red: they have Influence over hovered character
 * - Yellow: mutual Influence
 *
 * Matching rule (per request):
 *   - Coerce to lowercase
 *   - Remove occurrences of "the", "lady", "sir"
 *   - Remove all whitespace
 *   - Check if the resulting (influence-name) is a substring of the other actor’s name(s)
 *
 * Notes:
 *   - Influence source: flags["masks-newgeneration-unofficial"].influences (array of { name, hasInfluenceOver, haveInfluenceOver })
 *   - We analyze all actor tokens present (PC or NPC) as potential targets, but trigger only when hovering a CHARACTER token.
 *   - Lines are half-opacity by default (configurable).
 */

const NS = "masks-newgeneration-extensions";

// Settings keys
const KEY_ENABLED = `${NS}.enabled`;
const KEY_REDUCED_OPACITY = `${NS}.halfOpacity`;

// Colors
// const COLOR_OUT = 0x2ecc71; // green
// const COLOR_IN  = 0xe74c3c; // red
// const COLOR_MUT = 0xf1c40f; // yellow
const COLOR_OUT = 0x26b231; // green
const COLOR_IN  = 0xce0707; // red
const COLOR_MUT = 0xee9b3a; // yellow

// Internal singleton
const InfluenceLines = {
  container: null,
  currentHoverTokenId: null,

  get enabled() {
    return game.settings.get(NS, KEY_ENABLED) === true;
  },

  get alpha() {
    return game.settings.get(NS, KEY_REDUCED_OPACITY) ? 0.25 : 0.5;
  },

  /** Ensure a drawing container exists on the current canvas */
  ensureContainer() {
    if (!canvas?.stage) return;
    // If switching scenes, clear old
    if (this.container && this.container.parent) {
      this.container.parent.removeChild(this.container);
      try { this.container.destroy({ children: true }); } catch (e) {}
      this.container = null;
    }
    this.container = new PIXI.Container();
    this.container.label = "masks-influence-links";
    this.container.eventMode = "none";
    this.container.interactiveChildren = false;
    canvas.stage.addChild(this.container);
  },

  clear() {
    if (!this.container) return;
    this.container.removeChildren().forEach(c => {
      try { c.destroy(); } catch (e) {}
    });
  },

  /** Normalize input string for comparison per requirement */
  _normalizeString(s) {
    if (!s) return "";
    return String(s)
      .toLowerCase()
      .replace(/the|lady|sir/g, "")  // remove occurrences anywhere
      .replace(/\s+/g, "");          // remove all whitespace
  },

  /** Collect a composite name-key for an actor (actor name, token name, real name) */
  _actorKeyNormalized(actor, token) {
    const bits = [];
    if (token?.document?.name) bits.push(token.document.name);
    if (actor?.name) bits.push(actor.name);
    const realName = foundry.utils.getProperty(actor, "system.attributes.realName.value");
    if (realName) bits.push(realName);
    return this._normalizeString(bits.filter(Boolean).join("|"));
  },

  /** Read influences for an actor: lists of normalized names for outgoing/incoming */
  _getInfluences(actor) {
    const arr = foundry.utils.getProperty(actor, "flags.masks-newgeneration-unofficial.influences") || [];
    // outgoing: this actor has influence over <name>
    const outgoingRaw = arr.filter(e => e?.haveInfluenceOver && e?.name).map(e => e.name);
    // incoming: <name> has influence over this actor
    const incomingRaw = arr.filter(e => e?.hasInfluenceOver && e?.name).map(e => e.name);
    const outgoing = outgoingRaw.map(n => this._normalizeString(n)).filter(Boolean);
    const incoming = incomingRaw.map(n => this._normalizeString(n)).filter(Boolean);
    return { outgoing, incoming };
  },

  /** Draw lines for current hovered token */
  drawForToken(token) {
    if (!canvas?.stage || !this.enabled) return;
    if (!token?.actor) return;

    this.clear();

    // Only trigger when hovering a CHARACTER token (not NPC)
    const type = token.actor?.type ?? token.document?.actor?.type;
    if (type !== "character") return;

    const hoveredActor = token.actor;
    const myKey = this._actorKeyNormalized(hoveredActor, token);
    const myInf = this._getInfluences(hoveredActor);

    // Gather all other visible tokens present
    const others = (canvas.tokens?.placeables ?? [])
      .filter(t => t.id !== token.id && t.visible && t.actor);

    if (!others.length) return;

    // Prepare a graphics layer
    const g = new PIXI.Graphics();
    this.container.addChild(g);

    // Keep line width roughly constant in screen pixels across zoom:
    const desiredPx = 4;
    const widthWorld = desiredPx / Math.max(0.0001, canvas.stage.scale.x);

    // For each other token, test both directions. If mutual → yellow. Else green or red.
    for (const other of others) {
      const otherActor = other.actor;
      const otherKey = this._actorKeyNormalized(otherActor, other);

      // A over B?
      const aOverB = myInf.outgoing.some(n => otherKey.includes(n));

      // B over A? (prefer reading other actor's "outgoing"; also accept our "incoming")
      const otherInf = this._getInfluences(otherActor);
      const bOverA = otherInf.outgoing.some(n => myKey.includes(n)) || myInf.incoming.some(n => otherKey.includes(n));

      let color = null;
      if (aOverB && bOverA) color = COLOR_MUT;
      else if (aOverB) color = COLOR_OUT;
      else if (bOverA) color = COLOR_IN;

      if (!color) continue;

      // Draw a line from hovered token center to the other token center
      const p1 = token.center; // world coords
      const p2 = other.center;

      g.lineStyle({ color, width: widthWorld, alpha: this.alpha, alignment: 0.5, cap: "round", join: "round" });
      g.moveTo(p1.x, p1.y);
      g.lineTo(p2.x, p2.y);

      // Optional subtle endpoints
      const endRadius = (desiredPx * 0.5) / Math.max(0.0001, canvas.stage.scale.x);
      g.beginFill(color, Math.min(this.alpha, 0.7));
      g.drawCircle(p1.x, p1.y, endRadius);
      g.drawCircle(p2.x, p2.y, endRadius);
      g.endFill();
    }
  },

  /** Re-draw if something moves while a hover is active */
  _redrawIfActive() {
    if (!this.currentHoverTokenId) return;
    const tok = canvas.tokens?.get(this.currentHoverTokenId);
    if (!tok) return this.clear();
    this.drawForToken(tok);
  }
};

// ---- Hooks & Settings ----
Hooks.once("init", () => {
  game.settings.register(NS, KEY_ENABLED, {
    name: "Influence Lines",
    hint: "Show Influence connections when hovering over a token.",
    scope: "client",        // client setting so each user can toggle
    config: true,
    type: Boolean,
    default: true,
    onChange: () => InfluenceLines.clear()
  });

  game.settings.register(NS, KEY_REDUCED_OPACITY, {
    name: "Influence Lines: Half Opacity",
    hint: "Render lines at reduced opacity so they don’t dominate the scene.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => InfluenceLines._redrawIfActive()
  });
});

Hooks.once("ready", () => {
  InfluenceLines.ensureContainer();

  // Fresh container when the canvas is ready or changes
  Hooks.on("canvasReady", () => {
    InfluenceLines.ensureContainer();
    InfluenceLines.clear();
  });

  // Hover behavior
  Hooks.on("hoverToken", (token, hovered) => {
    if (!InfluenceLines.enabled) {
      InfluenceLines.clear();
      InfluenceLines.currentHoverTokenId = null;
      return;
    }
    if (hovered) {
      InfluenceLines.currentHoverTokenId = token?.id ?? null;
      InfluenceLines.drawForToken(token);
    } else {
      if (InfluenceLines.currentHoverTokenId === token?.id) {
        InfluenceLines.currentHoverTokenId = null;
      }
      InfluenceLines.clear();
    }
  });

  // If tokens move or transform while hovering, update the lines
  Hooks.on("updateToken", () => InfluenceLines._redrawIfActive());
  Hooks.on("controlToken", () => InfluenceLines._redrawIfActive());
  Hooks.on("refreshToken", () => InfluenceLines._redrawIfActive());
  Hooks.on("deleteToken", () => InfluenceLines._redrawIfActive());
  Hooks.on("updateActor", () => InfluenceLines._redrawIfActive());
});
