// localStorage-backed persistence for the transition-rating feedback loop
// (Milestone 4 Part D) — the write/read side that src/lib/lessons.ts's pure
// summarizeLessons() then consumes. UI-free (no React), but — unlike the
// rest of src/lib/ — genuinely browser-only (localStorage). Every function
// here guards against localStorage being unavailable (SSR/build-time
// import, or a check-*.mjs script importing this file under Node) by
// no-op'ing rather than throwing, same defensive spirit as AudioCore's
// browser-only APIs.
import type { TransitionRecord } from "./lessons";

const STORAGE_KEY = "djsm.transitions";
const HISTORY_CAP = 200;

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

export function loadTransitionRecords(): TransitionRecord[] {
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

export function saveTransitionRecords(records: TransitionRecord[]): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-HISTORY_CAP)));
  } catch {
    // Best-effort persistence — e.g. storage quota exceeded or disabled. Not fatal.
  }
}

/** Appends one record (capped to the last HISTORY_CAP) and returns the new full list, for the caller to mirror into React state. */
export function appendTransitionRecord(record: TransitionRecord): TransitionRecord[] {
  const next = [...loadTransitionRecords(), record].slice(-HISTORY_CAP);
  saveTransitionRecords(next);
  return next;
}

/** Finds the record by `when` and updates its rating/note, returning the new full list. No-op (returns the unchanged list) if `when` isn't found. */
export function updateTransitionRecordRating(
  when: number,
  rating: "up" | "down" | null,
  note: string | null
): TransitionRecord[] {
  const records = loadTransitionRecords();
  const next = records.map((r) => (r.when === when ? { ...r, rating, note } : r));
  saveTransitionRecords(next);
  return next;
}
