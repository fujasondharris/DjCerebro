// In-and-out mixing (part 2 of the lesson-ledger/energy dispatch, 2026-07-28):
// pure RMS-energy analysis of a decoded track buffer, producing a mix-in
// point (skip a dead/quiet intro) and a mix-out point (exit before a dead
// outro) — no AudioContext here, same "pure src/lib module" discipline as
// beatmatch.ts/beatclock.ts. src/app/page.tsx runs this off the queued
// track's decoded AudioBuffer (channel 0, mono is fine for RMS) once per
// track, after decode and before the transition engine's play() — see
// page.tsx's analyzeMixPoints()/executeQueueCommand().
//
// FACTS discrepancy (reported per the "verify, don't silently substitute"
// rule): the dispatch's pinned FACTS describe the Serato BeatGrid shape as
// "{anchorSeconds, bpm}" — the actual field name, confirmed by reading
// src/lib/serato.ts/beatclock.ts's BeatGridLike, is `anchor`, not
// `anchorSeconds`. This module uses BeatGridLike ({anchor, bpm}) to stay
// consistent with the rest of the codebase (beatclock.ts, transition.ts).
import type { BeatGridLike } from "./beatclock";

export interface MixPoints {
  /** SOURCE-time seconds — same convention as Cue.atSeconds/Deck.positionSeconds. */
  mixInSeconds: number;
  mixOutSeconds: number;
  confidence: "high" | "low";
}

// --- Heuristic constants (see the dispatch's PART 2 for the exact rules) ---
const WINDOW_SECONDS = 4; // "≥4 consecutive seconds" of sustained energy
const ENERGY_PERCENTILE = 0.6; // the track's 60th-percentile RMS
const THRESHOLD_FRACTION = 0.5; // "≥ ~50% of" that percentile
const MIX_IN_CLAMP_SECONDS = 60; // "never skip more than a minute"
const MIN_RESIDENCY_SECONDS = 30; // "mixOut ≥ mixIn + 30s else fall back to full duration"
const EARLY_VOCAL_START_SECONDS = 4;
const EARLY_VOCAL_MIN_SECONDS = 8;
const EARLY_VOCAL_MAX_SKIP_SECONDS = 90;
const PHRASE_BEATS = 16; // "phrase boundary = anchor + n*16 beats"
// A track that's uniformly at/near digital silence has no real "energy
// build" for the heuristic to find — treated as a distinct low-confidence
// case (see findMixPoints' file-header note) rather than reporting a
// misleadingly "found" mixIn of 0.
const SILENCE_FLOOR = 1e-4;

/**
 * Per-second RMS of a mono (or single-channel) sample array. One-second
 * windows, last window may be shorter (partial trailing second) — pure,
 * no AudioContext (samples/sampleRate come from an already-decoded
 * AudioBuffer's getChannelData(0) + .sampleRate).
 */
export function computeRmsPerSecond(samples: Float32Array, sampleRate: number): number[] {
  if (samples.length === 0 || sampleRate <= 0) return [];
  const windowSize = Math.max(1, Math.round(sampleRate));
  const totalWindows = Math.ceil(samples.length / windowSize);
  const rms: number[] = new Array(totalWindows);
  for (let i = 0; i < totalWindows; i++) {
    const start = i * windowSize;
    const end = Math.min(samples.length, start + windowSize);
    let sumSquares = 0;
    for (let j = start; j < end; j++) sumSquares += samples[j] * samples[j];
    const count = end - start;
    rms[i] = count > 0 ? Math.sqrt(sumSquares / count) : 0;
  }
  return rms;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/** Average of rms[start..start+windowSeconds), clamped to the array bounds. */
function rollingAverage(rms: number[], start: number, windowSeconds: number): number {
  const end = Math.min(rms.length, start + windowSeconds);
  let sum = 0;
  for (let i = start; i < end; i++) sum += rms[i];
  const n = end - start;
  return n > 0 ? sum / n : 0;
}

function hasRealGrid(grid: BeatGridLike | null): grid is BeatGridLike {
  return grid !== null && grid.bpm > 0;
}

/** Nearest phrase boundary (anchor + n*16 beats) to `seconds`; nearest whole second when no real grid. */
function nearestPhraseBoundary(seconds: number, grid: BeatGridLike | null): number {
  if (!hasRealGrid(grid)) return Math.round(seconds);
  const phraseIntervalSeconds = (60 / grid.bpm) * PHRASE_BEATS;
  const n = Math.round((seconds - grid.anchor) / phraseIntervalSeconds);
  const raw = grid.anchor + n * phraseIntervalSeconds;
  if (raw < 0) {
    const minN = Math.ceil(-grid.anchor / phraseIntervalSeconds);
    return grid.anchor + minN * phraseIntervalSeconds;
  }
  return raw;
}

/** Phrase boundary at-or-before `seconds` (floor); whole second (floor) when no real grid. Used for mixOut (always "snap down") and for the mixIn 60s hard clamp (must never round UP past the clamp). If `seconds` is earlier than the first non-negative phrase boundary, snaps forward to the first non-negative phrase boundary (same C8 rule as loop-blend.ts). */
function phraseBoundaryAtOrBefore(seconds: number, grid: BeatGridLike | null): number {
  if (!hasRealGrid(grid)) return Math.floor(seconds);
  const phraseIntervalSeconds = (60 / grid.bpm) * PHRASE_BEATS;
  const n = Math.floor((seconds - grid.anchor) / phraseIntervalSeconds);
  const raw = grid.anchor + n * phraseIntervalSeconds;
  if (raw < 0) {
    const minN = Math.ceil(-grid.anchor / phraseIntervalSeconds);
    return grid.anchor + minN * phraseIntervalSeconds;
  }
  return raw;
}

/** Phrase boundary at-or-after `seconds` (ceil); whole second (ceil) when no real grid. Used when escaping known spoken/vocal material, where snapping backward could leave speech in the intro. */
function phraseBoundaryAtOrAfter(seconds: number, grid: BeatGridLike | null): number {
  if (!hasRealGrid(grid)) return Math.ceil(seconds);
  const phraseIntervalSeconds = (60 / grid.bpm) * PHRASE_BEATS;
  const n = Math.ceil((seconds - grid.anchor) / phraseIntervalSeconds);
  return grid.anchor + n * phraseIntervalSeconds;
}

/**
 * Finds the mix-in (skip a dead/quiet intro) and mix-out (exit before a dead
 * outro) points from a track's per-second RMS profile. See the dispatch's
 * PART 2 for the exact heuristic; summarized:
 *  - mixIn = start of the first ≥4-consecutive-second window whose rolling
 *    average RMS is ≥ ~50% of the track's own 60th-percentile RMS, snapped
 *    to the nearest phrase boundary (or whole second without a real grid),
 *    hard-clamped to ≤60s (never skip more than a minute) — a clamp always
 *    marks confidence "low".
 *  - mixOut = end of the LAST such window, snapped DOWN to a phrase
 *    boundary (or whole second). Falls back to the full duration if that
 *    would leave under 30s of "residency" after mixIn.
 *  - A track with no real energy signal at all (uniformly at/near silence)
 *    is its own low-confidence case, not a false "found at 0s".
 */
export function findMixPoints(rms: number[], grid: BeatGridLike | null): MixPoints {
  const duration = rms.length;
  if (duration === 0) {
    return { mixInSeconds: 0, mixOutSeconds: 0, confidence: "low" };
  }

  const threshold = percentile(rms, ENERGY_PERCENTILE) * THRESHOLD_FRACTION;
  const noSignal = percentile(rms, ENERGY_PERCENTILE) < SILENCE_FLOOR;

  let mixInSeconds: number;
  let confidence: "high" | "low" = "high";

  // BUG FIXED (choir round #2, P6): both "no sustained window found"
  // fallbacks below used to clamp to Math.min(MIX_IN_CLAMP_SECONDS,
  // duration) — for a track SHORTER than the 60s clamp (in particular
  // shorter than WINDOW_SECONDS, so the sustained-window scan below can
  // never even run: the loop bound `duration - WINDOW_SECONDS` goes
  // negative and the loop body never executes), that collapses to `duration`
  // itself, i.e. "mix in at the very end of the track" — seeking there is
  // effectively instant silence. 0 (the start of the track) is always a
  // safe fallback when there's no sustained-energy signal to hang a real
  // mixIn point on.
  if (noSignal) {
    mixInSeconds = phraseBoundaryAtOrBefore(0, grid);
    confidence = "low";
  } else {
    let mixInRaw: number | null = null;
    for (let i = 0; i <= duration - WINDOW_SECONDS; i++) {
      if (rollingAverage(rms, i, WINDOW_SECONDS) >= threshold) {
        mixInRaw = i;
        break;
      }
    }
    if (mixInRaw === null) {
      mixInSeconds = phraseBoundaryAtOrBefore(0, grid);
      confidence = "low";
    } else {
      mixInSeconds = nearestPhraseBoundary(mixInRaw, grid);
    }
  }

  // Hard invariant, enforced regardless of which path produced the value
  // above — "never skip more than a minute" is absolute, and a
  // nearest-boundary snap could in principle round slightly past 60s.
  if (mixInSeconds > MIX_IN_CLAMP_SECONDS) {
    mixInSeconds = phraseBoundaryAtOrBefore(MIX_IN_CLAMP_SECONDS, grid);
    confidence = "low";
  }
  mixInSeconds = Math.min(Math.max(0, mixInSeconds), duration);

  let mixOutSeconds: number;
  if (noSignal) {
    mixOutSeconds = duration;
  } else {
    let mixOutRaw: number | null = null;
    for (let end = duration; end - WINDOW_SECONDS >= 0; end--) {
      const start = end - WINDOW_SECONDS;
      if (rollingAverage(rms, start, WINDOW_SECONDS) >= threshold) {
        mixOutRaw = end;
        break;
      }
    }
    mixOutSeconds = mixOutRaw === null ? duration : phraseBoundaryAtOrBefore(mixOutRaw, grid);
  }
  mixOutSeconds = Math.min(Math.max(0, mixOutSeconds), duration);

  if (mixOutSeconds < mixInSeconds + MIN_RESIDENCY_SECONDS) {
    mixOutSeconds = duration;
  }

  return { mixInSeconds, mixOutSeconds, confidence };
}

// --- Cue override (mixIn only) ---------------------------------------------

/** Minimal shape needed from a Cue for the override — decoupled from cue-store.ts's full Cue type so energy.ts stays a leaf module. */
export interface MixInCueLike {
  label?: string;
  atSeconds: number;
}

/** "mix in" / "mixin" / a standalone "in" label, per the dispatch's exact pattern. */
const MIX_IN_LABEL_PATTERN = /\b(mix ?in|in)\b/i;

/**
 * If the track has a user-assigned cue whose label matches
 * MIX_IN_LABEL_PATTERN, that cue's position wins over the heuristic for
 * mixIn (confidence becomes "high" — a human-placed mark is authoritative).
 * First match wins (cues are usually sorted by atSeconds already, see
 * cue-store.ts's setCues). No-op (returns `points` unchanged) if none match.
 *
 * BUG FIXED (choir round #2, C6): this had no UPPER bound at all — a
 * stale/mislabeled "mix in" cue placed past the track's own valid range
 * (near/at end of file, or past the analyzed mixOut point) used to seek
 * there anyway with confidence bumped to "high", i.e. the MOST trusted
 * value the engine can produce, for what's effectively "start playing at
 * the very end" (near-instant silence). `durationSeconds` (the track's own
 * length, same units/granularity as findMixPoints' `rms` array) is now
 * required so an out-of-range cue can be validated: valid range is
 * [0, min(durationSeconds - MIN_RESIDENCY_SECONDS, points.mixOutSeconds)] —
 * the same 30s floor guard findMixPoints itself already enforces between
 * mixIn/mixOut, and never past the analyzed mixOut point. Out of range ->
 * ignore the cue entirely (keep the heuristic's own point AND its own
 * confidence untouched) rather than clamping the value to the boundary,
 * which would silently move the cue to a spot the human never actually
 * marked.
 */
export function applyMixInCueOverride(points: MixPoints, cues: MixInCueLike[], durationSeconds: number): MixPoints {
  const match = cues.find((c) => c.label && MIX_IN_LABEL_PATTERN.test(c.label));
  if (!match) return points;
  const upperBound = Math.max(0, Math.min(durationSeconds - MIN_RESIDENCY_SECONDS, points.mixOutSeconds));
  if (match.atSeconds < 0 || match.atSeconds > upperBound) return points;
  return { ...points, mixInSeconds: match.atSeconds, confidence: "high" };
}

/**
 * Energy alone cannot distinguish a real beat from talking over a YouTube
 * intro bed. If auto-entry would start at/near zero and the vocal map says a
 * vocal/spoken block begins immediately, move the mix-in to the first phrase
 * after that early block when the map also shows a real gap before the next
 * vocal. This is deliberately skipped for later vocals, continuous opening
 * vocals, and long/unknown intros so normal lyric-starting songs do not get
 * gutted.
 */
export function avoidEarlyVocalIntro(
  points: MixPoints,
  vocalIntervals: [number, number][],
  grid: BeatGridLike | null,
  durationSeconds: number
): MixPoints {
  if (points.mixInSeconds > EARLY_VOCAL_START_SECONDS) return points;
  const sorted = [...vocalIntervals].sort((a, b) => a[0] - b[0]);
  const earlyIndex = sorted.findIndex(([start, end]) => {
    const length = end - start;
    return start <= EARLY_VOCAL_START_SECONDS && length >= EARLY_VOCAL_MIN_SECONDS && end <= EARLY_VOCAL_MAX_SKIP_SECONDS;
  });
  if (earlyIndex < 0) return points;
  const early = sorted[earlyIndex];
  const next = sorted[earlyIndex + 1];
  if (!next || next[0] - early[1] < EARLY_VOCAL_MIN_SECONDS) return points;

  const upperBound = Math.max(0, Math.min(durationSeconds - MIN_RESIDENCY_SECONDS, points.mixOutSeconds));
  const escaped = phraseBoundaryAtOrAfter(early[1], grid);
  if (escaped <= points.mixInSeconds || escaped > upperBound) return points;
  return { ...points, mixInSeconds: escaped, confidence: "low" };
}
