// Pure grouping + summarization of the human DJ's transition ratings into
// short natural-language "lessons" fed back to the brain (src/lib/brain.ts's
// DjRequestBody.lessons) every request — Milestone 4 Part D's feedback loop,
// read side. See src/lib/history-store.ts for the localStorage-backed write
// side and src/app/page.tsx for the 👍/👎 UI that produces ratings in the
// first place. No AudioContext/localStorage/UI here, matching every other
// src/lib module's constraint — and no Date.now()/randomness either: this
// must be a pure function of its input array so the same ratings always
// produce the exact same lessons array (see scripts/check-lessons.mjs's
// determinism assertion).
import type { TransitionKind } from "./transition";

export interface TransitionRecord {
  when: number; // Date.now() at completion — doubles as a stable-enough key
  fromTrack: string;
  toTrack: string;
  bpmFrom: number | null;
  bpmTo: number | null;
  clamped: boolean;
  degraded: boolean;
  transitionType: TransitionKind | "stem_migrate" | "trance_breakdown";
  durationBars: number;
  rating: "up" | "down" | null;
  note: string | null;
  /**
   * Lesson-ledger tie-in (2026-07-28): where in the OUTGOING track
   * (source-time seconds) this transition fired — captured so a later
   * 👍/👎+note rating has a real number to attach to the lesson-ledger's
   * transition_rating event (src/lib/lesson-ledger.ts). Additive/optional —
   * every record stored before this milestone simply lacks it. Not used by
   * summarizeLessons() itself, purely plumbing for page.tsx's
   * handleRateTransition.
   */
  outPositionSeconds?: number | null;
}

const MAX_LESSONS = 10;

/**
 * Grouping key: transition kind + whether the tempo-sync clamped + whether
 * the engine auto-degraded the duration. A clamped/degraded transition is a
 * meaningfully different "pattern" from a clean lock at the same transition
 * kind — a 👎 on a clamped bass_swap says nothing about clean bass_swaps —
 * so they're kept in separate buckets rather than merged by transitionType
 * alone.
 */
function groupKey(record: TransitionRecord): string {
  return `${record.transitionType}|${record.clamped ? "clamped" : "clean"}|${record.degraded ? "degraded" : "full"}`;
}

function formatBpm(bpm: number | null): string {
  return bpm === null ? "?" : String(Math.round(bpm));
}

/** Human-readable description of a group, using its most-recent record for the representative bpm/duration values. */
function describeGroup(key: string, mostRecent: TransitionRecord): string {
  const [transitionType, clampedTag] = key.split("|");
  if (clampedTag === "clamped") {
    return `${transitionType} with clamped BPM`;
  }
  return `${transitionType} ${formatBpm(mostRecent.bpmFrom)}→${formatBpm(mostRecent.bpmTo)} over ${mostRecent.durationBars} bars`;
}

/**
 * Summarizes rated transitions into at most MAX_LESSONS short bullet
 * strings, one per group. Groups are sorted by total rating count
 * (descending), tie-broken by the most recent `when` within the group
 * (descending) — i.e. the patterns with the most feedback, freshest first.
 */
export function summarizeLessons(records: TransitionRecord[]): string[] {
  const rated = records.filter((r) => r.rating !== null);
  if (rated.length === 0) return [];

  const groups = new Map<string, TransitionRecord[]>();
  for (const record of rated) {
    const key = groupKey(record);
    const list = groups.get(key);
    if (list) list.push(record);
    else groups.set(key, [record]);
  }

  const summaries = Array.from(groups.entries()).map(([key, groupRecords]) => {
    const up = groupRecords.filter((r) => r.rating === "up").length;
    const down = groupRecords.filter((r) => r.rating === "down").length;
    const mostRecent = groupRecords.reduce((a, b) => (b.when > a.when ? b : a));
    const parts: string[] = [];
    if (up > 0) parts.push(`👍 ×${up}`);
    if (down > 0) parts.push(`👎 ×${down}`);
    const avoid = down > up ? " — avoid" : "";
    const text = `${describeGroup(key, mostRecent)} rated ${parts.join(" ")}${avoid}`;
    return { text, total: up + down, mostRecentWhen: mostRecent.when };
  });

  summaries.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return b.mostRecentWhen - a.mostRecentWhen;
  });

  return summaries.slice(0, MAX_LESSONS).map((s) => s.text);
}
