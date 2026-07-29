// Partial-fetch tag parsing for the lazy-crate architecture (large-library
// re-architecture — see CLAUDE_STATE.md). Jason's real crate is ~264 mp3s
// (~1.8GB); downloading every file in full just to read its BPM/key tag is
// what made "Load crate" take 5-15 minutes and crash iOS Safari on memory.
//
// The fix: the ID3v2 tag (and the Serato BeatGrid GEOB frame inside it — see
// src/lib/serato.ts) lives at the START of the file, and the ID3v2 header
// itself declares its own total size (bytes 6-9, a syncsafe int) — so a
// partial fetch of the first ~256KB is enough for tag parsing in virtually
// every real file, and the declared size lets us detect + refetch the rare
// monster header that exceeds it. This module does ONLY that partial fetch +
// size math; the actual TBPM/TKEY/BeatGrid parsing is still
// parseId3Tags()/parseSeratoBeatgrid() (src/lib/id3.ts, src/lib/serato.ts) —
// unmodified, per scope — called by page.tsx against a File built from the
// bytes this module fetches (both already parse via `file.slice(...).
// arrayBuffer()`, so wrapping partial bytes in a File is the same trick
// page.tsx already uses in loadFromBlob()/handleAddAllFromDrive(), not a new
// pattern).
//
// Deliberately duplicates the tiny ID3 "ID3" magic + syncsafe-int check
// rather than importing it from id3.ts/serato.ts — both of THOSE already
// duplicate the exact same header-walking logic between each other (see
// serato.ts's own file header comment for why), so a third small
// duplication here is consistent with this repo's existing precedent for
// keeping id3.ts's public surface untouched.

/** Default first-fetch size — comfortably covers real-world ID3v2 headers (BPM/key text frames + a Serato BeatGrid GEOB are all tiny; this only gets exceeded by embedded cover art, which we never read anyway). */
export const DEFAULT_HEADER_FETCH_BYTES = 256 * 1024;

/**
 * Reads the ID3v2 header's declared total tag size (10-byte header + all
 * frame bytes that follow it) from the first bytes of a file. Returns null
 * if there's no "ID3" magic at offset 0 or too few bytes to read the size
 * field — never throws. Pure, no I/O.
 */
export function readId3DeclaredHeaderSize(bytes: Uint8Array<ArrayBufferLike>): number | null {
  if (bytes.length < 10) return null;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null; // "ID3"
  const tagSize =
    ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  return 10 + tagSize; // header (10 bytes) + the declared frame-bytes size
}

/** Structural shape of a fetch Response that fetchTagHeader needs — a real fetch() Response satisfies this, and a test can mock it with a plain object. */
export interface RangeResponseLike {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type RangeFetcher = (rangeHeader: string) => Promise<RangeResponseLike>;

export interface FetchTagHeaderResult {
  /** The fetched header bytes, ready to wrap in a File for parseId3Tags()/parseSeratoBeatgrid(). */
  // Pinned to the ArrayBuffer-backed generic (not the wider ArrayBufferLike)
  // so this can be passed straight to `new File([bytes], name)` — File's
  // BlobPart type requires an ArrayBuffer-backed view, same TS 5.7+
  // distinction id3.ts's own file header comment documents.
  bytes: Uint8Array<ArrayBuffer>;
  /** True if a second, larger fetch was needed because the declared ID3 tag size exceeded the first fetch. */
  grew: boolean;
}

/**
 * Fetches the first `initialBytes` of a track via `fetcher` (a Range-header
 * fetch — see page.tsx's use against /api/crate/[id]), then checks the
 * ID3v2 header's own declared size: if it says the tag is bigger than what
 * we already have, re-fetches exactly that much in one more round trip.
 * Returns null if the first fetch itself fails (network/HTTP error) — that's
 * the caller's cue to treat this track as "tags unknown", same as any other
 * best-effort parse failure elsewhere in this app.
 */
export async function fetchTagHeader(
  fetcher: RangeFetcher,
  initialBytes: number = DEFAULT_HEADER_FETCH_BYTES
): Promise<FetchTagHeaderResult | null> {
  const first = await fetcher(`bytes=0-${initialBytes - 1}`);
  if (!first.ok) return null;
  const firstBytes = new Uint8Array(await first.arrayBuffer());

  const declaredSize = readId3DeclaredHeaderSize(firstBytes);
  if (declaredSize !== null && declaredSize > firstBytes.length) {
    const second = await fetcher(`bytes=0-${declaredSize - 1}`);
    if (second.ok) {
      const secondBytes = new Uint8Array(await second.arrayBuffer());
      return { bytes: secondBytes, grew: true };
    }
    // Second fetch failed (e.g. server doesn't like a huge range) — fall
    // back to what we already have rather than losing the track entirely;
    // tag parsing may just come back empty for this one file.
  }

  return { bytes: firstBytes, grew: false };
}
