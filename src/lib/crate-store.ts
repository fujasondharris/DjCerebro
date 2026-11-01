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
import type { CrateManifestEntry } from "./crate";
import type { GenreSource } from "./music-metadata";

export interface PersistedCrateEntry {
  id: string;
  name: string;
  title?: string | null;
  artist?: string | null;
  genre?: string | null;
  genreSource?: GenreSource;
  size: number | null;
  bpm: number | null;
  key: string | null;
  grid: SeratoBeatgrid | null;
}

/**
 * Drive reuploads change file IDs. Repair saved entries against the current
 * manifest before restoring them to the decks. Only a unique filename match
 * can replace a retired ID; NFKC accounts for the old upload's full-width
 * punctuation (｜/：/＂). Unknown/ambiguous entries remain untouched. Take
 * ALL metadata from the replacement, since its audio may have been trimmed.
 * Old IndexedDB audio is left alone and never relabeled as the new file.
 */
export function reconcileCrateList(
  entries: PersistedCrateEntry[],
  manifest: CrateManifestEntry[],
): { entries: PersistedCrateEntry[]; relinked: number } {
  const currentIds = new Set(manifest.map(entry => entry.id));
  const byName = new Map<string, CrateManifestEntry | null>();
  for (const entry of manifest) {
    const name = entry.name.normalize("NFKC");
    byName.set(name, byName.has(name) ? null : entry);
  }
  const seen = new Set<string>();
  const reconciled: PersistedCrateEntry[] = [];
  let relinked = 0;
  for (const entry of entries) {
    const replacement = currentIds.has(entry.id) ? null : byName.get(entry.name.normalize("NFKC"));
    const current: PersistedCrateEntry = replacement ? {
      id: replacement.id,
      name: replacement.name,
      size: replacement.size ?? null,
      bpm: replacement.bpm ?? null,
      key: replacement.key ?? null,
      grid: replacement.grid ?? null,
      ...(entry.title !== undefined ? { title: entry.title } : {}),
      ...(entry.artist !== undefined ? { artist: entry.artist } : {}),
      ...(entry.genre !== undefined ? { genre: entry.genre } : {}),
      ...(entry.genreSource !== undefined ? { genreSource: entry.genreSource } : {}),
    } : entry;
    if (replacement) relinked++;
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    reconciled.push(current);
  }
  return { entries: reconciled, relinked };
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
