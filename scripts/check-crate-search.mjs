import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { searchAndSortCrate, trackSearchMetadata } from "../src/lib/crate-search.ts";
import { parseId3Tags } from "../src/lib/id3.ts";
import { loadCrateList, saveCrateList, reconcileCrateList } from "../src/lib/crate-store.ts";
const tracks = [
  { id: "1", name: "Marc Anthony - Vivir Mi Vida.mp3", genre: "Salsa", bpm: 100 },
  { id: "2", name: "Daddy Yankee - Gasolina.mp3", genre: "Reggaetón", bpm: 96 },
  { id: "3", name: "Unknown.mp3", bpm: null },
  { id: "4", name: "Bad filename.mp3", title: "Ámame", artist: "Zeta", genre: "Bachata", bpm: 130 },
];
const before = structuredClone(tracks);
const ids = entries => entries.map(e => e.id);
assert.deepEqual(ids(searchAndSortCrate(tracks, "marc vida", "", "original")), ["1"]);
assert.deepEqual(ids(searchAndSortCrate(tracks, "reggaeton", "", "original")), ["2"]);
assert.deepEqual(ids(searchAndSortCrate(tracks, "AMAME zeta", "", "original")), ["4"]);
assert.deepEqual(ids(searchAndSortCrate(tracks, "", "salsa", "original")), ["1"]);
assert.deepEqual(ids(searchAndSortCrate(tracks, "", "__untagged", "original")), ["3"]);
assert.deepEqual(ids(searchAndSortCrate(tracks, "", "", "title")), ["4", "2", "3", "1"]);
assert.deepEqual(ids(searchAndSortCrate(tracks, "", "", "artist")), ["2", "1", "4", "3"]);
assert.deepEqual(ids(searchAndSortCrate(tracks, "", "", "genre")), ["4", "2", "1", "3"]);
assert.deepEqual(ids(searchAndSortCrate(tracks, "", "", "bpm")), ["2", "1", "4", "3"]);
assert.deepEqual(searchAndSortCrate(tracks, "no such song", "", "title"), []);
assert.deepEqual(tracks, before, "display sorting must not mutate engine order");
assert.equal(searchAndSortCrate(tracks, "", "", "title")[0], tracks[3], "click target retains object/ID identity");
assert.equal(trackSearchMetadata({ name: "J Balvin - Ginza.mp3", genre: "Music" }).genre, "Reggaeton");
assert.equal(trackSearchMetadata({ name: "J Balvin - Ginza.mp3", genre: "Music" }).genreSource, "artist-estimate");
const real = JSON.parse(readFileSync(new URL("../src/data/crate-manifest.json", import.meta.url)));
assert.ok(searchAndSortCrate(real, "j balvin ginza", "", "title").length > 0);
assert.ok(searchAndSortCrate(real, "pobre diabla", "", "title").length > 0);
const storage = new Map();
globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
saveCrateList(tracks);
assert.deepEqual(loadCrateList(), tracks, "labels survive reload");
assert.equal(reconcileCrateList([tracks[0]], [{ id: "replacement", name: tracks[0].name }]).entries[0].genre, "Salsa");
// Real ID3v2.3 bytes, not a mock parser: title/artist/genre plus legacy BPM/key.
const frames = Object.entries({ TIT2: "Ámame", TPE1: "Zeta", TCON: "Bachata", TBPM: "130", TKEY: "8A" }).map(([id, text]) => {
  const data = Buffer.concat([Buffer.from([3]), Buffer.from(text)]);
  const header = Buffer.alloc(10); header.write(id); header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
});
const payload = Buffer.concat(frames);
const header = Buffer.from([73, 68, 51, 3, 0, 0, (payload.length >> 21) & 127, (payload.length >> 14) & 127, (payload.length >> 7) & 127, payload.length & 127]);
assert.deepEqual(await parseId3Tags(new File([header, payload], "tagged.mp3")), { title: "Ámame", artist: "Zeta", genre: "Bachata", bpm: 130, key: "8A" });
console.log("PASS: name/artist/genre search, accents, all sorts, filters, ID stability, saved labels, actual crate and ID3 frames");
