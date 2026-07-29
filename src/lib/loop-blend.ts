// Audio engine v2, Part 3 — loop-tension blends: loop the outgoing deck's
// clean bars while the incoming track fades in, exit on the 1. The pure
// planner (planLoopBlend) is audio-node-free (see scripts/check-loop-blend.mjs);
// the real overlay (fireLoopOverlay) is the thin, unverifiable-here shell —
// same split as scratch.ts/roll.ts. src/lib/transition.ts's "loop_blend" kind
// orchestrates the timing (duck the outgoing deck, fade the incoming deck in
// over loopBlend.totalDurationSeconds, exit on the final "1") via two
// callbacks (onLoopBlendStart/onLoopBlendEnd) that page.tsx wires directly to
// fireLoopOverlay()'s start/stop against the real Deck/AudioCore — the same
// "duck-overlay lives outside the abstract engine" pattern scratch.ts/roll.ts
// already established, since transition.ts's TransitionDeck interface has no
// access to a real AudioBuffer/AudioContext.
import type { AudioCore } from "./audio-core";
import type { Deck } from "./deck";
import type { BeatGridLike } from "./beatclock";

const LOOP_CAPTURE_BEATS = 16; // 4 bars — the FIXED captured-slice length, independent of `bars` below
const BEATS_PER_BAR = 4;
export const DEFAULT_LOOP_BLEND_BARS = 16; // reuses the same "durationBars" convention every other transition kind already uses
const EPSILON_SECONDS = 1e-6; // same forward-epsilon convention as phrase.ts, so a position exactly on a boundary counts it as "just passed"

export interface LoopBlendPlan {
  /** SOURCE-seconds start of the captured 4-bar/16-beat slice — the phrase boundary just passed. */
  loopStart: number;
  /** SOURCE-seconds end of the captured slice (loopStart + 16 beats at the grid's own bpm). */
  loopEnd: number;
  /** OUTPUT-time (wall-clock) total duration the blend runs for — `bars` bars at the deck's EFFECTIVE bpm (tagged bpm x tempo), independent of (and typically longer than) the fixed 16-beat captured slice; the native loop simply repeats the slice to fill it. */
  totalDurationSeconds: number;
}

/**
 * Pure loop-blend planner. `grid` MUST be a real (non-estimated) BeatGrid —
 * per the dispatch's own no-grid-fallback rule ("never attempt an unsnapped
 * loop"), a null/missing grid returns `null` outright rather than guessing an
 * anchor-0 estimate; callers (page.tsx) must fall back to "bass_swap"/"cut"
 * in that case, the same code-level guard pattern the pre-existing
 * untagged-BPM guard already uses for beatmatch_crossfade/bass_swap.
 *
 * The captured slice is ALWAYS 16 beats (4 bars) at the grid's own bpm,
 * snapped to start at the phrase boundary at-or-just-before `positionSeconds`
 * — independent of `bars`, which instead controls the TOTAL blend duration
 * (reusing the app's existing durationBars convention, default 16 — a longer
 * blend just repeats the same captured slice more times via the native
 * loop's own loopStart/loopEnd, not a longer capture).
 *
 * `bpm` is the deck's TAGGED bpm (used, times tempo, for the total-duration
 * math) — kept separate from `grid.bpm` for the same reason
 * transition.ts's effectiveFromBpm is computed from the tagged bpm rather
 * than the grid (a half/double-time-matched grid's bpm can legitimately
 * differ from the plain tag). Falls back to `grid.bpm` if `bpm` itself is
 * missing/non-positive (an unusual case — a real BeatGrid without any BPM
 * tag at all — but keeps the duration math finite rather than producing a
 * zero/negative-duration plan).
 */
export function planLoopBlend(
  grid: BeatGridLike | null,
  positionSeconds: number,
  bpm: number,
  tempo: number,
  bars: number = DEFAULT_LOOP_BLEND_BARS
): LoopBlendPlan | null {
  if (!grid || !Number.isFinite(grid.bpm) || grid.bpm <= 0) return null;

  const safeTempo = Number.isFinite(tempo) && tempo > 0 ? tempo : 1;
  const safePosition = Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0;

  const phraseIntervalSeconds = (60 / grid.bpm) * LOOP_CAPTURE_BEATS;
  const phrasesSinceAnchor = (safePosition - grid.anchor) / phraseIntervalSeconds;
  const prevIndex = Math.floor(phrasesSinceAnchor + EPSILON_SECONDS);
  const rawLoopStart = grid.anchor + prevIndex * phraseIntervalSeconds;
  // BUG FIXED (choir round #2, C8): rawLoopStart can land BEFORE 0 when
  // `positionSeconds` is earlier than the grid's own anchor (e.g. anchor 3s,
  // position 1s -> the phrase-aligned slice containing position 1 is
  // [-5, 3), not [0, 8)) — the old code clamped loopStart to 0 but then
  // computed loopEnd as loopStart + phraseIntervalSeconds regardless,
  // discarding the snapped relationship entirely and capturing an
  // UNSNAPPED slice that crosses the real boundary at `grid.anchor`. Per
  // the dispatch's own "never attempt an unsnapped loop" rule (already
  // applied one level up for a missing/estimated grid — see this
  // function's own null-grid guard above), snap FORWARD to the first
  // anchor-aligned slice that's actually >= 0 instead of clamping the
  // start in isolation.
  const safeIndex = rawLoopStart < 0 ? Math.ceil(-grid.anchor / phraseIntervalSeconds) : prevIndex;
  const loopStart = grid.anchor + safeIndex * phraseIntervalSeconds;
  const loopEnd = loopStart + phraseIntervalSeconds;

  const effectiveBpm = Number.isFinite(bpm) && bpm > 0 ? bpm * safeTempo : grid.bpm * safeTempo;
  const safeBars = Number.isFinite(bars) && bars > 0 ? bars : DEFAULT_LOOP_BLEND_BARS;
  // BUG FIXED (choir round #2, C3): the captured slice is a FIXED 4 bars
  // (LOOP_CAPTURE_BEATS/BEATS_PER_BAR), but totalDurationSeconds used to be
  // driven by the raw `bars` param directly — the schema allows any integer
  // 4-64, and the native loop just plays for totalDurationSeconds
  // regardless of whether that's a whole multiple of the 4-bar cycle it's
  // actually looping. A non-multiple (e.g. 10 bars = 2.5 loop cycles) means
  // fireLoopOverlay's stop() lands mid-cycle, not "on the 1" as the whole
  // move is supposed to. Round `bars` to the nearest whole multiple of the
  // capture length (never below one full capture) BEFORE computing the
  // duration, so the loop always completes a whole number of cycles.
  const captureBars = LOOP_CAPTURE_BEATS / BEATS_PER_BAR;
  const roundedBars = Math.max(captureBars, Math.round(safeBars / captureBars) * captureBars);
  const totalDurationSeconds = (roundedBars * BEATS_PER_BAR * 60) / effectiveBpm;

  return { loopStart, loopEnd, totalDurationSeconds };
}

/**
 * Starts the real native-loop overlay against `deck`'s currently-decoded
 * buffer (loopStart/loopEnd from a plan, sample-accurate via
 * AudioBufferSourceNode's own loop points), routed straight to
 * `core.master` — same "overlay bypasses that deck's EQ/kill" tradeoff
 * scratch.ts's file header documents, and the same reason: unverifiable in
 * this environment (no real-device audio rig), so the lower-risk overlay
 * approach is used rather than a live PitchShifter splice. `playbackRate` is
 * set to the deck's CURRENT tempo (per this pass's pinned FACTS: the overlay
 * plays at native speed otherwise, audibly wrong once the deck has been
 * tempo-bent away from 1.0 — pitches slightly at tempo != 1, an accepted
 * tradeoff, same class as scratch.ts's own native-speed caveat).
 *
 * Returns a `stop()` closure the caller holds across the transition-engine's
 * onLoopBlendStart/onLoopBlendEnd boundary (see transition.ts's "loop_blend"
 * kind) — idempotent (a second stop() call is a no-op). Returns `null` if
 * nothing is decoded yet or the (clamped-to-buffer-duration) slice collapsed
 * to zero length — should be rare given the no-grid guard already ran
 * upstream, but stays defensive rather than throwing.
 */
export function fireLoopOverlay(deck: Deck, core: AudioCore, loopStart: number, loopEnd: number): (() => void) | null {
  const ctx = core.ensureContext();
  const buffer = deck.audioBuffer;
  if (!buffer) return null;

  const clampedEnd = Math.min(loopEnd, buffer.duration);
  const clampedStart = Math.min(loopStart, clampedEnd);
  if (clampedEnd - clampedStart <= 0) return null;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.loopStart = clampedStart;
  source.loopEnd = clampedEnd;
  source.playbackRate.value = deck.tempo;
  source.connect(core.master);
  source.start(ctx.currentTime, clampedStart);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    // Choir round #2 (P4 audit): this closure is called from INSIDE
    // transition.ts's own loop_blend completion/cancel path (see
    // onLoopBlendEnd) — an uncaught InvalidStateError from stop() here
    // would abort that caller's own remaining cleanup (toDeck's gain,
    // fromDeck's pause/reset, `running`/onDone), a worse wedge than
    // roll.ts's version of this bug. Guard the same way.
    try {
      source.stop();
      source.disconnect();
    } catch {
      // best-effort teardown — nothing further to do if the node was
      // already stopped/disconnected through some other path
    }
  };
}
