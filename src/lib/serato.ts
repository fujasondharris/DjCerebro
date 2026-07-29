// Serato "BeatGrid" GEOB tag reader — pulls the beat anchor position + BPM
// Serato writes into an mp3's ID3v2 tag (frame GEOB, description
// "Serato BeatGrid") so Beat Sync can phase-align two decks instead of only
// tempo-matching them. Deliberately a small SELF-CONTAINED frame walker
// rather than reusing src/lib/id3.ts's internals: id3.ts is explicitly
// scoped as "do not touch its public API or TBPM/TKEY behavior" for this
// milestone, and the safest way to guarantee zero regression there is to not
// touch that file at all. The header-walking logic below intentionally
// mirrors id3.ts's (same ID3v2.3/2.4 syncsafe-int handling), see that file's
// own header comment for why this repo hand-rolls ID3 parsing instead of
// pulling in a dependency.
//
// Payload format (github.com/Holzhaus/serato-tags, "Serato BeatGrid"), after
// the GEOB frame's encoding byte + 3 terminated strings (mime, filename,
// description):
//   u8 x2         header bytes (observed `01 00`) — not validated, just skipped
//   u32BE         marker count
//   per NON-terminal marker (count - 1 of them): f32BE position (source-
//                 seconds) + u32BE beatsTillNext
//   terminal marker (always present, last): f32BE position (source-seconds,
//                 this is the "anchor") + f32BE bpm
//   u8            trailing byte (ignored)
// Best-effort only: any parse failure (tag/frame absent, corrupt, truncated,
// unknown version) returns null rather than throwing — Beat Sync falls back
// to tag-BPM-only estimation when this happens (see page.tsx).

export interface SeratoBeatgridMarker {
  position: number;
  bpm?: number;
  beatsTillNext?: number;
}

export interface SeratoBeatgrid {
  markers: SeratoBeatgridMarker[];
  /** Source-seconds position of the terminal marker — the phase anchor. */
  anchor: number;
  /** BPM of the terminal marker. */
  bpm: number;
}

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

function readFloat32BE(bytes: Bytes, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return view.getFloat32(0, false);
}

// Text encoding byte (ID3v2 convention, also used inside GEOB): 0 = Latin-1,
// 1 = UTF-16 with BOM, 2 = UTF-16BE no BOM, 3 = UTF-8. Encodings 1/2 use a
// two-byte null terminator; 0/3 use a single byte.
function findTerminator(bytes: Bytes, start: number, wide: boolean): number {
  let i = start;
  if (wide) {
    while (i + 1 < bytes.length && !(bytes[i] === 0 && bytes[i + 1] === 0)) i += 2;
    return Math.min(i, bytes.length);
  }
  while (i < bytes.length && bytes[i] !== 0) i++;
  return i;
}

function decodeText(bytes: Bytes, encodingByte: number): string {
  try {
    switch (encodingByte) {
      case 0:
        return new TextDecoder("iso-8859-1").decode(bytes);
      case 1: {
        // TextDecoder strips a leading BOM by default (ignoreBOM defaults to
        // false, i.e. "process/remove it"), so no manual stripping needed.
        const isBigEndian = bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
        return new TextDecoder(isBigEndian ? "utf-16be" : "utf-16le").decode(bytes);
      }
      case 2:
        return new TextDecoder("utf-16be").decode(bytes);
      case 3:
        return new TextDecoder("utf-8").decode(bytes);
      default:
        return new TextDecoder("iso-8859-1").decode(bytes);
    }
  } catch {
    return "";
  }
}

interface GeobFrame {
  description: string;
  payload: Bytes;
}

// GEOB layout: encoding byte, then MIME type (always Latin-1 per spec,
// regardless of the encoding byte), then filename and description (both in
// the frame's stated encoding), then the raw encapsulated object bytes.
function parseGeobFrame(frameBody: Bytes): GeobFrame | null {
  if (frameBody.length < 1) return null;
  const encodingByte = frameBody[0];
  const wide = encodingByte === 1 || encodingByte === 2;

  const mimeEnd = findTerminator(frameBody, 1, false);
  let pos = mimeEnd + 1;
  if (pos > frameBody.length) return null;

  const filenameEnd = findTerminator(frameBody, pos, wide);
  pos = filenameEnd + (wide ? 2 : 1);
  if (pos > frameBody.length) return null;

  const descriptionEnd = findTerminator(frameBody, pos, wide);
  const description = decodeText(frameBody.subarray(pos, descriptionEnd), encodingByte);
  pos = descriptionEnd + (wide ? 2 : 1);
  if (pos > frameBody.length) return null;

  return { description, payload: frameBody.subarray(pos) };
}

function decodeBeatgridPayload(payload: Bytes): SeratoBeatgrid | null {
  if (payload.length < 2 + 4) return null;
  let offset = 2; // skip the two header bytes (observed `01 00`)
  const count = readUInt32BE(payload, offset);
  offset += 4;
  if (count < 1) return null;

  const markers: SeratoBeatgridMarker[] = [];
  for (let i = 0; i < count - 1; i++) {
    if (offset + 8 > payload.length) return null; // truncated
    const position = readFloat32BE(payload, offset);
    const beatsTillNext = readUInt32BE(payload, offset + 4);
    markers.push({ position, beatsTillNext });
    offset += 8;
  }

  // Terminal marker: always position + bpm (both float32BE), never beatsTillNext.
  if (offset + 8 > payload.length) return null;
  const anchor = readFloat32BE(payload, offset);
  const bpm = readFloat32BE(payload, offset + 4);
  if (!(bpm > 0) || !Number.isFinite(anchor)) return null;
  markers.push({ position: anchor, bpm });

  return { markers, anchor, bpm };
}

/**
 * Parse the ID3v2 header + frames from an mp3 File and pull out the Serato
 * BeatGrid GEOB tag, if present. Returns null on anything unexpected
 * (missing tag/frame, corrupt payload) — never throws.
 */
export async function parseSeratoBeatgrid(file: File): Promise<SeratoBeatgrid | null> {
  try {
    const head = await file.slice(0, 256 * 1024).arrayBuffer();
    const bytes = new Uint8Array(head);

    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
      return null; // no "ID3" magic at offset 0
    }

    const majorVersion = bytes[3];
    const tagSize = readSyncSafeInt(bytes, 6);
    const body: Bytes = bytes.subarray(10, Math.min(bytes.length, 10 + tagSize));

    let offset = 0;
    while (offset + 10 <= body.length) {
      const idBytes = body.subarray(offset, offset + 4);
      if (idBytes[0] === 0) break; // hit padding

      const frameId = String.fromCharCode(idBytes[0], idBytes[1], idBytes[2], idBytes[3]);
      const frameSize =
        majorVersion >= 4 ? readSyncSafeInt(body, offset + 4) : readUInt32BE(body, offset + 4);
      const frameStart = offset + 10;
      const frameEnd = frameStart + frameSize;
      if (frameSize <= 0 || frameEnd > body.length) break; // malformed/truncated

      if (frameId === "GEOB") {
        const geob = parseGeobFrame(body.subarray(frameStart, frameEnd));
        if (geob && geob.description === "Serato BeatGrid") {
          const grid = decodeBeatgridPayload(geob.payload);
          if (grid) return grid;
        }
      }

      offset = frameEnd;
    }

    return null;
  } catch {
    return null;
  }
}
