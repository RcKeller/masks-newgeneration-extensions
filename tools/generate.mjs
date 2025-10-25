#!/usr/bin/env node
/**
 * masks-npc-porter.mjs
 * ---------------------------------------------------------------------------
 * Batch-port NPCs from PDFs (or plaintext) into Masks: A New Generation NPC
 * JSON files for Foundry VTT v13+, using OpenRouter (Gemini 2.5 Pro) to help
 * with parsing and drafting moves. Each NPC gets:
 *   - Fresh 16‑char alphanumeric Actor _id (and _key)
 *   - 3–5 brand-new VILLAIN moves (type: "npcMove", moveType: "villain")
 *   - 5 custom CONDITION moves (one each: Afraid, Angry, Guilty, Hopeless, Insecure)
 *   - Baseline GM moves preserved (unchanged) to match the example schema
 *   - A file named: npc_<VILLAIN_NAME>_<UUID>.json
 *
 * INPUTS
 *   - A directory of source files (PDF, .txt, .md). One or more NPCs may be
 *     present per file. By default we assume one NPC per file; use --multi to
 *     attempt multi-NPC discovery and do one model request per NPC for consistency.
 *
 * OUTPUTS
 *   - Foundry-ready actor JSON files in a configurable output directory.
 *     Defaults to: src/packs/ported
 *
 * OPENROUTER / GEMINI 2.5 PRO
 *   - Provider: OpenRouter (model "google/gemini-2.5-pro")
 *   - Env var: OPENROUTER_API_KEY must be set
 *   - Uses the OpenAI-compatible Chat Completions endpoint
 *   - JSON-only responses via response_format: { type: "json_object" }
 *   - IMPORTANT: we DO NOT set max_tokens (per instructions)
 *   - Robust handling for 429/5xx with backoff and bounded retries
 *
 * VALIDATION & AUTO-SYNTHESIS
 *   - Strong post-parse validation ensures:
 *       * Name exists
 *       * 3–5 villain moves
 *       * All 5 condition moves (Afraid, Angry, Guilty, Hopeless, Insecure)
 *     If the model under-fills anything, the script auto-synthesizes missing content.
 *
 * ICONS
 *   - Villain/Condition/GM moves get icons from the allowed list
 *   - We pick appropriate icons by keyword; otherwise fall back to a default
 *
 * SAFETY / CONTINUATION
 *   - The script logs a warning and continues if porting one entity fails.
 *
 * USAGE
 *   node masks-npc-porter.mjs \
 *     --indir ./raw-pdfs \
 *     --outdir ./src/packs/ported \
 *     [--multi] \
 *     [--image-root ./modules/te-core-rules/images] \
 *     [--dry-run]
 *
 * FLAGS
 *   --indir        Source directory containing PDFs or text files. Default: ./src/packs
 *   --outdir       Output directory. Default: ./src/packs/ported
 *   --multi        Attempt to detect multiple NPCs per file; separate request per NPC
 *   --image-root   Prefix for relative image references (retain te-core-rules paths)
 *   --dry-run      Do not write files, just log what would be created
 *
 * DEPENDENCIES
 *   - Node 18+ (global fetch support)
 *   - pdf-parse (optional; install with: npm i pdf-parse)
 *     If unavailable, the script falls back to a very basic text extractor using
 *     the 'pdftotext' CLI if present; otherwise throws a helpful error.
 *
 * CLARIFIED INSTRUCTIONS (for the model & this pipeline)
 *   1) Extract NPCs from each source file. If --multi is set, detect them and
 *      run a separate OpenRouter request per NPC; otherwise treat the whole file
 *      as one NPC.
 *   2) For each NPC, produce:
 *      - name (the villain’s moniker)
 *      - realName (civilian identity if present; empty string if unknown)
 *      - img (use path from te-core-rules if found; otherwise leave default)
 *      - details.drive (short motivation paragraph)
 *      - details.abilities (HTML: <p> or <ul> describing powers)
 *      - details.biography (HTML: flavor notes; copy text verbatim is allowed)
 *      - 3–5 custom villain moves:
 *          * type "npcMove", system.moveType "villain"
 *          * fiction-first descriptions that leverage Masks GM move logic
 *          * e.g., "mark a condition (player chooses)", shift Labels, split the team,
 *            introduce obstacles, capture someone, endanger innocents, etc.
 *      - 5 condition moves (Afraid, Angry, Guilty, Hopeless, Insecure):
 *          * system.moveType "condition"
 *          * name MUST start with condition name + " — "
 *          * tailor to the NPC’s theme; one line each is fine, using GM-style outcomes
 *   3) DO NOT remove the baseline GM moves (we append them unmodified).
 *   4) Every document (Actor + each Item) gets a fresh 16‑char alphanumeric _id
 *      and matching _key ("!actors!<id>" or "!items!<id>").
 *   5) File naming: npc_<NameWithSpacesAsUnderscores>_<ActorUUID>.json in --outdir.
 *
 * ---------------------------------------------------------------------------
 */

import { readFile, writeFile, readdir, stat, mkdir } from "fs/promises";
import { exec as _exec } from "child_process";
import { createHash, randomBytes } from "crypto";
import path from "path";
import process from "process";
import { promisify } from "util";

const exec = promisify(_exec);

/* ----------------------------- Configuration ------------------------------ */

const MODEL = "google/gemini-2.5-pro";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Defaults & CLI args
const argv = parseArgs(process.argv.slice(2));
const IN_DIR = path.resolve(argv.indir ?? "./src/packs");
const OUT_DIR = path.resolve(argv.outdir ?? "./src/packs/ported");
const MULTI = Boolean(argv.multi ?? false);
const IMAGE_ROOT = argv["image-root"] ? String(argv["image-root"]) : "";
const DRY_RUN = Boolean(argv["dry-run"] ?? false);

// Foundry / System versions to embed in _stats
const CORE_VERSION = "13.350";
const SYSTEM_ID = "pbta";
const SYSTEM_VERSION = "1.1.22";

// Safety guards
if (!OPENROUTER_API_KEY) {
  console.error("ERROR: OPENROUTER_API_KEY env var is required.");
  process.exit(1);
}

/* ------------------------------- Utilities -------------------------------- */

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function cleanText(s) {
  return (s || "")
    .replace(/\u0000/g, " ")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function limitChars(s, max = 65000) {
  if (s.length <= max) return s;
  return s.slice(0, max);
}

function safeFileBase(name) {
  return String(name || "Unknown")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const ALNUM =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function generate16CharUUID() {
  const bytes = randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += ALNUM[bytes[i] % ALNUM.length];
  }
  return s;
}

function isValid16(id) {
  return typeof id === "string" && /^[A-Za-z0-9]{16}$/.test(id);
}

function nowMs() {
  return Date.now();
}

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

async function* walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walkFiles(full);
    } else if (ent.isFile()) {
      yield full;
    }
  }
}

function extOf(p) {
  return path.extname(p).toLowerCase();
}

/* ------------------------------- PDF/Text --------------------------------- */

let pdfParse = null;
async function loadPdfParse() {
  if (pdfParse) return pdfParse;
  try {
    pdfParse = (await import("pdf-parse")).default;
    return pdfParse;
  } catch {
    // Try the CLI fallback: pdftotext
    return null;
  }
}

async function extractTextFromPdf(filePath) {
  const lib = await loadPdfParse();
  if (lib) {
    const buf = await readFile(filePath);
    const data = await lib(buf);
    return cleanText(data.text || "");
  }
  // Fallback: pdftotext CLI
  try {
    const { stdout } = await exec(
      `pdftotext -layout "${filePath}" - | sed 's/\\x0//g'`
    );
    return cleanText(stdout || "");
  } catch (e) {
    throw new Error(
      `pdf-parse not installed and 'pdftotext' not available for: ${filePath}\n` +
        `Install pdf-parse: npm i pdf-parse`
    );
  }
}

async function readSourceFileAsText(filePath) {
  const ext = extOf(filePath);
  if (ext === ".pdf") return await extractTextFromPdf(filePath);
  if (ext === ".txt" || ext === ".md") {
    const text = await readFile(filePath, "utf-8");
    return cleanText(text);
  }
  // Unknown filetype: attempt to read as text
  const text = await readFile(filePath, "utf-8").catch(() => "");
  return cleanText(text);
}

/* --------------------------- OpenRouter Client ----------------------------- */

async function openrouterChatJSON(messages, { temperature = 0.2 } = {}) {
  const body = {
    model: MODEL,
    response_format: { type: "json_object" },
    messages,
    temperature, // Do NOT set max_tokens per instruction
  };
  return await fetchWithRetry(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERRER || "https://localhost",
      "X-Title": process.env.OPENROUTER_TITLE || "Masks NPC Porter",
    },
    body: JSON.stringify(body),
  });
}

async function fetchWithRetry(url, init, maxAttempts = 5) {
  let attempt = 0;
  let lastErr = null;

  while (attempt < maxAttempts) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        const delayMs =
          (retryAfter ? retryAfter * 1000 : 1000 * Math.pow(2, attempt)) +
          Math.floor(Math.random() * 250);
        console.warn(
          `OpenRouter HTTP ${res.status}; retrying in ${delayMs}ms (attempt ${
            attempt + 1
          }/${maxAttempts})`
        );
        await sleep(delayMs);
        attempt++;
        continue;
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(
          `OpenRouter error ${res.status}: ${txt || res.statusText}`
        );
      }

      const json = await res.json();
      const content =
        json?.choices?.[0]?.message?.content ||
        json?.choices?.[0]?.message?.[0]?.content ||
        json?.choices?.[0]?.message ||
        json;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
          ? content.map((c) => c?.text).join("\n")
          : content?.text;
      if (!text || typeof text !== "string") {
        throw new Error("OpenRouter returned an unexpected/non-text response.");
      }
      // Ensure JSON
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        const delayMs = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
        console.warn(
          `OpenRouter fetch error: ${err?.message || err}. Retrying in ${delayMs}ms (attempt ${
            attempt + 1
          }/${maxAttempts})`
        );
        await sleep(delayMs);
        attempt++;
      } else {
        break;
      }
    }
  }
  throw lastErr || new Error("OpenRouter fetch failed.");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* --------------------------- Model Prompting ------------------------------ */

const DISCOVER_SYS = `
You are helping port tabletop RPG villains (NPCs) into a Masks: A New Generation content pack.
Your job in this step is ONLY to list the NPCs found in the provided text.

Rules:
- Return JSON with a top-level key "npcs".
- Each item must include:
  { "name": string, "realName": string (or ""), "img": string (or ""), "notes": string (short) }
- Do NOT invent NPCs not in the text. If you are unsure, return a single best guess derived from the file's first clear heading.
- Keep names as they appear (title case).`.trim();

const SYNTH_SYS = `
You convert ONE villain (NPC) into a Masks: A New Generation NPC spec.

Return a JSON object with this shape:

{
  "npc": {
    "name": "Villain Name",
    "realName": "Civilian name or empty string",
    "img": "te-core-rules path if present, otherwise empty or placeholder",
    "tags": "comma-separated short tags",
    "drive": "1 short paragraph (plain text)",
    "abilitiesHtml": "<p>HTML explaining powers and edges/limits.</p>",
    "biographyHtml": "<p>HTML short notes/biography.</p>",
    "villainMoves": [
      {
        "name": "Move name",
        "description": "1–3 sentences, fiction-first. Use Masks GM-move language where useful (e.g., mark a condition (player chooses), separate them, capture someone, escalate stakes)."
      }
      // 3–5 total
    ],
    "conditionMoves": {
      "Afraid": "Line tailored to NPC theme; what they do when Afraid.",
      "Angry": "—",
      "Guilty": "—",
      "Hopeless": "—",
      "Insecure": "—"
    }
  }
}

Hard requirements:
- Exactly 3–5 villainMoves.
- Exactly 5 condition moves using keys: Afraid, Angry, Guilty, Hopeless, Insecure.
- No dice mechanics (no target numbers). Use Masks-style narrative effects and conditions.
- Keep content self-contained; no references to other systems.`.trim();

/**
 * Attempt to discover multiple NPCs from file text.
 */
async function discoverNPCsFromText(text, fallbackName = "Unknown") {
  const prompt = [
    {
      role: "system",
      content: DISCOVER_SYS,
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "Source text snippet (the model may only see the first ~65k chars):\n\n" +
            limitChars(text, 65000),
        },
      ],
    },
  ];
  try {
    const json = await openrouterChatJSON(prompt);
    if (json && Array.isArray(json.npcs) && json.npcs.length) {
      return json.npcs.map((n) => ({
        name: (n?.name || fallbackName).toString().trim(),
        realName: (n?.realName || "").toString(),
        img: (n?.img || "").toString(),
        notes: (n?.notes || "").toString(),
      }));
    }
  } catch (e) {
    console.warn(
      "NPC discovery via OpenRouter failed; will fallback to single-NPC mode.",
      e.message || e
    );
  }
  // Fallback: single NPC, name from file
  return [{ name: fallbackName, realName: "", img: "", notes: "" }];
}

/**
 * Synthesize one NPC spec for a single target NPC name.
 */
async function synthesizeNpcSpec(fullText, targetName, hints = {}) {
  const prompt = [
    { role: "system", content: SYNTH_SYS },
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `Target NPC Name: ${targetName}\n` +
            `Any hints (may be empty): ${JSON.stringify(hints)}\n\n` +
            `Source text (truncated if large):\n\n` +
            limitChars(fullText, 65000),
        },
      ],
    },
  ];
  const json = await openrouterChatJSON(prompt, { temperature: 0.35 });
  return json?.npc;
}

/* ----------------------- Foundry JSON Construction ------------------------ */

/** MoveResult block per schema */
function buildMoveResults() {
  return {
    failure: {
      key: "system.moveResults.failure.value",
      label: "Complications...",
      value: "",
    },
    partial: {
      key: "system.moveResults.partial.value",
      label: "Partial success",
      value: "",
    },
    success: {
      key: "system.moveResults.success.value",
      label: "Success!",
      value: "",
    },
  };
}

/** Minimal _stats block for Items */
function itemStats() {
  return {
    compendiumSource: null,
    duplicateSource: null,
    exportSource: null,
    coreVersion: CORE_VERSION,
    systemId: SYSTEM_ID,
    systemVersion: SYSTEM_VERSION,
    lastModifiedBy: generate16CharUUID(), // harmless placeholder
  };
}

/** Minimal _stats block for Actor */
function actorStats(actorId) {
  const now = nowMs();
  return {
    compendiumSource: null,
    duplicateSource: null,
    exportSource: {
      worldId: "v1",
      uuid: `Actor.${actorId}`,
      coreVersion: CORE_VERSION,
      systemId: SYSTEM_ID,
      systemVersion: SYSTEM_VERSION,
    },
    coreVersion: CORE_VERSION,
    systemId: SYSTEM_ID,
    systemVersion: SYSTEM_VERSION,
    createdTime: now,
    modifiedTime: now,
    lastModifiedBy: generate16CharUUID(),
  };
}

/** Baseline GM moves we must always include (unchanged) */
const BASELINE_GM_MOVES = [
  {
    name: "Inflict a Condition",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/convince-#ffffff-#3da7db.svg",
    description:
      "<p>Baseline GM option: have the villain’s actions cause a hero to <b>mark a condition</b> in the fiction (fear, anger, guilt, hopelessness, insecurity) as appropriate.</p>",
  },
  {
    name: "Take Influence",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/distraction-#ffffff-#3da7db.svg",
    description:
      "<p>Baseline GM option: show the villain <b>seizing Influence</b> over a hero through awe, shame, or negotiation, shifting Labels or pressuring choices per Masks rules.</p>",
  },
  {
    name: "Capture Someone",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/arrest-#ffffff-#3da7db.svg",
    description:
      "<p>Baseline GM option: separate or restrain a target via the villain’s tools, powers, or environment, per the scene’s fiction.</p>",
  },
  {
    name: "Put Innocents in Danger",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/target-dummy-#ffffff-#3da7db.svg",
    description:
      "<p>Baseline GM option: the chase or assault endangers bystanders, forcing hard choices or splitting the team, per Masks GM guidance.</p>",
  },
  {
    name: "Show the Costs of Collateral Damage",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/bulldozer-#ffffff-#3da7db.svg",
    description:
      "<p>Baseline GM option: spotlight cracked walls, failing structures, and endangered exhibits—escalating stakes in the environment.</p>",
  },
  {
    name: "Tell Them Possible Consequences and Ask",
    img: "modules/masks-newgeneration-unofficial/images/gameicons/death-note-#ffffff-#3da7db.svg",
    description:
      "<p>Baseline GM option: lay out what choosing to press on or to retreat will cost, and ask what they do now, per GM principles.</p>",
  },
];

/** Icon chooser by keywords */
function chooseIconForMove(name = "", description = "") {
  const s = `${name} ${description}`.toLowerCase();

  const map = [
    { k: ["scream", "shriek", "shout"], i: "screaming-#ffffff-#3da7db.svg" },
    { k: ["gaze", "stare", "eye"], i: "eye-target-#ffffff-#3da7db.svg" },
    { k: ["illusion", "invisible", "stealth"], i: "suspicious-#ffffff-#3da7db.svg" },
    { k: ["shield", "block", "reflect"], i: "shield-reflect-#ffffff-#3da7db.svg" },
    { k: ["chain", "bind", "trap", "capture"], i: "arrest-#ffffff-#3da7db.svg" },
    { k: ["portal", "gate", "rift"], i: "magic-portal-#ffffff-#3da7db.svg" },
    { k: ["hex", "curse", "spell", "witch"], i: "aura-#ffffff-#3da7db.svg" },
    { k: ["rock", "stone", "golem", "petrify"], i: "rock-golem-#ffffff-#3da7db.svg" },
    { k: ["speed", "rush", "charge"], i: "wide-arrow-dunk-#ffffff-#3da7db.svg" },
    { k: ["network", "signal", "surveil"], i: "cctv-camera-#ffffff-#3da7db.svg" },
  ];

  for (const { k, i } of map) {
    if (k.some((w) => s.includes(w))) {
      return `modules/masks-newgeneration-unofficial/images/gameicons/${i}`;
    }
  }
  // Default
  return "modules/masks-newgeneration-unofficial/images/gameicons/convince-#ffffff-#3da7db.svg";
}

function toHtmlParagraph(s) {
  const t = (s || "").trim();
  if (!t) return "";
  if (/^<p>/i.test(t)) return t;
  return `<p>${escapeHtml(t)}</p>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Build one Item (move) */
function buildMoveItem({ name, moveType, description, img, sort }) {
  const _id = generate16CharUUID();
  const item = {
    name,
    type: "npcMove",
    system: {
      moveType,
      description,
      rollFormula: "",
      moveResults: buildMoveResults(),
      uses: 0,
    },
    _id,
    img,
    effects: [],
    folder: null,
    sort,
    flags: {},
    _stats: itemStats(),
    ownership: { default: 0 },
    _key: `!items!${_id}`,
  };
  return item;
}

/** Build all Items for this NPC: villain moves, condition moves, + baseline GM moves */
function buildItemsForNpc(villainMoves, conditionMoves) {
  let sort = 0;
  const items = [];

  // Villain moves
  for (const vm of villainMoves) {
    const img = chooseIconForMove(vm.name, vm.description);
    items.push(
      buildMoveItem({
        name: vm.name,
        moveType: "villain",
        description: toHtmlParagraph(vm.description),
        img,
        sort,
      })
    );
    sort += 10;
  }

  // Condition moves: order Afraid, Angry, Guilty, Hopeless, Insecure
  const condOrder = ["Afraid", "Angry", "Guilty", "Hopeless", "Insecure"];
  for (const key of condOrder) {
    const line = conditionMoves[key] || defaultConditionLine(key);
    const name = `${key} — ${synthesizeConditionNameTail(key, line)}`;
    const img = conditionIcon(key);
    items.push(
      buildMoveItem({
        name,
        moveType: "condition",
        description: toHtmlParagraph(line),
        img,
        sort,
      })
    );
    sort += 10;
  }

  // Baseline GM moves (unchanged)
  for (const gm of BASELINE_GM_MOVES) {
    items.push(
      buildMoveItem({
        name: gm.name,
        moveType: "",
        description: gm.description,
        img: gm.img,
        sort,
      })
    );
    sort += 10;
  }

  return items;
}

function conditionIcon(cond) {
  const map = {
    Afraid:
      "modules/masks-newgeneration-unofficial/images/gameicons/surprised-#ffffff-#3da7db.svg",
    Angry:
      "modules/masks-newgeneration-unofficial/images/gameicons/enrage-#ffffff-#3da7db.svg",
    Guilty:
      "modules/masks-newgeneration-unofficial/images/gameicons/robber-#ffffff-#3da7db.svg",
    Hopeless:
      "modules/masks-newgeneration-unofficial/images/gameicons/kneeling-#ffffff-#3da7db.svg",
    Insecure:
      "modules/masks-newgeneration-unofficial/images/gameicons/broken-pottery-#ffffff-#3da7db.svg",
  };
  return map[cond] || chooseIconForMove(cond, "");
}

function defaultConditionLine(cond) {
  // Short, system-friendly defaults (will be replaced if model provided content)
  const defaults = {
    Afraid:
      "They retreat behind tricks or misdirection. To reach them, heroes brave confusion or speak a vulnerable truth; otherwise they buy time to reposition.",
    Angry:
      "They lash out at symbols of the team’s pride. Someone must defuse them with honesty or a daring action, or mark a condition from public humiliation.",
    Guilty:
      "They mend a harm they caused and offer a vulnerable apology. If accepted, clear one of their conditions and give that hero a chance to use Influence.",
    Hopeless:
      "They try to remove themselves—or a foe—from the scene entirely. Unless interrupted within a beat, the target exits; if intercepted, they mark a condition.",
    Insecure:
      "Overcompensating, they reignite a resolved complication. A hazard or rival returns, now angrier and more immediate.",
  };
  return defaults[cond] || "They act accordingly to the condition in a way that escalates stakes.";
}

function synthesizeConditionNameTail(cond, line) {
  const quick = {
    Afraid: "Fade Into Misdirection",
    Angry: "Smash and Shame",
    Guilty: "Atoning Gesture",
    Hopeless: "Slip Through the Gutters",
    Insecure: "Relight Old Fires",
  };
  return quick[cond] || "Embody the Condition";
}

function buildPrototypeToken(actorImg) {
  return {
    name: "Villain",
    displayName: 0,
    actorLink: false,
    width: 1,
    height: 1,
    texture: {
      src: actorImg || "icons/svg/mystery-man.svg",
      anchorX: 0.5,
      anchorY: 0.5,
      offsetX: 0,
      offsetY: 0,
      fit: "contain",
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      tint: "#ffffff",
      alphaThreshold: 0.75,
    },
    lockRotation: false,
    rotation: 0,
    alpha: 1,
    disposition: -1,
    displayBars: 0,
    bar1: { attribute: null },
    bar2: { attribute: null },
    light: {
      negative: false,
      priority: 0,
      alpha: 0.5,
      angle: 360,
      bright: 0,
      color: null,
      coloration: 1,
      dim: 0,
      attenuation: 0.5,
      luminosity: 0.5,
      saturation: 0,
      contrast: 0,
      shadows: 0,
      animation: { type: null, speed: 5, intensity: 5, reverse: false },
      darkness: { min: 0, max: 1 },
    },
    sight: {
      enabled: false,
      range: 0,
      angle: 360,
      visionMode: "basic",
      color: null,
      attenuation: 0.1,
      brightness: 0,
      saturation: 0,
      contrast: 0,
    },
    detectionModes: [],
    occludable: { radius: 0 },
    ring: {
      enabled: false,
      colors: { ring: null, background: null },
      effects: 1,
      subject: { scale: 1, texture: null },
    },
    turnMarker: { mode: 1, animation: null, src: null, disposition: false },
    movementAction: null,
    flags: {},
    randomImg: false,
    appendNumber: false,
    prependAdjective: false,
  };
}

function buildActorDocument({
  name,
  realName,
  img,
  drive,
  abilitiesHtml,
  biographyHtml,
  tags,
  villainMoves,
  conditionMoves,
}) {
  const actorId = generate16CharUUID();
  const actorImg = img?.trim() || "icons/svg/mystery-man.svg";
  const doc = {
    _id: actorId,
    _key: `!actors!${actorId}`,
    name,
    type: "npc",
    img: actorImg,
    system: {
      stats: {},
      attributes: {
        conditions: {
          label: "Conditions",
          description: "Choose all that apply:",
          customLabel: false,
          userLabel: false,
          type: "ListMany",
          condition: false,
          position: "Left",
          options: {
            0: { label: "Afraid", value: false },
            1: { label: "Angry", value: false },
            2: { label: "Guilty", value: false },
            3: { label: "Hopeless", value: false },
            4: { label: "Insecure", value: false },
          },
        },
        realName: {
          label: "Real Name",
          description: null,
          customLabel: false,
          userLabel: false,
          type: "Text",
          value: realName || "",
          position: "Left",
        },
        generation: {
          label: "Generation",
          description: null,
          customLabel: false,
          userLabel: false,
          type: "Text",
          value: "",
          position: "Left",
        },
      },
      attrLeft: {},
      attrTop: {},
      details: {
        drive: { label: "Drive", value: drive || "" },
        abilities: {
          label: "Abilities",
          value:
            abilitiesHtml?.trim() ||
            "<p>Powers, edges, and limits described here.</p>",
        },
        biography: {
          label: "Notes",
          value: biographyHtml?.trim() || "",
        },
      },
      tags: (tags || "").toString(),
    },
    prototypeToken: buildPrototypeToken(actorImg),
    items: buildItemsForNpc(villainMoves, conditionMoves),
    effects: [],
    folder: null,
    flags: {},
    _stats: actorStats(actorId),
    baseType: "npc",
    ownership: { default: 0 },
  };
  return doc;
}

/* --------------------------- Validation & Fixups -------------------------- */

function validateAndFixNpcSpec(npc, fallbackName) {
  const out = { ...npc };

  // Name
  if (!out.name || typeof out.name !== "string") {
    out.name = fallbackName || "Unknown";
  }
  out.name = out.name.trim();

  // realName
  if (typeof out.realName !== "string") out.realName = "";

  // img retention (te-core-rules path if present)
  if (typeof out.img !== "string") out.img = "";
  if (IMAGE_ROOT && out.img && !out.img.startsWith("http") && !out.img.startsWith("/")) {
    // prefix relative refs
    out.img = path.posix.join(IMAGE_ROOT.replace(/\\/g, "/"), out.img);
  }

  // drive
  if (typeof out.drive !== "string" || !out.drive.trim()) {
    out.drive = `Pursue their goals in a way that challenges the team’s values and escalates stakes until confronted.`;
  }

  // abilitiesHtml / biographyHtml
  out.abilitiesHtml =
    typeof out.abilitiesHtml === "string" && out.abilitiesHtml.trim()
      ? out.abilitiesHtml
      : "<p>Unique powers and methods that pressure the heroes and the setting.</p>";

  out.biographyHtml =
    typeof out.biographyHtml === "string" ? out.biographyHtml : "";

  // Villain moves: ensure 3–5; synthesize if needed
  if (!Array.isArray(out.villainMoves)) out.villainMoves = [];
  out.villainMoves = out.villainMoves
    .map((m) => ({
      name: (m?.name || "").toString().trim(),
      description: (m?.description || "").toString().trim(),
    }))
    .filter((m) => m.name && m.description);

  const need = clamp(3 - out.villainMoves.length, 0, 3);
  for (let i = 0; i < need; i++) {
    out.villainMoves.push(synthesizeGenericVillainMove(out.name, i));
  }
  if (out.villainMoves.length > 5) {
    out.villainMoves = out.villainMoves.slice(0, 5);
  }

  // Condition moves: ensure 5 keys
  out.conditionMoves = out.conditionMoves || {};
  const conds = ["Afraid", "Angry", "Guilty", "Hopeless", "Insecure"];
  for (const c of conds) {
    if (!out.conditionMoves[c] || typeof out.conditionMoves[c] !== "string") {
      out.conditionMoves[c] = defaultConditionLine(c);
    }
  }

  // tags
  if (typeof out.tags !== "string") {
    out.tags = "villain";
  }

  return out;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function synthesizeGenericVillainMove(name, idx) {
  const bases = [
    {
      name: "Seize the Spotlight",
      description:
        "They force a dramatic turn—split the team or isolate a leader; anyone who stays to contest marks a condition (player chooses).",
    },
    {
      name: "Collateral Crescendo",
      description:
        "They escalate environmental danger—collapsing structures, unruly crowds, or failing systems—demanding immediate choices or concessions.",
    },
    {
      name: "Strings and Levers",
      description:
        "They pull on Influence and reputations; shift a hero’s Labels (fictionally justified) or present a bargain with strings attached.",
    },
    {
      name: "No Clean Shots",
      description:
        "They negate a hero’s edge or tool for a beat, forcing a new approach or a risky move to regain initiative.",
    },
    {
      name: "Vanish on Their Terms",
      description:
        "On a beat, they create an exit—smoke, crowd, rift. Pursuit requires marking a condition or leaving someone/something behind.",
    },
  ];
  // Pick by index, rotate
  const pick = bases[idx % bases.length];
  // Minor flavor tag
  return {
    name: pick.name,
    description: pick.description,
  };
}

/* ------------------------------- Main Flow -------------------------------- */

async function main() {
  console.log("=== Masks NPC Porter (OpenRouter • Gemini 2.5 Pro) ===");
  console.log(`Input Dir:  ${IN_DIR}`);
  console.log(`Output Dir: ${OUT_DIR}`);
  console.log(`Multi-NPC discovery: ${MULTI ? "ON" : "OFF"}`);
  if (IMAGE_ROOT) console.log(`Image Root Prefix: ${IMAGE_ROOT}`);
  if (DRY_RUN) console.log(`DRY RUN (no files will be written)`);

  await ensureDir(OUT_DIR);

  let processedActors = 0;
  let failedActors = 0;

  for await (const filePath of walkFiles(IN_DIR)) {
    const ext = extOf(filePath);
    if (![".pdf", ".txt", ".md"].includes(ext)) continue;

    const base = path.basename(filePath);
    console.log(`\n— Processing source: ${base}`);

    try {
      const text = await readSourceFileAsText(filePath);
      const defaultName = titleFromFile(base);

      let candidates = [{ name: defaultName, realName: "", img: "", notes: "" }];
      if (MULTI) {
        candidates = await discoverNPCsFromText(text, defaultName);
        if (!Array.isArray(candidates) || !candidates.length) {
          candidates = [{ name: defaultName, realName: "", img: "", notes: "" }];
        }
      }

      for (const cand of candidates) {
        try {
          const npcRaw =
            (await synthesizeNpcSpec(text, cand.name, cand)) ||
            fallbackMinimalNpc(cand.name, cand.realName, cand.img);

          const npc = validateAndFixNpcSpec(npcRaw, cand.name);
          const actorDoc = buildActorDocument(npc);
          const outName = `npc_${safeFileBase(actorDoc.name)}_${actorDoc._id}.json`;
          const outPath = path.join(OUT_DIR, outName);

          if (!DRY_RUN) {
            await writeFile(outPath, JSON.stringify(actorDoc, null, 2), "utf-8");
          }
          console.log(`  ✓ ${actorDoc.name} -> ${DRY_RUN ? "(dry run)" : outPath}`);
          processedActors++;
        } catch (e) {
          console.warn(
            `  ! Failed to port NPC '${cand?.name || "Unknown"}' from ${base}:`,
            e?.message || e
          );
          failedActors++;
          // continue to next candidate
        }
      }
    } catch (err) {
      console.warn(`! Skipping file due to error: ${base}:`, err?.message || err);
    }
  }

  console.log(
    `\n=== Done. Actors created: ${processedActors}. Failures: ${failedActors}. ===`
  );
}

function titleFromFile(base) {
  const stem = base.replace(/\.[^.]+$/, "");
  // Attempt to prettify: split on non-alnum and title case
  const name = stem
    .split(/[_\-\.\s]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ");
  return name || "Unknown";
}

function fallbackMinimalNpc(name, realName = "", img = "") {
  return {
    name: name || "Unknown",
    realName: realName || "",
    img: img || "",
    tags: "villain",
    drive:
      "Impose their will on Halcyon City through spectacle and pressure, until confronted or outmaneuvered.",
    abilitiesHtml:
      "<p>Striking abilities suited to challenge the team; edges and limits that invite tough choices.</p>",
    biographyHtml:
      "<p>Notes and history about the villain’s methods, ties, and ambitions.</p>",
    villainMoves: [
      synthesizeGenericVillainMove(name, 0),
      synthesizeGenericVillainMove(name, 1),
      synthesizeGenericVillainMove(name, 2),
    ],
    conditionMoves: {
      Afraid: defaultConditionLine("Afraid"),
      Angry: defaultConditionLine("Angry"),
      Guilty: defaultConditionLine("Guilty"),
      Hopeless: defaultConditionLine("Hopeless"),
      Insecure: defaultConditionLine("Insecure"),
    },
  };
}

/* --------------------------------- Start ---------------------------------- */
main().catch((e) => {
  console.error("Fatal error:", e?.message || e);
  process.exit(1);
});
