#!/usr/bin/env node
// Craft pass #2, Part 1 — synced-lyrics -> per-track vocal-activity map
// pipeline. For each crate track: reuse scripts/suggest-cues.mjs's exact
// crate-listing/name-cleaning/matching/lrclib-cache plumbing (same
// GOOGLE_API_KEY-first, crate-manifest.json-fallback, friendly-exit-if-
// neither precedence, same .cache/lrclib/ cache — a rerun of this script
// after suggest-cues.mjs has already run for a track costs zero network
// calls, since both scripts request the exact same lrclib URLs), then derive
// vocal-active intervals from the FULL synced-lyrics line list (not just the
// small call-response subset suggest-cues.mjs extracts) via
// src/lib/vocal-map.ts's buildVocalIntervalsFromLines(). Writes
// src/data/vocal-maps.json, keyed the same way (cueTrackKey) as
// src/data/cue-suggestions.json.
//
// Rerunnable/idempotent, same posture as suggest-cues.mjs: a rerun after
// adding new crate tracks only hits the network for tracks whose lrclib
// query URLs aren't already cached.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { filterAudioFiles, mergeDrivePages, resolveListingSource, manifestToListing } from "../src/lib/crate.ts";
import { cueTrackKey } from "../src/lib/cue-store.ts";
import { cleanTrackName, buildQueryVariants, pickBestMatch, parseSyncedLyrics } from "../src/lib/lyrics-match.ts";
import { buildVocalIntervalsFromLines } from "../src/lib/vocal-map.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_PATH = path.join(REPO_ROOT, "src", "data", "vocal-maps.json");
const MANIFEST_PATH = path.join(REPO_ROOT, "src", "data", "crate-manifest.json");
const CACHE_DIR = path.join(REPO_ROOT, ".cache", "lrclib");

const DRIVE_PAGE_SIZE = 1000;

const LRCLIB_BASE = "https://lrclib.net/api";
const USER_AGENT = "dj-supermercado-vocal-map-builder/1.0 (personal-use local DJ tool, no public repo)";
const RATE_LIMIT_DELAY_MS = 250; // only applied on real network calls, never on cache hits

const MAX_VARIANTS_PER_TRACK = 6;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- .env.local (identical hand-rolled parser to suggest-cues.mjs — never logs values) ---
function loadEnvLocal() {
  const envPath = path.join(REPO_ROOT, ".env.local");
  let raw;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

// --- Crate listing (identical precedence to suggest-cues.mjs / src/app/api/crate/route.ts) ---
async function fetchAllDriveFiles(folderId, apiKey) {
  const pages = [];
  let pageToken;
  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", `'${folderId}' in parents`);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("fields", "nextPageToken, files(id,name,mimeType,size)");
    url.searchParams.set("pageSize", String(DRIVE_PAGE_SIZE));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const upstream = await fetch(url.toString());
    if (!upstream.ok) throw new Error(`Drive list HTTP ${upstream.status}`);
    const json = await upstream.json();
    pages.push(Array.isArray(json.files) ? json.files : []);
    pageToken = json.nextPageToken;
  } while (pageToken);
  return mergeDrivePages(pages);
}

async function loadCrateListing() {
  const apiKey = process.env.GOOGLE_API_KEY;
  let manifestEntries = [];
  try {
    manifestEntries = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    manifestEntries = [];
  }
  const source = resolveListingSource(Boolean(apiKey), Array.isArray(manifestEntries) && manifestEntries.length > 0);

  if (source === "none") {
    console.log("NOTICE: no GOOGLE_API_KEY set and no crate-manifest.json fallback entries — nothing to map.");
    return { source: "none", tracks: [] };
  }
  if (source === "manifest") {
    console.log("NOTICE: no GOOGLE_API_KEY set — using the committed crate-manifest.json fallback (may be stale).");
    return { source: "manifest", tracks: manifestToListing(manifestEntries) };
  }
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) {
    console.log("NOTICE: GOOGLE_API_KEY set but GOOGLE_DRIVE_FOLDER_ID is not — set it in .env.local to your Drive crate folder's id.");
    return { source: "none", tracks: [] };
  }
  const files = await fetchAllDriveFiles(folderId, apiKey);
  return { source: "live", tracks: filterAudioFiles(files) };
}

// --- lrclib.net (cached — same cache dir/keying as suggest-cues.mjs, so a
// track suggest-cues.mjs already looked up costs zero network here) ---
function cachePathFor(url) {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 24);
  return path.join(CACHE_DIR, `${hash}.json`);
}

async function cachedFetchJson(url) {
  const cachePath = cachePathFor(url);
  try {
    return JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    // no cache entry (or corrupt) -- fall through and fetch for real
  }
  await sleep(RATE_LIMIT_DELAY_MS);
  let json;
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (res.status === 404) {
      json = { __notFound: true };
    } else if (!res.ok) {
      json = { __error: `HTTP ${res.status}` };
    } else {
      json = await res.json();
    }
  } catch (err) {
    json = { __error: err instanceof Error ? err.message : String(err) };
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(json));
  return json;
}

async function searchLrclib(artist, title) {
  const url = new URL(`${LRCLIB_BASE}/search`);
  if (artist) {
    url.searchParams.set("artist_name", artist);
    url.searchParams.set("track_name", title);
  } else {
    url.searchParams.set("q", title);
  }
  const json = await cachedFetchJson(url.toString());
  return Array.isArray(json) ? json : [];
}

async function matchForTrack(rawName) {
  const clean = cleanTrackName(rawName);
  const variants = buildQueryVariants(clean).slice(0, MAX_VARIANTS_PER_TRACK);
  for (const variant of variants) {
    const results = await searchLrclib(variant.artist, variant.title);
    const match = pickBestMatch(results, { title: variant.title, artist: variant.artist });
    if (match) return { match, triedVariants: variants.indexOf(variant) + 1 };
  }
  return { match: null, triedVariants: variants.length };
}

// --- Main ---
async function main() {
  loadEnvLocal();

  const { source, tracks: listing } = await loadCrateListing();
  if (source === "none") process.exit(0);

  const playableTracks = listing.filter((t) => t.playable);
  console.log("");
  console.log("  DJ SUPERMERCADO — VOCAL MAPS (synced lyrics -> per-track vocal-activity intervals)");
  console.log(`  crate source: ${source} — ${listing.length} file(s), ${playableTracks.length} playable`);
  console.log("");

  const output = {};
  let matchedCount = 0;
  let mappedCount = 0; // matched AND produced at least one interval
  let noMatchCount = 0;
  let totalIntervals = 0;

  for (let i = 0; i < playableTracks.length; i++) {
    const track = playableTracks[i];
    const progress = `[${i + 1}/${playableTracks.length}]`;
    let outcome;
    try {
      const { match, triedVariants } = await matchForTrack(track.name);
      if (!match) {
        noMatchCount++;
        outcome = `no lyrics match found (tried ${triedVariants} variant(s))`;
      } else {
        matchedCount++;
        const lines = parseSyncedLyrics(match.syncedLyrics ?? "");
        const intervals = buildVocalIntervalsFromLines(lines);
        if (intervals.length === 0) {
          outcome = `matched "${match.trackName}" by ${match.artistName} — 0 vocal intervals derived`;
        } else {
          mappedCount++;
          totalIntervals += intervals.length;
          const key = cueTrackKey({ source: "drive", id: track.id, name: track.name, size: track.size });
          output[key] = intervals;
          outcome = `matched "${match.trackName}" by ${match.artistName} — ${intervals.length} interval(s)`;
        }
      }
    } catch (err) {
      outcome = `ERROR — ${err instanceof Error ? err.message : String(err)}`;
    }
    console.log(`${progress} "${track.name}" -> ${outcome}`);
  }

  // Sorted keys for a deterministic, low-noise diff across reruns (same convention as cue-suggestions.json).
  const sortedOutput = {};
  for (const key of Object.keys(output).sort()) sortedOutput[key] = output[key];

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(sortedOutput, null, 2) + "\n");

  console.log("");
  console.log("  SUMMARY");
  console.log(`  tracks scanned:          ${playableTracks.length}`);
  console.log(`  lyrics matched:          ${matchedCount}`);
  console.log(`  mapped (>=1 interval):   ${mappedCount}`);
  console.log(`  no lyrics match:         ${noMatchCount}`);
  console.log(`  intervals generated:     ${totalIntervals}`);
  console.log(`  wrote ${OUT_PATH}`);
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
