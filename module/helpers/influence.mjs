/* global game, canvas, foundry, Hooks, CONST */

/**
 * helpers/influence.mjs
 * ---------------------------------------------------------------------------
 * Global Influence utilities + index builder + (optional) sheet symmetry sync.
 *
 * Goals:
 *  - Keep fuzzy matching identical everywhere.
 *  - Build a single global hash of connections derived from character flags.
 *  - Allow querying "does A have influence over B?" using only token/actor names.
 *  - (Optional) Keep character↔character influences symmetric on sheet flags.
 *
 * Performance:
 *  - The index scans only Character actors (not NPCs) and only when flags or
 *    relevant names change (or canvas changes). It stores a compact Map:
 *       edges: Map<fromKeyNormalized, Set<toKeyNormalized>>
 *    where keys are normalized names (see normalize()).
 *  - Token name lookups are done against this map with substring tests.
 *    Typical influence counts are small, so this is very fast in practice.
 */

export const NS = "masks-newgeneration-extensions";
const FLAG_PATH = "flags.masks-newgeneration-unofficial.influences";

/* ----------------------------- Normalization ----------------------------- */

/** Fuzzy normalize per requirement:
 *  - lowercase
 *  - strip occurrences of "the", "lady", "sir" anywhere (intentionally lax)
 *  - strip all whitespace
 */
export function normalize(s) {
  if (!s) return "";
  return String(s).toLowerCase().replace(/the|lady|sir/g, "").replace(/\s+/g, "");
}

/** Return a character's Real Name if present (system.attributes.realName.value) */
export function actorRealName(actor) {
  return foundry.utils.getProperty(actor, "system.attributes.realName.value") || "";
}

/** Return a list of candidate display names for an actor; no token context. */
export function candidateActorNames(actor) {
  const list = [];
  if (actor?.name) list.push(actor.name);
  const rn = actorRealName(actor);
  if (rn && rn !== actor.name) list.push(rn);
  return [...new Set(list.filter(Boolean))];
}

/** Return a list of candidate display names for a token (actor+token). */
export function candidateTokenNames(actor, token) {
  const list = candidateActorNames(actor);
  const tn = token?.document?.name || token?.name || "";
  if (tn && !list.includes(tn)) list.push(tn);
  return list;
}

/** Build a composite normalized key from all relevant names of actor(+token). */
export function compositeKey(actor, token = null) {
  // Join with separators to avoid accidental merges; we only ever use substring checks.
  const joined = candidateTokenNames(actor, token).join("|");
  return normalize(joined);
}

/** Deep-cloned influences array from a Character actor (never NPC). */
export function readInfluences(actor) {
  return foundry.utils.deepClone(
    foundry.utils.getProperty(actor, FLAG_PATH) || []
  );
}

/* ------------------------------ InfluenceIndex ------------------------------ */

class InfluenceIndexImpl {
  constructor() {
    /** @type {Map<string, Set<string>>} edges[fromKeyNormalized] -> set(toKeyNormalized) */
    this.edges = new Map();
    /** Cache of all "from" keys for quick iteration */
    this.fromKeys = new Set();
    /** Simple bump counter to invalidate dependent caches */
    this.version = 0;

    /** Token key cache: tokenId -> { key: string, v: number } */
    this._tokKeyCache = new Map();

    /** Guard set for symmetry sync (avoid infinite loops) */
    this._syncGuard = new Set();

    this._registerMinimalHooks();
  }

  /* ------------------------------- Rebuilding ------------------------------- */

  /** Force a rebuild of the global edges index (Characters only). */
  rebuild() {
    this.edges.clear();
    this.fromKeys.clear();

    // Scan all Character actors in the world; NPC sheets do not store influences.
    const chars = (game.actors?.contents ?? []).filter(a => a?.type === "character");
    for (const a of chars) {
      const aKey = compositeKey(a, null); // actor-only (no token)
      if (!aKey) continue;

      const infl = readInfluences(a); // [{name, hasInfluenceOver, haveInfluenceOver, ...}]
      if (!Array.isArray(infl) || !infl.length) continue;

      for (const e of infl) {
        const n = normalize(e?.name);
        if (!n) continue;

        // a.haveInfluenceOver === true  => edge: A -> N
        if (e?.haveInfluenceOver === true) this._addEdge(aKey, n);

        // a.hasInfluenceOver === true   => edge: N -> A
        if (e?.hasInfluenceOver === true) this._addEdge(n, aKey);
      }
    }

    this.version++;
  }

  _addEdge(fromKey, toKey) {
    let set = this.edges.get(fromKey);
    if (!set) {
      set = new Set();
      this.edges.set(fromKey, set);
      this.fromKeys.add(fromKey);
    }
    set.add(toKey);
  }

  /* ---------------------------- Querying & Match ---------------------------- */

  /**
   * Return the composite normalized key for a token, cached per-index version.
   */
  tokenKey(token) {
    const id = token?.id;
    if (!id) return "";
    const entry = this._tokKeyCache.get(id);
    if (entry && entry.v === this.version) return entry.key;

    const k = compositeKey(token?.actor, token);
    this._tokKeyCache.set(id, { key: k, v: this.version });
    return k;
  }

  /** Invalidate a token's cached composite key (e.g., on name change). */
  invalidateToken(tokenId) {
    if (tokenId) this._tokKeyCache.delete(tokenId);
  }

  /** Clear all token key caches (e.g., on canvas change). */
  invalidateAllTokens() {
    this._tokKeyCache.clear();
  }

  /**
   * Determine if there is an edge from entity represented by aKeyStr to entity bKeyStr.
   * We match by substring:
   *   Exists F in fromKeys with (aKeyStr.includes(F)) AND
   *   Exists T in edges.get(F) with (bKeyStr.includes(T)).
   */
  hasEdgeFromKeyToKey(aKeyStr, bKeyStr) {
    if (!aKeyStr || !bKeyStr) return false;
    for (const F of this.fromKeys) {
      if (!aKeyStr.includes(F)) continue;
      const toSet = this.edges.get(F);
      if (!toSet || toSet.size === 0) continue;
      for (const T of toSet) {
        if (bKeyStr.includes(T)) return true;
      }
    }
    return false;
  }

  /** Convenience wrapper for tokens. */
  hasEdgeFromTokenToToken(tokenA, tokenB) {
    const aKey = this.tokenKey(tokenA);
    const bKey = this.tokenKey(tokenB);
    return this.hasEdgeFromKeyToKey(aKey, bKey);
  }

  /* -------------------------- Symmetry Sheet Sync --------------------------- */

  /**
   * Keep character↔character influence flags symmetric.
   * If A says "haveInfluenceOver: true" for B, then on B we ensure
   * "hasInfluenceOver: true" for A; and vice versa.
   *
   * Only applied to Character targets; NPC sheets are not modified.
   * Guarded to avoid infinite update loops.
   */
  async syncCharacterPairFlags(actor) {
    if (!actor || actor.type !== "character") return;
    if (this._syncGuard.has(actor.id)) return;

    const aKey = compositeKey(actor);
    if (!aKey) return;

    const aInfl = readInfluences(actor);
    if (!Array.isArray(aInfl)) return;

    // Collect target updates by actor id to batch writes.
    /** @type {Map<string, {doc: Actor, infl: any[], dirty: boolean}>} */
    const targetMap = new Map();

    const findTargetCharacterByNorm = (norm) => {
      // Prefer exact match on actor.name or realName, else fallback to contains.
      const chars = (game.actors?.contents ?? []).filter(x => x?.type === "character" && x.id !== actor.id);
      let exact = null;
      let partial = null;

      for (const t of chars) {
        const tNames = candidateActorNames(t);
        let isExact = false;
        for (const nm of tNames) {
          const nN = normalize(nm);
          if (nN === norm) { isExact = true; break; }
        }
        if (isExact) return t;

        // partial store the first "contains" candidate if nothing exact found
        const tKey = compositeKey(t);
        if (!partial && tKey.includes(norm)) partial = t;
      }
      return exact || partial;
    };

    const ensureEntry = (arr, nameForEntry) => {
      const idx = arr.findIndex(e => normalize(e?.name) === normalize(nameForEntry));
      if (idx >= 0) return { idx, obj: arr[idx] };
      const obj = {
        id: (foundry.utils.randomID?.(16) ?? Math.random().toString(36).slice(2)),
        name: nameForEntry,
        hasInfluenceOver: false,
        haveInfluenceOver: false,
        locked: false
      };
      arr.push(obj);
      return { idx: arr.length - 1, obj };
    };

    // Walk A's declared influences
    for (const e of aInfl) {
      const n = normalize(e?.name);
      if (!n) continue;

      // Only sync when the counterpart is a Character
      const tActor = findTargetCharacterByNorm(n);
      if (!tActor) continue;

      let bucket = targetMap.get(tActor.id);
      if (!bucket) {
        bucket = { doc: tActor, infl: readInfluences(tActor), dirty: false };
        targetMap.set(tActor.id, bucket);
      }

      // Symmetry:
      //   A.haveInfluenceOver(B) => on B, hasInfluenceOver(A)
      //   A.hasInfluenceOver(B)  => on B, haveInfluenceOver(A)
      const aOverB = !!e?.haveInfluenceOver;
      const bOverA = !!e?.hasInfluenceOver;

      const entry = ensureEntry(bucket.infl, actor.name ?? "Actor");
      const prev = { has: !!entry.obj.hasInfluenceOver, have: !!entry.obj.haveInfluenceOver };

      const desiredHas  = aOverB ? true : prev.has;   // B.hasInfluenceOver(A)
      const desiredHave = bOverA ? true : prev.have;  // B.haveInfluenceOver(A)

      // If neither side is true on A anymore and the B entry is only pointing back
      // to A because of symmetry, clear B's flags too.
      if (!aOverB && !bOverA) {
        // Reset B->A flags; if they end up both false and unlocked, prune later
        entry.obj.hasInfluenceOver = false;
        entry.obj.haveInfluenceOver = false;
      } else {
        entry.obj.hasInfluenceOver = desiredHas;
        entry.obj.haveInfluenceOver = desiredHave;
      }

      // prune if empty & not locked
      if (!entry.obj.hasInfluenceOver && !entry.obj.haveInfluenceOver && entry.obj.locked !== true) {
        bucket.infl.splice(entry.idx, 1);
      }

      bucket.dirty = bucket.dirty || (prev.has !== entry.obj.hasInfluenceOver || prev.have !== entry.obj.haveInfluenceOver);
    }

    // Apply writes
    const updates = [];
    for (const { doc, infl, dirty } of targetMap.values()) {
      if (!dirty) continue;
      // Guard to avoid loops
      this._syncGuard.add(doc.id);
      try {
        updates.push(doc.setFlag("masks-newgeneration-unofficial", "influences", infl));
      } catch (err) {
        console.error(`[${NS}] Failed to sync Influence flags on ${doc.name}`, err);
      } finally {
        // let Foundry finish its update cycle before releasing guard
        setTimeout(() => this._syncGuard.delete(doc.id), 0);
      }
    }
    if (updates.length) {
      try { await Promise.allSettled(updates); }
      finally { /* no-op */ }
      // Rebuild index to reflect latest writes
      this.rebuild();
    }
  }

  /* ------------------------------ Minimal hooks ----------------------------- */

  _registerMinimalHooks() {
    // When the scene/canvas changes, token ids and names can change; clear caches.
    Hooks.on("canvasReady", () => this.invalidateAllTokens());

    // Rebuild when relevant actor data changes
    Hooks.on("updateActor", (actor, changes) => {
      const inflChanged = foundry.utils.getProperty(changes, FLAG_PATH) !== undefined;
      const nameChanged = changes.name !== undefined ||
        foundry.utils.getProperty(changes, "system.attributes.realName.value") !== undefined;

      if (inflChanged || nameChanged) {
        // If we are NOT the one performing symmetry writes, optionally sync pair now.
        if (inflChanged && !this._syncGuard.has(actor.id)) {
          // Fire and forget; do not await to keep UI snappy.
          this.syncCharacterPairFlags(actor);
        }
        this.rebuild();
      }
    });

    // Initial build at ready
    Hooks.once("ready", () => {
      this.rebuild();
    });
  }
}

/** Singleton InfluenceIndex */
export const InfluenceIndex = new InfluenceIndexImpl();

/* ------------------------ Optional: public registration --------------------- */

/**
 * Register a very small set of hooks the line-drawer can rely on.
 * Not strictly required to call; importing this module runs the minimal hooks.
 */
export function registerInfluenceHelpers() {
  // No-op placeholder to make intent explicit in callers.
  return true;
}
