// localStorage-backed persistence for the Drive crate's METADATA list (the
// lazy-crate architecture — see CLAUDE_STATE.md). Same defensive pattern as
// history-store.ts/cost-store.ts: no-ops rather than throwing when
// localStorage is unavailable (SSR/build-time import, or a check-*.mjs
// script importing this file under Node).
//
// Only Drive-sourced entries persist — local file-picker entries hold an
// in-memory File that can't survive a reload anyway (per the dispatch, that
// stays unchanged/in-memory-only behavior), so there is nothing honest to
// restore for them. What DOES survive a reload: id/name/size/bpm/key/grid —
// never a file Blob (that's the point of the lazy-crate redesign; the full
// audio bytes live in IndexedDB via track-cache.ts, addressed by id, not
// duplicated into localStorage).
import type { SeratoBeatgrid } from "./serato";

export interface PersistedCrateEntry {
  id: string;
  name: string;
  size: number | null;
  bpm: number | null;
  key: string | null;
  grid: SeratoBeatgrid | null;
}

const STORAGE_KEY = "djsm.crate-metadata";

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

export function loadCrateList(): PersistedCrateEntry[] {
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

export function saveCrateList(entries: PersistedCrateEntry[]): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Best-effort persistence — e.g. storage quota exceeded or disabled. Not fatal.
  }
}
