#!/usr/bin/env node
// Walks data/sources.json (IIIF Collections and/or Manifests), figures out which
// canvases already have an Allmaps georeference annotation, and merges the result
// into data/status.json — without ever clobbering human-set `hasMap` values.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SOURCES_PATH = path.join(ROOT, "data", "sources.json");
const STATUS_PATH = path.join(ROOT, "data", "status.json");

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const contentType = res.headers.get("content-type") || "";
  if (!res.ok || !contentType.includes("json")) {
    throw new Error(
      `${res.status} ${res.statusText} fetching ${url}` +
        (contentType.includes("html") ? " (got HTML — likely a bot-protection page; see README)" : "")
    );
  }
  return res.json();
}

function label(value, fallback = "") {
  if (!value) return fallback;
  if (typeof value === "string") return value;
  // IIIF v3 language map: { en: ["..."] } — grab the first value of the first language.
  const firstLang = Object.values(value)[0];
  return Array.isArray(firstLang) ? firstLang.join(" ") : fallback;
}

// --- IIIF Collection -> list of { id, label } manifest refs (v2 or v3) ---
function manifestRefsFromCollection(collection) {
  const items = collection.items || collection.manifests || [];
  return items
    .filter((item) => (item.type || item["@type"] || "Manifest").includes("Manifest"))
    .map((item) => ({
      id: item.id || item["@id"],
      label: label(item.label, item.id || item["@id"]),
    }));
}

// --- IIIF Manifest -> list of canvases (v2 or v3) ---
function canvasesFromManifest(manifest) {
  const canvases =
    manifest.items /* v3 */ ||
    (manifest.sequences && manifest.sequences[0] && manifest.sequences[0].canvases) /* v2 */ ||
    [];

  return canvases.map((canvas) => {
    const id = canvas.id || canvas["@id"];
    let thumbnail = null;
    if (canvas.thumbnail && canvas.thumbnail[0]) {
      thumbnail = canvas.thumbnail[0].id || canvas.thumbnail[0]["@id"];
    } else if (canvas.images && canvas.images[0]) {
      // v2 fallback: use the full image resource as a stand-in thumbnail.
      const resource = canvas.images[0].resource;
      thumbnail = resource && (resource.id || resource["@id"]);
    }
    return {
      id,
      label: label(canvas.label, id),
      thumbnail,
    };
  });
}

// --- Allmaps Annotations API ---
//
// Georeference annotations don't expose the canvas id directly on `target`.
// A real annotation (from https://annotations.allmaps.org/maps?...) looks like:
//
//   target: {
//     type: "SpecificResource",
//     source: {
//       id: "<image service id>", type: "ImageService2",
//       partOf: [{ id: "<canvas id>", type: "Canvas",
//                  partOf: [{ id: "<manifest id>", type: "Manifest" }] }]
//     }
//   }
//
// Occasionally `target.source` is the Canvas itself (no ImageService wrapper).
// There is no working per-manifest endpoint for arbitrary (non-Allmaps-registered)
// manifests, so instead we pull every georeferenced map for the collection's
// domain via /maps?manifestDomain=..., paginated with modifiedBefore.
function canvasAndManifestIdFromAnnotation(annotation) {
  const source = annotation.target?.source;
  if (!source || typeof source !== "object") return {};

  if (source.type === "Canvas") {
    return { canvasId: source.id, manifestId: source.partOf?.[0]?.id };
  }
  const canvas = source.partOf?.[0];
  return { canvasId: canvas?.id, manifestId: canvas?.partOf?.[0]?.id };
}

async function fetchGeoreferencedMapsForDomain(domain) {
  // canvasId -> { annotationId, manifestId }
  const result = new Map();
  const seenAnnotationIds = new Set();
  let modifiedBefore = null;
  const LIMIT = 200;

  for (let page = 0; page < 200; page++) {
    const params = new URLSearchParams({ manifestDomain: domain, limit: String(LIMIT) });
    if (modifiedBefore) params.set("modifiedBefore", modifiedBefore);
    const url = `https://annotations.allmaps.org/maps?${params}`;
    const annotationPage = await fetchJson(url);
    const items = annotationPage.items || [];
    if (items.length === 0) break;

    for (const annotation of items) {
      if (seenAnnotationIds.has(annotation.id)) continue;
      seenAnnotationIds.add(annotation.id);
      const { canvasId, manifestId } = canvasAndManifestIdFromAnnotation(annotation);
      if (canvasId) result.set(canvasId, { annotationId: annotation.id, manifestId });
    }

    if (items.length < LIMIT) break;
    modifiedBefore = items[items.length - 1].modified;
  }

  return result;
}

// TAMU's "compound object" items (behavior: ["individuals"], e.g. multi-sheet
// folios) return a stub with no `items` at /metadata/iiifmanifest/default.jsonld.
// Their real manifest lives at /metadata/iiifmanifest3cws_multiple/default.jsonld,
// which — like the Collection endpoint — sits behind a Cloudflare managed
// challenge that only a real browser page load can pass (not even an in-page
// fetch() from an already-trusted tab). We don't try to defeat that here; we
// just detect the stub and flag the manifest as incomplete instead of silently
// reporting 0 canvases, which would look like "nothing to review."
function isLikelyCompoundStub(manifest, canvases) {
  return canvases.length === 0 && (manifest.behavior || []).includes("individuals");
}

async function buildManifestRecord(manifestRef, georeferencedByCanvasId, existingManifest, compoundCanvasesByManifestId) {
  console.log(`  manifest: ${manifestRef.label} (${manifestRef.id})`);
  const manifest = await fetchJson(manifestRef.id);
  let canvases = canvasesFromManifest(manifest);
  let incomplete = isLikelyCompoundStub(manifest, canvases);

  if (incomplete && compoundCanvasesByManifestId?.has(manifestRef.id)) {
    canvases = compoundCanvasesByManifestId.get(manifestRef.id);
    incomplete = false;
  } else if (incomplete) {
    console.warn(`  ! ${manifestRef.label}: compound object, canvases not retrievable without a browser (see README)`);
  }

  const existingCanvasesById = new Map((existingManifest?.canvases || []).map((c) => [c.id, c]));

  const mergedCanvases = canvases.map((canvas) => {
    const existing = existingCanvasesById.get(canvas.id);
    const georeferenced = georeferencedByCanvasId.get(canvas.id);
    return {
      id: canvas.id,
      label: canvas.label,
      thumbnail: canvas.thumbnail,
      georeferenced: Boolean(georeferenced),
      annotationId: georeferenced?.annotationId ?? null,
      // hasMap is human-curated: preserve whatever was already recorded, default to null (unreviewed).
      hasMap: existing ? existing.hasMap : null,
      notes: existing?.notes || "",
    };
  });

  return {
    id: manifestRef.id,
    label: label(manifest.label, manifestRef.label),
    canvases: mergedCanvases,
    incomplete,
  };
}

async function loadCollection(source) {
  if (source.collectionFile) {
    const filePath = path.join(ROOT, "data", source.collectionFile);
    return JSON.parse(await readFile(filePath, "utf8"));
  }
  return fetchJson(source.url);
}

// Optional per-source supplemental cache: real canvas lists for "compound object"
// manifests (see isLikelyCompoundStub), fetched out-of-band via a real browser
// session and saved as cache/<...>.json: [{ manifestId, label, canvases }, ...].
async function loadCompoundCanvases(source) {
  if (!source.compoundCanvasFile) return null;
  const filePath = path.join(ROOT, "data", source.compoundCanvasFile);
  const entries = JSON.parse(await readFile(filePath, "utf8"));
  return new Map(entries.map((entry) => [entry.manifestId, entry.canvases]));
}

async function main() {
  const sources = JSON.parse(await readFile(SOURCES_PATH, "utf8"));

  let existingStatus = { collections: [] };
  try {
    existingStatus = JSON.parse(await readFile(STATUS_PATH, "utf8"));
  } catch {
    // no existing status.json yet — start fresh
  }
  const existingCollectionsById = new Map((existingStatus.collections || []).map((c) => [c.id, c]));

  const collections = [];

  for (const source of sources) {
    console.log(`collection/source: ${source.label} (${source.id})`);
    const existingCollection = existingCollectionsById.get(source.id);
    const existingManifestsById = new Map((existingCollection?.manifests || []).map((m) => [m.id, m]));

    let manifestRefs;
    if (source.type === "manifest") {
      manifestRefs = [{ id: source.url, label: source.label }];
    } else {
      const collection = await loadCollection(source);
      manifestRefs = manifestRefsFromCollection(collection);
    }

    const compoundCanvasesByManifestId = await loadCompoundCanvases(source);

    const domain = source.annotationsDomain || new URL(source.url).hostname;
    console.log(`  fetching georeferenced maps for domain ${domain} ...`);
    const georeferencedByCanvasId = await fetchGeoreferencedMapsForDomain(domain);
    console.log(`  found ${georeferencedByCanvasId.size} georeferenced canvases on ${domain}`);

    const manifests = [];
    for (const ref of manifestRefs) {
      try {
        manifests.push(
          await buildManifestRecord(ref, georeferencedByCanvasId, existingManifestsById.get(ref.id), compoundCanvasesByManifestId)
        );
      } catch (err) {
        console.warn(`  ! skipping manifest ${ref.id}: ${err.message}`);
      }
    }

    collections.push({ id: source.id, label: source.label, manifests });
  }

  const status = { generatedAt: new Date().toISOString(), collections };
  await writeFile(STATUS_PATH, JSON.stringify(status, null, 2) + "\n");
  console.log(`\nWrote ${STATUS_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
