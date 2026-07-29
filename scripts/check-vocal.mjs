#!/usr/bin/env node
// Node-side smoke test for the vocal-clip library's pure logic — manifest
// categorization (src/lib/vocal-manifest.ts) and rotation/grouping
// (src/lib/vocal.ts) — no AudioContext, no filesystem scan, mirrors
// check-command.mjs/check-scratch.mjs's plain-assert style.
import { categorizeFilename, buildVocalManifest } from "../src/lib/vocal-manifest.ts";
import { groupManifestByCategory, pickNextVocalClip, VOCAL_CATEGORIES, HOST_ONLY_CATEGORIES } from "../src/lib/vocal.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

// --- categorizeFilename: prefix rules ---

assertOk("categorize: tag- prefix -> tag", categorizeFilename("tag-dale.mp3").category === "tag");
assertOk("categorize: tag2- prefix -> tag", categorizeFilename("tag2-fiesta.mp3").category === "tag");
assertOk("categorize: drop- prefix -> drop", categorizeFilename("drop-cerebro-nohands.mp3").category === "drop");
assertOk("categorize: adlib- prefix -> adlib", categorizeFilename("adlib-wepa.mp3").category === "adlib");
assertOk("categorize: crowd- prefix -> crowd", categorizeFilename("crowd-countdown.mp3").category === "crowd");
assertOk("categorize: cue-*-warm -> cue_warm", categorizeFilename("cue-dale-warm.mp3").category === "cue_warm");
assertOk("categorize: cue-*-hype -> cue_hype", categorizeFilename("cue-dale-hype.mp3").category === "cue_hype");
assertOk("categorize: known prefixes never flagged unknown", !categorizeFilename("tag-dale.mp3").unknown);

{
  const result = categorizeFilename("mystery-clip.mp3");
  assertOk("categorize: unrecognized prefix defaults to tag", result.category === "tag");
  assertOk("categorize: unrecognized prefix flags unknown", result.unknown === true);
}

{
  // A "cue-" file that isn't warm/hype-suffixed is itself unrecognized (not
  // a silent cue_warm/cue_hype guess) — falls through to the tag default.
  const result = categorizeFilename("cue-random.mp3");
  assertOk("categorize: cue- without warm/hype suffix is unknown, not silently cue_*", result.unknown === true);
}

// --- shoutout- prefix (host-only occasion callouts) ---

assertOk("categorize: shoutout- prefix -> shoutout", categorizeFilename("shoutout-happybirthday.mp3").category === "shoutout");
assertOk("categorize: shoutout- prefix never flagged unknown", !categorizeFilename("shoutout-happybirthday.mp3").unknown);
assertOk(
  "categorize: shoutout is NOT in VOCAL_CATEGORIES — the brain-eligible fx enum can never route to it",
  !VOCAL_CATEGORIES.includes("shoutout")
);
assertOk("categorize: shoutout IS in HOST_ONLY_CATEGORIES — the manual host pad can still fire it", HOST_ONLY_CATEGORIES.includes("shoutout"));

// --- buildVocalManifest ---

{
  const { manifest, warnings } = buildVocalManifest(["tag-dale.mp3", "drop-x.mp3", "weird-file.mp3"]);
  assertOk("buildVocalManifest: preserves input order", manifest.map((m) => m.file).join(",") === "tag-dale.mp3,drop-x.mp3,weird-file.mp3");
  assertOk("buildVocalManifest: maps categories correctly", manifest[0].category === "tag" && manifest[1].category === "drop" && manifest[2].category === "tag");
  assertOk("buildVocalManifest: one warning for the one unknown-prefix file", warnings.length === 1);
  assertOk("buildVocalManifest: warning mentions the offending filename", warnings[0].includes("weird-file.mp3"));
}

assertOk("buildVocalManifest: empty input -> empty manifest, no warnings", (() => {
  const { manifest, warnings } = buildVocalManifest([]);
  return manifest.length === 0 && warnings.length === 0;
})());

// --- groupManifestByCategory ---

{
  const groups = groupManifestByCategory([
    { file: "tag-a.mp3", category: "tag" },
    { file: "tag-b.mp3", category: "tag" },
    { file: "drop-a.mp3", category: "drop" },
  ]);
  assertOk("groupManifestByCategory: groups by category", groups.tag.length === 2 && groups.drop.length === 1);
  assertOk("groupManifestByCategory: preserves order within a category", groups.tag[0] === "tag-a.mp3" && groups.tag[1] === "tag-b.mp3");
  assertOk("groupManifestByCategory: every VOCAL_CATEGORIES key present, even when empty", VOCAL_CATEGORIES.every((c) => Array.isArray(groups[c])));
  assertOk("groupManifestByCategory: absent category is an empty array, not undefined", Array.isArray(groups.adlib) && groups.adlib.length === 0);
  assertOk("groupManifestByCategory: shoutout key present even with zero clips", Array.isArray(groups.shoutout) && groups.shoutout.length === 0);
}

{
  const groups = groupManifestByCategory([{ file: "shoutout-happybirthday.mp3", category: "shoutout" }]);
  assertOk("groupManifestByCategory: shoutout clips group correctly when present", groups.shoutout.length === 1 && groups.shoutout[0] === "shoutout-happybirthday.mp3");
}

// --- pickNextVocalClip: rotation / no-repeat ---

assertOk("pickNextVocalClip: empty list -> null", pickNextVocalClip([], null) === null);
assertOk("pickNextVocalClip: single file, no lastFile -> that file", pickNextVocalClip(["only.mp3"], null) === "only.mp3");
assertOk("pickNextVocalClip: single file, even as lastFile -> still returns it (nothing else to pick)", pickNextVocalClip(["only.mp3"], "only.mp3") === "only.mp3");

{
  // Deterministic random (always picks index 0 of the candidate pool) lets
  // us assert the no-repeat filter precisely.
  const zeroRandom = () => 0;
  const files = ["a.mp3", "b.mp3", "c.mp3"];
  assertOk("pickNextVocalClip: no lastFile picks from the full list (index 0)", pickNextVocalClip(files, null, zeroRandom) === "a.mp3");
  assertOk(
    "pickNextVocalClip: excludes lastFile from the candidate pool",
    pickNextVocalClip(files, "a.mp3", zeroRandom) === "b.mp3"
  );
  assertOk(
    "pickNextVocalClip: never returns lastFile across many draws with real randomness",
    (() => {
      let last = null;
      for (let i = 0; i < 200; i++) {
        const next = pickNextVocalClip(files, last);
        if (next === last) return false;
        last = next;
      }
      return true;
    })()
  );
}

{
  // lastFile not actually present in this category (e.g. category switched)
  // — falls back to the full list rather than returning null/throwing.
  const files = ["a.mp3", "b.mp3"];
  const result = pickNextVocalClip(files, "not-in-this-category.mp3", () => 0);
  assertOk("pickNextVocalClip: lastFile absent from category falls back to full list", result === "a.mp3");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all vocal-manifest/rotation cases");
