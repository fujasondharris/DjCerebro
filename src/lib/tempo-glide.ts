// Post-transition tempo-recovery glide — owner soundcheck finding
// (2026-07-26): every syncTempo() bends the newly-live deck's tempo away
// from 1.0 (its natural, tagged BPM), and nothing ever brought it back —
// over a whole set, repeated transitions only ever bend tempo further
// (autopilot never "un-bends" it upward again), so the set drifted slower
// and slower with no recovery. Fix: after a transition lands, gently walk
// the live deck's tempo back toward 1.0 in small steps rather than
// snapping instantly (which would be an audible pitch/tempo jump right
// after a beatmatched landing). Pure math only — no timers/AudioContext
// here; src/app/page.tsx owns the actual setInterval/setTempo wiring and
// the cancel conditions (a new transition starting, a tempo_nudge command,
// the user moving the tempo slider, or the track ending — see its
// startTempoGlide/cancelTempoGlide).
export const TEMPO_GLIDE_STEP_MS = 500;
export const TEMPO_GLIDE_DURATION_SECONDS = 25; // musical default within the dispatch's 20-30s window
export const TEMPO_GLIDE_START_DELAY_MS = 2000; // let the landing settle before nudging it again

/** Number of ~TEMPO_GLIDE_STEP_MS ticks the glide takes to finish. */
export function glideStepCount(
  durationSeconds: number = TEMPO_GLIDE_DURATION_SECONDS,
  stepMs: number = TEMPO_GLIDE_STEP_MS
): number {
  return Math.max(1, Math.round((durationSeconds * 1000) / stepMs));
}

/**
 * One glide step: moves `currentTempo` toward 1.0 by an equal fraction of
 * the REMAINING gap for each of the remaining steps, so the glide reaches
 * EXACTLY 1.0 on the final step (not asymptotically, and not left with a
 * residual fractional tempo from dividing a fixed increment unevenly).
 * `stepsRemaining` is the count including this step (1 = this is the last
 * step, snap straight to 1.0).
 */
export function nextGlideTempo(currentTempo: number, stepsRemaining: number): number {
  if (stepsRemaining <= 1) return 1;
  const gap = 1 - currentTempo;
  return currentTempo + gap / stepsRemaining;
}
