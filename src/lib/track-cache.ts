// On-demand full-file download + IndexedDB cache for the lazy-crate
// architecture (see CLAUDE_STATE.md's lazy-crate section). Drive crate
// entries carry only metadata (see crate-lazy.ts) until a deck or the
// autopilot queue actually needs to play one — at that point getTrackBlob()
// resolves the real audio Blob, from cache if present, over the network
// (through /api/crate/[id]) if not, storing the result so a party-night wifi
// drop doesn't kill a track that already played once.
//
// Zero deps, raw IndexedDB (no library) — one object store, keyed by track
// id, storing {id, blob, size, lastUsed}. The store is behind a small
// interface (TrackCacheStore) so the LRU-eviction and cache-or-download
// orchestration logic (the parts worth unit-testing) can be exercised with a
// plain Map in scripts/check-track-cache.mjs instead of a real IndexedDB,
// which Node doesn't have.

export interface CachedTrackEntry {
  id: string;
  blob: Blob;
  size: number;
  lastUsed: number;
}

export interface TrackCacheStore {
  get(id: string): Promise<CachedTrackEntry | null>;
  put(entry: CachedTrackEntry): Promise<void>;
  delete(id: string): Promise<void>;
  /** Metadata for every entry currently in the store — used for eviction bookkeeping and the crate list's "cached" (•) marker. Real blobs included; callers that only need size/lastUsed can ignore .blob. */
  list(): Promise<CachedTrackEntry[]>;
}

// LRU cap: whichever limit is hit first evicts. ~60 files / ~500MB is a
// deliberately conservative slice of a phone's practical IndexedDB quota
// (FACTS: iOS Safari's real-world IDB ceiling is roughly ~1GB) — leaves
// headroom for the vocal/SFX clip cache (~2MB, negligible) and whatever else
// Safari counts against the same origin quota.
export const CACHE_MAX_FILES = 60;
export const CACHE_MAX_BYTES = 500 * 1024 * 1024;

export interface CacheEntryMeta {
  id: string;
  size: number;
  lastUsed: number;
}

/**
 * Pure LRU eviction planner: given the OTHER entries already in the store
 * plus the entry about to be written (`incoming`, always exempt — it was
 * just used), returns the ids that must be evicted so the store stays
 * within `maxFiles`/`maxBytes` counting `incoming` as already present.
 * Oldest `lastUsed` evicts first. No IDB — checkable with a plain array, see
 * scripts/check-track-cache.mjs.
 */
export function planEvictions(
  existing: CacheEntryMeta[],
  incoming: CacheEntryMeta,
  maxFiles: number = CACHE_MAX_FILES,
  maxBytes: number = CACHE_MAX_BYTES
): string[] {
  const others = existing.filter((entry) => entry.id !== incoming.id);
  const oldestFirst = [...others].sort((a, b) => a.lastUsed - b.lastUsed);

  let count = others.length + 1; // +1 for incoming
  let bytes = others.reduce((sum, entry) => sum + entry.size, 0) + incoming.size;

  const toEvict: string[] = [];
  for (const entry of oldestFirst) {
    if (count <= maxFiles && bytes <= maxBytes) break;
    toEvict.push(entry.id);
    count -= 1;
    bytes -= entry.size;
  }
  return toEvict;
}

const DB_NAME = "dj-supermercado-cache";
const DB_VERSION = 1;
const STORE_NAME = "tracks";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available in this environment"));
  }
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    }).catch((err: unknown) => {
      // Self-review fix: don't cache a REJECTED open() forever — a
      // transient failure (private-browsing quota hiccup, first call before
      // some browser-specific gate clears) would otherwise permanently wall
      // off IndexedDB for the rest of the session even if a later attempt
      // would succeed. Every caller already treats a rejection as "fall
      // back to network, no cache" (see getTrackBlob), so retrying on the
      // next call is free — clear the cached promise and rethrow.
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

/** Real IndexedDB-backed TrackCacheStore. Lazily opens/creates the database on first use; every method rejects (never throws synchronously) if IndexedDB itself is unavailable, so callers can fall back to "not cached, fetch fresh" instead of crashing. */
export function createIndexedDbStore(): TrackCacheStore {
  return {
    async get(id) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const request = tx.objectStore(STORE_NAME).get(id);
        request.onsuccess = () => resolve((request.result as CachedTrackEntry | undefined) ?? null);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB get failed"));
      });
    },
    async put(entry) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB put failed"));
      });
    },
    async delete(id) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
      });
    },
    async list() {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const request = tx.objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve((request.result as CachedTrackEntry[]) ?? []);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB list failed"));
      });
    },
  };
}

let defaultStoreInstance: TrackCacheStore | null = null;
function defaultStore(): TrackCacheStore {
  if (!defaultStoreInstance) defaultStoreInstance = createIndexedDbStore();
  return defaultStoreInstance;
}

/**
 * Cache-or-download orchestrator: an IDB hit returns the cached Blob
 * (bumping its recency); a miss calls `fetchFull()` (the real network
 * download, via /api/crate/[id] with no Range — the whole file), stores the
 * result, evicts per planEvictions() if needed, and returns it.
 * `onCacheMiss`, if given, fires synchronously right before the network
 * fetch starts — page.tsx uses this to log an honest "downloading <name>…"
 * line only when it's a real cache miss, not on every call.
 */
export async function getTrackBlob(
  id: string,
  fetchFull: () => Promise<Blob>,
  opts: { store?: TrackCacheStore; onCacheMiss?: () => void; expectedSize?: number } = {}
): Promise<Blob> {
  const store = opts.store ?? defaultStore();

  try {
    const cached = await store.get(id);
    if (cached) {
      // Poisoned-cache guard (soundcheck #1 aftermath): pre-Edge-runtime,
      // Vercel's node functions streamed a 200 status and then TRUNCATED the
      // body at the ~4.5MB cap — response.ok was true, so a corrupt half-song
      // got cached and kept failing decode forever even after the server fix.
      // The Drive listing gives us the exact byte size, so a cached entry
      // that doesn't match it is evicted and re-downloaded instead of served.
      if (opts.expectedSize !== undefined && cached.blob.size !== opts.expectedSize) {
        await store.delete(id).catch(() => {});
      } else {
        void store.put({ ...cached, lastUsed: Date.now() }).catch(() => {
          // Recency bump failing is not fatal — the cached blob is still returned.
        });
        return cached.blob;
      }
    }
  } catch {
    // IDB unavailable/broken — fall through to a plain network fetch below,
    // same "best effort, never block playback" posture as id3.ts/serato.ts.
  }

  opts.onCacheMiss?.();
  const blob = await fetchFull();
  // Same guard on the fresh download: a body that doesn't match the listing's
  // byte size is a truncated/failed transfer — fail loudly, never cache it.
  if (opts.expectedSize !== undefined && blob.size !== opts.expectedSize) {
    throw new Error(
      `download incomplete: got ${blob.size} bytes, expected ${opts.expectedSize} — not caching`
    );
  }

  try {
    const existing = await store.list();
    const incoming: CacheEntryMeta = { id, size: blob.size, lastUsed: Date.now() };
    const evictIds = planEvictions(existing, incoming);
    for (const evictId of evictIds) {
      await store.delete(evictId).catch(() => {});
    }
    await store.put({ id, blob, size: blob.size, lastUsed: Date.now() });
  } catch {
    // Caching failed (quota, private browsing, IDB unavailable) — the
    // download itself still succeeded, so return the blob anyway; it just
    // won't survive a reload this time.
  }

  return blob;
}
