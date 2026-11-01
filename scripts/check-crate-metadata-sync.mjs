// Exercise the actual route with an in-memory Blob service, not the owner's
// live store. No secrets, cloud writes or paid calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { checkPasscode } from "../src/lib/passcode.ts";
import { parseGenreOverride } from "../src/lib/crate-metadata-sync.ts";
const manifest = JSON.parse(readFileSync(new URL("../src/data/crate-manifest.json", import.meta.url)));
const rows = new Map(); let calls = 0, failWrite = false;
const blob = {
  list: async ({ prefix }) => { calls++; return { hasMore: false, blobs: Array.from(rows.keys()).filter(p => p.startsWith(prefix)).map(pathname => ({ pathname })) }; },
  get: async (path, options) => { calls++; assert.equal(options.useCache, false); return rows.has(path) ? { stream: new Response(rows.get(path)).body } : null; },
  put: async (path, text, options) => { calls++; assert.equal(options.access, "private"); assert.ok(path.startsWith("crate-metadata/v1/")); if (failWrite) throw new Error("test outage"); rows.set(path, text); },
};
const exports = {};
const env = { DJ_PASSCODE: "isolated-test-only", BLOB_READ_WRITE_TOKEN: "mock-only" };
const code = ts.transpileModule(readFileSync(new URL("../src/app/api/crate-metadata/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
vm.runInNewContext(code, { exports, process: { env }, Response, Request, console, require: name => ({
  "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
  "@vercel/blob": blob, "@/lib/passcode": { checkPasscode }, "@/lib/crate-metadata-sync": { parseGenreOverride },
  "@/data/crate-manifest.json": manifest,
})[name] });
const req = (method = "GET", body, authenticated = true) => new Request("http://test/api/crate-metadata", {
  method, headers: authenticated ? { "x-dj-passcode": env.DJ_PASSCODE } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
assert.equal((await exports.GET(req("GET", undefined, false))).status, 401);
assert.equal((await exports.POST(req("POST", {}, false))).status, 401);
assert.equal(calls, 0);
assert.deepEqual((await (await exports.GET(req())).json()).overrides, []);
assert.equal((await exports.POST(req("POST", { id: "../lesson-ledger", genre: "Salsa" }))).status, 400);
const corrections = manifest.slice(0, 2).map((t, n) => ({ id: t.id, genre: n ? "Bachata" : "Reggaeton" }));
await Promise.all(corrections.map(async c => assert.equal((await exports.POST(req("POST", c))).status, 200)));
let result = await exports.GET(req());
assert.equal(result.headers.get("cache-control"), "no-store");
const saved = (await result.json()).overrides;
assert.equal(saved.length, 2, "concurrent different-song edits cannot erase each other");
for (const c of corrections) assert.equal(saved.find(s => s.id === c.id).genre, c.genre);
assert.equal((await exports.POST(req("POST", { ...corrections[0], genre: "" }))).status, 200);
failWrite = true;
assert.equal((await exports.POST(req("POST", { ...corrections[0], genre: "Not saved" }))).status, 502);
assert.equal((await (await exports.GET(req())).json()).overrides.find(s => s.id === corrections[0].id).genre, "");
env.BLOB_READ_WRITE_TOKEN = "";
assert.equal((await exports.GET(req())).status, 503);
console.log("PASS: actual shared-genre route auth, validation, concurrent independent writes, fresh-device reads, clear, failed-write integrity, missing storage");
