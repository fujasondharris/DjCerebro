#!/usr/bin/env node
// Node-side check for M7 Phase 3's contract work in src/lib/brain.ts: the new
// action:"loop" command schema, the stinger-vs-performance cadence split, and
// the SYSTEM_PROMPT rules that make both usable. Plain asserts, no framework.
//
// The point of the cadence assertions: before this split, page.tsx enforced
// ONE 120s autopilot cooldown across every fx, so a beat roll cost the same
// budget as an airhorn. That is why El Cerebro never performed and the DJ
// ended up pressing the pads manually — the fix is only real if rolls, the
// hold and EQ are genuinely in a different class from the stingers.
import {
  CommandSchema,
  SYSTEM_PROMPT,
  isPerformanceMove,
  isStinger,
  STINGER_FX,
  PERFORMANCE_FX,
} from "../src/lib/brain.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

const parse = (obj) => CommandSchema.safeParse(obj);

// --- The loop command exists and validates ------------------------------
{
  assertOk("a bare loop command is valid (every field optional)", parse({ action: "loop" }).success);
  assertOk(
    "a fully-specified loop command is valid",
    parse({ action: "loop", captureBars: 8, isolation: "melody", holdSeconds: 16, halvings: 3, say: "holding the hook" }).success
  );
  assertOk("followUpSeconds is accepted like every other command", parse({ action: "loop", followUpSeconds: 20 }).success);
}

// --- ...and rejects nonsense --------------------------------------------
{
  assertOk("captureBars must be 2, 4 or 8 — not 3", !parse({ action: "loop", captureBars: 3 }).success);
  assertOk("captureBars 16 is rejected", !parse({ action: "loop", captureBars: 16 }).success);
  assertOk("an unknown isolation mode is rejected", !parse({ action: "loop", isolation: "vocal" }).success);
  assertOk("a 3-second hold is rejected (below the floor)", !parse({ action: "loop", holdSeconds: 3 }).success);
  assertOk("a 5-minute hold is rejected (above the ceiling)", !parse({ action: "loop", holdSeconds: 300 }).success);
  assertOk("negative halvings are rejected", !parse({ action: "loop", halvings: -1 }).success);
  assertOk("more than 4 halvings are rejected", !parse({ action: "loop", halvings: 9 }).success);
  assertOk("fractional halvings are rejected", !parse({ action: "loop", halvings: 1.5 }).success);
}

// --- The discriminated union still routes every other action ------------
{
  for (const action of ["fx", "eq", "none", "tempo_nudge"]) {
    const sample =
      action === "fx"
        ? { action: "fx", fx: "airhorn" }
        : action === "eq"
          ? { action: "eq", deck: "live", low: -40 }
          : action === "tempo_nudge"
            ? { action: "tempo_nudge", deck: "live", tempoDelta: 0.02 }
            : { action: "none" };
    assertOk(`adding "loop" didn't break the "${action}" branch`, parse(sample).success);
  }
  assertOk("an unknown action is still rejected", !parse({ action: "teleport" }).success);
}

// --- Cadence classes ----------------------------------------------------
{
  for (const fx of STINGER_FX) {
    assertOk(`"${fx}" is a stinger (keeps the rare cap)`, isStinger(fx) && !isPerformanceMove(fx));
  }
  for (const fx of PERFORMANCE_FX) {
    assertOk(`"${fx}" is a performance move (loose budget)`, isPerformanceMove(fx) && !isStinger(fx));
  }
  assertOk('action "loop" is a performance move', isPerformanceMove("loop"));
  assertOk('action "eq" is a performance move', isPerformanceMove("eq"));
  assertOk("the two classes are disjoint", STINGER_FX.every((f) => !PERFORMANCE_FX.includes(f)));
  assertOk("all three roll subdivisions are performance moves", ["roll_eighth", "roll_quarter", "roll_half"].every(isPerformanceMove));
  assertOk("airhorn is NOT reclassified as performance (the rare cap survives)", !isPerformanceMove("airhorn"));
}
{
  // Vocal clips belong to NEITHER class — they are El Cerebro talking, with
  // their own placement rules, and must not silently inherit either budget.
  for (const vocal of ["tag", "drop", "adlib", "crowd", "cue_warm", "cue_hype"]) {
    assertOk(`vocal clip "${vocal}" is in neither cadence class`, !isStinger(vocal) && !isPerformanceMove(vocal));
  }
  assertOk("scratches are in neither class either", !isStinger("scratch_baby") && !isPerformanceMove("scratch_baby"));
  assertOk("an unknown name is in neither class", !isStinger("nonsense") && !isPerformanceMove("nonsense"));
}

// --- SYSTEM_PROMPT actually teaches all of it ---------------------------
{
  assertOk('SYSTEM_PROMPT documents action "loop"', SYSTEM_PROMPT.includes('action "loop"') && SYSTEM_PROMPT.includes("BAND-ISOLATED HELD LOOP"));
  assertOk("SYSTEM_PROMPT explains both isolation modes", SYSTEM_PROMPT.includes('"beat" = kill mid+high') && SYSTEM_PROMPT.includes('"melody" = DUCK the low band'));
  // Owner, 2026-08-16, on a 30s beat-only hold: "took all the song out and half-muted
  // it with the EQ." A bare loop is EXPOSED for its whole length; ~15-20s is the lean.
  assertOk("a 30s bare hold is REJECTED (owner: 'you can\'t do just bass for very long')", !parse({ action: "loop", holdSeconds: 30 }).success);
  assertOk("a 16s hold is accepted", parse({ action: "loop", holdSeconds: 16 }).success);
  assertOk("SYSTEM_PROMPT no longer calls ~30s the house length", !SYSTEM_PROMPT.includes("~30 is the house length"));
  assertOk("SYSTEM_PROMPT documents the cadence-class split", SYSTEM_PROMPT.includes("CADENCE CLASSES") && SYSTEM_PROMPT.includes("PERFORMANCE MOVES"));
  assertOk(
    "SYSTEM_PROMPT states that a stinger does not silence the performance moves",
    SYSTEM_PROMPT.includes("does NOT spend any stinger budget")
  );
  assertOk("SYSTEM_PROMPT keeps the rare stinger cap explicit", SYSTEM_PROMPT.includes("one per 10 minutes"));
  assertOk(
    "SYSTEM_PROMPT suppresses partner-dance loops by default but honors an explicit owner request",
    SYSTEM_PROMPT.includes("Without an explicit owner performance request, salsa/bachata still suppresses") &&
      SYSTEM_PROMPT.includes("In salsa/bachata, require an explicit owner request for loops or stems.")
  );
  assertOk(
    "SYSTEM_PROMPT tells the brain the return consult is booked FOR it (sequence chaining)",
    SYSTEM_PROMPT.includes("books your return consult automatically")
  );
  assertOk(
    "SYSTEM_PROMPT sources placement from the owner's own presses, not invention",
    SYSTEM_PROMPT.includes("PLACEMENT COMES FROM THE OWNER'S OWN PRESSES") && SYSTEM_PROMPT.includes("fxDemonstrations")
  );
  assertOk("SYSTEM_PROMPT keeps the grid-truth refusal honest", SYSTEM_PROMPT.includes("Requires a real BeatGrid"));
}

// --- Loop-covered tempo sweep (M7 Phase 4) ---------------------------
{
  assertOk("sweepToBpm is accepted", parse({ action: "loop", sweepToBpm: 128 }).success);
  assertOk("an absurdly low sweepToBpm is rejected", !parse({ action: "loop", sweepToBpm: 10 }).success);
  assertOk("an absurdly high sweepToBpm is rejected", !parse({ action: "loop", sweepToBpm: 400 }).success);
  assertOk(
    "SYSTEM_PROMPT teaches the sweep as the alternative to accepting a cut",
    SYSTEM_PROMPT.includes("LOOP-COVERED TEMPO SWEEP") && SYSTEM_PROMPT.includes("sweepToBpm") && SYSTEM_PROMPT.includes("enters at its OWN tempo with nothing clamped")
  );
}
if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all loop-action contract cases");
