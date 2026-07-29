// FX demonstration log — scope addendum (owner request, 2026-07-26): records
// every MANUAL fx/vocal/scratch pad fire (never brain-fired, never
// cue-fired — see src/app/page.tsx's handlePlayFx/handlePlayVocal/
// handleScratchButton, the only call sites that append here) with musical
// context, so the brain can learn the human DJ's own placement style
// (src/lib/brain.ts's SYSTEM_PROMPT reads the summary as
// state.fxDemonstrations). Pattern-matches src/lib/lessons.ts (pure
// summarization) + src/lib/history-store.ts (localStorage read/write,
// guarded against SSR/no-localStorage) but keeps both halves in this one
// file — the log is small/single-purpose enough that splitting it into two
// files isn't worth it. The pure summarizer half has no localStorage/DOM
// dependency, so it's unit-testable without a browser (see
// scripts/check-fx-log.mjs).
const STORAGE_KEY = "djsm.fx-demonstrations";
const LOG_CAP = 200;
const RECENT_SAMPLE_COUNT = 8;
const LAST_QUARTER_THRESHOLD = 0.75;

export interface FxDemonstrationEntry {
  /** SfxName or VocalCategory (or "scratch_<pattern>") — deliberately a plain string, not a shared union, so this module stays decoupled from fx.ts/vocal.ts's types. */
  fx: string;
  trackName: string | null;
  bpm: number | null;
  /** positionSeconds / duration of the live deck at fire time, 0..1. Null if nothing was live. */
  positionFraction: number | null;
  remainingSeconds: number | null;
  tempo: number | null;
  duringTransition: boolean;
  at: number; // Date.now()
}

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

export function loadFxDemonstrations(): FxDemonstrationEntry[] {
  if (!hasLocalStorage()) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveFxDemonstrations(entries: FxDemonstrationEntry[]): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-LOG_CAP)));
  } catch {
    // Best-effort persistence — e.g. storage quota exceeded or disabled. Not fatal.
  }
}

/** Appends one entry (capped to the last LOG_CAP, oldest evicted first) and returns the new full list, for the caller to mirror into a ref. */
export function appendFxDemonstration(entry: FxDemonstrationEntry): FxDemonstrationEntry[] {
  const next = [...loadFxDemonstrations(), entry].slice(-LOG_CAP);
  saveFxDemonstrations(next);
  return next;
}

// ---------------------------------------------------------------------------
// Pure summarization (no localStorage/DOM here — checkable without a browser)
// ---------------------------------------------------------------------------

export interface FxDemonstrationStat {
  fx: string;
  count: number;
  /** Median of the known (non-null) positionFraction samples for this fx. Null if none had a known position. */
  medianPositionFraction: number | null;
  /** Share (0..1) of this fx's fires that happened while a transition was running. */
  shareDuringTransition: number;
  /** Share (0..1) of the fires WITH a known position that landed in the track's last quarter (positionFraction >= 0.75). */
  shareInLastQuarter: number;
}

export interface FxDemonstrationRecent {
  fx: string;
  positionFraction: number | null;
  duringTransition: boolean;
}

export interface FxDemonstrationSummary {
  /** Per-fx aggregate stats, most-fired first (ties broken alphabetically for determinism). */
  byFx: FxDemonstrationStat[];
  /** The most recent RECENT_SAMPLE_COUNT raw fires, newest first, kept compact. */
  recent: FxDemonstrationRecent[];
}

export const EMPTY_FX_DEMONSTRATION_SUMMARY: FxDemonstrationSummary = { byFx: [], recent: [] };

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Aggregates the human DJ's manual fx fires into per-fx stats plus a compact
 * recent-fires sample — deterministic, no Date.now()/randomness (same
 * discipline as lessons.ts's summarizeLessons(), so the same log always
 * summarizes identically).
 */
export function summarizeFxDemonstrations(entries: FxDemonstrationEntry[]): FxDemonstrationSummary {
  if (entries.length === 0) return EMPTY_FX_DEMONSTRATION_SUMMARY;

  const byFxMap = new Map<string, FxDemonstrationEntry[]>();
  for (const entry of entries) {
    const list = byFxMap.get(entry.fx);
    if (list) list.push(entry);
    else byFxMap.set(entry.fx, [entry]);
  }

  const byFx: FxDemonstrationStat[] = Array.from(byFxMap.entries()).map(([fx, group]) => {
    const knownPositions = group.map((e) => e.positionFraction).filter((p): p is number => p !== null);
    const duringTransitionCount = group.filter((e) => e.duringTransition).length;
    const lastQuarterCount = knownPositions.filter((p) => p >= LAST_QUARTER_THRESHOLD).length;
    return {
      fx,
      count: group.length,
      medianPositionFraction: median(knownPositions),
      shareDuringTransition: duringTransitionCount / group.length,
      shareInLastQuarter: knownPositions.length > 0 ? lastQuarterCount / knownPositions.length : 0,
    };
  });

  byFx.sort((a, b) => b.count - a.count || a.fx.localeCompare(b.fx));

  const recent: FxDemonstrationRecent[] = entries
    .slice(-RECENT_SAMPLE_COUNT)
    .reverse()
    .map((e) => ({ fx: e.fx, positionFraction: e.positionFraction, duringTransition: e.duringTransition }));

  return { byFx, recent };
}
