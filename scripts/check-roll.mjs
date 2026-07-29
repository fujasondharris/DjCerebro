#!/usr/bin/env node
// Node-side smoke test for audio engine v2 Part 2's pure roll planner
// (src/lib/roll.ts's planRoll) — slice alignment/length per subdivision,
// playbackRate tracking the deck's tempo, and OUTPUT-time duration math. No
// AudioContext (fireRoll() itself is the thin, unverifiable-here shell, same
// class as scratch.ts's scratch()). Plain asserts, no test framework.
import { planRoll, DEFAULT_ROLL_BEATS } from "../src/lib/roll.ts";

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

// --- subdivision slice lengths @ 120bpm, tempo 1 (secondsPerBeat = 0.5) ---
{
  const pos = 60;
  const eighth = planRoll(pos, 120, 1, "1/8");
  const quarter = planRoll(pos, 120, 1, "1/4");
  const half = planRoll(pos, 120, 1, "1/2");
  const whole = planRoll(pos, 120, 1, "1");

  assertOk("1/8: slice length = 0.25s (0.5 beat)", approxEqual(eighth.loopEnd - eighth.loopStart, 0.25));
  assertOk("1/4: slice length = 0.5s (1 beat)", approxEqual(quarter.loopEnd - quarter.loopStart, 0.5));
  assertOk("1/2: slice length = 1.0s (2 beats)", approxEqual(half.loopEnd - half.loopStart, 1.0));
  assertOk('"1" (one bar): slice length = 2.0s (4 beats)', approxEqual(whole.loopEnd - whole.loopStart, 2.0));

  assertOk("slice ends exactly at the fire position (backward-aligned)", eighth.loopEnd === pos);
  assertOk("longer subdivisions read further back", whole.loopStart < half.loopStart && half.loopStart < quarter.loopStart);
}

// --- backward alignment near track start clamps to 0, never negative ---
{
  const plan = planRoll(0.1, 120, 1, "1"); // one-bar slice (2s) would read to -1.9s
  assertOk("clamps loopStart at 0 rather than going negative", plan.loopStart === 0);
  assertOk("loopEnd stays at the fire position", plan.loopEnd === 0.1);
}

// --- playbackRate tracks the deck's CURRENT tempo (per this pass's pinned FACTS) ---
{
  assertOk("playbackRate = tempo at 1.0", planRoll(30, 120, 1, "1/4").playbackRate === 1);
  assertOk("playbackRate = tempo when tempo-bent up", planRoll(30, 120, 1.05, "1/4").playbackRate === 1.05);
  assertOk("playbackRate = tempo when tempo-bent down", planRoll(30, 120, 0.92, "1/4").playbackRate === 0.92);
}

// --- durationSeconds: OUTPUT-time, rollBeats worth of the tagged bpm, tempo-divided ---
{
  // 4 beats @ 120bpm (default) = 2 SOURCE-seconds; at tempo 1, output = 2s.
  const atTempo1 = planRoll(30, 120, 1, "1/4");
  assertOk("durationSeconds @ tempo 1, default rollBeats (4) = 2s", approxEqual(atTempo1.durationSeconds, 2));

  // At tempo 1.08 (a bent-up deck), the SAME 4 source-beats pass in LESS output-time.
  const atTempoUp = planRoll(30, 120, 1.08, "1/4");
  assertOk("durationSeconds shrinks at tempo > 1 (output-time, not source-time)", approxEqual(atTempoUp.durationSeconds, 2 / 1.08));

  // Explicit rollBeats override.
  const eightBeats = planRoll(30, 120, 1, "1/2", 8);
  assertOk("durationSeconds scales with an explicit rollBeats override", approxEqual(eightBeats.durationSeconds, (8 * 60) / 120));

  assertOk("DEFAULT_ROLL_BEATS is 4 (one bar)", DEFAULT_ROLL_BEATS === 4);
}

// --- half/double bpm sanity ---
{
  const slow = planRoll(30, 60, 1, "1/4");
  const fast = planRoll(30, 120, 1, "1/4");
  assertOk("half-time bpm doubles the slice length vs double-time, same subdivision", approxEqual((slow.loopEnd - slow.loopStart), (fast.loopEnd - fast.loopStart) * 2));
  assertOk("half-time bpm doubles the roll duration vs double-time", approxEqual(slow.durationSeconds, fast.durationSeconds * 2));
}

// --- degenerate input: no usable bpm never fabricates a beat ---
{
  const noBpm = planRoll(30, 0, 1, "1/4");
  assertOk("bpm<=0 collapses to a zero-length/zero-duration plan, not NaN/negative", noBpm.loopStart === noBpm.loopEnd && noBpm.durationSeconds === 0);
  assertOk("bpm<=0 plan still reports a finite playbackRate", Number.isFinite(noBpm.playbackRate));

  const negativeBpm = planRoll(30, -50, 1, "1/8");
  assertOk("negative bpm also collapses cleanly", negativeBpm.loopStart === negativeBpm.loopEnd);

  const nonFiniteTempo = planRoll(30, 120, 0, "1/4");
  assertOk("tempo<=0 falls back to a safe (1) tempo rather than dividing by zero", Number.isFinite(nonFiniteTempo.durationSeconds) && nonFiniteTempo.playbackRate > 0);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all roll planning cases");
