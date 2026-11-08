import { STEM_ROLE, type MigrationPlan } from "./stem-migration.ts";

export const STEM_PREPARE_SECONDS = 60;
export const STEM_TAIL_SECONDS = 2;
export const STEM_MEMORY_BYTES = 512 * 1024 * 1024;
export const STEM_HANDOFF_SECONDS = 0.12;

/** Bound cache/decode waits as well as fetches; late results cannot resume a canceled job. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Preparation canceled"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); }
  });
}

/** All offsets are SOURCE seconds; all timestamps/durations are AudioContext seconds. */
export function stemClock(input: {
  now: number; delay: number; outgoingPosition: number; outgoingRate: number;
  outgoingBpm: number; incomingBpm: number; incomingAnchor: number;
  beatIn: number; bars: number; dropSeconds?: number;
}) {
  const { now, delay, outgoingPosition, outgoingRate, outgoingBpm, incomingBpm, bars } = input;
  const bpm = outgoingBpm * outgoingRate;
  const incomingRate = bpm / incomingBpm;
  if (![now, delay, outgoingPosition, outgoingRate, bpm, incomingRate, bars, input.incomingAnchor, input.beatIn].every(Number.isFinite) || bpm <= 0 || incomingRate <= 0 || outgoingRate <= 0 || delay < 0 || bars <= 0) throw new Error("Invalid migration clock");
  const duration = bars * 240 / bpm;
  const sourceBar = 240 / incomingBpm;
  const cue = Math.max(0, input.beatIn, input.incomingAnchor);
  const entry = input.dropSeconds === undefined
    ? input.incomingAnchor + Math.max(0, Math.ceil((cue - input.incomingAnchor) / sourceBar - 1e-7)) * sourceBar
    : input.dropSeconds - duration * incomingRate;
  if (!Number.isFinite(entry) || entry < 0) throw new Error("Not enough incoming music before the requested drop");
  const startTime = now + delay;
  return { startTime, endsAt: startTime + duration, duration, bpm, incomingRate, incomingOffset: entry, outgoingOffset: outgoingPosition + delay * outgoingRate };
}

/** A separate, explicit trance move. No numeric default is inferred from the pilot. */
export function planTranceBreakdown(outgoingStems: string[], incomingStems: string[], bpm: number, bars: number): MigrationPlan {
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(bars) || bars < 8) throw new Error("Invalid breakdown duration");
  if (!incomingStems.includes("bass") || !incomingStems.includes("drums") || !incomingStems.some(s => STEM_ROLE[s] === "harmony")) throw new Error("Breakdown needs incoming melody, drums and bass");
  const ramps: MigrationPlan["ramps"] = [];
  for (const stem of outgoingStems) {
    const role = STEM_ROLE[stem];
    if (!role) throw new Error(`Unknown stem role: ${stem}`);
    ramps.push({ deck: "out", stem, role, fromBar: 0, toBar: role === "harmony" ? 2 : 0.5, fromGain: 1, toGain: 0 });
  }
  for (const stem of incomingStems) {
    const role = STEM_ROLE[stem];
    if (!role) throw new Error(`Unknown stem role: ${stem}`);
    const rhythm = role === "bass" || role === "rhythm";
    ramps.push({ deck: "in", stem, role, fromBar: rhythm ? bars - 0.02 : role === "vocals" ? 2 : 0, toBar: rhythm ? bars : role === "vocals" ? 4 : 2, fromGain: 0, toGain: 1 });
  }
  return { totalBars: bars, barSeconds: 240 / bpm, ramps, bareRuns: [], warnings: [] };
}
