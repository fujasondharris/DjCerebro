// Craft pass #2, Part 1 — pure per-track vocal-activity maps derived from
// synced lyrics (scripts/build-vocal-maps.mjs writes src/data/vocal-maps.json,
// same build-time-JSON-import pattern as cue-suggestions.json/vocal-manifest.
// json). No AudioContext/network here — this module only reasons about
// already-computed [start,end] intervals, same "pure src/lib module"
// discipline as energy.ts/beatclock.ts. See src/lib/lyrics-match.ts for the
// synced-lyrics parsing this is built from.
//
// A vocal interval is SOURCE-time seconds (same convention as
// Cue.atSeconds/Deck.positionSeconds/energy.ts's MixPoints) — [start, end).

export type VocalInterval = [number, number];

/** src/data/vocal-maps.json's shape: keyed the same way cue-suggestions.json keys tracks (src/lib/cue-store.ts's cueTrackKey()). */
export type VocalMapFile = Record<string, VocalInterval[]>;

export interface Gap {
  start: number;
  /** `Infinity` for the post-last-vocal outro gap — its true end is unknown without the track's duration, which this module deliberately doesn't carry (see file header). */
  end: number;
}

// --- Building intervals from synced-lyrics lines (scripts/build-vocal-maps.mjs) ---

/** Minimal shape needed from a synced line — decoupled from lyrics-match.ts's SyncedLine so this stays a leaf module (same pattern as energy.ts's MixInCueLike). */
export interface VocalMapLineLike {
  atSeconds: number;
  text: string;
}

export interface BuildVocalIntervalsOptions {
  /** Each line spans [line.time, next line.time), capped at this many seconds. */
  maxLineSpanSeconds?: number;
  /** Two adjacent intervals separated by less than this many seconds are merged into one. */
  mergeGapSeconds?: number;
  /** Interval boundaries are rounded to this many seconds (0.1 = one decimal place). */
  roundToSeconds?: number;
}

const DEFAULT_MAX_LINE_SPAN_SECONDS = 8;
const DEFAULT_MERGE_GAP_SECONDS = 3;
const DEFAULT_ROUND_TO_SECONDS = 0.1;

// Dividing THEN multiplying by a non-power-of-two step (e.g. 0.1) reintroduces
// float error twice (0.1 itself isn't exactly representable) — e.g.
// Math.round(46)*0.1 can print as "4.6000000000000005". Multiplying by the
// step's reciprocal (10 for 0.1, itself exact) before dividing keeps the
// only imprecise operation to a single division, which JS's shortest-
// round-trip number-to-string formatting reliably prints as "4.6".
function roundTo(value: number, step: number): number {
  const scale = 1 / step;
  return Math.round(value * scale) / scale;
}

/**
 * Derives merged vocal-active intervals from a track's synced-lyrics lines:
 * each non-blank line spans from its own timestamp to the next line's
 * timestamp, capped at `maxLineSpanSeconds` (a line's last word doesn't
 * linger forever into an instrumental section); adjacent spans separated by
 * less than `mergeGapSeconds` merge into one continuous interval (treats a
 * quick breath between lines as still "vocal-active", not a real
 * instrumental gap); every boundary is rounded to `roundToSeconds`. Blank
 * (whitespace-only) lines are skipped entirely — they carry no vocal content
 * to mark active. Pure — no network/filesystem.
 */
export function buildVocalIntervalsFromLines(
  lines: VocalMapLineLike[],
  opts: BuildVocalIntervalsOptions = {}
): VocalInterval[] {
  const maxSpan = opts.maxLineSpanSeconds ?? DEFAULT_MAX_LINE_SPAN_SECONDS;
  const mergeGap = opts.mergeGapSeconds ?? DEFAULT_MERGE_GAP_SECONDS;
  const round = opts.roundToSeconds ?? DEFAULT_ROUND_TO_SECONDS;

  const nonBlank = lines.filter((l) => l.text.trim().length > 0).sort((a, b) => a.atSeconds - b.atSeconds);
  if (nonBlank.length === 0) return [];

  const raw: VocalInterval[] = nonBlank.map((line, i) => {
    const next = nonBlank[i + 1];
    const uncappedEnd = next ? next.atSeconds : line.atSeconds + maxSpan;
    const end = Math.min(uncappedEnd, line.atSeconds + maxSpan);
    return [line.atSeconds, end];
  });

  const merged: VocalInterval[] = [raw[0].slice() as VocalInterval];
  for (let i = 1; i < raw.length; i++) {
    const last = merged[merged.length - 1];
    const [s, e] = raw[i];
    if (s - last[1] < mergeGap) {
      last[1] = Math.max(last[1], e);
    } else {
      merged.push([s, e]);
    }
  }

  return merged.map(([s, e]) => [roundTo(s, round), roundTo(e, round)] as VocalInterval);
}

// --- Lookup helpers -----------------------------------------------------

/** A track with no entry (never matched, or matched with zero extractable lines) has no known vocal activity — treated as "no map", not "silent the whole way through": callers should omit the derived DjLiveState/CompactCrateEntry fields entirely rather than reporting false vocal-inactivity. */
export function getVocalIntervals(map: VocalMapFile, key: string): VocalInterval[] {
  return map[key] ?? [];
}

export function hasVocalMap(map: VocalMapFile, key: string): boolean {
  return key in map && map[key].length > 0;
}

// --- Pure interval math ---------------------------------------------------

export function isVocalActive(intervals: VocalInterval[], t: number): boolean {
  return intervals.some(([s, e]) => t >= s && t < e);
}

/** The start of the next vocal interval beginning at/after `t` (skips a currently-active section — this is the NEXT onset, not "now" even if already inside one). Null when there is no such interval. */
export function firstVocalAfter(intervals: VocalInterval[], t: number): number | null {
  let best: number | null = null;
  for (const [s] of intervals) {
    if (s >= t && (best === null || s < best)) best = s;
  }
  return best;
}

/** The end of the vocal interval containing `t`, or null when nothing is active at `t`. */
export function activeVocalEndsAt(intervals: VocalInterval[], t: number): number | null {
  for (const [s, e] of intervals) {
    if (t >= s && t < e) return e;
  }
  return null;
}

/**
 * Instrumental gaps of at least `minGapSeconds`, derived from a track's
 * vocal-active intervals — includes the pre-first-vocal intro gap (if long
 * enough) and always includes the post-last-vocal outro gap (its true end is
 * unknown, i.e. `Infinity`, so it trivially always satisfies any
 * `minGapSeconds` threshold). An empty `intervals` list (no vocal map, or a
 * fully instrumental track) is one big gap covering the whole thing.
 */
export function vocalGaps(intervals: VocalInterval[], minGapSeconds: number): Gap[] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const gaps: Gap[] = [];
  let cursor = 0;
  for (const [s, e] of sorted) {
    if (s - cursor >= minGapSeconds) gaps.push({ start: cursor, end: s });
    cursor = Math.max(cursor, e);
  }
  gaps.push({ start: cursor, end: Infinity });
  return gaps;
}

/** The first gap (from an already-computed, ascending-by-start `gaps` list, e.g. vocalGaps()'s output) that hasn't fully passed yet — its end is after `t`, so `t` may already be inside it. Null if none. */
export function nextGapAtOrAfter(gaps: Gap[], t: number): Gap | null {
  for (const gap of gaps) {
    if (gap.end > t) return gap;
  }
  return null;
}

// --- pickTransitionStart ---------------------------------------------------

/** Clips `intervals` (absolute-domain positions) into a local [0, windowSeconds) frame anchored at `offset` — i.e. interval [s,e] becomes [s-offset, e-offset], clamped to the window. */
function clipIntervalsToWindow(intervals: VocalInterval[], offset: number, windowSeconds: number): VocalInterval[] {
  const out: VocalInterval[] = [];
  for (const [s, e] of intervals) {
    const a = Math.max(0, s - offset);
    const b = Math.min(windowSeconds, e - offset);
    if (b > a) out.push([a, b]);
  }
  return out;
}

/** Total seconds of overlap between two (already-clipped) interval lists. Intervals within each list are assumed non-overlapping (true of merged vocal-map intervals) — a plain double loop is fine at these sizes (a handful of intervals per song per window). */
function intervalListOverlapSeconds(a: VocalInterval[], b: VocalInterval[]): number {
  let total = 0;
  for (const [as, ae] of a) {
    for (const [bs, be] of b) {
      const start = Math.max(as, bs);
      const end = Math.min(ae, be);
      if (end > start) total += end - start;
    }
  }
  return total;
}

/**
 * Picks the candidate transition-start time (one of `candidates`, e.g.
 * upcoming phrase-boundary OUTPUT-time delays-from-now — see
 * src/lib/phrase.ts's nextPhraseBoundaries) that minimizes simultaneous
 * vocal-vocal overlap during the `blendSeconds` window that follows it.
 *
 * For candidate `c`: the LIVE track's own vocal-map is evaluated over
 * [liveOffsetSeconds + c*liveTempo, liveOffsetSeconds + c*liveTempo +
 * blendSeconds] (it keeps playing continuously). `c` is an OUTPUT-time
 * (wall-clock) delay while liveIntervals/liveOffsetSeconds are SOURCE-time
 * (Deck.positionSeconds' own convention) — `liveTempo` converts the delay
 * to the equivalent source-time distance (source = output * tempo, the
 * inverse of phrase.ts's own output = source / tempo). Choir round #2 (P7)
 * fix: `liveTempo` defaults to 1 (the prior, undocumented-as-a-parameter
 * behavior) so a caller that omits it keeps evaluating candidates as if
 * tempo were ~1 — acceptable at tempo===1 exactly, but a real bug at any
 * other tempo (drifts by up to |1-tempo|, bounded to this app's own ±8%
 * sync range — small, but a free, real fix once named). blendSeconds
 * itself is still evaluated in wall-clock terms unconverted.
 *
 * The INCOMING track starts fresh at `incomingStartSeconds` the moment the
 * transition fires, so its own window is
 * [incomingStartSeconds, incomingStartSeconds + blendSeconds] regardless of
 * which candidate is chosen.
 *
 * Ties -> earliest: `candidates` is expected in ascending/chronological
 * order (true of nextPhraseBoundaries' output) and this uses a strict `<`
 * comparison, so the first candidate reaching the lowest overlap wins.
 * Returns `candidates[0]` (0 if even that's missing) when `candidates` is
 * empty — defensive; callers shouldn't call this with no candidates.
 */
export function pickTransitionStart(
  candidates: number[],
  blendSeconds: number,
  liveIntervals: VocalInterval[],
  liveOffsetSeconds: number,
  incomingIntervals: VocalInterval[],
  incomingStartSeconds: number,
  liveTempo: number = 1
): number {
  if (candidates.length === 0) return 0;

  const safeLiveTempo = Number.isFinite(liveTempo) && liveTempo > 0 ? liveTempo : 1;
  const incomingLocal = clipIntervalsToWindow(incomingIntervals, incomingStartSeconds, blendSeconds);

  let best = candidates[0];
  let bestOverlap = Infinity;
  for (const c of candidates) {
    const liveLocal = clipIntervalsToWindow(liveIntervals, liveOffsetSeconds + c * safeLiveTempo, blendSeconds);
    const overlap = intervalListOverlapSeconds(liveLocal, incomingLocal);
    if (overlap < bestOverlap) {
      bestOverlap = overlap;
      best = c;
    }
  }
  return best;
}
