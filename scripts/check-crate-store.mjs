#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reconcileCrateList, loadCrateList, saveCrateList } from "../src/lib/crate-store.ts";

const manifest = JSON.parse(readFileSync(new URL("../src/data/crate-manifest.json", import.meta.url), "utf8"));
// Retired IDs observed in production's failing requests on 2026-10-07 and
// confirmed against the manifest before e09753f's Drive-folder migration.
const saved = [
  { id: "1Y7ywSnTkGXPevIDpmW9hhHaSi2y7lXEc", name: "J Balvin - Ginza.mp3", size: 5456609, bpm: 102, key: "Fm", grid: { anchor: 1.6171071529388428, bpm: 101.99921417236328, markers: [{ position: 1.6171071529388428, bpm: 101.99921417236328 }] } },
  { id: "1BTwKUCZx_oXFkcSvXa4C6A6k2nDrR0Jh", name: "Don Omar - Pobre Diabla.mp3", size: 8976546, bpm: 92, key: "Am", grid: { anchor: 0.24653571844100952, bpm: 91.9996109008789, markers: [{ position: 0.24653571844100952, bpm: 91.9996109008789 }] } },
];
const before = structuredClone(saved);
const repaired = reconcileCrateList(saved, manifest);
assert.equal(repaired.relinked, 2);
assert.deepEqual(repaired.entries.map(e => e.id), ["1rSn2Ad3DDzqoiyNefXbt87_SN_w3nvZ3", "1kIgLJjGOJkQ470OSjBPmnh8Dr6zGe7vx"]);
for (const entry of repaired.entries) {
  const current = manifest.find(m => m.id === entry.id);
  for (const field of ["name", "size", "bpm", "key", "grid"]) assert.deepEqual(entry[field], current[field] ?? null);
}
assert.deepEqual(saved, before, "repair must not mutate old metadata or cache keys");
assert.deepEqual(reconcileCrateList(repaired.entries, manifest), { entries: repaired.entries, relinked: 0 }, "a second restore is stable");
assert.equal(reconcileCrateList([...saved, ...repaired.entries], manifest).entries.length, 2, "old and current copies converge without duplicates");

const unknown = { ...saved[0], id: "unknown", name: "Private new track.mp3" };
assert.deepEqual(reconcileCrateList([unknown], manifest), { entries: [unknown], relinked: 0 });
const ambiguous = [...manifest, { ...manifest.find(m => m.name === saved[0].name), id: "other-version" }];
assert.deepEqual(reconcileCrateList([saved[0]], ambiguous), { entries: [saved[0]], relinked: 0 }, "same-name alternatives must never be guessed");
const wideName = { ...saved[0], name: "Farruko - Farruko ＂Mi Forma de Ser＂ (Official Video).mp3" };
assert.equal(reconcileCrateList([wideName], manifest).entries[0].id, "15uJOV_eRGZ0gr6y5BBDI2P8aH9tYcYyn", "old full-width punctuation matches the current filename");
assert.equal(reconcileCrateList([wideName], [...manifest, { id: "ambiguous", name: wideName.name }]).relinked, 0, "normalization collisions remain ambiguous");
const missingTags = reconcileCrateList([saved[0]], [{ id: "replacement", name: saved[0].name }]);
assert.deepEqual(missingTags.entries[0], { id: "replacement", name: saved[0].name, size: null, bpm: null, key: null, grid: null }, "retired audio timing must not leak into a replacement");
const currentWithOwnTags = { ...repaired.entries[0], bpm: 103 };
assert.deepEqual(reconcileCrateList([currentWithOwnTags], manifest).entries, [currentWithOwnTags], "existing current IDs keep their saved metadata");

const storage = new Map();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
} });
saveCrateList(saved);
saveCrateList(reconcileCrateList(loadCrateList(), manifest).entries);
assert.deepEqual(loadCrateList(), repaired.entries, "the next page load uses the repaired IDs and metadata");
console.log("PASS: retired Drive IDs repaired, current metadata and persistence verified, ambiguous/unknown tracks preserved");
