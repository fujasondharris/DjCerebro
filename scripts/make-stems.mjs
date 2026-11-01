#!/usr/bin/env node
// M8.1 — offline stem separation for the whole crate (see GOAL-M8-stems.md).
//
// Same lane as make-loop-points.mjs / build-vocal-maps.mjs / make-crate-manifest.mjs:
// an offline script produces committed data, and the live engine only ever plays
// precomputed files. Separation never runs in the browser. This is also the mode
// Serato themselves recommend for constrained hardware (their "Stems crate" —
// prepare ahead of the performance rather than analysing on load).
//
// WHY ONE MODEL, NOT A GENRE SPLIT
// The pilot (10 tracks, both models — ~/dj-tools/stem-pilot-results.json) said
// htdemucs_6s only pays off on salsa/bachata: piano averages -47.8 dB / 69%
// silent and guitar 38.7% silent across the crate, because reggaeton (the bulk
// of it) simply has neither instrument. The first plan was therefore to classify
// genre and run a different model per track.
//
// That classification step is unnecessary. We run htdemucs_6s on EVERYTHING and
// then let the audio decide: any guitar/piano stem that measures blank is
// deleted, and its (near-silent) content is simply already absent from `other`.
// That is exactly why 6s `other` only lost 2-4 dB on reggaeton in the pilot but
// -26.4 dB on Aventura's "Obsesión", where the guitar really is the "other".
// So the split survives as an OUTCOME rather than as an input we have to guess:
// Latin material keeps its comping layer, everything else collapses to the
// 4-stem layout on its own. No genre list to maintain, no misclassification.
//
// SALSA COMPING NOTE: within salsa the model routes the comping instrument to
// guitar OR piano depending on whether it hears tres/cuatro or piano montuno
// (pilot: "Vivir Mi Vida" piano -22.5 dB but guitar -46.8; "El Día De Mi Suerte"
// the reverse). Consumers must treat guitar+piano as ONE comping layer for
// salsa, never as two independent stems.
//
// RESUMABLE BY DESIGN. This is a multi-hour unattended batch; it re-reads its own
// output manifest on start and skips tracks already done, so an interrupted run
// (or a machine that sleeps) costs only the track in flight.
//
// SCOPE: local generation + manifest ONLY. Uploading ~15-22 GB of stems to the
// Drive crate is a separate, explicitly-gated step — it writes to the owner's
// Drive and must not happen as a side effect of a batch job.
//
// Usage:
//   node --experimental-strip-types --no-warnings scripts/make-stems.mjs [--limit N] [--dry-run]
// Env:
//   CRATE_DIR   local mirror of the crate (default ~/Music/dj-crate)
//   STEMS_DIR   where stem files are written (default ~/dj-tools/stems-out)
//   STEMS_PY    python with demucs installed (default ~/dj-tools/.venv-stems/bin/python)
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { matchLocalFilename } from "../src/lib/crate.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST_IN = path.join(REPO_ROOT, "src", "data", "crate-manifest.json");
const MANIFEST_OUT = path.join(REPO_ROOT, "src", "data", "stem-manifest.json");

const CRATE_DIR = process.env.CRATE_DIR || path.join(os.homedir(), "Music", "dj-crate");
const STEMS_DIR = process.env.STEMS_DIR || path.join(os.homedir(), "dj-tools", "stems-out");
const PYTHON = process.env.STEMS_PY || path.join(os.homedir(), "dj-tools", ".venv-stems", "bin", "python");
const MODEL = "htdemucs_6s";

// A stem is "blank" below this. Calibrated on the pilot: real stems sit at -19 to
// -34 dB mean with <40% silence; crate-wide piano averaged -47.8 dB / 69% silent.
// Deliberately conservative — when in doubt we KEEP the stem, since a kept-but-thin
// stem costs disk while a wrongly-dropped one silently removes a musical option.
const BLANK_MEAN_DB = -45;
const BLANK_SILENT_PCT = 0.8;
const DROPPABLE = new Set(["guitar", "piano"]);

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

// --- measurement: mean dBFS + silent fraction, the same probe used to validate the pilot ---
function measure(file) {
  let dur = 0;
  try {
    dur = Number(
      execFileSync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", file,
      ], { encoding: "utf8" }).trim(),
    );
  } catch {
    return null; // no ffprobe / unreadable — caller keeps the stem rather than guessing
  }
  const res = spawnSync("ffmpeg", [
    "-hide_banner", "-i", file,
    "-af", `volumedetect,silencedetect=noise=${BLANK_MEAN_DB}dB:d=0.5`,
    "-f", "null", "-",
  ], { encoding: "utf8" });
  const err = res.stderr || "";
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(err);
  let silent = 0;
  for (const m of err.matchAll(/silence_duration:\s*([\d.]+)/g)) silent += Number(m[1]);
  return {
    meanDb: mean ? Number(mean[1]) : null,
    silentPct: dur > 0 ? Number((silent / dur).toFixed(3)) : null,
  };
}

function isBlank(stats) {
  if (!stats || stats.meanDb === null) return false; // unmeasurable -> keep
  return stats.meanDb < BLANK_MEAN_DB || (stats.silentPct !== null && stats.silentPct > BLANK_SILENT_PCT);
}

// --- inputs ---
const crate = JSON.parse(readFileSync(MANIFEST_IN, "utf8"));
const localFiles = existsSync(CRATE_DIR)
  ? readdirSync(CRATE_DIR).filter((f) => f.toLowerCase().endsWith(".mp3"))
  : [];
if (!localFiles.length) {
  console.error(`No mp3s under CRATE_DIR=${CRATE_DIR} — set CRATE_DIR and rerun.`);
  process.exit(1);
}

const out = existsSync(MANIFEST_OUT) ? JSON.parse(readFileSync(MANIFEST_OUT, "utf8")) : {};
mkdirSync(STEMS_DIR, { recursive: true });

let done = 0, skipped = 0, unmatched = 0, failed = 0, processed = 0;
const startedAt = Date.now();

for (const track of crate) {
  if (processed >= LIMIT) break;
  if (out[track.id]?.stems) { skipped++; continue; }

  const local = matchLocalFilename(track.name, localFiles);
  if (!local) {
    unmatched++;
    console.warn(`  unmatched locally, skipping: ${track.name.slice(0, 60)}`);
    continue;
  }
  const src = path.join(CRATE_DIR, local);
  processed++;

  if (DRY_RUN) {
    console.log(`[dry] would separate ${local.slice(0, 64)}`);
    continue;
  }

  const t0 = Date.now();
  const res = spawnSync(PYTHON, [
    "-m", "demucs.separate",
    "-n", MODEL, "-d", "mps", "--mp3", "--mp3-bitrate", "320",
    "-o", STEMS_DIR, src,
  ], { encoding: "utf8" });

  if (res.status !== 0) {
    failed++;
    console.error(`  FAILED ${local.slice(0, 55)}: ${(res.stderr || "").slice(-300)}`);
    continue;
  }

  const stemDir = path.join(STEMS_DIR, MODEL, path.basename(local, path.extname(local)));
  const stems = {};
  const dropped = [];
  const loudness = {};
  for (const f of readdirSync(stemDir).filter((f) => f.endsWith(".mp3"))) {
    const stem = path.basename(f, ".mp3");
    const full = path.join(stemDir, f);
    const stats = measure(full);
    loudness[stem] = stats;
    if (DROPPABLE.has(stem) && isBlank(stats)) {
      dropped.push(stem); // left on disk; the manifest is the source of truth
      continue;
    }
    stems[stem] = path.relative(STEMS_DIR, full);
  }

  out[track.id] = {
    name: track.name,
    model: MODEL,
    generatedAt: new Date().toISOString(),
    stems,
    dropped,
    loudness,
    // guitar+piano are ONE comping layer for salsa — never two independent stems
    compingLayer: ["guitar", "piano"].filter((s) => s in stems),
  };
  writeFileSync(MANIFEST_OUT, JSON.stringify(out, null, 2)); // checkpoint every track
  done++;

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const kept = Object.keys(stems).length;
  console.log(
    `  ${done} ok ${secs}s  ${kept} stems` +
    (dropped.length ? ` (dropped ${dropped.join("+")})` : "") +
    `  ${local.slice(0, 46)}`,
  );
}

const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
console.log(
  `\ndone=${done} skipped=${skipped} unmatched=${unmatched} failed=${failed} in ${mins} min` +
  `\nmanifest: ${MANIFEST_OUT}` +
  `\nstems:    ${STEMS_DIR}` +
  `\nNOTE: Drive upload is a separate, explicitly-gated step — nothing was uploaded.`,
);
