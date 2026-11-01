import type { Id3Tags } from "./id3.ts";
import type { SeratoBeatgrid } from "./serato.ts";
import type { CrateManifestEntry } from "./crate.ts";

export interface PlaybackMetadata {
  tags: Id3Tags;
  grid: SeratoBeatgrid | null;
  gridSource: "embedded" | "manifest" | null;
}

/** Restore analyzed timing stripped from the Drive MP3's tags. Only the current
 * committed entry for this exact Drive ID, byte size AND decoded duration may
 * supply a missing grid. Never infer an anchor from BPM or a filename match. */
export function playbackMetadata(
  tags: Id3Tags,
  embeddedGrid: SeratoBeatgrid | null,
  track: { id: string; source: "drive" | "local"; size: number },
  manifest: CrateManifestEntry | undefined,
  decodedDuration?: number,
): PlaybackMetadata {
  if (embeddedGrid) return { tags, grid: embeddedGrid, gridSource: "embedded" };
  const result: PlaybackMetadata = { tags, grid: null, gridSource: null };
  if (track.source !== "drive" || !manifest || manifest.id !== track.id || manifest.size !== track.size ||
      !Number.isFinite(decodedDuration) || !manifest.durationSeconds ||
      Math.abs(decodedDuration! - manifest.durationSeconds) > 0.25) return result;
  const grid = manifest.grid;
  if (!grid || !Number.isFinite(grid.bpm) || grid.bpm <= 0 || !Number.isFinite(grid.anchor) ||
      grid.anchor < 0 || grid.anchor >= decodedDuration! || !grid.markers.length ||
      grid.markers.some(marker => !Number.isFinite(marker.position) || marker.position < 0 || marker.position >= decodedDuration!)) return result;
  // A different tag tempo means the file/analysis disagree; fail closed.
  if (tags.bpm && Math.abs(tags.bpm - grid.bpm) > 1) return result;
  return {
    tags: { ...tags, bpm: tags.bpm ?? manifest.bpm ?? grid.bpm, key: tags.key ?? manifest.key ?? undefined },
    grid,
    gridSource: "manifest",
  };
}
