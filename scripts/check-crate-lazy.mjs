#!/usr/bin/env node
// Node-side smoke test for the lazy-crate partial-fetch pure pieces
// (src/lib/crate-lazy.ts) — the ID3-declared-header-size math and the
// grow-if-bigger fetchTagHeader logic, both exercised with a mock
// RangeFetcher (no real network), plus a sanity check against a real
// committed fixture. Plain asserts, no test framework, mirrors
// check-crate-route.mjs/check-gain.mjs.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readId3DeclaredHeaderSize, fetchTagHeader, DEFAULT_HEADER_FETCH_BYTES } from "../src/lib/crate-lazy.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

// --- readId3DeclaredHeaderSize ---

function encodeSyncSafe(n) {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
}

function makeId3Header(tagSize) {
  const [b0, b1, b2, b3] = encodeSyncSafe(tagSize);
  // ID3 magic, version 3.0, no flags, then the 4 syncsafe size bytes.
  return new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, b0, b1, b2, b3]);
}

assertOk("readId3DeclaredHeaderSize: too few bytes -> null", readId3DeclaredHeaderSize(new Uint8Array(5)) === null);
assertOk(
  "readId3DeclaredHeaderSize: no ID3 magic -> null",
  readId3DeclaredHeaderSize(new Uint8Array(20)) === null
);

{
  const header = makeId3Header(1000);
  assertOk("readId3DeclaredHeaderSize: tagSize=1000 -> declared 1010 (10-byte header + frames)", readId3DeclaredHeaderSize(header) === 1010);
}

{
  const header = makeId3Header(0);
  assertOk("readId3DeclaredHeaderSize: tagSize=0 -> declared 10 (header only, no frames)", readId3DeclaredHeaderSize(header) === 10);
}

{
  // A real-world "monster header" scenario: bigger than DEFAULT_HEADER_FETCH_BYTES (256KB).
  const bigSize = 512 * 1024;
  const header = makeId3Header(bigSize);
  assertOk(
    "readId3DeclaredHeaderSize: a header bigger than the default fetch size is still read correctly",
    readId3DeclaredHeaderSize(header) === 10 + bigSize
  );
}

// --- fetchTagHeader (mock RangeFetcher, no network) ---

function mockResponse(bytes, ok = true, status = ok ? 206 : 416) {
  return { ok, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

{
  // Small file: the whole file (well under the 1024-byte first fetch) comes
  // back in one response, header included — declared size (10+50=60) fits
  // comfortably inside what was already fetched, so no growth is needed.
  const calls = [];
  const header = makeId3Header(50); // declares 50 frame bytes — tiny
  const fullResponse = new Uint8Array(1024);
  fullResponse.set(header);
  const fetcher = async (range) => {
    calls.push(range);
    return mockResponse(fullResponse);
  };
  const result = await fetchTagHeader(fetcher, 1024);
  assertOk("fetchTagHeader: small header -> exactly one fetch (no growth)", calls.length === 1);
  assertOk("fetchTagHeader: first-fetch range uses the given initialBytes", calls[0] === "bytes=0-1023");
  assertOk("fetchTagHeader: grew === false when no second fetch was needed", result.grew === false);
  assertOk("fetchTagHeader: returns the fetched bytes", result.bytes.length === fullResponse.length);
}

{
  // Monster header: the first fetch's declared size exceeds what we already
  // have -> a second, bigger fetch must happen, requesting exactly the
  // declared size.
  const initialBytes = 100;
  const declaredTagSize = 5000; // 10 + 5000 = 5010, way bigger than 100
  const firstChunk = makeId3Header(declaredTagSize); // only 10 bytes actually returned by the mock (simulating a truncated first fetch)
  const fullChunk = new Uint8Array(5010); // the full declared size, second fetch
  fullChunk.set(firstChunk);

  const calls = [];
  const fetcher = async (range) => {
    calls.push(range);
    if (calls.length === 1) return mockResponse(firstChunk);
    return mockResponse(fullChunk);
  };
  const result = await fetchTagHeader(fetcher, initialBytes);
  assertOk("fetchTagHeader: monster header triggers a second fetch", calls.length === 2);
  assertOk("fetchTagHeader: first fetch requests the initial byte range", calls[0] === `bytes=0-${initialBytes - 1}`);
  assertOk("fetchTagHeader: second fetch requests exactly the declared size", calls[1] === `bytes=0-${5010 - 1}`);
  assertOk("fetchTagHeader: grew === true after a successful growth fetch", result.grew === true);
  assertOk("fetchTagHeader: returns the GROWN bytes, not the truncated first fetch", result.bytes.length === 5010);
}

{
  // Monster header where the growth fetch itself fails — falls back to
  // whatever the first fetch returned rather than losing the track.
  const initialBytes = 100;
  const firstChunk = makeId3Header(5000);
  const calls = [];
  const fetcher = async (range) => {
    calls.push(range);
    if (calls.length === 1) return mockResponse(firstChunk);
    return mockResponse(new Uint8Array(0), false, 500);
  };
  const result = await fetchTagHeader(fetcher, initialBytes);
  assertOk("fetchTagHeader: growth-fetch failure falls back to the first fetch's bytes", result.bytes.length === firstChunk.length);
  assertOk("fetchTagHeader: grew stays false when the growth fetch failed", result.grew === false);
}

{
  // First fetch itself fails outright (network/HTTP error) -> null, the
  // caller's cue to treat this track as "tags unknown".
  const fetcher = async () => mockResponse(new Uint8Array(0), false, 404);
  const result = await fetchTagHeader(fetcher, 1024);
  assertOk("fetchTagHeader: first-fetch failure -> null (not a throw)", result === null);
}

assertOk("DEFAULT_HEADER_FETCH_BYTES: matches the documented 256KB", DEFAULT_HEADER_FETCH_BYTES === 256 * 1024);

// --- Sanity check against a real committed fixture (not just synthetic bytes) ---

{
  const fixturePath = path.join(__dirname, "..", "public", "fixtures", "test-120bpm.mp3");
  const fullBuffer = await readFile(fixturePath);
  const fetcher = async (range) => {
    const match = /^bytes=0-(\d+)$/.exec(range);
    const end = Math.min(Number(match[1]) + 1, fullBuffer.length);
    return mockResponse(fullBuffer.subarray(0, end));
  };
  const result = await fetchTagHeader(fetcher, DEFAULT_HEADER_FETCH_BYTES);
  assertOk("fetchTagHeader against a real fixture: never throws, returns bytes", result !== null && result.bytes.length > 10);
  const declared = readId3DeclaredHeaderSize(result.bytes);
  assertOk("fetchTagHeader against a real fixture: declared header size is sane (well under 256KB for a tiny test tone)", declared !== null && declared < DEFAULT_HEADER_FETCH_BYTES);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all lazy-crate partial-fetch cases");
