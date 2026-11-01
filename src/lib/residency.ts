// M7 blocker — "you are going way longer than 30 seconds" (owner vibe note,
// 2026-07-29). Pure parsing + timing math for an EXPLICIT owner residency
// instruction ("30 seconds of a song then mix in the next one"), with no
// React and no timers, so scripts/check-residency.mjs can verify it.
//
// Why this module exists rather than more prompt wording: residency was
// previously prompt guidance ONLY (brain.ts's SYSTEM_PROMPT hard-codes a
// 90-180s window for filler and an "anthem rides its full arc" exception),
// and page.tsx's autopilot poll only ever consults the brain when the live
// track is within AUTOPILOT_REMAINING_THRESHOLD_SECONDS of ending or of its
// analyzed mix-out point. So an owner instruction of "30 seconds per track"
// had no path to act at all: the standing prompt rule actively contradicted
// it, and even a compliant brain response had no trigger to fire against
// mid-track. Honoring it end to end needs three things — a parsed number
// (here), a prompt rule that an explicit request OVERRIDES the standing
// window (brain.ts), and a poll-loop trigger (page.tsx).

/** Floor for a parsed request — below this a transition can't complete cleanly, so the value is clamped up rather than honored literally. */
export const MIN_RESIDENCY_REQUEST_SECONDS = 15;
/** Ceiling — past this the standing residency guidance is the better rule anyway. */
export const MAX_RESIDENCY_REQUEST_SECONDS = 900;
/**
 * How far BEFORE the requested residency to consult the brain. A consult
 * plus the brain's own response plus download/decode/phrase-wait is the
 * dominant delay (page.tsx's own comment measures the queue path at ~16s
 * past the response), so consulting exactly AT the target guarantees
 * overshooting it — which is the very complaint this fixes.
 */
export const DEFAULT_RESIDENCY_CONSULT_LEAD_SECONDS = 15;
/** Never consult before this many seconds into a track, even for a very short request — a transition fired instantly on entry isn't a residency, it's a stutter. */
const MIN_CONSULT_AT_SECONDS = 8;

export interface ResidencyRequest {
  /** OUTPUT-time seconds the owner wants each track to hold, clamped to [MIN, MAX]. */
  seconds: number;
  /** True when the owner's literal number was outside [MIN, MAX] and was clamped — surfaced so the brain can say so rather than silently substituting. */
  clamped: boolean;
}

/** `null` = the text says nothing about residency (leave any standing request alone). */
export type ResidencyParse = ResidencyRequest | { clear: true } | null;

const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const AMOUNT = "(\\d+(?:\\.\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten)";
const UNIT = "(seconds?|secs?|s|minutes?|mins?)";
const SUBJECT = "(?:of\\s+)?(?:a|an|the|each|every)?\\s*(?:song|track|tune|one)";

/**
 * Ordered so the most specific phrasing wins. Every pattern must contain BOTH
 * a number+unit AND residency intent — a bare "the first 30 seconds are
 * boring" must NOT be read as an instruction to play 30-second tracks.
 */
const REQUEST_PATTERNS: RegExp[] = [
  // "30 seconds of a song", "45 seconds per track", "2 minutes each"
  new RegExp(`${AMOUNT}\\s*${UNIT}\\s*(?:of|per|each|every|a|an)?\\s*(?:${SUBJECT}|each|apiece)`, "i"),
  // "each song 30 seconds", "per track 45 secs"
  new RegExp(`(?:each|every|per)\\s+(?:song|track|tune)\\s*(?:for|is|at|to|after|about|around|=|:)?\\s*${AMOUNT}\\s*${UNIT}`, "i"),
  // "longer than 30 seconds", "more than a minute"
  new RegExp(`(?:longer|more|further)\\s+than\\s*${AMOUNT}\\s*${UNIT}`, "i"),
  // "30 seconds then mix in the next one", "45 secs and then switch"
  new RegExp(`${AMOUNT}\\s*${UNIT}\\s*(?:,)?\\s*(?:then|and then|before)\\s+(?:you\\s+)?(?:mix|switch|move|change|go|cut)`, "i"),
  // "play each song for 60 seconds", "ride it for 45 seconds", "keep it under 30 seconds".
  // The track-subject word between the verb and the number is required — without
  // it, "give me a break for 30 seconds" parsed as a residency instruction.
  new RegExp(`(?:play|ride|hold|stay\\s+on|keep|give)\\b[^.]{0,25}?(?:song|track|tune|one|it|each|them)\\b[^.]{0,10}?${AMOUNT}\\s*${UNIT}`, "i"),
];

/**
 * Tested BEFORE the request patterns: text that mentions a duration but is
 * describing or evaluating rather than instructing. Found by adversarially
 * probing the parser rather than by imagining cases — all four of these
 * really did parse as residency instructions on the first implementation,
 * and "skip the first 45 seconds of each track" is especially bad because it
 * is a MIX-IN instruction, so obeying it as residency would do close to the
 * opposite of what was asked.
 */
const NEGATIVE_CONTEXT_PATTERNS: RegExp[] = [
  // "the first 30 seconds of a song...", "the last 20 seconds of a track..."
  new RegExp(`\\b(?:first|last|initial|opening|closing|final|early)\\s+(?:the\\s+)?${AMOUNT}\\s*${UNIT}`, "i"),
  // "skip the first 45 seconds", "trim 20 seconds" — note "cut" is deliberately
  // NOT here: "cut each track at 30 seconds" is a real residency instruction.
  new RegExp(`\\b(?:skip|trim|ignore|avoid|omit)\\b[^.]{0,20}?${AMOUNT}\\s*${UNIT}`, "i"),
  // "I like the 30 seconds of a song where the hook is" — an observation.
  /\b(?:i like|i love|i enjoy|my favou?rite)\b/i,
];

/** Phrases that cancel a standing request and return to the normal residency rules. */
const CLEAR_PATTERNS: RegExp[] = [
  /\b(normal|regular|usual|default|full|whole|natural)\s+(length|residency|song|songs|track|tracks|arc)\b/i,
  /\bplay\s+(?:the\s+)?(?:whole|full|entire)\s+(?:song|track)s?\b/i,
  /\b(?:stop|forget|drop|cancel|no more)\b[^.]{0,30}\b(?:short|quick)\b[^.]{0,20}\b(?:song|track|mix|residency)s?\b/i,
  /\bback to normal\b/i,
];

function toSeconds(rawAmount: string, rawUnit: string): number | null {
  const lowerAmount = rawAmount.toLowerCase();
  const amount = lowerAmount in WORD_NUMBERS ? WORD_NUMBERS[lowerAmount] : Number.parseFloat(lowerAmount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = rawUnit.toLowerCase();
  const isMinutes = unit.startsWith("m");
  return isMinutes ? amount * 60 : amount;
}

/**
 * Reads an explicit residency instruction out of an owner vibe note / chat
 * message. Returns null when the text says nothing about residency — the
 * caller must then leave any standing request untouched, since silence is
 * not a cancellation ("more salsa" doesn't mean "go back to full-length
 * tracks").
 */
export function parseResidencyRequest(text: string | null | undefined): ResidencyParse {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  for (const pattern of CLEAR_PATTERNS) {
    if (pattern.test(normalized)) return { clear: true };
  }

  for (const pattern of NEGATIVE_CONTEXT_PATTERNS) {
    if (pattern.test(normalized)) return null;
  }

  for (const pattern of REQUEST_PATTERNS) {
    const match = normalized.match(pattern);
    if (!match) continue;
    // Every pattern captures exactly one amount and one unit, in that order.
    const [, amount, unit] = match;
    if (amount === undefined || unit === undefined) continue;
    const rawSeconds = toSeconds(amount, unit);
    if (rawSeconds === null) continue;
    const seconds = Math.min(MAX_RESIDENCY_REQUEST_SECONDS, Math.max(MIN_RESIDENCY_REQUEST_SECONDS, rawSeconds));
    return { seconds, clamped: seconds !== rawSeconds };
  }

  return null;
}

/**
 * Applies a freshly-parsed note to the standing request. Kept separate from
 * parsing so the "silence leaves it alone, only an explicit clear cancels
 * it" rule lives in one checkable place.
 */
export function applyResidencyParse(standing: ResidencyRequest | null, parsed: ResidencyParse): ResidencyRequest | null {
  if (parsed === null) return standing;
  if ("clear" in parsed) return null;
  return parsed;
}

/**
 * The playedSeconds at which the autopilot should consult, so the NEXT
 * track is actually landing around `targetSeconds` rather than starting
 * then. Never earlier than MIN_CONSULT_AT_SECONDS into the track.
 */
export function residencyConsultAtSeconds(
  targetSeconds: number,
  leadSeconds: number = DEFAULT_RESIDENCY_CONSULT_LEAD_SECONDS
): number {
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) return Number.POSITIVE_INFINITY;
  const safeLead = Number.isFinite(leadSeconds) && leadSeconds > 0 ? leadSeconds : 0;
  return Math.max(MIN_CONSULT_AT_SECONDS, targetSeconds - safeLead);
}

/** True once the live track has played long enough that the residency consult is due. */
export function isResidencyConsultDue(
  playedSeconds: number,
  targetSeconds: number | null,
  leadSeconds: number = DEFAULT_RESIDENCY_CONSULT_LEAD_SECONDS
): boolean {
  if (targetSeconds === null || !Number.isFinite(playedSeconds)) return false;
  return playedSeconds >= residencyConsultAtSeconds(targetSeconds, leadSeconds);
}
