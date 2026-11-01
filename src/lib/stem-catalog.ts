import { resolveMusicMetadata, musicLabel, type MetadataTrack } from "./music-metadata.ts";
import type { StemManifestEntry } from "./stems";

export function usableStemEntry(entry?: StemManifestEntry): StemManifestEntry | null {
  return entry && Object.keys(entry.stems).length > 0 && Object.values(entry.stems).every(id => /^(?:[\w-]{10,}|\/audio\/stems\/[\w/-]+\.mp3)$/.test(id)) ? entry : null;
}
export function describeStems(track: MetadataTrack, entry?: StemManifestEntry) {
  const metadata = resolveMusicMetadata(track);
  return Object.entries(usableStemEntry(entry)?.stems ?? {}).map(([role, id]) => ({
    id, role, ...metadata, label: `${musicLabel(track)} — ${role}`,
  }));
}
