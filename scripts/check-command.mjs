#!/usr/bin/env node
// Node-side smoke test for the brain's command contract: imports the exact
// same src/lib/brain.ts used by the API route and asserts CommandSchema
// against good + bad sample commands (bad action, out-of-range durationBars,
// wrong types). Plain asserts, no test framework, mirrors check-beatclock.mjs.
import {
  CommandSchema,
  BrainResponseSchema,
  parseCommandText,
  parseBrainResponseText,
  NO_OP_COMMAND,
  noOpWithReason,
  isHumanInitiated,
  resolveCooldownReason,
  isPerformanceMove,
} from "../src/lib/brain.ts";
import { isDeepStrictEqual } from "node:util";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

// --- good commands ---

assertOk(
  "queue: minimal valid",
  CommandSchema.safeParse({ action: "queue", trackId: "abc123" }).success
);

{
  const result = CommandSchema.safeParse({ action: "queue", trackId: "abc123" });
  assertOk("queue: defaults transition to beatmatch_crossfade", result.success && result.data.transition === "beatmatch_crossfade");
  assertOk("queue: defaults durationBars to 16", result.success && result.data.durationBars === 16);
}

assertOk(
  "queue: full valid with cut",
  CommandSchema.safeParse({
    action: "queue",
    trackId: "xyz",
    transition: "cut",
    durationBars: 32,
    say: "vibe reset",
  }).success
);

assertOk(
  "tempo_nudge: valid",
  CommandSchema.safeParse({ action: "tempo_nudge", tempoDelta: 0.02 }).success
);

assertOk("tempo_nudge: negative delta valid", CommandSchema.safeParse({ action: "tempo_nudge", tempoDelta: -0.05 }).success);

assertOk("tempo_nudge: boundary +0.08 valid", CommandSchema.safeParse({ action: "tempo_nudge", tempoDelta: 0.08 }).success);
assertOk("tempo_nudge: boundary -0.08 valid", CommandSchema.safeParse({ action: "tempo_nudge", tempoDelta: -0.08 }).success);

assertOk("none: valid with say", CommandSchema.safeParse({ action: "none", say: "nothing to do" }).success);
assertOk("none: valid with no other fields", CommandSchema.safeParse({ action: "none" }).success);

assertOk(
  "routine: sample_mix complete recipe valid",
  CommandSchema.safeParse({
    action: "routine",
    routine: "sample_mix",
    sample: { captureBars: 4, isolation: "beat", holdSeconds: 16, halvings: 3, sweepToBpm: 124 },
    queue: { trackId: "a", transition: "bass_swap", durationBars: 4, startAt: "auto" },
  }).success
);

assertOk(
  "routine: sample_mix full sampler/queue valid",
  CommandSchema.safeParse({
    action: "routine",
    routine: "sample_mix",
    sample: { captureBars: 4, isolation: "melody", holdSeconds: 16, halvings: 3, sweepToBpm: 128 },
    queue: { trackId: "42", transition: "bass_swap", durationBars: 4, maskFx: "space_sweep", startAt: "auto" },
    say: "sampling the groove and bringing the next one in",
  }).success
);

assertOk(
  "durationBars: boundary 4 valid",
  CommandSchema.safeParse({ action: "queue", trackId: "a", durationBars: 4 }).success
);
assertOk(
  "durationBars: boundary 64 valid",
  CommandSchema.safeParse({ action: "queue", trackId: "a", durationBars: 64 }).success
);

// --- bad commands ---

assertOk(
  "bad action: rejected",
  !CommandSchema.safeParse({ action: "eject_dj", trackId: "abc" }).success
);

assertOk(
  "durationBars: 3 (below min) rejected",
  !CommandSchema.safeParse({ action: "queue", trackId: "a", durationBars: 3 }).success
);

assertOk(
  "durationBars: 65 (above max) rejected",
  !CommandSchema.safeParse({ action: "queue", trackId: "a", durationBars: 65 }).success
);

assertOk(
  "durationBars: non-integer rejected",
  !CommandSchema.safeParse({ action: "queue", trackId: "a", durationBars: 16.5 }).success
);

assertOk(
  "tempoDelta: out of range (0.5) rejected",
  !CommandSchema.safeParse({ action: "tempo_nudge", tempoDelta: 0.5 }).success
);

assertOk(
  "tempoDelta: out of range (-0.5) rejected",
  !CommandSchema.safeParse({ action: "tempo_nudge", tempoDelta: -0.5 }).success
);

assertOk(
  "wrong type: trackId as number rejected",
  !CommandSchema.safeParse({ action: "queue", trackId: 123 }).success
);

assertOk(
  "wrong type: durationBars as string rejected",
  !CommandSchema.safeParse({ action: "queue", trackId: "a", durationBars: "16" }).success
);

assertOk(
  "missing action rejected",
  !CommandSchema.safeParse({ trackId: "abc" }).success
);

assertOk(
  "routine: missing queue rejected",
  !CommandSchema.safeParse({ action: "routine", routine: "sample_mix" }).success
);

assertOk(
  "routine: wrong routine name rejected",
  !CommandSchema.safeParse({
    action: "routine",
    routine: "loop_then_queue",
    sample: { captureBars: 4, isolation: "beat", holdSeconds: 16, halvings: 3, sweepToBpm: 124 },
    queue: { trackId: "a", transition: "bass_swap", durationBars: 4, startAt: "auto" },
  }).success
);

assertOk(
  "routine: sample captureBars only allows 2/4/8",
  !CommandSchema.safeParse({
    action: "routine",
    routine: "sample_mix",
    sample: { captureBars: 3, isolation: "beat", holdSeconds: 16, halvings: 3, sweepToBpm: 124 },
    queue: { trackId: "a", transition: "bass_swap", durationBars: 4, startAt: "auto" },
  }).success
);

assertOk(
  "routine: queue maskFx rejects vocal category",
  !CommandSchema.safeParse({
    action: "routine",
    routine: "sample_mix",
    sample: { captureBars: 4, isolation: "beat", holdSeconds: 16, halvings: 3, sweepToBpm: 124 },
    queue: { trackId: "a", transition: "bass_swap", durationBars: 4, maskFx: "tag", startAt: "auto" },
  }).success
);

assertOk(
  "routine: queue transition is fixed to bass_swap",
  !CommandSchema.safeParse({
    action: "routine",
    routine: "sample_mix",
    sample: { captureBars: 4, isolation: "beat", holdSeconds: 16, halvings: 3, sweepToBpm: 124 },
    queue: { trackId: "a", transition: "gap", durationBars: 4, startAt: "auto" },
  }).success
);

assertOk(
  "routine: queue durationBars is fixed to 4",
  !CommandSchema.safeParse({
    action: "routine",
    routine: "sample_mix",
    sample: { captureBars: 4, isolation: "beat", holdSeconds: 16, halvings: 3, sweepToBpm: 124 },
    queue: { trackId: "a", transition: "bass_swap", durationBars: 8, startAt: "auto" },
  }).success
);

// --- discriminated-union enforcement: the field each action actually needs
// must be REQUIRED for that action, not merely present-if-given (this was
// the bug: an all-optional schema let {"action":"queue"} with no trackId
// validate, and the engine had nothing to load). ---

assertOk(
  "queue: missing trackId rejected",
  !CommandSchema.safeParse({ action: "queue" }).success
);

assertOk(
  "queue: empty-string trackId rejected",
  !CommandSchema.safeParse({ action: "queue", trackId: "" }).success
);

assertOk(
  "tempo_nudge: missing tempoDelta rejected",
  !CommandSchema.safeParse({ action: "tempo_nudge" }).success
);

assertOk(
  "queue: valid with trackId accepted",
  CommandSchema.safeParse({ action: "queue", trackId: "t1" }).success
);

assertOk(
  "none: never requires trackId or tempoDelta",
  CommandSchema.safeParse({ action: "none" }).success
);

assertOk("transition: bad enum value rejected", !CommandSchema.safeParse({ action: "queue", trackId: "a", transition: "wipe" }).success);

assertOk("not an object rejected", !CommandSchema.safeParse("action: queue").success);

// --- owner soundcheck fix: maskFx on the queue command (seam masking) ---

assertOk("queue: maskFx omitted is valid (optional)", CommandSchema.safeParse({ action: "queue", trackId: "a" }).success);
for (const fx of ["airhorn", "siren", "laser", "brake", "rewind", "cheer", "subdrop", "crash", "timbale", "downlifter"]) {
  assertOk(`queue: maskFx valid stinger "${fx}"`, CommandSchema.safeParse({ action: "queue", trackId: "a", maskFx: fx }).success);
}
assertOk(
  "queue: maskFx rejects a vocal category (tag) — stingers only, not vocal categories",
  !CommandSchema.safeParse({ action: "queue", trackId: "a", maskFx: "tag" }).success
);
assertOk(
  "queue: maskFx rejects another vocal category (cue_hype)",
  !CommandSchema.safeParse({ action: "queue", trackId: "a", maskFx: "cue_hype" }).success
);
assertOk(
  "queue: maskFx rejects riser (pre-transition tool, not a masking stinger)",
  !CommandSchema.safeParse({ action: "queue", trackId: "a", maskFx: "riser" }).success
);
assertOk(
  "queue: maskFx rejects a scratch pattern",
  !CommandSchema.safeParse({ action: "queue", trackId: "a", maskFx: "scratch_baby" }).success
);
assertOk(
  "queue: maskFx rejects a roll (rolls are an fx command, not a queue-transition seam mask)",
  !CommandSchema.safeParse({ action: "queue", trackId: "a", maskFx: "roll_eighth" }).success
);
assertOk(
  "queue: maskFx rejects an invalid string",
  !CommandSchema.safeParse({ action: "queue", trackId: "a", maskFx: "klaxon" }).success
);
assertOk(
  "queue: maskFx works alongside other queue fields",
  CommandSchema.safeParse({ action: "queue", trackId: "a", transition: "cut", durationBars: 8, maskFx: "airhorn", say: "hit it" }).success
);

// --- audio engine v2, Part 1: maskFx "space_sweep" (HPF sweep + echo + reverb, not a one-shot sample) ---
assertOk(
  'queue: maskFx valid "space_sweep" (audio engine v2, filter-sweep seam masking)',
  CommandSchema.safeParse({ action: "queue", trackId: "a", maskFx: "space_sweep" }).success
);

// --- parseCommandText (JSON.parse + schema) ---

{
  const good = parseCommandText(JSON.stringify({ action: "queue", trackId: "t1" }));
  assertOk("parseCommandText: valid JSON + schema", good.ok === true && good.command.trackId === "t1");
}

{
  const badJson = parseCommandText("{not json");
  assertOk("parseCommandText: invalid JSON reports error", badJson.ok === false && typeof badJson.error === "string");
}

{
  const badSchema = parseCommandText(JSON.stringify({ action: "nonsense" }));
  assertOk("parseCommandText: invalid schema reports error", badSchema.ok === false && typeof badSchema.error === "string");
}

// --- no-op helpers ---

assertOk("NO_OP_COMMAND: action none", NO_OP_COMMAND.action === "none");
assertOk("NO_OP_COMMAND: itself passes the schema", CommandSchema.safeParse(NO_OP_COMMAND).success);
assertOk("noOpWithReason: carries custom say", noOpWithReason("custom reason").say === "custom reason");
assertOk("noOpWithReason: action none", noOpWithReason("x").action === "none");

// --- M4 Part D: extended transition enum (queue) ---

assertOk(
  "queue: transition bass_swap accepted",
  CommandSchema.safeParse({ action: "queue", trackId: "a", transition: "bass_swap" }).success
);
assertOk(
  "queue: transition echo_out accepted",
  CommandSchema.safeParse({ action: "queue", trackId: "a", transition: "echo_out" }).success
);
assertOk(
  "queue: transition gap accepted (review-panel fix — salsa/bachata clean-ending mechanism)",
  CommandSchema.safeParse({ action: "queue", trackId: "a", transition: "gap" }).success
);
assertOk(
  "queue: transition loop_blend accepted (audio engine v2, Part 3 — loop-tension suspension tool)",
  CommandSchema.safeParse({ action: "queue", trackId: "a", transition: "loop_blend" }).success
);

// --- M4 Part D: fx command ---

assertOk("fx: valid airhorn", CommandSchema.safeParse({ action: "fx", fx: "airhorn" }).success);
assertOk("fx: valid siren", CommandSchema.safeParse({ action: "fx", fx: "siren" }).success);
assertOk("fx: valid riser", CommandSchema.safeParse({ action: "fx", fx: "riser" }).success);
assertOk("fx: valid rewind", CommandSchema.safeParse({ action: "fx", fx: "rewind" }).success);
assertOk("fx: valid laser (FX upgrade)", CommandSchema.safeParse({ action: "fx", fx: "laser" }).success);
assertOk("fx: valid brake (FX upgrade)", CommandSchema.safeParse({ action: "fx", fx: "brake" }).success);
assertOk("fx: valid cheer (vocal-library upgrade, real crowd-cheer stinger)", CommandSchema.safeParse({ action: "fx", fx: "cheer" }).success);
assertOk("fx: valid subdrop (808 sub-bass impact drop)", CommandSchema.safeParse({ action: "fx", fx: "subdrop" }).success);
assertOk("fx: valid crash (reverse cymbal swell + impact crash)", CommandSchema.safeParse({ action: "fx", fx: "crash" }).success);
assertOk("fx: valid timbale (Latin timbale + dembow snare fill)", CommandSchema.safeParse({ action: "fx", fx: "timbale" }).success);
assertOk("fx: valid downlifter (club jet exhaust sweep)", CommandSchema.safeParse({ action: "fx", fx: "downlifter" }).success);
assertOk("fx: valid tag (vocal-library upgrade, now a vocal category)", CommandSchema.safeParse({ action: "fx", fx: "tag" }).success);
assertOk(
  "fx: valid drop (review-panel fix — was a real vocal category never added to this enum)",
  CommandSchema.safeParse({ action: "fx", fx: "drop" }).success
);
assertOk("fx: valid adlib (vocal-library upgrade)", CommandSchema.safeParse({ action: "fx", fx: "adlib" }).success);
assertOk("fx: valid crowd (vocal-library upgrade)", CommandSchema.safeParse({ action: "fx", fx: "crowd" }).success);
assertOk("fx: valid cue_warm (vocal-library upgrade)", CommandSchema.safeParse({ action: "fx", fx: "cue_warm" }).success);
assertOk("fx: valid cue_hype (vocal-library upgrade)", CommandSchema.safeParse({ action: "fx", fx: "cue_hype" }).success);
assertOk("fx: valid scratch_baby", CommandSchema.safeParse({ action: "fx", fx: "scratch_baby" }).success);
assertOk("fx: valid scratch_chirp", CommandSchema.safeParse({ action: "fx", fx: "scratch_chirp" }).success);
assertOk("fx: valid scratch_spinback", CommandSchema.safeParse({ action: "fx", fx: "scratch_spinback" }).success);
assertOk("fx: valid roll_eighth (audio engine v2, Part 2 — beat rolls)", CommandSchema.safeParse({ action: "fx", fx: "roll_eighth" }).success);
assertOk("fx: valid roll_quarter", CommandSchema.safeParse({ action: "fx", fx: "roll_quarter" }).success);
assertOk("fx: valid roll_half", CommandSchema.safeParse({ action: "fx", fx: "roll_half" }).success);
assertOk(
  "fx: 'roll_full'/'roll_whole' rejected — the manual pad and this enum both stop at eighth/quarter/half, per the dispatch",
  !CommandSchema.safeParse({ action: "fx", fx: "roll_full" }).success && !CommandSchema.safeParse({ action: "fx", fx: "roll_whole" }).success
);
assertOk("fx: valid with say", CommandSchema.safeParse({ action: "fx", fx: "airhorn", say: "hyping the drop" }).success);
assertOk("fx: invalid enum value rejected", !CommandSchema.safeParse({ action: "fx", fx: "klaxon" }).success);
assertOk(
  "fx: 'shoutout' rejected — host-only occasion callouts are never brain-triggerable, deliberately absent from this enum",
  !CommandSchema.safeParse({ action: "fx", fx: "shoutout" }).success
);
assertOk("fx: missing fx rejected", !CommandSchema.safeParse({ action: "fx" }).success);

// --- M4 Part D: eq command ---

assertOk(
  "eq: all fields valid",
  CommandSchema.safeParse({ action: "eq", deck: "live", low: -6, mid: 2, high: 3 }).success
);
assertOk(
  "eq: no band fields still valid (all optional per action, deck required)",
  CommandSchema.safeParse({ action: "eq", deck: "live" }).success
);
assertOk(
  "eq: boundary values -40/+6 valid",
  CommandSchema.safeParse({ action: "eq", deck: "live", low: -40, mid: 0, high: 6 }).success
);
assertOk(
  "eq: low out of range (below -40) rejected",
  !CommandSchema.safeParse({ action: "eq", deck: "live", low: -41 }).success
);
assertOk(
  "eq: mid out of range (above +6) rejected",
  !CommandSchema.safeParse({ action: "eq", deck: "live", mid: 6.1 }).success
);
assertOk(
  "eq: high out of range rejected",
  !CommandSchema.safeParse({ action: "eq", deck: "live", high: 100 }).success
);
assertOk("eq: missing deck rejected", !CommandSchema.safeParse({ action: "eq", low: 1 }).success);
assertOk("eq: wrong deck value rejected", !CommandSchema.safeParse({ action: "eq", deck: "A", low: 1 }).success);

// --- In-and-out mixing (2026-07-28): startAt on the queue command. ---

assertOk(
  "queue: startAt omitted defaults to 'auto'",
  CommandSchema.safeParse({ action: "queue", trackId: "a" }).data?.startAt === "auto"
);
assertOk(
  "queue: startAt 'auto' explicit valid",
  CommandSchema.safeParse({ action: "queue", trackId: "a", startAt: "auto" }).success
);
assertOk(
  "queue: startAt 'beginning' valid",
  CommandSchema.safeParse({ action: "queue", trackId: "a", startAt: "beginning" }).success
);
assertOk(
  "queue: startAt rejects an invalid value",
  !CommandSchema.safeParse({ action: "queue", trackId: "a", startAt: "middle" }).success
);
assertOk(
  "queue: startAt works alongside other queue fields",
  CommandSchema.safeParse({ action: "queue", trackId: "a", transition: "gap", startAt: "beginning", say: "salsa, full length" })
    .success
);

// --- Deferred re-consult: followUpSeconds on every command variant (owner
// soundcheck fix) — optional, bounded [5, 600], rejects below/above bounds
// on all five discriminated-union branches. ---

const FOLLOW_UP_CASES = [
  { name: "queue", base: { action: "queue", trackId: "a" } },
  { name: "tempo_nudge", base: { action: "tempo_nudge", tempoDelta: 0.02 } },
  { name: "fx", base: { action: "fx", fx: "airhorn" } },
  { name: "eq", base: { action: "eq", deck: "live" } },
  {
    name: "routine",
    base: {
      action: "routine",
      routine: "sample_mix",
      sample: { captureBars: 4, isolation: "beat", holdSeconds: 16, halvings: 3, sweepToBpm: 124 },
      queue: { trackId: "a", transition: "bass_swap", durationBars: 4, startAt: "auto" },
    },
  },
  { name: "none", base: { action: "none" } },
];

for (const { name, base } of FOLLOW_UP_CASES) {
  assertOk(`${name}: followUpSeconds omitted is valid (optional)`, CommandSchema.safeParse(base).success);
  assertOk(`${name}: followUpSeconds valid at 30`, CommandSchema.safeParse({ ...base, followUpSeconds: 30 }).success);
  assertOk(`${name}: followUpSeconds boundary 5 valid`, CommandSchema.safeParse({ ...base, followUpSeconds: 5 }).success);
  assertOk(`${name}: followUpSeconds boundary 600 valid`, CommandSchema.safeParse({ ...base, followUpSeconds: 600 }).success);
  assertOk(`${name}: followUpSeconds rejects below min (2)`, !CommandSchema.safeParse({ ...base, followUpSeconds: 2 }).success);
  assertOk(`${name}: followUpSeconds rejects 4 (just under min)`, !CommandSchema.safeParse({ ...base, followUpSeconds: 4 }).success);
  assertOk(`${name}: followUpSeconds rejects above max (601)`, !CommandSchema.safeParse({ ...base, followUpSeconds: 601 }).success);
  assertOk(`${name}: followUpSeconds rejects wrong type (string)`, !CommandSchema.safeParse({ ...base, followUpSeconds: "30" }).success);
}

// --- isHumanInitiated (adversarial-review fix): the fx cooldown floor's
// classification — "user_chat"/"follow_up" are human-initiated (exempt),
// "autopilot_poll"/"opener" are app-cadence (floored). All 4 cases pinned. ---

assertOk("isHumanInitiated: user_chat is human-initiated", isHumanInitiated("user_chat") === true);
assertOk("isHumanInitiated: follow_up is human-initiated (deferred instruction execution)", isHumanInitiated("follow_up") === true);
assertOk("isHumanInitiated: autopilot_poll is NOT human-initiated", isHumanInitiated("autopilot_poll") === false);
assertOk("isHumanInitiated: opener is NOT human-initiated", isHumanInitiated("opener") === false);

// --- resolveCooldownReason (adversarial-review fix): a follow_up's wire
// reason must resolve to its ROOT for cooldown classification, not the
// literal "follow_up" value — this is what closes the loophole where an
// autopilot-originated follow-up chain could borrow the human exemption. ---

assertOk(
  "resolveCooldownReason: non-follow_up reasons pass through unchanged (user_chat)",
  resolveCooldownReason("user_chat", null) === "user_chat"
);
assertOk(
  "resolveCooldownReason: non-follow_up reasons pass through unchanged (autopilot_poll)",
  resolveCooldownReason("autopilot_poll", "user_chat") === "autopilot_poll"
);
assertOk(
  "resolveCooldownReason: non-follow_up reasons pass through unchanged (opener)",
  resolveCooldownReason("opener", null) === "opener"
);
assertOk(
  "resolveCooldownReason: follow_up rooted in user_chat resolves human-initiated",
  resolveCooldownReason("follow_up", "user_chat") === "user_chat" &&
    isHumanInitiated(resolveCooldownReason("follow_up", "user_chat"))
);
assertOk(
  "resolveCooldownReason: follow_up rooted in autopilot_poll stays floored",
  resolveCooldownReason("follow_up", "autopilot_poll") === "autopilot_poll" &&
    !isHumanInitiated(resolveCooldownReason("follow_up", "autopilot_poll"))
);
assertOk(
  "resolveCooldownReason: follow_up rooted in opener stays floored",
  resolveCooldownReason("follow_up", "opener") === "opener" &&
    !isHumanInitiated(resolveCooldownReason("follow_up", "opener"))
);
assertOk(
  "resolveCooldownReason: follow_up with a lost/null root fails closed to floored (autopilot_poll), not human",
  resolveCooldownReason("follow_up", null) === "autopilot_poll" &&
    !isHumanInitiated(resolveCooldownReason("follow_up", null))
);

// Production rejected the ten-action union's compiled grammar even at the
// documented optional-field limit. Check the actual provider schema recursively
// (including nested sample/queue objects), and pin the smaller live-tested budget.
// Counts alone cannot prove Anthropic will compile it: schema changes also need
// a real /api/dj smoke before deployment.
{
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const js = zodOutputFormat(BrainResponseSchema).schema;
  let optionalTotal = 0;
  let unionTotal = 0;
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (node.properties) {
      optionalTotal += Object.keys(node.properties).filter(k => !node.required?.includes(k)).length;
    }
    if (node.anyOf || node.oneOf || Array.isArray(node.type)) unionTotal++;
    Object.values(node).forEach(visit);
  }
  visit(js);
  assertOk(`provider schema: at most 7 optional fields, including nested fields (got ${optionalTotal})`, optionalTotal <= 7);
  assertOk(`provider schema: at most 3 unions (got ${unionTotal})`, unionTotal <= 3);
  const hasDefs = /"\$(?:ref|defs)"/.test(JSON.stringify(js));
  assertOk("schema: no $ref/$defs (Anthropic rejects them under anyOf)", !hasDefs);
}

// Every provider action must still become the same flat command the existing
// client consumes. In particular, absent EQ bands must remain absent, queue
// defaults must survive, and completion-owned actions must not gain follow-ups.
{
  const commands = [
    { action: "queue", trackId: "0", transition: "gap", durationBars: 8, startAt: "beginning", maskFx: "space_sweep" },
    { action: "tempo_nudge", tempoDelta: 0.02 },
    { action: "fx", fx: "scratch_chirp" },
    { action: "eq", deck: "live", low: -12 },
    { action: "eq_sweep", band: "low", toDb: -12, bars: 4 },
    { action: "trance_breakdown", trackId: "1", bars: 16, dropSeconds: 90 },
    { action: "loop", captureBars: 4, isolation: "melody", holdSeconds: 12, halvings: 3 },
    { action: "routine", routine: "sample_mix", sample: { captureBars: 4, isolation: "beat", holdSeconds: 16, halvings: 2, sweepToBpm: 100 }, queue: { trackId: "1", transition: "bass_swap", durationBars: 4, startAt: "auto", maskFx: "space_sweep" } },
    { action: "stem_migrate", trackId: "1", bars: 32, anchor: "out" },
    { action: "none" },
  ];
  assertOk("provider cases cover every executor action", isDeepStrictEqual(
    commands.map(c => c.action).sort(),
    CommandSchema.options.map(s => s.shape.action.value).sort(),
  ));
  for (const command of commands) {
    const metadata = { say: "Soundcheck OK", followUpSeconds: 30 };
    const parsed = parseBrainResponseText(JSON.stringify({ command, ...metadata }));
    assertOk(`provider ${command.action}: preserves the validated flat command`, parsed.ok &&
      isDeepStrictEqual(parsed.command, CommandSchema.parse({ ...command, ...metadata })));
  }
  const queue = parseBrainResponseText('{"command":{"action":"queue","trackId":"0"},"say":""}');
  assertOk("provider queue: retains default transition, duration and entry", queue.ok &&
    queue.command.transition === "beatmatch_crossfade" && queue.command.durationBars === 16 && queue.command.startAt === "auto");
  const none = parseBrainResponseText('{"command":{"action":"none"},"say":"Soundcheck OK"}');
  assertOk("provider: live response without follow-up stays unscheduled", none.ok &&
    isDeepStrictEqual(none.command, { action: "none", say: "Soundcheck OK" }));
  for (const raw of [
    "not JSON", "null", "{}",
    '{"command":{"action":"queue"},"say":""}',
    '{"command":{"action":"unknown"},"say":""}',
    '{"command":{"action":"none"}}',
    '{"command":{"action":"none"},"say":"","followUpSeconds":4}',
    '{"command":{"action":"eq","deck":"live","low":-99},"say":""}',
    '{"command":{"action":"loop","captureBars":4,"isolation":"beat","holdSeconds":90,"halvings":2},"say":""}',
    '{"command":{"action":"stem_migrate","trackId":"0","bars":32},"say":""}',
    '{"command":{"action":"routine","routine":"sample_mix"},"say":""}',
  ]) {
    assertOk(`provider rejects invalid output: ${raw}`, !parseBrainResponseText(raw).ok);
  }
}

// compact crate: the s (hasStems) flag the brain keys stem_migrate on
{
  const { buildCompactCrateEntry } = await import("../src/lib/brain.ts");
  const withStems = buildCompactCrateEntry(3, "Gasolina", 96, "9A", true, 12, true);
  const without = buildCompactCrateEntry(4, "Rompe", 88, "9A", true, null, false);
  assertOk("compact crate: s:true present when the track has stems on Drive", withStems.s === true);
  assertOk("compact crate: s OMITTED (not false) when it does not — same byte convention as g", !("s" in without));
}

// stem_migrate shape
assertOk("stem_migrate: valid with required anchor and say",
  CommandSchema.safeParse({ action: "stem_migrate", trackId: "12", bars: 32, anchor: "out", say: "riding the drums" }).success);
assertOk("stem_migrate: rejects missing anchor",
  !CommandSchema.safeParse({ action: "stem_migrate", trackId: "12", bars: 32, say: "x" }).success);
assertOk("stem_migrate: rejects bars below 8",
  !CommandSchema.safeParse({ action: "stem_migrate", trackId: "12", bars: 4, anchor: "out", say: "x" }).success);
assertOk("stem_migrate: is a performance move for cadence",
  isPerformanceMove("stem_migrate"));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all command schema cases");
