#!/usr/bin/env node
// Offline transition-recipe builder. This is the cheap "crate prep" layer:
// turn the committed manifest + loop/drop analysis into a small per-track
// shortlist so autopilot can mix proactively without asking the model for
// every routine handoff.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTransitionRecipes, compatibleLoopPoints } from "../src/lib/transition-recipes.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST_PATH = path.join(REPO_ROOT, "src", "data", "crate-manifest.json");
const LOOP_POINTS_PATH = path.join(REPO_ROOT, "src", "data", "loop-points.json");
const OUT_PATH = path.join(REPO_ROOT, "src", "data", "transition-recipes.json");

function readJson(pathname, fallback) {
  try {
    return JSON.parse(readFileSync(pathname, "utf8"));
  } catch {
    return fallback;
  }
}

const manifest = readJson(MANIFEST_PATH, []);
const loopPoints = readJson(LOOP_POINTS_PATH, {});
const tracks = manifest
  .filter((entry) => entry && typeof entry.id === "string" && /\.mp3$/i.test(entry.name ?? ""))
  .map((entry) => ({
    id: entry.id,
    name: entry.name,
    source: "drive",
    size: entry.size ?? null,
    bpm: entry.bpm ?? null,
    key: entry.key ?? null,
    durationSeconds: entry.durationSeconds ?? null,
    grid: entry.grid ?? null,
  }));

const compatible = compatibleLoopPoints(tracks, loopPoints);
const recipes = buildTransitionRecipes(tracks, compatible, { maxPerTrack: 5 });
const ids = new Set(tracks.map(t => t.id));
if (!ids.size || Object.values(recipes.recipes).flat().some(r => !ids.has(r.fromId) || !ids.has(r.toId))) throw new Error("Recipe catalog does not match current crate");
console.log(`Timeline-compatible loop/drop analyses: ${Object.keys(compatible).length}/${tracks.length}`);
writeFileSync(OUT_PATH, `${JSON.stringify(recipes, null, 2)}\n`, "utf8");

const recipeCount = Object.values(recipes.recipes).reduce((sum, list) => sum + list.length, 0);
const routineCount = Object.values(recipes.recipes)
  .flat()
  .filter((recipe) => recipe.command.action === "routine").length;
console.log(
  `Wrote ${path.relative(REPO_ROOT, OUT_PATH)}: ${recipeCount} recipes for ${Object.keys(recipes.recipes).length}/${tracks.length} tracks (${routineCount} sample_mix routines)`
);
