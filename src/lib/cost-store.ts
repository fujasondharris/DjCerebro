// localStorage-backed persistence for the M5 cost ticker's running session
// total — same defensive pattern as history-store.ts: no-ops rather than
// throwing when localStorage is unavailable (SSR/build-time import, or a
// check-*.mjs script importing this file under Node), so a reload at the
// party doesn't zero the total but a missing storage backend never crashes.
const STORAGE_KEY = "djsm.cost-total";

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

export function loadCostTotal(): number {
  if (!hasLocalStorage()) return 0;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export function saveCostTotal(total: number): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(STORAGE_KEY, String(total));
  } catch {
    // Best-effort persistence — e.g. storage quota exceeded or disabled. Not fatal.
  }
}

export function resetCostTotal(): void {
  saveCostTotal(0);
}
