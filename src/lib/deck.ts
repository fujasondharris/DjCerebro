// One playable deck: decode -> native Web Audio AudioBufferSourceNode (hardware
// audio-thread transport with per-source micro-fade GainNode) -> a 3-band EQ (lowshelf/peaking/highshelf,
// M4 Part A) -> permanent HPF/LPF sweep filters (audio engine v2, Part 1,
// neutral at 20Hz/20kHz) -> this deck's own GainNode -> the shared AudioCore's
// master GainNode -> destination. Two parallel FX sends tap that same
// post-EQ/post-sweep-filter, pre-duck-gain point (audio engine v2, Part 1 —
// see src/lib/fx-sends.ts for the pure planning math): a feedback DelayNode
// (echoTail, M4 Part B's original "echo_out" send, upgraded here with a real
// multi-repeat ring) and a ConvolverNode loaded with a synthesized impulse
// response (reverbWash) — both feed straight to master, independent of the
// dry gain node, so cutting the dry signal never cuts an in-flight tail. Two
// instances (Deck A, Deck B) share a single AudioCore so the crossfader can
// mix them; each deck's own gain node is what the crossfader drives
// (equal-power curve applied by the caller via setGain), completely
// independent of that deck's playback volume logic (there isn't any yet —
// this is deliberately kept UI-free so a future Claude-driven "brain"
// milestone can drive it directly).
import type { AudioCore } from "./audio-core";
import { duckStateInitial, duckStateOnDuck, duckStateOnUnduck, composeGain, type DuckState } from "./gain-math.ts";
import {
  clampWet,
  delayTimeForBeats,
  sweepPlan,
  getOrBuildReverbImpulseResponse,
  NEUTRAL_HPF_HZ,
  NEUTRAL_LPF_HZ,
  REVERB_WET_CAP,
  DEFAULT_ECHO_RAMP_OUT_SECONDS,
} from "./fx-sends.ts";

export interface ProgressUpdate {
  percentagePlayed: number;
  timePlayed: number;
  duration: number;
}

type ProgressListener = (update: ProgressUpdate) => void;
type EndedListener = () => void;

// --- EQ (M4 Part A) ---
const EQ_LOW_FREQ_HZ = 250; // lowshelf corner
const EQ_MID_FREQ_HZ = 1000; // peaking center
const EQ_MID_Q = 0.8;
const EQ_HIGH_FREQ_HZ = 4000; // highshelf corner
const EQ_MAX_DB = 6;
const EQ_KILL_DB = -40; // "effective kill" — not special-cased, the filter naturally silences near-completely at this depth
// AudioParam.setTargetAtTime approaches its target exponentially; the
// audible/visible settle point is conventionally ~3 time constants, so
// 0.012s here means ~36ms to feel "there" — fast enough to not feel
// sluggish on a slider drag, slow enough to avoid zipper/stepping noise on a
// discrete dB jump (e.g. a KILL tap).
const EQ_TIME_CONSTANT_SECONDS = 0.012;

// --- Echo send (M4 Part B, "echo_out" transition) ---
const ECHO_MAX_DELAY_SECONDS = 2; // DelayNode's maxDelayTime cap — covers real-world BPM well below anything this app will see
const DUCK_TIME_CONSTANT_SECONDS = 0.015; // scratch overlay ducking (M4 Part C) — same order of magnitude as the EQ constant, smooth but quick

export type EqBand = "low" | "mid" | "high";
export interface EqValues {
  low: number;
  mid: number;
  high: number;
}

export class Deck {
  private core: AudioCore;
  private gainNode: GainNode | null = null;
  private overlayDucker: GainNode | null = null;
  private overlayDuckUntil = 0;
  private overlayDuckFactor = 1;
  private gainValue = 1;
  private buffer: AudioBuffer | null = null;
  private reversedBufferCache: AudioBuffer | null = null;
  private playingState = false;
  private tempoValue = 1;
  private positionSecondsValue = 0;
  private progressListeners = new Set<ProgressListener>();
  private endedListeners = new Set<EndedListener>();
  private scheduledSource: { source: AudioBufferSourceNode; sourceGain?: GainNode; when: number; offset: number; rate: number; timer: ReturnType<typeof setInterval> } | null = null;
  private liveSource: { source: AudioBufferSourceNode; sourceGain: GainNode; when: number; offset: number; rate: number; timer: ReturnType<typeof setInterval> } | null = null;

  // EQ nodes + cached values (M4 Part A) — cached so setEq()/killX() can be
  // called (and reflected by getEq()) before ensureContext() has ever run,
  // same pattern as gainValue/gainNode above.
  private lowFilter: BiquadFilterNode | null = null;
  private midFilter: BiquadFilterNode | null = null;
  private highFilter: BiquadFilterNode | null = null;
  private eqValues: EqValues = { low: 0, mid: 0, high: 0 };

  // Echo send nodes (M4 Part B) — lazily created alongside the EQ nodes.
  private delayNode: DelayNode | null = null;
  private feedbackGain: GainNode | null = null;
  private wetGain: GainNode | null = null;
  // A single tracked pair of timeout handles for echoTail()'s self-scheduled
  // ring-then-fade-out (audio engine v2, Part 1) — re-arming echoTail()
  // clears any previous schedule so two overlapping calls never race each
  // other's ramp-down.
  private echoRingTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private echoRampOutTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  // HPF/LPF sweep filters + reverb send (audio engine v2, Part 1) — lazily
  // created alongside the EQ/echo nodes. HPF/LPF sit PERMANENTLY in the dry
  // chain at neutral positions (20Hz/20kHz — see ensureContext()); a sweep
  // only ever ramps their frequency param, never inserts/removes a node
  // (avoids clicks). The reverb send taps the same post-EQ/post-sweep point
  // as the echo send, in parallel, straight to master — cutting the dry
  // signal (gainNode) never cuts an in-flight reverb/echo tail.
  private hpfFilter: BiquadFilterNode | null = null;
  private lpfFilter: BiquadFilterNode | null = null;
  private convolverNode: ConvolverNode | null = null;
  private reverbWetGain: GainNode | null = null;

  // Gain ownership (review-panel fix, 2026-07-26): the node always carries
  // logicalGain * duckState.factor — see src/lib/gain-math.ts's file header
  // for why this replaced the old snapshot-and-restore preDuckGain. setGain()
  // owns logicalGain (crossfader/transition engine); duck()/unduck() own
  // duckState via a refcount (scratch overlay/vocal auto-duck), so several
  // overlapping duck sources on the same deck compose instead of stomping
  // each other, and a crossfader/transition write during an active duck
  // still respects it instead of overwriting the node directly.
  private duckState: DuckState = duckStateInitial();

  constructor(core: AudioCore) {
    this.core = core;
  }

  /**
   * Ensures the shared AudioContext exists (see AudioCore.ensureContext) and
   * that this deck's audio graph nodes exist and are wired:
   * shifter -> lowFilter -> midFilter -> highFilter -> gainNode -> master,
   * with highFilter ALSO fanning out to delayNode (the echo send) ->
   * feedbackGain -> delayNode (feedback loop) and delayNode -> wetGain ->
   * master. Safe to call synchronously from a tap handler, same as before
   * the refactor — and safe to call repeatedly (idempotent once created).
   */
  ensureContext(): AudioContext {
    const ctx = this.core.ensureContext();
    if (!this.gainNode) {
      this.gainNode = ctx.createGain();
      this.gainNode.gain.value = this.gainValue;
      this.gainNode.connect(this.core.master);
      this.overlayDucker = ctx.createGain();
      this.overlayDucker.connect(this.gainNode);
    }
    if (!this.lowFilter) {
      this.lowFilter = ctx.createBiquadFilter();
      this.lowFilter.type = "lowshelf";
      this.lowFilter.frequency.value = EQ_LOW_FREQ_HZ;
      this.lowFilter.gain.value = this.eqValues.low;

      this.midFilter = ctx.createBiquadFilter();
      this.midFilter.type = "peaking";
      this.midFilter.frequency.value = EQ_MID_FREQ_HZ;
      this.midFilter.Q.value = EQ_MID_Q;
      this.midFilter.gain.value = this.eqValues.mid;

      this.highFilter = ctx.createBiquadFilter();
      this.highFilter.type = "highshelf";
      this.highFilter.frequency.value = EQ_HIGH_FREQ_HZ;
      this.highFilter.gain.value = this.eqValues.high;

      // HPF/LPF sweep filters (audio engine v2, Part 1) — permanently in the
      // dry chain at neutral positions (20Hz/20kHz, audibly transparent). Q
      // explicitly set to ~0.707 (Butterworth, maximally flat/no resonant
      // peak) — BiquadFilterNode's own DEFAULT Q is 1, not 0.707 (a common
      // mix-up; verified against the Web Audio spec before writing this),
      // which would add a small audible bump near the cutoff even at a
      // "neutral" 20Hz/20kHz position. Explicit Q keeps a sweep coloring
      // tone smoothly rather than ringing at the cutoff.
      const SWEEP_FILTER_Q = 0.7071; // 1/sqrt(2) — Butterworth
      this.hpfFilter = ctx.createBiquadFilter();
      this.hpfFilter.type = "highpass";
      this.hpfFilter.frequency.value = NEUTRAL_HPF_HZ;
      this.hpfFilter.Q.value = SWEEP_FILTER_Q;

      this.lpfFilter = ctx.createBiquadFilter();
      this.lpfFilter.type = "lowpass";
      this.lpfFilter.frequency.value = NEUTRAL_LPF_HZ;
      this.lpfFilter.Q.value = SWEEP_FILTER_Q;

      this.lowFilter.connect(this.midFilter);
      this.midFilter.connect(this.highFilter);
      this.highFilter.connect(this.hpfFilter);
      this.hpfFilter.connect(this.lpfFilter);
      this.lpfFilter.connect(this.overlayDucker!);

      this.delayNode = ctx.createDelay(ECHO_MAX_DELAY_SECONDS);
      this.feedbackGain = ctx.createGain();
      this.feedbackGain.gain.value = 0;
      this.wetGain = ctx.createGain();
      this.wetGain.gain.value = 0;

      // Send tap: post-EQ AND post-sweep-filter (so a filter sweep colors
      // what feeds the sends too, matching a real mixer channel strip's
      // filter-before-fx-send order), pre-duck-gain (gainNode) — a dry cut
      // (gainNode -> 0, or a duck) never silences an already-in-flight
      // echo/reverb tail, since neither send routes through gainNode at all.
      this.lpfFilter.connect(this.delayNode); // parallel echo send
      this.delayNode.connect(this.feedbackGain);
      this.feedbackGain.connect(this.delayNode); // feedback loop
      this.delayNode.connect(this.wetGain);
      this.wetGain.connect(this.core.master);

      this.convolverNode = ctx.createConvolver();
      this.convolverNode.buffer = getOrBuildReverbImpulseResponse(ctx);
      this.reverbWetGain = ctx.createGain();
      this.reverbWetGain.gain.value = 0;
      this.lpfFilter.connect(this.convolverNode); // parallel reverb send, same tap point as the echo send
      this.convolverNode.connect(this.reverbWetGain);
      this.reverbWetGain.connect(this.core.master);
    }
    return ctx;
  }

  /** Decode raw file bytes into an AudioBuffer and reset transport state. */
  async decode(arrayBuffer: ArrayBuffer, signal?: AbortSignal): Promise<AudioBuffer> {
    const ctx = this.ensureContext();
    this.pause();
    const decoded = await ctx.decodeAudioData(arrayBuffer);
    signal?.throwIfAborted();
    this.pause(); // stop any source started while decodeAudioData was in flight
    this.buffer = decoded;
    this.reversedBufferCache = null; // invalidate the scratch engine's cached reverse copy — see getReversedBuffer()
    this.positionSecondsValue = 0;
    this.playingState = false;

    return decoded;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get playing(): boolean {
    return this.playingState;
  }

  get tempo(): number {
    return this.tempoValue;
  }

  get scheduledPlaybackTime(): number | null { return this.scheduledSource?.when ?? null; }

  /** Current playback position, in SOURCE-track seconds. Updated from live audio clock and seeks. */
  get positionSeconds(): number {
    if (this.scheduledSource) {
      const s = this.scheduledSource;
      return Math.min(this.duration, s.offset + Math.max(0, this.core.ensureContext().currentTime - s.when) * s.rate);
    }
    if (this.liveSource) {
      const s = this.liveSource;
      return Math.min(this.duration, s.offset + Math.max(0, this.core.ensureContext().currentTime - s.when) * s.rate);
    }
    return this.positionSecondsValue;
  }

  /**
   * A prepared stem performance returns to the full mix at an absolute audio time.
   * This transport keeps the stems' playback-rate/pitch semantics through that
   * handoff, with no timer or SoundTouch block-start gap. A later tempo/seek/pause
   * operation returns to the ordinary transport. Callers must
   * apply the same narrow tempo eligibility gate as the stems.
   */
  scheduleBufferPlayback(when: number, offset: number, rate: number): void {
    const ctx = this.ensureContext();
    if (!this.buffer || !Number.isFinite(when) || when < ctx.currentTime || !Number.isFinite(offset) || offset < 0 || offset >= this.duration || !Number.isFinite(rate) || rate <= 0) throw new Error("Full-mix handoff is not prepared");
    this.pause();
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = rate;
    source.connect(this.lowFilter!);
    const timer = setInterval(() => {
      const timePlayed = this.positionSeconds;
      this.positionSecondsValue = timePlayed;
      this.progressListeners.forEach(listener => listener({ timePlayed, duration: this.duration, percentagePlayed: 100 * timePlayed / this.duration }));
    }, 200);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.scheduledSource = { source, when, offset, rate, timer };
    this.positionSecondsValue = offset;
    this.tempoValue = rate;
    this.playingState = true;
    source.onended = () => {
      if (this.scheduledSource?.source !== source) return;
      clearInterval(timer);
      source.disconnect();
      this.scheduledSource = null;
      this.playingState = false;
      this.positionSecondsValue = 0;
      this.endedListeners.forEach(listener => listener());
    };
    source.start(when, offset);
  }

  onProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  onEnded(listener: EndedListener): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
  }

  /** Resume/start playback of whatever buffer is currently decoded on the native Web Audio thread. */
  play(): void {
    if (!this.buffer || !this.gainNode) return;
    if (this.playingState) return;
    const ctx = this.ensureContext();
    if (!this.lowFilter) return;
    const offset = Math.min(Math.max(0, this.positionSecondsValue), Math.max(0, this.duration - 0.001));
    const rate = Number.isFinite(this.tempoValue) && this.tempoValue > 0 ? this.tempoValue : 1;
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = rate;
    const sourceGain = ctx.createGain();
    const when = ctx.currentTime;
    try {
      sourceGain.gain.setValueAtTime(0.0001, when);
      sourceGain.gain.linearRampToValueAtTime(1, when + 0.006);
    } catch {
      sourceGain.gain.value = 1;
    }
    source.connect(sourceGain);
    sourceGain.connect(this.lowFilter);
    const timer = setInterval(() => {
      const timePlayed = this.positionSeconds;
      this.positionSecondsValue = timePlayed;
      const duration = this.duration;
      if (duration > 0) {
        this.progressListeners.forEach((listener) =>
          listener({
            percentagePlayed: (timePlayed / duration) * 100,
            timePlayed,
            duration,
          })
        );
      }
    }, 200);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.liveSource = { source, sourceGain, when, offset, rate, timer };
    this.playingState = true;
    source.onended = () => {
      if (this.liveSource?.source !== source) return;
      clearInterval(timer);
      try { source.disconnect(); } catch { /* ignore */ }
      try { sourceGain.disconnect(); } catch { /* ignore */ }
      this.liveSource = null;
      this.playingState = false;
      this.positionSecondsValue = 0;
      this.endedListeners.forEach((listener) => listener());
    };
    source.start(0, offset);
  }

  pause(): void {
    if (this.scheduledSource) {
      const s = this.scheduledSource;
      this.positionSecondsValue = this.positionSeconds;
      this.scheduledSource = null;
      clearInterval(s.timer);
      s.source.onended = null;
      try { s.source.stop(); } catch { /* already ended */ }
      try { s.source.disconnect(); } catch { /* ignore */ }
      this.playingState = false;
      return;
    }
    if (this.liveSource) {
      const s = this.liveSource;
      this.positionSecondsValue = this.positionSeconds;
      this.liveSource = null;
      clearInterval(s.timer);
      s.source.onended = null;
      const ctx = this.core.ensureContext();
      const now = ctx.currentTime;
      try {
        const g = s.sourceGain.gain;
        if (typeof g.cancelAndHoldAtTime === "function") g.cancelAndHoldAtTime(now);
        else { const cur = g.value; g.cancelScheduledValues(now); g.setValueAtTime(cur, now); }
        g.linearRampToValueAtTime(0, now + 0.008);
        s.source.stop(now + 0.010);
        const cleanupTimer = setTimeout(() => {
          try { s.source.disconnect(); } catch { /* ignore */ }
          try { s.sourceGain.disconnect(); } catch { /* ignore */ }
        }, 18);
        (cleanupTimer as unknown as { unref?: () => void }).unref?.();
      } catch {
        try { s.source.stop(); } catch { /* already ended */ }
        try { s.source.disconnect(); } catch { /* already disconnected */ }
        try { s.sourceGain.disconnect(); } catch { /* ignore */ }
      }
      this.playingState = false;
      return;
    }
    this.playingState = false;
  }

  setTempo(tempo: number): void {
    const safeTempo = Number.isFinite(tempo) && tempo > 0 ? tempo : 1;
    if (this.scheduledSource !== null) {
      const now = this.core.ensureContext().currentTime;
      if (now >= this.scheduledSource.when) {
        const currentPos = this.positionSeconds;
        this.scheduledSource.offset = currentPos;
        this.scheduledSource.when = now;
        this.scheduledSource.rate = safeTempo;
        this.positionSecondsValue = currentPos;
        try {
          this.scheduledSource.source.playbackRate.cancelScheduledValues(now);
          this.scheduledSource.source.playbackRate.setValueAtTime(safeTempo, now);
        } catch {
          this.scheduledSource.source.playbackRate.value = safeTempo;
        }
        this.tempoValue = safeTempo;
        return;
      }
      this.pause();
      this.tempoValue = safeTempo;
      this.play();
      return;
    }
    if (this.liveSource) {
      const now = this.core.ensureContext().currentTime;
      const currentPos = this.positionSeconds;
      this.liveSource.offset = currentPos;
      this.liveSource.when = now;
      this.liveSource.rate = safeTempo;
      this.positionSecondsValue = currentPos;
      try {
        this.liveSource.source.playbackRate.cancelScheduledValues(now);
        this.liveSource.source.playbackRate.setValueAtTime(safeTempo, now);
      } catch {
        this.liveSource.source.playbackRate.value = safeTempo;
      }
    }
    this.tempoValue = safeTempo;
  }

  /**
   * Seek to an absolute SOURCE-seconds position (clamped to the track's
   * duration), used by Beat Sync's phase-align step and the manual nudge
   * buttons (see page.tsx).
   */
  seekTo(sourceSeconds: number): void {
    if (!this.buffer || this.duration <= 0) return;
    const resume = this.playingState;
    if (resume) this.pause();
    const clamped = Math.min(Math.max(sourceSeconds, 0), this.duration);
    this.positionSecondsValue = clamped;
    this.progressListeners.forEach((listener) =>
      listener({
        percentagePlayed: (clamped / this.duration) * 100,
        timePlayed: clamped,
        duration: this.duration,
      })
    );
    if (resume) this.play();
  }

  /** Seek by a relative SOURCE-seconds delta (positive = forward). */
  seekBy(sourceSeconds: number): void {
    // When already playing on a live hardware-clocked AudioBufferSourceNode,
    // ignore sub-60ms corrective micro-nudges (e.g. legacy 1s ScriptProcessor
    // resnap or tiny tag-vs-grid BPM jitter) so we never splice the active
    // waveform during a transition.
    if (this.liveSource !== null && Math.abs(sourceSeconds) < 0.060) return;
    this.seekTo(this.positionSeconds + sourceSeconds);
  }

  /**
   * Crossfader/transition-engine-driven gain for this deck (0..1, equal-power
   * curve computed by the caller). Only ever touches logicalGain — the node
   * gets logicalGain * the current duck factor (see gain-math.ts), so this
   * composes correctly with any active duck() instead of overwriting it.
   * Uses a short 8ms smoothing target while playing (including when fading to
   * silence) so the ~30Hz transition tick and cut/loop_blend transitions never
   * create staircase zipper noise or step-to-zero clicks, while setting
   * immediately when paused before play().
   */
  setGain(value: number): void {
    this.gainValue = value;
    if (this.gainNode) {
      const ctx = this.core.ensureContext();
      const now = ctx.currentTime;
      const target = composeGain(this.gainValue, this.duckState);
      const param = this.gainNode.gain;
      if (typeof param.cancelAndHoldAtTime === "function") {
        param.cancelAndHoldAtTime(now);
      } else {
        const current = param.value;
        param.cancelScheduledValues(now);
        param.setValueAtTime(current, now);
      }
      if (!this.playingState) {
        param.setValueAtTime(target, now);
      } else {
        param.setTargetAtTime(target, now, 0.008);
      }
    }
  }

  get gain(): number { return this.gainValue; }

  /** Short scratch duck with its own gain stage and audio-clock release. */
  duckOverlay(db: number, duration: number): void {
    const ctx = this.ensureContext(), now = ctx.currentTime;
    const factor = Math.pow(10, Math.min(0, db) / 20);
    this.overlayDuckFactor = this.overlayDuckUntil > now ? Math.min(factor, this.overlayDuckFactor) : factor;
    this.overlayDuckUntil = Math.max(this.overlayDuckUntil, now + duration);
    const param = this.overlayDucker!.gain;
    if (typeof param.cancelAndHoldAtTime === "function") param.cancelAndHoldAtTime(now);
    else { const current = param.value; param.cancelScheduledValues(now); param.setValueAtTime(current, now); }
    param.linearRampToValueAtTime(this.overlayDuckFactor, now + 0.005);
    param.setValueAtTime(this.overlayDuckFactor, this.overlayDuckUntil);
    param.linearRampToValueAtTime(1, this.overlayDuckUntil + 0.01);
  }

  /**
   * Schedule a fader envelope on the AudioContext clock. This is used for
   * performance handoffs where a throttled JavaScript interval must not turn
   * a gradual blend into a late hard cut. A later setGain()/duck() call still
   * intentionally supersedes the schedule.
   */
  scheduleGainEnvelope(values: readonly number[], durationSeconds: number, startTime?: number): void {
    if (values.length === 0) return;
    const clamped = values.map((value) => Math.min(1, Math.max(0, value)));
    this.gainValue = clamped[clamped.length - 1];
    if (!this.gainNode) return;
    this.scheduleParamEnvelope(
      this.gainNode.gain,
      clamped.map((value) => composeGain(value, this.duckState)),
      durationSeconds, startTime
    );
  }

  // --- 3-band EQ (M4 Part A) ---

  /**
   * Set one or more EQ bands (dB, -40..+6). Only the given fields change —
   * omitted bands are left alone. Values are clamped (never thrown) and
   * ramped via setTargetAtTime to avoid zipper noise (see
   * EQ_TIME_CONSTANT_SECONDS above). Callable before ensureContext() has
   * ever run — the value is cached and applied as the filter's initial gain
   * once the nodes are created.
   */
  setEq(eq: { low?: number; mid?: number; high?: number }): void {
    if (eq.low !== undefined) this.applyEqBand("low", eq.low);
    if (eq.mid !== undefined) this.applyEqBand("mid", eq.mid);
    if (eq.high !== undefined) this.applyEqBand("high", eq.high);
  }

  /** Audio-clock EQ counterpart to scheduleGainEnvelope(). */
  scheduleEqEnvelope(band: EqBand, values: readonly number[], durationSeconds: number, startTime?: number): void {
    if (values.length === 0) return;
    const clamped = values.map((value) => Math.min(EQ_MAX_DB, Math.max(EQ_KILL_DB, value)));
    this.eqValues[band] = clamped[clamped.length - 1];
    const filter = band === "low" ? this.lowFilter : band === "mid" ? this.midFilter : this.highFilter;
    if (!filter) return;
    this.scheduleParamEnvelope(filter.gain, clamped, durationSeconds, startTime);
  }

  private scheduleParamEnvelope(param: AudioParam, values: readonly number[], durationSeconds: number, startTime?: number): void {
    const ctx = this.core.ensureContext();
    const now = Math.max(ctx.currentTime, startTime ?? ctx.currentTime);
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
  }

  private applyEqBand(band: EqBand, valueDb: number): void {
    const clamped = Math.min(EQ_MAX_DB, Math.max(EQ_KILL_DB, valueDb));
    this.eqValues[band] = clamped;
    const filter = band === "low" ? this.lowFilter : band === "mid" ? this.midFilter : this.highFilter;
    if (filter) {
      const ctx = this.core.ensureContext();
      const now = ctx.currentTime;
      const param = filter.gain;
      if (typeof param.cancelAndHoldAtTime === "function") {
        param.cancelAndHoldAtTime(now);
      } else {
        const current = param.value;
        param.cancelScheduledValues(now);
        param.setValueAtTime(current, now);
      }
      param.setTargetAtTime(clamped, now, EQ_TIME_CONSTANT_SECONDS);
    }
  }

  /**
   * Kill/unkill convenience for a band. Deliberately simple: turning a kill
   * OFF resets that band to flat (0dB), not whatever the slider was at
   * before the kill — this is a personal DJ tool, not a mixing console with
   * full per-band state recall.
   */
  killLow(on: boolean): void {
    this.setEq({ low: on ? EQ_KILL_DB : 0 });
  }
  killMid(on: boolean): void {
    this.setEq({ mid: on ? EQ_KILL_DB : 0 });
  }
  killHigh(on: boolean): void {
    this.setEq({ high: on ? EQ_KILL_DB : 0 });
  }

  /** Current EQ values (dB) so the UI can reflect state without duplicating it. */
  getEq(): EqValues {
    return { ...this.eqValues };
  }

  // --- Echo send (M4 Part B, "echo_out" transition) ---

  /** Arms the echo: sets the feedback delay's time + feedback gain. Wet level starts at 0 until rampEchoWet() raises it. */
  startEchoTail(delayTimeSec: number, feedback: number): void {
    const ctx = this.core.ensureContext();
    if (!this.delayNode || !this.feedbackGain) return;
    const now = ctx.currentTime;
    const clampedDelay = Math.min(Math.max(delayTimeSec, 0), ECHO_MAX_DELAY_SECONDS);
    const clampedFeedback = Math.min(0.85, Math.max(0, feedback));
    if (Math.abs(this.delayNode.delayTime.value - clampedDelay) > 0.005) {
      this.delayNode.delayTime.setTargetAtTime(clampedDelay, now, 0.020);
    } else {
      this.delayNode.delayTime.setValueAtTime(clampedDelay, now);
    }
    this.feedbackGain.gain.setTargetAtTime(clampedFeedback, now, 0.008);
  }

  /** Linearly ramps the echo's wet send level to `target` over `rampSeconds`. */
  rampEchoWet(target: number, rampSeconds: number): void {
    const ctx = this.core.ensureContext();
    if (!this.wetGain) return;
    const now = ctx.currentTime;
    const param = this.wetGain.gain;
    if (typeof param.cancelAndHoldAtTime === "function") param.cancelAndHoldAtTime(now);
    else { const cur = param.value; param.cancelScheduledValues(now); param.setValueAtTime(cur, now); }
    param.linearRampToValueAtTime(target, now + Math.max(0, rampSeconds));
  }

  /** Silences the echo send/feedback smoothly — call after letting the tail decay naturally for a bit, not the instant the source cuts. */
  stopEcho(): void {
    const ctx = this.core.ensureContext();
    if (!this.wetGain || !this.feedbackGain) return;
    const now = ctx.currentTime;
    const wetParam = this.wetGain.gain;
    if (typeof wetParam.cancelAndHoldAtTime === "function") wetParam.cancelAndHoldAtTime(now);
    else { const cur = wetParam.value; wetParam.cancelScheduledValues(now); wetParam.setValueAtTime(cur, now); }
    wetParam.setTargetAtTime(0, now, 0.010);
    const fbParam = this.feedbackGain.gain;
    if (typeof fbParam.cancelAndHoldAtTime === "function") fbParam.cancelAndHoldAtTime(now);
    else { const cur = fbParam.value; fbParam.cancelScheduledValues(now); fbParam.setValueAtTime(cur, now); }
    fbParam.setTargetAtTime(0, now, 0.010);
  }

  private clearEchoSchedule(): void {
    if (this.echoRingTimeoutHandle !== null) {
      clearTimeout(this.echoRingTimeoutHandle);
      this.echoRingTimeoutHandle = null;
    }
    if (this.echoRampOutTimeoutHandle !== null) {
      clearTimeout(this.echoRampOutTimeoutHandle);
      this.echoRampOutTimeoutHandle = null;
    }
  }

  // --- FX sends (audio engine v2, Part 1 — see src/lib/fx-sends.ts) ---

  /**
   * The clean public echo-tail API: arms the delay+feedback for `beats`
   * worth of `effectiveBpm` (tagged BPM × tempo — this deck doesn't own the
   * tag, so the caller, e.g. transition.ts/page.tsx, computes and passes it,
   * same convention startEchoTail's pre-existing delayTimeSec parameter
   * already used), ramps the wet send in, then SELF-SCHEDULES a ring for
   * `ringSeconds` (typically fx-sends.ts's planEchoTail()'s 2-4-repeat
   * `ringSeconds`) before ramping the wet send back to 0 and fully stopping
   * it — independent of whatever the caller does with the DRY signal (see
   * transition.ts's echo_out, which cuts dry on its own separate timer at
   * one bar, well before this tail finishes ringing). Deviation from the
   * dispatch's literal `echoTail(beats, feedback, wetLevel, ringSeconds)`
   * signature, reported: `effectiveBpm` is a required extra leading
   * parameter, since Deck has no notion of a track's BPM tag at all — every
   * other bpm-aware Deck method in this file (see the class's own file
   * header) already takes the caller-computed number rather than looking one
   * up itself.
   */
  echoTail(effectiveBpm: number, beats: 0.75 | 1, feedback: number, wetLevel: number, ringSeconds: number): void {
    if (!this.delayNode || !this.feedbackGain || !this.wetGain) return;
    const delayTimeSec = delayTimeForBeats(effectiveBpm, beats);
    const clampedWet = clampWet(wetLevel);
    this.clearEchoSchedule();
    this.startEchoTail(delayTimeSec, feedback);
    this.rampEchoWet(clampedWet, Math.min(delayTimeSec, DEFAULT_ECHO_RAMP_OUT_SECONDS));
    this.echoRingTimeoutHandle = setTimeout(() => {
      this.echoRingTimeoutHandle = null;
      this.rampEchoWet(0, DEFAULT_ECHO_RAMP_OUT_SECONDS);
      this.echoRampOutTimeoutHandle = setTimeout(() => {
        this.echoRampOutTimeoutHandle = null;
        this.stopEcho();
      }, DEFAULT_ECHO_RAMP_OUT_SECONDS * 1000);
    }, Math.max(0, ringSeconds) * 1000);
  }

  /** Ramps the reverb send's wet level to `wetLevel` (clamped to REVERB_WET_CAP) over `seconds`. A synthesized ~2.5s stereo IR — see fx-sends.ts's getOrBuildReverbImpulseResponse. */
  reverbWash(wetLevel: number, seconds: number): void {
    const ctx = this.core.ensureContext();
    if (!this.reverbWetGain) return;
    const now = ctx.currentTime;
    const clamped = clampWet(wetLevel, REVERB_WET_CAP);
    const param = this.reverbWetGain.gain;
    if (typeof param.cancelAndHoldAtTime === "function") param.cancelAndHoldAtTime(now);
    else { const cur = param.value; param.cancelScheduledValues(now); param.setValueAtTime(cur, now); }
    param.linearRampToValueAtTime(clamped, now + Math.max(0, seconds));
  }

  private sweepFilter(filter: BiquadFilterNode | null, targetHz: number, seconds: number): void {
    if (!filter) return;
    const ctx = this.core.ensureContext();
    const now = ctx.currentTime;
    const plan = sweepPlan(targetHz, seconds);
    const param = filter.frequency;
    if (typeof param.cancelAndHoldAtTime === "function") param.cancelAndHoldAtTime(now);
    else { const cur = param.value; param.cancelScheduledValues(now); param.setValueAtTime(cur, now); }
    if (plan.seconds <= 0) {
      param.setTargetAtTime(plan.targetHz, now, 0.010);
    } else {
      param.linearRampToValueAtTime(plan.targetHz, now + plan.seconds);
    }
  }

  /** Ramps the permanent HPF's cutoff up (clamped 20Hz-20kHz) over `seconds` — the classic build-up "filter sweep". */
  hpfSweep(targetHz: number, seconds: number): void {
    this.sweepFilter(this.hpfFilter, targetHz, seconds);
  }

  /** Ramps the permanent LPF's cutoff down (clamped 20Hz-20kHz) over `seconds`. */
  lpfSweep(targetHz: number, seconds: number): void {
    this.sweepFilter(this.lpfFilter, targetHz, seconds);
  }

  /** Ramps both sweep filters back to their neutral (audibly transparent) positions over `seconds`. */
  filterRelease(seconds: number): void {
    this.sweepFilter(this.hpfFilter, NEUTRAL_HPF_HZ, seconds);
    this.sweepFilter(this.lpfFilter, NEUTRAL_LPF_HZ, seconds);
  }

  /** Safety reset: releases both sweep filters, silences the reverb send, and stops any echo (immediately, cancelling any pending echoTail() ring/ramp-out schedule). Call when abandoning an in-progress fx sequence (e.g. a superseded maskFx) so nothing is left ringing/swept indefinitely. */
  allNeutral(): void {
    this.filterRelease(0.05);
    this.reverbWash(0, 0.05);
    this.clearEchoSchedule();
    this.stopEcho();
  }

  // --- Scratch overlay support (M4 Part C, see src/lib/scratch.ts) ---

  /** The currently-decoded buffer, read-only, for the scratch engine to pull forward segments from. Null before any decode(). */
  get audioBuffer(): AudioBuffer | null {
    return this.buffer;
  }

  /**
   * Lazily builds (and caches) a full reversed copy of the current buffer
   * for the scratch engine's reverse segments — each channel's Float32Array
   * is reversed into a fresh AudioBuffer once per decoded track. Cache is
   * invalidated on the next decode(). Returns null before any decode().
   */
  getReversedBuffer(ctx: AudioContext): AudioBuffer | null {
    if (!this.buffer) return null;
    if (this.reversedBufferCache) return this.reversedBufferCache;
    const reversed = ctx.createBuffer(this.buffer.numberOfChannels, this.buffer.length, this.buffer.sampleRate);
    for (let ch = 0; ch < this.buffer.numberOfChannels; ch++) {
      const src = this.buffer.getChannelData(ch);
      const dst = reversed.getChannelData(ch);
      const len = src.length;
      for (let i = 0; i < len; i++) {
        dst[i] = src[len - 1 - i];
      }
    }
    this.reversedBufferCache = reversed;
    return reversed;
  }

  /**
   * Ducks this deck's normal (dry) gain by `duckDb` (smoothed) — REFCOUNTED
   * (see gain-math.ts's duckStateOnDuck): only the 0->1 transition actually
   * ramps the node; a second/third overlapping duck() call (e.g. a scratch
   * firing while a vocal clip is already ducking the same deck) just bumps
   * the count and keeps the existing factor, no compounding. Used by the
   * scratch engine and the vocal-clip auto-duck so the deck's own playback
   * ducks under the overlay instead of being silenced outright (see
   * src/lib/scratch.ts's file-header rationale for why scratching is a
   * ducking overlay, not a PitchShifter disconnect/reconnect).
   */
  duck(duckDb: number, rampSeconds: number = DUCK_TIME_CONSTANT_SECONDS): void {
    const wasUnducked = this.duckState.count === 0;
    this.duckState = duckStateOnDuck(this.duckState, duckDb);
    if (wasUnducked) this.rampGainTo(composeGain(this.gainValue, this.duckState), rampSeconds);
  }

  /**
   * One fewer caller wants this deck ducked — REFCOUNTED, only the 1->0
   * transition actually ramps the node back, and it always ramps to the
   * CURRENT logicalGain (never a stale snapshot from whenever the duck
   * started — a crossfader/transition move mid-duck is respected). Guards
   * against going negative: an extra/unbalanced unduck() call is a no-op.
   */
  unduck(rampSeconds: number = DUCK_TIME_CONSTANT_SECONDS): void {
    if (this.duckState.count <= 0) return;
    this.duckState = duckStateOnUnduck(this.duckState);
    if (this.duckState.count === 0) this.rampGainTo(composeGain(this.gainValue, this.duckState), rampSeconds);
  }

  /** Force-clears any stuck duck refcount or overlay duck so the deck plays at clean full logical gain. */
  clearAllDucks(): void {
    this.duckState = duckStateInitial();
    this.overlayDuckUntil = 0;
    this.overlayDuckFactor = 1;
    if (this.overlayDucker) {
      const ctx = this.core.ensureContext();
      this.overlayDucker.gain.cancelScheduledValues(ctx.currentTime);
      this.overlayDucker.gain.setValueAtTime(1, ctx.currentTime);
    }
    this.setGain(this.gainValue);
  }

  /** Reconnects this deck's output nodes to a freshly recreated AudioCore.master after purgeOrphanedNodes(). */
  reconnectToMaster(): void {
    if (!this.gainNode) return;
    try { this.gainNode.disconnect(); } catch { /* ignore */ }
    this.gainNode.connect(this.core.master);
    if (this.wetGain) {
      try { this.wetGain.disconnect(); } catch { /* ignore */ }
      this.wetGain.connect(this.core.master);
    }
    if (this.reverbWetGain) {
      try { this.reverbWetGain.disconnect(); } catch { /* ignore */ }
      this.reverbWetGain.connect(this.core.master);
    }
  }

  private rampGainTo(target: number, rampSeconds: number): void {
    if (!this.gainNode) return;
    const ctx = this.core.ensureContext();
    const now = ctx.currentTime;
    const param = this.gainNode.gain;
    if (typeof param.cancelAndHoldAtTime === "function") {
      param.cancelAndHoldAtTime(now);
    } else {
      const current = param.value;
      param.cancelScheduledValues(now);
      param.setValueAtTime(current, now);
    }
    param.setTargetAtTime(target, now, rampSeconds);
  }

  dispose(): void {
    this.overlayDucker?.disconnect();
    this.overlayDucker = null;
    this.pause();
    // Choir round #2 (C7): dispose() used to clear only the echo's SELF-
    // SCHEDULED ring/fade-out timeout, never the wet/feedback send gains
    // themselves — the echo/reverb sends tap pre-duck-gain and feed
    // AudioCore.master directly (see this file's own header), so a
    // mid-echoTail dispose() left the feedback loop free to keep
    // circulating and leaking a decaying echo into master after this deck
    // was supposed to be gone. allNeutral() silences wet/feedback/reverb
    // immediately and releases the sweep filters, covering every send this
    // deck owns.
    this.allNeutral();
    this.buffer = null;
    this.reversedBufferCache = null;
  }
}
