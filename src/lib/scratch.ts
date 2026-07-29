// Scratch engine for DJ Supermercado — Milestone 4 Part C.
//
// DESIGN CONSTRAINT, pinned deliberately: this repo has never had real-
// device audio verification available in this environment (every milestone
// through M3's CLAUDE_STATE.md says "NOT yet verified on a real phone", and
// there is no way to run a browser AudioContext from this harness to
// ear-test glitches). Genuinely disconnecting/reconnecting the deck's live
// PitchShifter mid-playback to splice in scratch segments is exactly the
// kind of change whose correctness (buffer underruns, clicky re-syncs,
// timing drift against the ScriptProcessor's ~93ms block size) can only
// really be judged by ear — so rather than spend effort building something
// unverifiable here, this uses the dispatch's own documented acceptable
// fallback: a DUCKING OVERLAY. The deck's normal PitchShifter playback is
// NEVER disconnected — it's simply ducked (see Deck.duck/unduck in
// deck.ts) for the scratch's duration and restored afterward. A separate
// scratch overlay, built from short AudioBufferSourceNode segments read
// directly from the deck's decoded buffer (forward) and a cached reversed
// copy of it (reverse), plays on top. The overlay is routed straight to
// AudioCore.master rather than through the deck's own gain node — simpler
// (no need to expose the deck's private gain node), and it keeps the
// scratch's volume envelope independent of whatever the crossfader/
// transition engine happens to be doing to that deck's gain at the moment
// (a manual scratch gesture and an automated transition are unlikely to
// overlap, but if they did, decoupling avoids a confusing interaction). The
// tradeoff, documented per the dispatch: the overlay is NOT affected by
// that deck's EQ/kill — acceptable for a personal tool.
//
// planScratchSegments() below is the pure, audio-node-free planning logic
// (testable without a browser — see scripts/check-scratch.mjs). scratch()
// is the thin, unverifiable-here shell that schedules real nodes from that
// plan.
import type { AudioCore } from "./audio-core";
import type { Deck } from "./deck";

export type ScratchPattern = "baby" | "chirp" | "spinback";

export interface ScratchSegment {
  direction: "forward" | "reverse";
  /** Offset (seconds) into the relevant buffer — the ORIGINAL buffer for "forward", the cached REVERSED buffer for "reverse". */
  offsetSeconds: number;
  durationSeconds: number;
  rateStart: number;
  rateEnd: number;
}

// --- pattern durations/rates — exact numbers are guidance per the dispatch; proportions are what matter. ---

const BABY_TOTAL_SECONDS = 0.7;
const BABY_SEGMENT_SECONDS = BABY_TOTAL_SECONDS / 4; // two forward->reverse flick pairs
const BABY_RATE = 1.3;

const CHIRP_TOTAL_SECONDS = 0.6;
const CHIRP_SEGMENT_COUNT = 3;
// Segment durations sum to ~75% of the target; the remaining ~25% is the
// silence/attack gaps BETWEEN cuts ("three short forward cuts with brief
// silence/attack between") — those gaps are real-time scheduling (added by
// scratch()'s scheduler below), not encoded in this pure per-segment array,
// so the "total duration" check in check-scratch.mjs allows headroom for it.
const CHIRP_SEGMENT_SECONDS = (CHIRP_TOTAL_SECONDS * 0.75) / CHIRP_SEGMENT_COUNT;
const CHIRP_GAP_SECONDS = (CHIRP_TOTAL_SECONDS * 0.25) / (CHIRP_SEGMENT_COUNT - 1);
const CHIRP_RATE = 1.6;

const SPINBACK_TOTAL_SECONDS = 1.2;
const SPINBACK_REVERSE_SECONDS = SPINBACK_TOTAL_SECONDS * 0.75; // decelerating reverse
const SPINBACK_TAIL_SECONDS = SPINBACK_TOTAL_SECONDS - SPINBACK_REVERSE_SECONDS; // brief resume-forward tail
const SPINBACK_REVERSE_RATE_START = 3.5;
const SPINBACK_REVERSE_RATE_END = 0.4;

const DUCK_GAIN_DB = -12;
const DUCK_RAMP_SECONDS = 0.05; // fast but smooth — see deck.ts's DUCK_TIME_CONSTANT_SECONDS

/**
 * Pure pattern -> segment-plan logic, no AudioContext dependency. `cursor`
 * (starting at `positionSeconds`) tracks where in the SOURCE track each
 * successive segment reads from/to, advancing forward for "forward"
 * segments and backward for "reverse" segments, always clamped to
 * [0, bufferDurationSeconds].
 *
 * Reverse segments read from a buffer that is a full reversal of the
 * original track (see Deck.getReversedBuffer). Position `p` in the
 * original corresponds to position `(bufferDurationSeconds - p)` in the
 * reversed buffer, so reading FORWARD through the reversed buffer starting
 * at `(bufferDurationSeconds - p)` sounds identical to reading BACKWARD
 * through the original starting at `p` — that's the offset math below.
 */
export function planScratchSegments(
  pattern: ScratchPattern,
  positionSeconds: number,
  bufferDurationSeconds: number
): ScratchSegment[] {
  if (bufferDurationSeconds <= 0) return []; // nothing to scratch from a track with no decoded audio yet

  const clampPos = (p: number) => Math.min(Math.max(p, 0), bufferDurationSeconds);
  const clampOffset = (desired: number, dur: number) => {
    const maxOffset = Math.max(0, bufferDurationSeconds - dur);
    return Math.min(Math.max(desired, 0), maxOffset);
  };

  const segments: ScratchSegment[] = [];
  let cursor = clampPos(positionSeconds);

  function pushSegment(direction: "forward" | "reverse", duration: number, rateStart: number, rateEnd: number) {
    const dur = Math.max(0.01, Math.min(duration, bufferDurationSeconds));
    if (direction === "forward") {
      const offset = clampOffset(cursor, dur);
      segments.push({ direction, offsetSeconds: offset, durationSeconds: dur, rateStart, rateEnd });
      cursor = clampPos(cursor + dur);
    } else {
      const reversedCursor = bufferDurationSeconds - cursor; // position in the reversed buffer
      const offset = clampOffset(reversedCursor, dur);
      segments.push({ direction, offsetSeconds: offset, durationSeconds: dur, rateStart, rateEnd });
      cursor = clampPos(cursor - dur);
    }
  }

  switch (pattern) {
    case "baby":
      // Two forward->reverse flick pairs.
      pushSegment("forward", BABY_SEGMENT_SECONDS, BABY_RATE, BABY_RATE);
      pushSegment("reverse", BABY_SEGMENT_SECONDS, BABY_RATE, BABY_RATE);
      pushSegment("forward", BABY_SEGMENT_SECONDS, BABY_RATE, BABY_RATE);
      pushSegment("reverse", BABY_SEGMENT_SECONDS, BABY_RATE, BABY_RATE);
      break;
    case "chirp":
      for (let i = 0; i < CHIRP_SEGMENT_COUNT; i++) {
        pushSegment("forward", CHIRP_SEGMENT_SECONDS, CHIRP_RATE, CHIRP_RATE);
      }
      break;
    case "spinback":
      // One long decelerating reverse segment, then a brief forward resume tail at normal rate.
      pushSegment("reverse", SPINBACK_REVERSE_SECONDS, SPINBACK_REVERSE_RATE_START, SPINBACK_REVERSE_RATE_END);
      pushSegment("forward", SPINBACK_TAIL_SECONDS, 1.0, 1.0);
      break;
  }

  return segments;
}

/**
 * Schedules the real Web Audio nodes for `pattern` against `deck`'s
 * currently-decoded buffer, ducking the deck's own playback for the
 * duration (see file header) and restoring it afterward. No-op if nothing
 * is decoded yet. Returns whether it actually scheduled anything — callers
 * use this to only count a scratch toward the fx frequency-cap cooldown
 * when it truly fired (see page.tsx's recordFxFired()).
 */
export function scratch(deck: Deck, core: AudioCore, pattern: ScratchPattern): boolean {
  const ctx = core.ensureContext();
  const buffer = deck.audioBuffer;
  if (!buffer) return false;

  const segments = planScratchSegments(pattern, deck.positionSeconds, buffer.duration);
  if (segments.length === 0) return false;

  const reversedBuffer = deck.getReversedBuffer(ctx);
  const gapSeconds = pattern === "chirp" ? CHIRP_GAP_SECONDS : 0;
  const totalDuration = segments.reduce((sum, s) => sum + s.durationSeconds, 0);
  const totalRealSeconds = totalDuration + gapSeconds * Math.max(0, segments.length - 1);

  deck.duck(DUCK_GAIN_DB, DUCK_RAMP_SECONDS);

  let startTime = ctx.currentTime;
  for (const segment of segments) {
    const sourceBuffer = segment.direction === "forward" ? buffer : reversedBuffer;
    if (!sourceBuffer) continue; // shouldn't happen once decoded, but stay safe

    const source = ctx.createBufferSource();
    source.buffer = sourceBuffer;
    if (segment.rateStart === segment.rateEnd) {
      source.playbackRate.value = segment.rateStart;
    } else {
      // Scripted rate envelope within the segment (e.g. spinback's decel).
      const steps = 8;
      const curve = new Float32Array(steps);
      for (let i = 0; i < steps; i++) {
        const t = i / (steps - 1);
        curve[i] = segment.rateStart + (segment.rateEnd - segment.rateStart) * t;
      }
      source.playbackRate.setValueCurveAtTime(curve, startTime, segment.durationSeconds);
    }
    source.connect(core.master);
    source.start(startTime, segment.offsetSeconds, segment.durationSeconds);
    startTime += segment.durationSeconds + gapSeconds;
  }

  setTimeout(() => deck.unduck(DUCK_RAMP_SECONDS), totalRealSeconds * 1000);
  return true;
}
