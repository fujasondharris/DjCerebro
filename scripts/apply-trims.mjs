#!/usr/bin/env node
// M8.1d — apply APPROVED trims to audio. This is the first script in M8 that
// writes audio, so it is built to be reversible by construction.
//
// SAFETY INVARIANTS (all four are load-bearing — do not relax without a review):
//  1. ORIGINALS ARE NEVER MUTATED. Output goes to a separate tree (TRIMMED_DIR).
//     ~/Music/dj-crate is read-only to this script. That single choice is what
//     makes an otherwise one-way operation undoable: if a cut is wrong, delete the
//     output tree and rerun. Nothing is ever cut "in place".
//  2. ONLY `approved: true` ENTRIES ARE CUT. Auto-approval covers provable digital
//     silence only; everything else is an owner decision made in the review page.
//     An unapproved entry is skipped, loudly.
//  3. SOURCE AND EVERY STEM ARE CUT BY IDENTICAL OFFSETS. If the mix were trimmed
//     but its stems were not (or by a different amount), every stem would be
//     desynced from its own track — a corruption that would not surface until
//     playback, long after the originals were gone.
//  4. DRY RUN IS THE DEFAULT. Writing requires an explicit --apply.
//
// RE-ENCODE vs STREAM-COPY (--copy)
// Default is a sample-accurate re-encode at 320k. An mp3 stream-copy can only cut
// on a frame boundary (~26 ms at 44.1 kHz), which would land the cut up to ~26 ms
// off the downbeat that make-trim-plan carefully snapped to — about 4% of a beat at
// 96 BPM. These files are already lossy YouTube rips, so one more generation at
// 320k is a smaller cost than a downbeat that is audibly late. --copy is offered
// for anyone who disagrees; it is not the default.
//
// The applied offsets are written to trim-applied.json. That file is what lets
// loop-points / vocal-maps / cue-suggestions be SHIFTED rather than regenerated.
//
// Usage:
//   npm run trims:apply                # dry run — prints what it would do
//   npm run trims:apply -- --apply     # actually writes
//   npm run trims:apply -- --apply --copy
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAN = path.join(REPO_ROOT, "src", "data", "trim-plan.json");
const APPLIED = path.join(REPO_ROOT, "src", "data", "trim-applied.json");
const CRATE_DIR = process.env.CRATE_DIR || path.join(os.homedir(), "Music", "dj-crate");
const STEMS_DIR = process.env.STEMS_DIR || path.join(os.homedir(), "dj-tools", "stems-out");
const TRIMMED_DIR = process.env.TRIMMED_DIR || path.join(os.homedir(), "Music", "dj-crate-trimmed");
const TRIMMED_STEMS = process.env.TRIMMED_STEMS || path.join(os.homedir(), "dj-tools", "stems-trimmed");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
// --only=<id prefix>: restrict to a slice of the plan, e.g. --only=local: for batch 2.
// The 148 batch-1 entries are keyed by OLD Drive ids that no longer join to the (v2)
// stem manifest, so an unfiltered run would re-cut their mixes without stems.
const ONLY = args.find((a) => a.startsWith("--only="))?.slice(7) ?? "";
const COPY = args.includes("--copy");

// Invariant 1 needs CONTAINMENT, not equality. An equality-only check passes for
// TRIMMED_DIR=<CRATE_DIR>/out, which writes inside the originals tree — flagged by
// the local choir (qwen2.5-coder), and correctly: the stated invariant is "originals
// are never mutated", and a check that only catches the exact-same-path case does not
// enforce it. Checked both directions, with a separator so a sibling directory named
// like a prefix (dj-crate-trimmed vs dj-crate) is NOT falsely rejected.
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  // `rel.startsWith("..")` is WRONG and was a real bypass: a child directory literally
  // named "..trimmed" produces rel="..trimmed", which starts with ".." and would be
  // misread as outside the parent while sitting squarely inside it. Only an exact ".."
  // or a ".." followed by a separator means "walked upward".
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return !(rel === ".." || rel.startsWith(".." + path.sep));
}

// Resolve SYMLINKS, not just path text. path.resolve() is purely lexical, so an output
// path that is a symlink pointing into the crate passes a textual overlap test while
// every write still lands inside the originals. Canonicalise the nearest existing
// ancestor (the leaf usually does not exist yet on a first run).
function realOf(p) {
  let cur = path.resolve(p);
  for (;;) {
    try { return path.join(realpathSync(cur), path.relative(cur, path.resolve(p))); }
    catch { /* not created yet — walk up */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    cur = parent;
  }
}

for (const [label, dir] of [["TRIMMED_DIR", TRIMMED_DIR], ["TRIMMED_STEMS", TRIMMED_STEMS]]) {
  if (isInside(realOf(dir), realOf(CRATE_DIR)) ||
      isInside(realOf(CRATE_DIR), realOf(dir))) {
    console.error(
      `REFUSING: ${label} (${dir}) overlaps CRATE_DIR (${CRATE_DIR}).\n` +
      "Originals must never be written into. Choose an output path outside the crate.",
    );
    process.exit(1);
  }
}
if (!existsSync(PLAN)) {
  console.error("No trim-plan.json — run make:trim-plan first.");
  process.exit(1);
}

const plan = JSON.parse(readFileSync(PLAN, "utf8"));
const readJson = (f, dflt) => existsSync(path.join(REPO_ROOT, "src", "data", f))
  ? JSON.parse(readFileSync(path.join(REPO_ROOT, "src", "data", f), "utf8")) : dflt;
// batch-2 (local:<name>) stems live in a sibling manifest — see register-local-tracks.mjs
const stemManifest = { ...readJson("stem-manifest.json", {}), ...readJson("stem-manifest-batch2.json", {}) };
const applied = existsSync(APPLIED) ? JSON.parse(readFileSync(APPLIED, "utf8")) : {};

/** Duration in seconds, or null if unreadable (callers must not treat null as valid). */
function probeDuration(file) {
  const r = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  const v = Number((r.stdout || "").trim());
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Join a manifest-supplied name onto a base directory, refusing anything that escapes.
 *
 * Track names come from crate-manifest.json (originally Drive listings), and the
 * directory guards above only vet the BASE directories — they do nothing about the
 * per-file component. A name containing "../" turns
 * path.join(TRIMMED_DIR, name) into a path back inside the crate, where ffmpeg's -y
 * would overwrite an original. Flagged by the local choir (deepseek-r1) and confirmed:
 * join("~/Music/dj-crate-trimmed", "../dj-crate/Gasolina.mp3") resolves to
 * "~/Music/dj-crate/Gasolina.mp3".
 *
 * Data is not trust. Returns null if the name escapes its base.
 */
function safeJoin(base, name) {
  const full = path.resolve(base, name);
  const rel = path.relative(path.resolve(base), full);
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    return null;
  }
  return full;
}

/** Run one ffmpeg cut. Returns null on success, else an error string. */
function runCut(src, dst, headSeconds, tailSeconds) {
  mkdirSync(path.dirname(dst), { recursive: true });
  const a = ["-hide_banner", "-y", "-ss", String(headSeconds)];
  if (tailSeconds !== null && tailSeconds !== undefined) {
    a.push("-to", String(tailSeconds));
  }
  a.push("-i", src);
  // -ss/-to before -i are input-relative, so the cut is applied while decoding.
  a.push(...(COPY ? ["-c", "copy"] : ["-c:a", "libmp3lame", "-b:a", "320k"]));
  a.push("-map_metadata", "0", dst);
  const r = spawnSync("ffmpeg", a, { encoding: "utf8" });
  if (r.error) return String(r.error);
  if (r.status !== 0) return (r.stderr || "").slice(-300);
  if (!existsSync(dst) || statSync(dst).size === 0) return "produced an empty file";
  return null;
}

/**
 * Cut, with one retry that stops just short of the source's end.
 *
 * Some rips carry a malformed final frame or two. libmp3lame then fails while
 * FLUSHING rather than while encoding — "3 frames left in the queue on closing,
 * Conversion failed!" — after having already written essentially the whole file.
 * Observed on "LA MuDANZA" (both crate entries): ffmpeg exited 234 with output
 * 176.757s against an expected 176.844s, i.e. ~87 ms / 3 frames short.
 *
 * The retry re-runs with -to clamped to just inside the measured source duration,
 * which skips the bad tail frames and exits 0. Deliberately a RETRY and not a
 * blanket "accept non-zero exit if the duration looks close": treating a failed
 * conversion as success is the silent-accept pattern this script exists to avoid.
 * The result is still duration-checked by the caller like any other cut.
 */
const RETRY_TAIL_MARGIN_S = 0.15;
function cut(src, dst, headSeconds, tailSeconds) {
  const first = runCut(src, dst, headSeconds, tailSeconds);
  if (first === null) return null;
  const srcDur = probeDuration(src);
  if (srcDur === null) return first;
  const clamped = Number((srcDur - RETRY_TAIL_MARGIN_S).toFixed(3));
  // Only worth retrying if this actually shortens what we asked for.
  if (clamped <= headSeconds) return first;
  if (tailSeconds !== null && tailSeconds !== undefined && tailSeconds <= clamped) return first;
  const second = runCut(src, dst, headSeconds, clamped);
  return second === null ? null : `${first} | retry with clamped tail also failed: ${second}`;
}

const scoped = Object.entries(plan).filter(([id]) => id.startsWith(ONLY));
const pending = scoped.filter(([, c]) => c.approved);
const unapproved = scoped.filter(([, c]) => !c.approved);

console.log(
  `${APPLY ? "APPLYING" : "DRY RUN"} — approved=${pending.length} unapproved(skipped)=${unapproved.length}` +
  `\n  originals (read-only): ${CRATE_DIR}` +
  `\n  output:                ${TRIMMED_DIR}` +
  `\n  stems output:          ${TRIMMED_STEMS}` +
  `\n  mode:                  ${COPY ? "stream-copy (frame-boundary accurate only)" : "re-encode 320k (sample accurate)"}\n`,
);

let ok = 0, failed = 0, skipped = 0;
for (const [id, c] of pending) {
  const src = path.join(CRATE_DIR, c.name);
  if (!existsSync(src)) {
    failed++;
    console.warn(`  MISSING SOURCE: ${c.name.slice(0, 58)}`);
    continue;
  }

  // Invariant 3 is "the mix AND EVERY stem", so a stem listed in the manifest but
  // absent on disk is a FAILURE, not something to quietly leave out. Omitting it
  // would record the track as applied while its stem set is incomplete — and the
  // skip-if-applied check below would then stop it ever being regenerated.
  const mixOut = safeJoin(TRIMMED_DIR, c.name);
  if (!mixOut) {
    failed++;
    console.error(`  REFUSING (name escapes the output tree): ${c.name.slice(0, 56)}`);
    continue;
  }
  const targets = [[src, mixOut]];
  const missingStems = [];
  for (const [stem, rel] of Object.entries(stemManifest[id]?.stems ?? {})) {
    const s = path.join(STEMS_DIR, rel);
    const stemOut = safeJoin(TRIMMED_STEMS, rel);
    if (!stemOut) {
      missingStems.push(`${stem} (path escapes output tree)`);
    } else if (existsSync(s)) {
      targets.push([s, stemOut]);
    } else {
      missingStems.push(stem);
    }
  }
  if (missingStems.length) {
    failed++;
    console.error(`  MISSING STEM(S) [${missingStems.join(", ")}] — refusing partial cut: ${c.name.slice(0, 40)}`);
    continue;
  }

  // Skip only if this exact cut was already produced AND its outputs still exist.
  // Checking the record alone would break the documented "delete the output tree to
  // undo" recovery (rerun would skip everything and produce no audio), and would
  // leave stale output after an approved trim is edited.
  const prevRun = applied[id];
  const sameCut = prevRun
    && prevRun.headSeconds === c.headSeconds
    && prevRun.tailSeconds === c.tailSeconds
    && prevRun.mode === (COPY ? "stream-copy" : "reencode-320k");
  // A non-empty file is NOT proof of a complete cut. An interrupted write (or a
  // killed ffmpeg) leaves a truncated but non-zero mp3, which a size check happily
  // accepts — and because the entry is then treated as done, it would stay truncated
  // forever. Verify the DURATION matches what the plan says it should be.
  // (Flagged by the local choir; the size-only check was the residual gap behind its
  // "partial failure recorded as success" finding.)
  const outputsPresent = targets.every(([, to]) => {
    if (!existsSync(to) || statSync(to).size === 0) return false;
    const d = probeDuration(to);
    return d !== null && Math.abs(d - c.newDuration) <= 1.0;
  });
  if (sameCut && outputsPresent) { skipped++; continue; }
  if (prevRun && !sameCut) {
    console.log(`  re-cutting (plan or mode changed since ${prevRun.appliedAt}): ${c.name.slice(0, 40)}`);
  } else if (prevRun && !outputsPresent) {
    console.log(`  re-cutting (output missing — recovery rerun): ${c.name.slice(0, 40)}`);
  }

  if (!APPLY) {
    console.log(
      `  would cut head=${c.headSeconds}s tail=${c.tailSeconds ?? "end"}  ` +
      `${targets.length} file(s) (1 mix + ${targets.length - 1} stems)  ${c.name.slice(0, 42)}`,
    );
    continue;
  }

  // Invariant 3: the mix and every stem get the SAME offsets, or nothing is kept.
  const errors = [];
  for (const [from, to] of targets) {
    const err = cut(from, to, c.headSeconds, c.tailSeconds);
    if (err) errors.push(`${path.basename(to)}: ${err}`);
  }
  if (errors.length) {
    failed++;
    console.error(`  FAILED (${errors.length}/${targets.length}) ${c.name.slice(0, 42)}\n     ${errors[0]}`);
    continue;
  }

  // ffmpeg exiting 0 is not proof the file is whole. Verify every output actually
  // has the duration the plan called for BEFORE recording success — a track recorded
  // as applied is skipped on every future run, so a wrong record is permanent.
  const badDurations = targets
    .map(([, to]) => [to, probeDuration(to)])
    .filter(([, d]) => d === null || Math.abs(d - c.newDuration) > 1.0);
  if (badDurations.length) {
    failed++;
    const [file, d] = badDurations[0];
    console.error(
      `  FAILED duration check (${badDurations.length}/${targets.length}) ${c.name.slice(0, 40)}` +
      `\n     ${path.basename(file)}: got ${d === null ? "unreadable" : d.toFixed(2) + "s"}, expected ${c.newDuration}s`,
    );
    continue;
  }

  applied[id] = {
    name: c.name,
    headSeconds: c.headSeconds,
    tailSeconds: c.tailSeconds,
    newDuration: c.newDuration,
    // pre-cut grid (from the plan): shiftGrid(sourceGrid, headSeconds) needs no git ref
    ...(c.sourceGrid !== undefined ? { sourceGrid: c.sourceGrid } : {}),
    mode: COPY ? "stream-copy" : "reencode-320k",
    files: targets.length,
    appliedAt: new Date().toISOString(),
  };
  writeFileSync(APPLIED, JSON.stringify(applied, null, 2));
  ok++;
  console.log(`  ${ok} cut  head=${c.headSeconds}s  ${targets.length} files  ${c.name.slice(0, 42)}`);
}

console.log(
  `\n${APPLY ? `cut=${ok}` : "dry run — nothing written"} failed=${failed} alreadyDone=${skipped}` +
  (unapproved.length ? `\n${unapproved.length} entr${unapproved.length === 1 ? "y" : "ies"} NOT approved — run make:trim-review and approve them first.` : "") +
  (APPLY ? `\napplied offsets: ${APPLIED}  (feeds the loop-points/vocal-maps/cue-suggestions shift)` : "") +
  `\nOriginals untouched at ${CRATE_DIR} — delete ${TRIMMED_DIR} to undo everything.`,
);
