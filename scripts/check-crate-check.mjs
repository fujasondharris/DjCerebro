#!/usr/bin/env node
// Node-side smoke test for the pure classification logic scripts/crate-check.mjs
// depends on: imports the exact same src/lib/crate-check.ts and asserts
// classifyEntry()'s READY vs NEEDS SERATO PASS calls, incl. every
// missing-tag combination. Plain asserts, no test framework, mirrors
// check-pricing.mjs.
import { classifyEntry } from "../src/lib/crate-check.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

function sameMissing(actual, expected) {
  return actual.length === expected.length && expected.every((m) => actual.includes(m));
}

assertOk(
  "classifyEntry: BPM+key both present -> ready, no missing",
  (() => {
    const r = classifyEntry({ bpm: 120, key: "8A" });
    return r.ready === true && sameMissing(r.missing, []);
  })()
);

assertOk(
  "classifyEntry: missing BPM only -> not ready, missing = [BPM]",
  (() => {
    const r = classifyEntry({ key: "8A" });
    return r.ready === false && sameMissing(r.missing, ["BPM"]);
  })()
);

assertOk(
  "classifyEntry: missing key only -> not ready, missing = [key]",
  (() => {
    const r = classifyEntry({ bpm: 120 });
    return r.ready === false && sameMissing(r.missing, ["key"]);
  })()
);

assertOk(
  "classifyEntry: missing both -> not ready, missing = [BPM, key]",
  (() => {
    const r = classifyEntry({});
    return r.ready === false && sameMissing(r.missing, ["BPM", "key"]);
  })()
);

assertOk(
  "classifyEntry: empty-string key treated as missing (falsy, same as absent)",
  (() => {
    const r = classifyEntry({ bpm: 120, key: "" });
    return r.ready === false && sameMissing(r.missing, ["key"]);
  })()
);

assertOk(
  "classifyEntry: bpm=0 treated as missing (id3.ts never emits 0, but guard against it)",
  (() => {
    const r = classifyEntry({ bpm: 0, key: "8A" });
    return r.ready === false && sameMissing(r.missing, ["BPM"]);
  })()
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all crate-check classification cases");
