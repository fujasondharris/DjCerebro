#!/usr/bin/env node
// M8.2i — BEAT-IN: where the beat is actually playing, per track, from the drums stem.
//
// THE PROBLEM (owner, mid-test 2026-08-16): "we keep transitioning into the singing
// only intros instead of fastforwarding the song to where the beat is already playing
// and matching that." He is right, and the cause is in energy.ts: the existing mixIn
// is computed from FULL-MIX RMS - loudness. A sung intro over a pad is LOUD. It clears
// the 50%-of-median threshold easily, so mixIn lands on the singing and the brain
// believes it found "where the beat is". Loudness cannot tell a voice from a kick.
//
// THE DRUMS STEM CAN. Percussion is either present or it is not. beat-in = the first
// second at which the drums stem sustains above a floor for a full bar or more, then
// snapped DOWN to the nearest downbeat on the real grid so the entry lands on a "1".
// This is the same measurement that separated crowd noise from music earlier today
// (drums -85 dB vs -37 dB), now used for the entry point instead of the trim point.
//
// PRECEDENCE in the app (page.tsx): dropEntry ?? beatIn ?? mixIn. A detected drop is
// still the best entry when it exists; beat-in beats loudness-mixIn everywhere else.
//
// Runs against the LOCAL stems (trimmed where the track was trimmed, so beat-in is in
// the SAME timeline as the audio the app plays). Writes src/data/beat-in.json keyed
// by v2 Drive id, matching the other data files.
//
// Usage: node --experimental-strip-types --no-warnings scripts/make-beat-in.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = path.join(REPO_ROOT, "src", "data");
const STEMS_TRIMMED = process.env.STEMS_TRIMMED || path.join(os.homedir(), "dj-tools", "stems-trimmed", "htdemucs_6s");
const STEMS_OUT = process.env.STEMS_DIR || path.join(os.homedir(), "dj-tools", "stems-out", "htdemucs_6s");
const OUT = path.join(DATA, "beat-in.json");

// Drums above this, sustained, = the beat is in. Pilot: real drumming sits at
// -37..-15 dB; crowd/ambience misassigned to drums sat at -73..-85. Deliberately low
// so a quiet intro groove still counts as "beat is in".
const DRUMS_ON_DB = -45;
const STEP_S = 0.5;
const SCAN_S = 90; // only the head matters
const SUSTAIN_BARS = 1; // must hold for a full bar, not a one-hit stinger

const crate = JSON.parse(readFileSync(path.join(DATA, "crate-manifest.json"), "utf8"));
const stems = JSON.parse(readFileSync(path.join(DATA, "stem-manifest.json"), "utf8"));
const applied = JSON.parse(readFileSync(path.join(DATA, "trim-applied.json"), "utf8"));
const trimmedNames = new Set(Object.values(applied).map((v) => v.name));

function meanDb(file, from, len) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-ss", String(from), "-t", String(len), "-i", file,
    "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr || "");
  return m ? Number(m[1]) : null;
}
function duration(file) {
  try {
    return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", file], { encoding: "utf8" }).trim());
  } catch { return 0; }
}
function floorToDownbeat(t, grid) {
  if (!grid?.bpm || grid.bpm <= 0) return null;
  const anchor = typeof grid.anchor === "number" ? grid.anchor : 0;
  const bar = (60 / grid.bpm) * 4;
  const n = Math.floor((t - anchor) / bar);
  const s = anchor + n * bar;
  return s >= 0 && s <= t + 1e-6 ? Number(s.toFixed(3)) : null;
}

const out = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
let done = 0, skipped = 0, noStem = 0, neverIn = 0, atZero = 0;
for (const t of crate) {
  if (out[t.id]) { skipped++; continue; }
  const entry = stems[t.id];
  const drel = entry?.stems?.drums;
  if (!drel) { noStem++; continue; }
  // stem-manifest.json now holds Drive ids; the local file lives under the track dir
  // named after the file. Trimmed tracks read from the trimmed stems (same timeline).
  const trackDir = path.basename(t.name, path.extname(t.name));
  const base = trimmedNames.has(t.name) ? STEMS_TRIMMED : STEMS_OUT;
  const drums = path.join(base, trackDir, "drums.mp3");
  if (!existsSync(drums)) { noStem++; continue; }

  const dur = duration(drums);
  const bar = t.grid?.bpm > 0 ? (60 / t.grid.bpm) * 4 : 2.5;
  const needSteps = Math.max(1, Math.ceil((SUSTAIN_BARS * bar) / STEP_S));
  const limit = Math.min(SCAN_S, dur);
  let run = 0, beatIn = null;
  for (let s = 0; s + STEP_S <= limit; s += STEP_S) {
    const v = meanDb(drums, s, STEP_S);
    if (v !== null && v >= DRUMS_ON_DB) {
      run++;
      if (run >= needSteps) { beatIn = s - (needSteps - 1) * STEP_S; break; }
    } else run = 0;
  }
  if (beatIn === null) { neverIn++; out[t.id] = { name: t.name, beatInSeconds: null, note: "no sustained drums in the first 90s" }; done++; continue; }
  const snapped = floorToDownbeat(beatIn, t.grid);
  const final = snapped ?? Number(beatIn.toFixed(3));
  if (final < 1) atZero++;
  out[t.id] = { name: t.name, beatInSeconds: final, detectedSeconds: Number(beatIn.toFixed(3)), snapped: snapped !== null };
  done++;
  if (done % 25 === 0) { writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log(`  ${done} analysed...`); }
}
writeFileSync(OUT, JSON.stringify(out, null, 2));

const vals = Object.values(out).filter((v) => v.beatInSeconds !== null).map((v) => v.beatInSeconds);
const late = Object.values(out).filter((v) => v.beatInSeconds !== null && v.beatInSeconds >= 8);
console.log(`\ndone=${done} skipped=${skipped} noStem=${noStem} neverIn=${neverIn} beatAtStart=${atZero}`);
console.log(`tracks whose beat comes in >= 8s late (the ones this fixes): ${late.length}`);
late.sort((a, b) => b.beatInSeconds - a.beatInSeconds);
for (const v of late.slice(0, 12)) console.log(`   ${String(v.beatInSeconds).padStart(7)}s  ${v.name.slice(0, 56)}`);
console.log(`\nwrote ${OUT}`);
