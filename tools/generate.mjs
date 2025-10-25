#!/usr/bin/env node
/**
 * tools/port-npcs.mjs
 * =============================================================================
 * Port NPCs from source files (PDF/TXT/MD/JSON) into Masks: A New Generation
 * (PbtA) Actor JSON, mirroring ./example-npc.json and adding fresh, flavored
 * moves for each NPC.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ✨ What this does
 * - Scans an input directory for .pdf, .txt, .md, .json files.
 * - Extracts text (via pdf-parse or `pdftotext` CLI; reads text/JSON directly).
 * - Calls OpenRouter (model: google/gemini-2.5-pro) using the Chat Completions
 *   endpoint with JSON-only responses to:
 *     1) Enumerate NPCs mentioned in each source file.
 *     2) For each NPC, generate:
 *        • 3–5 custom "Villain" moves (type: npcMove, moveType: "villain")
 *        • 5 custom "Condition" moves (Afraid, Angry, Guilty, Hopeless, Insecure)
 *        • Optional drive/abilities/biography text (to preserve source flavor)
 * - Builds a complete Foundry Actor (type: "npc") by cloning ./example-npc.json,
 *   changing only allowed fields, and writing one JSON file per new villain:
 *      npc_<VILLAIN_NAME>_<16CHARUUID>.json
 *   in the configurable output directory (default: src/packs/ported).
 *
 * 🧱 Strict schema adherence & safety rails
 * - We clone ./example-npc.json and only modify:
 *     • name
 *     • _id (new 16‑character alphanumeric UUID)
 *     • img (tries to retain te-core-rules paths from source; otherwise default)
 *     • system.attributes.realName.value
 *     • system.details.{drive,abilities,biography} (optional preserve/copy)
 *     • items:
 *         → 3–5 new "villain" npcMove items
 *         → 5 new "condition" npcMove items (one per condition)
 *         → baseline GM options are kept (paraphrased; not removed)
 * - All moves use the same data structure as example items:
 *     system.moveType, system.description (HTML, single <p>…</p>),
 *     rollFormula:"", moveResults scaffold, uses:0, img icons provided.
 * - Each move description references 1–2 allowed GM moves wrapped as <b>…</b>.
 * - Strong validation & auto-synthesis if the model under-fills fields.
 * - Fresh 16‑character IDs are minted for the Actor and every Item.
 * - Robust retries on 429/5xx with exponential backoff (no infinite loops).
 * - Continues even if a given NPC or file fails (warns; keeps going).
 *
 * 🗂 Prompt capture
 * - Every LLM prompt we use is saved to ./resources as a .md file for traceability:
 *     • enum_prompt_<FILE>.md  (NPC enumeration)
 *     • build_prompt_<NPC>_<SEQ>.md (per-NPC move generation)
 *
 * ⚠️ Notes & constraints
 * - Never re-use the example NPC’s moves verbatim; generate brand new villain and
 *   condition moves per character.
 * - Do not strip baseline GM options; they must remain present.
 * - Avoid duplicative HTML markup: descriptions are normalized to a single <p>…</p>,
 *   and bold tags around GM move names are applied cleanly.
 * - Do not specify max tokens in OpenRouter requests.
 * - Separate request per NPC to keep outputs consistent.
 *
 * CLI
 * -----------------------------------------------------------------------------
 *   node tools/port-npcs.mjs [--indir ./src/packs]
 *                            [--outdir ./src/packs/ported]
 *                            [--template ./example-npc.json]
 *                            [--model google/gemini-2.5-pro]
 *                            [--concurrency 2]
 *                            [--filePattern "*"]
 *                            [--dry]
 *
 * ENV
 * -----------------------------------------------------------------------------
 *   OPENROUTER_API_KEY   (required)
 *   OPENROUTER_SITE_URL  (optional; for OpenRouter rankings)
 *   OPENROUTER_SITE_NAME (optional; for OpenRouter rankings)
 *
 * Optional dependency for PDFs:
 *   npm i -D pdf-parse
 * If missing, the script falls back to the `pdftotext` CLI (Poppler).
 *
 * License: MIT (matches the repository)
 * =============================================================================
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { exec as execCb } from "child_process";
import { setTimeout as sleep } from "timers/promises";

// Node 18+ has global fetch; fall back to node-fetch if needed
const fetch = globalThis.fetch ?? (await import("node-fetch")).default;

// WebCrypto for randomness (stable across Node 18+)
const webcrypto = globalThis.crypto ?? (await import("node:crypto")).webcrypto;

/* ---------------------------------- CLI ---------------------------------- */

const argv = process.argv.slice(2);
const getFlag = (name, def = undefined) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) return true; // boolean flag
  return v;
};

const IN_DIR = path.resolve(getFlag("indir", "./src/packs"));
const OUT_DIR = path.resolve(getFlag("outdir", "./src/packs/ported"));
const TEMPLATE_PATH = path.resolve(getFlag("template", "./example-npc.json"));
const MODEL = getFlag("model", "google/gemini-2.5-pro");
const CONCURRENCY = Math.max(1, parseInt(getFlag("concurrency", "2"), 10) || 2);
const FILE_PATTERN = getFlag("filePattern", "*"); // simple glob: literal or prefix*
const DRY_RUN = !!getFlag("dry", false);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  console.error("ERROR: OPENROUTER_API_KEY environment variable is required.");
  process.exit(1);
}

/* ------------------------------- Constants ------------------------------- */

const RESOURCES_DIR = path.resolve("./resources");

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
  "Bring an NPC to Rash Decisions and Hard Conclusions",
];

const ICONS = {
  default:
    "modules/masks-newgeneration-unofficial/images/gameicons/aura-#ffffff-#3da7db.svg",
  "Inflict a Condition":
    "modules/masks-newgeneration-unofficial/images/gameicons/spiky-explosion-#ffffff-#3da7db.svg",
  "Take Influence over Someone":
    "modules/masks-newgeneration-unofficial/images/gameicons/distraction-#ffffff-#3da7db.svg",
  "Put Innocents in Danger":
    "modules/masks-newgeneration-unofficial/images/gameicons/target-dummy-#ffffff-#3da7db.svg",
  "Capture Someone":
    "modules/masks-newgeneration-unofficial/images/gameicons/arrest-#ffffff-#3da7db.svg",
  "Show the Costs of Collateral Damage":
    "modules/masks-newgeneration-unofficial/images/gameicons/bulldozer-#ffffff-#3da7db.svg",
  "Tell Them the Possible Consequences—and Ask":
    "modules/masks-newgeneration-unofficial/images/gameicons/death-note-#ffffff-#3da7db.svg",
  "Make Them Pay a Price for Victory":
    "modules/masks-newgeneration-unofficial/images/gameicons/broken-pottery-#ffffff-#3da7db.svg",
  "Bring Them Together":
    "modules/masks-newgeneration-unofficial/images/gameicons/team-upgrade-#ffffff-#3da7db.svg",
  "Reveal the Future":
    "modules/masks-newgeneration-unofficial/images/gameicons/time-trap-#ffffff-#3da7db.svg",
  "Announce Between‑Panel Threats":
    "modules/masks-newgeneration-unofficial/images/gameicons/ringing-alarm-#ffffff-#3da7db.svg",
  "Activate the Downsides of their Abilities and Relationships":
    "modules/masks-newgeneration-unofficial/images/gameicons/liar-#ffffff-#3da7db.svg",
  "Turn Their Move Back on Them":
    "modules/masks-newgeneration-unofficial/images/gameicons/shield-reflect-#ffffff-#3da7db.svg",
  "Tell Them Who They Are or Who They Should Be":
    "modules/masks-newgeneration-unofficial/images/gameicons/philosopher-bust-#ffffff-#3da7db.svg",
  "Bring an NPC to Rash Decisions and Hard Conclusions":
    "modules/masks-newgeneration-unofficial/images/gameicons/radar-sweep-#ffffff-#3da7db.svg",
};

const CONDITION_ICONS = {
  Afraid:
    "modules/masks-newgeneration-unofficial/images/gameicons/suspicious-#ffffff-#3da7db.svg",
  Angry:
    "modules/masks-newgeneration-unofficial/images/gameicons/confrontation-#ffffff-#3da7db.svg",
  Guilty:
    "modules/masks-newgeneration-unofficial/images/gameicons/robber-#ffffff-#3da7db.svg",
  Hopeless:
    "modules/masks-newgeneration-unofficial/images/gameicons/kneeling-#ffffff-#3da7db.svg",
  Insecure:
    "modules/masks-newgeneration-unofficial/images/gameicons/broken-pottery-#ffffff-#3da7db.svg",
};

const BASE_MOVE_RESULTS = {
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

const NOW = () => Date.now();

const exec = (cmd) =>
  new Promise((resolve, reject) => {
    execCb(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout, stderr }));
      resolve({ stdout, stderr });
    });
  });

/* --------------------------------- Utils --------------------------------- */

function generate16CharUUID() {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(16);
  webcrypto.getRandomValues(arr);
  let out = "";
  for (let i = 0; i < arr.length; i++) {
    out += alphabet[arr[i] % alphabet.length];
  }
  return out;
}

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
  for (const t of triggers) if (ICONS[t]) return ICONS[t];
  return ICONS.default;
}

function ensureSingleParagraphHTML(input) {
  if (!input) return "<p></p>";
  let s = String(input).trim();

  // Prevent duplicate wrappers (e.g., <p><p>…</p></p>)
  // Strip surrounding <p>…</p> if it encloses the entire string more than once.
  const pOpen = /^<p>/i;
  const pClose = /<\/p>$/i;
  if (pOpen.test(s) && pClose.test(s)) {
    // Collapse multiple nested <p> by trimming once
    s = s.replace(/^\s*<p>\s*/i, "").replace(/\s*<\/p>\s*$/i, "");
  }

  // Collapse whitespace/newlines
  s = s.replace(/\s+/g, " ").trim();

  return `<p>${s}</p>`;
}

function stripExistingBoldForTriggers(text, triggers) {
  let s = String(text);
  for (const t of triggers) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Remove existing <b>…</b> around the trigger
    const re = new RegExp(`<b>\\s*${escaped}\\s*<\\/b>`, "gi");
    s = s.replace(re, t);
  }
  return s;
}

function wrapGMTriggersBold(text, triggers = []) {
  // First un-bold if already bolded, then bold once.
  let s = stripExistingBoldForTriggers(text, triggers);
  for (const t of triggers) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "g");
    s = s.replace(re, `<b>${t}</b>`);
  }
  return s;
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

function minimatch(filename, glob) {
  if (!glob || glob === "*") return true;
  if (glob.endsWith("*")) return filename.startsWith(glob.slice(0, -1));
  return filename === glob;
}

/* ---------------------------- Extraction: Text --------------------------- */

async function extractTextFromPDF(filePath) {
  // Try pdf-parse (NPM)
  try {
    const pdfParse = (await import("pdf-parse")).default;
    const data = await fsp.readFile(filePath);
    const res = await pdfParse(data);
    if (res?.text?.trim()) return res.text;
  } catch {
    // fall through
  }
  // Fallback: pdftotext CLI
  try {
    const cmd = `pdftotext -layout -nopgbrk "${filePath}" -`;
    const { stdout } = await exec(cmd);
    if (stdout?.trim()) return stdout;
  } catch {
    // ignore
  }
  console.warn(
    `WARN: Could not extract text from PDF (install pdf-parse or Poppler pdftotext): ${filePath}`
  );
  return "";
}

async function extractTextFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return extractTextFromPDF(filePath);
  if (ext === ".txt" || ext === ".md") return fsp.readFile(filePath, "utf8");
  if (ext === ".json") {
    try {
      const raw = await fsp.readFile(filePath, "utf8");
      return raw.length > 500_000 ? raw.slice(0, 500_000) : raw;
    } catch {
      return "";
    }
  }
  return "";
}

async function listFilesRecursively(dir, pattern = "*") {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const nested = await listFilesRecursively(full, pattern);
      out.push(...nested);
    } else {
      const ext = path.extname(e.name).toLowerCase();
      if (ALLOWED_EXTENSIONS.has(ext) && minimatch(e.name, pattern)) {
        out.push(full);
      }
    }
  }
  return out;
}

/* ------------------------------- OpenRouter ----------------------------- */

async function callOpenRouterJSON({ system, user }) {
  const headers = {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (process.env.OPENROUTER_SITE_URL)
    headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
  if (process.env.OPENROUTER_SITE_NAME)
    headers["X-Title"] = process.env.OPENROUTER_SITE_NAME;

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
        const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
        const base = Math.min(2 ** attempt * 500, 15_000);
        const delay = retryAfter ? retryAfter * 1000 : base + Math.random() * 500;
        console.warn(
          `WARN: OpenRouter ${res.status}. Retrying in ~${Math.round(
            delay / 1000
          )}s (attempt ${attempt}/${maxAttempts})`
        );
        await sleep(delay);
        continue;
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`OpenRouter error ${res.status}: ${txt?.slice(0, 400)}`);
      }

      const json = await res.json();
      let content =
        json?.choices?.[0]?.message?.content ??
        json?.choices?.[0]?.content ??
        "";

      if (Array.isArray(content)) {
        content = content
          .map((part) => (typeof part === "string" ? part : part?.text || ""))
          .join("\n");
      }

      const clean = stripCodeFences(String(content));
      if (!clean) throw new Error("Empty JSON response from model.");

      try {
        return JSON.parse(clean);
      } catch {
        const start = clean.indexOf("{");
        const end = clean.lastIndexOf("}");
        if (start >= 0 && end > start) {
          return JSON.parse(clean.slice(start, end + 1));
        }
        throw new Error("Failed to parse model JSON.");
      }
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) break;
      const backoff = Math.min(2 ** attempt * 400, 10_000);
      await sleep(backoff + Math.random() * 400);
    }
  }
  throw lastErr ?? new Error("Unknown OpenRouter failure.");
}

/* -------------------------------- Prompts ------------------------------- */

const SYSTEM_ENUMERATE = `
You convert third‑party TTRPG content into Masks: A New Generation NPCs.
Return pure JSON. No prose. No markdown.
`;

function USER_ENUMERATE(filePath, content) {
  return `
From the source below, enumerate NPCs suitable to port into Masks NPCs.

For each NPC, include:
- name (string, required)
- realName (string|null)
- img (string|null) — only include if the text explicitly contains an image path; do not invent
- concept (<=20 words)
- drive (string|null)
- abilities (string|null)
- biography (string|null)

Return exactly:
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

— File: ${filePath}
— Content Start —
${content.slice(0, 180000)}
— Content End —
`.trim();
}

const SYSTEM_BUILD = `
You are a senior content designer for "Masks: A New Generation" (PbtA).
Return JSON ONLY (no prose, no markdown).
Rules:
- Create 3–5 flavorful "villain" moves (GM‑style; narrative pressure, not dice).
- Create 5 "condition" moves, exactly one per: Afraid, Angry, Guilty, Hopeless, Insecure.
- Each move description must be a single <p>…</p> string.
- Inside that <p>, wrap 1–2 of these exact GM move names in <b>…</b>:
  ${GM_TRIGGER_WHITELIST.join(", ")}.
- Do not use any GM move names not on that list.
`;

function USER_BUILD(npc) {
  return `
NPC context (from source):
Name: ${npc.name}
Real Name: ${npc.realName ?? ""}
Image: ${npc.img ?? ""}
Concept: ${npc.concept ?? ""}
Drive: ${npc.drive ?? ""}
Abilities: ${npc.abilities ?? ""}
Biography: ${npc.biography ?? ""}

Return exactly:
{
  "villainMoves": [
    {
      "name": "string",
      "description_html": "<p>…include 1–2 <b>GM Move Name</b> tags…</p>",
      "gm_triggers": ["Allowed GM move", "Optional second allowed GM move"]
    }
  ],
  "conditionMoves": {
    "Afraid":  { "name": "Afraid — <verb phrase>",  "description_html": "<p>…</p>", "gm_triggers": ["…"] },
    "Angry":   { "name": "Angry — <verb phrase>",   "description_html": "<p>…</p>", "gm_triggers": ["…"] },
    "Guilty":  { "name": "Guilty — <verb phrase>",  "description_html": "<p>…</p>", "gm_triggers": ["…"] },
    "Hopeless":{ "name": "Hopeless — <verb phrase>","description_html": "<p>…</p>", "gm_triggers": ["…"] },
    "Insecure":{ "name": "Insecure — <verb phrase>","description_html": "<p>…</p>", "gm_triggers": ["…"] }
  },
  "details": {
    "drive": "1–4 short bullets or sentences (plain text or minimal HTML)",
    "abilities": "short blurb (HTML allowed)",
    "biography": "1–3 sentences"
  }
}
`.trim();
}

/* -------------------------- Prompt file emission ------------------------- */

async function writePromptMarkdown(kind, baseName, system, user) {
  try {
    await fsp.mkdir(RESOURCES_DIR, { recursive: true });
    const safe = baseName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    const file = path.join(RESOURCES_DIR, `${kind}_prompt_${safe}.md`);
    const body = `# ${kind} Prompt\n\n## system\n\n\`\`\`\n${system}\n\`\`\`\n\n## user\n\n\`\`\`\n${user}\n\`\`\`\n`;
    await fsp.writeFile(file, body, "utf8");
  } catch (e) {
    console.warn(`WARN: Failed to write prompt MD (${kind}): ${e.message}`);
  }
}

/* ----------------------- Validation & auto-synthesis ---------------------- */

function coerceGMTriggers(trigs) {
  const arr = Array.isArray(trigs) ? trigs : [];
  const filtered = arr.filter((t) => GM_TRIGGER_WHITELIST.includes(t));
  if (filtered.length === 0) return ["Inflict a Condition"];
  return filtered.slice(0, 2);
}

function ensureVillainMoves(moves) {
  const list = Array.isArray(moves) ? moves : [];
  let out = list
    .map((m) => {
      const gm = coerceGMTriggers(m?.gm_triggers);
      const desc = ensureSingleParagraphHTML(
        wrapGMTriggersBold(String(m?.description_html ?? "").trim(), gm)
      );
      return {
        name: String(m?.name ?? "").trim() || "Villain Gambit",
        gm_triggers: gm,
        description_html: desc,
      };
    })
    .filter((m) => m.name && m.description_html);

  if (out.length < 3) {
    while (out.length < 3) {
      out.push({
        name: `Villain Gambit ${out.length + 1}`,
        gm_triggers: ["Inflict a Condition"],
        description_html:
          "<p>Press the attack; <b>Inflict a Condition</b> unless the heroes accept a costly compromise.</p>",
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
      name: "Afraid — Slip into the Shadows",
      gm_triggers: ["Put Innocents in Danger"],
      description_html:
        "<p>Hesitation opens a gap; escalate to <b>Put Innocents in Danger</b> unless someone steps up immediately.</p>",
    },
    Angry: {
      name: "Angry — Break Something that Matters",
      gm_triggers: ["Show the Costs of Collateral Damage"],
      description_html:
        "<p>Rage spills over; <b>Show the Costs of Collateral Damage</b> as the scene strains under the outburst.</p>",
    },
    Guilty: {
      name: "Guilty — Overcorrect in the Spotlight",
      gm_triggers: ["Take Influence over Someone"],
      description_html:
        "<p>Public contrition cedes narrative control; a rival or adult <b>Take Influence over Someone</b>.</p>",
    },
    Hopeless: {
      name: "Hopeless — Step Between the Panels",
      gm_triggers: ["Make Them Pay a Price for Victory"],
      description_html:
        "<p>Offer success at cost; <b>Make Them Pay a Price for Victory</b> to keep the team in the fight.</p>",
    },
    Insecure: {
      name: "Insecure — Second‑Guess the Plan",
      gm_triggers: ["Tell Them the Possible Consequences—and Ask"],
      description_html:
        "<p>Momentum stalls; lay it out with <b>Tell Them the Possible Consequences—and Ask</b> before action resumes.</p>",
    },
  };

  const out = {};
  for (const key of ["Afraid", "Angry", "Guilty", "Hopeless", "Insecure"]) {
    const m = cond?.[key] ?? {};
    const gm = coerceGMTriggers(m?.gm_triggers);
    const name = String(m?.name ?? "").trim() || defaults[key].name;
    const desc =
      String(m?.description_html ?? "").trim() || defaults[key].description_html;
    out[key] = {
      name,
      gm_triggers: gm,
      description_html: ensureSingleParagraphHTML(
        wrapGMTriggersBold(desc, gm)
      ),
    };
  }
  return out;
}

function paraphrasedBaselineGMMoves() {
  const mk = (name, text, iconKey = name) => ({
    name,
    moveType: "",
    description_html: ensureSingleParagraphHTML(
      wrapGMTriggersBold(text, [name])
    ),
    icon: ICONS[iconKey] || ICONS.default,
  });

  return [
    mk(
      "Inflict a Condition",
      "Turn the screws in-fiction and <b>Inflict a Condition</b> unless the heroes accept a hard compromise."
    ),
    mk(
      "Take Influence over Someone",
      "Frame the moment so an adult or rival can <b>Take Influence over Someone</b>, or the target marks a fitting condition to resist."
    ),
    mk(
      "Capture Someone",
      "Separate or restrain a target; they must concede position or resources to avoid <b>Capture Someone</b>."
    ),
    mk(
      "Put Innocents in Danger",
      "Shift focus to bystanders and <b>Put Innocents in Danger</b>, forcing tough choices or a split."
    ),
    mk(
      "Show the Costs of Collateral Damage",
      "Highlight fallout as structures fail and gear cracks to <b>Show the Costs of Collateral Damage</b>."
    ),
    mk(
      "Tell Them the Possible Consequences—and Ask",
      "Present the stakes plainly—<b>Tell Them the Possible Consequences—and Ask</b>: do they proceed?"
    ),
  ];
}

function deriveImagePathHint(text) {
  const m =
    text.match(
      /(modules\/te-core-rules\/[^\s"')]+?\.(?:png|jpg|jpeg|webp|svg))/i
    ) || text.match(/(modules\/[^\s"')]+?\.(?:png|jpg|jpeg|webp|svg))/i);
  return m ? m[1] : null;
}

/* ------------------------------- Template ------------------------------- */

async function loadTemplate() {
  try {
    const raw = await fsp.readFile(TEMPLATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error(
      `ERROR: Could not read template at ${TEMPLATE_PATH}. Ensure ./example-npc.json exists.`
    );
    process.exit(1);
  }
}

/* ----------------------------- Actor building ---------------------------- */

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
      uses: 0,
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
      lastModifiedBy: generate16CharUUID(),
    },
    ownership: { default: 0 },
  };
}

function buildActorFromTemplate(template, npc, llm) {
  const actor = deepClone(template);

  // Fresh actor ID and name
  const actorId = generate16CharUUID();
  actor._id = actorId;
  actor.name = npc.name || "Unnamed Villain";

  // IMG: prefer npc.img, else derive te-core-rules path from source text, else default
  const img =
    npc.img || deriveImagePathHint(npc._sourceText || "") || "icons/svg/mystery-man.svg";
  actor.img = img;

  // Real name
  if (actor?.system?.attributes?.realName) {
    actor.system.attributes.realName.value = npc.realName || npc.name || "";
  }

  // Optional details (preserve source flavor)
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

  // Update stats
  if (actor?._stats) {
    actor._stats.coreVersion = "13.350";
    actor._stats.systemId = "pbta";
    actor._stats.systemVersion = "1.1.22";
    actor._stats.createdTime = NOW();
    actor._stats.modifiedTime = NOW();
    actor._stats.lastModifiedBy = generate16CharUUID();
  }

  // Keep prototypeToken; don't overwrite sheet token texture except to generic default
  if (actor?.prototypeToken?.texture?.src) {
    actor.prototypeToken.texture.src = "icons/svg/mystery-man.svg";
  }

  // ITEMS: rebuild from scratch
  actor.items = [];
  let sort = 0;

  // 3–5 villain moves
  const villainMoves = ensureVillainMoves(llm?.villainMoves);
  for (const vm of villainMoves) {
    actor.items.push(
      buildMoveItem({
        name: vm.name,
        moveType: "villain",
        description_html: vm.description_html,
        icon: chooseIconFromTriggers(vm.gm_triggers),
        sort: (sort += 10),
      })
    );
  }

  // 5 condition moves (Afraid/Angry/Guilty/Hopeless/Insecure)
  const condMoves = ensureConditionMoves(llm?.conditionMoves);
  for (const cname of ["Afraid", "Angry", "Guilty", "Hopeless", "Insecure"]) {
    const m = condMoves[cname];
    actor.items.push(
      buildMoveItem({
        name: m.name,
        moveType: "condition",
        description_html: m.description_html,
        icon: CONDITION_ICONS[cname] || ICONS.default,
        sort: (sort += 10),
      })
    );
  }

  // Preserve baseline GM options (paraphrased)
  for (const gm of paraphrasedBaselineGMMoves()) {
    actor.items.push(
      buildMoveItem({
        name: gm.name,
        moveType: "",
        description_html: gm.description_html,
        icon: gm.icon,
        sort: (sort += 10),
      })
    );
  }

  // Final safety: ensure actor ID is valid
  if (!isValid16CharUUID(actor._id)) {
    const newId = generate16CharUUID();
    console.warn(`WARN: Actor ID invalid; reminting ${actor._id} → ${newId}`);
    actor._id = newId;
  }

  return actor;
}

/* ------------------------------- Pipeline -------------------------------- */

async function enumerateNPCsFromText(filePath, text) {
  if (!text || text.trim().length < 30) return [];

  const sys = SYSTEM_ENUMERATE.trim();
  const usr = USER_ENUMERATE(filePath, text);
  await writePromptMarkdown("enum", path.basename(filePath), sys, usr);

  const payload = await callOpenRouterJSON({ system: sys, user: usr });
  const npcs = Array.isArray(payload?.npcs) ? payload.npcs : [];

  const clean = npcs
    .map((n) => ({
      name: String(n?.name ?? "").trim(),
      realName: n?.realName ? String(n.realName).trim() : null,
      img: n?.img ? String(n.img).trim() : null,
      concept: n?.concept ? String(n.concept).trim() : "",
      drive: n?.drive ? String(n.drive).trim() : "",
      abilities: n?.abilities ? String(n.abilities).trim() : "",
      biography: n?.biography ? String(n.biography).trim() : "",
      _sourceText: text.slice(0, 200000),
    }))
    .filter((n) => n.name);

  return clean.slice(0, 50);
}

async function generateNPCMoves(npc) {
  const sys = SYSTEM_BUILD.trim();
  const usr = USER_BUILD(npc);
  await writePromptMarkdown(
    "build",
    `${toSafeFileStub(npc.name)}_${Date.now()}`,
    sys,
    usr
  );

  const payload = await callOpenRouterJSON({ system: sys, user: usr });

  const villainMoves = ensureVillainMoves(payload?.villainMoves);
  const conditionMoves = ensureConditionMoves(payload?.conditionMoves);
  const details = {
    drive: String(payload?.details?.drive ?? "").trim(),
    abilities: String(payload?.details?.abilities ?? "").trim(),
    biography: String(payload?.details?.biography ?? "").trim(),
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

  for (const npc of npcs) {
    try {
      console.log(`  • Porting NPC: ${npc.name}`);
      const llm = await generateNPCMoves(npc);
      const actor = buildActorFromTemplate(template, npc, llm);

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

async function runWithConcurrency(tasks, limit) {
  const results = [];
  let idx = 0;
  let active = 0;

  return new Promise((resolve) => {
    const next = () => {
      if (idx >= tasks.length && active === 0) return resolve(results);
      while (active < limit && idx < tasks.length) {
        const myIdx = idx++;
        active++;
        tasks[myIdx]()
          .then((r) => results.push(r))
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

/* --------------------------------- Main ---------------------------------- */

async function main() {
  console.log("Masks NPC Porter — OpenRouter (Gemini 2.5 Pro)");
  console.log(`Model       : ${MODEL}`);
  console.log(`Input dir   : ${IN_DIR}`);
  console.log(`Output dir  : ${OUT_DIR}${DRY_RUN ? " (dry run)" : ""}`);
  console.log(`Template    : ${TEMPLATE_PATH}`);
  console.log(`Concurrency : ${CONCURRENCY}`);
  console.log(`Pattern     : ${FILE_PATTERN}`);

  const template = await loadTemplate();

  let files = [];
  try {
    files = await listFilesRecursively(IN_DIR, FILE_PATTERN);
  } catch (e) {
    console.error(`ERROR: Could not read input directory: ${e.message}`);
    process.exit(1);
  }

  if (!files.length) {
    console.warn("WARN: No input files found to process.");
    return;
  }

  const tasks = files.map((file) => () => processFile(template, file));
  await runWithConcurrency(tasks, CONCURRENCY);

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});
