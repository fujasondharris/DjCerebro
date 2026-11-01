import { meaningfulGenre, musicKey, resolveMusicMetadata, type MetadataTrack } from "./music-metadata.ts";

const GENRES = ["salsa", "bachata", "reggaeton", "merengue", "dembow", "cubaton", "hip hop", "latin trap", "house", "trance", "reggae", "rock", "cumbia", "plena", "afrobeats"];
export interface GenreRequest { include: string[]; exclude: string[] }
// Conservative, deterministic request parser. Complex prose stays with the
// model; a bare mention/question/critique is not an engine-level prohibition.
export function parseGenreRequest(text: string): GenreRequest | null {
  const value = musicKey(text).replace(/\breg+a?e?t+o+n\b/g, "reggaeton");
  if (/\b(all genres|any genre|open format|clear genre|anything you want)\b/.test(value)) return { include: [], exclude: [] };
  if (/\b(why|what|wrong|isnt|is not|isn t|instead of)\b/.test(value)) return null;
  const include: string[] = [], exclude: string[] = [];
  for (const genre of GENRES) {
    const pattern = new RegExp(`\\b${genre}\\b`, "g");
    for (const match of Array.from(value.matchAll(pattern))) {
      const before = value.slice(0, match.index);
      const negative = /\b(no|not|avoid|without|skip|dont play|don t play)\s+(?:any\s+)?$/.test(before)
        || /\b(no|not|avoid|without|skip|dont play|don t play)\s+(?:salsa|bachata|reggaeton|house|trance)(?:\s+(?:and|or)\s+(?:salsa|bachata|reggaeton|house|trance))*\s+(?:and|or)\s+$/.test(before);
      (negative ? exclude : include).push(genre);
    }
  }
  return include.length || exclude.length ? { include: Array.from(new Set(include)), exclude: Array.from(new Set(exclude)) } : null;
}
export function genreAllowed(genre: string | null | undefined, request: GenreRequest | null): boolean {
  if (!request) return true;
  const tags = meaningfulGenre(genre).split(/\s*[/;,]\s*/).map(musicKey);
  if (!tags.some(Boolean) && (request.include.length || request.exclude.length)) return false;
  if (request.exclude.some(g => tags.includes(g))) return false;
  return !request.include.length || request.include.some(g => tags.includes(g));
}
export function isPartnerDanceTrack(track: MetadataTrack): boolean {
  return /\b(salsa|bachata|merengue)\b/.test(musicKey(resolveMusicMetadata(track).genre));
}
export function requestsPerformanceMix(text: string | null | undefined): boolean {
  if (!text || /\b(no|without|avoid|stop)\s+(?:stems?|loops?|mixing|blending)\b/i.test(text)) return false;
  return /\b(stems?|loops?|sampling|sample|blend|mixing|no gaps|without breaks|nonstop|skills?|efx|fx|effects?|lead[\s-]?ins?|demo|showcase)\b/i.test(text);
}
export function recipeGapNeedsBlend(live: MetadataTrack, incoming: MetadataTrack, explicitMix: boolean): boolean {
  return explicitMix || (!isPartnerDanceTrack(live) && !isPartnerDanceTrack(incoming));
}
/** Recovery is allowed to pick a known-genre ordinary handoff when the old
 * precomputed top-five recipes contain no requested genre. Never fall back to
 * unrelated music just because the cloud is down. Full crate order stays fixed. */
export function genreRecoveryTrack<T extends MetadataTrack & { id: string; bpm: number | null }>(
  tracks: readonly T[], liveId: string, recentIds: ReadonlySet<string>, request: GenreRequest | null, liveBpm: number | null,
): T | null {
  if (!request || (!request.include.length && !request.exclude.length)) return null;
  const eligible = tracks.filter(t => t.id !== liveId && !recentIds.has(t.id) && t.bpm && genreAllowed(resolveMusicMetadata(t).genre, request));
  const distance = (t: T) => liveBpm && t.bpm ? Math.min(...[1, 2, .5].map(m => Math.abs(t.bpm! * m - liveBpm) / liveBpm)) : 0;
  return eligible.sort((a, b) => distance(a) - distance(b))[0] ?? null;
}
