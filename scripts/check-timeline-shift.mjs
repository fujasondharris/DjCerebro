#!/usr/bin/env node
// Golden for the timeline shift (scripts/shift-timeline-data.mjs).
//
// This is arithmetic applied to data that costs hours to regenerate — loop-points
// comes from bar-level self-similarity analysis over the whole crate. An off-by-one
// here would not throw; it would quietly move every cue in the crate by a few
// seconds, and the only symptom would be El Cerebro sounding slightly wrong weeks
// later. So the behaviour is pinned rather than trusted.
//
// Usage: npm run check:timeline-shift
import { shiftSeconds } from "./shift-timeline-data.mjs";

let failures = 0;
function assertOk(label, cond, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A track cut 10s off the head, 100s of audio surviving.
const HEAD = 10, NEW_DUR = 100;
const seen = {};

// --- the basic shift ---
assertOk(
  "a second-field moves earlier by exactly headSeconds",
  shiftSeconds({ startSeconds: 25 }, HEAD, NEW_DUR, seen)?.startSeconds === 15,
);
assertOk(
  "several second-fields on one object all shift",
  eq(shiftSeconds({ startSeconds: 25, endSeconds: 40 }, HEAD, NEW_DUR, seen),
     { startSeconds: 15, endSeconds: 30 }),
);
assertOk(
  "a field landing exactly at the new zero is kept, not dropped",
  shiftSeconds({ startSeconds: 10 }, HEAD, NEW_DUR, seen)?.startSeconds === 0,
);

// --- out-of-range entries are DROPPED, never clamped ---
// Clamping is the tempting bug: it keeps the entry but silently relocates a cue to
// a musically wrong place, which is worse than losing it.
assertOk(
  "an entry starting BEFORE the cut is dropped, not clamped to 0",
  shiftSeconds({ startSeconds: 4 }, HEAD, NEW_DUR, seen) === null,
);
assertOk(
  "an entry past the new end is dropped",
  shiftSeconds({ startSeconds: 200 }, HEAD, NEW_DUR, seen) === null,
);
assertOk(
  "one bad field drops the WHOLE record, not just that field",
  shiftSeconds({ startSeconds: 25, endSeconds: 500 }, HEAD, NEW_DUR, seen) === null,
);

// --- structure is preserved ---
assertOk(
  "nested objects shift",
  eq(shiftSeconds({ grid: { anchorSeconds: 30 } }, HEAD, NEW_DUR, seen),
     { grid: { anchorSeconds: 20 } }),
);
assertOk(
  "arrays shift element-wise and drop only the bad elements",
  eq(shiftSeconds([{ atSeconds: 20 }, { atSeconds: 2 }, { atSeconds: 30 }], HEAD, NEW_DUR, seen),
     [{ atSeconds: 10 }, { atSeconds: 20 }]),
);
assertOk(
  "non-time fields are passed through untouched",
  eq(shiftSeconds({ startSeconds: 25, bpm: 96, key: "Am", vocalFree: true }, HEAD, NEW_DUR, seen),
     { startSeconds: 15, bpm: 96, key: "Am", vocalFree: true }),
);
assertOk(
  "similarity/score fields are NOT treated as seconds",
  eq(shiftSeconds({ similarity: 0.88, stability: 0.96 }, HEAD, NEW_DUR, seen),
     { similarity: 0.88, stability: 0.96 }),
);

// --- a zero-head (tail-only) trim must not move anything ---
assertOk(
  "a tail-only trim (head=0) leaves timestamps untouched",
  eq(shiftSeconds({ startSeconds: 25, endSeconds: 40 }, 0, NEW_DUR, seen),
     { startSeconds: 25, endSeconds: 40 }),
);

// --- realistic loop-points record ---
const loop = {
  bpm: 123.0051,
  durationSeconds: 202.268,
  loops: [
    { startBar: 52, lengthBars: 8, startSeconds: 101.61, endSeconds: 117.219, similarity: 0.8869 },
    { startBar: 4, lengthBars: 8, startSeconds: 8.0, endSeconds: 23.6, similarity: 0.81 },
  ],
};
const shifted = shiftSeconds(loop, HEAD, 192.268, seen);
assertOk("realistic record: in-range loop shifts",
  shifted?.loops?.[0]?.startSeconds === 91.61 && shifted?.loops?.[0]?.endSeconds === 107.219,
  JSON.stringify(shifted?.loops?.[0]));
assertOk("realistic record: loop starting inside the cut is dropped",
  shifted?.loops?.length === 1, `${shifted?.loops?.length} loops survived, expected 1`);
assertOk("realistic record: lengthBars is untouched by a seconds shift",
  shifted?.loops?.[0]?.lengthBars === 8);

// --- lengths vs positions (the bug that dropped 117/117 loop-points records) ---
assertOk(
  "durationSeconds is a LENGTH and is never shifted or range-checked",
  eq(shiftSeconds({ durationSeconds: 202.268, startSeconds: 25 }, HEAD, NEW_DUR, seen),
     { durationSeconds: 202.268, startSeconds: 15 }),
  JSON.stringify(shiftSeconds({ durationSeconds: 202.268, startSeconds: 25 }, HEAD, NEW_DUR, seen)),
);
assertOk(
  "a TAIL-ONLY cut does not drop a record whose durationSeconds exceeds the new duration",
  shiftSeconds({ durationSeconds: 202.268, startSeconds: 40 }, 0, 190, seen) !== null,
);
assertOk(
  "anchor is NOT shifted here (the caller sets it to 0 after a snapped head cut) " +
  "- shifting it naively goes negative and drops the record",
  shiftSeconds({ anchor: 0.472, startSeconds: 25 }, HEAD, NEW_DUR, seen)?.anchor === 0.472,
);
assertOk(
  "holdSeconds is a LENGTH and is not shifted",
  shiftSeconds({ holdSeconds: 30 }, HEAD, NEW_DUR, seen)?.holdSeconds === 30,
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed — DO NOT shift the timeline data.`);
  process.exit(1);
}
console.log("\nPASS: timeline shift drops out-of-range entries instead of clamping them");
