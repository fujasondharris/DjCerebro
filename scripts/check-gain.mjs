#!/usr/bin/env node
// Node-side smoke test for the gain-ownership redesign's pure math
// (src/lib/gain-math.ts) — no AudioContext needed, mirrors
// check-beatclock.mjs/check-command.mjs's plain-assert style. This is the
// "one runnable check" for the review-panel fix: logicalGain/duckFactor
// composition, refcount nesting (no compounding across overlapping duck
// sources), and stale-restore-never (unduck always targets the CURRENT
// logicalGain, never a snapshot from when the duck started).
import {
  duckStateInitial,
  duckStateOnDuck,
  duckStateOnUnduck,
  composeGain,
  dbToFactor,
} from "../src/lib/gain-math.ts";

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

// --- dbToFactor ---
assertOk("dbToFactor: 0dB -> factor 1", dbToFactor(0) === 1);
assertOk("dbToFactor: -20dB -> factor 0.1", approxEqual(dbToFactor(-20), 0.1));
assertOk("dbToFactor: -9.12ish dB (vocal duck) -> ~0.35", approxEqual(dbToFactor(20 * Math.log10(0.35)), 0.35, 1e-6));

// --- composeGain ---
assertOk("composeGain: unducked (factor 1) passes logicalGain through", composeGain(0.8, { count: 0, factor: 1 }) === 0.8);
assertOk("composeGain: ducked multiplies logicalGain by the factor", approxEqual(composeGain(0.8, { count: 1, factor: 0.5 }), 0.4));

// --- initial state ---
{
  const s = duckStateInitial();
  assertOk("initial: count 0", s.count === 0);
  assertOk("initial: factor 1 (unducked)", s.factor === 1);
}

// --- single duck/unduck round trip ---
{
  let s = duckStateInitial();
  s = duckStateOnDuck(s, -12);
  assertOk("single duck: count becomes 1", s.count === 1);
  assertOk("single duck: factor set from the given dB", approxEqual(s.factor, dbToFactor(-12)));
  s = duckStateOnUnduck(s);
  assertOk("single unduck: count back to 0", s.count === 0);
  assertOk("single unduck: factor reset to 1", s.factor === 1);
}

// --- refcount nesting: two overlapping duck sources never compound ---
{
  let s = duckStateInitial();
  s = duckStateOnDuck(s, -12); // e.g. scratch fires first
  const factorAfterFirst = s.factor;
  s = duckStateOnDuck(s, -9.12); // e.g. a vocal clip fires on the SAME deck while still ducked
  assertOk("nesting: count reaches 2 on a second overlapping duck", s.count === 2);
  assertOk(
    "nesting: factor is NOT recomputed/compounded from the second call's dB — stays the first duck's factor",
    s.factor === factorAfterFirst
  );

  s = duckStateOnUnduck(s); // the second (vocal) source lets go first
  assertOk("nesting: count drops to 1 but deck STAYS ducked (scratch source still holding)", s.count === 1);
  assertOk("nesting: factor unchanged while any duck source still holds", s.factor === factorAfterFirst);

  s = duckStateOnUnduck(s); // the first (scratch) source lets go
  assertOk("nesting: count reaches 0 only once EVERY duck source has released", s.count === 0);
  assertOk("nesting: factor resets to 1 (fully unducked) only at count 0", s.factor === 1);
}

// --- guard against negative counts ---
{
  let s = duckStateInitial();
  s = duckStateOnUnduck(s); // unbalanced unduck with nothing ducking
  assertOk("guard: unduck() with count already 0 is a no-op, not negative", s.count === 0);
  assertOk("guard: factor stays 1", s.factor === 1);
}

// --- stale-restore-never: unduck must compose against the CURRENT
// logicalGain at the moment it fires, not a value captured when the duck
// started (Deck.unduck() achieves this by calling composeGain(this.gainValue,
// ...) fresh each time — this checks the pure math contract that makes that
// possible: composeGain takes logicalGain as a live parameter, not baked
// into the DuckState). ---
{
  let s = duckStateInitial();
  s = duckStateOnDuck(s, -12);
  const duckedGainEarly = composeGain(1.0, s); // e.g. crossfader was at full when the duck started
  const duckedGainAfterCrossfaderMove = composeGain(0.3, s); // crossfader moved WHILE still ducked
  assertOk(
    "stale-restore-never: composing against a later logicalGain reflects the crossfader move, not the old value",
    !approxEqual(duckedGainEarly, duckedGainAfterCrossfaderMove) && approxEqual(duckedGainAfterCrossfaderMove, 0.3 * s.factor)
  );
  s = duckStateOnUnduck(s);
  const restored = composeGain(0.3, s); // unduck restores to whatever logicalGain IS now (0.3), not the 1.0 it started at
  assertOk("stale-restore-never: unduck restores to the CURRENT logicalGain, not the value captured at duck-start", restored === 0.3);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all gain-ownership pure-math cases");
