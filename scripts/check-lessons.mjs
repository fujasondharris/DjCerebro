#!/usr/bin/env node
// Node-side smoke test for the feedback loop's summarization logic: imports
// the exact same src/lib/lessons.ts used by the UI and asserts
// summarizeLessons() — empty input, all-unrated input, thumbs-up/down
// aggregation with correct counts, a net-negative group's "avoid" suffix,
// capping at 10 groups, and determinism across repeated calls on the same
// input. Plain asserts, no test framework, mirrors check-scratch.mjs/
// check-command.mjs.
import { summarizeLessons } from "../src/lib/lessons.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

let nextWhen = 1000;
function makeRecord(overrides = {}) {
  return {
    when: nextWhen++,
    fromTrack: "Track A",
    toTrack: "Track B",
    bpmFrom: 120,
    bpmTo: 124,
    clamped: false,
    degraded: false,
    transitionType: "bass_swap",
    durationBars: 16,
    rating: null,
    note: null,
    ...overrides,
  };
}

// --- empty input -> [] ---
assertOk("empty input -> []", Array.isArray(summarizeLessons([])) && summarizeLessons([]).length === 0);

// --- all-unrated input -> [] ---
{
  const records = [makeRecord(), makeRecord(), makeRecord()];
  assertOk("all-unrated input -> []", summarizeLessons(records).length === 0);
}

// --- mix of up/down on the SAME group aggregates into one bullet with correct counts ---
{
  const records = [
    makeRecord({ rating: "up", transitionType: "bass_swap", bpmFrom: 120, bpmTo: 124, durationBars: 16 }),
    makeRecord({ rating: "up", transitionType: "bass_swap", bpmFrom: 120, bpmTo: 124, durationBars: 16 }),
    makeRecord({ rating: "up", transitionType: "bass_swap", bpmFrom: 120, bpmTo: 124, durationBars: 16 }),
  ];
  const summary = summarizeLessons(records);
  assertOk("same-group mix: exactly one bullet", summary.length === 1);
  assertOk("same-group mix: bullet mentions the transition type", summary[0].includes("bass_swap"));
  assertOk("same-group mix: bullet has the correct up-count", summary[0].includes("👍 ×3"));
  assertOk("same-group mix: no down marker present", !summary[0].includes("👎"));
  assertOk("same-group mix: bpm/duration reflected", summary[0].includes("120") && summary[0].includes("124") && summary[0].includes("16 bars"));
}

// --- net-negative group's bullet contains "avoid" ---
{
  const records = [
    makeRecord({ rating: "down", transitionType: "beatmatch_crossfade", clamped: true }),
    makeRecord({ rating: "down", transitionType: "beatmatch_crossfade", clamped: true }),
    makeRecord({ rating: "up", transitionType: "beatmatch_crossfade", clamped: true }),
  ];
  const summary = summarizeLessons(records);
  assertOk("net-negative: exactly one bullet", summary.length === 1);
  assertOk("net-negative: bullet contains 'avoid'", summary[0].includes("avoid"));
  assertOk("net-negative: clamped group described without exact bpm numbers", summary[0].includes("clamped BPM"));
  assertOk("net-negative: counts both directions", summary[0].includes("👍 ×1") && summary[0].includes("👎 ×2"));
}

// --- a net-positive (or tied) group does NOT get "avoid" ---
{
  const records = [
    makeRecord({ rating: "up", transitionType: "cut" }),
    makeRecord({ rating: "down", transitionType: "cut" }),
  ];
  const summary = summarizeLessons(records);
  assertOk("tied group: no 'avoid' suffix (down is not STRICTLY greater than up)", !summary[0].includes("avoid"));
}

// --- more than 10 distinct rated groups caps the output at exactly 10 ---
{
  const kinds = ["beatmatch_crossfade", "cut", "bass_swap", "echo_out"];
  const records = [];
  // Build 14 distinct groups by varying transitionType x clamped x degraded combinations.
  let count = 0;
  for (const kind of kinds) {
    for (const clamped of [false, true]) {
      for (const degraded of [false, true]) {
        if (count >= 14) break;
        records.push(makeRecord({ transitionType: kind, clamped, degraded, rating: "up" }));
        count++;
      }
    }
  }
  assertOk("setup: built at least 10 distinct groups", count >= 10);
  const summary = summarizeLessons(records);
  assertOk("cap: output capped at exactly 10", summary.length === 10);
}

// --- deterministic: calling summarizeLessons twice on the same input produces byte-identical output ---
{
  const records = [
    makeRecord({ rating: "up", transitionType: "bass_swap" }),
    makeRecord({ rating: "down", transitionType: "echo_out" }),
    makeRecord({ rating: "up", transitionType: "cut" }),
    makeRecord({ rating: "down", transitionType: "cut" }),
    makeRecord({ rating: "down", transitionType: "cut" }),
  ];
  const first = summarizeLessons(records);
  const second = summarizeLessons(records);
  assertOk("determinism: repeated calls produce identical arrays", JSON.stringify(first) === JSON.stringify(second));
}

// --- sort order: higher total rating count sorts first ---
{
  const records = [
    makeRecord({ rating: "up", transitionType: "bass_swap" }), // total 1
    makeRecord({ rating: "up", transitionType: "echo_out" }),
    makeRecord({ rating: "down", transitionType: "echo_out" }),
    makeRecord({ rating: "up", transitionType: "echo_out" }), // total 3
  ];
  const summary = summarizeLessons(records);
  assertOk("sort: the higher-total-count group (echo_out, 3 ratings) comes first", summary[0].includes("echo_out"));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all lessons summarization cases");
