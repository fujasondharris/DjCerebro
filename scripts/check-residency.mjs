#!/usr/bin/env node
// Node-side check for the M7 residency blocker fix (src/lib/residency.ts):
// parsing an explicit owner residency instruction out of a vibe note, the
// "silence is not a cancellation" rule, and the consult-lead timing math.
// The two headline cases are verbatim owner ledger notes. Plain
// asserts, no test framework.
import {
  parseResidencyRequest,
  applyResidencyParse,
  residencyConsultAtSeconds,
  isResidencyConsultDue,
  MIN_RESIDENCY_REQUEST_SECONDS,
  MAX_RESIDENCY_REQUEST_SECONDS,
  DEFAULT_RESIDENCY_CONSULT_LEAD_SECONDS,
} from "../src/lib/residency.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

const seconds = (text) => {
  const parsed = parseResidencyRequest(text);
  return parsed && "seconds" in parsed ? parsed.seconds : null;
};

// --- The owner's real notes (verbatim from the 2026-07-29 lesson ledger) ---
{
  const a = "30 seconds of a song then mix in teh next one and do that 10 times so I can evaluate";
  assertOk('owner note A ("30 seconds of a song then mix in...") parses as 30s', seconds(a) === 30);

  const b = "you are going way longer than 30 seconds";
  assertOk('owner note B ("you are going way longer than 30 seconds") parses as 30s', seconds(b) === 30);
}

// --- Other phrasings the same instruction plausibly arrives in ---
{
  assertOk('"45 seconds per track"', seconds("45 seconds per track") === 45);
  assertOk('"play each song for 60 seconds"', seconds("play each song for 60 seconds") === 60);
  assertOk('"每 each track 90 secs" (leading noise ignored)', seconds("each track 90 secs") === 90);
  assertOk('"give each one 40 seconds"', seconds("give each one 40 seconds") === 40);
  assertOk('"2 minutes each" converts to 120s', seconds("2 minutes each") === 120);
  assertOk('"a minute per song" converts the word number', seconds("a minute per song") === 60);
  assertOk('"two minutes of a track"', seconds("two minutes of a track") === 120);
  assertOk('"30 secs then switch"', seconds("30 secs then switch") === 30);
  assertOk('"ride it for 75 seconds"', seconds("ride it for 75 seconds") === 75);
  assertOk("case is ignored", seconds("30 SECONDS OF A SONG") === 30);
  assertOk("extra whitespace/newlines are normalized", seconds("30\n  seconds   of a song") === 30);
}

// --- FALSE POSITIVES: a number and a time unit are NOT an instruction ------
{
  const notInstructions = [
    "the first 30 seconds are boring",
    "that intro is like 40 seconds of nothing",
    "the drop hits around 90 seconds",
    "play more salsa",
    "less fx please",
    "that transition was rough",
    "airhorn in 30 seconds", // a one-off timed fx request, NOT a residency rule
    "played 30 seconds ago",
    // These four were found by adversarially probing the parser — every one
    // of them parsed as a residency instruction before the negative-context
    // guard existed. The last is the worst: it is a MIX-IN instruction, so
    // obeying it as residency would do nearly the opposite of what was asked.
    "the first 30 seconds of a song are usually the intro",
    "the last 20 seconds of a track always fade",
    "I like the 30 seconds of a song where the hook is",
    "skip the first 45 seconds of each track",
    "give me a break for 30 seconds",
  ];
  for (const text of notInstructions) {
    assertOk(`not a residency instruction: "${text}"`, parseResidencyRequest(text) === null);
  }
  // ...but the guard must not swallow real instructions that share a verb.
  assertOk('"cut each track at 30 seconds" IS still an instruction', seconds("cut each track at 30 seconds") === 30);
  assertOk('"keep it under 30 seconds" IS still an instruction', seconds("keep it under 30 seconds") === 30);
}

// --- Empty / missing input ---
{
  assertOk("null text parses to null", parseResidencyRequest(null) === null);
  assertOk("undefined text parses to null", parseResidencyRequest(undefined) === null);
  assertOk("empty string parses to null", parseResidencyRequest("") === null);
  assertOk("whitespace-only parses to null", parseResidencyRequest("   \n ") === null);
}

// --- Clamping is visible, never silent ---
{
  const tooShort = parseResidencyRequest("5 seconds per song");
  assertOk("an impossibly short request clamps up to the floor", tooShort.seconds === MIN_RESIDENCY_REQUEST_SECONDS);
  assertOk("a clamped request is FLAGGED as clamped, not silently substituted", tooShort.clamped === true);

  const tooLong = parseResidencyRequest("30 minutes per track");
  assertOk("an over-long request clamps down to the ceiling", tooLong.seconds === MAX_RESIDENCY_REQUEST_SECONDS);
  assertOk("the over-long request is flagged clamped too", tooLong.clamped === true);

  const inRange = parseResidencyRequest("30 seconds of a song");
  assertOk("an in-range request is not flagged clamped", inRange.clamped === false);
}

// --- Clearing: only an explicit cancellation clears a standing request ----
{
  const standing = { seconds: 30, clamped: false };

  assertOk("silence leaves a standing request alone", applyResidencyParse(standing, parseResidencyRequest("more salsa")) === standing);
  assertOk("a new number replaces the standing request", applyResidencyParse(standing, parseResidencyRequest("60 seconds per track")).seconds === 60);

  const clears = ["back to normal", "play the whole song now", "normal length songs", "regular residency please"];
  for (const text of clears) {
    const parsed = parseResidencyRequest(text);
    assertOk(`"${text}" clears the standing request`, parsed !== null && "clear" in parsed && applyResidencyParse(standing, parsed) === null);
  }

  assertOk("applying null to no standing request stays null", applyResidencyParse(null, null) === null);
  assertOk("a first request with nothing standing is adopted", applyResidencyParse(null, parseResidencyRequest("30 seconds of a song")).seconds === 30);
}

// --- Consult timing: consult BEFORE the target, or it always overshoots ---
{
  assertOk(
    "a 60s residency consults one lead-time early (45s in)",
    residencyConsultAtSeconds(60) === 60 - DEFAULT_RESIDENCY_CONSULT_LEAD_SECONDS
  );
  assertOk("the consult point is always before the target itself", residencyConsultAtSeconds(60) < 60);
  assertOk(
    "a short 30s residency still consults early (15s in), not at 30s",
    residencyConsultAtSeconds(30) === 15
  );
  assertOk(
    "a residency shorter than the lead time floors at 8s rather than going negative or zero",
    residencyConsultAtSeconds(MIN_RESIDENCY_REQUEST_SECONDS) === 8
  );
  assertOk("a custom lead time is honored", residencyConsultAtSeconds(120, 30) === 90);
  assertOk("a non-positive target never comes due", residencyConsultAtSeconds(0) === Number.POSITIVE_INFINITY);
}
{
  assertOk("not due early in the track", isResidencyConsultDue(5, 60) === false);
  assertOk("due once past the consult point", isResidencyConsultDue(46, 60) === true);
  assertOk("due exactly ON the consult point", isResidencyConsultDue(45, 60) === true);
  assertOk("no target means never due (normal residency rules apply)", isResidencyConsultDue(500, null) === false);
  assertOk("a non-finite playedSeconds is never due", isResidencyConsultDue(NaN, 60) === false);
  assertOk(
    "the 30s case now fires at 15s, well before the overshoot",
    isResidencyConsultDue(15, 30) === true && isResidencyConsultDue(14, 30) === false
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all residency cases");
