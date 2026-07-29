// Audio engine v2, Part 2 — beat rolls (slip rolls). Same duck-overlay
// pattern as src/lib/scratch.ts: the dry deck is NEVER paused, just ducked
// (see Deck.duck/unduck) for the roll's duration, while a short native-loop
// AudioBufferSourceNode (sample-accurate loopStart/loopEnd — the PitchShifter
// path is NOT, ~93ms ScriptProcessor granularity, per this pass's pinned
// FACTS) plays on top, read straight from the deck's own decoded buffer. The
// underlying deck keeps advancing position the whole time — "slip" behavior
// falls out automatically, same as scratch.ts's file header already notes,
// since duck() only ever touches gain, never pause().
//
// planRoll() is the pure, audio-node-free planning logic (see
// scripts/check-roll.mjs); fireRoll() is the thin, unverifiable-here shell
// that schedules the real node — same split as scratch.ts's
// planScratchSegments()/scratch().
import type { AudioCore } from "./audio-core";
import type { Deck } from "./deck";

export type RollSubdivision = "1/8" | "1/4" | "1/2" | "1";

// Note-value convention (choir round #2 review, confirmed as intentional —
// documented here so a future reviewer doesn't re-flag it): these are
// standard eighth-/quarter-/half-/whole-NOTE fractions of a 4-beat bar (the
// Serato/Pioneer DJ-gear convention), not fractions of a single beat — an
// "eighth roll" is 4/8 = 0.5 beats, a "quarter roll" is 4/4 = 1 beat, etc.
const BEATS_PER_BAR = 4;
const SUBDIVISION_BEATS: Record<RollSubdivision, number> = {
  "1/8": BEATS_PER_BAR / 8,
  "1/4": BEATS_PER_BAR / 4,
  "1/2": BEATS_PER_BAR / 2,
  "1": BEATS_PER_BAR,
};

export const DEFAULT_ROLL_BEATS = 4;
const ROLL_DUCK_DB = -15; // deep enough the rolled slice reads as the whole rhythm, not a layer on top — between scratch's -12 and vocal-clip auto-duck's ~35%(-9.1dB) depth
const ROLL_DUCK_RAMP_SECONDS = 0.05;

export interface RollPlan {
  /** SOURCE-seconds start of the looped slice. */
  loopStart: number;
  /** SOURCE-seconds end of the looped slice — this is also where the slice was captured FROM (the current position; the slice reads backward from here). */
  loopEnd: number;
  /** The native AudioBufferSourceNode's playbackRate — set to the deck's current tempo so the overlay tracks a tempo-bent deck (pitches slightly; acceptable, see the file header of scratch.ts for the same native-speed-overlay tradeoff). */
  playbackRate: number;
  /** OUTPUT-time (wall-clock) total duration of the roll, before it hands back to the dry deck. */
  durationSeconds: number;
}

/**
 * Pure roll-slice planner: loops a slice of the CURRENT position
 * backward-aligned to the beat grid — slice length is `subdivision` worth of
 * beats at the deck's own (untouched-by-tempo) tagged BPM, ending exactly at
 * `positionSeconds` and starting one slice-length before it (clamped to 0, so
 * a roll fired in the first fraction of a beat never reads negative buffer
 * offsets). `rollBeats` (default 4, i.e. one bar) is how many beats' worth of
 * OUTPUT-time the roll runs for in total, independent of the (shorter)
 * captured slice length — the native loop repeats the slice to fill it.
 *
 * Degenerate input (non-finite/non-positive bpm or tempo) returns a
 * zero-length/zero-duration plan (loopStart === loopEnd, durationSeconds 0)
 * rather than fabricating a beat — callers (fireRoll below) treat that as
 * "nothing to roll", same convention as scratch.ts's planScratchSegments()
 * returning [] for a track with no decoded buffer.
 */
export function planRoll(
  positionSeconds: number,
  bpm: number,
  tempo: number,
  subdivision: RollSubdivision,
  rollBeats: number = DEFAULT_ROLL_BEATS
): RollPlan {
  const safePosition = Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0;
  const safeTempo = Number.isFinite(tempo) && tempo > 0 ? tempo : 1;

  if (!Number.isFinite(bpm) || bpm <= 0) {
    return { loopStart: safePosition, loopEnd: safePosition, playbackRate: safeTempo, durationSeconds: 0 };
  }

  const secondsPerBeat = 60 / bpm;
  const sliceLengthSeconds = SUBDIVISION_BEATS[subdivision] * secondsPerBeat;
  const loopEnd = safePosition;
  const loopStart = Math.max(0, loopEnd - sliceLengthSeconds);
  const durationSeconds = (Math.max(0, rollBeats) * secondsPerBeat) / safeTempo;

  return { loopStart, loopEnd, playbackRate: safeTempo, durationSeconds };
}

/**
 * Schedules the real overlay node for `subdivision` against `deck`'s
 * currently-decoded buffer, ducking the deck's own playback for the roll's
 * duration (see file header) and restoring it afterward via `deck.unduck()`
 * on a real timer — no-op (returns false) if nothing is decoded yet or the
 * plan collapsed to zero length/duration (no usable BPM). `bpm` is the
 * deck's TAGGED bpm (caller-supplied — Deck itself doesn't track it, same
 * convention Deck.echoTail's effectiveBpm parameter uses).
 */
export function fireRoll(
  deck: Deck,
  core: AudioCore,
  bpm: number,
  subdivision: RollSubdivision,
  rollBeats: number = DEFAULT_ROLL_BEATS
): boolean {
  const ctx = core.ensureContext();
  const buffer = deck.audioBuffer;
  if (!buffer) return false;

  const plan = planRoll(deck.positionSeconds, bpm, deck.tempo, subdivision, rollBeats);
  const loopEnd = Math.min(plan.loopEnd, buffer.duration);
  const loopStart = Math.min(plan.loopStart, loopEnd);
  if (loopEnd - loopStart <= 0 || plan.durationSeconds <= 0) return false;

  deck.duck(ROLL_DUCK_DB, ROLL_DUCK_RAMP_SECONDS);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.loopStart = loopStart;
  source.loopEnd = loopEnd;
  source.playbackRate.value = plan.playbackRate;
  source.connect(core.master);
  source.start(ctx.currentTime, loopStart);

  setTimeout(() => {
    // Choir round #2 (P4): source.stop()/disconnect() can throw
    // (InvalidStateError per the Web Audio spec — e.g. the node was
    // already stopped/GC'd through some other path) — guard so a thrown
    // error never skips the unduck() below, which would otherwise leave
    // the deck stuck permanently quiet (duck()'s refcount never balanced
    // back to 0). scratch.ts's segments were audited too — they never call
    // an explicit stop()/disconnect() at all (each source just ends
    // naturally after its own scheduled duration), so they don't share
    // this failure mode.
    try {
      source.stop();
      source.disconnect();
    } finally {
      deck.unduck(ROLL_DUCK_RAMP_SECONDS);
    }
  }, plan.durationSeconds * 1000);

  return true;
}
