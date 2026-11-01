import { syncTempo } from "./beatmatch.ts";
import type { QueueCommand } from "./brain.ts";

/** An explicit short residency overrides the default partner-dance end wait. */
export function queueForResidency(command: QueueCommand, seconds: number | null,
  fromBpm: number | null, fromTempo: number, toBpm: number | null): QueueCommand {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0 || command.transition !== "gap") return command;
  const tagged = !!fromBpm && !!toBpm;
  const transition = !tagged ? "cut" : syncTempo(fromBpm, fromTempo, toBpm).clamped ? "echo_out" : "bass_swap";
  return { ...command, transition, durationBars: 4,
    say: `${seconds}s per track: ${transition} handoff; not waiting for the whole song` };
}

/** Land near the requested residency, not at the early preparation trigger. */
export function residencyHandoffDelay(seconds: number, played: number, transition: QueueCommand["transition"],
  bars: number, effectiveBpm: number, candidates: number[]): number {
  const beat = 60 / Math.max(1, effectiveBpm);
  const handoff = transition === "bass_swap" || transition === "beatmatch_crossfade" ? bars * 4 * beat
    : transition === "echo_out" ? beat : 0;
  const desired = Math.max(0, seconds - played - handoff);
  const nearby = candidates.filter(delay => delay >= 0 && Math.abs(delay - desired) <= 2);
  return nearby.length ? nearby.reduce((best, delay) => Math.abs(delay - desired) < Math.abs(best - desired) ? delay : best) : desired;
}
