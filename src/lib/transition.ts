// Engine-level automatic beat-matched transition between two decks — UI-free,
// like the rest of src/lib/. Milestone 3 Part B: this is the deterministic
// "body" half. Claude (src/lib/brain.ts + src/app/api/dj/route.ts) only ever
// picks a trackId + duration/transition kind; it never touches gain or
// tempo directly — this module does, reusing the exact same beatmatch.ts /
// beatclock.ts math the manual Beat Sync button uses so auto and manual
// transitions behave identically.
//
// Milestone 4 Part B additions: two new transition kinds ("bass_swap",
// "echo_out"), mid-transition drift correction for the two blend kinds, and
// auto-degrade (shortened duration) when a tempo-sync had to clamp. See the
// per-section comments below for each.
//
// NOTE: these two imports use explicit .ts extensions (unlike the rest of
// src/lib/, e.g. deck.ts's extension-less "./audio-core") because
// scripts/check-transition.mjs runs this file directly through Node's
// --experimental-strip-types loader, which — unlike webpack/tsc's "bundler"
// resolution — requires a real, resolvable specifier for relative imports.
// Requires tsconfig's `allowImportingTsExtensions` (paired with the
// pre-existing `noEmit: true`); Next.js's SWC/webpack pipeline resolves
// extension-ful relative imports the same as extension-less ones, so this
// doesn't change the production build.
import { syncTempo, type TempoRange } from "./beatmatch.ts";
import { phaseAlignOffset, type BeatGridLike } from "./beatclock.ts";
import { planEchoOutTimeline } from "./fx-sends.ts";

const DEFAULT_TEMPO_RANGE: TempoRange = { min: 0.92, max: 1.08 };
const TICK_MS = 1000 / 30; // ~30Hz, matches the manual crossfader's visual smoothness
const RESNAP_DELAY_MS = 1000; // compensates the ~93ms ScriptProcessor slop (see deck.ts/page.tsx nudge comments)

// --- bass_swap (M4) ---
const BASS_SWAP_LOW_KILL_DB = -40;
const BASS_SWAP_LOW_FLAT_DB = 0;
/**
 * M7 Phase 4 — ROOT CAUSE of Jason's `"no transition , hard cut"` note
 * (2026-07-29, Gasolina -> Te Boté, bass_swap, 8 bars, UNCLAMPED, i.e. a
 * blend the engine believed it ran).
 *
 * The swap used to be a single boolean step at progress >= 0.5: one
 * setEq() killing the outgoing low and opening the incoming low. deck.ts
 * ramps EQ with setTargetAtTime at EQ_TIME_CONSTANT_SECONDS = 0.012, so
 * that handover completed in roughly 36ms — perceptually instantaneous.
 *
 * Why that reads as a hard CUT rather than as a rough blend, specifically in
 * this crate: for the whole first half of the ramp the incoming deck's low
 * band is killed (the P3 fix, correct in itself — it stops two basslines
 * fighting). In reggaeton the dembow kick and bass ARE the track's identity,
 * so during that half the incoming track is a thin mid/high wash sitting
 * under a still-full outgoing track. Then the entire low end of the mix
 * teleports from one record to the other in one event. The equal-power gain
 * ramp is smooth and correct — but it is carrying almost none of the
 * PERCEIVED transition, because the perceptually dominant band is a step
 * function. The ear hears one abrupt change and calls it a cut.
 *
 * Fix: hand the low band over across a real musical window centred on the
 * midpoint, ramped in dB (which is how the ear scales it), instead of
 * stepping it. The two-basslines-fighting problem stays solved because the
 * incoming low is still fully killed everywhere outside that window.
 */
const BASS_SWAP_WINDOW_BARS = 2;

/**
 * Low-band dB for both decks at a given ramp progress. Pure — see
 * scripts/check-transition.mjs.
 *
 * `windowFraction` is the share of the whole ramp over which the low end
 * changes hands, centred on progress 0.5. Outside the window this returns
 * the same values the old step produced (outgoing flat / incoming killed
 * before, the reverse after), so the only behavioural change is that the
 * crossing is gradual.
 */
export function bassSwapLowGains(
  progress: number,
  windowFraction: number,
  killDb: number = BASS_SWAP_LOW_KILL_DB
): { fromLowDb: number; toLowDb: number } {
  const window = Math.min(1, Math.max(0, windowFraction));
  if (window <= 0) {
    // Degenerate window — fall back to the original step so a caller can
    // never accidentally produce a low band stuck halfway.
    const swapped = progress >= 0.5;
    return { fromLowDb: swapped ? killDb : 0, toLowDb: swapped ? 0 : killDb };
  }
  const start = 0.5 - window / 2;
  const t = Math.min(1, Math.max(0, (progress - start) / window));
  return { fromLowDb: killDb * t, toLowDb: killDb * (1 - t) };
}

// --- echo_out (M4, upgraded audio engine v2 Part 1 — real multi-repeat ring via Deck.echoTail/fx-sends.planEchoOutTimeline) ---
// BUG FIXED (choir round #2, C1): ECHO_CUT_BEATS was 4 (dry cuts after a
// full bar = 2s @120bpm) while the ring window (ECHO_RING_BEATS * 3 repeats
// = 2.25 beats = 1.125s @120bpm) is BPM-independent and shorter than that —
// the tail finished ringing and faded to silence BEFORE the dry signal ever
// cut, so "cut dry, tail rings on" never actually happened; the tail died
// under the still-playing dry track instead. Cutting on the very NEXT beat
// (1, not 4) makes the dry cut happen strictly before the ring window ends
// (1 beat < 2.25 beats) for any beats/repeats combination where
// ECHO_RING_BEATS * DEFAULT_ECHO_RING_REPEATS > ECHO_CUT_BEATS — asserted
// directly in scripts/check-fx-sends.mjs.
const ECHO_CUT_BEATS = 1; // dry cuts on the next beat — strictly before the ring window ends, so the tail keeps ringing audibly past the cut
const ECHO_RING_BEATS: 0.75 | 1 = 0.75; // the delay's own repeat interval — a common "dotted" 3/4-beat DJ echo feel
const ECHO_FEEDBACK = 0.55;
const ECHO_WET_TARGET = 0.4; // dry/wet cap (fx-sends.ts's ECHO_WET_CAP) — was 0.6 pre-upgrade, now clamped to the pro rule

// --- drift correction (M4) ---
const DRIFT_CORRECTION_THRESHOLD_MS = 25; // below this, a correction would be inaudible/not worth the seek
const DRIFT_CORRECTION_BAR_INTERVAL = 4; // recheck every 4 bars

// --- auto-degrade on clamp (M4) ---
const DEGRADE_MAX_BARS = 8;

/** Minimal surface transition.ts needs from a deck — satisfied by src/lib/deck.ts's Deck. */
export interface TransitionDeck {
  play(): void;
  pause(): void;
  setTempo(tempo: number): void;
  seekBy(sourceSeconds: number): void;
  setGain(value: number): void;
  setEq(eq: { low?: number; mid?: number; high?: number }): void;
  /** Audio engine v2 Part 1 — the full echo-tail API (arm + ramp-in + self-scheduled ring-then-fade-out). Replaces the old raw startEchoTail/rampEchoWet/stopEcho trio in this interface (Deck still exposes those individually — see fx-sends.ts/deck.ts — but transition.ts's echo_out only ever needs the composed call now). */
  echoTail(effectiveBpm: number, beats: 0.75 | 1, feedback: number, wetLevel: number, ringSeconds: number): void;
  /** Fires once when this deck's track finishes naturally — needed by the "gap" transition, which waits for it. Satisfied by src/lib/deck.ts's Deck.onEnded(). */
  onEnded(listener: () => void): () => void;
  /** Choir round #2 (C2): whether this deck is CURRENTLY playing — needed by "gap" to guard against subscribing to onEnded on a deck that already finished (or never started), which would otherwise wait forever for an event that will never fire again. Satisfied by src/lib/deck.ts's Deck.playing getter, already present — no adapter change needed. */
  readonly playing: boolean;
  readonly positionSeconds: number;
  readonly tempo: number;
}

/** A resolved beat grid: real Serato data, or the anchor-0 + tag-BPM fallback (page.tsx's effectiveGrid()). */
export type EffectiveGrid = (BeatGridLike & { estimated: boolean }) | null;

export type TransitionKind = "beatmatch_crossfade" | "cut" | "bass_swap" | "echo_out" | "gap" | "loop_blend";

/**
 * A grid-snapped 4-bar/16-beat capture off the outgoing deck — same shape as
 * src/lib/loop-blend.ts's planLoopBlend() output, deliberately DUPLICATED
 * here (not imported) rather than sharing one type: loop-blend.ts's
 * fireLoopOverlay() needs a real Deck (which imports soundtouchjs), and
 * transition.ts's whole design point is running cleanly under
 * scripts/check-transition.mjs's fake-deck harness with zero real-audio
 * module loading — even a type-only cross-import adds a coupling this file
 * has otherwise never had. Required for transition:"loop_blend"; callers
 * must never construct one from an estimated/missing grid (see
 * loop-blend.ts's own no-grid-fallback doc comment) — page.tsx enforces this
 * by forcing "bass_swap"/"cut" instead when the live track has no real grid,
 * mirroring the pre-existing untagged-BPM guard for
 * beatmatch_crossfade/bass_swap.
 */
export interface LoopBlendPlan {
  loopStart: number;
  loopEnd: number;
  totalDurationSeconds: number;
}

export interface RunTransitionParams {
  fromDeck: TransitionDeck;
  toDeck: TransitionDeck;
  fromBpm: number;
  toBpm: number;
  fromGrid: EffectiveGrid;
  toGrid: EffectiveGrid;
  /** Bars (4 beats each, at the OUTGOING deck's effective BPM, output-time) to ramp over. Ignored for "cut"/"echo_out" (echo_out uses one bar for its wet ramp — see below). */
  durationBars: number;
  transition?: TransitionKind;
  tempoRange?: TempoRange;
  /** Required for transition:"loop_blend" — the grid-snapped 4-bar capture plan (see loop-blend.ts's planLoopBlend). Ignored for every other kind. */
  loopBlend?: LoopBlendPlan;
  /** loop_blend only: fired once, synchronously, the instant the outgoing deck's dry signal is ducked to 0 — the caller's cue to start the real native-loop overlay (see page.tsx wiring loop-blend.ts's fireLoopOverlay onto the real Deck/AudioCore this abstract interface can't reach). */
  onLoopBlendStart?: () => void;
  /** loop_blend only: fired once, synchronously, right as the incoming deck reaches full gain ("the final 1") — the caller's cue to stop the loop overlay. */
  onLoopBlendEnd?: () => void;
  /** Called with progress 0 (full "from") .. 1 (full "to"), including once at start and once at end. Caller maps this onto its own A/B crossfader UI. */
  onGain?: (progress: number) => void;
  /** Called once, synchronously, right after the tempo-sync step applies toDeck's new tempo — lets the caller mirror it into its own UI state. */
  onTempoSet?: (tempo: number, clamped: boolean) => void;
  onDone?: (result: TransitionResult) => void;
  /** Injectable for tests — real callers omit these and get real timers. */
  now?: () => number;
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
  setTimeoutFn?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface TransitionResult {
  /** A completed transition always ends with the incoming deck live. */
  liveDeck: "to";
  /** True if the tempo-sync step had to clamp to tempoRange. */
  clamped: boolean;
  transition: TransitionKind;
  /** True if the engine shortened durationBars because the tempo-sync clamped (beatmatch_crossfade/bass_swap only — see auto-degrade below). Always false on every other path so pre-M4 callers/tests that don't check it are unaffected. */
  degraded: boolean;
  /** Human-readable reason, present only when degraded is true. */
  degradeReason?: string;
}

export type RunTransitionOutcome = { started: true } | { started: false; reason: string };

function equalPowerGains(progress: number): { fromGain: number; toGain: number } {
  const p = Math.min(1, Math.max(0, progress));
  return { fromGain: Math.cos((p * Math.PI) / 2), toGain: Math.sin((p * Math.PI) / 2) };
}

/**
 * Half/double-time matches (owner soundcheck fix, 2026-07-26): when
 * syncTempo() picked a candidate other than 1x (see beatmatch.ts's
 * SyncResult.multiplier), toDeck's REAL shared pulse with fromDeck isn't its
 * tagged bpm — it's tagged bpm * multiplier (e.g. a track tagged 86 BPM
 * matched at 2x really shares fromDeck's pulse every OTHER of its own
 * tagged beats' worth of time, i.e. at 172). Scaling toGrid.bpm by that same
 * multiplier before handing it to phaseAlignOffset keeps its
 * anchor-modulo-interval math (see beatclock.ts's derivation comment)
 * locking onto that same shared pulse instead of toDeck's un-adjusted tag —
 * anchor itself doesn't change (it's still a real beat crossing regardless
 * of which multiple of the interval we then measure against).
 */
function adjustedGridForMultiplier(grid: EffectiveGrid, multiplier: 1 | 2 | 0.5): EffectiveGrid {
  if (!grid || multiplier === 1) return grid;
  return { ...grid, bpm: grid.bpm * multiplier };
}

/** Phase-snap toDeck onto fromDeck's beat, if both grids are available. No-op (returns 0) otherwise. */
function snapPhase(
  fromDeck: TransitionDeck,
  fromGrid: EffectiveGrid,
  toDeck: TransitionDeck,
  toGrid: EffectiveGrid,
  toTempo: number,
  toGridMultiplier: 1 | 2 | 0.5 = 1
): number {
  const adjustedToGrid = adjustedGridForMultiplier(toGrid, toGridMultiplier);
  if (!fromGrid || !adjustedToGrid) return 0;
  const offset = phaseAlignOffset(
    fromDeck.positionSeconds,
    fromGrid,
    fromDeck.tempo,
    toDeck.positionSeconds,
    adjustedToGrid,
    toTempo
  );
  toDeck.seekBy(offset);
  return offset;
}

/**
 * Creates an independent transition engine instance. One instance should be
 * shared by the app (or one per test case) — it holds the "only one
 * transition at a time" guard.
 */
export function createTransitionEngine() {
  let running = false;
  // Choir round #2 (C2): a single "how do I tear down whatever's currently
  // in flight" callback, set by whichever branch below actually starts
  // async/pending work (a timer, an interval, or an onEnded subscription)
  // and cleared the moment that work finishes normally. cancel() below is
  // the ONLY way to unwedge a transition whose natural completion event
  // will never fire — e.g. "gap" waiting on an onEnded that can't fire
  // again because the DJ manually paused the deck mid-wait.
  let activeCancel: (() => void) | null = null;

  function runTransition(params: RunTransitionParams): RunTransitionOutcome {
    if (running) {
      return { started: false, reason: "a transition is already running" };
    }

    const {
      fromDeck,
      toDeck,
      fromBpm,
      toBpm,
      fromGrid,
      toGrid,
      durationBars,
      transition = "beatmatch_crossfade",
      tempoRange = DEFAULT_TEMPO_RANGE,
      loopBlend,
      onLoopBlendStart,
      onLoopBlendEnd,
      onGain,
      onTempoSet,
      onDone,
      now = Date.now,
      setIntervalFn = setInterval,
      clearIntervalFn = clearInterval,
      setTimeoutFn = setTimeout,
      clearTimeoutFn = clearTimeout,
    } = params;

    running = true;
    activeCancel = null; // always null at this point (a prior transition always clears it via finish()/cancel()) — set explicitly for clarity, each branch below assigns its own real cleanup before any async wait begins

    // (a) tempo-sync toDeck to fromDeck's effective BPM — proceed even when
    // clamped, for every transition kind including echo_out (the brain may
    // pick echo_out for reasons other than BPM, and syncing costs nothing).
    const sync = syncTempo(fromBpm, fromDeck.tempo, toBpm, tempoRange);
    toDeck.setTempo(sync.tempo);
    onTempoSet?.(sync.tempo, sync.clamped);

    const effectiveFromBpm = fromBpm * fromDeck.tempo;

    // Auto-degrade: an impossible BPM lock (clamped) makes committing to a
    // long blend/swap audibly wrong the whole way through (beats drifting
    // continuously) — shorten it instead. Exempt: "cut" (no ramp to shorten)
    // and "echo_out" (already the brain's chosen escape hatch for exactly
    // this situation — degrading it further doesn't make sense).
    const degraded = sync.clamped && (transition === "beatmatch_crossfade" || transition === "bass_swap");
    const degradeBars = Math.min(Math.max(1, durationBars), DEGRADE_MAX_BARS);
    const degradeReason = degraded
      ? `BPM lock impossible (clamped); shortened to ${degradeBars} bars`
      : undefined;

    let driftIntervalHandle: ReturnType<typeof setInterval> | null = null;

    function finish() {
      if (driftIntervalHandle !== null) {
        clearIntervalFn(driftIntervalHandle);
        driftIntervalHandle = null;
      }
      fromDeck.pause();
      fromDeck.setGain(1);
      if (transition === "bass_swap" || transition === "beatmatch_crossfade") {
        // Reset both decks' low band so a reused deck doesn't inherit a killed low.
        fromDeck.setEq({ low: BASS_SWAP_LOW_FLAT_DB });
        toDeck.setEq({ low: BASS_SWAP_LOW_FLAT_DB });
      }
      activeCancel = null;
      running = false;
      onDone?.({ liveDeck: "to", clamped: sync.clamped, transition, degraded, degradeReason });
    }

    // --- echo_out: a wholly different shape from the crossfade family. The
    // outgoing deck feeds a feedback delay timed to the beat; the dry signal
    // cuts (pause + dry gain to 0) after ECHO_CUT_BEATS, while the echo tail
    // — armed via Deck.echoTail (audio engine v2 Part 1) BEFORE the cut —
    // keeps ringing on its own for several real repeats (the feedback loop's
    // already-buffered audio doesn't need the source connected to keep
    // circulating, and the send taps pre-duck-gain — see deck.ts's file
    // header), then self-fades. toDeck deliberately does NOT start until the
    // dry cut — it comes in clean (no echo) right on the downbeat,
    // phase-snapped only at that point, rather than running silently under
    // the echo the whole time. ---
    if (transition === "echo_out") {
      const plan = planEchoOutTimeline(effectiveFromBpm, ECHO_CUT_BEATS, ECHO_RING_BEATS, ECHO_FEEDBACK, ECHO_WET_TARGET);

      fromDeck.echoTail(effectiveFromBpm, ECHO_RING_BEATS, ECHO_FEEDBACK, plan.wetLevel, plan.wetRampOutAtSeconds);
      onGain?.(0);

      const cutHandle = setTimeoutFn(() => {
        activeCancel = null;
        fromDeck.pause();
        fromDeck.setGain(0);
        snapPhase(fromDeck, fromGrid, toDeck, toGrid, sync.tempo, sync.multiplier);
        toDeck.setGain(1);
        toDeck.play();
        onGain?.(1);
        running = false;
        onDone?.({ liveDeck: "to", clamped: sync.clamped, transition, degraded: false, degradeReason: undefined });
      }, plan.dryCutAtSeconds * 1000);
      // Choir round #2 (C2): a manual pause of fromDeck mid-ring means the DJ
      // took over before the dry cut — clearing this timeout just stops the
      // now-unwanted later cut/toDeck.play() from firing; the echo tail
      // itself keeps ringing/self-silencing on its own schedule regardless
      // (Deck.echoTail owns that, not this timer).
      activeCancel = () => clearTimeoutFn(cutHandle);

      return { started: true };
    }

    // --- loop_blend: the "suspension" tool (see brain.ts's SYSTEM_PROMPT).
    // The outgoing deck's dry signal ducks to 0 immediately — it is REPLACED
    // audibly by a grid-snapped 4-bar/16-beat native loop overlay the caller
    // starts via onLoopBlendStart() (this abstract interface has no access
    // to a real AudioBuffer/AudioContext, so the actual overlay node lives
    // outside transition.ts — see page.tsx wiring loop-blend.ts's
    // fireLoopOverlay onto the real Deck/AudioCore, same "duck-overlay
    // outside the abstract engine" pattern scratch.ts/roll.ts already use).
    // The incoming deck fades in (equal-power, same curve as every blend
    // kind) over loopBlend.totalDurationSeconds; on "the final 1" the loop
    // stops (onLoopBlendEnd) and the outgoing deck is retired like any other
    // completed transition. No phase-snap (there's nothing to align the
    // incoming deck's phase against — the outgoing deck is silent) and no
    // drift correction. Requires a real (non-estimated) grid-derived plan —
    // callers must never reach this branch without one (see LoopBlendPlan's
    // own doc comment); a missing/degenerate plan fails the start cleanly
    // rather than mis-timing a loop. ---
    if (transition === "loop_blend") {
      if (!loopBlend || !(loopBlend.totalDurationSeconds > 0)) {
        running = false;
        return { started: false, reason: "loop_blend requires a valid grid-snapped loopBlend plan" };
      }

      onGain?.(0);
      fromDeck.setGain(0); // duck the dry outgoing deck fully — the loop overlay replaces it audibly
      onLoopBlendStart?.();
      toDeck.setGain(0);
      toDeck.play();

      const loopStart = now();
      let loopIntervalHandle: ReturnType<typeof setInterval> | null = null;
      const loopTick = () => {
        const elapsed = (now() - loopStart) / 1000;
        const progress = elapsed / loopBlend!.totalDurationSeconds;
        const { toGain } = equalPowerGains(progress);
        toDeck.setGain(toGain);
        onGain?.(Math.min(1, Math.max(0, progress)));

        if (progress >= 1) {
          if (loopIntervalHandle !== null) clearIntervalFn(loopIntervalHandle);
          activeCancel = null;
          onLoopBlendEnd?.();
          toDeck.setGain(1);
          fromDeck.pause();
          fromDeck.setGain(1); // reset for reuse, same convention as finish()'s post-transition reset
          running = false;
          onDone?.({ liveDeck: "to", clamped: sync.clamped, transition, degraded: false, degradeReason: undefined });
        }
      };
      loopIntervalHandle = setIntervalFn(loopTick, TICK_MS);
      // Choir round #2 (C2): canceling mid-loop must stop the native loop
      // overlay too (onLoopBlendEnd), not just the interval — otherwise it
      // keeps looping forever with nothing left to stop it once the DJ has
      // taken over.
      activeCancel = () => {
        if (loopIntervalHandle !== null) clearIntervalFn(loopIntervalHandle);
        onLoopBlendEnd?.();
      };
      return { started: true };
    }

    // --- gap: the salsa/bachata "clean ending" mechanism (see brain.ts's
    // SYSTEM_PROMPT) — toDeck must NOT start until fromDeck's track ends on
    // its own (its existing onEnded event, the same one the deck fires when
    // a track just naturally finishes). No overlap, no phase-snap (there's
    // nothing to align phase against — toDeck starts fresh), no ramp: once
    // fromDeck ends, toDeck starts plainly at full gain. The "only one
    // transition at a time" guard (running=true, set above) stays held for
    // the whole wait, which can be the rest of the track's length — that's
    // deliberate: a second runTransition() call during a pending gap must
    // still be rejected, same re-entrancy semantics as every other kind.
    //
    // Choir round #2 (C2) — two wedge fixes:
    //  (a) fromDeck.playing is checked BEFORE subscribing — if the track
    //      already ended (or never started) before this call, the "wait"
    //      condition is already trivially satisfied; start toDeck right now
    //      instead of subscribing to an onEnded that fired once already and
    //      will never fire again (a permanent wedge).
    //  (b) activeCancel exposes the unsubscribe to cancel() below, so a
    //      manual pause of fromDeck mid-wait (onEnded then genuinely never
    //      fires, since the DJ — not the track — stopped it) can unwedge
    //      `running` instead of leaving autopilot silently dead for the
    //      rest of the session. ---
    if (transition === "gap") {
      const completeGap = () => {
        activeCancel = null;
        fromDeck.pause();
        fromDeck.setGain(1);
        toDeck.setGain(1);
        toDeck.play();
        onGain?.(1);
        running = false;
        onDone?.({ liveDeck: "to", clamped: sync.clamped, transition, degraded: false, degradeReason: undefined });
      };
      if (!fromDeck.playing) {
        onGain?.(0);
        completeGap();
        return { started: true };
      }
      const unsubscribe = fromDeck.onEnded(() => {
        unsubscribe();
        completeGap();
      });
      activeCancel = () => unsubscribe();
      onGain?.(0);
      return { started: true };
    }

    // (b) phase-snap toDeck onto fromDeck and start it. Gain is zeroed on
    // toDeck (and pinned to full on fromDeck) and low EQ is set BEFORE play()
    // starts toDeck's AudioBufferSourceNode, so there is no stop/restart click
    // on frame 0 and no stale leftover gain/EQ becoming audible on start.
    const initialGains = equalPowerGains(0);
    fromDeck.setGain(initialGains.fromGain);
    toDeck.setGain(initialGains.toGain);
    snapPhase(fromDeck, fromGrid, toDeck, toGrid, sync.tempo, sync.multiplier);

    // Every overlapping beatmatch starts with only the outgoing bassline.
    // Plain crossfade trades lows for its full duration; bass_swap uses the
    // narrower musical window below.
    if (transition === "bass_swap" || transition === "beatmatch_crossfade") {
      toDeck.setEq({ low: BASS_SWAP_LOW_KILL_DB });
    }
    toDeck.play();

    if (transition === "cut") {
      // Instant switch — no fade. Tempo-sync + phase-snap already happened above.
      onGain?.(0);
      toDeck.setGain(1);
      fromDeck.setGain(0);
      onGain?.(1);
      finish();
      return { started: true };
    }

    // (c) after ~1s, one corrective re-snap (compensates ScriptProcessor slop).
    const resnapHandle = setTimeoutFn(() => {
      snapPhase(fromDeck, fromGrid, toDeck, toGrid, sync.tempo, sync.multiplier);
    }, RESNAP_DELAY_MS);

    // (d) ramp the crossfader through the equal-power curve, bar = 4 beats at
    // the OUTGOING deck's effective BPM (output-time). Both beatmatch modes
    // own a low-EQ handoff in addition to this gain curve.
    // Auto-degraded duration (see above) shortens the ramp when the
    // tempo-sync had to clamp.
    const bars = Math.max(1, degraded ? Math.min(durationBars, DEGRADE_MAX_BARS) : durationBars);
    // Plain crossfade trades low end across the entire ramp. bass_swap's
    // handover is expressed in bars so it stays musical at any duration.
    const bassSwapWindowFraction =
      transition === "beatmatch_crossfade" ? 1 : Math.min(1, BASS_SWAP_WINDOW_BARS / bars);
    const durationSeconds = effectiveFromBpm > 0 ? (bars * 4 * 60) / effectiveFromBpm : 0;

    // Mid-transition drift correction — beatmatch_crossfade/bass_swap only,
    // and only against REAL beat grids (not the anchor-0 estimated
    // fallback) with a tempo-sync that did NOT clamp. Under a clamp the two
    // decks' effective BPMs can never truly match, so drift is unavoidable —
    // correcting against it would just chase a moving target and add
    // audible stutter on top of an already-unavoidable mismatch, so it's
    // deliberately skipped (see the `degraded` shortening above instead).
    // Estimated grids (anchor-0 guess, no real Serato tag) aren't trusted
    // enough to correct against either — a wrong correction is worse than
    // none. Implemented as its own interval (piggybacking on the ~30Hz gain
    // tick would run this far more often than needed) — torn down in
    // finish() alongside the resnap/tick timers.
    const canDriftCorrect =
      (transition === "beatmatch_crossfade" || transition === "bass_swap") &&
      fromGrid !== null &&
      toGrid !== null &&
      !fromGrid.estimated &&
      !toGrid.estimated &&
      !sync.clamped &&
      effectiveFromBpm > 0;

    if (canDriftCorrect) {
      // Same multiplier-adjusted grid as the initial/resnap phase-snap above
      // — a half/double match's shared pulse is toGrid.bpm * sync.multiplier,
      // not toGrid.bpm on its own (see adjustedGridForMultiplier's comment).
      const driftToGrid = adjustedGridForMultiplier(toGrid, sync.multiplier);
      const driftIntervalMs = DRIFT_CORRECTION_BAR_INTERVAL * ((4 * 60) / effectiveFromBpm) * 1000;
      driftIntervalHandle = setIntervalFn(() => {
        const offsetSourceSeconds = phaseAlignOffset(
          fromDeck.positionSeconds,
          fromGrid,
          fromDeck.tempo,
          toDeck.positionSeconds,
          driftToGrid!,
          sync.tempo
        );
        // phaseAlignOffset returns a toDeck SOURCE-seconds correction (see
        // its own derivation comment in beatclock.ts). Converting back to
        // OUTPUT-ms inverts that exact derivation: a shift of X
        // output-seconds requires X * tempoB source-seconds, so
        // output-seconds = sourceSeconds / tempoB — divide, don't multiply.
        const offsetOutputMs = (offsetSourceSeconds / sync.tempo) * 1000;
        if (Math.abs(offsetOutputMs) > DRIFT_CORRECTION_THRESHOLD_MS) {
          toDeck.seekBy(offsetSourceSeconds);
        }
      }, driftIntervalMs);
    }

    onGain?.(0);
    const start = now();
    let intervalHandle: ReturnType<typeof setInterval> | null = null;

    function tick() {
      const elapsed = (now() - start) / 1000;
      const progress = elapsed / durationSeconds;
      const { fromGain, toGain } = equalPowerGains(progress);
      fromDeck.setGain(fromGain);
      toDeck.setGain(toGain);
      onGain?.(Math.min(1, Math.max(0, progress)));

      // Hand low end between channels without ever leaving both basslines
      // fully open. See bassSwapLowGains for the window shape.
      if (transition === "bass_swap" || transition === "beatmatch_crossfade") {
        const { fromLowDb, toLowDb } = bassSwapLowGains(progress, bassSwapWindowFraction);
        fromDeck.setEq({ low: fromLowDb });
        toDeck.setEq({ low: toLowDb });
      }

      if (progress >= 1) {
        if (intervalHandle !== null) clearIntervalFn(intervalHandle);
        clearTimeoutFn(resnapHandle);
        finish();
      }
    }

    if (durationSeconds <= 0) {
      // Degenerate duration (no BPM, or duration collapsed to 0) — behave like a cut.
      clearTimeoutFn(resnapHandle);
      toDeck.setGain(1);
      fromDeck.setGain(0);
      onGain?.(1);
      finish();
    } else {
      intervalHandle = setIntervalFn(tick, TICK_MS);
      // Choir round #2 (C2): tear down every timer this ramp owns (gain
      // tick, resnap, drift correction) on cancel. Beatmatched blends also
      // need their EQ put back — cancel must never leave a deck's low
      // permanently killed (same restoration finish() already guarantees on
      // normal completion, incl. the P3 kill-at-start above).
      activeCancel = () => {
        if (intervalHandle !== null) clearIntervalFn(intervalHandle);
        clearTimeoutFn(resnapHandle);
        if (driftIntervalHandle !== null) clearIntervalFn(driftIntervalHandle);
        if (transition === "bass_swap" || transition === "beatmatch_crossfade") {
          fromDeck.setEq({ low: BASS_SWAP_LOW_FLAT_DB });
          toDeck.setEq({ low: BASS_SWAP_LOW_FLAT_DB });
        }
      };
    }

    return { started: true };
  }

  /**
   * Choir round #2 (C2): tears down whatever's currently in flight (a
   * pending "gap" wait, an echo_out ring-then-cut timer, a loop_blend/ramp
   * interval, incl. any drift-correction interval) and resets `running` to
   * false — the ONLY way to recover when a transition's own natural
   * completion event will never fire (e.g. the DJ manually paused the deck
   * "gap" was waiting on). No-op (returns false) if nothing is running.
   * Deliberately does NOT call onDone (this is an abort, not a completion)
   * — callers that need bookkeeping (lesson ledger, UI state) do it
   * themselves at the call site, same as any other rejected/aborted path.
   */
  function cancel(): boolean {
    if (!running) return false;
    const cleanup = activeCancel;
    activeCancel = null;
    running = false;
    cleanup?.();
    return true;
  }

  return {
    runTransition,
    cancel,
    get isRunning() {
      return running;
    },
  };
}

export type TransitionEngine = ReturnType<typeof createTransitionEngine>;
