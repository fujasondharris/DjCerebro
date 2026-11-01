// Display-only searching/sorting. Never reorder the engine's crate/index map.
import { resolveMusicMetadata, needsGenreReview, type GenreSource } from "./music-metadata.ts";
export interface SearchableTrack {
  name: string;
  title?: string | null;
  artist?: string | null;
  genre?: string | null;
  genreSource?: GenreSource;
  bpm?: number | null;
}
export const CRATE_SORTS = [
  { value: "original", label: "Crate order" },
  { value: "title", label: "Song name · A–Z" },
  { value: "artist", label: "Artist · A–Z" },
  { value: "genre", label: "Genre · A–Z" },
  { value: "bpm", label: "BPM · low to high" },
] as const;
export type CrateSort = typeof CRATE_SORTS[number]["value"];
export function normalizeSearch(value: string): string {
  return value.normalize("NFKD").replace(new RegExp("\\p{M}", "gu"), "").toLocaleLowerCase()
    .replace(new RegExp("[^\\p{L}\\p{N}]+", "gu"), " ").trim();
}
export function trackSearchMetadata(track: SearchableTrack) {
  return resolveMusicMetadata(track);
}
export function searchAndSortCrate<T extends SearchableTrack>(
  tracks: readonly T[], query: string, genre: string, sort: CrateSort,
): T[] {
  const words = normalizeSearch(query).split(" ").filter(Boolean);
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  const decorated = tracks.map((track, index) => ({ track, index, ...trackSearchMetadata(track) }))
    .filter(item => {
      if (genre === "__untagged" && item.genre) return false;
      if (genre === "__review" && !needsGenreReview(item.track)) return false;
      if (genre && !["__untagged", "__review"].includes(genre) && normalizeSearch(item.genre) !== normalizeSearch(genre)) return false;
      const haystack = normalizeSearch(`${item.track.name} ${item.title} ${item.artist} ${item.genre}`);
      return words.every(word => haystack.includes(word));
    });
  if (sort !== "original") decorated.sort((a, b) => {
    if (sort === "bpm") return (a.track.bpm ?? Infinity) - (b.track.bpm ?? Infinity) || a.index - b.index;
    // Unknown metadata sorts last, even when a track has no filename delimiter.
    if (!a[sort] !== !b[sort]) return a[sort] ? -1 : 1;
    return collator.compare(a[sort], b[sort]) || collator.compare(a.title, b.title) || a.index - b.index;
  });
  return decorated.map(item => item.track);
}
