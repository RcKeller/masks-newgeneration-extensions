#!/usr/bin/env node
/**
 * port-packs-to-masks.mjs
 * -----------------------------------------------------------------------------
 * Ports villains found in source documents (PDF/TXT/MD/JSON) into Foundry VTT
 * Masks: A New Generation NPC JSON files, using OpenRouter (Gemini 2.5 Pro)
 * to extract/author content. Outputs one file per NPC with a strict schema
 * matching ./example-npc.json (structure and keys), while generating BRAND NEW
 * villain & condition moves for each NPC.
 *
 * Key requirements implemented:
 * - Provider: OpenRouter (Gemini 2.5 Pro) via Chat Completions JSON-only output
 * - Reads all files in an input directory (default: ./src/packs)
 * - Continues even if one file or NPC fails (warns and moves on)
 * - For every NPC:
 *    • Generate fresh 16-char alphanumeric IDs for ACTOR and EVERY ITEM
 *    • Keep GM baseline moves; synthesize 3–5 VILLAIN moves; 5 CONDITION moves
 *    • Retain "img" path from te-core-rules if detectable; else fallback
 *    • Produce exact data structure from example-npc.json
 * - Robust rate-limit & transient error handling (429, 5xx) with bounded retries
 * - Strong post-parse validation & auto-synthesis if model under-fills anything
 * - Output file per NPC named: npc_<VILLAIN_NAME>_<UUID>.json
 *   in configurable outdir (default ./src/packs/ported)
 *
 * Usage:
 *   node tools/port-packs-to-masks.mjs \
 *     --in ./src/packs \
 *     --out ./src/packs/ported \
 *     --model google/gemini-2.5-pro \
 *     --max-tokens 4000 \
 *     --concurrency 2
 *
 * Env:
 *   OPENROUTER_API_KEY (required)
 *   OPENROUTER_REFERRER (optional - shown on OpenRouter leaderboards)
 *   OPENROUTER_TITLE    (optional - shown on OpenRouter leaderboards)
 *
 * Notes:
 * - For PDFs, this script attempts to use `pdf-parse` dynamically if present.
 *   Install with: npm i pdf-parse
 *   If unavailable, PDF files are skipped with a warning (no hard failure).
 * - JSON-only model output is requested and then validated/normalized before
 *   writing Foundry-ready actor items.
 * - This script does not mutate your src files; it only writes new JSON files
 *   to the output directory.
 * -----------------------------------------------------------------------------
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";

// ---- CLI ARG PARSING -------------------------------------------------------

const argv = new Map(
  process.argv.slice(2).reduce((acc, cur) => {
    const m = cur.match(/^--([^=\s]+)(?:=(.+))?$/);
    if (m) acc.push([m[1], m[2] ?? true]);
    return acc;
  }, /** @type {[string,string|boolean][]} */ ([]))
);

const INPUT_DIR = path.resolve(String(argv.get("in") ?? "./src/packs"));
const OUTPUT_DIR = path.resolve(String(argv.get("out") ?? "./src/packs/ported"));
const MODEL = String(argv.get("model") ?? "google/gemini-2.5-pro");
const MAX_TOKENS = Number(argv.get("max-tokens") ?? 65535);
const CONCURRENCY = Math.max(1, Number(argv.get("concurrency") ?? 2));
const DRY_RUN = Boolean(argv.get("dry-run") ?? false);

// ---- OPENROUTER CONFIG -----------------------------------------------------

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_REFERRER = process.env.OPENROUTER_REFERRER ?? "";
const OPENROUTER_TITLE = process.env.OPENROUTER_TITLE ?? "Masks NPC Porting Tool";

if (!OPENROUTER_API_KEY) {
  console.error("ERROR: OPENROUTER_API_KEY environment variable is required.");
  process.exit(1);
}

// ---- OPTIONAL PDF SUPPORT ---------------------------------------------------

let pdfParse = null;
try {
  const mod = await import("pdf-parse").catch(() => null);
  pdfParse = mod ? (mod.default ?? mod) : null;
} catch {
  pdfParse = null;
}

// ---- UTILITIES --------------------------------------------------------------

/** Generate a 16-character alphanumeric UUID */
function gen16() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += chars[bytes[i] % chars.length];
  return s;
}

/** Validate 16-char alphanumeric */
function is16Id(s) {
  return typeof s === "string" && s.length === 16 && /^[A-Za-z0-9]+$/.test(s);
}

function safeName(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Sleep helper */
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/** Extract JSON from a string safely (handles accidental code fences) */
function extractJson(text) {
  if (!text) throw new Error("Empty model response");
  // Strip Markdown fences if present
  const fence = text.match(/```json([\s\S]*?)```/i);
  const body = fence ? fence[1] : text.trim();

  // Find first JSON object or array
  const firstBrace = body.indexOf("{");
  const firstBracket = body.indexOf("[");
  let start = -1;
  if (firstBrace === -1 && firstBracket === -1) {
    throw new Error("No JSON object/array found in response.");
  }
  if (firstBrace !== -1 && firstBracket !== -1) start = Math.min(firstBrace, firstBracket);
  else start = Math.max(firstBrace, firstBracket);

  // Try direct parse first
  try {
    return JSON.parse(body);
  } catch {
    // Attempt to locate a balanced object/array region
    const sub = body.slice(start);
    // naive balancing
    let depth = 0;
    let end = -1;
    const open = sub[0] === "{" ? "{" : "[";
    const close = open === "{" ? "}" : "]";
    for (let i = 0; i < sub.length; i++) {
      if (sub[i] === open) depth++;
      if (sub[i] === close) depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end > 0) return JSON.parse(sub.slice(0, end));
    throw new Error("Failed to balance JSON in response.");
  }
}

/** Find first te-core-rules image path occurrence within text */
function findTeCoreRulesImg(text) {
  if (!text) return null;
  const re = /(te-core-rules[\/\w\.\-\_]+?\.(?:png|jpg|jpeg|webp|svg|gif))/i;
  const m = text.match(re);
  if (!m) return null;
  // Return relative path as-is; Foundry will resolve if module is present
  return m[1].replace(/\\/g, "/");
}

/** HTML encode a string minimally (for <p> content) */
function pHtml(s) {
  if (!s) return "";
  const e = String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<p>${e}</p>`;
}

// ---- LLM CALL (OpenRouter) --------------------------------------------------

async function callOpenRouterJSON(messages, { model = MODEL, maxTokens = MAX_TOKENS, temperature = 0.3, retries = 5 } = {}) {
  const url = "https://openrouter.ai/api/v1/chat/completions";
  let attempt = 0;
  let backoff = 1000;

  while (attempt <= retries) {
    attempt++;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "HTTP-Referer": OPENROUTER_REFERRER,
          "X-Title": OPENROUTER_TITLE,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature,
        //   max_tokens: maxTokens,
          response_format: { type: "json_object" }, // JSON-only
          messages,
        }),
      });

      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        const body = await res.text().catch(() => "");
        console.warn(`[OpenRouter] Transient ${res.status}. Attempt ${attempt}/${retries}. Body: ${body.slice(0, 200)}...`);
        if (attempt > retries) throw new Error(`OpenRouter error ${res.status} after ${retries} retries.`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`OpenRouter HTTP ${res.status}: ${body}`);
      }

      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      if (!content) throw new Error("OpenRouter returned no content.");
      const parsed = extractJson(typeof content === "string" ? content : content?.[0]?.text ?? "");
      return parsed;
    } catch (err) {
      if (attempt > retries) throw err;
      console.warn(`[OpenRouter] Error on attempt ${attempt}/${retries}: ${err?.message || err}. Retrying in ${Math.round(backoff/1000)}s...`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
  throw new Error("Unreachable - retries exhausted");
}

// ---- MODEL PROMPTING --------------------------------------------------------

const SYSTEM_PROMPT = `
You are an expert tabletop RPG development assistant. You read source documents
(PDF/TXT/MD/JSON) containing villains/NPCs from various game systems and then
author *new* Masks: A New Generation (PbtA) villains suitable for Foundry VTT.

Task:
- From the provided text chunk, detect each distinct villain/NPC (name + any clearly tied details).
- For each NPC you find, return a compact JSON object with:
  name                 : string
  realName             : string|null (omit or null if unknown)
  img                  : string|null (if source text mentions a te-core-rules path, include it; otherwise null)
  tags                 : string (comma-separated)
  drive                : string (1–3 short lines)
  abilities            : string (brief description of powers/edges; HTML allowed)
  biography            : string (short paragraph; HTML allowed)
  villainMoves         : array of 3–5 objects with { name, description } each; description should be a short Masks-style GM move (HTML OK), no dice formulas, no references to non-Masks mechanics. DO NOT repeat across NPCs. DO NOT include GM baseline moves.
  conditionMoves       : object with exactly 5 keys: afraid, angry, guilty, hopeless, insecure.
                         Each value is { name, description } describing how THIS villain behaves when that condition is marked. Short, evocative, Masks-flavored. NEW content only.

Constraints:
- Output MUST be strict JSON with a top-level object: { "npcs": [ ... ] }
- Do not include IDs; the caller will mint 16-char alphanumeric IDs.
- Keep text concise and game-ready. 
- Never include Markdown fences or backticks; return raw JSON only.
`;

function makeUserPrompt({ fileName, text, teImgPathHint }) {
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `Source File: ${fileName}\n` +
            (teImgPathHint ? `Image path hint (if applicable): ${teImgPathHint}\n` : "") +
            `--- BEGIN CONTENT ---\n${text}\n--- END CONTENT ---\n` +
            `Return JSON with key "npcs". If none found, return { "npcs": [] }`,
        },
      ],
    },
  ];
}

// ---- FILE SCANNING / CONTENT EXTRACTION ------------------------------------

const ACCEPTED_EXTS = new Set([".pdf", ".txt", ".md", ".json"]);

async function* walk(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else {
      if (ACCEPTED_EXTS.has(path.extname(e.name).toLowerCase())) {
        yield full;
      }
    }
  }
}

async function readTextFromFile(file) {
  const ext = path.extname(file).toLowerCase();
  try {
    if (ext === ".pdf") {
      if (!pdfParse) {
        console.warn(`Skipping PDF (pdf-parse not installed): ${file}`);
        return null;
      }
      const buf = await fsp.readFile(file);
      const data = await pdfParse(buf);
      return data.text || null;
    }
    if (ext === ".json") {
      // Convert JSON content into a readable plain text summary for the model
      const raw = await fsp.readFile(file, "utf-8");
      const json = JSON.parse(raw);
      return JSON.stringify(json, null, 2);
    }
    // .txt/.md
    return await fsp.readFile(file, "utf-8");
  } catch (err) {
    console.warn(`Failed to read ${file}: ${err?.message || err}`);
    return null;
  }
}

// ---- SYNTHESIS / NORMALIZATION ---------------------------------------------

// A small pool of module icon paths we can rotate for villain moves
const MOVE_ICON_POOL = [
  "modules/masks-newgeneration-unofficial/images/gameicons/conqueror-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/eye-target-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/suspicious-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/enrage-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/popcorn-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/convince-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/confrontation-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/broken-pottery-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/arrest-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/target-dummy-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/bulldozer-%23ffffff-%233da7db.svg",
  "icons/svg/aura.svg"
];

// Baseline GM options (kept across NPCs; do not remove)
const BASELINE_GM_MOVES = [
  {
    name: "Inflict a Condition",
    description: "<p>Baseline GM option: have the villain’s actions cause a hero to <b>mark a condition</b> (fear, anger, guilt, hopelessness, insecurity) as appropriate.</p>",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/convince-%23ffffff-%233da7db.svg"
  },
  {
    name: "Take Influence",
    description: "<p>Baseline GM option: show the villain <b>seizing Influence</b> over a hero through awe, shame, or negotiation, shifting Labels or pressuring choices per Masks rules.</p>",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/distraction-%23ffffff-%233da7db.svg"
  },
  {
    name: "Capture Someone",
    description: "<p>Baseline GM option: separate or restrain a target by the fiction (bindings, cages, wards, stone, tech restraints), consistent with the villain’s theme.</p>",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/arrest-%23ffffff-%233da7db.svg"
  },
  {
    name: "Put Innocents in Danger",
    description: "<p>Baseline GM option: endanger bystanders, forcing hard choices or splitting the team, per Masks GM guidance.</p>",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/target-dummy-%23ffffff-%233da7db.svg"
  },
  {
    name: "Show the Costs of Collateral Damage",
    description: "<p>Baseline GM option: spotlight cracked streets, shattered windows, and endangered artifacts—escalating stakes in the environment.</p>",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/bulldozer-%23ffffff-%233da7db.svg"
  },
  {
    name: "Tell Them Possible Consequences and Ask",
    description: "<p>Baseline GM option: lay out what the villain’s next move will cost and ask what they do now, per GM principles.</p>",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/death-note-%23ffffff-%233da7db.svg"
  }
];

// Provide fallback villain move names if the model under-fills
function synthesizeVillainMoves(npcName, count = 3) {
  const base = [
    { name: "Stage the Perfect Complication", description: "<p>Unveil a prepared twist that splits the team or puts an asset at risk; <b>force hard choices</b> before anyone can act freely.</p>" },
    { name: "Weaponize the Scene", description: "<p>Turn local terrain, tech, or superstition into an <b>immediate obstacle</b> that must be overcome before progress.</p>" },
    { name: "Twist the Spotlight", description: "<p>Shift attention to an unready or pressured hero; <b>shift Labels</b> via Influence or public pressure, then strike.</p>" },
    { name: "Smoke and Escape", description: "<p>Give a clear path out or <b>impose a countdown</b>; if the team doesn’t commit, the villain <b>escapes</b> with leverage.</p>" },
    { name: "Call in a Favor", description: "<p>Bring in a rival, hazard, or minion that <b>overloads</b> the heroes’ current plan, forcing adaptation.</p>" }
  ];
  // Take first N, tweak names slightly per NPC
  return base.slice(0, Math.max(3, Math.min(5, count))).map((m, i) => ({
    name: `${m.name}`,
    description: m.description
  }));
}

// Fallback custom condition moves if missing
function synthesizeConditionMoves(theme = "villain") {
  return {
    afraid: { name: "Shadows and Misdirection", description: "<p>They retreat behind <b>illusions or cover</b>; to pin them down, heroes must break the veil or risk exposure.</p>" },
    angry:  { name: "Break the Symbols", description: "<p>They lash out at what the team values—<b>destroying symbols</b> or camaraderie to rattle morale.</p>" },
    guilty: { name: "Moment of Remorse", description: "<p>They <b>aid a bystander</b> or repair a harm, opening a window for influence if a hero reaches out.</p>" },
    hopeless:{ name: "Slip Between the Panels", description: "<p>They try to <b>exit the scene</b> or banish a hero; intercept or someone is gone when the page turns.</p>" },
    insecure:{ name: "Rewrite a Resolved Threat", description: "<p>They <b>reignite</b> a problem the team thought solved, overcompensating to mask doubt.</p>" }
  };
}

// Foundry mask actor template builder
function buildActorTemplate() {
  // Template cloned from example-npc.json (structure preserved)
  return JSON.parse(`{
    "name": "",
    "type": "npc",
    "img": "icons/svg/mystery-man.svg",
    "system": {
      "stats": {},
      "attributes": {
        "conditions": {
          "label": "Conditions",
          "description": "Choose all that apply:",
          "customLabel": false,
          "userLabel": false,
          "type": "ListMany",
          "condition": false,
          "position": "Left",
          "options": {
            "0": { "label": "Afraid", "value": false },
            "1": { "label": "Angry",  "value": false },
            "2": { "label": "Guilty", "value": false },
            "3": { "label": "Hopeless","value": false },
            "4": { "label": "Insecure","value": false }
          }
        },
        "realName": {
          "label": "Real Name",
          "description": null,
          "customLabel": false,
          "userLabel": false,
          "type": "Text",
          "value": "",
          "position": "Left"
        },
        "generation": {
          "label": "Generation",
          "description": null,
          "customLabel": false,
          "userLabel": false,
          "type": "Text",
          "value": "",
          "position": "Left"
        }
      },
      "attrLeft": {},
      "attrTop": {},
      "details": {
        "drive": { "label": "Drive", "value": "" },
        "abilities": { "label": "Abilities", "value": "" },
        "biography": { "label": "Notes", "value": "" }
      },
      "tags": ""
    },
    "prototypeToken": {
      "name": "Villain",
      "displayName": 0,
      "actorLink": false,
      "width": 1,
      "height": 1,
      "texture": {
        "src": "icons/svg/mystery-man.svg",
        "anchorX": 0.5,
        "anchorY": 0.5,
        "offsetX": 0,
        "offsetY": 0,
        "fit": "contain",
        "scaleX": 1,
        "scaleY": 1,
        "rotation": 0,
        "tint": "#ffffff",
        "alphaThreshold": 0.75
      },
      "lockRotation": false,
      "rotation": 0,
      "alpha": 1,
      "disposition": -1,
      "displayBars": 0,
      "bar1": { "attribute": null },
      "bar2": { "attribute": null },
      "light": {
        "negative": false,
        "priority": 0,
        "alpha": 0.5,
        "angle": 360,
        "bright": 0,
        "color": null,
        "coloration": 1,
        "dim": 0,
        "attenuation": 0.5,
        "luminosity": 0.5,
        "saturation": 0,
        "contrast": 0,
        "shadows": 0,
        "animation": { "type": null, "speed": 5, "intensity": 5, "reverse": false },
        "darkness": { "min": 0, "max": 1 }
      },
      "sight": {
        "enabled": false,
        "range": 0,
        "angle": 360,
        "visionMode": "basic",
        "color": null,
        "attenuation": 0.1,
        "brightness": 0,
        "saturation": 0,
        "contrast": 0
      },
      "detectionModes": [],
      "occludable": { "radius": 0 },
      "ring": {
        "enabled": false,
        "colors": { "ring": null, "background": null },
        "effects": 1,
        "subject": { "scale": 1, "texture": null }
      },
      "turnMarker": { "mode": 1, "animation": null, "src": null, "disposition": false },
      "movementAction": null,
      "flags": {},
      "randomImg": false,
      "appendNumber": false,
      "prependAdjective": false
    },
    "items": [],
    "effects": [],
    "folder": null,
    "flags": {},
    "_stats": {
      "compendiumSource": null,
      "duplicateSource": null,
      "exportSource": {
        "worldId": "v1",
        "uuid": "",
        "coreVersion": "13.350",
        "systemId": "pbta",
        "systemVersion": "1.1.22"
      },
      "coreVersion": "13.350",
      "systemId": "pbta",
      "systemVersion": "1.1.22",
      "createdTime": 0,
      "modifiedTime": 0,
      "lastModifiedBy": ""
    },
    "baseType": "npc",
    "ownership": { "default": 0 }
  }`);
}

// Build move item shell
function buildMoveItem({ name, description, moveType, img, sort }) {
  const _id = gen16();
  const item = {
    name,
    type: "npcMove",
    system: {
      moveType: moveType ?? "",
      description: description ?? "",
      rollFormula: "",
      moveResults: {
        failure: { key: "system.moveResults.failure.value", label: "Complications...", value: "" },
        partial: { key: "system.moveResults.partial.value", label: "Partial success", value: "" },
        success: { key: "system.moveResults.success.value", label: "Success!", value: "" }
      },
      uses: 0
    },
    _id,
    img: img ?? "icons/svg/aura.svg",
    effects: [],
    folder: null,
    sort: sort ?? 0,
    flags: {},
    _stats: {
      compendiumSource: null,
      duplicateSource: null,
      exportSource: null,
      coreVersion: "13.350",
      systemId: "pbta",
      systemVersion: "1.1.22",
      lastModifiedBy: gen16()
    },
    ownership: { default: 0 }
  };
  item._key = `!items!${_id}`;
  return item;
}

// Construct a full Foundry actor from a compact NPC spec
function actorFromSpec(spec) {
  const now = Date.now();
  const actorId = gen16();

  const A = buildActorTemplate();
  A.name = String(spec.name || "Untitled Villain");
  A.img = spec.img || "icons/svg/mystery-man.svg";
  A.system.attributes.realName.value = spec.realName ?? "";
  A.system.attributes.generation.value = spec.generation ?? "";
  A.system.details.drive.value = pHtml(spec.drive?.trim() || ""); // keep as <p>
  A.system.details.abilities.value = spec.abilities?.includes("<") ? spec.abilities : pHtml(spec.abilities || "");
  A.system.details.biography.value = spec.biography?.includes("<") ? spec.biography : pHtml(spec.biography || "");
  A.system.tags = String(spec.tags || "").trim();

  // token
  A.prototypeToken.texture.src = A.img;
  A.prototypeToken.name = "Villain";

  // stats meta
  A._stats.createdTime = now;
  A._stats.modifiedTime = now;
  A._stats.lastModifiedBy = gen16();
  A._stats.exportSource.uuid = `Actor.${actorId}`;

  // Items: build villain + condition + baseline GM items
  let sort = 0;

  // Villain moves (3–5)
  const villainMoves = Array.isArray(spec.villainMoves) ? spec.villainMoves.filter(Boolean) : [];
  let usableVillain = villainMoves.slice(0, 5);
  if (usableVillain.length < 3) {
    usableVillain = usableVillain.concat(synthesizeVillainMoves(A.name, 3 - usableVillain.length));
  }
  usableVillain = usableVillain.slice(0, Math.max(3, Math.min(5, usableVillain.length)));
  usableVillain.forEach((m, idx) => {
    A.items.push(
      buildMoveItem({
        name: String(m.name || `Villain Move ${idx + 1}`),
        description: m.description?.includes("<") ? m.description : pHtml(m.description || ""),
        moveType: "villain",
        img: MOVE_ICON_POOL[(idx + A.name.length) % MOVE_ICON_POOL.length],
        sort: sort
      })
    );
    sort += 10;
  });

  // Condition moves (exactly 5: afraid, angry, guilty, hopeless, insecure)
  let cond = spec.conditionMoves;
  if (!cond || typeof cond !== "object") cond = synthesizeConditionMoves();
  const keys = ["afraid", "angry", "guilty", "hopeless", "insecure"];
  const friendlyNames = {
    afraid: "Afraid",
    angry: "Angry",
    guilty: "Guilty",
    hopeless: "Hopeless",
    insecure: "Insecure"
  };
  keys.forEach((k, i) => {
    const m = cond[k] ?? synthesizeConditionMoves()[k];
    const name = `${friendlyNames[k]} — ${String(m?.name || "Custom Reaction")}`;
    A.items.push(
      buildMoveItem({
        name,
        description: m?.description?.includes("<") ? m.description : pHtml(m?.description || ""),
        moveType: "condition",
        img: MOVE_ICON_POOL[(i + 7) % MOVE_ICON_POOL.length],
        sort
      })
    );
    sort += 10;
  });

  // Baseline GM moves (unchanged)
  BASELINE_GM_MOVES.forEach((gm, i) => {
    A.items.push(
      buildMoveItem({
        name: gm.name,
        description: gm.description,
        moveType: "",
        img: gm.img,
        sort
      })
    );
    sort += 10;
  });

  // Finalize actor IDs
  A._id = actorId;
  A._key = `!actors!${actorId}`;
  return A;
}

// Validate actor structure & auto-fill if missing
function validateActor(actor) {
  const errors = [];

  if (!is16Id(actor._id)) errors.push("Actor _id invalid or missing.");
  if (actor.type !== "npc") errors.push("Actor type must be npc.");
  if (!actor.items || !Array.isArray(actor.items)) errors.push("Actor items missing.");
  else {
    const itemIds = new Set();
    for (const it of actor.items) {
      if (!is16Id(it._id)) errors.push(`Item ${it.name} missing valid _id.`);
      if (itemIds.has(it._id)) errors.push(`Duplicate item id: ${it._id}`);
      itemIds.add(it._id);
    }
    // 3–5 villain + 5 condition + 6 baseline GM
    const vCount = actor.items.filter(i => i.system?.moveType === "villain").length;
    const cCount = actor.items.filter(i => i.system?.moveType === "condition").length;
    const gCount = actor.items.filter(i => (i.system?.moveType ?? "") === "").length;
    if (vCount < 3 || vCount > 5) errors.push(`Villain move count must be 3–5; got ${vCount}`);
    if (cCount !== 5) errors.push(`Condition move count must be 5; got ${cCount}`);
    if (gCount < 6) errors.push(`Baseline GM moves appear incomplete; expected >= 6; got ${gCount}`);
  }
  return errors;
}

// ---- WRITER -----------------------------------------------------------------

async function writeActor(actor, outDir) {
  const id = actor._id;
  const fname = `npc_${safeName(actor.name)}_${id}.json`;
  const full = path.join(outDir, fname);
  const json = JSON.stringify(actor, null, 2);
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would write: ${full}`);
    return full;
  }
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(full, json, "utf-8");
  return full;
}

// ---- CHUNKING ---------------------------------------------------------------

/**
 * Simple chunker to keep prompt size manageable.
 * Splits by ~18,000 chars target (rough heuristic for Gemini context).
 */
function chunkText(s, size = 18000) {
  const chunks = [];
  let i = 0;
  while (i < s.length) {
    chunks.push(s.slice(i, i + size));
    i += size;
  }
  return chunks;
}

// ---- PIPELINE ---------------------------------------------------------------

async function processFile(file) {
  const base = path.basename(file);
  console.log(`\n--- Processing: ${base} ---`);

  const text = await readTextFromFile(file);
  if (!text) {
    console.warn(`No text extracted from ${base}; skipping.`);
    return [];
  }

  const teImgPathHint = findTeCoreRulesImg(text);
  const chunks = chunkText(text);
  const foundNPCs = [];

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...makeUserPrompt({ fileName: base + ` [Part ${idx + 1}/${chunks.length}]`, text: chunk, teImgPathHint })
    ];
    let parsed;
    try {
      parsed = await callOpenRouterJSON(messages);
    } catch (err) {
      console.warn(`Model failure on ${base} part ${idx + 1}: ${err?.message || err}`);
      continue; // continue to next chunk
    }

    const npcs = Array.isArray(parsed?.npcs) ? parsed.npcs : [];
    if (!npcs.length) continue;
    for (const n of npcs) {
      try {
        // Normalize minimal fields
        const spec = {
          name: String(n.name || "Untitled Villain").trim(),
          realName: n.realName ?? "",
          img: n.img || teImgPathHint || null,
          tags: String(n.tags || "").trim(),
          drive: String(n.drive || ""),
          abilities: String(n.abilities || ""),
          biography: String(n.biography || ""),
          villainMoves: Array.isArray(n.villainMoves) ? n.villainMoves.slice(0, 5) : [],
          conditionMoves: typeof n.conditionMoves === "object" ? n.conditionMoves : null
        };

        // Build actor
        const actor = actorFromSpec(spec);
        // Validate & auto-fix if needed
        const errs = validateActor(actor);
        if (errs.length) {
          console.warn(`Validation issues for ${spec.name}: ${errs.join("; ")}`);
          // Attempt basic correction for villain move count
          const vCount = actor.items.filter(i => i.system?.moveType === "villain").length;
          if (vCount < 3) {
            const extras = synthesizeVillainMoves(actor.name, 3 - vCount);
            let sort = Math.max(0, ...actor.items.map(i => i.sort ?? 0)) + 10;
            for (const m of extras) {
              actor.items.unshift(
                buildMoveItem({
                  name: m.name,
                  description: m.description,
                  moveType: "villain",
                  img: MOVE_ICON_POOL[(sort / 10) % MOVE_ICON_POOL.length],
                  sort
                })
              );
              sort += 10;
            }
          }
          // Re-validate
          const errs2 = validateActor(actor);
          if (errs2.length) {
            console.warn(`Unresolved issues for ${spec.name}: ${errs2.join("; ")}`);
          }
        }

        // Write actor
        const outPath = await writeActor(actor, OUTPUT_DIR);
        console.log(`✓ Wrote ${outPath}`);
        foundNPCs.push(outPath);
      } catch (err) {
        console.warn(`Failed to build/write NPC from ${base}: ${err?.message || err}`);
        continue;
      }
    }
  }

  if (!foundNPCs.length) {
    console.warn(`No NPCs produced from: ${base}`);
  }

  return foundNPCs;
}

// Simple concurrency control without external deps
async function runAll(files, concurrency = CONCURRENCY) {
  const queue = files.slice();
  const results = [];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const file = queue.shift();
      try {
        const outs = await processFile(file);
        results.push(...outs);
      } catch (err) {
        console.warn(`Error processing ${path.basename(file)}: ${err?.message || err}`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ---- MAIN -------------------------------------------------------------------

async function main() {
  console.log(`Input directory : ${INPUT_DIR}`);
  console.log(`Output directory: ${OUTPUT_DIR}`);
  console.log(`Model           : ${MODEL}`);
  console.log(`Max tokens      : ${MAX_TOKENS}`);
  console.log(`Concurrency     : ${CONCURRENCY}`);
  console.log(`Dry run         : ${DRY_RUN ? "YES" : "NO"}`);

  // Ensure output directory exists
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });

  // Walk input
  const files = [];
  for await (const f of walk(INPUT_DIR)) files.push(f);

  if (!files.length) {
    console.warn(`No input files with extensions ${[...ACCEPTED_EXTS].join(", ")} found under ${INPUT_DIR}`);
    return;
  }

  console.log(`Found ${files.length} file(s) to process.`);
  const outs = await runAll(files, CONCURRENCY);

  console.log(`\nDone. Created ${outs.length} NPC file(s).`);
}

main().catch((err) => {
  console.error("Fatal error:", err?.stack || err?.message || err);
  process.exit(1);
});
