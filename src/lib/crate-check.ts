// Pure classification logic for scripts/crate-check.mjs: given a track's
// parsed tags, decides READY (has both TBPM and TKEY — the two fields the
// app actually needs, see src/lib/id3.ts) vs NEEDS SERATO PASS (missing
// either). Deliberately does NOT require a Serato BeatGrid — Beat Sync's
// phase-align already falls back to an estimated grid off tagged BPM alone
// (see src/lib/serato.ts's header comment), so BeatGrid presence is reported
// but not part of the READY gate. UI/IO-free by design, same discipline as
// beatmatch.ts/pricing.ts, so it's checkable without touching the filesystem
// — see scripts/check-crate-check.mjs.
export interface CrateCheckTags {
  bpm?: number;
  key?: string;
}

export interface CrateCheckResult {
  ready: boolean;
  missing: string[];
}

export function classifyEntry(tags: CrateCheckTags): CrateCheckResult {
  const missing: string[] = [];
  if (!tags.bpm) missing.push("BPM"); // falsy covers undefined/null/0/NaN — id3.ts never emits 0, but guard anyway
  if (!tags.key) missing.push("key");
  return { ready: missing.length === 0, missing };
}
