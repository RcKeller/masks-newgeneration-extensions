/* global Hooks, game, foundry */

/**
 * XCard — GM Whisper Button
 * Inserts a Foundry-styled button between #roll-privacy and .control-buttons
 * in the chat controls. Clicking it ensures the chat textarea begins with
 * "/w GM " (idempotently).
 */

const NS = "masks-newgeneration-extensions";
const TEMPLATE_PATH = `modules/${NS}/templates/xcard.html`; // keep if your file is at module root

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
    title: "X-Card: Whisper to DM",
    label: "GM"
  });

  const $fragment = $(fragHtml);

  // Insert after #roll-privacy so it sits between privacy and the control buttons
  const $rollPrivacy = $controls.find("#roll-privacy").first();
  if ($rollPrivacy.length) $rollPrivacy.after($fragment);
  else $controls.prepend($fragment); // graceful fallback

  // Wire up click (delegate to controls to survive minor reflows)
  $controls.off("click.xcard").on("click.xcard", "#xcard", () => {
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

/* ---- Hooks ---- */
Hooks.on("renderChatLog", async (_app, html) => {
  try { await injectButton(html); }
  catch (err) { console.error(`[${NS}] Failed to inject button`, err); }
});

Hooks.on("renderSidebarTab", async (app, html) => {
  if (app?.id !== "chat") return;
  try { await injectButton(html); }
  catch (err) { console.error(`[${NS}] Failed to inject button (sidebar)`, err); }
});
