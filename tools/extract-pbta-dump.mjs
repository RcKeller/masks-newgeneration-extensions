#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * PBTA/FoundryVTT summarizer – characters, NPCs, and journals
 * -----------------------------------------------------------
 * - Reads JSON, NDJSON, or Foundry .db (line-delimited JSON) from pack folders
 * - Extracts + summarizes key information you asked for
 * - Produces pbta-dump.json (and optional pbta-dump.md)
 *
 * Node 18+ (no dependencies)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* -------------------------- CLI ARG PARSING -------------------------- */
function parseArgs(argv) {
  const args = {
    chars: 'src/packs/sgb30-characters',
    campaign: 'src/packs/sgb30-campaign',
    out: 'pbta-dump',
    md: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--chars') args.chars = argv[++i];
    else if (a === '--campaign') args.campaign = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--md') args.md = true;
  }
  // Normalize comma-separated to arrays
  args.charDirs = args.chars.split(',').map(s => s.trim()).filter(Boolean);
  args.campaignDirs = args.campaign.split(',').map(s => s.trim()).filter(Boolean);
  return args;
}

/* -------------------------- FILE UTILITIES --------------------------- */

async function listFilesRecursively(root) {
  const out = [];
  async function walk(dir) {
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of items) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(root);
  return out;
}

function isLikelyJsonFile(fp) {
  const ext = path.extname(fp).toLowerCase();
  return ['.json', '.db', '.ndjson', '.txt'].includes(ext);
}

function tryJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Attempts to parse file content into an array of Foundry documents
function parseAnyJsonDocument(text, hintExt = '') {
  const trimmed = text.trim();
  // 1) Array JSON
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const arr = tryJsonParse(trimmed);
    if (Array.isArray(arr)) return arr;
  }
  // 2) Single JSON object
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const obj = tryJsonParse(trimmed);
    if (obj) return [obj];
  }
  // 3) NDJSON / .db lines
  const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const docs = [];
  let parsed = 0;
  for (const ln of lines) {
    const obj = tryJsonParse(ln);
    if (obj) {
      parsed++;
      docs.push(obj);
    }
  }
  if (parsed > 0) return docs;
  // 4) Fallback: split on }{ boundaries (some exports end up concatenated)
  const split = trimmed.split(/}\s*{\s*/g);
  if (split.length > 1) {
    const maybe = ['{' + split.join('}{') + '}'];
    const obj = tryJsonParse(maybe[0]);
    if (obj) return [obj];
  }
  // Give up: return nothing
  return [];
}

/* --------------------------- TEXT UTILITIES -------------------------- */

const entityMap = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&rdquo;': '”',
  '&ldquo;': '“',
  '&mdash;': '—',
  '&ndash;': '–'
};

function decodeEntities(str = '') {
  return str.replace(/&[a-zA-Z#0-9]+;/g, m => entityMap[m] ?? m);
}

function stripHtml(html = '') {
  if (!html) return '';
  // Preserve list bullets and headings a bit before stripping
  const withBullets =
    html
      .replace(/\r?\n/g, ' ')
      .replace(/<\/(h1|h2|h3|h4|p|div)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/li>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\n{3,}/g, '\n\n');
  const decoded = decodeEntities(withBullets);
  return decoded.replace(/[ \t]{2,}/g, ' ').trim();
}

function clampLines(text, maxLines = 18) {
  const lines = text.split(/\r?\n/).map(l => l.trimEnd());
  if (lines.length <= maxLines) return lines.join('\n');
  return [...lines.slice(0, maxLines), '…'].join('\n');
}

function clampChars(text, maxChars = 1200) {
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars);
  // cut at last sentence or line break for cleanliness
  const lastCut = Math.max(
    clipped.lastIndexOf('\n'),
    clipped.lastIndexOf('. '),
    clipped.lastIndexOf('! '),
    clipped.lastIndexOf('? ')
  );
  return (lastCut > 200 ? clipped.slice(0, lastCut + 1) : clipped) + ' …';
}

function summarizeHtml(html, { preferBullets = true, maxChars = 1200, maxLines = 18 } = {}) {
  const text = stripHtml(html);
  let lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (preferBullets) {
    // Bias toward keeping bullet-like lines and section headers
    const scored = lines.map(line => {
      let score = 0;
      if (/^[-•]/.test(line)) score += 3;
      if (/^\s*[A-Z][A-Za-z ]{2,}:\s*$/.test(line)) score += 2; // "Backstory:" style
      if (/^\s*(Look|Abilities|Backstory|Doom|Sanctuary|Moves|Relationships|Team|Nemesis)/i.test(line)) score += 2;
      if (line.length < 200) score += 1;
      return { line, score };
    });
    scored.sort((a, b) => b.score - a.score);
    lines = scored.map(s => s.line);
    // Keep uniqueness and original order where possible
    const seen = new Set();
    const filtered = [];
    for (const l of lines) {
      const key = l.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      filtered.push(l);
      if (filtered.length >= Math.max(12, Math.floor(maxLines * 0.75))) break;
    }
    lines = filtered;
  }
  const joined = clampLines(lines.join('\n'), maxLines);
  return clampChars(joined, maxChars);
}

/* ----------------------- DOMAIN-SPECIFIC EXTRACTORS ------------------ */

// Foundry masks flags influence shape:
// { name, hasInfluenceOver: boolean, haveInfluenceOver: boolean }
function extractInfluences(flags = {}) {
  const arr = flags?.['masks-newgeneration-unofficial']?.influences || [];
  const influencedBy = [];
  const influenceOver = [];
  for (const inf of arr) {
    const name = inf?.name ?? '(unknown)';
    if (inf?.hasInfluenceOver) influencedBy.push(name);   // They have influence over me
    if (inf?.haveInfluenceOver) influenceOver.push(name); // I have influence over them
  }
  return { influencedBy, influenceOver };
}

function extractStats(system = {}) {
  const s = system?.stats || {};
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    out[k] = v?.value ?? null;
  }
  return out;
}

function get(obj, pathStr, dflt = undefined) {
  return pathStr.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj) ?? dflt;
}

function nonEmptyAttributesForPlaybook(system = {}, playbookName) {
  const attrs = system?.attributes || {};
  const picked = {};
  for (const [key, meta] of Object.entries(attrs)) {
    // keep attributes that either (a) declare this playbook, or (b) are populated and look relevant
    const belongs = (meta?.playbook && meta.playbook === playbookName);
    const hasVal =
      typeof meta?.value === 'string' && meta.value.trim().length > 0 ||
      (meta?.type === 'ListMany' && meta?.options && Object.values(meta.options).some(o => o?.value === true));
    if (belongs || hasVal) {
      if (meta?.type === 'ListMany' && meta?.options) {
        picked[key] = Object.values(meta.options)
          .filter(o => o?.value === true || (typeof o?.label === 'string' && /\S/.test(o.label)))
          .map(o => (typeof o.label === 'string' ? o.label : '')).filter(Boolean);
      } else if (typeof meta?.value === 'string') {
        picked[key] = stripHtml(meta.value).trim();
      }
    }
  }
  return picked;
}

function summarizePlaybookItem(item) {
  // item.type === 'playbook', item.system.description is big HTML blob
  const html = get(item, 'system.description', '');
  return summarizeHtml(html, { preferBullets: true, maxChars: 1400, maxLines: 22 });
}

function summarizeMoveItem(item) {
  const name = item?.name ?? '(move)';
  const mvType = get(item, 'system.moveType', '');
  const desc = summarizeHtml(get(item, 'system.description', ''), { preferBullets: true, maxChars: 600, maxLines: 10 });
  return { name, moveType: mvType, summary: desc };
}

function pickNpcMoves(items = []) {
  return items
    .filter(i => i?.type === 'npcMove' || (i?.type === 'move' && /villain|condition/i.test(get(i, 'system.moveType', ''))))
    .map(summarizeMoveItem);
}

function extractCharacter(doc) {
  const system = doc?.system || {};
  const playbookName = get(system, 'playbook.name') ||
                       (doc.items || []).find(it => it.type === 'playbook')?.name;
  const playbookItem = (doc.items || []).find(it => it.type === 'playbook');
  const playbookSummary = playbookItem ? summarizePlaybookItem(playbookItem) : null;

  const backstoryHtml = get(system, 'details.backstory.value', '') || get(system, 'attributes.backstory.value', '');
  const backstorySummary = backstoryHtml ? summarizeHtml(backstoryHtml, { preferBullets: false, maxChars: 1200, maxLines: 20 }) : null;

  const relationshipsHtml = get(system, 'attributes.relationshipQuestions.value', '');
  const relationships = relationshipsHtml ? summarizeHtml(relationshipsHtml, { preferBullets: true, maxChars: 600, maxLines: 10 }) : null;

  const momentHtml = get(system, 'attributes.momentOfTruth.value', '');
  const moment = momentHtml ? stripHtml(momentHtml) : null;

  const teamHtml = get(system, 'attributes.teamQuestion.value', '');
  const teamFirstTogether = teamHtml ? stripHtml(teamHtml) : null;

  const influences = extractInfluences(doc?.flags || {});
  const stats = extractStats(system);
  const realName = stripHtml(get(system, 'attributes.realName.value', '') || '');

  const playbookAttrs = nonEmptyAttributesForPlaybook(system, playbookName);

  // List playbook-specific moves (not basic/rules)
  const playbookMoves = (doc.items || [])
    .filter(it => it.type === 'move' && get(it, 'system.moveType', '') === 'playbook')
    .map(summarizeMoveItem);

  return {
    kind: 'character',
    name: doc?.name ?? '(unnamed)',
    realName: realName || null,
    playbook: playbookName || null,
    stats,
    influence: influences,
    playbookSummary,
    backstorySummary,
    relationships,
    momentOfTruth: moment,
    teamWhenWeFirstCameTogether: teamFirstTogether,
    playbookAttributes: playbookAttrs,
    playbookMoves
  };
}

function extractNpc(doc) {
  const system = doc?.system || {};
  const name = doc?.name ?? '(unnamed)';
  const realName = stripHtml(get(system, 'attributes.realName.value', '') || '');
  const generation = stripHtml(get(system, 'attributes.generation.value', '') || '');
  const tags = (get(system, 'tags', '') || '').toString();

  const drive = stripHtml(get(system, 'details.drive.value', '') || '');
  const abilities = stripHtml(get(system, 'details.abilities.value', '') || '');
  const biography = summarizeHtml(get(system, 'details.biography.value', '') || '', { preferBullets: false, maxChars: 800, maxLines: 12 }) || null;

  const moves = pickNpcMoves(doc?.items || []);

  return {
    kind: 'npc',
    name,
    realName: realName || null,
    generation: generation || null,
    tags: tags || null,
    drive: drive || null,
    abilities: abilities || null,
    notesSummary: biography,
    moves
  };
}

function isActor(doc) {
  const t = (doc?.type || doc?.baseType || '').toLowerCase();
  return t === 'character' || t === 'npc';
}

// Journal entries: Foundry v10+ usually has { name, pages: [{type: 'text', text:{content: '<p>..'}}] }
function extractJournal(doc) {
  const name = doc?.name ?? '(journal)';
  const pages = Array.isArray(doc?.pages) ? doc.pages : [];
  const chunks = [];
  for (const p of pages) {
    const kind = (p?.type || '').toLowerCase();
    if (kind === 'text') {
      const html = get(p, 'text.content', '') || get(p, 'system.text', '') || '';
      if (html) chunks.push(html);
    }
  }
  let combined = chunks.join('\n\n');
  if (!combined && typeof doc?.content === 'string') combined = doc.content; // older exports
  const summary = combined ? summarizeHtml(combined, { preferBullets: true, maxChars: 1400, maxLines: 28 }) : null;
  return {
    kind: 'journal',
    name,
    summary
  };
}

function isJournal(doc) {
  if (Array.isArray(doc?.pages)) return true;
  const t = (doc?.type || '').toLowerCase();
  // Some exports store JournalEntry with type 'journal' or omit it; be generous.
  return t === 'journal' || (!!doc?.content && typeof doc.content === 'string');
}

/* ------------------------------ MAIN --------------------------------- */

async function readDocsFromDirs(dirs) {
  const docs = [];
  for (const dir of dirs) {
    const files = await listFilesRecursively(dir);
    for (const f of files) {
      if (!isLikelyJsonFile(f)) continue;
      const raw = await fs.readFile(f, 'utf8').catch(() => null);
      if (!raw) continue;
      const parsed = parseAnyJsonDocument(raw, path.extname(f));
      for (const doc of parsed) docs.push({ doc, file: f });
    }
  }
  return docs;
}

function dedupeByNameAndKind(items) {
  const key = i => `${(i.kind || 'doc')}::${(i.name || '').toLowerCase()}`;
  const map = new Map();
  for (const i of items) {
    if (!map.has(key(i))) map.set(key(i), i);
  }
  return [...map.values()];
}

function toMarkdown(dump) {
  const lines = [];
  lines.push(`# PBTA Campaign Dump`);
  lines.push(`Generated: ${dump.generatedAt}`);
  lines.push('');

  if (dump.characters?.length) {
    lines.push(`## Player Characters`);
    for (const c of dump.characters) {
      lines.push(`### ${c.name}${c.realName ? ` (${c.realName})` : ''}${c.playbook ? ` — ${c.playbook}` : ''}`);
      const labels = c.stats ? Object.entries(c.stats).map(([k,v]) => `${k}:${v}`).join('  ·  ') : '';
      if (labels) lines.push(`**Labels:** ${labels}`);
      if (c.influence) {
        const by = c.influence.influencedBy?.length ? `Influenced by: ${c.influence.influencedBy.join(', ')}` : '';
        const over = c.influence.influenceOver?.length ? `Influence over: ${c.influence.influenceOver.join(', ')}` : '';
        if (by || over) lines.push(`**Influence:** ${[by, over].filter(Boolean).join('  ·  ')}`);
      }
      if (c.playbookSummary) {
        lines.push('');
        lines.push(`**Playbook summary:**`);
        lines.push('');
        lines.push('```');
        lines.push(c.playbookSummary);
        lines.push('```');
      }
      if (c.backstorySummary) {
        lines.push('');
        lines.push(`**Backstory (summary):**`);
        lines.push('');
        lines.push('```');
        lines.push(c.backstorySummary);
        lines.push('```');
      }
      if (c.playbookMoves?.length) {
        lines.push('');
        lines.push(`**Signature Moves:**`);
        for (const mv of c.playbookMoves) {
          lines.push(`- *${mv.name}*${mv.moveType ? ` (${mv.moveType})` : ''}`);
        }
      }
      const extras = [];
      if (c.playbookAttributes && Object.keys(c.playbookAttributes).length) {
        lines.push('');
        lines.push(`**Notable Playbook Fields:**`);
        for (const [k, v] of Object.entries(c.playbookAttributes)) {
          if (Array.isArray(v)) lines.push(`- ${k}: ${v.join('; ')}`);
          else if (typeof v === 'string' && v.length < 280) lines.push(`- ${k}: ${v}`);
          else if (typeof v === 'string') lines.push(`- ${k}: ${v.slice(0, 280)}…`);
        }
      }
      if (c.momentOfTruth) {
        lines.push('');
        lines.push(`**Moment of Truth:** ${c.momentOfTruth.length > 300 ? c.momentOfTruth.slice(0, 300) + '…' : c.momentOfTruth}`);
      }
      if (c.teamWhenWeFirstCameTogether) {
        lines.push('');
        lines.push(`**When our team first came together:** ${c.teamWhenWeFirstCameTogether}`);
      }
      lines.push('');
    }
  }

  if (dump.npcs?.length) {
    lines.push(`## NPCs`);
    for (const n of dump.npcs) {
      lines.push(`### ${n.name}${n.realName ? ` (${n.realName})` : ''}`);
      const metas = [n.generation && `Generation: ${n.generation}`, n.tags && `Tags: ${n.tags}`].filter(Boolean).join('  ·  ');
      if (metas) lines.push(metas);
      if (n.drive) lines.push(`**Drive:** ${n.drive}`);
      if (n.abilities) lines.push(`**Abilities:** ${n.abilities}`);
      if (n.notesSummary) {
        lines.push('');
        lines.push(`**Notes (summary):**`);
        lines.push('');
        lines.push('```');
        lines.push(n.notesSummary);
        lines.push('```');
      }
      if (n.moves?.length) {
        lines.push('');
        lines.push(`**Key Moves:**`);
        for (const mv of n.moves) {
          lines.push(`- *${mv.name}*${mv.moveType ? ` (${mv.moveType})` : ''}`);
        }
      }
      lines.push('');
    }
  }

  if (dump.journals?.length) {
    lines.push(`## Journals / Recaps`);
    for (const j of dump.journals) {
      lines.push(`### ${j.name}`);
      if (j.summary) {
        lines.push('');
        lines.push('```');
        lines.push(j.summary);
        lines.push('```');
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);

  // Read character + npc docs
  const charDocs = await readDocsFromDirs(args.charDirs);
  const outChars = [];
  const outNpcs = [];

  for (const { doc } of charDocs) {
    if (!doc || typeof doc !== 'object') continue;
    if (!isActor(doc)) continue;
    const t = (doc.type || doc.baseType || '').toLowerCase();
    if (t === 'character') outChars.push(extractCharacter(doc));
    else if (t === 'npc') outNpcs.push(extractNpc(doc));
  }

  // Read campaign (journals)
  const campaignDocs = await readDocsFromDirs(args.campaignDirs);
  const outJournals = [];
  for (const { doc } of campaignDocs) {
    if (!doc || typeof doc !== 'object') continue;
    if (isJournal(doc)) outJournals.push(extractJournal(doc));
  }

  const dump = {
    generatedAt: new Date().toISOString(),
    characters: dedupeByNameAndKind(outChars).sort((a,b)=>a.name.localeCompare(b.name)),
    npcs: dedupeByNameAndKind(outNpcs).sort((a,b)=>a.name.localeCompare(b.name)),
    journals: dedupeByNameAndKind(outJournals).sort((a,b)=>a.name.localeCompare(b.name))
  };

  // Write JSON
  const jsonPath = path.resolve(__dirname, `${args.out}.json`);
  await fs.writeFile(jsonPath, JSON.stringify(dump, null, 2), 'utf8');
  console.log(`✅ Wrote ${jsonPath}`);

  // Optionally write Markdown
  if (args.md) {
    const mdPath = path.resolve(__dirname, `${args.out}.md`);
    await fs.writeFile(mdPath, toMarkdown(dump), 'utf8');
    console.log(`✅ Wrote ${mdPath}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
