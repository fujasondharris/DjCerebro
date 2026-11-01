// M7 Phase 2 — the band-isolated HELD loop: capture a phrase-aligned slice of
// the live track, play it ALONE for ~30 seconds with a frequency band killed,
// build tension by progressively halving it, and exit on the "1" with the
// incoming track tempo-locked.
//
// planHeldLoop() is the pure, audio-node-free planner (see
// scripts/check-loop-hold.mjs); fireIsolatedLoopHold() is the thin,
// unverifiable-here shell — the same split as loop-blend.ts's
// planLoopBlend/fireLoopOverlay and roll.ts's planRoll/fireRoll.
//
// HELD vs ROLL (a distinction the codebase previously blurred, GOAL-M7.md
// Phase 2): a loop ROLL (roll.ts) keeps the track playing underneath and
// releases to where it would have been, so phrasing is preserved — it is a
// garnish. A HELD loop locks the track in place and becomes the only thing
// playing; it is transition INFRASTRUCTURE, which is exactly why exiting on
// the "1" matters so much here and barely matters for a roll.
//
// Three things this fixes about the existing overlay:
//  1. fireLoopOverlay connects the buffer source straight to core.master
//     (loop-blend.ts), bypassing the deck's EQ — so the deck's kill buttons
//     cannot band-isolate it. This module gives the loop its OWN 3-band
//     chain, mirroring deck.ts's lowshelf/peaking/highshelf at the same
//     corner frequencies and the same EQ_KILL_DB.
//  2. LOOP_CAPTURE_BEATS was hardcoded at 16. Capture length is a parameter
//     here, and it HALVES mid-hold — the actual tension move.
//  3. The overlay's playbackRate = deck.tempo pitches whenever the deck is
//     bent off 1.0. Held alone for 30s that is fully exposed. Here the pitch
//     ride is deliberate and, critically, RESOLVES TO 1.0 (the track's own
//     key) for the final stage, so the hold hands over in the original key.
import type { AudioCore } from "./audio-core";
import type { Deck } from "./deck";
import type { BeatGridLike } from "./beatclock";
import type { IsolationMode } from "./loop-points";
import {
  clampWet,
  delayTimeForBeats,
  getOrBuildReverbImpulseResponse,
  REVERB_WET_CAP,
} from "./fx-sends.ts";

const BEATS_PER_BAR = 4;
/** A phrase is 16 beats — same convention as energy.ts/phrase.ts/loop-blend.ts. */
const PHRASE_BEATS = 16;
const EPSILON_SECONDS = 1e-6; // same forward-epsilon convention as loop-blend.ts

// --- Band isolation --------------------------------------------------------

/** Mirrors deck.ts's own EQ constants exactly, so "killed here" means what the deck's kill buttons mean. */
export const EQ_LOW_FREQ_HZ = 250;
export const EQ_MID_FREQ_HZ = 1000;
export const EQ_MID_Q = 1;
export const EQ_HIGH_FREQ_HZ = 4000;
export const EQ_KILL_DB = -40;

/**
 * M8.2h — the low band is DUCKED in "melody" mode, never killed. Owner heard the
 * failure on 2026-08-16: "he just did a stem without any drums on a loop" — a hook
 * floating with no floor under it. That was `melody` = low at -40 dB, a full kill of
 * the band that carries kick and bass, which directly violates his one hard rule:
 * ALWAYS A BASSLINE LOOPING ("you always need rhythm and bass, and the harmony and
 * melody can change around it"). The prompt stated the rule and the engine shipped
 * a mode that broke it. -12 dB lets the hook lead — the melodic content is clearly
 * what you hear — while the pulse never leaves the floor.
 */
export const MELODY_LOW_DUCK_DB = -12;
/** The incoming deck gets one complete 16-beat phrase to enter under the sample. */
export const SAMPLE_MIX_HANDOFF_BEATS = 16;
export const SAMPLE_MIX_ACTIVATION_LATE_TOLERANCE_MS = 40;
export const SAMPLE_MIX_TIMER_LATE_TOLERANCE_MS = 250;

export function sampleMixHandoffIsLate(
  actualMs: number,
  scheduledMs: number,
  toleranceMs: number = SAMPLE_MIX_TIMER_LATE_TOLERANCE_MS
): boolean {
  return actualMs - scheduledMs > Math.max(0, toleranceMs);
}

export interface IsolationEq {
  low: number;
  mid: number;
  high: number;
}

/**
 * The two isolation modes from GOAL-M7.md item 5:
 *  - "beat"   — kill high + mid, leaving drums and the low end. Vocals sit
 *               mostly in the mid band, so killing mid+high is what strips
 *               them; a vocal with heavy low-mid energy WILL still bleed,
 *               which is why segment selection (a vocal-free, pattern-
 *               repeating range from loop-points.json) does most of the work
 *               and stems stay out of scope.
 *  - "melody" — DUCK low (not kill), so the hook leads but the bassline never
 *               leaves. A full kill here broke the owner's hard rule (see
 *               MELODY_LOW_DUCK_DB).
 */
export function isolationEq(mode: IsolationMode): IsolationEq {
  return mode === "melody"
    ? { low: MELODY_LOW_DUCK_DB, mid: 0, high: 0 } // duck, never kill — see MELODY_LOW_DUCK_DB
    : { low: 0, mid: EQ_KILL_DB, high: EQ_KILL_DB };
}

export interface SampleMixFrame {
  sampleGain: number;
  incomingGain: number;
  sampleLowDb: number;
  incomingLowDb: number;
}

/**
 * The deterministic fader/EQ frame for the final sample-mix phrase.
 * Gains use an equal-power curve; the low bands trade places across the
 * middle two bars so there is never a one-tick bass cut at resolve.
 */
export function sampleMixFrame(progress: number, isolation: IsolationMode): SampleMixFrame {
  const p = Math.min(1, Math.max(0, progress));
  const bassProgress = Math.min(1, Math.max(0, (p - 0.25) / 0.5));
  return {
    sampleGain: Math.cos((p * Math.PI) / 2),
    incomingGain: Math.sin((p * Math.PI) / 2),
    // "beat": the sample's low band hands over to the incoming track across the
    // middle bars (kill ramps in as the incoming bass ramps up — never a gap).
    // "melody": DUCKED, never killed (M8.2h) — the incoming bass rises underneath a
    // still-present floor, so a bassline is looping at every instant of the mix.
    sampleLowDb: isolation === "beat" ? EQ_KILL_DB * bassProgress : MELODY_LOW_DUCK_DB,
    incomingLowDb: EQ_KILL_DB * (1 - bassProgress),
  };
}

export interface SampleMixEnvelope {
  sampleGain: number[];
  incomingGain: number[];
  sampleLowDb: number[];
  incomingLowDb: number[];
}

export interface SampleMixFxFrame {
  seamProgress: number;
  wetShape: number;
}

/** The seam FX is silent for two bars, blooms, then returns to zero at resolve. */
export function sampleMixFxFrame(progress: number): SampleMixFxFrame {
  const seamProgress = Math.min(1, Math.max(0, (progress - 0.5) / 0.5));
  return {
    seamProgress,
    wetShape: Math.sin(Math.PI * seamProgress),
  };
}

/** AudioParam-ready control points from the current handoff position to its end. */
export function sampleMixEnvelope(
  isolation: IsolationMode,
  startProgress: number = 0,
  segments: number = 32
): SampleMixEnvelope {
  const start = Math.min(1, Math.max(0, startProgress));
  const count = Math.max(1, Math.floor(segments));
  const envelope: SampleMixEnvelope = {
    sampleGain: [],
    incomingGain: [],
    sampleLowDb: [],
    incomingLowDb: [],
  };
  for (let index = 0; index <= count; index += 1) {
    const progress = start + (1 - start) * (index / count);
    const frame = sampleMixFrame(progress, isolation);
    envelope.sampleGain.push(frame.sampleGain);
    envelope.incomingGain.push(frame.incomingGain);
    envelope.sampleLowDb.push(frame.sampleLowDb);
    envelope.incomingLowDb.push(frame.incomingLowDb);
  }
  return envelope;
}

// --- Halving ---------------------------------------------------------------

export interface HalvingStage {
  /** Loop length for this stage, in beats. Always a power-of-two division of the base capture. */
  captureBeats: number;
  /** Whole loop cycles played at this length — never fractional, so every stage ends on a loop boundary. */
  cycles: number;
}

/**
 * The progressive-halving tail: 4 bars -> 2 -> 1 -> 1/2 -> 1 beat, per both
 * research channels (DJ Blakey's intermediate/pro looping, Crossfader). Each
 * halved stage plays `cyclesPerStage` whole cycles, so the tail accelerates
 * without ever landing off a loop boundary.
 *
 * Stops halving at 1 beat (below that it stops reading as a loop and starts
 * reading as a buzz) and never emits a stage shorter than `minBeats`.
 */
export function planHalvingStages(baseBeats: number, stageCount: number, cyclesPerStage: number = 2, minBeats: number = 1): HalvingStage[] {
  const stages: HalvingStage[] = [];
  let beats = baseBeats;
  for (let i = 0; i < stageCount; i++) {
    beats = beats / 2;
    if (beats < minBeats) break;
    stages.push({ captureBeats: beats, cycles: Math.max(1, Math.round(cyclesPerStage)) });
  }
  return stages;
}

// --- The plan --------------------------------------------------------------

export interface HeldLoopStage extends HalvingStage {
  /** Playback rate for this stage. Constant WITHIN the stage — see planHeldLoop's note on why the pitch ride is stepped rather than continuous. */
  rate: number;
  /** OUTPUT-time (wall-clock) seconds this stage runs for: its whole cycles at its own rate. */
  durationSeconds: number;
  /** OUTPUT-time offset from the start of the hold at which this stage begins. */
  startAtSeconds: number;
  /** SOURCE-seconds end of this stage's (sub-)slice — loopStart stays put, the end halves. */
  loopEnd: number;
}

export interface HeldLoopPlan {
  /** SOURCE-seconds start of the captured slice — the phrase boundary at/just before the request position. */
  loopStart: number;
  /** SOURCE-seconds end of the FULL captured slice (the first stage's end). */
  loopEnd: number;
  /** Length of the base capture in beats (captureBars * 4). */
  captureBeats: number;
  stages: HeldLoopStage[];
  /** OUTPUT-time (wall-clock) total — the sum of the stages, always a whole number of loop cycles at each stage's own rate. */
  totalDurationSeconds: number;
  /** Total SOURCE beats the hold consumes. Always a multiple of 16 so the exit lands on a phrase "1". */
  totalBeats: number;
  /** Beat count reserved at the final, constant exit rate for the incoming handoff. Always exactly 16. */
  handoffBeats: number;
  /** OUTPUT-time offset where the incoming deck may start. Before this, the sample plays alone. */
  handoffStartAtSeconds: number;
  /** OUTPUT-time duration of the final equal-power/EQ handoff. */
  handoffDurationSeconds: number;
  /** Playback rate at the exit — 1 (the track's ORIGINAL key and native tempo) unless a tempo sweep asked for a different `resolveToRate`. */
  exitRate: number;
  /** The BPM the incoming track must be tempo-matched to at the exit (grid.bpm * exitRate). For a loop-covered sweep this is the swept-to tempo, which is the whole point: the incoming track enters unclamped. */
  exitBpm: number;
  isolation: IsolationMode;
  eq: IsolationEq;
}

export interface PlanHeldLoopOptions {
  /** Base capture length in BARS — 2, 4 or 8 (GOAL-M7.md Phase 2's "selectable capture"). Default 4. */
  captureBars?: number;
  /** Roughly how long to hold, OUTPUT-time seconds. Quantized UP/DOWN to whole cycles — "~30s", never 30.000s. Default 30. */
  targetHoldSeconds?: number;
  /** How many creative halvings to run before the fixed four-bar handoff. Default 3 (e.g. 4 bars -> 2 -> 1 -> 1/2). */
  halvingStages?: number;
  /** Whole cycles played at each halved stage. Default 2. */
  cyclesPerHalvedStage?: number;
  isolation?: IsolationMode;
  /**
   * Peak playback rate for the deliberate pitch rise, as a multiple of 1.0.
   * Default 1.06. Clamped to [1, MAX_PEAK_RATE]. The rise is a documented
   * tension technique (both research channels), not a defect to hide — but
   * it always resolves to 1.0 for the final stage.
   */
  peakRate?: number;
  /**
   * M7 Phase 4 — LOOP-COVERED TEMPO SWEEP. The rate the hold resolves TO,
   * instead of the default 1.0 (the track's own key).
   *
   * This is the answer to the clamped transition Jason rated down (La
   * Gozadera -> Gasolina, `clamped: true`): today an out-of-±8% BPM gap can
   * only ever become a `cut`, because syncTempo refuses to bend a deck
   * further than its range. Riding the tempo UNDER a held loop crosses the
   * gap musically instead of giving up — the research names this explicitly
   * as the open-format DJ's move. The loop is the only thing playing, so
   * there is no second track for the sweep to fight with, and the incoming
   * track then enters at its OWN natural tempo with nothing clamped.
   *
   * Clamped to [0.5, 2]: beyond an octave the loop stops being the same
   * musical material.
   */
  resolveToRate?: number;
}

const DEFAULT_CAPTURE_BARS = 4;
const DEFAULT_TARGET_HOLD_SECONDS = 30;
const DEFAULT_HALVING_STAGES = 3;
const DEFAULT_CYCLES_PER_HALVED_STAGE = 2;
const DEFAULT_PEAK_RATE = 1.06;
/** A rise beyond this stops reading as tension and starts reading as a fault. */
const MAX_PEAK_RATE = 1.12;

/**
 * Pure held-loop planner.
 *
 * `grid` MUST be a real BeatGrid — a null/zero-bpm grid returns null rather
 * than guessing, the same no-unsnapped-loop rule planLoopBlend already
 * enforces (GOAL-M7.md PRINCIPLE 4).
 *
 * Quantization (PRINCIPLE 5): the hold is built from WHOLE loop cycles, and
 * the total is padded until it is a whole number of 16-beat phrases, so the
 * exit lands on the phrase "1" rather than merely on some beat. `targetHold
 * Seconds` is therefore approached, never hit exactly — "~30 seconds" is the
 * spec.
 *
 * Why the pitch ride is STEPPED (one constant rate per stage) rather than a
 * continuous ramp: a buffer source's progress through its slice is the
 * integral of its playback rate, so a rate that varies *within* a stage makes
 * that stage's wall-clock length depend on the ramp shape — and the exit
 * stops being sample-accurate. Holding the rate constant inside each stage
 * keeps every stage an exact whole number of cycles while still delivering
 * the rise, and each step lands exactly on a loop boundary, which is where a
 * DJ nudging a pitch fader would put it anyway. The last stage is pinned to
 * rate 1.0, so the hold hands over in the track's original key.
 */
export function planHeldLoop(
  grid: BeatGridLike | null,
  positionSeconds: number,
  tempo: number,
  options: PlanHeldLoopOptions = {}
): HeldLoopPlan | null {
  if (!grid || !Number.isFinite(grid.bpm) || grid.bpm <= 0) return null;

  // captureBars is snapped to a POWER OF TWO (choir round #3, finding 2).
  // The phrase-alignment padding below can only work if the shortest stage
  // length divides 16: every stage is baseBeats / 2^k, so baseBeats must be
  // a power of two for that to hold. With captureBars: 3 the plan came out
  // at 66 beats — 66 % 16 = 2 — i.e. it REPORTED a phrase-aligned exit while
  // landing two beats past the "1". The command schema only offers 2/4/8, so
  // this was unreachable through the app, but planHeldLoop is a public pure
  // function and must not silently lie about its own core guarantee.
  const requestedBars = Math.max(1, Math.round(options.captureBars ?? DEFAULT_CAPTURE_BARS));
  const captureBars = 2 ** Math.round(Math.log2(requestedBars));
  const targetHoldSeconds = Math.max(1, options.targetHoldSeconds ?? DEFAULT_TARGET_HOLD_SECONDS);
  const halvingStageCount = Math.max(0, Math.round(options.halvingStages ?? DEFAULT_HALVING_STAGES));
  const cyclesPerHalvedStage = Math.max(1, Math.round(options.cyclesPerHalvedStage ?? DEFAULT_CYCLES_PER_HALVED_STAGE));
  const isolation = options.isolation ?? "beat";
  const startRate = Number.isFinite(tempo) && tempo > 0 ? tempo : 1;
  const peakRate = Math.min(MAX_PEAK_RATE, Math.max(1, options.peakRate ?? DEFAULT_PEAK_RATE));
  const rawResolve = options.resolveToRate;
  const resolveRate =
    Number.isFinite(rawResolve) && (rawResolve as number) > 0 ? Math.min(2, Math.max(0.5, rawResolve as number)) : 1;

  const captureBeats = captureBars * BEATS_PER_BAR;
  const sourceSecondsPerBeat = 60 / grid.bpm;

  // --- Capture: snap to the phrase boundary at/just before the position ---
  const phraseIntervalSeconds = sourceSecondsPerBeat * PHRASE_BEATS;
  const safePosition = Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0;
  const phrasesSinceAnchor = (safePosition - grid.anchor) / phraseIntervalSeconds;
  const prevIndex = Math.floor(phrasesSinceAnchor + EPSILON_SECONDS);
  const rawLoopStart = grid.anchor + prevIndex * phraseIntervalSeconds;
  // Same forward-snap as planLoopBlend's C8 fix: a would-be negative start
  // snaps FORWARD to the first anchor-aligned phrase >= 0, never an
  // unsnapped clamp to 0.
  const safeIndex = rawLoopStart < 0 ? Math.ceil(-grid.anchor / phraseIntervalSeconds) : prevIndex;
  const loopStart = grid.anchor + safeIndex * phraseIntervalSeconds;
  const loopEnd = loopStart + captureBeats * sourceSecondsPerBeat;

  // --- Stage lengths (beats), base first then the halving tail ---
  const tail = planHalvingStages(captureBeats, halvingStageCount, cyclesPerHalvedStage);

  // The performance contract is an exact four-bar handoff even when the
  // sampled phrase is longer or creative halving is disabled. Add a final
  // 16-beat sub-loop when the requested sequence would otherwise end wider.
  const finalCreativeCaptureBeats = tail.length > 0 ? tail[tail.length - 1].captureBeats : captureBeats;
  if (finalCreativeCaptureBeats > SAMPLE_MIX_HANDOFF_BEATS) {
    tail.push({ captureBeats: SAMPLE_MIX_HANDOFF_BEATS, cycles: 1 });
  }

  // The incoming deck cannot beatmatch a loop whose rate is still stepping.
  // Reserve at least one complete phrase in the final (resolve-rate) stage.
  // Because every stage length is a power-of-two division of the capture,
  // this remains an exact whole number of loop cycles.
  if (tail.length > 0) {
    const tailLast = tail[tail.length - 1];
    tailLast.cycles = Math.max(tailLast.cycles, Math.ceil(SAMPLE_MIX_HANDOFF_BEATS / tailLast.captureBeats));
  }

  // Head cycles: fill the remainder of the target with whole base-capture
  // cycles. At least one, so a hold is always a real hold.
  const baseCycleOutputSeconds = (captureBeats * sourceSecondsPerBeat) / startRate;
  const tailOutputSecondsEstimate = tail.reduce(
    (sum, s) => sum + (s.captureBeats * s.cycles * sourceSecondsPerBeat) / startRate,
    0
  );
  const headCycles = Math.max(1, Math.round((targetHoldSeconds - tailOutputSecondsEstimate) / baseCycleOutputSeconds));

  const staged: HalvingStage[] = [{ captureBeats, cycles: headCycles }, ...tail];

  // --- Phrase-align the total (PRINCIPLE 5 / the exit-on-the-1 criterion) ---
  // Every stage length is a power-of-two division of the base capture, so the
  // running total is always a multiple of the SHORTEST stage — which makes
  // the padding below an exact whole number of cycles, never a fraction.
  const last = staged[staged.length - 1];
  const handoffBeats = SAMPLE_MIX_HANDOFF_BEATS;
  last.cycles = Math.max(last.cycles, Math.ceil(handoffBeats / last.captureBeats));
  let totalBeats = staged.reduce((sum, s) => sum + s.captureBeats * s.cycles, 0);
  while (totalBeats % PHRASE_BEATS !== 0) {
    last.cycles += 1;
    totalBeats += last.captureBeats;
  }

  // --- Rates: rise across the stages, resolve to 1.0 on the last one ---
  const stages: HeldLoopStage[] = [];
  let cursor = 0;
  for (let i = 0; i < staged.length; i++) {
    const stage = staged[i];
    const rate = rateForStage(i, staged.length, startRate, peakRate, resolveRate);
    const durationSeconds = (stage.captureBeats * stage.cycles * sourceSecondsPerBeat) / rate;
    stages.push({
      captureBeats: stage.captureBeats,
      cycles: stage.cycles,
      rate,
      durationSeconds,
      startAtSeconds: cursor,
      loopEnd: loopStart + stage.captureBeats * sourceSecondsPerBeat,
    });
    cursor += durationSeconds;
  }

  const handoffDurationSeconds = (handoffBeats * sourceSecondsPerBeat) / resolveRate;
  const handoffStartAtSeconds = cursor - handoffDurationSeconds;

  return {
    loopStart,
    loopEnd,
    captureBeats,
    stages,
    totalDurationSeconds: cursor,
    totalBeats,
    handoffBeats,
    handoffStartAtSeconds,
    handoffDurationSeconds,
    exitRate: resolveRate,
    exitBpm: grid.bpm * resolveRate,
    isolation,
    eq: isolationEq(isolation),
  };
}

/**
 * Rate for stage `index` of `count`: hold the mix's current rate through the
 * body, rise toward `peakRate` across the halving tail, and land on exactly
 * 1.0 for the FINAL stage so the hold hands the mix over in the track's own
 * key. A single-stage hold (no halving) is all body, so it resolves
 * immediately — there is nowhere to ride.
 */
export function rateForStage(
  index: number,
  count: number,
  startRate: number,
  peakRate: number,
  resolveRate: number = 1
): number {
  if (count <= 1) return resolveRate;
  if (index === count - 1) return resolveRate; // resolve to the original key (or to the sweep target)
  if (index === 0) return startRate; // start matched to what the room is already hearing

  const steps = count - 1; // stages between the first and the last, inclusive of this one
  if (resolveRate !== 1) {
    // TEMPO SWEEP: ride monotonically from where the room is to the target,
    // in even steps on loop boundaries. Deliberately NOT a rise-then-fall —
    // the point is to arrive somewhere, and an excursion toward peakRate on
    // the way would make the sweep audibly wander.
    return startRate + (resolveRate - startRate) * (index / steps);
  }
  // TENSION RISE: climb from startRate toward peakRate, then the final
  // stage above drops back to the original key.
  const climbSteps = count - 2;
  if (climbSteps <= 0) return startRate;
  return startRate + (peakRate - startRate) * Math.min(1, index / climbSteps);
}

// --- The real audio shell (unverifiable here — no AudioContext) ------------

export interface HeldLoopHandle {
  /** Controls the audible overlay itself (not the retired deck underneath it). */
  setGain: (value: number, rampSeconds?: number) => void;
  /** Ramps the overlay's own isolation EQ. */
  setEq: (eq: Partial<IsolationEq>, rampSeconds?: number) => void;
  /** Audible seam mask on the overlay path. */
  hpfSweep: (targetHz: number, durationSeconds: number) => void;
  /** Schedules the sample fader, bass handover, and full seam FX on the AudioContext clock. */
  scheduleHandoff: (durationSeconds: number, startProgress?: number, fx?: HeldLoopHandoffFx) => void;
  /** Stops the hold immediately and tears the nodes down. Idempotent. */
  stop: () => void;
}

export interface HeldLoopHandoffFx {
  hpfTargetHz: number;
  effectiveBpm: number;
  echoBeats: 0.75 | 1;
  echoFeedback: number;
  echoWet: number;
  reverbWet: number;
}

/**
 * Schedules the whole hold up front against `deck`'s decoded buffer: ONE
 * AudioBufferSourceNode per stage, each `start(when, offset)`/`stop(when)`-ed
 * at an exact AudioContext time and looping its own sub-slice at its own
 * constant rate.
 *
 * Deliberately not one mutating node: changing `loopEnd`/`playbackRate` on a
 * live source from a setTimeout puts the halving at the mercy of timer
 * jitter, and a change that lands even slightly late plays a whole extra
 * cycle of the OLD length — which is precisely how the exit stops landing on
 * the "1". Pre-scheduled nodes are sample-accurate, the same reason
 * scratch.ts schedules its segments up front.
 *
 * All stages share one controllable chain (source -> 3-band EQ -> HPF ->
 * gain -> master) so the routine can crossfade and sweep the AUDIO THAT IS
 * ACTUALLY LOOPING rather than moving controls on the silent retired deck.
 *
 * Returns null when nothing is decoded or the slice collapsed — never
 * throws, same defensive posture as fireLoopOverlay.
 */
export interface LoopHoldStemSource {
  /** Pre-mixed stem buffer (e.g., drums + bass for "beat", or vocal-free instrumental stems for "melody"). */
  buffer: AudioBuffer;
  /** Source-track timestamp (seconds) corresponding to sample 0 of `buffer`. Default 0. */
  bufferOffset?: number;
}

export function fireIsolatedLoopHold(
  deck: Deck,
  core: AudioCore,
  plan: HeldLoopPlan,
  onExit?: () => void,
  startDelaySeconds: number = 0,
  stemSource?: LoopHoldStemSource | null
): HeldLoopHandle | null {
  const ctx = core.ensureContext();
  const rawStemOffset = stemSource?.bufferOffset ?? 0;
  const canUseStemBuffer =
    !!stemSource?.buffer &&
    plan.loopStart >= rawStemOffset &&
    stemSource.buffer.duration - (plan.loopStart - rawStemOffset) > 0.05;
  const buffer = canUseStemBuffer ? stemSource!.buffer : deck.audioBuffer;
  const bufferOffset = canUseStemBuffer ? rawStemOffset : 0;
  if (!buffer) return null;

  const clampedStart = Math.max(0, Math.min(plan.loopStart - bufferOffset, buffer.duration));
  if (buffer.duration - clampedStart <= 0) return null;

  // --- The loop's OWN 3-band chain (mirrors deck.ts's ensureContext) ---
  // Keep all 3 bands flat at 0 dB during the solo loop hold so the captured
  // beat plays at the exact same EQ and volume as the song, and only apply
  // the 250 Hz low-band crossover when the incoming song enters in scheduleHandoff.
  const lowFilter = ctx.createBiquadFilter();
  lowFilter.type = "lowshelf";
  lowFilter.frequency.value = EQ_LOW_FREQ_HZ;
  lowFilter.gain.value = 0;

  const midFilter = ctx.createBiquadFilter();
  midFilter.type = "peaking";
  midFilter.frequency.value = EQ_MID_FREQ_HZ;
  midFilter.Q.value = EQ_MID_Q;
  midFilter.gain.value = 0;

  const highFilter = ctx.createBiquadFilter();
  highFilter.type = "highshelf";
  highFilter.frequency.value = EQ_HIGH_FREQ_HZ;
  highFilter.gain.value = 0;

  const hpfFilter = ctx.createBiquadFilter();
  hpfFilter.type = "highpass";
  hpfFilter.frequency.value = 20;
  hpfFilter.Q.value = 0.7071;

  const gainNode = ctx.createGain();
  gainNode.gain.value = 1;

  const delayNode = ctx.createDelay(2);
  const feedbackGain = ctx.createGain();
  feedbackGain.gain.value = 0;
  const echoWetGain = ctx.createGain();
  echoWetGain.gain.value = 0;

  const convolverNode = ctx.createConvolver();
  convolverNode.buffer = getOrBuildReverbImpulseResponse(ctx);
  const reverbWetGain = ctx.createGain();
  reverbWetGain.gain.value = 0;

  // Classic DJM Flanger / Phaser comb-filter path for tweaking the solo loop
  // on its second repetition before the incoming track enters.
  const flangerDelayNode = ctx.createDelay(0.05);
  flangerDelayNode.delayTime.value = 0.002;
  const flangerFeedbackGain = ctx.createGain();
  flangerFeedbackGain.gain.value = 0;
  const flangerWetGain = ctx.createGain();
  flangerWetGain.gain.value = 0;

  lowFilter.connect(midFilter);
  midFilter.connect(highFilter);
  highFilter.connect(hpfFilter);
  hpfFilter.connect(gainNode);
  gainNode.connect(core.master);
  hpfFilter.connect(delayNode);
  delayNode.connect(feedbackGain);
  feedbackGain.connect(delayNode);
  delayNode.connect(echoWetGain);
  echoWetGain.connect(core.master);
  hpfFilter.connect(convolverNode);
  convolverNode.connect(reverbWetGain);
  reverbWetGain.connect(core.master);
  hpfFilter.connect(flangerDelayNode);
  flangerDelayNode.connect(flangerFeedbackGain);
  flangerFeedbackGain.connect(flangerDelayNode);
  flangerDelayNode.connect(flangerWetGain);
  flangerWetGain.connect(gainNode);

  const safeStartDelaySeconds = Number.isFinite(startDelaySeconds) ? Math.max(0, startDelaySeconds) : 0;
  const startTime = ctx.currentTime + safeStartDelaySeconds;
  const sources: AudioBufferSourceNode[] = [];
  for (const stage of plan.stages) {
    const stageEnd = Math.min(stage.loopEnd - bufferOffset, buffer.duration);
    if (stageEnd - clampedStart <= 0) continue;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = clampedStart;
    source.loopEnd = stageEnd;
    source.playbackRate.value = stage.rate;
    source.connect(lowFilter);
    const when = startTime + stage.startAtSeconds;
    source.start(when, clampedStart);
    source.stop(when + stage.durationSeconds);
    sources.push(source);
  }
  if (sources.length === 0) {
    // Choir round #3, finding 5: the chain is already wired to core.master by
    // this point, and returning null hands the caller no handle to tear it
    // down — so an unschedulable plan used to leak the whole filter chain
    // into the graph permanently. Silent (nothing feeds it), but a leak.
    try {
      lowFilter.disconnect();
      midFilter.disconnect();
      highFilter.disconnect();
      hpfFilter.disconnect();
      gainNode.disconnect();
      delayNode.disconnect();
      feedbackGain.disconnect();
      echoWetGain.disconnect();
      convolverNode.disconnect();
      reverbWetGain.disconnect();
      flangerDelayNode.disconnect();
      flangerFeedbackGain.disconnect();
      flangerWetGain.disconnect();
    } catch {
      // best-effort teardown
    }
    return null;
  }

  // Schedule solo-loop texture (flanger jet sweep + dotted-eighth dub delay throw)
  // across the second half of the solo hold before the incoming track enters at
  // handoffStartAtSeconds, keeping gain at 1.0 (full volume) and EQ flat (0 dB).
  if (plan.handoffStartAtSeconds >= 3) {
    const tweakStart = startTime + plan.handoffStartAtSeconds * 0.42;
    const tweakEnd = startTime + Math.max(plan.handoffStartAtSeconds * 0.45, plan.handoffStartAtSeconds - 0.15);
    const tweakMid = (tweakStart + tweakEnd) / 2;
    if (tweakEnd > tweakStart + 0.5) {
      // 1. Flanger / Phaser comb-filter jet sweep (1.5ms -> 5.8ms -> 1.5ms)
      flangerWetGain.gain.setValueAtTime(0, tweakStart);
      flangerWetGain.gain.linearRampToValueAtTime(0.28, tweakStart + 0.25);
      flangerWetGain.gain.setValueAtTime(0.28, tweakEnd - 0.25);
      flangerWetGain.gain.linearRampToValueAtTime(0, tweakEnd);
      flangerFeedbackGain.gain.setValueAtTime(0.42, tweakStart);
      flangerFeedbackGain.gain.setValueAtTime(0, tweakEnd);
      flangerDelayNode.delayTime.setValueAtTime(0.0015, tweakStart);
      flangerDelayNode.delayTime.linearRampToValueAtTime(0.0058, tweakMid);
      flangerDelayNode.delayTime.linearRampToValueAtTime(0.0015, tweakEnd);

      // 2. Dotted-eighth (3/4-beat) Dub Delay Throw on the final 4 beats of Cycle 2
      // so the outgoing horn/melody hook echoes into the handoff seam like a DJM-A9 Dub Echo.
      const beatSec = 60 / Math.max(60, plan.exitBpm);
      const dubStart = Math.max(tweakMid, tweakEnd - 4 * beatSec);
      const dottedEighthSec = Math.min(1.8, Math.max(0.12, beatSec * 0.75));
      delayNode.delayTime.setValueAtTime(dottedEighthSec, dubStart);
      feedbackGain.gain.setValueAtTime(0, tweakStart);
      feedbackGain.gain.setValueAtTime(0.46, dubStart);
      feedbackGain.gain.linearRampToValueAtTime(0, tweakEnd + beatSec);
      echoWetGain.gain.setValueAtTime(0, tweakStart);
      echoWetGain.gain.setValueAtTime(0, dubStart);
      echoWetGain.gain.linearRampToValueAtTime(0.28, tweakEnd - 0.1);
      echoWetGain.gain.linearRampToValueAtTime(0, tweakEnd + beatSec);
    }
  }

  let stopped = false;
  const teardown = () => {
    if (stopped) return;
    stopped = true;
    for (const source of sources) {
      // Same guard as fireLoopOverlay/fireRoll: a node that already ended
      // throws InvalidStateError on stop(), and an uncaught throw here would
      // skip the rest of the teardown AND the caller's own cleanup.
      //
      // stop() and disconnect() are in SEPARATE try blocks (choir round #3,
      // finding 4): sharing one meant a throwing stop() skipped disconnect()
      // for exactly the nodes most likely to throw — the already-ended ones,
      // which on the normal timer exit is ALL of them — leaving them wired to
      // the filter chain and holding their buffer references.
      try {
        source.stop();
      } catch {
        // already stopped/ended — disconnect below still needs to run
      }
      try {
        source.disconnect();
      } catch {
        // already disconnected — nothing further to do
      }
    }
    try {
      lowFilter.disconnect();
      midFilter.disconnect();
      highFilter.disconnect();
      hpfFilter.disconnect();
      gainNode.disconnect();
      delayNode.disconnect();
      feedbackGain.disconnect();
      echoWetGain.disconnect();
      convolverNode.disconnect();
      reverbWetGain.disconnect();
      flangerDelayNode.disconnect();
      flangerFeedbackGain.disconnect();
      flangerWetGain.disconnect();
    } catch {
      // best-effort teardown
    }
  };

  const exitTimer = setTimeout(() => {
    teardown();
    onExit?.();
  }, (safeStartDelaySeconds + plan.totalDurationSeconds) * 1000);

  const rampParam = (param: AudioParam, target: number, rampSeconds: number = 0) => {
    if (stopped || !Number.isFinite(target)) return;
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    if (rampSeconds > 0) param.linearRampToValueAtTime(target, now + rampSeconds);
    else param.setValueAtTime(target, now);
  };

  const scheduleEnvelope = (param: AudioParam, values: readonly number[], durationSeconds: number) => {
    if (stopped || values.length === 0) return;
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    if (values.length === 1 || durationSeconds <= 0) {
      param.setValueAtTime(values[values.length - 1], now);
      return;
    }
    const stepSeconds = durationSeconds / (values.length - 1);
    param.setValueAtTime(values[0], now);
    for (let index = 1; index < values.length; index += 1) {
      param.linearRampToValueAtTime(values[index], now + stepSeconds * index);
    }
  };

  return {
    setGain: (value, rampSeconds = 0) => rampParam(gainNode.gain, Math.min(1, Math.max(0, value)), rampSeconds),
    setEq: (eq, rampSeconds = 0) => {
      if (eq.low !== undefined) rampParam(lowFilter.gain, Math.min(12, Math.max(EQ_KILL_DB, eq.low)), rampSeconds);
      if (eq.mid !== undefined) rampParam(midFilter.gain, Math.min(12, Math.max(EQ_KILL_DB, eq.mid)), rampSeconds);
      if (eq.high !== undefined) rampParam(highFilter.gain, Math.min(12, Math.max(EQ_KILL_DB, eq.high)), rampSeconds);
    },
    hpfSweep: (targetHz, durationSeconds) => {
      rampParam(hpfFilter.frequency, Math.min(12000, Math.max(20, targetHz)), Math.max(0, durationSeconds));
    },
    scheduleHandoff: (durationSeconds, startProgress = 0, fx) => {
      const start = Math.min(1, Math.max(0, startProgress));
      const safeDuration = Math.max(0, durationSeconds);
      const envelope = sampleMixEnvelope(canUseStemBuffer ? "beat" : plan.isolation, start);
      scheduleEnvelope(gainNode.gain, envelope.sampleGain, safeDuration);
      scheduleEnvelope(lowFilter.gain, envelope.sampleLowDb, safeDuration);

      // True 250 Hz bass crossover: hand the sub/low band (< 250 Hz) to the
      // incoming track while keeping the outgoing loop's mid and high bands
      // (> 250 Hz) 100% open and crisp (highFilter at 0 dB) as it crossfades.
      const crossoverHz = Math.min(EQ_LOW_FREQ_HZ, Math.max(20, fx?.hpfTargetHz ?? EQ_LOW_FREQ_HZ));
      const progressValues = envelope.sampleGain.map((_, index) =>
        start + (1 - start) * (index / Math.max(1, envelope.sampleGain.length - 1))
      );
      const fxFrames = progressValues.map(sampleMixFxFrame);
      const hpfValues = fxFrames.map(({ seamProgress }) => {
        return 20 + (crossoverHz - 20) * seamProgress;
      });
      scheduleEnvelope(hpfFilter.frequency, hpfValues, safeDuration);

      const echoWet = clampWet(fx?.echoWet ?? 0.35);
      const reverbWet = clampWet(fx?.reverbWet ?? 0.35, REVERB_WET_CAP);
      const feedback = Math.min(0.85, Math.max(0, fx?.echoFeedback ?? 0.5));
      const effectiveBpm = fx?.effectiveBpm ?? plan.exitBpm;
      const echoBeats = fx?.echoBeats ?? 1;
      delayNode.delayTime.setValueAtTime(Math.min(2, delayTimeForBeats(effectiveBpm, echoBeats)), ctx.currentTime);
      scheduleEnvelope(echoWetGain.gain, fxFrames.map(({ wetShape }) => echoWet * wetShape), safeDuration);
      scheduleEnvelope(reverbWetGain.gain, fxFrames.map(({ wetShape }) => reverbWet * wetShape), safeDuration);
      scheduleEnvelope(
        feedbackGain.gain,
        fxFrames.map(({ seamProgress, wetShape }) => (seamProgress > 0 && wetShape > 0 ? feedback : 0)),
        safeDuration
      );
    },
    stop: () => {
      clearTimeout(exitTimer);
      teardown();
    },
  };
}
