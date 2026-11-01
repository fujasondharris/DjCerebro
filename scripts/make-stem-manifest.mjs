#!/usr/bin/env node
// M8 batch 2 — build src/data/stem-manifest.json for EVERY track in crate-manifest.json
// from the live Drive stems/ tree (one read-only `rclone lsf -R`, ids + paths). Stem
// values are Drive file ids, which is what page.tsx's stemEntryFor requires.
//
// Join: crate-manifest name "<base>.mp3" -> Drive folder stems/<base>/ -> each file
// <stem>.mp3 -> id. Only stems on Drive are registered, minus any guitar/piano the earlier
// manifest recorded as blank-dropped (Drive can still hold the file); `dropped` is whatever is absent. Provenance fields
// (generatedAt, loudness, compingLayer) are carried from the previous stem-manifest /
// stem-manifest-batch2 by name when present; tracks with neither get dropped/compingLayer
// measured locally (guitar/piano blank rule) and dropped when blank. Cross-checks against the local stems
// tree (STEMS_DIR/htdemucs_6s/<base>) and reports any disagreement.
//
// Usage: node --experimental-strip-types --no-warnings scripts/make-stem-manifest.mjs
// Env:   DRIVE_STEMS_REMOTE (default "gdrive:DJ Supermercado Crate v2 (trimmed + stems)/stems"), STEMS_DIR
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const DATA = path.join(fileURLToPath(new URL("..", import.meta.url)), "src", "data");
const REMOTE = process.env.DRIVE_STEMS_REMOTE || "gdrive:DJ Supermercado Crate v2 (trimmed + stems)/stems";
const STEMS_DIR = process.env.STEMS_DIR || path.join(os.homedir(), "dj-tools", "stems-trimmed");
const MODEL = "htdemucs_6s";
const ALL = ["bass", "drums", "guitar", "other", "piano", "vocals"];
const BLANK_MEAN_DB = -45, BLANK_SILENT_PCT = 0.8; // same rule as register-local-tracks.mjs / make-stems.mjs
function measure(file) {
  try {
    const dur = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], { encoding: "utf8" }).trim());
    const err = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", `volumedetect,silencedetect=noise=${BLANK_MEAN_DB}dB:d=0.5`, "-f", "null", "-"], { encoding: "utf8" }).stderr || "";
    const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(err);
    let silent = 0;
    for (const m of err.matchAll(/silence_duration:\s*([\d.]+)/g)) silent += Number(m[1]);
    return { meanDb: mean ? Number(mean[1]) : null, silentPct: Number((silent / dur).toFixed(3)) };
  } catch { return null; }
}
const isBlank = (m) => !!m && m.meanDb !== null && (m.meanDb < BLANK_MEAN_DB || m.silentPct > BLANK_SILENT_PCT);
const load = (f) => (existsSync(path.join(DATA, f)) ? JSON.parse(readFileSync(path.join(DATA, f), "utf8")) : {});

const crate = load("crate-manifest.json");
const byName = new Map();
for (const e of [...Object.values(load("stem-manifest-batch2.json")), ...Object.values(load("stem-manifest.json"))]) byName.set(e.name, e);

const lst = execFileSync("rclone", ["lsf", "-R", "--files-only", "--format", "ip", REMOTE], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const idByDirStem = new Map(); // dir -> {stem -> id}
for (const line of lst.split("\n").filter(Boolean)) {
  const semi = line.indexOf(";");
  const id = line.slice(0, semi), rel = line.slice(semi + 1);
  const slash = rel.lastIndexOf("/");
  const dir = rel.slice(0, slash), file = rel.slice(slash + 1);
  if (!file.endsWith(".mp3")) continue;
  if (!idByDirStem.has(dir)) idByDirStem.set(dir, {});
  idByDirStem.get(dir)[file.slice(0, -4)] = id;
}

const out = {};
let blankKept = 0, measuredDropped = 0, noDir = 0, coreMissing = 0, carried = 0, derived = 0, localMismatch = 0;
for (const t of crate) {
  const base = t.name.replace(/\.mp3$/i, "");
  const ids = idByDirStem.get(base);
  if (!ids) { noDir++; console.warn(`  NO STEMS DIR on Drive: ${t.name.slice(0, 60)}`); continue; }
  const prev = byName.get(t.name);
  const localDir = path.join(STEMS_DIR, MODEL, base);
  const stems = {};
  const loudness = { ...(prev?.loudness ?? {}) };
  for (const s of ALL) {
    if (!ids[s]) continue;
    // Why: a blank guitar/piano stem was dropped on purpose (silent comping layer); Drive may still
    // hold the file, so honor the recorded drop. No record -> measure the local copy.
    if (s === "guitar" || s === "piano") {
      if (prev?.dropped?.includes(s)) { blankKept++; continue; }
      if (!prev && existsSync(path.join(localDir, `${s}.mp3`))) {
        loudness[s] = measure(path.join(localDir, `${s}.mp3`));
        if (isBlank(loudness[s])) { measuredDropped++; continue; }
      }
    }
    stems[s] = ids[s];
  }
  if (!["bass", "drums", "other", "vocals"].every((s) => s in stems)) { coreMissing++; console.warn(`  core stem missing: ${t.name.slice(0, 60)}`); }
  const dropped = ALL.filter((s) => !(s in stems));
  if (existsSync(localDir)) {
    const local = readdirSync(localDir).filter((f) => f.endsWith(".mp3")).map((f) => f.slice(0, -4)).sort().join(",");
    if (local !== Object.keys(ids).sort().join(",")) { localMismatch++; console.warn(`  local/Drive stem sets differ: ${t.name.slice(0, 60)}`); }
  }
  if (prev) carried++; else derived++;
  out[t.id] = {
    name: t.name, model: MODEL, generatedAt: prev?.generatedAt ?? new Date().toISOString(), stems, dropped,
    ...(Object.keys(loudness).length ? { loudness } : {}),
    compingLayer: ["guitar", "piano"].filter((s) => s in stems),
  };
}
writeFileSync(path.join(DATA, "stem-manifest.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`entries=${Object.keys(out).length}/${crate.length} noDir=${noDir} coreMissing=${coreMissing} carriedProvenance=${carried} derived=${derived} localMismatch=${localMismatch} blankDropHonored=${blankKept} measuredAndDropped=${measuredDropped}`);
console.log(`withGuitar=${Object.values(out).filter((e) => e.stems.guitar).length} withPiano=${Object.values(out).filter((e) => e.stems.piano).length}`);
