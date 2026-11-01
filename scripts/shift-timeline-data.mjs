#!/usr/bin/env node
// M8.1h — shift the time-based data files to match trimmed audio.
//
// WHY THIS EXISTS. loop-points.json, vocal-maps.json and cue-suggestions.json all
// store ABSOLUTE seconds measured against the untrimmed audio. Cutting `headSeconds`
// off the front moves every one of those timestamps earlier by exactly that amount.
// Without this step every loop point, vocal window and cue in the crate would be
// wrong by the head-cut — silently, and by a different amount per track.
//
// Recording headSeconds at trim time is what makes this a SHIFT instead of a
// regeneration. Regenerating loop-points alone is hours of analysis; shifting is
// arithmetic. That was the whole reason apply-trims writes trim-applied.json.
//
// WHAT IT DOES, PER TRACK THAT WAS TRIMMED:
//   newT = oldT - headSeconds
//   ...then DROP anything that fell outside the trimmed audio. A loop starting
//   before the new 0, or a cue after the new end, no longer refers to audio that
//   exists. Keeping a negative timestamp would be worse than losing the entry: the
//   engine would seek to a point that isn't there.
//
// Bars shift too: bar indices are relative to the grid anchor, which moved. A cut
// snapped to a downbeat moves the anchor by a WHOLE number of bars, so barIndex
// shifts by exactly headSeconds/barLength. If a cut was NOT snapped (no grid), bar
// indices cannot be trusted and the track's bar-based entries are dropped rather
// than left subtly wrong.
//
// Writes *-trimmed.json alongside the originals — the originals stay valid for the
// untrimmed crate until the cutover is done.
//
// Usage: npm run shift:timeline            (dry run)
//        npm run shift:timeline -- --write
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = path.join(REPO_ROOT, "src", "data");
const APPLIED = path.join(DATA, "trim-applied.json");
const WRITE = process.argv.includes("--write");

const IS_CLI = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (IS_CLI && !existsSync(APPLIED)) {
  console.error("No trim-applied.json — nothing has been cut yet, so there is nothing to shift.");
  process.exit(1);
}
const applied = IS_CLI ? JSON.parse(readFileSync(APPLIED, "utf8")) : {};
const crate = IS_CLI ? JSON.parse(readFileSync(path.join(DATA, "crate-manifest.json"), "utf8")) : [];
const gridById = new Map(crate.map((t) => [t.id, t.grid]));

// Keys in these files carry a "drive:" prefix; trim-applied is keyed by bare id.
const keyVariants = (id) => [id, `drive:${id}`];

/** Exported for scripts/check-timeline-shift.mjs — this is pure arithmetic on data
 * that cannot be cheaply regenerated, so it is goldened rather than trusted.
 * Shift every numeric second-field in an object, dropping out-of-range entries. */
export function shiftSeconds(value, head, newDuration, seenDropped) {
  if (Array.isArray(value)) {
    return value
      .map((v) => shiftSeconds(v, head, newDuration, seenDropped))
      .filter((v) => v !== null);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // POSITIONS move; LENGTHS do not. Getting this wrong is not a rounding error:
      // `durationSeconds` is how long the track IS, not a point inside it. Shifting it
      // (or range-checking it) made every tail-only cut look out-of-range and dropped
      // 117 of 117 loop-points records on the first dry run. Caught before --write.
      // `anchor` is handled separately by the caller, NOT here. It is the grid's zero
      // point, so naively shifting it goes negative (an anchor is ~0.3s, a head cut is
      // often 20s+) and dropped 14 more records. Since a snapped head IS a downbeat,
      // the trimmed audio begins exactly on one and the new anchor is simply 0.
      const isLength = /^(durationSeconds|holdSeconds|lengthSeconds)$/.test(k);
      const isPosition = /seconds$|Seconds$|^at$|Time$/.test(k);
      if (typeof v === "number" && !isLength && isPosition) {
        const shifted = Number((v - head).toFixed(3));
        // Anything that lands outside the surviving audio is dropped, not clamped.
        // Clamping would silently move a cue to a musically wrong place.
        if (shifted < -0.001 || shifted > newDuration + 0.001) {
          seenDropped.reason = `${k}=${v} falls outside 0..${newDuration}`;
          return null;
        }
        out[k] = Math.max(0, shifted);
      } else {
        const nested = shiftSeconds(v, head, newDuration, seenDropped);
        if (nested === null) return null;
        out[k] = nested;
      }
    }
    return out;
  }
  return value;
}

function shiftFile(name) {
  const src = path.join(DATA, `${name}.json`);
  if (!existsSync(src)) return { name, missing: true };
  const data = JSON.parse(readFileSync(src, "utf8"));
  const out = { ...data };
  let touched = 0, dropped = 0, unsnapped = 0;

  for (const [id, rec] of Object.entries(applied)) {
    const head = rec.headSeconds ?? 0;
    const key = keyVariants(id).find((k) => k in data);
    if (!key) continue;
    if (head === 0 && rec.tailSeconds === null) continue; // nothing moved

    const grid = gridById.get(id);
    const barLen = grid?.bpm > 0 ? (60 / grid.bpm) * 4 : null;
    // Bars must be counted FROM THE GRID ANCHOR, not from zero. A snapped head is
    // `anchor + n*bar`, so head/bar = anchor/bar + n, which is only a whole number
    // when the anchor happens to be 0 — and it almost never is. Using head/bar made
    // 29 correctly-snapped tracks look unsnapped and dropped their records.
    const anchor = typeof grid?.anchor === "number" ? grid.anchor : 0;
    const barsShifted = barLen ? (head - anchor) / barLen : null;
    // A snapped cut moves the anchor a whole number of bars. If it didn't, bar
    // indices in this record cannot be corrected and the record is dropped.
    if (head > 0 && (barsShifted === null || Math.abs(barsShifted - Math.round(barsShifted)) > 0.02)) {
      delete out[key];
      unsnapped++;
      continue;
    }

    const seen = {};
    let rec2 = shiftSeconds(data[key], head, rec.newDuration, seen);
    if (rec2 === null) { delete out[key]; dropped++; continue; }

    // barIndex/startBar move by the whole-bar shift.
    const bars = barsShifted === null ? 0 : Math.round(barsShifted);
    const fixBars = (v) => {
      if (Array.isArray(v)) return v.map(fixBars).filter((x) => x !== null);
      if (v && typeof v === "object") {
        const o = {};
        for (const [k, x] of Object.entries(v)) {
          if (typeof x === "number" && /^(startBar|barIndex|bar)$/.test(k)) {
            const nb = x - bars;
            if (nb < 0) return null;
            o[k] = nb;
          } else o[k] = fixBars(x);
        }
        return o;
      }
      return v;
    };
    rec2 = fixBars(rec2);
    if (rec2 === null) { delete out[key]; dropped++; continue; }

    if (typeof rec2 === "object" && "durationSeconds" in rec2) rec2.durationSeconds = rec.newDuration;
    // A downbeat-snapped head cut makes the trimmed audio start ON a downbeat, so the
    // grid's zero point is now 0. With no head cut the original anchor still stands.
    if (typeof rec2 === "object" && "anchor" in rec2 && head > 0) rec2.anchor = 0;
    if (rec2?.grid && typeof rec2.grid === "object" && "anchor" in rec2.grid && head > 0) {
      rec2.grid.anchor = 0;
    }
    out[key] = rec2;
    touched++;
  }

  const dst = path.join(DATA, `${name}-trimmed.json`);
  if (WRITE) writeFileSync(dst, JSON.stringify(out, null, 2));
  return { name, touched, dropped, unsnapped, entries: Object.keys(out).length, dst };
}

if (IS_CLI) {
console.log(`${WRITE ? "WRITING" : "DRY RUN"} — ${Object.keys(applied).length} trimmed track(s)\n`);
for (const name of ["loop-points", "vocal-maps", "cue-suggestions"]) {
  const r = shiftFile(name);
  if (r.missing) { console.log(`  ${name}: not present, skipped`); continue; }
  console.log(
    `  ${name.padEnd(16)} shifted=${r.touched} dropped=${r.dropped} ` +
    `unsnapped-dropped=${r.unsnapped} entriesOut=${r.entries}`,
  );
  if (WRITE) console.log(`    -> ${path.basename(r.dst)}`);
}
console.log(
  WRITE
    ? "\nWrote *-trimmed.json. Originals untouched — swap them in at cutover."
    : "\nDry run. Re-run with --write to produce the *-trimmed.json files.",
);
}
