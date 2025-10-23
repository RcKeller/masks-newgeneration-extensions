/* global Hooks, game, foundry, ChatMessage, CONST, ui */

/**
 * XCard — GM/Table Whisper Button (configurable)
 * ----------------------------------------------------------------------------
 * Inserts a Foundry-styled button between #roll-privacy and .control-buttons
 * in the chat controls. Clicking it will:
 *   1) Perform a user-configurable trigger behavior (see setting below):
 *        • (default) Anonymously inform the table
 *        • Anonymously ping the GMs
 *        • Directly inform the GMs (not anonymous)
 *        • Only start composing a whisper to the GM (not anonymous)
 *   2) Always proceed with the original behavior by focusing the chat textarea
 *      and ensuring it begins with "/w GM " so the player can explain if desired.
 *
 * Settings:
 *   - (client) masks-newgeneration-extensions.xcardTriggerMode
 *       String select with the four behaviors above (per-user).
 *
 * Backward compatibility:
 *   - (world) masks-newgeneration-extensions.xcardNotifyGMOnClick (Boolean)
 *       Legacy toggle to send the anonymous GM ping. It is kept registered
 *       (config: false) to avoid errors in existing worlds, but it is no longer
 *       consulted — the new client select controls behavior now.
 */

const NS = "masks-newgeneration-extensions";
const TEMPLATE_PATH = `modules/${NS}/templates/xcard.hbs`;

// --- Settings (new + legacy/deprecated) ---
const KEY_XCARD_MODE = "xcardTriggerMode";         // client select: user-configurable mode
const KEY_NOTIFY_GM  = "xcardNotifyGMOnClick";     // legacy (deprecated; config: false)

// Socket channel for anonymous relays
const SOCKET_NS = "module.masks-newgeneration-extensions";

const XCARD_TITLE = "🛑 X‑Card has been played"

// Enumerated modes (persisted as strings)
const XMODES = Object.freeze({
  TABLE_ANON:  "table-anon",   // Anonymously inform the table
  GM_ANON:     "gm-anon",      // Anonymously ping the GMs
  GM_DIRECT:   "gm-direct",    // Directly inform the GMs (not anonymous)
  COMPOSE:     "compose"       // Only start composing a whisper to the GM
});

/** Normalize the message to start with "/w GM " */
function ensureWhisperToGM(text) {
  const prefix = "/w GM ";
  if (text.startsWith(prefix)) return text;
  const whisperAtStart = /^\/w\s+\S+\s+/i; // replace any "/w <target> "
  return whisperAtStart.test(text) ? text.replace(whisperAtStart, prefix) : prefix + text;
}

/** Render a Handlebars template using the v13+ API (falls back to legacy if present). */
async function renderTpl(path, data) {
  const fn =
    foundry?.applications?.handlebars?.renderTemplate ??
    // Legacy (deprecated) fallback for older worlds; removed in v15
    (typeof window.renderTemplate === "function" ? window.renderTemplate : null);

  if (!fn) throw new Error("renderTemplate is not available in this environment.");
  return fn(path, data);
}

/* ----------------------------- GM & User Helpers --------------------------- */

/** Return an array of active GM user IDs (falls back to all GMs if "active" is unavailable). */
function getGMUserIds() {
  try {
    // Preferred Foundry helper to fetch GM recipients.
    const users = ChatMessage.getWhisperRecipients("GM");
    // If Foundry returns User documents, map to ids.
    if (Array.isArray(users) && users.length && users[0]?.id) return users.map(u => u.id);
  } catch (_) { /* ignore; fall through to manual */ }

  // Manual fallback
  const list = (game.users?.contents ?? game.users ?? []);
  return list.filter((u) => u?.isGM).map((u) => u.id);
}

/** Best‑effort "primary GM" selection so only one GM creates the socket message. */
function isPrimaryGM() {
  const gms = (game.users?.contents ?? game.users ?? []).filter(u => u?.isGM && u?.active);
  if (!gms.length) return game.user?.isGM === true; // single‑GM or offline fallback
  // Stable order by id to avoid multiple GMs acting at once.
  gms.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return gms[0]?.id === game.user?.id;
}

/* ----------------------------- Content Builders ---------------------------- */

function buildAnonContent(scope /* "gm" | "table" */) {
  const target = scope === "gm" ? "GM" : "table";
  return `
    <em class="color-muted">This is an anonymous safety ping to the ${target}.</em>
  `;
}

function buildDirectGMContent() {
  return `
    <p><b>${XCARD_TITLE}</b></p>
    <em class="color-muted">The sender may optionally whisper the GM to provide details.</em>
  `;
}

/* --------------------------- Dispatching / Delivery ------------------------ */

/**
 * Send a *public* anonymous X‑Card alert to the whole table.
 * Implementation prefers GM-socket relay (to hide initiator), with a local fallback.
 */
async function notifyTableAnon() {
  const content = buildAnonContent("table");

  const canSocket = !!game.socket;
  const hasActiveGM = (game.users?.some?.(u => u?.isGM && u?.active) === true);

  // Prefer GM relay for anonymity
  if (canSocket && hasActiveGM) {
    try {
      game.socket.emit(SOCKET_NS, { action: "xcardNotify", scope: "table", content });
      return;
    } catch (err) {
      console.warn(`[${NS}] Socket emit failed; falling back to local table message.`, err);
    }
  }

  // Fallback: create a public message locally (visible to everyone).
  try {
    await ChatMessage.create({
      content,
      type: CONST.CHAT_MESSAGE_TYPES.OTHER,
      speaker: { alias: XCARD_TITLE }
    });
  } catch (err) {
    console.error(`[${NS}] Failed to send X‑Card alert to the table.`, err);
    ui.notifications?.error?.("Couldn’t send the X‑Card alert to the table (see console).");
  }
}

/**
 * Send an *anonymous* X‑Card alert to all GMs.
 * Tries to route via socket so a GM client creates the message (hiding who clicked).
 * Falls back to creating a local GM‑whisper if sockets/GM are unavailable.
 */
async function notifyGMAnon() {
  const content = buildAnonContent("gm");

  // If any active GM exists and we have sockets, broadcast a relay request.
  const hasActiveGM = (game.users?.some?.(u => u?.isGM && u?.active) === true);
  const canSocket = !!game.socket;
  if (hasActiveGM && canSocket) {
    try {
      // GM clients will receive and only the primary GM will create the message.
      game.socket.emit(SOCKET_NS, { action: "xcardNotify", scope: "gm", content });
      // Socket emit is fire‑and‑forget; we don't await a response here.
      return;
    } catch (err) {
      console.warn(`[${NS}] Socket emit failed; falling back to local GM whisper.`, err);
    }
  }

  // Fallback: create a GM whisper from this client (not perfectly anonymous,
  // but still only visible to GMs).
  const whisper = getGMUserIds();
  if (!whisper.length) return;

  try {
    await ChatMessage.create({
      content,
      type: CONST.CHAT_MESSAGE_TYPES.OTHER,
      whisper,
      speaker: { alias: XCARD_TITLE }
    });
  } catch (err) {
    console.error(`[${NS}] Failed to send X‑Card whisper to GMs.`, err);
    ui.notifications?.error?.("Couldn’t send the X‑Card alert to the GM (see console).");
  }
}

/**
 * Send a *non‑anonymous* direct GM whisper immediately (from the clicking user).
 */
async function notifyGMDirect() {
  const whisper = getGMUserIds();
  if (!whisper.length) return;

  try {
    await ChatMessage.create({
      content: buildDirectGMContent(),
      type: CONST.CHAT_MESSAGE_TYPES.OTHER,
      whisper
      // DO NOT set speaker alias — let Foundry show the author normally (not anonymous).
    });
  } catch (err) {
    console.error(`[${NS}] Failed to send direct X‑Card whisper to GMs.`, err);
    ui.notifications?.error?.("Couldn’t send the X‑Card whisper to the GM (see console).");
  }
}

/**
 * Entry point for a click: evaluate configured mode and perform the appropriate action.
 * Regardless of the mode, the chat input is then prefilled with "/w GM ".
 */
async function handleXCardClick(htmlRoot) {
  const mode = String(game.settings.get(NS, KEY_XCARD_MODE) || XMODES.TABLE_ANON);

  try {
    if (mode === XMODES.TABLE_ANON) {
      await notifyTableAnon();
    } else if (mode === XMODES.GM_ANON) {
      await notifyGMAnon();
    } else if (mode === XMODES.GM_DIRECT) {
      await notifyGMDirect();
    } else if (mode === XMODES.COMPOSE) {
      // Intentionally do nothing here — compose-only path
    } else {
      // Unknown mode? Fallback to table anon.
      await notifyTableAnon();
    }
  } catch (err) {
    console.error(`[${NS}] X‑Card dispatch failed`, err);
  }

  // Always proceed with the "prefill whisper to GM + focus" behavior.
  const ta =
    htmlRoot?.[0]?.querySelector?.("textarea#chat-message") ||
    document.querySelector("textarea#chat-message");
  if (!ta) return;

  const updated = ensureWhisperToGM(ta.value || "");
  if (updated !== (ta.value || "")) {
    ta.value = updated;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new Event("change", { bubbles: true }));
  }
  ta.focus();
  try { ta.selectionStart = ta.selectionEnd = ta.value.length; } catch (_) { /* no-op */ }
}

/* ----------------------------- GM Socket Handler --------------------------- */

/** Register a GM‑side socket handler to create the anonymous chat message. */
function registerGMSocketHandler() {
  try {
    game.socket?.on(SOCKET_NS, async (data) => {
      if (!data || data.action !== "xcardNotify") return;
      if (!game.user?.isGM) return;
      if (!isPrimaryGM()) return; // only one GM should actually post

      const scope = data.scope === "table" ? "table" : "gm";
      const content = data.content || buildAnonContent(scope);

      try {
        if (scope === "gm") {
          const whisper = getGMUserIds();
          if (!whisper.length) return;
          await ChatMessage.create({
            content,
            type: CONST.CHAT_MESSAGE_TYPES.OTHER,
            whisper,
            speaker: { alias: XCARD_TITLE }
          });
        } else {
          await ChatMessage.create({
            content,
            type: CONST.CHAT_MESSAGE_TYPES.OTHER,
            speaker: { alias: XCARD_TITLE }
          });
        }
      } catch (err) {
        console.error(`[${NS}] Primary GM failed to deliver X‑Card alert.`, err);
      }
    });
  } catch (err) {
    console.warn(`[${NS}] Socket unavailable; X‑Card anonymous relays will use local fallback only.`, err);
  }
}

/* ----------------------------- UI Integration ----------------------------- */

/** Insert the button into the Chat controls */
async function injectButton(htmlRoot) {
  const $ = window.$;
  if (!$) return; // Foundry bundles jQuery; if somehow absent, bail.

  // Find the controls row *inside* the current render
  const $controls =
    htmlRoot.find?.("#chat-controls")?.first() ??
    $("#chat-controls").first();

  if (!$controls?.length) return;

  // Guard: avoid duplicates on re-render
  if ($controls.find("#xcard-btn-wrapper").length) return;

  // Render our tiny fragment
  const fragHtml = await renderTpl(TEMPLATE_PATH, {
    title: "X-Card",
    label: "GM"
  });

  const $fragment = $(fragHtml);

  // Insert after #roll-privacy so it sits between privacy and the control buttons
  const $rollPrivacy = $controls.find("#roll-privacy").first();
  if ($rollPrivacy.length) $rollPrivacy.after($fragment);
  else $controls.prepend($fragment); // graceful fallback

  // Wire up click (delegate to controls to survive minor reflows)
  $controls.off("click.xcard").on("click.xcard", "#xcard", async () => {
    await handleXCardClick(htmlRoot);
  });
}

/* --------------------------------- Hooks ---------------------------------- */

Hooks.once("init", () => {
  // New per-user select setting controlling X‑Card trigger behavior
  if (!game.settings.settings.has(`${NS}.${KEY_XCARD_MODE}`)) {
    game.settings.register(NS, KEY_XCARD_MODE, {
      name: "X‑Card: Trigger Mode",
      hint: "Choose what happens when you click the X‑Card. After any case, an optional whisper to the GM is prefilled in case you'd like to share more specific details.",
      scope: "client",
      config: true,
      type: String,
      choices: {
        [XMODES.TABLE_ANON]:  "Anonymously inform the table (default)",
        [XMODES.GM_ANON]:     "Anonymously ping the GMs",
        [XMODES.GM_DIRECT]:   "Directly ping GMs (not anonymous)",
        [XMODES.COMPOSE]:     "No ping, start a whisper to the GMs"
      },
      default: XMODES.TABLE_ANON
    });
  }
});

Hooks.once("ready", () => {
  registerGMSocketHandler();
});

Hooks.on("renderChatLog", async (_app, html) => {
  try { await injectButton(html); }
  catch (err) { console.error(`[${NS}] Failed to inject X‑Card button`, err); }
});

Hooks.on("renderSidebarTab", async (app, html) => {
  if (app?.id !== "chat") return;
  try { await injectButton(html); }
  catch (err) { console.error(`[${NS}] Failed to inject X‑Card button (sidebar)`, err); }
});
