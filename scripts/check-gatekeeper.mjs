#!/usr/bin/env node
// Node-side smoke test for the site-wide passcode gate's pure decision
// function (src/lib/gatekeeper.ts), backing src/middleware.ts. Plain
// asserts, no test framework, mirrors check-crate-route.mjs. No
// Request/Response objects involved — decideGate() is pure.
import { decideGate } from "../src/lib/gatekeeper.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

// --- unset DJ_PASSCODE: gate is a no-op everywhere ---

assertOk(
  "unset passcode -> allow, no header injection, even on /api/*",
  (() => {
    const d = decideGate(undefined, null, null, null, "/api/dj");
    return d.action === "allow" && d.injectPasscodeHeader === false;
  })()
);

assertOk(
  "empty-string passcode treated as unset -> allow",
  decideGate("", null, null, null, "/").action === "allow"
);

// --- matching cookie ---

assertOk(
  "matching cookie on a page route -> allow, no header injection",
  (() => {
    const d = decideGate("letmein", "letmein", null, null, "/");
    return d.action === "allow" && d.injectPasscodeHeader === false;
  })()
);

assertOk(
  "matching cookie on /api/* -> allow, WITH header injection (covers the route's own gate)",
  (() => {
    const d = decideGate("letmein", "letmein", null, null, "/api/dj");
    return d.action === "allow" && d.injectPasscodeHeader === true;
  })()
);

assertOk(
  "matching cookie takes priority over a stale/mismatched pass param",
  (() => {
    const d = decideGate("letmein", "letmein", "somethingelse", null, "/api/crate");
    return d.action === "allow" && d.injectPasscodeHeader === true;
  })()
);

// --- matching pass param (no/wrong cookie) sets the cookie + redirects ---

assertOk(
  "no cookie, matching pass param -> set-cookie-and-redirect",
  decideGate("letmein", null, "letmein", null, "/").action === "set-cookie-and-redirect"
);

assertOk(
  "wrong cookie, matching pass param -> set-cookie-and-redirect",
  decideGate("letmein", "wrong", "letmein", null, "/").action === "set-cookie-and-redirect"
);

// --- neither matches -> deny ---

assertOk("no cookie, no pass param -> deny", decideGate("letmein", null, null, null, "/").action === "deny");
assertOk("wrong cookie, no pass param -> deny", decideGate("letmein", "wrong", null, null, "/").action === "deny");
assertOk("no cookie, wrong pass param -> deny", decideGate("letmein", null, "wrong", null, "/").action === "deny");
assertOk("wrong cookie, wrong pass param -> deny", decideGate("letmein", "wrong", "wrong", null, "/").action === "deny");

assertOk("case-sensitive: cookie differing only in case -> deny", decideGate("LetMeIn", "letmein", null, null, "/").action === "deny");

assertOk(
  "matching API header on /api/* -> allow without reinjecting",
  (() => {
    const d = decideGate("letmein", null, null, "letmein", "/api/dj");
    return d.action === "allow" && d.injectPasscodeHeader === false;
  })()
);

assertOk(
  "matching API header on a page route does not unlock the shell",
  decideGate("letmein", null, null, "letmein", "/").action === "deny"
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all gatekeeper decision cases");
