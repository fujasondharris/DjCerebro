#!/usr/bin/env node
// Golden for the cutting behaviour apply-trims.mjs depends on.
//
// apply-trims stores tailSeconds as an ABSOLUTE second in the original audio and
// passes `-ss <head> -to <tail>` as INPUT options (before -i). That is only correct
// if ffmpeg treats `-to` as an absolute source timestamp rather than as a duration
// measured after the seek. Both readings appear in the wild, the semantics have
// differed across ffmpeg versions and between input/output placement, and getting it
// wrong is silent: every tail would be cut too long, and nobody would notice until
// the crate was already rebuilt.
//
// So this asserts the behaviour against a synthesised file instead of trusting the
// docs or the installed version. Run it before any batch cut.
//
// Usage: npm run check:trim-cut
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let failures = 0;
function assertOk(label, cond, detail = "") {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function duration(file) {
  return Number(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ], { encoding: "utf8" }).trim());
}

// A 60s tone: long enough that an absolute-vs-duration mistake is unmistakable.
const dir = mkdtempSync(path.join(tmpdir(), "trimcut-"));
const src = path.join(dir, "tone60.mp3");
try {
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=60",
    "-c:a", "libmp3lame", "-b:a", "128k", "-y", src,
  ]);
} catch (e) {
  console.error("could not synthesise the fixture — is ffmpeg installed with libmp3lame?");
  process.exit(1);
}

console.log(`fixture: 60s tone (${duration(src).toFixed(3)}s measured)`);

// --- the exact invocation shape apply-trims.mjs uses ---
function cut(head, tail, extra = []) {
  const out = path.join(dir, `cut-${head}-${tail}-${extra.join("") || "enc"}.mp3`);
  const a = ["-hide_banner", "-loglevel", "error", "-ss", String(head)];
  if (tail !== null) a.push("-to", String(tail));
  a.push("-i", src, ...(extra.length ? extra : ["-c:a", "libmp3lame", "-b:a", "320k"]), "-y", out);
  const r = spawnSync("ffmpeg", a, { encoding: "utf8" });
  if (r.status !== 0) return { error: (r.stderr || "").slice(-200) };
  return { out, seconds: duration(out) };
}

const near = (a, b, tol = 0.35) => Math.abs(a - b) <= tol;

// THE load-bearing assertion. head=10 tail=20 must yield 10s (absolute), never 20s.
const r1 = cut(10, 20);
assertOk(
  "-to is an ABSOLUTE source timestamp, not a duration after -ss",
  !r1.error && near(r1.seconds, 10),
  r1.error ?? `got ${r1.seconds?.toFixed(3)}s, expected ~10s (20s would mean -to is a duration)`,
);

// Head-only cut keeps everything after the head.
const r2 = cut(12, null);
assertOk("head-only cut keeps the remainder", !r2.error && near(r2.seconds, 48),
  r2.error ?? `got ${r2.seconds?.toFixed(3)}s, expected ~48s`);

// Tail-only cut (head 0) ends at the absolute tail position.
const r3 = cut(0, 25);
assertOk("tail-only cut ends at the absolute tail second", !r3.error && near(r3.seconds, 25),
  r3.error ?? `got ${r3.seconds?.toFixed(3)}s, expected ~25s`);

// A non-integer head, as produced by downbeat snapping (e.g. Un Beso's 27.424s).
const r4 = cut(27.424, 45);
assertOk("fractional downbeat-snapped head is honoured", !r4.error && near(r4.seconds, 17.576),
  r4.error ?? `got ${r4.seconds?.toFixed(3)}s, expected ~17.576s`);

// Stream-copy mode (--copy) must obey the same absolute semantics, even though its
// accuracy is limited to frame boundaries.
const r5 = cut(10, 20, ["-c", "copy"]);
assertOk("stream-copy mode uses the same absolute -to semantics",
  !r5.error && near(r5.seconds, 10, 0.6),
  r5.error ?? `got ${r5.seconds?.toFixed(3)}s, expected ~10s`);

// The re-encode path should be tighter than stream-copy, which is the stated reason
// re-encode is the default. Not a hard bound — just that it is not WORSE.
if (!r1.error && !r5.error) {
  assertOk("re-encode is at least as accurate as stream-copy",
    Math.abs(r1.seconds - 10) <= Math.abs(r5.seconds - 10) + 0.05,
    `reencode off by ${Math.abs(r1.seconds - 10).toFixed(3)}s, copy off by ${Math.abs(r5.seconds - 10).toFixed(3)}s`);
}

rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed — DO NOT run a batch cut until this passes.`);
  process.exit(1);
}
console.log("\nPASS: cut semantics are absolute; apply-trims offsets are correct");
