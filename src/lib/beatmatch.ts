// Pure beat-match math: given one deck's tagged BPM + current tempo (the
// "source" of truth for the match) and the other deck's tagged BPM (the
// "target" whose tempo we're about to change), compute the target tempo that
// makes both decks' effective BPM equal (tagBpm * tempo). No audio/UI here —
// see src/lib/deck.ts for playback and src/app/page.tsx for the Sync buttons
// that call this. Deliberately tempo-only: phase/beatgrid alignment is out of
// scope for this milestone.
//
// Half/double-time matching (owner soundcheck finding, 2026-07-26): a track
// tagged at half or double its "true" felt tempo (e.g. a dembow track tagged
// ~90 BPM that a club-tempo track at ~180 BPM is really the same pulse as) is
// a real, common mismatch a tag-only sync can't see. So besides the plain
// targetBpm, also try targetBpm*2 and targetBpm/2 as candidates and keep
// whichever needs the LEAST tempo change (requiredTempo closest to 1.0) —
// this can only ever produce an equal-or-better lock than the plain-only
// version, never a worse one, since the plain candidate is always in the
// running. See SyncResult.multiplier for which one won.
export interface TempoRange {
  min: number;
  max: number;
}

export interface SyncResult {
  /** The tempo to apply to the target deck, clamped to range. */
  tempo: number;
  /** True if the exact required tempo fell outside range and had to be clamped. */
  clamped: boolean;
  /** The exact tempo that would perfectly match effective BPM, pre-clamp. */
  requiredTempo: number;
  /**
   * Which multiple of targetBpm produced the winning requiredTempo: 1 = a
   * plain match; 2 = the target's real pulse is treated as double its tag
   * (targetBpm*2 was closer to a clean lock); 0.5 = the target's real pulse
   * is treated as half its tag (targetBpm/2 was closer). Lets callers/UI
   * notices say "matched at double-time"/"half-time".
   */
  multiplier: 1 | 2 | 0.5;
}

const DEFAULT_RANGE: TempoRange = { min: 0.92, max: 1.08 };

// Tried in this order; ties (equal distance from 1.0) keep the earlier
// (lower-index) candidate — 1 before 2 before 0.5 — so a plain match is
// always preferred over a half/double one when they're equally good.
const CANDIDATE_MULTIPLIERS: readonly (1 | 2 | 0.5)[] = [1, 2, 0.5];

/**
 * Compute the tempo for a target deck so that
 * (targetBpm * multiplier) * tempo === sourceBpm * sourceTempo (matching
 * effective BPM at whichever multiplier locks closest to 1.0x), clamped to
 * `range`.
 */
export function syncTempo(
  sourceBpm: number,
  sourceTempo: number,
  targetBpm: number,
  range: TempoRange = DEFAULT_RANGE
): SyncResult {
  const sourceEffectiveBpm = sourceBpm * sourceTempo;

  let bestMultiplier: 1 | 2 | 0.5 = 1;
  let bestRequiredTempo = sourceEffectiveBpm / targetBpm;
  let bestDistance = Math.abs(bestRequiredTempo - 1);

  for (const multiplier of CANDIDATE_MULTIPLIERS) {
    if (multiplier === 1) continue;
    const candidateRequiredTempo = sourceEffectiveBpm / (targetBpm * multiplier);
    const distance = Math.abs(candidateRequiredTempo - 1);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestRequiredTempo = candidateRequiredTempo;
      bestMultiplier = multiplier;
    }
  }

  const tempo = Math.min(range.max, Math.max(range.min, bestRequiredTempo));
  return {
    tempo,
    clamped: tempo !== bestRequiredTempo,
    requiredTempo: bestRequiredTempo,
    multiplier: bestMultiplier,
  };
}
