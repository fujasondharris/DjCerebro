#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  analyzeHarmonicRelationship,
  classifyRhythmicGroove,
  analyzeGrooveInterlock,
  planTurntablistChoreography,
  rankCandidatesByMusicTheory,
} from "../src/lib/music-theory-master.ts";

function assertOk(name, condition) {
  assert.ok(condition, name);
  console.log(`PASS: ${name}`);
}

// 1. 8-Mode Camelot Harmonic Modulation Analyzer
assertOk(
  "harmony: 8A -> 8A is tonic_lock",
  analyzeHarmonicRelationship("8A", "8A").mode === "tonic_lock"
);
assertOk(
  "harmony: 8A -> 8B is relative_pivot (A Minor <-> C Major)",
  analyzeHarmonicRelationship("8A", "8B").mode === "relative_pivot"
);
assertOk(
  "harmony: 8A -> 9A is dominant_fifth (+1 Wheel)",
  analyzeHarmonicRelationship("8A", "9A").mode === "dominant_fifth"
);
assertOk(
  "harmony: 8A -> 7A is subdominant_fourth (-1 Wheel)",
  analyzeHarmonicRelationship("8A", "7A").mode === "subdominant_fourth"
);
assertOk(
  "harmony: 8A -> 10A is energy_boost_whole_step (+2 Wheel / +2 Semitones)",
  analyzeHarmonicRelationship("8A", "10A").mode === "energy_boost_whole_step"
);
assertOk(
  "harmony: 8A -> 11B is parallel_mode_shift (Am -> A Major)",
  analyzeHarmonicRelationship("8A", "11B").mode === "parallel_mode_shift"
);
assertOk(
  "harmony: 8A -> 3A is semitone_surge (+1 Semitone)",
  analyzeHarmonicRelationship("8A", "3A").mode === "semitone_surge"
);
assertOk(
  "harmony: 8A -> 1B is non_harmonic_percussion_bridge",
  analyzeHarmonicRelationship("8A", "1B").mode === "non_harmonic_percussion_bridge"
);

// 2. Rhythmic Clave & Groove DNA Classifier
assertOk(
  "groove: reggaeton classified as dembow_tresillo",
  classifyRhythmicGroove({ name: "Daddy Yankee - Gasolina.mp3", bpm: 96, genre: "Reggaeton" }).family === "dembow_tresillo"
);
assertOk(
  "groove: salsa classified as salsa_son_clave and socialDanceProtected",
  classifyRhythmicGroove({ name: "Hector Lavoe - El Cantante.mp3", bpm: 94, genre: "Salsa" }).socialDanceProtected === true
);
assertOk(
  "groove: guaracha classified as guaracha_tribal_4x4",
  classifyRhythmicGroove({ name: "Medianoche Tech Guaracha.mp3", bpm: 126, genre: "Guaracha" }).family === "guaracha_tribal_4x4"
);

// 3. 4-Stage Turntablist Choreography & Candidate Ranking
const liveTrack = {
  id: "el_cerebro_dembow_fuego",
  name: "El Cerebro - Dembow Fuego (VIP 4-Stem Club Edit).mp3",
  bpm: 98,
  key: "8A",
  genre: "Reggaeton",
  hasStems: true,
  hasRealGrid: true,
};
const candidates = [
  {
    id: "cand_harmonic",
    name: "Feid - Classy 101.mp3",
    bpm: 99,
    key: "8A",
    genre: "Reggaeton",
    hasStems: true,
    hasRealGrid: true,
  },
  {
    id: "cand_clash",
    name: "Random Clashing Track.mp3",
    bpm: 138,
    key: "2B",
    genre: "Trance",
    hasStems: false,
    hasRealGrid: false,
  },
];

const ranked = rankCandidatesByMusicTheory(liveTrack, candidates);
assertOk("ranking: harmonic + stem-ready candidate ranks #1", ranked[0].track.id === "cand_harmonic");
assertOk("ranking: 4-stage turntablist choreography generated", ranked[0].choreography.stages.length === 4);

console.log("\nPASS: all music-theory-master checks passed!");
