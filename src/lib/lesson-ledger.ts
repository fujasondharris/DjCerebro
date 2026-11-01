// Lesson ledger (part 1 of the lesson-ledger/energy dispatch, 2026-07-28): an
// append-only, localStorage-backed event log of the owner's ratings, notes,
// and manual FX presses, each with track+position context — a richer,
// note/position-carrying sibling to src/lib/lessons.ts's aggregate
// 👍/👎-count summaries (which stay exactly as-is for
// TransitionHistoryPanel's display; this module doesn't replace that read
// path). Pattern-matches src/lib/fx-log.ts (persistence half + a pure
// summarization half in one file, same localStorage guard-and-no-op
// discipline as history-store.ts/crate-store.ts/cost-store.ts) — no
// AudioContext/UI here, unit-testable without a browser (see
// scripts/check-lesson-ledger.mjs).
const STORAGE_KEY = "djsm.lesson-ledger";
const LEDGER_CAP = 500;
// The distilled payload rides the volatile per-request suffix (never the
// cached system/opener blocks — see brain.ts's buildRequestBlocks) on EVERY
// brain call, so it's kept small deliberately.
const GLOBAL_LINE_CAP = 10;
const PER_TRACK_LINE_CAP = 3;
const DISTILLED_CHAR_BUDGET = 1500;

// ---------------------------------------------------------------------------
// Event shapes
// ---------------------------------------------------------------------------

export interface TransitionRatingEvent {
  type: "transition_rating";
  when: string; // ISO string
  fromTrackName: string;
  toTrackName: string;
  transitionType: string;
  durationBars: number;
  clamped: boolean;
  degraded: boolean;
  rating: "up" | "down";
  note?: string;
  /** Where in the OUTGOING track (source-time seconds) the transition fired. */
  outPositionSeconds?: number;
}

export interface FxManualEvent {
  type: "fx_manual";
  when: string;
  fx: string;
  trackId?: string;
  trackName?: string;
  positionSeconds?: number;
  duringTransition: boolean;
}

/** Brain-fired fx — same shape as FxManualEvent, kept as a separate `type` so a manual press (ground truth of owner taste) is never confused with a brain-fired one (context only) when distilling. */
export interface FxBrainEvent {
  type: "fx_brain";
  when: string;
  fx: string;
  trackId?: string;
  trackName?: string;
  positionSeconds?: number;
  duringTransition: boolean;
}

/**
 * M8.2e: a performance move the brain REQUESTED but the engine REFUSED, with the
 * reason. Before this, refusals went only to the on-screen brain log and never
 * synced — so from the ledger alone it was impossible to tell "he never asked for
 * stems" from "he asked and was blocked every time". Owner test 2026-08-16 showed
 * zero stem/fx activity and this event is what makes that diagnosable.
 */
export interface BrainSkipEvent {
  type: "brain_skip";
  when: string;
  /** The action that was refused: "stem_migrate", "loop", "routine", "fx", ... */
  action: string;
  reason: string;
  trackId?: string;
  trackName?: string;
  positionSeconds?: number;
}

export interface VibeNoteEvent {
  type: "vibe_note";
  when: string;
  text: string;
  trackId?: string;
  trackName?: string;
  positionSeconds?: number;
}

export type LessonEvent = TransitionRatingEvent | FxManualEvent | FxBrainEvent | VibeNoteEvent | BrainSkipEvent;

// ---------------------------------------------------------------------------
// Persistence (append-only, capped) — guard-and-no-op pattern, same as every
// other localStorage-backed module in src/lib/.
// ---------------------------------------------------------------------------

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

export function loadLedger(): LessonEvent[] {
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

export function saveLedger(events: LessonEvent[]): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-LEDGER_CAP)));
  } catch {
    // Best-effort persistence — e.g. storage quota exceeded or disabled. Not fatal.
  }
}

/** Dedupe key for merge (import, seed-file loading): a real duplicate is the same type at the same instant. */
function eventKey(event: LessonEvent): string {
  return `${event.type}|${event.when}`;
}

/**
 * Merges `incoming` into `existing`, deduping by type+when (first-seen
 * wins), then caps to LEDGER_CAP (oldest dropped) — used both for the
 * committed src/data/lessons-seed.json merge at load and for the
 * LessonsPanel's "Import" file input. Pure; callers persist the result.
 */
export function mergeLedgerEvents(existing: LessonEvent[], incoming: LessonEvent[]): LessonEvent[] {
  const seen = new Set(existing.map(eventKey));
  const merged = [...existing];
  for (const event of incoming) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged.slice(-LEDGER_CAP);
}

/** Appends one event (capped, oldest evicted first) and returns the new full list, for the caller to mirror into React state/a ref. */
export function appendLedgerEvent(event: LessonEvent): LessonEvent[] {
  const next = [...loadLedger(), event].slice(-LEDGER_CAP);
  saveLedger(next);
  return next;
}

// ---------------------------------------------------------------------------
// Distillation (pure — no localStorage/Date.now here) — turns the raw event
// log into the compact digest that rides every brain request.
// ---------------------------------------------------------------------------

export interface LedgerDigest {
  global: string[];
  perTrack: Record<string, string[]>;
}

export const EMPTY_LEDGER_DIGEST: LedgerDigest = { global: [], perTrack: {} };

function formatMmSs(totalSeconds: number): string {
  const clamped = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** A rated transition, described from the OUTGOING (fromTrack) track's perspective — matches outPositionSeconds' own "where in the outgoing track" convention and the dispatch's own example wording ("blending out"). */
function describeRatingLine(event: TransitionRatingEvent): string {
  const emoji = event.rating === "up" ? "👍" : "👎";
  const positionText = event.outPositionSeconds !== undefined ? ` at ${formatMmSs(event.outPositionSeconds)}` : "";
  const noteText = event.note ? `: '${event.note}'` : "";
  return `rated ${emoji} blending out${positionText} (${event.transitionType})${noteText}`;
}

function describeVibeNoteLine(event: VibeNoteEvent): string {
  const context = event.trackName ? ` (${event.trackName}${event.positionSeconds !== undefined ? ` @${formatMmSs(event.positionSeconds)}` : ""})` : "";
  return `vibe note: '${event.text}'${context}`;
}

/** Groups fx_manual events for one track by fx name, most-fired first, formatted "owner fired <fx> manually at <Ns> (xK)" using the median known position. */
function describeFxManualLines(events: FxManualEvent[]): string[] {
  const byFx = new Map<string, FxManualEvent[]>();
  for (const e of events) {
    const list = byFx.get(e.fx);
    if (list) list.push(e);
    else byFx.set(e.fx, [e]);
  }
  const lines = Array.from(byFx.entries()).map(([fx, group]) => {
    const positions = group.map((e) => e.positionSeconds).filter((p): p is number => p !== undefined);
    const sorted = [...positions].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianPosition = sorted.length === 0 ? null : sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    const positionText = medianPosition !== null ? ` at ${Math.round(medianPosition)}s` : "";
    return { fx, count: group.length, text: `owner fired ${fx} manually${positionText} (x${group.length})` };
  });
  lines.sort((a, b) => b.count - a.count || a.fx.localeCompare(b.fx));
  return lines.map((l) => l.text);
}

/** Fits `lines` under `budget` chars (JSON-stringified cost), dropping from the end (lowest priority, since callers push highest-priority first) until it fits. */
function trimToBudget(lines: string[], budget: number): string[] {
  const kept = [...lines];
  while (kept.length > 0 && JSON.stringify(kept).length > budget) {
    kept.pop();
  }
  return kept;
}

/**
 * Distills the raw event log into a compact digest for the brain: `global`
 * (≤10 lines, cross-cutting signal — rated transitions WITH a note, then
 * recent vibe notes, most-recent-and-highest-signal first) and `perTrack`
 * (≤3 lines per candidate track — that track's own manual fx demonstrations
 * plus any rating note attached to it as the outgoing track). Deterministic
 * given the same inputs (no Date.now()/randomness — matches lessons.ts's own
 * discipline). Total payload kept under ~DISTILLED_CHAR_BUDGET chars.
 */
export function distillForBrain(events: LessonEvent[], candidateTracks: { id: string; name: string }[]): LedgerDigest {
  const ratingsWithNotes = events.filter(
    (e): e is TransitionRatingEvent => e.type === "transition_rating" && !!e.note
  );
  const vibeNotes = events.filter((e): e is VibeNoteEvent => e.type === "vibe_note");

  const globalCandidates = [
    ...ratingsWithNotes.map((e) => ({ when: e.when, text: describeRatingLine(e) })),
    ...vibeNotes.map((e) => ({ when: e.when, text: describeVibeNoteLine(e) })),
  ];
  globalCandidates.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0)); // most-recent first
  const global = trimToBudget(
    globalCandidates.slice(0, GLOBAL_LINE_CAP).map((c) => c.text),
    DISTILLED_CHAR_BUDGET
  );

  const perTrack: Record<string, string[]> = {};
  for (const track of candidateTracks) {
    const fxManual = events.filter(
      (e): e is FxManualEvent => e.type === "fx_manual" && (e.trackId === track.id || e.trackName === track.name)
    );
    const ratings = events.filter(
      (e): e is TransitionRatingEvent => e.type === "transition_rating" && e.fromTrackName === track.name
    );
    const lines = [...describeFxManualLines(fxManual), ...ratings.slice(-PER_TRACK_LINE_CAP).map(describeRatingLine)];
    if (lines.length > 0) perTrack[track.id] = lines.slice(0, PER_TRACK_LINE_CAP);
  }

  // Budget enforcement across the whole payload: if global + perTrack
  // together exceed the char budget, trim perTrack tracks (drop the
  // lowest-priority whole track's lines) before ever touching global —
  // global is the cross-cutting signal every request wants, perTrack scales
  // with how many candidates are in the current window.
  let digest: LedgerDigest = { global, perTrack };
  const trackKeys = Object.keys(perTrack);
  let i = trackKeys.length - 1;
  while (JSON.stringify(digest).length > DISTILLED_CHAR_BUDGET && i >= 0) {
    const trimmedPerTrack = { ...digest.perTrack };
    delete trimmedPerTrack[trackKeys[i]];
    digest = { global: digest.global, perTrack: trimmedPerTrack };
    i--;
  }

  return digest;
}

// ---------------------------------------------------------------------------
// UI-facing formatting (still pure — no React/DOM here, just string
// formatting) for LessonsPanel's "recent events" list.
// ---------------------------------------------------------------------------

/** One human-readable line per event, for LessonsPanel's recent-events list. */
export function describeLedgerEvent(event: LessonEvent): string {
  switch (event.type) {
    case "transition_rating":
      return `${describeRatingLine(event)} — ${event.fromTrackName} → ${event.toTrackName}`;
    case "fx_manual":
      return `manual: ${event.fx}${event.trackName ? ` on "${event.trackName}"` : ""}${
        event.positionSeconds !== undefined ? ` @${formatMmSs(event.positionSeconds)}` : ""
      }`;
    case "fx_brain":
      return `El Cerebro: ${event.fx}${event.trackName ? ` on "${event.trackName}"` : ""}${
        event.positionSeconds !== undefined ? ` @${formatMmSs(event.positionSeconds)}` : ""
      }`;
    case "vibe_note":
      return describeVibeNoteLine(event);
    case "brain_skip":
      return `El Cerebro asked for ${event.action} but the engine refused: ${event.reason}${
        event.trackName ? ` (on "${event.trackName}")` : ""
      }`;
  }
}
