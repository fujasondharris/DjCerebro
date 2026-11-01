#!/usr/bin/env node
// M7 Phase 1 — offline loop-point + drop analysis for the whole crate,
// writing the committed data file src/data/loop-points.json.
//
// GOAL-M7.md PRINCIPLE 3 ("heavy analysis is offline") puts pattern and drop
// detection here rather than on the phone's audio thread, the same
// architecture as crate-manifest.json / vocal-maps.json / cue-suggestions.json.
// Run it alongside `npm run make:crate-manifest` / `npm run suggest:cues`
// whenever the crate changes.
//
// Pipeline per track:
//   1. Crate listing — live Drive when GOOGLE_API_KEY + GOOGLE_DRIVE_FOLDER_ID
//      are set, otherwise the committed crate-manifest.json fallback (same
//      precedence and friendly-exit as scripts/build-vocal-maps.mjs).
//   2. BeatGrid + BPM + duration from crate-manifest.json (already parsed
//      from the local files by make-crate-manifest.mjs — zero re-parsing).
//      No real grid -> SKIPPED, per PRINCIPLE 4 ("grid-truth or don't do it").
//   3. Local audio from the mirror (Downloads\dj-crate, override CRATE_DIR),
//      matched by filename with the same matchLocalFilename the manifest
//      builder uses. No local file -> SKIPPED (nothing to analyze).
//   4. ffmpeg decodes it to mono f32 PCM at ANALYSIS_SAMPLE_RATE.
//   5. src/lib/band-energy.ts measures per-band RMS per beat over the real
//      grid; src/lib/loop-points.ts folds that to bars and runs the
//      recurring-pattern and drop detectors.
//   6. Vocal-free is judged against src/data/vocal-maps.json. A track with
//      no vocal map is recorded as vocalChecked:false and its candidates
//      report vocalFree:false — "we didn't check" never reads as "it's clear".
//
// Rerunnable/idempotent, same posture as suggest-cues.mjs: per-track results
// are cached under .cache/loop-points/ keyed by file identity AND analysis
// parameters, so a rerun after adding tracks only decodes the new ones. Bump
// ANALYZER_VERSION whenever the detectors change, which invalidates the cache.
//
// Flags: --limit=N (analyze only the first N eligible tracks — for a smoke
// run, NEVER for a real refresh, since it would write a partial data file),
// --no-cache (ignore and rewrite cached results).
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { filterAudioFiles, mergeDrivePages, resolveListingSource, manifestToListing, matchLocalFilename } from "../src/lib/crate.ts";
import { cueTrackKey } from "../src/lib/cue-store.ts";
import { getVocalIntervals, hasVocalMap } from "../src/lib/vocal-map.ts";
import { computeBandEnergyPerBeat } from "../src/lib/band-energy.ts";
import { beatsToBars, findLoopCandidates, detectDrops } from "../src/lib/loop-points.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_PATH = path.join(REPO_ROOT, "src", "data", "loop-points.json");
const MANIFEST_PATH = path.join(REPO_ROOT, "src", "data", "crate-manifest.json");
const VOCAL_MAPS_PATH = path.join(REPO_ROOT, "src", "data", "vocal-maps.json");
const CACHE_DIR = path.join(REPO_ROOT, ".cache", "loop-points");

const DRIVE_PAGE_SIZE = 1000;

/**
 * 22050Hz mono is plenty: the highest band edge is 4kHz (deck.ts's
 * EQ_HIGH_FREQ_HZ), so Nyquist at 11025Hz leaves the high band's filter
 * plenty of room, and halving the rate halves the analysis time.
 */
const ANALYSIS_SAMPLE_RATE = 22050;
/** Bump on any detector/parameter change — it is part of the cache key, so bumping invalidates every cached track. */
const ANALYZER_VERSION = 3; // bumped: beatsToBars now folds from the first PHRASE line (choir round #3, finding 3)
const DETECTOR_OPTIONS = {
  lengthsBars: [4, 8, 2],
  maxCandidates: 3,
  similarityThreshold: 0.82,
  minLoudness: 0.45,
};
const DROP_OPTIONS = {};

// --- .env.local (same hand-rolled parser as the sibling scripts — never logs values) ---
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

// --- Crate listing (identical precedence to scripts/build-vocal-maps.mjs) ---
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

function readJsonOr(pathname, fallback) {
  try {
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch {
    return fallback;
  }
}

async function loadCrateListing(manifestEntries) {
  const apiKey = process.env.GOOGLE_API_KEY;
  const source = resolveListingSource(Boolean(apiKey), manifestEntries.length > 0);

  if (source === "none") {
    console.log("NOTICE: no GOOGLE_API_KEY set and no crate-manifest.json fallback entries — nothing to analyze.");
    return { source: "none", tracks: [] };
  }
  if (source === "manifest") {
    console.log("NOTICE: no GOOGLE_API_KEY set — using the committed crate-manifest.json fallback (may be stale).");
    return { source: "manifest", tracks: manifestToListing(manifestEntries) };
  }
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) {
    console.log("NOTICE: GOOGLE_API_KEY set but GOOGLE_DRIVE_FOLDER_ID is not — falling back to crate-manifest.json.");
    return { source: "manifest", tracks: manifestToListing(manifestEntries) };
  }
  const files = await fetchAllDriveFiles(folderId, apiKey);
  return { source: "live", tracks: filterAudioFiles(files) };
}

// --- Decode ----------------------------------------------------------------

/**
 * Decodes an audio file to mono float32 PCM at ANALYSIS_SAMPLE_RATE via the
 * system ffmpeg (already a dependency of the music pipeline — see
 * scripts/make-sfx.mjs). Throws on failure; the caller records the track as
 * a decode failure and carries on.
 */
function decodeMonoPcm(filePath) {
  const raw = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", filePath, "-ac", "1", "-ar", String(ANALYSIS_SAMPLE_RATE), "-f", "f32le", "-"],
    { maxBuffer: 1024 * 1024 * 1024 }
  );
  // Buffer -> Float32Array without copying when the byteOffset allows it.
  const usable = raw.byteLength - (raw.byteLength % 4);
  return new Float32Array(raw.buffer, raw.byteOffset, usable / 4);
}

// --- Rounding (small, diff-friendly JSON — full float precision here is noise) ---
const round = (value, places) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};
const roundSeconds = (value) => (value === null ? null : round(value, 3));

function serializeLoop(candidate) {
  return {
    startBar: candidate.startBar,
    lengthBars: candidate.lengthBars,
    startSeconds: roundSeconds(candidate.startSeconds),
    endSeconds: roundSeconds(candidate.endSeconds),
    repeats: candidate.repeats,
    similarity: round(candidate.similarity, 4),
    stability: round(candidate.stability, 4),
    loudness: round(candidate.loudness, 4),
    isolation: candidate.isolation,
    vocalFree: candidate.vocalFree,
    score: round(candidate.score, 4),
  };
}

function serializeDrop(drop) {
  return {
    atSeconds: roundSeconds(drop.atSeconds),
    barIndex: drop.barIndex,
    strength: round(drop.strength, 3),
    entry16Seconds: roundSeconds(drop.entry16Seconds),
    entry32Seconds: roundSeconds(drop.entry32Seconds),
  };
}

// --- Cache -----------------------------------------------------------------
function cachePathFor(identity) {
  const hash = createHash("sha1").update(identity).digest("hex").slice(0, 24);
  return path.join(CACHE_DIR, `${hash}.json`);
}

/**
 * The cache holds the DECODED per-bar band energies, not the detector
 * output, so its key deliberately excludes DETECTOR_OPTIONS: decoding is the
 * expensive step (~1s/track) and detector tuning is the part that gets
 * iterated. Re-running after a threshold change then costs no ffmpeg at all.
 */
function cacheIdentity(track, grid) {
  return JSON.stringify({
    v: ANALYZER_VERSION,
    id: track.id,
    name: track.name,
    size: track.size ?? null,
    sampleRate: ANALYSIS_SAMPLE_RATE,
    grid,
  });
}

// --- Main ------------------------------------------------------------------
async function main() {
  loadEnvLocal();

  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number.parseInt(limitArg.split("=")[1], 10) : null;
  const useCache = !args.includes("--no-cache");

  const manifestEntries = readJsonOr(MANIFEST_PATH, []);
  const vocalMaps = readJsonOr(VOCAL_MAPS_PATH, {});
  const { source, tracks: listing } = await loadCrateListing(Array.isArray(manifestEntries) ? manifestEntries : []);
  if (source === "none") process.exit(0);

  const manifestById = new Map((Array.isArray(manifestEntries) ? manifestEntries : []).map((e) => [e.id, e]));
  const playableTracks = listing.filter((t) => t.playable);

  const crateDir = process.env.CRATE_DIR || path.join(process.env.USERPROFILE ?? REPO_ROOT, "Downloads", "dj-crate");
  let localNames = [];
  try {
    localNames = readdirSync(crateDir).filter((f) => f.toLowerCase().endsWith(".mp3"));
  } catch {
    console.log(`NOTICE: ${crateDir} not readable — no track can be decoded. Set CRATE_DIR to your local mirror.`);
  }

  console.log("");
  console.log("  DJ SUPERMERCADO — LOOP POINTS (recurring-pattern loop ranges + drop positions)");
  console.log(`  crate source: ${source} — ${listing.length} file(s), ${playableTracks.length} playable`);
  console.log(`  local mirror: ${crateDir} — ${localNames.length} mp3(s)`);
  if (limit !== null) console.log(`  ⚠️  --limit=${limit} — PARTIAL run, the written file will not cover the whole crate`);
  console.log("");

  const output = {};
  const counts = {
    scanned: 0,
    noGrid: 0,
    noLocalFile: 0,
    decodeFailed: 0,
    tooShort: 0,
    analyzed: 0,
    cached: 0,
    withLoops: 0,
    withVocalFreeLoops: 0,
    withDrops: 0,
    vocalChecked: 0,
    totalLoops: 0,
    totalDrops: 0,
  };

  let processed = 0;
  for (let i = 0; i < playableTracks.length; i++) {
    if (limit !== null && processed >= limit) break;
    const track = playableTracks[i];
    counts.scanned++;
    const progress = `[${i + 1}/${playableTracks.length}]`;

    const manifestEntry = manifestById.get(track.id);
    const rawGrid = manifestEntry?.grid;
    if (!rawGrid || !Number.isFinite(rawGrid.bpm) || rawGrid.bpm <= 0) {
      counts.noGrid++;
      console.log(`${progress} "${track.name}" -> SKIP (no real BeatGrid — grid-truth rule)`);
      continue;
    }
    const grid = { anchor: rawGrid.anchor, bpm: rawGrid.bpm };

    const localName = matchLocalFilename(track.name, localNames);
    if (!localName) {
      counts.noLocalFile++;
      console.log(`${progress} "${track.name}" -> SKIP (no local file in the mirror to analyze)`);
      continue;
    }

    const key = cueTrackKey({ source: "drive", id: track.id, name: track.name, size: track.size ?? null });
    const trackHasVocalMap = hasVocalMap(vocalMaps, key);
    const vocalIntervals = getVocalIntervals(vocalMaps, key);

    const identity = cacheIdentity(track, grid);
    const cachePath = cachePathFor(identity);
    let bars = null;
    let durationSeconds = null;
    if (useCache) {
      const cached = readJsonOr(cachePath, null);
      if (cached && cached.identity === identity) {
        bars = cached.bars;
        durationSeconds = cached.durationSeconds;
        counts.cached++;
      }
    }

    if (!bars) {
      let samples;
      try {
        samples = decodeMonoPcm(path.join(crateDir, localName));
      } catch (err) {
        counts.decodeFailed++;
        console.log(`${progress} "${track.name}" -> SKIP (ffmpeg decode failed: ${err instanceof Error ? err.message.split("\n")[0] : err})`);
        continue;
      }

      const perBeat = computeBandEnergyPerBeat(samples, ANALYSIS_SAMPLE_RATE, grid);
      bars = perBeat ? beatsToBars(perBeat) : [];
      durationSeconds = round(samples.length / ANALYSIS_SAMPLE_RATE, 3);
      mkdirSync(CACHE_DIR, { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ identity, durationSeconds, bars }));
    }

    if (bars.length < 4) {
      counts.tooShort++;
      console.log(`${progress} "${track.name}" -> SKIP (only ${bars.length} whole bar(s) on the grid — too short to analyze)`);
      continue;
    }

    const loops = findLoopCandidates(bars, {
      ...DETECTOR_OPTIONS,
      vocalIntervals,
      hasVocalMap: trackHasVocalMap,
    });
    const drops = detectDrops(bars, grid.bpm, DROP_OPTIONS);

    const entry = {
      bpm: round(grid.bpm, 4),
      anchor: roundSeconds(grid.anchor),
      durationSeconds,
      vocalChecked: trackHasVocalMap,
      loops: loops.map(serializeLoop),
      drops: drops.map(serializeDrop),
    };

    output[key] = entry;
    counts.analyzed++;
    processed++;
    counts.totalLoops += entry.loops.length;
    counts.totalDrops += entry.drops.length;
    if (entry.loops.length > 0) counts.withLoops++;
    if (entry.loops.some((l) => l.vocalFree)) counts.withVocalFreeLoops++;
    if (entry.drops.length > 0) counts.withDrops++;
    if (entry.vocalChecked) counts.vocalChecked++;

    const best = entry.loops[0];
    const loopSummary = best
      ? `best loop ${best.lengthBars} bar(s) @${best.startSeconds}s x${best.repeats} (${best.isolation}${best.vocalFree ? ", vocal-free" : ""})`
      : "no loop candidate";
    console.log(`${progress} "${track.name}" -> ${entry.loops.length} loop(s), ${entry.drops.length} drop(s) — ${loopSummary}`);
  }

  // Sorted keys for a deterministic, low-noise diff across reruns (same convention as vocal-maps.json / cue-suggestions.json).
  const sortedOutput = {};
  for (const key of Object.keys(output).sort()) sortedOutput[key] = output[key];

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(sortedOutput, null, 2) + "\n");

  console.log("");
  console.log("  SUMMARY");
  console.log(`  playable crate tracks:      ${playableTracks.length}`);
  console.log(`  scanned this run:           ${counts.scanned}`);
  console.log(`  analyzed (in the data file):${String(counts.analyzed).padStart(5)}   (${counts.cached} from cache)`);
  console.log(`  skipped, no real BeatGrid:  ${counts.noGrid}`);
  console.log(`  skipped, no local file:     ${counts.noLocalFile}`);
  console.log(`  skipped, decode failed:     ${counts.decodeFailed}`);
  console.log(`  skipped, too short:         ${counts.tooShort}`);
  console.log(`  with >=1 loop candidate:    ${counts.withLoops}`);
  console.log(`  with >=1 VOCAL-FREE loop:   ${counts.withVocalFreeLoops}`);
  console.log(`  with >=1 drop:              ${counts.withDrops}`);
  console.log(`  vocal map available:        ${counts.vocalChecked} (the rest report vocalFree:false = unknown, not clear)`);
  console.log(`  total loop candidates:      ${counts.totalLoops}`);
  console.log(`  total drops:                ${counts.totalDrops}`);
  console.log(`  wrote ${OUT_PATH}`);
  console.log("");
}

main().catch((err) => {
  console.error(`FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
