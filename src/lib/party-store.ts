// Craft pass #2, Part 4 — localStorage persistence for the set-arc/anthem-
// residency feature's party-length state: the timestamp autopilot was FIRST
// turned on this "party" (so a reload mid-party doesn't reset
// state.partyElapsedSeconds back to 0) and the human-selected planned party
// length (the Off/1h/2h/3h/4h selector next to the autopilot toggle). Same
// guard-and-no-op pattern as cost-store.ts/history-store.ts/crate-store.ts —
// no-ops rather than throwing when localStorage is unavailable (SSR/build-
// time import, or a check-*.mjs script importing this file under Node).
//
// Design choice, documented per the dispatch's "your call" — there is no
// explicit "end the party"/reset control in this pass (not requested): the
// start timestamp persists until a human clears it (localStorage.clear(),
// or a future reset control), so "this party" effectively means "since
// autopilot was last turned on with no stored timestamp already present" —
// toggling autopilot off and back on again does NOT reset the clock, which
// matches "since autopilot first turned on this session" read literally.
const START_MS_KEY = "djsm.party-start-ms";
const PLANNED_SECONDS_KEY = "djsm.party-planned-seconds";

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

export function loadPartyStartMs(): number | null {
  if (!hasLocalStorage()) return null;
  try {
    const raw = localStorage.getItem(START_MS_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function savePartyStartMs(startMs: number): void {
  if (!hasLocalStorage()) return;
  try {
    localStorage.setItem(START_MS_KEY, String(startMs));
  } catch {
    // Best-effort persistence — not fatal.
  }
}

export function loadPartyPlannedSeconds(): number | null {
  if (!hasLocalStorage()) return null;
  try {
    const raw = localStorage.getItem(PLANNED_SECONDS_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** `null` persists as "Off" (removes the key) rather than writing a bogus value. */
export function savePartyPlannedSeconds(seconds: number | null): void {
  if (!hasLocalStorage()) return;
  try {
    if (seconds === null) {
      localStorage.removeItem(PLANNED_SECONDS_KEY);
    } else {
      localStorage.setItem(PLANNED_SECONDS_KEY, String(seconds));
    }
  } catch {
    // Best-effort persistence — not fatal.
  }
}
