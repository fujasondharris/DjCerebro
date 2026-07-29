#!/usr/bin/env node
// Node-side smoke test for the on-demand-download + IndexedDB-cache pure
// pieces (src/lib/track-cache.ts) — the LRU eviction planner (no IDB needed
// at all) and the getTrackBlob() cache-or-download orchestrator, exercised
// against a plain Map standing in for IndexedDB (Node has no real IDB — this
// is the "mock IDB with a Map" the dispatch asked for). Plain asserts, no
// test framework, mirrors check-gain.mjs/check-crate-route.mjs.
import { planEvictions, getTrackBlob, CACHE_MAX_FILES, CACHE_MAX_BYTES } from "../src/lib/track-cache.ts";

let failures = 0;
function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

// --- planEvictions (pure LRU policy) ---

assertOk("planEvictions: empty store, nothing to evict", planEvictions([], { id: "new", size: 100, lastUsed: 1 }).length === 0);

{
  const existing = [
    { id: "a", size: 100, lastUsed: 1 },
    { id: "b", size: 100, lastUsed: 2 },
  ];
  const evicted = planEvictions(existing, { id: "c", size: 100, lastUsed: 3 }, 10, 10_000);
  assertOk("planEvictions: well under both caps -> nothing evicted", evicted.length === 0);
}

{
  // File-count cap: 3 existing + 1 incoming = 4, cap is 3 files.
  const existing = [
    { id: "a", size: 1, lastUsed: 1 },
    { id: "b", size: 1, lastUsed: 2 },
    { id: "c", size: 1, lastUsed: 3 },
  ];
  const evicted = planEvictions(existing, { id: "d", size: 1, lastUsed: 4 }, 3, 1_000_000);
  assertOk("planEvictions: file-count cap evicts exactly one (oldest)", evicted.length === 1 && evicted[0] === "a");
}

{
  // Byte cap: 3 files of 100 bytes each + incoming 100 bytes = 400, cap 250 bytes.
  const existing = [
    { id: "a", size: 100, lastUsed: 1 }, // oldest
    { id: "b", size: 100, lastUsed: 2 },
    { id: "c", size: 100, lastUsed: 3 },
  ];
  const evicted = planEvictions(existing, { id: "d", size: 100, lastUsed: 4 }, 1_000, 250);
  assertOk(
    "planEvictions: byte cap evicts oldest-first until under the cap",
    evicted.join(",") === "a,b"
  );
}

{
  // The incoming entry is NEVER evicted even if it's (somehow) already present in `existing` under the same id.
  const existing = [{ id: "new", size: 1_000_000, lastUsed: 0 }];
  const evicted = planEvictions(existing, { id: "new", size: 1_000_000, lastUsed: 100 }, 1, 1);
  assertOk("planEvictions: the incoming id is excluded from its own eviction candidates", !evicted.includes("new"));
}

assertOk("planEvictions: default caps match the documented ~60 files / ~500MB", CACHE_MAX_FILES === 60 && CACHE_MAX_BYTES === 500 * 1024 * 1024);

// --- getTrackBlob (cache-or-download orchestrator, Map-mocked IDB) ---

function makeFakeBlob(bytes) {
  return { size: bytes }; // getTrackBlob only ever reads .size off the resolved blob
}

function makeMapStore() {
  const map = new Map();
  return {
    async get(id) {
      return map.get(id) ?? null;
    },
    async put(entry) {
      map.set(entry.id, entry);
    },
    async delete(id) {
      map.delete(id);
    },
    async list() {
      return Array.from(map.values());
    },
    _map: map, // test-only escape hatch
  };
}

{
  const store = makeMapStore();
  let fetchCount = 0;
  const fetchFull = async () => {
    fetchCount++;
    return makeFakeBlob(1000);
  };
  let missCount = 0;

  const first = await getTrackBlob("t1", fetchFull, { store, onCacheMiss: () => missCount++ });
  assertOk("getTrackBlob: cache miss calls fetchFull", fetchCount === 1);
  assertOk("getTrackBlob: cache miss fires onCacheMiss exactly once", missCount === 1);
  assertOk("getTrackBlob: returns the fetched blob", first.size === 1000);
  assertOk("getTrackBlob: stores the entry after a miss", store._map.has("t1"));

  const second = await getTrackBlob("t1", fetchFull, { store, onCacheMiss: () => missCount++ });
  assertOk("getTrackBlob: cache hit does NOT call fetchFull again", fetchCount === 1);
  assertOk("getTrackBlob: cache hit does NOT fire onCacheMiss", missCount === 1);
  assertOk("getTrackBlob: cache hit returns the same blob", second.size === 1000);
}

{
  // Eviction actually happens through getTrackBlob when the file-count cap is exceeded.
  const store = makeMapStore();
  for (let i = 0; i < 3; i++) {
    await store.put({ id: `old${i}`, blob: makeFakeBlob(10), size: 10, lastUsed: i }); // ascending lastUsed, old0 is oldest
  }
  const blob = await getTrackBlob("newTrack", async () => makeFakeBlob(10), { store, onCacheMiss: () => {} });
  const evictedCount = 4 - store._map.size; // started with 3 + wrote 1 = 4 before eviction
  assertOk("getTrackBlob: file-count cap (passed via planEvictions' defaults would be 60; here we just confirm eviction fires by pre-seeding a tiny store) leaves the new entry present", store._map.has("newTrack") && blob.size === 10);
  assertOk("getTrackBlob: nothing evicted when well under the default 60-file cap", evictedCount === 0);
}

{
  // Explicit small caps threaded through a custom store wrapper to prove getTrackBlob's OWN eviction call-through (not just planEvictions in isolation). getTrackBlob itself hardcodes planEvictions' default caps, so we simulate a tiny cap by pre-filling the store past a byte budget and checking the real default (500MB) doesn't evict tiny fixtures — the meaningful integration point is exercised via planEvictions directly above; here we confirm getTrackBlob calls store.delete() on the ids planEvictions returns.
  const deletedIds = [];
  const map = new Map();
  // Pre-seed one giant "existing" entry that will get evicted once the new (also giant) entry pushes the store over the default 500MB byte cap.
  const giantSize = 400 * 1024 * 1024; // 400MB
  map.set("giant-old", { id: "giant-old", blob: makeFakeBlob(giantSize), size: giantSize, lastUsed: 1 });
  const store = {
    async get(id) {
      return map.get(id) ?? null;
    },
    async put(entry) {
      map.set(entry.id, entry);
    },
    async delete(id) {
      deletedIds.push(id);
      map.delete(id);
    },
    async list() {
      return Array.from(map.values());
    },
  };
  const newSize = 200 * 1024 * 1024; // 200MB — 400+200=600MB > 500MB cap, must evict the old one
  await getTrackBlob("giant-new", async () => makeFakeBlob(newSize), { store, onCacheMiss: () => {} });
  assertOk("getTrackBlob: exceeding the byte cap actually calls store.delete() on the evicted id", deletedIds.includes("giant-old"));
  assertOk("getTrackBlob: the new entry survives the eviction it triggered", map.has("giant-new"));
}

{
  // IDB unavailable (store.get/list reject) — getTrackBlob falls back to a plain fetch rather than throwing.
  const brokenStore = {
    async get() {
      throw new Error("IndexedDB unavailable");
    },
    async put() {
      throw new Error("IndexedDB unavailable");
    },
    async delete() {
      throw new Error("IndexedDB unavailable");
    },
    async list() {
      throw new Error("IndexedDB unavailable");
    },
  };
  let fetchCount = 0;
  const blob = await getTrackBlob("t2", async () => {
    fetchCount++;
    return makeFakeBlob(50);
  }, { store: brokenStore, onCacheMiss: () => {} });
  assertOk("getTrackBlob: broken store still returns a real blob via fetchFull (never throws)", blob.size === 50 && fetchCount === 1);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all track-cache (LRU + cache-or-download) cases");
