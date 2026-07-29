#!/usr/bin/env node
// Node-side smoke test for the beat-match math: imports the exact same
// src/lib/beatmatch.ts used by the UI and asserts syncTempo() behaves for
// identity, an in-range match, both clamp directions, and (owner soundcheck
// fix, 2026-07-26) half/double-time matching. Plain asserts, no test
// framework, mirrors check-id3.mjs.
import { syncTempo } from "../src/lib/beatmatch.ts";

function approxEqual(a, b, epsilon = 1e-9) {
  return Math.abs(a - b) < epsilon;
}

function assertCase(name, result, expected) {
  const tempoOk = approxEqual(result.tempo, expected.tempo);
  const clampedOk = result.clamped === expected.clamped;
  const requiredOk = approxEqual(result.requiredTempo, expected.requiredTempo);
  const multiplierOk = result.multiplier === expected.multiplier;
  if (!tempoOk || !clampedOk || !requiredOk || !multiplierOk) {
    console.error(`FAIL: ${name}`);
    console.error("  got:     ", result);
    console.error("  expected:", expected);
    process.exit(1);
  }
  console.log(`PASS: ${name}`, result);
}

// Identity: same BPM on both decks -> tempo stays 1.0, nothing clamped, plain match (1x).
assertCase(
  "identity (same BPM)",
  syncTempo(120, 1, 120),
  { tempo: 1, clamped: false, requiredTempo: 1, multiplier: 1 }
);

// In-range match: source at 130bpm/tempo 1, target tagged 125bpm -> 1.04x, within +-8%, plain match.
assertCase(
  "exact match, in range",
  syncTempo(130, 1, 125),
  { tempo: 1.04, clamped: false, requiredTempo: 1.04, multiplier: 1 }
);

// Clamp-high: required tempo 1.2x is past +8%, must clamp to 1.08. Chosen
// deliberately (150 vs 125, not 150 vs 100) so the half/double candidates
// (0.6x doubled-target, 2.4x halved-target) are both FARTHER from 1.0 than
// the plain 1.2x — this stays a genuine "plain match clamps" case under the
// new multiplier-aware algorithm, not an accidental double-time win.
assertCase(
  "clamp-high (plain match still wins over half/double)",
  syncTempo(150, 1, 125),
  { tempo: 1.08, clamped: true, requiredTempo: 1.2, multiplier: 1 }
);

// Clamp-low: required tempo 0.8x is past -8%, must clamp to 0.92. Chosen
// deliberately (80 vs 100, not 80 vs 150) so the half/double candidates
// (0.4x doubled-target, 1.6x halved-target) are both FARTHER from 1.0 than
// the plain 0.8x — same "plain match still wins" guarantee as clamp-high.
assertCase(
  "clamp-low (plain match still wins over half/double)",
  syncTempo(80, 1, 100),
  { tempo: 0.92, clamped: true, requiredTempo: 0.8, multiplier: 1 }
);

// --- half/double-time matching (owner soundcheck fix) ---

// Double-time: source tagged 172, target tagged 86 (dembow half-time vs.
// club-tempo double) -> plain match would need 2.0x (clamped hard); doubling
// the target to 172 locks perfectly at 1.0x, unclamped.
assertCase(
  "double-time: 172 vs 86 -> matches at 2x, tempo ~1.0",
  syncTempo(172, 1, 86),
  { tempo: 1, clamped: false, requiredTempo: 1, multiplier: 2 }
);

// Half-time: the mirror image — source tagged 86, target tagged 172 ->
// plain match would need 0.5x (clamped hard); halving the target to 86
// locks perfectly at 1.0x, unclamped.
assertCase(
  "half-time: 86 vs 172 -> matches at 0.5x, tempo ~1.0",
  syncTempo(86, 1, 172),
  { tempo: 1, clamped: false, requiredTempo: 1, multiplier: 0.5 }
);

// A previously-unreachable match now reachable: source 100, target 52 ->
// plain match needs 1.923x (clamps to 1.08, badly wrong); doubling the
// target to 104 needs only 0.9615x — well within +-8%, no clamp at all.
assertCase(
  "double-time rescues an otherwise-hard-clamped pair (100 vs 52 -> 2x, ~0.96)",
  syncTempo(100, 1, 52),
  { tempo: 100 / 104, clamped: false, requiredTempo: 100 / 104, multiplier: 2 }
);

console.log("PASS: all beatmatch cases");
