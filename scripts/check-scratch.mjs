#!/usr/bin/env node
// Node-side smoke test for the scratch engine's pure planning logic: imports
// the exact same src/lib/scratch.ts used by the UI and asserts
// planScratchSegments() for each pattern — plausible segment count, total
// planned duration close to the target, bounds-safe even near the start/end
// of a very short buffer, and reverse segments only ever planned when the
// buffer actually has duration. Plain asserts, no test framework, mirrors
// check-transition.mjs/check-command.mjs. This is the "one runnable check"
// for scratch.ts's non-trivial pure logic (the AudioContext-dependent
// scratch() scheduler itself is not testable here — no browser AudioContext
// available in this harness, see scratch.ts's file-header rationale).
import { planScratchSegments } from "../src/lib/scratch.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

const TARGETS = { baby: 0.7, chirp: 0.6, spinback: 1.2 };
const EXPECTED_COUNTS = { baby: 4, chirp: 3, spinback: 2 };

// --- segment counts + total duration close to target (normal-length buffer) ---
for (const pattern of ["baby", "chirp", "spinback"]) {
  const segments = planScratchSegments(pattern, 30, 200); // 200s buffer, well clear of any edge
  assertOk(`${pattern}: segment count matches its description`, segments.length === EXPECTED_COUNTS[pattern]);

  const total = segments.reduce((sum, s) => sum + s.durationSeconds, 0);
  const target = TARGETS[pattern];
  // 40% headroom: chirp's pure segment durations deliberately sum to ~75%
  // of its target (the rest is real-time gap scheduling, not part of this
  // pure array — see scratch.ts's CHIRP_SEGMENT_SECONDS comment).
  assertOk(
    `${pattern}: total planned duration close to target (${target}s)`,
    Math.abs(total - target) <= target * 0.4
  );

  assertOk(`${pattern}: every segment has positive duration`, segments.every((s) => s.durationSeconds > 0));
  assertOk(
    `${pattern}: every segment stays within [0, bufferDurationSeconds]`,
    segments.every((s) => s.offsetSeconds >= 0 && s.offsetSeconds + s.durationSeconds <= 200 + 1e-9)
  );
}

// --- pattern shape sanity: baby alternates forward/reverse; chirp is all forward; spinback is reverse-then-forward ---
{
  const baby = planScratchSegments("baby", 30, 200);
  assertOk(
    "baby: two forward->reverse pairs (alternating, starting forward)",
    baby.map((s) => s.direction).join(",") === "forward,reverse,forward,reverse"
  );
}
{
  const chirp = planScratchSegments("chirp", 30, 200);
  assertOk("chirp: three forward cuts", chirp.every((s) => s.direction === "forward"));
}
{
  const spinback = planScratchSegments("spinback", 30, 200);
  assertOk(
    "spinback: one long reverse segment then a forward tail",
    spinback.length === 2 && spinback[0].direction === "reverse" && spinback[1].direction === "forward"
  );
  assertOk(
    "spinback: reverse segment decelerates (rateStart > rateEnd)",
    spinback[0].rateStart > spinback[0].rateEnd
  );
  assertOk("spinback: forward tail is normal rate", spinback[1].rateStart === 1 && spinback[1].rateEnd === 1);
}

// --- bounds: very short buffer, position near the START ---
for (const pattern of ["baby", "chirp", "spinback"]) {
  const shortBuffer = 0.05; // shorter than any single segment's nominal duration
  const segments = planScratchSegments(pattern, 0, shortBuffer);
  assertOk(
    `${pattern}: bounds hold near buffer start (short buffer)`,
    segments.every(
      (s) =>
        s.offsetSeconds >= -1e-9 &&
        s.durationSeconds <= shortBuffer + 1e-9 &&
        s.offsetSeconds + s.durationSeconds <= shortBuffer + 1e-9
    )
  );
}

// --- bounds: very short buffer, position near the END ---
for (const pattern of ["baby", "chirp", "spinback"]) {
  const shortBuffer = 0.05;
  const segments = planScratchSegments(pattern, shortBuffer, shortBuffer);
  assertOk(
    `${pattern}: bounds hold near buffer end (short buffer)`,
    segments.every(
      (s) =>
        s.offsetSeconds >= -1e-9 &&
        s.durationSeconds <= shortBuffer + 1e-9 &&
        s.offsetSeconds + s.durationSeconds <= shortBuffer + 1e-9
    )
  );
}

// --- reverse segments only ever planned when bufferDurationSeconds > 0 ---
for (const pattern of ["baby", "chirp", "spinback"]) {
  const segments = planScratchSegments(pattern, 0, 0);
  assertOk(`${pattern}: zero-duration buffer -> no segments at all`, segments.length === 0);
}
{
  // Sanity check the inverse: baby/spinback DO include reverse segments once bufferDurationSeconds > 0.
  const baby = planScratchSegments("baby", 0, 1);
  const spinback = planScratchSegments("spinback", 0, 1);
  assertOk("baby: has reverse segments once buffer has duration", baby.some((s) => s.direction === "reverse"));
  assertOk("spinback: has a reverse segment once buffer has duration", spinback.some((s) => s.direction === "reverse"));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all scratch planning cases");
