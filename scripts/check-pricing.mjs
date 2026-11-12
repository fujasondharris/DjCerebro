#!/usr/bin/env node
// Node-side smoke test for src/lib/pricing.ts (M5 cost ticker): imports the
// exact same module the /api/dj route uses and asserts computeCostUsd()'s
// math, including cache read/write multipliers, the sonnet intro-vs-standard
// pricing switchover, opus pricing, and a zero-usage case. Plain asserts, no
// test framework, mirrors check-beatmatch.mjs.
import { computeCostUsd, pricingForModel, CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER } from "../src/lib/pricing.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

function approxEqual(a, b, epsilon = 1e-9) {
  return Math.abs(a - b) < epsilon;
}

const INTRO_NOW = Date.parse("2026-07-26T00:00:00Z"); // inside the sonnet-5 intro window
const POST_EXPIRY_NOW = Date.parse("2026-09-01T00:00:00Z"); // after 2026-08-31 expiry

// --- pricingForModel ---

assertOk(
  "pricingForModel: sonnet-5 during intro window uses $2/$10",
  (() => {
    const p = pricingForModel("claude-sonnet-5", INTRO_NOW);
    return approxEqual(p.inputPerMTok, 2) && approxEqual(p.outputPerMTok, 10);
  })()
);

assertOk(
  "pricingForModel: sonnet-5 after intro expiry uses $3/$15",
  (() => {
    const p = pricingForModel("claude-sonnet-5", POST_EXPIRY_NOW);
    return approxEqual(p.inputPerMTok, 3) && approxEqual(p.outputPerMTok, 15);
  })()
);

assertOk(
  "pricingForModel: opus-5 uses $5/$25 regardless of date",
  (() => {
    const p1 = pricingForModel("claude-opus-5", INTRO_NOW);
    const p2 = pricingForModel("claude-opus-5", POST_EXPIRY_NOW);
    return (
      approxEqual(p1.inputPerMTok, 5) &&
      approxEqual(p1.outputPerMTok, 25) &&
      approxEqual(p2.inputPerMTok, 5) &&
      approxEqual(p2.outputPerMTok, 25)
    );
  })()
);

assertOk(
  "pricingForModel: opus-5-5 uses $4/$20 regardless of date",
  (() => {
    const p1 = pricingForModel("claude-opus-5-5", INTRO_NOW);
    const p2 = pricingForModel("claude-opus-5-5", POST_EXPIRY_NOW);
    return (
      approxEqual(p1.inputPerMTok, 4) &&
      approxEqual(p1.outputPerMTok, 20) &&
      approxEqual(p2.inputPerMTok, 4) &&
      approxEqual(p2.outputPerMTok, 20)
    );
  })()
);

assertOk(
  "pricingForModel: fable-5-2 uses $8/$40 regardless of date",
  (() => {
    const p1 = pricingForModel("claude-fable-5-2", INTRO_NOW);
    const p2 = pricingForModel("claude-fable-5-2", POST_EXPIRY_NOW);
    return (
      approxEqual(p1.inputPerMTok, 8) &&
      approxEqual(p1.outputPerMTok, 40) &&
      approxEqual(p2.inputPerMTok, 8) &&
      approxEqual(p2.outputPerMTok, 40)
    );
  })()
);

assertOk(
  "pricingForModel: sonnet-5-5 uses $2/$10 regardless of date",
  (() => {
    const p1 = pricingForModel("claude-sonnet-5-5", INTRO_NOW);
    const p2 = pricingForModel("claude-sonnet-5-5", POST_EXPIRY_NOW);
    return (
      approxEqual(p1.inputPerMTok, 2) &&
      approxEqual(p1.outputPerMTok, 10) &&
      approxEqual(p2.inputPerMTok, 2) &&
      approxEqual(p2.outputPerMTok, 10)
    );
  })()
);

assertOk(
  "pricingForModel: unknown model falls back to sonnet-5 standard rather than throwing",
  (() => {
    const p = pricingForModel("claude-future-model-9", POST_EXPIRY_NOW);
    return approxEqual(p.inputPerMTok, 3) && approxEqual(p.outputPerMTok, 15);
  })()
);

// --- computeCostUsd ---

assertOk(
  "computeCostUsd: zero-usage case costs exactly $0",
  computeCostUsd("claude-sonnet-5", {}, INTRO_NOW) === 0
);

assertOk(
  "computeCostUsd: zero-usage with all fields explicitly zero costs $0",
  computeCostUsd(
    "claude-opus-5",
    { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    INTRO_NOW
  ) === 0
);

assertOk(
  "computeCostUsd: plain input+output at opus-5 rates",
  (() => {
    // 1,000,000 input tokens @ $5 + 500,000 output tokens @ $25 = $5 + $12.50 = $17.50
    const cost = computeCostUsd("claude-opus-5", { input_tokens: 1_000_000, output_tokens: 500_000 }, INTRO_NOW);
    return approxEqual(cost, 17.5);
  })()
);

assertOk(
  "computeCostUsd: cache read billed at 0.1x input rate (sonnet-5 intro)",
  (() => {
    // 1,000,000 cache-read tokens @ $2 input rate * 0.1 = $0.20
    const cost = computeCostUsd("claude-sonnet-5", { cache_read_input_tokens: 1_000_000 }, INTRO_NOW);
    return approxEqual(cost, 2 * CACHE_READ_MULTIPLIER);
  })()
);

assertOk(
  "computeCostUsd: cache write billed at CACHE_WRITE_MULTIPLIER (1h TTL, 2x) x input rate (sonnet-5 intro)",
  (() => {
    // 1,000,000 cache-write tokens @ $2 input rate * 2 (1h TTL) = $4.00
    const cost = computeCostUsd("claude-sonnet-5", { cache_creation_input_tokens: 1_000_000 }, INTRO_NOW);
    return approxEqual(cost, 2 * CACHE_WRITE_MULTIPLIER) && approxEqual(cost, 4);
  })()
);

assertOk(
  "computeCostUsd: cached+uncached mix (cache read + cache write + plain input, opus-5)",
  (() => {
    // 1h-TTL cache scenario: a warm call reading most of the cached system
    // prompt plus a small uncached suffix, no fresh cache write this call.
    const usage = { input_tokens: 5_000, cache_read_input_tokens: 50_000 };
    const expected = (5_000 / 1_000_000) * 5 + (50_000 / 1_000_000) * 5 * CACHE_READ_MULTIPLIER;
    const cost = computeCostUsd("claude-opus-5", usage, INTRO_NOW);
    return approxEqual(cost, expected);
  })()
);

assertOk(
  "computeCostUsd: cold call (cache write only, no prior cache to read) at 1h-TTL rate",
  (() => {
    const usage = { input_tokens: 500, cache_creation_input_tokens: 8_000 };
    const expected = (500 / 1_000_000) * 5 + (8_000 / 1_000_000) * 5 * CACHE_WRITE_MULTIPLIER;
    const cost = computeCostUsd("claude-opus-5", usage, INTRO_NOW);
    return approxEqual(cost, expected);
  })()
);

assertOk(
  "computeCostUsd: mixed usage sums all four components correctly (opus-5)",
  (() => {
    const usage = {
      input_tokens: 200_000,
      output_tokens: 10_000,
      cache_creation_input_tokens: 50_000,
      cache_read_input_tokens: 300_000,
    };
    const expected =
      (200_000 / 1_000_000) * 5 +
      (10_000 / 1_000_000) * 25 +
      (50_000 / 1_000_000) * 5 * CACHE_WRITE_MULTIPLIER +
      (300_000 / 1_000_000) * 5 * CACHE_READ_MULTIPLIER;
    const cost = computeCostUsd("claude-opus-5", usage, INTRO_NOW);
    return approxEqual(cost, expected);
  })()
);

assertOk(
  "computeCostUsd: null usage fields treated as zero, not NaN",
  computeCostUsd(
    "claude-sonnet-5",
    { input_tokens: null, output_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null },
    INTRO_NOW
  ) === 0
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all pricing cases");
