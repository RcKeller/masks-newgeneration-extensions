/* global Hooks, game, foundry, ChatMessage, CONST, ui */

/**
 * XCard — GM Whisper Button (+ anonymous GM alert)
 * ----------------------------------------------------------------------------
 * Inserts a Foundry-styled button between #roll-privacy and .control-buttons
 * in the chat controls. Clicking it will:
 *   1) (Optionally) send an anonymous whisper to all active GMs that the
 *      X‑Card has been clicked. This can be suppressed via a world setting.
 *   2) Proceed with the original behavior by focusing the chat textarea and
 *      ensuring it begins with "/w GM " so the player can explain if desired.
 *
 * Setting (world):
 *   - masks-newgeneration-extensions.xcardNotifyGMOnClick (default: true)
 *     If enabled, step (1) is performed; if disabled, only step (2) runs.
 */

const NS = "masks-newgeneration-extensions";
const TEMPLATE_PATH = `modules/${NS}/templates/xcard.hbs`; // keep if your file is at module root
const KEY_NOTIFY_GM = "xcardNotifyGMOnClick";
const SOCKET_NS = "module.masks-newgeneration-extensions";

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

/* ----------------------------- GM Alert Helpers ---------------------------- */

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

/** Default content used in the anonymous GM whisper. */
function xcardDefaultContent() {
  // Keep minimal, high‑signal message. No user info included for anonymity.
  return `
    <p><b>⚠ X‑Card</b> has been clicked.</p>
    <p class="color-muted">This is an anonymous safety ping to the GM.</p>
  `;
}

/**
 * Send an *anonymous* X‑Card alert to all GMs.
 * Tries to route via socket so a GM client creates the message (hiding who clicked).
 * Falls back to creating a local GM‑whisper if sockets/GM are unavailable.
 */
async function notifyGMXCardClicked() {
  // Respect setting: suppress initial alert if disabled.
  if (game.settings.get(NS, KEY_NOTIFY_GM) !== true) return;

  const content = xcardDefaultContent();

  // If any active GM exists and we have sockets, broadcast a relay request.
  const hasActiveGM = (game.users?.some?.(u => u?.isGM && u?.active) === true);
  const canSocket = !!game.socket;
  if (hasActiveGM && canSocket) {
    try {
      // GM clients will receive and only the primary GM will create the message.
      game.socket.emit(SOCKET_NS, { action: "xcardNotify", content });
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
      speaker: { alias: "X‑Card" }
    });
  } catch (err) {
    console.error(`[${NS}] Failed to send X‑Card whisper to GMs.`, err);
    ui.notifications?.error?.("Couldn’t send the X‑Card alert to the GM (see console).");
  }
}

/** Register a GM‑side socket handler to create the anonymous chat message. */
function registerGMSocketHandler() {
  try {
    game.socket?.on(SOCKET_NS, async (data) => {
      if (!data || data.action !== "xcardNotify") return;
      if (!game.user?.isGM) return;
      if (!isPrimaryGM()) return; // only one GM should actually post

      const whisper = getGMUserIds();
      if (!whisper.length) return;

      const content = data.content || xcardDefaultContent();
      try {
        await ChatMessage.create({
          content,
          type: CONST.CHAT_MESSAGE_TYPES.OTHER,
          whisper,
          speaker: { alias: "X‑Card" }
        });
      } catch (err) {
        console.error(`[${NS}] Primary GM failed to deliver X‑Card alert.`, err);
      }
    });
  } catch (err) {
    console.warn(`[${NS}] Socket unavailable; X‑Card GM alert will use local fallback only.`, err);
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
    title: "X‑Card: Alert GM & start whisper",
    label: "GM"
  });

  const $fragment = $(fragHtml);

  // Insert after #roll-privacy so it sits between privacy and the control buttons
  const $rollPrivacy = $controls.find("#roll-privacy").first();
  if ($rollPrivacy.length) $rollPrivacy.after($fragment);
  else $controls.prepend($fragment); // graceful fallback

  // Wire up click (delegate to controls to survive minor reflows)
  $controls.off("click.xcard").on("click.xcard", "#xcard", async () => {
    // 1) Anonymous ping to GM (if enabled)
    try { await notifyGMXCardClicked(); }
    catch (err) { console.error(`[${NS}] X‑Card GM alert failed.`, err); }

    // 2) Proceed with original behavior: prep the whisper to GM
    const ta =
      htmlRoot[0]?.querySelector?.("textarea#chat-message") ||
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
  });
}

/* --------------------------------- Hooks ---------------------------------- */

Hooks.once("init", () => {
  // World setting to enable/disable the initial anonymous GM alert
  if (!game.settings.settings.has(`${NS}.${KEY_NOTIFY_GM}`)) {
    game.settings.register(NS, KEY_NOTIFY_GM, {
      name: "X‑Card: Alert GM on Click",
      hint: "If enabled, clicking the X‑Card button immediately sends an anonymous whisper to all active GMs before focusing the chat input.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
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
