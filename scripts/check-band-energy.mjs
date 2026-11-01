#!/usr/bin/env node
// Node-side check for M7 Phase 1's pure band-energy DSP (src/lib/band-energy.ts):
// biquad coefficient correctness at DC/Nyquist, real band separation on
// synthesized sine tones, and per-beat RMS over a real BeatGrid (including
// the grid-truth guard and the dropped trailing partial beat). No
// AudioContext anywhere — this module is deliberately pure so it can be
// verified here. Plain asserts, no test framework.
import {
  lowpassCoeffs,
  highpassCoeffs,
  applyBiquad,
  applyBiquadCascade,
  splitBands,
  rmsOverRange,
  computeBandEnergyPerBeat,
  BAND_LOW_HZ,
  BAND_HIGH_HZ,
} from "../src/lib/band-energy.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

function approxEqual(a, b, epsilon = 1e-6) {
  return Math.abs(a - b) < epsilon;
}

const SAMPLE_RATE = 22050;

/** Transfer-function magnitude at DC (z=1) and Nyquist (z=-1) for a normalized biquad. */
function dcGain(c) {
  return (c.b0 + c.b1 + c.b2) / (1 + c.a1 + c.a2);
}
function nyquistGain(c) {
  return (c.b0 - c.b1 + c.b2) / (1 - c.a1 + c.a2);
}

function sine(freqHz, seconds, sampleRate = SAMPLE_RATE) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

/** RMS skipping the first `skipSeconds` so the IIR's start-up transient isn't measured. */
function settledRms(samples, skipSeconds = 0.2, sampleRate = SAMPLE_RATE) {
  return rmsOverRange(samples, skipSeconds * sampleRate, samples.length);
}

// --- Coefficients: a lowpass passes DC and kills Nyquist; a highpass does the reverse ---
{
  const lp = lowpassCoeffs(BAND_LOW_HZ, SAMPLE_RATE);
  const hp = highpassCoeffs(BAND_LOW_HZ, SAMPLE_RATE);
  assertOk("lowpass has unity gain at DC", approxEqual(dcGain(lp), 1, 1e-9));
  assertOk("lowpass has ~zero gain at Nyquist", Math.abs(nyquistGain(lp)) < 1e-9);
  assertOk("highpass has ~zero gain at DC", Math.abs(dcGain(hp)) < 1e-9);
  assertOk("highpass has unity gain at Nyquist", approxEqual(Math.abs(nyquistGain(hp)), 1, 1e-9));
  assertOk("all coefficients are finite", [lp, hp].every((c) => Object.values(c).every(Number.isFinite)));
}
{
  // A corner above Nyquist must be clamped, not produce NaN coefficients.
  const clamped = lowpassCoeffs(BAND_HIGH_HZ * 10, SAMPLE_RATE);
  assertOk("a corner frequency above Nyquist is clamped, not NaN", Object.values(clamped).every(Number.isFinite));
}

// --- applyBiquad / cascade ---
{
  const dc = new Float32Array(SAMPLE_RATE).fill(1);
  const lp = applyBiquad(dc, lowpassCoeffs(BAND_LOW_HZ, SAMPLE_RATE));
  assertOk("lowpass passes a DC signal through at ~unity once settled", approxEqual(settledRms(lp), 1, 1e-3));

  const hp = applyBiquad(dc, highpassCoeffs(BAND_LOW_HZ, SAMPLE_RATE));
  assertOk("highpass removes DC almost entirely", settledRms(hp) < 1e-3);

  assertOk("applyBiquad preserves length", lp.length === dc.length);
  const cascaded = applyBiquadCascade(dc, lowpassCoeffs(BAND_LOW_HZ, SAMPLE_RATE), 2);
  assertOk("applyBiquadCascade preserves length", cascaded.length === dc.length);
  assertOk("a 0-times cascade is a pass-through", applyBiquadCascade(dc, lowpassCoeffs(BAND_LOW_HZ, SAMPLE_RATE), 0)[500] === 1);
}

// --- splitBands: a tone lands in the band that owns its frequency ---
{
  const cases = [
    { name: "60Hz (bassline)", freq: 60, expect: "low" },
    { name: "1kHz (vocal/mid)", freq: 1000, expect: "mid" },
    { name: "8kHz (hats/tops)", freq: 8000, expect: "high" },
  ];
  for (const { name, freq, expect } of cases) {
    const bands = splitBands(sine(freq, 1.5), SAMPLE_RATE);
    const levels = {
      low: settledRms(bands.low),
      mid: settledRms(bands.mid),
      high: settledRms(bands.high),
    };
    const winner = Object.keys(levels).reduce((a, b) => (levels[a] >= levels[b] ? a : b));
    assertOk(`${name} lands in the ${expect} band`, winner === expect);
    const others = Object.keys(levels).filter((k) => k !== expect);
    assertOk(
      `${name} is at least 4x louder in ${expect} than in either other band`,
      others.every((k) => levels[expect] > levels[k] * 4)
    );
  }
}
{
  const bands = splitBands(sine(1000, 0.5), SAMPLE_RATE);
  assertOk("splitBands returns three arrays of the input length", bands.low.length === bands.mid.length && bands.mid.length === bands.high.length && bands.high.length === Math.round(0.5 * SAMPLE_RATE));
}

// --- rmsOverRange ---
{
  const ones = new Float32Array(100).fill(1);
  assertOk("rmsOverRange of a constant-1 array is 1", approxEqual(rmsOverRange(ones, 0, 100), 1));
  assertOk("rmsOverRange clamps a past-the-end range", approxEqual(rmsOverRange(ones, 50, 500), 1));
  assertOk("rmsOverRange of an inverted range is 0", rmsOverRange(ones, 60, 20) === 0);
  assertOk("rmsOverRange of an empty range is 0", rmsOverRange(ones, 30, 30) === 0);
  const half = new Float32Array(100);
  half.fill(0, 0, 50);
  half.fill(2, 50, 100);
  assertOk("rmsOverRange measures only the requested window", approxEqual(rmsOverRange(half, 50, 100), 2));
}

// --- computeBandEnergyPerBeat: grid-truth guard ---
{
  const samples = sine(100, 2);
  assertOk("null grid returns null (never an estimated anchor-0 grid)", computeBandEnergyPerBeat(samples, SAMPLE_RATE, null) === null);
  assertOk("bpm <= 0 returns null", computeBandEnergyPerBeat(samples, SAMPLE_RATE, { anchor: 0, bpm: 0 }) === null);
  assertOk("non-finite bpm returns null", computeBandEnergyPerBeat(samples, SAMPLE_RATE, { anchor: 0, bpm: NaN }) === null);
  assertOk("empty samples return null", computeBandEnergyPerBeat(new Float32Array(0), SAMPLE_RATE, { anchor: 0, bpm: 120 }) === null);
  assertOk("sampleRate <= 0 returns null", computeBandEnergyPerBeat(samples, 0, { anchor: 0, bpm: 120 }) === null);
  // Choir round #3, finding 1: a non-finite ANCHOR was not validated, so
  // firstBeatIndex became NaN and — since every comparison with NaN is
  // false — the beat loop reached neither its continue nor its break. It
  // ran unbounded until the process died of heap exhaustion. Reproduced
  // before fixing; these two cases are the regression.
  assertOk("a NaN anchor returns null (it used to loop until OOM)", computeBandEnergyPerBeat(samples, SAMPLE_RATE, { anchor: NaN, bpm: 120 }) === null);
  assertOk("an infinite anchor returns null", computeBandEnergyPerBeat(samples, SAMPLE_RATE, { anchor: Infinity, bpm: 120 }) === null);
}

// --- computeBandEnergyPerBeat: beat placement ---
{
  // 120bpm = 0.5s/beat, 4.0s of audio, anchor 0 -> exactly 8 whole beats.
  const perBeat = computeBandEnergyPerBeat(sine(100, 4), SAMPLE_RATE, { anchor: 0, bpm: 120 });
  assertOk("anchor 0: first measured beat is beat 0", perBeat.firstBeatIndex === 0);
  assertOk("anchor 0 @120bpm over 4s: 8 whole beats measured", perBeat.beatSeconds.length === 8);
  assertOk("beats are spaced by 60/bpm", approxEqual(perBeat.beatSeconds[1] - perBeat.beatSeconds[0], 0.5));
  assertOk("band arrays are all the same length as beatSeconds", perBeat.low.length === 8 && perBeat.mid.length === 8 && perBeat.high.length === 8);
}
{
  // A trailing PARTIAL beat must be dropped, not reported as a quiet beat:
  // 4.3s @120bpm is 8 whole beats + 0.3s.
  const perBeat = computeBandEnergyPerBeat(sine(100, 4.3), SAMPLE_RATE, { anchor: 0, bpm: 120 });
  assertOk("a trailing partial beat is dropped, not measured as a quiet one", perBeat.beatSeconds.length === 8);
}
{
  // Nonzero anchor: anchor 0.25s @120bpm -> beats at 0.25, 0.75, ... and
  // firstBeatIndex 0 (0.25 already >= 0). Bar lines are where the
  // anchor-relative index is divisible by 4.
  const perBeat = computeBandEnergyPerBeat(sine(100, 4), SAMPLE_RATE, { anchor: 0.25, bpm: 120 });
  assertOk("nonzero positive anchor: measurement starts AT the anchor", approxEqual(perBeat.beatSeconds[0], 0.25));
  assertOk("nonzero positive anchor: firstBeatIndex is 0", perBeat.firstBeatIndex === 0);
}
{
  // Negative anchor (a grid whose beat 0 sits before the file start): the
  // first measured beat must be the first anchor-aligned beat >= 0, and
  // firstBeatIndex must report WHICH beat that is, so bar alignment stays
  // correct downstream.
  const perBeat = computeBandEnergyPerBeat(sine(100, 4), SAMPLE_RATE, { anchor: -0.75, bpm: 120 });
  assertOk("negative anchor: firstBeatIndex is the first beat at/after 0 (2)", perBeat.firstBeatIndex === 2);
  assertOk("negative anchor: first measured beat starts at 0.25s (-0.75 + 2*0.5)", approxEqual(perBeat.beatSeconds[0], 0.25));
}

// --- computeBandEnergyPerBeat: the energy actually tracks the audio ---
{
  // A bass pulse on beats 0 and 2 only, at 120bpm (0.5s beats) over 2s.
  const n = 2 * SAMPLE_RATE;
  const samples = new Float32Array(n);
  for (const beat of [0, 2]) {
    const start = Math.round(beat * 0.5 * SAMPLE_RATE);
    const end = Math.round((beat * 0.5 + 0.4) * SAMPLE_RATE);
    for (let i = start; i < end; i++) samples[i] = Math.sin((2 * Math.PI * 60 * i) / SAMPLE_RATE);
  }
  const perBeat = computeBandEnergyPerBeat(samples, SAMPLE_RATE, { anchor: 0, bpm: 120 });
  assertOk("4 beats measured over 2s @120bpm", perBeat.low.length === 4);
  assertOk("beats carrying the bass pulse read loud in the LOW band", perBeat.low[0] > 0.2 && perBeat.low[2] > 0.2);
  assertOk("beats with no pulse read quiet in the low band", perBeat.low[1] < perBeat.low[0] / 4 && perBeat.low[3] < perBeat.low[2] / 4);
  assertOk("a 60Hz pulse barely registers in the HIGH band", perBeat.high[0] < perBeat.low[0] / 10);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all band-energy cases");
