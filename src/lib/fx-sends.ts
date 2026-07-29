// Audio engine v2, Part 1 — per-deck FX send/return architecture: real
// tempo-synced echo/delay with a ringing tail, a synthesized-IR convolver
// reverb, and HPF/LPF filter sweeps. Pure planning math lives here (no
// AudioContext dependency, unit-checkable — see scripts/check-fx-sends.mjs);
// src/lib/deck.ts owns the actual node graph and calls into these helpers,
// same split as src/lib/scratch.ts's planScratchSegments()/scratch().
//
// FACTS discrepancy, reported per the "verify, don't silently substitute"
// rule: the dispatch's FACTS said "echo_out ... likely gain-ramp only, no
// real delay tail" — false. deck.ts already had a real DelayNode + feedback
// GainNode + wet GainNode echo send (M4 Part B), tapped post-EQ/pre-duck-gain
// exactly as this pass's FACTS separately describe. What was missing: a
// clean reusable public API (this module + Deck.echoTail below), a real
// multi-repeat ring before the wet ramps out (the old code hard-silenced the
// tail after one fixed 400ms decay window, not "2-4 repeats"), reverb, and
// filter sweeps. This module upgrades the send architecture; it does not
// invent the delay tail from nothing.
export const ECHO_WET_CAP = 0.4; // "the pro rule" — never let a send outweigh 40% of the dry signal
export const REVERB_WET_CAP = 0.4;
export const DEFAULT_ECHO_RING_REPEATS = 3; // "2-4 repeats" per the dispatch — 3 is the middle of that range
export const DEFAULT_ECHO_RAMP_OUT_SECONDS = 0.5;
export const NEUTRAL_HPF_HZ = 20; // audibly transparent low end
export const NEUTRAL_LPF_HZ = 20000; // audibly transparent high end
export const MIN_SWEEP_HZ = 20;
export const MAX_SWEEP_HZ = 20000;
const FALLBACK_DELAY_SECONDS = 0.5; // used only when effectiveBpm <= 0 (no BPM at all)

/**
 * Choir round #2 (C4): page.tsx's "space_sweep" maskFx arms a filter
 * sweep/reverb wash/echo tail on the transition's `onGain` hook, gated by a
 * seam threshold — 1 (fire only once progress reaches "fully complete") for
 * the four "instant completion" transition kinds (cut/echo_out/gap/
 * loop_blend, whose onGain(1) and onDone fire in the SAME synchronous tick
 * or timer callback), vs 0.5 (fire at the ramp's own midpoint, with real
 * elapsed time left before completion) for the two blend kinds. Arming the
 * sweep at threshold===1 and then immediately releasing it back to neutral
 * in onDone (same synchronous call) would cancel the sweep before it's ever
 * audible — this predicate tells the caller when the release needs to be
 * DEFERRED (by the sweep's own ramp duration) instead of applied
 * immediately, so the two blend kinds (which never had this bug — see
 * above) keep releasing right away, unchanged.
 */
export function needsDeferredMaskFxRelease(seamThreshold: number): boolean {
  return seamThreshold >= 1;
}

/** Clamp a wet send level into [0, cap] — "the pro rule": never dominate the dry signal. */
export function clampWet(level: number, cap: number = ECHO_WET_CAP): number {
  if (!Number.isFinite(level)) return 0;
  return Math.min(Math.max(level, 0), cap);
}

/** A deck's real (tempo-bent) BPM — tagged BPM × current tempo. Trivial, but named so call sites read intentionally. */
export function effectiveBpmOf(taggedBpm: number, tempo: number): number {
  return taggedBpm * tempo;
}

/**
 * Delay time (seconds) for `beats` worth of the deck's EFFECTIVE BPM (tagged
 * BPM × tempo — pass the already-multiplied value in). 60/bpm = seconds per
 * beat at that BPM; falls back to FALLBACK_DELAY_SECONDS when there's no
 * usable BPM at all (untagged track), same "graceful degrade" convention
 * transition.ts's echo_out already used pre-this-pass.
 */
export function delayTimeForBeats(effectiveBpm: number, beats: number): number {
  if (!Number.isFinite(effectiveBpm) || effectiveBpm <= 0) return FALLBACK_DELAY_SECONDS;
  return (60 / effectiveBpm) * beats;
}

export interface EchoTailPlan {
  delayTimeSeconds: number;
  feedback: number;
  wetLevel: number; // clamped to ECHO_WET_CAP
  /** How long (seconds, from when the echo is armed) before the tail starts ramping toward silence. */
  ringSeconds: number;
  /** How long the final ramp-to-zero takes, once ringSeconds has elapsed. */
  rampOutSeconds: number;
}

/**
 * Full echo-tail timeline, in the abstract (seconds from "armed", not tied to
 * any node) — this is the "echo-out timeline" pure planner the dispatch asks
 * for, reused by both Deck.echoTail (which schedules the real ramp-down) and
 * transition.ts's echo_out (which needs to know when the DRY cut happens,
 * separately, at `beats` worth of time — see barSecondsForBeats below).
 */
export function planEchoTail(
  effectiveBpm: number,
  beats: number,
  feedback: number,
  wetLevel: number,
  repeats: number = DEFAULT_ECHO_RING_REPEATS,
  rampOutSeconds: number = DEFAULT_ECHO_RAMP_OUT_SECONDS
): EchoTailPlan {
  const delayTimeSeconds = delayTimeForBeats(effectiveBpm, beats);
  return {
    delayTimeSeconds,
    feedback,
    wetLevel: clampWet(wetLevel),
    ringSeconds: delayTimeSeconds * Math.max(1, repeats),
    rampOutSeconds: Math.max(0, rampOutSeconds),
  };
}

/** Seconds for `beats` worth of the effective BPM — the "one bar" (or fractional-beat) duration the echo-out dry cut waits for. Same math as delayTimeForBeats, named separately so call sites documenting "when does dry cut" read clearly. */
export function barSecondsForBeats(effectiveBpm: number, beats: number): number {
  return delayTimeForBeats(effectiveBpm, beats);
}

export interface EchoOutTimeline {
  delayTimeSeconds: number;
  /** Seconds from "transition starts" until the dry signal is cut (fromDeck.pause()+setGain(0)) — one bar (or the given beat count) at the outgoing deck's effective BPM. */
  dryCutAtSeconds: number;
  /** Seconds from "transition starts" until the wet tail begins ramping to silence. */
  wetRampOutAtSeconds: number;
  /** How long that final ramp takes. */
  rampOutSeconds: number;
  wetLevel: number;
}

/**
 * The full echo-out sequence transition.ts's "echo_out" kind needs: when the
 * dry cuts (cutBeats worth of the outgoing deck's effective BPM — historically
 * "one bar" in this codebase, actually one beat*fraction, see deck.ts's prior
 * ECHO_DELAY_BAR_FRACTION naming note) and when the ring, which starts the
 * instant the echo is armed (t=0, alongside the dry signal, so it keeps
 * ringing audibly AFTER the dry cut), finishes decaying.
 */
export function planEchoOutTimeline(
  effectiveBpm: number,
  cutBeats: number,
  echoBeats: number,
  feedback: number,
  wetLevel: number,
  repeats: number = DEFAULT_ECHO_RING_REPEATS,
  rampOutSeconds: number = DEFAULT_ECHO_RAMP_OUT_SECONDS
): EchoOutTimeline {
  const plan = planEchoTail(effectiveBpm, echoBeats, feedback, wetLevel, repeats, rampOutSeconds);
  return {
    delayTimeSeconds: plan.delayTimeSeconds,
    dryCutAtSeconds: barSecondsForBeats(effectiveBpm, cutBeats),
    wetRampOutAtSeconds: plan.ringSeconds,
    rampOutSeconds: plan.rampOutSeconds,
    wetLevel: plan.wetLevel,
  };
}

export interface SweepPlan {
  targetHz: number;
  seconds: number;
}

/** Clamps a filter sweep target into the audible/AudioParam-safe range and a non-negative duration. */
export function sweepPlan(targetHz: number, seconds: number): SweepPlan {
  const clampedHz = Number.isFinite(targetHz) ? Math.min(Math.max(targetHz, MIN_SWEEP_HZ), MAX_SWEEP_HZ) : NEUTRAL_HPF_HZ;
  return { targetHz: clampedHz, seconds: Math.max(0, Number.isFinite(seconds) ? seconds : 0) };
}

// --- Synthesized reverb impulse response ------------------------------

export const REVERB_IR_SECONDS = 2.5;
const REVERB_DECAY_POWER = 2; // exponential-feeling decay curve exponent

/**
 * Pure envelope math for the synthesized IR: 1 at the start of the impulse,
 * decaying to 0 at the end (fractionOfLength in [0,1]) — separated from the
 * actual noise generation so the DECAY SHAPE is unit-checkable without an
 * AudioContext (see scripts/check-fx-sends.mjs). The real IR multiplies white
 * noise by this envelope per-sample.
 */
export function reverbDecayEnvelope(fractionOfLength: number): number {
  const t = Math.min(Math.max(fractionOfLength, 0), 1);
  return Math.pow(1 - t, REVERB_DECAY_POWER);
}

const reverbIrCache = new WeakMap<AudioContext, AudioBuffer>();

/**
 * Builds (and caches per-AudioContext) a stereo ~2.5s exponentially-decaying
 * white-noise impulse response for the reverb send's ConvolverNode — zero-dep
 * per the dispatch's "synthesize the IR in code" rule. Unverifiable-here (no
 * real AudioContext in this environment, same standing caveat as every other
 * real-node function in deck.ts/scratch.ts) — the decay SHAPE it applies is
 * covered by reverbDecayEnvelope()'s own checks above.
 */
export function getOrBuildReverbImpulseResponse(ctx: AudioContext, seconds: number = REVERB_IR_SECONDS): AudioBuffer {
  const cached = reverbIrCache.get(ctx);
  if (cached) return cached;
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * reverbDecayEnvelope(i / length);
    }
  }
  reverbIrCache.set(ctx, impulse);
  return impulse;
}
