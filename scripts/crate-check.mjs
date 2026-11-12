#!/usr/bin/env node
// Crate-readiness report for the music pipeline: DJ Music Downloader
// (tools/dl-music.ps1) drops MP3s in Downloads\dj-crate, then each needs a
// Serato pass (BPM/key tags) before it's useful to the app. This scans that
// folder (override via CRATE_DIR) and reports each file's TBPM/TKEY (the
// exact same src/lib/id3.ts the app uses) and Serato BeatGrid presence
// (src/lib/serato.ts), then classifies READY vs NEEDS SERATO PASS via the
// pure src/lib/crate-check.ts (unit-checked separately, see
// scripts/check-crate-check.mjs). This is a REPORT tool, not a gate: a
// missing/empty crate dir or an unreadable/corrupt file is a notice/warning,
// never a failure — always exits 0.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { parseId3Tags } = await import("../src/lib/id3.ts");
const { parseSeratoBeatgrid } = await import("../src/lib/serato.ts");
const { classifyEntry } = await import("../src/lib/crate-check.ts");

const crateDir =
  process.env.CRATE_DIR || path.join(process.env.USERPROFILE ?? __dirname, "Downloads", "dj-crate");

console.log("");
console.log("  DJ SUPERMERCADO CRATE CHECK");
console.log(`  scanning: ${crateDir}`);
console.log("");

let entries;
try {
  entries = await readdir(crateDir, { withFileTypes: true });
} catch {
  console.log(`NOTICE: ${crateDir} doesn't exist yet — nothing to check.`);
  console.log("Run the DJ Music Downloader (Desktop shortcut) to pull some tracks first.");
  process.exit(0);
}

const mp3Names = entries
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".mp3"))
  .map((entry) => entry.name)
  .sort();

if (mp3Names.length === 0) {
  console.log(`NOTICE: ${crateDir} is empty — nothing to check yet.`);
  process.exit(0);
}

const rows = [];
for (const name of mp3Names) {
  try {
    const buffer = await readFile(path.join(crateDir, name));
    const file = new File([buffer], name);
    const [tags, grid] = await Promise.all([parseId3Tags(file), parseSeratoBeatgrid(file)]);
    const { ready, missing } = classifyEntry(tags);
    rows.push({ name, bpm: tags.bpm, key: tags.key, hasGrid: !!grid, ready, missing });
  } catch (err) {
    console.warn(`WARNING: couldn't read/parse "${name}" — skipping (${err instanceof Error ? err.message : err})`);
  }
}

if (rows.length === 0) {
  console.log("NOTICE: found .mp3 files but none were readable — nothing to report.");
  process.exit(0);
}

const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));
console.log(
  `${"NAME".padEnd(nameWidth)}  ${"BPM".padEnd(6)}  ${"KEY".padEnd(5)}  ${"GRID".padEnd(6)}  STATUS`
);
for (const r of rows) {
  const bpm = r.bpm !== undefined ? String(r.bpm) : "-";
  const key = r.key ?? "-";
  const grid = r.hasGrid ? "yes" : "no";
  const status = r.ready ? "READY" : `NEEDS SERATO PASS (missing ${r.missing.join(", ")})`;
  console.log(`${r.name.padEnd(nameWidth)}  ${bpm.padEnd(6)}  ${key.padEnd(5)}  ${grid.padEnd(6)}  ${status}`);
}

const ready = rows.filter((r) => r.ready);
const needsPass = rows.filter((r) => !r.ready);

console.log("");
console.log(`SUMMARY: ${rows.length} file(s) — ${ready.length} READY, ${needsPass.length} NEEDS SERATO PASS`);
if (ready.length > 0) console.log(`  READY: ${ready.map((r) => r.name).join(", ")}`);
if (needsPass.length > 0) console.log(`  NEEDS SERATO PASS: ${needsPass.map((r) => r.name).join(", ")}`);

console.log("");
console.log(
  "Next: run the NEEDS SERATO PASS files through Serato (BPM/key tags), then upload the READY files to the DJ Supermercado Crate Drive folder."
);

process.exit(0);
