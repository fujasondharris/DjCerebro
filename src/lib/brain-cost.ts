// Text-only, standard-tier estimates. Verified 2026-10-07:
// developers.openai.com/api/docs/models/gpt-6.1-sol + /guides/prompt-caching
// ai.google.dev/gemini-api/docs/pricing
// docs.x.ai/developers/cost-tracking
// dev.meta.ai/docs/pricing-rate-limits
// Account credits/free tiers can lower actual charges. Unknown usage != free.
import type { BrainModelId } from "./brain-models";

export function alternateBrainCost(id: BrainModelId, usage: Record<string, unknown>, now = Date.now()): number | null {
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (id === "grok") return valid(usage.cost_in_usd_ticks) ? usage.cost_in_usd_ticks / 1e10 : null;
  if (id === "gemini") {
    const input = usage.promptTokenCount;
    const output = usage.candidatesTokenCount;
    if (!valid(input) || !valid(output)) return null;
    const cached = valid(usage.cachedContentTokenCount) ? usage.cachedContentTokenCount : 0;
    const thinking = valid(usage.thoughtsTokenCount) ? usage.thoughtsTokenCount : 0;
    const multiplier = now < Date.parse("2027-01-01T00:00:00Z") ? 1 : 2;
    return (Math.max(0, input - cached) * 0.75 + cached * 0.075 + (output + thinking) * 3.75) * multiplier / 1e6;
  }
  if (id !== "openai" && id !== "muse") return null;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  if (!valid(input) || !valid(output)) return null;
  const details = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
  const cached = valid(details.cached_tokens) ? details.cached_tokens : 0;
  if (id === "muse") return (Math.max(0, input - cached) * 1.25 + cached * 0.15 + output * 4.25) / 1e6;
  const writes = valid(details.cache_write_tokens) ? details.cache_write_tokens : 0;
  const long = input > 272000;
  // Cache writes replace the uncached-input rate, they are not an extra fee.
  return ((Math.max(0, input - cached - writes) * 2 + cached * 0.1 + writes * 2.5) * (long ? 2 : 1)
    + output * 10 * (long ? 1.5 : 1)) / 1e6;
}
