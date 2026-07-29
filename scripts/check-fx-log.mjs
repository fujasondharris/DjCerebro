#!/usr/bin/env node
// Node-side smoke test for the fx-demonstration log's pure summarization
// logic (scope addendum, 2026-07-26 — see src/lib/fx-log.ts's file header):
// imports the exact same module src/app/page.tsx/src/lib/brain.ts use and
// asserts summarizeFxDemonstrations() — empty log, per-fx aggregation
// (count/median/shares), the last-quarter share ignoring unknown positions,
// the recent-sample cap/order, and cap-eviction behavior of
// appendFxDemonstration() against a fake localStorage. Plain asserts, no
// test framework, mirrors check-lessons.mjs.
import { summarizeFxDemonstrations, appendFxDemonstration, EMPTY_FX_DEMONSTRATION_SUMMARY } from "../src/lib/fx-log.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

let nextAt = 1000;
function makeEntry(overrides = {}) {
  return {
    fx: "airhorn",
    trackName: "Track One",
    bpm: 120,
    positionFraction: 0.8,
    remainingSeconds: 12,
    tempo: 1,
    duringTransition: false,
    at: nextAt++,
    ...overrides,
  };
}

// --- empty log -> the shared empty-summary constant ---
{
  const summary = summarizeFxDemonstrations([]);
  assertOk("empty log -> byFx []", Array.isArray(summary.byFx) && summary.byFx.length === 0);
  assertOk("empty log -> recent []", Array.isArray(summary.recent) && summary.recent.length === 0);
  assertOk("empty log -> the exported empty-summary constant", summary === EMPTY_FX_DEMONSTRATION_SUMMARY);
}

// --- per-fx aggregation: count, median position, shares ---
{
  const entries = [
    makeEntry({ fx: "airhorn", positionFraction: 0.9, duringTransition: false }),
    makeEntry({ fx: "airhorn", positionFraction: 0.85, duringTransition: false }),
    makeEntry({ fx: "airhorn", positionFraction: 0.95, duringTransition: true }),
  ];
  const summary = summarizeFxDemonstrations(entries);
  const airhorn = summary.byFx.find((s) => s.fx === "airhorn");
  assertOk("airhorn: count 3", airhorn.count === 3);
  assertOk("airhorn: median position is the middle sample (0.9) of [0.85,0.9,0.95]", airhorn.medianPositionFraction === 0.9);
  assertOk("airhorn: shareDuringTransition 1/3", Math.abs(airhorn.shareDuringTransition - 1 / 3) < 1e-9);
  assertOk("airhorn: shareInLastQuarter 1.0 (all three >= 0.75)", airhorn.shareInLastQuarter === 1);
}

// --- even-length median (average of the two middle values) ---
{
  const entries = [
    makeEntry({ fx: "siren", positionFraction: 0.2 }),
    makeEntry({ fx: "siren", positionFraction: 0.4 }),
    makeEntry({ fx: "siren", positionFraction: 0.6 }),
    makeEntry({ fx: "siren", positionFraction: 0.8 }),
  ];
  const summary = summarizeFxDemonstrations(entries);
  const siren = summary.byFx.find((s) => s.fx === "siren");
  assertOk("siren: even-length median averages the two middle values (0.4,0.6 -> 0.5)", siren.medianPositionFraction === 0.5);
  assertOk("siren: shareInLastQuarter 1/4 (only 0.8 >= 0.75)", Math.abs(siren.shareInLastQuarter - 0.25) < 1e-9);
}

// --- unknown positions (null) are excluded from median/lastQuarter but still counted ---
{
  const entries = [
    makeEntry({ fx: "laser", positionFraction: null }),
    makeEntry({ fx: "laser", positionFraction: null }),
    makeEntry({ fx: "laser", positionFraction: 0.9 }),
  ];
  const summary = summarizeFxDemonstrations(entries);
  const laser = summary.byFx.find((s) => s.fx === "laser");
  assertOk("laser: count includes null-position entries (3)", laser.count === 3);
  assertOk("laser: median computed only from the one known position (0.9)", laser.medianPositionFraction === 0.9);
  assertOk("laser: shareInLastQuarter computed only over known positions (1/1 = 1.0, not 1/3)", laser.shareInLastQuarter === 1);
}

// --- an fx with NO known positions at all -> null median, 0 lastQuarter share (no divide-by-zero) ---
{
  const entries = [makeEntry({ fx: "brake", positionFraction: null }), makeEntry({ fx: "brake", positionFraction: null })];
  const summary = summarizeFxDemonstrations(entries);
  const brake = summary.byFx.find((s) => s.fx === "brake");
  assertOk("brake: all-unknown positions -> median null", brake.medianPositionFraction === null);
  assertOk("brake: all-unknown positions -> shareInLastQuarter 0 (no NaN)", brake.shareInLastQuarter === 0);
}

// --- byFx sort: most-fired first, ties broken alphabetically ---
{
  const entries = [
    makeEntry({ fx: "z-rare" }),
    makeEntry({ fx: "airhorn" }),
    makeEntry({ fx: "airhorn" }),
    makeEntry({ fx: "brake" }),
    makeEntry({ fx: "brake" }),
  ];
  const summary = summarizeFxDemonstrations(entries);
  assertOk("sort: airhorn (2) and brake (2) tie and sort before z-rare (1)", summary.byFx[2].fx === "z-rare");
  assertOk("sort: tie between airhorn/brake (both count 2) broken alphabetically", summary.byFx[0].fx === "airhorn" && summary.byFx[1].fx === "brake");
}

// --- recent: newest-first, capped at 8, compact shape ---
{
  const entries = [];
  for (let i = 0; i < 12; i++) {
    entries.push(makeEntry({ fx: `fx-${i}`, positionFraction: i / 12 }));
  }
  const summary = summarizeFxDemonstrations(entries);
  assertOk("recent: capped at 8 entries even with 12 in the log", summary.recent.length === 8);
  assertOk("recent: newest-first (last appended is first)", summary.recent[0].fx === "fx-11");
  assertOk("recent: oldest of the 8 is fx-4 (12 entries, last 8 kept)", summary.recent[7].fx === "fx-4");
  assertOk(
    "recent: compact shape (fx/positionFraction/duringTransition only, no trackName/bpm/tempo/at)",
    Object.keys(summary.recent[0]).sort().join(",") === "duringTransition,fx,positionFraction"
  );
}

// --- determinism: repeated calls produce byte-identical output ---
{
  const entries = [makeEntry({ fx: "cheer" }), makeEntry({ fx: "cheer", duringTransition: true })];
  const first = summarizeFxDemonstrations(entries);
  const second = summarizeFxDemonstrations(entries);
  assertOk("determinism: repeated calls produce identical output", JSON.stringify(first) === JSON.stringify(second));
}

// --- appendFxDemonstration: cap eviction against a fake localStorage ---
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };

  let list = [];
  for (let i = 0; i < 205; i++) {
    list = appendFxDemonstration(makeEntry({ fx: `evict-${i}` }));
  }
  assertOk("appendFxDemonstration: caps the persisted log at 200 entries", list.length === 200);
  assertOk("appendFxDemonstration: evicts the OLDEST entries first (evict-5 survives, evict-4 evicted)", list[0].fx === "evict-5");
  assertOk("appendFxDemonstration: the most recent append is last", list[list.length - 1].fx === "evict-204");

  delete globalThis.localStorage;
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all fx-log cases");
