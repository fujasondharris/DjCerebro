// Cue-point persistence — the headline feature of this milestone: per-track,
// rehearsal-marked, lyric-timed vocal fires (e.g. NUEVAYoL's crowd answering
// "¿Pa' dónde?" — El Cerebro fires the exact clip at the exact moment,
// instead of reacting late). Pure data shape + localStorage I/O, same
// guard-and-no-op pattern as crate-store.ts/history-store.ts/cost-store.ts.
// Live-firing math (source-time -> wall-clock delay, drift/re-arm decision)
// deliberately lives in a SEPARATE module, cue-schedule.ts — no localStorage
// there, no persistence types here — so each half is independently testable
// (see scripts/check-cue-store.mjs).
export type CueAction =
  | { type: "clip"; file: string | null } // null = marked but not yet assigned a clip
  | { type: "singalong"; durationSeconds: number };

export interface Cue {
  /** SOURCE-time seconds (Deck.positionSeconds convention, M2.5) — NOT wall-clock/output time. */
  atSeconds: number;
  action: CueAction;
  label?: string;
  /**
   * Additive (migration-safe — every existing stored Cue simply has this
   * `undefined`, same as no cue ever had a `label` before this milestone).
   * True only for a cue seeded from scripts/suggest-cues.mjs's synced-lyrics
   * pipeline (src/data/cue-suggestions.json) that the user hasn't touched
   * yet. A suggested cue is always created with an unassigned/inert action
   * (see buildSuggestedCues below) — page.tsx's fireCue() already no-ops on
   * an unassigned clip action, so "suggested" alone is enough to keep it
   * silent; assigning a clip/sing-along (updateCueAction) or nudging
   * (nudgeCue) clears this flag, turning it into an ordinary user cue.
   */
  suggested?: boolean;
}

/**
 * Enough to key a track's cues stably across a reload. Drive tracks: the
 * real Drive file id (stable — see the lazy-crate re-architecture's own note
 * about why a crate entry's random local id isn't usable for this). Local
 * (file-picker) tracks have no such id, so name+size stands in — the crate
 * already carries both for every entry (CrateTrack in page.tsx).
 */
export interface CueTrackRef {
  source: "drive" | "local";
  id: string; // ignored for "local"
  name: string;
  size: number | null;
}

export function cueTrackKey(track: CueTrackRef): string {
  return track.source === "drive" ? `drive:${track.id}` : `local:${track.name}:${track.size ?? 0}`;
}

interface CueTrackEntry {
  cues: Cue[];
  lastTouchedMs: number;
}

export type CueStore = Record<string, CueTrackEntry>;

const STORAGE_KEY = "djsm.cue-points";
/** Cap on distinct tracks carrying cues — oldest-touched evicted first once exceeded. */
export const MAX_CUE_TRACKS = 50;

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

export function loadCueStore(): CueStore {
  if (!hasLocalStorage()) return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveCueStore(store: CueStore): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Best-effort persistence — e.g. storage quota exceeded or disabled. Not fatal.
  }
}

/** Pure: drops the oldest-touched tracks beyond `maxTracks` (LRU eviction by lastTouchedMs). */
export function evictOldestTracks(store: CueStore, maxTracks: number = MAX_CUE_TRACKS): CueStore {
  const keys = Object.keys(store);
  if (keys.length <= maxTracks) return store;
  const oldestFirst = [...keys].sort((a, b) => store[a].lastTouchedMs - store[b].lastTouchedMs);
  const toDrop = new Set(oldestFirst.slice(0, keys.length - maxTracks));
  const next: CueStore = {};
  for (const key of keys) {
    if (!toDrop.has(key)) next[key] = store[key];
  }
  return next;
}

export function getCues(store: CueStore, key: string): Cue[] {
  return store[key]?.cues ?? [];
}

/**
 * Pure: replaces one track's cue list (sorted by atSeconds), bumps
 * lastTouchedMs to `nowMs` (injectable for tests), then evicts. Callers
 * (page.tsx) mirror the result into React state and saveCueStore() it.
 */
export function setCues(store: CueStore, key: string, cues: Cue[], nowMs: number = Date.now()): CueStore {
  const sorted = [...cues].sort((a, b) => a.atSeconds - b.atSeconds);
  const next: CueStore = { ...store, [key]: { cues: sorted, lastTouchedMs: nowMs } };
  return evictOldestTracks(next);
}

// --- Cue-list mutation helpers (operate on a plain Cue[]; caller wraps the
// result with setCues() to persist it against a track key) ---

/** Rehearsal MARK: stamps a new cue at `atSeconds`, defaulting to an unassigned clip action. */
export function addCue(cues: Cue[], atSeconds: number): Cue[] {
  return [...cues, { atSeconds: Math.max(0, atSeconds), action: { type: "clip", file: null } }];
}

/** Assigning an action is the user taking ownership of a cue — clears `suggested` (see Cue's doc comment) even if the cue was seeded from lyrics. */
export function updateCueAction(cues: Cue[], index: number, action: CueAction): Cue[] {
  return cues.map((c, i) => (i === index ? { ...c, action, suggested: undefined } : c));
}

export function deleteCue(cues: Cue[], index: number): Cue[] {
  return cues.filter((_, i) => i !== index);
}

/** Fine-tune nudge (page.tsx's ±250ms buttons) without re-marking — clamped so a cue never goes negative. Fine-tuning a cue is also ownership, so this clears `suggested` too. */
export function nudgeCue(cues: Cue[], index: number, deltaSeconds: number): Cue[] {
  return cues.map((c, i) =>
    i === index ? { ...c, atSeconds: Math.max(0, c.atSeconds + deltaSeconds), suggested: undefined } : c
  );
}

// --- Suggested cues (synced-lyrics pipeline — scripts/suggest-cues.mjs /
// src/data/cue-suggestions.json), seeded into a track's cue list on load
// (see page.tsx's cueKeyA/cueKeyB effects) ---

export interface SuggestedCueInput {
  atSeconds: number;
  label: string;
}

/** One track's committed suggestion entry — src/data/cue-suggestions.json is a Record<cueTrackKey, CueSuggestionEntry>. */
export interface CueSuggestionEntry {
  name: string;
  matchedTitle: string | null;
  matchedArtist: string | null;
  source: "lrclib";
  cues: SuggestedCueInput[];
}

export type CueSuggestionsFile = Record<string, CueSuggestionEntry>;

/**
 * Builds Cue[] from suggested-cue inputs — always an unassigned/inert clip
 * action (file: null) until the user assigns a clip or sing-along, same
 * default addCue() uses for a fresh MARK. `suggested: true` is what makes
 * the cue-list UI render it dashed/distinct (see page.tsx's DeckPanel).
 */
export function buildSuggestedCues(suggestions: SuggestedCueInput[]): Cue[] {
  return suggestions.map((s) => ({
    atSeconds: Math.max(0, s.atSeconds),
    action: { type: "clip", file: null },
    label: s.label,
    suggested: true,
  }));
}

/**
 * Seeds a track's cue list from suggestions ONLY when it has no cues at
 * all — never overwrites anything the user has already marked/assigned.
 * Returns `existingCues` unchanged (same reference) when there's nothing to
 * seed, so callers can cheaply detect a no-op via reference equality rather
 * than re-deriving the same check.
 */
export function seedSuggestedCues(existingCues: Cue[], suggestions: SuggestedCueInput[]): Cue[] {
  if (existingCues.length > 0 || suggestions.length === 0) return existingCues;
  return buildSuggestedCues(suggestions);
}
