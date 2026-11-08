"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BRAIN_MODELS, BRAIN_MODEL_STORAGE_KEY, isBrainModelId, type BrainModelId, type BrainModelOption } from "@/lib/brain-models";
import { CRATE_SORTS, searchAndSortCrate, trackSearchMetadata, type CrateSort } from "@/lib/crate-search";
import { resolveMusicMetadata, musicLabel, needsGenreReview, type GenreSource } from "@/lib/music-metadata";
import { genreAllowed, parseGenreRequest, isPartnerDanceTrack, requestsPerformanceMix, recipeGapNeedsBlend, genreRecoveryTrack, type GenreRequest } from "@/lib/genre-policy";
import { usableStemEntry, describeStems } from "@/lib/stem-catalog";
import type { GenreOverride } from "@/lib/crate-metadata-sync";
import { AudioCore } from "@/lib/audio-core";
import { Deck, type ProgressUpdate } from "@/lib/deck";
import { parseId3Tags, type Id3Tags } from "@/lib/id3";
import { parseSeratoBeatgrid, type SeratoBeatgrid } from "@/lib/serato";
import { playbackMetadata, type PlaybackMetadata } from "@/lib/playback-metadata";
import { queueForResidency, residencyHandoffDelay } from "@/lib/queue-policy";
import { syncTempo } from "@/lib/beatmatch";
import { phaseAlignOffset, type BeatGridLike } from "@/lib/beatclock";
import { createTransitionEngine, type TransitionResult } from "@/lib/transition";
import {
  CommandSchema,
  type Command,
  type QueueCommand,
  type TempoNudgeCommand,
  type FxCommand,
  type EqCommand,
  type EqSweepCommand,
  type TranceBreakdownCommand,
  type LoopCommand,
  type RoutineCommand,
  type StemMigrateCommand,
  type DjState,
  type DjLiveState,
  type CompactCrateEntry,
  type ConsultReason,
  isHumanInitiated,
  isPerformanceMove,
  resolveCooldownReason,
  buildCompactCrateEntry,
  buildCrateWindow,
} from "@/lib/brain";
import {
  loadLedger,
  saveLedger,
  appendLedgerEvent,
  mergeLedgerEvents,
  distillForBrain,
  describeLedgerEvent,
  type LessonEvent,
} from "@/lib/lesson-ledger";
import lessonsSeedJson from "@/data/lessons-seed.json";
import { computeRmsPerSecond, findMixPoints, applyMixInCueOverride, avoidEarlyVocalIntro, type MixPoints } from "@/lib/energy";
import { toCamelot } from "@/lib/camelot";
import {
  analyzeHarmonicRelationship,
  analyzeGrooveInterlock,
  planTurntablistChoreography,
  rankCandidatesByMusicTheory,
  type MusicTheoryTrackInput,
} from "@/lib/music-theory-master";
import { nextPhraseBoundaries } from "@/lib/phrase";
import {
  getVocalIntervals,
  hasVocalMap,
  isVocalActive,
  activeVocalEndsAt,
  vocalGaps,
  nextGapAtOrAfter,
  pickTransitionStart,
  type VocalMapFile,
} from "@/lib/vocal-map";
import vocalMapsJson from "@/data/vocal-maps.json";
import { loadPartyStartMs, savePartyStartMs, loadPartyPlannedSeconds, savePartyPlannedSeconds } from "@/lib/party-store";
import { FxPlayer, type SfxName } from "@/lib/fx";
import { scratch, type ScratchPattern } from "@/lib/scratch";
import { fireRoll, type RollSubdivision } from "@/lib/roll";
import { planLoopBlend, fireLoopOverlay } from "@/lib/loop-blend";
import { needsDeferredMaskFxRelease } from "@/lib/fx-sends";
import {
  VocalPlayer,
  groupManifestByCategory,
  VOCAL_CATEGORIES,
  HOST_ONLY_CATEGORIES,
  type VocalCategory,
  type VocalManifestEntry,
} from "@/lib/vocal";
import vocalManifestJson from "@/data/vocal-manifest.json";

// The committed JSON's `category` field is a plain string as far as the
// JSON-module type inference is concerned — src/lib/vocal-manifest.ts's
// buildVocalManifest() is what actually guarantees every value is a real
// VocalCategory at generation time (see scripts/make-vocal-manifest.mjs),
// so this cast just restates that contract for the type checker.
const vocalManifest = vocalManifestJson as VocalManifestEntry[];
// Same build-time-JSON-import cast pattern as vocalManifest above —
// src/data/lessons-seed.json is committed empty ([]) today; the shape is
// guaranteed by lesson-ledger.ts's own event union, not re-validated here.
const LESSONS_SEED = lessonsSeedJson as LessonEvent[];
// Craft pass #2, Part 1 — same build-time-JSON-import cast pattern as
// vocalManifest/LESSONS_SEED above; scripts/build-vocal-maps.mjs's own pure
// interval-derivation logic (src/lib/vocal-map.ts's buildVocalIntervalsFromLines)
// guarantees the shape, not re-validated here.
const VOCAL_MAPS = vocalMapsJson as unknown as VocalMapFile;
// Party-length selector (Part 4) — Off (null) + four preset lengths, minutes converted to seconds once here.
const PARTY_LENGTH_OPTIONS: { label: string; seconds: number | null }[] = [
  { label: "Off", seconds: null },
  { label: "1h", seconds: 3600 },
  { label: "2h", seconds: 7200 },
  { label: "3h", seconds: 10800 },
  { label: "4h", seconds: 14400 },
];
// Vocal-clash awareness (Part 1): the minimum instrumental-gap length considered
// a real "next vocal gap" — matches the ~8s FACTS convention buildVocalIntervalsFromLines
// already uses for capping a lone line's span.
const VOCAL_GAP_MIN_SECONDS = 8;
// Phrase-aligned firing (Part 2): up to 4 candidate phrase boundaries, capped
// at 16 output-seconds out — never let a wait push a transition audibly late.
const PHRASE_CANDIDATE_COUNT = 4;
const PHRASE_CANDIDATE_CAP_SECONDS = 16;
// Audio engine v2, Part 2 (beat rolls) — the manual pad and the brain's fx
// enum both name a roll by its full fx name ("roll_eighth" etc, matching
// src/lib/brain.ts's FxCommandSchema); this maps that name back to
// roll.ts's own RollSubdivision, shared by handleRollButton (manual pad) and
// executeFxCommand (brain-driven) so there's exactly one mapping to keep in
// sync with the enum, not two.
type RollFxName = "roll_eighth" | "roll_quarter" | "roll_half";
const ROLL_SUBDIVISION_BY_FX: Record<RollFxName, RollSubdivision> = {
  roll_eighth: "1/8",
  roll_quarter: "1/4",
  roll_half: "1/2",
};
// Audio engine v2, Part 1 — maskFx "space_sweep": a filter sweep + echo tail
// + reverb wash on the OUTGOING deck instead of a one-shot sample. Fixed
// tuning (not brain-controlled, same posture as every other maskFx choice —
// the brain only picks WHICH stinger/texture, never its parameters).
const SPACE_SWEEP_HPF_TARGET_HZ = 1200; // sweeps the low end away — "something's changing" texture
const SPACE_SWEEP_SWEEP_SECONDS = 1.5;
const SPACE_SWEEP_REVERB_WET = 0.35;
const SPACE_SWEEP_ECHO_BEATS: 0.75 | 1 = 1;
const SPACE_SWEEP_ECHO_FEEDBACK = 0.5;
const SPACE_SWEEP_ECHO_WET = 0.35;
const SPACE_SWEEP_ECHO_RING_SECONDS = 2;
import { summarizeLessons, type TransitionRecord } from "@/lib/lessons";
import { loadTransitionRecords, appendTransitionRecord, updateTransitionRecordRating } from "@/lib/history-store";
import {
  buildManifestTagIndex,
  hasUsableTags,
  type CrateTrackListing,
  type CrateManifestEntry,
} from "@/lib/crate";
import { loadCostTotal, saveCostTotal, resetCostTotal } from "@/lib/cost-store";
import { fetchTagHeader } from "@/lib/crate-lazy";
import { runWithConcurrency, sleep } from "@/lib/concurrency";
import { getTrackBlob, createIndexedDbStore } from "@/lib/track-cache";
import { loadCrateList, saveCrateList, reconcileCrateList, type PersistedCrateEntry } from "@/lib/crate-store";
import {
  loadCueStore,
  saveCueStore,
  cueTrackKey,
  getCues,
  setCues,
  addCue,
  updateCueAction,
  deleteCue,
  nudgeCue,
  seedSuggestedCues,
  type CueStore,
  type Cue,
  type CueSuggestionsFile,
} from "@/lib/cue-store";
import { upcomingCues, computeExpectedFireAtMs, shouldRearm } from "@/lib/cue-schedule";
import cueSuggestionsJson from "@/data/cue-suggestions.json";
import crateManifestJson from "@/data/crate-manifest.json";
import { glideStepCount, nextGlideTempo, TEMPO_GLIDE_STEP_MS, TEMPO_GLIDE_START_DELAY_MS } from "@/lib/tempo-glide";
import { parseResidencyRequest, applyResidencyParse, isResidencyConsultDue, type ResidencyRequest } from "@/lib/residency";
import { findDownParts, pickDownPart } from "@/lib/down-part";
import {
  planHeldLoop,
  fireIsolatedLoopHold,
  sampleMixEnvelope,
  sampleMixHandoffIsLate,
  SAMPLE_MIX_TIMER_LATE_TOLERANCE_MS,
  type HeldLoopHandle,
  type LoopHoldStemSource,
} from "@/lib/loop-hold";
import {
  getLoopPoints,
  pickLoopCandidate,
  selectMashupEntryPoint,
  selectMidTrackEntryPoint,
  selectMidTrackExitPoint,
  type LoopPointsFile,
} from "@/lib/loop-points";
import LOOP_POINTS from "@/data/loop-points.json";
import { planStemMigration, planFullSongMashup } from "@/lib/stem-migration";
import { abortable, stemClock, planTranceBreakdown, STEM_PREPARE_SECONDS, STEM_TAIL_SECONDS, STEM_MEMORY_BYTES, STEM_HANDOFF_SECONDS } from "@/lib/stem-performance";
import {
  loadStemSet, loadStemLoopMixBuffer, startStemSet, disposeStemSet, scheduleMigration,
  type StemSet, type StemManifestEntry,
} from "@/lib/stems";
import STEM_MANIFEST from "@/data/stem-manifest.json";
import BEAT_IN from "@/data/beat-in.json";
import { compatibleLoopPoints, isPartnerDanceTrackName, isTranceTrackName, type TransitionRecipe, type TransitionRecipeFile } from "@/lib/transition-recipes";
import TRANSITION_RECIPES from "@/data/transition-recipes.json";
import {
  loadFxDemonstrations,
  appendFxDemonstration,
  summarizeFxDemonstrations,
  type FxDemonstrationEntry,
} from "@/lib/fx-log";
import styles from "./page.module.css";

// scripts/suggest-cues.mjs's committed output (build-time JSON import, same
// pattern as crate-manifest.json/vocal-manifest.json) — the generator's own
// pure logic guarantees this shape, see src/lib/cue-store.ts's
// CueSuggestionsFile/CueSuggestionEntry.
const CUE_SUGGESTIONS = cueSuggestionsJson as CueSuggestionsFile;

// Crate manifest's local-tag-matched data (M6.2 probe-storm fix, see
// CLAUDE_STATE.md) — indexed once by Drive file id at module scope, so
// handleAddAllFromDrive's per-track lookup is O(1) instead of scanning the
// whole manifest per track. Consulted regardless of whether the crate
// LISTING itself came from this same manifest or (as in production today) a
// live Drive API call — see buildManifestTagIndex()'s own doc comment.
const CRATE_MANIFEST_TAG_INDEX = buildManifestTagIndex(crateManifestJson as CrateManifestEntry[]);
const PLAYBACK_MANIFEST = new Map((crateManifestJson as CrateManifestEntry[]).map(entry => [entry.id, entry]));
const CURRENT_LOOP_POINTS = compatibleLoopPoints((crateManifestJson as CrateManifestEntry[]).map(t => ({ ...t, source: "drive" as const, size: t.size ?? null, bpm: t.bpm ?? null, key: t.key ?? null, durationSeconds: t.durationSeconds ?? null, grid: t.grid ?? null })), LOOP_POINTS as LoopPointsFile);

const STUDIO_TRACK_IDS = new Set([
  "el_cerebro_dembow_fuego",
  "supermercado_salsa_brava",
  "medianoche_tech_guaracha",
  "costa_dorada_bachata_vip",
]);

interface StudioVipTrackMeta {
  id: string;
  title: string;
  subtitle: string;
  genre: string;
  bpm: number;
  camelot: string;
  key: string;
  lufs: number;
  accent: string;
}

const STUDIO_VIP_TRACKS: StudioVipTrackMeta[] = [
  {
    id: "el_cerebro_dembow_fuego",
    title: "El Cerebro — Dembow Fuego",
    subtitle: "VIP Club Mix · RoFormer + HTDemucs 4-Stem",
    genre: "Reggaeton / Dembow",
    bpm: 96,
    camelot: "8A",
    key: "Am",
    lufs: -14.4,
    accent: "#f97316",
  },
  {
    id: "supermercado_salsa_brava",
    title: "Supermercado — Salsa Brava",
    subtitle: "Descarga en Vivo · Brass & Montuno 4-Stem",
    genre: "Salsa / Tropical",
    bpm: 104,
    camelot: "9A",
    key: "Em",
    lufs: -14.5,
    accent: "#eab308",
  },
  {
    id: "medianoche_tech_guaracha",
    title: "Medianoche — Tech Guaracha",
    subtitle: "Aleteo Club Tool · Tribal Brass 4-Stem",
    genre: "Latin Tech House / Guaracha",
    bpm: 126,
    camelot: "11A",
    key: "F#m",
    lufs: -14.5,
    accent: "#06b6d4",
  },
  {
    id: "costa_dorada_bachata_vip",
    title: "Costa Dorada — Bachata Sensual",
    subtitle: "VIP Dub · Requinto & Bongó 4-Stem",
    genre: "Bachata",
    bpm: 120,
    camelot: "6A",
    key: "Gm",
    lufs: -13.7,
    accent: "#ec4899",
  },
];

const PAISA_VOCAL_LABELS: Record<string, { phrase: string; vibe: string }> = {
  "drop-cerebro-nohands.mp3": { phrase: "¡El Cerebro — Sin Manos!", vibe: "Signature Drop" },
  "drop-cheer-cerebro.mp3": { phrase: "Crowd Roar + ¡El Cerebro!", vibe: "Stadium Drop" },
  "drop-horseman.mp3": { phrase: "¡El Jinete Del Perreo!", vibe: "Heavy Drop" },
  "drop-ones-twos.mp3": { phrase: "En Los Controles 1 & 2", vibe: "Booth Drop" },
  "drop-purocerebro-laser.mp3": { phrase: "¡Puro Cerebro! + Laser", vibe: "Laser Drop" },
  "tag-dale.mp3": { phrase: "¡Dale, El Cerebro!", vibe: "DJ Tag" },
  "tag-horseman.mp3": { phrase: "El Jinete En La Casa", vibe: "DJ Tag" },
  "tag-jinete.mp3": { phrase: "¡Jinete Paisa!", vibe: "DJ Tag" },
  "tag-look-mom.mp3": { phrase: "¡Mira Mamá, Sin Manos!", vibe: "DJ Tag" },
  "tag-ones-twos.mp3": { phrase: "Partiendo La Pista", vibe: "DJ Tag" },
  "tag-puro-cerebro.mp3": { phrase: "¡Puro Cerebro Papá!", vibe: "DJ Tag" },
  "tag2-eyyy.mp3": { phrase: "¡Eyyy Qué Chimba!", vibe: "Paisa Tag" },
  "tag2-fiesta.mp3": { phrase: "¡Se Prendió La Fiesta!", vibe: "Party Tag" },
  "tag2-fuego.mp3": { phrase: "¡Puro Fuego En La Pista!", vibe: "Fire Tag" },
  "tag2-manos.mp3": { phrase: "¡Arriba Las Manos!", vibe: "Hype Tag" },
  "tag2-nopare.mp3": { phrase: "¡No Pare, Sigue Sigue!", vibe: "Anthem Tag" },
  "tag2-sube.mp3": { phrase: "¡Súbele El Bajo!", vibe: "Bass Tag" },
  "cue-abajo-hype.mp3": { phrase: "¡Hasta Abajo! 🔥", vibe: "Hype Cue" },
  "cue-dale-hype.mp3": { phrase: "¡Dale Duro! 🔥", vibe: "Hype Cue" },
  "cue-escuche-hype.mp3": { phrase: "¡Que Se Escuche! 🔥", vibe: "Hype Cue" },
  "cue-eso-hype.mp3": { phrase: "¡Eso, Rompe! 🔥", vibe: "Hype Cue" },
  "cue-manos-hype.mp3": { phrase: "¡Manos Arriba! 🔥", vibe: "Hype Cue" },
  "cue-abajo-warm.mp3": { phrase: "Bajando Suave 🌴", vibe: "Warm Cue" },
  "cue-dale-warm.mp3": { phrase: "Dale Con Calma 🌴", vibe: "Warm Cue" },
  "cue-escuche-warm.mp3": { phrase: "Escucha Este Ritmo 🌴", vibe: "Warm Cue" },
  "cue-eso-warm.mp3": { phrase: "Eso Mismo Mi Gente 🌴", vibe: "Warm Cue" },
  "cue-manos-warm.mp3": { phrase: "Sube La Mano Suave 🌴", vibe: "Warm Cue" },
  "adlib-asimismo.mp3": { phrase: "¡Así Mismo!", vibe: "Paisa Ad-Lib" },
  "adlib-eso.mp3": { phrase: "¡Eso Es!", vibe: "Paisa Ad-Lib" },
  "adlib-otra.mp3": { phrase: "¡Otra, Otra!", vibe: "Paisa Ad-Lib" },
  "adlib-oyeme.mp3": { phrase: "¡Óyeme Bien!", vibe: "Paisa Ad-Lib" },
  "adlib-padonde.mp3": { phrase: "¿Pa' Dónde Vas?", vibe: "Paisa Ad-Lib" },
  "adlib-sepone.mp3": { phrase: "¡Se Pone Bueno!", vibe: "Paisa Ad-Lib" },
  "adlib-wepa.mp3": { phrase: "¡Wepa!", vibe: "Paisa Ad-Lib" },
  "crowd-callresponse.mp3": { phrase: "¡Oye! ¡Eh! ¡Oh!", vibe: "Call & Response" },
  "crowd-countdown.mp3": { phrase: "¡3, 2, 1… Dale!", vibe: "Drop Countdown" },
  "crowd-manos.mp3": { phrase: "¡Las Manos Todo El Mundo!", vibe: "Crowd Chant" },
  "crowd-palante.mp3": { phrase: "¡Pa'lante Mi Gente!", vibe: "Crowd Chant" },
};

type StemRoleKey = "vocals" | "drums" | "bass" | "other";
const STEM_ROLES: { key: StemRoleKey; label: string; icon: string; model: string; color: string }[] = [
  { key: "vocals", label: "Vocals", icon: "🎤", model: "BS-RoFormer SDR 12.9", color: "#f43f5e" },
  { key: "drums", label: "Drums / Beat", icon: "🥁", model: "HTDemucs 6-Stem", color: "#f59e0b" },
  { key: "bass", label: "Bassline", icon: "🎸", model: "HTDemucs 6-Stem", color: "#8b5cf6" },
  { key: "other", label: "Horns / Melody / Synth", icon: "🎺", model: "Horns + Synth + Guitar + Keys", color: "#06b6d4" },
];

function resolveAudioAssetUrl(idOrPath: string): { url: string } {
  if (idOrPath.startsWith("/audio/")) {
    return { url: idOrPath };
  }
  if (STUDIO_TRACK_IDS.has(idOrPath)) {
    return { url: `/audio/tracks/${idOrPath}.mp3` };
  }
  return { url: `/api/crate/${encodeURIComponent(idOrPath)}` };
}

// Drive tag-probe throttle (M6.2 probe-storm fix): a manifest/already-known
// hit skips the network entirely (no throttle needed), but a genuinely
// unknown track still costs one real Range request to Google Drive — capped
// to a low concurrency with a short pause after each real fetch so a
// mostly-untagged crate doesn't fire a burst that looks like abuse to
// Google's rate limiter (the actual cause of the "Sorry..." 403 storm this
// fix responds to).
const CRATE_TAG_PROBE_CONCURRENCY = 3;
const CRATE_TAG_PROBE_DELAY_MS = 300;

// Vocal-clip manifest is a build-time JSON import (same pattern as
// src/data/crate-manifest.json) — grouping by category is a pure, one-time
// computation at module scope, not per-render.
const VOCAL_GROUPS = groupManifestByCategory(vocalManifest);
const VOCAL_PAD_LABELS: Record<VocalCategory, string> = {
  tag: "Tag",
  drop: "Drop",
  adlib: "Adlib",
  crowd: "Crowd",
  cue_warm: "Cue-",
  cue_hype: "Cue+",
  shoutout: "Shout-out",
};

const TEMPO_MIN = 0.92;
const TEMPO_MAX = 1.08;
const TEMPO_STEP = 0.005;
const CENTER_SNAP_WINDOW = 0.004; // how close to 1.0 counts as "the detent"
const NUDGE_MS = 20; // manual nudge step, in OUTPUT (wall-clock) milliseconds
const AUTOPILOT_POLL_MS = 1000;
// Craft pass #2, Part 2: bumped from 45 to 60 — phrase-aligned firing can now
// delay a transition's actual start by up to PHRASE_CANDIDATE_CAP_SECONDS
// (16s) past the brain's own response, so the early-consult margin needs
// enough headroom that a phrase wait never pushes the transition past the
// live track's own mix-out point into a dead outro.
const AUTOPILOT_REMAINING_THRESHOLD_SECONDS = 60;
const AUTOPILOT_RETRY_DELAY_MS = 10000;
// Review-panel fix: the opener/per-track "already asked" guard used to be a
// permanent sentinel — if the brain answered "none" or the queued track
// failed to load, autopilot went silent forever with the toggle still ON.
// Now it's a timestamp: the opener guard is allowed to re-ask after this
// window if nothing is live yet, and executeQueueCommand's failure paths
// clear it immediately (see askedForTrackRef below).
const AUTOPILOT_OPENER_REASK_MS = 60000;
// Review-panel fix: a hard floor under the brain's own ~10-minute fx
// frequency cap — an AUTOPILOT-driven call (message was null) that requests
// fx sooner than this after the last one fires is skipped outright, even if
// the brain's own judgment slipped. A human-typed vibe note is exempt (the
// human asked directly, in the moment) — only autopilot-driven calls with
// no accompanying message are floored.
const AUTOPILOT_FX_COOLDOWN_SECONDS = 120;
// M7 Phase 3 — the cadence budget is split by CLASS. The 120s floor above was
// written for STINGERS (a horn every 90s is worse than silence, per the
// 2026-07-26 FX research) but it was applied to every fx, so a beat roll cost
// the same budget as an airhorn. That is why El Cerebro never performed and
// Jason ended up pressing the pads himself. Performance moves — rolls, the
// band-isolated hold, EQ kills — are craft, not punctuation: a real
// open-format DJ touches them constantly, so they get a much looser floor.
// Salsa/bachata total suppression is a separate gate entirely and is
// untouched by this split.
const AUTOPILOT_PERFORMANCE_COOLDOWN_SECONDS = 10;
// Longest a queue/routine/migration can legitimately be "in flight" before the
// watchdog assumes it died. 90s sample_mix hold + 16s phrase wait + decode, with margin.
const QUEUE_INFLIGHT_STALE_SECONDS = 150;
// Cheap-DJ mode: routine autopilot handoffs should usually come from the
// precomputed catalog recipes, not from a fresh model call. Fresh human notes
// still go to the brain, and every few local handoffs we ask the brain again
// so set-level taste can course-correct instead of locking into one heuristic.
const LOCAL_RECIPE_FRESH_NOTE_SECONDS = 45;
const LOCAL_RECIPE_AI_REFRESH_MOVES = 4;
// The held loop IS the mix while it runs, so the deck under it is ducked
// deeper than a roll's -15dB (roll.ts) — the captured slice should read as
// the whole record, not as a layer over it.
const HELD_LOOP_DUCK_DB = -40;
const HELD_LOOP_DUCK_RAMP_SECONDS = 0.08;
// Deck.duck() uses setTargetAtTime, whose argument is a time constant rather
// than a finish duration. Five constants gets the retired deck effectively
// silent before the phrase-scheduled overlay begins.
const HELD_LOOP_DUCK_LEAD_SECONDS = HELD_LOOP_DUCK_RAMP_SECONDS * 5;
// How far before a hold's exit to re-consult the brain so the incoming track
// is picked, downloaded and decoded in time to land on the "1". page.tsx's
// own measurement of the queue path is ~16s past the brain's response.
const HELD_LOOP_HANDOFF_LEAD_SECONDS = 18;
// A drop-relative entry must still leave real airtime before the track's own
// analyzed mix-out — entering 20s before the outro is not a mid-track entry.
const MIN_ENTRY_RESIDENCY_SECONDS = 45;
// Length of the El Cerebro name-drop clip (tag2-nopare.mp3, 2.85s) — a down
// part has to hold it with air to spare or it is not a usable placement.
const NAME_DROP_CLIP_SECONDS = 2.9;
// Deferred re-consult (owner soundcheck fix): if brainBusy at the scheduled
// followUpSeconds fire time, retry once after this short delay, then drop
// with a log line rather than queueing indefinitely — see fireFollowUp().
const FOLLOW_UP_BUSY_RETRY_MS = 2000;
const BRAIN_LOG_LIMIT = 20;
const HISTORY_LIMIT = 10;
const NEUTRAL_BPM_FALLBACK = 120; // used only when a crate track has no BPM tag, so tempo math stays finite
const EQ_MIN_DB = -40;
const EQ_MAX_DB = 6;
const TRANSITION_HISTORY_PANEL_LIMIT = 5; // M4 Part D: how many recent transition records the rating UI shows

// --- Cue points (rehearsal-marked, lyric-timed vocal fires) ---
const CUE_NUDGE_SECONDS = 0.25; // ±250ms fine-tune per the dispatch
const SINGALONG_DEFAULT_DURATION_SECONDS = 8;
const SINGALONG_MIN_DURATION_SECONDS = 1;
const SINGALONG_MAX_DURATION_SECONDS = 60;
// Sing-along duck is DEEPER than the vocal-clip auto-duck (~35% / ~-9.12dB,
// src/lib/vocal.ts) — the crowd IS the vocalist here, so the music needs to
// duck further out of the way. Deck.duck() already takes a dB depth
// parameter (see its own doc comment), so no deck.ts change is needed to
// support a second, deeper duck level — just a different constant.
const SINGALONG_DUCK_TARGET = 0.15; // ~15% per the dispatch
const SINGALONG_DUCK_DB = 20 * Math.log10(SINGALONG_DUCK_TARGET); // ~-16.48dB
const SINGALONG_DUCK_RAMP_SECONDS = 0.12; // ~120ms per the dispatch

type EqBand = "low" | "mid" | "high";
type EqValues = { low: number; mid: number; high: number };
const FLAT_EQ: EqValues = { low: 0, mid: 0, high: 0 };

/** mm:ss formatting for cue timestamps (rehearsal mark list, MARK button). Pure, module-scope — no deck/audio dependency. */
function formatMmSs(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const minutes = Math.floor(clamped / 60);
  const seconds = Math.floor(clamped % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** One armed live-fire timer per deck — see the cue scheduler section in Home() for the design rationale. */
interface ArmedCue {
  timeoutId: ReturnType<typeof setTimeout>;
  atSeconds: number;
  expectedAtMs: number;
}

const FIXTURE_A = { url: "/fixtures/test-120bpm.mp3", name: "test-120bpm.mp3" };
const FIXTURE_B = { url: "/fixtures/test-100bpm.mp3", name: "test-100bpm.mp3" };

type Status = "idle" | "loading" | "ready" | "error";
type DeckLabel = "A" | "B";

type WakeLockSentinelLike = { release: () => Promise<void> };
type NavigatorWithWakeLock = Navigator & {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
};

function makeTrackId(name: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// --- M5: optional passcode gate, client side ---------------------------------
// Server routes (/api/dj, /api/crate, /api/crate/[id]) 401 with
// {"error":"passcode required"} when DJ_PASSCODE is set and the header is
// missing/wrong. This wrapper attaches any stored passcode, and on a 401
// prompts once, stores it, and retries — a wrong passcode surfaces as an
// honest notice via the normal error-handling path in each caller (the retry
// itself just 401s again; callers already log/display fetch failures).
const PASSCODE_STORAGE_KEY = "djsm.passcode";

function getStoredPasscode(): string | null {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(PASSCODE_STORAGE_KEY) : null;
  } catch {
    return null;
  }
}

function setStoredPasscode(value: string): void {
  try {
    window.localStorage.setItem(PASSCODE_STORAGE_KEY, value);
  } catch {
    // ignore — e.g. storage disabled
  }
}

async function fetchWithPasscode(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const stored = getStoredPasscode();
  if (stored) headers.set("x-dj-passcode", stored);

  const response = await fetch(url, { ...init, headers });
  if (response.status !== 401) return response;

  const entered = typeof window !== "undefined" ? window.prompt("DJ passcode required:") : null;
  if (!entered) return response; // user cancelled — surface the original 401 to the caller

  setStoredPasscode(entered);
  const retryHeaders = new Headers(init.headers);
  retryHeaders.set("x-dj-passcode", entered);
  return fetch(url, { ...init, headers: retryHeaders });
}

// Lazy-crate architecture (large-library re-architecture — see
// CLAUDE_STATE.md): a crate entry is metadata-first. Drive entries carry NO
// File blob at all — full audio is fetched on demand (deck load / autopilot
// queue) and cached in IndexedDB, see getTrackForPlayback()/track-cache.ts.
// Local file-picker entries keep their in-memory File exactly as before
// (unchanged behavior — they never needed a network round trip to begin
// with, and can't survive a reload anyway, so there's nothing lazy to gain).
interface CrateTrack {
  id: string;
  name: string;
  title?: string | null;
  artist?: string | null;
  genre?: string | null;
  genreSource?: GenreSource;
  size: number | null;
  bpm: number | null;
  key: string | null;
  grid: SeratoBeatgrid | null;
  source: "drive" | "local";
  /** Present only for source === "local". */
  file?: File;
}

/**
 * All the React state + handlers for a single deck. The actual audio graph
 * lives in Deck (src/lib/deck.ts, UI-free); this hook is just the glue that
 * lets the page bind it to inputs. Called once per deck (A and B) below.
 */
function useDeckController(
  core: AudioCore,
  fixture: { url: string; name: string },
  opts: {
    onCueKeyKnown?: (key: string) => void;
    /** Post-transition tempo-recovery glide (owner soundcheck fix): cancels THIS deck's glide, if one is running — invoked on a manual tempo-slider move or when the track ends, since both mean the glide should stop steering this deck's tempo. */
    onTempoGlideCancel?: () => void;
    /** Phrase-aligned firing (Part 2): a manual pause on THIS deck means the DJ took over — cancel any pending phrase-delayed transition start (see page.tsx's pendingTransitionTimeoutRef/cancelPendingTransitionStart()). */
    onManualPause?: () => void;
    /** Manual Play on THIS deck: stops any background 4-Stem Mixer or secondary deck so two tracks never play at once. */
    onManualPlay?: () => void;
  } = {}
) {
  const deckRef = useRef<Deck | null>(null);
  if (!deckRef.current) deckRef.current = new Deck(core);

  const pendingBufferRef = useRef<ArrayBuffer | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Mirror isDecoded/tempo in refs so async helpers chained without an
  // intervening render (loadFile -> decodeIfNeeded, both awaited back to
  // back by the brain's queue executor) read the FRESH value rather than a
  // stale one captured before this render's setState calls have flushed.
  const isDecodedRef = useRef(false);
  const tempoRef = useRef(1);

  const [trackId, setTrackId] = useState<string | null>(null);
  const [trackName, setTrackName] = useState<string | null>(null);
  const [, setMetadata] = useState<PlaybackMetadata>({ tags: {}, grid: null, gridSource: null });
  const metadataRef = useRef<PlaybackMetadata>({ tags: {}, grid: null, gridSource: null });
  const metadataTrackRef = useRef<{ id: string; source: "drive" | "local"; size: number } | null>(null);
  function publishMetadata(next: PlaybackMetadata) {
    metadataRef.current = next;
    setMetadata(next);
  }
  const [status, setStatus] = useState<Status>("idle");
  const [isDecoded, setIsDecoded] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [tempo, setTempo] = useState(1);
  const [progress, setProgress] = useState(0);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  // M4 Part A: per-deck 3-band EQ. Deliberately NOT reset on a new track
  // load (unlike tempo) — EQ persists across a deck's track changes, same
  // as a physical mixer channel's EQ knobs staying wherever the DJ left
  // them; the underlying Deck's filter nodes already work this way for
  // free (they're created once, not recreated on decode()), this just
  // keeps the UI state consistent with that.
  const [eq, setEqState] = useState<EqValues>(FLAT_EQ);
  const [eqKilled, setEqKilled] = useState<{ low: boolean; mid: boolean; high: boolean }>({
    low: false,
    mid: false,
    high: false,
  });

  // In-and-out mixing (2026-07-28): this deck's analyzed mix-in/mix-out
  // points for whichever track is currently loaded (see page.tsx's
  // analyzeMixPoints()/executeQueueCommand()) — null until analysis has run
  // for this load. Reset on every new loadFromBlob, same lifecycle as
  // tags/grid above.
  const [mixPoints, setMixPoints] = useState<MixPoints | null>(null);
  // M7 Phase 5: the per-second RMS profile computed during mix-point
  // analysis, kept so down-part detection can reuse it instead of
  // re-walking the decoded buffer every time deckLiveState() runs.
  const [rmsProfile, setRmsProfile] = useState<number[] | null>(null);
  // When this deck actually went live (Date.now(), OUTPUT/wall-clock time) —
  // feeds DjLiveState.playedSeconds. Ref, not state: nothing renders off it
  // directly, deckLiveState() just reads it at request-build time.
  const wentLiveAtRef = useRef<number | null>(null);

  useEffect(() => {
    const deck = deckRef.current!;
    const unsubscribeProgress = deck.onProgress((update: ProgressUpdate) => {
      setProgress(update.percentagePlayed);
    });
    const unsubscribeEnded = deck.onEnded(() => {
      setIsPlaying(false);
      setProgress(0);
      // Owner soundcheck fix: a track ending must cancel any pending
      // tempo-recovery glide targeting this deck immediately, not wait for
      // the glide's own isPlaying check on its next ~500ms tick.
      opts.onTempoGlideCancel?.();
    });
    return () => {
      unsubscribeProgress();
      unsubscribeEnded();
      deck.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadFromBlob(blob: Blob, name: string, id: string | null = null, source: "drive" | "local" = "local") {
    setStatus("loading");
    setTrackId(id ?? name);
    setTrackName(name);
    publishMetadata({ tags: {}, grid: null, gridSource: null });
    metadataTrackRef.current = { id: id ?? name, source, size: blob.size };
    setMixPoints(null); // in-and-out mixing: a new track needs fresh analysis
    setRmsProfile(null);
    wentLiveAtRef.current = null;
    // Cue-point keying (see src/lib/cue-store.ts's cueTrackKey doc comment):
    // Drive tracks use their real Drive file id (stable across a reload);
    // local tracks use name+size instead of whatever id this load happened
    // to be called with (a crate-tap's local entry carries only a random
    // uuid, not stable identity) — cueTrackKey() picks the right branch off
    // `source` regardless of what `id` is.
    opts.onCueKeyKnown?.(cueTrackKey({ source, id: id ?? "", name, size: blob.size }));
    isDecodedRef.current = false;
    setIsDecoded(false);
    setIsPlaying(false);
    setProgress(0);
    tempoRef.current = 1;
    setTempo(1);
    setSyncNotice(null);
    setEqState(FLAT_EQ);
    setEqKilled({ low: false, mid: false, high: false });
    deckRef.current?.setEq(FLAT_EQ);
    deckRef.current?.allNeutral();
    deckRef.current?.pause();

    // ID3/Serato parsing is best-effort and never blocks playback/tempo controls.
    try {
      const file = blob instanceof File ? blob : new File([blob], name);
      const [parsedTags, parsedGrid] = await Promise.all([
        parseId3Tags(file),
        parseSeratoBeatgrid(file),
      ]);
      publishMetadata({ tags: parsedTags, grid: parsedGrid, gridSource: parsedGrid ? "embedded" : null });
    } catch {
      publishMetadata({ tags: {}, grid: null, gridSource: null });
    }

    try {
      pendingBufferRef.current = await blob.arrayBuffer();
      setStatus("ready");
    } catch {
      pendingBufferRef.current = null;
      setStatus("error");
    }
  }

  /** Public load — used by "Load MP3", the crate ("tap a track -> load to idle deck"), and the brain's queue executor. Accepts a Blob (not just a File) so lazily-downloaded/IndexedDB-cached Drive tracks (see getTrackForPlayback() in page.tsx) can load without ever being wrapped back into a File. Loads only; does not decode or play. `source` defaults to "local" (the fixture/file-picker paths); crate-backed loads pass the CrateTrack's own source through — see cueTrackKey()'s branch on it above. */
  async function loadFile(file: File | Blob, name: string, id?: string, source: "drive" | "local" = "local"): Promise<void> {
    await loadFromBlob(file, name, id ?? name, source);
  }

  /** Decode the currently-loaded pending buffer if not already decoded. Safe to call more than once. Ref-backed (not state-backed) so it's safe to call immediately after loadFile in the same async chain. */
  async function decodeIfNeeded(signal?: AbortSignal): Promise<boolean> {
    if (isDecodedRef.current) return true;
    if (!pendingBufferRef.current) return false;
    const deck = deckRef.current!;
    try {
      const decoded = await deck.decode(pendingBufferRef.current, signal);
      const identity = metadataTrackRef.current;
      if (identity) publishMetadata(playbackMetadata(metadataRef.current.tags, metadataRef.current.grid,
        identity, PLAYBACK_MANIFEST.get(identity.id), decoded.duration));
      deck.setTempo(tempoRef.current);
      isDecodedRef.current = true;
      setIsDecoded(true);
      return true;
    } catch {
      if (signal?.aborted) return false;
      setStatus("error");
      return false;
    }
  }

  async function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-picking the same file later
    if (!file) return;
    opts.onManualPause?.();
    await loadFromBlob(file, file.name);
  }

  async function handleLoadTestTrack() {
    opts.onManualPause?.();
    setStatus("loading");
    try {
      const response = await fetch(fixture.url);
      if (!response.ok) throw new Error(`fixture fetch failed: ${response.status}`);
      const blob = await response.blob();
      await loadFromBlob(blob, fixture.name);
    } catch {
      setStatus("error");
    }
  }

  async function handlePlayPause() {
    const deck = deckRef.current!;

    if (isPlaying) {
      deck.pause();
      setIsPlaying(false);
      opts.onManualPause?.();
      return;
    }

    // Create/resume the shared AudioContext synchronously in this tap
    // handler — required by iOS Safari's autoplay policy.
    deck.ensureContext();

    const ok = await decodeIfNeeded();
    if (!ok) return;

    opts.onManualPlay?.();
    deck.play();
    wentLiveAtRef.current = Date.now(); // in-and-out mixing: feeds DjLiveState.playedSeconds
    setIsPlaying(true);
  }

  function handleTempoChange(event: React.ChangeEvent<HTMLInputElement>) {
    let value = parseFloat(event.target.value);
    if (Math.abs(value - 1) < CENTER_SNAP_WINDOW) value = 1; // center detent
    tempoRef.current = value;
    setTempo(value);
    setSyncNotice(null);
    deckRef.current?.setTempo(value);
    // Owner soundcheck fix: the DJ taking manual control of this deck's
    // tempo means the auto-recovery glide should stop steering it.
    opts.onTempoGlideCancel?.();
  }

  function handleResetTempo() {
    tempoRef.current = 1;
    setTempo(1);
    setSyncNotice(null);
    deckRef.current?.setTempo(1);
  }

  /** Set tempo precisely (no center-snap) — used by Beat Sync and the transition engine's onTempoSet mirror. */
  function setTempoDirectly(value: number) {
    tempoRef.current = value;
    setTempo(value);
    deckRef.current?.setTempo(value);
  }

  /**
   * Manual nudge fallback for by-ear correction: ms is OUTPUT (wall-clock)
   * time, converted to a SOURCE-seconds seek via the current tempo (a shift
   * of X output-seconds = X * tempo source-seconds — same conversion
   * beatclock.ts uses for the automatic phase-align step).
   */
  function handleNudge(ms: number) {
    deckRef.current?.seekBy((ms / 1000) * tempo);
  }

  /** Pure state mirrors for the transition engine, which plays/pauses the raw Deck directly. */
  function markPlaying() {
    wentLiveAtRef.current = Date.now(); // in-and-out mixing: feeds DjLiveState.playedSeconds
    setIsPlaying(true);
  }
  function markPaused() {
    setIsPlaying(false);
  }

  // --- EQ (M4 Part A) ---

  function handleEqChange(band: EqBand, value: number) {
    const clamped = Math.min(EQ_MAX_DB, Math.max(EQ_MIN_DB, value));
    setEqState((prev) => ({ ...prev, [band]: clamped }));
    setEqKilled((prev) => ({ ...prev, [band]: false })); // moving the slider clears any kill state for that band
    deckRef.current?.setEq({ [band]: clamped });
  }

  function handleKillToggle(band: EqBand) {
    setEqKilled((prev) => {
      const next = !prev[band];
      const deck = deckRef.current;
      if (deck) {
        if (band === "low") deck.killLow(next);
        else if (band === "mid") deck.killMid(next);
        else deck.killHigh(next);
      }
      setEqState((eqPrev) => ({ ...eqPrev, [band]: next ? EQ_MIN_DB : 0 }));
      return { ...prev, [band]: next };
    });
  }

  function handleResetEq() {
    setEqState(FLAT_EQ);
    setEqKilled({ low: false, mid: false, high: false });
    deckRef.current?.setEq(FLAT_EQ);
  }

  return {
    deck: deckRef.current,
    fileInputRef,
    trackId,
    trackName,
    // Async executors retain a controller across load/decode awaits. Getters
    // read this load's metadata immediately, without waiting for React render.
    get tags() { return metadataRef.current.tags; },
    get grid() { return metadataRef.current.grid; },
    get gridSource() { return metadataRef.current.gridSource; },
    status,
    isDecoded,
    isPlaying,
    tempo,
    progress,
    syncNotice,
    setSyncNotice,
    eq,
    eqKilled,
    mixPoints,
    setMixPoints,
    rmsProfile,
    setRmsProfile,
    wentLiveAtMs: () => wentLiveAtRef.current,
    loadFile,
    decodeIfNeeded,
    markPlaying,
    markPaused,
    handleFileSelected,
    handleLoadTestTrack,
    handlePlayPause,
    handleTempoChange,
    handleResetTempo,
    setTempoDirectly,
    handleNudge,
    handleEqChange,
    handleKillToggle,
    handleResetEq,
  };
}

type DeckController = ReturnType<typeof useDeckController>;

function formatSignedPct(fraction: number): string {
  const pct = (fraction - 1) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function DeckPanel({
  label,
  accentClass,
  deckState,
  syncLabel,
  syncDisabled,
  syncDisabledReason,
  onSync,
  onJumpToBeat,
  cues,
  rehearsing,
  onToggleRehearse,
  onMark,
  onAssignClip,
  onAssignSingalong,
  onDeleteCue,
  onNudgeCue,
  crate = [],
  otherDeckTrackId = null,
  otherDeckTrackName = null,
  otherDeckBpm = null,
  otherDeckKey = null,
  onSelectCrateTrack,
  onOpenInStemStudio,
}: {
  label: string;
  accentClass: string;
  deckState: DeckController;
  syncLabel: string;
  syncDisabled: boolean;
  syncDisabledReason: string;
  onSync: () => void;
  onJumpToBeat: () => void;
  cues: Cue[];
  rehearsing: boolean;
  onToggleRehearse: () => void;
  onMark: () => void;
  onAssignClip: (index: number, file: string | null) => void;
  onAssignSingalong: (index: number, durationSeconds: number) => void;
  onDeleteCue: (index: number) => void;
  onNudgeCue: (index: number, deltaSeconds: number) => void;
  crate?: CrateTrack[];
  otherDeckTrackId?: string | null;
  otherDeckTrackName?: string | null;
  otherDeckBpm?: number | null;
  otherDeckKey?: string | null;
  onSelectCrateTrack?: (trackId: string, autoPlay?: boolean) => void;
  onOpenInStemStudio?: () => void;
}) {
  const {
    deck,
    fileInputRef,
    trackId,
    trackName,
    tags,
    grid,
    status,
    isDecoded,
    isPlaying,
    tempo,
    progress,
    syncNotice,
    eq,
    eqKilled,
    handleFileSelected,
    handleLoadTestTrack,
    handlePlayPause,
    handleTempoChange,
    handleResetTempo,
    handleNudge,
    handleEqChange,
    handleKillToggle,
    handleResetEq,
  } = deckState;

  const [deckSearch, setDeckSearch] = useState("");

  const libraryTracks = useMemo(() => {
    const base = crate.length > 0 ? crate : (crateManifestJson as CrateManifestEntry[]);
    return base
      .filter((t) => !STUDIO_TRACK_IDS.has(t.id))
      .map((t) => {
        const hasStems = usableStemEntry((STEM_MANIFEST as Record<string, StemManifestEntry>)[t.id]) !== null;
        const camelot = toCamelot(t.key ?? null) ?? t.key ?? "—";
        const cleanTitle = musicLabel(t);
        const bpmVal = t.bpm ?? null;
        return {
          id: t.id,
          title: cleanTitle,
          bpm: bpmVal,
          key: t.key ?? null,
          camelot,
          hasStems,
          hasGrid: Boolean(t.grid),
          label: `${cleanTitle} (${bpmVal ? `${Math.round(bpmVal)} BPM` : "no BPM"} · ${camelot}${hasStems ? " · 4-Stem" : ""})`,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [crate]);

  const filteredLibraryTracks = useMemo(() => {
    const q = deckSearch.trim().toLowerCase();
    if (!q) return libraryTracks;
    return libraryTracks.filter((t) => t.label.toLowerCase().includes(q));
  }, [libraryTracks, deckSearch]);

  const matchedForOtherDeck = useMemo(() => {
    if (!otherDeckBpm || otherDeckBpm <= 0) return [];
    const close = filteredLibraryTracks.filter(
      (t) =>
        t.id !== otherDeckTrackId &&
        t.id !== trackId &&
        t.bpm !== null &&
        t.bpm > 0 &&
        Math.abs(otherDeckBpm / t.bpm - 1) <= 0.065
    );
    if (close.length === 0) return [];
    const ranked = rankCandidatesByMusicTheory(
      {
        id: otherDeckTrackId ?? "other",
        name: otherDeckTrackName ?? "Other Deck",
        bpm: otherDeckBpm,
        key: otherDeckKey,
        hasStems: true,
        hasRealGrid: true,
      },
      close.map((c) => ({
        id: c.id,
        name: c.title,
        bpm: c.bpm,
        key: c.key,
        hasStems: c.hasStems,
        hasRealGrid: c.hasGrid,
      }))
    );
    const rankMap = new Map(ranked.map((r, idx) => [r.track.id, { idx, score: r.totalScore, headline: r.harmonic.headline }]));
    return [...close].sort((a, b) => (rankMap.get(a.id)?.idx ?? 999) - (rankMap.get(b.id)?.idx ?? 999));
  }, [filteredLibraryTracks, otherDeckBpm, otherDeckKey, otherDeckTrackId, otherDeckTrackName, trackId]);

  const hasTrack = trackName !== null;
  const effectiveBpm = tags.bpm ? tags.bpm * tempo : null;
  const duration = deck.duration; // used only for cue-marker positioning below

  // Live Beat & Bar Counter telemetry for this deck:
  const livePosSec = deck.positionSeconds;
  const gridBpm = grid?.bpm ?? tags.bpm ?? 120;
  const gridAnchor = grid?.anchor ?? 0;
  const beatLengthSec = 60 / Math.max(60, gridBpm);
  const barLengthSec = beatLengthSec * 4;
  const beatsFromAnchor = Math.max(0, (livePosSec - gridAnchor) / beatLengthSec);
  const currentBeatInBar = (Math.floor(beatsFromAnchor) % 4) + 1; // 1, 2, 3, 4
  const currentBarNumber = Math.floor(beatsFromAnchor / 4) + 1;
  const currentPhraseBar = (Math.floor(beatsFromAnchor / 4) % 4) + 1; // 1..4

  return (
    <section className={`${styles.deckPanel} ${accentClass}`}>
      <div className={styles.deckHeader}>
        <span className={styles.deckLabel}>{label}</span>
        <button
          type="button"
          className={styles.syncButton}
          onClick={onSync}
          disabled={syncDisabled}
          title={syncDisabled ? syncDisabledReason : undefined}
          aria-label={syncLabel}
          aria-disabled={syncDisabled}
        >
          {syncLabel}
        </button>
      </div>

      {/* 🎵 DIRECT SONG PICKER FOR THIS DECK (Pick any of the 600 Library Songs right on Deck A or Deck B!) */}
      {onSelectCrateTrack && (
        <div
          style={{
            padding: "10px 12px",
            marginBottom: 10,
            borderRadius: 10,
            background: "rgba(15, 23, 42, 0.82)",
            border: label === "Deck A" ? "1px solid rgba(56, 189, 248, 0.45)" : "1px solid rgba(249, 115, 22, 0.45)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: "0.78rem", fontWeight: 900, color: label === "Deck A" ? "#38bdf8" : "#fb923c", letterSpacing: "0.03em" }}>
              🎵 CHANGE SONG ON {label.toUpperCase()} ({libraryTracks.length} SONGS):
            </span>
            {matchedForOtherDeck.length > 0 && (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => onSelectCrateTrack(matchedForOtherDeck[0].id, false)}
                style={{
                  padding: "3px 9px",
                  fontSize: "0.74rem",
                  fontWeight: 800,
                  background: "linear-gradient(135deg, #10b981, #059669)",
                  color: "#fff",
                  borderColor: "#34d399",
                }}
                title={`Load the #1 BPM & Key match for ${otherDeckTrackName ? musicLabel({ name: otherDeckTrackName }) : "the other deck"}: ${matchedForOtherDeck[0].label}`}
              >
                🎯 Load #1 Match ({matchedForOtherDeck[0].title.slice(0, 22)})
              </button>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <input
              type="search"
              value={deckSearch}
              onChange={(e) => setDeckSearch(e.target.value)}
              placeholder={`🔍 Search song, artist, or BPM for ${label}…`}
              aria-label={`Search song for ${label}`}
              style={{
                width: "100%",
                padding: "6px 10px",
                borderRadius: 6,
                background: "#090d16",
                color: "#f8fafc",
                border: "1px solid #334155",
                fontSize: "0.8rem",
              }}
            />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <select
                value={trackId && libraryTracks.some((t) => t.id === trackId) ? trackId : ""}
                onChange={(e) => {
                  if (e.target.value) {
                    onSelectCrateTrack(e.target.value, false);
                  }
                }}
                aria-label={`Choose song for ${label}`}
                style={{
                  flex: 1,
                  minWidth: 180,
                  padding: "7px 9px",
                  borderRadius: 6,
                  background: "#0f172a",
                  color: "#f8fafc",
                  border: "1px solid #475569",
                  fontSize: "0.82rem",
                  fontWeight: 700,
                }}
              >
                <option value="">
                  {hasTrack && trackName
                    ? `Current: ${musicLabel({ name: trackName })} — Click to pick another song…`
                    : `▼ Click to pick any song for ${label}…`}
                </option>
                {matchedForOtherDeck.length > 0 && (
                  <optgroup label={`🔥 Best BPM & Key Matches for Other Deck (${Math.round(otherDeckBpm!)} BPM)`}>
                    {matchedForOtherDeck.slice(0, 25).map((t) => (
                      <option key={`match-${t.id}`} value={t.id}>
                        ★ {t.label}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label={`📚 All Library Songs (${filteredLibraryTracks.length})`}>
                  {filteredLibraryTracks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </optgroup>
              </select>
              {trackId && onOpenInStemStudio && (
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={onOpenInStemStudio}
                  style={{
                    padding: "6px 10px",
                    fontSize: "0.76rem",
                    fontWeight: 800,
                    background: "rgba(6, 182, 212, 0.22)",
                    color: "#22d3ee",
                    borderColor: "#06b6d4",
                  }}
                  title="Open this song in the 4-Stem Horn & Beat Looper"
                >
                  🎺 Stem Looper
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className={styles.loadRow}>
        <button
          type="button"
          className={styles.bigButton}
          onClick={() => fileInputRef.current?.click()}
          title="Upload a local MP3 file from your computer or phone"
        >
          Load MP3
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/mpeg,.mp3"
          className={styles.hiddenInput}
          onChange={handleFileSelected}
        />
        <button type="button" className={styles.secondaryButton} onClick={handleLoadTestTrack}>
          Load test track
        </button>
      </div>

      {hasTrack && (
        <div className={styles.trackInfo}>
          <p className={styles.trackName} title={trackName ?? undefined}>{trackName ? musicLabel({ name: trackName }) : ""}</p>
          <p className={styles.metaLine}>
            BPM: <strong>{tags.bpm ? tags.bpm : "no BPM tag"}</strong>
            {tags.key && (
              <>
                {" "}
                &middot; Key: <strong>{tags.key}</strong>
              </>
            )}
            {" "}&middot; BeatGrid: <strong>{grid ? "yes" : "estimated"}</strong>
          </p>
          {status === "error" && <p className={styles.errorText}>Could not load this file.</p>}
          {syncNotice && (
            <p className={styles.syncNotice} aria-live="polite">
              {syncNotice}
            </p>
          )}
        </div>
      )}

      {hasTrack && status !== "error" && (
        <>
          <button
            type="button"
            className={styles.playButton}
            onClick={handlePlayPause}
            disabled={status === "loading"}
          >
            {isPlaying ? "Pause" : "Play"}
          </button>

          <div
            className={styles.progressWrap}
            style={{ cursor: duration > 0 ? "pointer" : "default" }}
            title={duration > 0 ? "Click anywhere on the bar to jump/scrub through the track" : undefined}
            onClick={(event) => {
              if (duration <= 0) return;
              const rect = event.currentTarget.getBoundingClientRect();
              if (rect.width <= 0) return;
              const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
              deck.seekTo(ratio * duration);
            }}
          >
            <div className={styles.progressTrack} aria-hidden="true">
              <div className={styles.progressFill} style={{ width: `${progress}%` }} />
            </div>
            {duration > 0 &&
              cues.map((cue, index) => (
                <span
                  key={index}
                  className={styles.cueMarker}
                  style={{ left: `${Math.min(100, (cue.atSeconds / duration) * 100)}%` }}
                  aria-hidden="true"
                />
              ))}
          </div>

          <div className={styles.nudgeSection} style={{ marginTop: 6, marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
            <span className={styles.nudgeLabel} style={{ minWidth: 90 }}>
              {duration > 0 ? `${formatMmSs(deck.positionSeconds)} / ${formatMmSs(duration)}` : "Seek / Intro"}
            </span>
            <button
              type="button"
              className={styles.nudgeButton}
              onClick={() => deck.seekBy(-15)}
              disabled={!isDecoded}
              title="Rewind 15 seconds"
            >
              ⏪ -15s
            </button>
            <button
              type="button"
              className={styles.nudgeButton}
              onClick={() => deck.seekBy(15)}
              disabled={!isDecoded}
              title="Fast-forward 15 seconds"
            >
              ⏩ +15s
            </button>
            <button
              type="button"
              className={styles.nudgeButton}
              onClick={() => deck.seekBy(30)}
              disabled={!isDecoded}
              title="Fast-forward 30 seconds past a slow video intro"
            >
              ⏩ +30s
            </button>
            <button
              type="button"
              className={styles.nudgeButton}
              onClick={onJumpToBeat}
              disabled={!isDecoded}
              title="Jump straight past a slow intro to the track's analyzed beat-in / drop"
              style={{ fontWeight: 700 }}
            >
              🔥 Skip Intro / Drop
            </button>
          </div>

          {/* 🥁 LIVE VISUAL BEAT & BAR COUNTER ON DECK (1 Bar = 4 Beats, 4 Bars = 16 Beats) */}
          <div
            style={{
              padding: "7px 10px",
              marginBottom: 8,
              borderRadius: 8,
              background: "rgba(9, 13, 22, 0.85)",
              border: "1px solid rgba(56, 189, 248, 0.3)",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
            }}
            title={`1 Bar = 4 Beats (${barLengthSec.toFixed(1)}s) · 4 Bars = 16 Beats (${(barLengthSec * 4).toFixed(1)}s)`}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: "0.72rem", fontWeight: 800, color: "#94a3b8", marginRight: 2 }}>
                BAR #{currentBarNumber}:
              </span>
              {([1, 2, 3, 4] as const).map((b) => {
                const active = isPlaying && currentBeatInBar === b;
                const isDownbeat = b === 1;
                return (
                  <span
                    key={b}
                    style={{
                      padding: "2px 7px",
                      borderRadius: 5,
                      fontSize: "0.73rem",
                      fontWeight: 900,
                      background: active
                        ? isDownbeat
                          ? "#f59e0b"
                          : "#06b6d4"
                        : "rgba(30, 41, 59, 0.9)",
                      color: active ? "#090d16" : "#94a3b8",
                      border: active
                        ? isDownbeat
                          ? "1px solid #fde047"
                          : "1px solid #38bdf8"
                        : "1px solid rgba(71, 85, 105, 0.5)",
                    }}
                  >
                    {isDownbeat ? "1·DOWN" : b}
                  </span>
                );
              })}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: "0.7rem", fontWeight: 700, color: "#64748b" }}>
                4-Bar Phrase:
              </span>
              {([1, 2, 3, 4] as const).map((barIdx) => {
                const activeBar = isPlaying && currentPhraseBar === barIdx;
                return (
                  <span
                    key={barIdx}
                    style={{
                      padding: "2px 6px",
                      borderRadius: 4,
                      fontSize: "0.7rem",
                      fontWeight: 800,
                      background: activeBar ? "rgba(16, 185, 129, 0.3)" : "rgba(15, 23, 42, 0.7)",
                      color: activeBar ? "#34d399" : "#64748b",
                      border: activeBar ? "1px solid #10b981" : "1px solid rgba(51, 65, 85, 0.5)",
                    }}
                  >
                    Bar {barIdx}/4
                  </span>
                );
              })}
            </div>
          </div>

          <div className={styles.tempoSection}>
            <div className={styles.tempoHeader}>
              <span>Tempo</span>
              <span className={styles.tempoValue}>{(tempo * 100).toFixed(1)}%</span>
              <button type="button" className={styles.resetButton} onClick={handleResetTempo}>
                Reset
              </button>
            </div>
            <input
              type="range"
              className={styles.tempoSlider}
              min={TEMPO_MIN}
              max={TEMPO_MAX}
              step={TEMPO_STEP}
              value={tempo}
              onChange={handleTempoChange}
              aria-label={`${label} tempo, percent of original speed`}
            />
            <div className={styles.tempoLabels}>
              <span>-8%</span>
              <span>0</span>
              <span>+8%</span>
            </div>
            {effectiveBpm !== null && (
              <p className={styles.effectiveBpm}>Effective BPM: {effectiveBpm.toFixed(1)}</p>
            )}
          </div>

          <div className={styles.eqSection}>
            <div className={styles.eqHeader}>
              <span>EQ</span>
              <button type="button" className={styles.resetButton} onClick={handleResetEq}>
                Reset to flat
              </button>
            </div>
            <div className={styles.eqBands}>
              {(["high", "mid", "low"] as const).map((band) => (
                <div key={band} className={styles.eqBand}>
                  <span className={styles.eqBandLabel}>{band.toUpperCase()}</span>
                  <div className={styles.eqSliderWrap}>
                    <input
                      type="range"
                      className={styles.eqSlider}
                      min={EQ_MIN_DB}
                      max={EQ_MAX_DB}
                      step={1}
                      value={eq[band]}
                      onChange={(event) => handleEqChange(band, parseFloat(event.target.value))}
                      aria-label={`${label} ${band} EQ, decibels`}
                    />
                  </div>
                  <span className={styles.eqBandValue}>{eq[band]}dB</span>
                  <button
                    type="button"
                    className={`${styles.killButton} ${eqKilled[band] ? styles.killButtonActive : ""}`}
                    onClick={() => handleKillToggle(band)}
                    aria-pressed={eqKilled[band]}
                    aria-label={`${label} kill ${band} band`}
                  >
                    KILL
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.nudgeSection}>
            <span className={styles.nudgeLabel}>Nudge (by ear)</span>
            <button
              type="button"
              className={styles.nudgeButton}
              onClick={() => handleNudge(-NUDGE_MS)}
              aria-label={`${label} nudge earlier ${NUDGE_MS} milliseconds`}
            >
              &laquo; -{NUDGE_MS}ms
            </button>
            <button
              type="button"
              className={styles.nudgeButton}
              onClick={() => handleNudge(NUDGE_MS)}
              aria-label={`${label} nudge later ${NUDGE_MS} milliseconds`}
            >
              +{NUDGE_MS}ms &raquo;
            </button>
          </div>
        </>
      )}

      {/* Cue points: rendered unconditionally (like the Beat Sync button
          above) — Rehearse/MARK are disabled rather than hidden when no
          track is loaded, so a bare page load still shows the controls. */}
      <div className={styles.cueSection}>
        <div className={styles.cueHeader}>
          <span>Cue points</span>
          <button
            type="button"
            className={`${styles.rehearseButton} ${rehearsing ? styles.rehearseButtonActive : ""}`}
            onClick={onToggleRehearse}
            disabled={!hasTrack}
            aria-pressed={rehearsing}
            aria-label={`${label} rehearse mode`}
          >
            {rehearsing ? "Rehearse: ON" : "Rehearse"}
          </button>
        </div>

        <button
          type="button"
          className={styles.markButton}
          onClick={onMark}
          disabled={!hasTrack || !rehearsing}
          title={!hasTrack ? "Load a track first" : !rehearsing ? "Turn Rehearse on to mark cues" : undefined}
        >
          MARK{hasTrack && rehearsing ? ` (${formatMmSs(deck.positionSeconds)})` : ""}
        </button>

        {!hasTrack && <p className={styles.hint}>Load a track to set cue points.</p>}

        {hasTrack && cues.length === 0 && (
          <p className={styles.hint}>{rehearsing ? "No cues yet — tap MARK to stamp one." : "No cues on this track yet."}</p>
        )}

        {hasTrack && cues.length > 0 && (
          <ul className={styles.cueList}>
            {cues.map((cue, index) => (
              <li
                key={index}
                className={`${styles.cueItem} ${cue.suggested ? styles.cueItemSuggested : ""}`}
              >
                <span className={styles.cueTime}>{formatMmSs(cue.atSeconds)}</span>
                {cue.label && (
                  <span className={styles.cueLabel}>
                    {cue.suggested ? "Suggested — " : ""}
                    {cue.label}
                  </span>
                )}
                <select
                  className={styles.cueSelect}
                  value={cue.action.type === "singalong" ? "singalong" : cue.action.file ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "singalong") onAssignSingalong(index, SINGALONG_DEFAULT_DURATION_SECONDS);
                    else if (value === "") onAssignClip(index, null);
                    else onAssignClip(index, value);
                  }}
                  aria-label={`${label} cue at ${formatMmSs(cue.atSeconds)} action`}
                >
                  <option value="">— unassigned —</option>
                  <option value="singalong">Sing-along</option>
                  {(Object.keys(VOCAL_GROUPS) as VocalCategory[]).map((category) =>
                    VOCAL_GROUPS[category].length > 0 ? (
                      <optgroup key={category} label={VOCAL_PAD_LABELS[category]}>
                        {VOCAL_GROUPS[category].map((file) => (
                          <option key={file} value={file}>
                            {file}
                          </option>
                        ))}
                      </optgroup>
                    ) : null
                  )}
                </select>
                {cue.action.type === "singalong" && (
                  <label className={styles.cueDurationLabel}>
                    Duration (s)
                    <input
                      type="number"
                      className={styles.cueDurationInput}
                      min={SINGALONG_MIN_DURATION_SECONDS}
                      max={SINGALONG_MAX_DURATION_SECONDS}
                      value={cue.action.durationSeconds}
                      onChange={(event) => onAssignSingalong(index, parseFloat(event.target.value) || SINGALONG_DEFAULT_DURATION_SECONDS)}
                      aria-label={`${label} cue at ${formatMmSs(cue.atSeconds)} sing-along duration, seconds`}
                    />
                  </label>
                )}
                <div className={styles.cueNudgeRow}>
                  <button
                    type="button"
                    className={styles.nudgeButton}
                    onClick={() => onNudgeCue(index, -CUE_NUDGE_SECONDS)}
                    aria-label={`${label} nudge cue at ${formatMmSs(cue.atSeconds)} earlier`}
                  >
                    -{Math.round(CUE_NUDGE_SECONDS * 1000)}ms
                  </button>
                  <button
                    type="button"
                    className={styles.nudgeButton}
                    onClick={() => onNudgeCue(index, CUE_NUDGE_SECONDS)}
                    aria-label={`${label} nudge cue at ${formatMmSs(cue.atSeconds)} later`}
                  >
                    +{Math.round(CUE_NUDGE_SECONDS * 1000)}ms
                  </button>
                  <button
                    type="button"
                    className={styles.deleteCueButton}
                    onClick={() => onDeleteCue(index)}
                    aria-label={`${label} delete cue at ${formatMmSs(cue.atSeconds)}`}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {!hasTrack && <p className={styles.hint}>Pick an MP3 to get started.</p>}
      {!isDecoded && hasTrack && status === "ready" && (
        <p className={styles.hint}>Tap Play to start (first tap enables audio on iOS).</p>
      )}
    </section>
  );
}

function ClubBoothHud({
  deckA,
  deckB,
  cueKeyA,
  cueKeyB,
  stemMixerPlaying,
  stemMixerBpm,
  stemMixerTitle,
  autopilot,
  transitionRunning,
  crate,
  onPickHarmonicNext,
  onFireTurntablistCombo,
  onSoloActiveDeck,
  onStopAllAudio,
}: {
  deckA: DeckController;
  deckB: DeckController;
  cueKeyA: string | null;
  cueKeyB: string | null;
  stemMixerPlaying: boolean;
  stemMixerBpm: number | null;
  stemMixerTitle: string | null;
  autopilot: boolean;
  transitionRunning: boolean;
  crate: CrateTrack[];
  onPickHarmonicNext: (targetTrackId: string, comboId: string) => void;
  onFireTurntablistCombo: (comboId: string) => void;
  onSoloActiveDeck: () => void;
  onStopAllAudio: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const anyActive = deckA.isPlaying || deckB.isPlaying || stemMixerPlaying;
  const activeBpm =
    (deckA.isPlaying && deckA.tags.bpm ? deckA.tags.bpm * deckA.tempo : null) ??
    (deckB.isPlaying && deckB.tags.bpm ? deckB.tags.bpm * deckB.tempo : null) ??
    (stemMixerPlaying ? stemMixerBpm : null) ??
    104;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const startMs = performance.now();

    const draw = (now: number) => {
      const elapsed = (now - startMs) / 1000;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Subtle grid background
      ctx.strokeStyle = "rgba(56, 189, 248, 0.08)";
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 32) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y < h; y += 20) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      const beatFreq = (activeBpm || 104) / 60;
      const beatPhase = (elapsed * beatFreq) % 1;
      const beatPulse = anyActive ? Math.pow(Math.max(0, 1 - beatPhase * 2.2), 2) : 0.15;

      // 48-bar real-time club spectrum
      const barCount = 48;
      const barGap = 3;
      const totalBarW = (w - 140) / barCount;
      for (let i = 0; i < barCount; i++) {
        const norm = i / barCount;
        const bassWeight = norm < 0.25 ? 1.25 : norm < 0.6 ? 0.85 : 0.65;
        const wave1 = Math.sin(elapsed * (3.5 + i * 0.23) + i * 0.4) * 0.5 + 0.5;
        const wave2 = Math.cos(elapsed * (6.1 - i * 0.11) + i * 0.7) * 0.5 + 0.5;
        const energy = anyActive
          ? Math.min(1, (0.22 + wave1 * 0.42 + wave2 * 0.22 + beatPulse * 0.38) * bassWeight)
          : 0.08 + Math.sin(elapsed * 1.6 + i * 0.3) * 0.04;
        const barH = Math.max(4, energy * (h - 18));
        const x = 12 + i * totalBarW;
        const y = h - 8 - barH;

        const grad = ctx.createLinearGradient(0, h - 8, 0, 8);
        if (norm < 0.33) {
          grad.addColorStop(0, "#06b6d4");
          grad.addColorStop(1, "#3b82f6");
        } else if (norm < 0.66) {
          grad.addColorStop(0, "#8b5cf6");
          grad.addColorStop(1, "#ec4899");
        } else {
          grad.addColorStop(0, "#f59e0b");
          grad.addColorStop(1, "#ef4444");
        }
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, Math.max(2, totalBarW - barGap), barH);
      }

      // Right-hand Beat Phase & Harmonic Lock Radar
      const cx = w - 64;
      const cy = h / 2;
      const radius = Math.min(34, h * 0.36) + beatPulse * 5;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.strokeStyle = anyActive ? "rgba(249, 115, 22, 0.85)" : "rgba(148, 163, 184, 0.35)";
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.68, -Math.PI / 2, -Math.PI / 2 + beatPhase * Math.PI * 2);
      ctx.strokeStyle = "#06b6d4";
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.fillStyle = "#f8fafc";
      ctx.font = "700 11px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.fillText(`${Math.round(activeBpm)} BPM`, cx, cy + 4);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [anyActive, activeBpm]);

  const camelotA = toCamelot(deckA.tags.key ?? null) ?? deckA.tags.key ?? "—";
  const camelotB = toCamelot(deckB.tags.key ?? null) ?? deckB.tags.key ?? "—";
  const beatInA = deckA.trackId ? (BEAT_IN as Record<string, { beatInSeconds: number | null }>)[deckA.trackId]?.beatInSeconds : null;
  const beatInB = deckB.trackId ? (BEAT_IN as Record<string, { beatInSeconds: number | null }>)[deckB.trackId]?.beatInSeconds : null;
  const loopsA = cueKeyA ? getLoopPoints(CURRENT_LOOP_POINTS, cueKeyA)?.loops.length ?? 0 : 0;
  const loopsB = cueKeyB ? getLoopPoints(CURRENT_LOOP_POINTS, cueKeyB)?.loops.length ?? 0 : 0;
  const recipesA = deckA.trackId ? ((TRANSITION_RECIPES as TransitionRecipeFile).recipes[deckA.trackId]?.length ?? 0) : 0;
  const recipesB = deckB.trackId ? ((TRANSITION_RECIPES as TransitionRecipeFile).recipes[deckB.trackId]?.length ?? 0) : 0;
  const hasGridA = Boolean(deckA.grid);
  const hasGridB = Boolean(deckB.grid);

  // Compute live Music Theory & Turntablist Mastery intelligence
  const theorySummary = useMemo(() => {
    const primaryDeck = deckA.isPlaying ? deckA : deckB.isPlaying ? deckB : deckA.trackName ? deckA : deckB;
    const secondaryDeck = primaryDeck === deckA ? deckB : deckA;

    const liveInput: MusicTheoryTrackInput = {
      id: primaryDeck.trackId ?? STUDIO_VIP_TRACKS[0].id,
      name: primaryDeck.trackName ?? STUDIO_VIP_TRACKS[0].title,
      bpm: primaryDeck.tags.bpm ? primaryDeck.tags.bpm * primaryDeck.tempo : STUDIO_VIP_TRACKS[0].bpm,
      key: primaryDeck.tags.key ?? STUDIO_VIP_TRACKS[0].camelot,
      hasStems: Boolean(primaryDeck.trackId ? usableStemEntry((STEM_MANIFEST as Record<string, StemManifestEntry>)[primaryDeck.trackId]) : true),
      hasRealGrid: Boolean(primaryDeck.grid),
    };

    const candidatePool: MusicTheoryTrackInput[] = crate.slice(0, 120).map((t) => ({
      id: t.id,
      name: t.name,
      bpm: t.bpm,
      key: t.key,
      genre: t.genre,
      hasStems: Boolean(usableStemEntry((STEM_MANIFEST as Record<string, StemManifestEntry>)[t.id])),
      hasRealGrid: Boolean(t.grid),
    }));

    const topRanked = rankCandidatesByMusicTheory(liveInput, candidatePool)[0] ?? null;

    const targetInput: MusicTheoryTrackInput =
      secondaryDeck.trackName && secondaryDeck.trackId !== liveInput.id
        ? {
            id: secondaryDeck.trackId ?? STUDIO_VIP_TRACKS[1].id,
            name: secondaryDeck.trackName,
            bpm: secondaryDeck.tags.bpm ? secondaryDeck.tags.bpm * secondaryDeck.tempo : STUDIO_VIP_TRACKS[1].bpm,
            key: secondaryDeck.tags.key ?? STUDIO_VIP_TRACKS[1].camelot,
            hasStems: Boolean(secondaryDeck.trackId ? usableStemEntry((STEM_MANIFEST as Record<string, StemManifestEntry>)[secondaryDeck.trackId]) : true),
            hasRealGrid: Boolean(secondaryDeck.grid),
          }
        : topRanked?.track ?? {
            id: STUDIO_VIP_TRACKS[1].id,
            name: STUDIO_VIP_TRACKS[1].title,
            bpm: STUDIO_VIP_TRACKS[1].bpm,
            key: STUDIO_VIP_TRACKS[1].camelot,
            hasStems: true,
            hasRealGrid: true,
          };

    const harmonic = analyzeHarmonicRelationship(liveInput.key, targetInput.key);
    const groove = analyzeGrooveInterlock(liveInput, targetInput, harmonic);
    const choreography = planTurntablistChoreography(liveInput, targetInput, harmonic, groove);

    return {
      liveInput,
      targetInput,
      harmonic,
      groove,
      choreography,
      topRecommendation: topRanked,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    deckA.trackId,
    deckA.trackName,
    deckA.isPlaying,
    deckA.tempo,
    deckA.tags.bpm,
    deckA.tags.key,
    hasGridA,
    deckB.trackId,
    deckB.trackName,
    deckB.isPlaying,
    deckB.tempo,
    deckB.tags.bpm,
    deckB.tags.key,
    hasGridB,
    crate,
  ]);

  return (
    <section className={styles.boothHud} aria-label="El Cerebro Pro Club Booth Telemetry">
      <div className={styles.hudTopRow}>
        <div className={styles.hudBrandBlock}>
          <span className={anyActive ? styles.liveStatusText : styles.idleStatusText}>
            {transitionRunning
              ? "⚡ TRANSITION ACTIVE"
              : autopilot
                ? "● AUTOPILOT TELEMETRY"
                : anyActive
                  ? "● ON AIR · LIVE TELEMETRY"
                  : "○ TELEMETRY STANDBY"}
          </span>
          <span className={styles.hudSubtitle}>
            Music Theory Master · 1,605 Pre-Computed Recipes · 599 4-Stem Packs
          </span>
        </div>
      </div>

      <div className={styles.hudCanvasWrap}>
        <canvas ref={canvasRef} width={760} height={86} className={styles.hudCanvas} />
      </div>

      <div className={styles.hudTelemetryGrid}>
        <div className={styles.hudDeckCardA}>
          <div className={styles.hudDeckHeader}>
            <span className={styles.hudDeckTagA}>DECK A {deckA.isPlaying ? "▶ LIVE" : "⏸ IDLE"}</span>
            <span className={styles.hudSubtitle}>Key: <strong>{camelotA}</strong></span>
          </div>
          <div className={styles.hudTrackTitle}>
            {deckA.trackName ? musicLabel({ name: deckA.trackName }) : "No track loaded — tap a Crate song"}
          </div>
          <div className={styles.hudMetricsRow}>
            <span>BPM: <strong>{deckA.tags.bpm ? (deckA.tags.bpm * deckA.tempo).toFixed(1) : "—"}</strong></span>
            <span>Beat-In: <strong>{typeof beatInA === "number" ? `${beatInA.toFixed(1)}s` : "0.0s"}</strong></span>
            <span>Loops: <strong>{loopsA}</strong></span>
            <span>Recipes: <strong>{recipesA}</strong></span>
          </div>
        </div>

        <div className={styles.hudCenterBridge}>
          <span className={styles.hudBridgeTitle}>CAMELOT &amp; GROOVE INTERLOCK</span>
          <span className={styles.hudBridgeLock}>
            {stemMixerPlaying && stemMixerTitle
              ? `🎛️ 4-STEM LIVE: ${stemMixerTitle}`
              : theorySummary.harmonic.headline}
          </span>
          <span className={styles.hudBridgeSub}>
            {theorySummary.groove.interlockSummary}
          </span>
        </div>

        <div className={styles.hudDeckCardB}>
          <div className={styles.hudDeckHeader}>
            <span className={styles.hudDeckTagB}>DECK B {deckB.isPlaying ? "▶ LIVE" : "⏸ IDLE"}</span>
            <span className={styles.hudSubtitle}>Key: <strong>{camelotB}</strong></span>
          </div>
          <div className={styles.hudTrackTitle}>
            {deckB.trackName ? musicLabel({ name: deckB.trackName }) : "No track loaded — tap a Crate song"}
          </div>
          <div className={styles.hudMetricsRow}>
            <span>BPM: <strong>{deckB.tags.bpm ? (deckB.tags.bpm * deckB.tempo).toFixed(1) : "—"}</strong></span>
            <span>Beat-In: <strong>{typeof beatInB === "number" ? `${beatInB.toFixed(1)}s` : "0.0s"}</strong></span>
            <span>Loops: <strong>{loopsB}</strong></span>
            <span>Recipes: <strong>{recipesB}</strong></span>
          </div>
        </div>
      </div>

      {/* 🧠 EL CEREBRO MUSIC THEORY & TURNTABLIST MASTERY ENGINE */}
      <div className={styles.theoryMasterBox}>
        <div className={styles.theoryHeaderRow}>
          <div>
            <span className={styles.theoryTitleBadge}>🧠 EL CEREBRO MUSIC THEORY &amp; TURNTABLIST MASTER</span>
            <p className={styles.theoryCoachingText}>{theorySummary.harmonic.djCoachingNote}</p>
          </div>
          <div className={styles.theoryActionButtons}>
            {theorySummary.topRecommendation && (
              <button
                type="button"
                className={styles.theoryPickBtn}
                onClick={() =>
                  onPickHarmonicNext(
                    theorySummary.topRecommendation!.track.id,
                    theorySummary.topRecommendation!.choreography.comboId
                  )
                }
                title={`Best harmonic & groove match: ${musicLabel({ name: theorySummary.topRecommendation.track.name })}`}
              >
                🎯 Pick &amp; Mix #1 Harmonic Track ({Math.round(theorySummary.topRecommendation.totalScore * 100)}% Match)
              </button>
            )}
            <button
              type="button"
              className={styles.theoryComboBtn}
              onClick={() => onFireTurntablistCombo(theorySummary.choreography.comboId)}
            >
              🎛️ Fire 4-Stage Combo Now
            </button>
            <button
              type="button"
              className={styles.theoryComboBtn}
              onClick={onSoloActiveDeck}
              style={{
                background: "linear-gradient(135deg, #f59e0b, #d97706)",
                color: "#090d16",
                fontWeight: 800,
              }}
              title="Stop any background track, 4-stem loop, or held sample and solo ONLY the active deck at 100% volume"
            >
              🎯 Kill Background Track / Solo Active Song
            </button>
            <button
              type="button"
              className={styles.theoryComboBtn}
              onClick={onStopAllAudio}
              style={{
                background: "linear-gradient(135deg, #ef4444, #991b1b)",
                color: "#fff",
                fontWeight: 800,
              }}
              title="Immediately stop all decks, 4-stem loops, transitions, and autopilot"
            >
              🛑 STOP ALL AUDIO
            </button>
          </div>
        </div>

        {/* Read-only plain telemetry grid — styled as clean text columns so they NEVER look like fake buttons */}
        <div className={styles.plainTelemetryList}>
          <div className={styles.plainTelemetryItem}>
            <span className={styles.plainTelemetryLabel}>Harmonic Mode</span>
            <span className={styles.plainTelemetryValue}>{theorySummary.harmonic.mode.replace(/_/g, " ").toUpperCase()}</span>
          </div>
          <div className={styles.plainTelemetryItem}>
            <span className={styles.plainTelemetryLabel}>Outgoing Clave</span>
            <span className={styles.plainTelemetryValue}>{theorySummary.groove.fromGroove.clavePattern}</span>
          </div>
          <div className={styles.plainTelemetryItem}>
            <span className={styles.plainTelemetryLabel}>Incoming Groove</span>
            <span className={styles.plainTelemetryValue}>{theorySummary.groove.toGroove.label}</span>
          </div>
          <div className={styles.plainTelemetryItem}>
            <span className={styles.plainTelemetryLabel}>Sub Crossover</span>
            <span className={styles.plainTelemetryValue}>{theorySummary.groove.subBassCrossoverHz}Hz ({theorySummary.harmonic.recommendedEqSwap})</span>
          </div>
          {theorySummary.topRecommendation && (
            <div className={styles.plainTelemetryItem}>
              <span className={styles.plainTelemetryLabel}>#1 Recommended Next Track</span>
              <span className={styles.plainTelemetryValue} style={{ color: "#34d399" }}>
                {musicLabel({ name: theorySummary.topRecommendation.track.name })} ({theorySummary.topRecommendation.track.bpm ?? "—"} BPM · {toCamelot(theorySummary.topRecommendation.track.key) ?? "—"})
              </span>
            </div>
          )}
        </div>

        <div className={styles.choreographyGrid}>
          {theorySummary.choreography.stages.map((stage) => (
            <div key={stage.code} className={styles.choreographyStageCard}>
              <div className={styles.choreographyStageHeader}>
                <span className={styles.choreographyStageNum}>STAGE {stage.stageNumber} (READ-ONLY PLAN)</span>
                <span className={styles.choreographyTiming}>{stage.timingLabel}</span>
              </div>
              <div className={styles.choreographyMoveName}>{stage.moveName}</div>
              <div className={styles.choreographyReason}>{stage.reason}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const TEMPORAL_DEFAULT_ID = "1nZUDRNgEZmt-W_ZhpMlS9F1PD5IbyXJC";
const TEMPORAL_DEFAULT_TITLE = 'Tito "El Bambino" & Farruko — Temporal';
const TEMPORAL_DEFAULT_BPM = 127.99;
const TEMPORAL_DEFAULT_CAMELOT = "9A";

function LiveStemMixerPanel({
  core,
  activeDeckTrackId,
  activeDeckTrackName,
  activeDeckBpm = null,
  activeDeckCamelot = null,
  activeDeckTempo = 1,
  activeDeckPositionSec = 0,
  activeDeckDurationSec = 0,
  activeDeckAnchorSec = 0,
  crate = [],
  trackCacheStore,
  onLoadVipToDeck,
  onReturnToDeck,
  onLog,
  onPlayingChange,
  stopRef,
  onBeforePlay,
  onPurgeMasterBus,
}: {
  core: AudioCore;
  activeDeckTrackId: string | null;
  activeDeckTrackName: string | null;
  activeDeckBpm?: number | null;
  activeDeckCamelot?: string | null;
  activeDeckTempo?: number;
  activeDeckPositionSec?: number;
  activeDeckDurationSec?: number;
  activeDeckAnchorSec?: number;
  crate?: CrateTrack[];
  trackCacheStore?: ReturnType<typeof createIndexedDbStore>;
  onLoadVipToDeck: (trackId: string) => void;
  onReturnToDeck?: (resumePositionSec: number, resumeTempo: number) => void;
  onLog: (action: string, say: string) => void;
  onPlayingChange?: (playing: boolean, bpm: number | null, title: string | null) => void;
  stopRef?: React.MutableRefObject<(() => void) | null>;
  onBeforePlay?: () => void;
  onPurgeMasterBus?: () => void;
}) {
  const initialId = activeDeckTrackId && (STEM_MANIFEST as Record<string, StemManifestEntry>)[activeDeckTrackId]
    ? activeDeckTrackId
    : TEMPORAL_DEFAULT_ID;
  const initialManifest = PLAYBACK_MANIFEST.get(initialId);
  const initialTitle =
    initialId === activeDeckTrackId && activeDeckTrackName
      ? musicLabel({ name: activeDeckTrackName })
      : initialManifest
        ? musicLabel({ name: initialManifest.name })
        : TEMPORAL_DEFAULT_TITLE;

  const [selectedId, setSelectedId] = useState<string>(initialId);
  const [trackTitle, setTrackTitle] = useState<string>(initialTitle);
  const [trackBpm, setTrackBpm] = useState<number>(activeDeckBpm ?? initialManifest?.bpm ?? TEMPORAL_DEFAULT_BPM);
  const [trackCamelot, setTrackCamelot] = useState<string>(
    activeDeckCamelot ?? toCamelot(initialManifest?.key ?? null) ?? initialManifest?.key ?? TEMPORAL_DEFAULT_CAMELOT
  );
  const [loadingStems, setLoadingStems] = useState(false);
  const [stemStatus, setStemStatus] = useState<string>(
    "🎧 Synced to active song — click any Horn/Beat Loop, Hook, or Stem Isolation button below!"
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [stemTempo, setStemTempo] = useState(activeDeckTempo || 1);
  const [positionSec, setPositionSec] = useState(activeDeckPositionSec || 0);
  const [durationSec, setDurationSec] = useState(activeDeckDurationSec || initialManifest?.durationSeconds || 323.13);
  const [loopWindow, setLoopWindow] = useState<{
    startSec: number;
    endSec: number;
    bars: number;
    label: string;
  } | null>(null);
  const [levels, setLevels] = useState<Record<StemRoleKey, number>>({
    vocals: 1,
    drums: 1,
    bass: 1,
    other: 1,
  });
  const [muted, setMuted] = useState<Record<StemRoleKey, boolean>>({
    vocals: false,
    drums: false,
    bass: false,
    other: false,
  });
  const [soloed, setSoloed] = useState<Record<StemRoleKey, boolean>>({
    vocals: false,
    drums: false,
    bass: false,
    other: false,
  });

  const buffersRef = useRef<Partial<Record<StemRoleKey, AudioBuffer>>>({});
  const loadedTrackIdRef = useRef<string | null>(null);
  const sourcesRef = useRef<Partial<Record<StemRoleKey, AudioBufferSourceNode>>>({});
  const gainsRef = useRef<Partial<Record<StemRoleKey, GainNode>>>({});
  const startedAtCtxTimeRef = useRef<number>(0);
  const offsetSecRef = useRef<number>(0);
  const isPlayingRef = useRef(false);
  const loadGenRef = useRef<number>(0);
  const loopWindowRef = useRef<{
    startSec: number;
    endSec: number;
    bars: number;
    label: string;
  } | null>(null);

  const setActiveLoopWindow = (
    next: { startSec: number; endSec: number; bars: number; label: string } | null
  ) => {
    loopWindowRef.current = next;
    setLoopWindow(next);
  };

  const [punchInSec, setPunchInSec] = useState<number | null>(null);

  // Analyzed recurring Horn/Melody Hooks, Drops & Beat Loops from loop-points.json for the selected song:
  const songEntry = useMemo(
    () => getLoopPoints(CURRENT_LOOP_POINTS, `drive:${selectedId}`),
    [selectedId]
  );

  const songHooks = useMemo(() => {
    if (!songEntry) return [];
    const bpmVal = songEntry.bpm > 0 ? songEntry.bpm : trackBpm || 120;
    const barSecVal = (60 / bpmVal) * 4;
    const items: Array<{
      startBar: number;
      lengthBars: 1 | 2 | 4 | 8;
      startSeconds: number;
      endSeconds: number;
      isolation: "melody" | "beat";
      kindLabel: string;
    }> = [];

    for (const l of songEntry.loops ?? []) {
      const vDb = (l as { vocalsDb?: number }).vocalsDb;
      const isVocalFree = typeof vDb === "number" && vDb <= -24;
      const isMelodyHook = l.isolation === "melody" || isVocalFree;
      items.push({
        startBar: l.startBar,
        lengthBars: (l.lengthBars === 1 || l.lengthBars === 2 || l.lengthBars === 4 || l.lengthBars === 8 ? l.lengthBars : 4) as 1 | 2 | 4 | 8,
        startSeconds: l.startSeconds,
        endSeconds: l.endSeconds,
        isolation: isMelodyHook ? "melody" : "beat",
        kindLabel: l.isolation === "melody" ? "🎺 Horn/Melody Hook" : isVocalFree ? "🎺 Synth/Horn Hook" : "🥁 Beat Groove",
      });
    }

    for (let i = 0; i < (songEntry.drops ?? []).length; i++) {
      const d = songEntry.drops[i];
      const alreadyCovered = items.some((it) => Math.abs(it.startSeconds - d.atSeconds) < 2.0);
      if (!alreadyCovered) {
        items.push({
          startBar: (d as { bar?: number }).bar ?? Math.round(d.atSeconds / barSecVal),
          lengthBars: 8,
          startSeconds: d.atSeconds,
          endSeconds: d.atSeconds + 8 * barSecVal,
          isolation: "melody",
          kindLabel: `🔥 Main Drop #${i + 1}`,
        });
      }
    }

    return items.sort((a, b) => a.startSeconds - b.startSeconds);
  }, [songEntry, trackBpm]);

  // Live Beat & Bar Counter telemetry synced to the song's BeatGrid:
  const gridAnchorSec = songEntry?.anchor ?? (selectedId === activeDeckTrackId ? activeDeckAnchorSec : 0);
  const beatSec = 60 / Math.max(60, trackBpm);
  const barSec = beatSec * 4;
  const beatsSinceAnchor = Math.max(0, (positionSec - gridAnchorSec) / beatSec);
  const beatInBar = (Math.floor(beatsSinceAnchor) % 4) + 1; // 1, 2, 3, 4
  const songBarNum = Math.floor(beatsSinceAnchor / 4) + 1;
  const totalCycleBars = loopWindow ? Math.max(1, loopWindow.bars) : 4;
  const barInCurrentCycle = loopWindow
    ? (Math.floor(Math.max(0, (positionSec - loopWindow.startSec) / barSec)) % totalCycleBars) + 1
    : (Math.floor(beatsSinceAnchor / 4) % 4) + 1;

  const stemReadyCrateTracks = useMemo(() => {
    const base = crate.length > 0 ? crate : (crateManifestJson as CrateManifestEntry[]);
    return base
      .filter((t) => usableStemEntry((STEM_MANIFEST as Record<string, StemManifestEntry>)[t.id]) !== null && !STUDIO_TRACK_IDS.has(t.id))
      .map((t) => ({
        id: t.id,
        label: `${musicLabel(t)} (${Math.round(t.bpm ?? 0)} BPM · ${toCamelot(t.key ?? null) ?? t.key ?? "—"})`,
        title: musicLabel(t),
        bpm: t.bpm ?? 110,
        camelot: toCamelot(t.key ?? null) ?? t.key ?? "8A",
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [crate]);

  const computeEffectiveGain = (
    role: StemRoleKey,
    nextLevels = levels,
    nextMuted = muted,
    nextSoloed = soloed
  ) => {
    const anySolo = Object.values(nextSoloed).some(Boolean);
    if (nextMuted[role]) return 0;
    if (anySolo && !nextSoloed[role]) return 0;
    return nextLevels[role];
  };

  const syncGainNodes = (
    nextLevels = levels,
    nextMuted = muted,
    nextSoloed = soloed
  ) => {
    const ctx = core.ensureContext();
    const now = ctx.currentTime;
    for (const { key } of STEM_ROLES) {
      const gainNode = gainsRef.current[key];
      if (gainNode) {
        const target = computeEffectiveGain(key, nextLevels, nextMuted, nextSoloed);
        const param = gainNode.gain;
        if (typeof param.cancelAndHoldAtTime === "function") {
          param.cancelAndHoldAtTime(now);
        } else {
          const cur = param.value;
          param.cancelScheduledValues(now);
          param.setValueAtTime(cur, now);
        }
        param.setTargetAtTime(target, now, 0.012);
      }
    }
  };

  const currentLivePositionSec = (): number => {
    if (!isPlayingRef.current) {
      if (selectedId === activeDeckTrackId && activeDeckPositionSec > 0) {
        return activeDeckPositionSec;
      }
      return offsetSecRef.current || positionSec || 0;
    }
    const ctx = core.ensureContext();
    const dur = durationSec || 323.13;
    const lw = loopWindowRef.current;
    if (lw && lw.endSec > lw.startSec) {
      const loopLen = Math.max(0.05, lw.endSec - lw.startSec);
      const relElapsed = (ctx.currentTime - startedAtCtxTimeRef.current) * stemTempo + (offsetSecRef.current - lw.startSec);
      return lw.startSec + (((relElapsed % loopLen) + loopLen) % loopLen);
    }
    const elapsed = (ctx.currentTime - startedAtCtxTimeRef.current) * stemTempo + offsetSecRef.current;
    return dur > 0 ? elapsed % dur : 0;
  };

  const stopSources = () => {
    // Invalidate any in-flight loadStemsForTrack so an async decode never auto-starts after stop!
    loadGenRef.current += 1;
    setLoadingStems(false);
    const oldSources = sourcesRef.current;
    const oldGains = gainsRef.current;
    sourcesRef.current = {};
    gainsRef.current = {};
    const ctx = core.ensureContext();
    const now = ctx.currentTime;
    for (const { key } of STEM_ROLES) {
      const g = oldGains[key];
      const s = oldSources[key];
      try {
        if (g) {
          if (typeof g.gain.cancelAndHoldAtTime === "function") g.gain.cancelAndHoldAtTime(now);
          else { const cur = g.gain.value; g.gain.cancelScheduledValues(now); g.gain.setValueAtTime(cur, now); }
          g.gain.linearRampToValueAtTime(0, now + 0.012);
        }
        if (s) {
          s.stop(now + 0.015);
        }
      } catch {
        try { s?.stop(); } catch { /* ignore */ }
      }
    }
    setTimeout(() => {
      for (const { key } of STEM_ROLES) {
        try { oldSources[key]?.disconnect(); } catch { /* ignore */ }
        try { oldGains[key]?.disconnect(); } catch { /* ignore */ }
      }
    }, 25);
    isPlayingRef.current = false;
    setIsPlaying(false);
    onPlayingChange?.(false, trackBpm * stemTempo, trackTitle);
  };

  const handleHardStopStems = () => {
    stopSources();
    setActiveLoopWindow(null);
    setStemStatus("🛑 4-Stem Isolator OFF (All Stems Silenced)");
    onLog("stem_mixer", "🛑 Turned OFF 4-Stem Isolator");
    onPurgeMasterBus?.();
  };

  const handleHandBackToDeck = () => {
    const resumePos = currentLivePositionSec();
    const resumeTmp = stemTempo;
    stopSources();
    setActiveLoopWindow(null);
    setStemStatus(`🎧 Handed "${trackTitle}" back to Deck at ${formatMmSs(resumePos)}`);
    onLog("stem_mixer", `🎧 Returned "${trackTitle}" to normal Deck at ${formatMmSs(resumePos)}`);
    onReturnToDeck?.(resumePos, resumeTmp);
  };

  if (stopRef) {
    stopRef.current = stopSources;
  }

  useEffect(() => {
    return () => {
      if (stopRef) stopRef.current = null;
      stopSources();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Automatically follow the active Deck song whenever the Stem Isolator is not actively overriding with another track!
  useEffect(() => {
    if (!activeDeckTrackId || isPlayingRef.current) return;
    if (!(STEM_MANIFEST as Record<string, StemManifestEntry>)[activeDeckTrackId]) return;
    const manifestEntry = PLAYBACK_MANIFEST.get(activeDeckTrackId);
    const nextTitle = activeDeckTrackName ? musicLabel({ name: activeDeckTrackName }) : manifestEntry ? musicLabel({ name: manifestEntry.name }) : activeDeckTrackId;
    const nextBpm = activeDeckBpm ?? manifestEntry?.bpm ?? 120;
    const nextCamelot = activeDeckCamelot ?? toCamelot(manifestEntry?.key ?? null) ?? manifestEntry?.key ?? "8A";
    setSelectedId(activeDeckTrackId);
    setTrackTitle(nextTitle);
    setTrackBpm(nextBpm);
    setTrackCamelot(nextCamelot);
    if (activeDeckTempo > 0) setStemTempo(activeDeckTempo);
    if (activeDeckDurationSec > 0) setDurationSec(activeDeckDurationSec);
    if (activeDeckPositionSec >= 0) {
      offsetSecRef.current = activeDeckPositionSec;
      setPositionSec(activeDeckPositionSec);
    }
    // Pre-decode the active deck song's stems in the background so 1-click Horn/Beat loops start instantaneously!
    if (loadedTrackIdRef.current !== activeDeckTrackId && !loadingStems) {
      void loadStemsForTrack(activeDeckTrackId, nextTitle, nextBpm, nextCamelot, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDeckTrackId, activeDeckTrackName, activeDeckBpm, activeDeckCamelot]);

  // Keep playhead & tempo mirrored to the active deck while the stem isolator is in standby:
  useEffect(() => {
    if (isPlaying || selectedId !== activeDeckTrackId) return;
    if (activeDeckPositionSec >= 0) {
      offsetSecRef.current = activeDeckPositionSec;
      setPositionSec(activeDeckPositionSec);
    }
    if (activeDeckDurationSec > 0) setDurationSec(activeDeckDurationSec);
    if (activeDeckTempo > 0) setStemTempo(activeDeckTempo);
  }, [isPlaying, selectedId, activeDeckTrackId, activeDeckPositionSec, activeDeckDurationSec, activeDeckTempo]);

  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setPositionSec(currentLivePositionSec());
    }, 80);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, durationSec, stemTempo, core]);

  async function fetchStemArrayBuffer(idOrUrl: string): Promise<ArrayBuffer> {
    if (idOrUrl.startsWith("/audio/") || STUDIO_TRACK_IDS.has(idOrUrl)) {
      const { url } = resolveAudioAssetUrl(idOrUrl);
      const res = await fetchWithPasscode(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    }
    const blob = await getTrackBlob(
      idOrUrl,
      async () => {
        const { url } = resolveAudioAssetUrl(idOrUrl);
        const res = await fetchWithPasscode(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      },
      trackCacheStore ? { store: trackCacheStore } : undefined
    );
    return blob.arrayBuffer();
  }

  async function loadStemsForTrack(
    targetId: string,
    titleOverride?: string,
    bpmOverride?: number,
    camelotOverride?: string,
    backgroundPreload = false
  ): Promise<boolean> {
    const stemEntry = (STEM_MANIFEST as Record<string, StemManifestEntry>)[targetId];
    if (!stemEntry || !stemEntry.stems) {
      setStemStatus(`No separated stems registered for "${titleOverride ?? targetId}"`);
      return false;
    }
    setLoadingStems(true);
    setStemStatus(
      backgroundPreload
        ? `⏳ Pre-loading 6-stem pack (Vocals, Drums, Bass, Horns/Guitar/Keys) for "${titleOverride ?? targetId}"…`
        : `⏳ Loading separated stems (Vocals, Drums, Bass, Horns/Melody) for "${titleOverride ?? targetId}"…`
    );
    try {
      const ctx = core.ensureContext();
      const decodedMap: Partial<Record<StemRoleKey, AudioBuffer>> = {};
      await Promise.all(
        STEM_ROLES.map(async ({ key }) => {
          const idOrUrl = stemEntry.stems[key];
          if (!idOrUrl) return;
          const buf = await fetchStemArrayBuffer(idOrUrl);
          decodedMap[key] = await ctx.decodeAudioData(buf);
        })
      );

      // For 6-stem (htdemucs_6s) tracks like Farruko — Temporal, fold `guitar` and `piano`
      // into the `other` (🎺 Horns / Melody / Synth) buffer so 100% of the horns, guitars, and keys play!
      const extraHarmonyKeys = (["guitar", "piano"] as const).filter((k) => {
        const id = stemEntry.stems[k];
        if (!id) return false;
        const stats = stemEntry.loudness?.[k];
        if (stats && stats.silentPct >= 0.92 && !stemEntry.compingLayer?.includes(k)) return false;
        return true;
      });
      if (extraHarmonyKeys.length > 0 && decodedMap.other) {
        const baseOther = decodedMap.other;
        const combined = ctx.createBuffer(baseOther.numberOfChannels, baseOther.length, baseOther.sampleRate);
        for (let ch = 0; ch < baseOther.numberOfChannels; ch++) {
          combined.getChannelData(ch).set(baseOther.getChannelData(ch));
        }
        for (const extraKey of extraHarmonyKeys) {
          try {
            const extraBuf = await fetchStemArrayBuffer(stemEntry.stems[extraKey]);
            const extraDecoded = await ctx.decodeAudioData(extraBuf);
            const len = Math.min(combined.length, extraDecoded.length);
            const chCount = Math.min(combined.numberOfChannels, extraDecoded.numberOfChannels);
            for (let ch = 0; ch < chCount; ch++) {
              const dst = combined.getChannelData(ch);
              const src = extraDecoded.getChannelData(ch);
              for (let i = 0; i < len; i++) {
                dst[i] += src[i];
              }
            }
          } catch {
            // Best-effort auxiliary harmony merge
          }
        }
        // Soft peak guard on the combined Horn/Melody/Guitar/Piano buffer:
        let peak = 0;
        for (let ch = 0; ch < combined.numberOfChannels; ch++) {
          const data = combined.getChannelData(ch);
          for (let i = 0; i < data.length; i++) {
            const abs = Math.abs(data[i]);
            if (abs > peak) peak = abs;
          }
        }
        if (peak > 0.95) {
          const scale = 0.95 / peak;
          for (let ch = 0; ch < combined.numberOfChannels; ch++) {
            const data = combined.getChannelData(ch);
            for (let i = 0; i < data.length; i++) {
              data[i] *= scale;
            }
          }
        }
        decodedMap.other = combined;
      }

      if (backgroundPreload && isPlayingRef.current && loadedTrackIdRef.current !== targetId) {
        return false;
      }
      buffersRef.current = decodedMap;
      loadedTrackIdRef.current = targetId;
      const firstBuf = decodedMap.drums ?? decodedMap.vocals ?? decodedMap.bass ?? decodedMap.other;
      const dur = firstBuf?.duration ?? 323.13;
      setDurationSec(dur);
      if (!backgroundPreload && targetId !== activeDeckTrackId) {
        offsetSecRef.current = 0;
        setPositionSec(0);
      }
      setStemStatus(
        `✅ Stems Ready for "${titleOverride ?? trackTitle}" (${formatMmSs(dur)}) — Click any Horn/Beat Loop or Isolation button!`
      );
      if (titleOverride) setTrackTitle(titleOverride);
      if (bpmOverride) setTrackBpm(bpmOverride);
      if (camelotOverride) setTrackCamelot(camelotOverride);
      return true;
    } catch (err) {
      setStemStatus(`⚠️ Could not load stems: ${err instanceof Error ? err.message : "network error"}`);
      return false;
    } finally {
      setLoadingStems(false);
    }
  }

  function startPlaybackFromOffset(
    startOffset: number,
    currentTitle = trackTitle,
    currentBpm = trackBpm,
    customLoopWindow: { startSec: number; endSec: number; bars: number; label: string } | null = loopWindowRef.current,
    overrideLevels = levels,
    overrideMuted = muted,
    overrideSoloed = soloed,
    overrideTempo = stemTempo
  ) {
    onBeforePlay?.();
    const ctx = core.ensureContext();
    stopSources();
    const newSources: Partial<Record<StemRoleKey, AudioBufferSourceNode>> = {};
    const newGains: Partial<Record<StemRoleKey, GainNode>> = {};
    const startWhen = ctx.currentTime + 0.018;

    let effectiveStartOffset = startOffset;
    for (const { key } of STEM_ROLES) {
      const buffer = buffersRef.current[key];
      if (!buffer) continue;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.playbackRate.value = overrideTempo;
      let safeOffset = buffer.duration > 0 ? Math.max(0, startOffset % buffer.duration) : 0;
      if (customLoopWindow && buffer.duration > 0 && customLoopWindow.endSec > customLoopWindow.startSec) {
        const lStart = Math.max(0, Math.min(customLoopWindow.startSec, buffer.duration - 0.1));
        const lEnd = Math.max(lStart + 0.1, Math.min(customLoopWindow.endSec, buffer.duration));
        source.loopStart = lStart;
        source.loopEnd = lEnd;
        if (safeOffset < lStart || safeOffset >= lEnd) {
          safeOffset = lStart;
        }
      }
      effectiveStartOffset = safeOffset;
      const gain = ctx.createGain();
      const targetGain = computeEffectiveGain(key, overrideLevels, overrideMuted, overrideSoloed);
      gain.gain.setValueAtTime(0.0001, startWhen);
      gain.gain.linearRampToValueAtTime(targetGain, startWhen + 0.012);
      source.connect(gain);
      gain.connect(core.master);
      source.start(startWhen, safeOffset);
      newSources[key] = source;
      newGains[key] = gain;
    }
    sourcesRef.current = newSources;
    gainsRef.current = newGains;
    startedAtCtxTimeRef.current = startWhen;
    offsetSecRef.current = effectiveStartOffset;
    setPositionSec(effectiveStartOffset);
    isPlayingRef.current = true;
    setIsPlaying(true);
    onPlayingChange?.(true, currentBpm * overrideTempo, currentTitle);
  }

  async function ensureStemsAndRun(
    actionLabel: string,
    opts: {
      loopBars?: number | null;
      explicitLoop?: { startSec: number; endSec: number; bars: number; label: string } | null;
      seekSec?: number;
      nextLevels?: Record<StemRoleKey, number>;
      nextMuted?: Record<StemRoleKey, boolean>;
      nextSoloed?: Record<StemRoleKey, boolean>;
    }
  ) {
    // Capture the live deck's exact current timestamp & tempo BEFORE stopping the deck!
    const wasPlayingStems = isPlayingRef.current;
    const basePos =
      opts.seekSec !== undefined
        ? opts.seekSec
        : opts.explicitLoop
          ? opts.explicitLoop.startSec
          : wasPlayingStems
            ? currentLivePositionSec()
            : selectedId === activeDeckTrackId && activeDeckPositionSec > 0
              ? activeDeckPositionSec
              : offsetSecRef.current || 0;
    const nextTempo = !wasPlayingStems && selectedId === activeDeckTrackId && activeDeckTempo > 0 ? activeDeckTempo : stemTempo;
    if (nextTempo !== stemTempo) setStemTempo(nextTempo);

    const nextLevels = opts.nextLevels ?? levels;
    const nextMuted = opts.nextMuted ?? muted;
    const nextSoloed = opts.nextSoloed ?? soloed;
    setLevels(nextLevels);
    setMuted(nextMuted);
    setSoloed(nextSoloed);

    const myGen = ++loadGenRef.current;
    if (loadedTrackIdRef.current !== selectedId || !buffersRef.current.drums) {
      const ok = await loadStemsForTrack(selectedId, trackTitle, trackBpm, trackCamelot, false);
      if (!ok || loadGenRef.current !== myGen) return;
    }

    const dur = buffersRef.current.drums?.duration ?? durationSec ?? 323.13;
    let nextLoop = loopWindowRef.current;
    if (opts.explicitLoop !== undefined) {
      nextLoop = opts.explicitLoop;
    } else if (opts.loopBars !== undefined) {
      if (opts.loopBars === null || opts.loopBars <= 0) {
        nextLoop = null;
      } else {
        const beatSec = 60 / Math.max(60, trackBpm);
        const barSec = beatSec * 4;
        const anchor = selectedId === activeDeckTrackId ? activeDeckAnchorSec : 0;
        const barIdx = Math.max(0, Math.floor((basePos - anchor) / barSec));
        const startSec = Math.max(0, Math.min(dur - barSec, anchor + barIdx * barSec));
        const endSec = Math.min(dur, startSec + opts.loopBars * barSec);
        nextLoop = {
          startSec,
          endSec,
          bars: opts.loopBars,
          label: `${opts.loopBars}-Bar Loop (${formatMmSs(startSec)}–${formatMmSs(endSec)})`,
        };
      }
    }
    setActiveLoopWindow(nextLoop);
    startPlaybackFromOffset(
      nextLoop ? Math.max(nextLoop.startSec, Math.min(basePos, nextLoop.endSec - 0.05)) : basePos,
      trackTitle,
      trackBpm,
      nextLoop,
      nextLevels,
      nextMuted,
      nextSoloed,
      nextTempo
    );
    setStemStatus(
      nextLoop
        ? `🔁 ${actionLabel} — Looping ${nextLoop.label}`
        : `🔊 ${actionLabel} at ${formatMmSs(basePos)}`
    );
    onLog(
      "stem_mixer",
      nextLoop
        ? `🎛️ ${actionLabel} on "${trackTitle}" [${nextLoop.label}]`
        : `🎛️ ${actionLabel} on "${trackTitle}" @ ${formatMmSs(basePos)}`
    );
  }

  function handleShiftBars(deltaBars: number) {
    const dur = buffersRef.current.drums?.duration ?? durationSec ?? 323.13;
    const beatSec = 60 / Math.max(60, trackBpm);
    const barSec = beatSec * 4;
    const shiftSec = deltaBars * barSec;
    const curLoop = loopWindowRef.current;
    if (curLoop) {
      const len = curLoop.endSec - curLoop.startSec;
      const newStart = Math.max(0, Math.min(dur - len, curLoop.startSec + shiftSec));
      const newEnd = Math.min(dur, newStart + len);
      void ensureStemsAndRun(`Shifted Loop ${deltaBars > 0 ? `+${deltaBars}` : deltaBars} Bars`, {
        explicitLoop: {
          startSec: newStart,
          endSec: newEnd,
          bars: curLoop.bars,
          label: `${curLoop.bars}-Bar Loop (${formatMmSs(newStart)}–${formatMmSs(newEnd)})`,
        },
        seekSec: newStart,
      });
    } else {
      const curPos = currentLivePositionSec();
      const target = Math.max(0, Math.min(dur - 1, curPos + shiftSec));
      void ensureStemsAndRun(`Jumped ${deltaBars > 0 ? `+${deltaBars}` : deltaBars} Bars`, {
        seekSec: target,
      });
    }
  }

  async function handleTogglePlay() {
    if (isPlayingRef.current || loadingStems) {
      const curPos = currentLivePositionSec();
      offsetSecRef.current = curPos;
      setPositionSec(curPos);
      stopSources();
      onPurgeMasterBus?.();
      setStemStatus(`⏹ Paused 4-Stem Isolator at ${formatMmSs(curPos)}`);
      return;
    }
    await ensureStemsAndRun("Playing 4-Stem Live Isolator", {});
  }

  async function handleSelectSongFromDropdown(targetId: string) {
    const found = stemReadyCrateTracks.find((t) => t.id === targetId);
    const manifestEntry = PLAYBACK_MANIFEST.get(targetId);
    const title = found?.title ?? (manifestEntry ? musicLabel({ name: manifestEntry.name }) : targetId);
    const bpm = found?.bpm ?? manifestEntry?.bpm ?? 120;
    const camelot = found?.camelot ?? toCamelot(manifestEntry?.key ?? null) ?? manifestEntry?.key ?? "8A";
    stopSources();
    setActiveLoopWindow(null);
    setSelectedId(targetId);
    setTrackTitle(title);
    setTrackBpm(bpm);
    setTrackCamelot(camelot);
    offsetSecRef.current = 0;
    setPositionSec(0);
    await loadStemsForTrack(targetId, title, bpm, camelot, false);
  }

  function applyStemPreset(
    presetName: string,
    nextLevels: Record<StemRoleKey, number>,
    nextMuted: Record<StemRoleKey, boolean>,
    nextSoloed: Record<StemRoleKey, boolean>
  ) {
    if (isPlayingRef.current) {
      setLevels(nextLevels);
      setMuted(nextMuted);
      setSoloed(nextSoloed);
      syncGainNodes(nextLevels, nextMuted, nextSoloed);
      setStemStatus(
        loopWindowRef.current
          ? `🎛️ ${presetName} · Looping ${loopWindowRef.current.label}`
          : `🎛️ Stem Preset Active: ${presetName}`
      );
      onLog("stem_mixer", `🎛️ Applied 4-Stem Isolation Preset: ${presetName}`);
      return;
    }
    void ensureStemsAndRun(presetName, {
      nextLevels,
      nextMuted,
      nextSoloed,
    });
  }

  return (
    <section className={styles.stemMixerPanel} aria-label="Live 4-Stem Studio Mixer">
      <div className={styles.stemMixerHeader}>
        <div>
          <span className={styles.stemBadge}>⚡ REAL-TIME 6-STEM ISOLATOR &amp; HORN / BEAT LOOPER</span>
          <h2 className={styles.stemMixerTitle}>
            🎛️ Live Song Stem Isolator &amp; Horn / Beat Loop Studio
          </h2>
          <p className={styles.stemMixerSub}>
            Automatically locked to your playing song (<strong>{trackTitle}</strong>). Click <strong>🎺 Loop Horns + Beat</strong> or any <strong>Song Hook</strong> below to strip out the vocals and loop the horn riff &amp; beat right where you are listening!
          </p>
        </div>
        <div className={styles.stemHeaderActions} style={{ flexWrap: "wrap", gap: 8 }}>
          {onReturnToDeck && selectedId === activeDeckTrackId && (
            <button
              type="button"
              className={styles.stemActionBtn}
              onClick={handleHandBackToDeck}
              style={{
                background: "linear-gradient(135deg, #10b981, #059669)",
                color: "#ffffff",
                fontWeight: 800,
                border: "2px solid #34d399",
              }}
              title="Hand playback smoothly back to the main DJ Deck at the exact current timestamp"
            >
              🔙 Return to Normal Deck ({formatMmSs(positionSec)})
            </button>
          )}
          <button
            type="button"
            className={styles.stemSendDeckBtn}
            onClick={() => {
              handleHardStopStems();
              onLoadVipToDeck(selectedId);
            }}
          >
            📥 Send &ldquo;{trackTitle.split("—")[0].trim()}&rdquo; to Deck
          </button>
          <button
            type="button"
            className={styles.stemActionBtn}
            onClick={handleHardStopStems}
            style={{
              background: "linear-gradient(135deg, #ef4444, #991b1b)",
              color: "#ffffff",
              fontWeight: 800,
              border: "2px solid #f87171",
              boxShadow: isPlaying ? "0 0 14px rgba(239, 68, 68, 0.75)" : undefined,
            }}
            title="Immediately turn off all 4-Stem Mixer channels and silence any looping stem"
          >
            🛑 STOP STEMS
          </button>
        </div>
      </div>

      {/* Song Selector & Active Deck Sync Row */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "10px 14px",
          marginBottom: 12,
          borderRadius: 10,
          background: "rgba(15, 23, 42, 0.75)",
          border: "1px solid rgba(56, 189, 248, 0.35)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800, color: "#38bdf8", fontSize: "0.86rem" }}>
            🎵 TARGET SONG:
          </span>
          <strong style={{ color: "#f8fafc", fontSize: "0.95rem" }}>{trackTitle}</strong>
          <span style={{ color: "#94a3b8", fontSize: "0.82rem" }}>
            ({(trackBpm * stemTempo).toFixed(1)} BPM · Key {trackCamelot})
          </span>
          {activeDeckTrackId && selectedId !== activeDeckTrackId && (STEM_MANIFEST as Record<string, StemManifestEntry>)[activeDeckTrackId] && (
            <button
              type="button"
              className={styles.stemPresetBtn}
              onClick={() => {
                const manifestEntry = PLAYBACK_MANIFEST.get(activeDeckTrackId);
                const nextTitle = activeDeckTrackName ? musicLabel({ name: activeDeckTrackName }) : manifestEntry ? musicLabel({ name: manifestEntry.name }) : activeDeckTrackId;
                const nextBpm = activeDeckBpm ?? manifestEntry?.bpm ?? 120;
                const nextCamelot = activeDeckCamelot ?? toCamelot(manifestEntry?.key ?? null) ?? manifestEntry?.key ?? "8A";
                stopSources();
                setActiveLoopWindow(null);
                setSelectedId(activeDeckTrackId);
                setTrackTitle(nextTitle);
                setTrackBpm(nextBpm);
                setTrackCamelot(nextCamelot);
                offsetSecRef.current = activeDeckPositionSec || 0;
                setPositionSec(activeDeckPositionSec || 0);
                void loadStemsForTrack(activeDeckTrackId, nextTitle, nextBpm, nextCamelot, false);
              }}
              style={{
                background: "linear-gradient(135deg, #0ea5e9, #2563eb)",
                color: "#fff",
                fontWeight: 800,
              }}
            >
              🔄 Sync to Active Deck ({activeDeckTrackName ? musicLabel({ name: activeDeckTrackName }).slice(0, 26) : "Deck"})
            </button>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <label style={{ fontSize: "0.8rem", color: "#cbd5e1", fontWeight: 600 }}>
            Or Pick Any 4-Stem Song:{" "}
            <select
              value={selectedId}
              onChange={(e) => void handleSelectSongFromDropdown(e.target.value)}
              style={{
                padding: "5px 8px",
                borderRadius: 6,
                background: "#0f172a",
                color: "#f8fafc",
                border: "1px solid #475569",
                maxWidth: 280,
                fontSize: "0.82rem",
              }}
              aria-label="Select a song for 4-Stem Isolation and Looping"
            >
              {stemReadyCrateTracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* 🥁 LIVE VISUAL BEAT & BAR COUNTER + 2-TAP "LOOP BY EAR" (No Mental Counting Needed!) */}
      <div
        style={{
          padding: "12px 14px",
          marginBottom: 12,
          borderRadius: 12,
          background: "rgba(9, 13, 22, 0.9)",
          border: "1px solid rgba(251, 191, 36, 0.45)",
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
          <div>
            <span style={{ fontWeight: 900, color: "#fbbf24", fontSize: "0.86rem", letterSpacing: "0.03em" }}>
              🥁 LIVE BEAT &amp; BAR COUNTER — BAR #{songBarNum} AT {formatMmSs(positionSec)}
            </span>
            <div style={{ fontSize: "0.76rem", color: "#cbd5e1", marginTop: 2 }}>
              <strong>How DJs Count:</strong> 1 Bar = <strong>4 Beats</strong> (<strong>{barSec.toFixed(1)}s</strong>) · 4 Bars = <strong>16 Beats</strong> (<strong>{(barSec * 4).toFixed(1)}s</strong> = 1 full horn/synth riff) · 8 Bars = <strong>32 Beats</strong> (<strong>{(barSec * 8).toFixed(1)}s</strong> = full drop)
            </div>
          </div>

          {/* 4 Flashing Beat Boxes (1 - 2 - 3 - 4) */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {([1, 2, 3, 4] as const).map((b) => {
              const isBeatNow = beatInBar === b;
              const isDownbeat = b === 1;
              return (
                <div
                  key={b}
                  style={{
                    padding: "6px 11px",
                    borderRadius: 8,
                    fontWeight: 900,
                    fontSize: "0.8rem",
                    background: isBeatNow
                      ? isDownbeat
                        ? "linear-gradient(135deg, #f59e0b, #ea580c)"
                        : "linear-gradient(135deg, #06b6d4, #0284c7)"
                      : "rgba(30, 41, 59, 0.85)",
                    color: isBeatNow ? (isDownbeat ? "#090d16" : "#ffffff") : "#64748b",
                    border: isBeatNow
                      ? isDownbeat
                        ? "2px solid #fde047"
                        : "2px solid #38bdf8"
                      : "1px solid rgba(71, 85, 105, 0.5)",
                    boxShadow: isBeatNow ? "0 0 12px rgba(56, 189, 248, 0.55)" : undefined,
                  }}
                >
                  {isDownbeat ? "🔥 BEAT 1 (DOWNBEAT)" : `BEAT ${b}`}
                </div>
              );
            })}
          </div>
        </div>

        {/* Bar Progress Row + 2-Tap "Punch Loop IN / OUT By Ear" */}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, paddingTop: 8, borderTop: "1px solid rgba(148, 163, 184, 0.2)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.76rem", fontWeight: 800, color: "#94a3b8" }}>
              {loopWindow ? `LOOP BAR (${totalCycleBars} BARS):` : "PHRASE BAR (4 BARS):"}
            </span>
            {Array.from({ length: Math.min(8, totalCycleBars) }, (_, idx) => idx + 1).map((barNum) => {
              const activeBar = barInCurrentCycle === barNum;
              return (
                <span
                  key={barNum}
                  style={{
                    padding: "4px 9px",
                    borderRadius: 6,
                    fontSize: "0.75rem",
                    fontWeight: 900,
                    background: activeBar ? "rgba(16, 185, 129, 0.32)" : "rgba(15, 23, 42, 0.8)",
                    color: activeBar ? "#34d399" : "#64748b",
                    border: activeBar ? "1.5px solid #10b981" : "1px solid rgba(51, 65, 85, 0.6)",
                  }}
                >
                  BAR {barNum}/{totalCycleBars}
                </span>
              );
            })}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.76rem", fontWeight: 800, color: "#fde68a" }}>
              👂 DON&apos;T WANT TO COUNT? TAP BY EAR:
            </span>
            <button
              type="button"
              className={styles.stemPresetBtn}
              onClick={() => {
                const curPos = currentLivePositionSec();
                const barIdx = Math.max(0, Math.round((curPos - gridAnchorSec) / barSec));
                const snappedStart = Math.max(0, gridAnchorSec + barIdx * barSec);
                setPunchInSec(snappedStart);
                setStemStatus(`📍 Loop IN marked at ${formatMmSs(snappedStart)} (Bar #${barIdx + 1}) — now tap "2. Tap Loop OUT" when the riff ends!`);
              }}
              style={{
                background: punchInSec !== null ? "linear-gradient(135deg, #f59e0b, #d97706)" : "rgba(245, 158, 11, 0.22)",
                color: punchInSec !== null ? "#090d16" : "#fde68a",
                borderColor: "#fbbf24",
                fontWeight: 900,
                padding: "5px 10px",
              }}
              title="Tap this when the horn/synth riff starts — it automatically snaps to the nearest bar!"
            >
              {punchInSec !== null ? `📍 1. Loop IN Set (${formatMmSs(punchInSec)})` : "📍 1. Tap When Riff Starts"}
            </button>
            <button
              type="button"
              className={styles.stemPresetBtn}
              onClick={() => {
                const curPos = currentLivePositionSec();
                const start = punchInSec !== null && curPos > punchInSec + 0.5 ? punchInSec : Math.max(0, curPos - 4 * barSec);
                const rawBars = Math.max(1, Math.round((curPos - start) / barSec));
                const snappedBars = rawBars <= 1 ? 1 : rawBars <= 2 ? 2 : rawBars <= 6 ? 4 : 8;
                const end = start + snappedBars * barSec;
                const label = `Ear-Tapped ${snappedBars}-Bar Riff (${formatMmSs(start)}–${formatMmSs(end)})`;
                setPunchInSec(null);
                void ensureStemsAndRun(label, {
                  explicitLoop: { startSec: start, endSec: end, bars: snappedBars, label },
                  seekSec: start,
                  nextLevels: { vocals: 1, drums: 1, bass: 1, other: 1 },
                  nextMuted: { vocals: true, drums: false, bass: false, other: false },
                  nextSoloed: { vocals: false, drums: false, bass: false, other: false },
                });
              }}
              style={{
                background: "linear-gradient(135deg, #10b981, #059669)",
                color: "#ffffff",
                borderColor: "#34d399",
                fontWeight: 900,
                padding: "5px 10px",
              }}
              title="Tap this when the riff finishes — locks & loops your exact riff (quantized to 1, 2, 4, or 8 bars) with Vocals removed!"
            >
              🔁 2. Tap When Riff Ends (Lock &amp; Loop!)
            </button>
          </div>
        </div>
      </div>

      {/* 🎺 1-CLICK HORN / MELODY & BEAT LOOP STUDIO (Quantized to the Song's BeatGrid!) */}
      <div
        style={{
          padding: "12px 14px",
          marginBottom: 12,
          borderRadius: 12,
          background: "linear-gradient(135deg, rgba(6, 182, 212, 0.16), rgba(245, 158, 11, 0.14))",
          border: "1px solid rgba(6, 182, 212, 0.5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
          <span style={{ fontWeight: 900, color: "#22d3ee", fontSize: "0.88rem", letterSpacing: "0.03em" }}>
            🎺 STEP 1 — 1-CLICK HORN &amp; BEAT LOOPERS (AT CURRENT SONG POSITION: {formatMmSs(positionSec)})
          </span>
          {loopWindow && (
            <span
              style={{
                padding: "3px 10px",
                borderRadius: 999,
                background: "#f59e0b",
                color: "#090d16",
                fontWeight: 900,
                fontSize: "0.78rem",
              }}
            >
              🔁 ACTIVE LOOP: {loopWindow.label}
            </span>
          )}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: songHooks.length > 0 ? 10 : 0 }}>
          <button
            type="button"
            className={styles.stemPresetBtn}
            onClick={() =>
              void ensureStemsAndRun("🎺 Loop Horns/Melody + Beat (No Vocals)", {
                loopBars: 4,
                nextLevels: { vocals: 1, drums: 1, bass: 1, other: 1 },
                nextMuted: { vocals: true, drums: false, bass: false, other: false },
                nextSoloed: { vocals: false, drums: false, bass: false, other: false },
              })
            }
            style={{
              background: "linear-gradient(135deg, #06b6d4, #0284c7)",
              color: "#ffffff",
              fontWeight: 900,
              borderColor: "#38bdf8",
              padding: "9px 14px",
            }}
            title="Strip out the vocals and loop 4 bars of the Horns/Melody + Drums + Bass right where you are in the song!"
          >
            🎺 Loop Horns + Beat Here (4 Bars · {(barSec * 4).toFixed(1)}s · No Vocals)
          </button>

          <button
            type="button"
            className={styles.stemPresetBtn}
            onClick={() =>
              void ensureStemsAndRun("🎺 Loop Horns / Melody ONLY", {
                loopBars: 4,
                nextLevels: { vocals: 1, drums: 1, bass: 1, other: 1 },
                nextMuted: { vocals: true, drums: true, bass: true, other: false },
                nextSoloed: { vocals: false, drums: false, bass: false, other: true },
              })
            }
            style={{
              background: "linear-gradient(135deg, #8b5cf6, #6d28d9)",
              color: "#ffffff",
              fontWeight: 800,
              borderColor: "#a855f7",
              padding: "9px 14px",
            }}
            title="Solo ONLY the Horns / Melody / Synth / Guitar stem and loop 4 bars right here"
          >
            🎺 Loop Horns / Melody Solo Here (4 Bars · {(barSec * 4).toFixed(1)}s)
          </button>

          <button
            type="button"
            className={styles.stemPresetBtn}
            onClick={() =>
              void ensureStemsAndRun("🥁 Loop Beat + Bass Pocket", {
                loopBars: 4,
                nextLevels: { vocals: 1, drums: 1, bass: 1, other: 1 },
                nextMuted: { vocals: true, drums: false, bass: false, other: true },
                nextSoloed: { vocals: false, drums: false, bass: false, other: false },
              })
            }
            style={{
              background: "linear-gradient(135deg, #f59e0b, #d97706)",
              color: "#090d16",
              fontWeight: 900,
              borderColor: "#fbbf24",
              padding: "9px 14px",
            }}
            title="Loop 4 bars of pure Drums + Bass (no vocals, no horns) right here"
          >
            🥁 Loop Beat + Bass Only Here (4 Bars · {(barSec * 4).toFixed(1)}s)
          </button>

          <button
            type="button"
            className={styles.stemPresetBtn}
            onClick={() =>
              void ensureStemsAndRun("🔊 Loop All 4 Stems Here", {
                loopBars: 4,
              })
            }
            style={{
              fontWeight: 800,
              padding: "9px 14px",
            }}
            title="Loop 4 bars at your current position while keeping your current stem faders/mutes"
          >
            🔁 Loop Current Mix Here (4 Bars · {(barSec * 4).toFixed(1)}s)
          </button>

          {loopWindow && (
            <button
              type="button"
              className={styles.stemPresetBtn}
              onClick={() => {
                const curPos = currentLivePositionSec();
                setActiveLoopWindow(null);
                if (isPlayingRef.current) {
                  startPlaybackFromOffset(curPos, trackTitle, trackBpm, null);
                }
                setStemStatus(`🔓 Loop Released — Continuing "${trackTitle}" from ${formatMmSs(curPos)}`);
                onLog("stem_mixer", `🔓 Released stem loop on "${trackTitle}" at ${formatMmSs(curPos)}`);
              }}
              style={{
                background: "linear-gradient(135deg, #10b981, #059669)",
                color: "#ffffff",
                fontWeight: 900,
                borderColor: "#34d399",
                padding: "9px 14px",
              }}
            >
              🔓 Release Loop (Keep Playing Song)
            </button>
          )}
        </div>

        {/* Song's Pre-Analyzed Horn/Melody Hooks & Beat Breakdowns from loop-points.json */}
        {songHooks.length > 0 && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(148, 163, 184, 0.25)" }}>
            <div style={{ fontSize: "0.78rem", fontWeight: 800, color: "#fde68a", marginBottom: 6 }}>
              🎯 ANALYZED HORN / SYNTH HOOKS, DROPS &amp; BEAT BREAKDOWNS IN &ldquo;{trackTitle}&rdquo; (IN TIME ORDER — CLICK TO JUMP &amp; LOOP NO VOCALS):
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {songHooks.map((h, idx) => {
                const isMelody = h.isolation === "melody";
                const label = `${h.kindLabel} (${formatMmSs(h.startSeconds)}–${formatMmSs(h.endSeconds)} · ${h.lengthBars} Bars / ${(h.endSeconds - h.startSeconds).toFixed(0)}s)`;
                const isCurrentHook =
                  loopWindow !== null &&
                  Math.abs(loopWindow.startSec - h.startSeconds) < 0.5 &&
                  Math.abs(loopWindow.endSec - h.endSeconds) < 0.5;
                return (
                  <button
                    key={`${h.startBar}-${h.lengthBars}-${idx}`}
                    type="button"
                    className={styles.stemPresetBtn}
                    onClick={() =>
                      void ensureStemsAndRun(label, {
                        explicitLoop: {
                          startSec: h.startSeconds,
                          endSec: h.endSeconds,
                          bars: h.lengthBars,
                          label,
                        },
                        seekSec: h.startSeconds,
                        nextLevels: { vocals: 1, drums: 1, bass: 1, other: 1 },
                        nextMuted: { vocals: true, drums: false, bass: false, other: false },
                        nextSoloed: { vocals: false, drums: false, bass: false, other: false },
                      })
                    }
                    style={{
                      background: isCurrentHook
                        ? "linear-gradient(135deg, #f59e0b, #ea580c)"
                        : isMelody
                          ? "rgba(6, 182, 212, 0.24)"
                          : "rgba(245, 158, 11, 0.2)",
                      color: isCurrentHook ? "#090d16" : "#f8fafc",
                      borderColor: isCurrentHook ? "#fde047" : isMelody ? "#22d3ee" : "#fbbf24",
                      fontWeight: 800,
                      fontSize: "0.79rem",
                    }}
                    title={`Jump to ${formatMmSs(h.startSeconds)}–${formatMmSs(h.endSeconds)} (${h.lengthBars} bars), mute Vocals, and loop Horns/Melody + Drums + Bass`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Bar Loop Size, BeatGrid Nudge & Interactive Full-Song Scrub Slider */}
      <div
        style={{
          padding: "10px 14px",
          marginBottom: 12,
          borderRadius: 10,
          background: "rgba(15, 23, 42, 0.65)",
          border: "1px solid rgba(148, 163, 184, 0.25)",
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: "0.78rem", fontWeight: 800, color: "#94a3b8" }}>LOOP SIZE (BEATS &amp; SECONDS):</span>
            {([1, 2, 4, 8] as const).map((bars) => {
              const activeBars = loopWindow?.bars === bars;
              const beatsCount = bars * 4;
              const secsVal = (bars * barSec).toFixed(1);
              return (
                <button
                  key={bars}
                  type="button"
                  className={styles.stemPresetBtn}
                  onClick={() => void ensureStemsAndRun(`Loop ${bars} Bar${bars > 1 ? "s" : ""}`, { loopBars: bars })}
                  style={{
                    background: activeBars ? "#06b6d4" : undefined,
                    color: activeBars ? "#090d16" : undefined,
                    fontWeight: 800,
                    padding: "5px 10px",
                  }}
                >
                  🔁 {bars} Bar{bars > 1 ? "s" : ""} ({beatsCount} Beats · {secsVal}s)
                </button>
              );
            })}
            <button
              type="button"
              className={styles.stemPresetBtn}
              onClick={() => {
                const curPos = currentLivePositionSec();
                setActiveLoopWindow(null);
                if (isPlayingRef.current) {
                  startPlaybackFromOffset(curPos, trackTitle, trackBpm, null);
                }
                setStemStatus(`🔓 Full Song Mode (No Bar Loop) at ${formatMmSs(curPos)}`);
              }}
              style={{
                background: loopWindow === null ? "rgba(52, 211, 153, 0.22)" : undefined,
                borderColor: loopWindow === null ? "#34d399" : undefined,
                fontWeight: 800,
                padding: "5px 10px",
              }}
            >
              🔓 Full Song (No Loop)
            </button>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: "0.78rem", fontWeight: 800, color: "#94a3b8" }}>MOVE WINDOW:</span>
            <button type="button" className={styles.stemPresetBtn} onClick={() => handleShiftBars(-4)} style={{ padding: "5px 9px", fontWeight: 700 }}>
              ⏪ -4 Bars
            </button>
            <button type="button" className={styles.stemPresetBtn} onClick={() => handleShiftBars(-1)} style={{ padding: "5px 9px", fontWeight: 700 }}>
              ⏪ -1 Bar
            </button>
            <button type="button" className={styles.stemPresetBtn} onClick={() => handleShiftBars(1)} style={{ padding: "5px 9px", fontWeight: 700 }}>
              ⏩ +1 Bar
            </button>
            <button type="button" className={styles.stemPresetBtn} onClick={() => handleShiftBars(4)} style={{ padding: "5px 9px", fontWeight: 700 }}>
              ⏩ +4 Bars
            </button>
          </div>
        </div>

        {/* Full-Song Timeline Scrub Slider */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: "0.8rem", fontWeight: 800, color: "#38bdf8", minWidth: 42 }}>
            {formatMmSs(positionSec)}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(1, durationSec)}
            step={0.1}
            value={Math.min(durationSec || 323, positionSec)}
            onChange={(e) => {
              const target = parseFloat(e.target.value);
              offsetSecRef.current = target;
              setPositionSec(target);
              if (loopWindowRef.current) {
                const len = loopWindowRef.current.endSec - loopWindowRef.current.startSec;
                const newEnd = Math.min(durationSec || 323, target + len);
                const nextLw = {
                  startSec: target,
                  endSec: newEnd,
                  bars: loopWindowRef.current.bars,
                  label: `${loopWindowRef.current.bars}-Bar Loop (${formatMmSs(target)}–${formatMmSs(newEnd)})`,
                };
                setActiveLoopWindow(nextLw);
                if (isPlayingRef.current) {
                  startPlaybackFromOffset(target, trackTitle, trackBpm, nextLw);
                }
              } else if (isPlayingRef.current) {
                startPlaybackFromOffset(target, trackTitle, trackBpm, null);
              }
            }}
            style={{ flex: 1, cursor: "pointer" }}
            aria-label="Scrub through song in 4-Stem Isolator"
          />
          <span style={{ fontSize: "0.8rem", fontWeight: 700, color: "#94a3b8", minWidth: 42 }}>
            {formatMmSs(durationSec)}
          </span>
        </div>
      </div>

      {/* Transport & Preset Bar */}
      <div className={styles.stemTransportBar}>
        <button
          type="button"
          className={`${styles.stemMasterPlayBtn} ${isPlaying ? styles.stemMasterPlayBtnActive : ""}`}
          onClick={() => void handleTogglePlay()}
        >
          {loadingStems ? "🛑 CANCEL / LOADING…" : isPlaying ? "⏹ PAUSE 4-STEM ISOLATOR" : `▶ ISOLATE "${trackTitle.slice(0, 22)}" AT ${formatMmSs(positionSec)}`}
        </button>
        <button
          type="button"
          className={styles.stemMasterPlayBtn}
          onClick={handleHardStopStems}
          style={{
            background: "linear-gradient(135deg, #ef4444, #991b1b)",
            color: "#ffffff",
            fontWeight: 800,
            borderColor: "#f87171",
          }}
        >
          🛑 TURN OFF STEMS
        </button>

        <div className={styles.stemReadoutBox}>
          <div className={styles.stemNowPlaying}>
            <strong>{trackTitle}</strong> · {(trackBpm * stemTempo).toFixed(1)} BPM · Key {trackCamelot}
          </div>
          <div className={styles.stemStatusLine}>
            {stemStatus} ({formatMmSs(positionSec)} / {formatMmSs(durationSec || 323.13)})
          </div>
        </div>

        <div className={styles.stemTempoBox}>
          <label className={styles.stemTempoLabel}>
            Stem Tempo: <strong>{(stemTempo * 100).toFixed(1)}%</strong>
            <input
              type="range"
              min={0.92}
              max={1.08}
              step={0.005}
              value={stemTempo}
              onChange={(e) => {
                const next = parseFloat(e.target.value);
                setStemTempo(next);
                for (const { key } of STEM_ROLES) {
                  if (sourcesRef.current[key]) {
                    sourcesRef.current[key]!.playbackRate.value = next;
                  }
                }
              }}
              aria-label="4-Stem Mixer Tempo"
            />
          </label>
        </div>
      </div>

      {/* 1-Click Stem Isolation Presets */}
      <div className={styles.stemPresetRow}>
        <span className={styles.stemPresetLabel}>STEP 2 — QUICK CHANNEL ISOLATION:</span>
        <button
          type="button"
          className={styles.stemPresetBtn}
          onClick={() =>
            applyStemPreset(
              "🎺 Horns/Melody + Beat (No Vocals / Instrumental)",
              { vocals: 1, drums: 1, bass: 1, other: 1 },
              { vocals: true, drums: false, bass: false, other: false },
              { vocals: false, drums: false, bass: false, other: false }
            )
          }
          style={{
            background: "rgba(6, 182, 212, 0.25)",
            borderColor: "#22d3ee",
            fontWeight: 800,
          }}
        >
          🎺 Horns + Beat (No Vocals)
        </button>
        <button
          type="button"
          className={styles.stemPresetBtn}
          onClick={() =>
            applyStemPreset(
              "🔥 Drums + Bass (Riddim Only)",
              { vocals: 1, drums: 1, bass: 1, other: 1 },
              { vocals: true, drums: false, bass: false, other: true },
              { vocals: false, drums: false, bass: false, other: false }
            )
          }
        >
          🔥 Drums + Bass (Riddim)
        </button>
        <button
          type="button"
          className={styles.stemPresetBtn}
          onClick={() =>
            applyStemPreset(
              "🎺 Horns / Melody Solo (Other + Guitar + Keys Only)",
              { vocals: 1, drums: 1, bass: 1, other: 1 },
              { vocals: true, drums: true, bass: true, other: false },
              { vocals: false, drums: false, bass: false, other: true }
            )
          }
        >
          🎺 Horns / Melody Solo
        </button>
        <button
          type="button"
          className={styles.stemPresetBtn}
          onClick={() =>
            applyStemPreset(
              "🎤 Acapella Only (BS-RoFormer Vocals)",
              { vocals: 1, drums: 1, bass: 1, other: 1 },
              { vocals: false, drums: true, bass: true, other: true },
              { vocals: true, drums: false, bass: false, other: false }
            )
          }
        >
          🎤 Acapella Only
        </button>
        <button
          type="button"
          className={styles.stemPresetBtn}
          onClick={() =>
            applyStemPreset(
              "🎹 Melodic Breakdown (Vocals + Horns/Melody, No Drums)",
              { vocals: 1, drums: 1, bass: 1, other: 1 },
              { vocals: false, drums: true, bass: true, other: false },
              { vocals: false, drums: false, bass: false, other: false }
            )
          }
        >
          🎹 Vocals + Horns (No Beat)
        </button>
        <button
          type="button"
          className={styles.stemPresetBtn}
          onClick={() =>
            applyStemPreset(
              "🔊 Full 4-Stem Club Mix",
              { vocals: 1, drums: 1, bass: 1, other: 1 },
              { vocals: false, drums: false, bass: false, other: false },
              { vocals: false, drums: false, bass: false, other: false }
            )
          }
        >
          🔊 All 4 Stems On
        </button>
        <button
          type="button"
          className={styles.stemPresetBtn}
          onClick={handleHardStopStems}
          style={{
            background: "#991b1b",
            color: "#ffffff",
            fontWeight: 800,
            borderColor: "#ef4444",
          }}
        >
          🛑 OFF / SILENCE STEMS
        </button>
      </div>

      {/* 4 Individual Stem Channel Strips */}
      <div className={styles.stemChannelsGrid}>
        {STEM_ROLES.map(({ key, label, icon, model, color }) => {
          const effGain = computeEffectiveGain(key);
          const isMuted = muted[key];
          const isSolo = soloed[key];
          return (
            <div
              key={key}
              className={`${styles.stemChannelCard} ${effGain === 0 ? styles.stemChannelSilenced : ""}`}
              style={{ borderTopColor: color }}
            >
              <div className={styles.stemChannelTop}>
                <span className={styles.stemChannelTitle}>
                  {icon} {label}
                </span>
                <span className={styles.stemModelBadge}>{model}</span>
              </div>

              <div className={styles.stemMeterBar}>
                <div
                  className={styles.stemMeterFill}
                  style={{
                    width: `${Math.min(100, Math.round(effGain * (isPlaying ? 82 : 35)))}%`,
                    background: effGain === 0 ? "#475569" : color,
                  }}
                />
              </div>

              <div className={styles.stemFaderRow}>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={levels[key]}
                  className={styles.stemFaderInput}
                  aria-label={`${label} stem volume`}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    const nextLevels = { ...levels, [key]: v };
                    setLevels(nextLevels);
                    if (isPlayingRef.current) {
                      syncGainNodes(nextLevels, muted, soloed);
                    } else if (!loadingStems) {
                      void ensureStemsAndRun(`Adjusted ${label} Fader`, { nextLevels });
                    }
                  }}
                />
                <span className={styles.stemFaderPct}>
                  {effGain === 0 ? "MUTED" : `${Math.round(levels[key] * 100)}%`}
                </span>
              </div>

              <div className={styles.stemButtonsRow}>
                <button
                  type="button"
                  className={`${styles.stemMuteBtn} ${isMuted ? styles.stemMuteBtnActive : ""}`}
                  onClick={() => {
                    const nextMuted = { ...muted, [key]: !muted[key] };
                    setMuted(nextMuted);
                    if (isPlayingRef.current) {
                      syncGainNodes(levels, nextMuted, soloed);
                    } else if (!loadingStems) {
                      void ensureStemsAndRun(`${nextMuted[key] ? "Muted" : "Unmuted"} ${label}`, { nextMuted });
                    }
                  }}
                  aria-pressed={isMuted}
                >
                  {isMuted ? "🔇 MUTED" : "M · MUTE"}
                </button>
                <button
                  type="button"
                  className={`${styles.stemSoloBtn} ${isSolo ? styles.stemSoloBtnActive : ""}`}
                  onClick={() => {
                    const nextSolo = { ...soloed, [key]: !soloed[key] };
                    setSoloed(nextSolo);
                    if (isPlayingRef.current) {
                      syncGainNodes(levels, muted, nextSolo);
                    } else if (!loadingStems) {
                      void ensureStemsAndRun(`${nextSolo[key] ? "Soloed" : "Unsoloed"} ${label}`, { nextSoloed: nextSolo });
                    }
                  }}
                  aria-pressed={isSolo}
                >
                  {isSolo ? "✨ SOLOED" : "S · SOLO"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CratePanel({
  crate,
  adding,
  fileInputRef,
  onAddClick,
  onFilesSelected,
  onTapTrack,
  onLoadToDeckA,
  onLoadToDeckB,
  onMashWithLive,
  driveTracks,
  driveListing,
  driveAdding,
  driveTagProgress,
  driveNotices,
  onLoadDrive,
  onAddAllFromDrive,
  cachedIds,
  onPrefetchNext10,
  prefetching,
  onGenreChange,
  metadataStatus,
}: {
  crate: CrateTrack[];
  adding: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onAddClick: () => void;
  onFilesSelected: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onTapTrack: (track: CrateTrack) => void;
  onLoadToDeckA?: (track: CrateTrack) => void;
  onLoadToDeckB?: (track: CrateTrack) => void;
  onMashWithLive?: (track: CrateTrack) => void;
  driveTracks: CrateTrackListing[] | null;
  driveListing: boolean;
  driveAdding: boolean;
  driveTagProgress: { done: number; total: number } | null;
  driveNotices: string[];
  onLoadDrive: () => void;
  onAddAllFromDrive: () => void;
  cachedIds: Set<string>;
  onPrefetchNext10: () => void;
  prefetching: boolean;
  onGenreChange: (id: string, genre: string) => void;
  metadataStatus: string;
}) {
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState("");
  const [sort, setSort] = useState<CrateSort>("original");
  const labels = useMemo(() => new Map(crate.map(track => [track.id, {
    ...trackSearchMetadata(track), label: musicLabel(track), review: needsGenreReview(track),
    stemCount: describeStems(track, (STEM_MANIFEST as Record<string, StemManifestEntry>)[track.id]).length,
  }])), [crate]);
  const visible = useMemo(() => searchAndSortCrate(crate, query, genre, sort), [crate, query, genre, sort]);
  const genres = useMemo(() => Array.from(new Set(crate.map(t => trackSearchMetadata(t).genre).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b)), [crate]);
  const playableCount = driveTracks?.filter((t) => t.playable).length ?? 0;
  const uncachedDriveCount = crate.filter((t) => t.source === "drive" && !cachedIds.has(t.id)).length;

  return (
    <section className={styles.cratePanel}>
      <div className={styles.deckHeader}>
        <span className={styles.deckLabel}>Crate ({crate.length} Tracks · 599 w/ 4-Stems)</span>
        <button type="button" className={styles.secondaryButton} onClick={onAddClick} disabled={adding}>
          {adding ? "Adding…" : "Add to crate"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/mpeg,.mp3"
          multiple
          className={styles.hiddenInput}
          onChange={onFilesSelected}
        />
      </div>

      <div className={styles.crateControls}>
        <input type="search" className={styles.chatInput} value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Search song, artist, or genre…" aria-label="Search crate by song, artist, or genre" />
        <select className={styles.cueSelect} aria-label="Filter crate by genre" value={genre} onChange={e => setGenre(e.target.value)}>
          <option value="">All genres</option>
          <option value="__untagged">Untagged</option>
          <option value="__review">Needs genre review</option>
          {genre && !["__untagged", "__review"].includes(genre) && !genres.includes(genre) && <option value={genre}>{genre} (no tracks)</option>}
          {genres.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <select className={styles.cueSelect} aria-label="Sort crate" value={sort} onChange={e => setSort(e.target.value as CrateSort)}>
          {CRATE_SORTS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {(query || genre || sort !== "original") && <button type="button" className={styles.resetButton}
          onClick={() => { setQuery(""); setGenre(""); setSort("original"); }}>Clear filters</button>}
      </div>
      <p className={styles.hint} role="status">{visible.length} of {crate.length} tracks</p>
      <datalist id="crate-genres">
        {Array.from(new Set([...genres, "Salsa", "Bachata", "Reggaeton", "Merengue", "Dembow", "Hip-Hop", "House", "Trance", "Pop"]))
          .map(value => <option key={value} value={value} />)}
      </datalist>
      {crate.length === 0 ? (
        <p className={styles.hint}>
          No tracks yet — add MP3s to build your crate. Local file-picker tracks are in-memory only (reloading
          clears them); Drive tracks restore automatically.
        </p>
      ) : visible.length === 0 ? (
        <p className={styles.hint}>No matching tracks. Try another search or clear the filters.</p>
      ) : (
        <ul className={styles.crateList}>
          {visible.map((track) => {
            // A track is "party-safe" (plays even if wifi dies) once its full
            // audio is cached — local file-picker entries always are (the
            // File is already in memory), Drive entries once getTrackBlob()
            // has actually downloaded them at least once.
            const isStudioVip = STUDIO_TRACK_IDS.has(track.id);
            const isCached = track.source === "local" || isStudioVip || cachedIds.has(track.id);
            const metadata = labels.get(track.id)!;
            return (
              <li key={track.id}>
                <button
                  type="button"
                  className={`${styles.crateItemButton} ${isStudioVip ? styles.crateItemVip : ""}`}
                  title={track.name}
                  onClick={() => onTapTrack(track)}
                >
                  <span className={styles.crateItemName}>
                    {isStudioVip && <span className={styles.crateVipBadge}>⚡ STUDIO 4-STEM VIP</span>}
                    {isCached ? "• " : ""}
                    {metadata.label}
                  </span>
                  <span className={styles.crateItemMeta}>
                    {metadata.genre || "Untagged"}{" · "}
                    {metadata.review ? "needs review · " : ""}
                    {track.bpm ? `${track.bpm} BPM` : "no BPM"}
                    {track.key ? ` · ${track.key}` : ""}
                    {" · grid: "}
                    {track.grid ? "yes" : "est"}
                    {` · ${metadata.stemCount} stems`}
                  </span>
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", marginTop: 4, marginBottom: 4 }}>
                  {onLoadToDeckA && (
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => onLoadToDeckA(track)}
                      style={{ padding: "3px 8px", fontSize: "0.73rem", fontWeight: 800, borderColor: "#38bdf8", color: "#38bdf8" }}
                      title={`Load "${metadata.label}" specifically onto Deck A`}
                    >
                      🅰️ Load Deck A
                    </button>
                  )}
                  {onLoadToDeckB && (
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => onLoadToDeckB(track)}
                      style={{ padding: "3px 8px", fontSize: "0.73rem", fontWeight: 800, borderColor: "#fb923c", color: "#fb923c" }}
                      title={`Load "${metadata.label}" specifically onto Deck B`}
                    >
                      🅱️ Load Deck B
                    </button>
                  )}
                  {onMashWithLive && metadata.stemCount > 0 && (
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => onMashWithLive(track)}
                      style={{ padding: "3px 8px", fontSize: "0.73rem", fontWeight: 800, borderColor: "#a855f7", color: "#e9d5ff", background: "rgba(168, 85, 247, 0.2)" }}
                      title={`Mash "${metadata.label}" vocals & melody over the currently playing song`}
                    >
                      🧬 Mash Into Playing Song
                    </button>
                  )}
                </div>
                <label className={styles.genreEditor}>
                  Genre
                  <input key={`${track.id}:${track.genre ?? ""}`} type="text" list="crate-genres" maxLength={80}
                    defaultValue={metadata.genre} placeholder="Add genre…"
                    aria-label={`Genre for ${metadata.label}`} onBlur={e => onGenreChange(track.id, e.target.value.trim())}
                    onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <div className={styles.driveSection}>
        <p className={styles.hint}>Full songs and their stems share artist, title and genre. Artist-based estimates are marked “needs review”; they are not verified tags. Edit a genre and press Enter to save across devices. Original audio filenames stay unchanged.</p>
        <p className={styles.hint} role="status">{metadataStatus}</p>
        <div className={styles.driveRow}>
          <button type="button" className={styles.secondaryButton} onClick={onLoadDrive} disabled={driveListing}>
            {driveListing ? "Loading…" : "Load crate from Drive"}
          </button>
          {driveTracks !== null && (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={onAddAllFromDrive}
              disabled={driveAdding || playableCount === 0}
            >
              {driveAdding
                ? driveTagProgress
                  ? `Reading tags ${driveTagProgress.done}/${driveTagProgress.total}…`
                  : "Reading tags…"
                : `Add ${playableCount} from Drive`}
            </button>
          )}
          {uncachedDriveCount > 0 && (
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={onPrefetchNext10}
              disabled={prefetching}
            >
              {prefetching ? "Prefetching…" : "Prefetch next 10"}
            </button>
          )}
        </div>
        {driveTracks !== null && driveTracks.length === 0 && (
          <p className={styles.hint}>Crate folder is empty — add music and refresh.</p>
        )}
        {driveTracks !== null && driveTracks.length > 0 && (
          <p className={styles.hint}>
            {driveTracks.length} file(s) found — {playableCount} playable (mp3), {driveTracks.length - playableCount} skipped
            (non-mp3).
          </p>
        )}
        {driveNotices.length > 0 && (
          <ul className={styles.driveNotices} aria-live="polite">
            {driveNotices.map((notice, index) => (
              <li key={index}>{notice}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

interface BrainLogEntry {
  id: number;
  action: string;
  say: string;
}

const GOLD_STANDARD_MASHUP_PRESETS: Array<{
  id: string;
  badge: string;
  title: string;
  subtitle: string;
  beatTrackId: string;
  vocalTrackId: string;
  bars: 16 | 32 | 64;
  accent: string;
}> = [
  {
    id: "gym_calvin_te_extrano",
    badge: "🏋️ YOUR GYM DISCOVERY (Cross-Genre)",
    title: "Calvin Harris · Feel So Close × Te Extraño",
    subtitle: "128.5 → 130 BPM (1.2% stretch) · 8-Bar Synth/House Groove × Full Bachata Vocals",
    beatTrackId: "1lZFsJSa_o6M83ZQlpqOncX_QnY8dnmju",
    vocalTrackId: "1W2ac_DeE9OzHaQVzNtXy3xX-p-Ydzt1B",
    bars: 64,
    accent: "linear-gradient(135deg, #f97316, #ec4899)",
  },
  {
    id: "blame_bad_bunny_5a",
    badge: "🔥 CROSS-GENRE 5A TONIC LOCK",
    title: "Calvin Harris · Blame × Bad Bunny · NI BIEN NI MAL",
    subtitle: "128 BPM (0.0% stretch · 5A Cm Lock) · Festival House Beat × Full Bad Bunny Hook & Verse",
    beatTrackId: "1zl2bmgRSzcBQxNvsmr_BKAD6VGDf3YTb",
    vocalTrackId: "1g3CtbD9xVzEzRdDTs_BLIAW6hxd5RTbi",
    bars: 64,
    accent: "linear-gradient(135deg, #8b5cf6, #ec4899)",
  },
  {
    id: "blame_romeo_drake_5a_5b",
    badge: "🔥 CROSS-GENRE 5A↔5B RELATIVE LOCK",
    title: "Calvin Harris · Blame × Romeo Santos & Drake · Odio",
    subtitle: "128 BPM (0.0% stretch · 5A↔5B) · House Groove Pocket × Romeo & Drake Full Vocals",
    beatTrackId: "1zl2bmgRSzcBQxNvsmr_BKAD6VGDf3YTb",
    vocalTrackId: "1GoQFQNamjEeaM-85fJOQPA_uoWIM6A5B",
    bars: 64,
    accent: "linear-gradient(135deg, #6366f1, #a855f7)",
  },
  {
    id: "reggaeton_98_8a",
    badge: "🔥 SAME-GENRE REGGAETON 8A LOCK",
    title: "Chyno, Wisin & Gente de Zona × Farruko · Nervios de Acero",
    subtitle: "98 BPM (0.0% stretch · 8A Am Lock) · Quédate Conmigo Dembow × Farruko Full Hook",
    beatTrackId: "10_fjwTNV20k4N-0NlY8UaNp2je2SuFCS",
    vocalTrackId: "1rhKtFEWOVtkYkaPfl5TVBdiMxRbsWz8H",
    bars: 64,
    accent: "linear-gradient(135deg, #10b981, #059669)",
  },
  {
    id: "reggaeton_92_8a",
    badge: "🔥 SAME-GENRE REGGAETON 8A LOCK",
    title: "Bad Bunny · A Tu Merced × Farruko & Lenier · La Bendición",
    subtitle: "92 BPM (0.01% stretch · 8A Am Lock) · YHLQMDLG Dembow Pocket × La Bendición Coro",
    beatTrackId: "1EHbX5zhcEzo22JWoAdC73P6pNcuaUeGO",
    vocalTrackId: "1rAom4FxzA10KMjitHBWvGyqBYGd72HXh",
    bars: 64,
    accent: "linear-gradient(135deg, #0ea5e9, #2563eb)",
  },
  {
    id: "bachata_124_aventura",
    badge: "🔥 SAME-GENRE BACHATA ANTHEMS",
    title: "Aventura · Inmortal × Aventura · Dile Al Amor",
    subtitle: "124 BPM (0.01% stretch · 12A↔1B) · Inmortal Bongo/Bass Pocket × Dile Al Amor Hook",
    beatTrackId: "1VwQdmKx4MnyvsQl4he1PhMF87_mKdEGI",
    vocalTrackId: "1BCRa3h9w2Ngm6zWF0kSQ-fg1AaNEetaQ",
    bars: 64,
    accent: "linear-gradient(135deg, #eab308, #ca8a04)",
  },
  {
    id: "trance_atb_incondicional_8a",
    badge: "⚡ TRANCE × BACHATA 8A TONIC LOCK",
    title: "ATB · 9Pm (Till I Come) × Prince Royce · Incondicional",
    subtitle: "129.9 → 128.9 BPM (0.7% stretch · 8A Am Lock) · ATB Rolling Guitar/4x4 Pocket × Incondicional Full Vocals",
    beatTrackId: "1pZipB7IzLrNt-LWWKkqkZPt4WFwt_4ne",
    vocalTrackId: "1_EaN7Mug5gpaDahAs4BHEpyi97pbWqAD",
    bars: 64,
    accent: "linear-gradient(135deg, #06b6d4, #3b82f6)",
  },
  {
    id: "trance_cafedelmar_monotonia_4a",
    badge: "⚡ TRANCE × BACHATA 4A TONIC LOCK",
    title: "Energy 52 · Café del Mar × Shakira & Ozuna · Monotonía",
    subtitle: "131.5 → 132 BPM (0.4% stretch · 4A Fm Lock) · Three 'n One Trance Groove × Shakira & Ozuna Full Vocals",
    beatTrackId: "1YS12BHPDj1Jyz-BC2hJRFW5JsLdEPuv3",
    vocalTrackId: "1H3WLopXVI40KLQfdQQeXpm8ibtYz7Zac",
    bars: 64,
    accent: "linear-gradient(135deg, #ec4899, #8b5cf6)",
  },
  {
    id: "trance_4strings_solita_2a",
    badge: "⚡ TRANCE × LATIN TRAP 2A LOCK",
    title: "4 Strings · Take Me Away × Ozuna & Bad Bunny · Solita",
    subtitle: "137.7 → 138 BPM (0.2% stretch · 2A E♭m Lock) · Uplifting Trance 4x4 Bassline × Bad Bunny & Ozuna Vocals",
    beatTrackId: "1DUfEUgIzhnCUTNFygllhLiWwUxW85UHi",
    vocalTrackId: "1UzKISSbHuDOfx18xtMCwcjar6kTuNZ-_",
    bars: 64,
    accent: "linear-gradient(135deg, #a855f7, #6366f1)",
  },
  {
    id: "trance_pvd_silence_8a",
    badge: "⚡ CLASSIC TRANCE ANTHEM 8A LOCK",
    title: "Paul van Dyk · For An Angel × Delerium · Silence (Tiësto Remix)",
    subtitle: "138.0 → 137.7 BPM (0.3% stretch · 8A Am Lock) · PvD Rolling 4x4 Groove × Sarah McLachlan Full Vocals",
    beatTrackId: "1wPaLWHzizMzYR81fQMec-mFImo8u3xvX",
    vocalTrackId: "1jI8MNxmId1SKecdEmWV7W29lQMqugfNY",
    bars: 64,
    accent: "linear-gradient(135deg, #14b8a6, #0284c7)",
  },
];

function BrainPanel({
  autopilot,
  onToggleAutopilot,
  partyPlannedSeconds,
  onPartyPlannedSecondsChange,
  chatInput,
  onChatInputChange,
  onChatSubmit,
  brainBusy,
  brainLog,
  costTotal,
  lastCost,
  lastModel,
  onResetCost,
  modelOptions,
  selectedModel,
  onModelChange,
  modelOnly,
  onModelOnlyChange,
  unpricedCalls,
  lastLatency,
  onSkipNext,
  onTriggerLiveMashup,
  onStartPairMashup,
  crate,
  onSeekLive,
  onJumpToBeatLive,
  hasLiveTrack,
  onSoloActiveDeck,
  onStopAllAudio,
  activeTrackId = null,
  activeTrackName = null,
  activeLoopLabel = null,
  onTriggerStemLoop,
  onReleaseStemLoop,
  onOpenStemStudio,
}: {
  autopilot: boolean;
  onToggleAutopilot: () => void;
  partyPlannedSeconds: number | null;
  onPartyPlannedSecondsChange: (seconds: number | null) => void;
  chatInput: string;
  onChatInputChange: (value: string) => void;
  onChatSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  brainBusy: boolean;
  brainLog: BrainLogEntry[];
  costTotal: number;
  lastCost: number | null;
  lastModel: string | null;
  onResetCost: () => void;
  modelOptions: BrainModelOption[];
  selectedModel: BrainModelId;
  onModelChange: (model: BrainModelId) => void;
  modelOnly: boolean;
  onModelOnlyChange: (value: boolean) => void;
  unpricedCalls: number;
  lastLatency: number | null;
  onSkipNext: (instantCut: boolean) => void;
  onTriggerLiveMashup: (fullSong?: boolean) => void;
  onStartPairMashup: (beatTrackId: string, vocalTrackId: string, bars: 16 | 32 | 64) => void;
  crate: CrateTrack[];
  onSeekLive: (deltaSeconds: number) => void;
  onJumpToBeatLive: () => void;
  hasLiveTrack: boolean;
  onSoloActiveDeck: () => void;
  onStopAllAudio: () => void;
  activeTrackId?: string | null;
  activeTrackName?: string | null;
  activeLoopLabel?: string | null;
  onTriggerStemLoop?: (opts: {
    isolation: "melody" | "beat";
    bars: 1 | 2 | 4 | 8;
    startSeconds?: number;
    endSeconds?: number;
    label?: string;
  }) => void;
  onReleaseStemLoop?: () => void;
  onOpenStemStudio?: () => void;
}) {
  const [showMashupStudio, setShowMashupStudio] = useState(false);
  const [customBeatId, setCustomBeatId] = useState<string>("1lZFsJSa_o6M83ZQlpqOncX_QnY8dnmju");
  const [customVocalId, setCustomVocalId] = useState<string>("1W2ac_DeE9OzHaQVzNtXy3xX-p-Ydzt1B");
  const [customBars, setCustomBars] = useState<16 | 32 | 64>(64);

  const activeSongHooks = useMemo(() => {
    if (!activeTrackId) return [];
    const entry = getLoopPoints(CURRENT_LOOP_POINTS, `drive:${activeTrackId}`);
    if (!entry) return [];
    const bpmVal = entry.bpm > 0 ? entry.bpm : 120;
    const barSecVal = (60 / bpmVal) * 4;
    const items: Array<{
      startBar: number;
      lengthBars: 2 | 4 | 8;
      startSeconds: number;
      endSeconds: number;
      isolation: "melody" | "beat";
      kindLabel: string;
    }> = [];

    for (const l of entry.loops ?? []) {
      const vDb = (l as { vocalsDb?: number }).vocalsDb;
      const isVocalFree = typeof vDb === "number" && vDb <= -24;
      const isMelody = l.isolation === "melody" || isVocalFree;
      items.push({
        startBar: l.startBar,
        lengthBars: (l.lengthBars === 2 || l.lengthBars === 4 || l.lengthBars === 8 ? l.lengthBars : 4) as 2 | 4 | 8,
        startSeconds: l.startSeconds,
        endSeconds: l.endSeconds,
        isolation: isMelody ? "melody" : "beat",
        kindLabel: l.isolation === "melody" ? "🎺 Horn/Melody" : isVocalFree ? "🎺 Synth/Horn Hook" : "🥁 Beat Groove",
      });
    }

    for (let i = 0; i < (entry.drops ?? []).length; i++) {
      const d = entry.drops[i];
      const alreadyCovered = items.some((it) => Math.abs(it.startSeconds - d.atSeconds) < 2.0);
      if (!alreadyCovered) {
        items.push({
          startBar: (d as { bar?: number }).bar ?? Math.round(d.atSeconds / barSecVal),
          lengthBars: 8,
          startSeconds: d.atSeconds,
          endSeconds: d.atSeconds + 8 * barSecVal,
          isolation: "melody",
          kindLabel: `🔥 Drop #${i + 1}`,
        });
      }
    }

    return items.sort((a, b) => a.startSeconds - b.startSeconds);
  }, [activeTrackId]);

  const stemReadyTracks = useMemo(() => {
    const base = crate.length > 0 ? crate : (crateManifestJson as CrateManifestEntry[]);
    return base
      .filter((t) => usableStemEntry((STEM_MANIFEST as Record<string, StemManifestEntry>)[t.id]) !== null && (t.bpm ?? 0) >= 70)
      .map((t) => ({
        id: t.id,
        label: `${musicLabel(t)} (${Math.round(t.bpm ?? 0)} BPM · ${toCamelot(t.key ?? null) ?? t.key ?? "—"})`,
        bpm: t.bpm ?? 100,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [crate]);

  const selectedBeatBpm = useMemo(() => {
    return stemReadyTracks.find((t) => t.id === customBeatId)?.bpm ?? 128;
  }, [stemReadyTracks, customBeatId]);

  const compatibleVocalTracks = useMemo(() => {
    const close = stemReadyTracks.filter(
      (t) => t.id !== customBeatId && Math.abs(selectedBeatBpm / t.bpm - 1) <= 0.06
    );
    return close.length > 0 ? close : stemReadyTracks.filter((t) => t.id !== customBeatId);
  }, [stemReadyTracks, customBeatId, selectedBeatBpm]);

  return (
    <section className={styles.brainPanel}>
      <div className={styles.deckHeader} style={{ flexWrap: "wrap", gap: 8 }}>
        <span className={styles.deckLabel}>Brain</span>
        <button
          type="button"
          className={styles.syncButton}
          onClick={onToggleAutopilot}
          aria-pressed={autopilot}
        >
          {autopilot ? "Autopilot: ON" : "Start autopilot"}
        </button>
        <select
          className={styles.cueSelect}
          aria-label="Party length"
          value={partyPlannedSeconds === null ? "off" : String(partyPlannedSeconds)}
          onChange={(event) => {
            const value = event.target.value;
            onPartyPlannedSecondsChange(value === "off" ? null : Number(value));
          }}
        >
          {PARTY_LENGTH_OPTIONS.map((opt) => (
            <option key={opt.label} value={opt.seconds === null ? "off" : String(opt.seconds)}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.fxRow} style={{ marginTop: 8, marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
        <button
          type="button"
          className={styles.syncButton}
          onClick={() => onTriggerLiveMashup(false)}
          title="Execute a 16-bar Live Stem Mashup (holds an 8-bar drum+bass groove pocket on the active song while layering the next song's Chorus/Hook vocal & guitar before swapping the bass)"
          style={{
            fontWeight: 800,
            background: "linear-gradient(135deg, #8b5cf6, #ec4899)",
            color: "#fff",
            borderColor: "#a855f7",
          }}
        >
          🧬 16-Bar Mashup Now
        </button>
        <button
          type="button"
          className={styles.syncButton}
          onClick={() => onTriggerLiveMashup(true)}
          title="Mash the ENTIRE song (64 bars / ~2.5 min): loops the outgoing track's 8-bar drum+bass groove pocket underneath while bringing in the incoming song's full vocals & melody from Bar 2!"
          style={{
            fontWeight: 800,
            background: "linear-gradient(135deg, #f97316, #db2777)",
            color: "#fff",
            borderColor: "#f97316",
          }}
        >
          🔥 Full-Song Mashup (64 Bars)
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => setShowMashupStudio((prev) => !prev)}
          title="Open the 2-Song Full Mashup Studio & Gym Discovery Presets"
          style={{
            fontWeight: 800,
            background: showMashupStudio ? "rgba(168, 85, 247, 0.28)" : "rgba(168, 85, 247, 0.14)",
            color: "#e9d5ff",
            borderColor: "#a855f7",
          }}
        >
          {showMashupStudio ? "🎛️ Hide Mashup Studio ▲" : "🎛️ 2-Song Mashup Studio ▼"}
        </button>
        <button
          type="button"
          className={styles.syncButton}
          onClick={() => onSkipNext(false)}
          title="Immediately transition out of the current song into the next track using DJ skills (loop / stem mix)"
          style={{ fontWeight: 700 }}
        >
          ⏭️ Next Song (Mix Now)
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => onSkipNext(true)}
          title="Ditch the current song immediately and cut straight to the next song's hot lead-in"
          style={{ fontWeight: 700 }}
        >
          ⚡ Cut to Next
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={onSoloActiveDeck}
          title="Stop any background track, 4-stem loop, or held sample and solo ONLY the active deck at 100% volume"
          style={{
            fontWeight: 800,
            background: "linear-gradient(135deg, #f59e0b, #d97706)",
            color: "#090d16",
            borderColor: "#f59e0b",
          }}
        >
          🎯 Kill Background Track / Solo Song
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={onStopAllAudio}
          title="Immediately stop all decks, 4-stem loops, transitions, and autopilot"
          style={{
            fontWeight: 800,
            background: "linear-gradient(135deg, #ef4444, #991b1b)",
            color: "#fff",
            borderColor: "#ef4444",
          }}
        >
          🛑 STOP ALL AUDIO
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => onSeekLive(-15)}
          disabled={!hasLiveTrack}
          title="Rewind the currently playing track by 15 seconds"
        >
          ⏪ -15s
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => onSeekLive(15)}
          disabled={!hasLiveTrack}
          title="Fast-forward the currently playing track by 15 seconds"
        >
          ⏩ +15s
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => onSeekLive(30)}
          disabled={!hasLiveTrack}
          title="Fast-forward the currently playing track by 30 seconds (skip slow intro)"
        >
          ⏩ +30s
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={onJumpToBeatLive}
          disabled={!hasLiveTrack}
          title="Skip past any slow video intro straight to the track's analyzed beat-in / drop"
          style={{ fontWeight: 700 }}
        >
          🔥 Skip Intro / Drop
        </button>
      </div>

      {/* 🎺 LIVE SONG HORN / BEAT LOOP & HOOK ISOLATOR (Works right on the Booth tab!) */}
      {onTriggerStemLoop && (
        <div
          style={{
            marginTop: 6,
            marginBottom: 10,
            padding: "10px 12px",
            borderRadius: 10,
            background: "linear-gradient(135deg, rgba(6, 182, 212, 0.16), rgba(245, 158, 11, 0.12))",
            border: "1px solid rgba(6, 182, 212, 0.45)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: "0.79rem", fontWeight: 900, color: "#22d3ee", letterSpacing: "0.02em" }}>
              🎺 LIVE HORN &amp; BEAT LOOPER ({activeTrackName ? musicLabel({ name: activeTrackName }).slice(0, 34) : "Current Song"}) — Strips Vocals &amp; Loops Horns/Beat!
            </span>
            {activeLoopLabel && (
              <span
                style={{
                  padding: "2px 9px",
                  borderRadius: 999,
                  background: "#f59e0b",
                  color: "#090d16",
                  fontWeight: 900,
                  fontSize: "0.75rem",
                }}
              >
                🔁 LOOPING: {activeLoopLabel}
              </span>
            )}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <button
              type="button"
              className={styles.syncButton}
              disabled={!hasLiveTrack}
              onClick={() =>
                onTriggerStemLoop({
                  isolation: "melody",
                  bars: 4,
                  label: "🎺 Horns/Melody + Beat (4 Bars · No Vocals)",
                })
              }
              style={{
                background: "linear-gradient(135deg, #06b6d4, #0284c7)",
                color: "#fff",
                fontWeight: 800,
                borderColor: "#38bdf8",
              }}
              title="Loop 4 bars at your current position with Vocals stripped out so the Horns/Melody + Drums + Bass loop cleanly!"
            >
              🎺 Loop Horns + Beat Here (4 Bars)
            </button>

            <button
              type="button"
              className={styles.syncButton}
              disabled={!hasLiveTrack}
              onClick={() =>
                onTriggerStemLoop({
                  isolation: "beat",
                  bars: 4,
                  label: "🥁 Beat + Bass Pocket (4 Bars)",
                })
              }
              style={{
                background: "linear-gradient(135deg, #f59e0b, #d97706)",
                color: "#090d16",
                fontWeight: 800,
                borderColor: "#fbbf24",
              }}
              title="Loop 4 bars of the Beat + Bass groove right at your current position"
            >
              🥁 Loop Beat + Bass Here (4 Bars)
            </button>

            <button
              type="button"
              className={styles.secondaryButton}
              disabled={!hasLiveTrack}
              onClick={() =>
                onTriggerStemLoop({
                  isolation: "melody",
                  bars: 2,
                  label: "🎺 Tight 2-Bar Horn/Beat Loop",
                })
              }
              style={{ fontWeight: 700 }}
              title="Loop 2 bars of Horns/Melody + Beat right here"
            >
              🔁 Loop 2 Bars
            </button>

            <button
              type="button"
              className={styles.secondaryButton}
              disabled={!hasLiveTrack}
              onClick={() =>
                onTriggerStemLoop({
                  isolation: "melody",
                  bars: 8,
                  label: "🎺 Full 8-Bar Horn/Beat Loop",
                })
              }
              style={{ fontWeight: 700 }}
              title="Loop 8 bars of Horns/Melody + Beat right here"
            >
              🔁 Loop 8 Bars
            </button>

            {activeLoopLabel && onReleaseStemLoop && (
              <button
                type="button"
                className={styles.syncButton}
                onClick={onReleaseStemLoop}
                style={{
                  background: "linear-gradient(135deg, #10b981, #059669)",
                  color: "#fff",
                  fontWeight: 900,
                  borderColor: "#34d399",
                }}
                title="Release the active loop and continue playing the song seamlessly"
              >
                🔓 Release Loop (Keep Playing)
              </button>
            )}

            {onOpenStemStudio && (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={onOpenStemStudio}
                style={{
                  fontWeight: 800,
                  borderColor: "#38bdf8",
                  color: "#bae6fd",
                }}
                title="Open the full 4-Stem Isolator & Loop Studio synced to this exact song and timestamp"
              >
                🎛️ Open 4-Stem Faders &amp; Loop Studio →
              </button>
            )}
          </div>

          {activeSongHooks.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 8, paddingTop: 6, borderTop: "1px solid rgba(148, 163, 184, 0.22)" }}>
              <span style={{ fontSize: "0.75rem", fontWeight: 800, color: "#fde68a" }}>
                🎯 SONG HOOKS (1-CLICK JUMP &amp; LOOP NO VOCALS):
              </span>
              {activeSongHooks.map((h, idx) => {
                const isMelody = h.isolation === "melody";
                const lbl = `${h.kindLabel} ${formatMmSs(h.startSeconds)}–${formatMmSs(h.endSeconds)} (${h.lengthBars}b)`;
                return (
                  <button
                    key={`${h.startBar}-${idx}`}
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() =>
                      onTriggerStemLoop({
                        isolation: h.isolation,
                        bars: (h.lengthBars === 2 || h.lengthBars === 4 || h.lengthBars === 8 ? h.lengthBars : 4) as 2 | 4 | 8,
                        startSeconds: h.startSeconds,
                        endSeconds: h.endSeconds,
                        label: lbl,
                      })
                    }
                    style={{
                      fontSize: "0.75rem",
                      fontWeight: 800,
                      padding: "4px 9px",
                      borderColor: isMelody ? "#22d3ee" : "#fbbf24",
                      color: isMelody ? "#cffafe" : "#fef3c7",
                    }}
                    title={`Jump to ${formatMmSs(h.startSeconds)}–${formatMmSs(h.endSeconds)}, strip vocals, and loop ${h.lengthBars} bars`}
                  >
                    {lbl}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {showMashupStudio && (
        <div
          style={{
            marginTop: 6,
            marginBottom: 12,
            padding: 12,
            borderRadius: 12,
            background: "rgba(15, 23, 42, 0.88)",
            border: "1px solid rgba(168, 85, 247, 0.4)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
            <div>
              <strong style={{ color: "#f3e8ff", fontSize: 13 }}>
                🧬 FULL-SONG 2-TRACK MASHUP STUDIO (8-Bar Groove Anchor × Full Song Vocals)
              </strong>
              <p className={styles.hint} style={{ margin: "2px 0 0 0" }}>
                Locks Track A&apos;s 8-bar drum + bass groove pocket underneath for up to 64 bars (~2.5 min) while layering Track B&apos;s full vocals &amp; harmony right from Bar 2.
              </p>
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
              gap: 8,
              marginBottom: 12,
            }}
          >
            {GOLD_STANDARD_MASHUP_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => onStartPairMashup(preset.beatTrackId, preset.vocalTrackId, preset.bars)}
                style={{
                  textAlign: "left",
                  padding: "9px 11px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.16)",
                  background: preset.accent,
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.04em", opacity: 0.92 }}>
                  {preset.badge}
                </div>
                <div style={{ fontSize: 13, fontWeight: 800, marginTop: 2 }}>{preset.title}</div>
                <div style={{ fontSize: 11, opacity: 0.9, marginTop: 2 }}>{preset.subtitle}</div>
              </button>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
              paddingTop: 8,
              borderTop: "1px solid rgba(148, 163, 184, 0.2)",
            }}
          >
            <label style={{ display: "flex", flexDirection: "column", gap: 3, flex: "1 1 220px", fontSize: 11, color: "#cbd5e1" }}>
              <span>🥁 Track A (8-Bar Beat &amp; Bass Groove Anchor):</span>
              <select
                className={styles.cueSelect}
                value={
                  stemReadyTracks.some((t) => t.id === customBeatId)
                    ? customBeatId
                    : (stemReadyTracks[0]?.id ?? customBeatId)
                }
                onChange={(e) => {
                  const nextBeat = e.target.value;
                  setCustomBeatId(nextBeat);
                }}
              >
                {stemReadyTracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 3, flex: "1 1 220px", fontSize: 11, color: "#cbd5e1" }}>
              <span>🎤 Track B (Full Vocals &amp; Melodic Hook Partner):</span>
              <select
                className={styles.cueSelect}
                value={
                  compatibleVocalTracks.some((t) => t.id === customVocalId)
                    ? customVocalId
                    : (compatibleVocalTracks[0]?.id ?? customVocalId)
                }
                onChange={(e) => setCustomVocalId(e.target.value)}
              >
                {compatibleVocalTracks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11, color: "#cbd5e1" }}>
              <span>⏱️ Mashup Length:</span>
              <select
                className={styles.cueSelect}
                value={String(customBars)}
                onChange={(e) => setCustomBars(Number(e.target.value) as 16 | 32 | 64)}
              >
                <option value="64">64 Bars (~2.5 min Full Song)</option>
                <option value="32">32 Bars (~1.2 min Extended)</option>
                <option value="16">16 Bars (~35s Transition)</option>
              </select>
            </label>

            <button
              type="button"
              className={styles.syncButton}
              onClick={() => {
                const beatId = stemReadyTracks.some((t) => t.id === customBeatId)
                  ? customBeatId
                  : (stemReadyTracks[0]?.id ?? customBeatId);
                const vocalId = compatibleVocalTracks.some((t) => t.id === customVocalId)
                  ? customVocalId
                  : (compatibleVocalTracks[0]?.id ?? customVocalId);
                onStartPairMashup(beatId, vocalId, customBars);
              }}
              style={{
                fontWeight: 800,
                background: "linear-gradient(135deg, #f97316, #db2777)",
                color: "#fff",
                borderColor: "#f97316",
                alignSelf: "flex-end",
                padding: "8px 14px",
              }}
            >
              🔥 Mash These 2 Songs ({customBars} Bars)
            </button>
          </div>
        </div>
      )}

      <div className={styles.brainModelRow}>
        <label className={styles.modelLabel}>Cerebro model
          <select className={styles.cueSelect} aria-label="Cerebro model" value={selectedModel}
            disabled={brainBusy} onChange={e => { if (isBrainModelId(e.target.value)) onModelChange(e.target.value); }}>
            {modelOptions.map(option => <option key={option.id} value={option.id} disabled={!option.available}>
              {option.label}{option.available ? "" : " — not configured"}
            </option>)}
          </select>
        </label>
        <label className={styles.modelTestLabel}>
          <input type="checkbox" checked={modelOnly} onChange={e => onModelOnlyChange(e.target.checked)} />
          Ask selected model for every handoff (more API calls)
        </label>
      </div>
      <div className={styles.costTicker}>
        <span className={styles.costTotal}>
          Estimated cost since Reset: <strong>${costTotal.toFixed(4)}</strong>
          <span style={{ marginLeft: 10, opacity: 0.45, fontSize: "0.8em" }} title="build — if this does not match the latest deploy, close the tab and reopen">build {process.env.NEXT_PUBLIC_BUILD}</span>
        </span>
        {lastModel !== null && (
          <span className={styles.costLastCall}>
            {lastModel} · {lastLatency !== null ? `${(lastLatency / 1000).toFixed(1)}s · ` : ""}
            {lastCost !== null ? `last successful call: $${lastCost.toFixed(4)}` : "cost unavailable"}
          </span>
        )}
        <button type="button" className={styles.resetButton} onClick={onResetCost}>
          Reset
        </button>
      </div>
      {unpricedCalls > 0 && <p className={styles.hint}>{unpricedCalls} call(s) have no cost estimate and are not included above. See provider billing for their charges.</p>}

      <form className={styles.chatRow} onSubmit={onChatSubmit}>
        <input
          type="text"
          className={styles.chatInput}
          placeholder="Tell the DJ what you want…"
          value={chatInput}
          onChange={(event) => onChatInputChange(event.target.value)}
          aria-label="Vibe note to the brain"
        />
        <button
          type="submit"
          className={styles.secondaryButton}
          disabled={brainBusy || chatInput.trim() === ""}
        >
          Send
        </button>
      </form>

      <ul className={styles.brainLog} aria-live="polite">
        {brainLog.length === 0 && <li className={styles.hint}>No brain activity yet.</li>}
        {brainLog
          .slice()
          .reverse()
          .map((entry) => (
            <li key={entry.id} className={styles.brainLogEntry}>
              <strong>{entry.action}</strong>
              {entry.say ? `: ${entry.say}` : ""}
            </li>
          ))}
      </ul>
    </section>
  );
}

function FxPanel({
  liveDeckLabel,
  onPlayFx,
  onScratch,
  onRoll,
  onPlayVocal,
  onPlayVocalFile,
  onFireCombo,
  autoTurntablistFx,
  onToggleAutoTurntablistFx,
  onWarmUp,
  warmingUp,
}: {
  liveDeckLabel: DeckLabel | null;
  onPlayFx: (name: SfxName) => void;
  onScratch: (pattern: ScratchPattern) => void;
  onRoll: (fx: RollFxName) => void;
  onPlayVocal: (category: VocalCategory) => void;
  onPlayVocalFile: (file: string) => void;
  onFireCombo: (comboId: string) => void;
  autoTurntablistFx: boolean;
  onToggleAutoTurntablistFx: () => void;
  onWarmUp: () => void;
  warmingUp: boolean;
}) {
  const [vocalFilter, setVocalFilter] = useState<string>("all");
  const scratchDisabled = liveDeckLabel === null;
  const scratchDisabledReason = "No live deck to scratch — play a deck first";
  const presentVocalCategories = VOCAL_CATEGORIES.filter((c) => VOCAL_GROUPS[c].length > 0);
  const presentHostCategories = HOST_ONLY_CATEGORIES.filter((c) => VOCAL_GROUPS[c].length > 0);

  const allVocalClips = useMemo(() => {
    const list: { file: string; category: VocalCategory; title: string; vibe: string }[] = [];
    for (const cat of VOCAL_CATEGORIES) {
      for (const file of VOCAL_GROUPS[cat] ?? []) {
        const meta = PAISA_VOCAL_LABELS[file] ?? {
          phrase: file.replace(/\.mp3$/i, ""),
          vibe: cat,
        };
        list.push({ file, category: cat, title: meta.phrase, vibe: meta.vibe });
      }
    }
    return list;
  }, []);

  const filteredVocalClips = useMemo(() => {
    if (vocalFilter === "all") return allVocalClips;
    return allVocalClips.filter((c) => c.category === vocalFilter);
  }, [allVocalClips, vocalFilter]);

  return (
    <section className={styles.fxPanel}>
      <div className={styles.deckHeader}>
        <span className={styles.deckLabel}>🎛️ FX · 16 Studio Stingers, Rolls, Scratches &amp; 38 Paisa Vocals</span>
        <div className={styles.fxHeaderRight}>
          <button
            type="button"
            className={`${styles.secondaryButton} ${autoTurntablistFx ? styles.autoFxActiveBtn : ""}`}
            onClick={onToggleAutoTurntablistFx}
            aria-pressed={autoTurntablistFx}
          >
            {autoTurntablistFx ? "🎧 Auto-FX Turntablist: ON" : "🎧 Auto-FX Turntablist: OFF"}
          </button>
          <button type="button" className={styles.secondaryButton} onClick={onWarmUp} disabled={warmingUp}>
            {warmingUp ? "Warming up…" : "Warm up FX"}
          </button>
        </div>
      </div>

      {/* 1-Click Pro Turntablist Phrase Combos */}
      <div className={styles.comboSection}>
        <span className={styles.fxGroupTitle}>⚡ 1-Click Pro Turntablist Combos (Fill → Drop Impact → Paisa Tag)</span>
        <div className={styles.fxComboRow}>
          <button
            type="button"
            className={styles.fxComboBtn}
            onClick={() => onFireCombo("latin_timbale_subdrop_perreo")}
          >
            🥁 Latin Timbale → 808 Sub Drop → ¡No Pare!
          </button>
          <button
            type="button"
            className={styles.fxComboBtn}
            onClick={() => onFireCombo("club_riser_cryo_zapateo")}
          >
            🌪️ Club Riser → Crash → CO2 Cryo → ¡Fuego!
          </button>
          <button
            type="button"
            className={styles.fxComboBtn}
            onClick={() => onFireCombo("turntablist_chirp_spinback_808")}
          >
            🎛️ Chirp + Rewind → 808 Boom → Puro Cerebro
          </button>
          <button
            type="button"
            className={styles.fxComboBtn}
            onClick={() => onFireCombo("dub_siren_horn_stab_wepa")}
          >
            🇯🇲 Dub Siren → Brass Horn Stab → ¡Wepa!
          </button>
        </div>
      </div>

      <span className={styles.fxGroupTitle}>🔊 16 Studio Club SFX Pads (256kbps Stereo · -14 LUFS Mastered)</span>
      <div className={styles.fxRow}>
        <button type="button" className={`${styles.fxButton} ${styles.fxPadHype}`} onClick={() => onPlayFx("airhorn")}>
          Airhorn
        </button>
        <button type="button" className={`${styles.fxButton} ${styles.fxPadHype}`} onClick={() => onPlayFx("siren")}>
          Siren
        </button>
        <button type="button" className={`${styles.fxButton} ${styles.fxPadSweep}`} onClick={() => onPlayFx("riser")}>
          Riser
        </button>
        <button type="button" className={`${styles.fxButton} ${styles.fxPadVinyl}`} onClick={() => onPlayFx("rewind")}>
          Rewind
        </button>
      </div>
      <div className={styles.fxRow}>
        <button type="button" className={`${styles.fxButton} ${styles.fxPadHype}`} onClick={() => onPlayFx("laser")}>
          Laser
        </button>
        <button type="button" className={`${styles.fxButton} ${styles.fxPadVinyl}`} onClick={() => onPlayFx("brake")}>
          Brake
        </button>
        <button type="button" className={`${styles.fxButton} ${styles.fxPadHype}`} onClick={() => onPlayFx("cheer")}>
          Cheer
        </button>
        <button type="button" className={`${styles.fxButton} ${styles.fxPadSub}`} onClick={() => onPlayFx("subdrop")}>
          Sub Drop <span className={styles.fxNewBadge}>v2</span>
        </button>
      </div>
      <div className={styles.fxRow}>
        <button type="button" className={`${styles.fxButton} ${styles.fxPadSweep}`} onClick={() => onPlayFx("crash")}>
          Crash Swell <span className={styles.fxNewBadge}>v2</span>
        </button>
        <button type="button" className={`${styles.fxButton} ${styles.fxPadPerc}`} onClick={() => onPlayFx("timbale")}>
          Timbale Fill <span className={styles.fxNewBadge}>v2</span>
        </button>
        <button type="button" className={`${styles.fxButton} ${styles.fxPadSub}`} onClick={() => onPlayFx("downlifter")}>
          Downlifter <span className={styles.fxNewBadge}>v2</span>
        </button>
        <button type="button" className={`${styles.fxButton} ${styles.fxPadHype}`} onClick={() => onPlayFx("dub_siren")}>
          Dub Siren <span className={styles.fxNewBadge}>v2</span>
        </button>
      </div>
      <div className={styles.fxRow}>
        <button type="button" className={`${styles.fxButton} ${styles.fxPadPerc}`} onClick={() => onPlayFx("horn_stab")}>
          Brass Stab <span className={styles.fxNewBadge}>v2</span>
        </button>
        <button type="button" className={`${styles.fxButton} ${styles.fxPadSweep}`} onClick={() => onPlayFx("cryo_jet")}>
          CO2 Cannon <span className={styles.fxNewBadge}>v2</span>
        </button>
        <button type="button" className={`${styles.fxButton} ${styles.fxPadSub}`} onClick={() => onPlayFx("booyaka")}>
          808 Boom <span className={styles.fxNewBadge}>v2</span>
        </button>
        <button type="button" className={`${styles.fxButton} ${styles.fxPadHype}`} onClick={() => onPlayFx("gunshot")}>
          Ricochet Zap <span className={styles.fxNewBadge}>v2</span>
        </button>
      </div>

      <span className={styles.fxGroupTitle}>💿 Turntable Scratches &amp; Slip Beat Rolls</span>
      <div className={styles.fxRow}>
        <button
          type="button"
          className={`${styles.fxButton} ${styles.fxPadVinyl}`}
          onClick={() => onScratch("baby")}
          disabled={scratchDisabled}
          title={scratchDisabled ? scratchDisabledReason : undefined}
        >
          Baby
        </button>
        <button
          type="button"
          className={`${styles.fxButton} ${styles.fxPadVinyl}`}
          onClick={() => onScratch("chirp")}
          disabled={scratchDisabled}
          title={scratchDisabled ? scratchDisabledReason : undefined}
        >
          Chirp
        </button>
        <button
          type="button"
          className={`${styles.fxButton} ${styles.fxPadVinyl}`}
          onClick={() => onScratch("spinback")}
          disabled={scratchDisabled}
          title={scratchDisabled ? scratchDisabledReason : undefined}
        >
          Spinback
        </button>
      </div>
      {/* Audio engine v2, Part 2 — beat rolls: three roll pads, enabled only with a live deck (same guard/reason as the scratch row above). */}
      <div className={styles.fxRow}>
        <button
          type="button"
          className={`${styles.fxButton} ${styles.fxPadRoll}`}
          onClick={() => onRoll("roll_eighth")}
          disabled={scratchDisabled}
          title={scratchDisabled ? scratchDisabledReason : undefined}
        >
          Roll ⅛
        </button>
        <button
          type="button"
          className={`${styles.fxButton} ${styles.fxPadRoll}`}
          onClick={() => onRoll("roll_quarter")}
          disabled={scratchDisabled}
          title={scratchDisabled ? scratchDisabledReason : undefined}
        >
          Roll ¼
        </button>
        <button
          type="button"
          className={`${styles.fxButton} ${styles.fxPadRoll}`}
          onClick={() => onRoll("roll_half")}
          disabled={scratchDisabled}
          title={scratchDisabled ? scratchDisabledReason : undefined}
        >
          Roll ½
        </button>
      </div>

      {presentVocalCategories.length > 0 && (
        <>
          <div className={styles.deckHeader}>
            <span className={styles.deckLabel}>Vocals (Random Rotation Pads)</span>
          </div>
          {[presentVocalCategories.slice(0, 3), presentVocalCategories.slice(3, 6)]
            .filter((row) => row.length > 0)
            .map((row, i) => (
              <div className={styles.fxRow} key={i}>
                {row.map((category) => (
                  <button
                    key={category}
                    type="button"
                    className={`${styles.fxButton} ${styles.fxPadVocal}`}
                    onClick={() => onPlayVocal(category)}
                  >
                    {VOCAL_PAD_LABELS[category]}
                  </button>
                ))}
              </div>
            ))}
        </>
      )}

      {/* 🎙️ Direct 38-Clip "El Cerebro Paisa" Vocal Soundboard */}
      <div className={styles.vocalSoundboard}>
        <div className={styles.soundboardHeader}>
          <span className={styles.fxGroupTitle}>
            🇨🇴 Direct 38-Clip &ldquo;El Cerebro Paisa&rdquo; Vocal Soundboard (Click Any Clip to Fire + Auto-Duck)
          </span>
          <div className={styles.vocalFilterRow}>
            {[
              { id: "all", label: `All (${allVocalClips.length})` },
              { id: "drop", label: `🔥 Drops (${VOCAL_GROUPS.drop?.length ?? 0})` },
              { id: "tag", label: `🏷️ DJ Tags (${VOCAL_GROUPS.tag?.length ?? 0})` },
              { id: "cue_hype", label: `📣 Hype Cues (${VOCAL_GROUPS.cue_hype?.length ?? 0})` },
              { id: "cue_warm", label: `🌴 Warm Cues (${VOCAL_GROUPS.cue_warm?.length ?? 0})` },
              { id: "adlib", label: `🗣️ Paisa Ad-Libs (${VOCAL_GROUPS.adlib?.length ?? 0})` },
              { id: "crowd", label: `🙌 Crowd (${VOCAL_GROUPS.crowd?.length ?? 0})` },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`${styles.vocalFilterPill} ${vocalFilter === tab.id ? styles.vocalFilterPillActive : ""}`}
                onClick={() => setVocalFilter(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.vocalClipsGrid}>
          {filteredVocalClips.map((clip) => (
            <button
              key={clip.file}
              type="button"
              className={styles.vocalClipCard}
              onClick={() => onPlayVocalFile(clip.file)}
              title={`Play ${clip.file} (${clip.vibe})`}
            >
              <span className={styles.vocalClipTitle}>{clip.title}</span>
              <span className={styles.vocalClipMeta}>{clip.vibe}</span>
            </button>
          ))}
        </div>
      </div>

      {presentHostCategories.length > 0 && (
        <div className={styles.hostSection}>
          <div className={styles.deckHeader}>
            <span className={styles.hostLabel}>Host only (never autopilot)</span>
          </div>
          <div className={styles.fxRow}>
            {presentHostCategories.map((category) => (
              <button
                key={category}
                type="button"
                className={`${styles.fxButton} ${styles.hostButton}`}
                onClick={() => onPlayVocal(category)}
              >
                {VOCAL_PAD_LABELS[category]}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function TransitionHistoryPanel({
  records,
  onRate,
  onNoteChange,
}: {
  records: TransitionRecord[];
  onRate: (when: number, rating: "up" | "down") => void;
  onNoteChange: (when: number, note: string) => void;
}) {
  const recent = records.slice(-TRANSITION_HISTORY_PANEL_LIMIT).reverse();

  return (
    <section className={styles.historyPanel}>
      <div className={styles.deckHeader}>
        <span className={styles.deckLabel}>Transitions</span>
      </div>
      {recent.length === 0 && <p className={styles.hint}>No transitions yet — rate one once autopilot runs a few.</p>}
      <ul className={styles.historyList}>
        {recent.map((record) => (
          <li key={record.when} className={styles.historyItem}>
            <p className={styles.historyLine}>
              {record.fromTrack} &rarr; {record.toTrack} ({record.transitionType}
              {record.clamped ? ", clamped" : ""}
              {record.degraded ? ", degraded" : ""})
            </p>
            <div className={styles.historyRateRow}>
              <button
                type="button"
                className={`${styles.rateButton} ${record.rating === "up" ? styles.rateButtonActive : ""}`}
                onClick={() => onRate(record.when, "up")}
                aria-pressed={record.rating === "up"}
                aria-label="Rate this transition thumbs up"
              >
                👍
              </button>
              <button
                type="button"
                className={`${styles.rateButton} ${record.rating === "down" ? styles.rateButtonActive : ""}`}
                onClick={() => onRate(record.when, "down")}
                aria-pressed={record.rating === "down"}
                aria-label="Rate this transition thumbs down"
              >
                👎
              </button>
              <input
                type="text"
                className={styles.historyNoteInput}
                placeholder="note (optional)"
                defaultValue={record.note ?? ""}
                onBlur={(event) => onNoteChange(record.when, event.target.value)}
                aria-label="Note for this transition"
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const LESSONS_PANEL_RECENT_LIMIT = 8;

function LessonsPanel({
  events,
  onExport,
  onImportFile,
  syncStatus,
}: {
  events: LessonEvent[];
  onExport: () => void;
  onImportFile: (file: File) => void;
  syncStatus: { state: "idle" | "pending" | "synced" | "error"; count?: number };
}) {
  const recent = events.slice(-LESSONS_PANEL_RECENT_LIMIT).reverse();
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const syncLine =
    syncStatus.state === "synced"
      ? `☁ synced (${syncStatus.count ?? events.length} events)`
      : syncStatus.state === "pending"
        ? "☁ sync pending…"
        : syncStatus.state === "error"
          ? "☁ sync failed — kept locally"
          : null;

  return (
    <section className={styles.historyPanel}>
      <div className={styles.deckHeader}>
        <span className={styles.deckLabel}>Lessons</span>
        <button type="button" className={styles.secondaryButton} onClick={onExport}>
          Export lessons JSON
        </button>
        <button type="button" className={styles.secondaryButton} onClick={() => importInputRef.current?.click()}>
          Import
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          className={styles.hiddenInput}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = ""; // allow re-picking the same file later
            if (file) onImportFile(file);
          }}
        />
      </div>
      {syncLine && <p className={styles.hint}>{syncLine}</p>}
      <p className={styles.hint}>{events.length} event(s) logged this session.</p>
      {recent.length === 0 ? (
        <p className={styles.hint}>No lessons yet — rate a transition, jot a vibe note, or hit an fx pad manually.</p>
      ) : (
        <ul className={styles.historyList}>
          {recent.map((event, index) => (
            <li key={`${event.type}-${event.when}-${index}`} className={styles.historyItem}>
              <p className={styles.historyLine}>{describeLedgerEvent(event)}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function Home() {
  const coreRef = useRef<AudioCore | null>(null);
  if (!coreRef.current) coreRef.current = new AudioCore();

  // M4 Part C: one shared FxPlayer, reused across every fx pad tap.
  const fxPlayerRef = useRef<FxPlayer | null>(null);
  if (!fxPlayerRef.current) fxPlayerRef.current = new FxPlayer(coreRef.current);

  // Vocal-clip library: one shared VocalPlayer (rotation state + duck),
  // reused across every vocal pad tap and every brain-fired vocal command.
  const vocalPlayerRef = useRef<VocalPlayer | null>(null);
  if (!vocalPlayerRef.current) vocalPlayerRef.current = new VocalPlayer(coreRef.current);

  // FX upgrade: timestamp of the last fx command that actually fired
  // (autopilot-driven or a manual pad tap — both count), so the brain's
  // ~10-minute frequency-cap rule (SYSTEM_PROMPT) has something to check via
  // DjLiveState.fxLastSecondsAgo. null until the first fx of the session.
  const lastFxAtRef = useRef<number | null>(null);
  // M7 Phase 3: performance moves keep their OWN clock. Sharing one
  // timestamp meant a beat roll consumed the stinger budget (and vice
  // versa), so a single roll could silence airhorns for two minutes and one
  // airhorn could silence every performance move for two minutes. Separate
  // clocks are what let the two classes have genuinely different cadences.
  const lastPerformanceAtRef = useRef<number | null>(null);
  // The single in-flight band-isolated hold, if any (latest-and-only-one —
  // a second hold while one is running is refused, not stacked).
  const heldLoopRef = useRef<HeldLoopHandle | null>(null);
  const routineTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const routineIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  function recordFxFired(performance = false) {
    if (performance) lastPerformanceAtRef.current = Date.now();
    else lastFxAtRef.current = Date.now();
  }

  // FX demonstration log (scope addendum, 2026-07-26): the human DJ's own
  // MANUAL fx/vocal/scratch pad fires, with musical context, so the brain
  // can learn his placement style (see src/lib/fx-log.ts's file header).
  // Deliberately NOT populated by brain-driven fx (executeFxCommand) or cue
  // fires (fireCue) — only the true manual pad handlers below
  // (handlePlayFx/handlePlayVocal/handleScratchButton) append here. Kept in
  // a ref (hydrated once on mount, updated on every append) rather than
  // React state — nothing in the UI renders off this log directly, it only
  // feeds buildDjState()'s per-request summary.
  const fxDemonstrationsRef = useRef<FxDemonstrationEntry[]>([]);
  useEffect(() => {
    fxDemonstrationsRef.current = loadFxDemonstrations();
  }, []);

  /** Records one manual fx/vocal/scratch fire with the live deck's current musical context (or all-null context if nothing is live). */
  function recordFxDemonstration(fx: string) {
    const liveLabel = getLiveDeckLabel();
    const liveCtrl = liveLabel ? deckByLabel(liveLabel) : null;
    const duration = liveCtrl?.deck.duration ?? 0;
    const positionSeconds = liveCtrl?.deck.positionSeconds ?? 0;
    const positionFraction = liveCtrl && duration > 0 ? positionSeconds / duration : null;
    const remainingSourceSeconds = liveCtrl ? Math.max(0, duration - positionSeconds) : null;
    const remainingSeconds =
      liveCtrl && remainingSourceSeconds !== null && liveCtrl.tempo > 0
        ? remainingSourceSeconds / liveCtrl.tempo
        : remainingSourceSeconds;
    fxDemonstrationsRef.current = appendFxDemonstration({
      fx,
      trackName: liveCtrl?.trackName ?? null,
      bpm: liveCtrl?.tags.bpm ?? null,
      positionFraction,
      remainingSeconds,
      tempo: liveCtrl?.tempo ?? null,
      duringTransition: transitionEngineRef.current.isRunning,
      at: Date.now(),
    });
  }

  // Cue-point keying (see cue-store.ts's cueTrackKey): whichever track each
  // deck currently has loaded, known as soon as loadFromBlob starts (before
  // decode finishes) — reported via useDeckController's onCueKeyKnown.
  const [cueKeyA, setCueKeyA] = useState<string | null>(null);
  const [cueKeyB, setCueKeyB] = useState<string | null>(null);

  // cancelTempoGlide is a function DECLARATION further down this component
  // body (near the transition engine, its closest logical home) — fully
  // hoisted within this function's scope, so referencing it in a wrapper
  // closure here (only ever CALLED later, after mount) is safe.
  const stopStemMixerRef = useRef<(() => void) | null>(null);

  const deckA = useDeckController(coreRef.current, FIXTURE_A, {
    onCueKeyKnown: setCueKeyA,
    onTempoGlideCancel: () => cancelTempoGlide("A"),
    onManualPause: () => handleManualPauseDuringTransition(),
    onManualPlay: () => handleManualPlayDeck("A"),
  });
  const deckB = useDeckController(coreRef.current, FIXTURE_B, {
    onCueKeyKnown: setCueKeyB,
    onTempoGlideCancel: () => cancelTempoGlide("B"),
    onManualPause: () => handleManualPauseDuringTransition(),
    onManualPlay: () => handleManualPlayDeck("B"),
  });

  // Refs mirroring the latest deckA/deckB/crate/crossfade every render, so
  // the autopilot poll loop (a useEffect with a narrow dependency array —
  // see below) and the brain's async command executors always read FRESH
  // values instead of a stale render's closure, without tearing down and
  // recreating the poll interval on every progress-bar tick.
  const deckARef = useRef(deckA);
  deckARef.current = deckA;
  const deckBRef = useRef(deckB);
  deckBRef.current = deckB;

  const cueKeyARef = useRef(cueKeyA);
  cueKeyARef.current = cueKeyA;
  const cueKeyBRef = useRef(cueKeyB);
  cueKeyBRef.current = cueKeyB;

  // --- Cue points: rehearsal mode (per deck, "Rehearse" toggle) + the
  // persisted store (localStorage, shared across both decks — keyed by
  // track, not by deck) ---
  const [rehearseA, setRehearseA] = useState(false);
  const [rehearseB, setRehearseB] = useState(false);
  const rehearseARef = useRef(rehearseA);
  rehearseARef.current = rehearseA;
  const rehearseBRef = useRef(rehearseB);
  rehearseBRef.current = rehearseB;

  const [cueStore, setCueStoreState] = useState<CueStore>({});
  const cueStoreRef = useRef(cueStore);
  cueStoreRef.current = cueStore;
  useEffect(() => {
    setCueStoreState(loadCueStore());
  }, []);
  function persistCueStore(next: CueStore) {
    setCueStoreState(next);
    saveCueStore(next);
  }

  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const [crossfade, setCrossfade] = useState(0.5); // 0 = full A, 1 = full B
  const crossfadeRef = useRef(crossfade);
  crossfadeRef.current = crossfade;

  // --- Crate (Part A) ---
  const [crate, setCrate] = useState<CrateTrack[]>([]);
  const [metadataStatus, setMetadataStatus] = useState("Loading shared genre corrections…");
  const genreOverridesRef = useRef(new Map<string, GenreOverride>());
  const genreEditsRef = useRef(new Map<string, number>());
  const crateRef = useRef(crate);
  crateRef.current = crate;
  const [crateAdding, setCrateAdding] = useState(false);
  const crateFileInputRef = useRef<HTMLInputElement | null>(null);

  // --- Drive crate loader (M5, re-architected for the lazy-crate design) ---
  const [driveTracks, setDriveTracks] = useState<CrateTrackListing[] | null>(null);
  const [driveListing, setDriveListing] = useState(false);
  const [driveAdding, setDriveAdding] = useState(false);
  const [driveTagProgress, setDriveTagProgress] = useState<{ done: number; total: number } | null>(null);
  const [driveNotices, setDriveNotices] = useState<string[]>([]);

  // --- Lazy-crate: on-demand download + IndexedDB cache (see
  // src/lib/track-cache.ts). One store instance shared by every
  // getTrackForPlayback() call and the cache-hydration listing below — both
  // resolve to the same underlying IndexedDB database regardless (the
  // module dedupes the open() call), sharing an instance is just tidier. ---
  const trackCacheStoreRef = useRef(createIndexedDbStore());
  // In-and-out mixing: analyzed mix-in/mix-out points, cached per crate-item
  // id for the session — analysis (RMS over the whole decoded buffer) only
  // needs to run once per track even if it's re-queued later. Ref, not
  // state/localStorage: this is a derived cache from the (already-cached)
  // audio, cheap to rebuild on a reload, and not part of the crate's own
  // persisted shape (crate-store.ts is explicitly out of scope for this
  // change — see analyzeMixPoints()).
  const mixPointsCacheRef = useRef<Map<string, MixPoints>>(new Map());
  // Which crate ids currently have a full audio blob cached — drives the
  // "•" party-safe marker in the crate list and which tracks
  // "Prefetch next 10" still has left to do. Local file-picker entries are
  // always party-safe (their File is already in memory) and don't need to
  // appear here — CratePanel treats source === "local" as cached outright.
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set());
  const [prefetching, setPrefetching] = useState(false);
  // FX/vocal-clip warm-up (scope addendum): guards against overlapping
  // warm-up runs (autopilot toggle + a manual "Warm up FX" tap in close
  // succession) — preloadAll() itself is idempotent/cheap on a repeat call
  // (already-cached clips resolve instantly), this just avoids double log
  // lines from two runs racing.
  const fxWarmingRef = useRef(false);
  const [fxWarmingUp, setFxWarmingUp] = useState(false);

  // --- Cost ticker (M5) — persisted so a reload at the party doesn't zero it ---
  const [costTotal, setCostTotal] = useState(0);
  const [lastCost, setLastCost] = useState<number | null>(null);
  const [lastModel, setLastModel] = useState<string | null>(null);
  const [lastLatency, setLastLatency] = useState<number | null>(null);
  const [unpricedCalls, setUnpricedCalls] = useState(0);
  const [selectedModel, setSelectedModel] = useState<BrainModelId>("gemini");
  const selectedModelRef = useRef<BrainModelId>("gemini");
  const [modelOptions, setModelOptions] = useState<BrainModelOption[]>(BRAIN_MODELS.map(option => ({ ...option, available: false })));
  const [modelOnly, setModelOnly] = useState(false);
  const modelOnlyRef = useRef(false);
  useEffect(() => {
    setCostTotal(loadCostTotal());
    try {
      const saved = localStorage.getItem(BRAIN_MODEL_STORAGE_KEY);
      if (isBrainModelId(saved)) { selectedModelRef.current = saved; setSelectedModel(saved); }
      const count = Number(localStorage.getItem("djsm.unpriced-brain-calls"));
      if (Number.isSafeInteger(count) && count > 0) setUnpricedCalls(count);
    } catch { /* private browsing can disable storage */ }
    let active = true;
    void fetchWithPasscode("/api/dj", { cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("Model list unavailable");
      const data = await response.json();
      if (active && Array.isArray(data.models)) setModelOptions(data.models);
    }).catch(() => { if (active) pushBrainLog("error", "Could not load the model list. Refresh to retry."); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Lazy-crate: auto-restore the metadata list on page load (a reload
  // at the party must not lose the crate) and auto-upgrade with all 603
  // manifest tracks + Studio VIP 4-Stem tracks pinned at the top ---
  useEffect(() => {
    const savedCrate = loadCrateList();
    const manifestEntries = crateManifestJson as CrateManifestEntry[];
    const savedIds = new Set(savedCrate.map((e) => e.id));
    const savedNames = new Set(savedCrate.map((e) => e.name.toLowerCase()));
    const missingManifestEntries: PersistedCrateEntry[] = manifestEntries
      .filter((m) => !savedIds.has(m.id) && !savedNames.has(m.name.toLowerCase()))
      .map((m) => ({
        id: m.id,
        name: m.name,
        size: m.size ?? null,
        bpm: m.bpm ?? null,
        key: m.key ?? null,
        grid: m.grid ?? null,
      }));
    const initialEntries: PersistedCrateEntry[] =
      savedCrate.length > 0
        ? [...savedCrate, ...missingManifestEntries]
        : missingManifestEntries;
    const { entries: restoredRaw, relinked } = reconcileCrateList(
      initialEntries,
      manifestEntries,
    );
    // Exclude synthetic 19-second studio demo clips from the main Crate list
    const restored = restoredRaw.filter((entry) => !STUDIO_TRACK_IDS.has(entry.id));
    if (restored.length === 0) return;
    setCrate((prev) => {
      const existingIds = new Set(prev.map((t) => t.id));
      const restoredTracks: CrateTrack[] = restored
        .filter((entry) => !existingIds.has(entry.id))
        .map((entry) => {
          const manifestEntry = PLAYBACK_MANIFEST.get(entry.id);
          return {
            id: entry.id,
            name: entry.name,
            ...resolveMusicMetadata(entry),
            size: entry.size ?? manifestEntry?.size ?? null,
            bpm: entry.bpm ?? manifestEntry?.bpm ?? null,
            key: entry.key ?? manifestEntry?.key ?? null,
            grid: entry.grid ?? manifestEntry?.grid ?? null,
            source: "drive",
          };
        });
      return [...prev, ...restoredTracks];
    });
    pushBrainLog("crate", `Crate restored (${restored.length} track${restored.length === 1 ? "" : "s"})`);
    if (relinked > 0) {
      pushBrainLog("crate", `Updated ${relinked} saved track link${relinked === 1 ? "" : "s"} to the current library`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persists the crate's Drive-sourced entries (metadata only, never a File
  // blob) on every change — local file-picker entries are deliberately
  // excluded, same in-memory-only behavior as before this milestone.
  useEffect(() => {
    const driveEntries: PersistedCrateEntry[] = crate
      .filter((t) => t.source === "drive")
      .map((t) => ({ id: t.id, name: t.name, size: t.size, bpm: t.bpm, key: t.key, grid: t.grid,
        title: t.title, artist: t.artist, genre: t.genre, genreSource: t.genreSource }));
    saveCrateList(driveEntries);
  }, [crate]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetchWithPasscode("/api/crate-metadata", { cache: "no-store" });
        if (!response.ok) throw new Error("Shared genre sync unavailable. Library labels still work; edits need a connection.");
        const data = await response.json() as { overrides: GenreOverride[] };
        if (!active) return;
        for (const row of data.overrides) {
          const previous = genreOverridesRef.current.get(row.id);
          if (!genreEditsRef.current.has(row.id) && (!previous || row.updatedAt >= previous.updatedAt)) genreOverridesRef.current.set(row.id, row);
        }
        setCrate(prev => prev.map(track => {
          const row = genreOverridesRef.current.get(track.id);
          return row && !genreEditsRef.current.has(track.id) ? { ...track, genre: row.genre, genreSource: "owner" } : track;
        }));
        if (!genreEditsRef.current.size) setMetadataStatus("Shared genres connected. Corrections apply to the song and every stem.");
      } catch (error) { if (active) setMetadataStatus(error instanceof Error ? error.message : "Shared genre sync unavailable."); }
    };
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { active = false; window.removeEventListener("focus", onFocus); };
  }, []);

  async function saveGenre(id: string, genre: string) {
    const track = crateRef.current.find(t => t.id === id);
    if (!track || (track.genreSource === "owner" && track.genre === genre && !genreEditsRef.current.has(id))) return;
    if (track.source === "local") {
      setCrate(prev => prev.map(t => t.id === id ? { ...t, genre, genreSource: "owner" } : t));
      setMetadataStatus("Local file genre updated for this session only."); return;
    }
    // Keep the current saved label until the cloud acknowledges. Failed edits
    // stay visibly unsaved and may be retried; never claim device-wide success.
    if (genreEditsRef.current.has(id)) return;
    genreEditsRef.current.set(id, Date.now());
    setMetadataStatus(`Saving genre for ${musicLabel(track)}…`);
    try {
      const response = await fetchWithPasscode("/api/crate-metadata", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, genre }),
      });
      if (!response.ok) throw new Error("Genre NOT saved to cloud. Press Enter in that genre field to retry.");
      const { override } = await response.json() as { override: GenreOverride };
      genreOverridesRef.current.set(id, override);
      setCrate(prev => prev.map(t => t.id === id ? { ...t, genre: override.genre, genreSource: "owner" } : t));
      setMetadataStatus(`Saved across devices: ${musicLabel(track)} — ${genre || "Untagged"}. Stems updated too.`);
    } catch (error) { setMetadataStatus(error instanceof Error ? error.message : "Genre not saved."); }
    finally { genreEditsRef.current.delete(id); }
  }

  // Which crate ids already have a full audio blob cached in IndexedDB —
  // hydrated once on mount so a reloaded crate immediately shows accurate
  // "•" party-safe markers instead of looking all-uncached until the first
  // getTrackForPlayback() call. Best-effort: IndexedDB being unavailable
  // just means the markers stay empty, same "never block playback" posture
  // as the rest of the cache (see track-cache.ts).
  useEffect(() => {
    let cancelled = false;
    trackCacheStoreRef.current
      .list()
      .then((entries) => {
        if (cancelled) return;
        setCachedIds(new Set(entries.map((entry) => entry.id)));
      })
      .catch(() => {
        // IndexedDB unavailable — leave cachedIds empty.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Engine auto-transition (Part B) ---
  const transitionEngineRef = useRef(createTransitionEngine());
  const [transitionRunning, setTransitionRunning] = useState(false);

  // --- Post-transition tempo-recovery glide (owner soundcheck fix,
  // 2026-07-26): after a transition lands, the newly-live deck's tempo
  // often carries a bend from syncTempo() — repeated transitions over a set
  // only ever bend tempo down (or up) with nothing to bring it back, so the
  // set audibly drifted slower and slower. Fix: a couple seconds after a
  // transition resolves, gently walk that deck's tempo back to 1.0 in small
  // steps (src/lib/tempo-glide.ts's pure math) rather than snapping — and
  // cancel outright the moment anything else wants to own that deck's
  // tempo (a new transition, a tempo_nudge, the user's own slider, or the
  // track ending). Only one glide is ever active (only one deck can be
  // "newly live" per transition), tracked by label so a cancel scoped to a
  // specific deck (the manual slider/track-end cases) doesn't clobber a
  // glide on the OTHER deck. ---
  const tempoGlideLabelRef = useRef<DeckLabel | null>(null);
  const tempoGlideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tempoGlideIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopTempoGlideTimers() {
    if (tempoGlideTimeoutRef.current !== null) {
      clearTimeout(tempoGlideTimeoutRef.current);
      tempoGlideTimeoutRef.current = null;
    }
    if (tempoGlideIntervalRef.current !== null) {
      clearInterval(tempoGlideIntervalRef.current);
      tempoGlideIntervalRef.current = null;
    }
    tempoGlideLabelRef.current = null;
  }

  /** `forLabel` narrows the cancel to that deck's own glide only (e.g. the manual tempo slider only cancels ITS OWN deck); omit to cancel unconditionally (a new transition or a tempo_nudge cancels regardless of which deck is currently gliding). */
  function cancelTempoGlide(forLabel?: DeckLabel) {
    if (forLabel && tempoGlideLabelRef.current !== forLabel) return;
    stopTempoGlideTimers();
  }

  function startTempoGlide(label: DeckLabel) {
    stopTempoGlideTimers();
    tempoGlideLabelRef.current = label;
    tempoGlideTimeoutRef.current = setTimeout(() => {
      tempoGlideTimeoutRef.current = null;
      let stepsRemaining = glideStepCount();
      tempoGlideIntervalRef.current = setInterval(() => {
        const ctrl = deckByLabel(label);
        // The track ending is also caught here defensively (belt-and-
        // suspenders alongside the onEnded-driven cancelTempoGlide call in
        // useDeckController) — isPlaying going false mid-tick still stops
        // the glide even if that event wiring were ever bypassed.
        if (!ctrl.isPlaying) {
          stopTempoGlideTimers();
          return;
        }
        const next = nextGlideTempo(ctrl.tempo, stepsRemaining);
        ctrl.setTempoDirectly(next);
        stepsRemaining -= 1;
        if (stepsRemaining <= 0) stopTempoGlideTimers();
      }, TEMPO_GLIDE_STEP_MS);
    }, TEMPO_GLIDE_START_DELAY_MS);
  }

  // --- Learning loop: transition ratings feed back into the brain's future
  // decisions (M4 Part D) ---
  const [transitionRecords, setTransitionRecords] = useState<TransitionRecord[]>([]);
  const transitionRecordsRef = useRef(transitionRecords);
  transitionRecordsRef.current = transitionRecords;
  useEffect(() => {
    setTransitionRecords(loadTransitionRecords());
  }, []);

  // --- Lesson ledger (2026-07-28): append-only ratings/notes/manual-fx log,
  // distilled into every brain request (see src/lib/lesson-ledger.ts). Same
  // state+ref mirror pattern as transitionRecords above (LessonsPanel reads
  // the state directly; async closures like callBrain read the ref for a
  // fresh value without re-subscribing). Hydrated on mount by merging the
  // committed seed file (src/data/lessons-seed.json, empty today) with
  // whatever's in localStorage — same dedupe-by-when+type the Import button
  // uses, so a future non-empty seed file never double-counts against a
  // session that's already recorded the same events.
  const [ledgerEvents, setLedgerEvents] = useState<LessonEvent[]>([]);
  const ledgerEventsRef = useRef(ledgerEvents);
  ledgerEventsRef.current = ledgerEvents;
  useEffect(() => {
    const merged = mergeLedgerEvents(loadLedger(), LESSONS_SEED);
    saveLedger(merged);
    setLedgerEvents(merged);
  }, []);

  // --- Lesson ledger cloud sync (M6, 2026-07-29): the ledger above is
  // otherwise device-local localStorage — this mirrors it through
  // /api/lessons (Vercel Blob-backed, src/app/api/lessons/route.ts) so every
  // device converges on one merged ledger instead of Export-JSON being the
  // only way events leave a phone. One pull on load (below) + a debounced
  // push per write (see recordLedgerEvent) — no polling loop. Every step is
  // best-effort: a failure logs one brainLog line and never blocks the app;
  // the existing Export/Import buttons remain the manual fallback.
  const [lessonSyncStatus, setLessonSyncStatus] = useState<{
    state: "idle" | "pending" | "synced" | "error";
    count?: number;
  }>({ state: "idle" });
  const lessonSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Posts the full local ledger to /api/lessons — called (debounced ~5s) after every recordLedgerEvent. Reads loadLedger() fresh rather than the ref so it always sends what's actually persisted. */
  async function pushLedgerToServer() {
    try {
      const response = await fetchWithPasscode("/api/lessons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: loadLedger() }),
      });
      if (!response.ok) {
        pushBrainLog("error", `lesson sync push failed: HTTP ${response.status}`);
        setLessonSyncStatus({ state: "error" });
        return;
      }
      const data = await response.json();
      setLessonSyncStatus({ state: "synced", count: typeof data.count === "number" ? data.count : undefined });
    } catch (err) {
      pushBrainLog("error", `lesson sync push failed: ${err instanceof Error ? err.message : "network error"}`);
      setLessonSyncStatus({ state: "error" });
    }
  }

  useEffect(() => {
    // One-time pull on load — merges whatever other devices already synced
    // into this device's ledger before the session records any new events.
    // Reads loadLedger() directly (not the ref) since this runs in the same
    // effect flush as the seed-merge effect above, before that effect's
    // setLedgerEvents has necessarily re-rendered; loadLedger() always
    // reflects the seed-merge's saveLedger() call, which is synchronous.
    (async () => {
      try {
        const response = await fetchWithPasscode("/api/lessons");
        if (!response.ok) {
          pushBrainLog("error", `lesson sync pull failed: HTTP ${response.status}`);
          return;
        }
        const data = await response.json();
        if (!Array.isArray(data.events)) return;
        const merged = mergeLedgerEvents(loadLedger(), data.events as LessonEvent[]);
        saveLedger(merged);
        setLedgerEvents(merged);
        setLessonSyncStatus({ state: "synced", count: merged.length });
        // First-open backlog upload: a device that recorded events before M6
        // shipped (or while offline) holds events the server has never seen —
        // without this, they'd only upload after the NEXT recorded event.
        // Merely opening the app is enough to drain the backlog.
        if (merged.length > (data.events as LessonEvent[]).length) void pushLedgerToServer();
      } catch (err) {
        pushBrainLog("error", `lesson sync pull failed: ${err instanceof Error ? err.message : "network error"}`);
      }
    })();
  }, []);

  /** Appends one ledger event and mirrors the result into React state — the one place every ledger write goes through. Also (re)arms the debounced cloud push (~5s, coalescing rapid-fire events like a burst of fx presses into one POST). */
  function recordLedgerEvent(event: LessonEvent) {
    setLedgerEvents(appendLedgerEvent(event));
    setLessonSyncStatus((prev) => ({ ...prev, state: "pending" }));
    if (lessonSyncTimeoutRef.current) clearTimeout(lessonSyncTimeoutRef.current);
    lessonSyncTimeoutRef.current = setTimeout(() => {
      lessonSyncTimeoutRef.current = null;
      void pushLedgerToServer();
    }, 5000);
  }

  /** The live deck's track context for a ledger event, or all-null if nothing is live — mirrors recordFxDemonstration's own context-gathering above, kept separate since the ledger event shape (trackId, not bpm/tempo/remainingSeconds) differs. */
  function liveTrackContextForLedger(): { trackId?: string; trackName?: string; positionSeconds?: number } {
    const liveLabel = getLiveDeckLabel();
    const liveCtrl = liveLabel ? deckByLabel(liveLabel) : null;
    if (!liveCtrl || !liveCtrl.trackName) return {};
    return {
      trackId: liveCtrl.trackId ?? undefined,
      trackName: liveCtrl.trackName,
      positionSeconds: liveCtrl.deck.positionSeconds,
    };
  }

  /** Records a manual OR brain-fired fx/vocal/scratch press to the ledger — `source` picks fx_manual vs fx_brain (see lesson-ledger.ts's file header on why these stay separate types). */
  function recordLedgerFx(fx: string, source: "manual" | "brain") {
    recordLedgerEvent({
      type: source === "manual" ? "fx_manual" : "fx_brain",
      when: new Date().toISOString(),
      fx,
      ...liveTrackContextForLedger(),
      duringTransition: transitionEngineRef.current.isRunning,
    });
  }

  // --- Brain + autopilot (Parts C/D) ---
  const [autopilot, setAutopilot] = useState(false);
  const autopilotRef = useRef(autopilot);
  autopilotRef.current = autopilot;
  // Set arc / anthem residency (Part 4): party-length state. partyStartMsRef
  // is read-only-ref (never rendered directly, see party-store.ts's own doc
  // comment on what "reset" means); partyPlannedSeconds is user-facing (the
  // selector next to the autopilot toggle) so it's real state, mirrored into
  // a ref too since buildDjState() can be called from a long-lived
  // setInterval closure (the autopilot poll effect) that would otherwise
  // read a stale value — same pattern as every other *Ref mirror here.
  const partyStartMsRef = useRef<number | null>(loadPartyStartMs());
  const [partyPlannedSeconds, setPartyPlannedSecondsState] = useState<number | null>(() => loadPartyPlannedSeconds());
  const partyPlannedSecondsRef = useRef(partyPlannedSeconds);
  partyPlannedSecondsRef.current = partyPlannedSeconds;
  function setPartyPlannedSeconds(seconds: number | null) {
    setPartyPlannedSecondsState(seconds);
    savePartyPlannedSeconds(seconds);
  }
  const [history, setHistory] = useState<{ trackId: string; name: string }[]>([]);
  const historyRef = useRef(history);
  historyRef.current = history;
  const [brainLog, setBrainLog] = useState<BrainLogEntry[]>([]);
  const brainLogIdRef = useRef(0);
  const [chatInput, setChatInput] = useState("");
  const [brainBusy, setBrainBusy] = useState(false);
  const brainBusyRef = useRef(false);
  // Per-live-trackId (or "__opener__") "already asked" guard — an asked-at
  // TIMESTAMP, not a permanent sentinel (review-panel fix, see
  // AUTOPILOT_OPENER_REASK_MS above): the opener re-asks after the reask
  // window if still nothing live, and executeQueueCommand's failure paths
  // clear this outright so the very next poll retries immediately.
  const askedForTrackRef = useRef<{ key: string; at: number } | null>(null);
  const retryStageRef = useRef(0); // 0 = fresh, 1 = one retry already sent
  const localRecoveryUntilRef = useRef(0);
  const performanceControlVersionRef = useRef(0);
  const executionFeedbackRef = useRef<{ action: string; status: "rejected"; reason: string } | null>(null);
  const retryTimeoutHandleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Review-panel fix (vibe-note persistence): the human's most recent chat
  // submission + when it was sent, so EVERY brain call (autopilot-driven
  // included, not just the one the human actually typed into) can report
  // state.lastVibeNote with an honest age — previously a vibe note only
  // rode along on the single request it was typed into.
  const lastVibeNoteRef = useRef<{ text: string; at: number } | null>(null);
  const genreRequestRef = useRef<GenreRequest | null>(null);
  const performanceMixRef = useRef(false);
  // M7 blocker fix: the owner's standing EXPLICIT residency instruction
  // ("30 seconds of a song then mix in the next one"), parsed out of their
  // chat by src/lib/residency.ts. Sticky on purpose — silence is not a
  // cancellation, only an explicit "back to normal" clears it (see
  // applyResidencyParse). Read by buildDjState AND by the autopilot poll,
  // which is what makes the instruction actually bind instead of being
  // prompt guidance the brain can drift past.
  const residencyRequestRef = useRef<ResidencyRequest | null>(null);
  // Deferred re-consult (owner soundcheck fix, 2026-07-26): a brain response
  // can set followUpSeconds ("re-consult me in N seconds") instead of dying
  // silently after a one-command ack — this is the single pending slot for
  // that scheduled call (latest wins; see scheduleFollowUp/cancelFollowUp).
  const followUpTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followUpRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Adversarial-review fix: a follow-up's wire consultReason is always
  // honestly "follow_up", but its COOLDOWN classification must inherit the
  // ROOT reason that started the chain — otherwise an autopilot-originated
  // follow-up (opener/autopilot_poll set followUpSeconds) would read as
  // human-initiated and bypass the fx floor. Root persists across an
  // arbitrarily long follow_up chain (each re-schedule reuses the same
  // root); null when no follow-up chain is pending.
  const followUpRootReasonRef = useRef<ConsultReason | null>(null);
  // Cost addendum (2026-07-26): compact crate index -> real crate item id,
  // rebuilt fresh every callBrain() from the FULL crate in stable (array)
  // order — see buildFullCompactCrate(). Covers every entry regardless of
  // whether this call's window included it, so resolving a queue command's
  // trackId (the stringified index) always works even against a windowed
  // slice.
  const crateIndexMapRef = useRef<Map<number, string>>(new Map());
  // Phrase-aligned firing (Part 2): a queue command's actual runTransition()
  // call is delayed via setTimeout until the live track's next phrase
  // boundary (see executeQueueCommand) — single pending slot, same
  // "keep it simple, a single cancelable timeout ref" posture as
  // followUpTimeoutRef above. Cancelled by a new queue command (top of
  // executeQueueCommand) or a manual pause on either deck (see
  // cancelPendingTransitionStart()/useDeckController's onManualPause).
  const pendingTransitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Choir round #2 (C4): a "space_sweep" maskFx's DEFERRED neutral-reset
  // timer (see clearPendingMaskFxRelease()/the onDone handler below) —
  // single slot, same posture as every other *TimeoutRef in this file.
  const maskFxReleaseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Choir round #2 (P1): single-flight guard for executeQueueCommand's own
  // async setup window (download/decode/phrase-wait) — see its own
  // "releaseQueueInFlight" helper for exactly what window this covers.
  const queueInFlightRef = useRef(false);
  // See the watchdog in the live-state builder. Null while nothing is in flight.
  const queueInFlightSinceRef = useRef<number | null>(null);
  const queuePreparationRef = useRef<AbortController | null>(null);
  const pendingGapRef = useRef<{ trackId: string; command: QueueCommand } | null>(null);
  const localRecipeMovesSinceBrainRef = useRef(0);

  const anyPlaying = deckA.isPlaying || deckB.isPlaying;

  async function acquireWakeLock() {
    try {
      const nav = navigator as NavigatorWithWakeLock;
      if (nav.wakeLock && !wakeLockRef.current) {
        wakeLockRef.current = await nav.wakeLock.request("screen");
      }
    } catch {
      // Not fatal — e.g. unsupported browser or low battery. Playback still works.
    }
  }

  async function releaseWakeLock() {
    try {
      await wakeLockRef.current?.release();
    } catch {
      // ignore
    }
    wakeLockRef.current = null;
  }

  // Wake Lock applies while EITHER deck is playing, released only when BOTH
  // are stopped — driven off the combined state rather than per-deck logic.
  useEffect(() => {
    if (anyPlaying) {
      void acquireWakeLock();
    } else {
      void releaseWakeLock();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyPlaying]);

  // Screen Wake Lock is released by the browser whenever the tab is hidden;
  // re-acquire it when the tab comes back to the foreground during playback.
  // Review-panel fix: the AudioContext itself can ALSO get suspended by the
  // OS while backgrounded (a separate mechanism from the Wake Lock) — resume
  // it here too, or the app can come back to the foreground with no sound
  // and no obvious reason why.
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "visible" && anyPlaying) {
        void acquireWakeLock();
        const resumed = coreRef.current?.resumeIfSuspended();
        if (resumed) pushBrainLog("audio", "resumed the audio context after returning to the foreground");
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyPlaying]);

  // Equal-power crossfade curve: gainA = cos(x*pi/2), gainB = sin(x*pi/2).
  // Applied every time the slider moves — but skipped while an engine
  // transition owns the gain nodes directly (see runQueueTransition's
  // onGain, which drives `crossfade` for display purposes during a
  // transition; letting this effect also fire would just re-apply the same
  // equal-power math a second time, which is harmless but redundant, so we
  // gate it for clarity).
  useEffect(() => {
    if (transitionRunning) return;
    const gainA = Math.cos((crossfade * Math.PI) / 2);
    const gainB = Math.sin((crossfade * Math.PI) / 2);
    deckA.deck.setGain(gainA);
    deckB.deck.setGain(gainB);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crossfade, transitionRunning]);

  function handleCrossfadeChange(event: React.ChangeEvent<HTMLInputElement>) {
    teardownMigration();
    setCrossfade(parseFloat(event.target.value));
  }

  const bpmA = deckA.tags.bpm;
  const bpmB = deckB.tags.bpm;
  const missingBpmReason = "Beat Sync needs both decks to have a BPM tag";
  const syncDisabled = !bpmA || !bpmB;
  const syncDisabledReason = missingBpmReason;

  /**
   * Grid to use for phase-align: the deck's real parsed Serato BeatGrid when
   * present, otherwise a fallback of anchor 0 + tagged BPM (marked
   * "estimated" — still lets Beat Sync run, just less precise since anchor 0
   * is a guess, not a real downbeat position). Also reused by the auto-
   * transition executor below (Part B), so manual and automatic transitions
   * resolve grids identically.
   */
  function effectiveGrid(
    deckTags: Id3Tags,
    deckGrid: SeratoBeatgrid | null
  ): (BeatGridLike & { estimated: boolean }) | null {
    if (deckGrid) return { anchor: deckGrid.anchor, bpm: deckGrid.bpm, estimated: false };
    if (deckTags.bpm) return { anchor: 0, bpm: deckTags.bpm, estimated: true };
    return null;
  }

  /**
   * In-and-out mixing: analyzes (or returns the cached) mix-in/mix-out
   * points for a queued crate item, off its now-decoded buffer's channel 0
   * (mono is fine for RMS — see src/lib/energy.ts). Cached per crate-item id
   * for the session (mixPointsCacheRef) so a re-queued track isn't
   * re-analyzed. A user-assigned "mix in"-labeled cue (if any) overrides the
   * heuristic mixIn — see energy.ts's applyMixInCueOverride. Returns null
   * only if the buffer somehow isn't decoded yet (defensive; callers always
   * call this after a successful decodeIfNeeded()).
   */
  function analyzeMixPoints(item: CrateTrack, ctrl: DeckController): MixPoints | null {
    const buffer = ctrl.deck.audioBuffer;
    if (!buffer) return null;
    const cached = mixPointsCacheRef.current.get(item.id);
    if (cached) {
      // The mix points are cached but the RMS profile lives on the deck
      // controller, which is cleared on every load — recompute it so a
      // re-queued track does not silently lose its down parts.
      if (!ctrl.rmsProfile) ctrl.setRmsProfile(computeRmsPerSecond(buffer.getChannelData(0), buffer.sampleRate));
      return cached;
    }
    const rms = computeRmsPerSecond(buffer.getChannelData(0), buffer.sampleRate);
    ctrl.setRmsProfile(rms); // M7 Phase 5: reused by down-part detection
    const grid = effectiveGrid(ctrl.tags, ctrl.grid);
    let points = findMixPoints(rms, grid ? { anchor: grid.anchor, bpm: grid.bpm } : null);
    const cueKey = cueTrackKey({ source: item.source, id: item.id, name: item.name, size: item.size });
    points = avoidEarlyVocalIntro(points, getVocalIntervals(VOCAL_MAPS, cueKey), grid ? { anchor: grid.anchor, bpm: grid.bpm } : null, rms.length);
    const loopEntry = getLoopPoints(CURRENT_LOOP_POINTS, cueKey);
    const tightenedMixOut = selectMidTrackExitPoint(loopEntry, points.mixOutSeconds, points.mixInSeconds, MIN_ENTRY_RESIDENCY_SECONDS);
    if (tightenedMixOut < points.mixOutSeconds) {
      points = { ...points, mixOutSeconds: tightenedMixOut };
    }
    // Choir round #2 (C6): applyMixInCueOverride now needs the track's own
    // duration to reject a stale/out-of-range "mix in" cue — rms.length is
    // the same whole-second duration findMixPoints itself already used.
    points = applyMixInCueOverride(points, getCues(cueStoreRef.current, cueKey), rms.length);
    mixPointsCacheRef.current.set(item.id, points);
    return points;
  }

  /**
   * Tempo-sync `target` to `source`'s effective BPM. Graduated: when both
   * decks are playing, also phase-align `target` onto `source` (full Beat
   * Sync); otherwise tempo-only, since one/both decks not yet playing is the
   * normal DJ workflow of prepping an incoming track's tempo BEFORE it plays
   * — phase can't be judged (or snapped) against a deck that isn't running.
   */
  function beatSync(
    source: DeckController,
    sourceBpm: number,
    target: DeckController,
    targetBpm: number
  ) {
    const result = syncTempo(sourceBpm, source.tempo, targetBpm, { min: TEMPO_MIN, max: TEMPO_MAX });
    target.setTempoDirectly(result.tempo);

    let notice = result.clamped
      ? `needs ${formatSignedPct(result.requiredTempo)}, clamped to ${formatSignedPct(result.tempo)}`
      : null;

    if (!source.isPlaying || !target.isPlaying) {
      notice =
        (notice ? `${notice}; ` : "") +
        "tempo matched — Beat Sync again while both playing to lock phase";
      target.setSyncNotice(notice);
      return;
    }

    const sourceGrid = effectiveGrid(source.tags, source.grid);
    const targetGrid = effectiveGrid(target.tags, target.grid);
    if (sourceGrid && targetGrid) {
      const offset = phaseAlignOffset(
        source.deck.positionSeconds,
        sourceGrid,
        source.tempo,
        target.deck.positionSeconds,
        targetGrid,
        result.tempo
      );
      target.deck.seekBy(offset);
      const estimatedNote = sourceGrid.estimated || targetGrid.estimated ? " (estimated grid)" : "";
      notice = (notice ? `${notice}; ` : "") + `phase-aligned${estimatedNote}`;
    }

    target.setSyncNotice(notice);
  }

  function handleBeatSyncBtoA() {
    if (!bpmA || !bpmB) return;
    beatSync(deckA, bpmA, deckB, bpmB);
  }

  function handleBeatSyncAtoB() {
    if (!bpmA || !bpmB) return;
    beatSync(deckB, bpmB, deckA, bpmA);
  }

  // --- Crate handlers (Part A) ---

  async function handleAddToCrate(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    setCrateAdding(true);
    const added: CrateTrack[] = [];
    for (const file of files) {
      let tags: Id3Tags = {};
      let grid: SeratoBeatgrid | null = null;
      try {
        [tags, grid] = await Promise.all([parseId3Tags(file), parseSeratoBeatgrid(file)]);
      } catch {
        tags = {};
        grid = null;
      }
      added.push({
        id: makeTrackId(file.name),
        name: file.name,
        size: file.size,
        source: "local",
        file,
        bpm: tags.bpm ?? null,
        key: tags.key ?? null,
        title: tags.title,
        artist: tags.artist,
        genre: tags.genre,
        grid,
      });
    }
    // Local entries are trivially "party-safe" — the File is already in
    // memory, no network round trip needed to play it (see CratePanel's
    // isCached check: source === "local" always counts as cached).
    setCrate((prev) => [...prev, ...added]);
    setCrateAdding(false);
  }

  function getLiveDeckLabel(): DeckLabel | null {
    const a = deckARef.current;
    const b = deckBRef.current;
    if (a.deck.playing && !b.deck.playing) return "A";
    if (b.deck.playing && !a.deck.playing) return "B";
    if (a.deck.playing && b.deck.playing) return crossfadeRef.current <= 0.5 ? "A" : "B";
    return null;
  }

  function pickIdleDeckLabel(): DeckLabel {
    const live = getLiveDeckLabel();
    if (live === "A") return "B";
    if (live === "B") return "A";
    if (!deckARef.current.trackName) return "A";
    if (!deckBRef.current.trackName) return "B";
    return "A";
  }

  function deckByLabel(label: DeckLabel): DeckController {
    return label === "A" ? deckARef.current : deckBRef.current;
  }

  /** The cue-store key (src/lib/cue-store.ts's cueTrackKey) for whichever track is loaded on `label` — same stable per-track key src/data/vocal-maps.json is keyed by (see cueKeyA/cueKeyB above). Null if nothing's loaded / label is null. */
  function cueKeyForLabel(label: DeckLabel | null): string | null {
    if (label === "A") return cueKeyARef.current;
    if (label === "B") return cueKeyBRef.current;
    return null;
  }

  /**
   * Resolves the real playable Blob/File for a crate track — the one
   * lazy-loading choke point deck loading and the autopilot queue both go
   * through (Deliverable 3/4). Local file-picker entries already hold their
   * File in memory (unchanged behavior, no network). Drive entries have no
   * blob at all until now: getTrackBlob() (src/lib/track-cache.ts) returns
   * the cached copy if IndexedDB already has it, or downloads the full file
   * through the proxy (no Range — the whole track) and caches it. Throws on
   * a real download failure — callers decide what "queue failed" means for
   * their own flow (see executeQueueCommand's/handleCrateTap's catch).
   */
  async function getTrackForPlayback(track: CrateTrack, signal?: AbortSignal): Promise<File | Blob> {
    signal?.throwIfAborted();
    if (track.source === "local") {
      if (!track.file) throw new Error(`"${track.name}" is a local entry with no file loaded`);
      return track.file;
    }
    const blob = await getTrackBlob(
      track.id,
      async () => {
        const asset = resolveAudioAssetUrl(track.id);
        const response = await fetchWithPasscode(asset.url, { signal });
        if (!response.ok) throw new Error(`download failed (HTTP ${response.status})`);
        return response.blob();
      },
      {
        store: trackCacheStoreRef.current,
        onCacheMiss: () => pushBrainLog("crate", `downloading "${track.name}"…`),
        // Drive listing byte size — powers the poisoned-cache guard in
        // getTrackBlob (evicts pre-Edge-fix truncated entries automatically).
        expectedSize: track.size ?? undefined,
      }
    );
    setCachedIds((prev) => (prev.has(track.id) ? prev : new Set(prev).add(track.id)));
    return blob;
  }

  function handleCrateTap(track: CrateTrack) {
    stopStemMixerRef.current?.();
    performanceControlVersionRef.current += 1;
    queuePreparationRef.current?.abort(new Error("Playback changed manually"));
    teardownMigration();
    const label = pickIdleDeckLabel();
    void (async () => {
      try {
        const blob = await getTrackForPlayback(track);
        await deckByLabel(label).loadFile(blob, track.name, track.id, track.source);
      } catch (err) {
        setDriveNotices((prev) => [
          ...prev,
          `${track.name}: ${err instanceof Error ? err.message : "could not load track"}`,
        ]);
      }
    })();
  }

  function handleLoadTrackToSpecificDeck(targetLabel: DeckLabel, trackId: string, autoPlay = false) {
    coreRef.current?.ensureContext();
    const resolved = ensureTrackInCrate(trackId);
    if (!resolved) {
      pushBrainLog("error", `Deck ${targetLabel}: could not find track "${trackId}" in library`);
      return;
    }
    const { track } = resolved;
    const ctrl = deckByLabel(targetLabel);
    const wasPlayingOnThisDeck = ctrl.deck.playing;
    if (wasPlayingOnThisDeck || autoPlay) {
      stopStemMixerRef.current?.();
      performanceControlVersionRef.current += 1;
      queuePreparationRef.current?.abort(new Error(`Loading track onto Deck ${targetLabel}`));
      teardownMigration();
    }
    pushBrainLog(
      "crate",
      `🎵 Loading "${musicLabel(track)}" (${track.bpm ? `${Math.round(track.bpm)} BPM` : "—"} · ${toCamelot(track.key) ?? track.key ?? "—"}) onto Deck ${targetLabel}…`
    );
    void (async () => {
      try {
        const blob = await getTrackForPlayback(track);
        await ctrl.loadFile(blob, track.name, track.id, track.source);
        await ctrl.decodeIfNeeded();
        if (autoPlay || wasPlayingOnThisDeck) {
          handleManualPlayDeck(targetLabel);
          ctrl.deck.play();
          ctrl.markPlaying();
        }
        pushBrainLog("crate", `✅ Deck ${targetLabel} ready: "${musicLabel(track)}"`);
      } catch (err) {
        pushBrainLog(
          "error",
          `Deck ${targetLabel}: could not load "${track.name}" (${err instanceof Error ? err.message : "load error"})`
        );
      }
    })();
  }

  // --- Drive crate loader handlers (re-architected for the lazy-crate design) ---

  async function handleLoadDriveList() {
    setDriveListing(true);
    setDriveNotices([]);
    try {
      const response = await fetchWithPasscode("/api/crate");
      let json: { tracks?: CrateTrackListing[]; error?: string } | null = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      if (!response.ok || !json || json.error) {
        setDriveNotices([json?.error || `Drive list failed (HTTP ${response.status})`]);
        setDriveTracks(null);
        return;
      }
      setDriveTracks(Array.isArray(json.tracks) ? json.tracks : []);
    } catch (err) {
      setDriveNotices([err instanceof Error ? err.message : "network error listing Drive crate"]);
      setDriveTracks(null);
    } finally {
      setDriveListing(false);
    }
  }

  /**
   * Metadata-only crate build (Deliverable 1/2): for every playable (mp3)
   * Drive track, resolves BPM/key/BeatGrid WITHOUT a network probe whenever
   * possible (M6.2 probe-storm fix) — first from the committed manifest's
   * local-tag-matched data (CRATE_MANIFEST_TAG_INDEX), then from this
   * track's existing crate entry if one's already known (a prior add, or
   * this device's restored crate — see loadCrateList() above); only a
   * genuine miss on both falls back to the original Range-probe path
   * (fetchTagHeader — first 256KB, grown if the tag declares a bigger size —
   * then parses BPM/key/BeatGrid with the SAME id3/serato path local files
   * use). This is the actual fix for the incident: every repeat "Add all
   * from Drive" tap (and every fresh page load, since the crate
   * auto-restores with tags already known) used to re-probe all ~326 tracks
   * regardless of what was already known, which is what turned into the
   * rate-limit-triggering probe storm against Google Drive. Real probes that
   * do still happen are throttled (CRATE_TAG_PROBE_CONCURRENCY workers,
   * CRATE_TAG_PROBE_DELAY_MS pause after each) instead of an unbounded
   * burst. NO full-file download, NO in-memory File, regardless of path.
   * onItemDone drives the "Reading tags X/N…" progress indicator. Honest
   * per-track notices on failure (network, oversize, etc.) without aborting
   * the rest of the batch. Replaces the crate's existing Drive-sourced
   * entries (a repeat click refreshes rather than duplicating) — local
   * file-picker entries are untouched.
   */
  async function handleAddAllFromDrive() {
    if (!driveTracks) return;
    const playable = driveTracks.filter((t) => t.playable);
    const skippedCount = driveTracks.length - playable.length;
    if (playable.length === 0) {
      setDriveNotices(skippedCount > 0 ? [`${skippedCount} file(s) skipped (not mp3)`] : []);
      return;
    }

    setDriveAdding(true);
    setDriveTagProgress({ done: 0, total: playable.length });
    const notices: string[] = [];
    let completed = 0;
    const existingById = new Map(crateRef.current.map((t) => [t.id, t]));

    const results = await runWithConcurrency<CrateTrackListing, CrateTrack | null>(
      playable,
      CRATE_TAG_PROBE_CONCURRENCY,
      async (track) => {
        try {
          const manifestTags = CRATE_MANIFEST_TAG_INDEX.get(track.id);
          if (manifestTags && hasUsableTags(manifestTags)) {
            const existing = existingById.get(track.id);
            const resolved = resolveMusicMetadata({
              id: track.id,
              name: track.name,
              title: existing?.title,
              artist: existing?.artist,
              genre: existing?.genre,
              genreSource: existing?.genreSource,
            });
            return {
              id: track.id,
              name: track.name,
              size: track.size,
              source: "drive",
              bpm: manifestTags.bpm,
              key: manifestTags.key,
              grid: manifestTags.grid,
              title: resolved.title,
              artist: resolved.artist,
              genre: resolved.genre,
              genreSource: resolved.genreSource,
            };
          }
          const existing = existingById.get(track.id);
          if (existing && existing.source === "drive" && hasUsableTags(existing)) {
            return existing;
          }

          const header = await fetchTagHeader((range) =>
            fetchWithPasscode(`/api/crate/${encodeURIComponent(track.id)}`, { headers: { Range: range } })
          );
          let tags: Id3Tags = {};
          let grid: SeratoBeatgrid | null = null;
          if (header) {
            const headerFile = new File([header.bytes], track.name);
            try {
              [tags, grid] = await Promise.all([parseId3Tags(headerFile), parseSeratoBeatgrid(headerFile)]);
            } catch {
              tags = {};
              grid = null;
            }
          } else {
            notices.push(`${track.name}: could not read tags (network/HTTP error) — added with tags blank`);
          }
          // Throttle (M6.2): only real network probes pace themselves — a
          // manifest/already-known hit above returns immediately, so a
          // mostly-tagged crate stays fast even with this delay in place.
          await sleep(CRATE_TAG_PROBE_DELAY_MS);
          return {
            id: track.id,
            name: track.name,
            size: track.size,
            source: "drive",
            bpm: tags.bpm ?? null,
            key: tags.key ?? null,
            title: tags.title,
            artist: tags.artist,
            genre: existing?.genre ?? tags.genre,
            grid,
          };
        } catch (err) {
          notices.push(`${track.name}: ${err instanceof Error ? err.message : "network error reading tags"}`);
          return null;
        }
      },
      () => {
        completed += 1;
        setDriveTagProgress({ done: completed, total: playable.length });
      }
    );

    const added = results.filter((t): t is CrateTrack => t !== null).map(t => {
      const saved = genreOverridesRef.current.get(t.id);
      return { ...t, ...resolveMusicMetadata(saved ? { ...t, genre: saved.genre, genreSource: "owner" } : t) };
    });
    if (skippedCount > 0) notices.push(`${skippedCount} file(s) skipped (not mp3 — soundtouchjs pipeline is mp3-tested)`);

    setCrate((prev) => [...prev.filter((t) => t.source !== "drive"), ...added]);
    setDriveNotices(notices);
    setDriveTagProgress(null);
    setDriveAdding(false);
  }

  /**
   * Nice-to-have pre-party warm-up (Deliverable 4): downloads (and caches)
   * the full audio for up to 10 not-yet-cached Drive tracks currently in the
   * crate, bounded concurrency, so the DJ can make the whole crate
   * party-safe ahead of time instead of only on first queue. Reuses
   * getTrackForPlayback() — same cache-or-download path a real queue/tap
   * uses, so there's exactly one code path to trust.
   */
  async function handlePrefetchNext10() {
    const candidates = crateRef.current.filter((t) => t.source === "drive" && !cachedIds.has(t.id)).slice(0, 10);
    if (candidates.length === 0) return;
    setPrefetching(true);
    try {
      await runWithConcurrency(candidates, 4, async (track) => {
        try {
          await getTrackForPlayback(track);
        } catch (err) {
          pushBrainLog("crate", `prefetch failed for "${track.name}": ${err instanceof Error ? err.message : "network error"}`);
        }
      });
    } finally {
      setPrefetching(false);
    }
  }

  function handleResetCost() {
    setCostTotal(0);
    resetCostTotal();
    setUnpricedCalls(0);
    try { localStorage.removeItem("djsm.unpriced-brain-calls"); } catch { /* best effort */ }
  }

  function handleModelChange(id: BrainModelId) {
    if (brainBusyRef.current) return;
    selectedModelRef.current = id;
    setSelectedModel(id);
    localRecoveryUntilRef.current = 0;
    localRecipeMovesSinceBrainRef.current = LOCAL_RECIPE_AI_REFRESH_MOVES;
    try { localStorage.setItem(BRAIN_MODEL_STORAGE_KEY, id); } catch { /* best effort */ }
    pushBrainLog("model", `${modelOptions.find(option => option.id === id)?.label ?? id} selected for the next brain call`);
  }

  // --- Brain state serialization + log (Part C) ---

  // Performance actions whose REFUSALS must reach the synced ledger, not just the
  // on-screen log. Without this, the ledger cannot distinguish "the brain never
  // asked for stems" from "it asked and the engine refused every time" — which is
  // exactly the question the owner's 2026-08-16 test left unanswerable.
  const LEDGERED_SKIP_ACTIONS = new Set(["stem_migrate", "trance_breakdown", "eq_sweep", "loop", "routine", "fx", "eq", "queue"]);

  function pushBrainLog(action: string, say: string) {
    const id = brainLogIdRef.current++;
    setBrainLog((prev) => [...prev, { id, action, say }].slice(-BRAIN_LOG_LIMIT));
    if (LEDGERED_SKIP_ACTIONS.has(action) && /\bskipped\b/i.test(say)) {
      executionFeedbackRef.current = { action, status: "rejected", reason: say };
      const ctx = liveTrackContextForLedger();
      recordLedgerEvent({
        type: "brain_skip",
        when: new Date().toISOString(),
        action,
        reason: say.replace(/^skipped\s*[—-]?\s*/i, "").trim(),
        ...ctx,
      });
    }
  }

  function appendHistory(entry: { trackId: string; name: string }) {
    setHistory((prev) => [...prev, entry].slice(-HISTORY_LIMIT));
  }

  function checkQueueWatchdog() {
    if (!queueInFlightRef.current) { queueInFlightSinceRef.current = null; return; }
    if (queueInFlightSinceRef.current === null) queueInFlightSinceRef.current = Date.now();
    const stuckFor = (Date.now() - queueInFlightSinceRef.current) / 1000;
    if (stuckFor > QUEUE_INFLIGHT_STALE_SECONDS && !pendingTransitionTimeoutRef.current && !transitionEngineRef.current.isRunning && !migrationRef.current) {
      if (queuePreparationRef.current) { queuePreparationRef.current.abort(new Error("queue preparation watchdog")); return; }
      queueInFlightRef.current = false;
      queueInFlightSinceRef.current = null;
      cleanupHeldLoopAndRoutine("watchdog: queueInFlight was stuck");
      teardownMigration();
      pushBrainLog("queue", `skipped — WATCHDOG cleared a queue flag stuck for ${stuckFor.toFixed(0)}s (a transition never resolved); brain unblocked`);
    }
  }

  function deckLiveState(ctrl: DeckController, cueKey: string | null = null): DjLiveState | null {
    if (!ctrl.trackName) return null;
    const bpm = ctrl.tags.bpm ?? null;
    const effectiveBpm = bpm ? bpm * ctrl.tempo : null;
    const duration = ctrl.deck.duration;
    const positionSeconds = ctrl.deck.positionSeconds;
    const remainingSourceSeconds = Math.max(0, duration - positionSeconds);
    const remainingSeconds = ctrl.tempo > 0 ? remainingSourceSeconds / ctrl.tempo : remainingSourceSeconds;
    const fxLastSecondsAgo = lastFxAtRef.current === null ? null : (Date.now() - lastFxAtRef.current) / 1000;
    // In-and-out mixing: OUTPUT-time duration/elapsed (distinct from the
    // SOURCE-time `duration` above — see DjLiveState.durationSeconds' own
    // doc comment in brain.ts) + the analyzed mix-out point, if known.
    const durationSeconds = ctrl.tempo > 0 ? duration / ctrl.tempo : duration;
    const wentLiveAtMs = ctrl.wentLiveAtMs();
    const playedSeconds = wentLiveAtMs !== null ? (Date.now() - wentLiveAtMs) / 1000 : 0;
    const mixOutSeconds = ctrl.mixPoints?.mixOutSeconds ?? null;

    // Craft pass #2, Part 3 (Camelot harmonic mixing): convert raw TKEY text
    // (Camelot notation already, or musical notation — see camelot.ts's file
    // header) to Camelot; unparseable/absent -> null (never sent as raw text
    // the brain's harmonic rules can't interpret).
    const key = toCamelot(ctrl.tags.key ?? null);

    // Craft pass #2, Part 1 (vocal-clash-aware transitions): only populated
    // when this track actually has a vocal map — omitted entirely otherwise
    // (see DjLiveState's own doc comments on why "no data" must stay
    // distinct from "confirmed instrumental").
    const vocalIntervals = cueKey ? getVocalIntervals(VOCAL_MAPS, cueKey) : [];
    const hasVocals = cueKey !== null && hasVocalMap(VOCAL_MAPS, cueKey);
    let vocalActiveNow: boolean | undefined;
    let nextVocalGap: { start: number; end: number | null } | null | undefined;
    let vocalEndsAt: number | null | undefined;
    if (hasVocals) {
      vocalActiveNow = isVocalActive(vocalIntervals, positionSeconds);
      vocalEndsAt = vocalActiveNow ? activeVocalEndsAt(vocalIntervals, positionSeconds) : null;
      const gap = nextGapAtOrAfter(vocalGaps(vocalIntervals, VOCAL_GAP_MIN_SECONDS), positionSeconds);
      nextVocalGap = gap ? { start: gap.start, end: Number.isFinite(gap.end) ? gap.end : null } : null;
    }

    // M7 Phase 5: the next DOWN PART — a low-energy AND vocal-free window,
    // which is where El Cerebro's own name-drop belongs. Distinct from
    // nextVocalGap: a gap only says nobody is singing, which is just as true
    // over a full-energy instrumental drop. A down part is the breakdown.
    // Derived from the per-second RMS profile the mix-point analysis already
    // computed for this track (no new analysis), intersected with the vocal
    // map — and omitted entirely without a vocal map, since without one we
    // cannot promise the window isn't over a vocal.
    let nextDownPart: { start: number; end: number } | null | undefined;
    if (hasVocals && ctrl.rmsProfile) {
      const pick = pickDownPart(
        findDownParts(ctrl.rmsProfile, { hasVocalMap: true, vocalIntervals }),
        { fromSeconds: positionSeconds, clipSeconds: NAME_DROP_CLIP_SECONDS }
      );
      nextDownPart = pick ? { start: pick.fireAtSeconds, end: pick.part.end } : null;
    }

    // Choir round #2 (P1): true while a queue command already issued is
    // still resolving (queueInFlightRef — download/decode/phrase-wait) OR a
    // transition is actively running — see DjLiveState.transitionPending's
    // own doc comment in brain.ts.
    //
    // WATCHDOG (M8.2f, owner test 2026-08-16). If queueInFlight sticks true — a decode
    // that never resolves, a fetch that hangs without rejecting, a routine timer cleared
    // before its completion fired — the brain is told transitionPending forever and
    // politely answers "transition already queued, not stepping on it, checking back in
    // 25s" until the party ends. That exact loop is what the owner pasted. There was no
    // recovery path. Now: pending older than QUEUE_INFLIGHT_STALE_SECONDS is force-
    // cleared and ledgered as a brain_skip so the CAUSE is visible next time. Any real
    // queue/routine/migration resolves in well under this — the longest legitimate hold
    // is a 90s sample_mix plus a ~16s phrase wait plus a decode.
    checkQueueWatchdog();
    const transitionPending = queueInFlightRef.current || transitionEngineRef.current.isRunning;

    return {
      trackId: ctrl.trackId ?? ctrl.trackName,
      name: musicLabel(crateRef.current.find(t => t.id === ctrl.trackId) ?? { name: ctrl.trackName }),
      genre: resolveMusicMetadata(crateRef.current.find(t => t.id === ctrl.trackId) ?? { name: ctrl.trackName }).genre,
      genreSource: resolveMusicMetadata(crateRef.current.find(t => t.id === ctrl.trackId) ?? { name: ctrl.trackName }).genreSource,
      hasStems: stemEntryFor(ctrl.trackId) !== null,
      stemRoles: Object.keys(stemEntryFor(ctrl.trackId)?.stems ?? {}),
      bpm,
      key,
      tempo: ctrl.tempo,
      effectiveBpm,
      positionSeconds,
      duration,
      remainingSeconds,
      fxLastSecondsAgo,
      durationSeconds,
      playedSeconds,
      mixOutSeconds,
      vocalActiveNow,
      nextVocalGap,
      vocalEndsAt,
      nextDownPart,
      transitionPending,
      hasRealBeatGrid: !!ctrl.grid,
    };
  }

  function buildDjState(consultReason: ConsultReason): DjState {
    const liveLabel = getLiveDeckLabel();
    const liveCtrl = liveLabel ? deckByLabel(liveLabel) : null;
    const vibeNote = lastVibeNoteRef.current;
    // Set arc / anthem residency (Part 4): elapsed time since autopilot was
    // first turned on this party (persisted — see party-store.ts); 0 before
    // autopilot has ever run this party.
    const partyElapsedSeconds = partyStartMsRef.current !== null ? (Date.now() - partyStartMsRef.current) / 1000 : 0;
    return {
      live: liveCtrl ? deckLiveState(liveCtrl, cueKeyForLabel(liveLabel)) : null,
      idleDeck: pickIdleDeckLabel(),
      history: historyRef.current,
      autopilot: autopilotRef.current,
      consultReason,
      lastVibeNote: vibeNote ? { text: vibeNote.text, secondsAgo: (Date.now() - vibeNote.at) / 1000 } : null,
      fxDemonstrations: summarizeFxDemonstrations(fxDemonstrationsRef.current),
      partyElapsedSeconds,
      partyPlannedSeconds: partyPlannedSecondsRef.current,
      requestedResidencySeconds: residencyRequestRef.current?.seconds ?? null,
      requestedGenres: genreRequestRef.current,
      performanceMixRequested: performanceMixRef.current,
      executionFeedback: executionFeedbackRef.current,
    };
  }

  /**
   * Cost addendum (2026-07-26): the FULL compact crate list, index = array
   * position (stable as long as the crate itself doesn't change — append-
   * only in this app, so this is byte-stable call-to-call, which is what
   * makes it eligible for the cached crate block). Rebuilds
   * crateIndexMapRef fresh every call so a queue command's trackId (the
   * index, stringified) always resolves back to the real crate item —
   * covers every entry, not just whatever a later window selects.
   */
  function buildFullCompactCrate(): CompactCrateEntry[] {
    const indexMap = new Map<number, string>();
    const entries = crateRef.current.map((t, n) => {
      indexMap.set(n, t.id);
      const metadata = resolveMusicMetadata(t);
      const displayName = musicLabel(t);
      // Camelot conversion (Part 3) — same toCamelot() call deckLiveState uses.
      const camelotKey = toCamelot(t.key);
      // Vocal map lookup (Part 1) — keyed the same way vocal-maps.json/
      // cue-suggestions.json key every track (src/lib/cue-store.ts's cueTrackKey).
      const key = cueTrackKey({ source: t.source, id: t.id, name: t.name, size: t.size });
      const intervals = getVocalIntervals(VOCAL_MAPS, key);
      const firstVocalSeconds = intervals.length > 0 ? Math.min(...intervals.map(([s]) => s)) : null;
      // M8.2: tell the brain which tracks can be stem_migrate'd. stemEntryFor is the
      // same gate the executor uses (stems on Drive, not local paths), so the brain
      // is never told a track has stems that the engine would then refuse.
      const hasStems = stemEntryFor(t.id) !== null;
      const entry = buildCompactCrateEntry(n, displayName, t.bpm, camelotKey, t.grid !== null, firstVocalSeconds, hasStems, beatInFor(t.id));
      entry.genre = metadata.genre || undefined;
      entry.genreSource = metadata.genreSource;
      if (hasStems) entry.stemRoles = Object.keys(stemEntryFor(t.id)!.stems);
      if (hasStems && isTranceTrackName(t.name)) {
        const drops = CURRENT_LOOP_POINTS[key]?.drops.map(d => d.atSeconds);
        if (drops?.length) entry.drops = drops.slice(0, 3);
      }
      return entry;
    });
    crateIndexMapRef.current = indexMap;
    return entries;
  }

  /** The live deck's effective BPM (tag * tempo), or null when nothing is live or it has no BPM tag — feeds buildCrateWindow(). */
  function liveEffectiveBpmForWindow(): number | null {
    const liveLabel = getLiveDeckLabel();
    if (!liveLabel) return null;
    return deckLiveState(deckByLabel(liveLabel))?.effectiveBpm ?? null;
  }

  function resolveCommandTrack(trackId: string): CrateTrack | null {
    const direct = crateRef.current.find((t) => t.id === trackId);
    if (direct) return direct;
    const trackIndex = Number(trackId);
    if (!Number.isFinite(trackIndex)) return null;
    const mappedId = crateIndexMapRef.current.get(trackIndex);
    if (mappedId !== undefined) return crateRef.current.find((t) => t.id === mappedId) ?? null;
    return crateRef.current[trackIndex] ?? null;
  }

  function crateIndexForTrackId(trackId: string): number | null {
    const index = crateRef.current.findIndex((track) => track.id === trackId);
    return index >= 0 ? index : null;
  }

  function performanceMoveReady(): boolean {
    if (lastPerformanceAtRef.current === null) return true;
    return (Date.now() - lastPerformanceAtRef.current) / 1000 >= AUTOPILOT_PERFORMANCE_COOLDOWN_SECONDS;
  }

  function hasFreshVibeNote(): boolean {
    const note = lastVibeNoteRef.current;
    return note !== null && (Date.now() - note.at) / 1000 < LOCAL_RECIPE_FRESH_NOTE_SECONDS;
  }

  function commandFromRecipe(recipe: TransitionRecipe, trackIndex: number, recovery = false): Command {
    const trackId = String(trackIndex);
    const shortResidency = residencyRequestRef.current !== null && residencyRequestRef.current.seconds <= 60;
    if (recipe.command.action === "stem_migrate") {
      return {
        action: "stem_migrate",
        trackId,
        bars: shortResidency ? 8 : recipe.command.bars,
        anchor: recipe.command.anchor,
        say: `recipe: ${recipe.reason}`,
      };
    }
    if (recipe.command.action === "queue") {
      const live = getLiveDeckLabel();
      const ctrl = live ? deckByLabel(live) : null;
      const incoming = crateRef.current[trackIndex];
      const outgoing = crateRef.current.find(t => t.id === ctrl?.trackId) ?? { name: ctrl?.trackName ?? "" };
      const blend = recipe.command.transition === "gap" && incoming && recipeGapNeedsBlend(outgoing, incoming, performanceMixRef.current);
      const effectiveTransition = blend ? "bass_swap" : recipe.command.transition;
      const liveGrid = ctrl ? effectiveGrid(ctrl.tags, ctrl.grid) : null;
      const inGrid = incoming ? ((crateManifestJson as CrateManifestEntry[]).find(t => t.id === incoming.id)?.grid ?? incoming.grid) : null;
      const canStemMigrate =
        !recovery &&
        performanceMoveReady() &&
        ctrl &&
        incoming &&
        (performanceMixRef.current || (!isPartnerDanceTrack(outgoing) && !isPartnerDanceTrack(incoming))) &&
        effectiveTransition !== "gap" &&
        stemEntryFor(ctrl.trackId) !== null &&
        stemEntryFor(incoming.id) !== null &&
        liveGrid &&
        !liveGrid.estimated &&
        inGrid &&
        Math.abs(ctrl.deck.tempo - 1) <= 0.06 &&
        Math.abs((liveGrid.bpm * ctrl.deck.tempo) / inGrid.bpm - 1) <= 0.05;
      if (canStemMigrate && localRecipeMovesSinceBrainRef.current % 2 === 1) {
        const migrateBars = shortResidency ? 8 : 16;
        return {
          action: "stem_migrate",
          trackId,
          bars: migrateBars,
          anchor: "out",
          say: `recipe: ${migrateBars}-bar stem migration (${recipe.reason})`,
        };
      }
      return queueForResidency({
        action: "queue",
        trackId,
        transition: effectiveTransition,
        durationBars: recipe.command.durationBars,
        startAt: recipe.command.startAt,
        ...(recipe.command.maskFx ? { maskFx: recipe.command.maskFx } : {}),
        say: `recipe: ${blend ? "blend follows current genres and your mixing request" : recipe.reason}`,
      }, residencyRequestRef.current?.seconds ?? null, ctrl?.tags.bpm ?? null,
        ctrl?.deck.tempo ?? 1, crateRef.current[trackIndex]?.bpm ?? null);
    }
    return {
      action: "routine",
      routine: "sample_mix",
      sample: {
        ...recipe.command.sample,
        ...(shortResidency ? { holdSeconds: 18 } : {}),
      },
      queue: {
        trackId,
        transition: recipe.command.queue.transition,
        durationBars: recipe.command.queue.durationBars,
        startAt: recipe.command.queue.startAt,
        ...(recipe.command.queue.maskFx ? { maskFx: recipe.command.queue.maskFx } : {}),
      },
      say: `recipe: ${recipe.reason}`,
    };
  }

  function tryExecuteLocalAutopilotRecipe(liveState: Pick<DjLiveState, "trackId">, recovery = false): boolean {
    if (queueInFlightRef.current || transitionEngineRef.current.isRunning || heldLoopRef.current || migrationRef.current) return false;
    recovery = recovery || Date.now() < localRecoveryUntilRef.current;
    if (!recovery && modelOnlyRef.current) return false;
    if (!recovery && hasFreshVibeNote() && residencyRequestRef.current === null && genreRequestRef.current === null) return false;
    if (!recovery && localRecipeMovesSinceBrainRef.current >= LOCAL_RECIPE_AI_REFRESH_MOVES) {
      pushBrainLog("recipe", "asking El Cerebro for a set-level refresh after local recipes");
      return false;
    }
    const file = TRANSITION_RECIPES as TransitionRecipeFile;
    const candidates = file.recipes[liveState.trackId] ?? [];

    const availableIds = new Set(crateRef.current.map((track) => track.id));
    const recentIds = new Set(historyRef.current.slice(-HISTORY_LIMIT).map((entry) => entry.trackId));
    for (const recipe of candidates) {
      if (!availableIds.has(recipe.toId) || recentIds.has(recipe.toId)) continue;
      const target = crateRef.current.find(t => t.id === recipe.toId);
      if (!target || !genreAllowed(resolveMusicMetadata(target).genre, genreRequestRef.current)) continue;
      // A failed cloud refresh must not launch another complex routine as its
      // recovery. Use a precomputed normal handoff and retain all queue guards.
      if (recovery && recipe.command.action !== "queue") continue;
      if ((recipe.command.action === "routine" || recipe.command.action === "stem_migrate") && !performanceMoveReady()) continue;
      const trackIndex = crateIndexForTrackId(recipe.toId);
      if (trackIndex === null) continue;
      const command = commandFromRecipe(recipe, trackIndex, recovery);
      const parsed = CommandSchema.safeParse(command);
      if (!parsed.success) continue;
      localRecipeMovesSinceBrainRef.current += 1;
      if (recovery) {
        if (Date.now() >= localRecoveryUntilRef.current) localRecoveryUntilRef.current = Date.now() + 120000;
        pushBrainLog("recovery", "brain delayed or unavailable — continuing with a local transition; no other model called");
      } else pushBrainLog("recipe", `local recipe ${localRecipeMovesSinceBrainRef.current}/${LOCAL_RECIPE_AI_REFRESH_MOVES}: ${command.say ?? recipe.reason}`);
      executeCommand(parsed.data, "autopilot_poll");
      return true;
    }
    if (recovery || genreRequestRef.current !== null || residencyRequestRef.current !== null) {
      const liveLabel = getLiveDeckLabel();
      const ctrl = liveLabel ? deckByLabel(liveLabel) : null;
      const target = genreRecoveryTrack(crateRef.current, liveState.trackId, recentIds, genreRequestRef.current, ctrl?.tags.bpm ?? null);
      const index = target ? crateIndexForTrackId(target.id) : null;
      if (target && index !== null && ctrl) {
        const command = queueForResidency({ action: "queue", trackId: String(index),
          transition: !performanceMixRef.current && isPartnerDanceTrack(target) ? "gap" : "bass_swap",
          durationBars: 4, startAt: "auto", say: "Local handoff within your requested genres" },
          residencyRequestRef.current?.seconds ?? null, ctrl.tags.bpm ?? null, ctrl.deck.tempo, target.bpm);
        if (recovery) localRecoveryUntilRef.current = Date.now() + 120000;
        pushBrainLog("recipe", `genre-matched handoff into "${musicLabel(target)}"`);
        executeCommand(command, "autopilot_poll");
        return true;
      }
    }
    return false;
  }

  // --- Command execution (Parts B+C: brain picks, engine executes) ---

  function executeTempoNudge(command: TempoNudgeCommand) {
    if (migrationRef.current || migrationPreparingRef.current) return;
    const liveLabel = getLiveDeckLabel();
    if (!liveLabel) {
      pushBrainLog("error", "tempo_nudge: no live deck to adjust");
      return;
    }
    // Owner soundcheck fix: an explicit tempo_nudge means the brain now owns
    // this deck's tempo for this moment — the auto-recovery glide must stop
    // fighting it.
    cancelTempoGlide();
    const liveCtrl = deckByLabel(liveLabel);
    const next = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, liveCtrl.tempo + command.tempoDelta));
    liveCtrl.setTempoDirectly(next);
  }

  /**
   * `cooldownReason` classifies WHY this call happened, for the cooldown
   * floor ONLY — it is the resolved ROOT reason (see callBrain's
   * cooldownReason computation and followUpRootReasonRef), never the raw
   * wire "follow_up" value, so an autopilot-originated follow-up chain can't
   * borrow the human exemption. Adversarial-review fix history: the floor
   * first keyed off "this call's message was null" (wrong — a follow_up's
   * message is null too), then off the raw consultReason (still wrong — a
   * follow_up's ROOT might be autopilot_poll/opener). isHumanInitiated()
   * (src/lib/brain.ts) is the correct classification once given the root:
   * "user_chat"/"follow_up"(-rooted-in-user_chat) are exempt from the hard
   * cooldown floor below, "autopilot_poll"/"opener" stay floored.
   */
  function executeFxCommand(command: FxCommand, cooldownReason: ConsultReason) {
    if (migrationRef.current || migrationPreparingRef.current) { pushBrainLog("fx", "skipped — stem performance owns the audio"); return; }
    // Code-side guard (review-panel fix): the prompt already forbids firing
    // fx mid-transition, but enforce it here too rather than trusting the
    // model every time — an honest log line either way.
    if (transitionEngineRef.current.isRunning) {
      pushBrainLog("fx", `skipped "${command.fx}" — a transition is currently in progress`);
      return;
    }

    // Hard cooldown floor (review-panel fix, reclassified per the
    // adversarial-review fixes above): only for app-cadence calls
    // (autopilot_poll/opener, by ROOT) — a human-initiated call (chat, or a
    // follow-up chain rooted in a chat) is exempt, the human asked directly.
    // recordFxFired() itself (below, success-only) still won't fire if this
    // skip happens, so the cooldown clock is untouched by a skip.
    // M7 Phase 3: which floor applies depends on the CLASS of the move.
    // Rolls are performance (loose floor, own clock); airhorns and the rest
    // of the stingers keep the rare, research-backed cap.
    const performance = isPerformanceMove(command.fx);
    if (!isHumanInitiated(cooldownReason)) {
      const clockRef = performance ? lastPerformanceAtRef : lastFxAtRef;
      const floorSeconds = performance ? AUTOPILOT_PERFORMANCE_COOLDOWN_SECONDS : AUTOPILOT_FX_COOLDOWN_SECONDS;
      const secondsAgo = clockRef.current === null ? null : (Date.now() - clockRef.current) / 1000;
      if (secondsAgo !== null && secondsAgo < floorSeconds) {
        pushBrainLog(
          "fx",
          `skipped "${command.fx}" — ${performance ? "performance" : "stinger"} cooldown floor (${secondsAgo.toFixed(0)}s < ${floorSeconds}s), root=${cooldownReason}`
        );
        return;
      }
    }

    if (command.fx.startsWith("scratch_")) {
      const liveLabel = getLiveDeckLabel();
      if (!liveLabel) {
        pushBrainLog("error", "fx: no live deck to scratch");
        return;
      }
      // recordFxFired() only when the scratch actually schedules something
      // (review-panel fix — previously it burned the cooldown even on a
      // silent no-op, e.g. no buffer decoded yet).
      const scratchPattern = command.fx.slice("scratch_".length) as ScratchPattern;
      const started = scratch(deckByLabel(liveLabel).deck, coreRef.current!, scratchPattern, (deckByLabel(liveLabel).tags.bpm ?? NEUTRAL_BPM_FALLBACK) * deckByLabel(liveLabel).deck.tempo);
      if (started) {
        recordFxFired();
        recordLedgerFx(command.fx, "brain");
      }
      return;
    }
    if (command.fx.startsWith("roll_")) {
      const liveLabel = getLiveDeckLabel();
      if (!liveLabel) {
        pushBrainLog("error", "fx: no live deck to roll");
        return;
      }
      const liveCtrl = deckByLabel(liveLabel);
      const bpm = liveCtrl.tags.bpm ?? NEUTRAL_BPM_FALLBACK;
      const started = fireRoll(liveCtrl.deck, coreRef.current!, bpm, ROLL_SUBDIVISION_BY_FX[command.fx as RollFxName]);
      if (started) {
        recordFxFired(true); // performance clock, not the stinger clock
        recordLedgerFx(command.fx, "brain");
      }
      return;
    }
    if ((VOCAL_CATEGORIES as string[]).includes(command.fx)) {
      playVocalCategory(command.fx as VocalCategory); // demonstrate defaults false -> logs as fx_brain, see playVocalCategory
      return;
    }
    // recordFxFired() only when playback actually starts (async — the clip
    // still needs to fetch/decode). A failed load no longer burns the
    // cooldown for nothing.
    void fxPlayerRef.current?.play(command.fx as SfxName).then((success) => {
      if (success) {
        recordFxFired();
        recordLedgerFx(command.fx, "brain");
      }
    });
  }

  /**
   * Fires a random clip from `category` (rotation + auto-duck, see
   * VocalPlayer) — shared by the brain's fx command and the manual vocal
   * pads. Ducks both decks (see vocal.ts's file header for why both, and why
   * it skips the duck rather than fighting an in-progress transition).
   * recordFxFired() only fires on actual playback success (async — reported
   * via onResult once the fetch/decode resolves). `demonstrate` (manual pad
   * taps only, see handlePlayVocal) also logs a fx-demonstration entry on
   * success — the brain's own fx command (executeFxCommand) leaves it false
   * so brain-fired vocal clips never pollute the human's demonstration log.
   */
  function playVocalCategory(category: VocalCategory, demonstrate = false) {
    vocalPlayerRef.current?.playCategory(category, VOCAL_GROUPS, [deckARef.current.deck, deckBRef.current.deck], {
      isTransitionRunning: () => transitionEngineRef.current.isRunning,
      onResult: (success) => {
        if (success) {
          recordFxFired();
          if (demonstrate) recordFxDemonstration(category);
          recordLedgerFx(category, demonstrate ? "manual" : "brain");
        }
      },
    });
  }

  function executeEqCommand(command: EqCommand) {
    if (migrationRef.current || migrationPreparingRef.current) return;
    const liveLabel = getLiveDeckLabel();
    if (!liveLabel) {
      pushBrainLog("error", "eq: no live deck to adjust");
      return;
    }
    const ctrl = deckByLabel(liveLabel);
    const safeLow = command.low !== undefined ? Math.max(-12, command.low) : undefined;
    const safeMid = command.mid !== undefined ? Math.max(-6, command.mid) : undefined;
    const safeHigh = command.high !== undefined ? Math.max(-6, command.high) : undefined;
    ctrl.deck.setEq({ low: safeLow, mid: safeMid, high: safeHigh });
    if ((safeLow !== undefined && safeLow < 0) || (safeMid !== undefined && safeMid < 0) || (safeHigh !== undefined && safeHigh < 0)) {
      setTimeout(() => {
        ctrl.deck.setEq({ low: 0, mid: 0, high: 0 });
      }, 6000);
    }
  }

  function executeEqSweepCommand(command: EqSweepCommand) {
    const label = getLiveDeckLabel();
    if (!label || queueInFlightRef.current || transitionRunning) return;
    const ctrl = deckByLabel(label), grid = effectiveGrid(ctrl.tags, ctrl.grid);
    if (!grid || grid.estimated || isPartnerDanceTrackName(ctrl.trackName ?? "")) {
      pushBrainLog("eq_sweep", "skipped — needs a real grid and an eligible musical lane");
      return;
    }
    const delay = nextPhraseBoundaries(grid, ctrl.deck.positionSeconds, ctrl.deck.tempo, 2)[0];
    if (delay === undefined || delay > PHRASE_CANDIDATE_CAP_SECONDS) return;
    const ctx = coreRef.current!.ensureContext();
    const currentDb = ctrl.deck.getEq()[command.band];
    const targetDb = command.toDb < 0 ? Math.max(-9, command.toDb) : command.toDb;
    const envelopeValues = targetDb < 0 ? [currentDb, targetDb, 0] : [currentDb, targetDb];
    ctrl.deck.scheduleEqEnvelope(command.band, envelopeValues, command.bars * 240 / (grid.bpm * ctrl.deck.tempo), ctx.currentTime + delay);
    lastPerformanceAtRef.current = Date.now();
    pushBrainLog("eq_sweep", `${command.band} → ${targetDb} dB${targetDb < 0 ? " → 0 dB" : ""} over ${command.bars} bars, on the next phrase`);
  }

  function clearRoutineTimers() {
    for (const timer of routineTimersRef.current) clearTimeout(timer);
    routineTimersRef.current = [];
    if (routineIntervalRef.current) {
      clearInterval(routineIntervalRef.current);
      routineIntervalRef.current = null;
    }
  }

  const [manualLoopLabel, setManualLoopLabel] = useState<string | null>(null);

  function cleanupHeldLoopAndRoutine(reason: string) {
    setManualLoopLabel(null);
    if (!heldLoopRef.current && routineTimersRef.current.length === 0 && !routineIntervalRef.current) return false;
    const handle = heldLoopRef.current;
    heldLoopRef.current = null;
    clearRoutineTimers();
    handle?.stop();
    queueInFlightRef.current = false;
    askedForTrackRef.current = null;
    setTransitionRunning(false);
    deckA.deck.unduck(HELD_LOOP_DUCK_RAMP_SECONDS);
    deckB.deck.unduck(HELD_LOOP_DUCK_RAMP_SECONDS);
    // A manual pause can arrive after the AudioContext handoff envelopes have
    // started. Supersede both schedules now, then give the surviving deck
    // explicit crossfader ownership so React cannot reapply a stale midpoint.
    const deckAStillPlaying = deckA.deck.playing;
    const deckBStillPlaying = deckB.deck.playing;
    deckA.deck.setGain(1);
    deckB.deck.setGain(1);
    if (deckAStillPlaying && !deckBStillPlaying) setCrossfade(0);
    else if (deckBStillPlaying && !deckAStillPlaying) setCrossfade(1);
    deckA.deck.setEq({ low: 0, mid: 0, high: 0 });
    deckB.deck.setEq({ low: 0, mid: 0, high: 0 });
    deckA.deck.filterRelease(0.05);
    deckA.deck.reverbWash(0, 0.05);
    deckB.deck.filterRelease(0.05);
    deckB.deck.reverbWash(0, 0.05);
    cancelFollowUp();
    pushBrainLog("loop", reason);
    return true;
  }

  /**
   * M7 Phase 3 — the band-isolated HELD loop, fired by El Cerebro himself.
   *
   * Grid-truth (GOAL-M7.md PRINCIPLE 4): planHeldLoop returns null without a
   * real BeatGrid and this refuses rather than falling back to an unsnapped
   * hold — a hold that isn't on the grid can't exit on the "1", which is the
   * whole point of the move.
   *
   * Uses the loop-points.json candidate for this track when there is one, so
   * the bars being held are the song's actual recurring hook rather than
   * whatever four bars happen to be under the playhead (the owner's core
   * correction, 2026-07-30: a filter strip on arbitrary bars sounds thin).
   * Falls back to the current position when the track has no candidate.
   */
  async function executeLoopCommand(command: LoopCommand, cooldownReason: ConsultReason) {
    if (migrationRef.current || migrationPreparingRef.current) return;
    const controlVersion = performanceControlVersionRef.current;
    const liveLabel = getLiveDeckLabel();
    if (!liveLabel) {
      pushBrainLog("error", "loop: no live deck to hold");
      return;
    }
    if (transitionEngineRef.current.isRunning) {
      pushBrainLog("loop", "skipped — a transition is currently in progress");
      return;
    }
    if (heldLoopRef.current) {
      pushBrainLog("loop", "skipped — a held loop is already running");
      return;
    }
    // Same class-aware cadence gate as executeFxCommand: a hold is a
    // performance move, so it answers to the loose floor, not the stinger cap.
    if (!isHumanInitiated(cooldownReason)) {
      const secondsAgo = lastPerformanceAtRef.current === null ? null : (Date.now() - lastPerformanceAtRef.current) / 1000;
      if (secondsAgo !== null && secondsAgo < AUTOPILOT_PERFORMANCE_COOLDOWN_SECONDS) {
        pushBrainLog("loop", `skipped — performance cooldown floor (${secondsAgo.toFixed(0)}s < ${AUTOPILOT_PERFORMANCE_COOLDOWN_SECONDS}s)`);
        return;
      }
    }

    const liveCtrl = deckByLabel(liveLabel);
    const liveTrackId = liveCtrl.trackId;
    // An ESTIMATED (anchor-0, tag-BPM) grid is explicitly not good enough
    // here: a hold that isn't on the real grid can't exit on the "1".
    const grid = effectiveGrid(liveCtrl.tags, liveCtrl.grid);
    if (!grid || grid.estimated) {
      pushBrainLog("loop", "skipped — no real BeatGrid on the live track (never an unsnapped hold)");
      return;
    }

    // Prefer the precomputed recurring-pattern range for this track.
    // When transitioning near the end of a track, also allow sampling the
    // track's strongest earlier vocal-free hook (e.g. a 1:07–1:22 horn + bassline
    // break), or a stem-isolated hook when separated stems strip out vocals.
    const entry = getLoopPoints(CURRENT_LOOP_POINTS, cueKeyForLabel(liveLabel) ?? "");
    const candidate =
      pickLoopCandidate(entry, {
        fromSeconds: liveCtrl.deck.positionSeconds,
        requireVocalFree: true,
        isolation: command.isolation,
      }) ??
      pickLoopCandidate(entry, {
        fromSeconds: 0,
        requireVocalFree: true,
        isolation: command.isolation,
      }) ??
      pickLoopCandidate(entry, {
        fromSeconds: 0,
        requireVocalFree: true,
      }) ??
      (stemEntryFor(liveTrackId)
        ? pickLoopCandidate(entry, {
            fromSeconds: 0,
            requireVocalFree: false,
            isolation: command.isolation,
          }) ??
          pickLoopCandidate(entry, {
            fromSeconds: 0,
            requireVocalFree: false,
          })
        : null);
    const fromSeconds = candidate ? candidate.startSeconds : liveCtrl.deck.positionSeconds;
    const halvingStages = command.halvings ?? 0;

    const plan = planHeldLoop(grid, fromSeconds, liveCtrl.deck.tempo, {
      captureBars: command.captureBars ?? (candidate ? candidate.lengthBars : 4),
      targetHoldSeconds: Math.min(20, command.holdSeconds ?? 12), // owner: bare loop max ~15-20s, never 30
      halvingStages,
      isolation: command.isolation ?? candidate?.isolation ?? "beat",
      peakRate: halvingStages > 1 ? 1.04 : 1.0,
      // Loop-covered tempo sweep: ride the loop from this track's own tempo
      // to the incoming track's, so the incoming deck enters unclamped.
      resolveToRate: command.sweepToBpm ? command.sweepToBpm / grid.bpm : undefined,
    });
    if (!plan) {
      pushBrainLog("loop", "skipped — the held-loop planner refused (no usable grid)");
      return;
    }

    const stemSource = candidate?.vocalFree
      ? null
      : await loadStemBufferForLoop(
          liveTrackId,
          plan.isolation,
          plan.loopStart,
          plan.loopEnd
        );
    if (
      controlVersion !== performanceControlVersionRef.current ||
      !liveCtrl.deck.playing ||
      liveCtrl.trackId !== liveTrackId ||
      heldLoopRef.current ||
      transitionEngineRef.current.isRunning ||
      migrationRef.current
    ) {
      return;
    }

    // Duck the deck for the hold's duration: the captured slice IS the mix
    // while it runs. Deliberately duck rather than pause, matching roll.ts's
    // and scratch.ts's established overlay pattern, so nothing in the deck's
    // own state machine has to be unwound on exit.
    liveCtrl.deck.duck(HELD_LOOP_DUCK_DB, HELD_LOOP_DUCK_RAMP_SECONDS);
    const handle = fireIsolatedLoopHold(
      liveCtrl.deck,
      coreRef.current!,
      plan,
      () => {
        heldLoopRef.current = null;
        liveCtrl.deck.unduck(HELD_LOOP_DUCK_RAMP_SECONDS);
      },
      0,
      stemSource
    );
    if (!handle) {
      liveCtrl.deck.unduck(HELD_LOOP_DUCK_RAMP_SECONDS);
      pushBrainLog("loop", "skipped — nothing decoded to loop yet");
      return;
    }
    heldLoopRef.current = handle;
    recordFxFired(true);
    recordLedgerFx("loop_hold", "brain");

    // M7 Phase 3, "make performance sequences expressible". One command per
    // consult cannot carry "hold, then drop back in on the 1", and asking the
    // model to compute the right followUpSeconds for a quantized hold it
    // can't see the length of is exactly the kind of timing that drifts. The
    // app knows the hold's real duration, so it books the return consult
    // itself, landing HELD_LOOP_HANDOFF_LEAD_SECONDS before the exit — early
    // enough to pick, download and decode the incoming track so it can land
    // on the "1" the hold resolves to. Any followUpSeconds the model also set
    // is superseded (scheduleFollowUp is a single latest-wins slot), which is
    // the intended precedence: the app's measured timing beats a guess.
    scheduleFollowUp(
      Math.max(5, plan.totalDurationSeconds - HELD_LOOP_HANDOFF_LEAD_SECONDS),
      cooldownReason
    );
    pushBrainLog(
      "loop",
      `held ${plan.captureBeats / 4} bar(s) @${plan.loopStart.toFixed(1)}s, ${plan.isolation} mode${stemSource ? " (isolated stems)" : ""}, ${plan.totalDurationSeconds.toFixed(1)}s (${plan.totalBeats / 16} phrases), exits at ${plan.exitBpm.toFixed(1)} BPM${candidate ? " — recurring-pattern range" : " — current position (no candidate)"}`
    );
  }

  /** Phrase-aligned firing (Part 2): cancels any pending phrase-delayed transition start — a new queue command superseding it, or the user manually intervening (pause on either deck — see useDeckController's onManualPause). Single slot, latest/only-one wins. Logs a line when it actually had something to cancel (choir round #2, P1 — "make every cancelation log a line to the brain log"). */
  // --- M8.2: stem migration (the real club transition) ---
  // Two stem sets live at once during a migration; refs so a later command can
  // tear them down. Only one migration runs at a time.
  const migrationRef = useRef<{ out: StemSet; inc: StemSet; endsAt: number; cancel: () => void } | null>(null);
  const migrationPreparingRef = useRef<AbortController | null>(null);
  const stemLoopCacheRef = useRef<Map<string, LoopHoldStemSource>>(new Map());

  function stemEntryFor(trackId: string | null | undefined): StemManifestEntry | null {
    if (!trackId) return null;
    const entry = (STEM_MANIFEST as Record<string, StemManifestEntry>)[trackId];
    // Only usable once the stems are on Drive (ids, not local paths). A local
    // relative path means the batch ran but the upload has not — refuse cleanly.
    return usableStemEntry(entry);
  }

  async function loadStemBufferForLoop(
    trackId: string | null | undefined,
    isolation: "beat" | "melody",
    fromSeconds: number,
    toSeconds: number
  ): Promise<LoopHoldStemSource | null> {
    const entry = stemEntryFor(trackId);
    const core = coreRef.current;
    if (!trackId || !entry || !core) return null;
    const cacheKey = `${trackId}:${isolation}:${Math.floor(fromSeconds)}:${Math.ceil(toSeconds)}`;
    const cached = stemLoopCacheRef.current.get(cacheKey);
    if (cached) return cached;
    const manifestEntry = (crateManifestJson as CrateManifestEntry[]).find((t) => t.id === trackId);
    const aborter = new AbortController();
    const timer = setTimeout(() => aborter.abort(), 12000);
    try {
      const fetchBytes = async (id: string) => {
        const blob = await getTrackBlob(
          id,
          async () => {
            const asset = resolveAudioAssetUrl(id);
            const response = await fetchWithPasscode(asset.url, { signal: aborter.signal });
            if (!response.ok) throw new Error(`stem download HTTP ${response.status}`);
            return response.blob();
          },
          { store: trackCacheStoreRef.current }
        );
        aborter.signal.throwIfAborted();
        return blob.arrayBuffer();
      };
      const source = await loadStemLoopMixBuffer(core, entry, fetchBytes, {
        isolation,
        fromSeconds: Math.max(0, fromSeconds - 0.5),
        toSeconds: toSeconds + 0.5,
        expectedTrackDuration: manifestEntry?.durationSeconds ?? undefined,
        signal: aborter.signal,
      });
      if (source) {
        if (stemLoopCacheRef.current.size >= 8) {
          const oldest = stemLoopCacheRef.current.keys().next().value;
          if (oldest) stemLoopCacheRef.current.delete(oldest);
        }
        stemLoopCacheRef.current.set(cacheKey, source);
      }
      return source;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * M8.2i — where the BEAT is in, from the drums stem (scripts/make-beat-in.mjs), in
   * the same timeline as the audio the app plays. Null when unknown or when the beat is
   * in from the start. This is what startAt:"auto" should prefer over the loudness
   * mixIn: a sung intro is loud, and loudness cannot tell a voice from a kick.
   */
  function beatInFor(trackId: string | null | undefined): number | null {
    if (!trackId) return null;
    const e = (BEAT_IN as Record<string, { beatInSeconds: number | null }>)[trackId];
    const v = e?.beatInSeconds ?? null;
    return typeof v === "number" && v >= 1 ? v : null;
  }

  function midTrackEntryFor(item: CrateTrack, maxEntrySeconds = 85, preferBeats: 16 | 32 = 16): { seconds: number; reason: string } | null {
    const loopEntry = getLoopPoints(
      CURRENT_LOOP_POINTS,
      cueTrackKey({ source: item.source, id: item.id, name: item.name, size: item.size })
    );
    const minEntry = isPartnerDanceTrackName(item.name) ? 0 : 18;
    return selectMidTrackEntryPoint(loopEntry, {
      minEntrySeconds: minEntry,
      maxEntrySeconds,
      preferBeats,
      beatInSeconds: beatInFor(item.id),
    });
  }

  function mashupEntryFor(item: CrateTrack, migrationBars = 16): { seconds: number; reason: string } | null {
    const loopEntry = getLoopPoints(
      CURRENT_LOOP_POINTS,
      cueTrackKey({ source: item.source, id: item.id, name: item.name, size: item.size })
    );
    return selectMashupEntryPoint(loopEntry, {
      migrationBars,
      minEntrySeconds: migrationBars >= 32 ? 14 : 28,
      maxEntrySeconds: migrationBars >= 32 ? 56 : 110,
      beatInSeconds: beatInFor(item.id),
    });
  }

  function teardownMigration() {
    migrationPreparingRef.current?.abort();
    migrationPreparingRef.current = null;
    const m = migrationRef.current;
    migrationRef.current = null;
    m?.cancel();
  }

  /** Prepared performance; all audible handoffs are scheduled before the first fade. */
  async function executeStemMigrateCommand(command: StemMigrateCommand | TranceBreakdownCommand, cooldownReason: ConsultReason) {
    const controlVersion = performanceControlVersionRef.current;
    const action = command.action;
    const liveLabel = getLiveDeckLabel();
    if (!liveLabel || queueInFlightRef.current || transitionEngineRef.current.isRunning || heldLoopRef.current || migrationRef.current || migrationPreparingRef.current) {
      pushBrainLog(action, "skipped — no free live performance slot");
      return;
    }
    if (!isHumanInitiated(cooldownReason) && !performanceMoveReady()) return;
    const liveCtrl = deckByLabel(liveLabel);
    const item = resolveCommandTrack(command.trackId);
    const refuse = (reason: string) => {
      pushBrainLog(action, `skipped — ${reason}; current track kept playing`);
      askedForTrackRef.current = null;
      // For autopilot-initiated moves, fall back to a clean handoff so autopilot
      // does not stall; for explicit human mashup button clicks, do not silently
      // replace a requested stem mashup with a 4-bar bass_swap.
      if (isHumanInitiated(cooldownReason)) return;
      queueMicrotask(() => {
        if (!item || item.id === liveCtrl.trackId || controlVersion !== performanceControlVersionRef.current || !liveCtrl.deck.playing || queueInFlightRef.current || migrationPreparingRef.current) return;
        pushBrainLog("recovery", `${action} did not run — preparing an ordinary handoff to ${musicLabel(item)}; this is not a stem mix`);
        const fallback = queueForResidency({ action: "queue", trackId: command.trackId,
          transition: isPartnerDanceTrack(item) && !performanceMixRef.current ? "gap" : "bass_swap", durationBars: 4, startAt: "auto" },
          residencyRequestRef.current?.seconds ?? null, liveCtrl.tags.bpm ?? null, liveCtrl.deck.tempo, item.bpm);
        void executeQueueCommand(fallback, !isHumanInitiated(cooldownReason));
      });
    };
    if (!item || item.id === liveCtrl.trackId) { refuse("target is missing or already live"); return; }
    if (!performanceMixRef.current && !isHumanInitiated(cooldownReason) && (isPartnerDanceTrack(crateRef.current.find(t => t.id === liveCtrl.trackId) ?? { name: liveCtrl.trackName ?? "" }) || isPartnerDanceTrack(item))) {
      refuse("partner-dance tracks keep their full-song clean ending"); return;
    }
    const outEntry = stemEntryFor(liveCtrl.trackId), inEntry = stemEntryFor(item.id);
    const liveGrid = effectiveGrid(liveCtrl.tags, liveCtrl.grid);
    const inGrid = (crateManifestJson as CrateManifestEntry[]).find(t => t.id === item.id)?.grid ?? item.grid;
    if (!outEntry || !inEntry || !liveGrid || liveGrid.estimated || !inGrid) { refuse("both tracks need prepared stems and real BeatGrids"); return; }
    if (liveCtrl.grid?.markers.some(m => typeof m.bpm === "number" && Math.abs(m.bpm - liveGrid.bpm) > 0.1) || inGrid.markers.some(m => typeof m.bpm === "number" && Math.abs(m.bpm - inGrid.bpm) > 0.1)) { refuse("variable-tempo grids need a different transition"); return; }
    const rate = liveCtrl.deck.tempo, outgoingId = liveCtrl.trackId;
    const effectiveBpm = liveGrid.bpm * rate, incomingRate = effectiveBpm / inGrid.bpm;
    // Allow up to ±6% incoming rate (around ±1 semitone) and ±8% live rate so
    // club-range BPM neighbors (e.g. 92 -> 96 BPM or 124 -> 128 BPM) can stem_migrate.
    if (Math.abs(incomingRate - 1) > 0.06 || Math.abs(rate - 1) > 0.08) { refuse("stem tempo would change pitch too far; use a normal key-locked blend"); return; }
    const breakdown = command.action === "trance_breakdown";
    const loopEntry = CURRENT_LOOP_POINTS[cueTrackKey({ source: item.source, id: item.id, name: item.name, size: item.size })];
    if (breakdown && (!isTranceTrackName(liveCtrl.trackName ?? "") || !isTranceTrackName(item.name) || !loopEntry?.drops.some(d => Math.abs(d.atSeconds - command.dropSeconds) < 0.05))) {
      refuse("trance breakdown requires two eligible trance tracks and a current analyzed drop cue"); return;
    }
    stopStemMixerRef.current?.();
    const core = coreRef.current!, ctx = core.ensureContext();
    const idleLabel: DeckLabel = liveLabel === "A" ? "B" : "A";
    const idleCtrl = deckByLabel(idleLabel);
    if (idleCtrl.deck.playing) {
      // If the idle deck was left playing from an interrupted transition, stop it cleanly instead of stranding both decks!
      idleCtrl.deck.pause();
      idleCtrl.markPaused();
      idleCtrl.deck.allNeutral();
      idleCtrl.deck.clearAllDucks();
    }
    cancelTempoGlide();
    const originalGain = liveCtrl.deck.gain;
    const originalEq = liveCtrl.deck.getEq();
    const aborter = new AbortController();
    migrationPreparingRef.current = aborter;
    queueInFlightRef.current = true;
    queueInFlightSinceRef.current = Date.now();
    const deadline = setTimeout(() => aborter.abort(new Error("stem preparation timed out")), STEM_PREPARE_SECONDS * 1000);
    let outSet: StemSet | null = null, inSet: StemSet | null = null;
    let committed = false;
    const check = () => {
      aborter.signal.throwIfAborted();
      if (!liveCtrl.deck.playing || deckByLabel(liveLabel).trackId !== outgoingId || Math.abs(liveCtrl.deck.tempo - rate) > 1e-6) throw new Error("live playback changed during preparation");
    };
    try {
      const fetchBytes = async (id: string) => {
        const stemBlob = await getTrackBlob(id, async () => {
          const asset = resolveAudioAssetUrl(id);
          const response = await fetchWithPasscode(asset.url, { signal: aborter.signal });
          if (!response.ok) throw new Error(`stem download HTTP ${response.status}`);
          return response.blob();
        }, { store: trackCacheStoreRef.current });
        aborter.signal.throwIfAborted();
        return stemBlob.arrayBuffer();
      };
      // Warm stem blobs into IndexedDB/memory cache in parallel with the full track download.
      for (const stemId of [...Object.values(outEntry.stems), ...Object.values(inEntry.stems)]) {
        if (stemId) void fetchBytes(stemId).catch(() => {});
      }
      pushBrainLog(action, `preparing ${command.bars >= 32 ? `Full-Song Mashup (${command.bars} bars)` : `${command.bars}-bar stem mashup`} for "${item.name}"…`);
      const blob = await abortable(getTrackForPlayback(item, aborter.signal), aborter.signal);
      check();
      await idleCtrl.loadFile(blob, item.name, item.id, item.source);
      if (!await abortable(idleCtrl.decodeIfNeeded(aborter.signal), aborter.signal)) throw new Error("incoming full-track decode failed");
      check();
      idleCtrl.setTempoDirectly(incomingRate);

      // Now that idleCtrl.deck is decoded, we have the exact incoming audio duration!
      const knownInDuration = idleCtrl.deck.duration > 0
        ? idleCtrl.deck.duration
        : (loopEntry?.durationSeconds ?? (crateManifestJson as CrateManifestEntry[]).find(t => t.id === item.id)?.durationSeconds ?? null);
      let migBars = command.bars;
      const requestedBars = command.bars;
      let stemBeatIn = mashupEntryFor(item, migBars)?.seconds ?? midTrackEntryFor(item, migBars >= 32 ? 55 : 95, 32)?.seconds ?? beatInFor(item.id) ?? 0;
      const sourceBarIn = 240 / inGrid.bpm;
      const snappedEntryFor = (cueSec: number) =>
        inGrid.anchor + Math.max(0, Math.ceil((Math.max(0, cueSec, inGrid.anchor) - inGrid.anchor) / sourceBarIn - 1e-7)) * sourceBarIn;
      const fitsIncoming = (cueSec: number, barsToTest: number) => {
        if (!knownInDuration) return true;
        const entrySec = snappedEntryFor(cueSec);
        const neededSec = ((barsToTest * 240) / effectiveBpm + STEM_TAIL_SECONDS + 1.5) * incomingRate;
        return entrySec + neededSec < knownInDuration;
      };
      if (knownInDuration && !breakdown) {
        if (!fitsIncoming(stemBeatIn, migBars)) {
          // Prefer moving the incoming entry earlier (down to beatIn or the first grid bar) so all 64 bars fit!
          const maxEntry = Math.max(inGrid.anchor, knownInDuration - ((migBars * 240) / effectiveBpm + STEM_TAIL_SECONDS + 2.5) * incomingRate - sourceBarIn);
          const candidateCue = Math.max(inGrid.anchor, Math.min(beatInFor(item.id) ?? inGrid.anchor, maxEntry));
          if (fitsIncoming(candidateCue, migBars)) {
            stemBeatIn = candidateCue;
          } else if (fitsIncoming(inGrid.anchor, migBars)) {
            stemBeatIn = inGrid.anchor;
          } else {
            stemBeatIn = inGrid.anchor;
            while (migBars > 8 && !fitsIncoming(stemBeatIn, migBars)) {
              migBars = migBars > 56 ? 56 : migBars > 48 ? 48 : migBars > 40 ? 40 : migBars > 32 ? 32 : migBars > 24 ? 24 : migBars > 16 ? 16 : 8;
            }
            if (migBars < requestedBars) {
              pushBrainLog(action, `fitted mashup to ${migBars} bars (full available length of "${item.name}")`);
            }
          }
        }
      }
      const anchorLoopBars = migBars >= 16 ? 8 : 4;
      const isOutLoopingMashup = !breakdown && command.anchor === "out";
      const outLoopSpanSource = anchorLoopBars * (240 / liveGrid.bpm);
      // When outgoing drums/bass/harmony loop over 8 bars, we only need 10 bars of outgoing audio after the phrase start!
      const outActiveBars = isOutLoopingMashup ? Math.min(migBars, migBars >= 32 ? 10 : Math.max(10, Math.ceil(migBars * 0.35))) : migBars;
      const outActiveDuration = outActiveBars * (240 / effectiveBpm);
      let outBasePos = liveCtrl.deck.positionSeconds;
      const knownOutDuration = liveCtrl.deck.duration > 0 ? liveCtrl.deck.duration : ((crateManifestJson as CrateManifestEntry[]).find(t => t.id === outgoingId)?.durationSeconds ?? 180);
      const outWindowNeededSource = (28 + outActiveDuration + 6) * rate;
      if (isOutLoopingMashup && outBasePos + outWindowNeededSource >= knownOutDuration && outLoopSpanSource > 1) {
        const shortfall = outBasePos + outWindowNeededSource - Math.max(30, knownOutDuration - 4);
        const shiftLoops = Math.max(1, Math.ceil(shortfall / outLoopSpanSource));
        outBasePos = Math.max(liveGrid.anchor, outBasePos - shiftLoops * outLoopSpanSource);
      }
      const initial = stemClock({ now: ctx.currentTime, delay: 0, outgoingPosition: outBasePos, outgoingRate: rate, outgoingBpm: liveGrid.bpm, incomingBpm: inGrid.bpm, incomingAnchor: inGrid.anchor, beatIn: stemBeatIn, bars: migBars, ...(breakdown ? { dropSeconds: command.dropSeconds } : {}) });
      const windowStart = Math.max(0, Math.min(outBasePos, liveCtrl.deck.positionSeconds) - 1);
      outSet = await abortable(loadStemSet(core, outgoingId!, outEntry, fetchBytes, { signal: aborter.signal, fromSeconds: windowStart, toSeconds: windowStart + Math.max(outWindowNeededSource, (STEM_PREPARE_SECONDS + outActiveDuration + 6) * rate), maxDecodedBytes: STEM_MEMORY_BYTES }), aborter.signal);
      check();
      inSet = await abortable(loadStemSet(core, item.id, inEntry, fetchBytes, { signal: aborter.signal, fromSeconds: Math.max(0, initial.incomingOffset - 1), toSeconds: initial.incomingOffset + (initial.duration + STEM_TAIL_SECONDS + 6) * incomingRate, maxDecodedBytes: STEM_MEMORY_BYTES }), aborter.signal);
      check();
      if (deckByLabel(idleLabel).trackId !== item.id) throw new Error("incoming deck changed during preparation");
      const boundaries = nextPhraseBoundaries(liveGrid, liveCtrl.deck.positionSeconds, rate, 3);
      const delay = boundaries.find(d => d >= 0.4 && d <= PHRASE_CANDIDATE_CAP_SECONDS) ?? boundaries.find(d => d >= 0.25) ?? 0.5;
      let livePosForClock = liveCtrl.deck.positionSeconds;
      const outMinBufDuration = Math.min(...Array.from(outSet.stems.values()).map(st => st.buffer.duration));
      const outCheckLen = (outActiveDuration + 0.2) * rate;
      if (isOutLoopingMashup && livePosForClock + delay * rate + outCheckLen > outSet.bufferOffset + outMinBufDuration && outLoopSpanSource > 1) {
        const excess = (livePosForClock + delay * rate + outCheckLen) - (outSet.bufferOffset + outMinBufDuration - 0.2);
        const shiftLoops = Math.max(1, Math.ceil(excess / outLoopSpanSource));
        livePosForClock = Math.max(outSet.bufferOffset, livePosForClock - shiftLoops * outLoopSpanSource);
        if (livePosForClock + delay * rate + outCheckLen > outSet.bufferOffset + outMinBufDuration) {
          livePosForClock = Math.max(outSet.bufferOffset, outSet.bufferOffset + outMinBufDuration - outCheckLen - delay * rate - 0.1);
        }
      }
      const clock = stemClock({ now: ctx.currentTime, delay, outgoingPosition: livePosForClock, outgoingRate: rate, outgoingBpm: liveGrid.bpm, incomingBpm: inGrid.bpm, incomingAnchor: inGrid.anchor, beatIn: stemBeatIn, bars: migBars, ...(breakdown ? { dropSeconds: command.dropSeconds } : {}) });
      const covers = (set: StemSet, offset: number, length: number) => offset >= set.bufferOffset - 1e-3 && Array.from(set.stems.values()).every(st => offset + length <= set.bufferOffset + st.buffer.duration + 0.05);
      if (!covers(outSet, clock.outgoingOffset, outCheckLen) || !covers(inSet, clock.incomingOffset, (clock.duration + 0.1) * incomingRate) || clock.incomingOffset + (clock.duration + 0.25) * incomingRate >= idleCtrl.deck.duration) throw new Error("not enough prepared audio for this many bars");
      if (breakdown) {
        // An intentional bass gap must retain audible melodic material. Check the
        // retained incoming harmony in one-second windows; unknown/quiet is refused.
        const harmony = Array.from(inSet.stems.values()).filter(st => ["other", "guitar", "piano"].includes(st.name));
        for (let second = 2; second < clock.duration - 1; second++) {
          const audible = harmony.some(st => {
            const data = st.buffer.getChannelData(0), start = Math.floor(second * incomingRate * st.buffer.sampleRate);
            const end = Math.min(data.length, start + st.buffer.sampleRate);
            let sum = 0, n = 0;
            for (let i = start; i < end; i += 32) { sum += data[i] * data[i]; n++; }
            return n > 0 && Math.sqrt(sum / n) > 0.001;
          });
          if (!audible) throw new Error("incoming breakdown has an unverified melodic gap");
        }
      }
      const plan = breakdown
        ? planTranceBreakdown(Object.keys(outEntry.stems), Object.keys(inEntry.stems), effectiveBpm, migBars)
        : migBars >= 32
          ? planFullSongMashup({ outgoingStems: Object.keys(outEntry.stems), incomingStems: Object.keys(inEntry.stems), bpm: effectiveBpm, totalBars: migBars, anchor: command.anchor })
          : planStemMigration({ outgoingStems: Object.keys(outEntry.stems), incomingStems: Object.keys(inEntry.stems), bpm: effectiveBpm, totalBars: migBars as 8 | 16 | 32, anchor: command.anchor });
      if (plan.warnings.some(w => w.includes("BASS DROPS TO ZERO"))) throw new Error("no continuous bass carrier for this migration");
      for (const warning of plan.warnings) pushBrainLog(action, warning);
      const outgoing = outSet, incoming = inSet;
      if (Object.values(originalEq).some(db => Math.abs(db) > 0.1)) {
        liveCtrl.deck.setEq({ low: 0, mid: 0, high: 0 });
      }
      liveCtrl.deck.allNeutral();
      idleCtrl.deck.allNeutral();
      idleCtrl.deck.setGain(0);
      // Reserve the full-mix return FIRST. Failure cannot mute the live track.
      idleCtrl.deck.scheduleBufferPlayback(clock.endsAt, clock.incomingOffset + clock.duration * incomingRate, incomingRate);
      startStemSet(core, outgoing, {
        when: clock.startTime,
        offsetSeconds: clock.outgoingOffset,
        playbackRate: rate,
        loopRhythmSeconds: !breakdown && command.anchor === "out" ? anchorLoopBars * plan.barSeconds * rate : undefined,
      });
      startStemSet(core, incoming, {
        when: clock.startTime,
        offsetSeconds: clock.incomingOffset,
        playbackRate: incomingRate,
        loopRhythmSeconds: !breakdown && command.anchor === "in" ? anchorLoopBars * plan.barSeconds * incomingRate : undefined,
      });
      for (const stem of Array.from(incoming.stems.values())) stem.gain.gain.setValueAtTime(0, clock.startTime);
      scheduleMigration(ctx, plan, outgoing, incoming, clock.startTime);
      const mashupTrim = 0.78;
      const resolveStart = Math.max(clock.startTime + 0.02, clock.endsAt - Math.min(4, migBars * 0.25) * plan.barSeconds);
      outgoing.setGain.gain.cancelScheduledValues(clock.startTime);
      outgoing.setGain.gain.setValueAtTime(0, clock.startTime);
      outgoing.setGain.gain.linearRampToValueAtTime(originalGain * mashupTrim, clock.startTime + 0.015);
      outgoing.setGain.gain.setValueAtTime(originalGain * mashupTrim, clock.endsAt);
      outgoing.setGain.gain.linearRampToValueAtTime(0, clock.endsAt + STEM_HANDOFF_SECONDS);
      liveCtrl.deck.scheduleGainEnvelope([originalGain, 0], 0.015, clock.startTime);
      incoming.setGain.gain.cancelScheduledValues(clock.startTime);
      incoming.setGain.gain.setValueAtTime(0, clock.startTime);
      incoming.setGain.gain.linearRampToValueAtTime(mashupTrim, clock.startTime + 0.015);
      incoming.setGain.gain.setValueAtTime(mashupTrim, resolveStart);
      incoming.setGain.gain.linearRampToValueAtTime(0.95, clock.endsAt);
      incoming.setGain.gain.linearRampToValueAtTime(0, clock.endsAt + STEM_HANDOFF_SECONDS);
      idleCtrl.deck.scheduleGainEnvelope([0, 1], STEM_HANDOFF_SECONDS, clock.endsAt);
      for (const set of [outgoing, incoming]) for (const stem of Array.from(set.stems.values())) stem.source?.stop(clock.endsAt + STEM_HANDOFF_SECONDS + 0.02);
      setTransitionRunning(true);
      lastPerformanceAtRef.current = Date.now();
      let timer: ReturnType<typeof setTimeout>;
      const cancel = () => {
        clearTimeout(timer);
        clearInterval(monitor);
        idleCtrl.deck.pause(); idleCtrl.markPaused();
        liveCtrl.deck.setEq(originalEq);
        liveCtrl.deck.setGain(originalGain);
        const cancelNow = ctx.currentTime;
        for (const set of [outgoing, incoming]) {
          try {
            const p = set.setGain.gain;
            if (typeof p.cancelAndHoldAtTime === "function") p.cancelAndHoldAtTime(cancelNow);
            else { const cur = p.value; p.cancelScheduledValues(cancelNow); p.setValueAtTime(cur, cancelNow); }
            p.linearRampToValueAtTime(0, cancelNow + 0.020);
          } catch { /* ignore */ }
        }
        setTimeout(() => {
          disposeStemSet(outgoing);
          disposeStemSet(incoming);
        }, 30);
        queueInFlightRef.current = false;
        queueInFlightSinceRef.current = null;
        askedForTrackRef.current = null;
        setCrossfade(liveLabel === "A" ? 0 : 1);
        setTransitionRunning(false);
      };
      migrationRef.current = { out: outgoing, inc: incoming, endsAt: clock.endsAt, cancel };
      committed = true;
      const monitor = setInterval(() => {
        if (ctx.currentTime < clock.endsAt && (deckByLabel(liveLabel).trackId !== outgoingId || deckByLabel(idleLabel).trackId !== item.id || Math.abs(liveCtrl.deck.tempo - rate) > 1e-6 || idleCtrl.deck.scheduledPlaybackTime !== clock.endsAt)) {
          teardownMigration();
          pushBrainLog(action, "canceled — manual transport changed during the performance");
        }
      }, 100);
      const finish = () => {
        if (migrationRef.current?.out !== outgoing) return;
        // UI callbacks may wake early while AudioContext is suspended. Wait for
        // audio time; the actual full-mix source already owns the scheduled return.
        if (ctx.currentTime < clock.endsAt + STEM_HANDOFF_SECONDS) {
          timer = setTimeout(finish, 100); return;
        }
        migrationRef.current = null;
        clearInterval(monitor);
        disposeStemSet(outgoing); disposeStemSet(incoming);
        liveCtrl.deck.pause(); liveCtrl.markPaused();
        liveCtrl.deck.setGain(1);
        if (idleCtrl.deck.playing) {
          idleCtrl.markPlaying();
          startTempoGlide(idleLabel);
        }
        setCrossfade(idleLabel === "A" ? 0 : 1);
        setTransitionRunning(false);
        queueInFlightRef.current = false;
        queueInFlightSinceRef.current = null;
        askedForTrackRef.current = null;
        appendHistory({ trackId: item.id, name: item.name });
        setTransitionRecords(appendTransitionRecord({
          when: Date.now(), fromTrack: liveCtrl.trackName ?? outgoingId ?? "unknown", toTrack: item.name,
          bpmFrom: liveGrid.bpm, bpmTo: inGrid.bpm, clamped: false, degraded: false,
          transitionType: action, durationBars: migBars, rating: null,
          note: `Prepared ${action} (${migBars} bars); incoming cue ${clock.incomingOffset.toFixed(2)}s; rate ${incomingRate.toFixed(5)}`,
          outPositionSeconds: clock.outgoingOffset,
        }));
        pushBrainLog(action, `completed on the audio clock — "${item.name}"${idleCtrl.deck.playing ? " is live" : " finished while the tab was inactive"}`);
        if (autopilotRef.current && residencyRequestRef.current === null) {
          scheduleFollowUp(2, cooldownReason);
        }
      };
      timer = setTimeout(finish, Math.max(0, (clock.endsAt + STEM_HANDOFF_SECONDS - ctx.currentTime) * 1000));
      pushBrainLog(action, `scheduled ${migBars} bars into "${item.name}", source cue ${clock.incomingOffset.toFixed(2)}s; full-track return prepared`);
    } catch (error) {
      if (!committed) {
        aborter.abort(error); // also cancel prefetched compressed stem files
        if (outSet) disposeStemSet(outSet);
        if (inSet) disposeStemSet(inSet);
        idleCtrl.deck.pause(); idleCtrl.markPaused();
        liveCtrl.deck.setEq(originalEq);
        liveCtrl.deck.setGain(originalGain);
        refuse(error instanceof Error ? error.message : "preparation failed");
      }
    } finally {
      clearTimeout(deadline);
      if (migrationPreparingRef.current === aborter) {
        migrationPreparingRef.current = null;
        if (!committed) {
          queueInFlightRef.current = false;
          queueInFlightSinceRef.current = null;
        }
      }
    }
  }

  async function executeRoutineCommand(command: RoutineCommand, cooldownReason: ConsultReason) {
    if (command.routine !== "sample_mix") return;
    stopStemMixerRef.current?.();
    const controlVersion = performanceControlVersionRef.current;
    const originalLiveLabel = getLiveDeckLabel();
    const originalLiveId = originalLiveLabel ? deckByLabel(originalLiveLabel).trackId : null;
    const releaseAutopilotAskOnFailure = (recover = true) => {
      if (!isHumanInitiated(cooldownReason)) askedForTrackRef.current = null;
      if (!recover || controlVersion !== performanceControlVersionRef.current || queueInFlightRef.current ||
          transitionEngineRef.current.isRunning || heldLoopRef.current || migrationRef.current) return;
      const currentLabel = getLiveDeckLabel();
      const current = currentLabel ? deckByLabel(currentLabel) : null;
      if (current && current.trackId !== originalLiveId) return;
      const target = resolveCommandTrack(command.queue.trackId);
      if (!target || target.id === current?.trackId) return;
      cancelFollowUp();
      const partnerDance = isPartnerDanceTrackName(current?.trackName ?? "") || isPartnerDanceTrackName(target.name);
      const transition = partnerDance ? "gap" : current?.tags.bpm && target.bpm ? "bass_swap" : "cut";
      pushBrainLog("recovery", `sample_mix did not run — using ${transition} into "${target.name}" instead; this is not a loop`);
      void executeQueueCommand({ action: "queue", trackId: command.queue.trackId, transition,
        durationBars: 4, startAt: partnerDance ? "beginning" : command.queue.startAt ?? "auto" });
    };
    if (queueInFlightRef.current || transitionEngineRef.current.isRunning || heldLoopRef.current) {
      pushBrainLog("routine", "skipped sample_mix — another queue, transition, or sample is already running");
      releaseAutopilotAskOnFailure(false);
      return;
    }

    const liveLabel = getLiveDeckLabel();
    if (!liveLabel) {
      pushBrainLog("error", "sample_mix: no live deck to sample");
      releaseAutopilotAskOnFailure();
      return;
    }

    if (!isHumanInitiated(cooldownReason)) {
      const secondsAgo = lastPerformanceAtRef.current === null ? null : (Date.now() - lastPerformanceAtRef.current) / 1000;
      if (secondsAgo !== null && secondsAgo < AUTOPILOT_PERFORMANCE_COOLDOWN_SECONDS) {
        pushBrainLog("routine", `skipped sample_mix — performance cooldown floor (${secondsAgo.toFixed(0)}s < ${AUTOPILOT_PERFORMANCE_COOLDOWN_SECONDS}s)`);
        releaseAutopilotAskOnFailure();
        return;
      }
    }

    const liveCtrl = deckByLabel(liveLabel);
    const liveGrid = effectiveGrid(liveCtrl.tags, liveCtrl.grid);
    if (!liveGrid || liveGrid.estimated) {
      pushBrainLog("routine", "sample_mix skipped — no real BeatGrid on the live track");
      releaseAutopilotAskOnFailure();
      return;
    }

    const item = resolveCommandTrack(command.queue.trackId);
    if (!item) {
      pushBrainLog("error", `sample_mix: track index "${command.queue.trackId}" not found in crate`);
      releaseAutopilotAskOnFailure();
      return;
    }
    if (item.id === liveCtrl.trackId) {
      pushBrainLog("routine", `sample_mix skipped - "${item.name}" is already live`);
      releaseAutopilotAskOnFailure();
      return;
    }

    const idleLabel = pickIdleDeckLabel();
    const idleCtrl = deckByLabel(idleLabel);
    if (idleCtrl.deck.playing) {
      idleCtrl.deck.pause();
      idleCtrl.markPaused();
      idleCtrl.deck.allNeutral();
      idleCtrl.deck.clearAllDucks();
    }
    queueInFlightRef.current = true;
    clearRoutineTimers();

    const preEntry = getLoopPoints(CURRENT_LOOP_POINTS, cueKeyForLabel(liveLabel) ?? "");
    const preSample = command.sample ?? {};
    const hasLiveStems = Boolean(stemEntryFor(liveCtrl.trackId));
    const preCandidate =
      pickLoopCandidate(preEntry, {
        fromSeconds: liveCtrl.deck.positionSeconds,
        requireVocalFree: true,
        isolation: preSample.isolation,
      }) ??
      pickLoopCandidate(preEntry, {
        fromSeconds: 0,
        requireVocalFree: true,
        isolation: preSample.isolation,
      }) ??
      pickLoopCandidate(preEntry, {
        fromSeconds: 0,
        requireVocalFree: true,
      }) ??
      (hasLiveStems
        ? pickLoopCandidate(preEntry, {
            fromSeconds: 0,
            requireVocalFree: false,
            isolation: preSample.isolation,
          }) ??
          pickLoopCandidate(preEntry, {
            fromSeconds: 0,
            requireVocalFree: false,
          })
        : null);
    const preFromSeconds = preCandidate ? preCandidate.startSeconds : liveCtrl.deck.positionSeconds;
    const preIsolation = preSample.isolation ?? preCandidate?.isolation ?? "beat";
    const stemSourcePromise = preCandidate?.vocalFree
      ? Promise.resolve(null)
      : loadStemBufferForLoop(
          liveCtrl.trackId,
          preIsolation,
          preFromSeconds,
          preFromSeconds + 24
        );

    let blob: File | Blob;
    try {
      blob = await getTrackForPlayback(item);
    } catch (err) {
      pushBrainLog("error", `sample_mix: could not download "${item.name}" (${err instanceof Error ? err.message : "network error"})`);
      queueInFlightRef.current = false;
      releaseAutopilotAskOnFailure();
      return;
    }

    await idleCtrl.loadFile(blob, item.name, item.id, item.source);
    const [decoded, stemSource] = await Promise.all([
      idleCtrl.decodeIfNeeded(),
      stemSourcePromise,
    ]);
    if (!decoded) {
      pushBrainLog("error", `sample_mix: could not decode "${item.name}"`);
      queueInFlightRef.current = false;
      releaseAutopilotAskOnFailure();
      return;
    }
    // A user pause/load or a different live deck during download is not a
    // permission to start the old routine (or its fallback) later.
    if (controlVersion !== performanceControlVersionRef.current ||
        (getLiveDeckLabel() !== null && deckByLabel(getLiveDeckLabel()!).trackId !== originalLiveId)) {
      queueInFlightRef.current = false;
      pushBrainLog("routine", "sample_mix canceled — playback was changed during preparation");
      return;
    }
    if (!liveCtrl.deck.playing) {
      queueInFlightRef.current = false;
      pushBrainLog("routine", "sample_mix skipped — the source ended during preparation");
      releaseAutopilotAskOnFailure();
      return;
    }
    idleCtrl.deck.ensureContext();

    const mixPoints = analyzeMixPoints(item, idleCtrl);
    idleCtrl.setMixPoints(mixPoints);
    const startAt = command.queue.startAt ?? "auto";
    if (startAt === "auto") {
      const maxEntry = mixPoints ? Math.min(85, Math.max(20, mixPoints.mixOutSeconds - MIN_ENTRY_RESIDENCY_SECONDS)) : 85;
      const midEntry = midTrackEntryFor(item, maxEntry, 16);
      const beatIn = beatInFor(item.id);
      const seekTo = midEntry?.seconds ?? beatIn ?? (mixPoints && mixPoints.mixInSeconds > 0 ? mixPoints.mixInSeconds : null);
      if (seekTo !== null && seekTo > 0) {
        idleCtrl.deck.seekTo(seekTo);
        pushBrainLog(
          "routine",
          `sample_mix entering "${item.name}" at ${seekTo.toFixed(1)}s (${midEntry?.reason ?? "analyzed mix-in"})`
        );
      }
    }

    const entry = getLoopPoints(CURRENT_LOOP_POINTS, cueKeyForLabel(liveLabel) ?? "");
    const sample = command.sample ?? {};
    const candidate =
      pickLoopCandidate(entry, {
        fromSeconds: liveCtrl.deck.positionSeconds,
        requireVocalFree: true,
        isolation: sample.isolation,
      }) ??
      pickLoopCandidate(entry, {
        fromSeconds: 0,
        requireVocalFree: true,
        isolation: sample.isolation,
      }) ??
      pickLoopCandidate(entry, {
        fromSeconds: 0,
        requireVocalFree: true,
      }) ??
      (hasLiveStems
        ? pickLoopCandidate(entry, {
            fromSeconds: 0,
            requireVocalFree: false,
            isolation: sample.isolation,
          }) ??
          pickLoopCandidate(entry, {
            fromSeconds: 0,
            requireVocalFree: false,
          })
        : null);
    const fromSeconds = candidate ? candidate.startSeconds : liveCtrl.deck.positionSeconds;
    const sampleIsolation = sample.isolation ?? candidate?.isolation ?? "beat";
    const sampleHalvings = sample.halvings ?? 0;
    const plan = planHeldLoop(liveGrid, fromSeconds, liveCtrl.deck.tempo, {
      captureBars: sample.captureBars === 2 ? 2 : 4,
      targetHoldSeconds: Math.min(26, Math.max(20, sample.holdSeconds ?? 22)),
      halvingStages: sampleHalvings,
      isolation: sampleIsolation,
      peakRate: sampleHalvings > 1 ? 1.04 : 1.0,
      resolveToRate: sample.sweepToBpm ? sample.sweepToBpm / liveGrid.bpm : undefined,
    });
    if (!plan) {
      pushBrainLog("routine", "sample_mix skipped — sampler planner refused");
      queueInFlightRef.current = false;
      releaseAutopilotAskOnFailure();
      return;
    }
    let finalStemSource = candidate?.vocalFree ? null : stemSource;
    if (
      !candidate?.vocalFree &&
      (!finalStemSource ||
        plan.loopStart < (finalStemSource.bufferOffset ?? 0) ||
        plan.loopEnd > (finalStemSource.bufferOffset ?? 0) + finalStemSource.buffer.duration)
    ) {
      finalStemSource = await loadStemBufferForLoop(
        liveCtrl.trackId,
        sampleIsolation,
        plan.loopStart,
        plan.loopEnd + 2
      );
    }

    const idleBpm = idleCtrl.tags.bpm ?? null;
    const idleGrid = effectiveGrid(idleCtrl.tags, idleCtrl.grid);
    if (!idleBpm || !idleGrid || idleGrid.estimated) {
      pushBrainLog("routine", "sample_mix skipped - incoming track has no real BPM/grid");
      queueInFlightRef.current = false;
      releaseAutopilotAskOnFailure();
      return;
    }
    const sync = syncTempo(plan.exitBpm, 1, idleBpm);
    if (sync.clamped) {
      pushBrainLog("routine", "sample_mix skipped - incoming BPM cannot lock to the sample exit");
      queueInFlightRef.current = false;
      releaseAutopilotAskOnFailure();
      return;
    }
    idleCtrl.setTempoDirectly(sync.tempo);
    const phaseGrid = sync.multiplier === 1 ? idleGrid : { ...idleGrid, bpm: idleGrid.bpm * sync.multiplier };
    const phraseDelay = nextPhraseBoundaries(liveGrid, liveCtrl.deck.positionSeconds, liveCtrl.deck.tempo, 3).find(
      (delay) => delay >= HELD_LOOP_DUCK_LEAD_SECONDS
    );
    if (phraseDelay === undefined || phraseDelay > 24) {
      pushBrainLog("routine", "sample_mix skipped - no phrase boundary is close enough to prepare cleanly");
      queueInFlightRef.current = false;
      releaseAutopilotAskOnFailure();
      return;
    }
    const activationDelaySeconds = phraseDelay;

    const routineStartedAt = Date.now() + activationDelaySeconds * 1000;
    const outPositionSeconds = liveCtrl.deck.positionSeconds;
    let routineFinished = false;
    let incomingStarted = false;
    let seamSweepFired = false;
    let dropFxFired = false;
    let handle: HeldLoopHandle | null = null;

    const alignIncomingToSample = (handoffElapsedSeconds: number) => {
      const virtualSamplePosition = plan.loopStart + Math.max(0, handoffElapsedSeconds) * plan.exitRate;
      const offset = phaseAlignOffset(
        virtualSamplePosition,
        { anchor: liveGrid.anchor, bpm: liveGrid.bpm },
        plan.exitRate,
        idleCtrl.deck.positionSeconds,
        phaseGrid,
        sync.tempo
      );
      idleCtrl.deck.seekBy(offset);
    };

    const startIncoming = (handoffElapsedSeconds: number = 0) => {
      if (incomingStarted) return;
      const startProgress = Math.min(1, Math.max(0, handoffElapsedSeconds / plan.handoffDurationSeconds));
      const remainingSeconds = Math.max(0, plan.handoffDurationSeconds - handoffElapsedSeconds);
      const envelope = sampleMixEnvelope(plan.isolation, startProgress);
      alignIncomingToSample(handoffElapsedSeconds);
      idleCtrl.deck.setGain(envelope.incomingGain[0]);
      idleCtrl.deck.setEq({ low: envelope.incomingLowDb[0], mid: 0, high: 0 });
      idleCtrl.deck.play();
      idleCtrl.markPlaying();
      appendHistory({ trackId: item.id, name: item.name });
      incomingStarted = true;

      // From this point the audible handoff is owned by AudioParams. The
      // interval below only mirrors progress in React; background throttling
      // cannot freeze the fader or bass swap halfway through.
      handle?.scheduleHandoff(remainingSeconds, startProgress, {
        hpfTargetHz: SPACE_SWEEP_HPF_TARGET_HZ,
        effectiveBpm: plan.exitBpm,
        echoBeats: SPACE_SWEEP_ECHO_BEATS,
        echoFeedback: SPACE_SWEEP_ECHO_FEEDBACK,
        echoWet: SPACE_SWEEP_ECHO_WET,
        reverbWet: SPACE_SWEEP_REVERB_WET,
      });
      idleCtrl.deck.scheduleGainEnvelope(envelope.incomingGain, remainingSeconds);
      idleCtrl.deck.scheduleEqEnvelope("low", envelope.incomingLowDb, remainingSeconds);

      if (!seamSweepFired) {
        seamSweepFired = true;
        const untilSweepFraction = startProgress >= 0.5 ? 0 : (0.5 - startProgress) / Math.max(0.001, 1 - startProgress);
        const seamLogTimer = setTimeout(() => {
          if (routineFinished) return;
          recordFxFired();
          recordLedgerFx("space_sweep", "brain");
        }, remainingSeconds * untilSweepFraction * 1000);
        routineTimersRef.current.push(seamLogTimer);
      }
    };

    const cancelArmedRoutine = (reason: string) => {
      if (routineFinished) return;
      routineFinished = true;
      clearRoutineTimers();
      handle?.stop();
      if (heldLoopRef.current === handle) heldLoopRef.current = null;
      setTransitionRunning(false);
      queueInFlightRef.current = false;
      askedForTrackRef.current = null;
      pushBrainLog("routine", reason);
    };

    const abortRoutine = (reason: string) => {
      if (routineFinished) return;
      liveCtrl.deck.unduck(HELD_LOOP_DUCK_RAMP_SECONDS);
      liveCtrl.deck.setGain(1);
      liveCtrl.deck.setEq({ low: 0, mid: 0, high: 0 });
      idleCtrl.deck.pause();
      idleCtrl.deck.setGain(1);
      idleCtrl.deck.setEq({ low: 0, mid: 0, high: 0 });
      idleCtrl.markPaused();
      setCrossfade(liveLabel === "A" ? 0 : 1);
      cancelArmedRoutine(reason);
    };

    const finishRoutine = () => {
      if (routineFinished) return;
      if (!incomingStarted) {
        abortRoutine("sample_mix aborted - the handoff missed its phrase; kept the outgoing deck live");
        return;
      }
      routineFinished = true;
      clearRoutineTimers();
      handle?.setGain(0);
      handle?.stop();
      if (heldLoopRef.current === handle) heldLoopRef.current = null;
      liveCtrl.deck.unduck(HELD_LOOP_DUCK_RAMP_SECONDS);
      liveCtrl.deck.pause();
      liveCtrl.deck.setGain(1);
      liveCtrl.deck.setEq({ low: 0, mid: 0, high: 0 });
      liveCtrl.markPaused();
      idleCtrl.deck.setEq({ low: 0, mid: 0, high: 0 });
      idleCtrl.deck.setGain(1);
      setCrossfade(idleLabel === "A" ? 0 : 1);
      setTransitionRunning(false);
      if (command.queue.maskFx && command.queue.maskFx !== "space_sweep" && !dropFxFired) {
        dropFxFired = true;
        const explicitFx = command.queue.maskFx;
        void fxPlayerRef.current?.play(explicitFx).then((success) => {
          if (success) {
            recordFxFired();
            recordLedgerFx(explicitFx, "brain");
          }
        });
      }
      startTempoGlide(idleLabel);
      queueInFlightRef.current = false;
      const record: TransitionRecord = {
        when: Date.now(),
        fromTrack: liveCtrl.trackName ?? liveCtrl.trackId ?? "unknown",
        toTrack: item.name,
        bpmFrom: liveCtrl.tags.bpm ?? null,
        bpmTo: idleCtrl.tags.bpm ?? null,
        clamped: sync.clamped,
        degraded: false,
        transitionType: command.queue.transition,
        durationBars: plan.handoffBeats / 4,
        rating: null,
        note: `sample_mix ${plan.isolation} ${plan.captureBeats / 4}-bar sample, ${plan.handoffBeats / 4}-bar handoff over ${Math.max(0, (Date.now() - routineStartedAt) / 1000).toFixed(1)}s`,
        outPositionSeconds,
      };
      setTransitionRecords(appendTransitionRecord(record));
      pushBrainLog("routine", `sample_mix completed — "${item.name}" is live`);
      executionFeedbackRef.current = null;
      if (typeof command.followUpSeconds === "number") scheduleFollowUp(command.followUpSeconds, cooldownReason);
    };

    const usableStemSource =
      finalStemSource &&
      plan.loopStart >= (finalStemSource.bufferOffset ?? 0) &&
      plan.loopEnd <= (finalStemSource.bufferOffset ?? 0) + finalStemSource.buffer.duration
        ? finalStemSource
        : null;
    handle = fireIsolatedLoopHold(
      liveCtrl.deck,
      coreRef.current!,
      plan,
      finishRoutine,
      activationDelaySeconds,
      usableStemSource
    );
    if (!handle) {
      pushBrainLog("routine", "sample_mix skipped — nothing decoded to sample");
      queueInFlightRef.current = false;
      releaseAutopilotAskOnFailure();
      return;
    }

    heldLoopRef.current = handle;
    setTransitionRunning(true);
    const preparedLiveTrackId = liveCtrl.trackId;
    const activationGuardDelaySeconds = Math.max(0, activationDelaySeconds - HELD_LOOP_DUCK_LEAD_SECONDS);
    const activationTimer = setTimeout(() => {
      const activationGuardAtMs = routineStartedAt - HELD_LOOP_DUCK_LEAD_SECONDS * 1000;
      const activationNowMs = Date.now();
      if (sampleMixHandoffIsLate(activationNowMs, activationGuardAtMs, SAMPLE_MIX_TIMER_LATE_TOLERANCE_MS)) {
        cancelArmedRoutine(
          `sample_mix canceled - phrase activation timer was ${Math.round(activationNowMs - activationGuardAtMs)}ms late`
        );
        return;
      }
      const currentLive = deckByLabel(liveLabel);
      if (currentLive.trackId !== preparedLiveTrackId || !currentLive.deck.playing) {
        cancelArmedRoutine("sample_mix canceled - live deck changed before the phrase boundary");
        return;
      }
      currentLive.deck.duck(HELD_LOOP_DUCK_DB, HELD_LOOP_DUCK_RAMP_SECONDS);
      recordFxFired(true);
      recordLedgerFx("sample_mix", "brain");
      pushBrainLog("routine", `sample captured on the phrase - ${plan.handoffStartAtSeconds.toFixed(1)}s solo before the handoff`);
    }, activationGuardDelaySeconds * 1000);
    routineTimersRef.current.push(activationTimer);

    const handoffTimer = setTimeout(() => {
      if (routineFinished || heldLoopRef.current !== handle) return;
      const handoffStartMs = routineStartedAt + plan.handoffStartAtSeconds * 1000;
      const handoffNowMs = Date.now();
      const handoffLateMs = Math.max(0, handoffNowMs - handoffStartMs);
      if (sampleMixHandoffIsLate(handoffNowMs, handoffStartMs)) {
        abortRoutine(`sample_mix aborted - handoff timer was ${Math.round(handoffLateMs)}ms late; kept the outgoing deck live`);
        return;
      }
      startIncoming(handoffLateMs / 1000);

      routineIntervalRef.current = setInterval(() => {
        const progress = Math.min(1, (Date.now() - handoffStartMs) / (plan.handoffDurationSeconds * 1000));
        setCrossfade(idleLabel === "A" ? 1 - progress : progress);
        if (progress >= 1 && routineIntervalRef.current) {
          clearInterval(routineIntervalRef.current);
          routineIntervalRef.current = null;
          finishRoutine();
        }
      }, 50);
    }, (activationDelaySeconds + plan.handoffStartAtSeconds) * 1000);
    routineTimersRef.current.push(handoffTimer);

    pushBrainLog(
      "routine",
      `sample_mix armed: ${plan.captureBeats / 4}-bar ${plan.isolation}${usableStemSource ? " stem" : ""} sample, ${plan.handoffStartAtSeconds.toFixed(1)}s solo + ${plan.handoffBeats / 4}-bar EQ crossfade into "${item.name}"${candidate ? " — recurring-pattern sample" : ""}`
    );
  }

  function cancelPendingTransitionStart() {
    if (pendingTransitionTimeoutRef.current) {
      clearTimeout(pendingTransitionTimeoutRef.current);
      pendingTransitionTimeoutRef.current = null;
      queueInFlightRef.current = false;
      queueInFlightSinceRef.current = null;
      askedForTrackRef.current = null;
      pushBrainLog("transition", "canceled a pending phrase-delayed transition start");
    }
  }

  /** Choir round #2 (C4): clears any pending deferred maskFx neutral-release timer (see the onDone handler in executeQueueCommand) without firing it — a fresh transition on the same deck, or a manual-pause cancel, supersedes it. */
  function clearPendingMaskFxRelease() {
    if (maskFxReleaseTimeoutRef.current) {
      clearTimeout(maskFxReleaseTimeoutRef.current);
      maskFxReleaseTimeoutRef.current = null;
    }
  }

  /**
   * Choir round #2 (C2): a manual pause on EITHER deck means the DJ took
   * over — beyond the pre-existing pending-phrase-wait cancel above, a
   * transition that's already ACTIVELY RUNNING (mid "gap" wait, mid
   * echo_out ring, mid a blend/loop ramp) must also be torn down, or its
   * own natural completion event (onEnded for "gap", a timer for the
   * others) can end up never firing the way the DJ now expects — wedging
   * transitionEngineRef.current.isRunning true forever and silently
   * dead-ending autopilot for the rest of the session (the concrete "gap"
   * scenario this was found from). transitionEngineRef.current.cancel() is
   * a safe no-op when nothing is running. Both decks are force-neutralized
   * (allNeutral()) regardless of which deck was mid-transition — cheap,
   * and guarantees a maskFx sweep/reverb/echo the DJ interrupted never
   * carries on past this point (ties into C4's deferred-release fix, whose
   * own timer this also cancels).
   */
  /**
   * Hardware-level master bus purge: stops the Live 4-Stem Mixer and replaces
   * AudioCore's masterGain node while reconnecting ONLY Deck A and Deck B.
   * Any orphaned loop buffer, stem migration source, or stuck background audio
   * connected to the previous masterGain is physically severed from the speakers.
   */
  function purgeMasterBus() {
    stopStemMixerRef.current?.();
    coreRef.current?.purgeOrphanedNodes(() => {
      deckARef.current.deck.reconnectToMaster();
      deckBRef.current.deck.reconnectToMaster();
    });
  }

  /**
   * Ensures at most ONE deck is playing outside of an active transition.
   * Pauses and silences the non-primary deck, clears all ducks/filters on
   * the primary deck, and snaps the crossfader to the active deck.
   */
  function enforceSingleLiveDeck(preferredLabel?: DeckLabel) {
    const aPlaying = deckARef.current.deck.playing;
    const bPlaying = deckBRef.current.deck.playing;
    if (!aPlaying && !bPlaying) return;
    const keepLabel: DeckLabel =
      preferredLabel ??
      (aPlaying && !bPlaying
        ? "A"
        : bPlaying && !aPlaying
          ? "B"
          : (deckBRef.current.wentLiveAtMs() ?? 0) > (deckARef.current.wentLiveAtMs() ?? 0)
            ? "B"
            : crossfadeRef.current <= 0.5
              ? "A"
              : "B");
    const otherLabel: DeckLabel = keepLabel === "A" ? "B" : "A";
    const keepCtrl = deckByLabel(keepLabel);
    const otherCtrl = deckByLabel(otherLabel);
    if (otherCtrl.deck.playing) {
      otherCtrl.deck.pause();
    }
    otherCtrl.markPaused();
    otherCtrl.deck.allNeutral();
    otherCtrl.deck.clearAllDucks();
    otherCtrl.deck.setGain(0);

    keepCtrl.deck.clearAllDucks();
    keepCtrl.deck.allNeutral();
    keepCtrl.deck.setEq({ low: 0, mid: 0, high: 0 });
    keepCtrl.deck.setGain(1);
    setCrossfade(keepLabel === "A" ? 0 : 1);
  }

  function handleManualPlayDeck(label: DeckLabel) {
    stopStemMixerRef.current?.();
    handleManualPauseDuringTransition();
    const otherLabel: DeckLabel = label === "A" ? "B" : "A";
    const otherCtrl = deckByLabel(otherLabel);
    if (otherCtrl.deck.playing) {
      otherCtrl.deck.pause();
      otherCtrl.markPaused();
      otherCtrl.deck.allNeutral();
      otherCtrl.deck.clearAllDucks();
      otherCtrl.deck.setGain(0);
    }
    const thisCtrl = deckByLabel(label);
    thisCtrl.deck.clearAllDucks();
    thisCtrl.deck.allNeutral();
    thisCtrl.deck.setEq({ low: 0, mid: 0, high: 0 });
    thisCtrl.deck.setGain(1);
    setCrossfade(label === "A" ? 0 : 1);
    purgeMasterBus();
  }

  function handleStopDecksForStemMixer() {
    performanceControlVersionRef.current += 1;
    queuePreparationRef.current?.abort(new Error("Live 4-Stem Mixer started"));
    queuePreparationRef.current = null;
    pendingGapRef.current = null;
    cancelPendingTransitionStart();
    teardownMigration();
    cleanupHeldLoopAndRoutine("stopped for Live 4-Stem Mixer");
    clearPendingMaskFxRelease();
    transitionEngineRef.current.cancel();
    setTransitionRunning(false);
    queueInFlightRef.current = false;
    if (autopilotRef.current) {
      autopilotRef.current = false;
      setAutopilot(false);
      cancelFollowUp();
    }
    for (const ctrl of [deckARef.current, deckBRef.current]) {
      if (ctrl.deck.playing) ctrl.deck.pause();
      ctrl.markPaused();
      ctrl.deck.allNeutral();
      ctrl.deck.clearAllDucks();
    }
  }

  function handleReturnFromStemsToDeck(resumePositionSec: number, resumeTempo: number) {
    coreRef.current?.ensureContext();
    stopStemMixerRef.current?.();
    const targetLabel: DeckLabel | null =
      deckARef.current.trackId
        ? "A"
        : deckBRef.current.trackId
          ? "B"
          : null;
    if (!targetLabel) return;
    const ctrl = deckByLabel(targetLabel);
    const otherCtrl = deckByLabel(targetLabel === "A" ? "B" : "A");
    if (otherCtrl.deck.playing) {
      otherCtrl.deck.pause();
      otherCtrl.markPaused();
      otherCtrl.deck.allNeutral();
      otherCtrl.deck.clearAllDucks();
      otherCtrl.deck.setGain(0);
    }
    ctrl.setTempoDirectly(Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, resumeTempo)));
    if (Number.isFinite(resumePositionSec) && resumePositionSec >= 0) {
      ctrl.deck.seekTo(resumePositionSec);
    }
    ctrl.deck.clearAllDucks();
    ctrl.deck.allNeutral();
    ctrl.deck.setEq({ low: 0, mid: 0, high: 0 });
    ctrl.deck.setGain(1);
    setCrossfade(targetLabel === "A" ? 0 : 1);
    ctrl.deck.play();
    ctrl.markPlaying();
  }

  function handleReleaseManualLoop() {
    coreRef.current?.ensureContext();
    if (heldLoopRef.current) {
      cleanupHeldLoopAndRoutine("🔓 Released horn/beat loop — continuing song");
    }
  }

  async function handleManualStemLoop(opts: {
    isolation: "melody" | "beat";
    bars: 1 | 2 | 4 | 8;
    startSeconds?: number;
    endSeconds?: number;
    label?: string;
  }) {
    coreRef.current?.ensureContext();
    stopStemMixerRef.current?.();
    if (migrationRef.current || migrationPreparingRef.current) {
      teardownMigration();
    }
    if (transitionEngineRef.current.isRunning) {
      transitionEngineRef.current.cancel();
      setTransitionRunning(false);
    }
    if (heldLoopRef.current) {
      cleanupHeldLoopAndRoutine("switching loop");
    }

    const liveLabel: DeckLabel | null =
      getLiveDeckLabel() ??
      (deckARef.current.trackId ? "A" : deckBRef.current.trackId ? "B" : null);
    if (!liveLabel) {
      pushBrainLog("error", "loop: load or play a song first");
      return;
    }
    const liveCtrl = deckByLabel(liveLabel);
    if (!liveCtrl.deck.audioBuffer) {
      await liveCtrl.decodeIfNeeded();
    }
    if (!liveCtrl.deck.playing) {
      handleManualPlayDeck(liveLabel);
      liveCtrl.deck.play();
      liveCtrl.markPlaying();
    }

    const liveTrackId = liveCtrl.trackId;
    const cueKey = cueKeyForLabel(liveLabel);
    const loopPts = cueKey ? getLoopPoints(CURRENT_LOOP_POINTS, cueKey) : undefined;
    const rawGrid = effectiveGrid(liveCtrl.tags, liveCtrl.grid);
    const grid: BeatGridLike =
      rawGrid && !rawGrid.estimated
        ? rawGrid
        : loopPts && loopPts.bpm > 0
          ? { bpm: loopPts.bpm, anchor: loopPts.anchor ?? 0 }
          : rawGrid ?? { bpm: 120, anchor: 0 };

    const fromSeconds =
      opts.startSeconds !== undefined ? opts.startSeconds : liveCtrl.deck.positionSeconds;
    const plan = planHeldLoop(grid, fromSeconds, liveCtrl.deck.tempo, {
      captureBars: opts.bars,
      targetHoldSeconds: 180,
      halvingStages: 0,
      isolation: opts.isolation,
      peakRate: 1.0,
      resolveToRate: liveCtrl.deck.tempo,
    });
    if (!plan) return;

    if (opts.startSeconds !== undefined && opts.endSeconds !== undefined && opts.endSeconds > opts.startSeconds + 0.2) {
      plan.loopStart = opts.startSeconds;
      plan.loopEnd = opts.endSeconds;
      for (const stage of plan.stages) {
        stage.loopEnd = opts.endSeconds;
      }
      liveCtrl.deck.seekTo(opts.startSeconds);
    }

    const displayLabel =
      opts.label ??
      `${opts.isolation === "melody" ? "🎺 Horns + Beat" : "🥁 Beat + Bass"} (${formatMmSs(plan.loopStart)}–${formatMmSs(plan.loopEnd)} · ${opts.bars}b)`;

    const cacheKey = liveTrackId
      ? `${liveTrackId}:${opts.isolation}:${Math.floor(plan.loopStart)}:${Math.ceil(plan.loopEnd)}`
      : "";
    const cachedStem = cacheKey ? stemLoopCacheRef.current.get(cacheKey) ?? null : null;

    // 1. Start the BeatGrid-quantized loop IMMEDIATELY (0ms latency)
    const controlVersion = performanceControlVersionRef.current;
    liveCtrl.deck.duck(HELD_LOOP_DUCK_DB, HELD_LOOP_DUCK_RAMP_SECONDS);
    const initialHandle = fireIsolatedLoopHold(
      liveCtrl.deck,
      coreRef.current!,
      plan,
      () => {
        if (heldLoopRef.current === initialHandle) {
          heldLoopRef.current = null;
          setManualLoopLabel(null);
          liveCtrl.deck.unduck(HELD_LOOP_DUCK_RAMP_SECONDS);
        }
      },
      0,
      cachedStem
    );
    if (!initialHandle) {
      liveCtrl.deck.unduck(HELD_LOOP_DUCK_RAMP_SECONDS);
      return;
    }
    heldLoopRef.current = initialHandle;
    setManualLoopLabel(cachedStem ? `${displayLabel} [Vocal-Free Stems]` : `${displayLabel} [Isolating Stems…]`);
    pushBrainLog(
      "loop",
      `🔁 Looping ${displayLabel} @ ${formatMmSs(plan.loopStart)}–${formatMmSs(plan.loopEnd)}${cachedStem ? " (100% vocal-free stems)" : " (loading vocal-free stems…)"}`
    );

    // 2. If the vocal-free stem mix wasn't cached yet, decode it in the background and hot-swap seamlessly!
    if (!cachedStem && liveTrackId && stemEntryFor(liveTrackId)) {
      const stemSource = await loadStemBufferForLoop(
        liveTrackId,
        opts.isolation,
        plan.loopStart,
        plan.loopEnd
      );
      if (
        stemSource &&
        controlVersion === performanceControlVersionRef.current &&
        heldLoopRef.current === initialHandle
      ) {
        const upgradedHandle = fireIsolatedLoopHold(
          liveCtrl.deck,
          coreRef.current!,
          plan,
          () => {
            if (heldLoopRef.current === upgradedHandle) {
              heldLoopRef.current = null;
              setManualLoopLabel(null);
              liveCtrl.deck.unduck(HELD_LOOP_DUCK_RAMP_SECONDS);
            }
          },
          0,
          stemSource
        );
        if (upgradedHandle) {
          heldLoopRef.current = upgradedHandle;
          initialHandle.stop();
          setManualLoopLabel(`${displayLabel} [Vocal-Free Stems]`);
          pushBrainLog(
            "loop",
            `🎺 Vocal-free stems locked in for ${displayLabel} (Drums + Bass + Horns/Melody, Vocals removed!)`
          );
        }
      }
    }
  }

  function handleKillBackgroundAndSoloActiveDeck() {
    coreRef.current?.ensureContext();
    stopStemMixerRef.current?.();
    performanceControlVersionRef.current += 1;
    queuePreparationRef.current?.abort(new Error("Soloed active deck"));
    queuePreparationRef.current = null;
    pendingGapRef.current = null;
    cancelPendingTransitionStart();
    teardownMigration();
    cleanupHeldLoopAndRoutine("killed background audio — soloed active deck");
    clearPendingMaskFxRelease();
    transitionEngineRef.current.cancel();
    setTransitionRunning(false);
    queueInFlightRef.current = false;
    askedForTrackRef.current = null;
    purgeMasterBus();
    enforceSingleLiveDeck();
    pushBrainLog("transition", "🎯 Killed background audio & loops — soloed active track at 100% volume");
  }

  function handleStopAllAudio() {
    coreRef.current?.ensureContext();
    stopStemMixerRef.current?.();
    performanceControlVersionRef.current += 1;
    queuePreparationRef.current?.abort(new Error("Stopped all audio"));
    queuePreparationRef.current = null;
    pendingGapRef.current = null;
    cancelPendingTransitionStart();
    teardownMigration();
    cleanupHeldLoopAndRoutine("stopped all audio");
    clearPendingMaskFxRelease();
    transitionEngineRef.current.cancel();
    setTransitionRunning(false);
    queueInFlightRef.current = false;
    askedForTrackRef.current = null;
    cancelFollowUp();
    if (autopilotRef.current) {
      autopilotRef.current = false;
      setAutopilot(false);
    }
    for (const ctrl of [deckARef.current, deckBRef.current]) {
      if (ctrl.deck.playing) ctrl.deck.pause();
      ctrl.markPaused();
      ctrl.deck.allNeutral();
      ctrl.deck.clearAllDucks();
      ctrl.deck.setGain(1);
    }
    purgeMasterBus();
    pushBrainLog("transition", "🛑 Stopped all audio, background loops, stems, and decks");
  }

  function handleManualPauseDuringTransition() {
    stopStemMixerRef.current?.();
    performanceControlVersionRef.current += 1;
    queuePreparationRef.current?.abort(new Error("Playback changed manually"));
    pendingGapRef.current = null;
    cancelPendingTransitionStart();
    teardownMigration();
    cleanupHeldLoopAndRoutine("canceled held loop/routine — a deck was paused manually");
    if (transitionEngineRef.current.isRunning) {
      clearPendingMaskFxRelease();
      transitionEngineRef.current.cancel();
      setTransitionRunning(false);
      deckA.deck.allNeutral();
      deckB.deck.allNeutral();
      deckA.deck.clearAllDucks();
      deckB.deck.clearAllDucks();
      pushBrainLog("transition", "canceled — a deck was paused manually mid-transition");
    }
    purgeMasterBus();
    enforceSingleLiveDeck();
  }

  async function executeQueueCommand(command: QueueCommand, residencyTimed = false) {
    stopStemMixerRef.current?.();
    const fullSongRequested = command.transition === "gap";
    // Choir round #2 (P1): single-flight the queue path — this async setup
    // window (download/decode/up-to-16s phrase-wait) used to have NO guard
    // at all, so a second queue command (a stale follow-up racing a fresh
    // one, or an overlapping chat + autopilot poll) could start its own
    // download/decode while the first was still mid-flight, double-firing
    // transitions or interleaving callbacks. A second command arriving
    // while one is already in flight is dropped (not queued-behind — this
    // app has no real command queue elsewhere either) with an honest log
    // line. Released explicitly at every real exit below (see
    // releaseQueueInFlight) — NOT via a blanket try/finally, since the
    // phrase-aligned-firing path returns from this async function long
    // before the delayed fireTransition() actually runs; the engine's own
    // "running" reentrancy guard (see transition.ts) takes over as the
    // real single-flight protection from the moment a transition actually
    // starts.
    if (queueInFlightRef.current || transitionEngineRef.current.isRunning) {
      pushBrainLog("error", `queue: dropped — still resolving a previous queue command`);
      return;
    }
    queueInFlightRef.current = true;
    queueInFlightSinceRef.current = Date.now();
    const controlVersion = performanceControlVersionRef.current;
    let queueInFlightReleased = false;
    const releaseQueueInFlight = () => {
      if (queueInFlightReleased) return;
      queueInFlightReleased = true;
      queueInFlightRef.current = false;
      queueInFlightSinceRef.current = null;
    };

    // Owner soundcheck fix: any new queue command — opener or transition —
    // means the tempo landscape is about to change; a pending auto-recovery
    // glide from a PREVIOUS transition must not keep nudging a deck whose
    // tempo the new transition (or the fresh opener) is about to own.
    cancelTempoGlide();
    // Phrase-aligned firing: a fresh queue command supersedes any transition
    // this app was already waiting to fire.
    cancelPendingTransitionStart();

    // Cost addendum: trackId is now the STRING FORM of the compact crate
    // entry's index (see src/lib/brain.ts's CompactCrateEntry), not a real
    // crate id — resolve it back via the per-call index map built by
    // buildFullCompactCrate() before this response could have arrived.
    const item = resolveCommandTrack(command.trackId);
    if (!item) {
      pushBrainLog("error", `queue: track index "${command.trackId}" not found in crate`);
      // Review-panel fix: clear the "already asked" guard on failure so the
      // very next poll retries instead of waiting on the opener's re-ask
      // window (or being wedged forever on a per-trackId guard that will
      // never be revisited since the live track hasn't changed).
      askedForTrackRef.current = null;
      releaseQueueInFlight();
      return;
    }
    // Re-bound so the closures below (fireTransition, its onDone/onGain
    // callbacks) don't lose TS's narrowing of `item` past `undefined` —
    // narrowing a `const` doesn't carry into a nested function's body.
    const track = item;

    const idleLabel = pickIdleDeckLabel();
    const idleCtrl = deckByLabel(idleLabel);
    if (idleCtrl.deck.playing) {
      idleCtrl.deck.pause();
      idleCtrl.markPaused();
      idleCtrl.deck.allNeutral();
      idleCtrl.deck.clearAllDucks();
    }
    // the proxy — see getTrackForPlayback()) BEFORE handing it to the deck.
    // A download failure (dead wifi, Drive error) goes through the exact
    // same guard-reset-and-log path as the pre-existing "not found"/
    // "could not decode" failures below, so autopilot's failure ladder
    // (retry, then stop with a log line) still applies unchanged.
    const preparation = new AbortController();
    queuePreparationRef.current = preparation;
    const preparationTimeout = setTimeout(() => preparation.abort(new Error("audio preparation exceeded 45 seconds")), 45000);
    const checkPreparation = () => {
      preparation.signal.throwIfAborted();
      if (controlVersion !== performanceControlVersionRef.current) throw new Error("playback changed during preparation");
    };
    try {
      await abortable((async () => {
        const blob = await getTrackForPlayback(track, preparation.signal);
        checkPreparation();
        pushBrainLog("queue", `download ready — preparing "${track.name}"`);
        await idleCtrl.loadFile(blob, track.name, track.id, track.source);
        checkPreparation();
        if (!await idleCtrl.decodeIfNeeded(preparation.signal)) throw new Error("audio decode failed");
        checkPreparation();
      })(), preparation.signal);
    } catch (err) {
      pushBrainLog(
        "error",
        `queue: could not prepare "${track.name}" (${err instanceof Error ? err.message : "network error"})`
      );
      askedForTrackRef.current = null;
      releaseQueueInFlight();
      return;
    } finally {
      clearTimeout(preparationTimeout);
      if (queuePreparationRef.current === preparation) queuePreparationRef.current = null;
    }
    idleCtrl.deck.ensureContext();

    // Choir round #2 (P1): revalidate live/idle state AFTER the awaits
    // above (download + decode can take seconds) rather than trusting the
    // liveLabel snapshot taken before them — two real races this closes:
    // (a) an "opener" (liveLabel was null) playing directly OVER a deck
    // that started meanwhile would now correctly see it and go through the
    // transition branch instead; (b) a live deck that ended naturally
    // during the download/decode window now correctly reads as null here
    // (nothing playing), so this becomes a fresh opener instead of setting
    // up a transition against a deck that already stopped.
    const liveLabel = getLiveDeckLabel();

    // In-and-out mixing: analyze (or reuse the cached) mix-in/mix-out points
    // off the now-decoded buffer, then seek the incoming deck to its mix-in
    // point BEFORE any play() — both for a direct/opener play below and for
    // the transition handoff further down, since runTransition's toDeck.play()
    // reads whatever position the deck is already at. startAt:"beginning"
    // (salsa/bachata etc, per SYSTEM_PROMPT) skips the seek — the deck is
    // already at position 0 fresh off decode().
    const mixPoints = analyzeMixPoints(track, idleCtrl);
    idleCtrl.setMixPoints(mixPoints);
    const startAt = command.startAt ?? "auto";
    if (startAt === "auto") {
      const maxEntry = mixPoints ? Math.min(85, Math.max(20, mixPoints.mixOutSeconds - MIN_ENTRY_RESIDENCY_SECONDS)) : 85;
      const midEntry = midTrackEntryFor(track, maxEntry, 32);
      const beatIn = beatInFor(item.id);
      const seekTo = midEntry?.seconds ?? beatIn ?? (mixPoints && mixPoints.mixInSeconds > 0 ? mixPoints.mixInSeconds : null);
      if (seekTo !== null && seekTo > 0) {
        idleCtrl.deck.seekTo(seekTo);
        pushBrainLog(
          "queue",
          `entering "${track.name}" at ${seekTo.toFixed(1)}s (${midEntry?.reason ?? "analyzed mix-in"})`
        );
      }
    }

    if (liveLabel === null) {
      // Nothing else playing — this is a bootstrap/opener, no transition needed.
      idleCtrl.deck.play();
      idleCtrl.markPlaying();
      setCrossfade(idleLabel === "A" ? 0 : 1);
      appendHistory({ trackId: track.id, name: track.name });
      releaseQueueInFlight();
      return;
    }

    const liveCtrl = deckByLabel(liveLabel);
    const liveBpmTag = liveCtrl.tags.bpm ?? null;
    const idleBpmTag = idleCtrl.tags.bpm ?? null;
    const timedCommand = queueForResidency(command, residencyRequestRef.current?.seconds ?? null,
      liveBpmTag, liveCtrl.deck.tempo, idleBpmTag);
    if (timedCommand !== command) pushBrainLog("queue", timedCommand.say!);
    command = timedCommand;
    const fromBpm = liveBpmTag ?? NEUTRAL_BPM_FALLBACK;
    const toBpm = idleBpmTag ?? NEUTRAL_BPM_FALLBACK;
    const liveGrid = effectiveGrid(liveCtrl.tags, liveCtrl.grid);

    // Untagged-BPM guard (review-panel fix): never run a beatmatch/bass_swap
    // blend against a FABRICATED tempo (NEUTRAL_BPM_FALLBACK) just because
    // one side has no real BPM tag — the manual Beat Sync button already
    // refuses in this situation (syncDisabled above); autopilot must too.
    // Honor "echo_out"/"gap" if the brain already chose one of those (both
    // already avoid committing to a fabricated beat-lock); otherwise force "cut".
    const eitherUntagged = liveBpmTag === null || idleBpmTag === null;
    const safeWithoutBpm: QueueCommand["transition"][] = ["cut", "echo_out", "gap"];
    const bpmGuardedTransition = eitherUntagged && !safeWithoutBpm.includes(command.transition) ? "cut" : command.transition;
    if (eitherUntagged && bpmGuardedTransition !== command.transition) {
      pushBrainLog("queue", `untagged BPM — forced transition to "cut" instead of "${command.transition}"`);
    }

    // Loop-blend no-grid guard (audio engine v2, Part 3): "loop_blend" needs
    // a REAL (non-estimated) BeatGrid on the live track to phrase-snap the
    // captured 4-bar slice — never attempt an unsnapped loop (per the
    // dispatch). Falls back to "bass_swap" when both sides are still tagged
    // (a real BPM lock is still possible, just not a grid-snapped loop), or
    // stays "cut" when the untagged-BPM guard above already forced one.
    const effectiveTransition =
      bpmGuardedTransition === "loop_blend" && (!liveGrid || liveGrid.estimated)
        ? eitherUntagged
          ? "cut"
          : "bass_swap"
        : bpmGuardedTransition;
    if (effectiveTransition !== bpmGuardedTransition) {
      pushBrainLog("queue", `loop_blend needs a real BeatGrid on the live track — falling back to "${effectiveTransition}"`);
    }

    // Seam masking (owner soundcheck fix): fire the brain's requested
    // stinger exactly at the seam — the cut instant for "cut"/"echo_out"/
    // "gap" (all resolve their seam via a single onGain(1) call, not a
    // ramp), or the crossfade midpoint for the two blend kinds that DO ramp
    // continuously. Reuses the existing onGain stream rather than a
    // separate timer — the honest simplest hook, per the dispatch. Fires at
    // most once per transition; never fires if the transition never starts
    // (onGain is simply never called in that case).
    let maskFxFired = false;
    const maskFxSeamThreshold = effectiveTransition === "beatmatch_crossfade" || effectiveTransition === "bass_swap" ? 0.5 : 1;

    /**
     * Fires the actual transition NOW — factored out so phrase-aligned
     * firing (below) can call it either immediately or from a delayed
     * setTimeout. `outPositionSeconds` (the lesson-ledger tie-in — see its
     * own comment below) is captured INSIDE this closure specifically so a
     * delayed start records the position at the ACTUAL fire moment, not
     * whatever the live deck's position was back when the brain's response
     * first arrived (per the dispatch: "the DELAYED start records the
     * actual fire position, not the command-arrival position").
     */
    function fireTransition() {
      pendingTransitionTimeoutRef.current = null;

      // Choir round #2 (P2): the live deck stopped playing while this fire
      // was pending (a manual pause not caught by onManualPause's proactive
      // cancel — e.g. it fired between the cancel check and this callback —
      // or the track ended naturally during the wait). idleCtrl's deck is
      // already decoded AND seeked to its mix-in point at this point —
      // abandoning it here used to strand it silently until a LATER poll
      // re-asked the brain (dead air in the meantime). Play it directly
      // instead (opener-style, same as the "nothing else playing" bootstrap
      // branch above), logged honestly so this path stays visible.
      if (controlVersion !== performanceControlVersionRef.current) { releaseQueueInFlight(); return; }
      if (!liveCtrl.deck.playing) {
        pushBrainLog(
          "queue",
          `live deck stopped before a phrase-delayed transition fired — playing "${track.name}" directly instead of abandoning it`
        );
        idleCtrl.deck.play();
        idleCtrl.markPlaying();
        setCrossfade(idleLabel === "A" ? 0 : 1);
        appendHistory({ trackId: track.id, name: track.name });
        releaseQueueInFlight();
        return;
      }

      // Lesson-ledger tie-in: where in the OUTGOING track this transition
      // fired, captured NOW (transition start) rather than at onDone/finish —
      // a blend's fromDeck keeps advancing during the ramp, so "the moment the
      // transition fired" means this instant, not wherever fromDeck ends up
      // once the ramp completes.
      const outPositionSeconds = liveCtrl.deck.positionSeconds;

      // Loop-tension blend (audio engine v2, Part 3): the loop capture IS
      // the phrase-boundary moment, per the dispatch — planned HERE (fire
      // time), off the live deck's position at the ACTUAL fire moment, not
      // whenever the brain's response first arrived (same "delayed start
      // records the real moment" rule outPositionSeconds above already
      // follows). The no-grid guard above guarantees liveGrid is real
      // (non-estimated) whenever effectiveTransition is still "loop_blend"
      // here. fireLoopOverlay()/its stop() live outside the abstract
      // TransitionDeck interface (real Deck/AudioCore) — see
      // transition.ts's "loop_blend" branch doc comment for why the two
      // callbacks exist at all.
      const loopBlendPlan =
        effectiveTransition === "loop_blend"
          ? planLoopBlend(liveGrid, outPositionSeconds, liveBpmTag ?? NEUTRAL_BPM_FALLBACK, liveCtrl.tempo, command.durationBars)
          : null;
      let loopOverlayStop: (() => void) | null = null;
      let incomingStarted = false;
      const markIncoming = () => {
        if (incomingStarted || !idleCtrl.deck.playing) return;
        incomingStarted = true;
        idleCtrl.markPlaying();
        appendHistory({ trackId: track.id, name: track.name });
      };

      const outcome = transitionEngineRef.current.runTransition({
        fromDeck: liveCtrl.deck,
        toDeck: idleCtrl.deck,
        fromBpm,
        toBpm,
        fromGrid: effectiveGrid(liveCtrl.tags, liveCtrl.grid),
        toGrid: effectiveGrid(idleCtrl.tags, idleCtrl.grid),
        durationBars: command.durationBars,
        transition: effectiveTransition,
        loopBlend: loopBlendPlan ?? undefined,
        onLoopBlendStart: () => {
          if (!loopBlendPlan) return;
          loopOverlayStop = fireLoopOverlay(liveCtrl.deck, coreRef.current!, loopBlendPlan.loopStart, loopBlendPlan.loopEnd, loopBlendPlan.totalDurationSeconds);
        },
        onLoopBlendEnd: () => {
          loopOverlayStop?.();
          loopOverlayStop = null;
        },
        onGain: (progress) => {
          markIncoming();
          setCrossfade(idleLabel === "B" ? progress : 1 - progress);
          if (command.maskFx && !maskFxFired && progress >= maskFxSeamThreshold) {
            maskFxFired = true;
            // Functional cover, not hype: fires regardless of the fx
            // frequency cap/cooldown (those live in executeFxCommand, an
            // entirely separate code path from this queue executor) — but
            // still records for cadence tracking, per the dispatch.
            if (command.maskFx === "space_sweep") {
              // audio engine v2, Part 1 — not a one-shot sample: a filter
              // sweep + echo tail + reverb wash run directly on the
              // OUTGOING deck's own fx sends (see src/lib/fx-sends.ts /
              // deck.ts). allNeutral() below (onDone) resets these before
              // the deck is reused for a later track.
              const outgoingEffectiveBpm = fromBpm * liveCtrl.tempo;
              liveCtrl.deck.hpfSweep(SPACE_SWEEP_HPF_TARGET_HZ, SPACE_SWEEP_SWEEP_SECONDS);
              liveCtrl.deck.reverbWash(SPACE_SWEEP_REVERB_WET, SPACE_SWEEP_SWEEP_SECONDS);
              liveCtrl.deck.echoTail(
                outgoingEffectiveBpm,
                SPACE_SWEEP_ECHO_BEATS,
                SPACE_SWEEP_ECHO_FEEDBACK,
                SPACE_SWEEP_ECHO_WET,
                SPACE_SWEEP_ECHO_RING_SECONDS
              );
              recordFxFired();
            } else {
              void fxPlayerRef.current?.play(command.maskFx).then((success) => {
                if (success) recordFxFired();
              });
            }
          }
        },
        onTempoSet: (t) => idleCtrl.setTempoDirectly(t),
        onDone: (result: TransitionResult) => {
          pendingGapRef.current = null;
          markIncoming();
          pushBrainLog("transition", `${result.transition} completed — "${track.name}" is live`);
          liveCtrl.markPaused();
          // Safety reset (audio engine v2, Part 1) — filters/reverb ONLY,
          // deliberately NOT the echo send (NOT Deck.allNeutral(), which
          // also hard-stops it): a lingering HPF/LPF sweep or reverb wash
          // (e.g. from a maskFx "space_sweep") must never carry into
          // whatever track loads on this deck next, since both sit
          // permanently in the chain — but an in-flight echo_out tail is
          // SUPPOSED to keep ringing under the incoming track after this
          // deck retires (the whole point of the upgrade); it already
          // self-silences via echoTail()'s own internally-scheduled
          // ring-then-fade-out, so cutting it here would defeat the feature.
          //
          // Choir round #2 (C4): for the four "instant completion" kinds
          // (cut/echo_out/gap/loop_blend — maskFxSeamThreshold===1 above),
          // a fired maskFx's onGain(1) arm and this onDone reset happen in
          // the SAME synchronous tick/timeout callback — releasing right
          // here would cancel a just-armed ~1.5s sweep before it's ever
          // audible. Defer the release until the sweep's own ramp window
          // has elapsed for those kinds; the two blend kinds (whose maskFx
          // arms at the ramp's MIDPOINT, with real elapsed time left before
          // completion) keep releasing immediately, unchanged.
          clearPendingMaskFxRelease();
          if (maskFxFired && command.maskFx === "space_sweep" && needsDeferredMaskFxRelease(maskFxSeamThreshold)) {
            maskFxReleaseTimeoutRef.current = setTimeout(() => {
              maskFxReleaseTimeoutRef.current = null;
              liveCtrl.deck.filterRelease(0.05);
              liveCtrl.deck.reverbWash(0, 0.05);
            }, SPACE_SWEEP_SWEEP_SECONDS * 1000);
          } else {
            liveCtrl.deck.filterRelease(0.05);
            liveCtrl.deck.reverbWash(0, 0.05);
          }
          setTransitionRunning(false);

          // Owner soundcheck fix: the newly-live deck (idleLabel) may carry a
          // bent tempo from the sync above — start walking it back to 1.0.
          startTempoGlide(idleLabel);

          // Learning loop: every completed transition (any kind, including
          // "cut") is recorded so the human can rate it and future brain
          // calls see the pattern via lessons — see src/lib/lessons.ts.
          const record: TransitionRecord = {
            when: Date.now(),
            fromTrack: liveCtrl.trackName ?? liveCtrl.trackId ?? "unknown",
            toTrack: track.name,
            bpmFrom: liveCtrl.tags.bpm ?? null,
            bpmTo: idleCtrl.tags.bpm ?? null,
            clamped: result.clamped,
            degraded: result.degraded,
            transitionType: result.transition,
            durationBars: command.durationBars,
            rating: null,
            note: null,
            outPositionSeconds,
          };
          setTransitionRecords(appendTransitionRecord(record));

          if (result.degraded && result.degradeReason) {
            pushBrainLog("transition", `degraded: ${result.degradeReason}`);
          }
        },
      });

      if (!outcome.started) {
        pushBrainLog("error", `queue: ${outcome.reason}`);
        askedForTrackRef.current = null; // see the comment on the missing-track branch above
        releaseQueueInFlight();
        return;
      }

      markIncoming();
      setTransitionRunning(transitionEngineRef.current.isRunning);
      if (effectiveTransition === "gap" && transitionEngineRef.current.isRunning) {
        pendingGapRef.current = { trackId: track.id, command };
        pushBrainLog("transition", `full-song handoff armed — waiting for "${liveCtrl.trackName}" to end; incoming audio has not started`);
      }
      releaseQueueInFlight();
    }

    // Phrase-aligned firing (Part 2): "gap" already waits for the outgoing
    // track's own natural end (see transition.ts) — no extra delay needed,
    // fire the call now (it just arms the onEnded listener). Every other
    // kind is delayed to the live track's next 16-beat phrase boundary.
    if (effectiveTransition === "gap") {
      fireTransition();
      return;
    }

    const candidates = nextPhraseBoundaries(
      liveGrid ? { anchor: liveGrid.anchor, bpm: liveGrid.bpm } : null,
      liveCtrl.deck.positionSeconds,
      liveCtrl.tempo,
      PHRASE_CANDIDATE_COUNT,
      liveBpmTag
    ).filter((delay) => delay <= PHRASE_CANDIDATE_CAP_SECONDS);

    const requestedSeconds = residencyRequestRef.current?.seconds ?? null;
    if (requestedSeconds !== null && (residencyTimed || fullSongRequested)) {
      const wentLive = liveCtrl.wentLiveAtMs();
      const played = wentLive === null ? 0 : (Date.now() - wentLive) / 1000;
      const delay = residencyHandoffDelay(requestedSeconds, played, effectiveTransition,
        command.durationBars, fromBpm * liveCtrl.deck.tempo, candidates);
      pushBrainLog("queue", `${requestedSeconds}s residency — ${effectiveTransition} starts in ${delay.toFixed(1)}s into "${track.name}"`);
      if (delay <= 0) fireTransition();
      else pendingTransitionTimeoutRef.current = setTimeout(fireTransition, delay * 1000);
      return;
    }

    if (candidates.length === 0) {
      // No phrase boundary computable within the cap (no bpm/grid at all, or
      // the live track's phrase interval is longer than the cap) — fire
      // immediately, unchanged from pre-Part-2 behavior.
      fireTransition();
      return;
    }

    // Vocal-clash-aware pick (Part 1): only when BOTH tracks have a vocal
    // map — otherwise there's nothing to minimize against, so just take the
    // first (earliest) boundary. Choir round #2 (P8): also skipped for
    // "cut"/"echo_out" — neither kind has any real audio OVERLAP between
    // the two tracks (cut is instant; echo_out only briefly rings a delay
    // tail, never the incoming track simultaneously) — minimizing a
    // fictitious overlap there just burns up to PHRASE_CANDIDATE_CAP_SECONDS
    // of pointless delay for zero audible benefit. Phrase alignment (the
    // candidates themselves) still applies; only the vocal-overlap scoring
    // is skipped.
    const liveCueKey = cueKeyForLabel(liveLabel);
    const idleCueKey = cueTrackKey({ source: track.source, id: track.id, name: track.name, size: track.size });
    let delaySeconds = candidates[0];
    const vocalOverlapMatters = effectiveTransition !== "cut" && effectiveTransition !== "echo_out";
    if (vocalOverlapMatters && liveCueKey && hasVocalMap(VOCAL_MAPS, liveCueKey) && hasVocalMap(VOCAL_MAPS, idleCueKey)) {
      const effectiveLiveBpm = liveBpmTag ? liveBpmTag * liveCtrl.tempo : null;
      const blendSeconds = effectiveLiveBpm && effectiveLiveBpm > 0 ? (command.durationBars * 4 * 60) / effectiveLiveBpm : PHRASE_CANDIDATE_CAP_SECONDS;
      const incomingStartSeconds = idleCtrl.deck.positionSeconds;
      delaySeconds = pickTransitionStart(
        candidates,
        blendSeconds,
        getVocalIntervals(VOCAL_MAPS, liveCueKey),
        liveCtrl.deck.positionSeconds,
        getVocalIntervals(VOCAL_MAPS, idleCueKey),
        incomingStartSeconds,
        // Choir round #2 (P7): candidates are OUTPUT-time delays but the
        // live track's vocal intervals are SOURCE-time — pickTransitionStart
        // now converts internally (delay * liveTempo) when this is passed;
        // omitting it (elsewhere/in tests) keeps the old tempo~1 behavior.
        liveCtrl.tempo
      );
    }

    if (delaySeconds <= 0) {
      fireTransition();
    } else {
      pendingTransitionTimeoutRef.current = setTimeout(fireTransition, delaySeconds * 1000);
    }
  }

  /** `cooldownReason` is the resolved ROOT reason (see executeFxCommand's doc comment) — not the raw wire consultReason. */
  function executeCommand(command: Command, cooldownReason: ConsultReason) {
    const requestedId = command.action === "routine" ? command.queue.trackId : "trackId" in command ? command.trackId : null;
    const requestedTrack = requestedId ? resolveCommandTrack(requestedId) : null;
    if (requestedTrack && !genreAllowed(resolveMusicMetadata(requestedTrack).genre, genreRequestRef.current)) {
      pushBrainLog(command.action, `skipped — ${musicLabel(requestedTrack)} is outside your requested genres`);
      askedForTrackRef.current = null;
      return;
    }
    // Model prose is a request, not proof the executor has played anything.
    pushBrainLog(command.action === "none" ? "none" : "plan", command.action === "none" ? command.say ?? "No move requested" : `${command.action}: ${command.say ?? "requested"}`);
    switch (command.action) {
      case "queue": {
        void executeQueueCommand(command, !isHumanInitiated(cooldownReason));
        return;
      }
      case "tempo_nudge":
        executeTempoNudge(command);
        return;
      case "fx":
        executeFxCommand(command, cooldownReason);
        return;
      case "eq_sweep":
        executeEqSweepCommand(command);
        return;
      case "trance_breakdown":
        void executeStemMigrateCommand(command, cooldownReason);
        return;
      case "eq":
        executeEqCommand(command);
        return;
      case "loop":
        void executeLoopCommand(command, cooldownReason);
        return;
      case "routine":
        void executeRoutineCommand(command, cooldownReason);
        return;
      case "stem_migrate":
        void executeStemMigrateCommand(command, cooldownReason);
        return;
      case "none":
        return;
    }
  }

  // --- Calling the brain (Part C+D) ---

  function handleAutopilotFailure(originalMessage: string | null, reason: ConsultReason) {
    if (!autopilotRef.current) return;
    const liveLabel = getLiveDeckLabel();
    const liveState = liveLabel ? deckLiveState(deckByLabel(liveLabel)) : historyRef.current.at(-1) ?? null;
    if (liveState && tryExecuteLocalAutopilotRecipe(liveState, true)) {
      retryStageRef.current = 0;
      cancelFollowUp();
      if (retryTimeoutHandleRef.current) clearTimeout(retryTimeoutHandleRef.current);
      retryTimeoutHandleRef.current = null;
      return;
    }
    if (retryStageRef.current === 0) {
      retryStageRef.current = 1;
      pushBrainLog("recovery", "no eligible local handoff — retrying the selected model in 10 seconds");
      retryTimeoutHandleRef.current = setTimeout(() => {
        retryTimeoutHandleRef.current = null;
        if (autopilotRef.current) void callBrain(originalMessage, { autopilotDriven: true, consultReason: reason });
      }, AUTOPILOT_RETRY_DELAY_MS);
    } else {
      retryStageRef.current = 0;
      setAutopilot(false);
      pushBrainLog("error", "autopilot stopped — the retry also failed and no eligible local handoff was available");
    }
  }

  // --- Deferred re-consult (owner soundcheck fix, 2026-07-26) ---
  // followUpSeconds on a brain response ("re-consult me in N seconds") is the
  // mechanism that makes a timed instruction ("30 more seconds then
  // transition") actually execute instead of dying after the acknowledgment.
  // Single pending slot: a new user chat, a new followUp from a later
  // response, or toggling autopilot off cancels any pending one.
  function cancelFollowUp() {
    if (followUpTimeoutRef.current) {
      clearTimeout(followUpTimeoutRef.current);
      followUpTimeoutRef.current = null;
    }
    if (followUpRetryTimeoutRef.current) {
      clearTimeout(followUpRetryTimeoutRef.current);
      followUpRetryTimeoutRef.current = null;
    }
    followUpRootReasonRef.current = null;
  }

  function fireFollowUp() {
    followUpTimeoutRef.current = null;
    checkQueueWatchdog();
    if (queueInFlightRef.current || transitionEngineRef.current.isRunning || heldLoopRef.current || migrationRef.current) {
      // Keep the original follow-up root, but wait locally rather than paying
      // a model to say "still pending". This timer is canceled by Stop/new chat.
      followUpTimeoutRef.current = setTimeout(fireFollowUp, FOLLOW_UP_BUSY_RETRY_MS);
      return;
    }
    if (brainBusyRef.current) {
      followUpRetryTimeoutRef.current = setTimeout(() => {
        followUpRetryTimeoutRef.current = null;
        if (brainBusyRef.current) {
          pushBrainLog("error", "follow-up dropped — brain still busy");
          return;
        }
        fireFollowUp();
      }, FOLLOW_UP_BUSY_RETRY_MS);
      return;
    }
    pushBrainLog("none", "El Cerebro checking back now…");
    void callBrain(null, { consultReason: "follow_up" });
  }

  /** `rootReason` is the ORIGIN of this follow-up chain — never "follow_up" itself (see the cooldown-classification note on followUpRootReasonRef above). */
  function scheduleFollowUp(seconds: number, rootReason: ConsultReason) {
    cancelFollowUp(); // single pending slot — latest wins (also clears the prior root)
    followUpRootReasonRef.current = rootReason;
    pushBrainLog("none", `El Cerebro checking back in ${seconds}s…`);
    followUpTimeoutRef.current = setTimeout(fireFollowUp, seconds * 1000);
  }

  async function callBrain(
    message: string | null,
    options: { autopilotDriven?: boolean; consultReason: ConsultReason }
  ) {
    if (options.consultReason !== "user_chat" &&
        (queueInFlightRef.current || transitionEngineRef.current.isRunning || heldLoopRef.current || migrationRef.current)) return;
    if (brainBusyRef.current) return;
    brainBusyRef.current = true;
    setBrainBusy(true);
    // Adversarial-review fix: resolve THIS call's effective (root) reason for
    // local cooldown classification — a "follow_up" wire reason inherits the
    // chain's root (set by whichever scheduleFollowUp call led here); if the
    // root was cleared (cancelFollowUp ran while this request was in
    // flight), fail closed to the floored classification rather than
    // assuming human origin.
    const cooldownReason: ConsultReason = resolveCooldownReason(options.consultReason, followUpRootReasonRef.current);
    const automatic = !!options.autopilotDriven || !isHumanInitiated(cooldownReason);
    const controlVersion = performanceControlVersionRef.current;
    const requestLiveLabel = getLiveDeckLabel();
    const requestLiveId = requestLiveLabel ? deckByLabel(requestLiveLabel).trackId : null;
    const requestAborter = new AbortController();
    let localHandoffStarted = false;
    let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
    const stillAuthorized = () => controlVersion === performanceControlVersionRef.current && (!automatic || autopilotRef.current);
    try {
      // Cost addendum (2026-07-26): build the FULL compact crate (rebuilds
      // the index map), then window it against the live effective BPM (+
      // vibe-note name matches + a wildcard sample) — a windowed slice is
      // per-call and NOT cache-eligible; the full list (nothing live) is
      // stable and IS.
      const fullCrate = buildFullCompactCrate();
      const window = buildCrateWindow({
        entries: fullCrate,
        liveEffectiveBpm: liveEffectiveBpmForWindow(),
        vibeNoteText: lastVibeNoteRef.current?.text ?? null,
        genreRequest: genreRequestRef.current,
      });

      // Lesson ledger (2026-07-28): distill against the STABLE real crate
      // ids (what ledger events were recorded against) so an event from an
      // earlier session still correlates correctly, then remap perTrack's
      // keys to THIS call's ephemeral index-based trackId — the id space
      // the brain actually operates in (see CompactCrateEntry's own doc
      // comment: trackId is the stringified index n, never the real id).
      const candidateTracks: { n: number; id: string; name: string }[] = [];
      for (const entry of window.entries) {
        const stableId = crateIndexMapRef.current.get(entry.n);
        if (stableId) candidateTracks.push({ n: entry.n, id: stableId, name: entry.t });
      }
      const rawLedgerDigest = distillForBrain(ledgerEventsRef.current, candidateTracks);
      const perTrackByIndex: Record<string, string[]> = {};
      for (const { n, id } of candidateTracks) {
        const lines = rawLedgerDigest.perTrack[id];
        if (lines) perTrackByIndex[String(n)] = lines;
      }
      const ledgerDigest = { global: rawLedgerDigest.global, perTrack: perTrackByIndex };

      // A cloud planner cannot own the final seconds of the song. After a
      // bounded wait, use an eligible precomputed handoff. Aborting the client
      // also prevents a late plan from acting on a deck that has since changed.
      // The provider may have incurred usage before cancellation: mark unpriced.
      if (automatic && requestLiveId) recoveryTimer = setTimeout(() => {
        if (!stillAuthorized()) return;
        const currentLabel = getLiveDeckLabel();
        if (currentLabel && deckByLabel(currentLabel).trackId !== requestLiveId) return;
        if (!tryExecuteLocalAutopilotRecipe({ trackId: requestLiveId }, true)) return;
        localHandoffStarted = true;
        retryStageRef.current = 0;
        cancelFollowUp();
        setUnpricedCalls(prev => {
          const next = prev + 1;
          try { localStorage.setItem("djsm.unpriced-brain-calls", String(next)); } catch { /* best effort */ }
          return next;
        });
        requestAborter.abort();
      }, 15000);
      pushBrainLog("request", `${modelOptions.find(option => option.id === selectedModelRef.current)?.label ?? selectedModelRef.current}: waiting for a DJ plan…`);
      const response = await fetchWithPasscode("/api/dj", {
        method: "POST",
        signal: requestAborter.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brainModel: selectedModelRef.current,
          message,
          state: buildDjState(options.consultReason),
          crate: window.entries,
          crateCacheable: !window.windowed,
          lessons: summarizeLessons(transitionRecordsRef.current),
          ledger: ledgerDigest,
        }),
      });

      let json: { command?: unknown; error?: string; cost_usd?: number | null; model?: string; latency_ms?: number } | null = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }

      if (localHandoffStarted) return;
      if (!response.ok || !json || json.error) {
        const errMsg = json?.error || `brain call failed (HTTP ${response.status})`;
        pushBrainLog("error", errMsg);
        if (automatic && stillAuthorized()) handleAutopilotFailure(message, options.consultReason);
        return;
      }

      // Defense in depth: the route already validates before responding,
      // but the executor treats anything that fails local validation as a
      // no-op with an honest log line rather than trusting the wire.
      const parsed = CommandSchema.safeParse(json.command);
      if (!parsed.success) {
        pushBrainLog("none", "(brain reply failed local validation — treated as no-op)");
        if (automatic && stillAuthorized()) handleAutopilotFailure(message, options.consultReason);
        return;
      }

      // Provider-specific accounting: valid responses (including refusals)
      // may carry usage. Unknown usage is visibly unpriced, never counted free.
      if (typeof json.model === "string") setLastModel(json.model);
      setLastLatency(typeof json.latency_ms === "number" ? json.latency_ms : null);
      if (typeof json.cost_usd === "number" && Number.isFinite(json.cost_usd)) {
        const callCost = json.cost_usd;
        setLastCost(callCost);
        setCostTotal((prev) => {
          const next = prev + callCost;
          saveCostTotal(next);
          return next;
        });
      } else {
        setLastCost(null);
        setUnpricedCalls(prev => {
          const next = prev + 1;
          try { localStorage.setItem("djsm.unpriced-brain-calls", String(next)); } catch { /* best effort */ }
          return next;
        });
      }
      pushBrainLog("model", `${json.model ?? selectedModelRef.current} returned ${parsed.data.action}`);

      const currentLabel = getLiveDeckLabel();
      const currentId = currentLabel ? deckByLabel(currentLabel).trackId : null;
      if (localHandoffStarted || !stillAuthorized() || (currentId !== null && currentId !== requestLiveId)) {
        pushBrainLog("plan", "discarded stale response — playback or automation changed while the model was thinking");
        return;
      }

      retryStageRef.current = 0; // a successful round-trip resets the retry ladder
      localRecipeMovesSinceBrainRef.current = 0;
      executeCommand(parsed.data, cooldownReason);
      // Deferred re-consult: honor followUpSeconds from ANY response
      // (chat-initiated or autopilot-initiated) — this does not itself
      // cancel a pending follow-up scheduled by an earlier response; only
      // a new chat, a new followUp, or autopilot-off do that (see
      // scheduleFollowUp/cancelFollowUp). Re-schedule inherits cooldownReason
      // (the resolved root), not options.consultReason, so a follow_up chain
      // never loses/mutates its root.
      // stem_migrate is the one command with no followUpSeconds field (schema
      // optional-param limit); it re-consults on its own completion instead.
      // A routine's follow-up starts only after the actual audio handoff, not
      // while it is preparing/playing or after its plan was rejected.
      const followUp = parsed.data.action !== "routine" && "followUpSeconds" in parsed.data ? parsed.data.followUpSeconds : undefined;
      if (typeof followUp === "number") {
        scheduleFollowUp(followUp, cooldownReason);
      }
    } catch (err) {
      if (localHandoffStarted) {
        pushBrainLog("recovery", "slow model request abandoned; local handoff owns playback and a late reply cannot interrupt it");
        return;
      }
      const errMsg = err instanceof Error ? err.message : "network error contacting the brain";
      pushBrainLog("error", errMsg);
      if (automatic && stillAuthorized()) handleAutopilotFailure(message, options.consultReason);
    } finally {
      if (recoveryTimer) clearTimeout(recoveryTimer);
      brainBusyRef.current = false;
      setBrainBusy(false);
    }
  }

  /**
   * FX/vocal-clip warm-up (scope addendum): both players lazy-load a clip
   * only on its first fire — if wifi dies before that, the clip is dead for
   * the rest of the set. Total asset weight is small (~2MB, 7 stingers + 32
   * vocal clips), so eagerly fetching+decoding everything ahead of time is
   * cheap. Bounded concurrency (preloadAll's own default), fire-and-forget
   * (never awaited by a caller — toggling autopilot must not wait on this).
   * One brain-log line on completion, another if anything failed.
   */
  async function handleWarmUpFx() {
    if (fxWarmingRef.current) return;
    fxWarmingRef.current = true;
    setFxWarmingUp(true);
    try {
      const [fxResult, vocalResult] = await Promise.all([
        fxPlayerRef.current!.preloadAll(),
        vocalPlayerRef.current!.preloadAll(vocalManifest),
      ]);
      const loadedCount = fxResult.loaded.length + vocalResult.loaded.length;
      pushBrainLog("fx", `FX warmed: ${loadedCount} clip(s) ready`);
      const failed = [...fxResult.failed, ...vocalResult.failed];
      if (failed.length > 0) {
        pushBrainLog("error", `FX warm-up: ${failed.length} clip(s) failed to load (${failed.join(", ")})`);
      }
    } finally {
      fxWarmingRef.current = false;
      setFxWarmingUp(false);
    }
  }

  function handleToggleAutopilot() {
    // Read BEFORE the toggle, not inside setAutopilot's updater — that
    // updater's execution timing relative to this function's return isn't
    // guaranteed, but autopilotRef.current is always the pre-toggle value
    // here (kept in sync every render, same pattern as every other *Ref
    // mirror in this component).
    const turningOn = !autopilotRef.current;
    stopStemMixerRef.current?.();
    // Stopping automation invalidates its pending performance preparations.
    if (!turningOn) {
      performanceControlVersionRef.current += 1;
      teardownMigration();
      cleanupHeldLoopAndRoutine("autopilot stopped");
      queuePreparationRef.current?.abort(new Error("Autopilot stopped"));
      cancelPendingTransitionStart();
      if (pendingGapRef.current || transitionEngineRef.current.isRunning) {
        transitionEngineRef.current.cancel();
        pendingGapRef.current = null;
        setTransitionRunning(false);
      }
      purgeMasterBus();
      enforceSingleLiveDeck();
    } else {
      enforceSingleLiveDeck();
    }
    setAutopilot((prev) => {
      const next = !prev;
      if (next) {
        // This tap is the user gesture that unlocks the shared AudioContext
        // for every subsequent brain-driven (non-gesture) play() call.
        coreRef.current?.ensureContext();
        askedForTrackRef.current = null;
        retryStageRef.current = 0;
        // Set arc / anthem residency (Part 4): stamp the party's start the
        // FIRST time autopilot ever turns on (persisted — see
        // party-store.ts's own doc comment on why toggling off/on again
        // deliberately does NOT reset this).
        if (partyStartMsRef.current === null) {
          partyStartMsRef.current = Date.now();
          savePartyStartMs(partyStartMsRef.current);
        }
      } else {
        if (retryTimeoutHandleRef.current) {
          clearTimeout(retryTimeoutHandleRef.current);
          retryTimeoutHandleRef.current = null;
        }
        // Turning autopilot off cancels any pending deferred re-consult too.
        cancelFollowUp();
      }
      return next;
    });
    // Background, non-blocking — autopilot starts immediately either way;
    // this just makes sure FX/vocal clips are ready before they're needed.
    if (turningOn) void handleWarmUpFx();
  }

  function handleSeekLive(deltaSeconds: number) {
    coreRef.current?.ensureContext();
    const label = getLiveDeckLabel();
    const ctrl = label
      ? deckByLabel(label)
      : deckA.trackName
        ? deckA
        : deckB.trackName
          ? deckB
          : null;
    if (!ctrl || !ctrl.trackName) return;
    const duration = ctrl.deck.duration;
    const current = ctrl.deck.positionSeconds;
    const target = Math.max(0, Math.min(duration > 0 ? duration - 1 : current + deltaSeconds, current + deltaSeconds));
    ctrl.deck.seekTo(target);
    pushBrainLog(
      "seek",
      `Deck ${ctrl === deckA ? "A" : "B"} ${deltaSeconds >= 0 ? "⏩" : "⏪"} ${deltaSeconds >= 0 ? `+${deltaSeconds}s` : `${deltaSeconds}s`} → ${formatMmSs(target)}`
    );
  }

  function handleJumpToBeat(forLabel?: DeckLabel) {
    coreRef.current?.ensureContext();
    const label =
      forLabel ??
      getLiveDeckLabel() ??
      (deckA.trackName ? "A" : deckB.trackName ? "B" : null);
    if (!label) return;
    const ctrl = deckByLabel(label);
    if (!ctrl.trackName) return;
    const current = ctrl.deck.positionSeconds;
    const duration = ctrl.deck.duration;
    const track = ctrl.trackId ? crateRef.current.find((t) => t.id === ctrl.trackId) : null;
    const midEntry = track ? midTrackEntryFor(track, 90, 16) : null;
    const beatIn = beatInFor(ctrl.trackId);
    const mixIn = ctrl.mixPoints?.mixInSeconds ?? 0;
    const cueKey = label === "A" ? cueKeyARef.current : cueKeyBRef.current;
    const loopPts = cueKey ? getLoopPoints(CURRENT_LOOP_POINTS, cueKey) : undefined;
    const drops = (loopPts?.drops ?? [])
      .map((d) => d.atSeconds)
      .filter((s) => Number.isFinite(s) && s > 2);

    // 1. If we're still in the intro before the hot mid-track entry / beat-in, jump straight to it:
    const entryCandidates = [
      midEntry?.seconds ?? 0,
      beatIn ?? 0,
      mixIn,
      drops[0] ?? 0,
    ].filter((s) => s > 4 && (duration <= 0 || s < duration - 15));
    const hotEntry = entryCandidates.length > 0 ? Math.max(...entryCandidates) : 25;

    let target: number;
    let reason: string;
    if (current + 3 < hotEntry) {
      target = hotEntry;
      reason = midEntry?.reason ?? "skipped slow intro to main beat / drop";
    } else {
      // Already past the first entry — jump to the next drop if available, otherwise +25s
      const nextDrop = drops.find((d) => d > current + 4 && (duration <= 0 || d < duration - 12));
      if (nextDrop !== undefined) {
        target = nextDrop;
        reason = "jumped to next drop";
      } else {
        target = Math.min(duration > 0 ? Math.max(0, duration - 10) : current + 25, current + 25);
        reason = "fast-forwarded +25s past intro/breakdown";
      }
    }
    ctrl.deck.seekTo(target);
    pushBrainLog("seek", `🔥 Deck ${label} → ${formatMmSs(target)} (${reason})`);
  }

  function handleSkipToNextSong(instantCut: boolean) {
    coreRef.current?.ensureContext();
    stopStemMixerRef.current?.();
    const liveLabel = getLiveDeckLabel();
    const liveCtrl = liveLabel ? deckByLabel(liveLabel) : null;
    const liveId = liveCtrl?.trackId ?? null;

    // Cancel any in-flight preparation, pending transition, or active transition engine
    performanceControlVersionRef.current += 1;
    queuePreparationRef.current?.abort(new Error("Skipped to next song"));
    queuePreparationRef.current = null;
    cancelPendingTransitionStart();
    teardownMigration();
    cleanupHeldLoopAndRoutine("skipped to next song");
    transitionEngineRef.current.cancel();
    pendingGapRef.current = null;
    setTransitionRunning(false);
    queueInFlightRef.current = false;
    askedForTrackRef.current = null;
    lastPerformanceAtRef.current = null;
    purgeMasterBus();

    if (instantCut) {
      // Immediately silence BOTH decks so the next track cuts in cleanly with zero overlap!
      for (const ctrl of [deckARef.current, deckBRef.current]) {
        if (ctrl.deck.playing) ctrl.deck.pause();
        ctrl.markPaused();
        ctrl.deck.allNeutral();
        ctrl.deck.clearAllDucks();
      }
    } else if (liveLabel) {
      // Ensure the non-live deck is paused before queuing the mix-in so two tracks never overlap
      enforceSingleLiveDeck(liveLabel);
    }

    // Standard autopilot / crate skip
    if (!instantCut && liveId && tryExecuteLocalAutopilotRecipe({ trackId: liveId })) {
      pushBrainLog("skip", "⏭️ Manual Next Song — triggered immediate transition into next track");
      return;
    }

    // Pick a high-compatibility next track from the crate (respecting any active genre request)
    const crate = crateRef.current;
    if (crate.length === 0) return;
    const recentIds = new Set(historyRef.current.map((r) => r.trackId));
    if (liveId) recentIds.add(liveId);
    const genreFilter = genreRequestRef.current;
    let pool = crate.filter(
      (t) => !recentIds.has(t.id) && (PLAYBACK_MANIFEST.get(t.id)?.durationSeconds ?? 180) >= 60
    );
    if (genreFilter) {
      const genreMatches = pool.filter((t) => genreAllowed(resolveMusicMetadata(t).genre, genreFilter));
      if (genreMatches.length > 0) pool = genreMatches;
    }
    if (pool.length === 0) {
      pool = crate.filter((t) => t.id !== liveId);
    }
    const chosen = pool[Math.floor(Math.random() * pool.length)] ?? crate[0];
    if (!chosen) return;
    const chosenIndex = crateIndexForTrackId(chosen.id);

    pushBrainLog(
      "skip",
      instantCut
        ? `⚡ Cut straight to "${chosen.name}" (hot lead-in)`
        : `⏭️ Mixing immediately into "${chosen.name}"`
    );
    executeCommand(
      {
        action: "queue",
        trackId: chosenIndex !== null ? String(chosenIndex) : chosen.id,
        startAt: "auto",
        transition: instantCut ? "cut" : "bass_swap",
        durationBars: instantCut ? 1 : 4,
      },
      "user_chat"
    );
  }

  function handleChatSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = chatInput.trim();
    if (!trimmed) return;
    coreRef.current?.ensureContext(); // this submit is a user gesture too
    lastVibeNoteRef.current = { text: trimmed, at: Date.now() }; // persists into every later call's state.lastVibeNote, not just this one
    const genreRequest = parseGenreRequest(trimmed);
    if (genreRequest) genreRequestRef.current = genreRequest;
    if (requestsPerformanceMix(trimmed)) performanceMixRef.current = true;
    if (/\b(no|without|avoid|stop)\s+(stems?|loops?|mixing|blending)\b|\bfull songs?\b/i.test(trimmed)) performanceMixRef.current = false;
    // M7 blocker fix: pull any explicit residency instruction out of this
    // note. applyResidencyParse keeps the standing request when the note
    // says nothing about residency — "more salsa" must not silently cancel
    // "30 seconds of a song".
    residencyRequestRef.current = applyResidencyParse(residencyRequestRef.current, parseResidencyRequest(trimmed));
    if (!autopilotRef.current && (residencyRequestRef.current || genreRequest || performanceMixRef.current)) {
      autopilotRef.current = true;
      setAutopilot(true);
      void handleWarmUpFx();
    }
    // A newly requested short showcase must also release an already-armed
    // full-song wait, not just change what the next model request says.
    const pendingGap = pendingGapRef.current;
    if (pendingGap && residencyRequestRef.current) {
      transitionEngineRef.current.cancel();
      pendingGapRef.current = null;
      setTransitionRunning(false);
      const index = crateIndexForTrackId(pendingGap.trackId);
      if (index !== null) void executeQueueCommand({ ...pendingGap.command, trackId: String(index) });
    }
    recordLedgerEvent({ type: "vibe_note", when: new Date().toISOString(), text: trimmed, ...liveTrackContextForLedger() });
    cancelFollowUp(); // a new user chat supersedes any pending deferred re-consult
    setChatInput("");
    void callBrain(trimmed, { consultReason: "user_chat" });
  }

  // --- FX pad + scratch buttons (M4 Part C) ---

  function handlePlayFx(name: SfxName) {
    coreRef.current?.ensureContext(); // this tap is a user gesture too
    // recordFxFired() only on actual playback success (review-panel fix —
    // manual taps used to burn the cooldown even when the clip failed to load).
    // recordFxDemonstration() too (scope addendum) — this is a genuinely
    // MANUAL pad tap, exactly the signal the demonstration log wants.
    void fxPlayerRef.current?.play(name).then((success) => {
      if (success) {
        recordFxFired();
        recordFxDemonstration(name);
        recordLedgerFx(name, "manual");
      }
    });
  }

  function handleScratchButton(pattern: ScratchPattern) {
    if (migrationRef.current || migrationPreparingRef.current) return;
    coreRef.current?.ensureContext();
    const liveLabel = getLiveDeckLabel();
    if (!liveLabel) return; // button is already disabled in this state; defensive no-op
    const started = scratch(deckByLabel(liveLabel).deck, coreRef.current!, pattern, (deckByLabel(liveLabel).tags.bpm ?? NEUTRAL_BPM_FALLBACK) * deckByLabel(liveLabel).deck.tempo);
    if (started) {
      recordFxFired();
      recordFxDemonstration(`scratch_${pattern}`);
      recordLedgerFx(`scratch_${pattern}`, "manual");
    }
  }

  /** Audio engine v2, Part 2 (beat rolls) — manual pad handler, mirrors handleScratchButton's duck-overlay shape exactly. `bpm` is the live deck's TAGGED bpm (fireRoll needs it, same convention as every other bpm-aware Deck-adjacent call in this file); an untagged live track falls back to NEUTRAL_BPM_FALLBACK so the roll still fires (at a guessed tempo) rather than silently doing nothing. */
  function handleRollButton(fx: RollFxName) {
    if (migrationRef.current || migrationPreparingRef.current) return;
    coreRef.current?.ensureContext();
    const liveLabel = getLiveDeckLabel();
    if (!liveLabel) return; // button is already disabled with no live deck; defensive no-op
    const liveCtrl = deckByLabel(liveLabel);
    const bpm = liveCtrl.tags.bpm ?? NEUTRAL_BPM_FALLBACK;
    const started = fireRoll(liveCtrl.deck, coreRef.current!, bpm, ROLL_SUBDIVISION_BY_FX[fx]);
    if (started) {
      recordFxFired();
      recordFxDemonstration(fx);
      recordLedgerFx(fx, "manual");
    }
  }

  function handlePlayVocal(category: VocalCategory) {
    coreRef.current?.ensureContext(); // this tap is a user gesture too
    // demonstrate=true — a manual pad tap, so playVocalCategory also logs a
    // fx-demonstration entry on success (recordFxFired() happens inside its
    // onResult too, success-only, unchanged).
    playVocalCategory(category, true);
  }

  const [autoTurntablistFx, setAutoTurntablistFx] = useState(false);
  const autoTurntablistFxRef = useRef(false);
  autoTurntablistFxRef.current = autoTurntablistFx;
  const mashupPresetCursorRef = useRef(0);

  const [stemMixerState, setStemMixerState] = useState<{
    playing: boolean;
    bpm: number | null;
    title: string | null;
  }>({ playing: false, bpm: null, title: null });

  function handlePlayVocalFile(file: string) {
    coreRef.current?.ensureContext();
    const decks = [deckARef.current.deck, deckBRef.current.deck];
    const meta = PAISA_VOCAL_LABELS[file];
    vocalPlayerRef.current?.playFile(file, decks, {
      isTransitionRunning: () => transitionEngineRef.current.isRunning || Boolean(migrationRef.current),
      onResult: (success) => {
        if (success) {
          pushBrainLog("vocal", `🇨🇴 Paisa Vocal: ${meta ? meta.phrase : file} (${file})`);
          recordFxFired();
          recordFxDemonstration(`vocal:${file}`);
        }
      },
    });
  }

  function handleFireTurntablistCombo(comboId: string) {
    coreRef.current?.ensureContext();
    const liveLabel = getLiveDeckLabel();
    const liveCtrl = liveLabel ? deckByLabel(liveLabel) : null;
    const bpm = liveCtrl?.tags.bpm ?? 100;

    if (comboId === "club_riser_cryo_zapateo") {
      pushBrainLog("combo", "🌪️ 4-Stage Combo: Club Riser → Crash Swell + ⅛ Roll → CO2 Cryo Jet → ¡Fuego!");
      if (liveCtrl) fireRoll(liveCtrl.deck, coreRef.current!, bpm, ROLL_SUBDIVISION_BY_FX.roll_quarter);
      void fxPlayerRef.current?.play("riser");
      setTimeout(() => {
        void fxPlayerRef.current?.play("crash");
        if (liveCtrl) fireRoll(liveCtrl.deck, coreRef.current!, bpm, ROLL_SUBDIVISION_BY_FX.roll_eighth);
      }, 950);
      setTimeout(() => {
        void fxPlayerRef.current?.play("cryo_jet");
        void fxPlayerRef.current?.play("horn_stab");
      }, 2100);
      setTimeout(() => {
        handlePlayVocalFile("drop-fuego-laser.mp3");
      }, 2850);
      return;
    }

    if (comboId === "turntablist_chirp_spinback_808") {
      pushBrainLog("combo", "🎛️ 4-Stage Combo: ⅛ Roll → Chirp Scratch + Rewind → 808 Booyaka → Puro Cerebro!");
      if (liveCtrl) fireRoll(liveCtrl.deck, coreRef.current!, bpm, ROLL_SUBDIVISION_BY_FX.roll_eighth);
      setTimeout(() => {
        if (liveCtrl) scratch(liveCtrl.deck, coreRef.current!, "chirp", bpm * liveCtrl.deck.tempo);
        void fxPlayerRef.current?.play("rewind");
      }, 650);
      setTimeout(() => {
        void fxPlayerRef.current?.play("booyaka");
        void fxPlayerRef.current?.play("dub_siren");
      }, 1550);
      setTimeout(() => {
        handlePlayVocalFile("drop-purocerebro-laser.mp3");
      }, 2350);
      return;
    }

    if (comboId === "dub_siren_horn_stab_wepa") {
      pushBrainLog("combo", "🇯🇲 4-Stage Combo: Dub Siren → Rewind Spin → Brass Horn Stab → ¡Wepa!");
      void fxPlayerRef.current?.play("dub_siren");
      setTimeout(() => {
        void fxPlayerRef.current?.play("rewind");
      }, 750);
      setTimeout(() => {
        void fxPlayerRef.current?.play("horn_stab");
        void fxPlayerRef.current?.play("subdrop");
      }, 1550);
      setTimeout(() => {
        handlePlayVocalFile("adlib-wepa.mp3");
      }, 2200);
      return;
    }

    if (comboId === "sonero_clean_handoff") {
      pushBrainLog("combo", "🌴 Social-Dance Sonero Stamp: Warm Cue ('Con calma, que la noche es joven')");
      handlePlayVocalFile("cue-suave-warm.mp3");
      return;
    }

    // Default: latin_timbale_subdrop_perreo
    pushBrainLog("combo", "🥁 4-Stage Combo: ¼ Roll + Dub Siren → Tito Timbale Fill → 808 Sub Drop → ¡No Pare La Fiesta!");
    if (liveCtrl) fireRoll(liveCtrl.deck, coreRef.current!, bpm, ROLL_SUBDIVISION_BY_FX.roll_quarter);
    void fxPlayerRef.current?.play("dub_siren");
    setTimeout(() => {
      void fxPlayerRef.current?.play("timbale");
    }, 650);
    setTimeout(() => {
      void fxPlayerRef.current?.play("subdrop");
      void fxPlayerRef.current?.play("horn_stab");
    }, 1750);
    setTimeout(() => {
      handlePlayVocalFile("tag2-nopare.mp3");
    }, 2500);
  }

  function handleLoadVipToDeck(trackId: string) {
    coreRef.current?.ensureContext();
    const found = crateRef.current.find((t) => t.id === trackId);
    if (found) {
      pushBrainLog("crate", `⚡ Loading Studio 4-Stem VIP "${musicLabel(found)}" to Deck…`);
      handleCrateTap(found);
      return;
    }
    const manifestEntry = (crateManifestJson as CrateManifestEntry[]).find((m) => m.id === trackId);
    if (!manifestEntry) return;
    const tempTrack: CrateTrack = {
      id: manifestEntry.id,
      name: manifestEntry.name,
      ...resolveMusicMetadata(manifestEntry),
      size: manifestEntry.size ?? null,
      bpm: manifestEntry.bpm ?? null,
      key: manifestEntry.key ?? null,
      grid: manifestEntry.grid ?? null,
      source: "drive",
    };
    pushBrainLog("crate", `⚡ Loading Studio 4-Stem VIP "${musicLabel(tempTrack)}" to Deck…`);
    handleCrateTap(tempTrack);
  }

  function handlePickHarmonicNext(targetTrackId: string, comboId: string) {
    coreRef.current?.ensureContext();
    const idx = crateIndexForTrackId(targetTrackId);
    const target = crateRef.current.find((t) => t.id === targetTrackId);
    if (idx === null || !target) {
      handleLoadVipToDeck(targetTrackId);
      return;
    }
    const liveLabel = getLiveDeckLabel();
    if (!liveLabel) {
      handleCrateTap(target);
      if (autoTurntablistFxRef.current) {
        setTimeout(() => handleFireTurntablistCombo(comboId), 1200);
      }
      return;
    }
    const liveCtrl = deckByLabel(liveLabel);
    const liveGrid = effectiveGrid(liveCtrl.tags, liveCtrl.grid);
    const inGrid = (crateManifestJson as CrateManifestEntry[]).find((t) => t.id === target.id)?.grid ?? target.grid;
    const isSocial = isPartnerDanceTrack(target) && !performanceMixRef.current;
    const canMashup =
      !isSocial &&
      stemEntryFor(liveCtrl.trackId) !== null &&
      stemEntryFor(target.id) !== null &&
      liveGrid !== null &&
      !liveGrid.estimated &&
      inGrid !== null &&
      Math.abs(liveCtrl.deck.tempo - 1) <= 0.06 &&
      Math.abs((liveGrid.bpm * liveCtrl.deck.tempo) / inGrid.bpm - 1) <= 0.05;

    pushBrainLog(
      "plan",
      `🧠 Music Theory Master queuing #1 harmonic match "${musicLabel(target)}" (${target.bpm ?? "—"} BPM · ${toCamelot(target.key) ?? "—"})${canMashup ? " via 16-bar Live Stem Mashup" : ""}`
    );
    if (autoTurntablistFxRef.current && !isSocial && !canMashup) {
      handleFireTurntablistCombo(comboId);
    }
    if (canMashup) {
      executeCommand(
        {
          action: "stem_migrate",
          trackId: String(idx),
          bars: 16,
          anchor: "out",
          say: `Music Theory Master: 16-bar live stem mashup into ${musicLabel(target)}`,
        },
        "user_chat"
      );
      return;
    }
    executeCommand(
      {
        action: "queue",
        trackId: String(idx),
        transition: isSocial ? "gap" : "bass_swap",
        durationBars: isSocial ? 8 : 4,
        startAt: isSocial ? "beginning" : "auto",
        say: `Music Theory Master: mixing into ${musicLabel(target)}`,
      },
      "user_chat"
    );
  }

  function ensureTrackInCrate(trackId: string): { track: CrateTrack; index: number } | null {
    const existingIdx = crateIndexForTrackId(trackId);
    if (existingIdx !== null) {
      return { track: crateRef.current[existingIdx], index: existingIdx };
    }
    const manifestEntry = (crateManifestJson as CrateManifestEntry[]).find((m) => m.id === trackId);
    if (!manifestEntry) return null;
    const added: CrateTrack = {
      id: manifestEntry.id,
      name: manifestEntry.name,
      ...resolveMusicMetadata(manifestEntry),
      size: manifestEntry.size ?? null,
      bpm: manifestEntry.bpm ?? null,
      key: manifestEntry.key ?? null,
      grid: manifestEntry.grid ?? null,
      source: "drive",
    };
    const nextCrate = [...crateRef.current, added];
    crateRef.current = nextCrate;
    setCrate(nextCrate);
    return { track: added, index: nextCrate.length - 1 };
  }

  function handleStartPairMashup(beatTrackId: string, vocalTrackId: string, bars: 16 | 32 | 64 = 64) {
    coreRef.current?.ensureContext();
    stopStemMixerRef.current?.();
    genreRequestRef.current = null; // explicit mashup button overrides any stale chat genre filter

    const beatResolved = ensureTrackInCrate(beatTrackId);
    const vocalResolved = ensureTrackInCrate(vocalTrackId);
    if (!beatResolved || !vocalResolved) {
      pushBrainLog("error", "mashup: could not resolve selected tracks in crate manifest");
      return;
    }

    const liveLabel = getLiveDeckLabel();
    const liveCtrl = liveLabel ? deckByLabel(liveLabel) : null;
    if (
      liveLabel &&
      liveCtrl &&
      liveCtrl.trackId === beatResolved.track.id &&
      liveCtrl.deck.playing &&
      !queueInFlightRef.current &&
      !transitionEngineRef.current.isRunning &&
      !migrationRef.current &&
      !migrationPreparingRef.current &&
      !heldLoopRef.current
    ) {
      pushBrainLog(
        "stem_migrate",
        `🔥 Launching ${bars}-Bar Mashup: "${musicLabel(beatResolved.track)}" (8-bar beat pocket) × "${musicLabel(vocalResolved.track)}" (Full Vocals & Hook)`
      );
      executeCommand(
        {
          action: "stem_migrate",
          trackId: vocalResolved.track.id,
          bars,
          anchor: "out",
          say: `🔥 ${bars}-bar mashup: ${musicLabel(beatResolved.track)} × ${musicLabel(vocalResolved.track)}`,
        },
        "user_chat"
      );
      return;
    }

    // Otherwise, cleanly load & start beatTrack on Deck A right before a phrase boundary, then fire stem_migrate into vocalTrack:
    performanceControlVersionRef.current += 1;
    const mashupVersion = performanceControlVersionRef.current;
    queuePreparationRef.current?.abort(new Error("Starting 2-song mashup"));
    queuePreparationRef.current = null;
    pendingGapRef.current = null;
    cancelPendingTransitionStart();
    teardownMigration();
    cleanupHeldLoopAndRoutine("starting 2-song mashup");
    clearPendingMaskFxRelease();
    transitionEngineRef.current.cancel();
    setTransitionRunning(false);
    queueInFlightRef.current = false;
    purgeMasterBus();

    for (const ctrl of [deckARef.current, deckBRef.current]) {
      if (ctrl.deck.playing) ctrl.deck.pause();
      ctrl.markPaused();
      ctrl.deck.allNeutral();
      ctrl.deck.clearAllDucks();
    }

    const anchorCtrl = deckARef.current;
    pushBrainLog(
      "stem_migrate",
      `🔥 Preparing ${bars}-Bar Full-Song Mashup: loading Beat Anchor "${musicLabel(beatResolved.track)}" → layering "${musicLabel(vocalResolved.track)}"…`
    );

    void (async () => {
      try {
        const blob = await getTrackForPlayback(beatResolved.track);
        if (mashupVersion !== performanceControlVersionRef.current) return;
        await anchorCtrl.loadFile(blob, beatResolved.track.name, beatResolved.track.id, beatResolved.track.source);
        if (!(await anchorCtrl.decodeIfNeeded())) throw new Error("decode failed");
        if (mashupVersion !== performanceControlVersionRef.current) return;
        anchorCtrl.deck.ensureContext();
        const midEntry = midTrackEntryFor(beatResolved.track, 75, 16);
        const beatIn = beatInFor(beatResolved.track.id);
        let seekTo = midEntry?.seconds ?? beatIn ?? 24;
        const beatGrid = effectiveGrid(anchorCtrl.tags, anchorCtrl.grid) ?? beatResolved.track.grid;
        if (beatGrid && beatGrid.bpm > 0) {
          // Position ~1.5s before a 16-beat phrase boundary so once stems decode,
          // the phrase handoff fires almost immediately instead of waiting 15s!
          const nextPhrases = nextPhraseBoundaries({ anchor: beatGrid.anchor, bpm: beatGrid.bpm }, seekTo, 1, 2);
          if (nextPhrases.length > 0 && nextPhrases[0] > 2.0) {
            seekTo = Math.max(0, seekTo + nextPhrases[0] - 1.5);
          }
        }
        if (seekTo > 0) anchorCtrl.deck.seekTo(seekTo);
        anchorCtrl.deck.setGain(1);
        setCrossfade(0);
        anchorCtrl.deck.play();
        anchorCtrl.markPlaying();
        appendHistory({ trackId: beatResolved.track.id, name: beatResolved.track.name });

        setTimeout(() => {
          if (mashupVersion !== performanceControlVersionRef.current) return;
          executeCommand(
            {
              action: "stem_migrate",
              trackId: vocalResolved.track.id,
              bars,
              anchor: "out",
              say: `🔥 ${bars}-bar mashup: ${musicLabel(beatResolved.track)} × ${musicLabel(vocalResolved.track)}`,
            },
            "user_chat"
          );
        }, 150);
      } catch (err) {
        pushBrainLog(
          "error",
          `mashup: could not start anchor "${beatResolved.track.name}" (${err instanceof Error ? err.message : "load error"})`
        );
      }
    })();
  }

  function handleTriggerLiveMashupNow(fullSong = false) {
    coreRef.current?.ensureContext();
    stopStemMixerRef.current?.();
    genreRequestRef.current = null; // explicit mashup button overrides any stale chat genre filter
    const targetBars: 16 | 64 = fullSong ? 64 : 16;
    const crate = crateRef.current;
    const liveLabel = getLiveDeckLabel();
    const liveCtrl = liveLabel ? deckByLabel(liveLabel) : null;
    const liveId = liveCtrl?.trackId ?? null;

    const launchNextGoldPreset = (reason?: string) => {
      const idx = mashupPresetCursorRef.current % GOLD_STANDARD_MASHUP_PRESETS.length;
      mashupPresetCursorRef.current += 1;
      const preset = GOLD_STANDARD_MASHUP_PRESETS[idx];
      if (reason) {
        pushBrainLog("stem_migrate", `${reason} — launching ${preset.title} (${targetBars} bars)`);
      }
      handleStartPairMashup(preset.beatTrackId, preset.vocalTrackId, targetBars);
    };

    if (!liveLabel || !liveCtrl || !liveId) {
      launchNextGoldPreset(fullSong ? "🔥 Starting Full-Song 64-Bar Mashup" : "🧬 Starting 16-Bar Live Stem Mashup");
      return;
    }

    const liveGrid = effectiveGrid(liveCtrl.tags, liveCtrl.grid);
    if (!stemEntryFor(liveId) || !liveGrid || liveGrid.estimated) {
      launchNextGoldPreset("🧬 Current song lacks 4-stem separation or a real BeatGrid");
      return;
    }

    if (crate.length === 0) {
      launchNextGoldPreset("🧬 Crate not yet hydrated");
      return;
    }

    const liveBpm = liveGrid.bpm * liveCtrl.deck.tempo;
    const liveKey = liveCtrl.tags.key ?? crate.find((t) => t.id === liveId)?.key ?? null;
    const recentIds = new Set(historyRef.current.slice(-6).map((r) => r.trackId));
    recentIds.add(liveId);

    let eligible = crate.filter((t) => {
      if (t.id === liveId || recentIds.has(t.id)) return false;
      if (!stemEntryFor(t.id)) return false;
      if (isPartnerDanceTrack(t)) return false;
      const inGrid = (crateManifestJson as CrateManifestEntry[]).find((m) => m.id === t.id)?.grid ?? t.grid;
      if (!inGrid || !inGrid.bpm) return false;
      const ratio = liveBpm / inGrid.bpm;
      return Math.abs(ratio - 1) <= 0.058;
    });

    if (eligible.length === 0) {
      // Relax recent-history exclusion so a playing stem-ready song always finds a partner without resetting playback.
      eligible = crate.filter((t) => {
        if (t.id === liveId) return false;
        if (!stemEntryFor(t.id)) return false;
        if (isPartnerDanceTrack(t)) return false;
        const inGrid = (crateManifestJson as CrateManifestEntry[]).find((m) => m.id === t.id)?.grid ?? t.grid;
        if (!inGrid || !inGrid.bpm) return false;
        const ratio = liveBpm / inGrid.bpm;
        return Math.abs(ratio - 1) <= 0.06;
      });
    }

    const ranked = rankCandidatesByMusicTheory(
      {
        id: liveId,
        name: liveCtrl.trackName ?? "",
        bpm: liveBpm,
        key: liveKey,
        hasStems: true,
        hasRealGrid: true,
      },
      eligible.map((t) => ({
        id: t.id,
        name: t.name,
        bpm: t.bpm,
        key: t.key,
        genre: resolveMusicMetadata(t).genre,
        hasStems: true,
        hasRealGrid: true,
      }))
    );

    const best = ranked[0]?.track ? crate.find((t) => t.id === ranked[0].track.id) : eligible[0];
    if (!best) {
      launchNextGoldPreset(`🧬 No stem partner within ±6% of ${liveBpm.toFixed(1)} BPM`);
      return;
    }

    // Cancel any in-progress transition/routine so the user's explicit Mashup button click executes immediately!
    if (queueInFlightRef.current || transitionEngineRef.current.isRunning || heldLoopRef.current || migrationRef.current || migrationPreparingRef.current) {
      performanceControlVersionRef.current += 1;
      queuePreparationRef.current?.abort(new Error("User triggered live mashup"));
      queuePreparationRef.current = null;
      cancelPendingTransitionStart();
      teardownMigration();
      cleanupHeldLoopAndRoutine("switching to live stem mashup");
      transitionEngineRef.current.cancel();
      setTransitionRunning(false);
      queueInFlightRef.current = false;
      enforceSingleLiveDeck(liveLabel);
    }

    pushBrainLog(
      "stem_migrate",
      fullSong
        ? `🔥 Full-Song 64-Bar Stem Mashup: holding 8-bar groove pocket on "${musicLabel({ name: liveCtrl.trackName ?? "" })}" × layering FULL SONG vocals & hook of "${musicLabel(best)}" (${best.bpm ?? "—"} BPM · ${toCamelot(best.key) ?? "—"})`
        : `🧬 Live 16-Bar Stem Mashup: holding 8-bar pocket on "${musicLabel({ name: liveCtrl.trackName ?? "" })}" × layering Chorus/Hook of "${musicLabel(best)}" (${best.bpm ?? "—"} BPM · ${toCamelot(best.key) ?? "—"})`
    );
    executeCommand(
      {
        action: "stem_migrate",
        trackId: best.id,
        bars: targetBars,
        anchor: "out",
        say: `${fullSong ? "🔥 Full-Song 64-bar" : "🧬 Live 16-bar"} stem mashup into ${musicLabel(best)} (${ranked[0]?.harmonic.headline ?? "harmonic lock"})`,
      },
      "user_chat"
    );
  }

  // --- Transition rating (M4 Part D learning loop) ---

  function handleRateTransition(when: number, rating: "up" | "down") {
    setTransitionRecords((prev) => {
      const existing = prev.find((r) => r.when === when);
      const nextRating = existing?.rating === rating ? null : rating; // tap the same rating again to clear it
      const updated = updateTransitionRecordRating(when, nextRating, existing?.note ?? null);
      // Lesson-ledger tie-in: only on a rating being SET (not cleared) — the
      // ledger is append-only, so clearing a rating doesn't retroactively
      // remove the earlier entry (an honest limitation, not a bug: the
      // ledger records what the owner said AT THE TIME, same as any log).
      if (existing && nextRating !== null) {
        recordLedgerEvent({
          type: "transition_rating",
          when: new Date().toISOString(),
          fromTrackName: existing.fromTrack,
          toTrackName: existing.toTrack,
          transitionType: existing.transitionType,
          durationBars: existing.durationBars,
          clamped: existing.clamped,
          degraded: existing.degraded,
          rating: nextRating,
          ...(existing.note ? { note: existing.note } : {}),
          ...(existing.outPositionSeconds != null ? { outPositionSeconds: existing.outPositionSeconds } : {}),
        });
      }
      return updated;
    });
  }

  function handleTransitionNoteChange(when: number, note: string) {
    setTransitionRecords((prev) => {
      const existing = prev.find((r) => r.when === when);
      const trimmed = note.trim();
      return updateTransitionRecordRating(when, existing?.rating ?? null, trimmed === "" ? null : trimmed);
    });
  }

  // --- Lesson ledger panel: export/import (2026-07-28) ---

  function handleExportLedger() {
    const blob = new Blob([JSON.stringify(ledgerEventsRef.current, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "lesson-ledger.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImportLedgerFile(file: File) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        pushBrainLog("error", "lesson import: file did not contain a JSON array");
        return;
      }
      const merged = mergeLedgerEvents(ledgerEventsRef.current, parsed as LessonEvent[]);
      saveLedger(merged);
      setLedgerEvents(merged);
      pushBrainLog("none", `lessons imported (${merged.length - ledgerEventsRef.current.length} new event(s))`);
    } catch (err) {
      pushBrainLog("error", `lesson import failed: ${err instanceof Error ? err.message : "invalid file"}`);
    }
  }

  // --- Cue-point live firing (rehearsal → mark → assign → live-fire) ---
  //
  // Design: rather than juggling one concurrent setTimeout per upcoming cue,
  // only the SOONEST not-yet-fired cue is ever armed per deck at a time —
  // firing it re-arms whatever's next. This gives every cue the exact same
  // on-time behavior (each still fires at its own real-time moment) with far
  // less state, and the progress-tick drift-check loop below transparently
  // absorbs seeks/tempo changes too: both change positionSeconds/tempo,
  // which changes the very next tick's recomputed expected-fire time enough
  // to exceed shouldRearm()'s 100ms threshold — so there's no separate
  // seek/tempo-change hook needed, just this tick loop plus an explicit
  // clear on pause/track-end/rehearse-toggle (no more ticks arrive to
  // self-correct once paused).
  const armedCueRef = useRef<Record<DeckLabel, ArmedCue | null>>({ A: null, B: null });
  const firedCueSetRef = useRef<Record<DeckLabel, Set<number>>>({ A: new Set(), B: new Set() });

  function clearArmedCue(label: DeckLabel) {
    const armed = armedCueRef.current[label];
    if (armed) {
      clearTimeout(armed.timeoutId);
      armedCueRef.current[label] = null;
    }
  }

  function resetCueFiringState(label: DeckLabel) {
    clearArmedCue(label);
    firedCueSetRef.current[label] = new Set();
  }

  function fireCue(label: DeckLabel, cue: Cue) {
    firedCueSetRef.current[label].add(cue.atSeconds);
    armedCueRef.current[label] = null;

    // Skip (with a log line) if a transition is running at fire time —
    // same defensive posture as executeFxCommand's code-side transition
    // guard, applied here too rather than trusting timing alone.
    if (transitionEngineRef.current.isRunning) {
      pushBrainLog("cue", `skipped cue at ${formatMmSs(cue.atSeconds)} — a transition is currently in progress`);
      return;
    }

    const decks = [deckARef.current.deck, deckBRef.current.deck];

    if (cue.action.type === "singalong") {
      pushBrainLog("cue", "SING-ALONG — crowd's got this one");
      for (const deck of decks) deck.duck(SINGALONG_DUCK_DB, SINGALONG_DUCK_RAMP_SECONDS);
      setTimeout(() => {
        for (const deck of decks) deck.unduck(SINGALONG_DUCK_RAMP_SECONDS);
      }, cue.action.durationSeconds * 1000);
      return;
    }

    if (!cue.action.file) return; // unassigned clip cue — nothing to fire yet
    // Cue fires are HUMAN-AUTHORED: exempt from the autopilot fx cooldown
    // floor (executeFxCommand's AUTOPILOT_FX_COOLDOWN_SECONDS gate is
    // skipped entirely here) and deliberately do NOT call recordFxFired() —
    // a pre-rehearsed cue shouldn't burn El Cerebro's own fx frequency cap.
    vocalPlayerRef.current?.playFile(cue.action.file, decks, {
      isTransitionRunning: () => transitionEngineRef.current.isRunning,
    });
  }

  function armNextCue(label: DeckLabel, ctrl: DeckController, cueKey: string | null, nowMs: number) {
    if (!cueKey) return;
    const cues = getCues(cueStoreRef.current, cueKey);
    if (cues.length === 0) return;
    const fired = firedCueSetRef.current[label];
    const upcoming = upcomingCues(cues, ctrl.deck.positionSeconds).filter((c) => !fired.has(c.atSeconds));
    if (upcoming.length === 0) return;
    const next = upcoming[0];
    const freshExpectedAtMs = computeExpectedFireAtMs(next.atSeconds, ctrl.deck.positionSeconds, ctrl.tempo, nowMs);

    const armed = armedCueRef.current[label];
    if (armed && armed.atSeconds === next.atSeconds && !shouldRearm(armed.expectedAtMs, freshExpectedAtMs)) {
      return; // same cue already armed, no meaningful drift — leave the existing timer alone
    }

    clearArmedCue(label);
    const delayMs = Math.max(0, freshExpectedAtMs - nowMs);
    const timeoutId = setTimeout(() => fireCue(label, next), delayMs);
    armedCueRef.current[label] = { timeoutId, atSeconds: next.atSeconds, expectedAtMs: freshExpectedAtMs };
  }

  /** Hooked to each deck's onProgress (~93ms apart, same cadence as every other progress-driven check in this app) — see the design note above. */
  function handleCueSchedulerTick(label: DeckLabel) {
    const ctrl = label === "A" ? deckARef.current : deckBRef.current;
    const rehearsing = label === "A" ? rehearseARef.current : rehearseBRef.current;
    if (rehearsing) return; // rehearsal mode never live-fires — marking only
    const cueKey = label === "A" ? cueKeyARef.current : cueKeyBRef.current;
    armNextCue(label, ctrl, cueKey, Date.now());
  }

  useEffect(() => {
    const unsubA = deckA.deck.onProgress(() => handleCueSchedulerTick("A"));
    const unsubB = deckB.deck.onProgress(() => handleCueSchedulerTick("B"));
    return () => {
      unsubA();
      unsubB();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pause or track-end (both surface as isPlaying -> false) stop progress
  // ticks from arriving, so nothing would otherwise cancel a stale armed
  // timer — clear explicitly. A new track loading (cueKey changing) resets
  // the fired-this-playthrough set too, so re-loading the same track later
  // doesn't inherit stale fired history.
  useEffect(() => {
    if (!deckA.isPlaying) resetCueFiringState("A");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckA.isPlaying]);
  useEffect(() => {
    if (!deckB.isPlaying) resetCueFiringState("B");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckB.isPlaying]);
  useEffect(() => {
    resetCueFiringState("A");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cueKeyA]);
  useEffect(() => {
    resetCueFiringState("B");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cueKeyB]);

  // Suggested cue-point seeding (lyric-timed adlib/call-response moments
  // from scripts/suggest-cues.mjs's committed src/data/cue-suggestions.json)
  // — ONLY when the track has no cues at all yet, so this never overwrites
  // anything the user marked/assigned. Seeded cues are fully INERT
  // (action: {type:"clip", file:null}, same shape as a fresh MARK) — fireCue()
  // above already no-ops on an unassigned clip cue, so no separate
  // "suggested" branch is needed at fire time; assigning a clip/sing-along
  // or nudging (both in cue-store.ts) clears the suggested flag on its own.
  function seedSuggestedCuesForKey(cueKey: string | null) {
    if (!cueKey) return;
    const suggestion = CUE_SUGGESTIONS[cueKey];
    if (!suggestion) return;
    const existing = getCues(cueStoreRef.current, cueKey);
    const seeded = seedSuggestedCues(existing, suggestion.cues);
    if (seeded === existing) return; // already had cues -- seedSuggestedCues no-op'd, nothing to persist
    persistCueStore(setCues(cueStoreRef.current, cueKey, seeded));
  }
  useEffect(() => {
    seedSuggestedCuesForKey(cueKeyA);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cueKeyA]);
  useEffect(() => {
    seedSuggestedCuesForKey(cueKeyB);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cueKeyB]);

  function handleToggleRehearse(label: DeckLabel) {
    const setRehearse = label === "A" ? setRehearseA : setRehearseB;
    setRehearse((prev) => {
      const next = !prev;
      if (next) clearArmedCue(label); // rehearsal mode never live-fires — no timer should stay armed while it's on
      return next;
    });
  }

  function handleMarkCue(label: DeckLabel) {
    const ctrl = label === "A" ? deckARef.current : deckBRef.current;
    const cueKey = label === "A" ? cueKeyARef.current : cueKeyBRef.current;
    if (!cueKey) return;
    const next = addCue(getCues(cueStoreRef.current, cueKey), ctrl.deck.positionSeconds);
    persistCueStore(setCues(cueStoreRef.current, cueKey, next));
  }

  function withCueKey(label: DeckLabel, mutate: (cues: Cue[]) => Cue[]) {
    const cueKey = label === "A" ? cueKeyARef.current : cueKeyBRef.current;
    if (!cueKey) return;
    const next = mutate(getCues(cueStoreRef.current, cueKey));
    persistCueStore(setCues(cueStoreRef.current, cueKey, next));
  }

  function handleAssignCueClip(label: DeckLabel, index: number, file: string | null) {
    withCueKey(label, (cues) => updateCueAction(cues, index, { type: "clip", file }));
  }

  function handleAssignCueSingalong(label: DeckLabel, index: number, durationSeconds: number) {
    const clamped = Math.min(SINGALONG_MAX_DURATION_SECONDS, Math.max(SINGALONG_MIN_DURATION_SECONDS, durationSeconds));
    withCueKey(label, (cues) => updateCueAction(cues, index, { type: "singalong", durationSeconds: clamped }));
  }

  function handleDeleteCue(label: DeckLabel, index: number) {
    withCueKey(label, (cues) => deleteCue(cues, index));
  }

  function handleNudgeCue(label: DeckLabel, index: number, deltaSeconds: number) {
    withCueKey(label, (cues) => nudgeCue(cues, index, deltaSeconds));
  }

  const lastAutoDropMoveTrackRef = useRef<string | null>(null);
  const lastAutoVocalDropTrackRef = useRef<string | null>(null);

  // Autopilot poll loop (Part D). Deliberately narrow deps ([autopilot,
  // crate.length]) so this doesn't tear down/recreate the interval on every
  // progress-bar tick — see the deckARef/deckBRef/crateRef mirrors above for
  // how the callback still reads fresh values every second.
  useEffect(() => {
    if (!autopilot) return;
    const interval = setInterval(() => {
      if (brainBusyRef.current || transitionEngineRef.current.isRunning) return;
      checkQueueWatchdog();
      // Let preparation/the audio clock finish its accepted move. Polling the
      // cloud again here creates competing plans and unnecessary paid calls.
      if (queueInFlightRef.current || heldLoopRef.current || migrationRef.current || migrationPreparingRef.current) return;

      const liveLabel = getLiveDeckLabel();
      if (liveLabel === null) {
        if (crateRef.current.length > 0) {
          const asked = askedForTrackRef.current;
          // Review-panel fix: re-ask the opener after the reask window even
          // if we already asked once — a "none" reply or a failed queue
          // execution (the latter also clears this ref immediately, see
          // executeQueueCommand) must not wedge autopilot silent forever.
          const staleOpener = asked !== null && asked.key === "__opener__" && Date.now() - asked.at > AUTOPILOT_OPENER_REASK_MS;
          if (asked === null || asked.key !== "__opener__" || staleOpener) {
            askedForTrackRef.current = { key: "__opener__", at: Date.now() };
            void callBrain(null, { autopilotDriven: true, consultReason: "opener" });
          }
        }
        return;
      }

      const liveCueKey = cueKeyForLabel(liveLabel);
      const liveState = deckLiveState(deckByLabel(liveLabel), liveCueKey);
      if (!liveState) return;
      // In-and-out mixing: consult early either when the track's genuinely
      // ending soon OR when it's approaching its OWN analyzed mix-out point
      // (a dead-outro warning that can fire well before remainingSeconds
      // would) — mixOutSeconds is SOURCE-time, so the distance to it needs
      // the same source->output conversion remainingSeconds itself uses.
      const mixOutRemainingSeconds =
        liveState.mixOutSeconds !== null
          ? Math.max(0, (liveState.mixOutSeconds - liveState.positionSeconds) / Math.max(liveState.tempo, 1e-6))
          : null;
      const nearingEnd = liveState.remainingSeconds < AUTOPILOT_REMAINING_THRESHOLD_SECONDS;
      const nearingMixOut = mixOutRemainingSeconds !== null && mixOutRemainingSeconds < AUTOPILOT_REMAINING_THRESHOLD_SECONDS;
      // M7 blocker fix ("you are going way longer than 30 seconds"): when the
      // owner has asked for a specific residency, that mark is its OWN
      // consult trigger. When performanceMixRef is active, start the ~20s
      // sample_mix / stem_migrate 20s before targetSeconds so each track's
      // total airtime including the transition is ~targetSeconds (e.g. 45s).
      const residencyLeadSeconds = performanceMixRef.current ? 20 : undefined;
      const residencyDue = isResidencyConsultDue(
        liveState.playedSeconds,
        residencyRequestRef.current?.seconds ?? null,
        residencyLeadSeconds
      );
      if ((nearingEnd || nearingMixOut || residencyDue) && askedForTrackRef.current?.key !== liveState.trackId) {
        askedForTrackRef.current = { key: liveState.trackId, at: Date.now() };
        if (tryExecuteLocalAutopilotRecipe(liveState)) return;
        void callBrain(null, { autopilotDriven: true, consultReason: "autopilot_poll" });
        return;
      }

      // Live human-DJ mid-track performance moves during solo track play:
      // 1) Pre-drop beat roll or baby scratch right before an analyzed internal drop (or at ~11s in showcase/residency mode).
      // 2) Colombian El Cerebro vocal tag / hype drop during an instrumental gap or breakdown.
      const minMidTrackPlayedSeconds =
        residencyRequestRef.current !== null
          ? Math.max(8, Math.min(13, Math.floor(residencyRequestRef.current.seconds * 0.25)))
          : 18;
      if (
        !nearingEnd &&
        !nearingMixOut &&
        !residencyDue &&
        liveState.playedSeconds >= minMidTrackPlayedSeconds &&
        (residencyRequestRef.current !== null ||
          liveState.remainingSeconds >= AUTOPILOT_REMAINING_THRESHOLD_SECONDS + 12) &&
        !isPartnerDanceTrackName(liveState.name)
      ) {
        const loopEntry = liveCueKey ? getLoopPoints(CURRENT_LOOP_POINTS, liveCueKey) : null;
        const upcomingDrop = loopEntry?.drops.find((d) => {
          const untilDrop = (d.atSeconds - liveState.positionSeconds) / Math.max(liveState.tempo, 1e-6);
          return untilDrop >= 1.0 && untilDrop <= 2.6;
        });
        if (upcomingDrop && lastAutoDropMoveTrackRef.current !== liveState.trackId && performanceMoveReady()) {
          lastAutoDropMoveTrackRef.current = liveState.trackId;
          pushBrainLog("fx", `live performance move — pre-drop roll before drop @${upcomingDrop.atSeconds.toFixed(1)}s`);
          executeFxCommand({ action: "fx", fx: "roll_quarter", say: "Pre-drop 1/4-beat roll into the drop" }, "autopilot_poll");
          return;
        }
        if (
          (performanceMixRef.current || residencyRequestRef.current !== null) &&
          lastAutoDropMoveTrackRef.current !== liveState.trackId &&
          performanceMoveReady()
        ) {
          lastAutoDropMoveTrackRef.current = liveState.trackId;
          const showcaseMoveIndex = historyRef.current.length % 3;
          const moveFx = showcaseMoveIndex === 0 ? "roll_quarter" : showcaseMoveIndex === 1 ? "scratch_baby" : "roll_eighth";
          pushBrainLog("fx", `live performance move — mid-track ${moveFx} skill @${liveState.positionSeconds.toFixed(1)}s`);
          executeFxCommand(
            { action: "fx", fx: moveFx, say: `Mid-track ${moveFx} skill on the beat` },
            "user_chat"
          );
          if (!liveState.vocalActiveNow && lastAutoVocalDropTrackRef.current !== liveState.trackId) {
            lastAutoVocalDropTrackRef.current = liveState.trackId;
            const vocalCat: VocalCategory = showcaseMoveIndex === 0 ? "tag" : showcaseMoveIndex === 1 ? "cue_hype" : "adlib";
            setTimeout(() => {
              playVocalCategory(vocalCat, false);
            }, 900);
          }
          return;
        }
        const fxCooldown =
          performanceMixRef.current || residencyRequestRef.current !== null ? 18 : AUTOPILOT_FX_COOLDOWN_SECONDS;
        const fxReady =
          lastFxAtRef.current === null ||
          (Date.now() - lastFxAtRef.current) / 1000 >= fxCooldown;
        if (
          fxReady &&
          lastAutoVocalDropTrackRef.current !== liveState.trackId &&
          !liveState.vocalActiveNow &&
          liveState.nextDownPart &&
          liveState.positionSeconds >= liveState.nextDownPart.start - 0.5 &&
          liveState.positionSeconds <= liveState.nextDownPart.start + 2.0
        ) {
          lastAutoVocalDropTrackRef.current = liveState.trackId;
          pushBrainLog("fx", `live performance move — DJ tag in vocal-free breakdown @${liveState.positionSeconds.toFixed(1)}s`);
          executeFxCommand({ action: "fx", fx: "tag", say: "DJ tag in the vocal-free breakdown" }, "autopilot_poll");
        }
      }
    }, AUTOPILOT_POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autopilot, crate.length]);

  // Automatic single-deck guard: if both Deck A and Deck B end up playing simultaneously
  // while NO transition, routine, or stem migration is running, immediately enforce a
  // single live deck so a background track can never stay stuck underneath the active track.
  useEffect(() => {
    if (
      deckA.isPlaying &&
      deckB.isPlaying &&
      !transitionRunning &&
      !transitionEngineRef.current.isRunning &&
      !migrationRef.current &&
      !heldLoopRef.current &&
      !queueInFlightRef.current
    ) {
      enforceSingleLiveDeck();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckA.isPlaying, deckB.isPlaying, transitionRunning]);

  const [activeTab, setActiveTab] = useState<"booth" | "fx" | "crate" | "stems" | "theory" | "all">("booth");

  // Clear any pending autopilot retry timer (and any pending deferred
  // re-consult) on unmount.
  useEffect(() => {
    return () => {
      if (retryTimeoutHandleRef.current) clearTimeout(retryTimeoutHandleRef.current);
      cancelFollowUp();
      teardownMigration();
    };
  }, []);

  const liveDeckNow = deckA.isPlaying ? deckA : deckB.isPlaying ? deckB : deckA.trackName ? deckA : deckB.trackName ? deckB : null;
  const liveDeckBpm = liveDeckNow?.tags.bpm ? (liveDeckNow.tags.bpm * liveDeckNow.tempo).toFixed(1) : null;
  const liveDeckKey = toCamelot(liveDeckNow?.tags.key ?? null) ?? liveDeckNow?.tags.key ?? null;

  return (
    <main className={styles.main}>
      {/* 📱 MOBILE-FIRST STICKY TOP TRANSPORT + REAL NAVIGATION TABS */}
      <header className={styles.mobileTopHeader}>
        <div className={styles.mobileBrandRow}>
          <div className={styles.mobileBrandLeft}>
            <h1 className={styles.mobileAppTitle}>DJ Supermercado</h1>
            <span className={anyPlaying || stemMixerState.playing ? styles.liveStatusText : styles.idleStatusText}>
              {transitionRunning
                ? "⚡ MIXING"
                : autopilot
                  ? "● AUTOPILOT ON"
                  : stemMixerState.playing
                    ? "🎛️ 4-STEMS ON"
                    : anyPlaying
                      ? "● LIVE"
                      : "○ READY"}
            </span>
          </div>
          <span className={styles.idleStatusText}>
            {deckA.isPlaying ? "Deck A Live" : deckB.isPlaying ? "Deck B Live" : "Manual / Studio"}
          </span>
        </div>

        {/* Plain-text Now Playing readout (never looks like a button) */}
        <div className={styles.nowPlayingBanner}>
          <span className={styles.nowPlayingSong}>
            {stemMixerState.playing && stemMixerState.title
              ? `🎛️ 4-Stem Pack: ${stemMixerState.title}`
              : liveDeckNow?.trackName
                ? `🎵 ${musicLabel({ name: liveDeckNow.trackName })}`
                : "No song playing — tap ▶ Start Autopilot or pick a song in Crate"}
          </span>
          <span className={styles.nowPlayingMeta}>
            {stemMixerState.playing && stemMixerState.bpm
              ? `${Math.round(stemMixerState.bpm)} BPM`
              : `${liveDeckBpm ? `${liveDeckBpm} BPM` : "—"}${liveDeckKey ? ` · ${liveDeckKey}` : ""}`}
          </span>
        </div>

        {/* 4 Unmistakable Primary Action Buttons (Always visible on phone) */}
        <div className={styles.quickActionRow}>
          <button
            type="button"
            className={autopilot ? styles.quickBtnAutopilotOn : styles.quickBtnAutopilotOff}
            onClick={handleToggleAutopilot}
          >
            {autopilot ? "⏸ Autopilot: ON" : "▶ Start Autopilot"}
          </button>
          <button
            type="button"
            className={styles.quickBtnNext}
            onClick={() => handleTriggerLiveMashupNow(false)}
            title="Execute a 16-bar Live Stem Mashup into the #1 harmonic match"
            style={{ background: "linear-gradient(135deg, #8b5cf6, #ec4899)" }}
          >
            🧬 Mashup
          </button>
          <button
            type="button"
            className={styles.quickBtnNext}
            onClick={() => handleTriggerLiveMashupNow(true)}
            title="Mash the ENTIRE song (64 bars / ~2.5 min) over an 8-bar drum+bass groove pocket"
            style={{ background: "linear-gradient(135deg, #f97316, #db2777)" }}
          >
            🔥 Full Mash
          </button>
          <button
            type="button"
            className={styles.quickBtnNext}
            onClick={() => handleSkipToNextSong(false)}
            title="Mix into the next song right now"
          >
            ⏭️ Next Song
          </button>
          <button
            type="button"
            className={styles.quickBtnSolo}
            onClick={handleKillBackgroundAndSoloActiveDeck}
            title="Kill any background track or stem loop and solo the active song"
          >
            🎯 Solo Song
          </button>
          <button
            type="button"
            className={styles.quickBtnStop}
            onClick={handleStopAllAudio}
            title="Immediately stop all decks, stems, and loops"
          >
            🛑 STOP ALL
          </button>
        </div>

        {/* Real Interactive Tab Switcher (replaces the old non-clickable top pills!) */}
        <nav className={styles.navTabsBar} aria-label="DJ Workspace Sections">
          <button
            type="button"
            className={`${styles.navTabBtn} ${activeTab === "booth" ? styles.navTabBtnActive : ""}`}
            onClick={() => setActiveTab("booth")}
          >
            <span>🎧 Booth &amp; Decks</span>
            <span className={styles.navTabCount}>Brain + A/B</span>
          </button>
          <button
            type="button"
            className={`${styles.navTabBtn} ${activeTab === "fx" ? styles.navTabBtnActive : ""}`}
            onClick={() => setActiveTab("fx")}
          >
            <span>🔊 FX &amp; Vocals</span>
            <span className={styles.navTabCount}>16 SFX · 38 Paisa</span>
          </button>
          <button
            type="button"
            className={`${styles.navTabBtn} ${activeTab === "crate" ? styles.navTabBtnActive : ""}`}
            onClick={() => setActiveTab("crate")}
          >
            <span>🎵 Crate</span>
            <span className={styles.navTabCount}>{crate.length || 603} Tracks</span>
          </button>
          <button
            type="button"
            className={`${styles.navTabBtn} ${activeTab === "stems" ? styles.navTabBtnActive : ""}`}
            onClick={() => setActiveTab("stems")}
          >
            <span>🎛️ 4-Stem Mixer</span>
            <span className={styles.navTabCount}>{stemMixerState.playing ? "▶ PLAYING" : "599 Packs"}</span>
          </button>
          <button
            type="button"
            className={`${styles.navTabBtn} ${activeTab === "theory" ? styles.navTabBtnActive : ""}`}
            onClick={() => setActiveTab("theory")}
          >
            <span>🧠 Theory &amp; Log</span>
            <span className={styles.navTabCount}>1,605 Recipes</span>
          </button>
          <button
            type="button"
            className={`${styles.navTabBtn} ${activeTab === "all" ? styles.navTabBtnActive : ""}`}
            onClick={() => setActiveTab("all")}
          >
            <span>📱 Full Studio</span>
            <span className={styles.navTabCount}>Show All</span>
          </button>
        </nav>
      </header>

      {/* TAB 1: BOOTH & DECKS (Default Mobile View: Brain + Deck A / Crossfader / Deck B right at the top!) */}
      {(activeTab === "booth" || activeTab === "all") && (
        <>
          <BrainPanel
            autopilot={autopilot}
            onToggleAutopilot={handleToggleAutopilot}
            partyPlannedSeconds={partyPlannedSeconds}
            onPartyPlannedSecondsChange={setPartyPlannedSeconds}
            chatInput={chatInput}
            onChatInputChange={setChatInput}
            onChatSubmit={handleChatSubmit}
            brainBusy={brainBusy}
            brainLog={brainLog}
            costTotal={costTotal}
            lastCost={lastCost}
            lastModel={lastModel}
            onResetCost={handleResetCost}
            modelOptions={modelOptions}
            selectedModel={selectedModel}
            onModelChange={handleModelChange}
            modelOnly={modelOnly}
            onModelOnlyChange={value => { modelOnlyRef.current = value; setModelOnly(value); }}
            unpricedCalls={unpricedCalls}
            lastLatency={lastLatency}
            onSkipNext={handleSkipToNextSong}
            onTriggerLiveMashup={handleTriggerLiveMashupNow}
            onStartPairMashup={handleStartPairMashup}
            crate={crate}
            onSeekLive={handleSeekLive}
            onJumpToBeatLive={() => handleJumpToBeat()}
            hasLiveTrack={anyPlaying || Boolean(deckA.trackName || deckB.trackName)}
            onSoloActiveDeck={handleKillBackgroundAndSoloActiveDeck}
            onStopAllAudio={handleStopAllAudio}
            activeTrackId={liveDeckNow?.trackId ?? null}
            activeTrackName={liveDeckNow?.trackName ?? null}
            activeLoopLabel={manualLoopLabel}
            onTriggerStemLoop={(opts) => void handleManualStemLoop(opts)}
            onReleaseStemLoop={handleReleaseManualLoop}
            onOpenStemStudio={() => setActiveTab("stems")}
          />

          <div className={styles.deckGrid}>
            <DeckPanel
              label="Deck A"
              accentClass={styles.deckA}
              deckState={deckA}
              syncLabel="Beat Sync A→B"
              syncDisabled={syncDisabled}
              syncDisabledReason={syncDisabledReason}
              onSync={handleBeatSyncAtoB}
              onJumpToBeat={() => handleJumpToBeat("A")}
              cues={cueKeyA ? getCues(cueStore, cueKeyA) : []}
              rehearsing={rehearseA}
              onToggleRehearse={() => handleToggleRehearse("A")}
              onMark={() => handleMarkCue("A")}
              onAssignClip={(index, file) => handleAssignCueClip("A", index, file)}
              onAssignSingalong={(index, duration) => handleAssignCueSingalong("A", index, duration)}
              onDeleteCue={(index) => handleDeleteCue("A", index)}
              onNudgeCue={(index, delta) => handleNudgeCue("A", index, delta)}
              crate={crate}
              otherDeckTrackId={deckB.trackId}
              otherDeckTrackName={deckB.trackName}
              otherDeckBpm={deckB.tags.bpm ? deckB.tags.bpm * deckB.tempo : null}
              otherDeckKey={deckB.tags.key ?? null}
              onSelectCrateTrack={(id, autoPlay) => handleLoadTrackToSpecificDeck("A", id, autoPlay)}
              onOpenInStemStudio={() => setActiveTab("stems")}
            />

            <div className={styles.crossfaderSection}>
              <div className={styles.crossfaderLabels}>
                <span>A</span>
                <span>Crossfader</span>
                <span>B</span>
              </div>
              <input
                type="range"
                className={styles.crossfaderSlider}
                min={0}
                max={1}
                step={0.01}
                value={crossfade}
                onChange={handleCrossfadeChange}
                aria-label="Crossfader, A to B"
              />

              {/* 🧬 DIRECT DECK A × DECK B MASHUP & MIX BRIDGE */}
              <div
                style={{
                  marginTop: 10,
                  padding: "10px 12px",
                  borderRadius: 10,
                  background: "rgba(15, 23, 42, 0.85)",
                  border: "1px solid rgba(168, 85, 247, 0.45)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <span style={{ fontSize: "0.75rem", fontWeight: 900, color: "#e9d5ff", textAlign: "center", letterSpacing: "0.03em" }}>
                  🧬 MASH DECK A × DECK B SONGS TOGETHER:
                </span>
                <button
                  type="button"
                  className={styles.syncButton}
                  disabled={!deckA.trackId || !deckB.trackId}
                  onClick={() => {
                    if (deckA.trackId && deckB.trackId) {
                      handleStartPairMashup(deckA.trackId, deckB.trackId, 64);
                    }
                  }}
                  style={{
                    background: "linear-gradient(135deg, #8b5cf6, #ec4899)",
                    color: "#fff",
                    fontWeight: 900,
                    fontSize: "0.78rem",
                    padding: "8px 10px",
                  }}
                  title="Loop Deck A's 8-bar drum+bass groove pocket and layer Deck B's FULL vocals & melody over it (64 bars)"
                >
                  🔥 Mash Deck A Beat × Deck B Vocals (Full 64b)
                </button>
                <button
                  type="button"
                  className={styles.syncButton}
                  disabled={!deckA.trackId || !deckB.trackId}
                  onClick={() => {
                    if (deckA.trackId && deckB.trackId) {
                      handleStartPairMashup(deckB.trackId, deckA.trackId, 64);
                    }
                  }}
                  style={{
                    background: "linear-gradient(135deg, #f97316, #db2777)",
                    color: "#fff",
                    fontWeight: 900,
                    fontSize: "0.78rem",
                    padding: "8px 10px",
                  }}
                  title="Loop Deck B's 8-bar drum+bass groove pocket and layer Deck A's FULL vocals & melody over it (64 bars)"
                >
                  🔥 Mash Deck B Beat × Deck A Vocals (Full 64b)
                </button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={!deckA.trackId || !deckB.trackId}
                  onClick={() => {
                    if (deckA.trackId && deckB.trackId) {
                      const beatId = deckB.isPlaying && !deckA.isPlaying ? deckB.trackId : deckA.trackId;
                      const vocalId = beatId === deckA.trackId ? deckB.trackId : deckA.trackId;
                      handleStartPairMashup(beatId, vocalId, 16);
                    }
                  }}
                  style={{
                    fontWeight: 800,
                    fontSize: "0.75rem",
                    padding: "6px 10px",
                    borderColor: "#a855f7",
                    color: "#e9d5ff",
                  }}
                  title="16-bar quick mashup between Deck A and Deck B"
                >
                  🧬 16-Bar Quick Mash (Deck A × Deck B)
                </button>
                {(!deckA.trackId || !deckB.trackId) && (
                  <span style={{ fontSize: "0.72rem", color: "#94a3b8", textAlign: "center" }}>
                    👆 Pick a song in the dropdown on Deck A &amp; Deck B above to mash them!
                  </span>
                )}
              </div>
            </div>

            <DeckPanel
              label="Deck B"
              accentClass={styles.deckB}
              deckState={deckB}
              syncLabel="Beat Sync B→A"
              syncDisabled={syncDisabled}
              syncDisabledReason={syncDisabledReason}
              onSync={handleBeatSyncBtoA}
              onJumpToBeat={() => handleJumpToBeat("B")}
              cues={cueKeyB ? getCues(cueStore, cueKeyB) : []}
              rehearsing={rehearseB}
              onToggleRehearse={() => handleToggleRehearse("B")}
              onMark={() => handleMarkCue("B")}
              onAssignClip={(index, file) => handleAssignCueClip("B", index, file)}
              onAssignSingalong={(index, duration) => handleAssignCueSingalong("B", index, duration)}
              onDeleteCue={(index) => handleDeleteCue("B", index)}
              onNudgeCue={(index, delta) => handleNudgeCue("B", index, delta)}
              crate={crate}
              otherDeckTrackId={deckA.trackId}
              otherDeckTrackName={deckA.trackName}
              otherDeckBpm={deckA.tags.bpm ? deckA.tags.bpm * deckA.tempo : null}
              otherDeckKey={deckA.tags.key ?? null}
              onSelectCrateTrack={(id, autoPlay) => handleLoadTrackToSpecificDeck("B", id, autoPlay)}
              onOpenInStemStudio={() => setActiveTab("stems")}
            />
          </div>
        </>
      )}

      {/* TAB 2: FX & 38 PAISA VOCALS */}
      {(activeTab === "fx" || activeTab === "all") && (
        <FxPanel
          liveDeckLabel={getLiveDeckLabel()}
          onPlayFx={handlePlayFx}
          onScratch={handleScratchButton}
          onRoll={handleRollButton}
          onPlayVocal={handlePlayVocal}
          onPlayVocalFile={handlePlayVocalFile}
          onFireCombo={handleFireTurntablistCombo}
          autoTurntablistFx={autoTurntablistFx}
          onToggleAutoTurntablistFx={() => setAutoTurntablistFx((prev) => !prev)}
          onWarmUp={() => void handleWarmUpFx()}
          warmingUp={fxWarmingUp}
        />
      )}

      {/* TAB 3: CRATE (603 GOOGLE DRIVE TRACKS) */}
      {(activeTab === "crate" || activeTab === "all") && (
        <CratePanel
          crate={crate}
          adding={crateAdding}
          fileInputRef={crateFileInputRef}
          onAddClick={() => crateFileInputRef.current?.click()}
          onFilesSelected={handleAddToCrate}
          onTapTrack={(track) => {
            handleCrateTap(track);
          }}
          onLoadToDeckA={(track) => {
            handleLoadTrackToSpecificDeck("A", track.id, false);
            setActiveTab("booth");
          }}
          onLoadToDeckB={(track) => {
            handleLoadTrackToSpecificDeck("B", track.id, false);
            setActiveTab("booth");
          }}
          onMashWithLive={(track) => {
            const beatId = liveDeckNow?.trackId ?? deckA.trackId ?? "1zl2bmgRSzcBQxNvsmr_BKAD6VGDf3YTb";
            handleStartPairMashup(beatId, track.id, 64);
            setActiveTab("booth");
          }}
          driveTracks={driveTracks}
          driveListing={driveListing}
          driveAdding={driveAdding}
          driveTagProgress={driveTagProgress}
          driveNotices={driveNotices}
          onLoadDrive={() => void handleLoadDriveList()}
          onAddAllFromDrive={() => void handleAddAllFromDrive()}
          cachedIds={cachedIds}
          onPrefetchNext10={() => void handlePrefetchNext10()}
          prefetching={prefetching}
          onGenreChange={(id, genre) => void saveGenre(id, genre)}
          metadataStatus={metadataStatus}
        />
      )}

      {/* TAB 4: LIVE 4-STEM MIXER & HORN / BEAT LOOP STUDIO */}
      {(activeTab === "stems" || activeTab === "all") && (
        <LiveStemMixerPanel
          core={coreRef.current}
          activeDeckTrackId={liveDeckNow?.trackId ?? null}
          activeDeckTrackName={liveDeckNow?.trackName ?? null}
          activeDeckBpm={liveDeckNow?.tags.bpm ?? null}
          activeDeckCamelot={liveDeckKey}
          activeDeckTempo={liveDeckNow?.tempo ?? 1}
          activeDeckPositionSec={liveDeckNow?.deck.positionSeconds ?? 0}
          activeDeckDurationSec={liveDeckNow?.deck.duration ?? 0}
          activeDeckAnchorSec={liveDeckNow?.grid?.anchor ?? 0}
          crate={crate}
          trackCacheStore={trackCacheStoreRef.current}
          onLoadVipToDeck={(id) => {
            handleLoadVipToDeck(id);
            setActiveTab("booth");
          }}
          onReturnToDeck={(resumePos, resumeTmp) => {
            handleReturnFromStemsToDeck(resumePos, resumeTmp);
            setActiveTab("booth");
          }}
          onLog={pushBrainLog}
          onPlayingChange={(playing, bpm, title) => setStemMixerState({ playing, bpm, title })}
          stopRef={stopStemMixerRef}
          onBeforePlay={handleStopDecksForStemMixer}
          onPurgeMasterBus={purgeMasterBus}
        />
      )}

      {/* TAB 5: MUSIC THEORY MASTER, SPECTRUM & TRANSITION HISTORY */}
      {(activeTab === "theory" || activeTab === "all") && (
        <>
          <ClubBoothHud
            deckA={deckA}
            deckB={deckB}
            cueKeyA={cueKeyA}
            cueKeyB={cueKeyB}
            stemMixerPlaying={stemMixerState.playing}
            stemMixerBpm={stemMixerState.bpm}
            stemMixerTitle={stemMixerState.title}
            autopilot={autopilot}
            transitionRunning={transitionRunning}
            crate={crate}
            onPickHarmonicNext={(trackId, comboId) => {
              handlePickHarmonicNext(trackId, comboId);
              setActiveTab("booth");
            }}
            onFireTurntablistCombo={handleFireTurntablistCombo}
            onSoloActiveDeck={handleKillBackgroundAndSoloActiveDeck}
            onStopAllAudio={handleStopAllAudio}
          />

          <TransitionHistoryPanel
            records={transitionRecords}
            onRate={handleRateTransition}
            onNoteChange={handleTransitionNoteChange}
          />

          <LessonsPanel
            events={ledgerEvents}
            onExport={handleExportLedger}
            onImportFile={(file) => void handleImportLedgerFile(file)}
            syncStatus={lessonSyncStatus}
          />
        </>
      )}
    </main>
  );
}
