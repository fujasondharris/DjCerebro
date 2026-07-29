#!/usr/bin/env node
// Node-side smoke test for in-and-out mixing's pure energy analysis
// (src/lib/energy.ts): imports the exact same module page.tsx uses and
// asserts computeRmsPerSecond's basic math, findMixPoints' heuristic
// (silent-intro mixIn detection, fade-out mixOut detection, the all-quiet
// low-confidence case, grid-vs-no-grid phrase-boundary snapping, the 60s
// mixIn clamp), and applyMixInCueOverride's precedence. Plain asserts, no
// test framework, mirrors scripts/check-beatclock.mjs.
import { computeRmsPerSecond, findMixPoints, applyMixInCueOverride } from "../src/lib/energy.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

function buildRms(spec, length) {
  const rms = new Array(length);
  for (let i = 0; i < length; i++) rms[i] = spec(i);
  return rms;
}

// --- computeRmsPerSecond ---
{
  // 3 whole seconds at sampleRate 100, constant amplitude 0.5 -> rms 0.5 each second.
  const sampleRate = 100;
  const samples = new Float32Array(sampleRate * 3).fill(0.5);
  const rms = computeRmsPerSecond(samples, sampleRate);
  assertOk("computeRmsPerSecond: one entry per whole second (3)", rms.length === 3);
  assertOk("computeRmsPerSecond: constant-amplitude signal -> rms == amplitude", rms.every((v) => Math.abs(v - 0.5) < 1e-9));
}
{
  // Partial trailing second (2.5s worth of samples at sampleRate 100) -> 3 entries, last one from a half-length window.
  const sampleRate = 100;
  const samples = new Float32Array(250).fill(1);
  const rms = computeRmsPerSecond(samples, sampleRate);
  assertOk("computeRmsPerSecond: partial trailing second still produces one more entry", rms.length === 3);
  assertOk("computeRmsPerSecond: partial-second entry still computed from its own (shorter) window", Math.abs(rms[2] - 1) < 1e-9);
}
{
  const rms = computeRmsPerSecond(new Float32Array(0), 44100);
  assertOk("computeRmsPerSecond: empty samples -> empty array", rms.length === 0);
}

// --- findMixPoints: silent intro then steady energy (mixIn found, not clamped) ---
{
  const duration = 60;
  const rms = buildRms((i) => (i < 10 ? 0.001 : 1.0), duration);
  const result = findMixPoints(rms, null);
  assertOk("silent-intro: mixIn found well before the 60s clamp", result.mixInSeconds > 0 && result.mixInSeconds < 20);
  assertOk("silent-intro: confidence high (a real signal was found)", result.confidence === "high");
  assertOk("silent-intro: mixOut stays at/near the full duration (energy never drops again)", result.mixOutSeconds === duration);
}

// --- findMixPoints: fade-out outro (mixOut found before the true end) ---
{
  const duration = 80;
  // Steady energy for the first 60s, then a hard drop to near-silence for the last 20s.
  const rms = buildRms((i) => (i < 60 ? 1.0 : 0.001), duration);
  const result = findMixPoints(rms, null);
  assertOk("fade-out: mixIn found at/near the very start (energy present from t=0)", result.mixInSeconds <= 4);
  assertOk("fade-out: mixOut lands BEFORE the true end (skips the dead outro)", result.mixOutSeconds < duration);
  assertOk("fade-out: mixOut still leaves a real residency after mixIn", result.mixOutSeconds >= result.mixInSeconds + 30);
  assertOk("fade-out: mixOut lands in the steady-energy region, not deep into the fade", result.mixOutSeconds >= 55 && result.mixOutSeconds <= 63);
}

// --- findMixPoints: all-quiet track (low confidence, falls back to 0) ---
// Choir round #2 (P6) fix: the "no sustained window found" fallback used to
// clamp to Math.min(MIX_IN_CLAMP_SECONDS, duration) — for a normal-length
// track that collapses to the 60s cap (as these tests used to assert), but
// for a SHORT track it collapses to `duration` itself, i.e. "mix in at the
// very end" (near-instant silence — see the dedicated short-buffer case
// below). Fixed uniformly to 0 (start of track), always a safe fallback
// when there's no sustained-energy signal to hang a real point on.
{
  const duration = 90;
  const rms = buildRms(() => 0, duration);
  const result = findMixPoints(rms, null);
  assertOk("all-quiet: confidence is low (no real energy signal to find)", result.confidence === "low");
  assertOk("all-quiet: mixIn falls back to 0 (start of track), not the old 60s clamp", result.mixInSeconds === 0);
  assertOk("all-quiet: mixOut falls back to the full duration", result.mixOutSeconds === duration);
}
{
  // Effectively silent but not exactly 0 (dithered digital silence) -> same low-confidence path.
  const duration = 45;
  const rms = buildRms(() => 1e-6, duration);
  const result = findMixPoints(rms, null);
  assertOk("near-silent (not exactly 0): still classified low-confidence", result.confidence === "low");
  assertOk("near-silent (not exactly 0): mixIn falls back to 0", result.mixInSeconds === 0);
}

// --- findMixPoints: short-buffer fallback (choir round #2, P6 — the concrete bug scenario) ---
{
  // A 2-second buffer is SHORTER than WINDOW_SECONDS (4) — the sustained-
  // window scan loop (`i <= duration - WINDOW_SECONDS`) can never execute
  // at all, so mixInRaw stays null regardless of the actual energy present.
  // Real (non-silent) energy here means `noSignal` is false — this hits the
  // OTHER "no sustained window" fallback branch, not the all-quiet one
  // above. Old behavior: mixInSeconds collapsed to Math.min(60, 2) = 2 =
  // duration itself (seek to the very end -> instant silence).
  const duration = 2;
  const rms = buildRms(() => 1.0, duration);
  const result = findMixPoints(rms, null);
  assertOk("short buffer (< 4s window): mixIn falls back to 0, never seeks to the end of a real track", result.mixInSeconds === 0);
  assertOk("short buffer (< 4s window): confidence low (no sustained window could be evaluated)", result.confidence === "low");
}

// --- findMixPoints: grid vs no-grid snapping ---
{
  const duration = 40;
  const rms = buildRms((i) => (i < 5 ? 0 : 1.0), duration);
  const grid = { anchor: 0, bpm: 120 }; // phrase interval = (60/120)*16 = 8s
  const phraseIntervalSeconds = (60 / grid.bpm) * 16;

  const noGrid = findMixPoints(rms, null);
  const withGrid = findMixPoints(rms, grid);

  assertOk("grid snapping: no-grid mixIn is a whole second", Number.isInteger(noGrid.mixInSeconds));
  assertOk(
    "grid snapping: with a real grid, mixIn lands exactly on a phrase boundary (anchor + n*16 beats)",
    Math.abs(((withGrid.mixInSeconds - grid.anchor) / phraseIntervalSeconds) % 1) < 1e-9
  );
}

// --- findMixPoints: the 60s mixIn clamp, no grid and with a grid ---
{
  const duration = 200;
  const rms = buildRms((i) => (i < 90 ? 0 : 1.0), duration);

  const noGrid = findMixPoints(rms, null);
  assertOk("60s clamp (no grid): mixIn never exceeds 60s even though the real energy starts near 90s", noGrid.mixInSeconds <= 60);
  assertOk("60s clamp (no grid): confidence low when the clamp fires", noGrid.confidence === "low");
  assertOk("60s clamp (no grid): snaps to exactly 60 (whole-second snap, no grid)", noGrid.mixInSeconds === 60);

  const grid = { anchor: 0, bpm: 60 }; // phrase interval = (60/60)*16 = 16s
  const withGrid = findMixPoints(rms, grid);
  assertOk("60s clamp (with grid): still never exceeds 60s", withGrid.mixInSeconds <= 60);
  assertOk("60s clamp (with grid): snaps DOWN to the phrase boundary at/before 60 (48, not 64)", withGrid.mixInSeconds === 48);
  assertOk("60s clamp (with grid): confidence low", withGrid.confidence === "low");
}

// --- findMixPoints: empty rms array (degenerate input) ---
{
  const result = findMixPoints([], null);
  assertOk("empty rms: returns a degenerate zero-length result rather than throwing", result.mixInSeconds === 0 && result.mixOutSeconds === 0);
  assertOk("empty rms: low confidence", result.confidence === "low");
}

// --- applyMixInCueOverride: cue-override precedence ---
// durationSeconds=200 throughout this block (large enough that none of the
// existing in-range cue positions below trip the new C6 upper bound).
{
  const points = { mixInSeconds: 10, mixOutSeconds: 100, confidence: "low" };
  const cues = [
    { label: "verse", atSeconds: 5 },
    { label: "Mix In", atSeconds: 22 },
  ];
  const result = applyMixInCueOverride(points, cues, 200);
  assertOk("cue override: a matching 'Mix In' label wins over the heuristic mixIn", result.mixInSeconds === 22);
  assertOk("cue override: confidence becomes high (a human mark is authoritative)", result.confidence === "high");
  assertOk("cue override: mixOut is left untouched (override is mixIn-only)", result.mixOutSeconds === 100);
}
{
  const points = { mixInSeconds: 10, mixOutSeconds: 100, confidence: "high" };
  const cues = [{ label: "verse one", atSeconds: 5 }];
  const result = applyMixInCueOverride(points, cues, 200);
  assertOk("cue override: no matching label -> heuristic value unchanged", result.mixInSeconds === 10 && result.confidence === "high");
}
{
  const points = { mixInSeconds: 10, mixOutSeconds: 100, confidence: "low" };
  const result = applyMixInCueOverride(points, [], 200);
  assertOk("cue override: no cues at all -> no-op", result.mixInSeconds === 10);
}
{
  // The dispatch's exact pattern (/\b(mix ?in|in)\b/i) matches a standalone "in" too — documented, not a bug.
  const points = { mixInSeconds: 10, mixOutSeconds: 100, confidence: "low" };
  const cues = [{ label: "Check-in point", atSeconds: 15 }];
  const result = applyMixInCueOverride(points, cues, 200);
  assertOk("cue override: a standalone 'in' word boundary also matches, per the dispatch's exact regex", result.mixInSeconds === 15);
}

// --- applyMixInCueOverride: out-of-range cue is IGNORED, not clamped (choir round #2, C6) ---
{
  // Cue past the track's own end.
  const points = { mixInSeconds: 10, mixOutSeconds: 100, confidence: "low" };
  const cues = [{ label: "mix in", atSeconds: 250 }];
  const result = applyMixInCueOverride(points, cues, 200);
  assertOk("out-of-range cue (past duration): ignored, heuristic mixIn unchanged", result.mixInSeconds === 10);
  assertOk("out-of-range cue (past duration): confidence NOT bumped to high", result.confidence === "low");
}
{
  // Cue past the analyzed mixOut point (still technically < duration).
  const points = { mixInSeconds: 10, mixOutSeconds: 100, confidence: "low" };
  const cues = [{ label: "mix in", atSeconds: 150 }];
  const result = applyMixInCueOverride(points, cues, 300);
  assertOk("out-of-range cue (past mixOutSeconds): ignored even though it's still < duration", result.mixInSeconds === 10);
  assertOk("out-of-range cue (past mixOutSeconds): confidence NOT bumped to high", result.confidence === "low");
}
{
  // Cue within the 30s floor guard of the track's own end (duration - MIN_RESIDENCY_SECONDS).
  const points = { mixInSeconds: 10, mixOutSeconds: 500, confidence: "low" };
  const cues = [{ label: "mix in", atSeconds: 190 }]; // duration 200 - 30 = 170 upper bound
  const result = applyMixInCueOverride(points, cues, 200);
  assertOk("out-of-range cue (inside the 30s end-of-track floor guard): ignored", result.mixInSeconds === 10);
}
{
  // Exactly AT the upper bound is still valid (inclusive).
  const points = { mixInSeconds: 10, mixOutSeconds: 500, confidence: "low" };
  const cues = [{ label: "mix in", atSeconds: 170 }]; // duration 200 - 30 = exactly 170
  const result = applyMixInCueOverride(points, cues, 200);
  assertOk("cue exactly at the upper bound is still accepted (inclusive)", result.mixInSeconds === 170 && result.confidence === "high");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all energy cases");
