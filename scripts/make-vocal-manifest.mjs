#!/usr/bin/env node
// Rerunnable manifest generator for the vocal-clip library
// (public/sfx/vocal/*.mp3) — scans the folder, maps each filename to a
// category via src/lib/vocal-manifest.ts's pure prefix rules (same module
// scripts/check-vocal.mjs unit-checks), and writes
// src/data/vocal-manifest.json, committed to git so the app doesn't need to
// rescan at build/runtime (same pattern as src/data/crate-manifest.json).
// Rerun this any time clips are added/removed/renamed in public/sfx/vocal/.
import { readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVocalManifest } from "../src/lib/vocal-manifest.ts";

const VOCAL_DIR = fileURLToPath(new URL("../public/sfx/vocal/", import.meta.url));
const OUT_PATH = fileURLToPath(new URL("../src/data/vocal-manifest.json", import.meta.url));

let filenames = [];
try {
  filenames = readdirSync(VOCAL_DIR)
    .filter((f) => f.toLowerCase().endsWith(".mp3"))
    .sort();
} catch (err) {
  console.log(`vocal-manifest: ${VOCAL_DIR} not readable (${err.message}) — writing an empty manifest.`);
}

const { manifest, warnings } = buildVocalManifest(filenames);
for (const warning of warnings) console.warn(warning);

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${OUT_PATH} — ${manifest.length} clip(s), ${warnings.length} warning(s)`);
