// Tiny bounded-concurrency runner — no deps beyond native Promises. Used
// wherever a batch of async work must run with a maximum number in flight at
// once without blocking the caller (crate tag-header fetches, FX/vocal-clip
// warm-up, crate blob prefetch) — see src/lib/crate-lazy.ts, src/lib/fx.ts's
// FxPlayer.preloadAll(), src/lib/vocal.ts's VocalPlayer.preloadAll(), and
// page.tsx's Drive-crate "Add N from Drive"/"Prefetch next 10" handlers.
// Pure control flow, no I/O of its own — see scripts/check-concurrency.mjs.

/**
 * Runs `worker` over every item in `items`, at most `limit` in flight at
 * once, and resolves with the results in ORIGINAL item order regardless of
 * completion order (a slow item 0 does not shift later results). `onItemDone`
 * (optional) fires as each item finishes, in completion order — the hook a
 * progress indicator ("Reading tags 37/264…") uses.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onItemDone?: (result: R, index: number) => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runOne(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const result = await worker(items[index], index);
      results[index] = result;
      onItemDone?.(result, index);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runOne()));
  return results;
}

/**
 * Tiny Promise-based delay — used to space out real network work inside a
 * runWithConcurrency worker (e.g. page.tsx's Drive tag-probe throttle, M6.2
 * probe-storm fix) instead of letting every one of `limit` workers fire back
 * to back with no pacing at all.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
