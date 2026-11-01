// Minimal client-side ID3v2 tag reader — BPM/key plus title/artist/genre
// text frames out of an mp3 File. Hand-written with zero deps
// instead of bundling `music-metadata`: that package pulls in Node builtins
// (stream/buffer) that fight the Next.js client webpack config, and this is a
// much smaller surface that is fully sufficient for the two fields we need.
//
// Reference: ID3v2.3.0 spec (id3.org/id3v2.3.0) and ID3v2.4.0 spec
// (id3.org/id3v2.4.0-structure), frame header layout (section 3.3 / 4) and
// text-frame encoding byte (section 4).

export interface Id3Tags {
  bpm?: number;
  key?: string;
  title?: string;
  artist?: string;
  genre?: string;
}

const EMPTY_TAGS: Id3Tags = {};

// TS 5.7+ distinguishes Uint8Array<ArrayBuffer> from the wider
// Uint8Array<ArrayBufferLike> that .subarray()/.slice() return; use the
// wider alias everywhere here so reassigning a subarray back to a `let`
// (see removeUnsynchronisation below) type-checks.
type Bytes = Uint8Array<ArrayBufferLike>;

function readSyncSafeInt(bytes: Bytes, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function readUInt32BE(bytes: Bytes, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

// Frame text bodies start with a one-byte text-encoding indicator, then the
// (possibly null-terminated) text in that encoding.
function decodeFrameText(bytes: Bytes): string {
  if (bytes.length === 0) return "";
  const encodingByte = bytes[0];
  const body = bytes.subarray(1);
  try {
    switch (encodingByte) {
      case 0: // ISO-8859-1 / Latin-1
        return new TextDecoder("iso-8859-1").decode(body).replace(/\0+$/, "");
      case 1: {
        // UTF-16 with a leading BOM; default to LE if the BOM is missing/odd.
        const isBigEndian = body.length >= 2 && body[0] === 0xfe && body[1] === 0xff;
        return new TextDecoder(isBigEndian ? "utf-16be" : "utf-16le")
          .decode(body)
          .replace(/^\uFEFF/, "")
          .replace(/\0+$/, "");
      }
      case 2: // UTF-16BE, no BOM (ID3v2.4 only)
        return new TextDecoder("utf-16be").decode(body).replace(/\0+$/, "");
      case 3: // UTF-8 (ID3v2.4 only)
        return new TextDecoder("utf-8").decode(body).replace(/\0+$/, "");
      default:
        return new TextDecoder("iso-8859-1").decode(bytes).replace(/\0+$/, "");
    }
  } catch {
    return "";
  }
}

// Reverse ID3v2 "unsynchronisation" (FF 00 -> FF) when the tag header flag says it was applied.
function removeUnsynchronisation(bytes: Bytes): Bytes {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i]);
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) {
      i++; // drop the inserted 0x00
    }
  }
  return Uint8Array.from(out);
}

/**
 * Parse ID3v2 BPM/key and searchable title/artist/genre from an mp3 File.
 * Best-effort only: any parse failure (missing tag, corrupt frame, unknown
 * version) returns {} rather than throwing, so playback and the tempo
 * slider keep working with the effective-BPM readout simply hidden.
 */
export async function parseId3Tags(file: File): Promise<Id3Tags> {
  try {
    // The ID3v2 tag lives at the start of the file. 256KB comfortably covers
    // any tag we care about (we ignore embedded cover art frames entirely).
    const head = await file.slice(0, 256 * 1024).arrayBuffer();
    const bytes = new Uint8Array(head);

    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
      return EMPTY_TAGS; // no "ID3" magic at offset 0
    }

    const majorVersion = bytes[3]; // 3 => ID3v2.3, 4 => ID3v2.4
    const headerFlags = bytes[5];
    const unsynchronised = (headerFlags & 0x80) !== 0;
    const tagSize = readSyncSafeInt(bytes, 6);

    let body: Bytes = bytes.subarray(10, Math.min(bytes.length, 10 + tagSize));
    if (unsynchronised) body = removeUnsynchronisation(body);

    const tags: Id3Tags = {};
    let offset = 0;

    while (offset + 10 <= body.length) {
      const idBytes = body.subarray(offset, offset + 4);
      if (idBytes[0] === 0) break; // hit padding

      const frameId = String.fromCharCode(idBytes[0], idBytes[1], idBytes[2], idBytes[3]);
      const frameSize =
        majorVersion >= 4 ? readSyncSafeInt(body, offset + 4) : readUInt32BE(body, offset + 4);
      const frameStart = offset + 10;
      const frameEnd = frameStart + frameSize;
      if (frameSize <= 0 || frameEnd > body.length) break; // malformed/truncated — stop, keep what we have

      if (["TBPM", "TKEY", "TIT2", "TPE1", "TCON"].includes(frameId)) {
        const text = decodeFrameText(body.subarray(frameStart, frameEnd)).trim();
        if (frameId === "TBPM") {
          const parsed = parseFloat(text);
          if (!Number.isNaN(parsed) && parsed > 0) tags.bpm = parsed;
        } else if (frameId === "TKEY" && text) {
          tags.key = text;
        } else if (text) {
          const field = { TIT2: "title", TPE1: "artist", TCON: "genre" }[frameId] as "title" | "artist" | "genre";
          // Numeric ID3 genres need a lookup, not a guessed musical category.
          const cleaned = text.replace(/\0/g, " / ").trim();
          if (field !== "genre" || !/^\(?\d+\)?$/.test(cleaned)) tags[field] = cleaned;
        }
      }

      offset = frameEnd;
    }

    return tags;
  } catch {
    return EMPTY_TAGS;
  }
}
