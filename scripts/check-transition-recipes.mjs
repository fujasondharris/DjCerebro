#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  buildTransitionRecipes,
  camelotCompatible,
  computeEqSwapStrategy,
  computePitchShiftSemitones,
  computeSubBassPhaseCoherence,
  isPartnerDanceTrackName,
  selectTransitionRecipe,
} from "../src/lib/transition-recipes.ts";
import recipes from "../src/data/transition-recipes.json" with { type: "json" };
import manifest from "../src/data/crate-manifest.json" with { type: "json" };

function assertOk(name, condition) {
  assert.ok(condition, name);
  console.log(`PASS: ${name}`);
}

assertOk("camelot: same key compatible", camelotCompatible("8A", "8A"));
assertOk("camelot: adjacent same-mode compatible", camelotCompatible("8A", "9A"));
assertOk("camelot: relative major/minor compatible", camelotCompatible("8A", "8B"));
assertOk("camelot: distant key incompatible", !camelotCompatible("8A", "11B"));
assertOk("partner dance: salsa detected", isPartnerDanceTrackName("Salsa Clasica - Un Verano En NY.mp3"));
assertOk("partner dance: bachata detected", isPartnerDanceTrackName("Aventura - Bachata Mix.mp3"));
assertOk("partner dance: Aventura bachata artist detected even without bachata token", isPartnerDanceTrackName("Aventura - Obsesion.mp3"));
assertOk("partner dance: Gente de Zona / Gilberto Santa Rosa detected even without salsa token", isPartnerDanceTrackName("Gente de Zona, Kelvis Ochoa, Gilberto Santa Rosa - Loco Loco.mp3"));
assertOk("partner dance: reggaeton not partner-dance detected", !isPartnerDanceTrackName("Daddy Yankee - Gasolina.mp3"));

{
  const tracks = [
    {
      id: "from",
      name: "From Track.mp3",
      source: "drive",
      size: 1,
      bpm: 100,
      key: "Am",
      durationSeconds: 180,
      grid: { markers: [{ position: 0, bpm: 100 }], anchor: 0, bpm: 100 },
    },
    {
      id: "to",
      name: "To Track.mp3",
      source: "drive",
      size: 2,
      bpm: 128,
      key: "Em",
      durationSeconds: 180,
      grid: { markers: [{ position: 0, bpm: 128 }], anchor: 0, bpm: 128 },
    },
  ];
  const loopPoints = {
    "drive:from": {
      bpm: 100,
      anchor: 0,
      durationSeconds: 180,
      vocalChecked: true,
      loops: [
        {
          startBar: 8,
          lengthBars: 4,
          startSeconds: 19.2,
          endSeconds: 28.8,
          repeats: 4,
          similarity: 0.9,
          stability: 0.9,
          loudness: 0.9,
          isolation: "beat",
          vocalFree: true,
          beatPresent: true,
          score: 0.9,
        },
      ],
      drops: [],
    },
    "drive:to": {
      bpm: 128,
      anchor: 0,
      durationSeconds: 180,
      vocalChecked: true,
      loops: [],
      drops: [{ atSeconds: 64, barIndex: 32, strength: 1.5, entry16Seconds: 56.5, entry32Seconds: 49 }],
    },
  };
  const file = buildTransitionRecipes(tracks, loopPoints, { nowIso: "2026-01-01T00:00:00.000Z" });
  const recipe = selectTransitionRecipe(file, "from", { availableIds: new Set(["to"]) });
  assertOk("builder: emits a recipe for a loop+drop pair", recipe !== null);
  assertOk("builder: wide BPM gap with loop+drop becomes sample_mix", recipe?.command.action === "routine");
  assertOk("builder: sample_mix includes sweepToBpm for a clamped gap", recipe?.command.action === "routine" && recipe.command.sample?.sweepToBpm === 128);
  assertOk("builder: sample_mix always carries an audible seam sweep", recipe?.command.action === "routine" && recipe.command.queue.maskFx === "space_sweep");
  assertOk("selector: excludes recent tracks", selectTransitionRecipe(file, "from", { availableIds: new Set(["to"]), excludedIds: new Set(["to"]) }) === null);
}

const keys = Object.keys(recipes.recipes ?? {});
const allRecipes = Object.values(recipes.recipes ?? {}).flat();
const sampleRecipes = allRecipes.filter((recipe) => recipe.command.action === "routine");
assertOk("data: has recipe map", keys.length > 0);
assertOk("data: top-K cap is respected", Object.values(recipes.recipes).every((list) => list.length <= 5));
assertOk("data: includes sample_mix routines", allRecipes.some((recipe) => recipe.command.action === "routine"));
assertOk("data: every sample_mix uses the four-bar handoff contract", sampleRecipes.every((recipe) => recipe.command.queue.durationBars === 4));
assertOk("data: every sample_mix has an audible seam sweep", sampleRecipes.every((recipe) => recipe.command.queue.maskFx === "space_sweep"));
assertOk("data: sampler availability was not collapsed to two choices per track", Object.values(recipes.recipes).some((list) => list.filter((recipe) => recipe.command.action === "routine").length >= 3));
assertOk("data: includes queue fallbacks", allRecipes.some((recipe) => recipe.command.action === "queue"));
assertOk("data: no recipe points to itself", allRecipes.every((recipe) => recipe.fromId !== recipe.toId));
assertOk(
  "data: every recipe includes subBassPhaseCoherence in [0.55, 1.0]",
  allRecipes.every(
    (recipe) =>
      typeof recipe.subBassPhaseCoherence === "number" &&
      recipe.subBassPhaseCoherence >= 0.55 &&
      recipe.subBassPhaseCoherence <= 1.0
  )
);
assertOk(
  "data: every recipe includes pitchShiftSemitones within [-1.5, 1.5]",
  allRecipes.every(
    (recipe) =>
      typeof recipe.pitchShiftSemitones === "number" &&
      recipe.pitchShiftSemitones >= -1.5 &&
      recipe.pitchShiftSemitones <= 1.5
  )
);
assertOk(
  "data: every recipe includes valid eqSwapStrategy",
  allRecipes.every((recipe) =>
    ["instant-bass-swap", "gradual-low-shelf", "stem-bass-cut-bar-4"].includes(recipe.eqSwapStrategy)
  )
);
assertOk(
  "math: computePitchShiftSemitones clamps extreme tempo warp to +-1.5 semitones",
  Math.abs(computePitchShiftSemitones("8A", "3B", 1.25)) <= 1.5 &&
    Math.abs(computePitchShiftSemitones("8A", "3B", 0.75)) <= 1.5
);
assertOk(
  "math: computeEqSwapStrategy selects stem-bass-cut-bar-4 for stem_migrate",
  computeEqSwapStrategy({ action: "stem_migrate", bars: 16, anchor: "out" }, 0.91, true) === "stem-bass-cut-bar-4"
);
{
  const obsEntry = Object.entries(recipes.recipes).find(([fromId]) => {
    return manifest.some(track => track.id === fromId && /aventura/i.test(track.name) && /obsesi[oó]n/i.test(track.name));
  });
  assertOk(
    "data: known Aventura/Obsesion source gets partner-dance-safe gap recipes",
    !!obsEntry && obsEntry[1].every((recipe) => recipe.command.action === "queue" && recipe.command.transition === "gap" && recipe.command.startAt === "beginning")
  );

  const locoEntry = Object.entries(recipes.recipes).find(([fromId]) => {
    return manifest.some(track => track.id === fromId && /gente.*zona/i.test(track.name) && /loco loco/i.test(track.name));
  });
  assertOk(
    "data: known Gente de Zona/Gilberto Santa Rosa source gets partner-dance-safe gap recipes",
    !!locoEntry && locoEntry[1].every((recipe) => recipe.command.action === "queue" && recipe.command.transition === "gap" && recipe.command.startAt === "beginning")
  );
}

console.log("\nPASS: all transition recipe cases");
