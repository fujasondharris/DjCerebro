// Pure Anthropic API pricing/cost math for the M5 cost ticker. UI/network-free
// by design (same discipline as beatmatch.ts/beatclock.ts) so it's checkable
// without a real key — see scripts/check-pricing.mjs.
//
// Pricing constants verified 2026-07-26 against platform.claude.com/docs/en/pricing
// (per the claude-api skill's cached model table, same date):
//   - claude-sonnet-5: $3/MTok input, $15/MTok output STANDARD; INTRO pricing
//     of $2/MTok input, $10/MTok output runs through 2026-08-31, after which
//     it reverts to standard. We use the intro numbers while they're active
//     (today's date, 2026-07-26, is inside that window) and fall back to
//     standard automatically once the window closes — see SONNET_5_INTRO_EXPIRY.
//   - claude-opus-5: $5/MTok input, $25/MTok output. No intro period.
//   - Cache read tokens bill at 0.1x the model's input rate.
//   - Cache write tokens bill at 1.25x the model's input rate for the 5-minute
//     TTL (the SDK default), or 2x for the 1-hour TTL. The /api/dj route
//     (scope addendum, 2026-07-26) caches SYSTEM_PROMPT with a 1h TTL — see
//     src/lib/brain.ts's buildSystemBlocks() — so CACHE_WRITE_MULTIPLIER
//     below reflects that 2x rate, verified against the claude-api skill's
//     shared/prompt-caching.md pricing table the same date.
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

const SONNET_5_INTRO_EXPIRY = Date.parse("2026-08-31T23:59:59Z");

export const FABLE_5_2: ModelPricing = { inputPerMTok: 8, outputPerMTok: 40 };
export const OPUS_5_5: ModelPricing = { inputPerMTok: 4, outputPerMTok: 20 };
export const OPUS_5: ModelPricing = { inputPerMTok: 5, outputPerMTok: 25 };
export const SONNET_5_5: ModelPricing = { inputPerMTok: 2, outputPerMTok: 10 };
export const SONNET_5_STANDARD: ModelPricing = { inputPerMTok: 3, outputPerMTok: 15 };
export const SONNET_5_INTRO: ModelPricing = { inputPerMTok: 2, outputPerMTok: 10 };

export const CACHE_READ_MULTIPLIER = 0.1;
// 1h TTL rate (2x) — the only TTL this app's route actually requests.
export const CACHE_WRITE_MULTIPLIER = 2;

/**
 * Resolves the per-MTok input/output rate for a model string. `now` is
 * injectable (defaults to Date.now()) so the intro-vs-standard Sonnet 5
 * switchover is checkable without mocking the system clock.
 */
export function pricingForModel(model: string, now: number = Date.now()): ModelPricing {
  if (model.includes("fable")) return FABLE_5_2;
  if (model.includes("opus-5-5") || model.includes("opus-5.5")) return OPUS_5_5;
  if (model.includes("opus")) return OPUS_5;
  if (model.includes("sonnet-5-5") || model.includes("sonnet-5.5")) return SONNET_5_5;
  if (model.includes("sonnet")) {
    return now < SONNET_5_INTRO_EXPIRY ? SONNET_5_INTRO : SONNET_5_STANDARD;
  }
  // Unknown/renamed model string (e.g. ANTHROPIC_MODEL typo'd or a future
  // model this file hasn't been updated for) — fall back to Sonnet 5
  // standard rates rather than throwing, so a misconfigured env var never
  // crashes the cost ticker. Cost will be approximate in that case.
  return SONNET_5_STANDARD;
}

/** Subset of the Messages API `usage` object this module needs. All fields optional/nullable to tolerate partial or missing usage data. */
export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Computes total USD cost for one API call's usage, including cache read/write multipliers. Pure — no I/O. */
export function computeCostUsd(model: string, usage: UsageLike, now: number = Date.now()): number {
  const pricing = pricingForModel(model, now);
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  const inputCost = (input / 1_000_000) * pricing.inputPerMTok;
  const outputCost = (output / 1_000_000) * pricing.outputPerMTok;
  const cacheWriteCost = (cacheWrite / 1_000_000) * pricing.inputPerMTok * CACHE_WRITE_MULTIPLIER;
  const cacheReadCost = (cacheRead / 1_000_000) * pricing.inputPerMTok * CACHE_READ_MULTIPLIER;

  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}
