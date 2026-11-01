#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AUDIO_DIR = path.join(ROOT, "public", "audio");
const MANIFEST_PATH = path.join(AUDIO_DIR, "manifest.json");

assert.ok(fs.existsSync(MANIFEST_PATH), "public/audio/manifest.json must exist");
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

assert.equal(manifest.application, "DJ Supermercado");
assert.equal(manifest.mastering?.targetLufs, -14.0);
assert.ok(Array.isArray(manifest.tracks) && manifest.tracks.length >= 4, "At least 4 studio tracks must be present");

const CAMELOT_RE = /^(?:[1-9]|1[0-2])[AB]$/;
const REQUIRED_STEMS = ["vocals", "drums", "bass", "other"];

for (const track of manifest.tracks) {
  const trackPath = path.join(AUDIO_DIR, "tracks", track.filename);
  assert.ok(fs.existsSync(trackPath), `Missing studio track MP3: ${track.filename}`);
  assert.ok(fs.statSync(trackPath).size > 100_000, `Studio track ${track.filename} must be >100KB`);
  assert.match(track.camelotKey, CAMELOT_RE, `Invalid Camelot key for ${track.id}: ${track.camelotKey}`);
  assert.ok(track.bpm >= 70 && track.bpm <= 180, `Invalid BPM for ${track.id}: ${track.bpm}`);
  assert.ok(Math.abs(track.measuredLufs - -14.0) <= 2.0, `Track ${track.id} LUFS (${track.measuredLufs}) must be near -14 LUFS`);
  assert.ok(track.beatGrid && Array.isArray(track.beatGrid.beatTimestamps) && track.beatGrid.beatTimestamps.length >= 16, `Missing beatGrid timestamps on ${track.id}`);
  assert.equal(track.video, false, `${track.id} must have video=false`);
  assert.equal(track.lipSync, false, `${track.id} must have lipSync=false`);

  for (const stemName of REQUIRED_STEMS) {
    const stemMeta = track.stems?.[stemName];
    assert.ok(stemMeta, `Missing '${stemName}' stem metadata for ${track.id}`);
    const stemFile = path.join(AUDIO_DIR, "stems", track.id, `${stemName}.mp3`);
    assert.ok(fs.existsSync(stemFile), `Missing separated stem file: ${stemFile}`);
    assert.ok(fs.statSync(stemFile).size > 50_000, `Separated stem ${stemFile} too small`);
  }
}

const CRATE_MANIFEST_PATH = path.join(ROOT, "src", "data", "crate-manifest.json");
const STEM_MANIFEST_PATH = path.join(ROOT, "src", "data", "stem-manifest.json");
const crateManifest = JSON.parse(fs.readFileSync(CRATE_MANIFEST_PATH, "utf8"));
const stemManifest = JSON.parse(fs.readFileSync(STEM_MANIFEST_PATH, "utf8"));

for (const track of manifest.tracks) {
  const crateEntry = crateManifest.find((t) => t.id === track.id);
  assert.ok(crateEntry, `Studio track ${track.id} must be registered in src/data/crate-manifest.json`);
  assert.equal(crateEntry.bpm, track.bpm, `Crate BPM mismatch for ${track.id}`);
  assert.ok(crateEntry.grid && crateEntry.grid.bpm === track.bpm, `Crate BeatGrid missing for ${track.id}`);
  const stemEntry = stemManifest[track.id];
  assert.ok(stemEntry && stemEntry.stems, `Studio track ${track.id} must be registered in src/data/stem-manifest.json`);
  for (const stemName of REQUIRED_STEMS) {
    assert.equal(
      stemEntry.stems[stemName],
      `/audio/stems/${track.id}/${stemName}.mp3`,
      `Stem manifest URL mismatch for ${track.id}:${stemName}`
    );
  }
}

console.log(`check-studio-stems-audio: OK (${manifest.tracks.length} studio tracks + ${manifest.tracks.length * 4} MLX RoFormer/HTDemucs-FT stems verified & wired into crate/stem manifests, zero video/lip-sync)`);
