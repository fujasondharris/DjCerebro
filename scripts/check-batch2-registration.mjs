#!/usr/bin/env node
// Golden for the batch-2 (local-only tracks) path: register-local-tracks.mjs ->
// make-trim-plan.mjs. Asserts (1) registration is additive — no local: id leaks into the
// LIVE manifests, and (post-cutover) only the 3 held tracks are absent from them; (2) every batch-2 stem entry is
// keyed to its own track and points at the htdemucs_6s tree; (3) every planned local:
// track carries the PRE-cut grid (sourceGrid === the registered grid), so the post-cut
// grid is shiftGrid(sourceGrid, headSeconds) with no git ref; (4) that shift is usable.
// Reads committed data only; run register-local-tracks + make-trim-plan first to refresh.
//
// Usage: npm run check:batch2
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shiftGrid } from "./restore-trimmed-grids.mjs";

const DATA = path.join(fileURLToPath(new URL("..", import.meta.url)), "src", "data");
const load = (f) => JSON.parse(readFileSync(path.join(DATA, f), "utf8"));
let failures = 0;
const ok = (l, c, d = "") => { if (c) console.log(`  ok   ${l}`); else { failures++; console.error(`  FAIL ${l}${d ? " — " + d : ""}`); } };

const liveCrate = load("crate-manifest.json"), liveStems = load("stem-manifest.json");
const crate2 = load("crate-manifest-batch2.json"), stems2 = load("stem-manifest-batch2.json");
const plan = load("trim-plan.json");
const liveNames = new Set(liveCrate.map((t) => t.name));

ok("batch-2 crate is non-empty", crate2.length > 0);
ok("every batch-2 id is local:<name>", crate2.every((t) => t.id === `local:${t.name}`));
ok("no local: id leaked into live crate/stem manifests",
  !liveCrate.some((t) => String(t.id).startsWith("local:")) && !Object.keys(liveStems).some((k) => k.startsWith("local:")));
// Post-cutover (Drive batch 2 uploaded, live manifests regenerated): the batch-2 names ARE live now,
// keyed by Drive id. The sibling files are kept as pre-cut provenance only; the 3 held tracks
// (never uploaded) must be the only names still absent from the live manifest.
const HELD = ["Por Ah", "Throw Ya Gunz", "Steady Mobbin"];
const absent = crate2.filter((t) => !liveNames.has(t.name));
ok("every batch-2 name is live exactly once, except the 3 held tracks",
  absent.length === 3 && absent.every((t) => HELD.some((h) => t.name.includes(h))) && liveCrate.length === new Set(liveCrate.map((t) => t.name)).size,
  `absent=${absent.length}`);
ok("every batch-2 stem entry belongs to a registered track and its name",
  Object.entries(stems2).every(([id, e]) => crate2.some((t) => t.id === id && t.name === e.name)));
ok("every stem path is under htdemucs_6s/",
  Object.values(stems2).every((e) => Object.values(e.stems).every((p) => p.startsWith("htdemucs_6s/"))));

const planned = crate2.filter((t) => plan[t.id]);
ok("batch-2 tracks are planned", planned.length > 0, `planned=${planned.length}`);
const badCapture = planned.filter((t) => JSON.stringify(plan[t.id].sourceGrid) !== JSON.stringify(t.grid ?? null));
ok("plan.sourceGrid equals the registered pre-cut grid for every planned track", badCapture.length === 0,
  badCapture.slice(0, 2).map((t) => t.name).join("; "));

const cutGridded = planned.filter((t) => t.grid && plan[t.id].headSeconds > 0);
const badShift = cutGridded.filter((t) => {
  const s = shiftGrid(plan[t.id].sourceGrid, plan[t.id].headSeconds);
  return !s || s.anchor !== 0 || !s.markers.every((m) => m.position >= 0);
});
ok(`shiftGrid(sourceGrid, head) is valid for all ${cutGridded.length} head-cut gridded tracks`, badShift.length === 0,
  badShift.slice(0, 2).map((t) => t.name).join("; "));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nPASS: batch-2 registration + grid capture");
