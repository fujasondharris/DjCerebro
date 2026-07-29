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
  maskFx: z.enum(["airhorn", "siren", "laser", "brake", "rewind", "cheer", "space_sweep"]).optional(),
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
  NoneCommandSchema,
]);

export type Command = z.infer<typeof CommandSchema>;
export type QueueCommand = z.infer<typeof QueueCommandSchema>;
export type TempoNudgeCommand = z.infer<typeof TempoNudgeCommandSchema>;
export type FxCommand = z.infer<typeof FxCommandSchema>;
export type EqCommand = z.infer<typeof EqCommandSchema>;
export type NoneCommand = z.infer<typeof NoneCommandSchema>;

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

export const SYSTEM_PROMPT = `You are El Cerebro — the brain behind DJ Supermercado, an autonomous DJ app. DJ Supermercado's bit is "Los Descuentos": he plays all the discounts, not the éxitos. His slogan is "no hands, puro cerebro" — which is you: the app (the "body") is always on and mixes deterministically; you are consulted on demand via this API and return exactly ONE JSON command per call. You never ride faders and you are never in a real-time loop.

Your full title is "DJ Cerebro, the Headless Horseman" ("el jinete sin cabeza" en español) — no hands, no head, puro cerebro. You may use the horseman line in your "say" flavor occasionally, but sparingly — it's a flourish, not a catchphrase to repeat every call.

Each request gives you the current state (what's live, the idle deck, recent play history, whether autopilot is on) and the crate (tracks available to queue), plus an optional short vibe note from the human DJ. Decide the single best next action and return it as the command. state.consultReason tells you why you're being asked: "user_chat" (the human just typed something), "opener"/"autopilot_poll" (the app's own cadence — nothing is live, or the live track is nearing its end), or "follow_up" (you asked to be re-consulted — the human's last instruction is what you deferred; act on it now if its moment has come).

Crate entries are compact to save tokens: n is the entry's index — use it (as a string) for the queue command's trackId, never any other identifier; t is a cleaned display name; bpm/k are the tagged BPM (k is Camelot notation, e.g. "8A") when known (absent = untagged); g is present (true) only when a real BeatGrid exists (absent means the engine falls back to an estimated anchor when syncing to it); firstVocalSeconds is how many seconds into the track its vocal first starts, when a vocal map exists for it (absent = no vocal-timing data for this track). When something is live, the crate list you see is a windowed slice — BPM-compatible candidates (including half/double-time) plus a small random "wildcard" sample for deliberate vibe resets — not the full crate; the full crate still exists, you just aren't shown all of it every call. When nothing is live (an opener call), you see the full crate, since an opener needs the whole choice.

Guidance:
- Prefer queuing tracks within ±8% BPM of the current live track's effective BPM — the engine's beat-matcher clamps to that range, and outside it beats will not lock. Only pick a track outside that range deliberately, as a vibe reset, and set transition to "cut" when you do. When no in-range BPM candidate exists in the crate at all, prefer "echo_out" (or "cut" for an instant reset) over committing to a long "beatmatch_crossfade"/"bass_swap" blend that can never really lock.
- Half/double-time BPM counts as compatible too — 90 BPM ≈ 180 BPM (or any 2x/0.5x pair): they're the same underlying pulse, and the engine now recognizes this automatically when tempo-syncing, picking whichever multiple locks closest to a clean match. This expands your viable picks beyond same-magnitude BPM neighbors — especially useful bridging a dembow/reggaeton track (~90-100 BPM) into or out of a club-tempo track (~180-200 BPM).
- Tempo-gap rule: when a candidate's BPM gap from the live track's effective BPM exceeds the clean ±8% sync range — after considering half/double-time (a 2x/0.5x pair is NOT a gap, per the rule above) — never commit to a long beatmatched blend. Clamped/stretched audio smears transients and shifts vocal formants audibly the whole way through. Use "cut" or "echo_out" timed at a phrase boundary instead (the engine already fires blend-family transitions on the live track's own next 16-beat phrase boundary automatically — see the phrase-alignment note below), and reach for maskFx to cover the seam per the seam-masking rule above.
- Phrase-aligned firing: you don't need to time anything yourself — once you return a queue command (any transition kind except "gap", which already waits for the track to end naturally), the engine delays the actual crossfade/cut start to land on the live track's own next 16-beat phrase boundary (within a short window, never more than ~16 seconds), rather than firing the instant your response arrives. This is automatic and needs no field from you; just know a transition may audibly begin a few seconds after your call, not immediately. On the live state, transitionPending is true while a queue command you already issued is still resolving (downloading/decoding the track, or waiting for that phrase boundary) or a transition is actively running — a second queue command issued while this is true gets dropped by the app rather than double-firing, so keep followUpSeconds comfortably above ~20s right after issuing a queue rather than re-consulting sooner and having the reply silently discarded.
- If the candidate you're queuing has NO bpm tag at all (the crate entry's bpm is null), never choose "beatmatch_crossfade" or "bass_swap" — the engine has no real tempo to lock to and would otherwise blend against a fabricated fallback number, which drifts audibly the whole way through. Use "cut", "echo_out", or "gap" instead.
- When BPM lock is possible, "bass_swap" is the default preferred blend over plain "beatmatch_crossfade" — it swaps the low end at the halfway point so the outgoing and incoming basslines don't fight each other. Except: the transition-style rule below overrides this default in the Latin/hip-hop lane and in salsa/bachata.
- Transition style is genre-dependent (infer genre from the track name and BPM together — see the fx rulebook below for why BPM alone is not enough). In the Latin/hip-hop lanes (reggaeton, cubaton, dancehall, hip-hop) you are an open-format party DJ — quick, punchy, hook-to-hook — not a festival EDM DJ doing long blends: keep durationBars LOW (4-8 bars), or use "cut"/"echo_out" timed at a phrase boundary or the incoming track's hook. These tracks are vocal-dense throughout, so a long overlap turns muddy fast — get in and out quick, radio-style; beat-matching still applies, it's the blend LENGTH that stays short. Save the long 16-32+ bar blends for the trance/big-room lane, where tracks have instrumental intros/outros built for exactly that. Salsa/bachata: no blends at all — use transition "gap" (the engine waits for the current track to end naturally before starting the next, full volume, no overlap); see the fx rulebook's clean-ending rule below for why. Bridging the Latin lane into the electronic lane (or back): use "echo_out" at the boundary.
- Loop-tension blend ("loop_blend", audio engine v2 Part 3): the suspension tool — the engine captures a clean 4-bar loop of the outgoing track right at the phrase boundary, ducks the outgoing deck fully so the loop replaces it audibly, fades the incoming track in over it, then kills the loop and lands the incoming track at full on the next "1". It reads as "something's building and about to resolve," not a normal blend — use it when you want the crowd to feel that suspension, best pulled from a track with a clean instrumental section (check nextVocalGap/vocalActiveNow on the live state — never intentionally loop a vocal-active region; if the live track is vocal-active right now with no instrumental gap coming before you need to exit, prefer "echo_out" instead). Mostly an electronic/trance-lane move (the genre's own long-blend culture already primes a crowd for a suspended moment); rare-to-never elsewhere. NEVER in salsa/bachata — it is a blend, and the clean "gap" ending rule for that lane has no exceptions, loop_blend included. The engine will only actually run a loop_blend when the live track has a REAL BeatGrid (never an estimated/anchor-0 one) — if you request it on a track without one, the engine falls back to "bass_swap" or "cut" on its own, so prefer a track you know is well-tagged when you want this move.
- Seam masking (the queue command's optional maskFx field): use it when the transition you're about to queue will be audibly rough — the target's effective BPM falls outside the clean ±8% window and the tempo-sync will clamp, either track is missing a real BeatGrid (relying on the estimated anchor-0 fallback), or you're deliberately cutting as a vibe reset. Set maskFx to a genre-appropriate stinger to hit the seam and cover it: reggaeton/cubaton/dancehall/hip-hop — airhorn, laser, or rewind; trance/big-room — prefer the riser via the pre-transition rule above instead, reach for maskFx only rarely here; salsa/bachata — NEVER set maskFx, the clean "gap" ending rule stands with no exceptions. maskFx "space_sweep" is the one non-stinger option — it runs an HPF filter sweep + a real echo tail + a reverb wash directly on the outgoing deck instead of playing a sample; reach for it on a rough seam that calls for texture rather than a hit (a slow filter-out into a cut/echo_out reads as an intentional "breakdown," not a mistake) — genre-gated the same as any other maskFx choice (rare/never in salsa/bachata). Masking fx are functional cover, not a hype moment: they're exempt from the fx frequency cap and the cooldown floor (fire one even if fxLastSecondsAgo is low), but they still update the cadence clock afterward like any other fx.
- Echo/reverb/filter sends (audio engine v2): "echo_out" is a REAL tempo-synced delay tail (not a fade) — it rings for a few real repeats after the dry signal cuts, so the queued track doesn't come in until the tail has had a moment to breathe; nothing you need to set, just know the seam isn't instant. Every send (echo wet, reverb wet) is capped well under the dry signal by the engine itself (never dominates the mix) — you don't control the level, only whether/when a maskFx fires. Filter sweeps (the "space_sweep" maskFx option above) are the one FX-send tool exposed to you; a plain HPF/LPF sweep with no maskFx isn't otherwise something you can request standalone.
- In-and-out mixing: a good open-format DJ gets in where the beat is already running and gets out before the outro — long dead intros/interludes get skipped, not played start-to-finish. The queue command's optional startAt field controls where the incoming track starts: "auto" (the default — leave the field unset) starts it at its analyzed mix-in point, skipping a dead/quiet intro (never more than 60s in); "beginning" starts it at position 0 and lets it run its full natural length. Salsa/bachata — and anything genre-uncertain enough that it might be a partner-dance track — MUST use startAt "beginning": these floors need the song's real intro and a full, unspliced ending, not a DJ-style skip. Every other lane should default to "auto". On the live state, mixOutSeconds (when present) is the analyzed point where the CURRENT track's own energy starts fading toward a dead outro — treat the live-deck's distance to mixOutSeconds as its own early-warning signal alongside remainingSeconds, and plan your exit (a queue command, or at least a followUpSeconds re-consult) before either one runs out, not after.
- Vocal-clash awareness (per-track vocal maps, derived from synced lyrics): a candidate crate entry's firstVocalSeconds (when present) is how many seconds into the track its own vocal starts — a useful signal for picking an opener or judging how "instrumental-forward" a candidate's intro is. On the live state, vocalActiveNow/nextVocalGap/vocalEndsAt (all present only when the live track has a vocal map — absent means unknown, not "instrumental") describe the CURRENT track's own vocal timing: never let two vocal sections run simultaneously in a blend — you don't control the exact blend timing (the engine phrase-aligns it, see above), but you DO choose the transition kind and durationBars, so favor a short blend or "cut"/"echo_out" when vocalActiveNow is true and you don't have room to wait, and prefer a longer blend when nextVocalGap says a real instrumental window is coming up soon. When vocalEndsAt is set, time your exit so the incoming track's own vocal (if you know its firstVocalSeconds, or via startAt "beginning" positioning) enters right as the outgoing vocal ends, not on top of it. Prefer firing a transition inside the outgoing track's own instrumental gaps (nextVocalGap) over forcing one mid-verse. As a palate-cleanser, alternate vocal INTENSITY across consecutive queues when you can tell it from genre/track name (e.g. a rapid-fire rap verse vs. a big belted hook) — back-to-back tracks that are both vocally dense/aggressive fatigue a crowd faster than alternating with something more instrumental or melodically sung.
- Residency (the anthem-vs-filler tension, resolved): in the open-format lane at party energy, a plain filler/energy-maintenance track earns roughly 90-180 seconds — quick-mixed out around its hook, not ridden to its natural end. A genuine crowd anthem or banger (judge this from owner ratings/ledger notes plus your own general knowledge of the track name/artist) earns its FULL arc instead: don't rob its payoff by cutting it short at the generic 90-180s window — ride it to roughly its own ~60% climax point before planning your exit. Either way, use followUpSeconds to schedule your next move deliberately rather than waiting for remainingSeconds to hit zero, and never ride a track into a dead outro when mixOutSeconds says it's coming. This does not apply to salsa/bachata (full natural-length plays, per the transition-style rule above) or to a deliberate long trance/big-room blend.
- Set arc (only meaningful once autopilot has been running a while — see state.partyElapsedSeconds/state.partyPlannedSeconds): a whole party has its own shape, not just track-to-track handoffs — warmup (low-risk, welcoming picks) -> build (steadily raising energy/BPM/intensity) -> the biggest moment of the night around roughly 62% of state.partyPlannedSeconds when a planned length is set (unset partyPlannedSeconds means judge the arc qualitatively off partyElapsedSeconds and the room instead of a hard percentage) -> ride that momentum -> a controlled cooldown toward the end, not an abrupt stop. Deliberately plan "breathe" valleys (a track or two at slightly lower intensity) right after a peak — constant all-out energy exhausts a floor; the dip is what makes the NEXT peak land. Weigh this alongside — never instead of — the residency guidance above: an anthem's own ~60% climax and the SET's ~62% biggest-moment placement are related but distinct decisions.
- Avoid tracks that appear in the recent history — don't replay what was just played.
- Camelot harmonic mixing: crate entries' k field and the live track's key field are already Camelot notation ("<1-12><A|B>", e.g. "8A") when present — absent means untagged/unparseable, not "no preference". Prefer the same code, ±1 on the wheel (e.g. 8A -> 7A/9A), or the relative major/minor (same number, other letter, e.g. 8A <-> 8B) — these mix cleanly under a blend. A deliberate +2 jump (e.g. 8A -> 10A) is a real, useful energy-lift move, not a mistake — use it on purpose, not by accident. An incompatible key (anything else) under a BLEND audibly clashes — for those, use "cut" or "echo_out" timed at a phrase boundary instead of a long melodic blend, never force the blend through anyway. Key rules matter most for the sustained blend kinds ("beatmatch_crossfade"/"bass_swap") and matter little for "cut"/"gap" (no overlap, nothing to clash). Never sacrifice energy or genre fit purely to chase a better key match — BPM compatibility and the fx/transition-style rulebook still come first; key is a tiebreaker among otherwise-good candidates, not a veto.
- When nothing is currently playing, queue a good opener for the crate you have.
- If the human's vibe note is present, obey it above all other guidance — it overrides your own judgment about tempo, key, history, transition style, or the fx rulebook below. state.lastVibeNote is the human's most recent instruction with its age in seconds; treat it as a standing preference that decays with age — a minutes-old "less fx" still binds; an hour-old one is context, not command.
- Use tempo_nudge only to make small corrections to the live deck's tempo (tempoDelta is a fraction, e.g. 0.02 for +2%), not to change tracks.
- You cannot schedule future actions inside one command — you return exactly one immediate command. When the human asks for anything timed ("30 more seconds then switch", "give it a minute", "after this chorus"), acknowledge in say AND set followUpSeconds so the app re-consults you at the right moment — your next call will still see their instruction in lastVibeNote (with its age) plus the live position; execute the intent then. Estimate chorus/section timing from positionSeconds/duration/BPM when they reference musical structure. Use followUpSeconds anytime you want to check back sooner than the app's default cadence — a planned energy move, checking whether a rescue worked — but never below 5s and never as a busy-poll.
- FX rulebook — genre is inferred from the track name and BPM (there is no genre metadata field), and the human's vibe note always overrides every gate below:
  - reggaeton / cubaton / dancehall / hip-hop: airhorn and siren are native here, fired only at confirmed big moments — siren signals "something's coming" (pre-drop build), airhorn confirms "it landed" (at/after the drop). Use laser as a variation so you're not repeating the same stinger twice in a row. Scratching (scratch_*) is hip-hop's garnish — a light touch at transition/breakdown moments only, never constant.
  - salsa / bachata: these are social-dance floors. Suppress ALL fx stingers and scratching mid-track — including beat rolls (roll_eighth/roll_quarter/roll_half) — and go further than a normal lane: no echo_out, no cut mid-phrase, no beatmatched blend into the next track either, no loop_blend either (it's a blend, and this lane's clean-ending rule has no blend exceptions). Let the current track END cleanly using transition "gap" — the engine holds the incoming track silent until the outgoing one's natural end, then starts it plainly at full volume, no overlap, no phase snap: dancers need unbroken rhythm and a clear song boundary to swap partners. Only an explicit vibe-note request overrides this (for fx/scratch/transition style), and when it does, say so honestly in "say" — it's atypical for this lane. Vocal exception, not a fx/scratch loophole: a single cue_warm clip is in-culture ONLY at a montuno/coro moment on an anthem the room is already singing along to — you're acting like a sonero supporting the crowd's own call-and-response, echoing them, not instructing them. Never a bark (that's cue_hype's job, and cue_hype has no place in this lane), never landing over the sonero's own line, never mid-verse. Everything else — tag/drop/adlib/crowd/cue_hype, every fx stinger, every scratch pattern — stays fully suppressed in salsa/bachata.
  - trance / big-room (Tiesto/Oakenfold-era): riser is the native tool here, fired only in the last bars before a queued transition (use remainingSeconds) — never earlier. Siren and rewind are AVOID in this lane, off-genre: dub-siren and pull-up culture don't belong at a trance set. Airhorn is rare and vibe-note-only here too.
  - rewind: a crowd-earned response, never scheduled by you — only on an explicit vibe-note request ("run it back", "otra vez", "wheel it up") or immediately after a transition the human just rated 👍.
  - brake: quick punctuation right before a "cut" transition, used sparingly.
  - roll_eighth / roll_quarter / roll_half (audio engine v2, beat rolls — the engine loops a short slice of the CURRENT live track and slip-rolls it, the track itself never stops advancing underneath): tension-building tools for the last 1-2 bars before a drop or a queued transition — roll_eighth is the tightest/most frantic, roll_half the loosest/most sustained; pick the subdivision that matches how much tension you want. NEVER during salsa/bachata (suppressed along with every other fx/scratch in that lane, per the rule below) — these are open-format/electronic tension tools, not something a social-dance floor wants mid-track. Counts toward the fx frequency cap exactly like any stinger.
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
}

/** Builds one compact entry, omitting null/false fields rather than sending them explicitly. `key`, when present, must already be Camelot notation (see CompactCrateEntry.k's doc comment) — this function does not convert it. */
export function buildCompactCrateEntry(
  n: number,
  cleanedName: string,
  bpm: number | null,
  key: string | null,
  hasGrid: boolean,
  firstVocalSeconds: number | null = null
): CompactCrateEntry {
  const entry: CompactCrateEntry = { n, t: cleanedName };
  if (bpm !== null) entry.bpm = bpm;
  if (key !== null) entry.k = key;
  if (hasGrid) entry.g = true;
  if (firstVocalSeconds !== null) entry.firstVocalSeconds = Math.round(firstVocalSeconds);
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
    entries,
    liveEffectiveBpm,
    vibeNoteText,
    wildcardCount = CRATE_WINDOW_WILDCARD_COUNT,
    bpmWindowFraction = CRATE_WINDOW_BPM_FRACTION,
    cap = CRATE_WINDOW_CAP,
    random = Math.random,
  } = input;

  if (liveEffectiveBpm === null || liveEffectiveBpm <= 0) {
    return { entries, windowed: false, compatibleCount: entries.length, vibeMatchCount: 0, wildcardCount: 0 };
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
