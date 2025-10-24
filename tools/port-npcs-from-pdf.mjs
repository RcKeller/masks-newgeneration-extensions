/**
 * tools/port-npcs-from-pdf.mjs
 * 
 * Ports NPCs from small PDFs into Masks: The New Generation NPC JSON documents
 * that match your existing schema (using example-npc.json as the “exact” shape).
 * 
 * - Uses Anthropic’s Files + Messages APIs to read the PDF and extract villains.
 * - Processes villains one-at-a-time (sequential) to make steady progress.
 * - Handles Anthropic rate limits with bounded exponential backoff + jitter.
 * - Saves robust progress in a temp work dir to allow safe stop/start.
 * - Continues even if a single villain fails (logs warning and moves on).
 * - Replaces the example actor’s 16‑char UUID everywhere with a fresh one.
 * - Sets `attributes.realName.value` and fills `details.drive/abilities/biography`.
 * - Adds 3–5 custom villain moves (type: npcMove) to the Items array.
 * - Writes results to an outDir (default: src/packs/ported) using Foundry naming.
 * 
 * REQUIREMENTS
 *   - Node 18+ recommended.
 *   - ANTHROPIC_API_KEY must be present in environment (or .env).
 *   - An example file in repo root named `example-npc.json` (can override via CLI).
 * 
 * USAGE
 *   node tools/port-npcs-from-pdf.mjs --input ./my-book.pdf
 *
 *   Options:
 *     --input, -i         Path to a single PDF file OR a directory that contains PDFs       (required)
 *     --outDir, -o        Output directory (default: src/packs/ported)
 *     --tempDir, -t       Temp/working directory (default: .tmp/port-npcs)
 *     --example, -e       Path to example NPC JSON (default: ./example-npc.json)
 *     --model, -m         Anthropic model (default: claude-sonnet-4-20250514)
 *     --maxVillains       Hard cap villains per PDF (default: unlimited)
 *     --dryRun            Don’t write final actor files, keep temp artifacts only
 *     --strictActorName   If set, WILL NOT change actor.name (only realName/details.*)
 * 
 * EXAMPLES
 *   node tools/port-npcs-from-pdf.mjs -i ./assets/adventure.pdf -o src/packs/ported
 *   node tools/port-npcs-from-pdf.mjs -i ./pdfs -m claude-3-7-sonnet-20250219
 * 
 * DEPENDENCIES (install in your repo):
 *   npm i @anthropic-ai/sdk dotenv
 * 
 * COPYRIGHT
 *   You stated you own the copyright for the files processed.
 */

import 'dotenv/config';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import crypto from 'crypto';

// ---------- Constants & CLI parsing ----------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
// Keep in sync with your existing usage in tools/pdf-processor.mjs
const FILES_BETA = 'files-api-2025-04-14';

const args = parseArgs(process.argv.slice(2));

if (!args.input) {
  console.error('ERROR: --input <fileOrDir> is required.\nTry: node tools/port-npcs-from-pdf.mjs --input ./foo.pdf');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY is not set. Put it in your environment or .env file.');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------- Main ----------

(async function main() {
  const inputs = await enumerateInputs(args.input);
  if (inputs.length === 0) {
    console.warn(`[warn] No PDFs found in: ${args.input}`);
    process.exit(0);
  }

  await ensureDir(args.tempDir);
  await ensureDir(args.outDir);

  for (const pdfPath of inputs) {
    try {
      await processOnePDF(pdfPath, args);
    } catch (err) {
      logErr(`Fatal error processing PDF ${pdfPath}: ${err?.message || err}`);
      // Continue to next PDF per requirements.
    }
  }

  log(`All done.`);
})().catch((e) => {
  logErr(`Unexpected failure: ${e?.stack || e}`);
  process.exit(1);
});

// ---------- Orchestration per PDF ----------

async function processOnePDF(pdfPath, cli) {
  const base = path.basename(pdfPath);
  const pdfSlug = slugify(base.replace(/\.pdf$/i, ''));
  const pdfTempDir = path.join(cli.tempDir, pdfSlug);
  await ensureDir(pdfTempDir);

  const progressPath = path.join(pdfTempDir, 'progress.json');
  const uploadMetaPath = path.join(pdfTempDir, 'upload.json');
  const villainsListPath = path.join(pdfTempDir, 'villains-list.json');

  const progress = await loadJSONSafe(progressPath, { villains: {}, pdf: { path: pdfPath } });

  // Upload or reuse uploaded fileId
  let fileId = await maybeReuseUpload(uploadMetaPath);
  if (!fileId) {
    fileId = await uploadPDF(pdfPath, uploadMetaPath);
  }

  // Plan: list villains present in PDF
  let villains = await loadJSONSafe(villainsListPath, null);
  if (!villains) {
    villains = await planVillainCandidates(fileId, cli.model);
    await saveJSON(villainsListPath, villains);
  }
  if (!Array.isArray(villains) || villains.length === 0) {
    logWarn(`[${base}] No villains found by the planner. Skipping PDF.`);
    return;
  }

  // Optional max
  let toProcess = villains;
  if (cli.maxVillains && Number.isFinite(Number(cli.maxVillains))) {
    toProcess = villains.slice(0, Number(cli.maxVillains));
  }

  const template = await loadExampleTemplate(cli.example);
  const templateActorId = (typeof template._id === 'string' && template._id.length === 16) ? template._id : null;

  // Extract + build each villain sequentially
  for (const v of toProcess) {
    const key = v.key || slugify(v.alias || v.name || v.realName || randomId(8));
    if (progress.villains[key]?.status === 'done') {
      log(`[${base}] [skip] ${v.alias || v.name || v.realName} already processed.`);
      continue;
    }
    try {
      log(`[${base}] [extract] ${v.alias || v.name || v.realName}...`);
      const details = await extractOneVillain(fileId, v, cli.model);
      const actorDoc = await buildActorDocumentFromTemplate({
        template,
        templateActorId,
        villain: details,
        keepActorName: cli.strictActorName
      });

      // Write final actor JSON
      if (cli.dryRun) {
        log(`[dryRun] Would write actor for ${details.alias || details.name || details.realName}`);
      } else {
        const actorFile = await writeActorFile(actorDoc, cli.outDir);
        progress.villains[key] = {
          status: 'done',
          alias: details.alias || details.name || null,
          realName: details.realName || null,
          outFile: actorFile,
          actorId: actorDoc._id
        };
        await saveJSON(progressPath, progress);
        log(`[${base}] [ok] ${details.alias || details.name || details.realName} -> ${actorFile}`);
      }
    } catch (err) {
      logWarn(`[${base}] [fail] ${v.alias || v.name || v.realName}: ${err?.message || err}`);
      progress.villains[key] = {
        status: 'failed',
        error: String(err?.message || err)
      };
      await saveJSON(progressPath, progress);
      // continue to next villain
    }
  }
}

// ---------- Anthropic helpers ----------

async function uploadPDF(pdfPath, metaOutPath) {
  const stat = await fsp.stat(pdfPath);
  const sizeMB = stat.size / (1024 * 1024);
  if (sizeMB > 32) {
    throw new Error(`PDF exceeds 32MB limit: ${sizeMB.toFixed(2)} MB`);
  }
  log(`[upload] ${pdfPath} (${sizeMB.toFixed(2)} MB)`);

  const file = await toFile(fs.createReadStream(pdfPath), path.basename(pdfPath), { type: 'application/pdf' });
  const res = await withRetries(async () =>
    anthropic.beta.files.upload({ file, betas: [FILES_BETA] }),
    { label: 'files.upload' }
  );

  const fileId = res?.id;
  if (!fileId) {
    throw new Error('Upload did not return a file id.');
  }
  await saveJSON(metaOutPath, { fileId, uploadedAt: new Date().toISOString(), path: pdfPath });
  log(`[upload] ok -> file_id: ${fileId}`);
  return fileId;
}

async function maybeReuseUpload(metaPath) {
  try {
    const meta = await loadJSONSafe(metaPath, null);
    if (!meta || !meta.fileId) return null;

    // Optionally, attempt a light-touch check; if not accessible, re-upload.
    try {
      await withRetries(async () =>
        anthropic.beta.files.get({ file_id: meta.fileId, betas: [FILES_BETA] }),
        { label: 'files.get' }
      );
      log(`[upload] reusing file_id: ${meta.fileId}`);
      return meta.fileId;
    } catch {
      log(`[upload] stored file_id invalid/expired; will re-upload.`);
      return null;
    }
  } catch {
    return null;
  }
}

async function planVillainCandidates(fileId, model) {
  const systemPrimer = getSystemPrimer();
  const planPrompt = [
    `You will analyze the attached PDF and list all adversary/villain NPCs.`,
    `Only include entities likely to be “villains” or opponents in play.`,
    `For each entry, return strictly JSON (no prose, no markdown) with this array shape:`,
    `[{`,
    `  "key": "stable-lowercase-kebab-unique-key",`,
    `  "alias": "Display name (villain name or moniker)",`,
    `  "realName": "Real name if known, else empty string",`,
    `  "pageApprox": 12,`,
    `  "shortHook": "1-2 sentences on what makes them an opponent"`,
    `}]`,
    ``,
    `Notes:`,
    `- Keep it concise; 1–50 entries is fine. Zero is acceptable only if truly none.`,
    `- key must be generated from alias/realName (kebab-case, a-z0-9-).`,
    `- shortHook should be informational but brief.`,
    ``,
    `Reference system (Masks: The New Generation) for context only:`,
    systemPrimer
  ].join('\n');

  const res = await withRetries(async () =>
    anthropic.beta.messages.create({
      model: model || DEFAULT_MODEL,
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: planPrompt },
            { type: 'document', source: { type: 'file', file_id: fileId } }
          ]
        }
      ],
      betas: [FILES_BETA]
    }),
    { label: 'messages.plan' }
  );

  const text = contentToText(res?.content);
  const json = safeJson(text);
  if (!Array.isArray(json)) {
    throw new Error('Planner did not return a JSON array of villains.');
  }

  // sanitize/normalize
  const dedup = new Map();
  for (const raw of json) {
    const alias = (raw?.alias || raw?.name || raw?.title || '').toString().trim();
    const realName = (raw?.realName || '').toString().trim();
    let key = (raw?.key || '').toString().trim();
    if (!key) key = slugify(alias || realName || randomId(8));
    if (!alias && !realName) continue;

    if (!dedup.has(key)) {
      dedup.set(key, {
        key,
        alias,
        realName,
        pageApprox: Number.isFinite(Number(raw?.pageApprox)) ? Number(raw.pageApprox) : null,
        shortHook: (raw?.shortHook || '').toString().trim()
      });
    }
  }

  return Array.from(dedup.values());
}

async function extractOneVillain(fileId, villain, model) {
  // Extract a single villain in a robust, bounded way.
  const systemPrimer = getSystemPrimer();
  const extractionPrompt = [
    `Extract ONE villain from the attached PDF: "${villain.alias || villain.realName || villain.key}".`,
    `If multiple, choose the best match by name/alias and context.`,
    ``,
    `Return STRICT JSON (no prose, no markdown) with this exact shape and keys:`,
    `{`,
    `  "alias": "string (villain name/moniker; if unknown, empty string)",`,
    `  "realName": "string (real name if known; else empty string)",`,
    `  "drive": "string (2–4 sentences on their motivation/drive; concise, in-world)",`,
    `  "abilities": "string (their powers/abilities/resources in Masks terms; 3–6 bullets or short lines, semicolon-separated)",`,
    `  "biography": "string (3–8 sentences: look, methods, history, relationships, what the GM should know)",`,
    `  "villainMoves": [`,
    `    { "name": "Title Case Move Name", "descriptionHtml": "<p>Mask-style GM/Villain move that adjusts spotlight, obstacles, or conditions.</p>" }`,
    `  ]`,
    `}`,
    ``,
    `Rules for "villainMoves":`,
    `- Provide 3 to 5 total.`,
    `- Each descriptionHtml must be valid HTML using <p>…</p>.`,
    `- Moves are flavorful and system-consistent: spotlight shifts, introduce obstacles, inflict a condition (player chooses), seize advantage, call reinforcements, escalate stakes, etc.`,
    `- No dice mechanics; pure GM-facing fictional levers.`,
    ``,
    `If not enough info exists, make plausible, setting-consistent inferences (clearly rooted in the villain’s theme).`,
    ``,
    `Context: Masks: The New Generation (PbtA).`,
    systemPrimer
  ].join('\n');

  const res = await withRetries(async () =>
    anthropic.beta.messages.create({
      model: model || DEFAULT_MODEL,
      max_tokens: 2800,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: extractionPrompt },
            { type: 'document', source: { type: 'file', file_id: fileId } }
          ]
        }
      ],
      betas: [FILES_BETA]
    }),
    { label: 'messages.extract' }
  );

  const text = contentToText(res?.content);
  const json = safeJson(text);
  if (!json || typeof json !== 'object') {
    throw new Error('Extractor did not return a JSON object.');
  }

  // Coerce & validate essentials
  const alias = (json.alias || villain.alias || '').toString().trim();
  const realName = (json.realName || villain.realName || '').toString().trim();
  let moves = Array.isArray(json.villainMoves) ? json.villainMoves : [];

  // Ensure 3–5 moves; if fewer, pad with generic system-consistent ones
  if (moves.length < 3) {
    moves = [...moves, ...fallbackMoves(alias || realName, json.abilities || '')];
  }
  if (moves.length > 5) moves = moves.slice(0, 5);

  // Normalize HTML & fields
  moves = moves.map((m) => ({
    name: (m?.name || 'Villain Move').toString().trim(),
    descriptionHtml: normalizeHtmlParagraph(m?.descriptionHtml || m?.description || '')
  }));

  return {
    alias,
    realName,
    drive: (json.drive || '').toString().trim(),
    abilities: (json.abilities || '').toString().trim(),
    biography: (json.biography || '').toString().trim(),
    villainMoves: moves
  };
}

// ---------- Build actor JSON from template ----------

async function loadExampleTemplate(examplePath) {
  const full = path.isAbsolute(examplePath) ? examplePath : path.resolve(process.cwd(), examplePath);
  const text = await fsp.readFile(full, 'utf8');
  const tpl = JSON.parse(text);
  // quick sanity
  if (!tpl || typeof tpl !== 'object' || tpl.type !== 'npc') {
    throw new Error(`example-npc.json at ${examplePath} does not look like a Masks NPC actor JSON`);
  }
  return tpl;
}

async function buildActorDocumentFromTemplate({ template, templateActorId, villain, keepActorName = false }) {
  // Deep clone the template to preserve exact structure
  const base = JSON.parse(JSON.stringify(template));

  // Decide display name: if strict, keep base.name; else use alias->realName
  if (!keepActorName) {
    const displayName = villain.alias || villain.realName || base.name || 'Villain';
    if (displayName) base.name = displayName;
  }

  // Fill required fields
  setPath(base, ['system', 'attributes', 'realName', 'value'], villain.realName || '');
  setPath(base, ['system', 'details', 'drive', 'value'], villain.drive || '');
  setPath(base, ['system', 'details', 'abilities', 'value'], villain.abilities || '');
  setPath(base, ['system', 'details', 'biography', 'value'], villain.biography || '');

  // Append 3–5 villain moves (npcMove) – we derive the item template from the example, if present.
  const itemTemplate = findAnyNpcMoveTemplate(base) || defaultNpcMoveItemTemplate();

  for (const mv of villain.villainMoves) {
    const item = JSON.parse(JSON.stringify(itemTemplate));
    item.name = mv.name || 'Villain Move';
    setPath(item, ['type'], 'npcMove');
    setPath(item, ['system', 'moveType'], 'villain');
    setPath(item, ['system', 'description'], normalizeHtmlParagraph(mv.descriptionHtml || mv.description || ''));
    // Unique 16‑char id per item
    item._id = gen16();
    // Keep other item fields from template (img/_stats/ownership/etc) intact for consistent shape
    base.items.push(item);
  }

  // Now assign a fresh actor ID and replace all occurrences of the old template ID (if any).
  const newId = gen16();
  base._id = newId;
  base._key = `!actors!${newId}`;

  // Ensure file/pack-friendly properties remain consistent
  // (We retain other fields exactly as in the template unless explicitly required to change.)

  // Perform robust replacement of the template actor ID everywhere in the serialized JSON
  let jsonText = JSON.stringify(base);
  if (templateActorId) {
    const re = new RegExp(escapeRegExp(templateActorId), 'g');
    jsonText = jsonText.replace(re, newId);
  }
  // Rehydrate final object after replacement
  const finalDoc = JSON.parse(jsonText);

  return finalDoc;
}

function findAnyNpcMoveTemplate(actorDoc) {
  if (!actorDoc?.items || !Array.isArray(actorDoc.items)) return null;
  // Prefer a villain move if present, else any npcMove
  let pick = actorDoc.items.find(i => i?.type === 'npcMove' && getPath(i, ['system', 'moveType']) === 'villain');
  if (!pick) pick = actorDoc.items.find(i => i?.type === 'npcMove');
  if (!pick) return null;

  // Strip volatile fields we’ll replace
  const clone = JSON.parse(JSON.stringify(pick));
  clone.name = 'Villain Move';
  setPath(clone, ['system', 'moveType'], 'villain');
  setPath(clone, ['system', 'description'], '<p></p>');
  clone._id = gen16(); // ensure a fresh base
  return clone;
}

function defaultNpcMoveItemTemplate() {
  return {
    name: 'Villain Move',
    type: 'npcMove',
    system: {
      moveType: 'villain',
      description: '<p></p>',
      rollFormula: '',
      moveResults: {
        failure: { key: 'system.moveResults.failure.value', label: 'Complications...', value: '' },
        partial: { key: 'system.moveResults.partial.value', label: 'Partial success', value: '' },
        success: { key: 'system.moveResults.success.value', label: 'Success!', value: '' }
      },
      uses: 0
    },
    _id: gen16(),
    img: 'icons/svg/aura.svg',
    effects: [],
    folder: null,
    sort: 0,
    flags: {},
    _stats: {
      compendiumSource: null,
      duplicateSource: null,
      exportSource: null,
      coreVersion: '13.350',
      systemId: 'pbta',
      systemVersion: '1.1.22',
      lastModifiedBy: null
    },
    ownership: { default: 0 }
  };
}

// ---------- Output ----------

async function writeActorFile(actorDoc, outDir) {
  await ensureDir(outDir);
  const safeName = (actorDoc?.name ? actorDoc.name : 'Villain')
    .replace(/[^a-zA-Z0-9А-я]/g, '_')
    .slice(0, 80);
  const fname = `npc_${safeName}_${actorDoc._id}.json`;
  const full = path.join(outDir, fname);
  await fsp.writeFile(full, JSON.stringify(actorDoc, null, 2), 'utf8');
  return full;
}

// ---------- Utilities ----------

function parseArgs(argv) {
  const res = {
    input: null,
    outDir: path.resolve(process.cwd(), 'src/packs/ported'),
    tempDir: path.resolve(process.cwd(), '.tmp/port-npcs'),
    example: path.resolve(process.cwd(), 'example-npc.json'),
    model: DEFAULT_MODEL,
    maxVillains: null,
    dryRun: false,
    strictActorName: false
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--input':
      case '-i':
        res.input = next; i++; break;
      case '--outDir':
      case '-o':
        res.outDir = path.resolve(process.cwd(), next); i++; break;
      case '--tempDir':
      case '-t':
        res.tempDir = path.resolve(process.cwd(), next); i++; break;
      case '--example':
      case '-e':
        res.example = path.resolve(process.cwd(), next); i++; break;
      case '--model':
      case '-m':
        res.model = next; i++; break;
      case '--maxVillains':
        res.maxVillains = Number(next); i++; break;
      case '--dryRun':
        res.dryRun = true; break;
      case '--strictActorName':
        res.strictActorName = true; break;
      default:
        // allow positional as input if not set
        if (!a.startsWith('-') && !res.input) res.input = a;
        break;
    }
  }
  return res;
}

async function enumerateInputs(input) {
  const full = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
  const stat = await fsp.stat(full);
  if (stat.isDirectory()) {
    const entries = await fsp.readdir(full);
    return entries
      .filter((f) => /\.pdf$/i.test(f))
      .map((f) => path.join(full, f));
  }
  if (/\.pdf$/i.test(full)) return [full];
  return [];
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}
function logWarn(msg) {
  console.warn(`[${ts()}] ${msg}`);
}
function logErr(msg) {
  console.error(`[${ts()}] ${msg}`);
}
function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function loadJSONSafe(file, fallback) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
async function saveJSON(file, data) {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

function slugify(s) {
  return (s || '')
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'entry';
}

function gen16() {
  // 16 chars from [A-Za-z0-9], consistent with your generate-uuids.mjs
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const rx = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += chars[rx[i] % chars.length];
  return out;
}

function randomId(n = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[(Math.random() * chars.length) | 0];
  return s;
}

function setPath(obj, pathArr, value) {
  let cur = obj;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const k = pathArr[i];
    if (!(k in cur) || typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[pathArr[pathArr.length - 1]] = value;
}

function getPath(obj, pathArr, dflt = undefined) {
  let cur = obj;
  for (const k of pathArr) {
    if (!cur || typeof cur !== 'object' || !(k in cur)) return dflt;
    cur = cur[k];
  }
  return cur;
}

function contentToText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (c?.type === 'text' && typeof c?.text === 'string') parts.push(c.text);
  }
  return parts.join('\n').trim();
}

function safeJson(text) {
  if (typeof text !== 'string') return null;
  // strip ``` fences if present
  let t = text.trim();
  t = t.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(t);
  } catch {
    // Attempt to salvage: find first {...} or [...]
    const firstBrace = t.indexOf('{');
    const firstBracket = t.indexOf('[');
    const start = (firstBrace === -1) ? firstBracket : (firstBracket === -1 ? firstBrace : Math.min(firstBrace, firstBracket));
    const lastBrace = t.lastIndexOf('}');
    const lastBracket = t.lastIndexOf(']');
    const end = (lastBrace === -1) ? lastBracket : (lastBracket === -1 ? lastBrace : Math.max(lastBrace, lastBracket));
    if (start >= 0 && end > start) {
      const possible = t.slice(start, end + 1);
      try { return JSON.parse(possible); } catch {}
    }
    return null;
  }
}

function normalizeHtmlParagraph(s) {
  const str = (s || '').toString().trim();
  if (!str) return '<p></p>';
  const isHtml = /<\/p>|<\/\w+>/.test(str) || /^<p>/i.test(str);
  if (isHtml) return str;
  // Convert \n\n into multiple <p> blocks
  const parts = str.split(/\n{2,}/).map(p => `<p>${escapeHtml(p.trim())}</p>`);
  return parts.join('');
}

function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Limited bounded exponential backoff with jitter
async function withRetries(fn, { label, maxAttempts = 8, baseDelayMs = 1000, maxDelayMs = 12000 } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = err?.status || err?.code || err?.name || '';
      const msg = err?.message || String(err);
      const retryable = isRetryable(err);

      logWarn(`[retry:${label}] attempt ${attempt + 1}/${maxAttempts} failed (${code}) ${msg}`);

      if (!retryable) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      // full jitter
      const jitter = Math.floor(Math.random() * delay * 0.4);
      const wait = delay - Math.floor(delay * 0.2) + jitter;
      await sleep(wait);
      attempt++;
    }
  }
  throw lastErr || new Error(`Request failed for ${label}`);
}

function isRetryable(err) {
  const status = err?.status || err?.code;
  const message = (err?.message || '').toLowerCase();
  if (status === 429) return true;
  if (status >= 500) return true;
  if (/rate/i.test(message)) return true;
  if (/timeout/i.test(message)) return true;
  if (/temporar/i.test(message)) return true;
  return false;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// ---------- System primer & fallback moves ----------

function getSystemPrimer() {
  return `
Masks is a Powered by the Apocalypse game about young superheroes. NPC "villain moves" are GM-facing levers—purely fictional consequences to shift spotlight, complicate scenes, threaten innocents, or inflict a condition (Afraid, Angry, Guilty, Hopeless, Insecure). They should read like: introduce an obstacle, separate them, take something away, reveal a dark future, call for reinforcements, demand a hard choice, etc. Avoid specific dice math—these moves are descriptive prompts the GM can fire.
`.trim();
}

function fallbackMoves(alias, abilities) {
  const name = alias || 'The Villain';
  const abilityHint = (abilities || '').split(/[;,•\n]/)[0]?.trim();
  const seed = [
    {
      name: 'Seize the Spotlight',
      descriptionHtml: `<p>${escapeHtml(name)} forces a dramatic shift—cut away from a hero's advantage and put them on the back foot. The table chooses who must act under pressure or <em>mark a condition</em> to keep control.</p>`
    },
    {
      name: 'Collateral Crescendo',
      descriptionHtml: `<p>Escalate environment danger linked to ${escapeHtml(abilityHint || 'their powers')}. Create a pressing obstacle or sacrifice; if ignored, an innocent is imperiled and ${escapeHtml(name)} takes another Villain Move.</p>`
    },
    {
      name: 'Offer a Cruel Choice',
      descriptionHtml: `<p>Present two bad options: save someone or keep the lead; protect your image or your team. If they hesitate on-panel, ${escapeHtml(name)} advances their plan or a hero <em>marks a condition</em>.</p>`
    },
    {
      name: 'Turn Strength Against Them',
      descriptionHtml: `<p>Reflect a signature tactic back at its owner. The affected hero chooses: pull punches and give ground, or push through and <em>mark a condition</em>.</p>`
    },
    {
      name: 'Call Reinforcements',
      descriptionHtml: `<p>Minions, drones, or a dangerous ally arrive. Split the team or force someone to fight alone; if they regroup quickly, reveal a new complication tied to ${escapeHtml(name)}’s scheme.</p>`
    }
  ];
  return seed.slice(0, 3);
}

// ---------- END ----------
