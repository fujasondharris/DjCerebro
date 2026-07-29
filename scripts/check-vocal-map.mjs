#!/usr/bin/env node
// Node-side smoke test for the vocal-clash-aware transition machinery's pure
// logic (src/lib/vocal-map.ts): interval derivation from synced-lyrics lines
// (span capping, merge-on-small-gap, rounding), instrumental-gap derivation
// (incl. intro/outro), lookup helpers, and pickTransitionStart's overlap
// minimization + earliest-tie-break. Plain asserts, no test framework,
// mirrors scripts/check-energy.mjs.
import {
  buildVocalIntervalsFromLines,
  getVocalIntervals,
  hasVocalMap,
  isVocalActive,
  firstVocalAfter,
  activeVocalEndsAt,
  vocalGaps,
  nextGapAtOrAfter,
  pickTransitionStart,
} from "../src/lib/vocal-map.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

// --- buildVocalIntervalsFromLines ---
{
  // Consecutive lines close together (<3s gap) merge into one interval.
  const lines = [
    { atSeconds: 0, text: "line one" },
    { atSeconds: 2, text: "line two" },
    { atSeconds: 4, text: "line three" },
  ];
  const intervals = buildVocalIntervalsFromLines(lines);
  assertOk("interval merging: close lines merge into a single interval", intervals.length === 1);
  assertOk("interval merging: merged interval starts at the first line", intervals[0][0] === 0);
  assertOk("interval merging: merged interval extends to the last line's capped end (4+8=12)", intervals[0][1] === 12);
}
{
  // A real instrumental gap (>=3s) between two groups keeps them separate.
  const lines = [
    { atSeconds: 0, text: "verse a" },
    { atSeconds: 1.5, text: "verse a2" },
    { atSeconds: 20, text: "verse b" },
    { atSeconds: 21.5, text: "verse b2" },
  ];
  const intervals = buildVocalIntervalsFromLines(lines);
  assertOk("interval merging: a real gap keeps two groups separate", intervals.length === 2);
  assertOk("interval merging: first group ends at its last line + cap (1.5+8=9.5)", intervals[0][1] === 9.5);
  assertOk("interval merging: second group starts at its own first line", intervals[1][0] === 20);
}
{
  // A single line with no next line caps at +8s.
  const lines = [{ atSeconds: 100, text: "only line" }];
  const intervals = buildVocalIntervalsFromLines(lines);
  assertOk("line-span cap: lone line spans exactly +8s", intervals.length === 1 && intervals[0][0] === 100 && intervals[0][1] === 108);
}
{
  // A line whose next line is far away is capped at +8s, not left open-ended.
  const lines = [
    { atSeconds: 0, text: "line a" },
    { atSeconds: 50, text: "line b (far away)" },
  ];
  const intervals = buildVocalIntervalsFromLines(lines);
  assertOk("line-span cap: a far-away next line still caps the first span at +8s", intervals[0][1] === 8);
}
{
  // Blank lines are skipped entirely — no interval, no gap in the merge chain either.
  const lines = [
    { atSeconds: 0, text: "line a" },
    { atSeconds: 2, text: "   " },
    { atSeconds: 4, text: "line b" },
  ];
  const intervals = buildVocalIntervalsFromLines(lines);
  assertOk("blank lines: skipped entirely (still one merged interval across the blank)", intervals.length === 1);
}
{
  assertOk("empty lines: produces no intervals", buildVocalIntervalsFromLines([]).length === 0);
  assertOk("all-blank lines: produces no intervals", buildVocalIntervalsFromLines([{ atSeconds: 1, text: "  " }]).length === 0);
}
{
  // Rounding: verifies no float artifacts like 4.6000000000000005 leak through.
  const lines = [
    { atSeconds: 4.53, text: "a" },
    { atSeconds: 6.27, text: "b" },
  ];
  const intervals = buildVocalIntervalsFromLines(lines, { roundToSeconds: 0.1 });
  assertOk("rounding: boundaries round to one decimal place", intervals[0][0] === 4.5 && intervals[0][1] === 14.3);
  assertOk("rounding: no float noise in the JSON-serialized form", JSON.stringify(intervals[0]) === "[4.5,14.3]");
}
{
  // Out-of-order input still produces correctly sorted, merged intervals.
  const lines = [
    { atSeconds: 10, text: "second" },
    { atSeconds: 0, text: "first" },
  ];
  const intervals = buildVocalIntervalsFromLines(lines);
  assertOk("out-of-order lines: sorted before deriving intervals", intervals[0][0] === 0);
}

// --- getVocalIntervals / hasVocalMap ---
{
  const map = { "drive:abc": [[0, 10]] };
  assertOk("getVocalIntervals: known key returns its intervals", getVocalIntervals(map, "drive:abc").length === 1);
  assertOk("getVocalIntervals: unknown key returns []", getVocalIntervals(map, "drive:zzz").length === 0);
  assertOk("hasVocalMap: known non-empty key -> true", hasVocalMap(map, "drive:abc") === true);
  assertOk("hasVocalMap: unknown key -> false", hasVocalMap(map, "drive:zzz") === false);
  assertOk("hasVocalMap: key present but empty array -> false", hasVocalMap({ "drive:empty": [] }, "drive:empty") === false);
}

// --- isVocalActive / firstVocalAfter / activeVocalEndsAt ---
{
  const intervals = [[10, 20], [30, 40]];
  assertOk("isVocalActive: inside the first interval", isVocalActive(intervals, 15) === true);
  assertOk("isVocalActive: exactly at an interval's start (inclusive)", isVocalActive(intervals, 10) === true);
  assertOk("isVocalActive: exactly at an interval's end (exclusive)", isVocalActive(intervals, 20) === false);
  assertOk("isVocalActive: in the gap between intervals", isVocalActive(intervals, 25) === false);
  assertOk("isVocalActive: before everything", isVocalActive(intervals, 0) === false);

  assertOk("firstVocalAfter: before the first interval -> its start", firstVocalAfter(intervals, 0) === 10);
  assertOk("firstVocalAfter: inside the first interval -> the NEXT onset, not now", firstVocalAfter(intervals, 15) === 30);
  assertOk("firstVocalAfter: after everything -> null", firstVocalAfter(intervals, 41) === null);

  assertOk("activeVocalEndsAt: inside an interval -> its end", activeVocalEndsAt(intervals, 15) === 20);
  assertOk("activeVocalEndsAt: not currently active -> null", activeVocalEndsAt(intervals, 25) === null);
}

// --- vocalGaps ---
{
  const gaps = vocalGaps([[10, 20]], 3);
  assertOk("vocalGaps: pre-first-vocal intro gap included when long enough", gaps.some((g) => g.start === 0 && g.end === 10));
  assertOk("vocalGaps: post-last-vocal outro gap always included (open-ended)", gaps.some((g) => g.start === 20 && g.end === Infinity));
  assertOk("vocalGaps: exactly two gaps for one interval (intro + outro)", gaps.length === 2);
}
{
  // Intro too short to count as a real gap.
  const gaps = vocalGaps([[1, 20]], 3);
  assertOk("vocalGaps: intro shorter than minGapSeconds is NOT reported", !gaps.some((g) => g.start === 0 && g.end === 1));
  assertOk("vocalGaps: outro still present regardless", gaps.some((g) => g.start === 20 && g.end === Infinity));
}
{
  // A real mid-song instrumental break.
  const gaps = vocalGaps([[0, 10], [30, 40]], 5);
  assertOk("vocalGaps: mid-song gap detected", gaps.some((g) => g.start === 10 && g.end === 30));
  assertOk("vocalGaps: no false intro gap (vocal starts at 0)", !gaps.some((g) => g.start === 0 && g.end === 0));
}
{
  // No intervals at all -> the whole track is one big gap.
  const gaps = vocalGaps([], 8);
  assertOk("vocalGaps: no intervals -> one gap covering the whole track", gaps.length === 1 && gaps[0].start === 0 && gaps[0].end === Infinity);
}

// --- nextGapAtOrAfter ---
{
  const gaps = [{ start: 0, end: 10 }, { start: 30, end: 40 }, { start: 60, end: Infinity }];
  assertOk("nextGapAtOrAfter: before the first gap -> the first gap", nextGapAtOrAfter(gaps, 0)?.start === 0);
  assertOk("nextGapAtOrAfter: inside a gap -> that same gap", nextGapAtOrAfter(gaps, 5)?.start === 0);
  assertOk("nextGapAtOrAfter: between gaps -> the next upcoming one", nextGapAtOrAfter(gaps, 15)?.start === 30);
  assertOk("nextGapAtOrAfter: past every finite gap -> the open-ended outro gap", nextGapAtOrAfter(gaps, 100)?.end === Infinity);
  assertOk("nextGapAtOrAfter: empty gap list -> null", nextGapAtOrAfter([], 5) === null);
}

// --- pickTransitionStart: overlap minimization + earliest tie-break ---
{
  // Live track has a vocal section right at "now"; the incoming track is
  // vocal-active for its entire blend window regardless of when the
  // transition fires (the incoming window is fixed to its OWN timeline, not
  // shifted by the candidate — see pickTransitionStart's own doc comment).
  // Candidate delay 0 lands the blend squarely on BOTH vocals (full clash);
  // delay 10 is past the live vocal's end (8s long), so it clashes with
  // nothing -> should be picked over delay 0.
  const liveIntervals = [[0, 8]]; // live is vocal-active from its own 0..8
  const incomingIntervals = [[0, 8]]; // incoming is vocal-active from its own start too
  const candidates = [0, 10, 20];
  const picked = pickTransitionStart(candidates, 8, liveIntervals, 0, incomingIntervals, 0);
  assertOk("pickTransitionStart: avoids the candidate landing on a live+incoming vocal clash", picked !== 0);
  assertOk("pickTransitionStart: picks the earliest zero-overlap candidate (delay 10, live vocal has ended by then)", picked === 10);
}
{
  // Every candidate produces the exact same (zero) overlap -> earliest wins.
  const liveIntervals = [];
  const incomingIntervals = [];
  const candidates = [2, 6, 14];
  const picked = pickTransitionStart(candidates, 8, liveIntervals, 0, incomingIntervals, 0);
  assertOk("pickTransitionStart: tie (no vocals at all) -> earliest candidate wins", picked === 2);
}
{
  // Every candidate clashes equally -> still picks the earliest (tie on nonzero overlap).
  const liveIntervals = [[0, 1000]]; // live is vocal-active throughout
  const incomingIntervals = [[0, 1000]]; // incoming is vocal-active throughout too
  const candidates = [5, 15, 25];
  const picked = pickTransitionStart(candidates, 8, liveIntervals, 0, incomingIntervals, 0);
  assertOk("pickTransitionStart: equal nonzero overlap on every candidate -> earliest still wins", picked === 5);
}
{
  // liveOffsetSeconds shifts where in the live track's own map "now" sits;
  // the incoming track also has a vocal right at its own start, so the two
  // candidates genuinely differ in overlap (not just "any overlap at all").
  const liveIntervals = [[100, 108]]; // live vocal section far into the track
  const incomingIntervals = [[0, 8]]; // incoming is vocal-active from its own start
  const candidates = [0, 8];
  // liveOffsetSeconds=100 means "now" is already at the live vocal's start.
  const picked = pickTransitionStart(candidates, 8, liveIntervals, 100, incomingIntervals, 0);
  assertOk("pickTransitionStart: avoids delay 0 (both live and incoming vocals clash fully)", picked !== 0);
  assertOk("pickTransitionStart: picks delay 8 (the live vocal has ended by then, no clash)", picked === 8);
}
{
  assertOk("pickTransitionStart: empty candidates -> defensive 0", pickTransitionStart([], 8, [], 0, [], 0) === 0);
}

// --- pickTransitionStart: liveTempo converts an OUTPUT-time candidate delay to the SOURCE-time distance the live vocal map is keyed in (choir round #2, P7) ---
{
  // Live vocal runs source-time [0,10); incoming is vocal-active the whole
  // blend window regardless (so overlap is driven entirely by whether the
  // LIVE vocal is still active at each candidate's converted position).
  // At tempo 3, candidate delay 2 (output-seconds) covers 2*3=6 SOURCE-
  // seconds -> still inside [0,10) (real overlap); delay 4 covers 4*3=12
  // source-seconds -> past the live vocal's end (zero overlap) -> the
  // tempo-aware pick must choose delay 4.
  const liveIntervals = [[0, 10]];
  const incomingIntervals = [[0, 100]];
  const candidates = [2, 4];
  const withoutTempo = pickTransitionStart(candidates, 2, liveIntervals, 0, incomingIntervals, 0); // omitted -> defaults to 1, the old (buggy) behavior
  const withTempo = pickTransitionStart(candidates, 2, liveIntervals, 0, incomingIntervals, 0, 3);
  assertOk(
    "pickTransitionStart: omitting liveTempo keeps the old tempo~1 behavior (both candidates tie at source-time 2/4, earliest wins)",
    withoutTempo === 2
  );
  assertOk(
    "pickTransitionStart: liveTempo=3 correctly converts candidate delays to source-time (6/12) and picks the genuinely lower-overlap one (delay 4, past the live vocal's end)",
    withTempo === 4
  );
}
{
  // Non-finite/non-positive liveTempo falls back to 1 rather than corrupting the math (NaN propagation, negative offsets, etc).
  const liveIntervals = [[0, 8]];
  const incomingIntervals = [[0, 8]];
  const candidates = [0, 10, 20];
  const pickedNaN = pickTransitionStart(candidates, 8, liveIntervals, 0, incomingIntervals, 0, NaN);
  const pickedZero = pickTransitionStart(candidates, 8, liveIntervals, 0, incomingIntervals, 0, 0);
  assertOk("pickTransitionStart: non-finite liveTempo falls back to 1 (same result as the tempo-1 case above)", pickedNaN === 10);
  assertOk("pickTransitionStart: non-positive liveTempo falls back to 1", pickedZero === 10);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all vocal-map cases");
