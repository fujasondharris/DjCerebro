#!/usr/bin/env node
// M8.1p — restore the Serato BeatGrid to every trimmed track in crate-manifest.json.
//
// THE REGRESSION. apply-trims re-encodes with `-map_metadata 0`, which copies ID3 TEXT
// frames (TBPM, TKEY survive) but DROPS the GEOB binary frame that holds the Serato
// BeatGrid. So every one of the 148 trimmed tracks lost its grid, and make:crate-
// manifest — which reads the grid from the local file — wrote grid:null for all of
// them. Production went from 321 gridded tracks to 191.
//
// Every move the owner could not hear gates on a real grid: stem_migrate ("a
// migration is bar-timed"), loop / sample_mix ("never an unsnapped hold"), and the
// phrase-aligned firing that times FX. Only the crossfade survived — which is exactly
// what he reported (2026-08-16): "cross fade seems good, I don't hear any sound
// effects from Cerebro and definitely I don't hear him using the stems."
//
// THE FIX is arithmetic, not re-analysis. The grid is a list of markers at absolute
// source seconds. A head cut of H seconds moves every marker H earlier, and because
// every cut was snapped to a downbeat, the new first downbeat sits at exactly 0 — the
// anchor becomes 0. Markers that fell inside the cut are dropped. Tail cuts move
// nothing. The pre-cutover manifest (git, commit e09753f~1) has all 321 original grids.
//
// Writes the shifted grid straight into crate-manifest.json, which is how the app
// gets a grid for any track already (page.tsx: `grid: manifestTags.grid`) — no GEOB
// writer needed, no special-casing, the same path as BPM.
//
// Usage: node --experimental-strip-types --no-warnings scripts/restore-trimmed-grids.mjs [--write]
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = path.join(REPO_ROOT, "src", "data");
const WRITE = process.argv.includes("--write");
const PRE_CUTOVER_REF = "e09753f~1";

/**
 * Shift a Serato grid by a head cut. Exported for the golden.
 * - every marker moves earlier by headSeconds
 * - markers that land before 0 are dropped (they were inside the cut)
 * - anchor becomes 0 when there was a head cut (the cut landed on a downbeat)
 * - bpm is untouched (it is a rate, not a position)
 * Returns null if nothing survives (should not happen on a real track).
 */
export function shiftGrid(grid, headSeconds) {
  if (!grid || !Array.isArray(grid.markers) || !grid.markers.length) return null;
  if (headSeconds <= 0) return grid; // tail-only trim: positions do not move

  // A Serato grid is usually ONE marker (anchor + bpm) that defines downbeats forever
  // after it. Naively shifting that marker by a 27s head cut sends it negative, and
  // dropping it kills the whole grid — which happened to exactly the 14 tracks the
  // owner set head points on. The grid is not gone: downbeats continue past the
  // marker at a fixed BPM. So a marker that lands negative is advanced forward by
  // whole BARS (4 beats at its own bpm) until it is >= 0. That is the same downbeat
  // lattice, re-expressed from the first downbeat that survives the cut.
  const markers = [];
  for (const m of grid.markers) {
    let pos = m.position - headSeconds;
    const bpm = m.bpm ?? grid.bpm;
    if (pos < -0.001 && bpm > 0) {
      const bar = (60 / bpm) * 4;
      pos += Math.ceil((-pos) / bar) * bar;
    }
    if (pos < -0.001) continue;
    markers.push({ ...m, position: Number(Math.max(0, pos).toFixed(6)) });
  }
  if (!markers.length) return null;
  // Every cut was snapped to a downbeat, so the trimmed audio STARTS on one: the
  // anchor is 0. (The advanced marker will be at some small positive multiple of a
  // bar — consistent with anchor 0 by construction, since it was moved in whole bars
  // from a lattice that the cut point itself lies on.)
  return { ...grid, markers, anchor: 0 };
}

const IS_CLI = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (IS_CLI) {
  const current = JSON.parse(readFileSync(path.join(DATA, "crate-manifest.json"), "utf8"));
  const applied = JSON.parse(readFileSync(path.join(DATA, "trim-applied.json"), "utf8"));
  const pre = JSON.parse(execFileSync("git", ["show", `${PRE_CUTOVER_REF}:src/data/crate-manifest.json`], {
    cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  }));
  const preByName = new Map(pre.map((t) => [t.name, t]));
  const trimByName = new Map(Object.values(applied).map((v) => [v.name, v]));

  let restored = 0, alreadyHad = 0, noOriginalGrid = 0, notTrimmed = 0, dropped = 0;
  for (const t of current) {
    const trim = trimByName.get(t.name);
    if (!trim) { notTrimmed++; continue; }
    if (t.grid) { alreadyHad++; continue; }
    // M8 batch 2: tracks cut after the pre-cutover ref carry their pre-cut grid in trim-applied.json.
    const orig = trim.sourceGrid ?? preByName.get(t.name)?.grid;
    if (!orig) { noOriginalGrid++; continue; }
    const shifted = shiftGrid(orig, trim.headSeconds ?? 0);
    if (!shifted) { dropped++; continue; }
    t.grid = shifted;
    restored++;
  }

  const withGrid = current.filter((t) => t.grid).length;
  console.log(`restored=${restored} alreadyHad=${alreadyHad} noOriginalGrid=${noOriginalGrid} notTrimmed=${notTrimmed} dropped=${dropped}`);
  console.log(`crate-manifest: ${withGrid}/${current.length} tracks now have a grid (was 191; pre-cutover 321)`);
  if (WRITE) {
    writeFileSync(path.join(DATA, "crate-manifest.json"), JSON.stringify(current, null, 2) + "\n");
    console.log("wrote crate-manifest.json");
  } else {
    console.log("DRY RUN — re-run with --write");
  }
}
