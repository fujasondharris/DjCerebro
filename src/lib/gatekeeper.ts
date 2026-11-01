// Pure decision logic for src/middleware.ts's site-wide passcode gate
// (production-privacy addendum: Vercel Authentication doesn't cover
// production domains on the Hobby plan, so the app gates itself at the
// edge). Reuses checkPasscode (src/lib/passcode.ts) for the actual string
// comparisons so "what counts as a match" lives in exactly one place — this
// file only decides WHAT TO DO given a cookie/query-param/path, never
// touches Request/Response objects, so it's checkable without a server —
// see scripts/check-gatekeeper.mjs. middleware.ts is a thin adapter around
// this.
// Explicit .ts extension (matches transition.ts/brain.ts's convention) so
// this resolves both under Next's bundler and via Node's
// --experimental-strip-types when scripts/check-gatekeeper.mjs imports it
// directly.
import { checkPasscode } from "./passcode.ts";

export type GateDecision =
  | { action: "allow"; injectPasscodeHeader: boolean }
  | { action: "set-cookie-and-redirect" }
  | { action: "deny" };

/**
 * @param required   DJ_PASSCODE env value; unset/empty disables the gate entirely (local dev unchanged).
 * @param cookie     current `dj_pass` cookie value, or null if absent.
 * @param passParam  `?pass=` query param on the request, or null if absent.
 * @param pathname   request pathname — only used to decide whether to inject the
 *                   `x-dj-passcode` header for /api/* requests (the existing
 *                   per-route header gates stay as defense in depth).
 */
export function decideGate(
  required: string | undefined | null,
  cookie: string | null,
  passParam: string | null,
  passHeader: string | null,
  pathname: string
): GateDecision {
  if (!required) return { action: "allow", injectPasscodeHeader: false };
  const isApi = pathname.startsWith("/api");

  if (checkPasscode(required, cookie).ok) {
    return { action: "allow", injectPasscodeHeader: isApi };
  }

  if (isApi && checkPasscode(required, passHeader).ok) {
    return { action: "allow", injectPasscodeHeader: false };
  }

  if (checkPasscode(required, passParam).ok) {
    return { action: "set-cookie-and-redirect" };
  }

  return { action: "deny" };
}
