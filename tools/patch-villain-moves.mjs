#!/usr/bin/env node
/**
 * Patch Masks NPC move types in two pack folders:
 *   - src/packs/adversaries
 *   - src/packs/champions-villains
 *
 * Rules:
 * 1) Condition moves (names starting with Afraid, Angry, Hopeless, Insecure, Guilty)
 *    => system.moveType = "condition"
 * 2) Basic "GM" moves (list below)
 *    => remove system.moveType entirely (or set "" with --basic blank)
 * 3) All other npcMove items
 *    => system.moveType = "villain"
 *
 * Safe by default:
 *  - Creates .bak backups next to modified files.
 *  - --dry-run reports what would change without writing.
 *
 * Node 18+ (ESM).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_DIRS = ['src/packs/adversaries', 'src/packs/champions-villains'];

/** Parse CLI flags */
function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    root: process.cwd(),
    dirs: [...DEFAULT_DIRS],
    dryRun: false,
    backup: true,
    // how to handle basic GM moves' moveType:
    // 'none' => delete property entirely (default); 'blank' => set to "".
    basicHandling: 'none',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-backup') opts.backup = false;
    else if (a === '--root') opts.root = path.resolve(argv[++i] ?? opts.root);
    else if (a === '--dirs') opts.dirs = argv[++i].split(',').map(d => d.trim()).filter(Boolean);
    else if (a === '--basic') {
      const v = (argv[++i] ?? '').toLowerCase();
      if (v === 'blank' || v === 'none') opts.basicHandling = v;
      else throw new Error(`--basic must be "blank" or "none" (got: ${v})`);
    } else {
      console.warn(`Unknown option ignored: ${a}`);
    }
  }
  return opts;
}

/** Normalize a move name for comparison (lowercase, unify dashes/spaces) */
function normalizeName(name = '') {
  return String(name)
    .toLowerCase()
    // unify various unicode dashes to ASCII hyphen
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    // collapse ellipsis glyph to '...'
    .replace(/\u2026/g, '...')
    // collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

// Canonical basic GM move names (normalized)
const BASIC_EQUIVALENTS = new Set([
  'make a playbook move',
  'activate downsides of abilities and relationships',
  'inflict condition',
  'take influence',
  'bring team together',
  'bring them together', // accepted alias
  'capture someone',
  'put innocents in danger',
  'villain move',
  'show collateral damage',
  'reveal future',
  'announce between-panel threats',
  'price of victory',
  'counter',
  'reverse',
  'tell them who they are or should be',
  'tell them who they are or who they should be', // accepted alias
  'rash decision',
]);

function isBasicMove(name) {
  const n = normalizeName(name);
  if (BASIC_EQUIVALENTS.has(n)) return true;

  // "Possible Consequence..." has punctuation variants; accept any that start with that stem.
  if (n.startsWith('possible consequence')) return true;

  return false;
}

const CONDITION_PREFIXES = ['afraid', 'angry', 'hopeless', 'insecure', 'guilty'];

function isConditionMove(name) {
  const n = normalizeName(name);
  // starts with any of the condition words followed by end, space, or hyphen
  return CONDITION_PREFIXES.some((p) => {
    if (n === p) return true;
    if (n.startsWith(`${p} `)) return true;
    if (n.startsWith(`${p}-`)) return true;
    return false;
  });
}

/** Recursively collect JSON files under a directory. */
async function listJsonFiles(dir) {
  const out = [];
  async function walk(d) {
    let entries = [];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch (e) {
      console.warn(`WARN: Unable to read dir ${d}: ${e.message}`);
      return;
    }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        await walk(p);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.json')) {
        out.push(p);
      }
    }
  }
  await walk(dir);
  return out;
}

/** Safely delete a property if it exists */
function deleteProp(obj, key) {
  if (obj && Object.prototype.hasOwnProperty.call(obj, key)) {
    delete obj[key];
    return true;
  }
  return false;
}

/** Ensure system object exists */
function ensureSystem(it) {
  if (!it.system || typeof it.system !== 'object') it.system = {};
  return it.system;
}

/** Update a single npcMove item per rules; returns one of: 'condition'|'villain'|'basic-cleared'|'basic-blank'|null if no change */
function updateNpcMove(item, basicHandling) {
  if (!item || item.type !== 'npcMove') return null;
  const sys = ensureSystem(item);
  const name = item.name ?? '';

  if (isBasicMove(name)) {
    if (basicHandling === 'blank') {
      if (sys.moveType !== '') {
        sys.moveType = '';
        return 'basic-blank';
      }
      return null;
    } else {
      // delete the property entirely
      if (deleteProp(sys, 'moveType')) {
        return 'basic-cleared';
      }
      return null;
    }
  }

  if (isConditionMove(name)) {
    if (sys.moveType !== 'condition') {
      sys.moveType = 'condition';
      return 'condition';
    }
    return null;
  }

  if (sys.moveType !== 'villain') {
    sys.moveType = 'villain';
    return 'villain';
  }
  return null;
}

/** Process an actor-like object that has an "items" array */
function processActorLike(doc, stats, basicHandling) {
  if (!doc || !Array.isArray(doc.items)) return false;
  let changed = false;
  stats.actorsVisited++;

  for (const it of doc.items) {
    if (!it || it.type !== 'npcMove') continue;
    stats.itemsVisited++;
    const res = updateNpcMove(it, basicHandling);
    if (res) {
      changed = true;
      stats.changedByKind[res] = (stats.changedByKind[res] || 0) + 1;
    }
  }

  return changed;
}

/** Process any JSON structure that might be an actor or an array of actors/docs */
function processJsonRoot(root, stats, basicHandling) {
  let changed = false;

  const handle = (o) => {
    // Foundry pack source files are often a single doc or an array of docs.
    // If it looks like an actor (has items), process it; otherwise, if it’s
    // a generic doc that contains "items", also process it.
    const did = processActorLike(o, stats, basicHandling);
    if (did) changed = true;
  };

  if (Array.isArray(root)) {
    for (const el of root) handle(el);
  } else if (root && typeof root === 'object') {
    handle(root);
  }

  return changed;
}

/** Read/patch/write a JSON file if needed */
async function patchFile(filePath, { dryRun, backup, basicHandling }, stats) {
  stats.filesVisited++;
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (e) {
    console.warn(`WARN: Cannot read ${filePath}: ${e.message}`);
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.warn(`WARN: Skipping ${filePath} (invalid JSON): ${e.message}`);
    return;
  }

  const changed = processJsonRoot(data, stats, basicHandling);
  if (!changed) return;

  stats.filesChanged++;
  const pretty = JSON.stringify(data, null, 2) + '\n';

  if (dryRun) {
    console.log(`DRY-RUN would modify: ${filePath}`);
    return;
  }

  try {
    if (backup) {
      const bakPath = `${filePath}.bak`;
      await fs.writeFile(bakPath, raw, 'utf8');
    }
    await fs.writeFile(filePath, pretty, 'utf8');
    console.log(`Patched: ${filePath}`);
  } catch (e) {
    console.error(`ERROR writing ${filePath}: ${e.message}`);
  }
}

/** Main */
(async function main() {
  const opts = parseArgs();
  const stats = {
    filesVisited: 0,
    filesChanged: 0,
    actorsVisited: 0,
    itemsVisited: 0,
    changedByKind: {}, // { condition, villain, 'basic-cleared', 'basic-blank': counts }
  };

  // Resolve roots
  const targets = opts.dirs.map((d) => path.resolve(opts.root, d));
  for (const dir of targets) {
    const jsonFiles = await listJsonFiles(dir);
    for (const f of jsonFiles) {
      await patchFile(f, opts, stats);
    }
  }

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Files scanned:   ${stats.filesVisited}`);
  console.log(`Files modified:  ${stats.filesChanged}`);
  console.log(`Actors touched:  ${stats.actorsVisited}`);
  console.log(`npcMove items:   ${stats.itemsVisited}`);
  const kinds = Object.entries(stats.changedByKind)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
  console.log('Changes by type:\n' + (kinds || '  (none)'));

  if (opts.dryRun) {
    console.log('\n(No files were written due to --dry-run)');
  } else {
    console.log('\nBackups: ' + (opts.backup ? 'ENABLED (*.bak created next to changed files)' : 'disabled'));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
