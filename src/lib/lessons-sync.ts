// Pure request-body validation for POST /api/lessons (M6 cloud sync,
// 2026-07-29), factored out the same way src/lib/passcode.ts factors out the
// gate check — checkable without spinning up a server (see
// scripts/check-lessons-sync.mjs). Only validates the two fields every
// LessonEvent variant shares (`type`, `when`); the full discriminated-union
// shape is lesson-ledger.ts's own concern (this route just needs enough
// shape to safely merge/store).
import type { LessonEvent } from "./lesson-ledger";

export interface ParsedSyncEvents {
  ok: true;
  events: LessonEvent[];
}

export interface RejectedSyncEvents {
  ok: false;
  error: string;
}

function looksLikeLessonEvent(value: unknown): value is LessonEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { when?: unknown }).when === "string"
  );
}

/**
 * Validates the POST /api/lessons request body: must be an object with an
 * `events` array, every item carrying at least a string `type` and `when`.
 * Anything else (missing `events`, non-array, or an item missing either
 * field) is rejected so the route can 400 instead of writing garbage into
 * the shared blob.
 */
export function parseSyncEventsBody(body: unknown): ParsedSyncEvents | RejectedSyncEvents {
  if (typeof body !== "object" || body === null || !("events" in body)) {
    return { ok: false, error: "Request body must include an `events` array." };
  }
  const events = (body as { events: unknown }).events;
  if (!Array.isArray(events)) {
    return { ok: false, error: "`events` must be an array." };
  }
  if (!events.every(looksLikeLessonEvent)) {
    return { ok: false, error: "Every event must have a string `type` and a string `when`." };
  }
  return { ok: true, events };
}
