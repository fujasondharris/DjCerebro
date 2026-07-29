#!/usr/bin/env node
// Node-side smoke test for the beat-lock math: imports the exact same
// src/lib/beatclock.ts used by the UI and asserts beatPhase()/
// phaseAlignOffset() for the cases that matter — already aligned, a
// half-beat mismatch (nearest-beat wrap), different anchors, and tempo != 1
// on both decks. Plain asserts, no test framework, mirrors check-id3.mjs.
import { beatPhase, phaseAlignOffset } from "../src/lib/beatclock.ts";

function approxEqual(a, b, epsilon = 1e-9) {
  return Math.abs(a - b) < epsilon;
}

function assertApprox(name, actual, expected, epsilon = 1e-9) {
  if (!approxEqual(actual, expected, epsilon)) {
    console.error(`FAIL: ${name}: expected ≈${expected}, got ${actual}`);
    process.exit(1);
  }
  console.log(`PASS: ${name}: ${actual} ≈ ${expected}`);
}

// --- beatPhase ---

// Exactly on a beat -> phase 0.
assertApprox("beatPhase: on the beat", beatPhase(10.0, 0, 120), 0);

// Halfway between beats (120bpm -> 0.5s/beat) -> phase 0.5.
assertApprox("beatPhase: halfway", beatPhase(10.25, 0, 120), 0.5);

// Anchor offset from zero still resolves via modulo.
assertApprox("beatPhase: offset anchor", beatPhase(10.0, 0.1, 120), 0.8);

// --- phaseAlignOffset ---

// Already aligned: same bpm/tempo/anchor, same phase -> ~0 correction.
assertApprox(
  "phaseAlignOffset: already aligned",
  phaseAlignOffset(10.0, { anchor: 0, bpm: 120 }, 1, 10.0, { anchor: 0, bpm: 120 }, 1),
  0,
  1e-6
);

// Half-beat off (120bpm, 0.5s/beat): B is 0.25s (half a beat) further into
// its cycle than A. Smallest-magnitude correction is -0.25s (rewind B by a
// quarter... here exactly half a beat, sign picked by the wrap rule) —
// verified by re-deriving: sourceB + correction should land B back in phase
// with A.
{
  const correction = phaseAlignOffset(
    10.0,
    { anchor: 0, bpm: 120 },
    1,
    10.25,
    { anchor: 0, bpm: 120 },
    1
  );
  assertApprox("phaseAlignOffset: half-beat off, magnitude", Math.abs(correction), 0.25, 1e-6);
  const newPhaseB = beatPhase(10.25 + correction, 0, 120);
  assertApprox("phaseAlignOffset: half-beat off, re-aligns", newPhaseB, 0, 1e-6);
}

// Different anchors, same bpm/tempo: A anchored at 0 (sourceA=10.0 -> phase
// 0), B anchored at 0.1 (sourceB=10.0 -> phase 0.8). Expect the SMALLER of
// the two wrap options (+0.1s, not -0.4s) and re-verify it re-aligns.
{
  const correction = phaseAlignOffset(
    10.0,
    { anchor: 0, bpm: 120 },
    1,
    10.0,
    { anchor: 0.1, bpm: 120 },
    1
  );
  assertApprox("phaseAlignOffset: different anchors", correction, 0.1, 1e-6);
  const newPhaseB = beatPhase(10.0 + correction, 0.1, 120);
  const phaseA = beatPhase(10.0, 0, 120);
  assertApprox("phaseAlignOffset: different anchors, re-aligns", newPhaseB, phaseA, 1e-6);
}

// Tempo != 1 on both decks, post-tempo-sync (effective BPM matched:
// 128*1.0 === 120*(128/120)): expect the correction to land B exactly back
// in phase with A.
{
  const gridA = { anchor: 0, bpm: 128 };
  const tempoA = 1.0;
  const gridB = { anchor: 0, bpm: 120 };
  const tempoB = 128 / 120;
  const sourceA = 3.0;
  const sourceB = 2.5;

  const correction = phaseAlignOffset(sourceA, gridA, tempoA, sourceB, gridB, tempoB);
  assertApprox("phaseAlignOffset: tempo != 1 on both decks", correction, 0.2, 1e-6);

  const phaseA = beatPhase(sourceA, gridA.anchor, gridA.bpm);
  const newPhaseB = beatPhase(sourceB + correction, gridB.anchor, gridB.bpm);
  assertApprox("phaseAlignOffset: tempo != 1, re-aligns", newPhaseB, phaseA, 1e-6);
}

// In-and-out mixing (2026-07-28): the phase-align math is purely
// modulo-based off each deck's OWN position (beatPhase() only ever computes
// (sourceTime - anchor) mod beatInterval) — it never assumes deck B starts
// at position 0, so seeking the incoming deck to a nonzero mix-in point
// BEFORE the transition (page.tsx's executeQueueCommand) needs no change
// here. Confirmed by re-running the SAME half-beat-off scenario from M2.5's
// own test above, but with both decks' positions shifted by a large,
// arbitrary offset (65s, well past a typical mix-in point) — the resulting
// correction is identical, proving the math is position-independent.
{
  const OFFSET = 65; // an arbitrary large "already seeked past the intro" position
  const correction = phaseAlignOffset(
    10.0 + OFFSET,
    { anchor: 0, bpm: 120 },
    1,
    10.25 + OFFSET,
    { anchor: 0, bpm: 120 },
    1
  );
  assertApprox("phaseAlignOffset: position-independent — nonzero-start-position offset gives the identical magnitude", Math.abs(correction), 0.25, 1e-6);
  const newPhaseB = beatPhase(10.25 + OFFSET + correction, 0, 120);
  assertApprox("phaseAlignOffset: nonzero-start-position correction re-aligns just like the zero-start case", newPhaseB, 0, 1e-6);
}

console.log("PASS: all beatclock cases");
