// Pure gain-composition math for Deck's gain ownership model (review-panel
// fix, 2026-07-26) — no AudioContext, no state beyond what's passed in, so
// it's testable without a browser (see scripts/check-gain.mjs).
//
// THE BUG THIS REPLACES: Deck used to own a single `gainValue` written by
// setGain() (crossfader/transition engine) plus a SEPARATE `preDuckGain`
// snapshot-and-restore mechanism for duck()/unduck() (scratch overlay,
// vocal-clip auto-duck). Two independent writers racing for the same
// AudioParam meant: a crossfader move during a duck overwrote the duck
// outright (setGain() wrote straight to the node, ignoring any active
// duck); a transition starting mid-duck inherited a stale pre-duck
// snapshot; and two ducks overlapping (e.g. a scratch AND a vocal clip on
// the same deck) stomped each other's restore value.
//
// THE FIX: the node always gets logicalGain × duckFactor. setGain() only
// ever touches logicalGain (what the crossfader/transition engine own);
// duck()/unduck() only ever touch duckFactor via a REFCOUNT (what the
// scratch overlay/vocal auto-duck own) — never compounding when several
// duck sources overlap, and restoring to whatever logicalGain IS at the
// moment the last duck lifts, never a stale snapshot from when the duck
// started.
export interface DuckState {
  /** How many callers currently want this deck ducked (0 = not ducked). */
  count: number;
  /** The linear factor applied while count > 0 — set once on the 0->1 transition, held fixed while count stays >= 1 (deeper stacking never compounds it). */
  factor: number;
}

export function duckStateInitial(): DuckState {
  return { count: 0, factor: 1 };
}

/** Converts a duck depth in dB (negative = quieter) to a linear multiplier. */
export function dbToFactor(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * One more caller wants this deck ducked. Only the 0->1 transition sets a
 * new factor (from `duckDb`) — a second/third overlapping duck call keeps
 * the existing factor untouched (no compounding) and just bumps the count.
 */
export function duckStateOnDuck(state: DuckState, duckDb: number): DuckState {
  const factor = state.count === 0 ? dbToFactor(duckDb) : state.factor;
  return { count: state.count + 1, factor };
}

/**
 * One caller no longer wants this deck ducked. Guards against going
 * negative (an unbalanced/extra unduck() call is a no-op, not a crash or an
 * over-restore). Only the 1->0 transition actually clears the factor back
 * to 1 — while any other duck source is still holding the count above 0,
 * the deck stays ducked.
 */
export function duckStateOnUnduck(state: DuckState): DuckState {
  if (state.count <= 0) return state;
  const count = state.count - 1;
  return { count, factor: count === 0 ? 1 : state.factor };
}

/** The AudioParam value the gain node should actually carry right now. */
export function composeGain(logicalGain: number, duckState: DuckState): number {
  return logicalGain * duckState.factor;
}
