// Server route for the Claude "brain" — Milestone 3 Part C. Deliberately
// thin: reads the API key, builds the Anthropic request from src/lib/brain.ts's
// pure helpers, and shapes the response. All prompt/schema/parsing logic
// lives in brain.ts so it's testable without a real key (see
// scripts/check-route.mjs). Never expose ANTHROPIC_API_KEY client-side — this
// file only runs server-side (Next.js Route Handler).
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { NextResponse } from "next/server";
import {
  CommandSchema,
  buildRequestBlocks,
  buildSystemBlocks,
  modelSupportsFallbacks,
  parseCommandText,
  noOpWithReason,
  type DjRequestBody,
} from "@/lib/brain";
import { checkPasscode } from "@/lib/passcode";
import { computeCostUsd } from "@/lib/pricing";

export const runtime = "nodejs";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

// The server-side `fallbacks` param (M3's refusal-recovery path) is only
// accepted by models with the elevated safety-classifier system that makes
// refusal fallback meaningful — opus/fable/mythos (modelSupportsFallbacks in
// src/lib/brain.ts, pinned in scripts/check-route.mjs). Sending it to any
// other model (e.g. claude-sonnet-5, which Jason's .env.local now uses per
// the M5 pause note's "consider ANTHROPIC_MODEL=claude-sonnet-5") 400s with
// "does not support the `fallbacks` parameter" — verified live against the
// dev server 2026-07-26. Gate it on model family so ANTHROPIC_MODEL can be
// swapped between families (e.g. to claude-opus-5) without breaking the route.
const MODEL_SUPPORTS_FALLBACKS = modelSupportsFallbacks(MODEL);

export async function POST(request: Request) {
  // M5: optional passcode gate — no-op when DJ_PASSCODE is unset (local dev unchanged).
  const passcodeCheck = checkPasscode(process.env.DJ_PASSCODE, request.headers.get("x-dj-passcode"));
  if (!passcodeCheck.ok) {
    return NextResponse.json({ error: passcodeCheck.error }, { status: 401 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not set on the server. Add it to .env.local and restart the dev server." },
      { status: 500 }
    );
  }

  let body: DjRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("state" in body) ||
    !("crate" in body) ||
    !("crateCacheable" in body) ||
    !("lessons" in body) ||
    !("ledger" in body)
  ) {
    return NextResponse.json(
      { error: "Request body must include state, crate, crateCacheable, lessons, and ledger." },
      { status: 400 }
    );
  }

  const client = new Anthropic({ apiKey });
  // Cost addendum (2026-07-26): two content blocks instead of one string —
  // the crate block gets its own 1h-TTL cache breakpoint (only when the
  // client reports crateCacheable, i.e. the full unwindowed list), the
  // volatile block (state/note/lessons) always rides uncached after it. See
  // src/lib/brain.ts's buildRequestBlocks() for the shape + rationale.
  const contentBlocks = buildRequestBlocks(body);

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      ...(MODEL_SUPPORTS_FALLBACKS
        ? { betas: ["server-side-fallback-2026-07-01" as const], fallbacks: "default" as const }
        : {}),
      max_tokens: 1024,
      output_config: {
        effort: "low",
        format: zodOutputFormat(CommandSchema),
      },
      // Cached (1h TTL, scope addendum 2026-07-26) — SYSTEM_PROMPT is a
      // multi-K-token stable rulebook; everything volatile stays in the
      // user message below, after this cached block. See
      // src/lib/brain.ts's buildSystemBlocks() for the shape + rationale.
      system: buildSystemBlocks(),
      messages: [{ role: "user", content: contentBlocks }],
    });

    // Check refusal BEFORE reading content — a decline is HTTP 200 with
    // empty/partial content, never a thrown error.
    if (response.stop_reason === "refusal") {
      return NextResponse.json({ command: noOpWithReason("(brain declined that one)") });
    }

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      console.error("[api/dj] no text block in response", JSON.stringify(response.content));
      return NextResponse.json({ command: noOpWithReason("(brain returned no text — see server log)") });
    }

    const parsed = parseCommandText(textBlock.text);
    if (!parsed.ok) {
      console.error("[api/dj] failed to parse command:", parsed.error, "raw:", textBlock.text);
      return NextResponse.json({ command: noOpWithReason(`(brain reply didn't parse: ${parsed.error})`) });
    }

    // M5 cost ticker: usage + a server-computed cost_usd, only on this clean
    // success path — refusal/no-text/parse-failure paths above deliberately
    // omit these fields so the client ticker just doesn't advance for them
    // (per dispatch: "offline/no-key/refusal paths ... cost fields absent").
    const cost_usd = computeCostUsd(MODEL, response.usage);
    return NextResponse.json({ command: parsed.command, usage: response.usage, cost_usd, model: MODEL });
  } catch (err) {
    console.error("[api/dj] Anthropic call failed:", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Brain call failed: ${message}` }, { status: 502 });
  }
}
