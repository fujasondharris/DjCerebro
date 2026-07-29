// Pure passcode-gate logic shared by /api/dj and both /api/crate routes
// (M5). Factored out of the route handlers so it's checkable without
// spinning up a server — see scripts/check-crate-route.mjs. No-op (always
// ok) when DJ_PASSCODE is unset, so local dev behaves exactly as before M5.
export interface PasscodeCheckResult {
  ok: boolean;
  error?: string;
}

export function checkPasscode(required: string | undefined | null, provided: string | null): PasscodeCheckResult {
  if (!required) return { ok: true };
  if (provided === required) return { ok: true };
  return { ok: false, error: "passcode required" };
}
