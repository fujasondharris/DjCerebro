#!/usr/bin/env node
// M8 batch 2 — register LOCAL-ONLY tracks (in CRATE_DIR, not yet on Drive) into the
// trim pipeline under a stable synthetic id `local:<filename>`, so make-trim-plan /
// apply-trims can plan and cut them before any upload. Writes NO audio, touches NO Drive.
//
// WHY SIBLING FILES. crate-manifest.json / stem-manifest.json are the LIVE app data for
// the 342 tracks already on Drive (the stem manifest is already re-keyed to Drive ids by
// rekey-to-v2). Batch 2 goes to crate-manifest-batch2.json / stem-manifest-batch2.json
// instead, which the app never imports; make-trim-plan and apply-trims merge them in.
// After upload, rekey by filename (the rekey-to-v2 pattern) turns local:<name> into a
// Drive id and folds the entries into the live manifests.
//
// Tags/grid/duration are read from the LOCAL untrimmed file exactly as
// make-crate-manifest.mjs does (parseId3Tags / parseSeratoBeatgrid / ffprobe). Stems are
// the ones ALREADY produced by demucs in STEMS_DIR/htdemucs_6s/<basename> — never re-run
// here. The blank-stem drop rule (guitar/piano) is copied from make-stems.mjs so the
// entry has the same shape as a make-stems one.
//
// A track is registered only if it is absent from Drive. The Drive name list is
// read-only input: DRIVE_NAMES (file, one name per line) — produce it with
// `rclone lsf --files-only "gdrive:<v2 folder>"`. Without it every local mp3 registers.
//
// Usage: node --experimental-strip-types --no-warnings scripts/register-local-tracks.mjs
// Env:   CRATE_DIR, STEMS_DIR, DRIVE_NAMES
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = path.join(REPO_ROOT, "src", "data");
const CRATE_OUT = path.join(DATA, "crate-manifest-batch2.json");
const STEMS_OUT = path.join(DATA, "stem-manifest-batch2.json");
const CRATE_DIR = process.env.CRATE_DIR || path.join(os.homedir(), "Music", "dj-crate");
const STEMS_DIR = process.env.STEMS_DIR || path.join(os.homedir(), "dj-tools", "stems-out");
const MODEL = "htdemucs_6s";
const STEM_NAMES = ["bass", "drums", "guitar", "other", "piano", "vocals"];
const BLANK_MEAN_DB = -45, BLANK_SILENT_PCT = 0.8, DROPPABLE = new Set(["guitar", "piano"]);

const localId = (name) => `local:${name}`;

function probeDuration(file) {
  try {
    const v = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", file], { encoding: "utf8" }).trim());
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

// Same probe as make-stems.mjs measure(); null => unmeasurable => keep the stem.
function measure(file) {
  const dur = probeDuration(file);
  if (dur === null) return null;
  const res = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af",
    `volumedetect,silencedetect=noise=${BLANK_MEAN_DB}dB:d=0.5`, "-f", "null", "-"], { encoding: "utf8" });
  const err = res.stderr || "";
  const mean = /mean_volume:\s*(-?[\d.]+) dB/.exec(err);
  let silent = 0;
  for (const m of err.matchAll(/silence_duration:\s*([\d.]+)/g)) silent += Number(m[1]);
  return { meanDb: mean ? Number(mean[1]) : null, silentPct: Number((silent / dur).toFixed(3)) };
}
const isBlank = (s) => !!s && s.meanDb !== null && (s.meanDb < BLANK_MEAN_DB || s.silentPct > BLANK_SILENT_PCT);

async function main() {
  const onDrive = new Set(process.env.DRIVE_NAMES && existsSync(process.env.DRIVE_NAMES)
    ? readFileSync(process.env.DRIVE_NAMES, "utf8").split(/\r?\n/).filter(Boolean) : []);
  const names = readdirSync(CRATE_DIR).filter((f) => f.toLowerCase().endsWith(".mp3") && !onDrive.has(f)).sort();

  const prevCrate = existsSync(CRATE_OUT) ? JSON.parse(readFileSync(CRATE_OUT, "utf8")) : [];
  const prevStems = existsSync(STEMS_OUT) ? JSON.parse(readFileSync(STEMS_OUT, "utf8")) : {};
  const crateById = new Map(prevCrate.map((t) => [t.id, t]));
  const stems = { ...prevStems };

  const { parseId3Tags } = await import("../src/lib/id3.ts");
  const { parseSeratoBeatgrid } = await import("../src/lib/serato.ts");

  let noStems = 0, reused = 0;
  for (const name of names) {
    const id = localId(name);
    if (crateById.has(id) && stems[id]) { reused++; continue; } // idempotent reruns
    const file = path.join(CRATE_DIR, name);
    const buf = readFileSync(file);
    const f = new File([buf], name);
    const [tags, grid] = await Promise.all([parseId3Tags(f), parseSeratoBeatgrid(f)]);
    crateById.set(id, { id, name, size: buf.length, bpm: tags.bpm ?? null, key: tags.key ?? null,
      durationSeconds: probeDuration(file), grid: grid ?? null });

    const dir = path.join(STEMS_DIR, MODEL, path.basename(name, ".mp3"));
    if (!STEM_NAMES.every((s) => existsSync(path.join(dir, `${s}.mp3`)))) {
      noStems++; console.warn(`  NO COMPLETE STEM SET (registered without stems): ${name.slice(0, 58)}`);
      continue;
    }
    const kept = {}, dropped = [], loudness = {};
    for (const s of STEM_NAMES) {
      const full = path.join(dir, `${s}.mp3`);
      loudness[s] = measure(full);
      if (DROPPABLE.has(s) && isBlank(loudness[s])) { dropped.push(s); continue; }
      kept[s] = path.relative(STEMS_DIR, full);
    }
    stems[id] = { name, model: MODEL, generatedAt: new Date().toISOString(), stems: kept, dropped, loudness,
      compingLayer: ["guitar", "piano"].filter((s) => s in kept) };
  }

  const crate = [...crateById.values()];
  writeFileSync(CRATE_OUT, JSON.stringify(crate, null, 2) + "\n");
  writeFileSync(STEMS_OUT, JSON.stringify(stems, null, 2) + "\n");
  const n = (p) => crate.filter(p).length;
  console.log(`registered=${crate.length} (reused ${reused}) withStems=${Object.keys(stems).length} noStems=${noStems}`);
  console.log(`bpm=${n((t) => t.bpm)} key=${n((t) => t.key)} grid=${n((t) => t.grid)} duration=${n((t) => t.durationSeconds)}`);
  console.log(`wrote ${CRATE_OUT}\nwrote ${STEMS_OUT}`);
}

main().catch((e) => { console.error(`FAILED: ${e instanceof Error ? e.message : e}`); process.exit(1); });
