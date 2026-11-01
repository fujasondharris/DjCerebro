// M7 Phase 1, part A — per-band energy over the REAL BeatGrid. Pure DSP:
// plain arrays in, plain numbers out, no AudioContext and no filesystem, so
// scripts/check-band-energy.mjs can verify it directly (same "pure src/lib
// module" discipline as energy.ts/beatclock.ts/phrase.ts).
//
// Why this exists: GOAL-M7.md Phase 1 needs "per-band energy per beat over
// the real BeatGrid" as the input to recurring-pattern and drop detection,
// and PRINCIPLE 3 puts that analysis OFFLINE (a committed data file, like
// crate-manifest.json / vocal-maps.json / cue-suggestions.json) rather than
// on the phone's audio thread. scripts/make-loop-points.mjs decodes each mp3
// with ffmpeg and feeds the mono PCM through here.
//
// Band edges deliberately mirror src/lib/deck.ts's 3-band EQ crossovers
// (EQ_LOW_FREQ_HZ = 250, EQ_HIGH_FREQ_HZ = 4000) so that "the low band is
// loud here" in this analysis means the same thing the deck's (and, from
// Phase 2, the loop node's) low-kill will actually act on. deck.ts uses
// shelf/peaking filters to SHAPE; this module uses lowpass/highpass sections
// to SPLIT, which is the right tool for measuring how energy is distributed.
import type { BeatGridLike } from "./beatclock";

/** Crossover between the low band and the mid band — deck.ts's EQ_LOW_FREQ_HZ (lowshelf corner). */
export const BAND_LOW_HZ = 250;
/** Crossover between the mid band and the high band — deck.ts's EQ_HIGH_FREQ_HZ (highshelf corner). */
export const BAND_HIGH_HZ = 4000;
/** Butterworth Q for a single biquad section (maximally flat passband). */
export const BUTTERWORTH_Q = Math.SQRT1_2;
/** Cascaded sections per band edge: 2 x 12 dB/oct = 24 dB/oct, enough separation that a bassline doesn't smear into the "mid" measurement. */
const SECTIONS_PER_EDGE = 2;

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  /** Already normalized by a0 (so the difference equation below uses a1/a2 directly). */
  a1: number;
  a2: number;
}

/** Clamps a corner frequency into a range the bilinear transform stays well-behaved over. */
function safeFreq(freqHz: number, sampleRate: number): number {
  const nyquist = sampleRate / 2;
  return Math.min(Math.max(freqHz, 1), nyquist * 0.98);
}

/** RBJ audio-EQ-cookbook lowpass, normalized by a0. */
export function lowpassCoeffs(freqHz: number, sampleRate: number, q: number = BUTTERWORTH_Q): BiquadCoeffs {
  const w0 = (2 * Math.PI * safeFreq(freqHz, sampleRate)) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cosw) / 2) / a0,
    b1: (1 - cosw) / a0,
    b2: ((1 - cosw) / 2) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** RBJ audio-EQ-cookbook highpass, normalized by a0. */
export function highpassCoeffs(freqHz: number, sampleRate: number, q: number = BUTTERWORTH_Q): BiquadCoeffs {
  const w0 = (2 * Math.PI * safeFreq(freqHz, sampleRate)) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cosw) / 2) / a0,
    b1: (-(1 + cosw)) / a0,
    b2: ((1 + cosw) / 2) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * One direct-form-I biquad pass over `samples`, returning a new array.
 * Forward-only, so it carries the filter's phase shift — irrelevant here
 * because everything downstream measures ENERGY per beat, not waveform
 * alignment, and a beat is ~600ms while the group delay of a 250Hz section
 * is well under a millisecond.
 */
export function applyBiquad(samples: Float32Array, c: BiquadCoeffs): Float32Array {
  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/** `times` cascaded identical biquad sections (12 dB/oct each). */
export function applyBiquadCascade(samples: Float32Array, c: BiquadCoeffs, times: number): Float32Array {
  let current = samples;
  for (let i = 0; i < times; i++) current = applyBiquad(current, c);
  return current;
}

export interface SplitBands {
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
}

/**
 * Splits mono samples into the same three bands the deck's EQ acts on:
 * low = below 250Hz, mid = 250Hz–4kHz, high = above 4kHz. Each edge is a
 * 24 dB/oct cascade; the mid band is the low edge's highpass followed by the
 * high edge's lowpass.
 */
export function splitBands(samples: Float32Array, sampleRate: number): SplitBands {
  const lp250 = lowpassCoeffs(BAND_LOW_HZ, sampleRate);
  const hp250 = highpassCoeffs(BAND_LOW_HZ, sampleRate);
  const lp4k = lowpassCoeffs(BAND_HIGH_HZ, sampleRate);
  const hp4k = highpassCoeffs(BAND_HIGH_HZ, sampleRate);

  const low = applyBiquadCascade(samples, lp250, SECTIONS_PER_EDGE);
  const high = applyBiquadCascade(samples, hp4k, SECTIONS_PER_EDGE);
  const mid = applyBiquadCascade(applyBiquadCascade(samples, hp250, SECTIONS_PER_EDGE), lp4k, SECTIONS_PER_EDGE);

  return { low, mid, high };
}

/** RMS over [startSample, endSample), clamped to the array. 0 for an empty/inverted range. */
export function rmsOverRange(samples: Float32Array, startSample: number, endSample: number): number {
  const start = Math.max(0, Math.min(samples.length, Math.floor(startSample)));
  const end = Math.max(start, Math.min(samples.length, Math.floor(endSample)));
  if (end <= start) return 0;
  let sumSquares = 0;
  for (let i = start; i < end; i++) sumSquares += samples[i] * samples[i];
  return Math.sqrt(sumSquares / (end - start));
}

export interface BeatBandEnergy {
  /**
   * Anchor-relative index of the FIRST measured beat (grid.anchor is beat 0).
   * Bar boundaries are the beats where (firstBeatIndex + i) % 4 === 0, which
   * is why this is reported rather than assumed — a grid whose anchor sits
   * partway into the file starts measuring at a nonzero beat index.
   */
  firstBeatIndex: number;
  /** SOURCE-seconds start of each measured beat. */
  beatSeconds: number[];
  low: number[];
  mid: number[];
  high: number[];
}

/**
 * Per-beat RMS in each band, over the track's REAL BeatGrid — never an
 * estimated one. Per GOAL-M7.md PRINCIPLE 4 ("grid-truth or don't do it")
 * a null/zero-BPM grid returns null rather than a guessed anchor-0 grid,
 * the same guard planLoopBlend already applies.
 *
 * Only WHOLE beats that fit inside the decoded audio are measured, so the
 * last partial beat is dropped rather than reported as a quiet one (a false
 * "the track gets quiet here" at the tail would look like a loop candidate's
 * energy instability).
 */
export function computeBandEnergyPerBeat(
  samples: Float32Array,
  sampleRate: number,
  grid: BeatGridLike | null
): BeatBandEnergy | null {
  // `anchor` is validated as carefully as `bpm` (choir round #3, finding 1):
  // a non-finite anchor made firstBeatIndex NaN, and since every comparison
  // with NaN is false the beat loop below could reach NEITHER its `continue`
  // nor its `break` — it ran unbounded, pushing to the output arrays until
  // the process died of heap exhaustion. Reproduced before fixing.
  if (!grid || !Number.isFinite(grid.bpm) || grid.bpm <= 0 || !Number.isFinite(grid.anchor)) return null;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || samples.length === 0) return null;

  const beatSeconds = 60 / grid.bpm;
  const durationSeconds = samples.length / sampleRate;
  // First anchor-aligned beat that starts at or after 0.
  const firstBeatIndex = Math.ceil(-grid.anchor / beatSeconds - 1e-9);
  const bands = splitBands(samples, sampleRate);

  const starts: number[] = [];
  const low: number[] = [];
  const mid: number[] = [];
  const high: number[] = [];

  for (let k = firstBeatIndex; ; k++) {
    const start = grid.anchor + k * beatSeconds;
    const end = start + beatSeconds;
    if (start < 0) continue;
    if (end > durationSeconds) break;
    const startSample = start * sampleRate;
    const endSample = end * sampleRate;
    starts.push(start);
    low.push(rmsOverRange(bands.low, startSample, endSample));
    mid.push(rmsOverRange(bands.mid, startSample, endSample));
    high.push(rmsOverRange(bands.high, startSample, endSample));
  }

  if (starts.length === 0) return null;
  return { firstBeatIndex, beatSeconds: starts, low, mid, high };
}
