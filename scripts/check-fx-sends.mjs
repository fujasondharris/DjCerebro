#!/usr/bin/env node
// Node-side smoke test for audio engine v2 Part 1's pure planning helpers
// (src/lib/fx-sends.ts) — delay-time math, the echo-tail/echo-out timeline,
// filter-sweep clamping, and the reverb IR's decay envelope. No AudioContext
// anywhere here (see the file's own doc comments for what's real-node and
// therefore unverifiable in this environment). Plain asserts, no test
// framework, mirrors check-scratch.mjs/check-phrase.mjs.
import {
  clampWet,
  effectiveBpmOf,
  delayTimeForBeats,
  barSecondsForBeats,
  planEchoTail,
  planEchoOutTimeline,
  sweepPlan,
  reverbDecayEnvelope,
  needsDeferredMaskFxRelease,
  ECHO_WET_CAP,
  REVERB_WET_CAP,
  DEFAULT_ECHO_RING_REPEATS,
  NEUTRAL_HPF_HZ,
  NEUTRAL_LPF_HZ,
  MIN_SWEEP_HZ,
  MAX_SWEEP_HZ,
} from "../src/lib/fx-sends.ts";

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

// --- clampWet ---
assertOk("clampWet: within range unchanged", clampWet(0.2) === 0.2);
assertOk("clampWet: caps at ECHO_WET_CAP (0.4)", clampWet(0.9) === ECHO_WET_CAP);
assertOk("clampWet: floors at 0 (negative)", clampWet(-0.5) === 0);
assertOk("clampWet: custom cap respected", clampWet(0.9, REVERB_WET_CAP) === REVERB_WET_CAP);
assertOk("clampWet: non-finite input treated as 0", clampWet(NaN) === 0);

// --- effectiveBpmOf ---
assertOk("effectiveBpmOf: tempo 1 is a no-op", effectiveBpmOf(120, 1) === 120);
assertOk("effectiveBpmOf: tempo != 1 scales", approxEqual(effectiveBpmOf(120, 1.05), 126));
assertOk("effectiveBpmOf: tempo < 1 scales down", approxEqual(effectiveBpmOf(120, 0.92), 110.4));

// --- delayTimeForBeats: tempo != 1 (caller pre-multiplies into effectiveBpm), half/double bpm ---
assertOk("delayTimeForBeats: 1 beat @ 120bpm = 0.5s", approxEqual(delayTimeForBeats(120, 1), 0.5));
assertOk("delayTimeForBeats: 0.75 beat @ 120bpm = 0.375s", approxEqual(delayTimeForBeats(120, 0.75), 0.375));
assertOk(
  "delayTimeForBeats: tempo != 1 folded into effectiveBpm (120bpm @ tempo 1.08 -> 129.6bpm)",
  approxEqual(delayTimeForBeats(effectiveBpmOf(120, 1.08), 1), 60 / 129.6)
);
assertOk("delayTimeForBeats: half-time bpm (60) doubles the delay vs 120bpm", approxEqual(delayTimeForBeats(60, 1), 1.0));
assertOk("delayTimeForBeats: double-time bpm (240) halves the delay vs 120bpm", approxEqual(delayTimeForBeats(240, 1), 0.25));
assertOk("delayTimeForBeats: no usable bpm falls back to a fixed default, not zero/NaN", delayTimeForBeats(0, 1) > 0 && Number.isFinite(delayTimeForBeats(0, 1)));
assertOk("delayTimeForBeats: negative bpm also falls back", delayTimeForBeats(-10, 1) === delayTimeForBeats(0, 1));

// --- barSecondsForBeats (same math, named for the dry-cut-timing call site) ---
assertOk("barSecondsForBeats: one bar (4 beats) @ 120bpm = 2s", approxEqual(barSecondsForBeats(120, 4), 2));

// --- planEchoTail: the ring/wet timeline ---
{
  const plan = planEchoTail(120, 0.75, 0.55, 0.9, 3, 0.5); // wetLevel 0.9 should clamp to 0.4
  assertOk("planEchoTail: delayTimeSeconds matches delayTimeForBeats", approxEqual(plan.delayTimeSeconds, 0.375));
  assertOk("planEchoTail: wetLevel clamped to the pro rule (0.4)", plan.wetLevel === ECHO_WET_CAP);
  assertOk("planEchoTail: ringSeconds = delayTime * repeats (0.375*3=1.125)", approxEqual(plan.ringSeconds, 1.125));
  assertOk("planEchoTail: rampOutSeconds passed through", plan.rampOutSeconds === 0.5);
  assertOk("planEchoTail: feedback passed through unmodified", plan.feedback === 0.55);
}
{
  const defaultPlan = planEchoTail(100, 1, 0.4, 0.2); // default repeats/rampOut
  assertOk(
    "planEchoTail: default repeats = DEFAULT_ECHO_RING_REPEATS",
    approxEqual(defaultPlan.ringSeconds, delayTimeForBeats(100, 1) * DEFAULT_ECHO_RING_REPEATS)
  );
}
assertOk("planEchoTail: repeats floors at 1 (never a zero/negative ring)", planEchoTail(120, 1, 0.5, 0.3, 0).ringSeconds > 0);

// --- planEchoOutTimeline: when dry cuts vs when the wet ramp starts fading ---
{
  // Pure formula check at cutBeats=4 (NOT transition.ts's own production
  // constant — see the dedicated production-values block below for that).
  // Choir round #2 (C1) note: at these particular inputs the ring
  // (0.375*3=1.125s) actually finishes BEFORE the 4-beat/2s dry cut — this
  // block only verifies the formula's arithmetic, it does NOT claim the
  // tail rings past the cut (the mislabeled assertion this used to carry,
  // now fixed — see below for the real "rings past the cut" assertion
  // against transition.ts's actual ECHO_CUT_BEATS).
  const timeline = planEchoOutTimeline(120, 4, 0.75, 0.55, 0.4);
  assertOk("planEchoOutTimeline: dryCutAtSeconds = 4 beats @ 120bpm = 2s", approxEqual(timeline.dryCutAtSeconds, 2));
  assertOk("planEchoOutTimeline: wetRampOutAtSeconds = the echo ring (0.375*3=1.125s)", approxEqual(timeline.wetRampOutAtSeconds, 1.125));
  assertOk("planEchoOutTimeline: delayTimeSeconds is the echo repeat interval, not the bar length", approxEqual(timeline.delayTimeSeconds, 0.375));
  assertOk("planEchoOutTimeline: wetLevel passed through clamped", timeline.wetLevel === 0.4);
}
{
  // Choir round #2 (C1) — the ACTUAL production timeline: transition.ts
  // calls this with ECHO_CUT_BEATS=1 (cut on the next beat), ECHO_RING_BEATS
  // =0.75, DEFAULT_ECHO_RING_REPEATS=3 (the defaults below). The dry cut
  // MUST happen strictly BEFORE the ring finishes fading, or the "cut dry,
  // tail rings on" effect never actually happens (the bug this pins).
  const productionTimeline = planEchoOutTimeline(120, 1, 0.75, 0.55, 0.4);
  assertOk(
    "planEchoOutTimeline: production values — dry cut (1 beat) happens BEFORE the ring window ends (2.25 beats), so the tail keeps ringing PAST the cut",
    productionTimeline.wetRampOutAtSeconds > productionTimeline.dryCutAtSeconds
  );
  assertOk("planEchoOutTimeline: production dryCutAtSeconds = 1 beat @ 120bpm = 0.5s", approxEqual(productionTimeline.dryCutAtSeconds, 0.5));
  assertOk("planEchoOutTimeline: production wetRampOutAtSeconds = 3 repeats of the 0.375s interval = 1.125s", approxEqual(productionTimeline.wetRampOutAtSeconds, 1.125));
}
{
  // Half/double bpm sanity — an 86bpm track's timeline should be exactly 2x a 172bpm track's (same beat count, half the tempo).
  const slow = planEchoOutTimeline(86, 4, 0.75, 0.55, 0.3);
  const fast = planEchoOutTimeline(172, 4, 0.75, 0.55, 0.3);
  assertOk("planEchoOutTimeline: half-time bpm doubles dryCutAtSeconds vs double-time", approxEqual(slow.dryCutAtSeconds, fast.dryCutAtSeconds * 2, 1e-9));
  assertOk("planEchoOutTimeline: half-time bpm doubles the ring window vs double-time", approxEqual(slow.wetRampOutAtSeconds, fast.wetRampOutAtSeconds * 2, 1e-9));
}
{
  // tempo != 1: caller folds tempo into effectiveBpm before calling — verify the composition end to end.
  const bent = planEchoOutTimeline(effectiveBpmOf(128, 0.94), 4, 1, 0.5, 0.3);
  assertOk("planEchoOutTimeline: tempo-bent effectiveBpm changes the timeline vs untouched 128bpm", !approxEqual(bent.dryCutAtSeconds, planEchoOutTimeline(128, 4, 1, 0.5, 0.3).dryCutAtSeconds));
}

// --- sweepPlan: clamping + duration safety ---
assertOk("sweepPlan: value within range unchanged", sweepPlan(800, 1).targetHz === 800);
assertOk("sweepPlan: clamps above MAX_SWEEP_HZ", sweepPlan(50000, 1).targetHz === MAX_SWEEP_HZ);
assertOk("sweepPlan: clamps below MIN_SWEEP_HZ", sweepPlan(1, 1).targetHz === MIN_SWEEP_HZ);
assertOk("sweepPlan: negative duration floors at 0", sweepPlan(500, -3).seconds === 0);
assertOk("sweepPlan: non-finite target falls back to NEUTRAL_HPF_HZ", sweepPlan(NaN, 1).targetHz === NEUTRAL_HPF_HZ);
assertOk("sweepPlan: filterRelease-style call to NEUTRAL_LPF_HZ passes through unclamped", sweepPlan(NEUTRAL_LPF_HZ, 0.5).targetHz === NEUTRAL_LPF_HZ);

// --- reverbDecayEnvelope: pure decay shape, no AudioContext ---
assertOk("reverbDecayEnvelope: starts at 1 (full amplitude at the impulse's own start)", reverbDecayEnvelope(0) === 1);
assertOk("reverbDecayEnvelope: ends at 0 (silence at the impulse's own end)", reverbDecayEnvelope(1) === 0);
assertOk("reverbDecayEnvelope: monotonically decreasing across the span", (() => {
  let prev = reverbDecayEnvelope(0);
  for (let i = 1; i <= 20; i++) {
    const v = reverbDecayEnvelope(i / 20);
    if (v > prev) return false;
    prev = v;
  }
  return true;
})());
assertOk("reverbDecayEnvelope: clamps a fraction above 1 to the same as 1 (never negative/undefined)", reverbDecayEnvelope(1.5) === 0);
assertOk("reverbDecayEnvelope: clamps a fraction below 0 to the same as 0", reverbDecayEnvelope(-0.5) === 1);

// --- needsDeferredMaskFxRelease (choir round #2, C4) ---
assertOk("needsDeferredMaskFxRelease: threshold 1 (cut/echo_out/gap/loop_blend) needs a deferred release", needsDeferredMaskFxRelease(1) === true);
assertOk("needsDeferredMaskFxRelease: threshold 0.5 (beatmatch_crossfade/bass_swap) releases immediately", needsDeferredMaskFxRelease(0.5) === false);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all fx-sends planning cases");
