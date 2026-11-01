#!/usr/bin/env node
// M8.2k — re-verify every loop-points candidate against the STEMS (ground truth).
//
// THE BUG (owner, 2026-08-16): "he just looped an intro of vocals only" — Ozuna,
// Unica. loop-points.json had a candidate at 0.1s, 4 bars, vocalFree:true. The vocal
// map (from synced LYRICS) said vocals start at 34.3s. The vocals STEM says they start
// at 0s at -17 dB, full volume, and the drums do not enter until 20s. The lyric sync
// missed the entire sung intro, so the picker served up four bars of Ozuna a cappella
// with the drums stem at -82 dB. Exactly what he heard.
//
// Two lessons, both encoded here:
//  1. `vocalFree` must come from the vocals STEM, not the lyric map. Lyrics are a
//     guess about timing; the stem is what is actually in the audio.
//  2. A loop candidate needs the BEAT PRESENT, not just vocals absent. "vocal-free"
//     was never the whole test — a beatless, vocal-free 4 bars is a pad, not a loop.
//     New per-candidate flag `beatPresent`, from the drums stem.
//
// Every candidate keeps its data; it just gets re-scored honestly. A candidate that
// fails either test is marked, not deleted, so the pickers can prefer good ones and
// fall back rather than run out — but page.tsx's requireVocalFree now means "stem-
// verified vocal-free AND beat-present".
//
// Usage: node --experimental-strip-types --no-warnings scripts/verify-loop-points.mjs [--write]
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { findLoopCandidates } from "../src/lib/loop-points.ts";
import { getVocalIntervals, hasVocalMap } from "../src/lib/vocal-map.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = path.join(REPO_ROOT, "src", "data");
const CACHE_DIR = path.join(REPO_ROOT, ".cache", "loop-points");
const STEMS_TRIMMED = path.join(os.homedir(), "dj-tools", "stems-trimmed", "htdemucs_6s");
const STEMS_OUT = path.join(os.homedir(), "dj-tools", "stems-out", "htdemucs_6s");
const WRITE = process.argv.includes("--write");

// A stem is "present" over a window if its mean level clears this. Pilot: real
// vocals/drums sit at -15..-35 dB; absent stems sit at -70..-90.
const VOCAL_PRESENT_DB = -42;
const BEAT_PRESENT_DB = -45;
const STEM_SR = 8000;

const crate = JSON.parse(readFileSync(path.join(DATA, "crate-manifest.json"), "utf8"));
const lp = JSON.parse(readFileSync(path.join(DATA, "loop-points.json"), "utf8"));
const vocalMaps = JSON.parse(readFileSync(path.join(DATA, "vocal-maps.json"), "utf8"));
const nameById = new Map(crate.map((t) => [t.id, t.name]));

// Load cached per-bar band energies keyed by track id so we can re-run
// findLoopCandidates with stem-guided vocal-free + beat-present intervals.
const barsByTrackId = new Map();
if (existsSync(CACHE_DIR)) {
  for (const file of readdirSync(CACHE_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(path.join(CACHE_DIR, file), "utf8"));
      if (raw?.identity && Array.isArray(raw.bars)) {
        const idObj = JSON.parse(raw.identity);
        if (idObj?.id) barsByTrackId.set(idObj.id, raw.bars);
      }
    } catch {
      // ignore unreadable cache entry
    }
  }
}

import { spawn } from "node:child_process";

function decodePcm8kAsync(file) {
  return new Promise((resolve) => {
    const chunks = [];
    const p = spawn("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(STEM_SR), "-f", "f32le", "-"]);
    p.stdout.on("data", (c) => chunks.push(c));
    p.on("error", () => resolve(null));
    p.on("close", (code) => {
      if (code !== 0 || chunks.length === 0) return resolve(null);
      const raw = Buffer.concat(chunks);
      resolve(new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4)));
    });
  });
}

function windowRmsDb(pcm, fromSec, toSec) {
  if (!pcm) return null;
  const s0 = Math.max(0, Math.floor(fromSec * STEM_SR));
  const s1 = Math.min(pcm.length, Math.ceil(toSec * STEM_SR));
  if (s1 <= s0) return null;
  let sum = 0;
  for (let i = s0; i < s1; i++) sum += pcm[i] * pcm[i];
  const rms = Math.sqrt(sum / (s1 - s0));
  return Math.round(20 * Math.log10(Math.max(1e-9, rms)) * 10) / 10;
}

/**
 * Fraction of 100ms frames in [fromSec, toSec] where the vocal stem is at least
 * `dropDb` quieter than `vocalRefDb` (or below -24 dB). Distinguishes an
 * instrumental horn/melody break with occasional hype shouts ("Farru!", "Fiesta!")
 * from continuous lead singing.
 */
function vocalQuietFrameRatio(pcm, fromSec, toSec, thresholdDb) {
  if (!pcm) return 0;
  const frameLen = Math.floor(STEM_SR * 0.1); // 100ms
  const s0 = Math.max(0, Math.floor(fromSec * STEM_SR));
  const s1 = Math.min(pcm.length, Math.ceil(toSec * STEM_SR));
  let total = 0, quiet = 0;
  for (let pos = s0; pos + frameLen <= s1; pos += frameLen) {
    let sum = 0;
    for (let i = 0; i < frameLen; i++) sum += pcm[pos + i] * pcm[pos + i];
    const db = 20 * Math.log10(Math.max(1e-9, Math.sqrt(sum / frameLen)));
    total++;
    if (db < thresholdDb) quiet++;
  }
  return total > 0 ? quiet / total : 0;
}

function percentile(values, p) {
  if (!values.length) return -90;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

const round = (value, places) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

let tracks = 0, cands = 0, flippedVocal = 0, noBeat = 0, unverifiable = 0, withVocalFreeBeat = 0;
const entries = Object.entries(lp);
const BATCH = 16;
for (let bIdx = 0; bIdx < entries.length; bIdx += BATCH) {
  const slice = entries.slice(bIdx, bIdx + BATCH);
  const decodedBatch = await Promise.all(
    slice.map(async ([key, entry]) => {
      const id = key.startsWith("drive:") ? key.slice(6) : key;
      const name = nameById.get(id);
      if (!name || !Array.isArray(entry.loops)) return { key, entry, id, skip: true };
      const dir = path.basename(name, path.extname(name));
      const trimmedVocals = path.join(STEMS_TRIMMED, dir, "vocals.mp3");
      const base = existsSync(trimmedVocals) ? STEMS_TRIMMED : STEMS_OUT;
      const vocalsFile = path.join(base, dir, "vocals.mp3");
      const drumsFile = path.join(base, dir, "drums.mp3");
      if (!existsSync(vocalsFile) || !existsSync(drumsFile)) return { key, entry, id, unverifiable: true };
      const [vocalsPcm, drumsPcm] = await Promise.all([decodePcm8kAsync(vocalsFile), decodePcm8kAsync(drumsFile)]);
      if (!vocalsPcm || !drumsPcm) return { key, entry, id, unverifiable: true };
      return { key, entry, id, vocalsPcm, drumsPcm };
    })
  );

  for (const item of decodedBatch) {
    if (item.skip) continue;
    if (item.unverifiable) { unverifiable++; continue; }
    const { key, entry, id, vocalsPcm, drumsPcm } = item;
    tracks++;

    const bars = barsByTrackId.get(id);
    const barVocalDbs = bars
      ? bars.map((b) => windowRmsDb(vocalsPcm, b.startSeconds, b.endSeconds)).filter((v) => v !== null && v > -45)
      : [];
    const vocalRefDb = barVocalDbs.length >= 4 ? percentile(barVocalDbs, 0.8) : -14;

    const isHookClearWindow = (fromSec, toSec, vDb, dDb) => {
      if (dDb === null || dDb < BEAT_PRESENT_DB) return false;
      if (vDb !== null && vDb < VOCAL_PRESENT_DB) return true;
      if (
        vDb !== null &&
        dDb >= -26 &&
        vDb <= vocalRefDb - 3.0 &&
        vocalQuietFrameRatio(vocalsPcm, fromSec, toSec, Math.min(-17.5, vocalRefDb - 4.0)) >= 0.4
      ) {
        return true;
      }
      return false;
    };

    if (bars && bars.length >= 4) {
      const stemIntervals = [];
      for (let i = 0; i < bars.length; i += 4) {
        const phraseEndIdx = Math.min(bars.length - 1, i + 3);
        const fromSec = bars[i].startSeconds;
        const toSec = bars[phraseEndIdx].endSeconds;
        const vDb = windowRmsDb(vocalsPcm, fromSec, toSec);
        const dDb = windowRmsDb(drumsPcm, fromSec, toSec);
        if (!isHookClearWindow(fromSec, toSec, vDb, dDb)) {
          stemIntervals.push([fromSec, toSec]);
        }
      }
      const discovered = findLoopCandidates(bars, {
        lengthsBars: [4, 8, 2],
        maxCandidates: 5,
        similarityThreshold: 0.82,
        minLoudness: 0.45,
        vocalIntervals: stemIntervals,
        hasVocalMap: true,
      });
      if (discovered.length > 0) {
        const lyricIntervals = getVocalIntervals(vocalMaps, key);
        const hasLyrics = hasVocalMap(vocalMaps, key);
        entry.vocalChecked = true;
        entry.loops = discovered.map((c) => ({
          startBar: c.startBar,
          lengthBars: c.lengthBars,
          startSeconds: round(c.startSeconds, 3),
          endSeconds: round(c.endSeconds, 3),
          repeats: c.repeats,
          similarity: round(c.similarity, 4),
          stability: round(c.stability, 4),
          loudness: round(c.loudness, 4),
          isolation: c.isolation,
          vocalFree: c.vocalFree,
          score: round(c.score, 4),
          lyricVocalFree: hasLyrics
            ? !lyricIntervals.some(([s, e]) => s < c.endSeconds && e > c.startSeconds)
            : false,
        }));
      }
    }

    for (const L of entry.loops) {
      cands++;
      const v = windowRmsDb(vocalsPcm, L.startSeconds, L.endSeconds);
      const d = windowRmsDb(drumsPcm, L.startSeconds, L.endSeconds);
      const clearHook = isHookClearWindow(L.startSeconds, L.endSeconds, v, d);
      const beatPresent = d !== null ? d >= BEAT_PRESENT_DB : null;
      const prevLyric = L.lyricVocalFree ?? L.vocalFree;
      if (v !== null && prevLyric === true && !clearHook) flippedVocal++;
      if (beatPresent === false) noBeat++;
      L.lyricVocalFree = prevLyric;
      L.vocalFree = Boolean(clearHook && beatPresent);
      L.beatPresent = beatPresent;
      L.vocalsDb = v;
      L.drumsDb = d;
    }
    if (entry.loops.some((l) => l.vocalFree && l.beatPresent === true)) withVocalFreeBeat++;
  }
}

console.log(`\ntracks=${tracks} candidates=${cands} unverifiable=${unverifiable} tracksWithVocalFreeBeatLoop=${withVocalFreeBeat}`);
console.log(`candidates the LYRIC map called vocal-free that the STEM says have vocals: ${flippedVocal}`);
console.log(`candidates with NO BEAT PRESENT (a pad, not a loop): ${noBeat}`);
if (WRITE) { writeFileSync(path.join(DATA, "loop-points.json"), JSON.stringify(lp, null, 2) + "\n"); console.log("wrote loop-points.json"); }
else console.log("DRY RUN — re-run with --write");
