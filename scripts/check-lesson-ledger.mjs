#!/usr/bin/env node
// Node-side smoke test for the lesson ledger (src/lib/lesson-ledger.ts):
// imports the exact same module page.tsx/brain.ts use and asserts event
// append/cap (against a fake localStorage), distill grouping (global vs
// perTrack, note-carrying ratings prioritized, fx_manual aggregation),
// candidate-window filtering (only requested tracks appear in perTrack),
// the char cap, and merge/dedupe (import + seed-file merge). Plain asserts,
// no test framework, mirrors scripts/check-fx-log.mjs.
import {
  appendLedgerEvent,
  loadLedger,
  mergeLedgerEvents,
  distillForBrain,
  describeLedgerEvent,
} from "../src/lib/lesson-ledger.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

function fakeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };
}

// --- event append/cap ---
{
  globalThis.localStorage = fakeLocalStorage();
  let list = [];
  for (let i = 0; i < 505; i++) {
    list = appendLedgerEvent({
      type: "vibe_note",
      when: new Date(i).toISOString(),
      text: `note-${i}`,
    });
  }
  assertOk("appendLedgerEvent: caps the persisted log at 500 events", list.length === 500);
  assertOk("appendLedgerEvent: evicts the OLDEST first (note-5 survives, note-4 doesn't)", list[0].text === "note-5");
  assertOk("appendLedgerEvent: the most recent append is last", list[list.length - 1].text === "note-504");
  assertOk("loadLedger: round-trips the persisted list", loadLedger().length === 500);
  delete globalThis.localStorage;
}

// --- distillForBrain: grouping ---
{
  const events = [
    {
      type: "transition_rating",
      when: "2026-01-01T00:00:00.000Z",
      fromTrackName: "Track A",
      toTrackName: "Track B",
      transitionType: "bass_swap",
      durationBars: 16,
      clamped: false,
      degraded: false,
      rating: "down",
      note: "too early",
      outPositionSeconds: 83,
    },
    {
      type: "transition_rating",
      when: "2026-01-02T00:00:00.000Z",
      fromTrackName: "Track C",
      toTrackName: "Track D",
      transitionType: "cut",
      durationBars: 8,
      clamped: true,
      degraded: false,
      rating: "up",
      // no note — should NOT appear in global (global is note-carrying ratings only)
    },
    {
      type: "vibe_note",
      when: "2026-01-03T00:00:00.000Z",
      text: "less fx please",
      trackName: "Track A",
      positionSeconds: 12,
    },
    {
      type: "fx_manual",
      when: "2026-01-01T00:10:00.000Z",
      fx: "airhorn",
      trackId: "t-a",
      trackName: "Track A",
      positionSeconds: 83,
      duringTransition: false,
    },
    {
      type: "fx_manual",
      when: "2026-01-01T00:20:00.000Z",
      fx: "airhorn",
      trackId: "t-a",
      trackName: "Track A",
      positionSeconds: 85,
      duringTransition: false,
    },
    {
      type: "fx_brain",
      when: "2026-01-01T00:30:00.000Z",
      fx: "siren",
      trackId: "t-a",
      trackName: "Track A",
      positionSeconds: 20,
      duringTransition: false,
    },
  ];

  const digest = distillForBrain(events, [{ id: "t-a", name: "Track A" }]);

  assertOk(
    "distillForBrain: global includes the note-carrying 👎 rating",
    digest.global.some((line) => line.includes("👎") && line.includes("too early"))
  );
  assertOk(
    "distillForBrain: global does NOT include the note-less 👍 rating (note-carrying ratings only — its transitionType 'cut' never appears)",
    !digest.global.some((line) => line.includes("(cut)"))
  );
  assertOk(
    "distillForBrain: global includes the vibe note",
    digest.global.some((line) => line.includes("less fx please"))
  );
  assertOk(
    "distillForBrain: global is most-recent-first (vibe note @ 01-03 before the rating @ 01-01)",
    digest.global[0].includes("less fx please")
  );
  assertOk(
    "distillForBrain: perTrack['t-a'] aggregates the two manual airhorn fires (x2)",
    digest.perTrack["t-a"].some((line) => line.includes("owner fired airhorn manually") && line.includes("x2"))
  );
  assertOk(
    "distillForBrain: perTrack['t-a'] does NOT include the brain-fired siren (fx_brain is context, not ground truth)",
    !digest.perTrack["t-a"].some((line) => line.includes("siren"))
  );
  assertOk(
    "distillForBrain: perTrack['t-a'] includes the note-carrying rating attributed to it as the outgoing track",
    digest.perTrack["t-a"].some((line) => line.includes("👎") && line.includes("too early"))
  );
  assertOk("distillForBrain: perTrack rating line includes the outPositionSeconds as mm:ss", digest.perTrack["t-a"].some((line) => line.includes("1:23")));
}

// --- candidate-window filtering: perTrack ONLY includes requested tracks ---
{
  const events = [
    { type: "fx_manual", when: "2026-01-01T00:00:00.000Z", fx: "riser", trackId: "not-a-candidate", trackName: "Off-window Track", positionSeconds: 5, duringTransition: false },
    { type: "fx_manual", when: "2026-01-01T00:00:00.000Z", fx: "laser", trackId: "in-window", trackName: "In-window Track", positionSeconds: 5, duringTransition: false },
  ];
  const digest = distillForBrain(events, [{ id: "in-window", name: "In-window Track" }]);
  assertOk("distillForBrain: perTrack includes only the requested candidate id", Object.keys(digest.perTrack).length === 1 && "in-window" in digest.perTrack);
  assertOk("distillForBrain: an fx event for a track NOT in the candidate list is excluded entirely", !("not-a-candidate" in digest.perTrack));
}

// --- empty inputs ---
{
  const digest = distillForBrain([], []);
  assertOk("distillForBrain: empty events -> empty global", Array.isArray(digest.global) && digest.global.length === 0);
  assertOk("distillForBrain: empty events -> empty perTrack", Object.keys(digest.perTrack).length === 0);
}

// --- global cap (≤10) and perTrack cap (≤3 per track) ---
{
  const events = [];
  for (let i = 0; i < 20; i++) {
    events.push({
      type: "vibe_note",
      when: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
      text: `note-${i}`,
    });
  }
  for (let i = 0; i < 10; i++) {
    events.push({
      type: "fx_manual",
      when: `2026-01-02T00:${String(i).padStart(2, "0")}:00.000Z`,
      fx: `fx-${i}`,
      trackId: "many-fx",
      trackName: "Many Fx Track",
      positionSeconds: i,
      duringTransition: false,
    });
  }
  const digest = distillForBrain(events, [{ id: "many-fx", name: "Many Fx Track" }]);
  assertOk("distillForBrain: global capped at 10 lines even with 20 vibe notes", digest.global.length <= 10);
  assertOk("distillForBrain: perTrack capped at 3 lines even with 10 distinct fx names", digest.perTrack["many-fx"].length <= 3);
}

// --- char budget: a huge number of candidate tracks with fx history still
// fits under the ~1500-char payload cap (trims whole tracks, not silently
// truncating mid-string) ---
{
  const events = [];
  const candidates = [];
  for (let i = 0; i < 150; i++) {
    const id = `track-${i}`;
    candidates.push({ id, name: `Some Fairly Long Track Title Number ${i}` });
    events.push({
      type: "fx_manual",
      when: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      fx: "airhorn",
      trackId: id,
      trackName: `Some Fairly Long Track Title Number ${i}`,
      positionSeconds: 42,
      duringTransition: false,
    });
  }
  const digest = distillForBrain(events, candidates);
  const payloadSize = JSON.stringify(digest).length;
  assertOk(`distillForBrain: total payload stays under the ~1500-char budget (got ${payloadSize})`, payloadSize <= 1600);
  assertOk("distillForBrain: char-budget trim drops WHOLE tracks, not partial lines", Object.values(digest.perTrack).every((lines) => lines.length > 0));
}

// --- merge/dedupe ---
{
  const a = [
    { type: "vibe_note", when: "2026-01-01T00:00:00.000Z", text: "first" },
    { type: "vibe_note", when: "2026-01-02T00:00:00.000Z", text: "second" },
  ];
  const b = [
    { type: "vibe_note", when: "2026-01-02T00:00:00.000Z", text: "second (duplicate, should be dropped)" },
    { type: "vibe_note", when: "2026-01-03T00:00:00.000Z", text: "third" },
  ];
  const merged = mergeLedgerEvents(a, b);
  assertOk("mergeLedgerEvents: keeps both originals + the one genuinely new event (3 total)", merged.length === 3);
  assertOk("mergeLedgerEvents: dedupes by type+when — the first-seen copy wins", merged[1].text === "second");
  assertOk("mergeLedgerEvents: the new event is appended", merged[2].text === "third");
}
{
  const merged = mergeLedgerEvents([], []);
  assertOk("mergeLedgerEvents: two empty lists -> empty", merged.length === 0);
}
{
  // Different types at the same `when` are NOT deduped against each other.
  const a = [{ type: "vibe_note", when: "2026-01-01T00:00:00.000Z", text: "note" }];
  const b = [{ type: "fx_manual", when: "2026-01-01T00:00:00.000Z", fx: "airhorn", duringTransition: false }];
  const merged = mergeLedgerEvents(a, b);
  assertOk("mergeLedgerEvents: same `when`, different `type` — both kept (dedupe key is type+when)", merged.length === 2);
}

// --- describeLedgerEvent (LessonsPanel's recent-events list) ---
{
  assertOk(
    "describeLedgerEvent: transition_rating",
    describeLedgerEvent({
      type: "transition_rating",
      when: "2026-01-01T00:00:00.000Z",
      fromTrackName: "A",
      toTrackName: "B",
      transitionType: "cut",
      durationBars: 8,
      clamped: false,
      degraded: false,
      rating: "up",
    }).includes("👍")
  );
  assertOk(
    "describeLedgerEvent: fx_manual",
    describeLedgerEvent({ type: "fx_manual", when: "2026-01-01T00:00:00.000Z", fx: "airhorn", duringTransition: false }).startsWith("manual:")
  );
  assertOk(
    "describeLedgerEvent: fx_brain",
    describeLedgerEvent({ type: "fx_brain", when: "2026-01-01T00:00:00.000Z", fx: "siren", duringTransition: false }).includes("El Cerebro")
  );
  assertOk(
    "describeLedgerEvent: vibe_note",
    describeLedgerEvent({ type: "vibe_note", when: "2026-01-01T00:00:00.000Z", text: "less fx" }).includes("less fx")
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all lesson-ledger cases");
