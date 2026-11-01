#!/usr/bin/env node
// Node-side smoke test for the /api/dj route's pure building blocks, without
// a real Anthropic key or a running dev server: imports SYSTEM_PROMPT and
// buildUserMessage straight from src/lib/brain.ts (the same module
// route.ts calls) and asserts (a) the system prompt is a stable string with
// no per-call volatility (no Date.now/random — see prompt-caching guidance:
// a frozen system prompt is load-bearing for caching), and (b) state+crate
// serialization is correct (round-trips through JSON, right shape, note
// passthrough). Plain asserts, no test framework, mirrors check-command.mjs.
import { spawnSync } from "node:child_process";
import {
  SYSTEM_PROMPT,
  buildSystemBlocks,
  buildRequestBlocks,
  buildCompactCrateEntry,
  buildCrateWindow,
  modelSupportsFallbacks,
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

// --- system prompt stability ---

assertOk("SYSTEM_PROMPT: is a non-empty string", typeof SYSTEM_PROMPT === "string" && SYSTEM_PROMPT.length > 0);
assertOk("SYSTEM_PROMPT: identical across repeated reads (byte-stable)", SYSTEM_PROMPT === SYSTEM_PROMPT);
// Historical owner-ruling dates are static text, not volatile timestamps. Load
// the actual module under two different clocks/random seeds to test caching.
const promptAt = (clock, random) => {
  const url = new URL('../src/lib/brain.ts', import.meta.url).href;
  const code = `const RealDate=Date; globalThis.Date=class extends RealDate { constructor(...args) { super(...(args.length ? args : [${clock}])); } static now(){return ${clock};} }; Math.random=()=>${random}; const m=await import(${JSON.stringify(url)}); process.stdout.write(m.SYSTEM_PROMPT);`;
  const result = spawnSync(process.execPath, ['--experimental-strip-types','--no-warnings','--input-type=module','-e',code], {encoding:'utf8',timeout:10000});
  if (result.status !== 0) throw new Error(result.stderr || 'Prompt stability subprocess failed');
  return result.stdout;
};
assertOk("SYSTEM_PROMPT: stable across different clocks and random seeds", promptAt(0,0.1) === SYSTEM_PROMPT && promptAt(4102444800000,0.9) === SYSTEM_PROMPT);

assertOk("SYSTEM_PROMPT: mentions the one-command contract", SYSTEM_PROMPT.toLowerCase().includes("one json command"));
assertOk("SYSTEM_PROMPT: mentions BPM guidance", SYSTEM_PROMPT.includes("8%"));
assertOk(
  "SYSTEM_PROMPT: M4 lessons paragraph present (mentions lessons + a prohibition framing)",
  SYSTEM_PROMPT.includes("lessons") && SYSTEM_PROMPT.includes("👎") && SYSTEM_PROMPT.toLowerCase().includes("prohibit")
);
assertOk("SYSTEM_PROMPT: mentions bass_swap as the default preferred blend", SYSTEM_PROMPT.includes("bass_swap"));
assertOk(
  "SYSTEM_PROMPT: mentions transitionPending (choir round #2, P1 queue-concurrency fix) and the followUpSeconds guidance tied to it",
  SYSTEM_PROMPT.includes("transitionPending") && SYSTEM_PROMPT.includes("followUpSeconds comfortably above ~20s")
);

// --- FX-upgrade rulebook assertions: pin the researched rules so a future
// prompt edit can't silently drop them (same drift-guard purpose as the
// bass_swap/8%/lessons assertions above). ---
assertOk("SYSTEM_PROMPT: mentions fxLastSecondsAgo (frequency-cap state field)", SYSTEM_PROMPT.includes("fxLastSecondsAgo"));
assertOk("SYSTEM_PROMPT: frequency cap pinned (~10 minutes)", SYSTEM_PROMPT.includes("per ~10 minutes"));
assertOk(
  "SYSTEM_PROMPT: salsa/bachata suppression extends beyond fx (no echo_out/cut mid-phrase/blend)",
  SYSTEM_PROMPT.includes("no echo_out, no cut mid-phrase")
);
assertOk(
  "SYSTEM_PROMPT: never fire fx while a transition is in progress",
  SYSTEM_PROMPT.includes("Never fire fx while a transition is currently in progress")
);
assertOk(
  "SYSTEM_PROMPT: reggaeton/hip-hop lane is short open-format blends, not festival EDM",
  SYSTEM_PROMPT.includes("open-format party DJ")
);
assertOk(
  "SYSTEM_PROMPT: trance/big-room avoids siren and rewind (off-genre)",
  SYSTEM_PROMPT.includes("Siren and rewind are AVOID in this lane")
);
assertOk(
  "SYSTEM_PROMPT: fx-as-energy-rescue only paired with a track change, never a standalone lull stinger",
  SYSTEM_PROMPT.includes("energy-rescue move")
);

// --- Vocal-library upgrade assertions: pin mic discipline, variant
// selection, the salsa warm-cue exception, and the brand wall so a future
// prompt edit can't silently drop any of them. ---
assertOk(
  "SYSTEM_PROMPT: mic discipline rule present (prefers intros/outros/transitions/instrumental breaks, never mid-verse)",
  SYSTEM_PROMPT.includes("Mic discipline: vocal clips") && SYSTEM_PROMPT.includes("never intentionally over a vocal-dense mid-verse moment")
);
assertOk(
  "SYSTEM_PROMPT: variant selection rule present (cue_warm builds/instrumental/coro-support, cue_hype drops/peaks only)",
  SYSTEM_PROMPT.includes("cue_warm is for builds, instrumental gaps, and salsa coro-support moments") &&
    SYSTEM_PROMPT.includes("cue_hype is for drops and peaks ONLY")
);
assertOk(
  "SYSTEM_PROMPT: countdown-type crowd clips gated to the final seconds before a drop/hand-off",
  SYSTEM_PROMPT.includes("fire only in the final seconds before a drop or hand-off")
);
assertOk(
  "SYSTEM_PROMPT: salsa warm-cue exception present (sonero/montuno framing, fx stingers still banned)",
  SYSTEM_PROMPT.includes("a single cue_warm clip is in-culture ONLY at a montuno/coro moment") &&
    SYSTEM_PROMPT.includes("Suppress ALL fx stingers and scratching mid-track")
);
assertOk(
  "SYSTEM_PROMPT: brand wall present (no Los Descuentos / DJ Supermercado name-drop, no artist signature marks)",
  SYSTEM_PROMPT.includes('NEVER say "Los Descuentos"') &&
    SYSTEM_PROMPT.includes('drop the "DJ Supermercado" name as your own tag') &&
    SYSTEM_PROMPT.includes("¡Azúcar!")
);

// --- Review-panel fixes (2026-07-26): pin the "drop" fx usability, the
// "gap" transition rule, the untagged-BPM guard, and the vibe-note
// persistence wording so a future prompt edit can't silently drop any of
// them. ---
assertOk(
  "SYSTEM_PROMPT: 'drop' vocal category is described as usable (schema fix landed alongside this)",
  SYSTEM_PROMPT.includes("drop: fully produced voice+SFX composites")
);
assertOk(
  "SYSTEM_PROMPT: 'gap' transition rule present (salsa/bachata clean-ending mechanism, named explicitly)",
  SYSTEM_PROMPT.includes('use transition "gap"') && SYSTEM_PROMPT.includes('Let the current track END cleanly using transition "gap"')
);
assertOk(
  "SYSTEM_PROMPT: untagged-BPM guard present (no beatmatch_crossfade/bass_swap against a candidate with no bpm tag)",
  SYSTEM_PROMPT.includes("If the candidate you're queuing has NO bpm tag at all")
);
assertOk(
  "SYSTEM_PROMPT: vibe-note persistence wording present (state.lastVibeNote decays with age)",
  SYSTEM_PROMPT.includes("state.lastVibeNote is the human's most recent instruction with its age in seconds") &&
    SYSTEM_PROMPT.includes("a minutes-old") &&
    SYSTEM_PROMPT.includes("an hour-old one is context, not command")
);

// --- Headless Horseman persona addendum + shout-out/cue-point pins (this milestone) ---
assertOk(
  "SYSTEM_PROMPT: Headless Horseman persona line present (full title, Spanish translation, no-hands/no-head framing)",
  SYSTEM_PROMPT.includes('DJ Cerebro, the Headless Horseman') &&
    SYSTEM_PROMPT.includes("el jinete sin cabeza") &&
    SYSTEM_PROMPT.includes("no hands, no head, puro cerebro")
);
assertOk(
  "SYSTEM_PROMPT: shout-outs are host-triggered only, never autonomous (hard wall, not a judgment call)",
  SYSTEM_PROMPT.includes("HOST-TRIGGERED ONLY, never autonomous") && SYSTEM_PROMPT.includes("not even in your fx enum")
);
assertOk(
  "SYSTEM_PROMPT: cue points are pre-marked/human-authored, not brain-requestable, and don't burn the fx frequency cap",
  SYSTEM_PROMPT.includes("Cue points (pre-marked by the human DJ, not something you request)") &&
    SYSTEM_PROMPT.includes("never counts against your fx frequency cap")
);

// --- Owner soundcheck fixes (2026-07-26): pin the half/double-time note,
// the seam-masking rule (+ salsa exclusion + cooldown exemption), and the
// fx-demonstration-log rule so a future prompt edit can't silently drop any
// of them. ---
assertOk(
  "SYSTEM_PROMPT: half/double-time BPM compatibility note present (90≈180, dembow<->club-tempo bridges)",
  SYSTEM_PROMPT.includes("Half/double-time BPM counts as compatible too") &&
    SYSTEM_PROMPT.includes("90 BPM ≈ 180 BPM") &&
    SYSTEM_PROMPT.includes("dembow")
);
assertOk(
  "SYSTEM_PROMPT: seam-masking rule present (maskFx field, rough-transition triggers)",
  SYSTEM_PROMPT.includes("Seam masking (the queue command's optional maskFx field)") &&
    SYSTEM_PROMPT.includes("the tempo-sync will clamp") &&
    SYSTEM_PROMPT.includes("missing a real BeatGrid")
);
assertOk(
  "SYSTEM_PROMPT: seam-masking salsa/bachata exclusion present (NEVER, no exceptions)",
  SYSTEM_PROMPT.includes('salsa/bachata — NEVER set maskFx, the clean "gap" ending rule stands with no exceptions')
);
assertOk(
  "SYSTEM_PROMPT: seam-masking exempt from the fx frequency cap/cooldown floor, but still updates cadence",
  SYSTEM_PROMPT.includes("they're exempt from the fx frequency cap and the cooldown floor") &&
    SYSTEM_PROMPT.includes("they still update the cadence clock afterward")
);
assertOk(
  "SYSTEM_PROMPT: fx-demonstration-log rule present (imitate the human's manual placements)",
  SYSTEM_PROMPT.includes("state.fxDemonstrations is the human DJ's own manual effect usage") &&
    SYSTEM_PROMPT.includes("his demonstrated timing outranks the generic genre rules above")
);
assertOk(
  "SYSTEM_PROMPT: fx-demonstration-log rule never overrides salsa/bachata suppression or the frequency cap",
  SYSTEM_PROMPT.includes("never overrides the salsa/bachata suppression or the frequency cap")
);

// --- Deferred-action mechanism (owner soundcheck fix, 2026-07-26): pin the
// followUpSeconds explanation and the consultReason explanation so a future
// prompt edit can't silently drop either. ---
assertOk(
  "SYSTEM_PROMPT: deferred-action mechanism explained (cannot schedule inside one command, use followUpSeconds)",
  SYSTEM_PROMPT.includes("You cannot schedule future actions inside one command") &&
    SYSTEM_PROMPT.includes("set followUpSeconds so the app re-consults you at the right moment") &&
    SYSTEM_PROMPT.includes("never below 5s and never as a busy-poll")
);
assertOk(
  "SYSTEM_PROMPT: consultReason explained (four values, follow_up = act on the deferred instruction)",
  SYSTEM_PROMPT.includes("state.consultReason tells you why you're being asked") &&
    SYSTEM_PROMPT.includes('"follow_up"') &&
    SYSTEM_PROMPT.includes("the human's last instruction is what you deferred")
);

// --- Compact crate format + windowing honesty (cost addendum, 2026-07-26):
// pin the n/t/bpm/k/g field explanation and the windowed-vs-full disclosure
// so a future prompt edit can't silently drop either. ---
assertOk(
  "SYSTEM_PROMPT: compact crate field mapping explained (n=index/t=name/bpm/k/g)",
  SYSTEM_PROMPT.includes("n is the entry's index") &&
    SYSTEM_PROMPT.includes("t is a cleaned display name") &&
    SYSTEM_PROMPT.includes("g is present (true) only when a real BeatGrid exists")
);
assertOk(
  "SYSTEM_PROMPT: windowing disclosed honestly (windowed slice when live, full crate for openers)",
  SYSTEM_PROMPT.includes("the crate list you see is a windowed slice") &&
    SYSTEM_PROMPT.includes("When nothing is live (an opener call), you see the full crate")
);

// --- Prompt caching (scope addendum, 2026-07-26): the route sends
// SYSTEM_PROMPT as a cache_control-tagged block array (1h TTL), not a bare
// string — pin the exact shape src/lib/pricing.ts's cache multipliers and
// the real API call both depend on. ---
{
  const blocks = buildSystemBlocks();
  assertOk("buildSystemBlocks: returns a single-element array", Array.isArray(blocks) && blocks.length === 1);
  assertOk("buildSystemBlocks: block type is 'text'", blocks[0].type === "text");
  assertOk("buildSystemBlocks: text is exactly SYSTEM_PROMPT (byte-identical)", blocks[0].text === SYSTEM_PROMPT);
  assertOk(
    "buildSystemBlocks: cache_control is ephemeral with a 1h TTL",
    blocks[0].cache_control?.type === "ephemeral" && blocks[0].cache_control?.ttl === "1h"
  );
  assertOk("buildSystemBlocks: stable across calls (same shape every time)", JSON.stringify(buildSystemBlocks()) === JSON.stringify(blocks));
}

// Importing the module twice via a fresh dynamic import (Node module cache
// notwithstanding) should still yield the exact same string — guards against
// any accidental per-call construction (e.g. a function instead of a const).
{
  const mod2 = await import("../src/lib/brain.ts?cachebust=1");
  assertOk("SYSTEM_PROMPT: stable across separate module instances", mod2.SYSTEM_PROMPT === SYSTEM_PROMPT);
}

// --- state serialization ---

const sampleState = {
  live: {
    trackId: "t1",
    name: "Track One",
    bpm: 120,
    key: "8A",
    tempo: 1.02,
    effectiveBpm: 122.4,
    positionSeconds: 45.2,
    duration: 210,
    remainingSeconds: 164.8,
    fxLastSecondsAgo: 312.5,
    transitionPending: false,
  },
  idleDeck: "B",
  history: [{ trackId: "t0", name: "Opener" }],
  autopilot: true,
  consultReason: "user_chat",
  lastVibeNote: { text: "less fx please", secondsAgo: 42.5 },
  fxDemonstrations: {
    byFx: [{ fx: "airhorn", count: 3, medianPositionFraction: 0.82, shareDuringTransition: 0, shareInLastQuarter: 1 }],
    recent: [{ fx: "airhorn", positionFraction: 0.82, duringTransition: false }],
  },
};

// Compact crate wire format (cost addendum) — n/t/bpm/k/g, not the old
// id/name/bpm/key/hasGrid shape. See buildCompactCrateEntry in brain.ts.
const sampleCrate = [
  buildCompactCrateEntry(0, "Track One", 120, "8A", true),
  buildCompactCrateEntry(1, "Track Two", 124, "9A", false),
];

const sampleLessons = [
  "bass_swap 120→124 over 16 bars rated 👍 ×3",
  "beatmatch_crossfade with clamped BPM rated 👎 ×2 — avoid",
];

// buildRequestBlocks replaces the old single-string buildUserMessage — two
// blocks now: [0] the crate (cache_control-tagged only when crateCacheable),
// [1] the volatile state/note/lessons suffix.

{
  const blocks = buildRequestBlocks({
    message: "play something chill",
    state: sampleState,
    crate: sampleCrate,
    crateCacheable: true,
    lessons: sampleLessons,
  });
  assertOk("buildRequestBlocks: returns exactly two blocks", Array.isArray(blocks) && blocks.length === 2);
  assertOk("buildRequestBlocks: both blocks are type 'text'", blocks[0].type === "text" && blocks[1].type === "text");

  const crateParsed = JSON.parse(blocks[0].text);
  assertOk("buildRequestBlocks: crate block produces valid JSON", crateParsed !== null);
  assertOk("buildRequestBlocks: round-trips crate exactly", JSON.stringify(crateParsed.crate) === JSON.stringify(sampleCrate));
  assertOk(
    "buildRequestBlocks: crate block IS cache_control-tagged (1h TTL) when crateCacheable",
    blocks[0].cache_control?.type === "ephemeral" && blocks[0].cache_control?.ttl === "1h"
  );

  const volatileParsed = JSON.parse(blocks[1].text);
  assertOk("buildRequestBlocks: volatile block produces valid JSON", volatileParsed !== null);
  assertOk("buildRequestBlocks: round-trips state exactly", JSON.stringify(volatileParsed.state) === JSON.stringify(sampleState));
  assertOk("buildRequestBlocks: carries the human note", volatileParsed.note === "play something chill");
  assertOk("buildRequestBlocks: round-trips lessons exactly", JSON.stringify(volatileParsed.lessons) === JSON.stringify(sampleLessons));
  assertOk("buildRequestBlocks: volatile block has NO cache_control", blocks[1].cache_control === undefined);
  assertOk(
    "buildRequestBlocks: round-trips live.fxLastSecondsAgo (FX upgrade)",
    volatileParsed.state.live.fxLastSecondsAgo === 312.5
  );
  assertOk(
    "buildRequestBlocks: round-trips state.lastVibeNote exactly (review-panel fix — vibe-note persistence)",
    volatileParsed.state.lastVibeNote.text === "less fx please" && volatileParsed.state.lastVibeNote.secondsAgo === 42.5
  );
  assertOk(
    "buildRequestBlocks: round-trips state.fxDemonstrations exactly (owner soundcheck fix)",
    JSON.stringify(volatileParsed.state.fxDemonstrations) === JSON.stringify(sampleState.fxDemonstrations)
  );
}

{
  // Windowed crate (crateCacheable: false) must NOT carry cache_control —
  // it changes every call, so caching it would only pay the write premium.
  const blocks = buildRequestBlocks({
    message: null,
    state: sampleState,
    crate: sampleCrate,
    crateCacheable: false,
    lessons: [],
  });
  assertOk("buildRequestBlocks: windowed crate block has NO cache_control", blocks[0].cache_control === undefined);
}

{
  // Empty log -> the shared empty-summary shape, not omitted/undefined.
  const noDemoState = { ...sampleState, fxDemonstrations: { byFx: [], recent: [] } };
  const blocks = buildRequestBlocks({ message: null, state: noDemoState, crate: [], crateCacheable: true, lessons: [] });
  const parsed = JSON.parse(blocks[1].text);
  assertOk(
    "buildRequestBlocks: empty fxDemonstrations serializes as {byFx:[],recent:[]}",
    Array.isArray(parsed.state.fxDemonstrations.byFx) &&
      parsed.state.fxDemonstrations.byFx.length === 0 &&
      Array.isArray(parsed.state.fxDemonstrations.recent) &&
      parsed.state.fxDemonstrations.recent.length === 0
  );
}

{
  // Review-panel fix: lastVibeNote must persist into an autopilot-driven
  // (message: null) call, not just the request the human actually typed
  // into — that's the whole point of the fix (page.tsx's lastVibeNoteRef
  // survives across calls; this asserts the wire shape supports it).
  const autopilotState = { ...sampleState, lastVibeNote: { text: "less fx please", secondsAgo: 305 } };
  const blocks = buildRequestBlocks({ message: null, state: autopilotState, crate: [], crateCacheable: true, lessons: [] });
  const parsed = JSON.parse(blocks[1].text);
  assertOk("buildRequestBlocks: lastVibeNote rides along on a null-message (autopilot-driven) call too", parsed.state.lastVibeNote.text === "less fx please");
  assertOk("buildRequestBlocks: lastVibeNote.secondsAgo reflects age, independent of note being present", parsed.state.lastVibeNote.secondsAgo === 305);
}

{
  // No vibe note sent yet this session -> null, not omitted/undefined.
  const noNoteState = { ...sampleState, lastVibeNote: null };
  const blocks = buildRequestBlocks({ message: null, state: noNoteState, crate: [], crateCacheable: true, lessons: [] });
  const parsed = JSON.parse(blocks[1].text);
  assertOk("buildRequestBlocks: state.lastVibeNote null (no vibe note yet) serializes as null", parsed.state.lastVibeNote === null);
}

{
  // FX upgrade: fxLastSecondsAgo === null means no fx has fired yet this session.
  const noFxState = { ...sampleState, live: { ...sampleState.live, fxLastSecondsAgo: null } };
  const blocks = buildRequestBlocks({ message: null, state: noFxState, crate: [], crateCacheable: true, lessons: [] });
  const parsed = JSON.parse(blocks[1].text);
  assertOk("buildRequestBlocks: live.fxLastSecondsAgo null (no fx fired yet) serializes as null", parsed.state.live.fxLastSecondsAgo === null);
}

{
  const blocks = buildRequestBlocks({ message: null, state: sampleState, crate: [], crateCacheable: true, lessons: [] });
  const crateParsed = JSON.parse(blocks[0].text);
  const volatileParsed = JSON.parse(blocks[1].text);
  assertOk("buildRequestBlocks: null message -> null note", volatileParsed.note === null);
  assertOk("buildRequestBlocks: empty crate serializes as []", Array.isArray(crateParsed.crate) && crateParsed.crate.length === 0);
  assertOk("buildRequestBlocks: empty lessons serializes as []", Array.isArray(volatileParsed.lessons) && volatileParsed.lessons.length === 0);
}

{
  const emptyState = { live: null, idleDeck: "A", history: [], autopilot: false, consultReason: "opener", lastVibeNote: null };
  const blocks = buildRequestBlocks({ message: null, state: emptyState, crate: [], crateCacheable: true, lessons: [] });
  const parsed = JSON.parse(blocks[1].text);
  assertOk("buildRequestBlocks: null live track serializes as null", parsed.state.live === null);
}

{
  // Deferred re-consult (owner soundcheck fix): DjState round-trips
  // consultReason for all four values honestly (four real call sites in
  // page.tsx: user_chat, autopilot_poll, follow_up, opener).
  for (const reason of ["user_chat", "autopilot_poll", "follow_up", "opener"]) {
    const state = { ...sampleState, consultReason: reason };
    const blocks = buildRequestBlocks({ message: null, state, crate: [], crateCacheable: true, lessons: [] });
    const parsed = JSON.parse(blocks[1].text);
    assertOk(`buildRequestBlocks: round-trips consultReason "${reason}"`, parsed.state.consultReason === reason);
  }
}

// --- buildCompactCrateEntry (cost addendum): omits null/false fields rather
// than sending them explicitly. ---

{
  const full = buildCompactCrateEntry(5, "Bad Bunny - Titi Me Preguntó", 122, "8A", true);
  assertOk("buildCompactCrateEntry: full entry has all fields", full.n === 5 && full.t === "Bad Bunny - Titi Me Preguntó" && full.bpm === 122 && full.k === "8A" && full.g === true);
}
{
  const sparse = buildCompactCrateEntry(2, "Untagged Track", null, null, false);
  assertOk("buildCompactCrateEntry: null bpm omitted (not sent as null)", !("bpm" in sparse));
  assertOk("buildCompactCrateEntry: null key omitted (not sent as null)", !("k" in sparse));
  assertOk("buildCompactCrateEntry: hasGrid=false omits g entirely (never sent as false)", !("g" in sparse));
  assertOk("buildCompactCrateEntry: n/t always present", sparse.n === 2 && sparse.t === "Untagged Track");
}

// --- buildCrateWindow (cost addendum): candidate windowing when a track is
// live — BPM-compatible (incl. half/double-time) + vibe-note name matches +
// a random wildcard sample, capped; full unwindowed list when nothing is
// live. ---

const bigCrate = [
  buildCompactCrateEntry(0, "Compatible A", 120, null, false), // in-window (exact)
  buildCompactCrateEntry(1, "Half Time B", 60, null, false), // in-window (double-time: 60*2=120)
  buildCompactCrateEntry(2, "Double Time C", 240, null, false), // in-window (half-time: 240*0.5=120)
  buildCompactCrateEntry(3, "Incompatible D", 90, null, false), // out of window
  buildCompactCrateEntry(4, "Untagged E", null, null, false), // no bpm at all -> never "compatible"
  buildCompactCrateEntry(5, "Vibe Match Bachata Anthem", 95, null, false), // matched by vibe note text, not bpm
  ...Array.from({ length: 20 }, (_, i) => buildCompactCrateEntry(6 + i, `Filler ${i}`, 85 + i, null, false)),
];

{
  const result = buildCrateWindow({ entries: bigCrate, liveEffectiveBpm: null, vibeNoteText: null });
  assertOk("buildCrateWindow: nothing live -> unwindowed, full list returned unchanged", result.windowed === false && result.entries.length === bigCrate.length);
}

{
  const result = buildCrateWindow({
    entries: bigCrate,
    liveEffectiveBpm: 120,
    vibeNoteText: null,
    wildcardCount: 5,
    random: () => 0, // deterministic — always picks index 0 of the remaining pool
  });
  assertOk("buildCrateWindow: live -> windowed = true", result.windowed === true);
  assertOk("buildCrateWindow: exact BPM match included", result.entries.some((e) => e.n === 0));
  assertOk("buildCrateWindow: half-time match included (60 -> *2 = 120)", result.entries.some((e) => e.n === 1));
  assertOk("buildCrateWindow: double-time match included (240 -> *0.5 = 120)", result.entries.some((e) => e.n === 2));
  assertOk("buildCrateWindow: out-of-window bpm excluded from the compatible set", !result.entries.slice(0, result.compatibleCount).some((e) => e.n === 3));
  assertOk("buildCrateWindow: compatibleCount is exactly 3 (A, B, C)", result.compatibleCount === 3);
  assertOk("buildCrateWindow: wildcardCount respects the requested cap (5)", result.wildcardCount === 5);
}

{
  // Vibe-note name match rides along even when its own BPM is well outside
  // the window (95 vs a 120 live effective BPM, no half/double multiple hits it).
  const result = buildCrateWindow({
    entries: bigCrate,
    liveEffectiveBpm: 120,
    vibeNoteText: "bachata anthem",
    wildcardCount: 0,
  });
  assertOk("buildCrateWindow: vibe-note text match included despite incompatible BPM", result.entries.some((e) => e.n === 5));
  assertOk("buildCrateWindow: vibeMatchCount reflects the one match", result.vibeMatchCount === 1);
}

{
  const result = buildCrateWindow({ entries: bigCrate, liveEffectiveBpm: 120, vibeNoteText: null, cap: 4, wildcardCount: 20 });
  assertOk("buildCrateWindow: total entries respect the cap", result.entries.length <= 4);
}

{
  // Determinism: same random function -> same wildcard selection every call.
  const random = (() => {
    let i = 0;
    const seq = [0.1, 0.5, 0.9, 0.3, 0.7];
    return () => seq[i++ % seq.length];
  })();
  const r1 = buildCrateWindow({ entries: bigCrate, liveEffectiveBpm: 120, vibeNoteText: null, wildcardCount: 3, random });
  const random2 = (() => {
    let i = 0;
    const seq = [0.1, 0.5, 0.9, 0.3, 0.7];
    return () => seq[i++ % seq.length];
  })();
  const r2 = buildCrateWindow({ entries: bigCrate, liveEffectiveBpm: 120, vibeNoteText: null, wildcardCount: 3, random: random2 });
  assertOk(
    "buildCrateWindow: deterministic given the same injected random sequence",
    JSON.stringify(r1.entries) === JSON.stringify(r2.entries)
  );
}

// --- modelSupportsFallbacks (M5 fix, re-pinned for the opus-5 env swap):
// the server-side fallbacks param only applies to the elevated-safety-
// classifier families — confirms the gating still applies correctly when
// ANTHROPIC_MODEL flips to claude-opus-5. ---

assertOk("modelSupportsFallbacks: claude-opus-5 supports fallbacks", modelSupportsFallbacks("claude-opus-5") === true);
assertOk("modelSupportsFallbacks: claude-fable-5 supports fallbacks", modelSupportsFallbacks("claude-fable-5") === true);
assertOk("modelSupportsFallbacks: claude-mythos-5 supports fallbacks", modelSupportsFallbacks("claude-mythos-5") === true);
assertOk("modelSupportsFallbacks: claude-sonnet-5 does NOT support fallbacks (400s if sent)", modelSupportsFallbacks("claude-sonnet-5") === false);
assertOk("modelSupportsFallbacks: claude-haiku-4-5 does NOT support fallbacks", modelSupportsFallbacks("claude-haiku-4-5") === false);

// --- In-and-out mixing (2026-07-28): pin the craft rule, the salsa/bachata
// startAt "beginning" exemption, and the residency guidance so a future
// prompt edit can't silently drop any of them. ---
assertOk(
  "SYSTEM_PROMPT: in-and-out mixing rule present (startAt auto/beginning, mixOutSeconds early-warning)",
  SYSTEM_PROMPT.includes("In-and-out mixing:") &&
    SYSTEM_PROMPT.includes('"auto" (the default') &&
    SYSTEM_PROMPT.includes("mixOutSeconds")
);
assertOk(
  "SYSTEM_PROMPT: salsa/bachata (and genre-uncertain partner-dance tracks) MUST use startAt beginning",
  SYSTEM_PROMPT.includes('MUST use startAt "beginning"') && SYSTEM_PROMPT.includes("a full, unspliced ending")
);
assertOk(
  "SYSTEM_PROMPT: residency guidance present (~90-180s filler, followUpSeconds to schedule the exit)",
  SYSTEM_PROMPT.includes("Residency (the anthem-vs-filler tension, resolved") &&
    SYSTEM_PROMPT.includes("roughly 90-180 seconds") &&
    SYSTEM_PROMPT.includes("This does not apply to salsa/bachata")
);
// M7 blocker fix: an EXPLICIT owner residency instruction has to beat the
// standing window, the anthem exception, AND salsa/bachata's full-length
// rule — the 2026-07-29 failure ("you are going way longer than 30 seconds")
// was the standing 90-180s guidance quietly winning over what Jason asked
// for. The 90-180s rule must also now be scoped to "no explicit request".
assertOk(
  "SYSTEM_PROMPT: an explicit requestedResidencySeconds overrides the standing residency window",
  SYSTEM_PROMPT.includes("Residency OVERRIDE") &&
    SYSTEM_PROMPT.includes("state.requestedResidencySeconds") &&
    SYSTEM_PROMPT.includes("applies only when state.requestedResidencySeconds is null")
);
assertOk(
  "SYSTEM_PROMPT: manual-fx-as-demonstration/ledger rule present (per-track owner notes = highest authority, 👎+note = near-prohibition)",
  SYSTEM_PROMPT.includes("state.ledger is the lesson ledger's distilled digest") &&
    SYSTEM_PROMPT.includes("highest-authority craft signal") &&
    SYSTEM_PROMPT.includes("owner demonstrating the exact moment that fx belongs") &&
    SYSTEM_PROMPT.includes("A 👎 rating with a note is a near-prohibition")
);

// --- In-and-out mixing: buildRequestBlocks round-trips the ledger digest +
// DjLiveState's new durationSeconds/playedSeconds/mixOutSeconds fields. ---
{
  const stateWithMixOut = {
    ...sampleState,
    live: { ...sampleState.live, durationSeconds: 205.5, playedSeconds: 42.1, mixOutSeconds: 190.25 },
  };
  const ledger = { global: ["👎 blending out at 1:23 (bass_swap): 'too early'"], perTrack: { "0": ["owner fired airhorn manually at 83s (x2)"] } };
  const blocks = buildRequestBlocks({
    message: null,
    state: stateWithMixOut,
    crate: sampleCrate,
    crateCacheable: true,
    lessons: sampleLessons,
    ledger,
  });
  const parsed = JSON.parse(blocks[1].text);
  assertOk(
    "buildRequestBlocks: round-trips live.durationSeconds/playedSeconds/mixOutSeconds",
    parsed.state.live.durationSeconds === 205.5 && parsed.state.live.playedSeconds === 42.1 && parsed.state.live.mixOutSeconds === 190.25
  );
  assertOk("buildRequestBlocks: round-trips the ledger digest exactly", JSON.stringify(parsed.ledger) === JSON.stringify(ledger));
}
{
  // mixOutSeconds null (not yet analyzed) serializes as null, not omitted.
  const noMixOutState = { ...sampleState, live: { ...sampleState.live, durationSeconds: 210, playedSeconds: 0, mixOutSeconds: null } };
  const blocks = buildRequestBlocks({
    message: null,
    state: noMixOutState,
    crate: [],
    crateCacheable: true,
    lessons: [],
    ledger: { global: [], perTrack: {} },
  });
  const parsed = JSON.parse(blocks[1].text);
  assertOk("buildRequestBlocks: live.mixOutSeconds null (not yet analyzed) serializes as null", parsed.state.live.mixOutSeconds === null);
  assertOk(
    "buildRequestBlocks: empty ledger digest serializes as {global:[],perTrack:{}}",
    Array.isArray(parsed.ledger.global) && parsed.ledger.global.length === 0 && Object.keys(parsed.ledger.perTrack).length === 0
  );
}

// --- Craft pass #2 (2026-07-28): pin the five new SYSTEM_PROMPT rule
// categories (vocal-clash, phrase-aligned firing, Camelot harmonic mixing,
// set-arc/anthem-vs-filler, tempo-gap) so a future prompt edit can't
// silently drop any of them. ---
assertOk(
  "SYSTEM_PROMPT: vocal-clash awareness rule present (firstVocalSeconds, vocalActiveNow/nextVocalGap/vocalEndsAt, no simultaneous vocals, palate-cleanser)",
  SYSTEM_PROMPT.includes("Vocal-clash awareness") &&
    SYSTEM_PROMPT.includes("firstVocalSeconds") &&
    SYSTEM_PROMPT.includes("never let two vocal sections run simultaneously in a blend") &&
    SYSTEM_PROMPT.includes("Prefer firing a transition inside the outgoing track's own instrumental gaps") &&
    SYSTEM_PROMPT.includes("alternate vocal INTENSITY")
);
assertOk(
  "SYSTEM_PROMPT: phrase-aligned firing rule present (automatic, no field needed, up to ~16s)",
  SYSTEM_PROMPT.includes("Phrase-aligned firing:") &&
    SYSTEM_PROMPT.includes("16-beat phrase boundary") &&
    SYSTEM_PROMPT.includes("This is automatic and needs no field from you")
);
assertOk(
  "SYSTEM_PROMPT: Camelot harmonic-mixing rule present (same/±1/relative, +2 energy jump, incompatible -> cut/echo_out, blends only)",
  SYSTEM_PROMPT.includes("Camelot harmonic mixing:") &&
    SYSTEM_PROMPT.includes("the relative major/minor") &&
    SYSTEM_PROMPT.includes("A deliberate +2 jump") &&
    SYSTEM_PROMPT.includes('use "cut" or "echo_out" timed at a phrase boundary instead of a long melodic blend') &&
    SYSTEM_PROMPT.includes("matter little for \"cut\"/\"gap\"") &&
    SYSTEM_PROMPT.includes("Never sacrifice energy or genre fit purely to chase a better key match")
);
assertOk(
  "SYSTEM_PROMPT: set-arc / anthem-vs-filler residency tension resolved (partyElapsedSeconds/partyPlannedSeconds, ~62% climax, breathe valleys)",
  SYSTEM_PROMPT.includes("Set arc (only meaningful once autopilot has been running a while") &&
    SYSTEM_PROMPT.includes("state.partyElapsedSeconds/state.partyPlannedSeconds") &&
    SYSTEM_PROMPT.includes("roughly 62% of state.partyPlannedSeconds") &&
    SYSTEM_PROMPT.includes('plan "breathe" valleys') &&
    SYSTEM_PROMPT.includes("A genuine crowd anthem or banger") &&
    SYSTEM_PROMPT.includes("earns its FULL arc instead")
);
assertOk(
  "SYSTEM_PROMPT: tempo-gap (cut-not-blend) rule present (exceeds ±8% after half/double-time -> cut/echo_out on a phrase boundary)",
  SYSTEM_PROMPT.includes("Tempo-gap rule:") &&
    SYSTEM_PROMPT.includes("exceeds the clean ±8% sync range") &&
    SYSTEM_PROMPT.includes("after considering half/double-time") &&
    SYSTEM_PROMPT.includes("never commit to a long beatmatched blend") &&
    SYSTEM_PROMPT.includes("smears transients and shifts vocal formants")
);

// --- audio engine v2 (this pass): rolls, loop-blend, echo-out realness, dry/wet cap, filter-sweep usage ---

assertOk(
  "SYSTEM_PROMPT: beat-roll usage pinned (tension in the last 1-2 bars before a drop/transition, never salsa/bachata, on the PERFORMANCE budget)",
  SYSTEM_PROMPT.includes("roll_eighth / roll_quarter / roll_half") &&
    SYSTEM_PROMPT.includes("tension-building tools for the last 1-2 bars before a drop or a queued transition") &&
    SYSTEM_PROMPT.includes("NEVER during salsa/bachata") &&
    // M7 Phase 3: rolls moved OFF the rare-stinger cap and onto the
    // performance budget. Lumping them together is what silenced them —
    // a roll used to cost the same 120s cooldown as an airhorn.
    SYSTEM_PROMPT.includes("Counts toward the PERFORMANCE cadence budget, not the rare-stinger cap")
);
assertOk(
  "SYSTEM_PROMPT: loop-blend suspension rule pinned (loop_blend, phrase-snapped capture, ducks/fades/exits on the 1)",
  SYSTEM_PROMPT.includes('Loop-tension blend ("loop_blend"') &&
    SYSTEM_PROMPT.includes("the suspension tool") &&
    SYSTEM_PROMPT.includes('captures a clean 4-bar loop of the outgoing track right at the phrase boundary') &&
    SYSTEM_PROMPT.includes('lands the incoming track at full on the next "1"')
);
assertOk(
  "SYSTEM_PROMPT: loop-blend vocal-map interaction pinned (never loop a vocal-active region, prefer echo_out when no gap)",
  SYSTEM_PROMPT.includes("never intentionally loop a vocal-active region") &&
    SYSTEM_PROMPT.includes("prefer \"echo_out\" instead")
);
assertOk(
  "SYSTEM_PROMPT: partner-dance default remains, with explicit owner loop/blend override",
  SYSTEM_PROMPT.includes("In salsa/bachata, use only when the owner explicitly requests loops or blending") &&
    SYSTEM_PROMPT.includes("no loop_blend either") &&
    SYSTEM_PROMPT.includes("this lane's clean-ending rule has no blend exceptions")
);
assertOk(
  "SYSTEM_PROMPT: loop-blend no-grid engine fallback disclosed (falls back to bass_swap/cut on its own)",
  SYSTEM_PROMPT.includes("the engine falls back to \"bass_swap\" or \"cut\" on its own")
);
assertOk(
  "SYSTEM_PROMPT: sample_mix routine pinned (sample a beat/melody and mix next track under it)",
  SYSTEM_PROMPT.includes('action "routine", routine "sample_mix"') &&
    SYSTEM_PROMPT.includes("grab a beat or melody from the live track") &&
    SYSTEM_PROMPT.includes("loop it alone, mix the next track underneath it") &&
    SYSTEM_PROMPT.includes('"routine":"sample_mix"')
);
assertOk(
  "SYSTEM_PROMPT: echo_out realness pinned (a real ringing delay tail, not a fade)",
  SYSTEM_PROMPT.includes('"echo_out" is a REAL tempo-synced delay tail (not a fade)') &&
    SYSTEM_PROMPT.includes("rings for a few real repeats after the dry signal cuts")
);
assertOk(
  "SYSTEM_PROMPT: dry/wet send cap disclosed (engine-capped, not brain-controlled)",
  SYSTEM_PROMPT.includes("Every send (echo wet, reverb wet) is capped well under the dry signal by the engine itself")
);
assertOk(
  "SYSTEM_PROMPT: filter-sweep usage pinned (space_sweep maskFx, genre-gated like any maskFx choice)",
  SYSTEM_PROMPT.includes('maskFx "space_sweep" is the one non-stinger option') &&
    SYSTEM_PROMPT.includes("HPF filter sweep + a real echo tail + a reverb wash directly on the outgoing deck") &&
    SYSTEM_PROMPT.includes("genre-gated the same as any other maskFx choice")
);
assertOk(
  "SYSTEM_PROMPT: compact-crate field mapping mentions firstVocalSeconds and Camelot-notation k",
  SYSTEM_PROMPT.includes("firstVocalSeconds is how many seconds into the track its vocal first starts") &&
    SYSTEM_PROMPT.includes('k is Camelot notation, e.g. "8A"')
);

// --- buildCompactCrateEntry (craft pass #2): firstVocalSeconds, the 6th
// optional param — omitted when null/unknown, rounded when present. ---
{
  const withVocal = buildCompactCrateEntry(7, "Track With Vocal Map", 120, "8A", true, 12.6);
  assertOk("buildCompactCrateEntry: firstVocalSeconds present and rounded to a whole second", withVocal.firstVocalSeconds === 13);
}
{
  const noVocalArg = buildCompactCrateEntry(8, "Track No Sixth Arg", 120, "8A", true);
  assertOk("buildCompactCrateEntry: firstVocalSeconds omitted when the 6th arg is left off (defaults null)", !("firstVocalSeconds" in noVocalArg));
}
{
  const explicitNull = buildCompactCrateEntry(9, "Track Explicit Null", null, null, false, null);
  assertOk("buildCompactCrateEntry: firstVocalSeconds omitted when explicitly null", !("firstVocalSeconds" in explicitNull));
}

// --- buildRequestBlocks round-trips (craft pass #2): DjLiveState's new
// vocalActiveNow/nextVocalGap/vocalEndsAt fields and DjState's new
// partyElapsedSeconds/partyPlannedSeconds fields, including the
// omitted/null cases. ---
{
  const vocalLiveState = {
    ...sampleState,
    live: {
      ...sampleState.live,
      durationSeconds: 200,
      playedSeconds: 10,
      mixOutSeconds: null,
      vocalActiveNow: true,
      nextVocalGap: { start: 120, end: 140 },
      vocalEndsAt: 45.5,
    },
  };
  const stateWithParty = { ...vocalLiveState, partyElapsedSeconds: 1834.2, partyPlannedSeconds: 7200 };
  const blocks = buildRequestBlocks({
    message: null,
    state: stateWithParty,
    crate: sampleCrate,
    crateCacheable: true,
    lessons: [],
    ledger: { global: [], perTrack: {} },
  });
  const parsed = JSON.parse(blocks[1].text);
  assertOk(
    "buildRequestBlocks: round-trips live.vocalActiveNow/nextVocalGap/vocalEndsAt",
    parsed.state.live.vocalActiveNow === true &&
      parsed.state.live.nextVocalGap.start === 120 &&
      parsed.state.live.nextVocalGap.end === 140 &&
      parsed.state.live.vocalEndsAt === 45.5
  );
  assertOk(
    "buildRequestBlocks: round-trips state.partyElapsedSeconds/partyPlannedSeconds",
    parsed.state.partyElapsedSeconds === 1834.2 && parsed.state.partyPlannedSeconds === 7200
  );
}
{
  // Choir round #2 (P1): live.transitionPending round-trips both true and
  // false — this is the brain's only signal that a queue command it
  // already issued is still resolving.
  const pendingState = { ...sampleState, live: { ...sampleState.live, transitionPending: true } };
  const blocks = buildRequestBlocks({
    message: null,
    state: pendingState,
    crate: [],
    crateCacheable: true,
    lessons: [],
    ledger: { global: [], perTrack: {} },
  });
  const parsed = JSON.parse(blocks[1].text);
  assertOk("buildRequestBlocks: round-trips live.transitionPending === true", parsed.state.live.transitionPending === true);
}
{
  const notPendingState = { ...sampleState, live: { ...sampleState.live, transitionPending: false } };
  const blocks = buildRequestBlocks({
    message: null,
    state: notPendingState,
    crate: [],
    crateCacheable: true,
    lessons: [],
    ledger: { global: [], perTrack: {} },
  });
  const parsed = JSON.parse(blocks[1].text);
  assertOk("buildRequestBlocks: round-trips live.transitionPending === false", parsed.state.live.transitionPending === false);
}
{
  // No vocal map for the live track -> the three vocal fields are OMITTED
  // (undefined), not sent as false/null — "unknown" must stay distinct from
  // "confirmed instrumental" (see brain.ts's DjLiveState doc comments).
  const noVocalMapState = { ...sampleState, partyElapsedSeconds: 0, partyPlannedSeconds: null };
  const blocks = buildRequestBlocks({
    message: null,
    state: noVocalMapState,
    crate: [],
    crateCacheable: true,
    lessons: [],
    ledger: { global: [], perTrack: {} },
  });
  const parsed = JSON.parse(blocks[1].text);
  assertOk(
    "buildRequestBlocks: no vocal map -> vocalActiveNow/nextVocalGap/vocalEndsAt all omitted (JSON.stringify drops undefined keys)",
    !("vocalActiveNow" in parsed.state.live) && !("nextVocalGap" in parsed.state.live) && !("vocalEndsAt" in parsed.state.live)
  );
  assertOk(
    "buildRequestBlocks: partyPlannedSeconds null (no length chosen) serializes as null, partyElapsedSeconds 0 before autopilot ever ran",
    parsed.state.partyPlannedSeconds === null && parsed.state.partyElapsedSeconds === 0
  );
}
{
  // Vocal map exists but nothing active right now, and no upcoming gap >=8s -> false/null, not omitted (a KNOWN fact, not "unknown").
  const knownInstrumentalState = {
    ...sampleState,
    live: { ...sampleState.live, vocalActiveNow: false, nextVocalGap: null, vocalEndsAt: null },
    partyElapsedSeconds: 60,
    partyPlannedSeconds: null,
  };
  const blocks = buildRequestBlocks({
    message: null,
    state: knownInstrumentalState,
    crate: [],
    crateCacheable: true,
    lessons: [],
    ledger: { global: [], perTrack: {} },
  });
  const parsed = JSON.parse(blocks[1].text);
  assertOk(
    "buildRequestBlocks: a known (not currently vocal-active, no upcoming gap) state serializes false/null, not omitted",
    parsed.state.live.vocalActiveNow === false && parsed.state.live.nextVocalGap === null && parsed.state.live.vocalEndsAt === null
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all route/brain building-block cases");
console.log(
  "\nNOTE: this checks the pure prompt/serialization logic only — it does not call the Anthropic API " +
    "(no key present in this environment; see VERIFY in the dispatch for the live dev-server 500-without-key check)."
);
