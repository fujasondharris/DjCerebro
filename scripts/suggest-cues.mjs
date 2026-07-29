#!/usr/bin/env node
// Synced-lyrics -> suggested-cue-points pipeline. For each crate track:
// clean its messy YouTube-derived filename (src/lib/lyrics-match.ts), query
// lrclib.net (free, keyless) for synced lyrics, extract candidate
// call-response/ad-lib moments (parenthetical lines + repeated coro lines),
// and write them to src/data/cue-suggestions.json. page.tsx seeds these into
// a track's cue list (as INERT, suggested:true cues) the first time it loads
// with no user cues yet — see src/lib/cue-store.ts's buildSuggestedCues/
// seedSuggestedCues and CLAUDE_STATE.md's cue-suggestion pipeline section.
//
// Rerunnable/idempotent: lrclib responses are cached in .cache/lrclib/
// (gitignored) keyed by request URL, so a rerun after adding new crate
// tracks only hits the network for tracks it hasn't asked about before.
//
// Env: reads GOOGLE_API_KEY / GOOGLE_DRIVE_FOLDER_ID from .env.local via a
// tiny hand-rolled parser (Next's own dev/build server loads .env.local for
// the app itself, but this is a standalone script) — values are read into
// process.env and NEVER logged. Falls back to the committed
// src/data/crate-manifest.json (same precedence as src/app/api/crate/
// route.ts's resolveListingSource()) when no key is set; if neither is
// available, prints a friendly notice and exits 0 rather than failing.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  filterAudioFiles,
  mergeDrivePages,
  resolveListingSource,
  manifestToListing,
} from "../src/lib/crate.ts";
import { cueTrackKey } from "../src/lib/cue-store.ts";
import {
  cleanTrackName,
  buildQueryVariants,
  pickBestMatch,
  parseSyncedLyrics,
  extractCallResponseCues,
} from "../src/lib/lyrics-match.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_PATH = path.join(REPO_ROOT, "src", "data", "cue-suggestions.json");
const MANIFEST_PATH = path.join(REPO_ROOT, "src", "data", "crate-manifest.json");
const CACHE_DIR = path.join(REPO_ROOT, ".cache", "lrclib");

const DRIVE_PAGE_SIZE = 1000;

const LRCLIB_BASE = "https://lrclib.net/api";
const USER_AGENT = "dj-supermercado-cue-suggester/1.0 (personal-use local DJ tool, no public repo)";
const RATE_LIMIT_DELAY_MS = 250; // only applied on real network calls, never on cache hits

const MAX_VARIANTS_PER_TRACK = 6; // safety cap even if buildQueryVariants ever grows

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- .env.local (tiny hand-rolled parser — never logs values) ---
function loadEnvLocal() {
  const envPath = path.join(REPO_ROOT, ".env.local");
  let raw;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return; // no .env.local -- real env vars (CI, shell) may already be set
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

// --- Crate listing (same precedence as src/app/api/crate/route.ts) ---
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
    if (!upstream.ok) {
      throw new Error(`Drive list HTTP ${upstream.status}`);
    }
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
    console.log("NOTICE: no GOOGLE_API_KEY set and no crate-manifest.json fallback entries — nothing to suggest cues for.");
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

// --- lrclib.net (cached) ---
function cachePathFor(url) {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 24);
  return path.join(CACHE_DIR, `${hash}.json`);
}

async function cachedFetchJson(url) {
  const cachePath = cachePathFor(url);
  if (existsSync(cachePath)) {
    try {
      return JSON.parse(readFileSync(cachePath, "utf8"));
    } catch {
      // corrupt/partial cache entry -- fall through and refetch
    }
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

// --- Per-track processing ---
async function suggestForTrack(rawName) {
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
  if (source === "none") {
    process.exit(0);
  }

  const playableTracks = listing.filter((t) => t.playable);
  console.log("");
  console.log("  DJ SUPERMERCADO — SUGGESTED CUE POINTS (synced lyrics -> call-response cues)");
  console.log(`  crate source: ${source} — ${listing.length} file(s), ${playableTracks.length} playable`);
  console.log("");

  const output = {};
  let matchedCount = 0;
  let matchedWithCuesCount = 0;
  let noMatchCount = 0;
  let totalCues = 0;

  for (let i = 0; i < playableTracks.length; i++) {
    const track = playableTracks[i];
    const progress = `[${i + 1}/${playableTracks.length}]`;
    let outcome;
    try {
      const { match, triedVariants } = await suggestForTrack(track.name);
      if (!match) {
        noMatchCount++;
        outcome = `no lyrics match found (tried ${triedVariants} variant(s))`;
      } else {
        matchedCount++;
        const lines = parseSyncedLyrics(match.syncedLyrics ?? "");
        const cues = extractCallResponseCues(lines);
        if (cues.length === 0) {
          outcome = `matched "${match.trackName}" by ${match.artistName} — 0 call-response lines found`;
        } else {
          matchedWithCuesCount++;
          totalCues += cues.length;
          const key = cueTrackKey({ source: "drive", id: track.id, name: track.name, size: track.size });
          output[key] = {
            name: track.name,
            matchedTitle: match.trackName,
            matchedArtist: match.artistName,
            source: "lrclib",
            cues,
          };
          outcome = `matched "${match.trackName}" by ${match.artistName} — ${cues.length} cue(s)`;
        }
      }
    } catch (err) {
      outcome = `ERROR — ${err instanceof Error ? err.message : String(err)}`;
    }
    console.log(`${progress} "${track.name}" -> ${outcome}`);
  }

  // Sorted keys for a deterministic, low-noise diff across reruns.
  const sortedOutput = {};
  for (const key of Object.keys(output).sort()) sortedOutput[key] = output[key];

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(sortedOutput, null, 2) + "\n");

  console.log("");
  console.log("  SUMMARY");
  console.log(`  tracks scanned:        ${playableTracks.length}`);
  console.log(`  lyrics matched:        ${matchedCount}`);
  console.log(`  matched WITH cues:     ${matchedWithCuesCount}`);
  console.log(`  no lyrics match:       ${noMatchCount}`);
  console.log(`  cues generated total:  ${totalCues}`);
  console.log(`  wrote ${OUT_PATH}`);
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
