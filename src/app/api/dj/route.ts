import { NextResponse } from "next/server";
import { type DjRequestBody } from "@/lib/brain";
import { isBrainModelId } from "@/lib/brain-models";
import { BrainProviderError, getBrainModels, requestBrain } from "@/lib/brain-providers";
import { checkPasscode } from "@/lib/passcode";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function denied(request: Request) {
  const result = checkPasscode(process.env.DJ_PASSCODE, request.headers.get("x-dj-passcode"));
  return result.ok ? null : NextResponse.json({ error: result.error }, { status: 401 });
}

export async function GET(request: Request) {
  return denied(request) ?? NextResponse.json({ models: getBrainModels(process.env) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const rejection = denied(request);
  if (rejection) return rejection;
  let body: DjRequestBody & { brainModel?: unknown };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 }); }
  if (!body || typeof body !== "object" || !body.state || typeof body.state !== "object" ||
      !Array.isArray(body.crate) || typeof body.crateCacheable !== "boolean" ||
      !Array.isArray(body.lessons) || !body.ledger || typeof body.ledger !== "object") {
    return NextResponse.json({ error: "Request body must include state, crate, crateCacheable, lessons, and ledger." }, { status: 400 });
  }
  const id = body.brainModel === undefined ? "claude" : body.brainModel;
  if (!isBrainModelId(id)) return NextResponse.json({ error: "Unknown brain model selection." }, { status: 400 });
  try { return NextResponse.json(await requestBrain(id, body, process.env)); }
  catch (err) {
    const error = err instanceof BrainProviderError ? err : new BrainProviderError("Brain request could not be completed.");
    return NextResponse.json({ error: error.message, provider: id }, { status: error.status });
  }
}
