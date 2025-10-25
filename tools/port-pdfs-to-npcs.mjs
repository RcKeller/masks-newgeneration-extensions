#!/usr/bin/env node
/**
 * tools/port-pdfs-to-npcs.mjs
 * -----------------------------------------------------------------------------
 * Port villains/NPCs from one or more PDFs into Masks: The New Generation NPC
 * JSONs that adhere exactly to your example schema — and ONLY add:
 *   • 3–5 custom VILLAIN moves
 *   • 5 CONDITION moves (one each: Afraid, Angry, Guilty, Hopeless, Insecure)
 *
 * Provider: OpenRouter (Gemini 2.5 Pro)
 *   - Set OPENROUTER_API_KEY in your environment.
 *   - Uses OpenAI-compatible Chat Completions endpoint with JSON-only responses.
 *
 * Fixes vs previous version:
 *   ✓ Never copy the example NPC’s (Sauceror) moves anymore.
 *   ✓ We build the items array from scratch: 3–5 villain moves + 5 condition moves.
 *   ✓ We ALWAYS mint fresh 16‑char IDs for the ACTOR and for EVERY ITEM.
 *   ✓ Strict model contract now requires a `conditionMoves` object (Afraid/Angry/…).
 *   ✓ Strong post-parse validation & auto-synthesis if the model under-fills anything.
 *   ✓ Robust rate-limit handling (429 & 5xx), bounded retries, no infinite loops.
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
 * Requires: Node 18+ and OPENROUTER_API_KEY env var.
 * Optional: npm i pdf-parse  (for higher-quality text extraction)
 * -----------------------------------------------------------------------------
 */

import 'dotenv/config';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

/* -------------------------------- CLI & Config ---------------------------- */

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    input: [],
    output: './src/packs/ported',
    model: 'google/gemini-2.5-pro',
    concurrency: 2,
    chunkChars: 12000,
    chunkOverlap: 600,
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

/* -------------------------------- Paths ----------------------------------- */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CWD = process.cwd();

const TEMPLATE_PATH = path.resolve(CWD, 'example-npc.json'); // canonical example (Sauceror)
const OUTPUT_DIR = path.resolve(CWD, ARGS.output);
const DEBUG_DIR = path.resolve(CWD, 'debug');

async function ensureDir(p) { await fsp.mkdir(p, { recursive: true }); }
function nowIso() { return new Date().toISOString(); }

/* ------------------------------- Utilities -------------------------------- */

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function generate16CharUUID() {
  const bytes = randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += ALNUM[bytes[i] % ALNUM.length];
  return s;
}

function safeName(s) {
  return String(s || 'Villain').replace(/[^a-zA-Z0-9А-я]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'Villain';
}

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function sanitizeToHtmlParas(text) {
  if (text == null) return '';
  const safe = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return safe.split(/\n{2,}/g).map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function backoffDelayMs(attempt) {
  const base = Math.min(30_000, 1000 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 1000);
}

function titleCase(s) {
  return String(s || '').replace(/\b\w+/g, t => t[0]?.toUpperCase() + t.slice(1));
}

/* ------------------------- OpenRouter JSON Chat ---------------------------- */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function isRetriableStatus(code) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(code);
}
function parseRetryAfter(headers) {
  const h = headers.get('retry-after');
  const s = h ? parseInt(h, 10) : NaN;
  return Number.isFinite(s) ? s * 1000 : null;
}

async function openRouterJSONChat({ model, messages, timeoutMs, maxRetries, label }) {
  let attempt = 0;
  let lastErr = null;

  while (attempt <= maxRetries) {
    attempt++;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost',
          'X-Title': 'Masks NPC Porter'
        },
        body: JSON.stringify({
          model,
          response_format: { type: 'json_object' },
          temperature: 0.2,
          messages
        })
      }).finally(() => clearTimeout(timer));

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (isRetriableStatus(res.status) && attempt <= maxRetries) {
          const retryAfter = parseRetryAfter(res.headers) ?? backoffDelayMs(attempt);
          console.warn(`   ⚠️  ${label} attempt ${attempt} failed (HTTP ${res.status}). Retrying in ${retryAfter}ms...`);
          await sleep(retryAfter);
          continue;
        }
        throw new Error(`OpenRouter HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      // Model is instructed to return a JSON string; handle string or object
      if (typeof content === 'string') {
        try { return JSON.parse(content); } catch { /* try fences below */ }
        const m = content.match(/```json\s*([\s\S]*?)\s*```/i) || content.match(/```\s*([\s\S]*?)\s*```/i);
        if (m) return JSON.parse(m[1]);
        // try trailing comma fix
        return JSON.parse(content.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'));
      } else if (content && typeof content === 'object') {
        return content; // already parsed by provider
      }
      throw new Error('Model response did not contain parseable JSON.');
    } catch (err) {
      lastErr = err;
      if (attempt > maxRetries) break;
      const delay = backoffDelayMs(attempt);
      console.warn(`   ⚠️  ${label} attempt ${attempt} error: ${err.message}. Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
  throw lastErr || new Error('OpenRouter call failed after retries.');
}

/* ------------------------------ PDF Extraction ---------------------------- */

async function extractPdfText(pdfPath) {
  try {
    const maybe = await import('pdf-parse').catch(() => null);
    if (maybe?.default) {
      const buf = await fsp.readFile(pdfPath);
      const data = await maybe.default(buf);
      if (data?.text?.trim()) return data.text;
    }
  } catch (e) {
    console.warn(`   ⚠️  pdf-parse failed for ${path.basename(pdfPath)}: ${e.message}`);
  }
  return fallbackExtractPdfText(pdfPath);
}

// very lightweight fallback for simple PDFs
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

/* -------------------------- Chunking & Discovery -------------------------- */

function splitTextIntoChunks(text, maxChars, overlap) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + maxChars);
    chunks.push(text.slice(i, end));
    if (end >= text.length) break;
    i = Math.max(0, end - overlap);
  }
  return chunks;
}

function normalizeKey(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/* ---------------------------- Template Loading ---------------------------- */

let TEMPLATE = null;
try {
  const raw = await fsp.readFile(TEMPLATE_PATH, 'utf8');
  TEMPLATE = JSON.parse(raw);
} catch (e) {
  console.error(`❌ Could not read "${TEMPLATE_PATH}". Place example-npc.json at repo root.`);
  process.exit(1);
}

function minimalMoveSkeleton(moveType = 'villain') {
  return {
    name: moveType === 'villain' ? 'Villain Move' : 'Condition Move',
    type: 'npcMove',
    system: {
      moveType,
      description: '<p>GM-facing narrative effect.</p>',
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
    _stats: {
      coreVersion: TEMPLATE?._stats?.coreVersion ?? '13.350',
      systemId: TEMPLATE?._stats?.systemId ?? 'pbta',
      systemVersion: TEMPLATE?._stats?.systemVersion ?? '1.1.22',
      lastModifiedBy: TEMPLATE?._stats?.lastModifiedBy ?? null
    },
    ownership: { default: 0 }
  };
}

const VILLAIN_BASELINE = (() => {
  const fromTemplate = Array.isArray(TEMPLATE.items) && TEMPLATE.items.find(i => i?.type === 'npcMove' && i?.system?.moveType === 'villain');
  return fromTemplate ? deepClone(fromTemplate) : minimalMoveSkeleton('villain');
})();

const CONDITION_BASELINE = minimalMoveSkeleton('condition');

/* --------------------- Model Prompts & Output Contract -------------------- */

const SYSTEM_PROMPT = [
  'You convert villains from a source PDF into Masks: The New Generation NPCs.',
  'STRICT contract for EACH chunk:',
  'Return ONLY JSON (no prose) with this shape:',
  '{',
  '  "npcs": [',
  '    {',
  '      "alias": "string",',
  '      "realName": "string | Unknown",',
  '      "generation": "short optional era string",',
  '      "drive": "1–3 sentences (Masks-style)",',
  '      "abilities": "2–5 sentences (Masks-style)",',
  '      "biography": "3–8 sentences (Masks-style)",',
  '      "villainMoves": [',
  '        { "name": "short name", "description": "1–3 sentences; GM-facing; use Masks consequences (mark a condition, separate, shift Labels, take Influence, reduce Team, introduce collateral damage, escalate countdown)" }',
  '      ],',
  '      "conditionMoves": {',
  '        "Afraid":  { "name": "short name", "description": "1–3 sentences; how they lash out when Afraid"  },',
  '        "Angry":   { "name": "short name", "description": "1–3 sentences; how they lash out when Angry"   },',
  '        "Guilty":  { "name": "short name", "description": "1–3 sentences; how they lash out when Guilty"  },',
  '        "Hopeless":{ "name": "short name", "description": "1–3 sentences; how they lash out when Hopeless"},',
  '        "Insecure":{ "name": "short name", "description": "1–3 sentences; how they lash out when Insecure"}',
  '      }',
  '    }',
  '  ]',
  '}',
  'Rules:',
  '• 3–5 villainMoves per NPC. Exactly the five conditionMoves keys above.',
  '• Do NOT copy text or lists from the PDF verbatim; paraphrase into Masks terms.',
  '• Do NOT output dice math or numeric damage; use Masks consequences.',
  '• Return valid JSON only.'
].join('\n');

function userPromptForChunk(pdfName, index, total) {
  return [
    `Source PDF: ${pdfName}`,
    `Chunk ${index + 1} of ${total}. Extract DISTINCT villains present in this chunk.`,
    'Return ONLY JSON for the contract above; no extra commentary.'
  ].join('\n');
}

/* ----------------------------- Post-Processing ---------------------------- */

function themeFromNPC(npc) {
  const basis = `${npc.alias || ''} ${npc.realName || ''} ${npc.abilities || ''} ${npc.drive || ''}`.toLowerCase();
  const picks = [];
  const addIf = (words, tag) => { if (words.some(w => basis.includes(w))) picks.push(tag); };
  addIf(['shadow','stealth','agent','operative','spy','black ops','a.e.g.i.s','soldier','protocol'], 'tactical');
  addIf(['fire','flame','heat','burn'], 'fire');
  addIf(['ice','cold','frost'], 'ice');
  addIf(['tech','drone','hack','ai','cyber'], 'tech');
  addIf(['magic','sorcer','witch','arcane','ritual'], 'arcane');
  addIf(['beast','claw','fang','animal'], 'feral');
  addIf(['telekin','mind','psy','psychic','emotion'], 'psychic');
  addIf(['time','future','past','chron'], 'time');
  if (!picks.length) picks.push('tactical');
  return picks.slice(0, 2);
}

function synthesizeConditionMoves(npc) {
  const tags = themeFromNPC(npc);
  const tag = tags[0];
  const pick = (options) => options[tag] || Object.values(options)[0];

  const byCond = {
    Afraid: {
      name: pick({
        tactical: 'Smoke & Withdraw',
        fire: 'Backdraft Barrier',
        ice: 'Frost Shell',
        tech: 'Adaptive Cloak',
        arcane: 'Warding Circle',
        feral: 'Low Stance Snarl',
        psychic: 'Mental Static',
        time: 'Slip Between Panels'
      }),
      description: pick({
        tactical: 'Fall back behind cover; separate a hero or buy time. Someone marks a condition or yields position.',
        fire: 'Erect a rolling wall of heat; approach requires braving the element or exposing vulnerability.',
        ice: 'Encase self in brittle frost; approaching hero risks marking a condition or losing footing.',
        tech: 'Engage active camo; force Assess or teamwork before re-engaging; spotlight shifts away.',
        arcane: 'Trace a ward that deflects bold advances; heroes must reveal vulnerability or truth to bypass.',
        feral: 'Circle warily and lash at reach; entering close range risks a powerful blow.',
        psychic: 'Flood the air with doubt; shift a Label or mark a condition to press on.',
        time: 'Phase to the gutter between panels; ignore them and they set up a worse threat off-screen.'
      })
    },
    Angry: {
      name: pick({
        tactical: 'Suppressive Fire',
        fire: 'Scorch the Floor',
        ice: 'Shattering Bite',
        tech: 'Overclock Barrage',
        arcane: 'Hex Lash',
        feral: 'Rake & Rush',
        psychic: 'Spike of Panic',
        time: 'Temporal Buckshot'
      }),
      description: pick({
        tactical: 'Spray the scene; reduce Team by 1 and force someone to choose: mark Angry or give ground.',
        fire: 'Blast hazard zones; crossing costs a condition or a prized position.',
        ice: 'Exploit weaknesses; on the next miss, immediately take a hard move.',
        tech: 'Dump ammo/energy; someone takes a powerful blow or the team abandons an asset.',
        arcane: 'Curse a hero’s confidence; they act at a cost until they prove you wrong.',
        feral: 'Bull through defenses; separate the most vocal hero from allies.',
        psychic: 'Overwhelm a hero; they must accept Influence or mark a condition to resist.',
        time: 'Split-second flurry; retroactively place them in a worse spot.'
      })
    },
    Guilty: {
      name: pick({
        tactical: 'Collateral Mitigation',
        fire: 'Ashen Apology',
        ice: 'Cold Compromise',
        tech: 'Patch & Pivot',
        arcane: 'Contrite Boon',
        feral: 'Pack Reproach',
        psychic: 'Remorseful Echo',
        time: 'Undo What You Can'
      }),
      description: pick({
        tactical: 'Stabilize a bystander or secure an exit; clear one of their conditions but open a new objective you must rush to stop.',
        fire: 'Dampen flames from civilians; a hero gains Influence over you if they accept your apology.',
        ice: 'Offer a brittle truce; if refused, you come back sharper next panel.',
        tech: 'Field-repair a harm you caused; give a hero a clear shot—but at collateral risk.',
        arcane: 'Grant a boon with a string attached; they may spend it to shift your Labels.',
        feral: 'Shield the weakest; expose flank while doing so.',
        psychic: 'Let a guilty thought slip; the team can exploit it to corner you.',
        time: 'Try to rewind fallout; paradox creates a fresh complication.'
      })
    },
    Hopeless: {
      name: pick({
        tactical: 'Abort to Objective',
        fire: 'Embers Fade',
        ice: 'Whiteout Retreat',
        tech: 'Hard Disconnect',
        arcane: 'Dim the Veil',
        feral: 'Lone Trail',
        psychic: 'Hollow Shell',
        time: 'Step Out of Scene'
      }),
      description: pick({
        tactical: 'Cut losses and advance the mission elsewhere; unless stopped immediately, you exit the scene.',
        fire: 'Let the blaze gutter; you vanish through heat haze; heroes must choose to pursue or save people.',
        ice: 'Snow squall blinds; you slip away between panels.',
        tech: 'Trigger a failsafe teleport/exfil; a hero must mark Hopeless to latch on.',
        arcane: 'Curtain of shadows falls; the next time they hesitate, you act again off-screen.',
        feral: 'Break contact; set a trap that will spring later if unaddressed.',
        psychic: 'Numb yourself; anyone trying to reach you must Comfort & Support amid danger.',
        time: 'Phase to a nearby page; you escape unless directly engaged right now.'
      })
    },
    Insecure: {
      name: pick({
        tactical: 'Overcorrect',
        fire: 'Flare Too Bright',
        ice: 'Brittle Pride',
        tech: 'Firmware Rollback',
        arcane: 'Frayed Sigil',
        feral: 'Show of Dominance',
        psychic: 'Second-Guess Spiral',
        time: 'Rewind the Win'
      }),
      description: pick({
        tactical: 'Reopen a resolved complication or bring back a rival; they return with at least 3 conditions marked.',
        fire: 'Burn resources to impress; create a new hazard that steals spotlight.',
        ice: 'Double-down on a cracked defense; anyone pressing marks a condition or slips.',
        tech: 'Revert to a “stable” loadout; lose finesse but gain a blunt obstacle.',
        arcane: 'Glyph misfires; summon a lesser menace the team must juggle.',
        feral: 'Roar and posture; someone must Provoke you or you hammer the weakest.',
        psychic: 'Self-doubt radiates; team bickers—reduce Team by 1.',
        time: 'Undo a hero’s small victory; rewrite positioning in your favor.'
      })
    }
  };
  return byCond;
}

function dedupeByName(moves) {
  const seen = new Set();
  const out = [];
  for (const mv of moves) {
    if (!mv?.name) continue;
    const key = normalizeKey(mv.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mv);
  }
  return out;
}

function guaranteeVillainMoves(npc) {
  let vms = Array.isArray(npc.villainMoves) ? npc.villainMoves.filter(m => m?.name && m?.description) : [];
  vms = vms.slice(0, ARGS.maxMoves);
  const fillers = [
    { name: 'Exploit the Opening', description: 'Separate a hero from the team or asset; they mark a condition or yield position.' },
    { name: 'Collateral Over Mission', description: 'Threaten innocents to force a hard choice; someone marks a condition or you achieve an objective.' },
    { name: 'Turn the Spotlight', description: 'Shift focus to a vulnerable hero; they must accept Influence or mark a condition to push through.' },
    { name: 'Raise the Stakes', description: 'Escalate a countdown, reveal a worse threat, or reduce Team by 1.' },
    { name: 'Trap the Strongest', description: 'Bind the most dangerous hero behind a fictional obstacle; freeing them costs time or a condition.' }
  ];
  while (vms.length < ARGS.minMoves) vms.push(fillers[vms.length % fillers.length]);
  return dedupeByName(vms).slice(0, ARGS.maxMoves);
}

function ensureConditionMovesObject(obj) {
  // Normalize any array-like or malformed structures to the required 5-key object
  const hasAll =
    obj && typeof obj === 'object' &&
    ['Afraid','Angry','Guilty','Hopeless','Insecure'].every(k => obj[k]?.name && obj[k]?.description);

  return hasAll ? obj : null;
}

function mergeNPCs(npcsArrays) {
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
        villainMoves: [],
        conditionMoves: null
      };

      for (const f of ['drive','abilities','biography','generation']) {
        if ((n[f] || '').length > (existing[f] || '').length) existing[f] = n[f];
      }

      const seen = new Set(existing.villainMoves.map(m => normalizeKey(m?.name)));
      for (const mv of Array.isArray(n.villainMoves) ? n.villainMoves : []) {
        const k = normalizeKey(mv?.name);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        existing.villainMoves.push({ name: mv.name, description: mv.description });
      }

      const cond = ensureConditionMovesObject(n.conditionMoves);
      if (cond) {
        if (!existing.conditionMoves) existing.conditionMoves = {};
        for (const k of ['Afraid','Angry','Guilty','Hopeless','Insecure']) {
          const incoming = cond[k];
          if (!incoming?.name || !incoming?.description) continue;
          const have = existing.conditionMoves[k];
          // prefer longer description
          if (!have || (incoming.description?.length || 0) > (have.description?.length || 0)) {
            existing.conditionMoves[k] = incoming;
          }
        }
      }

      map.set(key, existing);
    }
  }
  return Array.from(map.values());
}

/* --------------------------- ID Minting Helpers --------------------------- */

function mintIdAndMaybeKey(doc, typeHint /* 'actors'|'items' */, { force = false } = {}) {
  if (!force && doc?._id && doc._id.length === 16) return; // previous behavior; we’ll override with force where needed
  const id = generate16CharUUID();
  doc._id = id;
  if (doc._key && typeof doc._key === 'string') {
    if (/!actors!/.test(doc._key) || typeHint === 'actors') doc._key = `!actors!${id}`;
    else if (/!items!/.test(doc._key) || typeHint === 'items') doc._key = `!items!${id}`;
    else doc._key = `!items!${id}`;
  }
}

/* ----------------------- Item Builders (Villain/Cond) --------------------- */

function createVillainItem(name, description) {
  const it = deepClone(VILLAIN_BASELINE);
  it.name = name || 'Villain Move';
  it.type = 'npcMove';
  it.system = it.system || {};
  it.system.moveType = 'villain';
  it.system.description = sanitizeToHtmlParas(description || 'Escalate the threat using Masks-style consequences.');
  it.img = it.img || 'icons/svg/aura.svg';
  mintIdAndMaybeKey(it, 'items', { force: true }); // ALWAYS fresh
  return it;
}

function createConditionItem(condition, name, description) {
  const it = deepClone(CONDITION_BASELINE);
  it.name = `${condition} - ${name || 'Lash Out'}`;
  it.type = 'npcMove';
  it.system = it.system || {};
  it.system.moveType = 'condition';
  it.system.description = sanitizeToHtmlParas(description || 'How the villain lashes out when this condition is marked.');
  it.img = it.img || 'icons/svg/aura.svg';
  mintIdAndMaybeKey(it, 'items', { force: true }); // ALWAYS fresh
  return it;
}

/* --------------------------- Actor Construction --------------------------- */

function actorFromNPC(npc) {
  const actor = deepClone(TEMPLATE);

  // Rename actor (and token) to NPC alias/name
  if (ARGS.renameActor) {
    actor.name = npc.alias || npc.name || 'Villain';
    if (actor?.prototypeToken) actor.prototypeToken.name = actor.name;
  }

  // Ensure shape & set the ONLY fields we are allowed to change + items
  actor.system = actor.system || {};
  actor.system.attributes = actor.system.attributes || {};
  actor.system.details = actor.system.details || {};

  // Allowed fields to fill:
  actor.system.attributes.realName = actor.system.attributes.realName || { label: 'Real Name', type: 'Text', value: '', position: 'Left' };
  actor.system.attributes.realName.value = String(npc.realName || npc.alias || 'Unknown');

  if (npc.generation) {
    actor.system.attributes.generation = actor.system.attributes.generation || { label: 'Generation', type: 'Text', value: '', position: 'Left' };
    actor.system.attributes.generation.value = String(npc.generation);
  }

  actor.system.details.drive = actor.system.details.drive || { label: 'Drive', value: '' };
  actor.system.details.abilities = actor.system.details.abilities || { label: 'Abilities', value: '' };
  actor.system.details.biography = actor.system.details.biography || { label: 'Notes', value: '' };

  actor.system.details.drive.value = sanitizeToHtmlParas(npc.drive || '');
  actor.system.details.abilities.value = sanitizeToHtmlParas(npc.abilities || '');
  actor.system.details.biography.value = sanitizeToHtmlParas(npc.biography || '');

  // *** CRITICAL FIX: NEVER COPY TEMPLATE ITEMS. Build from scratch. ***
  actor.items = [];

  // Villain moves (3–5)
  const villainMoves = guaranteeVillainMoves(npc);
  for (const mv of villainMoves) {
    actor.items.push(createVillainItem(mv.name, mv.description));
  }

  // Condition moves (exactly 5)
  let cond = ensureConditionMovesObject(npc.conditionMoves);
  if (!cond) cond = synthesizeConditionMoves(npc);

  for (const k of ['Afraid','Angry','Guilty','Hopeless','Insecure']) {
    const c = cond[k] || { name: 'Lash Out', description: 'Reveal a messy, condition-fueled reaction; someone marks a condition or gives ground.' };
    actor.items.push(createConditionItem(k, c.name, c.description));
  }

  // ALWAYS mint new actor id
  mintIdAndMaybeKey(actor, 'actors', { force: true });

  return actor;
}

/* --------------------------- Debug Save Helper ---------------------------- */

async function saveDebug(obj, filename) {
  try {
    await ensureDir(DEBUG_DIR);
    await fsp.writeFile(path.join(DEBUG_DIR, filename), JSON.stringify(obj, null, 2), 'utf8');
  } catch { /* ignore */ }
}

/* ------------------------------ PDF Scanning ------------------------------ */

async function findPdfFiles(inputs) {
  const out = [];
  for (const p of inputs) {
    const abs = path.resolve(CWD, p);
    if (!fs.existsSync(abs)) continue;
    const st = await fsp.stat(abs);
    if (st.isDirectory()) {
      const entries = await fsp.readdir(abs);
      for (const e of entries) if (e.toLowerCase().endsWith('.pdf')) out.push(path.join(abs, e));
    } else if (abs.toLowerCase().endsWith('.pdf')) {
      out.push(abs);
    }
  }
  return out;
}

/* -------------------------------- Worker ---------------------------------- */

async function processPdf(pdfPath) {
  const base = path.basename(pdfPath);
  console.log(`\n📄 Processing PDF: ${base}`);

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

  const chunks = splitTextIntoChunks(text, ARGS.chunkChars, ARGS.chunkOverlap);
  console.log(`   ↳ ${chunks.length} text chunk(s) for model ingestion`);

  const perChunk = chunks.map((chunk, idx) =>
    openRouterJSONChat({
      model: ARGS.model,
      timeoutMs: ARGS.timeoutMs,
      maxRetries: ARGS.maxRetries,
      label: `extract NPCs (chunk ${idx + 1}/${chunks.length})`,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [{ type: 'text', text: userPromptForChunk(base, idx, chunks.length) }, { type: 'text', text: chunk }] }
      ]
    }).then(
      async (json) => {
        if (ARGS.debug) await saveDebug(json, `${base}.chunk-${idx + 1}.json`);
        return json;
      },
      (err) => {
        console.warn(`   ⚠️  Chunk ${idx + 1} failed: ${err.message}`);
        return { npcs: [] }; // continue
      }
    )
  );

  const results = await Promise.all(perChunk);
  const merged = mergeNPCs(results.map(r => r?.npcs || []));

  if (!merged.length) {
    console.warn(`   ⚠️  No NPCs parsed from ${base}.`);
    return { pdf: base, count: 0 };
  }

  await ensureDir(OUTPUT_DIR);
  let ok = 0;

  for (const [i, npc] of merged.entries()) {
    try {
      // Normalize basics
      npc.alias = (npc.alias || npc.name || 'Villain').toString();
      npc.realName = (npc.realName || npc.alias || 'Unknown').toString();
      npc.drive = npc.drive?.toString() || '';
      npc.abilities = npc.abilities?.toString() || '';
      npc.biography = npc.biography?.toString() || '';
      npc.villainMoves = guaranteeVillainMoves(npc);
      npc.conditionMoves = ensureConditionMovesObject(npc.conditionMoves) || synthesizeConditionMoves(npc);

      const actor = actorFromNPC(npc);
      const file = `npc_${safeName(actor.name)}_${actor._id}.json`;
      const outPath = path.join(OUTPUT_DIR, file);
      await fsp.writeFile(outPath, JSON.stringify(actor, null, 2), 'utf8');
      console.log(`   ✓ NPC ${i + 1}/${merged.length}: ${actor.name} -> ${path.relative(CWD, outPath)}`);
      ok++;
    } catch (e) {
      console.warn(`   ⚠️  Failed to build/write NPC ${i + 1}: ${e.message}`);
    }
  }

  console.log(`   ↳ Completed ${base}: ${ok} succeeded, ${merged.length - ok} failed.`);
  return { pdf: base, count: ok };
}

/* ------------------------------ Concurrency ------------------------------- */

function makeQueue(limit) {
  const waiters = [];
  let active = 0;
  return async function run(task) {
    if (active >= limit) await new Promise(res => waiters.push(res));
    active++;
    try { return await task(); }
    finally {
      active--;
      const next = waiters.shift();
      if (next) next();
    }
  };
}

/* ---------------------------------- Main ---------------------------------- */

async function main() {
  console.log(`\n=== Masks NPC Porter (OpenRouter · Gemini 2.5 Pro) ===`);
  console.log(`Input:        ${ARGS.input.map(p => path.resolve(CWD, p)).join(' ')}`);
  console.log(`Output:       ${path.relative(CWD, OUTPUT_DIR)}`);
  console.log(`Model:        ${ARGS.model}`);
  console.log(`Concurrency:  ${ARGS.concurrency}`);
  console.log(`Chunking:     ${ARGS.chunkChars} chars / ${ARGS.chunkOverlap} overlap`);
  console.log(`Moves/NPC:    ${ARGS.minMoves}–${ARGS.maxMoves} villain + 5 conditions`);
  console.log(`Rename Actor: ${ARGS.renameActor}`);
  console.log(`Start:        ${nowIso()}\n`);

  const pdfs = await findPdfFiles(ARGS.input);
  console.log(`Found PDFs:   ${pdfs.length}`);
  if (!pdfs.length) return void console.log('Nothing to do.');

  const run = makeQueue(ARGS.concurrency);
  const tasks = pdfs.map(pdf => run(async () => {
    try { return await processPdf(pdf); }
    catch (e) {
      console.warn(`⚠️  Worker error for ${path.basename(pdf)}: ${e.message}`);
      return { pdf: path.basename(pdf), count: 0 };
    }
  }));

  const results = await Promise.all(tasks);
  const total = results.reduce((a, r) => a + (r?.count || 0), 0);
  console.log(`\nAll done. Created ${total} NPC${total === 1 ? '' : 's'}. Finished at: ${nowIso()}\n`);
}

main().catch(err => {
  console.error(`\n❌ Fatal: ${err?.stack || err?.message || String(err)}\n`);
  process.exit(1);
});
