import assert from "node:assert/strict";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { BrainResponseSchema, CommandSchema } from "../src/lib/brain.ts";
import { BRAIN_MODELS, isBrainModelId } from "../src/lib/brain-models.ts";
import { getBrainModels, parseProviderText, requestBrain, strictBrainSchema } from "../src/lib/brain-providers.ts";
import { alternateBrainCost } from "../src/lib/brain-cost.ts";

const body = { message: "Test", state: { live: null, idleDeck: "A", history: [], autopilot: false, consultReason: "user_chat" },
  crate: [{ n: 0, t: "Artist - Song" }], crateCacheable: true, lessons: [], ledger: { global: [], perTrack: {} } };
const env = Object.fromEntries(["ANTHROPIC", "GEMINI", "XAI", "OPENAI", "MUSE"].map(p => [`${p}_API_KEY`, `test-${p}`]));
assert.equal(getBrainModels({}).filter(m => m.available).length, 0);
assert.equal(getBrainModels(env).filter(m => m.available).length, 5);
assert.equal(getBrainModels({ ...env, GEMINI_API_KEY: " " })[1].available, false);
assert.equal(getBrainModels({ ...env, ANTHROPIC_MODEL: "claude-sonnet-5" })[0].model, "claude-sonnet-5");
assert.equal(isBrainModelId("https://wrong-host"), false);
assert.equal(isBrainModelId("toString"), false);
assert.ok(!JSON.stringify(getBrainModels(env)).includes("test-"), "catalog must not leak keys");

const original = zodOutputFormat(BrainResponseSchema).schema;
const strict = strictBrainSchema(original);
const verifyStrict = node => {
  if (!node || typeof node !== "object") return;
  assert.ok(!node.oneOf && !node.default);
  if (node.type === "object") { assert.deepEqual(node.required, Object.keys(node.properties)); assert.equal(node.additionalProperties, false); }
  Object.values(node).forEach(verifyStrict);
};
verifyStrict(strict);
assert.equal(strict.properties.command.anyOf.length, 10);
assert.notDeepEqual(original, strict, "transport adapts a copy, not the shared schema");
const commands = [
  { action: "queue", trackId: "0", transition: "gap", durationBars: 8, startAt: "beginning", maskFx: null },
  { action: "tempo_nudge", tempoDelta: 0.02 },
  { action: "fx", fx: "scratch_chirp" },
  { action: "eq", deck: "live", low: -12, mid: null, high: null },
  { action: "eq_sweep", band: "low", toDb: -12, bars: 4 },
  { action: "trance_breakdown", trackId: "1", bars: 16, dropSeconds: 90 },
  { action: "loop", captureBars: 4, isolation: "melody", holdSeconds: 12, halvings: 3, sweepToBpm: null },
  { action: "routine", routine: "sample_mix", sample: { captureBars: 4, isolation: "beat", holdSeconds: 16, halvings: 2, sweepToBpm: 100 }, queue: { trackId: "1", transition: "bass_swap", durationBars: 4, startAt: "auto", maskFx: null } },
  { action: "stem_migrate", trackId: "1", bars: 32, anchor: "out" },
  { action: "none" },
];
for (const command of commands) {
  const parsed = parseProviderText(JSON.stringify({ command, say: "Ready", followUpSeconds: null }));
  assert.ok(parsed.ok, `${command.action}: ${parsed.error}`);
  assert.ok(CommandSchema.safeParse(parsed.command).success);
}
assert.ok(!("mid" in parseProviderText(JSON.stringify({ command: commands[3], say: "" })).command));
for (const command of [{ ...commands[0], trackId: null }, { ...commands[6], captureBars: null }, { ...commands[4], toDb: 100 }]) {
  assert.equal(parseProviderText(JSON.stringify({ command, say: "" })).ok, false);
}

const wire = JSON.stringify({ command: commands[0], say: "Ready", followUpSeconds: null });
const nativeWire = JSON.stringify({ command: { ...commands[0], maskFx: undefined }, say: "Ready" });
const fixture = (id, text = wire) => id === "claude" ? {
  id: "test", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: nativeWire }],
  stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 20 },
} : id === "gemini" ? {
  candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "not JSON" }, { text }] } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 10 },
} : { status: "completed", output: [{ type: "reasoning", summary: [] }, { type: "message", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 100, output_tokens: 20, cost_in_usd_ticks: 10000000 } };
for (const { id, model } of BRAIN_MODELS) {
  let count = 0;
  const fetcher = async (url, init) => {
    count++;
    const payload = JSON.parse(init.body);
    assert.ok(String(url).startsWith({ claude: "https://api.anthropic.com/", gemini: "https://generativelanguage.googleapis.com/", grok: "https://api.x.ai/", openai: "https://api.openai.com/", muse: "https://api.meta.ai/" }[id]));
    if (id !== "gemini") assert.equal(payload.model, model);
    if (id === "gemini") assert.deepEqual(payload.generationConfig.thinkingConfig, { thinkingBudget: 0 }, "live Gemini calls must disable unbounded default thinking so 599-track crate calls do not exceed 50s");
    if (id === "grok") assert.deepEqual(payload.reasoning,{effort:"low"},"live Grok calls must not inherit the high-effort default");
    else assert.equal(payload.reasoning,undefined,"do not change other providers' contracts");
    const instructions = id === "claude" ? payload.system[0].text : id === "gemini" ? payload.systemInstruction.parts[0].text : payload.instructions;
    assert.ok(instructions.toLowerCase().includes("one json command"));
    assert.ok(JSON.stringify(payload).includes("Artist - Song"));
    if (!["claude", "gemini"].includes(id)) { assert.equal(payload.store, false); assert.equal(payload.text.format.strict, true); }
    return Response.json(fixture(id));
  };
  const result = await requestBrain(id, body, env, fetcher);
  assert.equal(count, 1);
  assert.equal(result.model, model);
  assert.equal(result.provider, id);
  assert.equal(result.command.action, "queue");
  assert.ok(result.cost_usd > 0);
}
for (const status of [400, 401, 402, 429, 500]) {
  let calls = 0;
  await assert.rejects(requestBrain("muse", body, env, async () => { calls++; return Response.json({ error: { message: "test-MUSE" } }, { status }); }), e => !e.message.includes("test-MUSE"));
  assert.equal(calls, 1, "no hidden retry or model substitution");
}
await assert.rejects(requestBrain("muse", body, env, async () => { throw new DOMException("test secret", "TimeoutError"); }),
  error => error.status === 504 && error.message.includes("50-second deadline") && !error.message.includes("test secret"));
await assert.rejects(requestBrain("openai", body, {}, async () => { throw new Error("must not fetch"); }), /not configured/);
await assert.rejects(requestBrain("openai", body, env, async () => Response.json(fixture("openai", "{}"))), /validation/);
await assert.rejects(requestBrain("openai", body, env, async () => Response.json({ ...fixture("openai"), status: "incomplete" })), /incomplete/);
const declined = await requestBrain("openai", body, env, async () => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "refusal" }] }] }));
assert.equal(declined.command.action, "none");
assert.equal(declined.cost_usd, null);
assert.equal(alternateBrainCost("grok", { cost_in_usd_ticks: 264760000 }), 0.026476);
assert.equal(alternateBrainCost("openai", { input_tokens: 1000, input_tokens_details: { cache_write_tokens: 500, cached_tokens: 300 }, output_tokens: 100 }), 0.00268);
assert.equal(alternateBrainCost("gemini", { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 100 }, Date.parse("2026-10-07")), 0.0015);
assert.equal(alternateBrainCost("gemini", { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 100 }, Date.parse("2027-01-01")), 0.003);
assert.equal(alternateBrainCost("muse", {}), null);
console.log("PASS: all five transports, ten actions, strict schemas, null semantics, refusal/failure/no-fallback, server-only keys and cost math");
