#!/usr/bin/env node
// Rerunnable manifest generator + local tag-embedding pass for the crate
// manifest (src/data/crate-manifest.json) — M6.2 probe-storm fix (see
// CLAUDE_STATE.md). Two jobs in one pass:
//   1. Lists the real "DJ Supermercado Crate" Drive folder (GOOGLE_API_KEY +
//      GOOGLE_DRIVE_FOLDER_ID from .env.local, same live-listing call
//      src/app/api/crate/route.ts makes) to get every track's real
//      id/name/size — same precedence/style as scripts/suggest-cues.mjs.
//   2. For each Drive track, matches it against Jason's local mirror
//      (Downloads\dj-crate, override via CRATE_DIR) by filename
//      (matchLocalFilename — exact, then case-insensitive) and, on a match,
//      reads TBPM/TKEY/BeatGrid straight from the LOCAL file (parseId3Tags/
//      parseSeratoBeatgrid — the exact same parsers the app and
//      scripts/crate-check.mjs already use, zero network) plus duration via
//      a local ffprobe call (best-effort; null if ffprobe isn't installed or
//      the probe fails — never gates the rest of the run).
// Unmatched Drive tracks (a name that doesn't resolve locally, e.g. a
// mismatched-encoding filename) get null tags/duration — the client's
// existing Range-probe fallback still covers those.
//
// Why this matters even though GOOGLE_API_KEY is set in production (making
// /api/crate return "live", not "manifest" — a discrepancy from this
// dispatch's pinned FACTS, see CLAUDE_STATE.md's M6.2 section): this
// manifest is no longer just the keyless-fallback LISTING, it's also
// consulted client-side (src/lib/crate.ts's buildManifestTagIndex(), used in
// page.tsx's handleAddAllFromDrive) as a tag lookup BY ID regardless of
// whether the listing itself came from the live Drive API or this manifest —
// so a track this script already tagged never gets Range-probed over the
// network again, live-listing or not.
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { filterAudioFiles, mergeDrivePages, matchLocalFilename } from "../src/lib/crate.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_PATH = path.join(REPO_ROOT, "src", "data", "crate-manifest.json");
const DRIVE_PAGE_SIZE = 1000;

// --- .env.local (tiny hand-rolled parser, never logs values — same as scripts/suggest-cues.mjs) ---
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

// --- Crate listing (same precedence/shape as src/app/api/crate/route.ts's fetchAllDriveFiles) ---
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

// Best-effort local duration via system ffprobe (already used by
// scripts/make-sfx.mjs) — never throws, never gates the manifest write.
function probeDurationSeconds(filePath) {
  try {
    const out = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      { encoding: "utf8" }
    );
    const seconds = parseFloat(out.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

async function main() {
  loadEnvLocal();

  const apiKey = process.env.GOOGLE_API_KEY;
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!apiKey || !folderId) {
    console.log("NOTICE: GOOGLE_API_KEY / GOOGLE_DRIVE_FOLDER_ID not set in .env.local — nothing to refresh.");
    process.exit(0);
  }

  console.log("");
  console.log("  DJ SUPERMERCADO — CRATE MANIFEST REFRESH (+ local tag embedding)");

  const files = await fetchAllDriveFiles(folderId, apiKey);
  const driveTracks = filterAudioFiles(files).filter((t) => t.playable);
  console.log(`  Drive folder: ${driveTracks.length} playable track(s)`);

  const crateDir = process.env.CRATE_DIR || path.join(process.env.USERPROFILE ?? REPO_ROOT, "Downloads", "dj-crate");
  let localNames = [];
  try {
    localNames = readdirSync(crateDir).filter((f) => f.toLowerCase().endsWith(".mp3"));
  } catch {
    console.log(`  NOTICE: ${crateDir} not readable — every entry will get null tags.`);
  }
  console.log(`  Local mirror: ${crateDir} — ${localNames.length} mp3(s)`);

  const { parseId3Tags } = await import("../src/lib/id3.ts");
  const { parseSeratoBeatgrid } = await import("../src/lib/serato.ts");

  let matched = 0;
  let ffprobeWarned = false;
  const entries = [];
  for (const track of driveTracks) {
    const localName = matchLocalFilename(track.name, localNames);
    let bpm = null;
    let key = null;
    let durationSeconds = null;
    let grid = null;

    if (localName) {
      matched++;
      try {
        const buffer = readFileSync(path.join(crateDir, localName));
        const file = new File([buffer], localName);
        const [tags, beatgrid] = await Promise.all([parseId3Tags(file), parseSeratoBeatgrid(file)]);
        bpm = tags.bpm ?? null;
        key = tags.key ?? null;
        grid = beatgrid ?? null;
        durationSeconds = probeDurationSeconds(path.join(crateDir, localName));
        if (durationSeconds === null && !ffprobeWarned) {
          console.log(
            "  NOTICE: ffprobe unavailable/failed for at least one file — durationSeconds will be null for it (harmless, not gating)."
          );
          ffprobeWarned = true;
        }
      } catch (err) {
        console.warn(`  WARNING: couldn't read/parse "${localName}" (${err instanceof Error ? err.message : err}) — leaving tags null`);
      }
    }

    entries.push({ id: track.id, name: track.name, size: track.size ?? undefined, bpm, key, durationSeconds, grid });
  }

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(entries, null, 2) + "\n");

  console.log("");
  console.log(
    `SUMMARY: ${entries.length} Drive track(s), ${matched} matched to a local file (${entries.length - matched} unmatched -> null tags)`
  );
  console.log(`wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(`FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
