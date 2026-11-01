#!/usr/bin/env node
// Golden for restore-trimmed-grids.mjs's shiftGrid. A wrong grid puts EVERY
// bar-timed move off-beat forever, silently. Pinned rather than trusted.
import { shiftGrid } from "./restore-trimmed-grids.mjs";
let failures = 0;
const ok = (l, c, d = "") => { if (c) console.log(`  ok   ${l}`); else { failures++; console.error(`  FAIL ${l}${d ? " — " + d : ""}`); } };
const near = (a, b, t = 1e-4) => Math.abs(a - b) <= t;

const g96 = { markers: [{ position: 0.472, bpm: 96 }], anchor: 0.472, bpm: 96 }; // bar = 2.5s

ok("tail-only trim (head 0) returns the grid unchanged", shiftGrid(g96, 0) === g96);

// head cut of exactly 4 bars past the marker: marker lands on -0 -> 0
const r1 = shiftGrid(g96, 0.472 + 4 * 2.5);
ok("head cut on a downbeat: marker lands at 0", r1 && near(r1.markers[0].position, 0), JSON.stringify(r1?.markers));
ok("anchor becomes 0 after any head cut", r1?.anchor === 0);
ok("bpm is a rate and is untouched", r1?.markers[0].bpm === 96 && r1?.bpm === 96);

// THE 14-TRACK BUG: single marker near 0, cut far past it. Must NOT drop.
const r2 = shiftGrid({ markers: [{ position: 0.28, bpm: 88 }], anchor: 0.28, bpm: 88 }, 24.821);
ok("a single marker sent negative by a big head cut is ADVANCED, not dropped", r2 !== null && r2.markers.length === 1, "grid was dropped");
// it must land in [0, bar) and on the same downbeat lattice
const bar88 = (60 / 88) * 4;
ok("advanced marker lands within one bar of 0", r2 && r2.markers[0].position >= 0 && r2.markers[0].position < bar88 + 1e-6, `pos=${r2?.markers[0].position}`);
const lattice = ((0.28 - 24.821) % bar88 + bar88) % bar88;
ok("advanced marker is on the ORIGINAL downbeat lattice", r2 && near(r2.markers[0].position, lattice, 1e-3), `got ${r2?.markers[0].position}, lattice ${lattice}`);

// multi-marker grid: markers inside the cut are advanced too, later ones just shift
const multi = { markers: [{ position: 1, bpm: 120 }, { position: 41, bpm: 120 }], anchor: 1, bpm: 120 }; // bar=2s
const r3 = shiftGrid(multi, 11);
ok("multi-marker: later marker shifts by exactly head", r3 && near(r3.markers[1].position, 30));
ok("multi-marker: earlier marker survives via advancement", r3 && r3.markers.length === 2 && r3.markers[0].position >= 0);

// a per-marker bpm that differs from grid.bpm is used for THAT marker's advancement
const r4 = shiftGrid({ markers: [{ position: 0.1, bpm: 60 }], anchor: 0.1, bpm: 120 }, 5); // marker bar=4s at 60bpm
ok("advancement uses the marker's own bpm, not grid.bpm", r4 && near(r4.markers[0].position, ((0.1 - 5) % 4 + 4) % 4, 1e-3), `pos=${r4?.markers[0].position}`);

ok("empty grid returns null", shiftGrid({ markers: [], anchor: 0, bpm: 96 }, 5) === null);
ok("null grid returns null", shiftGrid(null, 5) === null);

if (failures) { console.error(`\n${failures} check(s) failed — DO NOT write grids.`); process.exit(1); }
console.log("\nPASS: grid restore shifts and advances correctly");
