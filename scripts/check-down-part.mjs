#!/usr/bin/env node
// Node-side check for M7 Phase 5's down-part detector (src/lib/down-part.ts)
// and the brand wall on the voice-tag generator (scripts/make-voice-tag.mjs's
// violatesBrandWall — imported, never invoked, so no network call fires).
// Plain asserts, no test framework.
//
// The load-bearing rule: NEVER over a vocal. A hype tag landing on the singer
// is the most obviously wrong thing the app can do with a voice clip, so the
// vocal check is a hard filter and "no vocal map" yields NO windows rather
// than a hopeful guess.
import { findDownParts, pickDownPart } from "../src/lib/down-part.ts";
import { violatesBrandWall } from "./make-voice-tag.mjs";
import { SYSTEM_PROMPT } from "../src/lib/brain.ts";
import VOCAL_MANIFEST from "../src/data/vocal-manifest.json" with { type: "json" };

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

/** 60s of loud track with a quiet breakdown at [20,30). */
function profile() {
  const rms = new Array(60).fill(1);
  for (let i = 20; i < 30; i++) rms[i] = 0.1;
  return rms;
}

// --- The basic find ------------------------------------------------------
{
  const parts = findDownParts(profile(), { hasVocalMap: true, vocalIntervals: [] });
  assertOk("a quiet breakdown is found", parts.length === 1);
  assertOk("the window covers the breakdown", parts[0].start === 20 && parts[0].end === 30);
  assertOk("relativeEnergy reports how quiet it is vs the track's own median", parts[0].relativeEnergy < 0.2);
}

// --- NEVER over a vocal --------------------------------------------------
{
  const overlapping = findDownParts(profile(), { hasVocalMap: true, vocalIntervals: [[25, 27]] });
  assertOk("a breakdown with a vocal in it is REJECTED entirely", overlapping.length === 0);

  const touchingStart = findDownParts(profile(), { hasVocalMap: true, vocalIntervals: [[10, 20]] });
  assertOk("a vocal ending exactly where the window starts does not reject it (half-open)", touchingStart.length === 1);

  const touchingEnd = findDownParts(profile(), { hasVocalMap: true, vocalIntervals: [[30, 40]] });
  assertOk("a vocal starting exactly where the window ends does not reject it (half-open)", touchingEnd.length === 1);

  const straddling = findDownParts(profile(), { hasVocalMap: true, vocalIntervals: [[18, 22]] });
  assertOk("a vocal straddling the window edge rejects it", straddling.length === 0);

  const covering = findDownParts(profile(), { hasVocalMap: true, vocalIntervals: [[0, 600]] });
  assertOk("a vocal covering the whole track leaves no windows", covering.length === 0);
}

// --- "We didn't check" is not "it's clear" -------------------------------
{
  assertOk("no vocal map yields NO windows, never a hopeful guess", findDownParts(profile(), { hasVocalMap: false }).length === 0);
  assertOk("hasVocalMap defaults to false (safe default)", findDownParts(profile()).length === 0);
}

// --- Degenerate input ----------------------------------------------------
{
  assertOk("an empty profile yields nothing", findDownParts([], { hasVocalMap: true }).length === 0);
  assertOk("a silent track yields nothing (silence is not a musical down part)", findDownParts(new Array(60).fill(0), { hasVocalMap: true }).length === 0);
  assertOk("a uniformly loud track has no down part", findDownParts(new Array(60).fill(1), { hasVocalMap: true, vocalIntervals: [] }).length === 0);
}

// --- Window-length and lead-in guards ------------------------------------
{
  const brief = new Array(60).fill(1);
  brief[30] = 0.1; // a single quiet second
  assertOk("a one-second dip is too short to be a window", findDownParts(brief, { hasVocalMap: true, vocalIntervals: [] }).length === 0);

  const leadIn = new Array(60).fill(1);
  for (let i = 0; i < 6; i++) leadIn[i] = 0.1; // quiet lead-in at the very start
  assertOk("a quiet lead-in at the track start is not a down part", findDownParts(leadIn, { hasVocalMap: true, vocalIntervals: [] }).length === 0);
  assertOk(
    "...but lowering minStartSeconds lets it through (it is the guard, not a bug elsewhere)",
    findDownParts(leadIn, { hasVocalMap: true, vocalIntervals: [], minStartSeconds: 0 }).length === 1
  );
}

// --- Relative, not absolute ----------------------------------------------
{
  // The same shape at 1/50th the level must still yield the same window — a
  // quietly-mastered track still has breakdowns.
  const quietMaster = profile().map((v) => v / 50);
  const parts = findDownParts(quietMaster, { hasVocalMap: true, vocalIntervals: [] });
  assertOk("a quietly-mastered track still yields its breakdown (threshold is relative)", parts.length === 1 && parts[0].start === 20);
}

// --- Multiple windows, in time order -------------------------------------
{
  const rms = new Array(120).fill(1);
  for (let i = 20; i < 30; i++) rms[i] = 0.1;
  for (let i = 80; i < 95; i++) rms[i] = 0.1;
  const parts = findDownParts(rms, { hasVocalMap: true, vocalIntervals: [] });
  assertOk("both breakdowns are found", parts.length === 2);
  assertOk("windows come back in time order", parts[0].start < parts[1].start);
  // A vocal in the FIRST one must not lose the second.
  const withVocal = findDownParts(rms, { hasVocalMap: true, vocalIntervals: [[22, 24]] });
  assertOk("a vocal in one window leaves the other usable", withVocal.length === 1 && withVocal[0].start === 80);
}
{
  // A run that reaches the very end of the array is still emitted (the loop
  // must close an open run when it runs out of seconds).
  const rms = new Array(60).fill(1);
  for (let i = 45; i < 60; i++) rms[i] = 0.1;
  const parts = findDownParts(rms, { hasVocalMap: true, vocalIntervals: [] });
  assertOk("a quiet run reaching the end of the track is still emitted", parts.length === 1 && parts[0].end === 60);
}

// --- pickDownPart --------------------------------------------------------
{
  const parts = findDownParts(profile(), { hasVocalMap: true, vocalIntervals: [] });
  const pick = pickDownPart(parts, { clipSeconds: 2.85 });
  assertOk("a 2.85s clip fits the 10s window", pick !== null && pick.fireAtSeconds === 20);

  assertOk("fromSeconds pushes the fire point later inside the window", pickDownPart(parts, { clipSeconds: 2.85, fromSeconds: 24 }).fireAtSeconds === 24);
  assertOk("a fromSeconds too late in the window disqualifies it", pickDownPart(parts, { clipSeconds: 2.85, fromSeconds: 28 }) === null);
  assertOk("a clip longer than the window is refused, not squeezed in", pickDownPart(parts, { clipSeconds: 30 }) === null);
  assertOk("no windows means no pick (never a fallback placement)", pickDownPart([], { clipSeconds: 2.85 }) === null);
  assertOk("the tail margin is respected", pickDownPart(parts, { clipSeconds: 9.6, tailSeconds: 0.5 }) === null);
}

// --- Brand wall on the generator ----------------------------------------
{
  assertOk('"DJ Supermercado" is refused', violatesBrandWall("¡DJ Supermercado! ¡Dale!"));
  assertOk('"Los Descuentos" is refused', violatesBrandWall("Los Descuentos en la casa"));
  assertOk("the wall is case-insensitive", violatesBrandWall("dj supermercado"));
  assertOk("the wall ignores accents", violatesBrandWall("DJ SUPERMÉRCADO"));
  assertOk('"DJ Cerebro" is his OWN name and is allowed', !violatesBrandWall("¡DJ Cerebro! ¡No pare la fiesta!"));
  assertOk('"El Cerebro" is allowed', !violatesBrandWall("El Cerebro en control"));
  assertOk("ordinary party phrasing is allowed", !violatesBrandWall("¡Manos arriba!"));
  assertOk("empty text is allowed", !violatesBrandWall(""));
  assertOk("null text does not throw", !violatesBrandWall(null));
}

// --- The prompt + manifest actually carry the Phase 5 work ---------------
{
  assertOk(
    "SYSTEM_PROMPT teaches down-part placement for the name-drop",
    SYSTEM_PROMPT.includes("YOUR OWN NAME-DROP") && SYSTEM_PROMPT.includes("nextDownPart")
  );
  assertOk(
    "SYSTEM_PROMPT says WAIT rather than fire approximately when there is no window",
    SYSTEM_PROMPT.includes("the answer is to WAIT, not to fire somewhere approximate")
  );
  assertOk(
    "SYSTEM_PROMPT distinguishes a down part from a mere vocal gap",
    SYSTEM_PROMPT.includes("a gap only means nobody is singing")
  );
  assertOk(
    "SYSTEM_PROMPT restates the brand wall on the name-drop",
    SYSTEM_PROMPT.includes("you never say \"DJ Supermercado\" or \"Los Descuentos\"")
  );
  const entry = VOCAL_MANIFEST.find((e) => e.file === "tag2-nopare.mp3");
  assertOk("the name-drop clip is registered in the vocal manifest", Boolean(entry));
  assertOk("...and is categorized as a tag", entry && entry.category === "tag");
  assertOk(
    "no reserved external DJ brand clip leaked into the manifest",
    VOCAL_MANIFEST.every((e) => !violatesBrandWall(e.file))
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all down-part + brand-wall cases");
