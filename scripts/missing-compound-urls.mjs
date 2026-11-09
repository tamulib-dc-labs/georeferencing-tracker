#!/usr/bin/env node
// Prints the iiifmanifest3cws_multiple URLs for a source's "compound object" manifests
// that are NOT yet in its compoundCanvasFile cache — i.e. the ones still needed.
// Usage: node scripts/missing-compound-urls.mjs <sourceId>

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const sourceId = process.argv[2];
if (!sourceId) {
  console.error("Usage: node scripts/missing-compound-urls.mjs <sourceId>");
  process.exit(1);
}

const sources = JSON.parse(await readFile(path.join(ROOT, "data", "sources.json"), "utf8"));
const source = sources.find((s) => s.id === sourceId);
if (!source) {
  console.error(`No source with id "${sourceId}" in data/sources.json`);
  process.exit(1);
}

const status = JSON.parse(await readFile(path.join(ROOT, "data", "status.json"), "utf8"));
const collection = status.collections.find((c) => c.id === sourceId);
if (!collection) {
  console.error(`No collection "${sourceId}" in data/status.json — run npm run fetch first`);
  process.exit(1);
}

let known = new Set();
if (source.compoundCanvasFile) {
  const cache = JSON.parse(await readFile(path.join(ROOT, "data", source.compoundCanvasFile), "utf8"));
  known = new Set(cache.map((entry) => entry.manifestId));
}

const stillIncomplete = collection.manifests.filter((m) => m.incomplete && !known.has(m.id));
const urls = stillIncomplete.map((m) => m.id.replace("/iiifmanifest/", "/iiifmanifest3cws_multiple/"));

console.error(`${urls.length} manifests still need fetching for "${sourceId}".`);
console.log(JSON.stringify(urls));
