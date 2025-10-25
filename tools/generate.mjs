#!/usr/bin/env node
/**
 * tools/port-npcs.mjs
 * -----------------------------------------------------------------------------
 * PORT NPCs FROM SOURCE FILES (PDF/TXT/MD/JSON) TO FOUNDARY PBTA/MASKS NPC JSON
 * Provider: OpenRouter (model: google/gemini-2.5-pro)
 *
 * READ THIS FIRST — WHAT THIS SCRIPT DOES
 * -----------------------------------------------------------------------------
 * • Scans an input directory for content files (.pdf, .txt, .md, .json).
 * • Extracts text (uses pdf-parse or system `pdftotext` for PDFs; reads text/JSON directly).
 * • Calls the OpenRouter Chat Completions API (Gemini 2.5 Pro) to:
 *    (1) Identify NPCs present in each file (names, real names, image hints, short concept).
 *    (2) For each NPC, generate:
 *        - 3–5 custom "Villain" moves (type: npcMove, moveType: "villain"),
 *        - 5 custom "Condition" moves (Afraid, Angry, Guilty, Hopeless, Insecure) with character‑appropriate flavor,
 *        - optional drive/abilities/biography snippets.
 * • Builds a full Foundry VTT Actor document (type: npc) that strictly mirrors the
 *   structure of ./example-npc.json while replacing the allowed fields:
 *   - Name
 *   - _id (new 16‑character alphanumeric UUID)
 *   - img (tries to retain source path; falls back to default icon)
 *   - system.attributes.realName.value
 *   - Items array:
 *        → BRAND‑NEW 3–5 villain moves,
 *        → BRAND‑NEW 5 condition moves (one for each Condition),
 *        → A preserved set of baseline GM moves (not removed; lightly paraphrased),
 *      All items are minted with fresh 16‑char UUIDs and proper pbta move structure.
 * • Writes one file per NPC to an output directory:
 *      npc_<VILLAIN_NAME>_<UUID>.json
 *   The default outdir is: src/packs/ported
 *
 * SAFETY & ROBUSTNESS
 * -----------------------------------------------------------------------------
 * • Continues processing even if any single NPC fails (prints a warning).
 * • Strong post‑parse validation of LLM output and auto‑synthesizes missing data.
 * • Bounded retries with exponential backoff on 429/5xx responses (no infinite loops).
 * • Ensures every Actor & Item owns a valid 16‑char alphanumeric UUID (A–Z, a–z, 0–9).
 *
 * IMPORTANT MASKS / PBTA MODELING RULES THIS SCRIPT ENFORCES
 * -----------------------------------------------------------------------------
 * • Items (moves) use the exact structure found in example-npc.json:
 *   - type: "npcMove"
 *   - system.moveType: "villain" | "condition" | "" (for generic GM options)
 *   - system.description: HTML with a single <p>…</p> body
 *     * The specific GM move names cited are wrapped in <b>…</b> (e.g., <b>Inflict a Condition</b>)
 *   - system.moveResults: { failure, partial, success } scaffold present
 *   - rollFormula: "" and uses: 0
 * • Condition moves: exactly 5, one for each: Afraid, Angry, Guilty, Hopeless, Insecure.
 * • Villain moves: 3–5 per NPC, flavored to that character.
 * • The baseline GM options are preserved (not removed). They are slightly paraphrased
 *   to avoid verbatim duplication of the example’s text.
 *
 * CLI USAGE
 * -----------------------------------------------------------------------------
 *   node tools/port-npcs.mjs [--indir ./src/packs] [--outdir ./src/packs/ported]
 *                            [--template ./example-npc.json]
 *                            [--model google/gemini-2.5-pro]
 *                            [--concurrency 2]
 *                            [--filePattern "*.pdf"]
 *                            [--dry]
 *
 * ENVIRONMENT
 * -----------------------------------------------------------------------------
 *   OPENROUTER_API_KEY   (required)
 *   OPENROUTER_SITE_URL  (optional, leaderboard attribution)
 *   OPENROUTER_SITE_NAME (optional, leaderboard attribution)
 *
 * DEPENDENCIES (optional but recommended)
 * -----------------------------------------------------------------------------
 *   • pdf-parse (NPM). If unavailable, script will try `pdftotext` CLI. If both
 *     unavailable, PDF files are skipped with a warning.
 *     Install:  npm i -D pdf-parse
 *
 * MODEL CONTRACT TO THE LLM (EXCERPT)
 * -----------------------------------------------------------------------------
 *   We make a first request per file to enumerate NPCs (names, realName, optional image).
 *   Then, a separate request per NPC to generate:
 *     { villainMoves: 3–5, conditionMoves: Afraid/Angry/Guilty/Hopeless/Insecure }.
 *   Responses must be JSON only; script validates & repairs as needed.
 *
 * NOTE ON IMAGES
 * -----------------------------------------------------------------------------
 *   The script attempts to “retain the path from te-core-rules” if present in source
 *   text (e.g., modules/te-core-rules/...); otherwise it falls back to
 *   "icons/svg/mystery-man.svg". You can post‑process outputs to swap images in bulk.
 *
 * OUTPUT DIRECTORY
 * -----------------------------------------------------------------------------
 *   Default: src/packs/ported (created if missing)
 *   Naming:  npc_<VillainName>_<UUID>.json
 *
 * -----------------------------------------------------------------------------
 * © You own the IP for your villains; this script can copy their text.
 * This file is MIT‑licensed like the repository.
 * -----------------------------------------------------------------------------
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { exec as execCb } from "child_process";
import { setTimeout as sleep } from "timers/promises";
const exec = (cmd) =>
  new Promise((resolve, reject) => {
    execCb(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout, stderr }));
      resolve({ stdout, stderr });
    });
  });

// ------------------------------ CLI ARGS ------------------------------

const argv = process.argv.slice(2);
const getFlag = (name, def = undefined) => {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return def;
  const next = argv[idx + 1];
  if (!next || next.startsWith("--")) return true; // boolean flag
  return next;
};

const IN_DIR = path.resolve(getFlag("indir", "./src/packs"));
const OUT_DIR = path.resolve(getFlag("outdir", "./src/packs/ported"));
const TEMPLATE_PATH = path.resolve(getFlag("template", "./example-npc.json"));
const MODEL = getFlag("model", "deepseek/deepseek-chat-v3-0324");
const CONCURRENCY = Math.max(1, parseInt(getFlag("concurrency", "2"), 10) || 2);
const FILE_PATTERN = getFlag("filePattern", "*"); // simple include pattern
const DRY_RUN = !!getFlag("dry", false);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  console.error("ERROR: OPENROUTER_API_KEY environment variable is required.");
  process.exit(1);
}

// ------------------------------ CONSTANTS ------------------------------

const ALLOWED_EXTENSIONS = new Set([".pdf", ".txt", ".md", ".json"]);

const GM_TRIGGER_WHITELIST = [
  "Make a Villain Move",
  "Make a Playbook Move",
  "Activate the Downsides of their Abilities and Relationships",
  "Inflict a Condition",
  "Take Influence over Someone",
  "Bring Them Together",
  "Capture Someone",
  "Put Innocents in Danger",
  "Show the Costs of Collateral Damage",
  "Reveal the Future",
  "Announce Between‑Panel Threats",
  "Make Them Pay a Price for Victory",
  "Turn Their Move Back on Them",
  "Tell Them the Possible Consequences—and Ask",
  "Tell Them Who They Are or Who They Should Be",
  "Bring an NPC to Rash Decisions and Hard Conclusions"
];

// Icons for flavor; mapped by common triggers. Falls back to auras if not matched.
const ICONS = {
  default: "modules/masks-newgeneration-unofficial/images/gameicons/aura-#ffffff-#3da7db.svg",
  "Inflict a Condition": "modules/masks-newgeneration-unofficial/images/gameicons/spiky-explosion-#ffffff-#3da7db.svg",
  "Take Influence over Someone": "modules/masks-newgeneration-unofficial/images/gameicons/distraction-#ffffff-#3da7db.svg",
  "Put Innocents in Danger": "modules/masks-newgeneration-unofficial/images/gameicons/target-dummy-#ffffff-#3da7db.svg",
  "Capture Someone": "modules/masks-newgeneration-unofficial/images/gameicons/arrest-#ffffff-#3da7db.svg",
  "Show the Costs of Collateral Damage": "modules/masks-newgeneration-unofficial/images/gameicons/bulldozer-#ffffff-#3da7db.svg",
  "Tell Them the Possible Consequences—and Ask": "modules/masks-newgeneration-unofficial/images/gameicons/death-note-#ffffff-#3da7db.svg",
  "Make Them Pay a Price for Victory": "modules/masks-newgeneration-unofficial/images/gameicons/broken-pottery-#ffffff-#3da7db.svg",
  "Bring Them Together": "modules/masks-newgeneration-unofficial/images/gameicons/team-upgrade-#ffffff-#3da7db.svg",
  "Reveal the Future": "modules/masks-newgeneration-unofficial/images/gameicons/time-trap-#ffffff-#3da7db.svg",
  "Announce Between‑Panel Threats": "modules/masks-newgeneration-unofficial/images/gameicons/ringing-alarm-#ffffff-#3da7db.svg",
  "Activate the Downsides of their Abilities and Relationships": "modules/masks-newgeneration-unofficial/images/gameicons/liar-#ffffff-#3da7db.svg",
  "Turn Their Move Back on Them": "modules/masks-newgeneration-unofficial/images/gameicons/shield-reflect-#ffffff-#3da7db.svg",
  "Tell Them Who They Are or Who They Should Be": "modules/masks-newgeneration-unofficial/images/gameicons/philosopher-bust-#ffffff-#3da7db.svg",
  "Bring an NPC to Rash Decisions and Hard Conclusions": "modules/masks-newgeneration-unofficial/images/gameicons/radar-sweep-#ffffff-#3da7db.svg",
};

const CONDITION_ICONS = {
  Afraid: "modules/masks-newgeneration-unofficial/images/gameicons/suspicious-#ffffff-#3da7db.svg",
  Angry: "modules/masks-newgeneration-unofficial/images/gameicons/confrontation-#ffffff-#3da7db.svg",
  Guilty: "modules/masks-newgeneration-unofficial/images/gameicons/robber-#ffffff-#3da7db.svg",
  Hopeless: "modules/masks-newgeneration-unofficial/images/gameicons/kneeling-#ffffff-#3da7db.svg",
  Insecure: "modules/masks-newgeneration-unofficial/images/gameicons/broken-pottery-#ffffff-#3da7db.svg",
};

const NOW = () => Date.now();

// ------------------------------ UTILS ------------------------------

function generate16CharUUID() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  // crypto.randomBytes replacement without import: use Node's webcrypto
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 16; i++) out += chars[bytes[i] % chars.length];
  return out;
}
const crypto =
  globalThis.crypto ??
  (await import("node:crypto")).webcrypto; // ensure webcrypto for random

function isValid16CharUUID(id) {
  return typeof id === "string" && /^[A-Za-z0-9]{16}$/.test(id);
}

function toSafeFileStub(name) {
  return (name || "NPC")
    .replace(/[^A-Za-z0-9 _-]/g, "_")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function chooseIconFromTriggers(triggers = []) {
  for (const t of triggers) {
    if (ICONS[t]) return ICONS[t];
  }
  return ICONS.default;
}

function ensureSingleParagraphHTML(htmlOrText) {
  if (!htmlOrText) return "<p></p>";
  const s = String(htmlOrText).trim();
  if (s.startsWith("<p>") && s.endsWith("</p>")) return s;
  // Strip any newlines and wrap in <p>
  const stripped = s.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  return `<p>${stripped}</p>`;
}

function wrapGMTriggersBold(text, triggers = []) {
  // For each known trigger, wrap exact substring if present.
  let out = text;
  for (const t of triggers) {
    const safe = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${safe}\\b`, "g");
    out = out.replace(re, `<b>${t}</b>`);
  }
  return out;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function stripCodeFences(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function pick(arr, count) {
  const clone = [...arr];
  const out = [];
  while (clone.length && out.length < count) {
    const idx = Math.floor(Math.random() * clone.length);
    out.push(clone.splice(idx, 1)[0]);
  }
  return out;
}

// ------------------------------ PDF / TEXT EXTRACTION ------------------------------

async function extractTextFromPDF(filePath) {
  // Try pdf-parse
  try {
    const pdfParse = (await import("pdf-parse")).default;
    const data = await fsp.readFile(filePath);
    const res = await pdfParse(data);
    if (res && res.text && res.text.trim()) {
      return res.text;
    }
  } catch (err) {
    // ignore; try pdftotext
  }

  // Try pdftotext CLI
  try {
    const cmd = `pdftotext -layout -nopgbrk "${filePath}" -`;
    const { stdout } = await exec(cmd);
    if (stdout && stdout.trim()) return stdout;
  } catch (err) {
    // skip
  }

  console.warn(
    `WARN: Could not extract text from PDF (no pdf-parse or pdftotext): ${filePath}`
  );
  return "";
}

async function extractTextFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    return extractTextFromPDF(filePath);
  }
  if (ext === ".txt" || ext === ".md") {
    return await fsp.readFile(filePath, "utf8");
  }
  if (ext === ".json") {
    try {
      const raw = await fsp.readFile(filePath, "utf8");
      // Pass through either prettified JSON or raw if huge:
      if (raw.length > 500_000) return raw.slice(0, 500_000);
      return raw;
    } catch (e) {
      return "";
    }
  }
  return "";
}

// ------------------------------ FILE DISCOVERY ------------------------------

async function listFilesRecursively(dir, pattern = "*") {
  const results = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const d of entries) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      const child = await listFilesRecursively(full, pattern);
      results.push(...child);
    } else {
      const ext = path.extname(d.name).toLowerCase();
      if (ALLOWED_EXTENSIONS.has(ext)) {
        if (pattern && pattern !== "*" && !minimatch(d.name, pattern)) continue;
        results.push(full);
      }
    }
  }
  return results;
}

function minimatch(filename, glob) {
  // ultra-light glob: only supports single trailing "*"
  if (glob === "*" || !glob) return true;
  if (glob.endsWith("*")) {
    const base = glob.slice(0, -1);
    return filename.startsWith(base);
  }
  return filename === glob;
}

// ------------------------------ OPENROUTER CALLS ------------------------------

async function callOpenRouterJSON({ system, user }) {
  const headers = {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (process.env.OPENROUTER_SITE_URL) {
    headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
  }
  if (process.env.OPENROUTER_SITE_NAME) {
    headers["X-Title"] = process.env.OPENROUTER_SITE_NAME;
  }

  // bounded retries with exponential backoff + jitter
  const maxAttempts = 5;
  let attempt = 0;
  let lastErr;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const body = {
        model: MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      };

      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        const retryAfter =
          parseInt(res.headers.get("retry-after") || "0", 10) || 0;
        const base = Math.min(2 ** attempt * 500, 15_000); // cap base at 15s
        const delay = retryAfter
          ? retryAfter * 1000
          : base + Math.floor(Math.random() * 500);
        console.warn(
          `WARN: OpenRouter ${res.status}. Retrying in ${Math.round(
            delay / 1000
          )}s... (attempt ${attempt}/${maxAttempts})`
        );
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `OpenRouter error ${res.status}: ${text?.slice(0, 400)}`
        );
      }

      const json = await res.json();
      const content =
        json?.choices?.[0]?.message?.content ??
        json?.choices?.[0]?.content ??
        "";

      const raw = Array.isArray(content)
        ? content.map((x) => (typeof x === "string" ? x : x?.text || "")).join("\n")
        : String(content);

      const clean = stripCodeFences(raw);
      if (!clean) throw new Error("Empty JSON response from model.");
      let parsed;
      try {
        parsed = JSON.parse(clean);
      } catch (e) {
        // Sometimes models wrap single JSON object in text. Try to find a JSON object.
        const start = clean.indexOf("{");
        const end = clean.lastIndexOf("}");
        if (start >= 0 && end > start) {
          const sub = clean.slice(start, end + 1);
          parsed = JSON.parse(sub);
        } else {
          throw e;
        }
      }
      return parsed;
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) break;
      const backoff = Math.min(2 ** attempt * 400, 10_000);
      await sleep(backoff + Math.floor(Math.random() * 400));
    }
  }

  throw lastErr ?? new Error("Unknown OpenRouter failure.");
}

// ------------------------------ LLM PROMPTS ------------------------------

const SYSTEM_ENUMERATE = `
You are an expert at converting third‑party tabletop RPG content into NPCs for "Masks: A New Generation" (PbtA).
You MUST respond with pure JSON (no prose, no code fences).
`;

function USER_ENUMERATE(filePath, content) {
  // Keep prompt lean; the raw content can be large. We trust the model to skim.
  return `
From the following source text, enumerate NPCs suitable to port into Masks NPCs.
For each NPC, return: name (string), realName (string or null), img (string path if given), concept (<=20 words), 
and optional fields drive, abilities, biography (short strings). Do not invent image paths if none are present.

Return strictly:
{
  "npcs": [
    {
      "name": "string",
      "realName": "string|null",
      "img": "string|null",
      "concept": "string",
      "drive": "string|null",
      "abilities": "string|null",
      "biography": "string|null"
    }
  ]
}

-- File: ${filePath}
-- Content Start --
${content.slice(0, 180000)}
-- Content End --
`;
}

const SYSTEM_BUILD = `
You are a senior content designer for "Masks: A New Generation" (PbtA).
Return JSON ONLY. No explanations. No markdown.
Rules:
- Create 3–5 flavorful villain moves (these are GM-style narrative moves, not dice moves).
- Create 5 condition moves, exactly one for each: Afraid, Angry, Guilty, Hopeless, Insecure.
- Each move MUST wrap the referenced GM move names in <b>…</b> inside a single <p>…</p> string.
- Use only these GM move names verbatim: ${GM_TRIGGER_WHITELIST.join(", ")}.
- Do not include any other keys.
`;

function USER_BUILD(npc) {
  return `
NPC context (from source):
Name: ${npc.name}
Real Name: ${npc.realName ?? ""}
Image Hint: ${npc.img ?? ""}
Concept: ${npc.concept ?? ""}
Drive: ${npc.drive ?? ""}
Abilities: ${npc.abilities ?? ""}
Bio: ${npc.biography ?? ""}

Return strictly:
{
  "villainMoves": [
    {
      "name": "string",
      "description_html": "<p>... include 1–2 <b>GM Move</b> tags ...</p>",
      "gm_triggers": ["One or two from the allowed list"]
    }
  ],
  "conditionMoves": {
    "Afraid": { "name": "Afraid — <short_verb_phrase>", "description_html": "<p>...</p>", "gm_triggers": ["..."] },
    "Angry": { "name": "Angry — <short_verb_phrase>", "description_html": "<p>...</p>", "gm_triggers": ["..."] },
    "Guilty": { "name": "Guilty — <short_verb_phrase>", "description_html": "<p>...</p>", "gm_triggers": ["..."] },
    "Hopeless": { "name": "Hopeless — <short_verb_phrase>", "description_html": "<p>...</p>", "gm_triggers": ["..."] },
    "Insecure": { "name": "Insecure — <short_verb_phrase>", "description_html": "<p>...</p>", "gm_triggers": ["..."] }
  },
  "details": {
    "drive": "1–4 short bullets or sentences",
    "abilities": "short HTML allowed",
    "biography": "1–3 sentences"
  }
}
`;
}

// ------------------------------ VALIDATION & SYNTHESIS ------------------------------

function coerceGMTriggers(trigs) {
  const arr = Array.isArray(trigs) ? trigs : [];
  const filtered = arr.filter((t) => GM_TRIGGER_WHITELIST.includes(t));
  if (filtered.length === 0) {
    // sensible defaults
    return ["Inflict a Condition"];
  }
  if (filtered.length > 2) return filtered.slice(0, 2);
  return filtered;
}

function ensureVillainMoves(moves) {
  const v = Array.isArray(moves) ? moves : [];
  let out = v
    .map((m) => ({
      name: String(m?.name ?? "").trim() || "Villain Tactic",
      gm_triggers: coerceGMTriggers(m?.gm_triggers),
      description_html: ensureSingleParagraphHTML(
        wrapGMTriggersBold(String(m?.description_html ?? "").trim(), coerceGMTriggers(m?.gm_triggers))
      ),
    }))
    .filter((m) => m.name && m.description_html);

  // Ensure 3–5 entries
  if (out.length < 3) {
    while (out.length < 3) {
      out.push({
        name: `Villain Gambit ${out.length + 1}`,
        gm_triggers: ["Inflict a Condition"],
        description_html: "<p>A ruthless push that <b>Inflict a Condition</b> unless the heroes accept a hard cost.</p>",
      });
    }
  } else if (out.length > 5) {
    out = out.slice(0, 5);
  }
  return out;
}

function ensureConditionMoves(cond) {
  const defaults = {
    Afraid: {
      name: "Afraid — Flinch from the Blow",
      gm_triggers: ["Put Innocents in Danger"],
      description_html:
        "<p>Hesitation opens a gap; the scene shifts to <b>Put Innocents in Danger</b> unless someone steps up and owns the risk.</p>",
    },
    Angry: {
      name: "Angry — Smash First, Ask Later",
      gm_triggers: ["Show the Costs of Collateral Damage"],
      description_html:
        "<p>Rage hits the wrong target; highlight fallout to <b>Show the Costs of Collateral Damage</b> in the environment.</p>",
    },
    Guilty: {
      name: "Guilty — Overcorrect in Public",
      gm_triggers: ["Take Influence over Someone"],
      description_html:
        "<p>Contrition plays on‑camera; an adult or rival seizes the narrative to <b>Take Influence over Someone</b>.</p>",
    },
    Hopeless: {
      name: "Hopeless — Fade Between Panels",
      gm_triggers: ["Make Them Pay a Price for Victory"],
      description_html:
        "<p>They consider bowing out; offer success but <b>Make Them Pay a Price for Victory</b> to stay engaged.</p>",
    },
    Insecure: {
      name: "Insecure — Second‑Guess and Stall",
      gm_triggers: ["Tell Them the Possible Consequences—and Ask"],
      description_html:
        "<p>Self‑doubt stalls momentum; lay it out with <b>Tell Them the Possible Consequences—and Ask</b>.</p>",
    },
  };

  const out = {};
  for (const key of ["Afraid", "Angry", "Guilty", "Hopeless", "Insecure"]) {
    const m = cond?.[key] ?? {};
    const name =
      String(m?.name ?? "").trim() ||
      defaults[key].name;
    const gm_triggers = coerceGMTriggers(m?.gm_triggers);
    const desc =
      String(m?.description_html ?? "").trim() ||
      defaults[key].description_html;
    out[key] = {
      name,
      gm_triggers,
      description_html: ensureSingleParagraphHTML(
        wrapGMTriggersBold(desc, gm_triggers)
      ),
    };
  }
  return out;
}

function paraphrasedBaselineGMMoves() {
  // Slightly reworded to avoid verbatim copying the example text.
  const scaffold = (name, text, iconKey = name) => ({
    name,
    moveType: "",
    description_html: ensureSingleParagraphHTML(wrapGMTriggersBold(text, [name])),
    icon: ICONS[iconKey] || ICONS.default,
  });

  return [
    scaffold(
      "Inflict a Condition",
      "Lean on the fiction: push emotions to the surface and <b>Inflict a Condition</b> unless the heroes accept a costly compromise."
    ),
    scaffold(
      "Take Influence over Someone",
      "Frame the moment so an adult or rival can <b>Take Influence over Someone</b>—or the target marks a fitting Condition to resist."
    ),
    scaffold(
      "Capture Someone",
      "Separate or restrain a target; they must concede position or resources to avoid <b>Capture Someone</b>."
    ),
    scaffold(
      "Put Innocents in Danger",
      "Turn the spotlight toward bystanders and <b>Put Innocents in Danger</b>, forcing tough choices or a split focus."
    ),
    scaffold(
      "Show the Costs of Collateral Damage",
      "Make the fallout vivid; structures crack and gear fails to <b>Show the Costs of Collateral Damage</b> right now."
    ),
    scaffold(
      "Tell Them the Possible Consequences—and Ask",
      "Present the stakes plainly—<b>Tell Them the Possible Consequences—and Ask</b>: do they still go through with it?"
    ),
  ];
}

// ------------------------------ TEMPLATE LOAD ------------------------------

async function loadTemplate() {
  try {
    const raw = await fsp.readFile(TEMPLATE_PATH, "utf8");
    const tpl = JSON.parse(raw);
    return tpl;
  } catch (e) {
    console.error(
      `ERROR: Could not read template at ${TEMPLATE_PATH}. Place ./example-npc.json at repo root.`
    );
    process.exit(1);
  }
}

// ------------------------------ ACTOR BUILD ------------------------------

const BASE_MOVE_RESULTS = {
  failure: {
    key: "system.moveResults.failure.value",
    label: "Complications...",
    value: ""
  },
  partial: {
    key: "system.moveResults.partial.value",
    label: "Partial success",
    value: ""
  },
  success: {
    key: "system.moveResults.success.value",
    label: "Success!",
    value: ""
  }
};

function buildMoveItem({ name, moveType, description_html, icon, sort = 0 }) {
  const id = generate16CharUUID();
  return {
    name,
    type: "npcMove",
    system: {
      moveType: moveType ?? "",
      description: description_html,
      rollFormula: "",
      moveResults: deepClone(BASE_MOVE_RESULTS),
      uses: 0
    },
    _id: id,
    img: icon || ICONS.default,
    effects: [],
    folder: null,
    sort,
    flags: {},
    _stats: {
      compendiumSource: null,
      duplicateSource: null,
      exportSource: null,
      coreVersion: "13.350",
      systemId: "pbta",
      systemVersion: "1.1.22",
      lastModifiedBy: generate16CharUUID()
    },
    ownership: { default: 0 }
  };
}

function deriveImagePathHint(text) {
  // Try to retain te-core-rules like paths in source.
  const m =
    text.match(/(modules\/te-core-rules\/[^\s"')]+?\.(?:png|jpg|jpeg|webp|svg))/i) ||
    text.match(/(modules\/[^\s"')]+?\.(?:png|jpg|jpeg|webp|svg))/i);
  return m ? m[1] : null;
}

function buildActorFromTemplate(template, npc, llm) {
  const actor = deepClone(template);

  // Required changes
  const actorId = generate16CharUUID();
  actor._id = actorId;
  actor.name = npc.name || "Unnamed Villain";

  // IMG: prefer npc.img; else try to derive; else default
  const img =
    npc.img ||
    deriveImagePathHint(npc._sourceText || "") ||
    "icons/svg/mystery-man.svg";
  actor.img = img;

  // Real name
  if (
    actor?.system?.attributes?.realName &&
    typeof actor.system.attributes.realName === "object"
  ) {
    actor.system.attributes.realName.value = npc.realName || npc.name || "";
  }

  // Optional details from llm.details
  const details = llm?.details || {};
  if (actor?.system?.details) {
    if (actor.system.details.drive)
      actor.system.details.drive.value = details.drive || npc.drive || "";
    if (actor.system.details.abilities)
      actor.system.details.abilities.value =
        details.abilities || npc.abilities || "";
    if (actor.system.details.biography)
      actor.system.details.biography.value =
        details.biography || npc.biography || "";
  }

  // Stats metadata
  if (actor?._stats) {
    actor._stats.coreVersion = "13.350";
    actor._stats.systemId = "pbta";
    actor._stats.systemVersion = "1.1.22";
    actor._stats.createdTime = NOW();
    actor._stats.modifiedTime = NOW();
    actor._stats.lastModifiedBy = generate16CharUUID();
  }

  // Prototype token (leave structure; keep its image generic)
  if (actor?.prototypeToken?.texture) {
    // keep default icon here; sheet image is from actor.img above
    actor.prototypeToken.texture.src = "icons/svg/mystery-man.svg";
  }

  // --- ITEMS: rebuild from scratch ---
  actor.items = [];
  let sort = 0;

  // Villain moves 3–5
  const villainMoves = ensureVillainMoves(llm?.villainMoves);
  for (const vm of villainMoves) {
    const icon = chooseIconFromTriggers(vm.gm_triggers);
    actor.items.push(
      buildMoveItem({
        name: vm.name,
        moveType: "villain",
        description_html: vm.description_html,
        icon,
        sort: (sort += 10)
      })
    );
  }

  // Condition moves (exactly 5)
  const conditions = ensureConditionMoves(llm?.conditionMoves);
  for (const cname of ["Afraid", "Angry", "Guilty", "Hopeless", "Insecure"]) {
    const m = conditions[cname];
    actor.items.push(
      buildMoveItem({
        name: m.name,
        moveType: "condition",
        description_html: m.description_html,
        icon: CONDITION_ICONS[cname] || ICONS.default,
        sort: (sort += 10)
      })
    );
  }

  // Baseline GM options (preserved, paraphrased)
  for (const gm of paraphrasedBaselineGMMoves()) {
    actor.items.push(
      buildMoveItem({
        name: gm.name,
        moveType: "",
        description_html: gm.description_html,
        icon: gm.icon,
        sort: (sort += 10)
      })
    );
  }

  return actor;
}

// ------------------------------ PIPELINE ------------------------------

async function enumerateNPCsFromText(filePath, text) {
  if (!text || text.trim().length < 30) return [];

  const payload = await callOpenRouterJSON({
    system: SYSTEM_ENUMERATE,
    user: USER_ENUMERATE(filePath, text)
  });

  const npcs = Array.isArray(payload?.npcs) ? payload.npcs : [];

  // Light validation & clipping if a model returns too many.
  const clean = npcs
    .map((n) => ({
      name: String(n?.name ?? "").trim(),
      realName: n?.realName ? String(n.realName).trim() : null,
      img: n?.img ? String(n.img).trim() : null,
      concept: n?.concept ? String(n.concept).trim() : "",
      drive: n?.drive ? String(n.drive).trim() : "",
      abilities: n?.abilities ? String(n.abilities).trim() : "",
      biography: n?.biography ? String(n.biography).trim() : "",
      _sourceText: text.slice(0, 200000) // hold for potential image path derivation
    }))
    .filter((n) => n.name);

  // If none found, return empty.
  return clean.slice(0, 50);
}

async function generateNPCMoves(npc) {
  const payload = await callOpenRouterJSON({
    system: SYSTEM_BUILD,
    user: USER_BUILD(npc)
  });

  // Validate & coerce
  const villainMoves = ensureVillainMoves(payload?.villainMoves);
  const conditionMoves = ensureConditionMoves(payload?.conditionMoves);
  const details = {
    drive: String(payload?.details?.drive ?? "").trim(),
    abilities: String(payload?.details?.abilities ?? "").trim(),
    biography: String(payload?.details?.biography ?? "").trim()
  };
  return { villainMoves, conditionMoves, details };
}

async function processFile(template, filePath) {
  console.log(`\n— Processing file: ${filePath}`);
  const text = await extractTextFromFile(filePath);
  if (!text) {
    console.warn(`WARN: No readable content: ${filePath}`);
    return;
  }

  // 1) Enumerate NPCs for this file
  let npcs = [];
  try {
    npcs = await enumerateNPCsFromText(filePath, text);
  } catch (e) {
    console.warn(`WARN: Failed to enumerate NPCs in ${filePath}: ${e.message}`);
    return;
  }

  if (!npcs.length) {
    console.warn(`WARN: No NPCs found in ${filePath}.`);
    return;
  }

  // 2) Per‑NPC request for consistency
  for (const npc of npcs) {
    try {
      console.log(`  • Porting NPC: ${npc.name}`);
      const llm = await generateNPCMoves(npc);
      const actor = buildActorFromTemplate(template, npc, llm);

      // Enforce fresh 16‑char actor ID and items ID already handled
      if (!isValid16CharUUID(actor._id)) {
        const newId = generate16CharUUID();
        console.warn(
          `    WARN: Actor ID invalid; reminting ${actor._id} → ${newId}`
        );
        actor._id = newId;
      }

      const safe = toSafeFileStub(actor.name);
      const fname = `npc_${safe}_${actor._id}.json`;
      const outPath = path.join(OUT_DIR, fname);

      if (!DRY_RUN) {
        await fsp.mkdir(OUT_DIR, { recursive: true });
        await fsp.writeFile(outPath, JSON.stringify(actor, null, 2), "utf8");
      }
      console.log(`    ✓ Wrote ${DRY_RUN ? "(dry) " : ""}${outPath}`);
    } catch (e) {
      console.warn(
        `  WARN: Failed to port NPC "${npc?.name ?? "unknown"}" from ${path.basename(
          filePath
        )}: ${e.message}`
      );
      // continue to next NPC
    }
  }
}

// Simple concurrency runner
async function runWithConcurrency(tasks, limit) {
  const results = [];
  let i = 0;
  let active = 0;

  return new Promise((resolve) => {
    const next = () => {
      if (i >= tasks.length && active === 0) return resolve(results);
      while (active < limit && i < tasks.length) {
        const idx = i++;
        active++;
        tasks[idx]()
          .then((res) => results.push(res))
          .catch(() => results.push(null))
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
  });
}

// ------------------------------ MAIN ------------------------------

async function main() {
  console.log("Masks NPC Porter — OpenRouter (Gemini 2.5 Pro)");
  console.log(`Model: ${MODEL}`);
  console.log(`Input dir:  ${IN_DIR}`);
  console.log(`Output dir: ${OUT_DIR}${DRY_RUN ? " (dry run)" : ""}`);
  console.log(`Template:   ${TEMPLATE_PATH}`);
  console.log(`Concurrency:${CONCURRENCY}`);
  console.log(`Pattern:    ${FILE_PATTERN}`);

  const template = await loadTemplate();

  // Gather input files
  let files = [];
  try {
    files = await listFilesRecursively(IN_DIR, FILE_PATTERN);
  } catch (e) {
    console.error(`ERROR: Could not read input directory: ${e.message}`);
    process.exit(1);
  }
  if (!files.length) {
    console.warn("WARN: No input files found.");
    return;
  }

  // Create tasks
  const tasks = files.map((file) => () => processFile(template, file));
  await runWithConcurrency(tasks, CONCURRENCY);

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});
