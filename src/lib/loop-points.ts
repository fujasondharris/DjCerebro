// M7 Phase 1, part B — recurring-pattern (loopable range) and drop detection
// from the per-band, per-beat energy band-energy.ts produces. Pure functions
// only: numbers in, numbers out, no AudioContext and no filesystem, verified
// by scripts/check-loop-points.mjs.
//
// The craft rule this encodes (GOAL-M7.md Phase 1, owner's correction
// 2026-07-30): a band-isolated loop only sounds intentional when the bars
// being looped ARE the song's recurring hook. A filter strip on an arbitrary
// 4 bars sounds thin. The melody is visible in the EQ/energy data, so the
// job here is to find the bar range that already repeats, is vocal-free, and
// holds steady energy — then say which band-isolation mode suits it.
//
// Everything is expressed in BARS on the real grid, never in seconds, per
// PRINCIPLE 5 ("quantize to bars, never to seconds"). Candidate ranges start
// on 4-bar (16-beat) PHRASE boundaries so that loop-blend.ts's planLoopBlend
// — which snaps its capture to exactly those boundaries — can use one
// verbatim without re-snapping it somewhere else.
import type { BeatBandEnergy } from "./band-energy";
import type { VocalInterval } from "./vocal-map";

export const BEATS_PER_BAR = 4;
/** A phrase is 16 beats = 4 bars — the same convention energy.ts/phrase.ts/loop-blend.ts already use. */
export const BARS_PER_PHRASE = 4;

export interface BandVector {
  low: number;
  mid: number;
  high: number;
}

export interface BarEnergy extends BandVector {
  /** Bar index within this track's measured range (0 = first whole anchor-aligned bar). */
  barIndex: number;
  /** SOURCE-seconds start of the bar. */
  startSeconds: number;
  /** SOURCE-seconds end of the bar. */
  endSeconds: number;
}

/**
 * Folds per-beat band energy into per-BAR band energy, starting at the first
 * real PHRASE line (anchor-relative beat index divisible by 16). Leading
 * beats before it are dropped rather than folded into a misaligned "bar" —
 * an off-by-one here would make every downstream comparison compare half of
 * one bar against half of another.
 *
 * Why phrase-aligned and not merely bar-aligned (choir round #3, finding 3):
 * `barIndex` is an index into the RETURNED array, and both downstream
 * detectors treat index 0 as a phrase start — findLoopCandidates steps
 * `start += 4` bars from 0, detectDrops steps boundaries by 4 bars from 0.
 * If bars[0] sat on a bar line that was NOT a phrase line (e.g. a grid whose
 * anchor is 2 beats before the file start), every emitted candidate would be
 * offset from a true phrase boundary — and planHeldLoop, which snaps its
 * capture to a real 16-beat phrase line, would then loop a DIFFERENT range
 * than the one the detector picked. That silently breaks the whole premise
 * that the hold loops the detected hook. Starting the fold on a phrase line
 * makes array index 0 a phrase line by construction, so every downstream
 * "every 4 bars" step lands on a genuine phrase boundary.
 */
export function beatsToBars(perBeat: BeatBandEnergy, beatsPerBar: number = BEATS_PER_BAR): BarEnergy[] {
  if (beatsPerBar <= 0) return [];
  const count = perBeat.beatSeconds.length;
  const phraseBeats = beatsPerBar * BARS_PER_PHRASE;
  // Offset into the measured beats at which the first real PHRASE line falls.
  let offset = 0;
  while (offset < count && (perBeat.firstBeatIndex + offset) % phraseBeats !== 0) offset++;

  // Beat length from the measured grid itself (beats are evenly spaced by
  // construction in computeBandEnergyPerBeat). With fewer than 2 beats there
  // is no whole bar to emit anyway, so the loop below never runs.
  if (count < 2) return [];
  const beatLength = perBeat.beatSeconds[1] - perBeat.beatSeconds[0];

  const bars: BarEnergy[] = [];
  for (let start = offset; start + beatsPerBar <= count; start += beatsPerBar) {
    let low = 0;
    let mid = 0;
    let high = 0;
    for (let i = start; i < start + beatsPerBar; i++) {
      low += perBeat.low[i];
      mid += perBeat.mid[i];
      high += perBeat.high[i];
    }
    bars.push({
      barIndex: bars.length,
      startSeconds: perBeat.beatSeconds[start],
      endSeconds: perBeat.beatSeconds[start] + beatLength * beatsPerBar,
      low: low / beatsPerBar,
      mid: mid / beatsPerBar,
      high: high / beatsPerBar,
    });
  }
  return bars;
}

/** Value at percentile `p` (0..1) of an already-unsorted numeric list. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Per-band normalization against the track's OWN 90th-percentile level, so
 * comparisons are about shape ("is this the same pattern?") rather than
 * absolute loudness, and a quiet mastering job doesn't score differently
 * from a loud one. Values are clipped to [0, 1.5] — a hard transient can sit
 * above the 90th percentile, and letting it run away would dominate the
 * distance metric.
 */
export function normalizeBars(bars: BarEnergy[]): BarEnergy[] {
  const refLow = percentile(bars.map((b) => b.low), 0.9) || 1;
  const refMid = percentile(bars.map((b) => b.mid), 0.9) || 1;
  const refHigh = percentile(bars.map((b) => b.high), 0.9) || 1;
  const clip = (v: number) => Math.min(1.5, Math.max(0, v));
  return bars.map((b) => ({
    ...b,
    low: clip(b.low / refLow),
    mid: clip(b.mid / refMid),
    high: clip(b.high / refHigh),
  }));
}

/** Mean absolute per-band difference between two NORMALIZED bars (0 = identical). */
export function barDistance(a: BandVector, b: BandVector): number {
  return (Math.abs(a.low - b.low) + Math.abs(a.mid - b.mid) + Math.abs(a.high - b.high)) / 3;
}

/** Mean bar-to-bar distance between two equal-length NORMALIZED windows. */
export function windowDistance(bars: BarEnergy[], startA: number, startB: number, length: number): number {
  let total = 0;
  for (let i = 0; i < length; i++) total += barDistance(bars[startA + i], bars[startB + i]);
  return total / length;
}

export type IsolationMode = "beat" | "melody";

/**
 * Which band-isolation mode suits a range, per GOAL-M7.md Phase 2's two
 * modes: "beat" (kill high+mid, leaving drums/low) when the range's energy
 * leans low, "melody" (kill low, keeping tops without the bassline) when it
 * leans mid/high. Ties go to "beat" — a drum-led hold is the safer of the
 * two to hold alone for 30 seconds, since it can't strand a melody in a key
 * the incoming track disagrees with.
 */
export function suggestIsolationMode(mean: BandVector): IsolationMode {
  const total = mean.low + mean.mid + mean.high;
  if (total <= 0) return "beat";
  const lowShare = mean.low / total;
  const topShare = (mean.mid + mean.high) / total;
  return lowShare >= topShare ? "beat" : "melody";
}

/** True when [startSeconds, endSeconds) overlaps no vocal interval at all. */
export function isRangeVocalFree(intervals: VocalInterval[], startSeconds: number, endSeconds: number): boolean {
  return !intervals.some(([s, e]) => s < endSeconds && e > startSeconds);
}

export interface LoopCandidate {
  /** Bar index (into the bars array) where the loopable range starts — always on a 4-bar phrase boundary. */
  startBar: number;
  lengthBars: number;
  startSeconds: number;
  endSeconds: number;
  /** How many times this pattern occurs in the track, including itself (>= 2 by construction). */
  repeats: number;
  /** Mean similarity (0..1) across the matched occurrences; 1 = identical. */
  similarity: number;
  /** 0..1, how steady total energy is across the range (1 = flat). */
  stability: number;
  /** 0..1, the range's mean energy relative to the track's own 90th-percentile level. Low = a fade or a breakdown, not a hook. */
  loudness: number;
  isolation: IsolationMode;
  /**
   * True only when a vocal map was available AND no vocal overlaps the range.
   * A track with no vocal map reports false, never a free "vocal-free" pass —
   * "we don't know" must not read the same as "we checked and it's clear".
   */
  vocalFree: boolean;
  /**
   * M8.2k — the vocal-map's original verdict, kept for provenance once vocalFree has
   * been re-derived from the vocals STEM by scripts/verify-loop-points.mjs. The lyric
   * map missed Ozuna's entire 34s sung intro on "Unica" (called 0-20s vocal-free; the
   * stem has vocals at -17 dB from 0s), and the picker looped four bars of a cappella.
   */
  lyricVocalFree?: boolean;
  /**
   * M8.2k — true only when the DRUMS STEM is audibly present across the range. A loop
   * needs the beat, not just the absence of vocals: a beatless vocal-free range is a
   * pad, not a hook. Undefined = not yet verified against stems; the picker treats
   * that as NOT present (fail closed) unless told otherwise.
   */
  beatPresent?: boolean;
  score: number;
}

export interface FindLoopOptions {
  /** Capture lengths to search, in bars. Default [4, 8, 2] — the selectable captures Phase 2 needs. */
  lengthsBars?: number[];
  /** Max candidates returned (non-overlapping, best first). Default 3. */
  maxCandidates?: number;
  /** A window pair counts as a repeat at or above this similarity. Default 0.82. */
  similarityThreshold?: number;
  /**
   * Minimum `loudness` for a range to qualify at all. Default 0.45.
   *
   * This is a correctness guard, not a taste knob: a fade-out or a near-
   * silent passage normalizes to ~0 in every band, so every such bar is
   * trivially "identical" to every other one — which reads as a
   * high-similarity, high-stability, many-repeats pattern and outranks the
   * real hook. Measured on the crate before this filter existed, the top
   * candidate for several tracks sat at 94-97% of the duration with
   * stability 0.99+: the fade, not the song.
   */
  minLoudness?: number;
  /** Vocal-active intervals for this track, in SOURCE-seconds. Empty when no map exists — pass `hasVocalMap: false` in that case. */
  vocalIntervals?: VocalInterval[];
  /** Whether `vocalIntervals` came from a real vocal map. Default false (unknown). */
  hasVocalMap?: boolean;
}

const DEFAULT_LENGTHS_BARS = [4, 8, 2];
const DEFAULT_MAX_CANDIDATES = 3;
const DEFAULT_SIMILARITY_THRESHOLD = 0.82;
const DEFAULT_MIN_LOUDNESS = 0.45;
/**
 * Absolute floor, same value and meaning as energy.ts's SILENCE_FLOOR: a
 * track whose own 90th-percentile bar energy is below this has no real
 * signal at all. `minLoudness` cannot catch this case because normalizeBars
 * scales against the track's OWN level by design — under uniform near-
 * silence every bar normalizes to 1.0 and looks maximally loud. The two
 * guards answer different questions: minLoudness = "is this passage quiet
 * FOR THIS TRACK" (the fade), SILENCE_FLOOR = "is there anything here at
 * all".
 */
const SILENCE_FLOOR = 1e-4;
/** Reference for the length preference below: 8 bars scores 1.0, 4 scores 2/3, 2 scores 1/3. */
const LENGTH_SCORE_REFERENCE = 3; // log2(8)

/**
 * Ranks loopable ranges: a range that repeats elsewhere in the track (>= 2
 * occurrences), holds steady energy, and — where we know — carries no vocal.
 *
 * Method (bar-level self-similarity, GOAL-M7.md Phase 1): normalize bars
 * per band against the track's own level, then for every phrase-aligned
 * start and each candidate length, compare that window against every other
 * non-overlapping phrase-aligned window of the same length. Windows within
 * `similarityThreshold` count as occurrences of the same pattern.
 *
 * Returned candidates never overlap each other in time, so a caller can use
 * all of them across one play-through without looping the same bars twice.
 */
export function findLoopCandidates(bars: BarEnergy[], options: FindLoopOptions = {}): LoopCandidate[] {
  const lengths = options.lengthsBars ?? DEFAULT_LENGTHS_BARS;
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const minLoudness = options.minLoudness ?? DEFAULT_MIN_LOUDNESS;
  const vocalIntervals = options.vocalIntervals ?? [];
  const hasVocalMap = options.hasVocalMap ?? false;

  if (bars.length < 4) return [];
  // No real signal anywhere -> no pattern to find. Checked on the RAW bars,
  // before normalization erases the absolute level (see SILENCE_FLOOR).
  if (percentile(bars.map((b) => b.low + b.mid + b.high), 0.9) < SILENCE_FLOOR) return [];
  const norm = normalizeBars(bars);

  const all: LoopCandidate[] = [];
  for (const lengthBars of lengths) {
    if (lengthBars <= 0 || lengthBars > bars.length) continue;
    for (let start = 0; start + lengthBars <= bars.length; start += BARS_PER_PHRASE) {
      const sims: number[] = [];
      for (let other = 0; other + lengthBars <= bars.length; other += BARS_PER_PHRASE) {
        if (other === start) continue;
        // Non-overlapping only: two windows sharing bars are trivially
        // similar and would inflate `repeats` without the pattern actually
        // recurring anywhere.
        if (Math.abs(other - start) < lengthBars) continue;
        const similarity = 1 - windowDistance(norm, start, other, lengthBars);
        if (similarity >= threshold) sims.push(similarity);
      }
      if (sims.length === 0) continue; // repeats would be 1 — not a recurring pattern

      const normSlice = norm.slice(start, start + lengthBars);
      const loudness = Math.min(
        1,
        normSlice.reduce((s, b) => s + (b.low + b.mid + b.high) / 3, 0) / lengthBars
      );
      // Hard filter, applied BEFORE anything else is computed: a fade or a
      // near-silent passage is self-similar to itself and would otherwise
      // dominate the ranking. See minLoudness' own comment.
      if (loudness < minLoudness) continue;

      const slice = bars.slice(start, start + lengthBars);
      const mean: BandVector = {
        low: slice.reduce((s, b) => s + b.low, 0) / lengthBars,
        mid: slice.reduce((s, b) => s + b.mid, 0) / lengthBars,
        high: slice.reduce((s, b) => s + b.high, 0) / lengthBars,
      };
      const totals = slice.map((b) => b.low + b.mid + b.high);
      const meanTotal = totals.reduce((s, v) => s + v, 0) / lengthBars;
      const variance = totals.reduce((s, v) => s + (v - meanTotal) ** 2, 0) / lengthBars;
      const stability = meanTotal > 0 ? Math.max(0, 1 - Math.sqrt(variance) / meanTotal) : 0;

      const startSeconds = bars[start].startSeconds;
      const endSeconds = bars[start + lengthBars - 1].endSeconds;
      const vocalFree = hasVocalMap && isRangeVocalFree(vocalIntervals, startSeconds, endSeconds);

      const similarity = sims.reduce((s, v) => s + v, 0) / sims.length;
      const repeats = sims.length + 1;

      // Longer captures are preferred when they repeat just as convincingly.
      // Without this, the shortest length always wins — a 2-bar window
      // averages fewer bar-to-bar differences, so it scores higher
      // similarity on the same music, and the first crate-wide run picked a
      // 2-bar loop for every single track. Musically that is backwards: the
      // research's move is a 4- or 8-bar loop that then HALVES into the
      // drop (GOAL-M7.md Phase 2), so the detector should hand Phase 2 the
      // longest range that genuinely recurs and let the halving shorten it.
      const lengthScore = Math.min(1, Math.log2(lengthBars) / LENGTH_SCORE_REFERENCE);

      // Weights: similarity and repetition carry the "is this actually the
      // hook" signal; length prefers a full musical statement over a
      // fragment; stability keeps a range from straddling a section change
      // mid-loop; loudness breaks ties toward a range with something in it.
      // Vocal presence is a flat penalty rather than a hard filter so a
      // track whose only repeating pattern sits under a vocal still emits a
      // (correctly de-ranked, honestly labelled) candidate.
      const score =
        0.35 * similarity +
        0.2 * Math.min(repeats, 4) / 4 +
        0.2 * lengthScore +
        0.15 * stability +
        0.1 * loudness -
        (vocalFree ? 0 : 0.2);

      all.push({
        startBar: start,
        lengthBars,
        startSeconds,
        endSeconds,
        repeats,
        similarity,
        stability,
        loudness,
        isolation: suggestIsolationMode(mean),
        vocalFree,
        score,
      });
    }
  }

  all.sort((a, b) => b.score - a.score);
  const picked: LoopCandidate[] = [];
  for (const candidate of all) {
    if (picked.length >= maxCandidates) break;
    const overlaps = picked.some(
      (p) => candidate.startSeconds < p.endSeconds && candidate.endSeconds > p.startSeconds
    );
    if (!overlaps) picked.push(candidate);
  }
  return picked;
}

export interface DropPoint {
  /** SOURCE-seconds of the drop — always a bar line on the real grid. */
  atSeconds: number;
  barIndex: number;
  /** Energy ratio after/before across the boundary (higher = a bigger jump). */
  strength: number;
  /** 16 beats before the drop — the research's cue placement. Null if that lands before the start of the track. */
  entry16Seconds: number | null;
  /** 32 beats before the drop. Null if that lands before the start of the track. */
  entry32Seconds: number | null;
}

export interface DetectDropsOptions {
  /** Bars either side of the boundary to compare. Default 4 (one phrase). */
  windowBars?: number;
  /**
   * Minimum after/before energy ratio to call it a drop. Default 1.3,
   * measured against this crate rather than guessed: across the 321
   * analyzable tracks the best boundary strength has median 1.52 (p25 1.24,
   * p75 2.00), so the initial 1.6 sat ABOVE the median and left 55% of the
   * crate with no drop at all. 1.3 covers ~70% of tracks at ~1.3 drops each
   * while still demanding a clear lift. Note this crate is Latin/open-format,
   * not EDM: the detected event is "the beat kicks back in on a phrase line
   * with the low end returning", which is the genre's equivalent of a drop
   * and the right place to aim a mid-track entry. Every drop carries its
   * measured `strength`, so a consumer that wants only the big ones filters
   * on that — this detector reports, it does not set policy.
   */
  minStrength?: number;
  /** Max drops returned. Default 4. */
  maxDrops?: number;
  /** Minimum spacing between reported drops, in bars. Default 16. */
  minSpacingBars?: number;
}

const DEFAULT_DROP_WINDOW_BARS = 4;
const DEFAULT_MIN_STRENGTH = 1.3; // see DetectDropsOptions.minStrength — measured against the crate, not guessed
const DEFAULT_MAX_DROPS = 4;
const DEFAULT_MIN_SPACING_BARS = 16;

/**
 * Drop detection: a large band-energy jump ON a phrase boundary, per
 * GOAL-M7.md Phase 1. Compares the phrase before against the phrase after
 * each phrase line and keeps the boundaries where energy jumps by at least
 * `minStrength`, with the low band actually returning (a drop is where the
 * bass comes back — a jump made only of hi-hats is a build, not a drop) and
 * the post-drop level at or above the track's median.
 *
 * `bpm` is used only to place the 16- and 32-beats-before entry points the
 * research prescribes; it must be the same grid BPM the bars were measured
 * against.
 */
export function detectDrops(bars: BarEnergy[], bpm: number, options: DetectDropsOptions = {}): DropPoint[] {
  const windowBars = options.windowBars ?? DEFAULT_DROP_WINDOW_BARS;
  const minStrength = options.minStrength ?? DEFAULT_MIN_STRENGTH;
  const maxDrops = options.maxDrops ?? DEFAULT_MAX_DROPS;
  const minSpacingBars = options.minSpacingBars ?? DEFAULT_MIN_SPACING_BARS;

  if (!Number.isFinite(bpm) || bpm <= 0) return [];
  if (bars.length < windowBars * 2) return [];

  const totals = bars.map((b) => b.low + b.mid + b.high);
  const medianTotal = percentile(totals, 0.5);
  const epsilon = 1e-9;

  const found: DropPoint[] = [];
  // Start at the first PHRASE line that leaves a full `before` window behind
  // it — stepping by BARS_PER_PHRASE from `windowBars` itself would walk
  // off the phrase grid whenever windowBars isn't a multiple of 4, and a
  // "drop" that isn't on a phrase line is not a drop a DJ can mix to.
  const firstBoundary = Math.ceil(windowBars / BARS_PER_PHRASE) * BARS_PER_PHRASE;
  for (let boundary = firstBoundary; boundary + windowBars <= bars.length; boundary += BARS_PER_PHRASE) {
    let beforeTotal = 0;
    let beforeLow = 0;
    let afterTotal = 0;
    let afterLow = 0;
    for (let i = boundary - windowBars; i < boundary; i++) {
      beforeTotal += totals[i];
      beforeLow += bars[i].low;
    }
    for (let i = boundary; i < boundary + windowBars; i++) {
      afterTotal += totals[i];
      afterLow += bars[i].low;
    }
    const strength = (afterTotal + epsilon) / (beforeTotal + epsilon);
    const lowStrength = (afterLow + epsilon) / (beforeLow + epsilon);
    const afterMean = afterTotal / windowBars;
    if (strength < minStrength) continue;
    if (lowStrength < 1.2) continue; // a jump with no bass return is a build, not a drop
    if (afterMean < medianTotal) continue;

    const atSeconds = bars[boundary].startSeconds;
    const beatSeconds = 60 / bpm;
    const entry16 = atSeconds - 16 * beatSeconds;
    const entry32 = atSeconds - 32 * beatSeconds;
    found.push({
      atSeconds,
      barIndex: boundary,
      strength,
      entry16Seconds: entry16 >= 0 ? entry16 : null,
      entry32Seconds: entry32 >= 0 ? entry32 : null,
    });
  }

  found.sort((a, b) => b.strength - a.strength);
  const picked: DropPoint[] = [];
  for (const drop of found) {
    if (picked.length >= maxDrops) break;
    if (picked.some((p) => Math.abs(p.barIndex - drop.barIndex) < minSpacingBars)) continue;
    picked.push(drop);
  }
  picked.sort((a, b) => a.atSeconds - b.atSeconds);
  return picked;
}

// --- The committed data file (src/data/loop-points.json) --------------------

export interface TrackLoopPoints {
  /** The grid BPM the analysis ran against — a consumer must not re-derive positions from a different BPM. */
  bpm: number;
  /** The grid anchor the analysis ran against, SOURCE-seconds. */
  anchor: number;
  durationSeconds: number;
  /** False when no vocal map existed for this track, i.e. every candidate's `vocalFree` is "unknown", not "clear". */
  vocalChecked: boolean;
  loops: LoopCandidate[];
  drops: DropPoint[];
}

/** Keyed by cueTrackKey(), same convention as vocal-maps.json / cue-suggestions.json. */
export type LoopPointsFile = Record<string, TrackLoopPoints>;

export function getLoopPoints(file: LoopPointsFile, key: string): TrackLoopPoints | null {
  return file[key] ?? null;
}

export interface EntryPointOptions {
  /**
   * Prefer entering this many beats before the drop. 32 lands 8 bars out
   * (more room to blend), 16 lands 4 bars out (the drop arrives sooner).
   * Both are the placements the research names explicitly; 32 is the default
   * because it leaves room for a blend to breathe before the payoff.
   */
  preferBeats?: 16 | 32;
  /** Whether the other supported entry distance may be used when the preferred point is unavailable. Default true. */
  allowAlternate?: boolean;
  /** Never enter earlier than this many seconds in — avoids landing at 0s inside untrimmed video intros or beatless pads when a drop is near the top of the file. */
  minEntrySeconds?: number;
  /** Never enter later than this many seconds in — a guard against a drop so late that entering there skips most of the song. */
  maxEntrySeconds?: number;
}

/**
 * Where to ENTER an incoming track, per GOAL-M7.md Phase 4: 16–32 beats
 * before its own drop, so the drop lands shortly after the blend completes.
 *
 * This is sharper than the generic RMS mixIn point energy.ts computes: mixIn
 * answers "where does this track stop being dead air", which on a track with
 * a long musical intro is still minutes before anything happens — exactly
 * Jason's `"didn't omit the long intro"` complaint. A drop-relative entry
 * answers "where do I come in so the payoff lands".
 *
 * Returns null when the track has no detected drop, or when every candidate
 * entry would land before `minEntrySeconds` (default 0) — the caller must then
 * fall back to its existing mixIn behaviour rather than inventing a position.
 */
export function entryPointBeforeDrop(entry: TrackLoopPoints | null, options: EntryPointOptions = {}): number | null {
  if (!entry || entry.drops.length === 0) return null;
  const preferBeats = options.preferBeats ?? 32;
  const allowAlternate = options.allowAlternate ?? true;
  const minEntrySeconds = options.minEntrySeconds ?? 0;
  const maxEntrySeconds = options.maxEntrySeconds ?? Number.POSITIVE_INFINITY;

  // Strongest drop first — a bigger lift is a better thing to aim at.
  const ranked = [...entry.drops].sort((a, b) => b.strength - a.strength);
  for (const drop of ranked) {
    const preferred = preferBeats === 16 ? drop.entry16Seconds : drop.entry32Seconds;
    const fallback = preferBeats === 16 ? drop.entry32Seconds : drop.entry16Seconds;
    for (const candidate of allowAlternate ? [preferred, fallback] : [preferred]) {
      if (candidate === null) continue;
      if (candidate < minEntrySeconds || candidate > maxEntrySeconds) continue;
      return candidate;
    }
  }
  return null;
}

export interface MidTrackEntryOptions {
  /** Minimum seconds into the track to enter (default 16s, or beatInSeconds when higher) so transitions land once the groove is rolling rather than at 0s or over a video skit. */
  minEntrySeconds?: number;
  /** Maximum seconds into the track to enter (default 85s) so at least a full residency remains. */
  maxEntrySeconds?: number;
  /** Preferred beats before a detected drop (default 16). */
  preferBeats?: 16 | 32;
  /** Known drums-stem beat-in point (from beat-in.json), if available. */
  beatInSeconds?: number | null;
}

/**
 * Selects a real human-DJ mid-track entry point (typically 20–75s in, phrase-aligned
 * where the beat/groove is already rolling or 16–32 beats before a real drop),
 * skipping YouTube video skits, crowd intros, and beatless opening pads.
 */
export function selectMidTrackEntryPoint(
  entry: TrackLoopPoints | null,
  options: MidTrackEntryOptions = {}
): { seconds: number; reason: "drop-approach" | "mid-groove-loop" | "beat-loop" | "beat-in" | "phrase-hot" } | null {
  const beatIn = options.beatInSeconds ?? null;
  const dur = entry && Number.isFinite(entry.durationSeconds) && entry.durationSeconds > 0 ? entry.durationSeconds : null;
  const rawMin = dur !== null && dur < 45 ? 0 : (options.minEntrySeconds ?? 16);
  const rawMax = options.maxEntrySeconds ?? 85;
  const maxEntry = dur !== null && dur < 60 ? Math.min(rawMax, Math.max(0, Number((dur * 0.42).toFixed(3)))) : rawMax;
  const minEntry = Math.min(maxEntry, Math.max(rawMin, beatIn ?? 0));
  const preferBeats = options.preferBeats ?? 16;

  if (entry) {
    // 1. Drop-relative entry (16 or 32 beats before a strong drop, or right on the drop downbeat) in [minEntry, maxEntry].
    const dropPre = entryPointBeforeDrop(entry, {
      preferBeats,
      allowAlternate: true,
      minEntrySeconds: minEntry,
      maxEntrySeconds: maxEntry,
    });
    if (dropPre !== null) {
      return { seconds: dropPre, reason: "drop-approach" };
    }
    const rankedDrops = [...entry.drops].sort((a, b) => b.strength - a.strength);
    for (const d of rankedDrops) {
      if (d.atSeconds >= minEntry && d.atSeconds <= maxEntry) {
        return { seconds: d.atSeconds, reason: "drop-approach" };
      }
    }

    // 2. Earliest high-energy, drums-verified repeating phrase (hook/groove) in [minEntry, min(75, maxEntry)].
    const grooveWindowMax = Math.min(75, maxEntry);
    const grooveLoops = entry.loops
      .filter((c) => c.beatPresent === true && c.loudness >= 0.60 && c.startSeconds >= minEntry && c.startSeconds <= grooveWindowMax)
      .sort((a, b) => a.startSeconds - b.startSeconds);
    if (grooveLoops.length > 0) {
      return { seconds: grooveLoops[0].startSeconds, reason: "mid-groove-loop" };
    }

    // 3. Any drums-verified repeating phrase in [minEntry, maxEntry].
    const anyBeatLoop = entry.loops
      .filter((c) => c.beatPresent === true && c.startSeconds >= minEntry && c.startSeconds <= maxEntry)
      .sort((a, b) => a.startSeconds - b.startSeconds);
    if (anyBeatLoop.length > 0) {
      return { seconds: anyBeatLoop[0].startSeconds, reason: "beat-loop" };
    }
  }

  // 4. Drums-stem beat-in point if it is already >= 12s in.
  if (beatIn !== null && beatIn >= 12 && beatIn <= maxEntry) {
    return { seconds: beatIn, reason: "beat-in" };
  }

  // 5. Phrase-aligned hot entry around ~20s on the real grid.
  if (entry && entry.bpm > 0) {
    const phraseSeconds = (60 / entry.bpm) * BEATS_PER_BAR * BARS_PER_PHRASE;
    const anchor = entry.anchor || 0;
    const n = Math.max(1, Math.ceil((Math.max(16, minEntry) - anchor) / phraseSeconds));
    const candidate = anchor + n * phraseSeconds;
    if (candidate <= maxEntry) {
      return { seconds: Number(candidate.toFixed(3)), reason: "phrase-hot" };
    }
  }

  return beatIn !== null && beatIn >= 0 ? { seconds: Math.min(beatIn, maxEntry), reason: "beat-in" } : null;
}

/**
 * Tightens a track's mixOutSeconds to the end of its last active beat/groove
 * phrase so the DJ exits while the beat is still rolling, before untrimmed
 * music-video outro skits, crowd noise, or beatless fade-outs begin.
 */
export function selectMidTrackExitPoint(
  entry: TrackLoopPoints | null,
  rawMixOutSeconds: number,
  mixInSeconds: number,
  minResidencySeconds: number = 45
): number {
  if (!entry || rawMixOutSeconds <= 0) return rawMixOutSeconds;
  const minSafeExit = mixInSeconds + minResidencySeconds;
  if (rawMixOutSeconds <= minSafeExit + 8) return rawMixOutSeconds;

  const beatLoops = entry.loops.filter(
    (c) => c.beatPresent === true && c.loudness >= 0.55 && c.endSeconds <= rawMixOutSeconds + 2
  );
  let lastActiveBeatEnd = beatLoops.length > 0 ? Math.max(...beatLoops.map((c) => c.endSeconds)) : 0;

  if (entry.bpm > 0) {
    const barSeconds = (60 / entry.bpm) * BEATS_PER_BAR;
    for (const d of entry.drops) {
      const postDropEnd = d.atSeconds + 16 * barSeconds;
      if (postDropEnd <= rawMixOutSeconds && postDropEnd > lastActiveBeatEnd) {
        lastActiveBeatEnd = postDropEnd;
      }
    }
  }

  if (lastActiveBeatEnd >= minSafeExit && lastActiveBeatEnd < rawMixOutSeconds - 6) {
    return Number(lastActiveBeatEnd.toFixed(3));
  }
  return rawMixOutSeconds;
}


export interface PickLoopOptions {
  /** Only consider candidates starting at/after this position. Default 0. */
  fromSeconds?: number;
  /** Require a range with no vocal over it (and a real vocal map behind that claim). Default true. */
  requireVocalFree?: boolean;
  /** Restrict to one isolation mode. */
  isolation?: IsolationMode;
  /** Require the drums stem to be present across the range (default true). */
  requireBeat?: boolean;
}

/**
 * The next usable loop candidate at/after `fromSeconds` — what the live
 * engine asks for when El Cerebro decides to hold a loop from here. Returns
 * the highest-scoring qualifying candidate rather than merely the nearest,
 * so a slightly later but much stronger hook wins; null when nothing
 * qualifies (the caller must then fall back, never invent a range).
 */
export function pickLoopCandidate(entry: TrackLoopPoints | null, options: PickLoopOptions = {}): LoopCandidate | null {
  if (!entry) return null;
  const fromSeconds = options.fromSeconds ?? 0;
  const requireVocalFree = options.requireVocalFree ?? true;
  // M8.2k: the beat must be PRESENT, not just vocals absent. Fails closed when
  // unverified — "we don't know" must not read as "we checked and there's a beat",
  // the same rule vocalFree already follows.
  const requireBeat = options.requireBeat ?? true;
  const eligible = entry.loops.filter((c) => {
    if (c.startSeconds < fromSeconds) return false;
    if (requireVocalFree && !c.vocalFree) return false;
    if (requireBeat && c.beatPresent !== true) return false;
    if (options.isolation && c.isolation !== options.isolation) return false;
    return true;
  });
  if (eligible.length === 0) return null;
  return eligible.reduce((best, c) => (c.score > best.score ? c : best));
}
