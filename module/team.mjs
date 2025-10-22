// masks-newgeneration-extensions / team.js
/* global game, ui, Hooks, ChatMessage, CONST, renderTemplate, foundry */

const NS = "masks-newgeneration-extensions";

// Settings keys
const KEY_ALLOW_EDIT = "playersCanEdit";  // UI gate only (document permission is the real control)
const KEY_ANNOUNCE   = "announceChanges";
const KEY_POSITION   = "hudPosition";
// Used only to remember which Journal is our storage; value itself is *not* stored in settings.
const KEY_TEAM_DOCID = "teamDocId";

// Reference links (unchanged)
const LINKS = [
  { uuid: "Compendium.masks-newgeneration-unofficial.moves.Item.x3abYvFtsiDsMNQa", label: "Enter Battle as a Team" },
  { uuid: "Compendium.masks-newgeneration-unofficial.moves.Item.H7mJLUYVlQ3ZPGHK", label: "Spending Team" },
  { uuid: "Compendium.masks-newgeneration-unofficial.moves.Item.QWsQGprpNFFJz9AP", label: "Spending Team Selfishly" }
];

// ---- Internal constants
const TEAM_DOC_NAME = "MASKS • Team Pool";
const FLAG_PATH = `${NS}.team`;
const FLAG_MARKER = `${NS}.isTeamDoc`; // to mark our doc
const OWNER = (CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3);

const MasksTeamHUD = {
  root: null,
  _teamDoc: null,
  _renderQueued: false,

  // --------- Storage helpers ----------
  async _getTeamDoc({ createIfMissing = false } = {}) {
    // 1) Try by cached instance
    if (this._teamDoc && game.journal?.has(this._teamDoc.id)) return this._teamDoc;

    // 2) Try via stored id
    const storedId = game.settings.get(NS, KEY_TEAM_DOCID);
    if (storedId) {
      const found = game.journal?.get(storedId);
      if (found) return (this._teamDoc = found);
    }

    // 3) Try to locate by flag or name
    const fromFlag = game.journal?.find(j => j.getFlag(NS, "isTeamDoc") === true);
    if (fromFlag) {
      await game.settings.set(NS, KEY_TEAM_DOCID, fromFlag.id);
      return (this._teamDoc = fromFlag);
    }
    const byName = game.journal?.find(j => (j.name ?? "") === TEAM_DOC_NAME);
    if (byName) {
      // If it exists by name but isn’t marked, mark it now (GM only)
      if (game.user.isGM && byName.getFlag(NS, "isTeamDoc") !== true) {
        await byName.setFlag(NS, "isTeamDoc", true);
      }
      await game.settings.set(NS, KEY_TEAM_DOCID, byName.id);
      return (this._teamDoc = byName);
    }

    // 4) Create if requested and GM
    if (createIfMissing && game.user.isGM) {
      const data = {
        name: TEAM_DOC_NAME,
        pages: [], // no need for content; we store only in flags
        ownership: { default: OWNER }, // <-- all players are Owners of this doc
        flags: { [NS]: { isTeamDoc: true, team: 0 } }
      };
      const doc = await JournalEntry.create(data, { renderSheet: false });
      await game.settings.set(NS, KEY_TEAM_DOCID, doc.id);
      ui.notifications?.info?.("Created Team Pool journal with Owner permission for all players.");
      return (this._teamDoc = doc);
    }

    // 5) Not found and not GM: read-only until GM logs in once
    return null;
  },

  async _ensureTeamDocReady() {
    // GM ensures the doc exists and has correct permission + migrates old setting
    if (!game.user.isGM) return;

    const doc = await this._getTeamDoc({ createIfMissing: true });
    if (!doc) return;

    // Ensure default Owner for all players
    const defaultPerm = doc.ownership?.default ?? 0;
    if (defaultPerm !== OWNER) {
      await doc.update({ ownership: { ...(doc.ownership ?? {}), default: OWNER } });
    }

    // One-time migration from old world setting KEY_TEAM (if present)
    const oldSetting = Number(game.settings.get(NS, "teamPool") ?? NaN);
    const hasOld = Number.isFinite(oldSetting);
    const currentFlag = Number(doc.getFlag(NS, "team"));
    if (hasOld && Number.isFinite(currentFlag) && currentFlag === 0 && oldSetting > 0) {
      await doc.setFlag(NS, "team", oldSetting);
      // Optionally zero out legacy setting to avoid confusion
      await game.settings.set(NS, "teamPool", 0);
      console.warn(`[${NS}] Migrated Team ${oldSetting} from world setting to JournalEntry flags.`);
    }
  },

  get _canEdit() {
    // UI gate: both the setting AND the document permission must allow
    const allowBySetting = game.settings.get(NS, KEY_ALLOW_EDIT);
    return allowBySetting && (this._teamDoc?.isOwner === true);
  },

  _normalize(n) {
    const v = Number(n);
    return Math.max(0, Number.isFinite(v) ? Math.floor(v) : 0);
  },

  get team() {
    if (!this._teamDoc) return 0;
    const v = Number(this._teamDoc.getFlag(NS, "team"));
    return Number.isFinite(v) ? v : 0;
  },

  // --------- UI lifecycle ----------
  async mount() {
    // Clear previous
    this.root?.remove();

    // Create root
    const uiTop = document.getElementById("ui-top") ?? document.body;
    this.root = document.createElement("section");
    this.root.id = "masks-team";
    uiTop.appendChild(this.root);

    this.applyPosition();

    // Ensure storage (GM runs first-time setup; others proceed read-only until GM arrives)
    await this._ensureTeamDocReady();
    this._teamDoc = await this._getTeamDoc();

    // Render and wire hooks
    await this.render();
    this._registerHooks();
  },

  applyPosition() {
    if (!this.root) return;
    const pos = game.settings.get(NS, KEY_POSITION);
    this.root.classList.remove("pos-bottom-left", "pos-top-left", "pos-top-right");
    this.root.classList.add(`pos-${pos}`);
  },

  async render() {
    if (!this.root) return;

    const canEdit = this._canEdit;
    const team = this.team;

    const html = await renderTemplate(`modules/${NS}/templates/team.hbs`, {
      team,
      canEdit,
      links: LINKS
    });

    this.root.innerHTML = html;
    this.activateListeners();
  },

  activateListeners() {
    const q = (sel) => this.root?.querySelector(sel);

    // Buttons
    q("[data-action='minus']")?.addEventListener("click", (ev) => {
      const step = ev.shiftKey ? -5 : -1;
      this._change(step);
    });
    q("[data-action='plus']")?.addEventListener("click", (ev) => {
      const step = ev.shiftKey ? 5 : 1;
      this._change(step);
    });
    q("[data-action='reset']")?.addEventListener("click", () => this._set(0));

    // Manual input
    const input = q("input[name='team']");
    input?.addEventListener("change", (ev) => {
      const n = Number(ev.currentTarget.value);
      this._set(n);
    });
    input?.addEventListener("blur", (ev) => {
      ev.currentTarget.value = String(this._normalize(ev.currentTarget.value));
    });
  },

  // --------- Mutations ----------
  async _change(delta) {
    const current = this.team;
    return this._set(current + delta);
  },

  async _set(n) {
    n = this._normalize(n);

    // Ensure we know the storage doc
    this._teamDoc ??= await this._getTeamDoc();
    if (!this._teamDoc) {
      ui.notifications?.warn?.("Team Pool storage not initialized yet. A GM must open the world once.");
      return;
    }

    // UI gate + permission check
    if (!this._canEdit) {
      if (!game.settings.get(NS, KEY_ALLOW_EDIT)) {
        ui.notifications?.warn?.("Players cannot edit the Team pool right now (disabled in settings).");
      } else {
        ui.notifications?.warn?.("You don’t have permission to edit Team.");
      }
      return;
    }

    const old = this.team;
    if (n === old) return;

    // Update the flag on the JournalEntry — any Owner can do this.
    try {
      await this._teamDoc.setFlag(NS, "team", n);

      // Optional announce (only by the user who applied the change, to avoid duplicates)
      if (game.settings.get(NS, KEY_ANNOUNCE)) {
        const d = n - old;
        const sign = d > 0 ? "+" : "";
        const from = game.user?.name ?? "Player";

        await ChatMessage.create({
          content: `<b>Team Pool</b>: ${old} → <b>${n}</b> (${sign}${d}) <span class="color-muted">— set by ${from}</span>`,
          type: CONST.CHAT_MESSAGE_TYPES.OTHER
        });
      }
    } catch (err) {
      console.error(`[${NS}] Failed to set Team`, err);
      ui.notifications?.error?.("Couldn’t update the Team pool.");
    }
  },

  // --------- Live sync ----------
  _registerHooks() {
    // Re-render when the storage doc changes
    Hooks.on("updateJournalEntry", (doc, changes, opts, userId) => {
      if (!this._teamDoc || doc.id !== this._teamDoc.id) return;
      // Only re-render if our flag changed or ownership changed (affects canEdit)
      const flagChanged = foundry.utils.getProperty(changes, `flags.${NS}.team`) !== undefined;
      const ownerChanged = changes.ownership !== undefined;
      if (flagChanged || ownerChanged) this._queueRender();
    });

    Hooks.on("deleteJournalEntry", (doc) => {
      if (this._teamDoc && doc.id === this._teamDoc.id) {
        this._teamDoc = null;
        this._queueRender();
      }
    });
  },

  _queueRender() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    setTimeout(async () => {
      this._teamDoc = await this._getTeamDoc(); // refresh reference
      await this.render();
      this._renderQueued = false;
    }, 10);
  }
};

// ----- Hooks & Settings -----
Hooks.once("init", () => {
  // (Legacy) world-shared Team pool value — retained only to migrate out of it.
  // We leave it registered so existing worlds don’t error; it’s not used anymore.
  game.settings.register(NS, "teamPool", {
    name: "Team Pool (legacy)",
    hint: "Legacy storage used by older versions; automatically migrated to a shared JournalEntry.",
    scope: "world",
    config: false,
    type: Number,
    default: 0
  });

  // World setting: can players edit? (UI gate only; real control is document permission)
  game.settings.register(NS, KEY_ALLOW_EDIT, {
    name: "Players can edit Team via the HUD",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => MasksTeamHUD.render?.()
  });

  // World setting: announce to chat
  game.settings.register(NS, KEY_ANNOUNCE, {
    name: "Announce Team changes to chat",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Client setting: per-user HUD position
  game.settings.register(NS, KEY_POSITION, {
    name: "Team HUD Position (per user)",
    scope: "client",
    config: true,
    type: String,
    default: "top-right",
    choices: {
      "bottom-left": "Bottom Left",
      "top-left": "Top Left",
      "top-right": "Top Right"
    },
    onChange: () => MasksTeamHUD.applyPosition?.()
  });

  // World setting: remember our JournalEntry id
  game.settings.register(NS, KEY_TEAM_DOCID, {
    name: "Team Pool Journal Id",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });
});

Hooks.once("ready", async () => {
  await MasksTeamHUD.mount();
});
