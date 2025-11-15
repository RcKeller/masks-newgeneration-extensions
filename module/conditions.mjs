/* global Hooks, game, foundry, ActiveEffect, canvas, CONST */
/**
 * status-fx.mjs
 * ----------------------------------------------------------------------------
 * Automatic token status icons for Masks conditions (Afraid, Angry, Guilty,
 * Hopeless, Insecure) with robust de‑duplication:
 *  - Keeps exactly one effect per managed condition.
 *  - Removes any look‑alike/duplicate condition effects that aren't ours.
 *  - Cleans up if an effect was accidentally applied twice.
 *  - Single-writer election (primary GM or lowest-id owner) to avoid races.
 *
 * v13+ only.
 */

const NS = "masks-newgeneration-extensions";

/** Canonical set of conditions we manage + their icons. */
const MANAGED = Object.freeze({
	Afraid: {
		id: `${NS}-afraid`,
		name: "Afraid",
		img: "modules/masks-newgeneration-unofficial/images/gameicons/shadow-follower-%23ffffff-%233da7db.svg",
	},
	Angry: {
		id: `${NS}-angry`,
		name: "Angry",
		img: "modules/masks-newgeneration-unofficial/images/gameicons/enrage-%23ffffff-%233da7db.svg",
	},
	Guilty: {
		id: `${NS}-guilty`,
		name: "Guilty",
		img: "modules/masks-newgeneration-unofficial/images/gameicons/liar-%23ffffff-%233da7db.svg",
	},
	Hopeless: {
		id: `${NS}-hopeless`,
		name: "Hopeless",
		img: "modules/masks-newgeneration-unofficial/images/gameicons/broken-bone-%23ffffff-%233da7db.svg",
	},
	Insecure: {
		id: `${NS}-insecure`,
		name: "Insecure",
		img: "modules/masks-newgeneration-unofficial/images/gameicons/screaming-%23ffffff-%233da7db.svg",
	},
});

const FX_FLAG = "autoConditionEffect";

/** Health depends on unique active conditions - this file ensures they're properly managed */

// Lowercase helpers and reverse lookups
const COND_KEYS = Object.keys(MANAGED);
const LOWER = Object.fromEntries(COND_KEYS.map((k) => [k, k.toLowerCase()]));
const ID_TO_KEY = Object.fromEntries(COND_KEYS.map((k) => [MANAGED[k].id, k]));
const IMG_TO_KEY = Object.fromEntries(
	COND_KEYS.map((k) => [MANAGED[k].img, k])
);

/* --------------------------------- Writers -------------------------------- */

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

/** Elect a single client to write for this actor to avoid duplicate creation races. */
function amIPrimaryWriter(actor) {
	const gmId = _primaryGMId();
	if (gmId) return game.user?.id === gmId; // any active GM exists => only primary GM writes
	const ownerId = _lowestActiveOwnerId(actor);
	if (ownerId) return game.user?.id === ownerId; // otherwise, a single active owner writes
	// Fallback: if no one is clearly elected, allow GM or owner (rare/offline scenes)
	return game.user?.isGM || actor?.isOwner === true;
}

function canWrite(actor) {
	return (game.user?.isGM || actor?.isOwner === true) && amIPrimaryWriter(actor);
}

/* --------------------------- Change / Data Access -------------------------- */

function didConditionsChange(
	changes,
	basePath = "system.attributes.conditions.options"
) {
	const flat = foundry.utils.flattenObject(changes || {});
	for (const k of Object.keys(flat)) {
		if (k === basePath || k.startsWith(`${basePath}.`)) return true;
	}
	const tokenBase = `actorData.${basePath}`;
	for (const k of Object.keys(flat)) {
		if (k === tokenBase || k.startsWith(`${tokenBase}.`)) return true;
	}
	return false;
}

/**
 * Extract boolean state for a given condition key ("Afraid", …).
 * Handles both Character and NPC examples:
 * system.attributes.conditions.options.{0,1,...} = { label, value }
 */
function getConditionState(actor, condKey) {
	const opts = foundry.utils.getProperty(
		actor,
		"system.attributes.conditions.options"
	);
	if (!opts || typeof opts !== "object") return false;

	const want = LOWER[condKey];
	for (const ent of Object.values(opts)) {
		const raw = String(ent?.label ?? "")
			.toLowerCase()
			.trim();
		const base = raw.split("(")[0].trim(); // strip "(-2 …)" suffixes
		if (base === want) return !!ent?.value;
	}
	return false;
}

/* ------------------------------ Classification ---------------------------- */

/** Try to map an ActiveEffect to one of our 5 condition keys. */
function classifyEffectToConditionKey(eff) {
	if (!eff) return null;

	// 1) If it carries our managed status id(s), it's definitely ours.
	if (Array.isArray(eff.statuses)) {
		for (const s of eff.statuses) {
			const key = ID_TO_KEY[s];
			if (key) return key;
		}
	}

	// 2) If its name matches a known condition name (case-insensitive)
	const name = String(eff.name ?? "")
		.toLowerCase()
		.trim();
	for (const k of COND_KEYS) {
		if (name === LOWER[k] || name.startsWith(`${LOWER[k]} `)) return k;
	}

	// 3) If any free-form statuses look like condition names ("afraid","angry",…)
	if (Array.isArray(eff.statuses)) {
		const lowers = eff.statuses.map((s) => String(s).toLowerCase());
		for (const k of COND_KEYS) {
			if (lowers.includes(LOWER[k]) || lowers.includes(`condition-${LOWER[k]}`))
				return k;
		}
	}

	// 4) Exact image match to our canonical icon (rare, but safe)
	const imgKey = IMG_TO_KEY[eff.img];
	if (imgKey) return imgKey;

	return null;
}

/** True if the effect was created by us (flag or our status id). */
function isOurEffect(eff) {
	if (!eff) return false;
	if (eff.getFlag(NS, FX_FLAG) === true) return true;
	if (Array.isArray(eff.statuses)) {
		return eff.statuses.some((s) => ID_TO_KEY[s]); // contains one of our status ids
	}
	return false;
}

/* --------------------------- Read / De-dup Present ------------------------- */

/** Map of current managed condition statusId -> effectId. */
function readCurrentManagedByStatus(actor) {
	const map = new Map();
	if (!actor?.effects) return map;
	for (const eff of actor.effects) {
		if (!isOurEffect(eff)) continue;
		for (const s of eff.statuses ?? []) {
			if (ID_TO_KEY[s]) map.set(s, eff.id);
		}
	}
	return map;
}

/**
 * Remove duplicates and clear any non-canonical condition effects:
 *  - For each of the 5 conditions, keep at most 1 effect (prefer ours).
 *  - Delete any OTHER effects that appear to represent one of those conditions.
 * Returns array of promises to await (deletions only).
 */
function buildDedupDeletes(actor) {
	/** @type {Array<string>} */
	const toDelete = [];
	if (!actor?.effects) return toDelete;

	// Bucket effects by condition they appear to represent
	/** @type {Record<string, {ours: ActiveEffect[], others: ActiveEffect[]}>} */
	const buckets = Object.fromEntries(
		COND_KEYS.map((k) => [k, { ours: [], others: [] }])
	);

	for (const eff of actor.effects) {
		const key = classifyEffectToConditionKey(eff);
		if (!key) continue; // not one of our 5 conditions; leave it alone entirely
		(isOurEffect(eff) ? buckets[key].ours : buckets[key].others).push(eff);
	}

	// For each condition: keep 1 canonical effect, delete the rest (ours+others beyond first)
	for (const k of COND_KEYS) {
		const { ours, others } = buckets[k];
		// Prefer OUR first instance as the canonical survivor
		const survivors = [];
		if (ours.length) survivors.push(ours[0]);
		// Any remaining ours are duplicates
		for (let i = ours.length ? 1 : 0; i < ours.length; i++) {
			toDelete.push(ours[i].id);
		}
		// All "others" are considered duplicates of our intended icon set => delete them
		for (const e of others) toDelete.push(e.id);

		// If we didn't have any of ours and there are "others", we will later create our canonical one
		// and we already scheduled deletion of the others above.
	}

	return [...new Set(toDelete)];
}

/* ---------------------------------- Sync ---------------------------------- */

async function syncConditionEffects(actor) {
	if (!actor) return;

	// ELECT A SINGLE WRITER to avoid duplicate creations across clients
	if (!canWrite(actor)) return;

	// 1) De-dup pass: nuke extra/foreign condition effects so we start clean
	const dupDeletes = buildDedupDeletes(actor);
	if (dupDeletes.length) {
		try {
			await actor.deleteEmbeddedDocuments("ActiveEffect", dupDeletes);
		} catch (err) {
			console.warn(
				`[${NS}] Failed to delete duplicate/foreign condition effects for ${actor.name}`,
				err
			);
		}
	}

	// 2) Compute delta vs. our canonical set
	const presentByStatus = readCurrentManagedByStatus(actor);
	const toCreate = [];
	const toDelete = [];

	for (const key of COND_KEYS) {
		const def = MANAGED[key];
		const active = getConditionState(actor, key);
		const hasNow = presentByStatus.has(def.id);

		if (active && !hasNow) {
			toCreate.push({
				name: def.name,
				img: def.img,
				statuses: [def.id],
				origin: actor.uuid,
				transfer: false,
				disabled: false,
				flags: { [NS]: { [FX_FLAG]: true } },
			});
		} else if (!active && hasNow) {
			toDelete.push(presentByStatus.get(def.id));
		}
	}

	if (!toCreate.length && !toDelete.length) return;

	try {
		if (toCreate.length) {
			await ActiveEffect.create(toCreate, { parent: actor, keepId: false });
		}
		if (toDelete.length) {
			await actor.deleteEmbeddedDocuments("ActiveEffect", [...new Set(toDelete)]);
		}
	} catch (err) {
		console.error(`[${NS}] Condition effect sync failed for ${actor.name}`, err);
	}
}

/* ------------------------------ Scheduling -------------------------------- */

const _pending = new Map(); // actor.id -> timerId

function queueSync(actor, delay = 30) {
	if (!actor) return;
	const id = actor.id ?? actor.parent?.id ?? actor.uuid;
	if (!id) return;
	const prev = _pending.get(id);
	if (prev) clearTimeout(prev);
	const tid = setTimeout(() => {
		_pending.delete(id);
		// Fire and forget; syncConditionEffects will elect a single writer.
		syncConditionEffects(actor);
	}, Math.max(10, delay));
	_pending.set(id, tid);
}

/* --------------------------------- Hooks ---------------------------------- */

Hooks.once("ready", () => {
	// Live sheet edits (Characters & NPCs; linked or synthetic)
	Hooks.on("updateActor", (actor, changes) => {
		if (didConditionsChange(changes)) queueSync(actor);
	});

	// Token-level overrides (synthetic actors)
	Hooks.on("updateToken", (tokenDoc, changes) => {
		if (!didConditionsChange(changes)) return;
		if (tokenDoc?.actor) queueSync(tokenDoc.actor);
	});

	// Initial sweep: only a single elected writer performs it
	const doInitial = () => {
		// Choose a representative actor set:
		const candidates = new Set();
		for (const a of game.actors?.contents ?? []) candidates.add(a);
		for (const t of canvas.tokens?.placeables ?? [])
			if (t?.actor) candidates.add(t.actor);
		for (const a of candidates) queueSync(a, 1);
	};

	// Run once when ready
	doInitial();

	// Also re-sweep when canvas (scene) swaps to clean up synthetic tokens
	Hooks.on("canvasReady", () => doInitial());

	// New documents during play
	Hooks.on("createActor", (actor) => queueSync(actor, 1));
	Hooks.on(
		"createToken",
		(tokenDoc) => tokenDoc?.actor && queueSync(tokenDoc.actor, 1)
	);
});
