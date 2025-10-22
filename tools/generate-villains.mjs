#!/usr/bin/env node
// One-off generator: creates an actor JSON per villain using your base template.
// Usage:
//   node ./tools/generate-villain-actors.mjs [--villains <path>] [--base <path>] [--out <dir>] [--dry]
//
// Defaults:
//   --villains  src/packs/villains/VILLAINS.json (falls back to several common paths)
//   --base      src/packs/villains/npc_Villain_3jt1q2oTz1qZDu0m.json
//   --out       src/packs/villains
//
// Notes:
// - Prefers your local `tools/generate-uuid.(mjs|js)` for Foundry-like IDs, else makes a 16-char base62.
// - Replaces all "3jt1q2oTz1qZDu0m" occurrences in the cloned JSON as a last safety step.

import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();

// --- CLI args ---------------------------------------------------------------
const args = new Map(process.argv.slice(2).map((v, i, a) =>
  v.startsWith("--") ? [v.slice(2), a[i + 1]?.startsWith("--") ? true : a[i + 1]] : null
).filter(Boolean));

const DRY = args.has("dry") || args.get("dry") === "true";

const VIL_PATH = await resolveFirstExisting([
  args.get("villains"),
  "src/packs/villains/VILLAINS.json",
  "src/packs/villains/villains.json",
  "src/packs/VILLAINS.json",
  "src/VILLAINS.json",
  "VILLAINS.json",
  "villains.json"
].filter(Boolean));

const BASE_PATH = args.get("base") ??
  "src/packs/villains/npc_Villain_3jt1q2oTz1qZDu0m.json";

const OUT_DIR = args.get("out") ?? "src/packs/villains";

// --- Utilities --------------------------------------------------------------
function base62Id(len = 16) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  // simple PRNG; good enough for file IDs
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function tryGenerateIdWithLocalTool() {
  // prefer your local tool if present (js or mjs); returns null if not available/failed
  const candidates = ["./tools/generate-uuid.mjs", "./tools/generate-uuid.js"];
  for (const p of candidates) {
    try {
      // Run as node child; capture stdout
      const { status, stdout } = spawnSync(process.execPath, [p], { cwd: ROOT, encoding: "utf8" });
      if (status === 0) {
        const id = String(stdout).trim();
        if (/^[A-Za-z0-9]{16}$/.test(id)) return id; // Foundry-style 16-char IDs
        // If your tool emits something else (like standard UUID), ignore and continue
      }
    } catch (_) { /* ignore */ }
  }
  return null;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(path.join(ROOT, file), "utf8"));
}
async function writeJson(file, data) {
  const full = path.join(ROOT, file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, JSON.stringify(data, null, 2) + "\n", "utf8");
}
async function exists(file) {
  try { await fs.access(path.join(ROOT, file)); return true; } catch { return false; }
}
async function resolveFirstExisting(paths) {
  for (const p of paths) if (p && await exists(p)) return p;
  throw new Error(`Could not find any villains file. Tried:\n  - ${paths.join("\n  - ")}`);
}
function safeName(name) {
  return String(name ?? "").replace(/[^a-zA-Z0-9А-я]/g, "_");
}
function nowStats(stats = {}) {
  const t = Date.now();
  return {
    ...stats,
    createdTime: t,
    modifiedTime: t
  };
}

// Replace *all* occurrences of oldId in string values (safety pass after structural updates)
function deepStringReplace(obj, oldId, newId) {
  if (obj == null) return obj;
  if (typeof obj === "string") return obj.split(oldId).join(newId);
  if (Array.isArray(obj)) return obj.map(v => deepStringReplace(v, oldId, newId));
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = deepStringReplace(v, oldId, newId);
    return out;
  }
  return obj;
}

// Build a new item object for a villain-specific move.
function buildVillainMoveFrom(template, srcMove, actorId) {
  // Keep template’s boilerplate (flags/ownership/_stats), but use srcMove content.
  const itemId = base62Id(16);

  const mergedSystem = {
    ...template.system,
    ...srcMove.system,
    moveType: "villain"
  };

  const out = {
    ...template,
    name: srcMove.name ?? template.name,
    type: "npcMove",
    system: mergedSystem,
    img: srcMove.img || template.img || "icons/svg/aura.svg",
    effects: [],
    folder: null,
    sort: 0,
    ownership: template.ownership ?? { default: 0 },
    flags: template.flags ?? {},
    _stats: nowStats(template._stats ?? {}),
    _id: itemId,
    _key: `!actors.items!${actorId}.${itemId}`
  };

  // Strip any carried-over compendiumSource/duplicate/exportSource if undesired
  if (out._stats) {
    out._stats.compendiumSource = null;
    out._stats.duplicateSource = null;
    out._stats.exportSource = null;
  }
  return out;
}

// Update all embedded item keys to the new actor id
function retargetItemKeys(items, actorId) {
  return items.map(it => ({
    ...it,
    _key: `!actors.items!${actorId}.${it._id}`
  }));
}

// --- Main -------------------------------------------------------------------
(async () => {
  const villains = await readJson(VIL_PATH);
  const base = await readJson(BASE_PATH);

  const originalId = String(base._id ?? "").trim();
  if (!originalId) throw new Error(`Base file missing _id: ${BASE_PATH}`);

  // find the 3 placeholder villain-move templates in the base actor
  const baseVillainMoveTemplates = (base.items ?? []).filter(
    i => i?.type === "npcMove" && i?.system?.moveType === "villain"
  );
  if (baseVillainMoveTemplates.length < 1) {
    throw new Error("Base file does not contain any 'NPC Move' placeholders with moveType 'villain'.");
  }
  const firstVillainMoveTemplate = baseVillainMoveTemplates[0];

  let made = 0;
  for (const v of Array.isArray(villains) ? villains : []) {
    try {
      // collect this villain’s 3 custom moves (system.moveType === 'villain')
      const customMoves = (v.items ?? []).filter(
        i => i?.type === "npcMove" && (i.system?.moveType === "villain")
      );

      if (customMoves.length === 0) {
        console.warn(`[warn] ${v.name ?? "<unnamed>"} has no custom villain moves; skipping.`);
        continue;
      }

      // new actor id
      const preferred = tryGenerateIdWithLocalTool();
      const newId = preferred ?? base62Id(16);

      // clone base
      let actor = JSON.parse(JSON.stringify(base));

      // basic identity
      actor._id = newId;
      actor._key = `!actors!${newId}`;
      actor.name = v.name ?? actor.name;
      if (actor.prototypeToken) actor.prototypeToken.name = actor.name;

      // details
      if (actor.system?.details) {
        actor.system.details.drive = {
          ...(actor.system.details.drive ?? { label: "Drive" }),
          value: v?.system?.details?.drive?.value ?? ""
        };
        actor.system.details.abilities = {
          ...(actor.system.details.abilities ?? { label: "Abilities" }),
          value: v?.system?.details?.abilities?.value ?? ""
        };
        actor.system.details.biography = {
          ...(actor.system.details.biography ?? { label: "Notes" }),
          value: v?.system?.details?.biography?.value ?? ""
        };
      }

      // OPTIONAL: copy realName/generation if present on source (kept safe if absent)
      if (actor.system?.attributes) {
        const rn = v?.system?.attributes?.realName?.value;
        if (typeof rn === "string") actor.system.attributes.realName.value = rn;
        const gen = v?.system?.attributes?.generation?.value;
        if (typeof gen === "string") actor.system.attributes.generation.value = gen;
      }

      // Replace the 3 placeholder NPC Moves with this villain's 3 custom moves
      const remainingBaseItems = (actor.items ?? []).filter(i => i?.system?.moveType !== "villain");
      const taken = customMoves.slice(0, 3);
      const replacements = taken.map(m => buildVillainMoveFrom(firstVillainMoveTemplate, m, newId));
      if (customMoves.length < 3) {
        console.warn(`[warn] ${v.name}: only ${customMoves.length} villain moves found; filling ${3 - customMoves.length} slots with base placeholders.`);
        // fill with copies of template (renamed to "NPC Move" variants) if fewer than 3
        for (let i = customMoves.length; i < 3; i++) {
          const filler = buildVillainMoveFrom(firstVillainMoveTemplate, { name: `NPC Move (${i+1})`, system: { description: "" } }, newId);
          replacements.push(filler);
        }
      }

      // Rebuild items: keep all non-villain base items + new villain moves
      actor.items = [...remainingBaseItems.map(it => ({ ...it })), ...replacements];

      // Fix all items’ _key to the new actor id (the non-villain ones carried the old id)
      actor.items = retargetItemKeys(actor.items, newId);

      // Update _stats times
      actor._stats = nowStats(actor._stats ?? {});

      // Safety: deep string replace any straggler "originalId" → newId
      actor = deepStringReplace(actor, originalId, newId);

      // File name: npc_<SafeName>_<newId>.json
      const fileName = `npc_${safeName(actor.name)}_${newId}.json`;
      const outPath = path.join(OUT_DIR, fileName);

      if (DRY) {
        console.log(`[dry] would write ${outPath}`);
      } else {
        await writeJson(outPath, actor);
        console.log(`✓ wrote ${outPath}`);
        made++;
      }
    } catch (err) {
      console.error(`[error] while processing villain "${v?.name ?? "<unknown>"}":`, err?.message ?? err);
    }
  }

  if (!DRY) console.log(`\nDone. Created ${made} actor file(s) in ${OUT_DIR}`);

})().catch(e => {
  console.error(e);
  process.exit(1);
});
