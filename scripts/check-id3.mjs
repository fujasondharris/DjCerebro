#!/usr/bin/env node
// Node-side smoke test for the ID3 parser: imports the exact same
// src/lib/id3.ts used by the browser (Node 24's built-in TypeScript type
// stripping runs it directly, no duplicate implementation, no build step)
// and asserts it reads TBPM/TKEY correctly off both generated test fixtures
// (Deck A's 120bpm and Deck B's 100bpm — see public/fixtures/).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "..", "public", "fixtures");

const { parseId3Tags } = await import("../src/lib/id3.ts");

const cases = [
  { file: "test-120bpm.mp3", expectedBpm: 120, expectedKey: "8A" },
  { file: "test-100bpm.mp3", expectedBpm: 100, expectedKey: "11A" },
];

let failed = false;

for (const { file, expectedBpm, expectedKey } of cases) {
  const fixturePath = path.join(fixturesDir, file);
  const buffer = await readFile(fixturePath);
  const audioFile = new File([buffer], file);
  const tags = await parseId3Tags(audioFile);

  console.log("Parsed ID3 tags from", fixturePath);
  console.log(tags);

  if (tags.bpm !== expectedBpm) {
    console.error(`FAIL: ${file}: expected bpm === ${expectedBpm}, got ${tags.bpm}`);
    failed = true;
    continue;
  }
  if (expectedKey && tags.key !== expectedKey) {
    console.error(`FAIL: ${file}: expected key === ${expectedKey}, got ${tags.key}`);
    failed = true;
    continue;
  }

  console.log(`PASS: ${file}: TBPM parsed as ${tags.bpm}, TKEY parsed as ${tags.key}`);
}

if (failed) process.exit(1);

console.log("PASS: all fixtures");
