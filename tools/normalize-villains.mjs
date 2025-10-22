#!/usr/bin/env node
// Updates villain JSONs in-place:
// 1) Title-cases "name"
// 2) Sets "img" using tools/villain-numbers.txt mapping
//
// Usage:
//   node ./tools/apply-villain-names-and-images.mjs [--dry]
//
// Notes:
// - Mapping file format (case-insensitive match by name):
//     VORTEX 16
//     COLD SNAP 26
// - Also updates prototypeToken.name and prototypeToken.texture.src if they exist.

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const VILLAINS_DIR = path.join(ROOT, "src", "packs", "villains");
const MAP_PATH = path.join(ROOT, "tools", "villain-numbers.txt");
const IMG_PREFIX = "modules/masks-newgeneration-extensions/images/villains";
const DRY = process.argv.includes("--dry");

function normalizeName(n) {
  return String(n || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function cap(word) {
  return word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word;
}
function titleCase(s) {
  // Capitalize each space- or hyphen-delimited token
  return String(s || "")
    .split(/\s+/)
    .filter(Boolean)
    .map(tok => tok.split("-").map(cap).join("-"))
    .join(" ");
}

async function parseMapping(file) {
  const text = await fs.readFile(file, "utf8");
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(.+?)\s+(\d+)\s*$/);
    if (!m) {
      console.warn(`[warn] could not parse line: "${line}"`);
      continue;
    }
    const name = normalizeName(m[1]);
    const num = m[2];
    map.set(name, num);
  }
  return map;
}

async function main() {
  const mapping = await parseMapping(MAP_PATH);

  const files = (await fs.readdir(VILLAINS_DIR))
    .filter(f => f.endsWith(".json"));

  let updated = 0;

  for (const file of files) {
    const full = path.join(VILLAINS_DIR, file);
    let data;
    try {
      data = JSON.parse(await fs.readFile(full, "utf8"));
    } catch (e) {
      console.warn(`[skip] ${file}: invalid JSON (${e.message})`);
      continue;
    }
    if (!data || typeof data !== "object") {
      console.warn(`[skip] ${file}: not an object`);
      continue;
    }

    const oldName = data.name || "";
    const newName = titleCase(oldName);

    const key = normalizeName(oldName);
    const num = mapping.get(key);

    let imgChanged = false;
    let newImg = data.img;
    if (num) {
      newImg = `${IMG_PREFIX}/${num}.png`;
      imgChanged = true;
    }

    // Apply changes
    data.name = newName;

    // Keep token in sync (safe no-ops if missing)
    if (data.prototypeToken && typeof data.prototypeToken === "object") {
      if (typeof data.prototypeToken.name === "string") {
        data.prototypeToken.name = newName;
      }
      if (
        imgChanged &&
        data.prototypeToken.texture &&
        typeof data.prototypeToken.texture.src === "string"
      ) {
        data.prototypeToken.texture.src = newImg;
      }
    }

    if (imgChanged) data.img = newImg;

    if (DRY) {
      console.log(
        `[dry] ${file}: "${oldName}" -> "${newName}"` +
        (imgChanged ? `, img -> ${newImg}` : ", img unchanged (no mapping)")
      );
    } else {
      await fs.writeFile(full, JSON.stringify(data, null, 2) + "\n", "utf8");
      console.log(
        `✓ ${file}: "${oldName}" -> "${newName}"` +
        (imgChanged ? `, img -> ${newImg}` : ", img unchanged (no mapping)")
      );
      updated++;
    }
  }

  if (!DRY) console.log(`Done. Updated ${updated} file(s).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
