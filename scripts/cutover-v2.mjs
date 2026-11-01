#!/usr/bin/env node
// M8.1n — the v2 CUTOVER: swap the app onto the trimmed crate + stems, as ONE unit.
//
// Owner's call (2026-08-15): "wait the 6 hours and flip it all at once." So this
// does the whole switch in one deliberate step, and refuses to start if any input
// is not ready - a half-cutover (new folder, old data) is worse than no cutover,
// because the app would list v2 and find no tags for anything.
//
// PRECONDITIONS, all checked before a single file is touched:
//   - stem-manifest-v2.json exists and resolves stems for a sane share of tracks
//   - loop-points/vocal-maps/cue-suggestions -v2.json exist
//   - crate-manifest.json has been regenerated against v2 (spot-checked: an id in
//     it must appear in loop-points-v2)
//
// WHAT IT DOES:
//   1. Backs up every file it will overwrite to src/data/_pre-v2/  (the ROLLBACK)
//   2. Renames *-v2.json over the live files the app imports
//   3. Prints the two things it will NOT do for you, because they touch prod:
//        vercel env: GOOGLE_DRIVE_FOLDER_ID -> the v2 id
//        vercel --prod --yes
//      (kept manual so the last irreversible step is a human keystroke)
//
// ROLLBACK: restore src/data/_pre-v2/*, set the env var back, redeploy. Old Drive
// folder is never touched, so rollback is complete.
//
// Usage: node --experimental-strip-types --no-warnings scripts/cutover-v2.mjs [--apply]
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = path.join(REPO_ROOT, "src", "data");
const BACKUP = path.join(DATA, "_pre-v2");
const APPLY = process.argv.includes("--apply");
const V2_FOLDER_ID = "1Y7QtljFoUOaoCAp78k2YrlPNwtIk6-Yo";

const SWAPS = [
  ["loop-points-v2.json", "loop-points.json"],
  ["vocal-maps-v2.json", "vocal-maps.json"],
  ["cue-suggestions-v2.json", "cue-suggestions.json"],
  ["stem-manifest-v2.json", "stem-manifest.json"],
];

let blocked = false;
const say = (ok, msg) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) blocked = true; };

console.log("preconditions:");
for (const [src] of SWAPS) say(existsSync(path.join(DATA, src)), `${src} exists`);

if (existsSync(path.join(DATA, "stem-manifest-v2.json"))) {
  const sm = JSON.parse(readFileSync(path.join(DATA, "stem-manifest-v2.json"), "utf8"));
  const n = Object.keys(sm).length;
  const allDriveIds = Object.values(sm).every((e) => Object.values(e.stems).every((v) => !String(v).includes("/")));
  say(n >= 250, `stem-manifest-v2 resolves ${n} tracks (need >= 250 of ~310)`);
  say(allDriveIds, "every stem value in stem-manifest-v2 is a Drive id, not a local path");
}

const crate = JSON.parse(readFileSync(path.join(DATA, "crate-manifest.json"), "utf8"));
if (existsSync(path.join(DATA, "loop-points-v2.json"))) {
  const lp = JSON.parse(readFileSync(path.join(DATA, "loop-points-v2.json"), "utf8"));
  const sample = crate.slice(0, 40).map((t) => t.id);
  const hits = sample.filter((id) => `drive:${id}` in lp || id in lp).length;
  say(hits >= 30, `crate-manifest.json is v2-keyed (${hits}/40 sampled ids present in loop-points-v2) — regenerate with make:crate-manifest against v2 if this fails`);
}

if (blocked) {
  console.error("\nBLOCKED — fix the failing precondition(s) above. Nothing was changed.");
  process.exit(1);
}

if (!APPLY) {
  console.log("\nDRY RUN — all preconditions pass. Re-run with --apply to swap.");
  process.exit(0);
}

mkdirSync(BACKUP, { recursive: true });
console.log(`\nbacking up to ${path.relative(REPO_ROOT, BACKUP)}/ then swapping:`);
for (const [src, dst] of SWAPS) {
  const dstPath = path.join(DATA, dst);
  if (existsSync(dstPath)) copyFileSync(dstPath, path.join(BACKUP, dst));
  renameSync(path.join(DATA, src), dstPath);
  console.log(`  ${src}  ->  ${dst}`);
}
writeFileSync(path.join(BACKUP, "README.txt"),
  `Pre-v2 backups taken ${new Date().toISOString()}.\nROLLBACK: copy these over src/data/, set GOOGLE_DRIVE_FOLDER_ID back to the old folder, redeploy.\n`);

console.log(`
Data swapped. TWO steps left, deliberately manual (they change production):

  1. vercel env rm GOOGLE_DRIVE_FOLDER_ID production --yes
     printf '%s' '${V2_FOLDER_ID}' | vercel env add GOOGLE_DRIVE_FOLDER_ID production --sensitive
     (and update .env.local to match)

  2. vercel --prod --yes

Then verify: /api/crate lists ${crate.length}-ish tracks from v2, and stem_migrate
stops logging "has no stems available".
`);
