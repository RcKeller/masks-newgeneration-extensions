#!/usr/bin/env node
/**
 * tools/port-npcs.mjs
 * -----------------------------------------------------------------------------
 * PORT NPCs FROM SOURCE FILES (.txt / .md) TO FOUNDY PBTA/MASKS NPC JSON
 *
 * Provider: OpenRouter (model: deepseek/deepseek-chat-v3-0324)
 * Endpoint: https://openrouter.ai/api/v1/chat/completions
 * Response format: JSON-only (no markdown)
 *
 * WHAT THIS SCRIPT DOES
 * -----------------------------------------------------------------------------
 * • Scans an input directory for .txt and .md files (no PDFs).
 * • For each file:
 *    1) Calls the LLM once to enumerate all NPCs referenced in the file
 *       (names, realName, concept, optional drive/abilities/bio/img path).
 *    2) Calls the LLM once per NPC to produce:
 *          - 3–5 custom Villain moves (type: npcMove, moveType: "villain")
 *          - 5 custom Condition moves (Afraid, Angry, Guilty, Hopeless, Insecure)
 * • Builds a full Foundry VTT Actor document (type: "npc") by cloning
 *   ./example-npc.json and replacing allowed fields:
 *     - name
 *     - _id (fresh 16‑character alphanumeric UUID)
 *     - img (retain "te-core-rules" style path if present; else fallback)
 *     - system.attributes.realName.value
 *     - items[] rebuilt from scratch:
 *         → 3–5 villain moves, 5 condition moves,
 *         → preserves baseline GM options (not removed).
 *   All Items get fresh 16‑char UUIDs and exact Masks/PbtA move structure.
 * • Writes one file per NPC:
 *      npc_<VILLAIN_NAME>_<UUID>.json  (default outdir: src/packs/ported)
 *
 * ROBUSTNESS
 * -----------------------------------------------------------------------------
 * • Continues on errors: logs warnings and keeps going.
 * • Validates/repairs under-filled model output (auto-synthesis).
 * • Retries 429/5xx with bounded exponential backoff (+ jitter). No infinite loops.
 *
 * PROMPTS (CONFIGURABLE)
 * -----------------------------------------------------------------------------
 * You can override the built-in prompts by creating markdown files in ./resources:
 *   resources/enumerate.system.md
 *   resources/enumerate.user.md
 *   resources/build.system.md
 *   resources/build.user.md
 *
 * Available template variables (double curly braces) for prompt files:
 *   Enumerate:
 *     {{FILE_PATH}}   absolute path string
 *     {{CONTENT}}     file content (trimmed)
 *   Build (per-NPC):
 *     {{NPC_NAME}}, {{NPC_REALNAME}}, {{NPC_IMG}}, {{NPC_CONCEPT}},
 *     {{NPC_DRIVE}}, {{NPC_ABILITIES}}, {{NPC_BIO}},
 *     {{GM_TRIGGERS}}  comma-separated allowed GM triggers
 *     {{GM_LINK_CATALOG}} newline list of @UUID options grouped by trigger
 *     {{ICON_CATALOG}}   JSON array of valid icon paths
 *
 * IMPORTANT MASKS CONSTRAINTS THIS SCRIPT ENFORCES
 * -----------------------------------------------------------------------------
 * • Moves are narrative GM-style; no villain dice. One <p>…</p> per description.
 * • Each custom Villain OR Condition move:
 *     - Must reference 1–2 allowed GM move names and MUST embed the @UUID[…] link
 *       **inline on the GM phrase** with the label text in {…} crafted by the LLM
 *       for grammatical fit (no trailing “— …” block).
 * • Non-condition **villain** moves will NOT use “Make a Villain Move”.
 * • Exactly five condition moves (Afraid, Angry, Guilty, Hopeless, Insecure).
 * • Preserves a small baseline set of GM options (not removed).
 * • Every actor and item gets a fresh 16‑char [A‑Za‑z0‑9] UUID.
 *
 * CLI
 * -----------------------------------------------------------------------------
 * node tools/port-npcs.mjs
 *   [--indir ./src/packs]         Input directory to scan for .txt/.md files
 *   [--outdir ./src/packs/ported] Output directory (auto-created)
 *   [--template ./example-villain.json] Path to the NPC template JSON
 *   [--model deepseek/deepseek-chat-v3-0324]  OpenRouter model id
 *   [--concurrency 2]             Max concurrent file jobs
 *   [--filePattern "*"]           Simple filename prefix glob (e.g. "chapter*")
 *   [--resources ./resources]     Directory with optional .md prompt overrides
 *   [--dry]                       Do not write files (log only)
 *
 * ENV VARS
 * -----------------------------------------------------------------------------
 *   OPENROUTER_API_KEY   (required)
 *   OPENROUTER_SITE_URL  (optional ranking metadata)
 *   OPENROUTER_SITE_NAME (optional ranking metadata)
 *
 * LICENSE
 * -----------------------------------------------------------------------------
 * MIT. You confirm you own the IP for the villains you port.
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { setTimeout as sleep } from "timers/promises";

// ------------------------------ CLI ARGS ------------------------------

const argv = process.argv.slice(2);
const getFlag = (name, def = undefined) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) return true;
  return v;
};

const IN_DIR        = path.resolve(getFlag("indir", "./src/packs"));
const OUT_DIR       = path.resolve(getFlag("outdir", "./src/packs/ported"));
const TEMPLATE_PATH = path.resolve(getFlag("template", "./resources/example-villain.json"));
const MODEL         = getFlag("model", "deepseek/deepseek-chat-v3-0324");
const CONCURRENCY   = Math.max(1, parseInt(getFlag("concurrency", "2"), 10) || 2);
const FILE_PATTERN  = getFlag("filePattern", "*");
const RES_DIR       = path.resolve(getFlag("resources", "./resources"));
const DRY_RUN       = !!getFlag("dry", false);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  console.error("ERROR: OPENROUTER_API_KEY is required.");
  process.exit(1);
}

// ------------------------------ CONSTANTS ------------------------------

const ALLOWED_EXTENSIONS = new Set([".txt", ".md"]);

const GM_TRIGGER_WHITELIST = [
  "Make a Villain Move",
  "Make a Playbook Move",
  "Activate the Downsides of their Abilities and Relationships",
  "Inflict a Condition",
  "Take Influence over",
  "Bring Them Together",
  "Capture Someone",
  "Put Innocents in Danger",
  "Collateral Damage",
  "Reveal the Future",
  "Announce Between‑Panel Threats",
  "Make Them Pay a Price for Victory",
  "Turn Their Move Back on Them",
  "Trade Blows",
  "Tell Them the Possible Consequences—and Ask",
  "Tell Them Who They Are or Who They Should Be",
  "Bring an NPC to Rash Decisions and Hard Conclusions",
  "Lash Out Verbally",
  "Resist or Avoid Their Blows",
  "Struggle Past the Pain",
  "Giving Ground"
];

// (Kept as authoritatively provided; we pass these to the LLM so it can pick one variant
// and HAND-WRITE the {label} text for grammar.)
const GM_UUID_MAP = {
  "Activate the Downsides of their Abilities and Relationships": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.NXgUwNBxnjOEIqRa]{Activate the Downsides of the heroes Abilities and Relationships}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.NXgUwNBxnjOEIqRa]{Activate the Downsides of the heroes Relationships}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.NXgUwNBxnjOEIqRa]{Activate the Downsides of the heroes Abilities}",
  ],
  "Giving Ground": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.w5RMQhyRMu0Kz8Bh.JournalEntryPage.Xp8um8mddjyw1T7N]{Give ground}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.w5RMQhyRMu0Kz8Bh.JournalEntryPage.Xp8um8mddjyw1T7N]{Giving ground}",
  ],
  "Resist or Avoid Their Blows":[
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.w5RMQhyRMu0Kz8Bh.JournalEntryPage.t9kFvEp4eNYMCUkC]{Resist or avoid their blows}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.w5RMQhyRMu0Kz8Bh.JournalEntryPage.t9kFvEp4eNYMCUkC]{Resist their blows}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.w5RMQhyRMu0Kz8Bh.JournalEntryPage.t9kFvEp4eNYMCUkC]{Avoid their blows}",
  ],
  "Struggle Past the Pain": ["@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.w5RMQhyRMu0Kz8Bh.JournalEntryPage.KfrxYBcKmyhJEFkh]{Struggle Past the Pain}"],
  "Lash Out Verbally":["@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.w5RMQhyRMu0Kz8Bh.JournalEntryPage.7bUuUXo8ob2I9rx3]{Lashing out verbally}"],
  "Announce Between‑Panel Threats": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.sSBCr0W3EJYs6Tg7]{Announce Between-Panel Threats}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.sSBCr0W3EJYs6Tg7]{Reveal Between-Panel Threats}",
  ],
  "Bring an NPC to Rash Decisions and Hard Conclusions": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.WDtPMAeq3CIumtrg]{Bring an NPC to Rash Decisions and Hard Conclusions}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.WDtPMAeq3CIumtrg]{Prompt an NPC to make a Hard Conclusion}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.WDtPMAeq3CIumtrg]{Prompt an NPC to make a Rash Decision}",
  ],
  "Bring Them Together": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.5NEbMj9wQ0QJFLYz]{Bring Them Together}"
  ],
  "Capture Someone": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.u8A6Gk7GoqBIMQBs]{Capture an Innocent}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.u8A6Gk7GoqBIMQBs]{Capture Someone}",
  ],
  "Inflict a Condition": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.aiXzW3H0z4NREaFc]{Inflict a Condition}"
  ],
  "Make a Playbook Move": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.voNk2PNNF7oNqnSn]{Make a Playbook Move}"
  ],
  "Make a Villain Move": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.gUeKGSiXfwJEKGeS]{Make a Villain Move}"
  ],
  "Trade Blows": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.w5RMQhyRMu0Kz8Bh.JournalEntryPage.ychaHSFqGy2SK7d7]{Trade blows}"
  ],
  "Make Them Pay a Price for Victory": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.89UPbdTtpbs4kmP3]{Make Them Pay a Price for Victory}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.89UPbdTtpbs4kmP3]{Heroes Pay a Price}",
  ],
  "Put Innocents in Danger": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.J6NDHhQ2xeaHUZ6Y]{Endanger Innocents}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.J6NDHhQ2xeaHUZ6Y]{Put Innocents in Danger}"
  ],
  "Reveal the Future": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.Rm4fQyfiwGkpytfF]{Reveal the Future, Subtly or Directly}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.Rm4fQyfiwGkpytfF]{Reveal the Future}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.Rm4fQyfiwGkpytfF]{Foreshadow}",
  ],
  "Collateral Damage": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.y38zWkHIGzqyZmGc]{Show the Costs of Collateral Damage}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.y38zWkHIGzqyZmGc]{Inflict Collateral Damage}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.y38zWkHIGzqyZmGc]{Collateral Damage}"
  ],
  "Take Influence over": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.NQfxjpOmX5mqu1Ow]{Take Influence Over}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.NQfxjpOmX5mqu1Ow]{Take Influence Over Someone}"
  ],
  "Tell Them the Possible Consequences—and Ask": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.TxVR9tX5Y50wmTRt]{Tell them the Possible Consequences and Ask}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.TxVR9tX5Y50wmTRt]{Tell them the Possible Consequences}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.TxVR9tX5Y50wmTRt]{Offer a Difficult Choice}",
  ],
  "Tell Them Who They Are or Who They Should Be": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.vbmelu6amDCsv8Xp]{Tell Them Who They Are}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.vbmelu6amDCsv8Xp]{Tell Them Who They Should Be}",
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.vbmelu6amDCsv8Xp]{Tell Them Who They Are or Who They Should Be}",
  ],
  "Turn Their Move Back on Them": [
    "@UUID[Compendium.masks-newgeneration-unofficial.documents.JournalEntry.llXD7GIZiU5z5MiG.JournalEntryPage.EgNc30M2opeJiQOg]{Turn Their Move Back on Them}"
  ],
};

// Default legacy mapping (still used as fallback only)
const ICONS = {
  default: "modules/masks-newgeneration-unofficial/images/gameicons/aura-%23ffffff-%233da7db.svg",
  "Inflict a Condition": "modules/masks-newgeneration-unofficial/images/gameicons/spiky-explosion-%23ffffff-%233da7db.svg",
  "Take Influence over": "modules/masks-newgeneration-unofficial/images/gameicons/distraction-%23ffffff-%233da7db.svg",
  "Put Innocents in Danger": "modules/masks-newgeneration-unofficial/images/gameicons/target-dummy-%23ffffff-%233da7db.svg",
  "Capture Someone": "modules/masks-newgeneration-unofficial/images/gameicons/arrest-%23ffffff-%233da7db.svg",
  "Collateral Damage": "modules/masks-newgeneration-unofficial/images/gameicons/bulldozer-%23ffffff-%233da7db.svg",
  "Tell Them the Possible Consequences—and Ask": "modules/masks-newgeneration-unofficial/images/gameicons/death-note-%23ffffff-%233da7db.svg",
  "Make Them Pay a Price for Victory": "modules/masks-newgeneration-unofficial/images/gameicons/broken-pottery-%23ffffff-%233da7db.svg",
  "Bring Them Together": "modules/masks-newgeneration-unofficial/images/gameicons/team-upgrade-%23ffffff-%233da7db.svg",
  "Reveal the Future": "modules/masks-newgeneration-unofficial/images/gameicons/time-trap-%23ffffff-%233da7db.svg",
  "Announce Between‑Panel Threats": "modules/masks-newgeneration-unofficial/images/gameicons/ringing-alarm-%23ffffff-%233da7db.svg",
  "Activate the Downsides of their Abilities and Relationships": "modules/masks-newgeneration-unofficial/images/gameicons/liar-%23ffffff-%233da7db.svg",
  "Turn Their Move Back on Them": "modules/masks-newgeneration-unofficial/images/gameicons/shield-reflect-%23ffffff-%233da7db.svg",
  "Tell Them Who They Are or Who They Should Be": "modules/masks-newgeneration-unofficial/images/gameicons/philosopher-bust-%23ffffff-%233da7db.svg",
  "Bring an NPC to Rash Decisions and Hard Conclusions": "modules/masks-newgeneration-unofficial/images/gameicons/radar-sweep-%23ffffff-%233da7db.svg",
};

const CONDITION_ICONS = {
  Afraid: "modules/masks-newgeneration-unofficial/images/gameicons/suspicious-%23ffffff-%233da7db.svg",
  Angry: "modules/masks-newgeneration-unofficial/images/gameicons/confrontation-%23ffffff-%233da7db.svg",
  Guilty: "modules/masks-newgeneration-unofficial/images/gameicons/robber-%23ffffff-%233da7db.svg",
  Hopeless: "modules/masks-newgeneration-unofficial/images/gameicons/kneeling-%23ffffff-%233da7db.svg",
  Insecure: "modules/masks-newgeneration-unofficial/images/gameicons/broken-pottery-%23ffffff-%233da7db.svg",
};

const BASE_MOVE_RESULTS = {
  failure: { key: "system.moveResults.failure.value", label: "Complications...", value: "" },
  partial: { key: "system.moveResults.partial.value", label: "Partial success", value: "" },
  success: { key: "system.moveResults.success.value", label: "Success!", value: "" },
};

// Full icon catalog (user-supplied options)
const ALL_MOVE_ICONS = [
  "modules/masks-newgeneration-unofficial/images/gameicons/ages.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/love-letter-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/alien-stare-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/magic-portal-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/american-football-helmet-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/magnifying-glass-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/american-shield-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/medal-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/android-mask-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/melting-metal-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/angry-eyes-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/mesh-network-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/armor-punch-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/metroid-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/arrest-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/mighty-force-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/astronaut-helmet-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/mirror-mirror-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/atlas-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/misdirection-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/attached-shield-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/move-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/aura-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/mug-shot-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/awareness-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/muscle-up-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/barrier-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/newspaper-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/bat-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/open-folder-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/bat-mask-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/open-palm-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/big-gear-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/ouroboros-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/book-pile-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/overdrive-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/booze-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/philosopher-bust-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/bow-arrow-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/phone-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/brain-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/plant-roots-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/brainstorm-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/playbook.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/brodie-helmet-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/pointing-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/broken-bone-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/police-badge-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/broken-pottery-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/popcorn-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/bubble-field-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/prisoner-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/bulldozer-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/processor-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/bullet-impacts-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/progression-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/burning-passion-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/punch-blast-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/candlebright-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/radar-sweep-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/capitol-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/rail-road-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/captain-hat-profile-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/ray-gun-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/cavalry-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/red-carpet-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/cctv-camera-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/regeneration-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/centaur-heart-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/revolt-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/chalk-outline-murder-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/ringed-planet-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/character-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/ringing-alarm-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/charged-arrow-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/robber-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/charging-bull.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/rock-golem-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/checked-shield.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/save-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/chess-knight-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/school-bag-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/cloud-download-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/screaming-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/cold-heart-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/shadow-follower-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/confrontation-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/shaking-hands-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/congress-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/shield-reflect-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/conqueror-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/sitting-dog-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/convince-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/six-eyes-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/crowned-heart-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/skull-crossed-bones-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/cursed-star-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/slingshot-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/cyborg-face-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/smartphone-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/death-note-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/smoking-finger-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/discussion-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/snatch-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/distraction-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/snowflake-1-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/dna1-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/spark-spirit-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/domino-mask-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/spider-mask-%23ff0000-%23000000.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/duality-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/spider-mask-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/dunce-cap-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/spider-web-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/dutch-bike-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/spiky-explosion-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/earth-america-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/spray-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/elevator-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/spy-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/encirclement-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/star-struck-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/energise-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/stigmata-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/enrage-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/sunrise-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/entangled-typhoon-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/supersonic-arrow-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/erlenmeyer-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/surprised-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/eye-target-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/surrounded-shield-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/falling-blob-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/suspicious-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/family-tree-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/talk-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/fire-shield-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/target-dummy-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/flying-flag-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/teacher-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/frankenstein-creature-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/team-downgrade-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/full-motorcycle-helmet-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/team-upgrade-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/gemini-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/telepathy-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/ghost-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/temple-gate-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/grand-piano-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/theater-curtains-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/halt-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/three-friends-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/handcuffed-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/time-trap-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/headphones-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/trash-can-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/hearts-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/treehouse-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/help-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/ufo-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/high-five-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/upgrade-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/kneeling-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/white-book-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/law-star-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/wide-arrow-dunk-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/liar-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/wisdom-%23ffffff-%233da7db.svg",
  "modules/masks-newgeneration-unofficial/images/gameicons/lightning-flame-%23ffffff-%233da7db.svg"
];

const NOW = () => Date.now();

// ------------------------------ UTILS ------------------------------

const cryptoWeb = globalThis.crypto ?? (await import("node:crypto")).webcrypto;

function generate16CharUUID() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(16);
  cryptoWeb.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 16; i++) out += chars[bytes[i] % chars.length];
  return out;
}
function isValid16CharUUID(id) {
  return typeof id === "string" && /^[A-Za-z0-9]{16}$/.test(id);
}
function toSafeFileStub(name) {
  return (name || "NPC").replace(/[^A-Za-z0-9 _-]/g, "_").trim().replace(/\s+/g, "_").slice(0, 80);
}
function ensureSingleParagraphHTML(htmlOrText) {
  if (!htmlOrText) return "<p></p>";
  const s = String(htmlOrText).trim();
  if (s.startsWith("<p>") && s.endsWith("</p>")) return s;
  const stripped = s.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  return `<p>${stripped}</p>`;
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function sanitizeBold(html) {
  return html
    .replace(/<b>\s*<b>/g, "<b>")
    .replace(/<\/b>\s*<\/b>/g, "</b>")
    .replace(/<b>\s*<\/b>/g, "");
}
function pickRandom(arr, n = 1) {
  const copy = [...arr];
  const out = [];
  while (copy.length && out.length < n) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}
function minimatch(filename, glob) {
  if (glob === "*" || !glob) return true;
  if (glob.endsWith("*")) return filename.startsWith(glob.slice(0, -1));
  return filename === glob;
}
async function listFilesRecursively(dir, pattern = "*") {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listFilesRecursively(full, pattern)));
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;
    if (pattern && !minimatch(e.name, pattern)) continue;
    out.push(full);
  }
  return out;
}
async function readTextFile(p) {
  try { return await fsp.readFile(p, "utf8"); }
  catch { return ""; }
}
function stripCodeFences(s) {
  if (typeof s !== "string") return s;
  return s.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
}
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

function chooseIconFromTriggers(triggers = []) {
  for (const t of triggers) if (ICONS[t]) return ICONS[t];
  return ICONS.default;
}

function deriveImagePathHint(text) {
  const m = text.match(/(modules\/te-core-rules\/[^\s"')]+?\.(png|jpg|jpeg|webp|svg))/i)
        || text.match(/(modules\/[^\s"')]+?\.(png|jpg|jpeg|webp|svg))/i);
  return m ? m[1] : null;
}

function buildGmLinkCatalogText() {
  const lines = [];
  for (const key of Object.keys(GM_UUID_MAP)) {
    lines.push(`- ${key}:`);
    for (const s of GM_UUID_MAP[key]) lines.push(`  • ${s}`);
  }
  return lines.join("\n");
}

// ------------------------------ INLINE UUID LINKING (FALLBACK-ONLY) ------------------------------

const GM_ANCHOR_TEXT = {
  "Inflict a Condition": "Inflicting a Condition",
  "Take Influence over": "Taking Influence",
  "Capture Someone": "Capturing Someone",
  "Put Innocents in Danger": "Putting Innocents in Danger",
  "Collateral Damage": "Causing Collateral Damage",
  "Tell Them the Possible Consequences—and Ask": "Stating the Possible Consequences",
  "Make Them Pay a Price for Victory": "Exacting a Price for Victory",
  "Reveal the Future": "Revealing the Future",
  "Announce Between‑Panel Threats": "Announcing Between-Panel Threats",
  "Activate the Downsides of their Abilities and Relationships": "Activating the Downsides of Abilities/Relationships",
  "Turn Their Move Back on Them": "Turning Their Move Back on Them",
  "Tell Them Who They Are or Who They Should Be": "Telling Them Who They Are",
  "Bring an NPC to Rash Decisions and Hard Conclusions": "Driving an NPC to Rash Decisions",
  "Bring Them Together": "Bringing Them Together",
  "Make a Playbook Move": "Making a Playbook Move",
  "Make a Villain Move": "Making a Villain Move",
};

function getUUIDTargetForTrigger(trigger) {
  const list = GM_UUID_MAP[trigger];
  if (!list || !list.length) return null;
  const m = list[0].match(/^@UUID\[(.+?)\]\{.*\}$/);
  return m ? m[1] : null;
}

function buildVariants(trigger, anchor) {
  const base = [trigger, anchor];
  switch (trigger) {
    case "Capture Someone":
      base.push("Capturing Someone");
      break;
    case "Collateral Damage":
      base.push("Showing the Costs of Collateral Damage", "Cause Collateral Damage", "Causing Collateral Damage");
      break;
    case "Take Influence over":
      base.push("Taking Influence over", "Taking Influence");
      break;
    case "Inflict a Condition":
      base.push("Inflicting a Condition");
      break;
    case "Put Innocents in Danger":
      base.push("Putting Innocents in Danger");
      break;
    case "Tell Them the Possible Consequences—and Ask":
      base.push("Possible Consequences", "Stating the Possible Consequences");
      break;
    case "Announce Between‑Panel Threats":
      base.push("Announce Between-Panel Threats", "Announcing Between-Panel Threats");
      break;
    case "Bring Them Together":
      base.push("Bringing Them Together");
      break;
    case "Make Them Pay a Price for Victory":
      base.push("Making Them Pay a Price for Victory", "Pay a Price for Victory", "Exacting a Price for Victory");
      break;
    case "Reveal the Future":
      base.push("Revealing the Future");
      break;
    case "Turn Their Move Back on Them":
      base.push("Turning Their Move Back on Them");
      break;
    case "Tell Them Who They Are or Who They Should Be":
      base.push("Telling Them Who They Are");
      break;
    case "Make a Playbook Move":
      base.push("Making a Playbook Move");
      break;
    case "Make a Villain Move":
      base.push("Making a Villain Move");
      break;
    default:
      break;
  }
  return [...new Set(base.map((s) => String(s)))];
}

/**
 * Fallback linker: only used if the LLM failed to include any @UUID links.
 * The LLM is now responsible for choosing the right UUID and hand-writing {label}.
 */
function embedUUIDLinksInline(htmlWithP, gmTriggers) {
  let wrapped = ensureSingleParagraphHTML(htmlWithP);
  wrapped = sanitizeBold(wrapped);
  const matchP = wrapped.match(/^<p>([\s\S]*?)<\/p>$/i);
  let inner = matchP ? matchP[1] : wrapped;

  const gmList = [...new Set((gmTriggers || []).filter(Boolean))];
  const disallowVillainMove = !gmList.includes("Make a Villain Move");

  const discoveredOrdered = (() => {
    const occurrences = [];
    for (const trig of Object.keys(GM_UUID_MAP)) {
      if (disallowVillainMove && trig === "Make a Villain Move") continue;
      const anchor = GM_ANCHOR_TEXT[trig] || trig;
      const variants = buildVariants(trig, anchor);
      let bestIndex = -1;
      for (const v of variants) {
        const re = new RegExp(`(<b>)?${escapeRegex(v)}(</b>)?`, "i");
        const m = re.exec(inner);
        if (m) { bestIndex = m.index; break; }
      }
      if (bestIndex >= 0) occurrences.push({ trig, index: bestIndex });
    }
    occurrences.sort((a, b) => a.index - b.index);
    return occurrences.map(o => o.trig);
  })();

  const toProcess = [...new Set([...gmList, ...discoveredOrdered])];

  for (const trig of toProcess) {
    const target = getUUIDTargetForTrigger(trig);
    if (!target) continue;

    const anchor = GM_ANCHOR_TEXT[trig] || trig;
    const link = `@UUID[${target}]{${anchor}}`;

    const variants = buildVariants(trig, anchor);
    let replaced = false;
    for (const v of variants) {
      const re = new RegExp(`(<b>)?${escapeRegex(v)}(</b>)?`, "i");
      if (re.test(inner)) {
        inner = inner.replace(re, `<b>${link}</b>`);
        replaced = true;
        break;
      }
    }

    if (!replaced) {
      const punctIdx = inner.search(/[.!?](\s|$)/);
      const insertion = `<b>${link}</b>`;
      if (punctIdx >= 0) {
        inner = inner.slice(0, punctIdx) + (inner[punctIdx - 1] === " " ? "" : " ") + insertion + inner.slice(punctIdx);
      } else {
        inner = inner + (/\s$/.test(inner) ? "" : " ") + insertion;
      }
    }
  }

  const out = `<p>${inner}</p>`;
  return sanitizeBold(out);
}

// ------------------------------ PROMPTS (override via ./resources) ------------------------------

async function loadResource(fileName) {
  const p = path.join(RES_DIR, fileName);
  try {
    const stat = await fsp.stat(p);
    if (stat.isFile()) return await fsp.readFile(p, "utf8");
  } catch { /* ignore */ }
  return null;
}
function renderTemplate(tpl, vars) {
  return tpl.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/gi, (_, key) => String(vars[key] ?? ""));
}

const DEFAULT_ENUMERATE_SYSTEM = `
You design villains for a TTRPG about superheroes and growing up, the game is called Masks: The New Generation and it is based on Powered by The Apocalpyse.
Return JSON ONLY. No prose. No markdown.`;

function defaultEnumerateUser(filePath, content) {
  return `
From the source text, list NPCs to port to Masks NPCs.
For each, provide: name, realName (or null), img (path or null; do not invent), concept (<=20 words),
and optional drive, abilities, biography.

Strict JSON shape:
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

FILE: ${filePath}
CONTENT:
${content.slice(0, 180000)}
`;
}

const DEFAULT_BUILD_SYSTEM = `
You are a senior content designer for "Masks: A New Generation" (PbtA).
Return JSON ONLY. No explanations. No markdown.

Rules:
- Create 3–5 flavorful VILLAIN moves (GM-style narrative, no dice rolls) based on the source material.
- Create 5 CONDITION moves: exactly Afraid, Angry, Guilty, Hopeless, Insecure. Condition moves are how that villain reacts when inflicted with said condition, e.g. how they lash out in anger, how they take out their insecurities, assuage their guilt, etc.
- Every move description must be at least **4–6 full sentences** (max 2 paragraphs).
- Moves should be narrative focused but organized like:
  [triggers if applicable - "Triggers when/if …"]
  [describe soft effects - fictional change that creates pressure]
  [targets - who it's targetting]
  [describe hard effects - If ignored or on a miss/opportunity, [immediate, significant consequence]]
  [prompts, if any for, the team]
- **Inline linking is mandatory:** Each move must incorporate **1–3** allowed GM moves by embedding the exact @UUID link **inline on the GM phrase**, wrapped in <b>…</b>.
  • Choose the UUID from the GM_LINK_CATALOG below.
  • **Hand-write the {label} text** for the link so it is grammatically correct in context (e.g., "{Take Influence}", "{Taking Influence over her}", "{Show the costs of collateral damage}").
  • Do not add out-of-band link blocks or headers; links appear only inline in the prose.
- Allowed GM moves (names): {{GM_TRIGGERS}}. Non-condition villain moves must not reference "Make a Villain Move".
- **Icons:** Any move can use any icon. For each move, pick an "img" from ICON_CATALOG and also provide 2-3 alternate "img_options" from ICON_CATALOG that would fit thematically.
- Check to make sure that the GM moves you reference make sense in context and follow the rules of the game.

GM_LINK_CATALOG (choose targets from here; you may pick the variant that best fits):
{{GM_LINK_CATALOG}}

ICON_CATALOG (choose strings exactly as listed; do not invent new paths):
{{ICON_CATALOG}}

### How to Write Custom Villain Moves

1. **Purpose:** Each move must **escalate the fiction** and **showcase the villain’s idiom** (their style, drive, methods, and humanity).
2. **When They Fire:** Write moves the GM can use **whenever they’d make any GM move** and the villain is involved—**on a miss, during a lull, or when given a golden opportunity**.
3. **Fiction‑First, No Villain Rolls:** Moves **state what happens in fiction**; they **don’t require dice rolls**.
4. **Soft ↔ Hard Dial:** Phrase moves so they can be **soft (set‑up, telegraphed, interruptible)** or **hard (immediate, consequential, cannot be stopped)**. When approprorpiate include a natural **“if ignored, escalate to…”** clause. DO NOT explicitly state if a move is hard or soft.
5. **Address the Heroes as the intended reader:** Write in second person to the characters (not the players). If applicable, prompt a response from players.
6. **Stay on‑Agenda/Principled:** Describe like a comic; misdirect; make threats real; treat human life as meaningful; be a fan of the PCs; remind them of legacies; think between panels; let villains **give up to fight another day**; make supers look outlandish and cool; show adults as shortsighted; support conditionally; ask provocative questions.
7. **Use Core GM Vocabulary:** Express outcomes using or riffing on these GM move families (reflavored to the villain):
   * **Inflict a condition** (name it only when fiction is clear; otherwise “mark a fitting Condition”).
   * **Take Influence over someone** (if already held, **force an immediate Label shift**).
   * **Capture someone** / **separate** / **corner** a target.
   * **Put innocents in danger** (create rescue pressure).
   * **Show the costs of collateral damage** (bill, blame, fallout).
   * **Reveal the future** (visions, foreshadowing, exemplars).
   * **Announce between‑panel threats** (off‑screen actions, looming timers).
   * **Make them pay a price for victory** (bargains, strings, compromise).
   * **Turn their move back on them** (mirror a PC action at full effect).
   * **Tell possible consequences and ask** (spotlight a costly option).
   * **Trade Blows** (prompt a player to retaliate).
   * **Tell them who they are/should be** (push Labels unless Influence is rejected).
   * **Bring an NPC to rash decisions & hard conclusions** (misread, overreact).
   * **Activate downsides of abilities & relationships** (obligations, red tape, fallout).
   * **Make a playbook move** (aim at a specific playbook’s issues).
8. **Offer Real Choices:** Where fitting, embed **costly bargains** (win now at a price later), **strings**, or **spotlight trades** (e.g., “succeed but mark a Condition / cede Influence / break something important”).
9. **Write Clear Triggers:** Begin with a **clean cue**: *“When X happens…”*, *“If the team leaves Y unattended…”*, *“On a PC miss while Z is in play…”*.
10. **One Clear Effect:** Follow with a **single, concrete consequence** tied to the villain’s theme; avoid nested clauses and vague adverbs.
11. **Scene Pressure, Not Shutdowns:** Moves should **create momentum and tension**, not stall the story. If you lock someone down, **open a new problem** for the team to tackle.
12. **Respect Conditions & Labels:** Prefer **Conditions, Influence, Label shifts, separation, time pressure, and collateral stakes** over raw damage or KO.
13. **Between‑Panels Valid:** It’s valid to **announce off‑screen developments** (heists finished, leverage gained) that newly threaten hero interests.
14. **Exit and Return:** Allow for **“retreat to fight another day”** when it fits the villain’s idiom; seed a consequence or a clue.
15. **Humanity & Drive:** Even monstrous villains should have **recognizable motives**. Let a move **hint at their wants, scars, or lines they won’t cross**.
16. **Tie to Setting:** Name **locations, civilians, mentors, teams, and legacy icons** to anchor the move in Halcyon City.
17. **No New Subsystems:** Do **not** invent mini‑games or numeric modifiers beyond core MASKS tools (Conditions, Influence, Labels, Team prompts).
18. **Misdirect, Then Hit:** You can **telegraph** with imagery or taunts; if the heroes don’t act, **follow with a harder consequence**.
19. **Provocative Prompts:** Sprinkle **pointed questions** that invite teen drama: *“Do you accept their view of you?”* *“Whose safety do you prioritize?”*

`;

function defaultBuildUser(npc) {
  return `
NPC:
- Name: ${npc.name}
- Real Name: ${npc.realName ?? ""}
- Image: ${npc.img ?? ""}
- Concept: ${npc.concept ?? ""}
- Drive: ${npc.drive ?? ""}
- Abilities: ${npc.abilities ?? ""}
- Biography: ${npc.biography ?? ""}

Return strictly:
{
  "villainMoves": [
    { "name": "string",
      "description_html": "<p>… embed 1–2 bold inline @UUID[...] links with hand-written {label} …</p>",
      "gm_triggers": ["One or two from the allowed list that are appropriate for the situation"],
      "img": "one string from ICON_CATALOG",
      "img_options": ["other options from ICON_CATALOG"]
    }
  ],
  "conditionMoves": {
    "Afraid":   { "name": "Afraid — <verb phrase>",   "description_html": "<p>…</p>", "gm_triggers": ["…"], "img": "…", "img_options": ["…"] },
    "Angry":    { "name": "Angry — <verb phrase>",    "description_html": "<p>…</p>", "gm_triggers": ["…"], "img": "…", "img_options": ["…"] },
    "Guilty":   { "name": "Guilty — <verb phrase>",   "description_html": "<p>…</p>", "gm_triggers": ["…"], "img": "…", "img_options": ["…"] },
    "Hopeless": { "name": "Hopeless — <verb phrase>", "description_html": "<p>…</p>", "gm_triggers": ["…"], "img": "…", "img_options": ["…"] },
    "Insecure": { "name": "Insecure — <verb phrase>", "description_html": "<p>…</p>", "gm_triggers": ["…"], "img": "…", "img_options": ["…"] }
  },
  "details": {
    "drive": "1–4 short bullets or sentences",
    "abilities": "short HTML allowed, prefer bullet points",
    "biography": "Minimum 3-4 sentences, and as much of the base material verbatim as possible"
  }
}
`;
}

async function getEnumeratePrompts(filePath, content) {
  const sysTpl = (await loadResource("enumerate.system.md")) ?? DEFAULT_ENUMERATE_SYSTEM;
  const usrTpl = (await loadResource("enumerate.user.md")) ?? defaultEnumerateUser(filePath, content);
  const system = renderTemplate(sysTpl, {
    FILE_PATH: filePath,
    CONTENT: content,
    GM_TRIGGERS: GM_TRIGGER_WHITELIST.join(", "),
  });
  const user = renderTemplate(usrTpl, {
    FILE_PATH: filePath,
    CONTENT: content,
    GM_TRIGGERS: GM_TRIGGER_WHITELIST.join(", "),
  });
  return { system, user };
}

async function getBuildPrompts(npc) {
  const sysTpl = (await loadResource("build.system.md")) ?? DEFAULT_BUILD_SYSTEM;
  const usrTpl = (await loadResource("build.user.md")) ?? defaultBuildUser(npc);
  const system = renderTemplate(sysTpl, {
    NPC_NAME: npc.name ?? "",
    NPC_REALNAME: npc.realName ?? "",
    NPC_IMG: npc.img ?? "",
    NPC_CONCEPT: npc.concept ?? "",
    NPC_DRIVE: npc.drive ?? "",
    NPC_ABILITIES: npc.abilities ?? "",
    NPC_BIO: npc.biography ?? "",
    GM_TRIGGERS: GM_TRIGGER_WHITELIST.join(", "),
    GM_LINK_CATALOG: buildGmLinkCatalogText(),
    ICON_CATALOG: JSON.stringify(ALL_MOVE_ICONS, null, 2)
  });
  const user = renderTemplate(usrTpl, {
    NPC_NAME: npc.name ?? "",
    NPC_REALNAME: npc.realName ?? "",
    NPC_IMG: npc.img ?? "",
    NPC_CONCEPT: npc.concept ?? "",
    NPC_DRIVE: npc.drive ?? "",
    NPC_ABILITIES: npc.abilities ?? "",
    NPC_BIO: npc.biography ?? "",
    GM_TRIGGERS: GM_TRIGGER_WHITELIST.join(", "),
  });
  return { system, user };
}

// ------------------------------ OPENROUTER CALL ------------------------------

async function callOpenRouterJSON({ system, user }) {
  const headers = {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (process.env.OPENROUTER_SITE_URL) headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
  if (process.env.OPENROUTER_SITE_NAME) headers["X-Title"] = process.env.OPENROUTER_SITE_NAME;

  const maxAttempts = 5;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
        const ra = parseInt(res.headers.get("retry-after") || "0", 10) || 0;
        const base = Math.min(2 ** attempt * 500, 15000);
        const delay = (ra ? ra * 1000 : base) + Math.floor(Math.random() * 400);
        console.warn(`WARN: OpenRouter ${res.status}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${maxAttempts})`);
        await sleep(delay);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`OpenRouter error ${res.status}: ${text?.slice(0, 400)}`);
      }

      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.content ?? "";
      const raw = Array.isArray(content)
        ? content.map((x) => (typeof x === "string" ? x : x?.text || "")).join("\n")
        : String(content);
      const clean = stripCodeFences(raw);
      if (!clean) throw new Error("Empty JSON response.");
      let parsed;
      try { parsed = JSON.parse(clean); }
      catch {
        const s = clean.indexOf("{"); const e = clean.lastIndexOf("}");
        if (s >= 0 && e > s) parsed = JSON.parse(clean.slice(s, e + 1));
        else throw new Error("Non-JSON response.");
      }
      return parsed;
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const backoff = Math.min(2 ** attempt * 400, 10000) + Math.floor(Math.random() * 400);
      await sleep(backoff);
    }
  }
  throw lastErr ?? new Error("OpenRouter failed.");
}

// ------------------------------ LLM DRIVERS ------------------------------

async function enumerateNPCsFromText(filePath, text) {
  if (!text || text.trim().length < 30) return [];
  const { system, user } = await getEnumeratePrompts(filePath, text);
  const payload = await callOpenRouterJSON({ system, user });
  const list = Array.isArray(payload?.npcs) ? payload.npcs : [];
  const clean = list
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

function coerceGMTriggers(arr) {
  const list = (Array.isArray(arr) ? arr : []).filter((t) => GM_TRIGGER_WHITELIST.includes(t));
  if (!list.length) return ["Inflict a Condition"];
  return list.slice(0, 2);
}

// For non-condition villain moves, disallow “Make a Villain Move”
function sanitizeVillainTriggers(arr) {
  let list = coerceGMTriggers(arr).filter((t) => t !== "Make a Villain Move");
  if (!list.length) list = ["Inflict a Condition"];
  return list;
}

function hasAnyUUIDLink(html) {
  return /@UUID\[[^\]]+\]\{[^}]+\}/.test(String(html || ""));
}

function countSentences(html) {
  const text = String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return 0;
  const matches = text.match(/[.!?](\s|$)/g);
  return matches ? matches.length : (text.length > 0 ? 1 : 0);
}

function padToMinSentences(html, min = 4) {
  let out = String(html || "");
  let c = countSentences(out);
  const fillers = [
    "Between panels, the threat grows in ways you can feel but not entirely see.",
    "If you hesitate, their leverage sharpens and the moment turns against you.",
    "Step up with a cost, or watch the scene tilt toward disaster.",
    "What do you do?"
  ];
  while (c < min) {
    out = ensureSingleParagraphHTML(out).replace(/<\/p>$/, ` ${fillers[Math.min(c, fillers.length - 1)]}</p>`);
    c++;
  }
  return out;
}

function ensureVillainMoves(moves) {
  let out = (Array.isArray(moves) ? moves : []).map((m, idx) => {
    const name = String(m?.name ?? "").trim() || `Villain Gambit ${idx + 1}`;
    const gm_triggers = sanitizeVillainTriggers(m?.gm_triggers);
    let desc = String(m?.description_html ?? "").trim();
    desc = ensureSingleParagraphHTML(desc);
    // Enforce min length
    desc = padToMinSentences(desc, 4);
    // If the LLM failed to include any UUID links, fallback to auto-embed
    if (!hasAnyUUIDLink(desc)) {
      desc = embedUUIDLinksInline(desc, gm_triggers);
    }
    // Icon selection from LLM (fallback to trigger-based)
    const img = ALL_MOVE_ICONS.includes(m?.img) ? m.img : chooseIconFromTriggers(gm_triggers);
    const img_options = Array.isArray(m?.img_options) ? m.img_options.filter((p) => ALL_MOVE_ICONS.includes(p)).slice(0, 8) : [];

    return { name, gm_triggers, description_html: sanitizeBold(desc), img, img_options };
  }).filter((m) => m.name && m.description_html);

  if (out.length < 3) {
    while (out.length < 3) {
      const gm_triggers = ["Inflict a Condition"];
      let desc = "<p>An ugly opportunity opens and the villain presses hard, daring you to accept a cost to keep anyone safe.</p>";
      desc = padToMinSentences(desc, 4);
      out.push({
        name: `Villain Gambit ${out.length + 1}`,
        gm_triggers,
        description_html: embedUUIDLinksInline(desc, gm_triggers),
        img: chooseIconFromTriggers(gm_triggers),
        img_options: pickRandom(ALL_MOVE_ICONS, 5)
      });
    }
  } else if (out.length > 5) {
    out = out.slice(0, 5);
  }
  return out;
}

function ensureConditionMoves(cond) {
  const keys = ["Afraid", "Angry", "Guilty", "Hopeless", "Insecure"];
  const defaults = {
    Afraid: {
      name: "Afraid — Flinch from the Blow",
      gm_triggers: ["Put Innocents in Danger"],
      description_html: "<p>You catch the danger a heartbeat too late and your guard slips. A civilian cries out as the threat veers toward them. Your fear writes the next panel unless you step in. If you turn away, the moment narrows into a cruel choice. What do you do?</p>",
      img: CONDITION_ICONS.Afraid
    },
    Angry: {
      name: "Angry — Smash First, Ask Later",
      gm_triggers: ["Collateral Damage"],
      description_html: "<p>Your temper leaps faster than your plan and the scene fractures around you. A signpost bends, a window bursts, and blame starts to find a target with your face on it. The villain grins as consequences gather like stormclouds. If you don't redirect, the fallout will land somewhere that matters. What do you do?</p>",
      img: CONDITION_ICONS.Angry
    },
    Guilty: {
      name: "Guilty — Overcorrect in Public",
      gm_triggers: ["Take Influence over"],
      description_html: "<p>You're already apologizing as you move, handing the narrative to an onlooker who wants to define you. Their words bite deeper than any jab, and your body follows that script. The opening they wanted appears between panels. If you don't push back, you'll carry their label out of this scene. What do you do?</p>",
      img: CONDITION_ICONS.Guilty
    },
    Hopeless: {
      name: "Hopeless — Fade Between Panels",
      gm_triggers: ["Make Them Pay a Price for Victory"],
      description_html: "<p>You can see the win from here, but it's laughably out of reach without shedding something now. The villain sets the stakes on the table with a practiced flick. Your hesitation gives them minutes you don't have. Refuse the cost and they'll set the terms of the next page. What do you do?</p>",
      img: CONDITION_ICONS.Hopeless
    },
    Insecure: {
      name: "Insecure — Second‑Guess and Stall",
      gm_triggers: ["Tell Them the Possible Consequences—and Ask"],
      description_html: "<p>Your doubts stack like panels, slowing everything you touch. The risks line up and glare back until they feel inevitable. The villain notices and starts framing the scene to their advantage. If you won't decide, someone else will decide for you. What do you do?</p>",
      img: CONDITION_ICONS.Insecure
    },
  };

  const out = {};
  for (const k of keys) {
    const m = cond?.[k] ?? {};
    const name = String(m?.name ?? "").trim() || defaults[k].name;
    const gm_triggers = coerceGMTriggers(m?.gm_triggers?.length ? m.gm_triggers : defaults[k].gm_triggers);
    let baseDesc = String(m?.description_html ?? "").trim() || defaults[k].description_html;
    baseDesc = ensureSingleParagraphHTML(baseDesc);
    baseDesc = padToMinSentences(baseDesc, 4);
    const description_html = hasAnyUUIDLink(baseDesc) ? sanitizeBold(baseDesc) : embedUUIDLinksInline(baseDesc, gm_triggers);
    const img = ALL_MOVE_ICONS.includes(m?.img) ? m.img : (defaults[k].img || chooseIconFromTriggers(gm_triggers));
    const img_options = Array.isArray(m?.img_options) ? m.img_options.filter((p) => ALL_MOVE_ICONS.includes(p)).slice(0, 8) : pickRandom(ALL_MOVE_ICONS, 5);
    out[k] = { name, gm_triggers, description_html, img, img_options };
  }
  return out;
}

async function generateNPCMoves(npc) {
  const { system, user } = await getBuildPrompts(npc);
  const payload = await callOpenRouterJSON({ system, user });
  const villainMoves = ensureVillainMoves(payload?.villainMoves);
  const conditionMoves = ensureConditionMoves(payload?.conditionMoves);
  const details = {
    drive: String(payload?.details?.drive ?? npc.drive ?? "").trim(),
    abilities: String(payload?.details?.abilities ?? npc.abilities ?? "").trim(),
    biography: String(payload?.details?.biography ?? npc.biography ?? "").trim(),
  };
  return { villainMoves, conditionMoves, details };
}

// ------------------------------ TEMPLATE / ACTOR BUILD ------------------------------

async function loadTemplate() {
  const raw = await fsp.readFile(TEMPLATE_PATH, "utf8");
  return JSON.parse(raw);
}

function buildMoveItem({ name, moveType, description_html, icon, sort = 0, flags = {} }) {
  const id = generate16CharUUID();
  const t = NOW();
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
    flags,
    _stats: {
      compendiumSource: null,
      duplicateSource: null,
      exportSource: null,
      coreVersion: "13.350",
      systemId: "pbta",
      systemVersion: "1.1.22",
      lastModifiedBy: null,
      createdTime: t,
      modifiedTime: t
    },
    ownership: { default: 0 }
  };
}

function baselineGMMovesParaphrased() {
  // Preserve GM options (names mirror the sample; text paraphrased)
  return [
    {
      name: "Inflict a Condition",
      text: "Lean on the fiction and <b>Inflict a Condition</b> unless a costly compromise is accepted.",
      icon: ICONS["Inflict a Condition"],
    },
    {
      name: "Take Influence",
      text: "Frame the moment so a rival or adult can <b>Take Influence over</b>, or the target marks a fitting Condition to resist.",
      icon: ICONS["Take Influence over"],
    },
    {
      name: "Capture",
      text: "Separate or restrain a target—avoid it only by conceding position, time, or assets. <b>Capture Someone</b>.",
      icon: ICONS["Capture Someone"],
    },
    {
      name: "Put Innocents in Danger",
      text: "Shift the spotlight to bystanders and <b>Put Innocents in Danger</b>, forcing a split or hard choice.",
      icon: ICONS["Put Innocents in Danger"],
    },
    {
      name: "Collateral Damage",
      text: "Make fallout immediate and visible; gear cracks, structures fail—<b>Collateral Damage</b>.",
      icon: ICONS["Collateral Damage"],
    },
    {
      name: "Tell Them Possible Consequences and Ask",
      text: "Lay out the stakes clearly and <b>Tell Them the Possible Consequences—and Ask</b> if they proceed.",
      icon: ICONS["Tell Them the Possible Consequences—and Ask"],
    },
  ];
}

/**
 * Ensure Foundry DB-required keys/timestamps exist.
 */
function finalizeFoundryKeys(actor) {
  if (!actor || !actor._id) return actor;
  const now = NOW();

  // Actor DB key + timestamps
  actor._key = `!actors!${actor._id}`;
  if (!actor._stats) actor._stats = {};
  if (actor._stats.createdTime == null) actor._stats.createdTime = now;
  actor._stats.modifiedTime = now;
  if (!("lastModifiedBy" in actor._stats)) actor._stats.lastModifiedBy = null;

  // Ensure prototype token uses the actor image if we have one
  if (actor.prototypeToken?.texture && actor.img) {
    actor.prototypeToken.texture.src = actor.img;
  }

  // Items: DB keys + timestamps
  for (const it of actor.items ?? []) {
    if (!it._id || !isValid16CharUUID(it._id)) it._id = generate16CharUUID();
    it._key = `!actors.items!${actor._id}.${it._id}`;
    if (!it._stats) it._stats = {};
    if (it._stats.createdTime == null) it._stats.createdTime = now;
    it._stats.modifiedTime = now;
    if (!("lastModifiedBy" in it._stats)) it._stats.lastModifiedBy = null;
  }

  // Default sort if absent
  if (typeof actor.sort !== "number") actor.sort = 100000;

  return actor;
}

function buildActorFromTemplate(template, npc, llm) {
  const actor = deepClone(template);

  // Fresh actor id & name
  actor._id = generate16CharUUID();
  actor.name = npc.name || "Unnamed Villain";

  // Image
  const derived = deriveImagePathHint(npc._sourceText || "");
  actor.img = npc.img || derived || "icons/svg/mystery-man.svg";

  // Real name
  if (actor?.system?.attributes?.realName) {
    actor.system.attributes.realName.value = npc.realName || npc.name || "";
  }

  // Optional details
  if (actor?.system?.details) {
    if (actor.system.details.drive)     actor.system.details.drive.value     = llm.details.drive || "";
    if (actor.system.details.abilities) actor.system.details.abilities.value = llm.details.abilities || "";
    if (actor.system.details.biography) actor.system.details.biography.value = llm.details.biography || "";
  }

  // Stats
  if (actor?._stats) {
    actor._stats.coreVersion = "13.350";
    actor._stats.systemId = "pbta";
    actor._stats.systemVersion = "1.1.22";
    actor._stats.createdTime = NOW();
    actor._stats.modifiedTime = NOW();
    actor._stats.lastModifiedBy = null;
  }

  // Rebuild items from scratch
  actor.items = [];
  let sort = 0;

  // Villain moves (LLM-supplied inline UUID links + LLM-chosen icons)
  for (const vm of llm.villainMoves) {
    const chosenIcon = vm.img || chooseIconFromTriggers(vm.gm_triggers);
    console.log(`    • Icon for move "${vm.name}": ${chosenIcon}`);
    if (vm.img_options?.length) console.log(`      icon options: ${vm.img_options.join(", ")}`);

    actor.items.push(
      buildMoveItem({
        name: vm.name,
        moveType: "villain",
        description_html: vm.description_html,
        icon: chosenIcon,
        sort: (sort += 10),
        flags: { ai: { chosenImg: chosenIcon, imgOptions: vm.img_options || [], gmTriggers: vm.gm_triggers } }
      })
    );
  }

  // Condition moves (LLM-supplied inline UUID links + LLM-chosen icons)
  for (const cname of ["Afraid", "Angry", "Guilty", "Hopeless", "Insecure"]) {
    const cm = llm.conditionMoves[cname];
    const chosenIcon = cm.img || CONDITION_ICONS[cname] || ICONS.default;
    console.log(`    • Icon for condition "${cm.name}": ${chosenIcon}`);
    if (cm.img_options?.length) console.log(`      icon options: ${cm.img_options.join(", ")}`);

    actor.items.push(
      buildMoveItem({
        name: cm.name,
        moveType: "condition",
        description_html: cm.description_html,
        icon: chosenIcon,
        sort: (sort += 10),
        flags: { ai: { chosenImg: chosenIcon, imgOptions: cm.img_options || [], gmTriggers: cm.gm_triggers } }
      })
    );
  }

  // Baseline GM options (preserved; no UUID linking here)
  for (const gm of baselineGMMovesParaphrased()) {
    actor.items.push(
      buildMoveItem({
        name: gm.name,
        moveType: "",
        description_html: ensureSingleParagraphHTML(gm.text),
        icon: gm.icon,
        sort: (sort += 10),
      })
    );
  }

  // ← stamp DB keys and final timestamps
  finalizeFoundryKeys(actor);
  return actor;
}

// ------------------------------ FILE PIPELINE ------------------------------

async function processFile(template, filePath) {
  console.log(`\n— Processing: ${filePath}`);
  const text = await readTextFile(filePath);
  if (!text) {
    console.warn(`WARN: Empty or unreadable: ${filePath}`);
    return;
  }

  let npcs = [];
  try {
    npcs = await enumerateNPCsFromText(filePath, text);
  } catch (e) {
    console.warn(`WARN: Enumerate failed (${path.basename(filePath)}): ${e.message}`);
    return;
  }
  if (!npcs.length) {
    console.warn(`WARN: No NPCs found in ${filePath}.`);
    return;
  }

  // ONE FILE = ONE VILLAIN (take the first only)
  if (npcs.length > 1) {
    console.warn(`WARN: Multiple NPCs detected in ${path.basename(filePath)}; only the first will be ported for this file.`);
  }
  const npc = npcs[0];

  try {
    console.log(`  • Porting NPC: ${npc.name}`);
    const llm = await generateNPCMoves(npc);
    const actor = buildActorFromTemplate(template, npc, llm);

    if (!isValid16CharUUID(actor._id)) {
      const newId = generate16CharUUID();
      console.warn(`    WARN: Actor ID invalid; reminting ${actor._id} → ${newId}`);
      actor._id = newId;
      finalizeFoundryKeys(actor); // re-stamp keys if id changed
    }

    const fname = `npc_${toSafeFileStub(actor.name)}_${actor._id}.json`;
    const outPath = path.join(OUT_DIR, fname);
    if (!DRY_RUN) {
      await fsp.mkdir(OUT_DIR, { recursive: true });
      await fsp.writeFile(outPath, JSON.stringify(actor, null, 2), "utf8");
    }
    console.log(`    ✓ ${DRY_RUN ? "(dry) " : ""}${outPath}`);
  } catch (e) {
    console.warn(`  WARN: Failed to port "${npc?.name ?? "unknown"}" from ${path.basename(filePath)}: ${e.message}`);
  }
}

async function runWithConcurrency(tasks, limit) {
  const results = [];
  let idx = 0, active = 0;
  return new Promise((resolve) => {
    const next = () => {
      if (idx >= tasks.length && active === 0) return resolve(results);
      while (active < limit && idx < tasks.length) {
        const i = idx++; active++;
        tasks[i]().then((r) => results.push(r)).catch(() => results.push(null)).finally(() => { active--; next(); });
      }
    };
    next();
  });
}

// ------------------------------ MAIN ------------------------------

async function main() {
  console.log("Masks NPC Porter — OpenRouter");
  console.log(`Model:        ${MODEL}`);
  console.log(`Input dir:    ${IN_DIR}`);
  console.log(`Output dir:   ${OUT_DIR}${DRY_RUN ? " (dry run)" : ""}`);
  console.log(`Template:     ${TEMPLATE_PATH}`);
  console.log(`Resources:    ${RES_DIR}`);
  console.log(`Concurrency:  ${CONCURRENCY}`);
  console.log(`File pattern: ${FILE_PATTERN}`);
  console.log("Note: Only .txt and .md files are processed.");
  console.log("Note: One input file will produce exactly one villain JSON.");

  let template;
  try { template = await loadTemplate(); }
  catch (e) {
    console.error(`ERROR: Could not read template ${TEMPLATE_PATH}: ${e.message}`);
    process.exit(1);
  }

  let files = [];
  try { files = await listFilesRecursively(IN_DIR, FILE_PATTERN); }
  catch (e) {
    console.error(`ERROR: Could not read input directory: ${e.message}`);
    process.exit(1);
  }

  if (!files.length) {
    console.warn("WARN: No input files found.");
    return;
  }

  const tasks = files.map((f) => () => processFile(template, f));
  await runWithConcurrency(tasks, CONCURRENCY);
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});

