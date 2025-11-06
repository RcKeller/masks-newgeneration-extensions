/* global game, Hooks, ui, canvas, foundry, CONST */

/**
 * health.mjs
 * ----------------------------------------------------------------------------
 * Derived HP with visible token bars for Characters & NPCs (Foundry v13+).
 *
 *  - Characters: max HP = 5; HP = 5 − (# marked conditions)
 *  - NPCs: max HP = Tier (0–5); HP = Tier − (# marked conditions)
 *  - Adds NPC Tier if missing; adds HP field if missing.
 *  - Automatically wires token bar1 to attributes.hp (core token bar).
 *  - Marks token combatants defeated when HP reaches 0 (and clears if >0).
 *
 * Single-writer election prevents multi-client race conditions.
 */

const NS = "masks-newgeneration-extensions";

const PATH = Object.freeze({
	HP: "system.attributes.hp",
	HP_VAL: "system.attributes.hp.value",
	HP_MAX: "system.attributes.hp.max",
	TIER: "system.attributes.tier.value",
	COND_OPTS: "system.attributes.conditions.options",
});

/* --------------------------------- Helpers -------------------------------- */

function clamp(n, lo, hi) {
	const x = Number(n);
	if (!Number.isFinite(x)) return lo;
	return Math.min(hi, Math.max(lo, Math.floor(x)));
}

/** Count active (true) condition checkboxes on the Actor/Token actorData */
function countActiveConditions(dataLike) {
	const opts = foundry.utils.getProperty(dataLike, PATH.COND_OPTS);
	if (!opts || typeof opts !== "object") return 0;
	let n = 0;
	for (const v of Object.values(opts)) if (v?.value === true) n++;
	return n;
}

/** Derive HP {value, max} based on actor type & data */
function deriveHP(actor) {
	const isChar = actor?.type === "character";
	let max = isChar ? 5 : Number(foundry.utils.getProperty(actor, PATH.TIER));
	if (!Number.isFinite(max)) max = isChar ? 5 : 3;
	max = clamp(max, 0, 5);

	const conds = countActiveConditions(actor);
	const value = Math.max(0, max - conds);
	return { value, max };
}

/* ------------------------------ Write election ---------------------------- */

function _primaryGMId() {
	const gms = (game.users?.contents ?? game.users ?? []).filter(
		(u) => u?.isGM && u?.active
	);
	if (!gms.length) return null;
	gms.sort((a, b) => String(a.id).localeCompare(String(b.id)));
	return gms[0].id;
}

function _lowestActiveOwnerId(actor) {
	const users = game.users?.contents ?? game.users ?? [];
	const owners = users.filter(
		(u) =>
			u?.active &&
			actor?.testUserPermission?.(u, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
	);
	if (!owners.length) return null;
	owners.sort((a, b) => String(a.id).localeCompare(String(b.id)));
	return owners[0].id;
}

function amIPrimaryWriter(actor) {
	const gmId = _primaryGMId();
	if (gmId) return game.user?.id === gmId;
	const ownerId = _lowestActiveOwnerId(actor);
	if (ownerId) return game.user?.id === ownerId;
	return game.user?.isGM || actor?.isOwner === true;
}

function canWrite(actor) {
	return (game.user?.isGM || actor?.isOwner === true) && amIPrimaryWriter(actor);
}

/* ------------------------------ Change detection -------------------------- */

function didConditionsChange(changes) {
	const flat = foundry.utils.flattenObject(changes || {});
	for (const k of Object.keys(flat)) {
		if (k === PATH.COND_OPTS || k.startsWith(`${PATH.COND_OPTS}.`)) return true;
		const tok = `actorData.${PATH.COND_OPTS}`;
		if (k === tok || k.startsWith(`${tok}.`)) return true;
	}
	return false;
}

function didTierChange(changes) {
	const flat = foundry.utils.flattenObject(changes || {});
	return (
		flat[PATH.TIER] !== undefined || flat[`actorData.${PATH.TIER}`] !== undefined
	);
}

/* ---------------------------- Core write helpers -------------------------- */

async function ensureHpField(actor) {
	if (!actor) return false;
	const hasVal = foundry.utils.getProperty(actor, PATH.HP_VAL);
	const hasMax = foundry.utils.getProperty(actor, PATH.HP_MAX);
	if (hasVal !== undefined && hasMax !== undefined) return false;

	const { value, max } = deriveHP(actor);
	try {
		await actor.update(
			{ [PATH.HP]: { label: "Health", value, max } },
			{ diff: true }
		);
		return true;
	} catch (e) {
		console.warn(`[${NS}] Failed to initialize HP on ${actor.name}`, e);
		return false;
	}
}

async function writeDerivedHP(actor) {
	if (!actor || !canWrite(actor)) return;
	const before = Number(foundry.utils.getProperty(actor, PATH.HP_VAL));
	const beforeMax = Number(foundry.utils.getProperty(actor, PATH.HP_MAX));
	const { value, max } = deriveHP(actor);

	const upd = {};
	if (!Number.isFinite(before) || before !== value) upd[PATH.HP_VAL] = value;
	if (!Number.isFinite(beforeMax) || beforeMax !== max) upd[PATH.HP_MAX] = max;
	if (!Object.keys(upd).length) return;

	try {
		await actor.update(upd);
	} catch (err) {
		console.error(`[${NS}] Failed to set derived HP for ${actor.name}`, err);
	}
}

async function ensureTokenBar(tokenDoc) {
	if (!tokenDoc) return;
	// Foundry expects a path relative to actor.system
	const desired = "attributes.hp";
	const cur = tokenDoc?.bar1?.attribute;
	if (cur === desired) return;
	try {
		await tokenDoc.update({ "bar1.attribute": desired }, { diff: true });
	} catch (err) {
		console.warn(
			`[${NS}] Could not set bar1 to HP for token ${tokenDoc.name}`,
			err
		);
	}
}

async function toggleDefeatedForActorTokens(actor) {
	const tokens = (canvas?.tokens?.placeables ?? []).filter(
		(t) => t?.actor?.id === actor.id
	);
	const hpVal = Number(foundry.utils.getProperty(actor, PATH.HP_VAL));
	const isZero = Number.isFinite(hpVal) && hpVal <= 0;
	for (const t of tokens) {
		const cb = t.combatant ?? null;
		if (!cb) continue;
		try {
			if (isZero && cb.defeated !== true) await cb.update({ defeated: true });
			if (!isZero && cb.defeated === true) await cb.update({ defeated: false });
		} catch (err) {
			console.warn(`[${NS}] Failed to toggle defeated on ${t.name}`, err);
		}
	}
}

async function recalcApply(actor, changes = null) {
	if (!actor) return;
	// Create field if missing (safe no-op if present)
	await ensureHpField(actor);

	// Only recompute when relevant inputs changed.
	const relevant =
		!changes || didConditionsChange(changes) || didTierChange(changes);
	if (!relevant) return;

	await writeDerivedHP(actor);
	await toggleDefeatedForActorTokens(actor);
}

/* --------------------------------- Migrate -------------------------------- */

async function migrateExistingActorsAndTokens() {
	const actors = game.actors?.contents ?? [];
	const tasks = [];

	for (const a of actors) {
		// Seed NPC Tier if missing
		if (a.type === "npc") {
			const tier = Number(foundry.utils.getProperty(a, PATH.TIER));
			if (!Number.isFinite(tier)) {
				tasks.push(a.update({ [PATH.TIER]: 3 }));
			}
		}
		// Ensure HP field exists
		tasks.push(ensureHpField(a));
	}
	try {
		await Promise.allSettled(tasks);
	} catch (_) {
		/* ignore */
	}

	// Compute initial HP & assign token bars
	for (const a of actors) await writeDerivedHP(a);
	for (const t of canvas.tokens?.placeables ?? [])
		await ensureTokenBar(t.document);
}

/* ------------------------------- Sheet wiring ----------------------------- */
/** Patch PbtA sheet config to show Tier (NPC) and Health (both) as Number fields. */
function patchSheetConfig() {
	try {
		const cfg = game.pbta?.sheetConfig;
		if (!cfg) return;

		// Ensure object paths exist without clobbering
		cfg.actorTypes ||= {};
		cfg.actorTypes.character ||= {};
		cfg.actorTypes.character.attributes ||= {};
		cfg.actorTypes.npc ||= {};
		cfg.actorTypes.npc.attributes ||= {};

		const charAttrs = cfg.actorTypes.character.attributes;
		const npcAttrs = cfg.actorTypes.npc.attributes;

		// HP for Character & NPC (Number input; token bar shows the real progress)
		const hpDef = {
			type: "Number",
			label: "Health",
			value: 0,
			max: 5,
			position: "Top",
		};
		if (!charAttrs.hp) charAttrs.hp = foundry.utils.deepClone(hpDef);
		if (!npcAttrs.hp) npcAttrs.hp = foundry.utils.deepClone(hpDef);

		// NPC Tier (0–5). Keep simple Number for minimal intrusion.
		if (!npcAttrs.tier) {
			npcAttrs.tier = {
				type: "Number",
				label: "Tier",
				value: 3,
				min: 0,
				max: 5,
				position: "Top",
			};
		}
	} catch (err) {
		console.warn(`[${NS}] Failed to patch PbtA sheet config for Tier/HP`, err);
	}
}

/* ---------------------------------- Hooks --------------------------------- */

Hooks.once("ready", async () => {
	// Patch PbtA sheet config (visible Tier/Health inputs; real bar is the token bar)
	patchSheetConfig();

	// Initial migration + first compute
	await migrateExistingActorsAndTokens();

	// Actor changes (conditions/tier/name/anything relevant)
	Hooks.on("updateActor", (actor, changes) => {
		// Recompute if conditions or tier changed
		recalcApply(actor, changes);
	});

	// Synthetic (unlinked) token changes may carry actorData deltas
	Hooks.on("updateToken", (tokenDoc, changes) => {
		if (!tokenDoc?.actor) return;
		// Always ensure token bar
		ensureTokenBar(tokenDoc);
		if (didConditionsChange(changes) || didTierChange(changes)) {
			recalcApply(tokenDoc.actor, {}); // actorData already applied; trigger recompute
		}
	});

	// New docs during play
	Hooks.on("createActor", async (actor) => {
		await ensureHpField(actor);
		await writeDerivedHP(actor);
	});

	Hooks.on("createToken", async (tokenDoc) => {
		await ensureTokenBar(tokenDoc);
		if (tokenDoc?.actor) {
			await ensureHpField(tokenDoc.actor);
			await writeDerivedHP(tokenDoc.actor);
		}
	});

	// Scene swap: make sure token bars are present and HP derived (actors typically cached)
	Hooks.on("canvasReady", async () => {
		for (const t of canvas.tokens?.placeables ?? [])
			await ensureTokenBar(t.document);
		// A quick sweep to sync defeated overlays for any scene tokens
		for (const t of canvas.tokens?.placeables ?? [])
			if (t?.actor) await toggleDefeatedForActorTokens(t.actor);
	});
});
