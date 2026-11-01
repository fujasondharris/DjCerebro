// Pure beat-phase math for Beat Sync's phase-alignment step — no audio/UI
// here. See src/lib/serato.ts for where anchor/bpm come from and
// src/app/page.tsx for the Beat Sync button + nudge buttons that call this.

export interface BeatGridLike {
  anchor: number;
  bpm: number;
}

/**
 * Phase, in [0, 1), of `sourceTimeSec` within its beat, given the track's
 * anchor (a SOURCE-seconds position that lands exactly on a beat — it does
 * not have to be the first beat, the modulo below finds the nearest
 * preceding beat automatically) and its native (source, untouched-by-tempo)
 * BPM.
 */
export function beatPhase(sourceTimeSec: number, anchorSec: number, bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(sourceTimeSec) || !Number.isFinite(anchorSec)) {
    return 0;
  }
  const beatInterval = 60 / bpm; // seconds-per-beat, in SOURCE time
  const beatsSinceAnchor = (sourceTimeSec - anchorSec) / beatInterval;
  const phase = beatsSinceAnchor - Math.floor(beatsSinceAnchor);
  return phase >= 1 || phase < 0 ? 0 : phase; // strictly in [0, 1) even under IEEE-754 sub-epsilon rounding
}

/**
 * The SOURCE-seconds delta to apply to deck B (e.g. via Deck.seekBy) so its
 * next beat coincides with deck A's, picking the smallest-magnitude
 * correction (nearest beat, forward or back — never a whole extra beat of
 * travel).
 *
 * Derivation:
 * - For each deck, "real (output/wall-clock) seconds since its most recent
 *   beat crossing" is phase * outputBeatInterval, where
 *   outputBeatInterval = (60/bpm)/tempo (tempo speeds up how fast
 *   source-time elapses per output-second, so a higher tempo means a
 *   SHORTER output beat interval). That's what the ear actually judges —
 *   two decks are "aligned" when this value is equal on both.
 * - deltaOutputSec = outputOffsetA - outputOffsetB is the raw (unwrapped)
 *   correction; wrapping it modulo deck B's own output beat interval picks
 *   the smallest-magnitude equivalent (shifting B by a whole B-beat leaves
 *   its phase, and thus the lock, unchanged).
 * - A shift of X OUTPUT-seconds requires X * tempoB SOURCE-seconds on deck
 *   B, because deck B's PitchShifter advances tempoB source-seconds for
 *   every output-second that passes.
 */
export function phaseAlignOffset(
  sourceA: number,
  gridA: BeatGridLike,
  tempoA: number,
  sourceB: number,
  gridB: BeatGridLike,
  tempoB: number
): number {
  if (
    !gridA ||
    !gridB ||
    !Number.isFinite(gridA.bpm) ||
    gridA.bpm <= 0 ||
    !Number.isFinite(gridB.bpm) ||
    gridB.bpm <= 0 ||
    !Number.isFinite(tempoA) ||
    tempoA <= 0 ||
    !Number.isFinite(tempoB) ||
    tempoB <= 0
  ) {
    return 0;
  }
  const phaseA = beatPhase(sourceA, gridA.anchor, gridA.bpm);
  const phaseB = beatPhase(sourceB, gridB.anchor, gridB.bpm);

  const outputBeatIntervalA = 60 / gridA.bpm / tempoA;
  const outputBeatIntervalB = 60 / gridB.bpm / tempoB;

  const outputOffsetA = phaseA * outputBeatIntervalA;
  const outputOffsetB = phaseB * outputBeatIntervalB;

  let deltaOutputSec = outputOffsetA - outputOffsetB;
  deltaOutputSec -= Math.round(deltaOutputSec / outputBeatIntervalB) * outputBeatIntervalB;

  return deltaOutputSec * tempoB; // output-seconds -> deck B source-seconds
}
