// Craft pass #2, Part 2 — pure phrase-boundary math for phrase-aligned
// transition firing. A "phrase" is 16 beats (grid.anchor + n*16 beats), same
// convention src/lib/energy.ts's PHRASE_BEATS already uses for mix-in/mix-out
// snapping. No AudioContext/timers here
// — src/app/page.tsx's executeQueueCommand computes candidates off this and
// schedules the actual delayed setTimeout.
import type { BeatGridLike } from "./beatclock";

const PHRASE_BEATS = 16;
// Small forward epsilon (SOURCE-seconds) so a position that's
// (numerically) exactly ON a phrase boundary — e.g. floating-point noise
// from prior arithmetic leaving positionSeconds a hair under the "true"
// boundary value — counts that boundary as already passed rather than
// re-returning it as "next" with a near-zero-second delay.
//
// BUG FIXED (choir round #2, C5): this used to be added DIRECTLY to
// phrasesSinceAnchor, a dimensionless phrase-COUNT (not seconds) — for an
// 8s phrase interval, adding 1e-6 "phrase-count units" is equivalent to an
// 8-MICROSECOND real-time tolerance window, large enough that a position
// exactly 1 microsecond before a genuine boundary (e.g. 7.999999s at an 8s
// phrase) got treated as "already at" that boundary and skipped a whole
// extra phrase (returned 16s instead of 8s). Fixed by (1) converting the
// epsilon into phrase-units by dividing by the ACTUAL phrase interval
// (so the real-time tolerance window stays EPSILON_SECONDS regardless of
// how long a phrase is) and (2) shrinking it to float-noise scale — no
// legitimate call site in this app computes a position within nanoseconds
// of a boundary on purpose, so a tolerance this tiny only ever catches
// genuine FP rounding error, never a deliberately-just-before position.
const EPSILON_SECONDS = 1e-9;

/**
 * The next `count` phrase-boundary positions (SOURCE-time, `grid.anchor +
 * n*16 beats`) strictly after `positionSeconds`, expressed as OUTPUT-time
 * (wall-clock) delays from now — `(boundarySourceSeconds - positionSeconds) /
 * tempo`, the same source-time -> output-time conversion
 * deckLiveState()'s remainingSeconds already uses in page.tsx.
 *
 * `grid` may be null (no real BeatGrid) — pass `fallbackBpm` (e.g. the
 * track's tagged BPM) to fall back to an estimated anchor-0 grid, the same
 * "estimated grid" convention page.tsx's own effectiveGrid() uses elsewhere;
 * with neither a grid nor a fallback BPM, there's no phrase interval to
 * compute at all, so this returns an empty list (never fabricates a beat).
 * Also empty when `tempo` or the effective BPM is not a finite positive
 * number, or `count` is not positive.
 */
export function nextPhraseBoundaries(
  grid: BeatGridLike | null,
  positionSeconds: number,
  tempo: number,
  count: number,
  fallbackBpm: number | null = null
): number[] {
  if (count <= 0 || !Number.isFinite(tempo) || tempo <= 0) return [];

  const effectiveGrid: BeatGridLike | null = grid ?? (fallbackBpm && fallbackBpm > 0 ? { anchor: 0, bpm: fallbackBpm } : null);
  if (!effectiveGrid || !Number.isFinite(effectiveGrid.bpm) || effectiveGrid.bpm <= 0) return [];

  const phraseIntervalSeconds = (60 / effectiveGrid.bpm) * PHRASE_BEATS;
  const phrasesSinceAnchor = (positionSeconds - effectiveGrid.anchor) / phraseIntervalSeconds;
  // Smallest integer n such that anchor + n*interval is strictly greater
  // than positionSeconds (the epsilon nudge treats an exact/near-exact hit
  // as "passed") — epsilon converted to phrase-units by dividing by THIS
  // interval, so the real-time tolerance stays EPSILON_SECONDS regardless
  // of phrase length (see EPSILON_SECONDS' own comment above).
  const epsilonPhrases = EPSILON_SECONDS / phraseIntervalSeconds;
  const nextIndex = Math.floor(phrasesSinceAnchor + epsilonPhrases) + 1;

  const boundaries: number[] = [];
  for (let i = 0; i < count; i++) {
    const sourceBoundary = effectiveGrid.anchor + (nextIndex + i) * phraseIntervalSeconds;
    const delayOutputSeconds = (sourceBoundary - positionSeconds) / tempo;
    boundaries.push(delayOutputSeconds);
  }
  return boundaries;
}
