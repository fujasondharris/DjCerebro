// Server-side lesson-ledger sync (M6, 2026-07-29). The ledger
// (src/lib/lesson-ledger.ts) was otherwise device-local localStorage — the
// LessonsPanel's Export button downloaded a JSON file, which is useless on
// the owner's phone (no filesystem UI to hand it back in). This route
// mirrors the ledger to a single JSON blob in the ALREADY-PROVISIONED
// private Vercel Blob store (dj-supermercado-lessons), so every device
// converges on one merged ledger: GET pulls it, POST pushes+merges into it.
// Node runtime (the @vercel/blob SDK / BLOB_READ_WRITE_TOKEN are server-only)
// + force-dynamic (a mutable blob's contents must never ride a cached route
// response). Same per-route passcode gate as src/app/api/dj/route.ts — see
// src/lib/passcode.ts. Deliberately does NOT go anywhere near the distilled
// digest that already rides every brain request (buildRequestBlocks in
// brain.ts / page.tsx's callBrain) — that path is unchanged.
//
// Race note: two devices syncing within the same few seconds is last-write-
// wins on the blob (no locking/transactions) — acceptable for a single-owner
// app. mergeLedgerEvents' dedupe-by-type+when still means two clients each
// appending genuinely NEW events converge correctly as long as they aren't
// racing the exact same write window.
import { NextResponse } from "next/server";
import { get, put } from "@vercel/blob";
import { mergeLedgerEvents, type LessonEvent } from "@/lib/lesson-ledger";
import { parseSyncEventsBody } from "@/lib/lessons-sync";
import { checkPasscode } from "@/lib/passcode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BLOB_PATHNAME = "lesson-ledger.json";

/** Reads the current merged ledger from the blob store, [] when it doesn't exist yet (first run) or its contents don't parse as an array. `useCache: false` so a write from another device seconds ago is never masked by the CDN's read cache — see the private-storage "Consistent reads" doc. */
async function readLedgerBlob(): Promise<LessonEvent[]> {
  const result = await get(BLOB_PATHNAME, { access: "private", useCache: false });
  if (!result) return [];
  const text = await new Response(result.stream).text();
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function requirePasscode(request: Request): NextResponse | null {
  const check = checkPasscode(process.env.DJ_PASSCODE, request.headers.get("x-dj-passcode"));
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 401 });
  return null;
}

export async function GET(request: Request) {
  const denied = requirePasscode(request);
  if (denied) return denied;
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "sync unavailable" }, { status: 503 });
  }

  try {
    const events = await readLedgerBlob();
    return NextResponse.json({ events });
  } catch (err) {
    console.error("[api/lessons] GET failed:", err);
    return NextResponse.json({ error: "Failed to read lesson ledger." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const denied = requirePasscode(request);
  if (denied) return denied;
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: "sync unavailable" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const parsed = parseSyncEventsBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const existing = await readLedgerBlob();
    const merged = mergeLedgerEvents(existing, parsed.events);
    await put(BLOB_PATHNAME, JSON.stringify(merged), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
    return NextResponse.json({ count: merged.length });
  } catch (err) {
    console.error("[api/lessons] POST failed:", err);
    return NextResponse.json({ error: "Failed to sync lesson ledger." }, { status: 500 });
  }
}
