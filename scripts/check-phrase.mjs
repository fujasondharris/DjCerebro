#!/usr/bin/env node
// Node-side smoke test for craft pass #2's phrase-aligned-firing math
// (src/lib/phrase.ts) and Camelot harmonic-key conversion
// (src/lib/camelot.ts) — grouped in one script per the dispatch's own script
// list (no separate check:camelot was named). Plain asserts, no test
// framework, mirrors scripts/check-beatclock.mjs/check-energy.mjs.
import { nextPhraseBoundaries } from "../src/lib/phrase.ts";
import { toCamelot } from "../src/lib/camelot.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

// --- nextPhraseBoundaries: basic math, tempo === 1 ---
{
  // 120 BPM, anchor 0 -> phrase interval = (60/120)*16 = 8s. Sitting exactly
  // at t=0 (on a boundary) -> next boundaries are 8, 16, 24, 32 (delay == source distance at tempo 1).
  const grid = { anchor: 0, bpm: 120 };
  const boundaries = nextPhraseBoundaries(grid, 0, 1, 4);
  assertOk("basic: returns the requested count", boundaries.length === 4);
  assertOk("basic: on-the-boundary position advances to the NEXT phrase, not itself", approx(boundaries[0], 8));
  assertOk("basic: subsequent boundaries are one phrase interval apart", approx(boundaries[1] - boundaries[0], 8) && approx(boundaries[2] - boundaries[1], 8));
}
{
  // Mid-phrase position (t=3 of an 8s phrase interval) -> next boundary is 5s away.
  const grid = { anchor: 0, bpm: 120 };
  const boundaries = nextPhraseBoundaries(grid, 3, 1, 1);
  assertOk("mid-phrase: next boundary is the remaining distance to the phrase interval", approx(boundaries[0], 5));
}
{
  // Nonzero anchor still lands boundaries on anchor + n*interval.
  const grid = { anchor: 2, bpm: 120 }; // interval 8s, boundaries at 2, 10, 18, 26...
  const boundaries = nextPhraseBoundaries(grid, 5, 1, 2);
  assertOk("nonzero anchor: first boundary lands on anchor + n*interval (10, 5s away from position 5)", approx(boundaries[0], 5));
  assertOk("nonzero anchor: second boundary is one full interval later", approx(boundaries[1], 13));
}

// --- choir round #2 (C5): epsilon-scale bug — a position a MICROSECOND before a boundary must still return a delay to THAT boundary, not skip a whole extra phrase ---
{
  // 120 BPM, anchor 0 -> phrase interval 8s. Position 7.999999s is 1
  // MICROSECOND before the 8s boundary -> the returned delay must be
  // ~0.000001s (boundary 8 - position 7.999999), not ~8.000001s (the old
  // bug: boundary 16 - position 7.999999 — an epsilon meant for seconds
  // got added directly to the dimensionless phrase-COUNT, an
  // 8-microsecond real-time tolerance for an 8s interval, wide enough to
  // swallow this case and skip a whole extra phrase).
  const grid = { anchor: 0, bpm: 120 };
  const boundaries = nextPhraseBoundaries(grid, 7.999999, 1, 1);
  assertOk(
    "epsilon fix: a position 1 microsecond before a boundary still returns a ~microsecond delay to it, not ~8 extra seconds",
    approx(boundaries[0], 0.000001, 1e-5) && boundaries[0] < 0.01
  );
}
{
  // Same case at a LONGER phrase interval (60 BPM -> 16s interval) — the
  // real-time tolerance must stay tiny regardless of how long the phrase
  // is (the old bug scaled worse the longer the interval: an 8s interval
  // gave an 8-microsecond tolerance window, so a 16s interval would have
  // given a 16-microsecond one — still tiny in absolute terms, but this
  // confirms the FIXED math scales the tolerance down with 1/interval
  // rather than staying a flat, unscaled constant).
  const grid = { anchor: 0, bpm: 60 };
  const boundaries = nextPhraseBoundaries(grid, 15.999999, 1, 1);
  assertOk(
    "epsilon fix: same 1-microsecond-early case at a 16s phrase interval still returns a ~microsecond delay",
    approx(boundaries[0], 0.000001, 1e-5) && boundaries[0] < 0.01
  );
}

// --- output-time conversion, tempo != 1 ---
{
  // tempo 1.05 -> the SAME source-time distance converts to a SHORTER
  // output-time delay (source-time elapses faster per output-second at a
  // higher tempo) — delay = sourceDistance / tempo.
  const grid = { anchor: 0, bpm: 120 }; // interval 8s
  const atTempo1 = nextPhraseBoundaries(grid, 0, 1, 1)[0];
  const atTempoFast = nextPhraseBoundaries(grid, 0, 1.05, 1)[0];
  assertOk("tempo != 1: faster tempo -> shorter output-time delay for the same source distance", atTempoFast < atTempo1);
  assertOk("tempo != 1: delay == sourceDistance / tempo exactly", approx(atTempoFast, 8 / 1.05));
}
{
  const grid = { anchor: 0, bpm: 120 };
  const atTempoSlow = nextPhraseBoundaries(grid, 0, 0.95, 1)[0];
  assertOk("tempo != 1: slower tempo -> longer output-time delay", approx(atTempoSlow, 8 / 0.95) && atTempoSlow > 8);
}

// --- null-grid fallback ---
{
  assertOk("null grid, no fallback bpm: empty list (never fabricates a beat)", nextPhraseBoundaries(null, 10, 1, 4).length === 0);
}
{
  // Null grid but a fallback BPM is given -> treated as an anchor-0 estimated grid.
  const withFallback = nextPhraseBoundaries(null, 3, 1, 1, 120);
  const withExplicitAnchor0 = nextPhraseBoundaries({ anchor: 0, bpm: 120 }, 3, 1, 1);
  assertOk("null grid + fallback bpm: matches an explicit anchor-0/bpm grid exactly", approx(withFallback[0], withExplicitAnchor0[0]));
}
{
  assertOk("null grid + fallback bpm <= 0: still empty (never divides by a bogus bpm)", nextPhraseBoundaries(null, 3, 1, 1, 0).length === 0);
  assertOk("null grid + null fallback: empty", nextPhraseBoundaries(null, 3, 1, 1, null).length === 0);
}

// --- degenerate inputs ---
{
  assertOk("count 0: empty list", nextPhraseBoundaries({ anchor: 0, bpm: 120 }, 0, 1, 0).length === 0);
  assertOk("count negative: empty list", nextPhraseBoundaries({ anchor: 0, bpm: 120 }, 0, 1, -1).length === 0);
  assertOk("tempo 0: empty list (would divide by zero)", nextPhraseBoundaries({ anchor: 0, bpm: 120 }, 0, 0, 1).length === 0);
  assertOk("tempo negative: empty list", nextPhraseBoundaries({ anchor: 0, bpm: 120 }, 0, -1, 1).length === 0);
  assertOk("grid bpm 0: empty list", nextPhraseBoundaries({ anchor: 0, bpm: 0 }, 0, 1, 1).length === 0);
}

// --- toCamelot: pass-through, musical-key conversion, unknown input ---
assertOk("toCamelot: already-Camelot pass-through, normalized case", toCamelot("8a") === "8A");
assertOk("toCamelot: already-Camelot pass-through, unchanged case", toCamelot("11B") === "11B");
assertOk("toCamelot: already-Camelot with stray whitespace", toCamelot(" 5B ") === "5B");

assertOk("toCamelot: Am -> 8A (relative minor of C major)", toCamelot("Am") === "8A");
assertOk("toCamelot: C -> 8B (bare major)", toCamelot("C") === "8B");
assertOk("toCamelot: Cm -> 5A", toCamelot("Cm") === "5A");
assertOk("toCamelot: F#m -> 11A", toCamelot("F#m") === "11A");
assertOk("toCamelot: Gbm -> 11A (enharmonic of F#m)", toCamelot("Gbm") === "11A");
assertOk("toCamelot: C#m -> 12A", toCamelot("C#m") === "12A");
assertOk("toCamelot: Dbm -> 12A (enharmonic of C#m, the ID3 spec's own example)", toCamelot("Dbm") === "12A");
assertOk("toCamelot: F# -> 2B", toCamelot("F#") === "2B");
assertOk("toCamelot: Gb -> 2B (enharmonic)", toCamelot("Gb") === "2B");
assertOk("toCamelot: 'A minor' (spelled out) -> 8A", toCamelot("A minor") === "8A");
assertOk("toCamelot: 'C Major' (spelled out, mixed case) -> 8B", toCamelot("C Major") === "8B");
assertOk("toCamelot: lowercase note letter -> still parses", toCamelot("am") === "8A");

assertOk("toCamelot: unknown input 'o' (ID3 off-key marker) -> null", toCamelot("o") === null);
assertOk("toCamelot: unparseable garbage -> null", toCamelot("xyz123") === null);
assertOk("toCamelot: empty string -> null", toCamelot("") === null);
assertOk("toCamelot: null -> null", toCamelot(null) === null);
assertOk("toCamelot: undefined -> null", toCamelot(undefined) === null);
assertOk("toCamelot: out-of-range Camelot number (13A) -> falls through to null (not valid Camelot or a musical key)", toCamelot("13A") === null);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all phrase/camelot cases");
