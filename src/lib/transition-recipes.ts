import { syncTempo } from "./beatmatch.ts";
import { cueTrackKey } from "./cue-store.ts";
import { toCamelot } from "./camelot.ts";
import type { LoopPointsFile } from "./loop-points.ts";
import type { SeratoBeatgrid } from "./serato.ts";
import {
  analyzeHarmonicRelationship,
  analyzeGrooveInterlock,
  classifyRhythmicGroove,
  planTurntablistChoreography,
  rankCandidatesByMusicTheory,
  type HarmonicModulationMode,
  type GrooveFamilyId,
} from "./music-theory-master.ts";

export {
  analyzeHarmonicRelationship,
  analyzeGrooveInterlock,
  classifyRhythmicGroove,
  planTurntablistChoreography,
  rankCandidatesByMusicTheory,
  type HarmonicModulationMode,
  type GrooveFamilyId,
};

export type RecipeSource = "drive" | "local";
export type RecipeIsolation = "beat" | "melody";
export type RecipeTransition = "beatmatch_crossfade" | "cut" | "bass_swap" | "echo_out" | "gap" | "loop_blend";
export type RecipeMaskFx =
  | "airhorn"
  | "siren"
  | "laser"
  | "brake"
  | "rewind"
  | "cheer"
  | "subdrop"
  | "crash"
  | "timbale"
  | "downlifter"
  | "dub_siren"
  | "horn_stab"
  | "cryo_jet"
  | "booyaka"
  | "gunshot"
  | "space_sweep";

export interface RecipeTrack {
  id: string;
  name: string;
  source: RecipeSource;
  size: number | null;
  bpm: number | null;
  key: string | null;
  durationSeconds: number | null;
  grid: SeratoBeatgrid | null;
}

export type RecipeCommand =
  | {
      action: "queue";
      transition: RecipeTransition;
      durationBars: number;
      maskFx?: RecipeMaskFx;
      startAt: "auto" | "beginning";
    }
  | {
      action: "routine";
      routine: "sample_mix";
      sample: {
        captureBars: 2 | 4 | 8;
        isolation: RecipeIsolation;
        holdSeconds: number;
        halvings: number;
        sweepToBpm: number;
      };
      queue: {
        transition: "bass_swap";
        durationBars: 4;
        maskFx?: RecipeMaskFx;
        startAt: "auto" | "beginning";
      };
    }
  | {
      action: "stem_migrate";
      bars: 8 | 16 | 32;
      anchor: "out" | "in";
    };

export type EqSwapStrategy =
  | "instant-bass-swap"
  | "gradual-low-shelf"
  | "stem-bass-cut-bar-4";

export interface TransitionRecipe {
  fromId: string;
  toId: string;
  score: number;
  reason: string;
  subBassPhaseCoherence: number;
  pitchShiftSemitones: number;
  eqSwapStrategy: EqSwapStrategy;
  command: RecipeCommand;
}

export interface TransitionRecipeFile {
  version: number;
  generatedAt: string;
  tracks: number;
  recipes: Record<string, TransitionRecipe[]>;
}

export interface BuildTransitionRecipesOptions {
  maxPerTrack?: number;
  nowIso?: string;
}

export interface SelectTransitionRecipeOptions {
  availableIds: Set<string>;
  excludedIds?: Set<string>;
}

const RECIPE_VERSION = 1;
const DEFAULT_MAX_PER_TRACK = 8;

import { resolveMusicMetadata } from "./music-metadata.ts";

export function recipeTrackKey(track: Pick<RecipeTrack, "source" | "id" | "name" | "size">): string {
  return cueTrackKey(track);
}

export function isPartnerDanceTrackName(name: string): boolean {
  const lower = name.toLowerCase();
  if (/\b(gilberto santa rosa)\b/.test(lower)) return true;
  const resolvedGenre = resolveMusicMetadata({ name }).genre.toLowerCase();
  if (/\b(reggaeton|cubaton|latin trap|dembow|house|trance|hip-hop|rock|reggae|afrobeats|guaracha|dance pop|latin dance|dance|latin pop|pop)\b/.test(resolvedGenre)) {
    return false;
  }
  const patterns = [
    /\b(salsa|bachata|son|merengue)\b/,
    /\b(aventura|romeo santos|prince royce|monchy|alexandra|judy santos|frank reyes|raulin rodriguez|anthony santos)\b/,
    /\b(marc anthony|hector lavoe|willie colon|celia cruz|grupo niche|oscar d'leon|oscar de leon|el gran combo|frankie ruiz|victor manuelle)\b/,
    /\b(gilberto santa rosa|gente de zona|kelvis ochoa|ruben blades|tito nieves|india)\b/,
  ];
  return patterns.some((pattern) => pattern.test(lower));
}

export function isTranceTrackName(name: string): boolean {
  return /\b(trance|paul van dyk|paul oakenfold|yahel|ferry corsten|above.{0,3}beyond)\b/i.test(name) && !isPartnerDanceTrackName(name);
}

/** Current audio identity plus matching timeline; never relabel old trim cues by title. */
export function compatibleLoopPoints(tracks: RecipeTrack[], points: LoopPointsFile): LoopPointsFile {
  const result: LoopPointsFile = {};
  for (const t of tracks) {
    const key = recipeTrackKey(t), p = points[key];
    if (!p || !t.grid || t.durationSeconds === null || Math.abs(p.durationSeconds - t.durationSeconds) > 0.25 || Math.abs(p.anchor - t.grid.anchor) > 0.05 || Math.abs(p.bpm - t.grid.bpm) > 0.1) continue;
    result[key] = p;
  }
  return result;
}

export function camelotCompatible(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const left = /^(\d{1,2})([AB])$/.exec(a);
  const right = /^(\d{1,2})([AB])$/.exec(b);
  if (!left || !right) return false;
  const leftNumber = Number(left[1]);
  const rightNumber = Number(right[1]);
  const leftMode = left[2];
  const rightMode = right[2];
  if (leftMode !== rightMode && leftNumber === rightNumber) return true;
  if (leftMode !== rightMode) return false;
  const distance = Math.min(Math.abs(leftNumber - rightNumber), 12 - Math.abs(leftNumber - rightNumber));
  return distance <= 1;
}

function strongestLoop(loopPoints: LoopPointsFile, track: RecipeTrack, requireVocalFree: boolean) {
  const entry = loopPoints[recipeTrackKey(track)];
  if (!entry) return null;
  const vfLoops = entry.loops.filter((loop) => loop.vocalFree && loop.beatPresent === true);
  if (vfLoops.length > 0) {
    return vfLoops.reduce((best, loop) => (loop.score > best.score ? loop : best));
  }
  const beatLoops = requireVocalFree
    ? entry.loops.filter((loop) => loop.beatPresent === true)
    : entry.loops;
  if (beatLoops.length === 0) return null;
  return beatLoops.reduce((best, loop) => (loop.score > best.score ? loop : best));
}

function hasDropEntry(loopPoints: LoopPointsFile, track: RecipeTrack): boolean {
  const entry = loopPoints[recipeTrackKey(track)];
  return !!entry && entry.drops.some((drop) => drop.entry32Seconds !== null || drop.entry16Seconds !== null);
}

function roundScore(score: number): number {
  return Math.round(score * 10000) / 10000;
}

export function camelotToPitchClass(camelot: string | null): number | null {
  if (!camelot) return null;
  const match = /^(\d{1,2})([AB])$/.exec(camelot);
  if (!match) return null;
  const num = Number(match[1]);
  const mode = match[2];
  if (num < 1 || num > 12) return null;
  return mode === "B" ? ((num * 7) + 4) % 12 : ((num * 7) + 1) % 12;
}

export function computePitchShiftSemitones(
  fromKey: string | null,
  toKey: string | null,
  tempoRatio: number
): number {
  const safeRatio = Number.isFinite(tempoRatio) && tempoRatio > 0 ? tempoRatio : 1;
  const tempoSemitones = 12 * Math.log2(safeRatio);
  const fromPc = camelotToPitchClass(fromKey);
  const toPc = camelotToPitchClass(toKey);
  if (fromPc !== null && toPc !== null) {
    const targets = [fromPc, (fromPc + 7) % 12, (fromPc + 5) % 12];
    let bestDelta = Infinity;
    for (const target of targets) {
      const rawDelta = target - (toPc + tempoSemitones);
      const wrapped = ((((rawDelta % 12) + 18) % 12) - 6);
      if (Math.abs(wrapped) < Math.abs(bestDelta)) {
        bestDelta = wrapped;
      }
    }
    const candidate = tempoSemitones + bestDelta;
    if (Math.abs(candidate) <= 1.5) {
      return Math.round(candidate * 1000) / 1000;
    }
  }
  const clamped = Math.max(-1.5, Math.min(1.5, tempoSemitones));
  return Math.round(clamped * 1000) / 1000;
}

export function computeSubBassPhaseCoherence(
  from: RecipeTrack,
  to: RecipeTrack,
  tempoRatio: number,
  harmonic: boolean,
  hasOutgoingLoop: boolean,
  hasIncomingDrop: boolean
): number {
  const bothGridded = from.grid !== null && to.grid !== null;
  const oneGridded = (from.grid !== null) !== (to.grid !== null);
  let coherence = bothGridded ? 0.86 : oneGridded ? 0.78 : 0.7;
  const tempoDrift = Math.abs(1 - (Number.isFinite(tempoRatio) ? tempoRatio : 1));
  coherence -= Math.min(0.18, tempoDrift * 0.45);
  if (harmonic) coherence += 0.04;
  if (hasOutgoingLoop) coherence += 0.045;
  if (hasIncomingDrop) coherence += 0.035;
  if (from.grid && to.grid && from.bpm && to.bpm) {
    const beatSec = 60 / Math.max(60, from.bpm);
    const phaseDiff = Math.abs((from.grid.anchor - to.grid.anchor) % beatSec);
    const normalizedPhase = Math.min(phaseDiff, beatSec - phaseDiff) / (beatSec * 0.5);
    coherence += 0.015 * (1 - Math.min(1, Math.max(0, normalizedPhase)));
  }
  return Math.round(Math.max(0.55, Math.min(0.995, coherence)) * 10000) / 10000;
}

export function computeEqSwapStrategy(
  command: RecipeCommand,
  subBassPhaseCoherence: number,
  harmonic: boolean
): EqSwapStrategy {
  if (command.action === "stem_migrate") {
    return "stem-bass-cut-bar-4";
  }
  if (command.action === "routine" && command.routine === "sample_mix") {
    return command.sample.isolation === "beat" && subBassPhaseCoherence >= 0.86
      ? "stem-bass-cut-bar-4"
      : "instant-bass-swap";
  }
  if (command.action === "queue") {
    if (command.transition === "bass_swap" || command.transition === "cut" || subBassPhaseCoherence < 0.82) {
      return "instant-bass-swap";
    }
    if (command.transition === "beatmatch_crossfade" && harmonic && subBassPhaseCoherence >= 0.84) {
      return "gradual-low-shelf";
    }
    return command.transition === "gap" ? "gradual-low-shelf" : "instant-bass-swap";
  }
  return "instant-bass-swap";
}

function buildRecipe(from: RecipeTrack, to: RecipeTrack, loopPoints: LoopPointsFile): TransitionRecipe | null {
  if (from.id === to.id) return null;
  if (!from.bpm || !to.bpm) return null;

  const fromPartner = isPartnerDanceTrackName(from.name);
  const toPartner = isPartnerDanceTrackName(to.name);
  const fromKey = toCamelot(from.key);
  const toKey = toCamelot(to.key);
  const harmonic = camelotCompatible(fromKey, toKey);
  const sync = syncTempo(from.bpm, 1, to.bpm);
  const cleanTempo = !sync.clamped;
  const outgoingLoop = strongestLoop(loopPoints, from, true);
  const incomingDrop = hasDropEntry(loopPoints, to);
  const bothGridded = from.grid !== null && to.grid !== null;
  const pitchShiftSemitones = computePitchShiftSemitones(fromKey, toKey, sync.tempo);
  const subBassPhaseCoherence = computeSubBassPhaseCoherence(
    from,
    to,
    sync.tempo,
    harmonic,
    outgoingLoop !== null,
    incomingDrop
  );

  if (fromPartner || toPartner) {
    const command: RecipeCommand = { action: "queue", transition: "gap", durationBars: 8, startAt: "beginning" };
    return {
      fromId: from.id,
      toId: to.id,
      score: roundScore(0.25 + (fromPartner && toPartner ? 0.35 : 0) + (harmonic ? 0.1 : 0)),
      reason: "partner-dance-safe full-song handoff",
      subBassPhaseCoherence,
      pitchShiftSemitones,
      eqSwapStrategy: computeEqSwapStrategy(command, subBassPhaseCoherence, harmonic),
      command,
    };
  }

  if ((outgoingLoop || !cleanTempo) && bothGridded && (incomingDrop || outgoingLoop)) {
    // A held-loop routine always owns an explicit seam insert. The runtime
    // applies this sweep to the loop overlay itself; leaving it optional was
    // how clean/harmonic recipes silently produced no transition texture.
    // Use halvings: 0 for tempo-compatible grooves (steady 4-bar drum/bass
    // pocket) and halvings: 1 when stepping across a wider BPM gap.
    const maskFx: RecipeMaskFx = "space_sweep";
    const isolation: RecipeIsolation = outgoingLoop ? outgoingLoop.isolation : "beat";
    const loopScore = outgoingLoop ? outgoingLoop.score : 0.75;
    const captureBars = outgoingLoop && outgoingLoop.lengthBars === 2 ? 2 : 4;
    const command: RecipeCommand = {
      action: "routine",
      routine: "sample_mix",
      sample: {
        isolation,
        captureBars,
        holdSeconds: 22,
        halvings: cleanTempo ? 0 : 1,
        sweepToBpm: to.bpm,
      },
      queue: {
        transition: "bass_swap",
        durationBars: 4,
        startAt: "auto",
        maskFx,
      },
    };
    return {
      fromId: from.id,
      toId: to.id,
      score: roundScore(
        0.45 +
          Math.min(0.2, loopScore * 0.2) +
          (cleanTempo ? 0.12 : 0.04) +
          (harmonic ? 0.12 : 0) +
          (incomingDrop ? 0.08 : 0) +
          (maskFx ? 0.03 : 0)
      ),
      reason: `${isolation} sample loop into ${incomingDrop ? "drop-entry" : "beat-entry"} with seam sweep`,
      subBassPhaseCoherence,
      pitchShiftSemitones,
      eqSwapStrategy: computeEqSwapStrategy(command, subBassPhaseCoherence, harmonic),
      command,
    };
  }

  if (bothGridded && cleanTempo && harmonic && Math.abs(sync.tempo - 1) <= 0.035) {
    const command: RecipeCommand = {
      action: "stem_migrate",
      bars: 16,
      anchor: "out",
    };
    return {
      fromId: from.id,
      toId: to.id,
      score: roundScore(0.52 + (incomingDrop ? 0.12 : 0) + (fromKey && fromKey === toKey ? 0.08 : 0.04)),
      reason: `16-bar live stem mashup (${fromKey && toKey ? `${fromKey}↔${toKey}` : "harmonic lock"}, ΔBPM ${(Math.abs(sync.tempo - 1) * 100).toFixed(1)}%)`,
      subBassPhaseCoherence,
      pitchShiftSemitones,
      eqSwapStrategy: computeEqSwapStrategy(command, subBassPhaseCoherence, harmonic),
      command,
    };
  }

  const transition: RecipeTransition = cleanTempo ? (harmonic ? "bass_swap" : "beatmatch_crossfade") : "echo_out";
  const maskFx = !cleanTempo || (!harmonic && cleanTempo) ? "space_sweep" : undefined;
  const command: RecipeCommand = {
    action: "queue",
    transition,
    durationBars: cleanTempo ? 8 : 4,
    startAt: "auto",
    ...(maskFx ? { maskFx } : {}),
  };
  return {
    fromId: from.id,
    toId: to.id,
    score: roundScore(
      0.25 +
        (cleanTempo ? 0.25 : 0.04) +
        (harmonic ? 0.18 : 0) +
        (incomingDrop ? 0.12 : 0) +
        (bothGridded ? 0.08 : 0) +
        (maskFx ? 0.03 : 0)
    ),
    reason: `${transition}${incomingDrop ? " into drop-entry" : ""}${maskFx ? " with seam mask" : ""}`,
    subBassPhaseCoherence,
    pitchShiftSemitones,
    eqSwapStrategy: computeEqSwapStrategy(command, subBassPhaseCoherence, harmonic),
    command,
  };
}

export function buildTransitionRecipes(
  tracks: RecipeTrack[],
  loopPoints: LoopPointsFile,
  options: BuildTransitionRecipesOptions = {}
): TransitionRecipeFile {
  const maxPerTrack = options.maxPerTrack ?? DEFAULT_MAX_PER_TRACK;
  const recipes: Record<string, TransitionRecipe[]> = {};
  for (const from of tracks) {
    const ranked = tracks
      .map((to) => buildRecipe(from, to, loopPoints))
      .filter((recipe): recipe is TransitionRecipe => recipe !== null)
      .sort((a, b) => b.score - a.score);
    const candidates: TransitionRecipe[] = [];
    const buckets = new Map<string, number>();
    for (const recipe of ranked) {
      if (candidates.length >= maxPerTrack) break;
      const bucket =
        recipe.command.action === "routine"
          ? `${recipe.command.action}:${recipe.command.sample?.isolation ?? "any"}:${recipe.command.queue.maskFx ?? "dry"}`
          : recipe.command.action === "stem_migrate"
            ? `${recipe.command.action}:${recipe.command.bars}:${recipe.command.anchor}`
            : `${recipe.command.action}:${recipe.command.transition}:${recipe.command.maskFx ?? "dry"}`;
      const count = buckets.get(bucket) ?? 0;
      // Every sample routine now owns the same mandatory seam sweep, so the
      // old two-per-bucket cap would accidentally halve sampler availability.
      const bucketLimit = recipe.command.action === "routine" ? 4 : 2;
      if (count >= bucketLimit) continue;
      buckets.set(bucket, count + 1);
      candidates.push(recipe);
    }
    for (const recipe of ranked) {
      if (candidates.length >= maxPerTrack) break;
      if (!candidates.some((picked) => picked.toId === recipe.toId)) candidates.push(recipe);
    }
    if (candidates.length > 0) recipes[from.id] = candidates;
  }
  return {
    version: RECIPE_VERSION,
    generatedAt: options.nowIso ?? new Date().toISOString(),
    tracks: tracks.length,
    recipes,
  };
}

export function selectTransitionRecipe(
  file: TransitionRecipeFile,
  fromId: string,
  options: SelectTransitionRecipeOptions
): TransitionRecipe | null {
  const candidates = file.recipes[fromId] ?? [];
  const excluded = options.excludedIds ?? new Set<string>();
  return candidates.find((recipe) => options.availableIds.has(recipe.toId) && !excluded.has(recipe.toId)) ?? null;
}
