// M7 Phase 5 — "down part" detection: the low-energy, vocal-free windows
// where El Cerebro's own name-drop belongs. Pure — plain arrays in, windows
// out, no AudioContext and no filesystem (see scripts/check-down-part.mjs).
//
// Deliberately built on what already exists rather than new analysis, per
// GOAL-M7.md Phase 5: energy.ts's computeRmsPerSecond gives the per-second
// energy profile (page.tsx already computes it for every queued track to
// find mix-in/mix-out), and src/data/vocal-maps.json gives the vocal-active
// intervals. A down part is simply the intersection: quiet FOR THIS TRACK,
// and nobody singing.
//
// The hard rule this encodes is "never over a vocal". That is not a
// preference — a hype tag landing on top of the singer is the single most
// obviously wrong thing the app can do with a voice clip, and it is why the
// vocal check here is a filter, not a score.
import type { VocalInterval } from "./vocal-map";

export interface DownPart {
  /** SOURCE-seconds start of the window. */
  start: number;
  /** SOURCE-seconds end of the window. */
  end: number;
  /** Mean RMS across the window, relative to the track's own median (0 = silence, 1 = typical for this track). */
  relativeEnergy: number;
}

export interface FindDownPartsOptions {
  /**
   * A second counts as "down" when its RMS is at or below this fraction of
   * the track's own MEDIAN second. Relative, not absolute, for the same
   * reason loop-points.ts normalizes per track: a quietly-mastered track
   * still has breakdowns, and a loud one still has them.
   */
  quietFraction?: number;
  /** Minimum usable window length in seconds — must fit the clip plus a little air. Default 3. */
  minWindowSeconds?: number;
  /** Vocal-active intervals for this track (SOURCE-seconds). */
  vocalIntervals?: VocalInterval[];
  /**
   * Whether `vocalIntervals` came from a real vocal map. When false the
   * result is EMPTY, not "everything is vocal-free": with no map we cannot
   * promise a window isn't over a vocal, and the whole point of this module
   * is that promise. Default false.
   */
  hasVocalMap?: boolean;
  /** Ignore windows starting before this (a track's silent lead-in isn't a musical down part). Default 8. */
  minStartSeconds?: number;
}

const DEFAULT_QUIET_FRACTION = 0.55;
const DEFAULT_MIN_WINDOW_SECONDS = 3;
const DEFAULT_MIN_START_SECONDS = 8;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** True when [start, end) touches no vocal interval at all. */
function vocalFree(intervals: VocalInterval[], start: number, end: number): boolean {
  return !intervals.some(([s, e]) => s < end && e > start);
}

/**
 * Low-energy, vocal-free windows, in time order.
 *
 * `rms` is energy.ts's computeRmsPerSecond output — index i is second i, so
 * the units line up with the vocal map's seconds without conversion.
 */
export function findDownParts(rms: number[], options: FindDownPartsOptions = {}): DownPart[] {
  const quietFraction = options.quietFraction ?? DEFAULT_QUIET_FRACTION;
  const minWindowSeconds = options.minWindowSeconds ?? DEFAULT_MIN_WINDOW_SECONDS;
  const minStartSeconds = options.minStartSeconds ?? DEFAULT_MIN_START_SECONDS;
  const intervals = options.vocalIntervals ?? [];
  const hasVocalMap = options.hasVocalMap ?? false;

  // No vocal map -> no promise -> no windows. See hasVocalMap's comment.
  if (!hasVocalMap) return [];
  if (rms.length === 0) return [];

  const med = median(rms);
  if (med <= 0) return []; // a silent track has no musical down part, just silence
  const threshold = med * quietFraction;

  const parts: DownPart[] = [];
  let runStart: number | null = null;
  for (let second = 0; second <= rms.length; second++) {
    const quiet = second < rms.length && rms[second] <= threshold;
    if (quiet && runStart === null) runStart = second;
    if (!quiet && runStart !== null) {
      const start = runStart;
      const end = second;
      runStart = null;
      if (end - start < minWindowSeconds) continue;
      if (start < minStartSeconds) continue;
      if (!vocalFree(intervals, start, end)) continue;
      let sum = 0;
      for (let i = start; i < end; i++) sum += rms[i];
      parts.push({ start, end, relativeEnergy: sum / (end - start) / med });
    }
  }
  return parts;
}

export interface PickDownPartOptions {
  /** Only consider windows at/after this position. Default 0. */
  fromSeconds?: number;
  /** The clip's own length — the window must hold it with room to spare. Default 0. */
  clipSeconds?: number;
  /** Extra air to leave after the clip inside the window. Default 0.5. */
  tailSeconds?: number;
}

/**
 * The next down part that can actually hold the clip, and the second within
 * it to fire at. Returns null when nothing qualifies — the caller must then
 * NOT fire, rather than falling back to "somewhere near here": a name-drop
 * placed by fallback is exactly the one that lands on a vocal.
 */
export function pickDownPart(
  parts: DownPart[],
  options: PickDownPartOptions = {}
): { part: DownPart; fireAtSeconds: number } | null {
  const fromSeconds = options.fromSeconds ?? 0;
  const clipSeconds = options.clipSeconds ?? 0;
  const tailSeconds = options.tailSeconds ?? 0.5;
  const needed = clipSeconds + tailSeconds;

  for (const part of parts) {
    const fireAt = Math.max(part.start, fromSeconds);
    if (fireAt + needed > part.end) continue;
    return { part, fireAtSeconds: fireAt };
  }
  return null;
}
