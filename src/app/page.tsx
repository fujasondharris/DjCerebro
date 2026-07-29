"use client";

import { useEffect, useRef, useState } from "react";
import { AudioCore } from "@/lib/audio-core";
import { Deck, type ProgressUpdate } from "@/lib/deck";
import { parseId3Tags, type Id3Tags } from "@/lib/id3";
import { parseSeratoBeatgrid, type SeratoBeatgrid } from "@/lib/serato";
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
  type DjState,
  type DjLiveState,
  type CompactCrateEntry,
  type ConsultReason,
  isHumanInitiated,
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
import { computeRmsPerSecond, findMixPoints, applyMixInCueOverride, type MixPoints } from "@/lib/energy";
import { cleanTrackName } from "@/lib/lyrics-match";
import { toCamelot } from "@/lib/camelot";
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
import { loadCrateList, saveCrateList, type PersistedCrateEntry } from "@/lib/crate-store";
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
// Deferred re-consult (owner soundcheck fix): if brainBusy at the scheduled
// followUpSeconds fire time, retry once after this short delay, then drop
// with a log line rather than queueing indefinitely — see fireFollowUp().
const FOLLOW_UP_BUSY_RETRY_MS = 2000;
const BRAIN_LOG_LIMIT = 5;
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
  const [tags, setTags] = useState<Id3Tags>({});
  const [grid, setGrid] = useState<SeratoBeatgrid | null>(null);
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
    setTags({});
    setGrid(null);
    setMixPoints(null); // in-and-out mixing: a new track needs fresh analysis
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
    deckRef.current?.pause();

    // ID3/Serato parsing is best-effort and never blocks playback/tempo controls.
    try {
      const file = blob instanceof File ? blob : new File([blob], name);
      const [parsedTags, parsedGrid] = await Promise.all([
        parseId3Tags(file),
        parseSeratoBeatgrid(file),
      ]);
      setTags(parsedTags);
      setGrid(parsedGrid);
    } catch {
      setTags({});
      setGrid(null);
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
  async function decodeIfNeeded(): Promise<boolean> {
    if (isDecodedRef.current) return true;
    if (!pendingBufferRef.current) return false;
    const deck = deckRef.current!;
    try {
      await deck.decode(pendingBufferRef.current);
      deck.setTempo(tempoRef.current);
      isDecodedRef.current = true;
      setIsDecoded(true);
      return true;
    } catch {
      setStatus("error");
      return false;
    }
  }

  async function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-picking the same file later
    if (!file) return;
    await loadFromBlob(file, file.name);
  }

  async function handleLoadTestTrack() {
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
    tags,
    grid,
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
  cues,
  rehearsing,
  onToggleRehearse,
  onMark,
  onAssignClip,
  onAssignSingalong,
  onDeleteCue,
  onNudgeCue,
}: {
  label: string;
  accentClass: string;
  deckState: DeckController;
  syncLabel: string;
  syncDisabled: boolean;
  syncDisabledReason: string;
  onSync: () => void;
  cues: Cue[];
  rehearsing: boolean;
  onToggleRehearse: () => void;
  onMark: () => void;
  onAssignClip: (index: number, file: string | null) => void;
  onAssignSingalong: (index: number, durationSeconds: number) => void;
  onDeleteCue: (index: number) => void;
  onNudgeCue: (index: number, deltaSeconds: number) => void;
}) {
  const {
    deck,
    fileInputRef,
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

  const hasTrack = trackName !== null;
  const effectiveBpm = tags.bpm ? tags.bpm * tempo : null;
  const duration = deck.duration; // used only for cue-marker positioning below

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

      <div className={styles.loadRow}>
        <button
          type="button"
          className={styles.bigButton}
          onClick={() => fileInputRef.current?.click()}
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
          <p className={styles.trackName}>{trackName}</p>
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

          <div className={styles.progressWrap}>
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

function CratePanel({
  crate,
  adding,
  fileInputRef,
  onAddClick,
  onFilesSelected,
  onTapTrack,
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
}: {
  crate: CrateTrack[];
  adding: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onAddClick: () => void;
  onFilesSelected: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onTapTrack: (track: CrateTrack) => void;
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
}) {
  const playableCount = driveTracks?.filter((t) => t.playable).length ?? 0;
  const uncachedDriveCount = crate.filter((t) => t.source === "drive" && !cachedIds.has(t.id)).length;

  return (
    <section className={styles.cratePanel}>
      <div className={styles.deckHeader}>
        <span className={styles.deckLabel}>Crate</span>
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

      {crate.length === 0 ? (
        <p className={styles.hint}>
          No tracks yet — add MP3s to build your crate. Local file-picker tracks are in-memory only (reloading
          clears them); Drive tracks restore automatically.
        </p>
      ) : (
        <ul className={styles.crateList}>
          {crate.map((track) => {
            // A track is "party-safe" (plays even if wifi dies) once its full
            // audio is cached — local file-picker entries always are (the
            // File is already in memory), Drive entries once getTrackBlob()
            // has actually downloaded them at least once.
            const isCached = track.source === "local" || cachedIds.has(track.id);
            return (
              <li key={track.id}>
                <button type="button" className={styles.crateItemButton} onClick={() => onTapTrack(track)}>
                  <span className={styles.crateItemName}>
                    {isCached ? "• " : ""}
                    {track.name}
                  </span>
                  <span className={styles.crateItemMeta}>
                    {track.bpm ? `${track.bpm} BPM` : "no BPM"}
                    {track.key ? ` · ${track.key}` : ""}
                    {" · grid: "}
                    {track.grid ? "yes" : "est"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className={styles.driveSection}>
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
}) {
  return (
    <section className={styles.brainPanel}>
      <div className={styles.deckHeader}>
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

      <div className={styles.costTicker}>
        <span className={styles.costTotal}>
          Session cost: <strong>${costTotal.toFixed(4)}</strong>
        </span>
        {lastCost !== null && (
          <span className={styles.costLastCall}>
            last call: ${lastCost.toFixed(4)}
            {lastModel ? ` (${lastModel})` : ""}
          </span>
        )}
        <button type="button" className={styles.resetButton} onClick={onResetCost}>
          Reset
        </button>
      </div>

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
  onWarmUp,
  warmingUp,
}: {
  liveDeckLabel: DeckLabel | null;
  onPlayFx: (name: SfxName) => void;
  onScratch: (pattern: ScratchPattern) => void;
  onRoll: (fx: RollFxName) => void;
  onPlayVocal: (category: VocalCategory) => void;
  onWarmUp: () => void;
  warmingUp: boolean;
}) {
  const scratchDisabled = liveDeckLabel === null;
  const scratchDisabledReason = "No live deck to scratch — play a deck first";
  // Only render a pad for a category that actually has clips in this
  // manifest — a pruned/empty category (or a fresh checkout before
  // `npm run make:vocal-manifest` has ever run) never shows a broken pad.
  const presentVocalCategories = VOCAL_CATEGORIES.filter((c) => VOCAL_GROUPS[c].length > 0);
  // Host-only categories (shout-outs) are never brain-triggerable — see
  // vocal.ts's HOST_ONLY_CATEGORIES doc comment. Same "only show a pad for a
  // category with real clips" rule as above; there are none pre-generated
  // yet, so this section stays hidden until the owner adds shoutout-*.mp3
  // clips ahead of a party.
  const presentHostCategories = HOST_ONLY_CATEGORIES.filter((c) => VOCAL_GROUPS[c].length > 0);

  return (
    <section className={styles.fxPanel}>
      <div className={styles.deckHeader}>
        <span className={styles.deckLabel}>FX</span>
        <button type="button" className={styles.secondaryButton} onClick={onWarmUp} disabled={warmingUp}>
          {warmingUp ? "Warming up…" : "Warm up FX"}
        </button>
      </div>
      <div className={styles.fxRow}>
        <button type="button" className={styles.fxButton} onClick={() => onPlayFx("airhorn")}>
          Airhorn
        </button>
        <button type="button" className={styles.fxButton} onClick={() => onPlayFx("siren")}>
          Siren
        </button>
        <button type="button" className={styles.fxButton} onClick={() => onPlayFx("riser")}>
          Riser
        </button>
        <button type="button" className={styles.fxButton} onClick={() => onPlayFx("rewind")}>
          Rewind
        </button>
      </div>
      <div className={styles.fxRow}>
        <button type="button" className={styles.fxButton} onClick={() => onPlayFx("laser")}>
          Laser
        </button>
        <button type="button" className={styles.fxButton} onClick={() => onPlayFx("brake")}>
          Brake
        </button>
        <button type="button" className={styles.fxButton} onClick={() => onPlayFx("cheer")}>
          Cheer
        </button>
      </div>
      <div className={styles.fxRow}>
        <button
          type="button"
          className={styles.fxButton}
          onClick={() => onScratch("baby")}
          disabled={scratchDisabled}
          title={scratchDisabled ? scratchDisabledReason : undefined}
        >
          Baby
        </button>
        <button
          type="button"
          className={styles.fxButton}
          onClick={() => onScratch("chirp")}
          disabled={scratchDisabled}
          title={scratchDisabled ? scratchDisabledReason : undefined}
        >
          Chirp
        </button>
        <button
          type="button"
          className={styles.fxButton}
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
          className={styles.fxButton}
          onClick={() => onRoll("roll_eighth")}
          disabled={scratchDisabled}
          title={scratchDisabled ? scratchDisabledReason : undefined}
        >
          Roll ⅛
        </button>
        <button
          type="button"
          className={styles.fxButton}
          onClick={() => onRoll("roll_quarter")}
          disabled={scratchDisabled}
          title={scratchDisabled ? scratchDisabledReason : undefined}
        >
          Roll ¼
        </button>
        <button
          type="button"
          className={styles.fxButton}
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
            <span className={styles.deckLabel}>Vocals</span>
          </div>
          {/* Two pads max per row (rather than one long row) keeps each pad
              big/tappable on a phone even with all six categories present. */}
          {[presentVocalCategories.slice(0, 3), presentVocalCategories.slice(3, 6)]
            .filter((row) => row.length > 0)
            .map((row, i) => (
              <div className={styles.fxRow} key={i}>
                {row.map((category) => (
                  <button
                    key={category}
                    type="button"
                    className={styles.fxButton}
                    onClick={() => onPlayVocal(category)}
                  >
                    {VOCAL_PAD_LABELS[category]}
                  </button>
                ))}
              </div>
            ))}
        </>
      )}
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
  function recordFxFired() {
    lastFxAtRef.current = Date.now();
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
  const deckA = useDeckController(coreRef.current, FIXTURE_A, {
    onCueKeyKnown: setCueKeyA,
    onTempoGlideCancel: () => cancelTempoGlide("A"),
    onManualPause: () => handleManualPauseDuringTransition(),
  });
  const deckB = useDeckController(coreRef.current, FIXTURE_B, {
    onCueKeyKnown: setCueKeyB,
    onTempoGlideCancel: () => cancelTempoGlide("B"),
    onManualPause: () => handleManualPauseDuringTransition(),
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
  useEffect(() => {
    setCostTotal(loadCostTotal());
  }, []);

  // --- Lazy-crate: auto-restore the metadata list on page load (a reload
  // at the party must not lose the crate) ---
  useEffect(() => {
    const restored = loadCrateList();
    if (restored.length === 0) return;
    setCrate((prev) => {
      const existingIds = new Set(prev.map((t) => t.id));
      const restoredTracks: CrateTrack[] = restored
        .filter((entry) => !existingIds.has(entry.id))
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          size: entry.size,
          bpm: entry.bpm,
          key: entry.key,
          grid: entry.grid,
          source: "drive",
        }));
      return [...prev, ...restoredTracks];
    });
    pushBrainLog("crate", `Crate restored (${restored.length} track${restored.length === 1 ? "" : "s"})`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persists the crate's Drive-sourced entries (metadata only, never a File
  // blob) on every change — local file-picker entries are deliberately
  // excluded, same in-memory-only behavior as before this milestone.
  useEffect(() => {
    const driveEntries: PersistedCrateEntry[] = crate
      .filter((t) => t.source === "drive")
      .map((t) => ({ id: t.id, name: t.name, size: t.size, bpm: t.bpm, key: t.key, grid: t.grid }));
    saveCrateList(driveEntries);
  }, [crate]);

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
  const retryTimeoutHandleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Review-panel fix (vibe-note persistence): the human's most recent chat
  // submission + when it was sent, so EVERY brain call (autopilot-driven
  // included, not just the one the human actually typed into) can report
  // state.lastVibeNote with an honest age — previously a vibe note only
  // rode along on the single request it was typed into.
  const lastVibeNoteRef = useRef<{ text: string; at: number } | null>(null);
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
    const cached = mixPointsCacheRef.current.get(item.id);
    if (cached) return cached;
    const buffer = ctrl.deck.audioBuffer;
    if (!buffer) return null;
    const rms = computeRmsPerSecond(buffer.getChannelData(0), buffer.sampleRate);
    const grid = effectiveGrid(ctrl.tags, ctrl.grid);
    let points = findMixPoints(rms, grid ? { anchor: grid.anchor, bpm: grid.bpm } : null);
    const cueKey = cueTrackKey({ source: item.source, id: item.id, name: item.name, size: item.size });
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
    if (a.isPlaying && !b.isPlaying) return "A";
    if (b.isPlaying && !a.isPlaying) return "B";
    if (a.isPlaying && b.isPlaying) return crossfadeRef.current <= 0.5 ? "A" : "B";
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
  async function getTrackForPlayback(track: CrateTrack): Promise<File | Blob> {
    if (track.source === "local") {
      if (!track.file) throw new Error(`"${track.name}" is a local entry with no file loaded`);
      return track.file;
    }
    const blob = await getTrackBlob(
      track.id,
      async () => {
        const response = await fetchWithPasscode(`/api/crate/${encodeURIComponent(track.id)}`);
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
            return {
              id: track.id,
              name: track.name,
              size: track.size,
              source: "drive",
              bpm: manifestTags.bpm,
              key: manifestTags.key,
              grid: manifestTags.grid,
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

    const added = results.filter((t): t is CrateTrack => t !== null);
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
  }

  // --- Brain state serialization + log (Part C) ---

  function pushBrainLog(action: string, say: string) {
    const id = brainLogIdRef.current++;
    setBrainLog((prev) => [...prev, { id, action, say }].slice(-BRAIN_LOG_LIMIT));
  }

  function appendHistory(entry: { trackId: string; name: string }) {
    setHistory((prev) => [...prev, entry].slice(-HISTORY_LIMIT));
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

    // Choir round #2 (P1): true while a queue command already issued is
    // still resolving (queueInFlightRef — download/decode/phrase-wait) OR a
    // transition is actively running — see DjLiveState.transitionPending's
    // own doc comment in brain.ts.
    const transitionPending = queueInFlightRef.current || transitionEngineRef.current.isRunning;

    return {
      trackId: ctrl.trackId ?? ctrl.trackName,
      name: ctrl.trackName,
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
      transitionPending,
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
      const cleaned = cleanTrackName(t.name);
      const displayName = cleaned.artist ? `${cleaned.artist} - ${cleaned.title}` : cleaned.title;
      // Camelot conversion (Part 3) — same toCamelot() call deckLiveState uses.
      const camelotKey = toCamelot(t.key);
      // Vocal map lookup (Part 1) — keyed the same way vocal-maps.json/
      // cue-suggestions.json key every track (src/lib/cue-store.ts's cueTrackKey).
      const key = cueTrackKey({ source: t.source, id: t.id, name: t.name, size: t.size });
      const intervals = getVocalIntervals(VOCAL_MAPS, key);
      const firstVocalSeconds = intervals.length > 0 ? Math.min(...intervals.map(([s]) => s)) : null;
      return buildCompactCrateEntry(n, displayName, t.bpm, camelotKey, t.grid !== null, firstVocalSeconds);
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

  // --- Command execution (Parts B+C: brain picks, engine executes) ---

  function executeTempoNudge(command: TempoNudgeCommand) {
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
    if (!isHumanInitiated(cooldownReason)) {
      const secondsAgo = lastFxAtRef.current === null ? null : (Date.now() - lastFxAtRef.current) / 1000;
      if (secondsAgo !== null && secondsAgo < AUTOPILOT_FX_COOLDOWN_SECONDS) {
        pushBrainLog(
          "fx",
          `skipped "${command.fx}" — hard cooldown floor (${secondsAgo.toFixed(0)}s < ${AUTOPILOT_FX_COOLDOWN_SECONDS}s), root=${cooldownReason}`
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
      const started = scratch(deckByLabel(liveLabel).deck, coreRef.current!, scratchPattern);
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
        recordFxFired();
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
    const liveLabel = getLiveDeckLabel();
    if (!liveLabel) {
      pushBrainLog("error", "eq: no live deck to adjust");
      return;
    }
    deckByLabel(liveLabel).deck.setEq({ low: command.low, mid: command.mid, high: command.high });
  }

  /** Phrase-aligned firing (Part 2): cancels any pending phrase-delayed transition start — a new queue command superseding it, or the user manually intervening (pause on either deck — see useDeckController's onManualPause). Single slot, latest/only-one wins. Logs a line when it actually had something to cancel (choir round #2, P1 — "make every cancelation log a line to the brain log"). */
  function cancelPendingTransitionStart() {
    if (pendingTransitionTimeoutRef.current) {
      clearTimeout(pendingTransitionTimeoutRef.current);
      pendingTransitionTimeoutRef.current = null;
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
  function handleManualPauseDuringTransition() {
    cancelPendingTransitionStart();
    if (transitionEngineRef.current.isRunning) {
      // clearPendingMaskFxRelease() lives INSIDE this branch, not
      // unconditionally above it (self-review catch): a deferred maskFx
      // release can still be legitimately pending AFTER a transition has
      // already completed normally (see C4) — an unrelated manual pause on
      // some other deck a moment later must not silently drop that timer
      // without ever applying the release, which would leave a swept
      // filter/reverb stuck forever. allNeutral() below already covers the
      // release for the transition actually being canceled here.
      clearPendingMaskFxRelease();
      transitionEngineRef.current.cancel();
      setTransitionRunning(false);
      deckA.deck.allNeutral();
      deckB.deck.allNeutral();
      pushBrainLog("transition", "canceled — a deck was paused manually mid-transition");
    }
  }

  async function executeQueueCommand(command: QueueCommand) {
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
    if (queueInFlightRef.current) {
      pushBrainLog("error", `queue: dropped — still resolving a previous queue command`);
      return;
    }
    queueInFlightRef.current = true;
    let queueInFlightReleased = false;
    const releaseQueueInFlight = () => {
      if (queueInFlightReleased) return;
      queueInFlightReleased = true;
      queueInFlightRef.current = false;
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
    const trackIndex = Number(command.trackId);
    const realId = Number.isFinite(trackIndex) ? crateIndexMapRef.current.get(trackIndex) : undefined;
    const item = realId !== undefined ? crateRef.current.find((t) => t.id === realId) : undefined;
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

    // Lazy-crate: resolve the real audio (cache hit, or download through
    // the proxy — see getTrackForPlayback()) BEFORE handing it to the deck.
    // A download failure (dead wifi, Drive error) goes through the exact
    // same guard-reset-and-log path as the pre-existing "not found"/
    // "could not decode" failures below, so autopilot's failure ladder
    // (retry, then stop with a log line) still applies unchanged.
    let blob: File | Blob;
    try {
      blob = await getTrackForPlayback(track);
    } catch (err) {
      pushBrainLog(
        "error",
        `queue: could not download "${track.name}" (${err instanceof Error ? err.message : "network error"})`
      );
      askedForTrackRef.current = null;
      releaseQueueInFlight();
      return;
    }

    await idleCtrl.loadFile(blob, track.name, track.id, track.source);
    const decoded = await idleCtrl.decodeIfNeeded();
    if (!decoded) {
      pushBrainLog("error", `queue: could not decode "${track.name}"`);
      askedForTrackRef.current = null; // see the comment on the missing-track branch above
      releaseQueueInFlight();
      return;
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
    if (startAt === "auto" && mixPoints && mixPoints.mixInSeconds > 0) {
      idleCtrl.deck.seekTo(mixPoints.mixInSeconds);
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
      if (!liveCtrl.isPlaying) {
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
          loopOverlayStop = fireLoopOverlay(liveCtrl.deck, coreRef.current!, loopBlendPlan.loopStart, loopBlendPlan.loopEnd);
        },
        onLoopBlendEnd: () => {
          loopOverlayStop?.();
          loopOverlayStop = null;
        },
        onGain: (progress) => {
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

      idleCtrl.markPlaying();
      setTransitionRunning(true);
      appendHistory({ trackId: track.id, name: track.name });
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
      const incomingStartSeconds = startAt === "auto" && mixPoints ? mixPoints.mixInSeconds : 0;
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
    pushBrainLog(command.action, command.say ?? "");
    switch (command.action) {
      case "queue":
        void executeQueueCommand(command);
        return;
      case "tempo_nudge":
        executeTempoNudge(command);
        return;
      case "fx":
        executeFxCommand(command, cooldownReason);
        return;
      case "eq":
        executeEqCommand(command);
        return;
      case "none":
        return;
    }
  }

  // --- Calling the brain (Part C+D) ---

  function handleAutopilotFailure(originalMessage: string | null, reason: ConsultReason) {
    if (retryStageRef.current === 0) {
      retryStageRef.current = 1;
      retryTimeoutHandleRef.current = setTimeout(() => {
        retryTimeoutHandleRef.current = null;
        void callBrain(originalMessage, { autopilotDriven: true, consultReason: reason });
      }, AUTOPILOT_RETRY_DELAY_MS);
    } else {
      retryStageRef.current = 0;
      setAutopilot(false);
      pushBrainLog("error", "autopilot stopped — the retry also failed");
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
    if (brainBusyRef.current) {
      followUpRetryTimeoutRef.current = setTimeout(() => {
        followUpRetryTimeoutRef.current = null;
        if (brainBusyRef.current) {
          pushBrainLog("error", "follow-up dropped — brain still busy");
          return;
        }
        pushBrainLog("none", "El Cerebro checking back now (after a busy retry)…");
        void callBrain(null, { consultReason: "follow_up" });
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

      const response = await fetchWithPasscode("/api/dj", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          state: buildDjState(options.consultReason),
          crate: window.entries,
          crateCacheable: !window.windowed,
          lessons: summarizeLessons(transitionRecordsRef.current),
          ledger: ledgerDigest,
        }),
      });

      let json: { command?: unknown; error?: string; cost_usd?: number; model?: string } | null = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }

      if (!response.ok || !json || json.error) {
        const errMsg = json?.error || `brain call failed (HTTP ${response.status})`;
        pushBrainLog("error", errMsg);
        if (options.autopilotDriven) handleAutopilotFailure(message, options.consultReason);
        return;
      }

      // Defense in depth: the route already validates before responding,
      // but the executor treats anything that fails local validation as a
      // no-op with an honest log line rather than trusting the wire.
      const parsed = CommandSchema.safeParse(json.command);
      if (!parsed.success) {
        pushBrainLog("none", "(brain reply failed local validation — treated as no-op)");
        return;
      }

      // M5 cost ticker: cost fields are only present on the route's clean
      // success path (see api/dj/route.ts) — offline/no-key/refusal paths
      // never reach here with a cost_usd, so the ticker naturally doesn't
      // advance for them.
      if (typeof json.cost_usd === "number" && Number.isFinite(json.cost_usd)) {
        const callCost = json.cost_usd;
        setLastCost(callCost);
        if (typeof json.model === "string") setLastModel(json.model);
        setCostTotal((prev) => {
          const next = prev + callCost;
          saveCostTotal(next);
          return next;
        });
      }

      retryStageRef.current = 0; // a successful round-trip resets the retry ladder
      executeCommand(parsed.data, cooldownReason);
      // Deferred re-consult: honor followUpSeconds from ANY response
      // (chat-initiated or autopilot-initiated) — this does not itself
      // cancel a pending follow-up scheduled by an earlier response; only
      // a new chat, a new followUp, or autopilot-off do that (see
      // scheduleFollowUp/cancelFollowUp). Re-schedule inherits cooldownReason
      // (the resolved root), not options.consultReason, so a follow_up chain
      // never loses/mutates its root.
      if (typeof parsed.data.followUpSeconds === "number") {
        scheduleFollowUp(parsed.data.followUpSeconds, cooldownReason);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "network error contacting the brain";
      pushBrainLog("error", errMsg);
      if (options.autopilotDriven) handleAutopilotFailure(message, options.consultReason);
    } finally {
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

  function handleChatSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = chatInput.trim();
    if (!trimmed) return;
    coreRef.current?.ensureContext(); // this submit is a user gesture too
    lastVibeNoteRef.current = { text: trimmed, at: Date.now() }; // persists into every later call's state.lastVibeNote, not just this one
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
    coreRef.current?.ensureContext();
    const liveLabel = getLiveDeckLabel();
    if (!liveLabel) return; // button is already disabled in this state; defensive no-op
    const started = scratch(deckByLabel(liveLabel).deck, coreRef.current!, pattern);
    if (started) {
      recordFxFired();
      recordFxDemonstration(`scratch_${pattern}`);
      recordLedgerFx(`scratch_${pattern}`, "manual");
    }
  }

  /** Audio engine v2, Part 2 (beat rolls) — manual pad handler, mirrors handleScratchButton's duck-overlay shape exactly. `bpm` is the live deck's TAGGED bpm (fireRoll needs it, same convention as every other bpm-aware Deck-adjacent call in this file); an untagged live track falls back to NEUTRAL_BPM_FALLBACK so the roll still fires (at a guessed tempo) rather than silently doing nothing. */
  function handleRollButton(fx: RollFxName) {
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

  // Autopilot poll loop (Part D). Deliberately narrow deps ([autopilot,
  // crate.length]) so this doesn't tear down/recreate the interval on every
  // progress-bar tick — see the deckARef/deckBRef/crateRef mirrors above for
  // how the callback still reads fresh values every second.
  useEffect(() => {
    if (!autopilot) return;
    const interval = setInterval(() => {
      if (brainBusyRef.current || transitionEngineRef.current.isRunning) return;

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

      const liveState = deckLiveState(deckByLabel(liveLabel));
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
      if ((nearingEnd || nearingMixOut) && askedForTrackRef.current?.key !== liveState.trackId) {
        askedForTrackRef.current = { key: liveState.trackId, at: Date.now() };
        void callBrain(null, { autopilotDriven: true, consultReason: "autopilot_poll" });
      }
    }, AUTOPILOT_POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autopilot, crate.length]);

  // Clear any pending autopilot retry timer (and any pending deferred
  // re-consult) on unmount.
  useEffect(() => {
    return () => {
      if (retryTimeoutHandleRef.current) clearTimeout(retryTimeoutHandleRef.current);
      cancelFollowUp();
    };
  }, []);

  return (
    <main className={styles.main}>
      <h1 className={styles.title}>DJ Supermercado</h1>

      <CratePanel
        crate={crate}
        adding={crateAdding}
        fileInputRef={crateFileInputRef}
        onAddClick={() => crateFileInputRef.current?.click()}
        onFilesSelected={handleAddToCrate}
        onTapTrack={handleCrateTap}
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
      />

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

      <FxPanel
        liveDeckLabel={getLiveDeckLabel()}
        onPlayFx={handlePlayFx}
        onScratch={handleScratchButton}
        onRoll={handleRollButton}
        onPlayVocal={handlePlayVocal}
        onWarmUp={() => void handleWarmUpFx()}
        warmingUp={fxWarmingUp}
      />

      <DeckPanel
        label="Deck A"
        accentClass={styles.deckA}
        deckState={deckA}
        syncLabel="Beat Sync A→B"
        syncDisabled={syncDisabled}
        syncDisabledReason={syncDisabledReason}
        onSync={handleBeatSyncAtoB}
        cues={cueKeyA ? getCues(cueStore, cueKeyA) : []}
        rehearsing={rehearseA}
        onToggleRehearse={() => handleToggleRehearse("A")}
        onMark={() => handleMarkCue("A")}
        onAssignClip={(index, file) => handleAssignCueClip("A", index, file)}
        onAssignSingalong={(index, duration) => handleAssignCueSingalong("A", index, duration)}
        onDeleteCue={(index) => handleDeleteCue("A", index)}
        onNudgeCue={(index, delta) => handleNudgeCue("A", index, delta)}
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
      </div>

      <DeckPanel
        label="Deck B"
        accentClass={styles.deckB}
        deckState={deckB}
        syncLabel="Beat Sync B→A"
        syncDisabled={syncDisabled}
        syncDisabledReason={syncDisabledReason}
        onSync={handleBeatSyncBtoA}
        cues={cueKeyB ? getCues(cueStore, cueKeyB) : []}
        rehearsing={rehearseB}
        onToggleRehearse={() => handleToggleRehearse("B")}
        onMark={() => handleMarkCue("B")}
        onAssignClip={(index, file) => handleAssignCueClip("B", index, file)}
        onAssignSingalong={(index, duration) => handleAssignCueSingalong("B", index, duration)}
        onDeleteCue={(index) => handleDeleteCue("B", index)}
        onNudgeCue={(index, delta) => handleNudgeCue("B", index, delta)}
      />
    </main>
  );
}
