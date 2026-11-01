// Site-wide passcode gate (production-privacy addendum, 2026-07-26): Jason
// wants the deployed site private, and Vercel Authentication doesn't cover
// production domains on the Hobby plan — so the app gates itself here at
// the edge instead. No-op (pass everything through) when DJ_PASSCODE is
// unset, same convention as src/lib/passcode.ts's per-route gate, so local
// dev is unchanged. All decision logic lives in the pure
// src/lib/gatekeeper.ts (unit-checked, see scripts/check-gatekeeper.mjs) —
// this file is a thin Request/Response adapter around it.
//
// Flow: a cookie `dj_pass` matching DJ_PASSCODE lets everything through; for
// /api/* requests it also injects the `x-dj-passcode` header into the
// forwarded request so the existing per-route header gates (src/lib/passcode.ts,
// checked in each API route) pass without the client's own prompt/retry
// flow — one passcode entry at the door covers everything. No/wrong cookie
// but a matching `?pass=` query param sets the cookie (httpOnly, secure,
// 30-day) and redirects to the same URL with `pass` stripped. Otherwise a
// tiny inline-CSS password form, no external assets (they'd be gated too).
import { NextResponse, type NextRequest } from "next/server";
import { decideGate } from "@/lib/gatekeeper";

const COOKIE_NAME = "dj_pass";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function gateHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DJ Supermercado</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0a0a0a;color:#f5d742;font-family:system-ui,-apple-system,sans-serif}
  form{text-align:center;padding:2rem}
  h1{margin:0 0 .25rem;font-size:1.4rem}
  p{margin:0 0 1.5rem;color:#a88b1f;font-size:.85rem}
  input[type=password]{padding:.6rem .8rem;border-radius:.4rem;border:1px solid #333;
    background:#111;color:#fff;font-size:1rem}
  button{margin-left:.5rem;padding:.6rem 1rem;border-radius:.4rem;border:none;
    background:#f5d742;color:#111;font-weight:600;cursor:pointer}
</style>
</head>
<body>
<form method="GET">
  <h1>DJ Supermercado</h1>
  <p>no hands, puro cerebro</p>
  <input type="password" name="pass" placeholder="passcode" autofocus required />
  <button type="submit">Enter</button>
</form>
</body>
</html>`;
}

export function middleware(request: NextRequest) {
  const required = process.env.DJ_PASSCODE;
  const pathname = request.nextUrl.pathname;
  const cookie = request.cookies.get(COOKIE_NAME)?.value ?? null;
  const passParam = request.nextUrl.searchParams.get("pass");
  const passHeader = request.headers.get("x-dj-passcode");

  const decision = decideGate(required, cookie, passParam, passHeader, pathname);

  if (decision.action === "allow") {
    if (decision.injectPasscodeHeader) {
      const headers = new Headers(request.headers);
      headers.set("x-dj-passcode", required as string);
      return NextResponse.next({ request: { headers } });
    }
    return NextResponse.next();
  }

  if (decision.action === "set-cookie-and-redirect") {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.searchParams.delete("pass");
    const response = NextResponse.redirect(redirectUrl);
    response.cookies.set(COOKIE_NAME, required as string, {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      maxAge: COOKIE_MAX_AGE_SECONDS,
      path: "/",
    });
    return response;
  }

  // deny
  return new NextResponse(gateHtml(), {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
