#!/usr/bin/env node
// Node-side smoke test for the cue-point feature's pure logic — persistence
// shape/eviction (src/lib/cue-store.ts) and source-time -> wall-time
// scheduling math (src/lib/cue-schedule.ts) — no AudioContext, no
// localStorage (Node has none; cue-store.ts's hasLocalStorage() guard makes
// load/save no-ops here, so this exercises the pure evict/mutate/schedule
// functions directly, same spirit as check-gain.mjs/check-beatclock.mjs).
import {
  cueTrackKey,
  evictOldestTracks,
  getCues,
  setCues,
  addCue,
  updateCueAction,
  deleteCue,
  nudgeCue,
  buildSuggestedCues,
  seedSuggestedCues,
} from "../src/lib/cue-store.ts";
import {
  upcomingCues,
  computeDelaySeconds,
  computeDelayMs,
  computeExpectedFireAtMs,
  shouldRearm,
} from "../src/lib/cue-schedule.ts";

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

// --- cueTrackKey ---

assertOk(
  "cueTrackKey: drive track keyed by the real Drive id",
  cueTrackKey({ source: "drive", id: "1AbCdEf", name: "whatever.mp3", size: 999 }) === "drive:1AbCdEf"
);
assertOk(
  "cueTrackKey: local track keyed by name+size, NOT by whatever random id it was assigned",
  cueTrackKey({ source: "local", id: "some-random-uuid", name: "song.mp3", size: 4242 }) === "local:song.mp3:4242"
);
assertOk(
  "cueTrackKey: local track with null size falls back to 0 (never throws/NaNs)",
  cueTrackKey({ source: "local", id: "", name: "song.mp3", size: null }) === "local:song.mp3:0"
);
assertOk(
  "cueTrackKey: two different drive ids never collide",
  cueTrackKey({ source: "drive", id: "a", name: "x", size: 1 }) !== cueTrackKey({ source: "drive", id: "b", name: "x", size: 1 })
);

// --- addCue / updateCueAction / deleteCue / nudgeCue (plain Cue[] mutators) ---

{
  let cues = [];
  cues = addCue(cues, 12.5);
  assertOk("addCue: appends one cue", cues.length === 1);
  assertOk("addCue: stamped at the given atSeconds", cues[0].atSeconds === 12.5);
  assertOk("addCue: defaults to an unassigned clip action", cues[0].action.type === "clip" && cues[0].action.file === null);

  cues = addCue(cues, -3);
  assertOk("addCue: clamps a negative atSeconds to 0", cues[1].atSeconds === 0);

  cues = updateCueAction(cues, 0, { type: "clip", file: "cue-dale-hype.mp3" });
  assertOk("updateCueAction: assigns a clip file to the given index only", cues[0].action.file === "cue-dale-hype.mp3");
  assertOk("updateCueAction: leaves other cues untouched", cues[1].action.file === null);

  cues = updateCueAction(cues, 1, { type: "singalong", durationSeconds: 8 });
  assertOk("updateCueAction: can switch a cue to a singalong action", cues[1].action.type === "singalong" && cues[1].action.durationSeconds === 8);

  const beforeNudge = cues[0].atSeconds;
  cues = nudgeCue(cues, 0, 0.25);
  assertOk("nudgeCue: +0.25s moves only the targeted cue", approxEqual(cues[0].atSeconds, beforeNudge + 0.25));
  cues = nudgeCue(cues, 0, -100);
  assertOk("nudgeCue: clamps to 0, never goes negative", cues[0].atSeconds === 0);

  const lengthBefore = cues.length;
  cues = deleteCue(cues, 0);
  assertOk("deleteCue: removes exactly one cue", cues.length === lengthBefore - 1);
}

// --- setCues / getCues (store-level, sorted + lastTouchedMs) ---

{
  let store = {};
  store = setCues(store, "drive:abc", [{ atSeconds: 30, action: { type: "clip", file: null } }, { atSeconds: 5, action: { type: "clip", file: null } }], 1000);
  const cues = getCues(store, "drive:abc");
  assertOk("setCues: sorts cues ascending by atSeconds", cues[0].atSeconds === 5 && cues[1].atSeconds === 30);
  assertOk("setCues: records lastTouchedMs from the injectable nowMs", store["drive:abc"].lastTouchedMs === 1000);
  assertOk("getCues: unknown key returns an empty array, not undefined/throw", Array.isArray(getCues(store, "nope")) && getCues(store, "nope").length === 0);
}

// --- evictOldestTracks (LRU cap ~50) ---

{
  let store = {};
  for (let i = 0; i < 50; i++) {
    store[`t${i}`] = { cues: [], lastTouchedMs: i }; // t0 is oldest, t49 is newest
  }
  assertOk("evictOldestTracks: under the cap is a no-op", Object.keys(evictOldestTracks(store, 50)).length === 50);

  store["t50"] = { cues: [], lastTouchedMs: 50 }; // 51 tracks now, one over cap
  const evicted = evictOldestTracks(store, 50);
  assertOk("evictOldestTracks: drops exactly one track over the cap", Object.keys(evicted).length === 50);
  assertOk("evictOldestTracks: drops the OLDEST-touched track (t0), not an arbitrary one", !("t0" in evicted));
  assertOk("evictOldestTracks: keeps the newest-touched track (t50)", "t50" in evicted);
  assertOk("evictOldestTracks: keeps everything else untouched", "t1" in evicted && "t49" in evicted);
}

{
  // setCues itself evicts — a 51st track pushed in via setCues shouldn't
  // silently grow the store past the cap either.
  let store = {};
  for (let i = 0; i < 50; i++) {
    store = setCues(store, `t${i}`, [], i);
  }
  store = setCues(store, "t50", [], 999);
  assertOk("setCues: evicts on every write, never grows past MAX_CUE_TRACKS", Object.keys(store).length === 50);
  assertOk("setCues: the just-written track always survives its own write", "t50" in store);
}

// --- Suggested cues (synced-lyrics pipeline seeding — see
// scripts/suggest-cues.mjs / src/data/cue-suggestions.json) ---

{
  const suggestions = [
    { atSeconds: 24.1, label: "(¿Pa' dónde?)" },
    { atSeconds: -3, label: "(negative clamps to 0)" },
  ];
  const built = buildSuggestedCues(suggestions);
  assertOk("buildSuggestedCues: builds one Cue per suggestion", built.length === 2);
  assertOk("buildSuggestedCues: suggested:true on every built cue", built.every((c) => c.suggested === true));
  assertOk(
    "buildSuggestedCues: always an UNASSIGNED/INERT clip action, never pre-assigned",
    built.every((c) => c.action.type === "clip" && c.action.file === null)
  );
  assertOk("buildSuggestedCues: carries the lyric label through", built[0].label === "(¿Pa' dónde?)");
  assertOk("buildSuggestedCues: clamps a negative atSeconds to 0, same as addCue()", built[1].atSeconds === 0);
}

{
  const suggestions = [{ atSeconds: 10, label: "(Nueva York)" }];
  assertOk("seedSuggestedCues: seeds a track with no cues yet", seedSuggestedCues([], suggestions).length === 1);
  assertOk(
    "seedSuggestedCues: seeded cue is suggested + inert",
    seedSuggestedCues([], suggestions)[0].suggested === true && seedSuggestedCues([], suggestions)[0].action.file === null
  );

  const existing = [{ atSeconds: 5, action: { type: "clip", file: "tag-fiesta.mp3" } }];
  const result = seedSuggestedCues(existing, suggestions);
  assertOk("seedSuggestedCues: NEVER overwrites a track that already has any cue (user-marked or previously seeded)", result === existing);
  assertOk("seedSuggestedCues: no-op returns the exact same array reference (cheap no-op detection for callers)", result === existing);

  assertOk("seedSuggestedCues: no suggestions available -> untouched existing (even if empty)", seedSuggestedCues([], []).length === 0);
}

{
  // The scheduler-inertness contract: a suggested cue's action is
  // {type:"clip", file:null} — the exact same shape page.tsx's fireCue()
  // already no-ops on for any unassigned clip cue (see cue-store.ts's own
  // addCue(), which has always defaulted to this same inert shape for a
  // fresh MARK). No separate "is it suggested" branch is needed at fire
  // time; this assertion pins that invariant so it can never silently drift.
  const seeded = buildSuggestedCues([{ atSeconds: 12, label: "(Uh)" }]);
  assertOk(
    "INERT-UNTIL-ASSIGNED invariant: a suggested cue's action shape is indistinguishable, at fire time, from an unassigned MARK cue",
    JSON.stringify(seeded[0].action) === JSON.stringify(addCue([], 12)[0].action)
  );
}

// --- suggested flag clears on assign/nudge (user takes ownership) ---

{
  let cues = buildSuggestedCues([{ atSeconds: 24.1, label: "(¿Pa' dónde?)" }]);
  assertOk("setup: cue starts suggested", cues[0].suggested === true);

  cues = updateCueAction(cues, 0, { type: "clip", file: "adlib-pa-donde.mp3" });
  assertOk("updateCueAction: assigning a clip clears the suggested flag", cues[0].suggested === undefined);
  assertOk("updateCueAction: the assignment itself still applies", cues[0].action.file === "adlib-pa-donde.mp3");
}

{
  let cues = buildSuggestedCues([{ atSeconds: 24.1, label: "(¿Pa' dónde?)" }]);
  cues = nudgeCue(cues, 0, 0.25);
  assertOk("nudgeCue: fine-tuning also clears the suggested flag", cues[0].suggested === undefined);
  assertOk("nudgeCue: the nudge itself still applies", approxEqual(cues[0].atSeconds, 24.35));
}

{
  // A cue the user MARKed themselves was never suggested in the first place
  // — updateCueAction/nudgeCue on it is a pure no-op for the flag (stays undefined).
  let cues = addCue([], 5);
  cues = updateCueAction(cues, 0, { type: "clip", file: "tag-fiesta.mp3" });
  assertOk("updateCueAction: a plain MARK cue (never suggested) stays unsuggested after assignment", cues[0].suggested === undefined);
}

// --- cue-schedule.ts: upcomingCues ---

{
  const cues = [
    { atSeconds: 10, action: { type: "clip", file: "a.mp3" } },
    { atSeconds: 40, action: { type: "clip", file: "b.mp3" } },
    { atSeconds: 25, action: { type: "clip", file: "c.mp3" } },
  ];
  const upcoming = upcomingCues(cues, 20);
  assertOk("upcomingCues: excludes cues already passed", upcoming.every((c) => c.atSeconds >= 20));
  assertOk("upcomingCues: sorted ascending", upcoming[0].atSeconds === 25 && upcoming[1].atSeconds === 40);
  assertOk("upcomingCues: past cue (10) is gone", !upcoming.some((c) => c.atSeconds === 10));

  const atBoundary = upcomingCues(cues, 25.005); // within the default epsilon (0.01) of the 25s cue
  assertOk("upcomingCues: epsilon tolerates progress-tick rounding right at a cue's own timestamp", atBoundary.some((c) => c.atSeconds === 25));
}

// --- cue-schedule.ts: source-time -> wall-time delay math ---

assertOk("computeDelaySeconds: tempo 1.0, cue 10s ahead of position -> 10s wall-clock delay", computeDelaySeconds(30, 20, 1.0) === 10);
assertOk(
  "computeDelaySeconds: tempo > 1 (sped up) shrinks the wall-clock delay — same source distance arrives sooner",
  approxEqual(computeDelaySeconds(30, 20, 1.08), 10 / 1.08)
);
assertOk(
  "computeDelaySeconds: tempo < 1 (slowed down) stretches the wall-clock delay",
  approxEqual(computeDelaySeconds(30, 20, 0.92), 10 / 0.92)
);
assertOk("computeDelaySeconds: cue already passed -> negative delay", computeDelaySeconds(10, 20, 1.0) < 0);
assertOk("computeDelayMs: matches computeDelaySeconds * 1000", computeDelayMs(30, 20, 1.0) === 10000);

{
  const expected = computeExpectedFireAtMs(30, 20, 1.0, 100000);
  assertOk("computeExpectedFireAtMs: nowMs + delayMs", expected === 100000 + 10000);
}

// --- cue-schedule.ts: drift/re-arm decision ---

assertOk("shouldRearm: identical expected time -> no rearm", !shouldRearm(500000, 500000));
assertOk("shouldRearm: 50ms drift (under the 100ms threshold) -> no rearm (normal tick jitter)", !shouldRearm(500000, 500050));
assertOk("shouldRearm: 150ms drift (over threshold) -> rearm", shouldRearm(500000, 500150));
assertOk("shouldRearm: negative-direction drift over threshold also rearms", shouldRearm(500000, 499800));
assertOk("shouldRearm: custom threshold respected", !shouldRearm(500000, 500080, 200) && shouldRearm(500000, 500080, 50));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all cue-store/cue-schedule pure-logic cases");
