// SERVER ONLY: imported by /api/dj, never by a client component.
// Provider contracts checked 2026-10-07 against official structured-output docs.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { BRAIN_MODELS, type BrainModelId, type BrainModelOption } from "./brain-models.ts";
import {
  BrainResponseSchema, buildRequestBlocks, buildSystemBlocks, modelSupportsFallbacks,
  parseBrainResponseText, noOpWithReason, type DjRequestBody,
} from "./brain.ts";
import { computeCostUsd } from "./pricing.ts";
import { alternateBrainCost } from "./brain-cost.ts";

type Env = Record<string, string | undefined>;
const KEY_NAMES: Record<BrainModelId, string> = {
  claude: "ANTHROPIC_API_KEY", fable: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY", grok: "XAI_API_KEY",
  openai: "OPENAI_API_KEY", muse: "MUSE_API_KEY",
};
export class BrainProviderError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}
export function getBrainModels(env: Env): BrainModelOption[] {
  return BRAIN_MODELS.map(option => ({
    ...option,
    ...(option.id === "claude" && env.ANTHROPIC_MODEL?.trim()
      ? { model: env.ANTHROPIC_MODEL.trim(), label: `Claude · ${env.ANTHROPIC_MODEL.trim()}` } : {}),
    available: !!env[KEY_NAMES[option.id]]?.trim(),
  }));
}

type Schema = Record<string, unknown>;
// Strict OpenAI/Meta schemas require all properties, using null for optional
// fields. Preserve the full action union and the unchanged executor contract.
export function strictBrainSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictBrainSchema);
  if (!value || typeof value !== "object") return value;
  const source = value as Schema;
  const out: Schema = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === "$schema" || key === "default") continue;
    out[key === "oneOf" ? "anyOf" : key] = strictBrainSchema(child);
  }
  if (source.type === "object" && source.properties) {
    const required = new Set((source.required as string[]) ?? []);
    const properties = out.properties as Schema;
    for (const name of Object.keys(properties)) {
      if (!required.has(name)) properties[name] = { anyOf: [properties[name], { type: "null" }] };
    }
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

export function parseProviderText(text: string) {
  // Only declared optional fields may translate null -> absent. Required nulls
  // remain invalid, including loop settings with executor-side defaults.
  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      if (raw.followUpSeconds === null) delete raw.followUpSeconds;
      const command = raw.command;
      if (command && typeof command === "object" && !Array.isArray(command)) {
        const optional: Record<string, string[]> = {
          queue: ["maskFx"], eq: ["low", "mid", "high"], loop: ["sweepToBpm"],
        };
        for (const name of optional[command.action] ?? []) if (command[name] === null) delete command[name];
        if (command.action === "routine" && command.queue?.maskFx === null) delete command.queue.maskFx;
      }
    }
    return parseBrainResponseText(JSON.stringify(raw));
  } catch { return { ok: false as const, error: "not valid JSON" }; }
}

function failureMessage(label: string, status?: number): string {
  if (status === 401 || status === 403) return `${label}: API access denied. Check the server key and model permissions.`;
  if (status === 402) return `${label}: billing needs attention in the provider account.`;
  if (status === 429) return `${label}: rate limit or quota reached. Check the provider account or try again later.`;
  return `${label}: brain request failed${status ? ` (HTTP ${status})` : " or timed out"}. No other model was substituted.`;
}

// No hidden retries or cross-provider fallback: preserve the user's selection.
export async function requestBrain(id: BrainModelId, body: DjRequestBody, env: Env, fetcher: typeof fetch = fetch) {
  const option = getBrainModels(env).find(item => item.id === id)!;
  const key = env[KEY_NAMES[id]]?.trim();
  if (!key) throw new BrainProviderError(`${option.label} is not configured on this server.`, 503);
  const started = Date.now();
  const blocks = buildRequestBlocks(body);
  const system = buildSystemBlocks();
  const format = zodOutputFormat(BrainResponseSchema);
  let text = "";
  let refusal = false;
  let incomplete = false;
  let usage: Record<string, unknown> = {};
  let cost: number | null = null;
  try {
    if (id === "claude" || id === "fable") {
      const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 50000, fetch: fetcher });
      const response = await client.beta.messages.create({
        model: option.model,
        ...(modelSupportsFallbacks(option.model)
          ? { betas: ["server-side-fallback-2026-07-01" as const], fallbacks: "default" as const } : {}),
        max_tokens: 1024,
        // Sonnet 4.5 rejects effort with HTTP 400; omit only that unsupported option.
        // https://platform.claude.com/docs/en/build-with-claude/effort
        output_config: { ...(/^claude-sonnet-4-5(?:-|$)/.test(option.model) ? {} : { effort: "low" as const }), format },
        system, messages: [{ role: "user", content: blocks }],
      });
      text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
      refusal = response.stop_reason === "refusal";
      incomplete = response.stop_reason === "max_tokens";
      usage = { ...response.usage };
      cost = computeCostUsd(option.model, response.usage);
    } else {
      const schema = strictBrainSchema(format.schema);
      const instructions = system.map(b => b.text).join("\n") +
        "\nFor schema-required nullable optional parameters, use null to mean omitted. Never return null for required action settings.";
      const input = blocks.map(b => b.text).join("\n");
      const urls = {
        gemini: `https://generativelanguage.googleapis.com/v1beta/models/${option.model}:generateContent`,
        openai: "https://api.openai.com/v1/responses",
        grok: "https://api.x.ai/v1/responses",
        muse: "https://api.meta.ai/v1/responses",
      };
      const payload = id === "gemini" ? {
        systemInstruction: { parts: [{ text: instructions }] },
        contents: [{ role: "user", parts: [{ text: input }] }],
        generationConfig: {
          maxOutputTokens: 1024,
          responseMimeType: "application/json",
          responseJsonSchema: schema,
          thinkingConfig: /^gemini-4(?:-|$)/.test(option.model) ? { thinkingLevel: "LOW" } : { thinkingBudget: 0 },
        },
      } : {
        model: option.model, instructions, input, store: false, max_output_tokens: 4096,
        reasoning: { effort: "low" },
        text: { format: { type: "json_schema", name: "dj_command", strict: true, schema } },
      };
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (id === "gemini") headers["x-goog-api-key"] = key;
      else headers.Authorization = `Bearer ${key}`;
      const response = await fetcher(urls[id], {
        method: "POST", headers, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(50000), redirect: "error", cache: "no-store",
      });
      if (!response.ok) throw new BrainProviderError(failureMessage(option.label, response.status));
      const data = await response.json();
      if (id === "gemini") {
        const candidate = data.candidates?.[0];
        text = (candidate?.content?.parts ?? []).filter((p: { thought?: boolean; text?: string }) => !p.thought && typeof p.text === "string")
          .map((p: { text: string }) => p.text).join("");
        refusal = !!data.promptFeedback?.blockReason || candidate?.finishReason === "SAFETY";
        incomplete = candidate?.finishReason !== "STOP" && !refusal;
        usage = data.usageMetadata ?? {};
      } else {
        const content = (data.output ?? []).filter((o: { type: string }) => o.type === "message")
          .flatMap((o: { content?: unknown[] }) => o.content ?? []);
        text = content.filter((p: { type: string }) => p.type === "output_text").map((p: { text: string }) => p.text).join("");
        refusal = content.some((p: { type: string }) => p.type === "refusal");
        incomplete = data.status !== "completed";
        usage = data.usage ?? {};
      }
    }
  } catch (err) {
    if (err instanceof BrainProviderError) throw err;
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new BrainProviderError(`${option.label}: response exceeded the 50-second deadline; no DJ command received.`, 504);
    }
    const status = err instanceof Anthropic.APIError ? err.status : undefined;
    // Raw upstream errors can contain credentials or request content.
    throw new BrainProviderError(failureMessage(option.label, status));
  }
  if (id !== "claude" && id !== "fable") cost = alternateBrainCost(id, usage);
  const meta = { provider: id, model: option.model, usage, cost_usd: cost, latency_ms: Date.now() - started };
  if (refusal) return { ...meta, command: noOpWithReason(`(${option.label} declined that one)`) };
  if (incomplete) throw new BrainProviderError(`${option.label}: incomplete response; no DJ command executed.`);
  const parsed = (id === "claude" || id === "fable") ? parseBrainResponseText(text) : parseProviderText(text);
  if (!parsed.ok) throw new BrainProviderError(`${option.label}: reply failed DJ command validation; no command executed.`);
  return { ...meta, command: parsed.command };
}
