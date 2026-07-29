#!/usr/bin/env node
// Node-side smoke test for audio engine v2 Part 3's pure loop-blend planner
// (src/lib/loop-blend.ts's planLoopBlend) — phrase-snapped 4-bar/16-beat
// capture, the no-grid fallback (null, never an unsnapped guess), and the
// OUTPUT-time total-duration math. fireLoopOverlay() itself is the thin,
// unverifiable-here shell (no AudioContext in this environment, same class
// as scratch.ts/roll.ts's real-node halves). Plain asserts, no test
// framework.
import { planLoopBlend, DEFAULT_LOOP_BLEND_BARS } from "../src/lib/loop-blend.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

function approxEqual(a, b, epsilon = 1e-9) {
  return Math.abs(a - b) < epsilon;
}

const grid0 = { anchor: 0, bpm: 120 }; // 16 beats @ 120bpm = 8s phrase interval

// --- no-grid fallback: never attempt an unsnapped loop ---
assertOk("null grid returns null (no fallback estimate)", planLoopBlend(null, 30, 120, 1, 16) === null);
assertOk("a grid with bpm<=0 also returns null", planLoopBlend({ anchor: 0, bpm: 0 }, 30, 120, 1, 16) === null);
assertOk("a grid with non-finite bpm returns null", planLoopBlend({ anchor: 0, bpm: NaN }, 30, 120, 1, 16) === null);

// --- captured-slice phrase snapping, anchor 0 ---
{
  // position 20s is inside the [16,24) phrase window (phrases at 0,8,16,24,...).
  const plan = planLoopBlend(grid0, 20, 120, 1, 16);
  assertOk("captured slice starts at the phrase boundary just passed (16s)", approxEqual(plan.loopStart, 16));
  assertOk("captured slice is exactly 16 beats (8s @ 120bpm) long", approxEqual(plan.loopEnd - plan.loopStart, 8));
}
{
  // position exactly ON a boundary counts it as "just passed" (the current one), not the previous one.
  const onBoundary = planLoopBlend(grid0, 24, 120, 1, 16);
  assertOk("position exactly on a phrase boundary snaps to THAT boundary, not the one before it", approxEqual(onBoundary.loopStart, 24));
}

// --- nonzero anchor ---
{
  const grid = { anchor: 3, bpm: 120 }; // phrases at 3, 11, 19, 27, ...
  const plan = planLoopBlend(grid, 15, 120, 1, 16);
  assertOk("nonzero anchor: snaps to the anchor-offset boundary just passed (11s)", approxEqual(plan.loopStart, 11));
}

// --- a negative would-be loopStart snaps FORWARD to the first anchor-aligned boundary >= 0, never an unsnapped clamp (choir round #2, C8) ---
{
  const grid = { anchor: 5, bpm: 120 }; // first real boundary is at 5s, interval 8s
  const plan = planLoopBlend(grid, 2, 120, 1, 16); // before the anchor's own first boundary (rawLoopStart would be -3)
  assertOk(
    "a position before the grid's first boundary snaps to the anchor itself (5s), not an unsnapped clamp to 0",
    approxEqual(plan.loopStart, 5)
  );
  assertOk("the captured slice off that snapped start is still exactly 16 beats (8s @ 120bpm)", approxEqual(plan.loopEnd - plan.loopStart, 8));
}
{
  // A bigger gap between position and anchor (position 1, anchor 20, interval
  // 8s -> boundaries at ...,-4,4,12,20,... the phrase-aligned slice
  // containing position 1 is [-4,4), still negative) must still snap forward
  // to the FIRST anchor-aligned boundary >= 0 (4s here), not merely the next
  // one after the raw negative start (which could itself still be negative).
  const grid = { anchor: 20, bpm: 120 };
  const plan = planLoopBlend(grid, 1, 120, 1, 16);
  assertOk("snaps forward to the first anchor-aligned boundary >= 0 (4s)", approxEqual(plan.loopStart, 4));
  assertOk("stays exactly anchor-aligned (a whole number of 8s phrase intervals from the anchor)", (plan.loopStart - grid.anchor) % 8 === 0);
}

// --- totalDurationSeconds: `bars` bars at the deck's EFFECTIVE bpm (tagged bpm x tempo), independent of the fixed 16-beat capture ---
{
  const plan16 = planLoopBlend(grid0, 20, 120, 1, 16); // 16 bars @ 120bpm = 32s
  assertOk("totalDurationSeconds = bars*4*60/effectiveBpm (16 bars @ 120bpm = 32s)", approxEqual(plan16.totalDurationSeconds, 32));

  const plan4 = planLoopBlend(grid0, 20, 120, 1, 4); // 4 bars @ 120bpm = 8s — same as the captured slice length here, coincidentally
  assertOk("a shorter `bars` shortens totalDurationSeconds independent of the fixed capture", approxEqual(plan4.totalDurationSeconds, 8));
  assertOk("the CAPTURED slice length stays 16 beats regardless of `bars`", approxEqual(plan4.loopEnd - plan4.loopStart, 8));

  assertOk("default bars is DEFAULT_LOOP_BLEND_BARS when omitted", approxEqual(planLoopBlend(grid0, 20, 120, 1).totalDurationSeconds, (DEFAULT_LOOP_BLEND_BARS * 4 * 60) / 120));
}

// --- tempo != 1 folds into totalDurationSeconds (output-time), not the capture (source-time) ---
{
  const bent = planLoopBlend(grid0, 20, 120, 1.08, 16);
  assertOk("tempo > 1 shortens totalDurationSeconds (output-time)", approxEqual(bent.totalDurationSeconds, (16 * 4 * 60) / (120 * 1.08)));
  assertOk("the captured slice (SOURCE-time) is unaffected by tempo", approxEqual(bent.loopEnd - bent.loopStart, 8));
}

// --- half/double bpm sanity ---
{
  const slowGrid = { anchor: 0, bpm: 60 };
  const fastGrid = { anchor: 0, bpm: 120 };
  const slow = planLoopBlend(slowGrid, 20, 60, 1, 16);
  const fast = planLoopBlend(fastGrid, 20, 120, 1, 16);
  assertOk("half-time bpm doubles the captured slice length vs double-time", approxEqual(slow.loopEnd - slow.loopStart, (fast.loopEnd - fast.loopStart) * 2));
  assertOk("half-time bpm doubles totalDurationSeconds vs double-time (same bars/tempo)", approxEqual(slow.totalDurationSeconds, fast.totalDurationSeconds * 2));
}

// --- non-multiple-of-4 `bars` rounds to a whole number of loop cycles (choir round #2, C3) ---
{
  // 10 bars would be 2.5 loop cycles of the fixed 4-bar/16-beat capture —
  // rounds to the nearer multiple (12, since |10-8|=2 ties |10-12|=2 and
  // JS's own round-half-up breaks the tie upward, same convention
  // Math.round already uses everywhere else in this codebase).
  const plan = planLoopBlend(grid0, 20, 120, 1, 10);
  const captureSeconds = plan.loopEnd - plan.loopStart; // 8s (4 bars @ 120bpm)
  const cycles = plan.totalDurationSeconds / captureSeconds;
  assertOk("non-multiple bars (10): totalDurationSeconds is a WHOLE multiple of the captured cycle length", approxEqual(cycles, Math.round(cycles)));
  assertOk("non-multiple bars (10): rounds to 12 bars (24s @ 120bpm), not the raw 10 (20s, 2.5 cycles)", approxEqual(plan.totalDurationSeconds, 24));
}
{
  // 5 bars is closer to 4 than 8 -> rounds DOWN to one whole cycle (never below one full capture).
  const plan = planLoopBlend(grid0, 20, 120, 1, 5);
  assertOk("non-multiple bars (5, closer to 4): rounds down to 4 bars (8s @ 120bpm)", approxEqual(plan.totalDurationSeconds, 8));
}
{
  // A tiny `bars` (e.g. 1, below one full capture) still rounds UP to at least one whole cycle — never a fractional/zero-cycle plan.
  const plan = planLoopBlend(grid0, 20, 120, 1, 1);
  assertOk("bars below one capture length (1): clamps up to one full 4-bar cycle (8s @ 120bpm), never a fraction", approxEqual(plan.totalDurationSeconds, 8));
}

// --- bpm param falls back to grid.bpm when the tagged bpm itself is missing/non-positive ---
{
  const untaggedBpm = planLoopBlend(grid0, 20, 0, 1, 16);
  assertOk("bpm<=0 falls back to grid.bpm for the duration math (finite, not NaN)", Number.isFinite(untaggedBpm.totalDurationSeconds) && untaggedBpm.totalDurationSeconds > 0);
  assertOk("that fallback matches using grid.bpm directly", approxEqual(untaggedBpm.totalDurationSeconds, planLoopBlend(grid0, 20, grid0.bpm, 1, 16).totalDurationSeconds));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all loop-blend planning cases");
