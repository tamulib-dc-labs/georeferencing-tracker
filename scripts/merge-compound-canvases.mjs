#!/usr/bin/env node
// Merges newly-fetched compound-object canvas data (see README "Compound objects")
// into a source's compoundCanvasFile cache, deduped by manifestId.
// Usage: node scripts/merge-compound-canvases.mjs <sourceId> <path-to-fetched.json>

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const [sourceId, fetchedPath] = process.argv.slice(2);
if (!sourceId || !fetchedPath) {
  console.error("Usage: node scripts/merge-compound-canvases.mjs <sourceId> <path-to-fetched.json>");
  process.exit(1);
}

const sources = JSON.parse(await readFile(path.join(ROOT, "data", "sources.json"), "utf8"));
const source = sources.find((s) => s.id === sourceId);
if (!source || !source.compoundCanvasFile) {
  console.error(`Source "${sourceId}" has no compoundCanvasFile configured in data/sources.json`);
  process.exit(1);
}

const cacheFilePath = path.join(ROOT, "data", source.compoundCanvasFile);
let existing = [];
try {
  existing = JSON.parse(await readFile(cacheFilePath, "utf8"));
} catch {
  // no cache yet
}

const fetched = JSON.parse(await readFile(path.resolve(fetchedPath), "utf8"));

const byManifestId = new Map(existing.map((entry) => [entry.manifestId, entry]));
let added = 0;
let updated = 0;
let errored = 0;
for (const entry of fetched) {
  if (entry.error) {
    errored++;
    continue;
  }
  if (byManifestId.has(entry.manifestId)) updated++;
  else added++;
  byManifestId.set(entry.manifestId, entry);
}

const merged = [...byManifestId.values()];
await writeFile(cacheFilePath, JSON.stringify(merged, null, 2) + "\n");

console.log(`${cacheFilePath}: ${added} added, ${updated} updated, ${errored} skipped (errors), ${merged.length} total.`);
console.log(`Now run: npm run fetch`);
