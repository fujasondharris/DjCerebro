#!/usr/bin/env node
// Node-side smoke test for the post-transition tempo-recovery glide's pure
// math (owner soundcheck fix, 2026-07-26 — see src/lib/tempo-glide.ts's file
// header): imports the exact same module src/app/page.tsx uses and asserts
// glideStepCount()/nextGlideTempo() — step count math, single-step
// snap-to-1.0, and a full simulated glide from a bent tempo converging to
// EXACTLY 1.0 after the expected number of steps (both bending directions).
// Plain asserts, no test framework, mirrors check-beatmatch.mjs.
import { glideStepCount, nextGlideTempo, TEMPO_GLIDE_STEP_MS, TEMPO_GLIDE_DURATION_SECONDS } from "../src/lib/tempo-glide.ts";

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

// --- glideStepCount ---

assertOk("glideStepCount: defaults land within the dispatch's 20-30s window at 500ms/step (25s -> 50 steps)", glideStepCount() === 50);
assertOk("glideStepCount: explicit duration/step math", glideStepCount(20, 500) === 40);
assertOk("glideStepCount: never returns 0 (degenerate 0-duration still ticks once)", glideStepCount(0, 500) === 1);

// --- nextGlideTempo: single-step snap ---

assertOk("nextGlideTempo: 1 step remaining snaps straight to 1.0 from below", nextGlideTempo(0.92, 1) === 1);
assertOk("nextGlideTempo: 1 step remaining snaps straight to 1.0 from above", nextGlideTempo(1.08, 1) === 1);
assertOk("nextGlideTempo: 0 steps remaining (degenerate) still returns 1.0, never divides by zero", nextGlideTempo(0.92, 0) === 1);

// --- nextGlideTempo: already at 1.0 stays there regardless of steps remaining ---

assertOk("nextGlideTempo: already at 1.0 stays at 1.0", nextGlideTempo(1, 30) === 1);

// --- nextGlideTempo: a full simulated glide converges to EXACTLY 1.0 after
// the expected step count, moving monotonically the whole way (no
// overshoot/oscillation) — both a bent-down and a bent-up starting tempo. ---

function simulateGlide(startTempo, totalSteps) {
  let tempo = startTempo;
  const samples = [tempo];
  for (let stepsRemaining = totalSteps; stepsRemaining >= 1; stepsRemaining--) {
    tempo = nextGlideTempo(tempo, stepsRemaining);
    samples.push(tempo);
  }
  return samples;
}

{
  const totalSteps = glideStepCount();
  const samples = simulateGlide(0.92, totalSteps); // bent down (clamped-low landing)
  assertOk("simulated glide (bent down): reaches exactly 1.0 after the expected step count", samples[samples.length - 1] === 1);
  assertOk("simulated glide (bent down): monotonically increasing the whole way (no overshoot)", samples.every((v, i) => i === 0 || v >= samples[i - 1]));
  assertOk("simulated glide (bent down): never overshoots past 1.0", samples.every((v) => v <= 1 + 1e-12));
}

{
  const totalSteps = glideStepCount();
  const samples = simulateGlide(1.08, totalSteps); // bent up (clamped-high landing)
  assertOk("simulated glide (bent up): reaches exactly 1.0 after the expected step count", samples[samples.length - 1] === 1);
  assertOk("simulated glide (bent up): monotonically decreasing the whole way (no overshoot)", samples.every((v, i) => i === 0 || v <= samples[i - 1]));
  assertOk("simulated glide (bent up): never overshoots past 1.0", samples.every((v) => v >= 1 - 1e-12));
}

// --- sanity: the module's own constants stay internally consistent ---
assertOk(
  "TEMPO_GLIDE_DURATION_SECONDS falls within the dispatch's 20-30s window",
  TEMPO_GLIDE_DURATION_SECONDS >= 20 && TEMPO_GLIDE_DURATION_SECONDS <= 30
);
assertOk("TEMPO_GLIDE_STEP_MS is the dispatch's ~500ms cadence", approxEqual(TEMPO_GLIDE_STEP_MS, 500, 1e-9));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all tempo-glide cases");
