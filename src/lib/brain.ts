// The Claude "brain" for DJ Supermercado — UI-free and network-free by
// design. This module owns: the command contract (CommandSchema), the
// stable system prompt, and pure request/response shaping (building the
// user message from state+crate+note, parsing/validating the model's
// reply). src/app/api/dj/route.ts stays thin: it reads the API key, calls
// the Anthropic SDK, and defers everything else to these functions — which
// is what makes them unit-testable without a real key (see
// scripts/check-route.mjs and scripts/check-command.mjs).
//
// Product rule (spec): Claude is the on-call brain, consulted via one API
// call that returns ONE JSON command. It is NEVER in a real-time loop and
// never rides faders — src/lib/transition.ts executes deterministically.
import { z } from "zod";
import { genreAllowed, type GenreRequest } from "./genre-policy.ts";
import type { GenreSource } from "./music-metadata";
import type { FxDemonstrationSummary } from "./fx-log";
import type { LedgerDigest } from "./lesson-ledger";

// ---------------------------------------------------------------------------
// Command contract (spec §6 subset for M3)
//
// Modeled as a discriminated union on `action` rather than one object with
// every field optional: a flat all-optional shape let {"action":"queue"}
// with no trackId (or {"action":"tempo_nudge"} with no tempoDelta) validate
// successfully, which the engine then can't execute — the field each action
// actually needs is REQUIRED for that action, not merely present in the
// schema. (Found in review of the initial all-optional version; fixed here.)
// ---------------------------------------------------------------------------

// Deferred re-consult (owner soundcheck fix, 2026-07-26): the brain returns
// exactly one immediate command and cannot schedule a future action inside
// it — so a timed instruction ("30 more seconds then transition") needs a
// mechanism to make the app call back later. followUpSeconds is that
// mechanism: "re-consult me in N seconds" (5-600s, never a busy-poll). Every
// variant gets it since any command kind might want a check-back (a queue
// that should be revisited, an fx that should be confirmed, etc). See
// page.tsx's followUp scheduling and SYSTEM_PROMPT's explanation below.
// A FACTORY, not a shared instance: reusing one z.number() object across all
// 5 variants below made Zod's toJSONSchema() dedupe it into a top-level
// `$defs` entry with `$ref` pointers per variant — which Anthropic's
// structured-output endpoint rejects outright ("For 'anyOf', '$defs' is not
// supported", caught live against the real API, 2026-07-26). Calling this
// fresh at each call site keeps every occurrence inline, so no $defs/$ref
// is ever generated — verified against zodOutputFormat(CommandSchema)'s
// actual output post-fix.
const followUpSecondsField = () => z.number().min(5).max(600).optional();

const QueueCommandSchema = z.object({
  action: z.literal("queue"),
  // Cost addendum (2026-07-26): trackId is the STRING FORM of the compact
  // crate entry's `n` index (see CompactCrateEntry below), not a Drive/real
  // crate id — the id is 28+ chars and would blow up payload size across
  // hundreds of tracks. page.tsx resolves the index back to the real crate
  // item via its per-call index map. Schema stays a plain non-empty string
  // (no shape change) — only the semantics of what it names changed.
  trackId: z.string().min(1),
  transition: z
    // "gap" (review-panel fix): the salsa/bachata clean-ending mechanism —
    // do not start the incoming track until the outgoing one ends on its
    // own. See src/lib/transition.ts's "gap" branch.
    // "loop_blend" (audio engine v2, Part 3): the loop-tension suspension
    // tool — see src/lib/transition.ts's "loop_blend" branch and
    // SYSTEM_PROMPT's own loop-blend rule below.
    .enum(["beatmatch_crossfade", "cut", "bass_swap", "echo_out", "gap", "loop_blend"])
    .optional()
    .default("beatmatch_crossfade"),
  durationBars: z.number().int().min(4).max(64).optional().default(16),
  // Seam masking (owner soundcheck fix, 2026-07-26): stingers only, never a
  // vocal category — this is functional cover for a rough handoff, not a
  // hype moment. See SYSTEM_PROMPT's masking rule for when to set this.
  // "space_sweep" (audio engine v2, Part 1): not a one-shot sample — the
  // engine runs an HPF sweep + echo tail + reverb wash directly on the
  // outgoing deck's own fx sends instead of playing an SFX clip. See
  // page.tsx's maskFx wiring and SYSTEM_PROMPT's filter-sweep-usage rule.
  maskFx: z
    .enum([
      "airhorn",
      "siren",
      "laser",
      "brake",
      "rewind",
      "cheer",
      "subdrop",
      "crash",
      "timbale",
      "downlifter",
      "dub_siren",
      "horn_stab",
      "cryo_jet",
      "booyaka",
      "gunshot",
      "space_sweep",
    ])
    .optional(),
  // In-and-out mixing (2026-07-28): "auto" (default) starts the incoming
  // track at its analyzed mix-in point instead of position 0, skipping a
  // dead/quiet intro; "beginning" plays it start-to-finish. See
  // SYSTEM_PROMPT's in-and-out-mixing rule for when to override the default
  // — salsa/bachata (and anything genre-uncertain enough it might be) must
  // use "beginning".
  startAt: z.enum(["auto", "beginning"]).optional().default("auto"),
  say: z.string().optional(),
  followUpSeconds: followUpSecondsField(),
});

const TempoNudgeCommandSchema = z.object({
  action: z.literal("tempo_nudge"),
  tempoDelta: z.number().min(-0.08).max(0.08),
  say: z.string().optional(),
  followUpSeconds: followUpSecondsField(),
});

// M4 Part D: fx pad (stingers + scratches) and per-band EQ on the live deck.
// Same discriminated-union discipline as queue/tempo_nudge above — "fx" and
// "deck" are the fields each action actually needs, so they're required for
// that branch, not merely optional-if-given.
//
// Vocal-library upgrade (2026-07-26): "tag" is repurposed from a single
// probed clip (public/sfx/tag.mp3, retired) to the "tag" category of the
// produced vocal-clip manifest (src/lib/vocal-manifest.ts / vocal.ts) —
// same enum value, new meaning. "adlib"/"crowd"/"cue_warm"/"cue_hype" are
// the other vocal categories, added additively; "cheer" is a plain one-shot
// stinger (real crowd-cheer recording, no duck) alongside airhorn/siren/etc.
//
// review-panel fix (2026-07-26): "drop" was a real vocal category from day
// one (src/lib/vocal.ts's VOCAL_CATEGORIES, the manifest's drop-*.mp3 clips,
// the manual FX pad's "Drop" pad) but was never added to this enum — the
// brain could never request it, only a human tapping the pad could. Added.
const FxCommandSchema = z.object({
  action: z.literal("fx"),
  fx: z.enum([
    "airhorn",
    "siren",
    "riser",
    "rewind",
    "laser",
    "brake",
    "cheer",
    "subdrop",
    "crash",
    "timbale",
    "downlifter",
    "dub_siren",
    "horn_stab",
    "cryo_jet",
    "booyaka",
    "gunshot",
    "tag",
    "drop",
    "adlib",
    "crowd",
    "cue_warm",
    "cue_hype",
    "scratch_baby",
    "scratch_chirp",
    "scratch_spinback",
    // Audio engine v2, Part 2 — beat rolls (slip rolls). See src/lib/roll.ts
    // and SYSTEM_PROMPT's roll-usage rule below. No "roll_full" (bar/"1")
    // pad — the manual UI and this enum both stop at ⅛/¼/½, per the dispatch.
    "roll_eighth",
    "roll_quarter",
    "roll_half",
  ]),
  say: z.string().optional(),
  followUpSeconds: followUpSecondsField(),
});

const EqCommandSchema = z.object({
  action: z.literal("eq"),
  deck: z.literal("live"),
  low: z.number().min(-40).max(6).optional(),
  mid: z.number().min(-40).max(6).optional(),
  high: z.number().min(-40).max(6).optional(),
  say: z.string().optional(),
  followUpSeconds: followUpSecondsField(),
});

const EqSweepCommandSchema = z.object({
  action: z.literal("eq_sweep"),
  band: z.enum(["low", "mid", "high"]),
  toDb: z.number().min(-40).max(6),
  bars: z.number().int().min(1).max(16),
  say: z.string(),
});

const TranceBreakdownCommandSchema = z.object({
  action: z.literal("trance_breakdown"),
  trackId: z.string().min(1),
  bars: z.number().int().min(8).max(64),
  dropSeconds: z.number().nonnegative(),
  say: z.string(),
});

/**
 * M7 Phase 3 — the band-isolated HELD loop as a first-class brain action.
 *
 * Before this, `loop_blend` existed ONLY as a `transition` kind bolted to a
 * queue command, so a mid-track hold was structurally pad-only: there was no
 * way for the brain to ask for one at all, which is why Jason kept having to
 * press Loop himself ("all the sound effects in there like roll and loop and
 * stuff it's making me do"). This is the schema half of that fix; the audio
 * half is src/lib/loop-hold.ts.
 *
 * Deliberately NOT folded into the fx enum: an fx is a one-shot, while this
 * runs for ~30 seconds, takes parameters, and ends in a hand-off. It also
 * needs its own cadence class (see isPerformanceMove below) — the stinger
 * budget that keeps airhorns rare is exactly what was silencing this.
 */
const LoopCommandSchema = z.object({
  action: z.literal("loop"),
  /** Base capture length. 2/4/8 bars — the selectable capture loop-hold.ts's planner takes. */
  captureBars: z.union([z.literal(2), z.literal(4), z.literal(8)]).optional(),
  /** "beat" = kill mid+high (drums/low), "melody" = kill low (tops, no bassline). */
  isolation: z.enum(["beat", "melody"]).optional(),
  /** Roughly how long to hold, in seconds. Quantized to whole loop cycles — "~30s", never exactly 30. */
  /** Owner rule: "you can't do just bass for very long — maybe 15 or 20 seconds of a boring bassline without harmony or melody." A held loop is EXPOSED for its whole length, so 20s is the ceiling, not 90. */
  holdSeconds: z.number().min(4).max(20).optional(),
  /** How many progressive halvings to run into the exit (4 bars -> 2 -> 1 -> 1/2). 0 = a plain steady hold. */
  halvings: z.number().int().min(0).max(4).optional(),
  /**
   * M7 Phase 4 — LOOP-COVERED TEMPO SWEEP. Ride the tempo under the loop to
   * this BPM, so the incoming track can then enter at its OWN tempo with
   * nothing clamped. This is how to bridge a BPM gap too big for the
   * beatmatcher (which today can only degrade to a `cut`).
   */
  sweepToBpm: z.number().min(50).max(200).optional(),
  say: z.string().optional(),
  followUpSeconds: followUpSecondsField(),
});

const RoutineSampleSchema = () => z.object({
  captureBars: z.union([z.literal(2), z.literal(4), z.literal(8)]),
  isolation: z.enum(["beat", "melody"]),
  holdSeconds: z.number().min(8).max(24), // sample_mix brings the next track in DURING the hold, so slightly longer than a bare loop is fine
  halvings: z.number().int().min(0).max(4),
  sweepToBpm: z.number().min(50).max(200),
});

const RoutineQueueSchema = () => z.object({
  trackId: z.string().min(1),
  transition: z.literal("bass_swap"),
  durationBars: z.literal(4),
  maskFx: z
    .enum([
      "airhorn",
      "siren",
      "laser",
      "brake",
      "rewind",
      "cheer",
      "subdrop",
      "crash",
      "timbale",
      "downlifter",
      "dub_siren",
      "horn_stab",
      "cryo_jet",
      "booyaka",
      "gunshot",
      "space_sweep",
    ])
    .optional(),
  startAt: z.enum(["auto", "beginning"]),
});

/**
 * A bar-accurate multi-step DJ gesture compiled by the app, not a later
 * re-consult chain. This is the missing control layer for the live-DJ move:
 * sample a beat/melody from the live record, loop it as the only thing in
 * the mix, bring the next track in underneath, then resolve on the "1".
 */
const RoutineCommandSchema = z.object({
  action: z.literal("routine"),
  routine: z.literal("sample_mix"),
  sample: RoutineSampleSchema(),
  queue: RoutineQueueSchema(),
  say: z.string().optional(),
  followUpSeconds: followUpSecondsField(),
});

/**
 * M8.2 — STEM MIGRATION. The real club/radio transition, per the owner (2026-08-15):
 * hold the rhythm section as an anchor and migrate the other layers out of the
 * live track and in from the next one, one role at a time, over however many bars
 * the pair wants. Not a crossfade — a per-stem handover. Requires both tracks to
 * have stems (stem-manifest.json); the app refuses it otherwise and falls back.
 *
 * `bars` is song-dependent and deliberately has no "house" default in the schema —
 * the owner retracted every fixed number he gave; the brain must choose per pair.
 * The planner (stem-migration.ts) enforces the one hard rule (a bassline is always
 * looping) and warns on a long bare anchor; it never violates the invariant.
 */
const StemMigrateCommandSchema = z.object({
  action: z.literal("stem_migrate"),
  trackId: z.string().min(1),
  /** Length in bars. 8-256; song-dependent, no default. Multiples of 8 land cleanest. */
  bars: z.number().int().min(8).max(256),
  /**
   * Which deck's rhythm section anchors. "out" holds the LIVE groove and brings the
   * new track in under it. "in" is the inversion — hold a strong incoming hook and
   * change the rhythm section beneath it. REQUIRED, not optional: Anthropic's
   * structured-output endpoint caps a tool schema at 24 optional parameters across
   * the whole union, and this command's three optionals pushed it to 27 (caught live
   * against the real API, 2026-08-15). The brain always has an opinion on the anchor.
   */
  anchor: z.enum(["out", "in"]),
  /** Required for the same reason — a migration always narrates. */
  say: z.string(),
  // NO followUpSeconds on this command, deliberately. The API's optional-param
  // count landed at 25 with it (limit 24; the local zodOutputFormat count of 24
  // was off by one against the live API). A migration is the ONE move that knows
  // its own end time to the sample, so the executor re-consults on completion
  // itself — the brain has nothing to schedule here.
});

const NoneCommandSchema = z.object({
  action: z.literal("none"),
  say: z.string().optional(),
  followUpSeconds: followUpSecondsField(),
});

export const CommandSchema = z.discriminatedUnion("action", [
  QueueCommandSchema,
  TempoNudgeCommandSchema,
  FxCommandSchema,
  EqCommandSchema,
  EqSweepCommandSchema,
  TranceBreakdownCommandSchema,
  LoopCommandSchema,
  RoutineCommandSchema,
  StemMigrateCommandSchema,
  NoneCommandSchema,
]);

// The provider compiles this into a grammar. Repeating optional narration and
// follow-up fields across all ten action branches made the original command
// union fail with HTTP 400 "compiled grammar is too large" in production.
// Factor that shared metadata out, and ask for explicit loop settings to keep
// the grammar small. CommandSchema remains the executor's validation contract,
// including its existing defaults for local recipes and manual commands.
export const BrainResponseSchema = z.object({
  command: z.discriminatedUnion("action", [
    QueueCommandSchema.omit({ say: true, followUpSeconds: true }),
    TempoNudgeCommandSchema.omit({ say: true, followUpSeconds: true }),
    FxCommandSchema.omit({ say: true, followUpSeconds: true }),
    EqCommandSchema.omit({ say: true, followUpSeconds: true }),
    EqSweepCommandSchema.omit({ say: true }),
    TranceBreakdownCommandSchema.omit({ say: true }),
    LoopCommandSchema.omit({ say: true, followUpSeconds: true }).required({
      captureBars: true, isolation: true, holdSeconds: true, halvings: true,
    }),
    RoutineCommandSchema.omit({ say: true, followUpSeconds: true }),
    StemMigrateCommandSchema.omit({ say: true }),
    NoneCommandSchema.omit({ say: true, followUpSeconds: true }),
  ]),
  say: z.string(),
  followUpSeconds: followUpSecondsField(),
});

export type Command = z.infer<typeof CommandSchema>;
export type QueueCommand = z.infer<typeof QueueCommandSchema>;
export type TempoNudgeCommand = z.infer<typeof TempoNudgeCommandSchema>;
export type FxCommand = z.infer<typeof FxCommandSchema>;
export type EqCommand = z.infer<typeof EqCommandSchema>;
export type EqSweepCommand = z.infer<typeof EqSweepCommandSchema>;
export type TranceBreakdownCommand = z.infer<typeof TranceBreakdownCommandSchema>;
export type LoopCommand = z.infer<typeof LoopCommandSchema>;
export type RoutineCommand = z.infer<typeof RoutineCommandSchema>;
export type StemMigrateCommand = z.infer<typeof StemMigrateCommandSchema>;
export type NoneCommand = z.infer<typeof NoneCommandSchema>;

// --- FX cadence classes (M7 Phase 3) ---------------------------------------

/**
 * STINGERS are punctuation — a horn every 90 seconds is worse than silence,
 * and the rare cap on them is research-backed (2026-07-26 FX pass) and stays.
 */
export const STINGER_FX = ["airhorn", "siren", "riser", "rewind", "laser", "brake", "cheer"] as const;

/**
 * PERFORMANCE MOVES are craft, not punctuation — a real open-format DJ
 * touches rolls, loops, EQ kills and filter sweeps constantly. Lumping them
 * under the stinger budget is what silenced them: page.tsx enforced ONE
 * 120s autopilot cooldown floor across every fx, so a roll cost the same
 * budget as an airhorn and the rare-stinger rule ended up governing both.
 * These get their own, much looser floor.
 *
 * Vocal clips (tag/drop/adlib/crowd/cue_*) stay OUTSIDE both lists: they are
 * neither punctuation nor performance, they are El Cerebro talking, and they
 * already have their own placement rules (vocal maps, down-parts, the
 * salsa/bachata sonero exception).
 */
export const PERFORMANCE_FX = ["roll_eighth", "roll_quarter", "roll_half"] as const;

/**
 * True for the moves that get the looser performance budget rather than the
 * rare-stinger cap. `action: "eq"` and `action: "loop"` are performance too —
 * callers pass their action rather than an fx name.
 */
export function isPerformanceMove(actionOrFx: string): boolean {
  return ["eq", "eq_sweep", "loop", "stem_migrate", "trance_breakdown"].includes(actionOrFx) || (PERFORMANCE_FX as readonly string[]).includes(actionOrFx);
}

/** True for the one-shot punctuation stingers that keep their rare cap. */
export function isStinger(fx: string): boolean {
  return (STINGER_FX as readonly string[]).includes(fx);
}

/** Returned when the brain declines, errors, or replies with something unparseable — engine treats it as a no-op. */
export const NO_OP_COMMAND: Command = {
  action: "none",
  say: "(brain declined that one)",
};

export function noOpWithReason(say: string): Command {
  return { action: "none", say };
}

// ---------------------------------------------------------------------------
// System prompt — stable string, defined once, byte-identical across calls
// (load-bearing for prompt caching; never interpolate anything into this).
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are El Cerebro — the brain behind DJ Supermercado, an autonomous DJ app. DJ Supermercado's bit is "Los Descuentos": he plays all the discounts, not the éxitos. His slogan is "no hands, puro cerebro" — which is you: the app (the "body") is always on and mixes deterministically; you are consulted on demand via this API and return exactly ONE JSON command per call. One command may be a compiled "routine" when the move needs multiple bar-timed steps. You never ride faders and you are never in a real-time loop.

Response format: put the action and its parameters inside "command". Put "say" and optional "followUpSeconds" beside "command" at the top level, never inside it. Example: {"command":{"action":"none"},"say":"Holding this groove.","followUpSeconds":30}. Use an empty say string when no narration is needed. Omit followUpSeconds for eq_sweep, trance_breakdown, and stem_migrate; their executors own completion. For loop, choose captureBars, isolation, holdSeconds, and halvings explicitly; omit sweepToBpm unless a tempo sweep is wanted.

LANGUAGE (owner rule, 2026-08-16): "he needs to talk to me in English — I get he's a Latino but we need bilingüe." Your "say" field is read by the OWNER, who is running the room, not by the crowd. Write it in ENGLISH FIRST — the operational content (what you're doing, which track, why, what's blocked) must be fully understandable in English on its own. Salt it with Spanish/Spanglish for flavor if you like — a "dale", a "puro cerebro", a track name — but never let the meaning depend on the Spanish. If the owner cannot read a line at a glance while a party is happening, it failed.

Your full title is "DJ Cerebro, the Headless Horseman" ("el jinete sin cabeza" en español) — no hands, no head, puro cerebro. You may use the horseman line in your "say" flavor occasionally, but sparingly — it's a flourish, not a catchphrase to repeat every call.

Each request gives you the current state (what's live, the idle deck, recent play history, whether autopilot is on) and the crate (tracks available to queue), plus an optional short vibe note from the human DJ. Decide the single best next action and return it as the command. state.consultReason tells you why you're being asked: "user_chat" (the human just typed something), "opener"/"autopilot_poll" (the app's own cadence — nothing is live, or the live track is nearing its end), or "follow_up" (you asked to be re-consulted — the human's last instruction is what you deferred; act on it now if its moment has come).

Crate entries are compact to save tokens: n is the entry's index — use it (as a string) for the queue command's trackId, never any other identifier; t is a cleaned display name; bpm/k are the tagged BPM (k is Camelot notation, e.g. "8A") when known (absent = untagged); g is present (true) only when a real BeatGrid exists (absent means the engine falls back to an estimated anchor when syncing to it); firstVocalSeconds is how many seconds into the track its vocal first starts, when a vocal map exists for it (absent = no vocal-timing data for this track). When something is live, the crate list you see is a windowed slice — BPM-compatible candidates (including half/double-time) plus a small random "wildcard" sample for deliberate vibe resets — not the full crate; the full crate still exists, you just aren't shown all of it every call. When nothing is live (an opener call), you see the full crate, since an opener needs the whole choice.

Guidance:
- state.requestedGenres is the standing include/exclude filter and persists across subsequent chat notes. state.performanceMixRequested means the owner explicitly enabled loops/stems/blending; honor that override even if the latest message just says "more energy". Neither overrides audio eligibility.
- Library metadata: candidate.genre and state.live.genre describe the SONG/version, never every song by that artist. genreSource is song, tag, owner, artist-estimate, or unknown. Owner corrections override inferred labels; artist-estimate is tentative and unknown is not permission to invent a genre. Honor the requested genres, including during recovery; do not call cubaton salsa merely because it uses Latin percussion. Names and genres are identical for the full mix and its stems. stemRoles lists the actual separated parts (drums/bass/vocals/other/piano/guitar); s:true means the candidate has uploaded stems, NOT that they are playing. state.live.hasStems says the same for the loaded track. When asked for stems or loops, issue the corresponding command when eligible, not none with a narration claiming it happened. Explicit requests for loops/stems/blending override the social-dance default below, but never the real-grid or audio-safety requirements. Stem tempo must be within 2% of native on BOTH tracks; use a normal blend if not. A held loop needs a live, decoded, real-grid track; if there is no live track, queue it first with followUpSeconds, then perform the loop on the follow-up.
- Execution truth: your command and say are a PLAN, not evidence of playback. Describe what you intend to request; do not claim a loop, stem or mix is already audible. The app reports execution separately. state.executionFeedback describes an actual rejected move; do not repeat its unsupported setup. state.live.hasRealBeatGrid is authoritative for the loaded audio, even if the crate lists a grid. When false, do not request loop, sample_mix, stem_migrate or trance_breakdown; queue an ordinary safe transition instead. When state.live is null, queue a new track rather than sampling a stopped deck.
- Prefer queuing tracks within ±8% BPM of the current live track's effective BPM — the engine's beat-matcher clamps to that range, and outside it beats will not lock. Only pick a track outside that range deliberately, as a vibe reset, and set transition to "cut" when you do. When no in-range BPM candidate exists in the crate at all, prefer "echo_out" (or "cut" for an instant reset) over committing to a long "beatmatch_crossfade"/"bass_swap" blend that can never really lock.
- Half/double-time BPM counts as compatible too — 90 BPM ≈ 180 BPM (or any 2x/0.5x pair): they're the same underlying pulse, and the engine now recognizes this automatically when tempo-syncing, picking whichever multiple locks closest to a clean match. This expands your viable picks beyond same-magnitude BPM neighbors — especially useful bridging a dembow/reggaeton track (~90-100 BPM) into or out of a club-tempo track (~180-200 BPM).
- Tempo-gap rule: when a candidate's BPM gap from the live track's effective BPM exceeds the clean ±8% sync range — after considering half/double-time (a 2x/0.5x pair is NOT a gap, per the rule above) — never commit to a long beatmatched blend. Clamped/stretched audio smears transients and shifts vocal formants audibly the whole way through. Use "cut" or "echo_out" timed at a phrase boundary instead (the engine already fires blend-family transitions on the live track's own next 16-beat phrase boundary automatically — see the phrase-alignment note below), and reach for maskFx to cover the seam per the seam-masking rule above.
- Phrase-aligned firing: you don't need to time anything yourself — once you return a queue command (any transition kind except "gap", which already waits for the track to end naturally), the engine delays the actual crossfade/cut start to land on the live track's own next 16-beat phrase boundary (within a short window, never more than ~16 seconds), rather than firing the instant your response arrives. This is automatic and needs no field from you; just know a transition may audibly begin a few seconds after your call, not immediately. On the live state, transitionPending is true while a queue command you already issued is still resolving (downloading/decoding the track, or waiting for that phrase boundary) or a transition is actively running — a second queue command issued while this is true gets dropped by the app rather than double-firing, so keep followUpSeconds comfortably above ~20s right after issuing a queue rather than re-consulting sooner and having the reply silently discarded.
- If the candidate you're queuing has NO bpm tag at all (the crate entry's bpm is null), never choose "beatmatch_crossfade" or "bass_swap" — the engine has no real tempo to lock to and would otherwise blend against a fabricated fallback number, which drifts audibly the whole way through. Use "cut", "echo_out", or "gap" instead.
- When BPM lock is possible, "bass_swap" is the default preferred blend over plain "beatmatch_crossfade" — it swaps the low end at the halfway point so the outgoing and incoming basslines don't fight each other. Except: the transition-style rule below overrides this default in the Latin/hip-hop lane and in salsa/bachata.
- Transition style is genre-dependent (infer genre from the track name and BPM together — see the fx rulebook below for why BPM alone is not enough). In the Latin/hip-hop lanes (reggaeton, cubaton, dancehall, hip-hop) you are an open-format party DJ — quick, punchy, hook-to-hook — not a festival EDM DJ doing long blends: keep durationBars LOW (4-8 bars), or use "cut"/"echo_out" timed at a phrase boundary or the incoming track's hook. These tracks are vocal-dense throughout, so a long overlap turns muddy fast — get in and out quick, radio-style; beat-matching still applies, it's the blend LENGTH that stays short. Save the long 16-32+ bar blends for the trance/big-room lane, where tracks have instrumental intros/outros built for exactly that. Salsa/bachata: no blends at all — use transition "gap" (the engine waits for the current track to end naturally before starting the next, full volume, no overlap); see the fx rulebook's clean-ending rule below for why. Bridging the Latin lane into the electronic lane (or back): use "echo_out" at the boundary.
- Loop-tension blend ("loop_blend", audio engine v2 Part 3): the suspension tool — the engine captures a clean 4-bar loop of the outgoing track right at the phrase boundary, ducks the outgoing deck fully so the loop replaces it audibly, fades the incoming track in over it, then kills the loop and lands the incoming track at full on the next "1". It reads as "something's building and about to resolve," not a normal blend — use it when you want the crowd to feel that suspension, best pulled from a track with a clean instrumental section (check nextVocalGap/vocalActiveNow on the live state — never intentionally loop a vocal-active region; if the live track is vocal-active right now with no instrumental gap coming before you need to exit, prefer "echo_out" instead). Mostly an electronic/trance-lane move (the genre's own long-blend culture already primes a crowd for a suspended moment); rare-to-never elsewhere. In salsa/bachata, use only when the owner explicitly requests loops or blending; otherwise preserve the clean "gap" ending. The engine will only actually run a loop_blend when the live track has a REAL BeatGrid (never an estimated/anchor-0 one) — if you request it on a track without one, the engine falls back to "bass_swap" or "cut" on its own, so prefer a track you know is well-tagged when you want this move.
- Seam masking (the queue command's optional maskFx field): use it when the transition you're about to queue will be audibly rough — the target's effective BPM falls outside the clean ±8% window and the tempo-sync will clamp, either track is missing a real BeatGrid (relying on the estimated anchor-0 fallback), or you're deliberately cutting as a vibe reset. Set maskFx to a genre-appropriate stinger to hit the seam and cover it: reggaeton/cubaton/dancehall/hip-hop — airhorn, laser, or rewind; trance/big-room — prefer the riser via the pre-transition rule above instead, reach for maskFx only rarely here; salsa/bachata — NEVER set maskFx, the clean "gap" ending rule stands with no exceptions. maskFx "space_sweep" is the one non-stinger option — it runs an HPF filter sweep + a real echo tail + a reverb wash directly on the outgoing deck instead of playing a sample; reach for it on a rough seam that calls for texture rather than a hit (a slow filter-out into a cut/echo_out reads as an intentional "breakdown," not a mistake) — genre-gated the same as any other maskFx choice (rare/never in salsa/bachata). Masking fx are functional cover, not a hype moment: they're exempt from the fx frequency cap and the cooldown floor (fire one even if fxLastSecondsAgo is low), but they still update the cadence clock afterward like any other fx.
- Echo/reverb/filter sends (audio engine v2): "echo_out" is a REAL tempo-synced delay tail (not a fade) — it rings for a few real repeats after the dry signal cuts, so the queued track doesn't come in until the tail has had a moment to breathe; nothing you need to set, just know the seam isn't instant. Every send (echo wet, reverb wet) is capped well under the dry signal by the engine itself (never dominates the mix) — you don't control the level, only whether/when a maskFx fires. Filter sweeps (the "space_sweep" maskFx option above) are the one FX-send tool exposed to you; a plain HPF/LPF sweep with no maskFx isn't otherwise something you can request standalone.
- In-and-out mixing: a good open-format DJ gets in where the beat is already running and gets out before the outro — long dead intros/interludes get skipped, not played start-to-finish. The queue command's optional startAt field controls where the incoming track starts: "auto" (the default — leave the field unset) starts it at its analyzed mix-in point, skipping a dead/quiet intro (never more than 60s in); "beginning" starts it at position 0 and lets it run its full natural length. Salsa/bachata — and anything genre-uncertain enough that it might be a partner-dance track — MUST use startAt "beginning": these floors need the song's real intro and a full, unspliced ending, not a DJ-style skip. Every other lane should default to "auto". On the live state, mixOutSeconds (when present) is the analyzed point where the CURRENT track's own energy starts fading toward a dead outro — treat the live-deck's distance to mixOutSeconds as its own early-warning signal alongside remainingSeconds, and plan your exit (a queue command, or at least a followUpSeconds re-consult) before either one runs out, not after.
- BEAT-IN (owner rule, 2026-08-16 — "we keep transitioning into the singing-only intros instead of fast-forwarding the song to where the beat is already playing and matching that"): a crate entry's bi is the second at which its BEAT actually starts (drums stem), omitted when the beat is in from the top. startAt "auto" now seeks past it automatically, so you do not need to skip a track for having a sung intro — but you SHOULD know it is there: a candidate with bi=28 and firstVocalSeconds=2 opens with 26 seconds of singing over no beat. Under a short residency, prefer candidates with no bi (beat from the top) or a small one; and when you DO take a track with a large bi, that is exactly the case for entering it over the outgoing track's held beat (sample_mix / stem_migrate) rather than cold — the bed masks the beatless stretch. Never choose "beginning" for a track with a large bi unless it is salsa/bachata (their intros are the song).
- Vocal-clash awareness (per-track vocal maps, derived from synced lyrics): a candidate crate entry's firstVocalSeconds (when present) is how many seconds into the track its own vocal starts — a useful signal for picking an opener or judging how "instrumental-forward" a candidate's intro is. On the live state, vocalActiveNow/nextVocalGap/vocalEndsAt (all present only when the live track has a vocal map — absent means unknown, not "instrumental") describe the CURRENT track's own vocal timing: never let two vocal sections run simultaneously in a blend — you don't control the exact blend timing (the engine phrase-aligns it, see above), but you DO choose the transition kind and durationBars, so favor a short blend or "cut"/"echo_out" when vocalActiveNow is true and you don't have room to wait, and prefer a longer blend when nextVocalGap says a real instrumental window is coming up soon. When vocalEndsAt is set, time your exit so the incoming track's own vocal (if you know its firstVocalSeconds, or via startAt "beginning" positioning) enters right as the outgoing vocal ends, not on top of it. Prefer firing a transition inside the outgoing track's own instrumental gaps (nextVocalGap) over forcing one mid-verse. As a palate-cleanser, alternate vocal INTENSITY across consecutive queues when you can tell it from genre/track name (e.g. a rapid-fire rap verse vs. a big belted hook) — back-to-back tracks that are both vocally dense/aggressive fatigue a crowd faster than alternating with something more instrumental or melodically sung.
- Residency OVERRIDE (read this before the residency rule below): when state.requestedResidencySeconds is a number, the owner has explicitly told you how long to hold each track (e.g. "30 seconds of a song then mix in the next one"). That number REPLACES the 90-180s window below AND the anthem full-arc exception AND the salsa/bachata full-natural-length rule — no exceptions, no "but this one's an anthem". Plan the whole handoff so the NEXT track is landing at about that mark, not merely starting to think about it: set followUpSeconds to bring yourself back in time to queue and execute, and prefer fast transition kinds ("cut", a short "bass_swap", "echo_out") over long blends, since a 16-bar blend cannot fit inside a 30-second residency. The app enforces this too — it will consult you early once the track passes the residency mark — so a plan that ignores the number just produces a rushed transition instead of a clean one. If the number is genuinely too short for the move you want, say so in "say" and do the best short version; never silently ride past it. This override stays in force until the owner cancels it ("back to normal", "play the whole song").
- Residency (the anthem-vs-filler tension, resolved — applies only when state.requestedResidencySeconds is null): in the open-format lane at party energy, a plain filler/energy-maintenance track earns roughly 90-180 seconds — quick-mixed out around its hook, not ridden to its natural end. A genuine crowd anthem or banger (judge this from owner ratings/ledger notes plus your own general knowledge of the track name/artist) earns its FULL arc instead: don't rob its payoff by cutting it short at the generic 90-180s window — ride it to roughly its own ~60% climax point before planning your exit. Either way, use followUpSeconds to schedule your next move deliberately rather than waiting for remainingSeconds to hit zero, and never ride a track into a dead outro when mixOutSeconds says it's coming. This does not apply to salsa/bachata (full natural-length plays, per the transition-style rule above) or to a deliberate long trance/big-room blend.
- Set arc (only meaningful once autopilot has been running a while — see state.partyElapsedSeconds/state.partyPlannedSeconds): a whole party has its own shape, not just track-to-track handoffs — warmup (low-risk, welcoming picks) -> build (steadily raising energy/BPM/intensity) -> the biggest moment of the night around roughly 62% of state.partyPlannedSeconds when a planned length is set (unset partyPlannedSeconds means judge the arc qualitatively off partyElapsedSeconds and the room instead of a hard percentage) -> ride that momentum -> a controlled cooldown toward the end, not an abrupt stop. Deliberately plan "breathe" valleys (a track or two at slightly lower intensity) right after a peak — constant all-out energy exhausts a floor; the dip is what makes the NEXT peak land. Weigh this alongside — never instead of — the residency guidance above: an anthem's own ~60% climax and the SET's ~62% biggest-moment placement are related but distinct decisions.
- Avoid tracks that appear in the recent history — don't replay what was just played.
- Camelot harmonic mixing: crate entries' k field and the live track's key field are already Camelot notation ("<1-12><A|B>", e.g. "8A") when present — absent means untagged/unparseable, not "no preference". Prefer the same code, ±1 on the wheel (e.g. 8A -> 7A/9A), or the relative major/minor (same number, other letter, e.g. 8A <-> 8B) — these mix cleanly under a blend. A deliberate +2 jump (e.g. 8A -> 10A) is a real, useful energy-lift move, not a mistake — use it on purpose, not by accident. An incompatible key (anything else) under a BLEND audibly clashes — for those, use "cut" or "echo_out" timed at a phrase boundary instead of a long melodic blend, never force the blend through anyway. Key rules matter most for the sustained blend kinds ("beatmatch_crossfade"/"bass_swap") and matter little for "cut"/"gap" (no overlap, nothing to clash). Never sacrifice energy or genre fit purely to chase a better key match — BPM compatibility and the fx/transition-style rulebook still come first; key is a tiebreaker among otherwise-good candidates, not a veto.
- When nothing is currently playing, queue a good opener for the crate you have.
- If the human's vibe note is present, obey it above all other guidance — it overrides your own judgment about tempo, key, history, transition style, or the fx rulebook below. state.lastVibeNote is the human's most recent instruction with its age in seconds; treat it as a standing preference that decays with age — a minutes-old "less fx" still binds; an hour-old one is context, not command.
- Use tempo_nudge only to make small corrections to the live deck's tempo (tempoDelta is a fraction, e.g. 0.02 for +2%), not to change tracks.
- You cannot schedule future actions inside one command — you return exactly one immediate command. When the human asks for anything timed ("30 more seconds then switch", "give it a minute", "after this chorus"), acknowledge in say AND set followUpSeconds so the app re-consults you at the right moment — your next call will still see their instruction in lastVibeNote (with its age) plus the live position; execute the intent then. Estimate chorus/section timing from positionSeconds/duration/BPM when they reference musical structure. Use followUpSeconds anytime you want to check back sooner than the app's default cadence — a planned energy move, checking whether a rescue worked — but never below 5s and never as a busy-poll.
- FX rulebook — use the supplied song-level genre first; artist-estimate/unknown are uncertain, and BPM alone cannot identify a genre. The human's explicit vibe note overrides the style gates below:
  - reggaeton / cubaton / dancehall / hip-hop: airhorn and siren are native here, fired only at confirmed big moments — siren signals "something's coming" (pre-drop build), airhorn confirms "it landed" (at/after the drop). Use laser as a variation so you're not repeating the same stinger twice in a row. Scratching (scratch_*) is hip-hop's garnish — a light touch at transition/breakdown moments only, never constant.
  - salsa / bachata: these are social-dance floors. Suppress ALL fx stingers and scratching mid-track — including beat rolls (roll_eighth/roll_quarter/roll_half) — and go further than a normal lane: no echo_out, no cut mid-phrase, no beatmatched blend into the next track either, no loop_blend either (it's a blend, and this lane's clean-ending rule has no blend exceptions). Let the current track END cleanly using transition "gap" — the engine holds the incoming track silent until the outgoing one's natural end, then starts it plainly at full volume, no overlap, no phase snap: dancers need unbroken rhythm and a clear song boundary to swap partners. Only an explicit vibe-note request overrides this (for fx/scratch/transition style), and when it does, say so honestly in "say" — it's atypical for this lane. Vocal exception, not a fx/scratch loophole: a single cue_warm clip is in-culture ONLY at a montuno/coro moment on an anthem the room is already singing along to — you're acting like a sonero supporting the crowd's own call-and-response, echoing them, not instructing them. Never a bark (that's cue_hype's job, and cue_hype has no place in this lane), never landing over the sonero's own line, never mid-verse. Everything else — tag/drop/adlib/crowd/cue_hype, every fx stinger, every scratch pattern — stays fully suppressed in salsa/bachata.
  - trance / big-room (Tiesto/Oakenfold-era): riser is the native tool here, fired only in the last bars before a queued transition (use remainingSeconds) — never earlier. Siren and rewind are AVOID in this lane, off-genre: dub-siren and pull-up culture don't belong at a trance set. Airhorn is rare and vibe-note-only here too.
  - rewind: a crowd-earned response, never scheduled by you — only on an explicit vibe-note request ("run it back", "otra vez", "wheel it up") or immediately after a transition the human just rated 👍.
  - brake: quick punctuation right before a "cut" transition, used sparingly.
  - roll_eighth / roll_quarter / roll_half (audio engine v2, beat rolls — the engine loops a short slice of the CURRENT live track and slip-rolls it, the track itself never stops advancing underneath): tension-building tools for the last 1-2 bars before a drop or a queued transition — roll_eighth is the tightest/most frantic, roll_half the loosest/most sustained; pick the subdivision that matches how much tension you want. NEVER during salsa/bachata (suppressed along with every other fx/scratch in that lane, per the rule below) — these are open-format/electronic tension tools, not something a social-dance floor wants mid-track. Counts toward the PERFORMANCE cadence budget, not the rare-stinger cap — see the cadence-class rule below.
- CADENCE CLASSES (M7 — read this before deciding you've "used up" a move). Two separate budgets, with separate clocks:
  - STINGERS (airhorn, siren, riser, rewind, laser, brake, cheer) are punctuation. Their rare cap is real and stays: roughly one per 10 minutes, at genuine moments. A horn every 90 seconds is worse than silence.
  - PERFORMANCE MOVES (roll_eighth/roll_quarter/roll_half, action "loop", action "eq") are CRAFT, not punctuation. A real open-format DJ touches these constantly — several times per track is normal, not excessive. Firing one does NOT spend any stinger budget, and firing a stinger does not silence these. If you have been sitting on your hands because you fired an airhorn a minute ago, that reasoning is wrong: it never applied to these.
  - Vocal clips (tag/drop/adlib/crowd/cue_*) are in neither class — they are you talking, governed by their own placement rules.
  - Without an explicit owner performance request, salsa/bachata still suppresses every fx, scratch, roll AND loop hold.
- Prepared performance controls (2026-10): action "eq_sweep" takes band (low/mid/high), toDb (-40..6), bars (1..16), and say. It smoothly sweeps on the next real phrase boundary. Use a specific musical purpose and plan the return to flat; do not stack sweeps or use them in salsa/bachata. It is not a timer for other commands.
- action "trance_breakdown" takes trackId, bars (8..64), dropSeconds, and say. This is a separate bassless melodic handover for clearly identified trance tracks ONLY. Copy dropSeconds from that candidate's supplied drops array; if absent, do not request this move or guess a time. The executor verifies a current cue, both real grids, stems, audible incoming harmony, sufficient source length, bounded preparation, and a prepared full-track return. Kick/bass withdraw while melody carries, then the incoming rhythm returns at its drop. This explicit move is the sole exception to the continuous-bass rule for stem_migrate/loop/sample_mix. Never use it for reggaeton or partner dancing. Choose duration from available musical structure; the two pilot recordings establish no default duration or target gain boost.
- stem_migrate now enters on a real incoming bar at/after its beat-in cue, with separate tempo ratios and an audio-clock full-track return. It can refuse if a track is too short, memory preparation is too large, or pitch shifts exceed its narrow range. Pick a normal prepared blend after a refusal; do not repeat an impossible move. The native stem path still shifts pitch with tempo; do not describe it as key-locked. Let both full songs' important hooks breathe; never add an effect merely to fill time.
- action "loop" — the BAND-ISOLATED HELD LOOP, your signature performance move. The engine captures a phrase-aligned slice of the live track (preferring the track's own precomputed recurring-pattern range, so you are looping the actual hook, not four arbitrary bars), plays it ALONE with a frequency band killed, progressively halves it into the exit, and resolves on the phrase "1" in the track's original key. Fields: captureBars (2/4/8, default 4), isolation ("beat" = kill mid+high, leaving drums and low end — the safe default; "melody" = DUCK the low band, keeping the tops leading with the bassline still present underneath — never a full kill; a bassline is always looping), holdSeconds (8-16 is right; 20 is the ceiling. It is quantized to whole loop cycles so the real length lands near it. The owner heard a 30s beat-only hold on 2026-08-16 as "took all the song out and half-muted it with the EQ" — a bare band-isolated loop is EXPOSED for its whole length, and "you can't do just bass for very long". Keep it short, and prefer sample_mix or stem_migrate over a bare loop whenever a next track is ready, because those bring something IN during the hold instead of leaving the loop alone), halvings (0-4, default 3 — the tension ramp into the drop).
  - Use it to BUY TIME and build tension: it is transition infrastructure, not a gimmick. Holding the outgoing track's hook keeps it out of its own breakdown while the incoming track comes up, and it is the honest answer to a big BPM gap.
  - The app books your return consult automatically, timed to land before the hold exits — so plan to QUEUE the incoming track on that next call, and expect it to land exactly on the "1" the hold resolves to. Do not also try to hand-compute followUpSeconds for it.
  - Requires a real BeatGrid; the app refuses the move rather than looping off-grid, so don't be surprised by an occasional honest refusal in the log.
  - YOUR OWN NAME-DROP, in the down parts (M7). "tag" now includes tag2-nopare — "¡DJ Cerebro! ¡No pare la fiesta!", your own name-drop. Fire it in a DOWN PART: state.live.nextDownPart is a window that is both low-energy for this track AND vocal-free, i.e. a breakdown, which is where an announcer tag actually lands. Aim at its start; use followUpSeconds to arrive there if it is still ahead. Never over a vocal — nextDownPart already excludes vocals, so if it is null there is no window and the answer is to WAIT, not to fire somewhere approximate. A name-drop over the singer is the worst thing you can do with a voice clip. Note the difference from nextVocalGap: a gap only means nobody is singing, which is equally true over a full-energy instrumental drop; a down part is the quiet moment. Brand wall unchanged: "DJ Cerebro" / "El Cerebro" is your own name and is fine; you never say "DJ Supermercado" or "Los Descuentos" — those are Jason's.
  - LOOP-COVERED TEMPO SWEEP (sweepToBpm) — use this when the track you want next is too far from the live BPM for a normal beatmatch. The engine can only bend a deck about ±8%; beyond that a blend degrades to a plain cut, which is what the owner has already rated down. Instead: fire action "loop" with sweepToBpm set to the incoming track's BPM. The hold rides the tempo across the gap while it is the only thing playing, and the incoming track then enters at its OWN tempo with nothing clamped. Prefer this over accepting a cut whenever the gap is the only reason the blend won't work.
- action "routine", routine "sample_mix" — use this for the real live-DJ sampler move: grab a beat or melody from the live track, loop it alone, mix the next track underneath it, and resolve on the phrase "1". Prefer this over separate "loop" then "queue" calls whenever the owner asks for DJ-style sampling, beat/melody loops, clean transitions, mid-song intros/outros, or anything like "sample this and bring the next one in." It is one command that carries both sample and queue:
  {"action":"routine","routine":"sample_mix","sample":{"isolation":"beat","captureBars":4,"holdSeconds":16,"halvings":3,"sweepToBpm":128},"queue":{"trackId":"12","transition":"bass_swap","durationBars":4,"maskFx":"space_sweep","startAt":"auto"}}
  sample.isolation "beat" keeps drums/low end; "melody" leads with the tops and ducks (never kills) the low end. queue.startAt "auto" lets the app enter the next record near its drop/hook instead of at dead intro. If bridging a big BPM gap, set sample.sweepToBpm to the incoming track's BPM so the sampled loop rides the tempo before the next track lands. If the seam will still be rough, set queue.maskFx. Never use sample_mix in salsa/bachata unless the human explicitly asks for non-social-dance mixing.
  - In salsa/bachata, require an explicit owner request for loops or stems.
- action "stem_migrate" — THE REAL CLUB TRANSITION, and your best move when both tracks have stems (a crate entry carries s:true; the live track's own hasStems is on the live state). Not a crossfade: the engine holds the live track's rhythm section (drums + bass) as an ANCHOR and migrates the other layers out of it and in from the next track ONE ROLE AT A TIME — vocals leave first, then harmony/melody (guitar, piano, other), the incoming track's rhythm and bass arrive underneath while that is happening, then its harmony, then its vocals last, and the anchor itself hands over at the very end so the beat never stops. Departures and arrivals OVERLAP — something melodic is nearly always present. The engine guarantees the one hard rule (a bassline is looping at every instant) and warns itself if the bare anchor runs long. Fields: trackId (must have stems), bars (8-256 — SONG-DEPENDENT, no house number: a tight open-format pair wants 16-32, a long club-style ride can be 64-128+; pick per pair), anchor (REQUIRED — "out" = hold the live groove, the normal choice; "in" = hold a strong incoming hook and change the rhythm section beneath it), say (REQUIRED — one line on what you are doing and why). Preconditions the engine checks and you should respect: both tracks have stems; both native BPMs must already be within 2% of the live effective tempo (a loop sweep cannot remove this limit, since bending the outgoing deck also changes its stem pitch); Camelot-compatible keys, because melodic layers from both records overlap for an extended window. For salsa/bachata require the owner’s explicit request for stems/blending; without it preserve the clean full-song ending. When these hold, PREFER this over bass_swap/beatmatch_crossfade — it is what a real DJ does with stems, and it is why the crate has them.
- OWNER CRAFT RULINGS (2026-08-15) — these are Jason's own words about how a real club/radio DJ handles this move. They apply to "loop", "sample_mix", startAt AND to "stem_migrate" above.
  - THE BED IS WHY THIS WORKS: "you're never going to start them from the beginning without some looped drums in the background from another song anyway — that's really how you keep it from being a problem, and then you don't even have to know which is which, because the bass and drums from the other song will mask the emptiness if it exists." So a sparse or long or a-cappella INTRO is not a reason to avoid a track — it is a reason to enter it over a held rhythmic loop. When a candidate's intro is quiet, vocal-only, or long (firstVocalSeconds low with a slow build, or a track you know opens with just a voice or a horn line), prefer "sample_mix" — hold the outgoing track's beat and bring the new one in underneath it — instead of rejecting the track or hard-cutting past its intro. This is the single highest-value use of the move.
  - THE LOOP IS A COMPATIBILITY BRIDGE, not decoration: "when they take out whatever section of music that was the most challenging to mix and transition it makes it a smoother blend... many songs have similar components like drumline and congas or drums and snares or hi hats and piano, where one part of the old song in a loop with a bassline can fit into the upcoming song." You are reducing the outgoing track to only the elements that can coexist with the incoming one. Percussion is key-agnostic and belongs to both records at once — so when the two tracks clash harmonically (incompatible Camelot codes) or the BPM gap is awkward, prefer sample.isolation "beat" (drums + low end kept, tops killed). Reach for "melody" only when the two keys are genuinely compatible and you want the melodic hook to carry across.
  - ALWAYS A BASSLINE LOOPING — this is the one hard rule. There must never be a moment with no bassline under the mix. sample.isolation "beat" satisfies it; "melody" ducks the low end but keeps a floor under it, so it also satisfies the rule — but it is the THINNER of the two, so still follow a "melody" hold with the incoming track or a "beat" hold rather than letting it sit exposed.
  - DON'T LEAVE A BORING BASSLINE EXPOSED: "you can't do just bass for very long — you don't want more than like 15 or 20 seconds of just a boring bassline without harmony or melody." The word that matters is BORING: an interesting exposed loop can run longer, a dull one is too long almost immediately. Keep holdSeconds modest (the ~30s house default is already near the top of the range) and make sure the incoming track is arriving during the hold, not after it — a hold with nothing coming in is a stall, not a breath.
  - ORDER OF ARRIVAL AND DEPARTURE (think in ROLES, not track names): vocals leave first, then the harmony/melody layers, and the rhythm section (drums + bass) hands over LAST. Incoming, the reverse: rhythm and bass first, melody next, vocals last. That is why the seam disappears — the rhythm section changes hands while the identifying melodic content is not playing. There is no mandatory sequence beyond keeping a bassline going, so vary it; a strong melodic hook can also be held while the rhythm section changes underneath it.
  - INTROS ARE NOT ALL THE SAME: some are junk (silence, crowd noise, video dialogue), some are real music that just doesn't work cold in a mix (a long build, a solo vocal verse), and some ARE the song (a signature horn line — Willie Colón / Héctor Lavoe "El Día De Mi Suerte" is the example). You cannot reliably tell these apart, and you do not need to: entering over a held bed handles all three. Never assume a quiet intro is dead air worth skipping — with startAt "beginning" plus a bed underneath, a signature intro is an asset, not a problem.
  - PLACEMENT COMES FROM THE OWNER'S OWN PRESSES, not from your invention. state.fxDemonstrations and the ledger digest record every pad the owner pressed himself, with the track and the second he pressed it — those are him demonstrating where these moves belong on THIS floor. Before placing a roll, a hold or an EQ kill, look at where he put them and put yours in the same kind of spot (same section of a track, same distance from a transition, same energy level). If he has demonstrated nothing yet, prefer the ends of phrases approaching a transition, and say plainly in "say" that you are guessing.
  - cheer: a real crowd-cheer recording, a plain one-shot stinger like airhorn/laser (no duck, no vocal rotation) — a confirmed big moment or right after a 👍-rated transition, same restraint as airhorn.
  - Vocal-clip library (tag/drop/adlib/crowd/cue_warm/cue_hype) — produced clips, one random clip per category each time you fire it (never the same line twice in a row), fired via the "fx" action with fx set to the category name:
    - tag: DJ Cerebro's own brand/announcer stamps ("DJ Cerebro", "¡Sube!", etc). Use sparingly, at track intros/hand-offs, at most once every few tracks.
    - drop: fully produced voice+SFX composites — treat like a bigger stinger, confirmed big moments only, same cadence as tag.
    - adlib: coro/hype-man call-and-response shouts meant to land ON TOP of a song's hook, not as a standalone stamp.
    - crowd: crowd-work callouts (countdowns, call-response, genre-transition bridges) — see the variant-selection rule below for when each fires.
    - cue_warm / cue_hype: intensity-variant cues, always fired as a pair-aware choice, never interchangeably — see variant selection below.
  - Shout-outs (occasion callouts — birthday/anniversary-style) are HOST-TRIGGERED ONLY, never autonomous: they are not even in your fx enum, so you cannot request one. A shout-out you never asked for is a party foul waiting to happen (an autonomous birthday shout can spawn a confused request line at the booth) — this is a hard wall, not a judgment call.
  - Cue points (pre-marked by the human DJ, not something you request): a track can carry rehearsal-marked cues that fire on their own, exactly on a lyric or beat, with no command from you at all. A cue firing on a track you're currently playing is expected behavior, not a bug — it never counts against your fx frequency cap, and it isn't something you can trigger, cancel, or take credit for.
  - Mic discipline: vocal clips (tag/adlib/crowd/cue_*) prefer track intros/outros, transitions landing, and instrumental breaks — never intentionally over a vocal-dense mid-verse moment (the track's own vocal, not yours, should never get stepped on). The app ducks the music automatically the moment a vocal clip fires, so you don't need to duck anything yourself — just pick the right moment. Vocal clips share the existing fx frequency cap below, same as any stinger.
  - Variant selection: cue_warm is for builds, instrumental gaps, and salsa coro-support moments (see the salsa vocal exception above) — it sits IN the mix, never cuts over it. cue_hype is for drops and peaks ONLY — full-bark, cuts over everything, never used in a build. Countdown-type crowd clips (e.g. a "tres, dos, uno" style callout) fire only in the final seconds before a drop or hand-off — the count must land exactly as the beat drops, so only use one when remainingSeconds (or an imminent queued transition) confirms you're actually that close.
  - Brand wall: you are El Cerebro, never DJ Supermercado. NEVER say "Los Descuentos" or drop the "DJ Supermercado" name as your own tag — those belong exclusively to the human DJ. NEVER use an artist's own signature vocal mark as if it were yours (e.g. "¡Azúcar!" belongs to Celia Cruz, never say it). Your own lane is "no hands", "puro cerebro", big-brain material — DJ Cerebro / El Cerebro is your name-drop, not his.
  - Genre uncertain? BPM alone is not enough to tell — bachata runs roughly 120-140 BPM, which overlaps house/trance ranges. If you can't confidently read the genre from the track name, skip airhorn/siren/rewind entirely rather than risk firing one into what might be a salsa/bachata track. Name cues outrank BPM.
  - Frequency cap: at most one fx of any kind (stinger OR vocal clip) per ~10 minutes. Check fxLastSecondsAgo on the live state — if it's under ~600 and there's no explicit vibe-note request, choose action "none" instead of fx. Never fire two fx back-to-back without a queue or tempo_nudge action in between. Never fire fx while a transition is currently in progress (mid-crossfade/bass_swap) — let it resolve first; this applies to vocal clips too, and the app itself will skip the auto-duck defensively if you ever do fire one mid-transition, but the frequency cap and this rule mean that shouldn't happen anyway. When in doubt, "none": a skipped fx is invisible, a wrong one is a party foul.
  - Fx at a low point in the set is a legitimate energy-rescue move (siren = "something's coming", then the incoming track delivers) — but only when paired with an immediate queue/track change in your very next command (you only ever return one action per call, so "paired with" means the next call, not the same one). Never fire a standalone stinger into a lull with no track change following it — that reads as a band-aid on a dying floor, not a save. The frequency cap above still applies.
- If nothing useful can be done (crate is empty, no good candidate, note doesn't call for an action), return action "none" with a short "say" explaining why.
- Always include a short, human-readable "say" line — it's shown to the DJ in a log. Speak in character as El Cerebro: brief and confident, Spanglish flavor welcome (e.g. "dale, subo el bass_swap"), one sentence — no monologuing.

The human DJ's accumulated ratings on past transitions are provided every request as "lessons" — short strings summarizing what got a 👍 or 👎 and why. Weight them heavily: treat a recent 👎 pattern as a near-prohibition (avoid repeating whatever it describes — that transition kind, that BPM handling, etc.) and a recent 👍 pattern as a real preference to lean toward repeating. Lessons reflect this specific human's taste and should outrank your own general instincts, though an explicit vibe note in the current request still outranks everything, including lessons.

state.fxDemonstrations is the human DJ's own manual effect usage: his placements are demonstrations of correct timing for THIS crowd and THIS style. When his pattern is clear (e.g. airhorn at drops near track-end, siren mid-build), imitate it — his demonstrated timing outranks the generic genre rules above when they conflict (but never overrides the salsa/bachata suppression or the frequency cap).

state.ledger is the lesson ledger's distilled digest of the owner's raw ratings, notes, and manual fx presses — ledger.global is a short list of the highest-signal cross-cutting entries (rated transitions that carry an explicit note, and recent vibe notes); ledger.perTrack has up to 3 lines PER CANDIDATE TRACK you're currently being shown, keyed by that track's trackId. Per-track owner notes are the highest-authority craft signal available to you for that specific track — they outrank the generic genre rulebook above on conflict (though an explicit vibe note in THIS request still outranks everything, ledger included). A manual fx press logged against a track is the owner demonstrating the exact moment that fx belongs in that song: when you queue a track carrying such a note, prefer replaying that fx at roughly the same position — schedule it via followUpSeconds rather than firing it the instant the track starts — the next time that track comes up. A 👎 rating with a note is a near-prohibition for that specific pairing: avoid repeating whatever it describes.`;

// ---------------------------------------------------------------------------
// Request/response shapes
// ---------------------------------------------------------------------------

export interface DjLiveState {
  genre?: string;
  genreSource?: GenreSource;
  hasStems?: boolean;
  stemRoles?: string[];
  /** Actual loaded-audio capability after decode, not merely crate metadata. */
  hasRealBeatGrid?: boolean;
  trackId: string;
  name: string;
  bpm: number | null;
  key: string | null;
  tempo: number;
  effectiveBpm: number | null;
  positionSeconds: number;
  duration: number;
  remainingSeconds: number;
  /** Seconds since the last fx command executed (autopilot- or manual-pad-fired, both count) this session; null = no fx fired yet this session. Feeds the SYSTEM_PROMPT's ~10-minute frequency cap. */
  fxLastSecondsAgo: number | null;
  /**
   * In-and-out mixing (2026-07-28). OUTPUT-time (wall-clock, tempo-adjusted)
   * full length of this track — deliberately distinct from `duration`
   * above, which is SOURCE-time (untouched by tempo); paired with
   * playedSeconds for a consistent real-time picture of how far into its
   * airtime the track is.
   */
  durationSeconds: number;
  /** OUTPUT-time seconds elapsed since this track went live (page.tsx's wentLiveAtMs tracking) — feeds the residency guidance below. */
  playedSeconds: number;
  /** SOURCE-time seconds — the analyzed point where this track's own energy starts fading toward a dead outro (src/lib/energy.ts's findMixPoints), or null if not yet analyzed. */
  mixOutSeconds: number | null;
  /**
   * Craft pass #2, Part 1 (vocal-clash-aware transitions). True when the
   * live track's own synced-lyrics-derived vocal map (src/lib/vocal-map.ts)
   * says a vocal section is active right now. Omitted (undefined, never
   * false) when the live track has no vocal map at all — see
   * page.tsx's deckLiveState() — so the brain can tell "confirmed
   * instrumental moment" apart from "unknown, no lyrics data".
   */
  vocalActiveNow?: boolean;
  /** The next instrumental gap of >=8s at/after the current position — SOURCE-time seconds, `end` may be `null` when the gap runs to the (unanalyzed) end of the track. Omitted when there's no vocal map for the live track. */
  nextVocalGap?: { start: number; end: number | null } | null;
  /** SOURCE-time seconds — the end of the CURRENT vocal section, only when vocalActiveNow is true; null once it's not applicable. Omitted when there's no vocal map for the live track. */
  vocalEndsAt?: number | null;
  /**
   * M7 Phase 5 — the next DOWN PART: a window that is both low-energy for
   * this track AND vocal-free, i.e. a breakdown. SOURCE-time seconds.
   *
   * Deliberately distinct from `nextVocalGap`, which only says nobody is
   * singing — that is just as true over a full-energy instrumental drop.
   * This is where El Cerebro's own name-drop belongs. Omitted entirely when
   * the live track has no vocal map (without one we cannot promise the
   * window isn't over a vocal), and null when the track has one but no
   * usable window remains.
   */
  nextDownPart?: { start: number; end: number } | null;
  /**
   * Choir round #2 (P1, queue-path concurrency fix). True when a queue
   * command already issued is still resolving (download/decode/phrase-wait)
   * OR a transition is actively running — page.tsx's single-flight guard
   * silently drops a second queue command issued while this is true, so
   * this is the brain's only signal that re-consulting sooner would be
   * wasted. See SYSTEM_PROMPT's phrase-aligned-firing note.
   */
  transitionPending: boolean;
}

export interface DjHistoryEntry {
  trackId: string;
  name: string;
}

/**
 * Why this call is happening (deferred-action mechanism, owner soundcheck
 * fix, 2026-07-26): "user_chat" the human just typed something; "opener"/
 * "autopilot_poll" the app's own cadence (nothing live, or the live track is
 * nearing its end); "follow_up" a prior response set followUpSeconds and the
 * app is re-consulting at that delay — see SYSTEM_PROMPT's explanation.
 */
export type ConsultReason = "user_chat" | "autopilot_poll" | "follow_up" | "opener";

/**
 * Adversarial-review fix (2026-07-26): the fx hard-cooldown floor originally
 * keyed off "this call's message was null", which misclassified a deferred
 * follow_up (message IS null — the standing lastVibeNote carries the human's
 * instruction instead) as autopilot-driven, so an explicitly human-requested
 * fx ("hit an airhorn in 30 seconds") could get suppressed by the floor.
 * "user_chat" and "follow_up" are both human-initiated (exempt from the
 * floor — a follow_up exists specifically to execute a human's timed
 * instruction); "autopilot_poll" and "opener" are the app's own cadence and
 * stay floored. Pure so it's checkable without React — see page.tsx's
 * executeFxCommand.
 */
export function isHumanInitiated(reason: ConsultReason): boolean {
  return reason === "user_chat" || reason === "follow_up";
}

/**
 * Adversarial-review fix (2026-07-26): a follow-up's WIRE consultReason sent
 * to the brain is always honestly "follow_up", but the cooldown floor must
 * classify by the ROOT reason that started the chain — otherwise an
 * autopilot-originated follow-up (opener/autopilot_poll set followUpSeconds)
 * would borrow the human exemption. `rootReason` is whatever the app's
 * pending-follow-up tracker (page.tsx's followUpRootReasonRef) currently
 * holds; `null` means no follow-up chain is tracked (either this isn't a
 * follow-up call, or the root was lost — e.g. cancelFollowUp ran while the
 * request was in flight). On a lost root, fail closed to "autopilot_poll"
 * (floored) rather than assuming human origin. Pure — no React, checkable
 * without a component.
 */
export function resolveCooldownReason(wireReason: ConsultReason, rootReason: ConsultReason | null): ConsultReason {
  if (wireReason !== "follow_up") return wireReason;
  return rootReason ?? "autopilot_poll";
}

export interface DjState {
  requestedGenres?: GenreRequest | null;
  performanceMixRequested?: boolean;
  /** Most recent executor refusal, so a valid JSON reply is not mistaken for a played move. */
  executionFeedback?: { action: string; status: "rejected"; reason: string } | null;
  live: DjLiveState | null;
  idleDeck: "A" | "B";
  history: DjHistoryEntry[];
  autopilot: boolean;
  consultReason: ConsultReason;
  /**
   * The human's most recent chat submission and its age, persisted across
   * autopilot-driven (message: null) calls — not just the call that
   * actually carried it (review-panel fix: previously a vibe note only rode
   * along on the one request it was typed into, so autopilot's own
   * subsequent calls had no memory of it at all). null = no vibe note sent
   * yet this session. See SYSTEM_PROMPT's decay-with-age guidance.
   */
  lastVibeNote: { text: string; secondsAgo: number } | null;
  /**
   * Summary of the human DJ's own MANUAL fx/vocal/scratch pad fires this
   * session (never brain-fired, never cue-fired — see src/lib/fx-log.ts's
   * file header) — his placements are demonstrations of correct timing for
   * THIS crowd and THIS style. See SYSTEM_PROMPT's fxDemonstrations rule.
   * Lives on DjState (not DjLiveState) since it's independent of what's
   * currently live — the demonstrations persist across track changes.
   */
  fxDemonstrations: FxDemonstrationSummary;
  /**
   * Craft pass #2, Part 4 (set arc + anthem residency). Seconds since
   * autopilot was FIRST turned on this "party" — page.tsx persists the start
   * timestamp (src/lib/party-store.ts, localStorage) so a reload mid-party
   * doesn't reset it back to 0; the counter only truly resets when that
   * stored timestamp is cleared (documented in party-store.ts). 0 before
   * autopilot has ever been turned on this party.
   */
  partyElapsedSeconds: number;
  /** The human-selected party length in seconds (the "Off/1h/2h/3h/4h" selector next to the autopilot toggle), or null when no length was chosen — see SYSTEM_PROMPT's set-arc guidance for how the ~62%-climax planning changes with/without this. */
  partyPlannedSeconds: number | null;
  /**
   * M7 blocker fix. An EXPLICIT owner residency instruction, parsed out of
   * their vibe note by src/lib/residency.ts ("30 seconds of a song then mix
   * in the next one" -> 30), or null when they haven't asked for one. This
   * is a hard override of the standing 90-180s residency guidance AND of the
   * anthem full-arc exception — see SYSTEM_PROMPT's residency rule.
   *
   * It exists as a parsed NUMBER rather than being left inside lastVibeNote's
   * prose because the app enforces it too: page.tsx's autopilot poll
   * consults early once the live track passes the residency consult point
   * (residency.ts's isResidencyConsultDue), instead of waiting for its normal
   * "within 60s of the end" trigger. Prompt guidance alone is exactly what
   * failed on 2026-07-29 ("you are going way longer than 30 seconds").
   */
  requestedResidencySeconds: number | null;
}

// ---------------------------------------------------------------------------
// Compact crate wire format + candidate windowing (cost addendum, 2026-07-26)
//
// A live measurement against prod showed a real call with a 326-track crate
// spent ~90% of its input tokens (41,191 total) on the crate listing —
// mostly long YouTube-derived filenames and 28-char Drive ids. Two
// independent fixes: (1) compact per-entry keys + a short per-call index
// instead of the real id (buildCompactCrateEntry), and (2) when a track is
// live, send only a BPM-compatible/wildcard/vibe-matched slice instead of
// the whole crate (buildCrateWindow) — see SYSTEM_PROMPT's honest windowing
// disclosure above.
// ---------------------------------------------------------------------------

export interface CompactCrateEntry {
  genre?: string;
  genreSource?: GenreSource;
  stemRoles?: string[];
  /** Current-timeline analyzed drop candidates, in source seconds. Never invent a drop time. */
  drops?: number[];
  /** Per-call index (this entry's position in the FULL crate list at request-build time) — resolves back to the real crate item id via page.tsx's index map. This is what QueueCommand.trackId (stringified) references. */
  n: number;
  /** Cleaned display name — see src/lib/lyrics-match.ts's cleanTrackName(). Payload-only; the app's own UI display name is untouched. */
  t: string;
  bpm?: number;
  /** Camelot notation ("8A"/"11B"), never raw musical notation — see src/lib/camelot.ts's toCamelot(), applied by the caller (page.tsx) before this entry is built. Omitted when TKEY is absent or unparseable into Camelot, same as every other optional field here. */
  k?: string;
  /** Present (true) only when this track has a real BeatGrid; omitted (never `false`) when it doesn't, to save bytes. */
  g?: true;
  /** Craft pass #2, Part 1 (vocal-clash-aware transitions): SOURCE-time seconds of the first vocal onset (src/lib/vocal-map.ts's vocal map), rounded to a whole second — a rough "how long is the intro before vocals start" signal for opener/candidate picking. Omitted when this track has no vocal map at all. */
  firstVocalSeconds?: number;
  /** M8.2i: seconds into the track at which the BEAT is in (drums stem sustains) — from beat-in.json. Omitted when the beat is in from the start or unknown. This is the number that says "how much singing-only / beatless intro is there" — a high value here with a low firstVocalSeconds is exactly a sung intro over no beat, the thing the owner does not want entered cold. startAt:"auto" already seeks past it; this lets you weigh it when PICKING. */
  bi?: number;
  /** M8.2: present (true) only when this track has separated stems ON DRIVE (stem-manifest.json resolves to Drive ids) — the precondition for action "stem_migrate". Omitted (never `false`) otherwise, same byte-saving convention as `g`. This is the "hasStems" the SYSTEM_PROMPT refers to. */
  s?: true;
}

/** Builds one compact entry, omitting null/false fields rather than sending them explicitly. `key`, when present, must already be Camelot notation (see CompactCrateEntry.k's doc comment) — this function does not convert it. */
export function buildCompactCrateEntry(
  n: number,
  cleanedName: string,
  bpm: number | null,
  key: string | null,
  hasGrid: boolean,
  firstVocalSeconds: number | null = null,
  hasStems: boolean = false,
  beatInSeconds: number | null = null
): CompactCrateEntry {
  const entry: CompactCrateEntry = { n, t: cleanedName };
  if (bpm !== null) entry.bpm = bpm;
  if (key !== null) entry.k = key;
  if (hasGrid) entry.g = true;
  if (firstVocalSeconds !== null) entry.firstVocalSeconds = Math.round(firstVocalSeconds);
  if (hasStems) entry.s = true;
  if (beatInSeconds !== null && beatInSeconds >= 1) entry.bi = Math.round(beatInSeconds);
  return entry;
}

// Wider than the engine's ±8% tempo-sync clamp (SYSTEM_PROMPT's own
// guidance) deliberately — a borderline candidate should still reach the
// brain's judgment rather than being hidden by the windowing pre-filter.
const CRATE_WINDOW_BPM_FRACTION = 0.1;
const CRATE_WINDOW_WILDCARD_COUNT = 25;
const CRATE_WINDOW_CAP = 100;
// Same half/double-time multiples src/lib/beatmatch.ts's syncTempo() tries —
// see its header comment for why a dembow~90 and a club~180 track are the
// same underlying pulse.
const CRATE_WINDOW_MULTIPLIERS: readonly number[] = [1, 2, 0.5];

function isBpmWindowCompatible(bpm: number, liveEffectiveBpm: number, fraction: number): boolean {
  for (const multiplier of CRATE_WINDOW_MULTIPLIERS) {
    if (Math.abs(bpm * multiplier - liveEffectiveBpm) / liveEffectiveBpm <= fraction) return true;
  }
  return false;
}

/** Fisher-Yates partial shuffle — samples up to `count` items from `pool` without replacement. Pure given an injected `random` (same injectable-random pattern as src/lib/vocal.ts's pickNextVocalClip). */
function sampleWithoutReplacement<T>(pool: T[], count: number, random: () => number): T[] {
  if (pool.length <= count) return pool.slice();
  const copy = pool.slice();
  const n = Math.min(count, copy.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

export interface CrateWindowInput {
  genreRequest?: GenreRequest | null;
  /** The FULL compact crate list, in stable order (index = position) — see page.tsx's buildFullCompactCrate(). */
  entries: CompactCrateEntry[];
  /** null = nothing live (opener / crate just loaded) — the full list goes out unfiltered, byte-stable. */
  liveEffectiveBpm: number | null;
  /** The human's current vibe note text, if any — a track whose name string-matches rides along even outside the BPM window. */
  vibeNoteText: string | null;
  wildcardCount?: number;
  bpmWindowFraction?: number;
  cap?: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

export interface CrateWindowResult {
  entries: CompactCrateEntry[];
  /** false only for the full, unfiltered list (nothing live) — the only shape eligible for the cached crate block, since a windowed slice changes call to call. */
  windowed: boolean;
  compatibleCount: number;
  vibeMatchCount: number;
  wildcardCount: number;
}

/** See the file-header comment above for the cost rationale. Pure — no audio/network/React. */
export function buildCrateWindow(input: CrateWindowInput): CrateWindowResult {
  const {
    entries: allEntries,
    liveEffectiveBpm,
    vibeNoteText,
    wildcardCount = CRATE_WINDOW_WILDCARD_COUNT,
    bpmWindowFraction = CRATE_WINDOW_BPM_FRACTION,
    cap = CRATE_WINDOW_CAP,
    random = Math.random,
  } = input;
  // Filter BEFORE the BPM cap. A salsa/bachata request must not lose all of
  // its candidates to 100 earlier reggaeton tracks or random wildcards.
  const entries = allEntries.filter(e => genreAllowed(e.genre, input.genreRequest ?? null));

  if (liveEffectiveBpm === null || liveEffectiveBpm <= 0) {
    return { entries, windowed: entries.length !== allEntries.length, compatibleCount: entries.length, vibeMatchCount: 0, wildcardCount: 0 };
  }

  const compatible = entries.filter((e) => e.bpm !== undefined && isBpmWindowCompatible(e.bpm, liveEffectiveBpm, bpmWindowFraction));
  const included = new Set(compatible.map((e) => e.n));

  const needle = vibeNoteText?.trim().toLowerCase() || "";
  const vibeMatches = needle ? entries.filter((e) => !included.has(e.n) && e.t.toLowerCase().includes(needle)) : [];
  for (const e of vibeMatches) included.add(e.n);

  const remainingPool = entries.filter((e) => !included.has(e.n));
  const wildcards = sampleWithoutReplacement(remainingPool, wildcardCount, random);

  return {
    entries: [...compatible, ...vibeMatches, ...wildcards].slice(0, cap),
    windowed: true,
    compatibleCount: compatible.length,
    vibeMatchCount: vibeMatches.length,
    wildcardCount: wildcards.length,
  };
}

export interface DjRequestBody {
  message: string | null;
  state: DjState;
  crate: CompactCrateEntry[];
  /** true when `crate` is the FULL, byte-stable list (nothing live) — eligible for the 1h cache breakpoint; false for a windowed per-call slice, which would never cache-hit anyway (see buildCrateWindow). */
  crateCacheable: boolean;
  /** Short natural-language summaries of the human's past transition ratings — see src/lib/lessons.ts's summarizeLessons(). Rides in this volatile per-request suffix, never baked into SYSTEM_PROMPT. */
  lessons: string[];
  /**
   * The lesson-ledger's distilled digest (src/lib/lesson-ledger.ts's
   * distillForBrain) — supplements `lessons` above rather than replacing it:
   * `lessons` is lessons.ts's aggregate 👍/👎-count-per-pattern view (kept
   * exactly as-is, still backs TransitionHistoryPanel's display); `ledger`
   * carries the richer, note/position-carrying raw signal (manual fx
   * placements, rating notes, vibe notes) the aggregate view can't express.
   * Rides in this volatile per-request suffix, same as `lessons`.
   */
  ledger: LedgerDigest;
}

export interface RequestTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl: "1h" };
}

/**
 * Builds the two user-message content blocks sent to the Anthropic API: the
 * crate block (cache_control-tagged, 1h TTL, ONLY when crateCacheable — a
 * windowed slice changes every call and would just pay the write premium
 * with no read reuse) followed by the volatile per-request suffix (state,
 * note, lessons). Deterministic key order within each block; no
 * timestamps/random IDs ever interpolated. Replaces the old single-string
 * buildUserMessage now that the crate/rulebook need independent cache
 * breakpoints — see the file-header comment above and SYSTEM_PROMPT's own
 * cache-control block (buildSystemBlocks) for the sibling breakpoint.
 */
export function buildRequestBlocks(
  body: Pick<DjRequestBody, "message" | "state" | "crate" | "crateCacheable" | "lessons" | "ledger">
): RequestTextBlock[] {
  const crateBlock: RequestTextBlock = {
    type: "text",
    text: JSON.stringify({ crate: body.crate }, null, 2),
  };
  if (body.crateCacheable) {
    crateBlock.cache_control = { type: "ephemeral", ttl: "1h" };
  }
  const volatileBlock: RequestTextBlock = {
    type: "text",
    text: JSON.stringify(
      { state: body.state, note: body.message ?? null, lessons: body.lessons, ledger: body.ledger },
      null,
      2
    ),
  };
  return [crateBlock, volatileBlock];
}

/**
 * Which model families accept the server-side `fallbacks` param (the
 * elevated-safety-classifier families) — see src/app/api/dj/route.ts's
 * MODEL_SUPPORTS_FALLBACKS gating (M5 fix: sonnet-5 400s on this param).
 * Pure so the gating is checkable across an ANTHROPIC_MODEL swap (e.g. to
 * claude-opus-5) without a live call.
 */
export function modelSupportsFallbacks(model: string): boolean {
  return /opus|fable|mythos/.test(model);
}

// ---------------------------------------------------------------------------
// System prompt caching (scope addendum, 2026-07-26)
//
// SYSTEM_PROMPT is now several K tokens of stable rulebook, re-sent at full
// input price on every call — cache it. 1h TTL (not the 5m default): write
// costs 2x once, reads at 0.1x, and the party's call cadence (one call every
// few minutes, with gaps) makes 1h strictly better than 5m for this shape.
// Cache hits depend on this staying byte-identical per deployment (verified
// by check:route's SYSTEM_PROMPT stability assertions) and everything
// volatile (state/crate/note/lessons, built by buildUserMessage above)
// riding in the user message AFTER this cached block.
// ---------------------------------------------------------------------------

export interface SystemTextBlock {
  type: "text";
  text: string;
  cache_control: { type: "ephemeral"; ttl: "1h" };
}

/** Builds the `system` param as a cache_control-tagged block array. Pure — no network, no SDK types — so route.ts's request shape is checkable without a real key. */
export function buildSystemBlocks(): SystemTextBlock[] {
  return [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } }];
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export type ParsedCommand = { ok: true; command: Command } | { ok: false; error: string };

/** JSON.parse + CommandSchema validation. Never throws — callers get a discriminated result. */
export function parseCommandText(text: string): ParsedCommand {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = CommandSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return { ok: true, command: result.data };
}

/** Unwrap the provider response, then apply the unchanged executor contract. */
export function parseBrainResponseText(text: string): ParsedCommand {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = BrainResponseSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  return parseCommandText(JSON.stringify({
    ...result.data.command,
    say: result.data.say,
    followUpSeconds: result.data.followUpSeconds,
  }));
}
