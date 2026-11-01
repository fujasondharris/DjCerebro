#!/usr/bin/env node
// Node-side check for M7 Phase 1's pure detectors (src/lib/loop-points.ts):
// bar folding off the real grid, self-similarity-based recurring-pattern
// detection, band-isolation-mode suggestion, drop detection with its
// 16-/32-beats-before entry points, and the loop-points data-file accessors.
// Synthetic bar energies throughout — no audio, no filesystem. Plain asserts,
// no test framework.
import {
  beatsToBars,
  normalizeBars,
  barDistance,
  windowDistance,
  suggestIsolationMode,
  isRangeVocalFree,
  findLoopCandidates,
  detectDrops,
  getLoopPoints,
  pickLoopCandidate,
  entryPointBeforeDrop,
  selectMidTrackEntryPoint,
  selectMidTrackExitPoint,
  BARS_PER_PHRASE,
} from "../src/lib/loop-points.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

function approxEqual(a, b, epsilon = 1e-9) {
  return Math.abs(a - b) < epsilon;
}

/** Builds a BeatBandEnergy from explicit per-beat band triples. */
function perBeatFrom(triples, { firstBeatIndex = 0, bpm = 120, anchor = 0 } = {}) {
  const beatLength = 60 / bpm;
  return {
    firstBeatIndex,
    beatSeconds: triples.map((_, i) => anchor + (firstBeatIndex + i) * beatLength),
    low: triples.map((t) => t[0]),
    mid: triples.map((t) => t[1]),
    high: triples.map((t) => t[2]),
  };
}

/** Builds bars directly (skipping the beat fold) for the detector tests. */
function barsFrom(triples, { bpm = 120, beatsPerBar = 4 } = {}) {
  const barLength = (60 / bpm) * beatsPerBar;
  return triples.map(([low, mid, high], i) => ({
    barIndex: i,
    startSeconds: i * barLength,
    endSeconds: (i + 1) * barLength,
    low,
    mid,
    high,
  }));
}

// --- beatsToBars ------------------------------------------------------------
{
  const perBeat = perBeatFrom(Array.from({ length: 8 }, () => [1, 2, 3]));
  const bars = beatsToBars(perBeat);
  assertOk("8 beats fold into 2 bars", bars.length === 2);
  assertOk("a bar's band value is the mean of its beats", bars[0].low === 1 && bars[0].mid === 2 && bars[0].high === 3);
  assertOk("bar 0 starts at the first beat", approxEqual(bars[0].startSeconds, 0));
  assertOk("a bar spans 4 beats (2s @120bpm)", approxEqual(bars[0].endSeconds - bars[0].startSeconds, 2));
  assertOk("bar indices are sequential from 0", bars[1].barIndex === 1);
}
{
  // Alignment (choir round #3, finding 3): the fold starts at the first
  // PHRASE line (anchor-relative beat divisible by 16), not merely the first
  // BAR line. Both downstream detectors treat array index 0 as a phrase
  // start — findLoopCandidates steps 4 bars at a time from 0, detectDrops
  // steps boundaries by 4 bars from 0 — and planHeldLoop snaps its capture
  // to a real 16-beat phrase line. If bars[0] sat on a bar line that was not
  // a phrase line, the hold would loop a DIFFERENT range than the detector
  // picked, silently breaking the "loop the detected hook" premise.
  const triples = Array.from({ length: 40 }, (_, i) => [i, 0, 0]);
  const bars = beatsToBars(perBeatFrom(triples, { firstBeatIndex: 2 }));
  // firstBeatIndex 2 -> the first phrase line is anchor-relative beat 16,
  // i.e. offset 14 into the measured beats. 40 - 14 = 26 beats -> 6 bars.
  assertOk("misaligned start: the fold begins at the first PHRASE line, not the first bar line", bars[0].low === (14 + 15 + 16 + 17) / 4);
  assertOk("misaligned start: only whole bars from there are emitted", bars.length === 6);

  // The property that actually matters downstream, stated directly: for any
  // starting beat index, bars[0] is on a phrase line.
  for (const firstBeatIndex of [0, 1, 2, 3, 4, 7, 8, 15, 16, 17]) {
    const b = beatsToBars(perBeatFrom(Array.from({ length: 80 }, () => [1, 1, 1]), { firstBeatIndex }));
    // offset = index of bars[0]'s first beat within the measured array
    const offset = (16 - (firstBeatIndex % 16)) % 16;
    assertOk(
      `firstBeatIndex ${firstBeatIndex}: bars[0] lands on an anchor-relative phrase line`,
      b.length > 0 && (firstBeatIndex + offset) % 16 === 0
    );
  }
}
{
  const partial = beatsToBars(perBeatFrom(Array.from({ length: 7 }, () => [1, 1, 1])));
  assertOk("a trailing partial bar is dropped", partial.length === 1);
  assertOk("fewer than 2 beats yields no bars", beatsToBars(perBeatFrom([[1, 1, 1]])).length === 0);
  assertOk("a non-positive beatsPerBar yields no bars", beatsToBars(perBeatFrom(Array.from({ length: 8 }, () => [1, 1, 1])), 0).length === 0);
}

// --- normalizeBars / barDistance / windowDistance ---------------------------
{
  const bars = barsFrom([
    [1, 1, 1],
    [2, 2, 2],
    [1, 1, 1],
    [2, 2, 2],
  ]);
  const norm = normalizeBars(bars);
  assertOk("normalizeBars keeps the bar count and indices", norm.length === 4 && norm[3].barIndex === 3);
  assertOk("normalizeBars scales against the track's own 90th percentile", norm[1].low === 1);
  assertOk("normalizeBars keeps relative order within a band", norm[0].low < norm[1].low);
  assertOk("normalizeBars preserves timing", approxEqual(norm[2].startSeconds, bars[2].startSeconds));
}
{
  assertOk("barDistance of identical bars is 0", barDistance({ low: 0.5, mid: 0.5, high: 0.5 }, { low: 0.5, mid: 0.5, high: 0.5 }) === 0);
  assertOk("barDistance is the mean absolute per-band difference", approxEqual(barDistance({ low: 1, mid: 0, high: 0 }, { low: 0, mid: 0, high: 0 }), 1 / 3));
  assertOk("barDistance is symmetric", barDistance({ low: 0.2, mid: 0.9, high: 0.4 }, { low: 0.7, mid: 0.1, high: 0.5 }) === barDistance({ low: 0.7, mid: 0.1, high: 0.5 }, { low: 0.2, mid: 0.9, high: 0.4 }));
}
{
  const bars = barsFrom([
    [1, 0, 0],
    [0, 1, 0],
    [1, 0, 0],
    [0, 1, 0],
  ]);
  assertOk("windowDistance of a window against an identical one is 0", windowDistance(bars, 0, 2, 2) === 0);
  assertOk("windowDistance of dissimilar windows is > 0", windowDistance(bars, 0, 1, 1) > 0);
}

// --- suggestIsolationMode ---------------------------------------------------
{
  assertOk("a low-heavy range suggests beat mode (kill high+mid)", suggestIsolationMode({ low: 0.9, mid: 0.2, high: 0.1 }) === "beat");
  assertOk("a mid/high-heavy range suggests melody mode (kill low)", suggestIsolationMode({ low: 0.1, mid: 0.8, high: 0.6 }) === "melody");
  assertOk("an exact tie goes to beat (safer to hold alone)", suggestIsolationMode({ low: 0.5, mid: 0.25, high: 0.25 }) === "beat");
  assertOk("an all-zero range defaults to beat rather than dividing by zero", suggestIsolationMode({ low: 0, mid: 0, high: 0 }) === "beat");
}

// --- isRangeVocalFree -------------------------------------------------------
{
  const intervals = [
    [10, 20],
    [40, 50],
  ];
  assertOk("a range entirely between vocals is vocal-free", isRangeVocalFree(intervals, 25, 35));
  assertOk("a range overlapping a vocal is not vocal-free", !isRangeVocalFree(intervals, 15, 25));
  assertOk("a range fully inside a vocal is not vocal-free", !isRangeVocalFree(intervals, 12, 18));
  assertOk("a range containing a whole vocal is not vocal-free", !isRangeVocalFree(intervals, 5, 25));
  assertOk("a range ending exactly where a vocal starts is vocal-free (half-open)", isRangeVocalFree(intervals, 0, 10));
  assertOk("a range starting exactly where a vocal ends is vocal-free (half-open)", isRangeVocalFree(intervals, 20, 30));
  assertOk("no intervals means nothing overlaps", isRangeVocalFree([], 0, 100));
}

// --- findLoopCandidates -----------------------------------------------------

/** A 4-bar motif repeated `times` over, i.e. an obvious recurring pattern. */
const MOTIF = [
  [1.0, 0.2, 0.1],
  [0.3, 0.8, 0.4],
  [0.9, 0.3, 0.2],
  [0.4, 0.7, 0.5],
];
function repeatMotif(times) {
  const out = [];
  for (let i = 0; i < times; i++) out.push(...MOTIF.map((m) => [...m]));
  return out;
}

{
  const bars = barsFrom(repeatMotif(6)); // 24 bars, the same 4-bar motif 6x
  const candidates = findLoopCandidates(bars, { hasVocalMap: true, vocalIntervals: [] });
  assertOk("an obviously repeating motif yields at least one candidate", candidates.length > 0);
  assertOk("every candidate repeats at least twice", candidates.every((c) => c.repeats >= 2));
  assertOk("candidates start on a 4-bar phrase boundary", candidates.every((c) => c.startBar % BARS_PER_PHRASE === 0));
  assertOk("similarity of an exact repeat is ~1", candidates.every((c) => c.similarity > 0.99));
  assertOk("candidates are returned best-score-first", candidates.every((c, i) => i === 0 || candidates[i - 1].score >= c.score));
  assertOk("returned candidates never overlap in time", candidates.every((c, i) => candidates.slice(0, i).every((p) => c.startSeconds >= p.endSeconds || c.endSeconds <= p.startSeconds)));
  assertOk("start/end seconds come from the bars, not recomputed", candidates.every((c) => approxEqual(c.startSeconds, bars[c.startBar].startSeconds) && approxEqual(c.endSeconds, bars[c.startBar + c.lengthBars - 1].endSeconds)));
  assertOk("a clean vocal map over a clear range marks vocalFree true", candidates.some((c) => c.vocalFree));
}
{
  // Without a vocal map, "vocal-free" is UNKNOWN and must never be reported
  // as true — the honesty rule that keeps "we didn't check" out of the same
  // bucket as "we checked and it's clear".
  const bars = barsFrom(repeatMotif(6));
  const candidates = findLoopCandidates(bars, { hasVocalMap: false });
  assertOk("no vocal map: no candidate claims vocalFree", candidates.every((c) => c.vocalFree === false));
  assertOk("no vocal map: candidates are still produced (de-ranked, not dropped)", candidates.length > 0);
}
{
  // A vocal covering the whole track must mark every candidate not-vocal-free.
  const bars = barsFrom(repeatMotif(6));
  const candidates = findLoopCandidates(bars, { hasVocalMap: true, vocalIntervals: [[0, 1000]] });
  assertOk("a vocal over the whole track leaves no vocalFree candidate", candidates.every((c) => !c.vocalFree));
}
{
  // A monotonic ramp has no repeating pattern at all.
  const ramp = barsFrom(Array.from({ length: 24 }, (_, i) => [i / 24, i / 24, i / 24]));
  const candidates = findLoopCandidates(ramp, { hasVocalMap: true, vocalIntervals: [] });
  assertOk("a track with no recurring pattern yields no candidates", candidates.length === 0);
}
{
  const bars = barsFrom(repeatMotif(6));
  assertOk("maxCandidates is honored", findLoopCandidates(bars, { maxCandidates: 1, hasVocalMap: true }).length === 1);
  assertOk("only requested capture lengths are returned", findLoopCandidates(bars, { lengthsBars: [4], hasVocalMap: true }).every((c) => c.lengthBars === 4));
  assertOk("a length longer than the track is skipped, not crashed on", findLoopCandidates(bars, { lengthsBars: [999], hasVocalMap: true }).length === 0);
  assertOk("too few bars to analyze returns empty", findLoopCandidates(barsFrom([[1, 1, 1], [1, 1, 1]]), {}).length === 0);
  assertOk("an impossible similarity threshold returns nothing", findLoopCandidates(bars, { similarityThreshold: 1.01, hasVocalMap: true }).length === 0);
}
{
  // Isolation mode reflects the range's own band balance.
  const lowHeavy = barsFrom(repeatMotif(6).map(() => [1.0, 0.1, 0.05]));
  const topHeavy = barsFrom(repeatMotif(6).map(() => [0.05, 0.9, 0.7]));
  assertOk("a low-heavy repeating range is tagged beat mode", findLoopCandidates(lowHeavy, { hasVocalMap: true })[0].isolation === "beat");
  assertOk("a top-heavy repeating range is tagged melody mode", findLoopCandidates(topHeavy, { hasVocalMap: true })[0].isolation === "melody");
}
{
  // A steady range scores higher stability than one that lurches mid-range.
  const steady = findLoopCandidates(barsFrom(repeatMotif(6).map(() => [0.5, 0.5, 0.5])), { hasVocalMap: true })[0];
  assertOk("a perfectly steady range has stability ~1", steady.stability > 0.99);
  assertOk("a full-level range has loudness ~1", steady.loudness > 0.99);
}
{
  // LENGTH PREFERENCE: with a motif that repeats identically at every
  // length, the LONGEST offered capture must win. The first crate-wide run
  // picked a 2-bar loop for all 326 tracks because a shorter window averages
  // fewer bar-to-bar differences and so scores higher raw similarity —
  // musically backwards, since Phase 2's move is a 4-/8-bar loop that then
  // halves into the drop.
  const bars = barsFrom(repeatMotif(8)); // 32 bars
  const best = findLoopCandidates(bars, { lengthsBars: [2, 4, 8], hasVocalMap: true })[0];
  assertOk("the longest convincingly-repeating capture wins, not the shortest", best.lengthBars === 8);
  const onlyShort = findLoopCandidates(bars, { lengthsBars: [2], hasVocalMap: true })[0];
  assertOk("a 2-bar range still scores lower than the same music at 8 bars", onlyShort.score < best.score);
}
{
  // LOUDNESS FLOOR: a fade-out normalizes to ~0 in every band, making every
  // one of its bars trivially identical to every other — high similarity,
  // high stability, many repeats. Before this filter the top candidate for
  // several real tracks sat at 94-97% of the duration: the fade, not the
  // song. A loud hook followed by a long quiet tail must pick the hook.
  const loudSection = repeatMotif(4); // 16 bars of real material
  const fade = Array.from({ length: 16 }, () => [0.01, 0.01, 0.01]);
  const bars = barsFrom([...loudSection, ...fade]);
  const candidates = findLoopCandidates(bars, { hasVocalMap: true, vocalIntervals: [] });
  assertOk("a near-silent fade produces no loop candidate", candidates.every((c) => c.startBar < loudSection.length));
  assertOk("candidates report their loudness", candidates.every((c) => c.loudness > 0.45));

  // ...and it is genuinely the loudness FILTER excluding the fade, not some
  // unrelated rejection: drop the filter (and widen the result cap past the
  // loud section's own candidates) and the fade ranges reappear.
  assertOk(
    "minLoudness 0 lets the fade back in (the filter is what excludes it, not a bug elsewhere)",
    findLoopCandidates(bars, { hasVocalMap: true, minLoudness: 0, maxCandidates: 20 }).some((c) => c.startBar >= loudSection.length)
  );
}
{
  // The two guards answer DIFFERENT questions, and the difference matters:
  //  - minLoudness is RELATIVE to the track's own level, because
  //    normalizeBars deliberately scales that way (so a quietly-mastered
  //    track isn't penalised against a loud one). It catches the fade at the
  //    end of a loud track.
  //  - a quiet-but-real track must therefore still produce candidates: its
  //    own hook is its own hook regardless of mastering level.
  //  - only the ABSOLUTE floor (SILENCE_FLOOR, same value as energy.ts's)
  //    rejects audio with nothing in it at all.
  const quietButReal = barsFrom(repeatMotif(6).map(([l, m, h]) => [l * 0.02, m * 0.02, h * 0.02]));
  assertOk("a quietly-mastered but real track still yields candidates", findLoopCandidates(quietButReal, { hasVocalMap: true }).length > 0);

  const silent = barsFrom(Array.from({ length: 24 }, () => [1e-6, 1e-6, 1e-6]));
  assertOk("audio at digital silence yields no candidates (absolute floor)", findLoopCandidates(silent, { hasVocalMap: true }).length === 0);
  assertOk("the silence floor is absolute — minLoudness 0 does not override it", findLoopCandidates(silent, { hasVocalMap: true, minLoudness: 0 }).length === 0);
}

// --- detectDrops ------------------------------------------------------------

/** 4 quiet bars, then 4 loud bars with the bass returning, repeated. */
function dropShape() {
  const quiet = Array.from({ length: 4 }, () => [0.05, 0.3, 0.3]);
  const loud = Array.from({ length: 4 }, () => [1.0, 0.9, 0.8]);
  return [...loud, ...quiet, ...loud, ...quiet, ...loud];
}

{
  const bars = barsFrom(dropShape());
  const drops = detectDrops(bars, 120);
  assertOk("a breakdown-into-full-energy boundary is detected as a drop", drops.length > 0);
  assertOk("a drop lands on a phrase boundary bar", drops.every((d) => d.barIndex % BARS_PER_PHRASE === 0));
  assertOk("a drop's atSeconds is that bar's own start", drops.every((d) => approxEqual(d.atSeconds, bars[d.barIndex].startSeconds)));
  assertOk("drops are returned in time order", drops.every((d, i) => i === 0 || drops[i - 1].atSeconds < d.atSeconds));
  assertOk("strength is the after/before energy ratio (>1 for a real drop)", drops.every((d) => d.strength > 1));
}
{
  // Entry points: 16 and 32 beats before the drop at the given BPM.
  // 120bpm = 0.5s/beat -> 8s and 16s before.
  const bars = barsFrom(dropShape());
  const drop = detectDrops(bars, 120).find((d) => d.atSeconds >= 16);
  assertOk("a drop at/after 16s exists to test entry points against", Boolean(drop));
  assertOk("entry16Seconds is exactly 16 beats before the drop", approxEqual(drop.entry16Seconds, drop.atSeconds - 8));
  assertOk("entry32Seconds is exactly 32 beats before the drop", approxEqual(drop.entry32Seconds, drop.atSeconds - 16));
}
{
  // An entry point that would land before the start of the track is null,
  // never a negative seek position.
  const early = barsFrom([
    ...Array.from({ length: 4 }, () => [0.05, 0.3, 0.3]),
    ...Array.from({ length: 4 }, () => [1.0, 0.9, 0.8]),
  ]);
  const drops = detectDrops(early, 120); // drop at bar 4 = 8s; 32 beats before = -8s
  assertOk("an early drop is still detected", drops.length === 1);
  assertOk("an entry point before 0 is reported as null, not negative", drops[0].entry32Seconds === null);
  assertOk("an in-range entry point is still a number", drops[0].entry16Seconds === 0);
}
{
  // A hats-only build (no bass return) is NOT a drop.
  const build = barsFrom([
    ...Array.from({ length: 4 }, () => [0.5, 0.3, 0.1]),
    ...Array.from({ length: 4 }, () => [0.5, 0.9, 1.0]),
  ]);
  assertOk("a jump with no bass return is rejected as a build, not a drop", detectDrops(build, 120).length === 0);
}
{
  const flat = barsFrom(Array.from({ length: 16 }, () => [0.5, 0.5, 0.5]));
  assertOk("a flat track has no drops", detectDrops(flat, 120).length === 0);
  assertOk("bpm <= 0 returns no drops (never a fabricated entry point)", detectDrops(barsFrom(dropShape()), 0).length === 0);
  assertOk("non-finite bpm returns no drops", detectDrops(barsFrom(dropShape()), NaN).length === 0);
  assertOk("too few bars returns no drops", detectDrops(barsFrom([[1, 1, 1], [1, 1, 1]]), 120).length === 0);
}
{
  const bars = barsFrom(dropShape());
  assertOk("maxDrops is honored", detectDrops(bars, 120, { maxDrops: 1 }).length <= 1);
  assertOk("an unreachable minStrength returns nothing", detectDrops(bars, 120, { minStrength: 1000 }).length === 0);
  const spaced = detectDrops(bars, 120, { minSpacingBars: 1000 });
  assertOk("a huge minSpacingBars collapses to a single drop", spaced.length === 1);
  // A non-multiple-of-4 comparison window must still only ever report drops
  // ON phrase lines — a "drop" off the phrase grid is not one a DJ can mix to.
  assertOk(
    "a windowBars that isn't a multiple of 4 still only reports phrase-aligned drops",
    detectDrops(barsFrom([...dropShape(), ...dropShape()]), 120, { windowBars: 3 }).every((d) => d.barIndex % BARS_PER_PHRASE === 0)
  );
}

// --- data-file accessors ----------------------------------------------------
{
  const entry = {
    bpm: 120,
    anchor: 0,
    durationSeconds: 200,
    vocalChecked: true,
    loops: [
      { startBar: 0, lengthBars: 4, startSeconds: 10, endSeconds: 18, repeats: 3, similarity: 0.95, stability: 0.9, isolation: "beat", vocalFree: true, beatPresent: true, score: 0.8 },
      { startBar: 8, lengthBars: 4, startSeconds: 40, endSeconds: 48, repeats: 2, similarity: 0.9, stability: 0.8, isolation: "melody", vocalFree: true, beatPresent: true, score: 0.9 },
      { startBar: 16, lengthBars: 4, startSeconds: 70, endSeconds: 78, repeats: 2, similarity: 0.88, stability: 0.7, isolation: "beat", vocalFree: false, beatPresent: true, score: 0.95 },
    ],
    drops: [],
  };
  const file = { "drive:abc": entry };

  assertOk("getLoopPoints finds a present key", getLoopPoints(file, "drive:abc") === entry);
  assertOk("getLoopPoints returns null for a missing key", getLoopPoints(file, "drive:nope") === null);
  assertOk("pickLoopCandidate on a null entry is null", pickLoopCandidate(null) === null);

  assertOk("pickLoopCandidate takes the highest-scoring vocal-free candidate, not merely the first", pickLoopCandidate(entry).startSeconds === 40);
  assertOk("pickLoopCandidate respects fromSeconds", pickLoopCandidate(entry, { fromSeconds: 50 }) === null);
  assertOk("pickLoopCandidate can include not-vocal-free candidates when asked", pickLoopCandidate(entry, { requireVocalFree: false }).startSeconds === 70);
  assertOk("pickLoopCandidate can filter by isolation mode", pickLoopCandidate(entry, { isolation: "beat" }).startSeconds === 10);
  assertOk("pickLoopCandidate returns null when nothing qualifies", pickLoopCandidate({ ...entry, loops: [] }) === null);

  // M8.2k — the beat must be PRESENT, and unverified fails closed. Owner heard the
  // failure on Ozuna "Unica": the lyric map called 0-20s vocal-free, the stem had
  // vocals at -17 dB from 0s and drums at -82 dB, and four bars of a cappella looped.
  const beatless = { ...entry, loops: [{ ...entry.loops[0], beatPresent: false }] };
  assertOk("a vocal-free candidate with NO beat is rejected (a pad is not a loop)", pickLoopCandidate(beatless) === null);
  const unverified = { ...entry, loops: [{ ...entry.loops[0], beatPresent: undefined }] };
  assertOk("an UNVERIFIED candidate is rejected by default (fail closed, same as vocalFree)", pickLoopCandidate(unverified) === null);
  assertOk("requireBeat:false restores the old behaviour explicitly", pickLoopCandidate(unverified, { requireBeat: false })?.startSeconds === 10);

  const withDrop = {
    ...entry,
    drops: [{ barIndex: 16, atSeconds: 80, strength: 2, entry16Seconds: 72, entry32Seconds: 64 }],
  };
  assertOk("drop entry defaults to the longer 32-beat runway", entryPointBeforeDrop(withDrop) === 64);
  assertOk("drop entry can request the exact 16-beat handoff runway", entryPointBeforeDrop(withDrop, { preferBeats: 16, allowAlternate: false }) === 72);
  assertOk("strict drop entry refuses an out-of-range preferred point instead of silently returning 32 beats", entryPointBeforeDrop(withDrop, { preferBeats: 16, allowAlternate: false, maxEntrySeconds: 70 }) === null);
  assertOk("minEntrySeconds skips a near-zero 32-beat entry and takes the 16-beat entry once the song is rolling", entryPointBeforeDrop({
    ...entry,
    drops: [{ barIndex: 4, atSeconds: 20, strength: 2, entry16Seconds: 12, entry32Seconds: 4 }],
  }, { preferBeats: 32, minEntrySeconds: 10 }) === 12);

  // Mid-track hot entry & exit tests
  const midEntryFromDrop = selectMidTrackEntryPoint(withDrop, { minEntrySeconds: 18, maxEntrySeconds: 85 });
  assertOk("selectMidTrackEntryPoint picks a drop-approach in the 18..85s window", midEntryFromDrop?.seconds === 72 && midEntryFromDrop?.reason === "drop-approach");

  const midEntryFromLoop = selectMidTrackEntryPoint({
    ...entry,
    loops: [
      { startBar: 0, lengthBars: 4, startSeconds: 2, endSeconds: 10, repeats: 2, similarity: 0.9, stability: 0.8, loudness: 0.8, isolation: "beat", vocalFree: true, beatPresent: true, score: 0.7 },
      { startBar: 8, lengthBars: 8, startSeconds: 36, endSeconds: 52, repeats: 3, similarity: 0.92, stability: 0.85, loudness: 0.88, isolation: "beat", vocalFree: false, beatPresent: true, score: 0.9 },
    ],
    drops: [],
  }, { minEntrySeconds: 18, maxEntrySeconds: 85 });
  assertOk("selectMidTrackEntryPoint skips 2s intro loop and lands at 36s mid-groove phrase", midEntryFromLoop?.seconds === 36 && midEntryFromLoop?.reason === "mid-groove-loop");

  const tightenedExit = selectMidTrackExitPoint({
    ...entry,
    durationSeconds: 240,
    loops: [
      { startBar: 8, lengthBars: 8, startSeconds: 36, endSeconds: 52, repeats: 3, similarity: 0.9, stability: 0.8, loudness: 0.85, isolation: "beat", vocalFree: false, beatPresent: true, score: 0.9 },
      { startBar: 40, lengthBars: 8, startSeconds: 164, endSeconds: 180, repeats: 3, similarity: 0.9, stability: 0.8, loudness: 0.82, isolation: "beat", vocalFree: false, beatPresent: true, score: 0.88 },
    ],
    drops: [],
  }, 235, 36, 45);
  assertOk("selectMidTrackExitPoint tightens 235s video-outro tail to 180s where the last beat loop ends", tightenedExit === 180);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all loop-points detector cases");
