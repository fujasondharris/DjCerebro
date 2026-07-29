#!/usr/bin/env node
// Node-side smoke test for src/lib/lessons-sync.ts's parseSyncEventsBody —
// the request-body validation POST /api/lessons uses before merging/writing
// to the blob store. Plain asserts, no test framework, no network/server,
// mirrors scripts/check-crate-route.mjs.
import { parseSyncEventsBody } from "../src/lib/lessons-sync.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

// --- valid bodies ---
{
  const result = parseSyncEventsBody({ events: [] });
  assertOk("parseSyncEventsBody: empty events array is valid", result.ok === true && result.events.length === 0);
}
{
  const result = parseSyncEventsBody({
    events: [{ type: "vibe_note", when: "2026-07-29T00:00:00.000Z", text: "sync-test" }],
  });
  assertOk(
    "parseSyncEventsBody: a well-shaped vibe_note event is valid",
    result.ok === true && result.events.length === 1 && result.events[0].type === "vibe_note"
  );
}
{
  // Extra fields on an otherwise well-shaped event are allowed through
  // (full per-variant shape validation is lesson-ledger.ts's own job).
  const result = parseSyncEventsBody({
    events: [{ type: "fx_manual", when: "2026-07-29T00:00:00.000Z", fx: "airhorn", duringTransition: false, extra: 1 }],
  });
  assertOk("parseSyncEventsBody: extra fields on an event don't fail validation", result.ok === true);
}

// --- rejected bodies ---
{
  const result = parseSyncEventsBody(null);
  assertOk("parseSyncEventsBody: null body rejected", result.ok === false);
}
{
  const result = parseSyncEventsBody({});
  assertOk("parseSyncEventsBody: missing `events` key rejected", result.ok === false);
}
{
  const result = parseSyncEventsBody({ events: "not-an-array" });
  assertOk("parseSyncEventsBody: non-array `events` rejected", result.ok === false);
}
{
  const result = parseSyncEventsBody({ events: [{ when: "2026-07-29T00:00:00.000Z" }] });
  assertOk("parseSyncEventsBody: event missing `type` rejected", result.ok === false);
}
{
  const result = parseSyncEventsBody({ events: [{ type: "vibe_note" }] });
  assertOk("parseSyncEventsBody: event missing `when` rejected", result.ok === false);
}
{
  const result = parseSyncEventsBody({ events: [{ type: 5, when: "2026-07-29T00:00:00.000Z" }] });
  assertOk("parseSyncEventsBody: non-string `type` rejected", result.ok === false);
}
{
  const result = parseSyncEventsBody({ events: [null] });
  assertOk("parseSyncEventsBody: a null event in the array rejected", result.ok === false);
}
{
  // One bad event among good ones rejects the whole batch (fail-closed, not
  // a partial write).
  const result = parseSyncEventsBody({
    events: [
      { type: "vibe_note", when: "2026-07-29T00:00:00.000Z", text: "ok" },
      { type: "vibe_note" },
    ],
  });
  assertOk("parseSyncEventsBody: one malformed event rejects the whole batch", result.ok === false);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all lessons-sync cases");
