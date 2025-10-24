#!/usr/bin/env node
/**
 * tools/port-pdfs-to-npcs.mjs
 * ---------------------------------------------------------------------------
 * Port villains/NPCs from one or more PDFs into Masks: The New Generation NPC
 * JSONs that adhere exactly to your example schema.
 *
 * Provider: OpenRouter (Gemini 2.5 Pro)
 *   - Set OPENROUTER_API_KEY in your environment.
 *   - Uses OpenAI-compatible Chat Completions endpoint.
 *
 * What this script does:
 *   1) Loads ./example-npc.json (root) as the canonical template.
 *   2) Finds all PDFs from --input (files and/or directories).
 *   3) Extracts text from each PDF (prefers pdf-parse if available, otherwise a
 *      lightweight built-in fallback extractor).
 *   4) Splits text into manageable chunks and asks Gemini 2.5 Pro (via
 *      OpenRouter) to return STRICT JSON { "npcs": [...] } for each chunk.
 *   5) Merges & de-duplicates NPCs across chunks.
 *   6) For each NPC, clones the template, replaces ALL _id values with fresh
 *      16-char alphanumerics, fills ONLY the allowed fields:
 *         - system.attributes.realName.value
 *         - system.details.drive.value
 *         - system.details.abilities.value
 *         - system.details.biography.value
 *      and appends 3–5 custom villain moves (type: "npcMove", moveType: "villain").
 *   7) Writes results to src/packs/ported as:
 *         npc_<SafeName>_<ACTOR_ID>.json
 *
 * Robustness:
 *   • Handles 429/5xx with bounded backoff + jitter; honors Retry-After.
 *   • Per-request timeouts; no infinite loops/deadlocks.
 *   • Continues even if some chunks or NPCs fail.
 *   • Optional --debug saves raw model replies to ./debug
 *
 * Usage:
 *   node tools/port-pdfs-to-npcs.mjs \
 *     --input ./raw-assets/Adversaries.pdf ./raw-assets \
 *     [--output ./src/packs/ported] \
 *     [--concurrency 2] \
 *     [--chunkChars 12000] [--chunkOverlap 600] \
 *     [--minMoves 3] [--maxMoves 5] \
 *     [--renameActor true] \
 *     [--timeoutMs 120000] [--maxRetries 6] \
 *     [--debug]
 *
 * Requires: Node 18+ (for global fetch) and OPENROUTER_API_KEY env var.
 * Optional: pdf-parse (npm i pdf-parse) for higher-quality text extraction.
 * ---------------------------------------------------------------------------
 */

import 'dotenv/config';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

/* ------------------------------ CLI & Config ------------------------------ */

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    input: [],
    output: './src/packs/ported',
    model: 'google/gemini-2.5-pro',
    concurrency: 2,
    chunkChars: 12000,     // conservative per-chunk char budget
    chunkOverlap: 600,     // overlap between chunks to avoid fencepost splits
    minMoves: 3,
    maxMoves: 5,
    renameActor: true,
    timeoutMs: 120000,
    maxRetries: 6,
    debug: false
  };
  let key = null;
  for (const tok of argv) {
    if (tok.startsWith('--')) { key = tok.slice(2); out[key] ??= true; }
    else if (key) {
      let v = tok;
      if (/^\d+$/.test(v)) v = parseInt(v, 10);
      if (v === 'true') v = true;
      if (v === 'false') v = false;
      out[key] = v;
      key = null;
    } else {
      out.input.push(tok);
    }
  }
  if (typeof out.input === 'string') out.input = [out.input];
  out.concurrency = Math.max(1, Number(out.concurrency));
  out.minMoves = Math.max(3, Number(out.minMoves));
  out.maxMoves = Math.max(out.minMoves, Number(out.maxMoves));
  out.chunkChars = Math.max(2000, Number(out.chunkChars));
  out.chunkOverlap = Math.max(0, Math.min(2000, Number(out.chunkOverlap)));
  out.timeoutMs = Math.max(10_000, Number(out.timeoutMs));
  out.maxRetries = Math.max(0, Number(out.maxRetries));
  out.renameActor = String(out.renameActor).toLowerCase() !== 'false';
  out.debug = Boolean(out.debug);
  return out;
}

const ARGS = parseArgs();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
if (!OPENROUTER_API_KEY) {
  console.error('❌ OPENROUTER_API_KEY is not set. Export it and rerun.');
  process.exit(1);
}

/* ------------------------------ Paths & Setup ----------------------------- */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CWD = process.cwd();

const TEMPLATE_PATH = path.resolve(CWD, 'example-npc.json');
const OUTPUT_DIR = path.resolve(CWD, ARGS.output);
const DEBUG_DIR = path.resolve(CWD, 'debug');

async function ensureDir(p) { await fsp.mkdir(p, { recursive: true }); }
function ts() { return new Date().toISOString(); }

/* ----------------------------- Helper Functions --------------------------- */

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function generate16CharUUID() {
  const bytes = randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += ALNUM[bytes[i] % ALNUM.length];
  return s;
}

function safeName(s) {
  return String(s || 'Villain')
    .replace(/[^a-zA-Z0-9А-я]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'Villain';
}

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function sanitizeToHtmlParas(text) {
  if (text == null) return '';
  const safe = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return safe
    .split(/\n{2,}/g)
    .map(para => `<p>${para.replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function backoffDelayMs(attempt) {
  const base = Math.min(30_000, 1000 * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 1000);
  return base + jitter;
}

function isRateLimited(status) {
  return status === 429;
}

function isRetriableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function parseRetryAfter(headers) {
  const h = headers.get('retry-after');
  if (!h) return null;
  const s = parseInt(h, 10);
  return Number.isFinite(s) ? s * 1000 : null;
}

async function withTimeoutAndAbort(fn, timeoutMs, label) {
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fn(ctrl.signal);
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`Timeout after ${timeoutMs}ms for ${label}`);
    throw e;
  } finally {
    clearTimeout(killer);
  }
}

/* ------------------------------ OpenRouter Call --------------------------- */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

async function openRouterJSONChat({ model, messages, timeoutMs, maxRetries, label }) {
  let attempt = 0;
  let lastErr = null;

  while (attempt <= maxRetries) {
    attempt++;
    try {
      const res = await withTimeoutAndAbort(async (signal) => {
        const r = await fetch(OPENROUTER_URL, {
          method: 'POST',
          signal,
          headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'http://localhost',         // optional, rankings
            'X-Title': 'Masks NPC Porter'               // optional, rankings
          },
          body: JSON.stringify({
            model,
            response_format: { type: 'json_object' },
            temperature: 0.2,
            messages
          })
        });
        return r;
      }, timeoutMs, label || 'openrouter request');

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`OpenRouter HTTP ${res.status} ${res.statusText} — ${text.slice(0, 300)}`);
        if (isRetriableStatus(res.status) && attempt <= maxRetries) {
          const retryAfter = parseRetryAfter(res.headers);
          const delay = retryAfter ?? backoffDelayMs(attempt);
          console.warn(`   ⚠️  ${label || 'request'} attempt ${attempt} failed (HTTP ${res.status}). Retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }
        throw err;
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content ?? '';
      if (typeof content === 'string' && content.trim()) {
        // Ideal: already pure JSON string
        try { return JSON.parse(content); } catch { /* salvage below */ }
        // Try fenced block
        const fence = content.match(/```json\s*([\s\S]*?)\s*```/i) || content.match(/```\s*([\s\S]*?)\s*```/i);
        if (fence) {
          try { return JSON.parse(fence[1]); } catch { /* continue */ }
        }
        // Try trimming trailing commas
        try {
          const fixed = content.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
          return JSON.parse(fixed);
        } catch { /* fallthrough */ }
      } else if (Array.isArray(content)) {
        // Some providers may return an array of parts; concatenate text parts
        const joined = content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('\n');
        try { return JSON.parse(joined); } catch { /* salvage below */ }
        const fence = joined.match(/```json\s*([\s\S]*?)\s*```/i) || joined.match(/```\s*([\s\S]*?)\s*```/i);
        if (fence) {
          try { return JSON.parse(fence[1]); } catch { /* noop */ }
        }
      }

      throw new Error('Model response did not contain parseable JSON.');
    } catch (err) {
      lastErr = err;
      if (attempt > maxRetries) break;
      // Fallback delay for network/parse errors
      const delay = backoffDelayMs(attempt);
      console.warn(`   ⚠️  ${label || 'request'} attempt ${attempt} error: ${err.message}. Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw lastErr || new Error('OpenRouter call failed after retries.');
}

/* ------------------------------ PDF Extraction ---------------------------- */

async function extractPdfText(pdfPath) {
  // Prefer pdf-parse if installed (best quality)
  try {
    const maybe = await import('pdf-parse').catch(() => null);
    if (maybe?.default) {
      const buffer = await fsp.readFile(pdfPath);
      const data = await maybe.default(buffer);
      if (data?.text && data.text.trim().length > 0) return data.text;
    }
  } catch (e) {
    console.warn(`   ⚠️  pdf-parse failed for ${path.basename(pdfPath)}: ${e.message}`);
  }
  // Lightweight fallback parser (not perfect, but works for simple PDFs)
  return await fallbackExtractPdfText(pdfPath);
}

async function fallbackExtractPdfText(pdfPath, maxBytes = 5_000_000) {
  const fd = await fsp.open(pdfPath, 'r');
  const { size } = await fd.stat();
  const readSize = Math.min(size, maxBytes);
  const buf = Buffer.alloc(readSize);
  await fd.read(buf, 0, readSize, 0);
  await fd.close();

  const raw = buf.toString('latin1');
  const textish = raw.match(/\(([^)\\]*(?:\\.[^)\\]*)*)\)/g) || [];
  const joined = textish.map(s => s.slice(1, -1)).join('\n');
  return joined.replace(/[^ -~\n\r\t]+/g, ' ').replace(/\s{3,}/g, ' ');
}

/* -------------------------- Chunking & Merging ---------------------------- */

function splitTextIntoChunks(text, maxChars, overlap) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + maxChars);
    const slice = text.slice(i, end);
    chunks.push(slice);
    if (end >= text.length) break;
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks;
}

function normalizeKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeNpcArrays(npcsArrays) {
  const map = new Map();
  for (const arr of npcsArrays) {
    if (!Array.isArray(arr)) continue;
    for (const n of arr) {
      if (!n) continue;
      const key =
        normalizeKey(n.alias) ||
        normalizeKey(n.realName) ||
        normalizeKey(n.name) ||
        `npc-${map.size + 1}`;
      const existing = map.get(key) || {
        alias: n.alias || n.name || 'Villain',
        realName: n.realName || n.alias || 'Unknown',
        generation: n.generation || '',
        drive: '',
        abilities: '',
        biography: '',
        villainMoves: []
      };

      // Prefer non-empty fields
      for (const field of ['drive', 'abilities', 'biography', 'generation']) {
        if ((!existing[field] || existing[field].length < (n[field]?.length || 0)) && n[field]) {
          existing[field] = n[field];
        }
      }

      // Merge moves by name uniqueness
      const seen = new Set(existing.villainMoves.map(m => normalizeKey(m?.name)));
      for (const mv of Array.isArray(n.villainMoves) ? n.villainMoves : []) {
        const k = normalizeKey(mv?.name);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        existing.villainMoves.push({ name: mv.name, description: mv.description });
      }

      map.set(key, existing);
    }
  }
  return Array.from(map.values());
}

/* -------------------------- Prompt Construction --------------------------- */

const SYSTEM_PROMPT = [
  'You are converting adversaries/villains from another TTRPG PDF into NPCs for "Masks: The New Generation" (PbtA).',
  'Rules:',
  '• Write in Masks tone; use narrative consequences (conditions, Influence, collateral damage, separation, etc.).',
  '• No numbers/HP from other systems; no copyrighted rules text—rephrase to Masks concepts.',
  '• For THIS CHUNK ONLY, return STRICT JSON of this form:',
  '{ "npcs": [ { "alias": "...", "realName": "Unknown or Name", "generation": "(optional short era)", "drive": "1–3 sentences", "abilities": "2–5 sentences", "biography": "3–8 sentences", "villainMoves": [ { "name": "move name", "description": "1–3 sentences, GM-facing" } ] } ] }',
  '• Include only villains/NPCs; ignore rules, PCs, locations unless an NPC.',
  `• 3–5 custom "villainMoves" per NPC.`
].join('\n');

function userPromptForChunk(pdfName, index, total) {
  return [
    `Source PDF: ${pdfName}`,
    `Chunk ${index + 1} of ${total}. Extract all DISTINCT villains/NPCs present in this chunk.`,
    'Return ONLY strict JSON for the schema above; no extra commentary.',
  ].join('\n');
}

/* ---------------------- Example Template Manipulation ---------------------- */

let TEMPLATE = null;
try {
  const raw = await fsp.readFile(TEMPLATE_PATH, 'utf8');
  TEMPLATE = JSON.parse(raw);
} catch (e) {
  console.error(`❌ Could not read "${TEMPLATE_PATH}". Ensure example-npc.json is at repo root.`);
  console.error(e.message || e);
  process.exit(1);
}

function findVillainBaselineItem() {
  if (Array.isArray(TEMPLATE.items)) {
    const byVillain = TEMPLATE.items.find(i => i?.type === 'npcMove' && i?.system?.moveType === 'villain');
    if (byVillain) return deepClone(byVillain);
    const anyNpcMove = TEMPLATE.items.find(i => i?.type === 'npcMove');
    if (anyNpcMove) {
      const c = deepClone(anyNpcMove);
      c.system = c.system || {};
      c.system.moveType = 'villain';
      return c;
    }
  }
  // synthesized minimal baseline
  return {
    name: 'Villain Move',
    type: 'npcMove',
    system: {
      moveType: 'villain',
      description: '<p>Make a Villain Move that shifts spotlight or inflicts a condition (player’s choice).</p>',
      rollFormula: '',
      moveResults: {
        failure: { key: 'system.moveResults.failure.value', label: 'Complications...', value: '' },
        partial: { key: 'system.moveResults.partial.value', label: 'Partial success', value: '' },
        success: { key: 'system.moveResults.success.value', label: 'Success!', value: '' }
      },
      uses: 0
    },
    img: 'icons/svg/aura.svg',
    effects: [],
    folder: null,
    sort: 0,
    flags: {},
    _stats: { systemId: 'pbta', systemVersion: '1.1.22' },
    ownership: { default: 0 }
  };
}

const VILLAIN_BASELINE = findVillainBaselineItem();

function mintIdAndMaybeKey(doc, typeHint /* 'actors' or 'items' */) {
  const id = generate16CharUUID();
  doc._id = id;
  if (doc._key && typeof doc._key === 'string') {
    // attempt to preserve existing pattern
    if (/!actors!/.test(doc._key) || typeHint === 'actors') doc._key = `!actors!${id}`;
    else if (/!items!/.test(doc._key) || typeHint === 'items') doc._key = `!items!${id}`;
    else doc._key = `!items!${id}`; // fallback
  }
}

function createVillainItemFromBaseline(name, description) {
  const it = deepClone(VILLAIN_BASELINE);
  it.name = name || 'Villain Move';
  it.type = 'npcMove';
  it.system = it.system || {};
  it.system.moveType = 'villain';
  it.system.description = sanitizeToHtmlParas(description || 'Escalate the threat with narrative consequences.');
  it.img = it.img || 'icons/svg/aura.svg';
  mintIdAndMaybeKey(it, 'items');
  return it;
}

function actorFromNPC(npc) {
  const actor = deepClone(TEMPLATE);

  // Rename actor if requested
  if (ARGS.renameActor) {
    actor.name = npc.alias || npc.name || 'Villain';
    if (actor.prototypeToken) actor.prototypeToken.name = actor.name;
  }

  // Ensure structure exists
  actor.system = actor.system || {};
  actor.system.attributes = actor.system.attributes || {};
  actor.system.details = actor.system.details || {};

  // Fill allowed fields only
  actor.system.attributes.realName = actor.system.attributes.realName || {
    label: 'Real Name',
    type: 'Text',
    value: '',
    position: 'Left'
  };
  actor.system.attributes.realName.value = String(npc.realName || npc.alias || 'Unknown');

  actor.system.details.drive = actor.system.details.drive || { label: 'Drive', value: '' };
  actor.system.details.abilities = actor.system.details.abilities || { label: 'Abilities', value: '' };
  actor.system.details.biography = actor.system.details.biography || { label: 'Notes', value: '' };

  actor.system.details.drive.value = sanitizeToHtmlParas(npc.drive || '');
  actor.system.details.abilities.value = sanitizeToHtmlParas(npc.abilities || '');
  actor.system.details.biography.value = sanitizeToHtmlParas(npc.biography || '');

  // Optional: generation (if present in template)
  if (npc.generation) {
    actor.system.attributes.generation = actor.system.attributes.generation || {
      label: 'Generation',
      type: 'Text',
      value: '',
      position: 'Left'
    };
    actor.system.attributes.generation.value = String(npc.generation);
  }

  // Ensure items array exists
  actor.items = Array.isArray(actor.items) ? actor.items : [];

  // Append 3–5 villain moves
  const vms = Array.isArray(npc.villainMoves) ? npc.villainMoves.slice(0, ARGS.maxMoves) : [];
  while (vms.length < ARGS.minMoves) {
    vms.push({
      name: 'Escalate the Threat',
      description: 'Separate someone, endanger an innocent, or force a hard choice; someone marks a condition or gives up position.'
    });
  }
  for (const mv of vms) {
    if (!mv?.name || !mv?.description) continue;
    actor.items.push(createVillainItemFromBaseline(mv.name, mv.description));
  }

  // Mint fresh ids for actor and existing items from template
  if (Array.isArray(actor.items)) {
    for (const it of actor.items) {
      if (!it._id || it._id.length !== 16) {
        // already minted newly appended moves; also re-mint any pre-existing template items
        mintIdAndMaybeKey(it, 'items');
      }
    }
  }
  mintIdAndMaybeKey(actor, 'actors');

  return actor;
}

/* ------------------------------ I/O: PDFs --------------------------------- */

async function findPdfFiles(inputs) {
  const out = [];
  for (const p of inputs) {
    const abs = path.resolve(CWD, p);
    if (!fs.existsSync(abs)) continue;
    const st = await fsp.stat(abs);
    if (st.isDirectory()) {
      const entries = await fsp.readdir(abs);
      for (const e of entries) {
        const ap = path.join(abs, e);
        if (ap.toLowerCase().endsWith('.pdf')) out.push(ap);
      }
    } else if (abs.toLowerCase().endsWith('.pdf')) {
      out.push(abs);
    }
  }
  return out;
}

/* ------------------------------ Worker Flow ------------------------------- */

async function processPdf(pdfPath) {
  const base = path.basename(pdfPath);
  console.log(`\n📄 Processing PDF: ${base}`);

  // 1) Extract text
  let text = '';
  try {
    text = await extractPdfText(pdfPath);
  } catch (e) {
    console.warn(`   ⚠️  Failed to extract text: ${e.message}`);
  }

  if (!text || text.trim().length < 40) {
    console.warn('   ⚠️  PDF text seems empty or too short; skipping.');
    return { pdf: base, count: 0 };
  }

  // 2) Chunk
  const chunks = splitTextIntoChunks(text, ARGS.chunkChars, ARGS.chunkOverlap);
  console.log(`   ↳ ${chunks.length} text chunk(s) for model ingestion`);

  // 3) Model calls per chunk
  const perChunkPromises = chunks.map((chunk, idx) =>
    openRouterJSONChat({
      model: ARGS.model,
      timeoutMs: ARGS.timeoutMs,
      maxRetries: ARGS.maxRetries,
      label: `extract NPCs (chunk ${idx + 1}/${chunks.length})`,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: userPromptForChunk(base, idx, chunks.length) },
            { type: 'text', text: chunk }
          ]
        }
      ]
    }).then(
      (json) => {
        if (ARGS.debug) {
          return saveDebug(json, `${base}.chunk-${idx + 1}.json`).then(() => json);
        }
        return json;
      },
      (err) => {
        console.warn(`   ⚠️  Chunk ${idx + 1} failed: ${err.message}`);
        return { npcs: [] }; // continue
      }
    )
  );

  const results = await Promise.all(perChunkPromises);
  const npcsArrays = results.map(r => Array.isArray(r?.npcs) ? r.npcs : []);
  let merged = mergeNpcArrays(npcsArrays);

  if (merged.length === 0) {
    console.warn(`   ⚠️  No NPCs parsed from ${base}.`);
    return { pdf: base, count: 0 };
  }

  // Normalize + clamp move counts
  merged = merged.map(n => {
    const out = {
      alias: String(n.alias || n.name || 'Villain'),
      realName: String(n.realName || n.alias || 'Unknown'),
      generation: n.generation ? String(n.generation) : '',
      drive: String(n.drive || ''),
      abilities: String(n.abilities || ''),
      biography: String(n.biography || ''),
      villainMoves: Array.isArray(n.villainMoves) ? n.villainMoves : []
    };
    // Ensure 3–5 moves per NPC
    while (out.villainMoves.length < ARGS.minMoves) {
      out.villainMoves.push({
        name: 'Complication',
        description: 'Introduce a new obstacle, escalate a countdown, or threaten collateral damage; someone marks a condition or yields ground.'
      });
    }
    out.villainMoves = out.villainMoves.slice(0, ARGS.maxMoves);
    return out;
  });

  // 4) Build Actors and write files
  await ensureDir(OUTPUT_DIR);
  let ok = 0;
  for (const [i, npc] of merged.entries()) {
    try {
      const actor = actorFromNPC(npc);
      const file = `npc_${safeName(actor.name)}_${actor._id}.json`;
      const outPath = path.join(OUTPUT_DIR, file);
      await fsp.writeFile(outPath, JSON.stringify(actor, null, 2), 'utf8');
      console.log(`   ✓ NPC ${i + 1}/${merged.length}: ${actor.name} -> ${path.relative(CWD, outPath)}`);
      ok++;
    } catch (e) {
      console.warn(`   ⚠️  Failed to write NPC ${i + 1}: ${e.message}`);
    }
  }

  console.log(`   ↳ Completed ${base}: ${ok} succeeded, ${merged.length - ok} failed.`);
  return { pdf: base, count: ok };
}

async function saveDebug(obj, filename) {
  try {
    await ensureDir(DEBUG_DIR);
    const p = path.join(DEBUG_DIR, filename);
    await fsp.writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

/* ---------------------------- Concurrency Queue --------------------------- */

function makeQueue(limit) {
  const waiters = [];
  let active = 0;
  return async function run(task) {
    if (active >= limit) await new Promise(res => waiters.push(res));
    active++;
    try {
      return await task();
    } finally {
      active--;
      const next = waiters.shift();
      if (next) next();
    }
  };
}

/* ---------------------------------- Main ---------------------------------- */

async function main() {
  // Banner
  console.log(`\n=== Masks NPC Porter (OpenRouter · Gemini 2.5 Pro) ===`);
  console.log(`Input:        ${ARGS.input.map(p => path.resolve(CWD, p)).join(' ')}`);
  console.log(`Output:       ${path.relative(CWD, OUTPUT_DIR)}`);
  console.log(`Foundry v13 packs path expected.`);
  console.log(`Model:        ${ARGS.model}`);
  console.log(`Concurrency:  ${ARGS.concurrency}`);
  console.log(`Chunking:     ${ARGS.chunkChars} chars / ${ARGS.chunkOverlap} overlap`);
  console.log(`Moves/NPC:    ${ARGS.minMoves}–${ARGS.maxMoves}`);
  console.log(`Rename Actor: ${ARGS.renameActor}`);
  console.log(`Start:        ${ts()}\n`);

  // Load PDFs
  const pdfs = await findPdfFiles(ARGS.input);
  console.log(`Found PDFs:   ${pdfs.length}`);
  if (pdfs.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const run = makeQueue(ARGS.concurrency);
  const tasks = pdfs.map((pdf) =>
    run(async () => {
      try {
        return await processPdf(pdf);
      } catch (e) {
        console.warn(`⚠️  Worker error for ${path.basename(pdf)}: ${e.message}`);
        return { pdf: path.basename(pdf), count: 0 };
      }
    })
  );

  const done = await Promise.all(tasks);
  const total = done.reduce((a, r) => a + (r?.count || 0), 0);
  console.log(`\nAll done. Created ${total} NPC${total === 1 ? '' : 's'}. Finished at: ${ts()}\n`);
}

main().catch(err => {
  console.error(`\n❌ Fatal: ${err?.stack || err?.message || String(err)}\n`);
  process.exit(1);
});
