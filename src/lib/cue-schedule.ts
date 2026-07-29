// Pure source-time -> wall-clock scheduling math for live cue-point firing.
// No AudioContext/timers here (page.tsx owns the actual setTimeout/onProgress
// wiring — see CLAUDE_STATE.md's cue-points section for the design), so this
// is testable without a browser, same spirit as beatclock.ts/gain-math.ts.
import type { Cue } from "./cue-store";

/**
 * Cues at/after `positionSeconds` (not yet due), ascending by atSeconds. A
 * small epsilon avoids treating a cue exactly at the current position as
 * already-passed due to progress-tick rounding noise.
 */
export function upcomingCues(cues: Cue[], positionSeconds: number, epsilonSeconds = 0.01): Cue[] {
  return cues.filter((c) => c.atSeconds >= positionSeconds - epsilonSeconds).sort((a, b) => a.atSeconds - b.atSeconds);
}

/**
 * Wall-clock (OUTPUT-time) seconds until `atSeconds` (SOURCE-time) is
 * reached at the deck's current position/tempo — same source-to-output
 * conversion convention as page.tsx's deckLiveState().remainingSeconds and
 * beatclock.ts's nudge math (source-seconds / tempo). Negative/zero means
 * the cue is already due.
 */
export function computeDelaySeconds(atSeconds: number, positionSeconds: number, tempo: number): number {
  const sourceDelta = atSeconds - positionSeconds;
  return tempo > 0 ? sourceDelta / tempo : sourceDelta;
}

export function computeDelayMs(atSeconds: number, positionSeconds: number, tempo: number): number {
  return computeDelaySeconds(atSeconds, positionSeconds, tempo) * 1000;
}

/** Absolute wall-clock timestamp (ms) `atSeconds` is expected to fire at, given `nowMs`. */
export function computeExpectedFireAtMs(
  atSeconds: number,
  positionSeconds: number,
  tempo: number,
  nowMs: number
): number {
  return nowMs + computeDelayMs(atSeconds, positionSeconds, tempo);
}

/**
 * True when a freshly recomputed expected-fire time has drifted from the
 * previously-armed one by more than `thresholdMs` — the caller should cancel
 * the existing timer and re-arm at the new delay. Progress ticks land ~93ms
 * apart (ScriptProcessorNode buffer size, same cadence M2.5's nudge-button
 * rationale already documents); a >100ms threshold means ordinary per-tick
 * jitter never re-arms, but a real seek or tempo change — which shifts the
 * expected fire time by much more than one tick's worth — always does. This
 * is also what lets the scheduler skip separate seek/tempo-change hooks
 * entirely: both change positionSeconds/tempo, which this function alone
 * notices on the very next tick.
 */
export function shouldRearm(previousExpectedAtMs: number, freshExpectedAtMs: number, thresholdMs = 100): boolean {
  return Math.abs(previousExpectedAtMs - freshExpectedAtMs) > thresholdMs;
}
