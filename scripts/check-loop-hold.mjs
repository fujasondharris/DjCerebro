#!/usr/bin/env node
// Node-side check for M7 Phase 2's pure held-loop planner
// (src/lib/loop-hold.ts's planHeldLoop / planHalvingStages / rateForStage /
// isolationEq). fireIsolatedLoopHold() is the thin, unverifiable-here shell
// (no AudioContext in this environment), same split as
// loop-blend.ts/roll.ts/scratch.ts. Plain asserts, no test framework.
//
// The load-bearing assertions here are the ones behind GOAL-M7.md's
// acceptance criteria: whole loop cycles at every stage, a total that is a
// whole number of 16-beat phrases (so the exit lands on the "1"), and a
// final stage pinned to rate 1.0 (the track's original key).
import {
  planHeldLoop,
  planHalvingStages,
  rateForStage,
  isolationEq,
  sampleMixFrame,
  sampleMixEnvelope,
  sampleMixFxFrame,
  sampleMixHandoffIsLate,
  SAMPLE_MIX_ACTIVATION_LATE_TOLERANCE_MS,
  EQ_KILL_DB,
  SAMPLE_MIX_HANDOFF_BEATS,
  MELODY_LOW_DUCK_DB,
} from "../src/lib/loop-hold.ts";
import { planLoopBlend, DEFAULT_LOOP_CAPTURE_BEATS } from "../src/lib/loop-blend.ts";

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

const grid120 = { anchor: 0, bpm: 120 }; // 0.5s/beat, 16-beat phrase = 8s

// --- Band isolation mirrors deck.ts's own kill depth --------------------
{
  const beat = isolationEq("beat");
  assertOk("beat mode kills mid and high, keeps low", beat.low === 0 && beat.mid === EQ_KILL_DB && beat.high === EQ_KILL_DB);
  const melody = isolationEq("melody");
  // M8.2h: melody DUCKS the low band, never kills it (owner heard the kill as "a stem
  // without any drums on a loop" — a violation of ALWAYS A BASSLINE LOOPING).
  assertOk("melody mode DUCKS low (not a full kill), keeps mid and high", melody.low === MELODY_LOW_DUCK_DB && melody.low > EQ_KILL_DB && melody.mid === 0 && melody.high === 0);
  assertOk("melody mode leaves an audible floor: duck is shallower than -20 dB", melody.low > -20);
  assertOk("the kill depth is deck.ts's own EQ_KILL_DB (-40)", EQ_KILL_DB === -40);
  assertOk("the two modes are not the same settings", JSON.stringify(beat) !== JSON.stringify(melody));
}

// --- The ACTUAL overlay fades/EQs during the final handoff -------------
{
  const start = sampleMixFrame(0, "beat");
  const middle = sampleMixFrame(0.5, "beat");
  const end = sampleMixFrame(1, "beat");
  assertOk("sample handoff starts with only the sampled loop audible", approxEqual(start.sampleGain, 1) && approxEqual(start.incomingGain, 0));
  assertOk("sample handoff midpoint is equal-power", approxEqual(middle.sampleGain, Math.SQRT1_2) && approxEqual(middle.incomingGain, Math.SQRT1_2));
  assertOk("sample handoff ends with only the incoming deck audible", Math.abs(end.sampleGain) < 1e-9 && approxEqual(end.incomingGain, 1));
  assertOk("beat sample and incoming bass trade places gradually", start.sampleLowDb === 0 && start.incomingLowDb === EQ_KILL_DB && end.sampleLowDb === EQ_KILL_DB && end.incomingLowDb === 0);
  assertOk("melody sample keeps its low band DUCKED (not killed) throughout", sampleMixFrame(0, "melody").sampleLowDb === MELODY_LOW_DUCK_DB && sampleMixFrame(1, "melody").sampleLowDb === MELODY_LOW_DUCK_DB);

  const lateEnvelope = sampleMixEnvelope("beat", 0.25, 4);
  assertOk("late handoff envelope starts at the requested progress", approxEqual(lateEnvelope.incomingGain[0], sampleMixFrame(0.25, "beat").incomingGain));
  assertOk("late handoff envelope still resolves fully", approxEqual(lateEnvelope.incomingGain.at(-1), 1) && Math.abs(lateEnvelope.sampleGain.at(-1)) < 1e-9);
  assertOk("handoff timer accepts normal jitter", !sampleMixHandoffIsLate(10_250, 10_000));
  assertOk("handoff timer rejects phrase-damaging lateness", sampleMixHandoffIsLate(10_251, 10_000));
  assertOk("activation guard rejects a duck timer outside its short lead window", sampleMixHandoffIsLate(10_041, 10_000, SAMPLE_MIX_ACTIVATION_LATE_TOLERANCE_MS));
  assertOk("seam FX stays silent through the first two handoff bars", sampleMixFxFrame(0.5).wetShape === 0);
  assertOk("seam FX blooms between its insert point and resolve", sampleMixFxFrame(0.75).wetShape > 0.99);
  assertOk("seam FX returns to silence on the final 1", Math.abs(sampleMixFxFrame(1).wetShape) < 1e-9);
}

// --- planHalvingStages: 4 bars -> 2 -> 1 -> 1/2 -> 1 beat ---------------
{
  const stages = planHalvingStages(16, 4);
  assertOk("halving from a 16-beat base yields 8, 4, 2, 1", stages.map((s) => s.captureBeats).join(",") === "8,4,2,1");
  assertOk("every halved stage plays whole cycles", stages.every((s) => Number.isInteger(s.cycles) && s.cycles >= 1));
  assertOk("halving stops at 1 beat, never below", planHalvingStages(16, 8).every((s) => s.captureBeats >= 1));
  assertOk("a 0-stage tail is empty (halving disabled)", planHalvingStages(16, 0).length === 0);
  assertOk("cyclesPerStage is honored", planHalvingStages(16, 2, 3).every((s) => s.cycles === 3));
  assertOk("minBeats floors the halving", planHalvingStages(16, 5, 2, 4).map((s) => s.captureBeats).join(",") === "8,4");
}

// --- rateForStage: start matched, rise, resolve to the original key -----
{
  assertOk("a single-stage hold resolves immediately to 1.0", rateForStage(0, 1, 1.06, 1.1) === 1);
  const count = 5;
  const rates = Array.from({ length: count }, (_, i) => rateForStage(i, count, 1.04, 1.1));
  assertOk("stage 0 starts at the mix's current rate", rates[0] === 1.04);
  assertOk("the FINAL stage is exactly 1.0 — the track's original key", rates[count - 1] === 1);
  assertOk("intermediate stages climb toward the peak", rates[1] > rates[0] && rates[2] >= rates[1]);
  assertOk("no stage exceeds the requested peak", rates.every((r) => r <= 1.1 + 1e-9));
  assertOk("every rate is a finite positive number", rates.every((r) => Number.isFinite(r) && r > 0));
}

// --- planHeldLoop: grid-truth guard -------------------------------------
{
  assertOk("null grid returns null (never an unsnapped hold)", planHeldLoop(null, 30, 1) === null);
  assertOk("bpm <= 0 returns null", planHeldLoop({ anchor: 0, bpm: 0 }, 30, 1) === null);
  assertOk("non-finite bpm returns null", planHeldLoop({ anchor: 0, bpm: NaN }, 30, 1) === null);
}

// --- planHeldLoop: capture snapping -------------------------------------
{
  const plan = planHeldLoop(grid120, 20, 1); // phrases at 0,8,16,24 -> 16
  assertOk("capture starts at the phrase boundary just passed (16s)", approxEqual(plan.loopStart, 16));
  assertOk("a 4-bar capture is 16 beats = 8s @120bpm", approxEqual(plan.loopEnd - plan.loopStart, 8) && plan.captureBeats === 16);

  const onBoundary = planHeldLoop(grid120, 24, 1);
  assertOk("a position exactly on a boundary snaps to THAT boundary", approxEqual(onBoundary.loopStart, 24));

  const before = planHeldLoop({ anchor: 5, bpm: 120 }, 2, 1);
  assertOk("a position before the grid's first boundary snaps FORWARD to the anchor, never an unsnapped clamp to 0", approxEqual(before.loopStart, 5));
}
{
  const two = planHeldLoop(grid120, 20, 1, { captureBars: 2 });
  const eight = planHeldLoop(grid120, 20, 1, { captureBars: 8 });
  assertOk("captureBars 2 gives an 8-beat capture", two.captureBeats === 8);
  assertOk("captureBars 8 gives a 32-beat capture", eight.captureBeats === 32);
  assertOk("all capture sizes still snap to the same phrase boundary", approxEqual(two.loopStart, eight.loopStart));
}

// --- Choir round #3, finding 2: a non-power-of-two capture broke the -----
// --- phrase-alignment guarantee (captureBars 3 gave 66 beats, 66%16=2), --
// --- i.e. the plan REPORTED an aligned exit while landing on the "3". ----
{
  for (const captureBars of [1, 2, 3, 4, 5, 6, 8, 12]) {
    const plan = planHeldLoop(grid120, 20, 1, { captureBars, halvingStages: 1, targetHoldSeconds: 30 });
    assertOk(`captureBars ${captureBars}: the exit is still phrase-aligned`, plan.totalBeats % 16 === 0);
    const bars = plan.captureBeats / 4;
    assertOk(`captureBars ${captureBars}: the capture is snapped to a power of two (got ${bars})`, Number.isInteger(Math.log2(bars)));
  }
  assertOk("captureBars 3 snaps to 4, not 3", planHeldLoop(grid120, 20, 1, { captureBars: 3 }).captureBeats === 16);
  assertOk("captureBars 6 snaps to 8", planHeldLoop(grid120, 20, 1, { captureBars: 6 }).captureBeats === 32);
}

// --- THE ACCEPTANCE MATH: whole cycles, phrase-aligned exit -------------
for (const captureBars of [2, 4, 8]) {
  for (const targetHoldSeconds of [15, 30, 45, 60]) {
    for (const halvingStages of [0, 2, 3, 4]) {
      const plan = planHeldLoop(grid120, 20, 1.04, { captureBars, targetHoldSeconds, halvingStages });
      const label = `capture ${captureBars}bar, target ${targetHoldSeconds}s, ${halvingStages} halvings`;

      const wholeCycles = plan.stages.every((s) => Number.isInteger(s.cycles) && s.cycles >= 1);
      if (!wholeCycles) assertOk(`${label}: every stage plays WHOLE cycles`, false);

      const phraseAligned = plan.totalBeats % 16 === 0;
      if (!phraseAligned) assertOk(`${label}: total is a whole number of 16-beat phrases (exit on the "1")`, false);

      const durationsMatch = approxEqual(
        plan.totalDurationSeconds,
        plan.stages.reduce((sum, s) => sum + s.durationSeconds, 0),
        1e-9
      );
      if (!durationsMatch) assertOk(`${label}: totalDurationSeconds is the sum of the stages`, false);

      const beatsMatch =
        plan.totalBeats === plan.stages.reduce((sum, s) => sum + s.captureBeats * s.cycles, 0);
      if (!beatsMatch) assertOk(`${label}: totalBeats is the sum of the stages' beats`, false);

      const resolves = plan.stages[plan.stages.length - 1].rate === 1 && plan.exitRate === 1;
      if (!resolves) assertOk(`${label}: the hold resolves to the original key`, false);

      const contiguous = plan.stages.every((s, i) =>
        i === 0 ? s.startAtSeconds === 0 : approxEqual(s.startAtSeconds, plan.stages[i - 1].startAtSeconds + plan.stages[i - 1].durationSeconds)
      );
      if (!contiguous) assertOk(`${label}: stages are contiguous with no gap or overlap`, false);

      const finalStage = plan.stages[plan.stages.length - 1];
      const handoffAtFinalRate =
        plan.handoffBeats === SAMPLE_MIX_HANDOFF_BEATS &&
        approxEqual(plan.handoffDurationSeconds, (plan.handoffBeats * 60) / plan.exitBpm) &&
        plan.handoffStartAtSeconds >= finalStage.startAtSeconds - 1e-9 &&
        approxEqual(plan.handoffStartAtSeconds + plan.handoffDurationSeconds, plan.totalDurationSeconds);
      if (!handoffAtFinalRate) assertOk(`${label}: final handoff owns exactly 16 beats at the constant exit rate`, false);

      if (wholeCycles && phraseAligned && durationsMatch && beatsMatch && resolves && contiguous && handoffAtFinalRate) {
        assertOk(`${label}: whole cycles, phrase-aligned exit, resolves to original key, contiguous, final handoff`, true);
      }
    }
  }
}

// --- "~30 seconds", never 30.000 ----------------------------------------
{
  const plan = planHeldLoop(grid120, 20, 1, { targetHoldSeconds: 30 });
  assertOk("a ~30s hold lands within 25% of the target", Math.abs(plan.totalDurationSeconds - 30) < 7.5);
  assertOk(
    "the hold is quantized, NOT exactly the requested seconds (bars, never seconds)",
    plan.totalBeats % 16 === 0
  );
  // 4-bar capture @120bpm: one cycle is 8s, so 30s cannot be a whole number
  // of cycles — the plan must not pretend otherwise.
  assertOk("a longer target produces a longer hold", planHeldLoop(grid120, 20, 1, { targetHoldSeconds: 60 }).totalDurationSeconds > plan.totalDurationSeconds);
  assertOk("a hold always contains at least one full base cycle", plan.stages[0].cycles >= 1);
}

// --- Stage sub-slices: loopStart stays, the END halves ------------------
{
  const plan = planHeldLoop(grid120, 20, 1, { captureBars: 4, halvingStages: 3 });
  assertOk("stage 0's loopEnd is the full capture", approxEqual(plan.stages[0].loopEnd, plan.loopEnd));
  assertOk("each later stage's slice is half the previous one", plan.stages.every((s, i) => i === 0 || approxEqual(s.captureBeats, plan.stages[i - 1].captureBeats / 2)));
  assertOk("every stage's slice starts at the SAME captured loopStart", plan.stages.every((s) => s.loopEnd > plan.loopStart));
  assertOk("no stage's slice runs past the full capture", plan.stages.every((s) => s.loopEnd <= plan.loopEnd + 1e-9));
}

// --- Exit hand-off: the incoming track matches the ORIGINAL bpm ---------
{
  const plan = planHeldLoop({ anchor: 0, bpm: 128 }, 40, 1.08);
  assertOk("exitRate is exactly 1 (original key)", plan.exitRate === 1);
  assertOk("exitBpm is the grid's own bpm, not the bent tempo", plan.exitBpm === 128);
  assertOk("the first stage still starts at the bent tempo the room is hearing", plan.stages[0].rate === 1.08);
}
{
  // A degenerate tempo must not produce NaN durations.
  const plan = planHeldLoop(grid120, 20, 0);
  assertOk("a non-positive tempo falls back to 1 rather than dividing by zero", plan.stages.every((s) => Number.isFinite(s.durationSeconds) && s.durationSeconds > 0));
  assertOk("a peakRate below 1 is clamped up to 1", planHeldLoop(grid120, 20, 1, { peakRate: 0.5 }).stages.every((s) => s.rate >= 1 - 1e-9));
  assertOk("an absurd peakRate is clamped to the ceiling", planHeldLoop(grid120, 20, 1, { peakRate: 5 }).stages.every((s) => s.rate <= 1.12 + 1e-9));
}

// --- Isolation carried onto the plan ------------------------------------
{
  assertOk("isolation defaults to beat mode", planHeldLoop(grid120, 20, 1).isolation === "beat");
  const melody = planHeldLoop(grid120, 20, 1, { isolation: "melody" });
  assertOk("a requested melody mode reaches the plan's eq (as a duck)", melody.isolation === "melody" && melody.eq.low === MELODY_LOW_DUCK_DB);
}

// --- LOOP-COVERED TEMPO SWEEP (M7 Phase 4) ------------------------------
// The answer to the clamped transition defect: an out-of-range BPM
// gap can only ever become a `cut` today, because syncTempo refuses to bend
// a deck past its range. Riding the tempo UNDER the hold crosses the gap, so
// the incoming track then enters at its own natural tempo, unclamped.
{
  // La Gozadera (~95) -> Gasolina (~95*1.35): a gap far outside the ±8% the
  // beatmatcher will bend, i.e. exactly the case that used to degrade to a cut.
  const fromBpm = 95;
  const toBpm = 128;
  const plan = planHeldLoop({ anchor: 0, bpm: fromBpm }, 60, 1, { resolveToRate: toBpm / fromBpm });

  assertOk("sweep: the hold resolves to the SWEPT rate, not back to 1.0", approxEqual(plan.exitRate, toBpm / fromBpm, 1e-9));
  assertOk("sweep: exitBpm is the incoming track's tempo, so it enters unclamped", approxEqual(plan.exitBpm, toBpm, 1e-6));
  assertOk("sweep: the final stage plays at the swept rate", approxEqual(plan.stages[plan.stages.length - 1].rate, plan.exitRate, 1e-9));
  assertOk("sweep: the first stage still starts where the room already is", approxEqual(plan.stages[0].rate, 1));

  const rates = plan.stages.map((s) => s.rate);
  assertOk("sweep: the rate rides MONOTONICALLY to the target (no wander toward peakRate)", rates.every((r, i) => i === 0 || r >= rates[i - 1] - 1e-9));
  assertOk("sweep: every intermediate rate lies between the start and the target", rates.every((r) => r >= 1 - 1e-9 && r <= plan.exitRate + 1e-9));

  // The quantization guarantees survive a sweep — the beat math is in BEATS,
  // which is rate-independent, so the exit still lands on the phrase "1".
  assertOk("sweep: the total is still a whole number of 16-beat phrases", plan.totalBeats % 16 === 0);
  assertOk("sweep: every stage still plays whole cycles", plan.stages.every((s) => Number.isInteger(s.cycles)));
  assertOk("sweep: durations are all finite and positive", plan.stages.every((s) => Number.isFinite(s.durationSeconds) && s.durationSeconds > 0));
}
{
  // Sweeping DOWN works the same way.
  const down = planHeldLoop({ anchor: 0, bpm: 128 }, 60, 1, { resolveToRate: 95 / 128 });
  assertOk("sweep down: exitBpm is the slower incoming tempo", approxEqual(down.exitBpm, 95, 1e-6));
  const rates = down.stages.map((s) => s.rate);
  assertOk("sweep down: the rate rides monotonically DOWN", rates.every((r, i) => i === 0 || r <= rates[i - 1] + 1e-9));
}
{
  // Guard rails: an absurd or degenerate sweep target can't produce a plan
  // that leaves the loop an octave away from the music it came from.
  assertOk("sweep: a target beyond 2x is clamped", planHeldLoop(grid120, 20, 1, { resolveToRate: 8 }).exitRate === 2);
  assertOk("sweep: a target below 0.5x is clamped", planHeldLoop(grid120, 20, 1, { resolveToRate: 0.1 }).exitRate === 0.5);
  assertOk("sweep: a non-finite target falls back to resolving at 1.0", planHeldLoop(grid120, 20, 1, { resolveToRate: NaN }).exitRate === 1);
  assertOk("sweep: a zero target falls back to resolving at 1.0", planHeldLoop(grid120, 20, 1, { resolveToRate: 0 }).exitRate === 1);
  assertOk("no resolveToRate keeps the original-key behaviour", planHeldLoop(grid120, 20, 1.04).exitRate === 1);
}
{
  // rateForStage directly: sweep mode must not detour toward peakRate.
  const count = 5;
  const sweep = Array.from({ length: count }, (_, i) => rateForStage(i, count, 1, 1.12, 1.3));
  assertOk("rateForStage sweep: ends exactly on the resolve rate", sweep[count - 1] === 1.3);
  assertOk("rateForStage sweep: strictly increasing toward the target", sweep.every((r, i) => i === 0 || r > sweep[i - 1]));
  assertOk("rateForStage sweep: never overshoots past the target", sweep.every((r) => r <= 1.3 + 1e-9));
  assertOk("rateForStage sweep: never dips below the start", sweep.every((r) => r >= 1 - 1e-9));
}

// --- loop-blend.ts's capture length is now a PARAMETER (Phase 2) --------
{
  assertOk("the default capture is still 16 beats", DEFAULT_LOOP_CAPTURE_BEATS === 16);
  const fourBar = planLoopBlend(grid120, 20, 120, 1, 16);
  const twoBar = planLoopBlend(grid120, 20, 120, 1, 16, 8);
  assertOk("an explicit 8-beat capture halves the captured slice", approxEqual(twoBar.loopEnd - twoBar.loopStart, (fourBar.loopEnd - fourBar.loopStart) / 2));
  assertOk("a smaller capture still snaps to its own grid-aligned boundary", approxEqual((twoBar.loopStart - grid120.anchor) % 4, 0));
  assertOk("omitting the capture argument is byte-identical to the old fixed behavior", JSON.stringify(planLoopBlend(grid120, 20, 120, 1, 16)) === JSON.stringify(planLoopBlend(grid120, 20, 120, 1, 16, 16)));
  assertOk("a non-positive capture falls back to the default", JSON.stringify(planLoopBlend(grid120, 20, 120, 1, 16, 0)) === JSON.stringify(fourBar));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all held-loop planning cases");
