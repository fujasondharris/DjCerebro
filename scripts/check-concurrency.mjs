#!/usr/bin/env node
// Node-side smoke test for the bounded-concurrency runner
// (src/lib/concurrency.ts) shared by the Drive tag-header batch, the FX/
// vocal-clip warm-up, and the crate blob prefetch. Plain asserts, no test
// framework, mirrors check-gain.mjs.
import { runWithConcurrency, sleep } from "../src/lib/concurrency.ts";

let failures = 0;
function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- ordering: results come back in ORIGINAL item order, not completion order ---
{
  const items = [30, 5, 20, 1]; // ms delays — item 0 finishes last, item 3 finishes first
  const results = await runWithConcurrency(items, 4, async (ms, index) => {
    await delay(ms);
    return index;
  });
  assertOk(
    "runWithConcurrency: results preserve original item order despite out-of-order completion",
    results.join(",") === "0,1,2,3"
  );
}

// --- bounded concurrency: never more than `limit` workers in flight at once ---
{
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  await runWithConcurrency(items, 3, async (item) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await delay(10);
    inFlight--;
    return item;
  });
  assertOk("runWithConcurrency: never exceeds the given limit", maxInFlight <= 3);
  assertOk("runWithConcurrency: actually uses concurrency (not serialized to 1)", maxInFlight > 1);
}

// --- onItemDone fires once per item, in COMPLETION order ---
{
  const doneOrder = [];
  const items = [30, 5, 20];
  await runWithConcurrency(
    items,
    3,
    async (ms, index) => {
      await delay(ms);
      return index;
    },
    (result) => doneOrder.push(result)
  );
  assertOk("onItemDone: fires once per item", doneOrder.length === 3);
  assertOk("onItemDone: fires in completion order (fastest item first)", doneOrder[0] === 1);
}

// --- edge cases ---
assertOk("runWithConcurrency: empty items -> empty results, no worker spun up", (await runWithConcurrency([], 4, async () => 1)).length === 0);

{
  const results = await runWithConcurrency([1, 2, 3], 100, async (n) => n * 2);
  assertOk("runWithConcurrency: limit larger than item count is fine (clamped internally)", results.join(",") === "2,4,6");
}

{
  const results = await runWithConcurrency([1, 2, 3], 1, async (n) => n * 2);
  assertOk("runWithConcurrency: limit of 1 behaves like sequential processing", results.join(",") === "2,4,6");
}

// --- a rejected worker propagates (caller decides whether to catch per-item internally, same convention as page.tsx's usages, which all wrap the worker body in try/catch themselves) ---
{
  let threw = false;
  try {
    await runWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
  } catch (err) {
    threw = err.message === "boom";
  }
  assertOk("runWithConcurrency: an uncaught worker rejection propagates to the caller", threw);
}

// --- sleep (M6.2: throttle helper used to pace real network work inside a runWithConcurrency worker) ---
{
  const start = Date.now();
  await sleep(50);
  const elapsed = Date.now() - start;
  assertOk("sleep: resolves after at least the requested delay", elapsed >= 45); // small tolerance for timer jitter
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all bounded-concurrency cases");
