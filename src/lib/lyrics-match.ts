// Pure logic for the synced-lyrics -> suggested-cue-points pipeline
// (scripts/suggest-cues.mjs writes src/data/cue-suggestions.json, which
// page.tsx seeds into a track's cue list — see src/lib/cue-store.ts's
// buildSuggestedCues/seedSuggestedCues). No network/filesystem here, so
// this is checkable in isolation against real (nasty) crate names — see
// scripts/check-lyrics-match.mjs.
//
// Two independent concerns live in this one small file, same spirit as
// crate.ts/vocal-manifest.ts keeping pure helpers next to their one real
// consumer rather than spreading them across modules:
//   1. Name cleaning + query-variant generation, for turning a messy
//      YouTube-derived crate filename into candidate {artist, title}
//      guesses to try against lrclib.net's search API.
//   2. Synced-lyrics parsing + call-response/ad-lib cue extraction, for
//      turning an lrclib "[mm:ss.xx] line" blob into candidate cue points.

// ---------------------------------------------------------------------------
// 1. Name cleaning + query variants
// ---------------------------------------------------------------------------

export interface NameCleanResult {
  artist: string | null;
  title: string;
}

// Known YouTube/downloader noise phrases, wrapped in either () or [] —
// stripped wherever they appear rather than only at the end, since some
// crate names interleave them mid-string (e.g. "Plakito (Remix)[Official
// Video] ft. ..."). Deliberately does NOT strip "(Remix)" itself — that's
// real title information, not downloader noise.
const NOISE_PATTERNS: RegExp[] = [
  /[([]\s*official\s*(music\s*)?video\s*[)\]]/gi,
  /[([]\s*video\s*oficial\s*[)\]]/gi,
  /[([]\s*(official\s*)?lyric(s)?\s*video\s*[)\]]/gi,
  /[([]\s*official\s*audio\s*[)\]]/gi,
  /[([]\s*audio\s*[)\]]/gi,
  /[([]\s*visualizer\s*[)\]]/gi,
  /[([]\s*explicit\s*[)\]]/gi,
  /[([]\s*letra\s*[)\]]/gi, // Spanish "lyrics" tag, seen in real crate names (e.g. "DtMF (Letra)")
  /[([]\s*live\s*[)\]]/gi,
];

/** Fullwidth punctuation some downloaders/uploaders use in place of ASCII — normalized before the rest of cleaning runs. */
function normalizeFullwidthPunctuation(name: string): string {
  return name.replace(/｜/g, "|").replace(/⧸/g, "/");
}

export function stripExtension(name: string): string {
  return name.replace(/\.[a-z0-9]{2,4}$/i, "");
}

/**
 * Real crate names put an album/playlist tag after a "|" (e.g. "Tití Me
 * Preguntó (Video Oficial) | Un Verano Sin Ti") — everything from the first
 * top-level "|" on is dropped, generalizing the FACTS' "| Album" example.
 */
function truncateAtPipe(name: string): string {
  const idx = name.indexOf("|");
  return idx === -1 ? name : name.slice(0, idx);
}

export function stripNoisePhrases(name: string): string {
  let out = name;
  for (const pattern of NOISE_PATTERNS) out = out.replace(pattern, " ");
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * "Yandel - Yandel - Plakito" (exact dup) and "Zion & Lennox - Zion & Lennox
 * Ft Yandel & Farruko - Pierdo..." (the first segment is a PREFIX of the
 * second, once features are folded in) are both the same downloader habit —
 * repeating the uploader/artist segment before the real "artist - title"
 * pair. Collapses either case by dropping the first segment when the second
 * one starts with it (case-insensitive). Requires at least 3 segments —
 * with only 2, there's nothing to disambiguate, so leaving it alone is
 * safer than guessing.
 */
export function collapseDuplicateLeadingSegment(name: string): string {
  const segments = name
    .split(" - ")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length >= 3 && segments[1].toLowerCase().startsWith(segments[0].toLowerCase())) {
    return segments.slice(1).join(" - ");
  }
  return name;
}

/**
 * Splits on the LAST " - " boundary: everything after it is the title,
 * everything before it (rejoined with " - " if there were multiple) is the
 * artist. For a genuine "Uploader - Artist - Title" name (uploader unrelated
 * to the artist, so collapseDuplicateLeadingSegment above didn't fire) this
 * over-includes the uploader in the "artist" guess — buildQueryVariants()
 * below adds a fallback variant using only the LAST segment of that guess,
 * which is what actually matches lrclib in that case.
 */
export function splitArtistTitle(name: string): NameCleanResult {
  const segments = name
    .split(" - ")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return { artist: null, title: name.trim() };
  if (segments.length === 1) return { artist: null, title: segments[0] };
  const title = segments[segments.length - 1];
  const artist = segments.slice(0, -1).join(" - ");
  return { artist, title };
}

export function cleanTrackName(rawName: string): NameCleanResult {
  const normalized = normalizeFullwidthPunctuation(rawName);
  const noExt = stripExtension(normalized);
  const noPipe = truncateAtPipe(noExt);
  const deNoised = stripNoisePhrases(noPipe);
  const collapsed = collapseDuplicateLeadingSegment(deNoised);
  return splitArtistTitle(collapsed);
}

function stripFeat(artist: string): string {
  return artist.replace(/\s*[,&/]?\s*(feat\.?|ft\.?|featuring)\s+.*/i, "").trim();
}

/** Blunt last-resort: strips every remaining ()/[] group from a title (used only as a low-priority variant). */
function stripAllBrackets(title: string): string {
  return title
    .replace(/[([][^)\]]*[)\]]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export interface QueryVariant {
  artist: string | null;
  title: string;
}

/**
 * Builds candidate {artist, title} guesses to try against lrclib, most-
 * likely-correct first, deduped. See cleanTrackName's doc comments for why
 * more than one guess is needed for the same messy name.
 */
export function buildQueryVariants(clean: NameCleanResult): QueryVariant[] {
  const variants: QueryVariant[] = [];
  const seen = new Set<string>();
  function push(artist: string | null, title: string) {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    const key = `${(artist ?? "").toLowerCase()}|${trimmedTitle.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    variants.push({ artist: artist?.trim() || null, title: trimmedTitle });
  }

  push(clean.artist, clean.title);

  if (clean.artist) {
    const stripped = stripFeat(clean.artist);
    if (stripped && stripped !== clean.artist) push(stripped, clean.title);

    const segments = clean.artist
      .split(" - ")
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length > 1) {
      const last = segments[segments.length - 1];
      push(last, clean.title);
      const lastStripped = stripFeat(last);
      if (lastStripped && lastStripped !== last) push(lastStripped, clean.title);
    }
  }

  const bluntTitle = stripAllBrackets(clean.title);
  if (bluntTitle !== clean.title) push(clean.artist, bluntTitle);

  push(null, clean.title); // combined-query fallback (script sends this as lrclib's q=)

  return variants;
}

// ---------------------------------------------------------------------------
// Similarity + best-match selection
// ---------------------------------------------------------------------------

function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics/combining marks (also cleans up decorative strikethrough-style names)
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** Dice's-coefficient bigram similarity, 0..1. Diacritic/punctuation-insensitive. */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ba = bigrams(na);
  const bb = bigrams(nb);
  if (ba.length === 0 || bb.length === 0) return na.includes(nb) || nb.includes(na) ? 0.8 : 0;
  const counts = new Map<string, number>();
  for (const g of ba) counts.set(g, (counts.get(g) ?? 0) + 1);
  let overlap = 0;
  for (const g of bb) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      overlap++;
      counts.set(g, c - 1);
    }
  }
  return (2 * overlap) / (ba.length + bb.length);
}

export interface LrclibResult {
  trackName: string;
  artistName: string;
  duration?: number | null;
  syncedLyrics?: string | null;
}

/**
 * Picks the best lrclib search result with actual synced lyrics. Verifies
 * against `target.durationSeconds` when the caller has one (an exact-ish
 * duration match beats title similarity — per the dispatch's FACTS); falls
 * back to a title-similarity threshold otherwise (the crate's own Drive
 * listing doesn't carry audio duration without downloading the whole file,
 * so callers without one just don't pass it — this function stays correct
 * for either case rather than assuming duration is always available).
 */
export function pickBestMatch(
  results: LrclibResult[],
  target: { title: string; artist: string | null; durationSeconds?: number | null },
  opts: { similarityThreshold?: number; durationToleranceSeconds?: number } = {}
): LrclibResult | null {
  const threshold = opts.similarityThreshold ?? 0.5;
  const durationTolerance = opts.durationToleranceSeconds ?? 3;

  const withLyrics = results.filter((r) => !!r.syncedLyrics && r.syncedLyrics.trim().length > 0);
  if (withLyrics.length === 0) return null;

  if (target.durationSeconds != null) {
    const closeOnDuration = withLyrics.filter(
      (r) => r.duration != null && Math.abs(r.duration - target.durationSeconds!) <= durationTolerance
    );
    if (closeOnDuration.length > 0) {
      return closeOnDuration.sort(
        (a, b) => titleSimilarity(b.trackName, target.title) - titleSimilarity(a.trackName, target.title)
      )[0];
    }
  }

  const scored = withLyrics
    .map((r) => ({ r, score: titleSimilarity(r.trackName, target.title) }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  return top && top.score >= threshold ? top.r : null;
}

// ---------------------------------------------------------------------------
// 2. Synced-lyrics parsing + call-response/ad-lib cue extraction
// ---------------------------------------------------------------------------

export interface SyncedLine {
  atSeconds: number;
  text: string;
}

const SYNCED_LINE_RE = /^\[(\d{2}):(\d{2})(?:\.(\d{1,2}))?\]\s*(.*)$/;

/** Parses lrclib's "[mm:ss.xx] line" synced-lyrics format. Non-timestamp lines (metadata like [ar:]/[ti:], blank lines) are silently skipped. */
export function parseSyncedLyrics(syncedLyrics: string): SyncedLine[] {
  const lines: SyncedLine[] = [];
  for (const rawLine of syncedLyrics.split(/\r?\n/)) {
    const m = SYNCED_LINE_RE.exec(rawLine.trim());
    if (!m) continue;
    const minutes = parseInt(m[1], 10);
    const seconds = parseInt(m[2], 10);
    const frac = m[3] ? parseInt(m[3].padEnd(2, "0").slice(0, 2), 10) / 100 : 0;
    lines.push({ atSeconds: minutes * 60 + seconds + frac, text: m[4].trim() });
  }
  return lines;
}

/** A line entirely (or almost entirely, once its own parenthetical groups are stripped) wrapped in parens — e.g. "(¿Pa' dónde?)", "(Nueva York)". */
function isMostlyParenthetical(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^\(.*\)$/.test(trimmed)) return true;
  const withoutParens = trimmed.replace(/\([^)]*\)/g, "").trim();
  return withoutParens.length <= 2;
}

export interface ExtractedCue {
  atSeconds: number;
  label: string;
}

export interface ExtractCuesOptions {
  maxCues?: number;
  minStartSeconds?: number;
  maxLabelLength?: number;
}

/**
 * Candidate call-response/ad-lib moments: parenthetical lines, plus lines
 * that are an exact repeat of another line elsewhere (a coro/hook the crowd
 * answers). Capped to ~6, favoring spread across the song (one per
 * time-bucket rather than just the first N chronologically) and skipping
 * anything within `minStartSeconds` of the start (per the dispatch — an
 * intro moment isn't useful as a rehearsed cue).
 */
export function extractCallResponseCues(lines: SyncedLine[], opts: ExtractCuesOptions = {}): ExtractedCue[] {
  const maxCues = opts.maxCues ?? 6;
  const minStartSeconds = opts.minStartSeconds ?? 10;
  const maxLabelLength = opts.maxLabelLength ?? 40;

  const textCounts = new Map<string, number>();
  for (const line of lines) {
    const norm = line.text.trim().toLowerCase();
    if (norm) textCounts.set(norm, (textCounts.get(norm) ?? 0) + 1);
  }

  const candidates: ExtractedCue[] = [];
  for (const line of lines) {
    if (line.atSeconds < minStartSeconds) continue;
    const trimmedText = line.text.trim();
    if (!trimmedText) continue;
    const norm = trimmedText.toLowerCase();
    const parenthetical = isMostlyParenthetical(trimmedText);
    const repeatedElsewhere = (textCounts.get(norm) ?? 0) >= 2;
    if (!parenthetical && !repeatedElsewhere) continue;
    candidates.push({ atSeconds: line.atSeconds, label: trimmedText.slice(0, maxLabelLength) });
  }

  if (candidates.length <= maxCues) return candidates;

  // Spread across the song: one pick per time-bucket, earliest match in
  // each bucket, rather than just the first `maxCues` chronologically.
  const first = candidates[0].atSeconds;
  const last = candidates[candidates.length - 1].atSeconds;
  const span = Math.max(0.001, last - first);
  const bucketSize = span / maxCues;
  const picked: ExtractedCue[] = [];
  for (let i = 0; i < maxCues; i++) {
    const bucketStart = first + i * bucketSize;
    const bucketEnd = i === maxCues - 1 ? last + 0.001 : first + (i + 1) * bucketSize;
    const found = candidates.find(
      (c) => c.atSeconds >= bucketStart && c.atSeconds < bucketEnd && !picked.includes(c)
    );
    if (found) picked.push(found);
  }
  return picked;
}
