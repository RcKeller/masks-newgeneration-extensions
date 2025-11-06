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
 *
 * ---------------------------------------------------------------------------
 * BUGFIX (v13+ reliability):
 * - Ensure the default behavior (“Anonymously inform the table”) ALWAYS posts a
 *   public chat message locally (no GM‑socket dependency). This fixes cases
 *   where players clicked the X‑card and no table message appeared in new worlds
 *   or during socket/GM timing races.
 * - Also: use `ChatMessage.getSpeaker({ alias })` and robust active‑GM checks.
 */

const NS = "masks-newgeneration-extensions";
const TEMPLATE_PATH = `modules/${NS}/templates/xcard.hbs`;

// --- Settings (new + legacy/deprecated) ---
const KEY_XCARD_MODE = "xcardTriggerMode"; // client select: user-configurable mode
const KEY_NOTIFY_GM = "xcardNotifyGMOnClick"; // legacy (deprecated; config: false)

// Socket channel (still used for GM‑anonymous mode)
const SOCKET_NS = "module.masks-newgeneration-extensions";

const XCARD_TITLE = "🛑 X‑Card has been played";

// Enumerated modes (persisted as strings)
const XMODES = Object.freeze({
	TABLE_ANON: "table-anon", // Anonymously inform the table
	GM_ANON: "gm-anon", // Anonymously ping the GMs
	GM_DIRECT: "gm-direct", // Directly inform the GMs (not anonymous)
	COMPOSE: "compose", // Only start composing a whisper to the GM
});

/** Normalize the message to start with "/w GM " */
function ensureWhisperToGM(text) {
	const prefix = "/w GM ";
	if (text.startsWith(prefix)) return text;
	const whisperAtStart = /^\/w\s+\S+\s+/i; // replace any "/w <target> "
	return whisperAtStart.test(text)
		? text.replace(whisperAtStart, prefix)
		: prefix + text;
}

/** Render a Handlebars template with broad compatibility for v13+. */
async function renderTpl(path, data) {
	// Prefer the global helper, then v13+ utils, then legacy handlebar shim.
	if (typeof globalThis.renderTemplate === "function") {
		return globalThis.renderTemplate(path, data);
	}
	if (foundry?.utils?.renderTemplate) {
		return foundry.utils.renderTemplate(path, data);
	}
	const fn = foundry?.applications?.handlebars?.renderTemplate;
	if (typeof fn === "function") return fn(path, data);
	throw new Error("renderTemplate is not available in this environment.");
}

/* ----------------------------- GM & User Helpers --------------------------- */

function getGMUserIds() {
	try {
		const users = ChatMessage.getWhisperRecipients("GM");
		if (Array.isArray(users) && users.length && users[0]?.id)
			return users.map((u) => u.id);
	} catch (_) {
		/* ignore; fall through */
	}

	const list = game.users?.contents ?? game.users ?? [];
	return list.filter((u) => u?.isGM).map((u) => u.id);
}

/** True if any active GM is currently connected. */
function hasAnyActiveGM() {
	const users = game.users?.contents ?? game.users ?? [];
	return users.some((u) => u?.isGM && u?.active);
}

/** Best‑effort "primary GM" selection so only one GM creates the socket message. */
function isPrimaryGM() {
	const gms = (game.users?.contents ?? game.users ?? []).filter(
		(u) => u?.isGM && u?.active
	);
	if (!gms.length) return game.user?.isGM === true;
	gms.sort((a, b) => String(a.id).localeCompare(String(b.id)));
	return gms[0]?.id === game.user?.id;
}

/** Build a safe speaker object that works across versions. */
function speakerAlias(alias) {
	try {
		return ChatMessage.getSpeaker({ alias });
	} catch (_) {
		return { alias };
	}
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
    <em class="color-muted">The sender may optionally whisper the GM to provide details.</em>
  `;
}

/* --------------------------- Dispatching / Delivery ------------------------ */

/**
 * Send a *public* anonymous X‑Card alert to the whole table.
 *
 * IMPORTANT CHANGE: We no longer rely on a GM‑socket relay for the default.
 * We always create the public message locally so it works in brand‑new worlds
 * and in any client configuration. (The alias hides the initiator in chat UI.)
 */
async function notifyTableAnon() {
	const content = buildAnonContent("table");
	try {
		await ChatMessage.create({
			content,
			type: CONST.CHAT_MESSAGE_TYPES.OTHER,
			speaker: speakerAlias(XCARD_TITLE),
		});
	} catch (err) {
		console.error(`[${NS}] Failed to send X‑Card alert to the table.`, err);
		ui.notifications?.error?.(
			"Couldn’t send the X‑Card alert to the table (see console)."
		);
	}
}

/**
 * Send an *anonymous* X‑Card alert to all GMs.
 * Tries to route via socket so a GM client creates the message (hiding who clicked).
 * Falls back to creating a local GM‑whisper if sockets/GM are unavailable.
 */
async function notifyGMAnon() {
	const content = buildAnonContent("gm");

	if (hasAnyActiveGM() && game.socket) {
		try {
			game.socket.emit(SOCKET_NS, { action: "xcardNotify", scope: "gm", content });
			return;
		} catch (err) {
			console.warn(
				`[${NS}] Socket emit failed; falling back to local GM whisper.`,
				err
			);
		}
	}

	// Fallback: create a GM whisper from this client (not perfectly anonymous, but GM‑only).
	const whisper = getGMUserIds();
	if (!whisper.length) return;

	try {
		await ChatMessage.create({
			content,
			type: CONST.CHAT_MESSAGE_TYPES.OTHER,
			whisper,
			speaker: speakerAlias(XCARD_TITLE),
		});
	} catch (err) {
		console.error(`[${NS}] Failed to send X‑Card whisper to GMs.`, err);
		ui.notifications?.error?.(
			"Couldn’t send the X‑Card alert to the GM (see console)."
		);
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
			whisper,
			// No `speaker` alias — let Foundry show the user normally (not anonymous).
		});
	} catch (err) {
		console.error(`[${NS}] Failed to send direct X‑Card whisper to GMs.`, err);
		ui.notifications?.error?.(
			"Couldn’t send the X‑Card whisper to the GM (see console)."
		);
	}
}

/**
 * Entry point for a click: evaluate configured mode and perform the appropriate action.
 * Regardless of the mode, the chat input is then prefilled with "/w GM ".
 */
async function handleXCardClick(htmlRoot) {
	const mode = String(
		game.settings.get(NS, KEY_XCARD_MODE) || XMODES.TABLE_ANON
	);

	try {
		if (mode === XMODES.TABLE_ANON) {
			await notifyTableAnon(); // <-- always posts locally (bugfix)
		} else if (mode === XMODES.GM_ANON) {
			await notifyGMAnon();
		} else if (mode === XMODES.GM_DIRECT) {
			await notifyGMDirect();
		} else if (mode === XMODES.COMPOSE) {
			// compose-only; do nothing before prefilling the whisper
		} else {
			await notifyTableAnon(); // safety fallback
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
	try {
		ta.selectionStart = ta.selectionEnd = ta.value.length;
	} catch (_) {
		/* no-op */
	}
}

/* ----------------------------- GM Socket Handler --------------------------- */

/** Register a GM‑side socket handler to create the anonymous GM whisper. */
function registerGMSocketHandler() {
	try {
		game.socket?.on(SOCKET_NS, async (data) => {
			if (!data || data.action !== "xcardNotify") return;
			if (!game.user?.isGM) return;
			if (!isPrimaryGM()) return; // only one GM should actually post

			const scope = data.scope === "gm" ? "gm" : "table";
			const content = data.content || buildAnonContent(scope);

			try {
				if (scope === "gm") {
					const whisper = getGMUserIds();
					if (!whisper.length) return;
					await ChatMessage.create({
						content,
						type: CONST.CHAT_MESSAGE_TYPES.OTHER,
						whisper,
						speaker: speakerAlias(XCARD_TITLE),
					});
				} else {
					// We no longer emit "table" via socket in default flow, but keep this for completeness.
					await ChatMessage.create({
						content,
						type: CONST.CHAT_MESSAGE_TYPES.OTHER,
						speaker: speakerAlias(XCARD_TITLE),
					});
				}
			} catch (err) {
				console.error(`[${NS}] Primary GM failed to deliver X‑Card alert.`, err);
			}
		});
	} catch (err) {
		console.warn(
			`[${NS}] Socket unavailable; X‑Card anonymous GM relays will use local fallback.`,
			err
		);
	}
}

/* ----------------------------- UI Integration ----------------------------- */

/** Insert the button into the Chat controls */
async function injectButton(htmlRoot) {
	const $ = window.$;
	if (!$) return; // Foundry bundles jQuery; if somehow absent, bail.

	// Find the controls row *inside* the current render
	const $controls =
		htmlRoot.find?.("#chat-controls")?.first() ?? $("#chat-controls").first();

	if (!$controls?.length) return;

	// Guard: avoid duplicates on re-render
	if ($controls.find("#xcard-btn-wrapper").length) return;

	// Render our tiny fragment
	const fragHtml = await renderTpl(TEMPLATE_PATH, {
		title: "X-Card",
		label: "GM",
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
			hint:
				"Choose what happens when you click the X‑Card. After any case, an optional whisper to the GM is prefilled in case you'd like to share more specific details.",
			scope: "client",
			config: true,
			type: String,
			choices: {
				[XMODES.TABLE_ANON]: "Anonymously inform the table (default)",
				[XMODES.GM_ANON]: "Anonymously ping the GMs",
				[XMODES.GM_DIRECT]: "Directly ping GMs (not anonymous)",
				[XMODES.COMPOSE]: "No ping, start a whisper to the GMs",
			},
			default: XMODES.TABLE_ANON,
		});
	}

	// Legacy world setting — kept to avoid errors in existing worlds (not used).
	if (!game.settings.settings.has(`${NS}.${KEY_NOTIFY_GM}`)) {
		game.settings.register(NS, KEY_NOTIFY_GM, {
			name: "X‑Card: Notify GM on Click (legacy)",
			scope: "world",
			config: false,
			type: Boolean,
			default: false,
		});
	}
});

Hooks.once("ready", () => {
	registerGMSocketHandler();
});

Hooks.on("renderChatLog", async (_app, html) => {
	try {
		await injectButton(html);
	} catch (err) {
		console.error(`[${NS}] Failed to inject X‑Card button`, err);
	}
});

Hooks.on("renderSidebarTab", async (app, html) => {
	if (app?.id !== "chat") return;
	try {
		await injectButton(html);
	} catch (err) {
		console.error(`[${NS}] Failed to inject X‑Card button (sidebar)`, err);
	}
});
