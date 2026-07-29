#!/usr/bin/env node
// Builds public/fixtures/test-120bpm-grid.mp3: a copy of the existing
// test-120bpm.mp3 fixture with a hand-constructed Serato "BeatGrid" GEOB
// frame appended to its ID3v2 tag (anchor 0.5s, bpm 120). The ffmpeg-made
// fixtures have no Serato tags at all, so check:serato needs one built by
// hand. Rerunnable: always rebuilds from the source fixture, never from its
// own prior output.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "..", "public", "fixtures");
const sourcePath = path.join(fixturesDir, "test-120bpm.mp3");
const outputPath = path.join(fixturesDir, "test-120bpm-grid.mp3");

const ANCHOR_SECONDS = 0.5;
const BPM = 120;

function readSyncSafeInt(bytes, offset) {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function writeSyncSafeInt(value) {
  return Buffer.from([
    (value >>> 21) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 7) & 0x7f,
    value & 0x7f,
  ]);
}

function nullTerminated(str) {
  return Buffer.concat([Buffer.from(str, "latin1"), Buffer.from([0])]);
}

function buildGeobFrame() {
  const payload = Buffer.concat([
    Buffer.from([0x01, 0x00]), // observed Serato BeatGrid header bytes
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(1, 0); // marker count = 1 (single terminal marker)
      return b;
    })(),
    (() => {
      const b = Buffer.alloc(8);
      b.writeFloatBE(ANCHOR_SECONDS, 0); // terminal marker position (the anchor)
      b.writeFloatBE(BPM, 4); // terminal marker bpm
      return b;
    })(),
    Buffer.from([0x00]), // trailing byte
  ]);

  const frameBody = Buffer.concat([
    Buffer.from([0x00]), // encoding: ISO-8859-1
    nullTerminated("application/octet-stream"), // mime
    nullTerminated(""), // filename
    nullTerminated("Serato BeatGrid"), // description
    payload,
  ]);

  const frameSize = writeSyncSafeInt(frameBody.length); // this fixture's ID3 tag is v2.4 (syncsafe frame sizes)
  return Buffer.concat([Buffer.from("GEOB", "latin1"), frameSize, Buffer.from([0x00, 0x00]), frameBody]);
}

async function main() {
  const buf = await readFile(sourcePath);
  if (buf.length < 10 || buf.toString("latin1", 0, 3) !== "ID3") {
    throw new Error(`${sourcePath} has no ID3v2 tag to extend`);
  }
  const majorVersion = buf[3];
  const tagSize = readSyncSafeInt(buf, 6);

  // Walk existing frames (same stop-at-padding rule as src/lib/id3.ts and
  // src/lib/serato.ts) to find exactly where real frame data ends, so we
  // insert our new frame BEFORE any zero padding rather than after it —
  // both parsers stop walking the instant they see a zero frame-ID byte.
  const body = buf.subarray(10, 10 + tagSize);
  let offset = 0;
  while (offset + 10 <= body.length) {
    if (body[offset] === 0) break;
    const frameSize =
      majorVersion >= 4 ? readSyncSafeInt(body, offset + 4) : body.readUInt32BE(offset + 4);
    if (frameSize <= 0) break;
    offset += 10 + frameSize;
  }
  const framesEnd = offset;

  const geobFrame = buildGeobFrame();
  const newTagBody = Buffer.concat([body.subarray(0, framesEnd), geobFrame]);
  const newTagSize = writeSyncSafeInt(newTagBody.length);

  const newHeader = Buffer.from(buf.subarray(0, 10));
  newTagSize.copy(newHeader, 6);

  const audioData = buf.subarray(10 + tagSize);
  const output = Buffer.concat([newHeader, newTagBody, audioData]);

  await writeFile(outputPath, output);
  console.log(`Wrote ${outputPath} (${output.length} bytes, GEOB frame ${geobFrame.length} bytes)`);
}

await main();
