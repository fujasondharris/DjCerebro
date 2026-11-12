#!/usr/bin/env node
// M8.1b — propose head/tail trims for YouTube-ripped crate tracks.
//
// THE PROBLEM (owner, 2026-08-15): these tracks came off YouTube music videos, so
// many carry non-musical video content at the head or tail — dialogue, skits, a
// guy talking on the phone. His words: "a 44 second pause in music because the
// transition is showing some guy talking on the phone in the video is a party
// killer." Measured against the 25 files he trimmed by hand, the cuts are real and
// large (Tití Me Preguntó 290s -> 244s, a 46-second head).
//
// WHY THE INSTRUMENTAL BED IS THE DETECTOR (and why drums alone is WRONG)
// This is NOT a silence problem — dialogue is not silent, and a generic RMS gate
// on the full mix cannot tell "man talking" from "quiet intro". Separation gives
// us the answer: spoken video content is VOCALS ONLY, with every instrumental
// stem genuinely empty.
//
// The first version of this script used the drums stem alone and it was WRONG.
// Validated against 25 hand-trimmed reference files: on "Dile Al Amor" it proposed
// cutting 16.1s of head that had deliberately been kept. Measuring that region per
// stem showed drums -85.5 dB and bass -91.0 dB (silent) but GUITAR -32.6 dB, the
// same level as the body — a guitar-and-vocal intro, which is how bachata
// routinely opens before the percussion enters. A drums-only detector amputates
// the intro of every song that starts on guitar or piano.
//
// So the music test is "is ANY instrumental stem active" — drums, bass, other,
// guitar, piano mixed together — and vocals are deliberately EXCLUDED from the
// detector, because vocals are exactly what dialogue looks like. All of these
// stems already exist from make-stems.mjs, so detection costs one extra probe.
//
// The tail half of the original approach validated cleanly and is unchanged in
// spirit: on the same track it landed at 234.807s against his hand-trimmed
// 234.9s — 0.1s apart.
//
// CUTS ARE SNAPPED TO A DOWNBEAT. A trim landing mid-bar leaves a fractional bar at
// the top of the track, which puts every bar-relative move in the engine off by a
// fraction forever after. We floor to the last downbeat at or before the detected
// music start (using the real Serato grid from crate-manifest.json), so at worst a
// track keeps up to one bar of lead-in — never clips its own first downbeat.
//
// THE OFFSET IS THE POINT. Every time-based data file we already have
// (loop-points.json, vocal-maps.json, cue-suggestions.json) stores absolute
// seconds against the UNTRIMMED audio. Recording headSeconds per track means that
// data can be SHIFTED rather than regenerated after trimming. If we trimmed without
// recording offsets, all of it would have to be rebuilt from scratch. That is the
// whole reason this is a plan file and not an in-place edit.
//
// PROPOSES ONLY — writes no audio. Review the plan (make-trim-review.py builds a
// listening page), then apply-trims.mjs performs the cuts.
//
// Usage: node --experimental-strip-types --no-warnings scripts/make-trim-plan.mjs
// Env: STEMS_DIR (default ~/dj-tools/stems-out), CRATE_DIR (default ~/Music/dj-crate)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CRATE_MANIFEST = path.join(REPO_ROOT, "src", "data", "crate-manifest.json");
const STEM_MANIFEST = path.join(REPO_ROOT, "src", "data", "stem-manifest.json");
const OUT_PATH = path.join(REPO_ROOT, "src", "data", "trim-plan.json");
const STEMS_DIR = process.env.STEMS_DIR || path.join(os.homedir(), "dj-tools", "stems-out");

// Drums below this for at least MIN_GAP_S is "no music happening". Deliberately low:
// a quiet intro groove must NOT read as dialogue. Pilot drums stems averaged
// -23 dB mean with 7% silence, so real drumming sits far above this.
const SILENCE_DB = -48;
const MIN_GAP_S = 2.0;
// Ignore a proposed head cut smaller than this — not worth the churn, and it risks
// shaving a genuine pickup/anacrusis before the first downbeat.
const MIN_HEAD_S = 3.0;
const MIN_TAIL_S = 3.0;

function duration(file) {
  try {
    return Number(execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", file,
    ], { encoding: "utf8" }).trim());
  } catch {
    return 0;
  }
}

/**
 * Silent [start,end] spans in the INSTRUMENTAL BED — every stem except vocals,
 * summed. Vocals are excluded on purpose: dialogue is vocals-only, so including
 * them would make a talking intro look like music. Takes the stem file list so a
 * track missing guitar/piano (dropped as blank by make-stems) still works.
 */
function silenceSpans(files) {
  const inputs = files.flatMap((f) => ["-i", f]);
  const mix = files.length > 1
    ? `amix=inputs=${files.length}:duration=longest:normalize=0,silencedetect=noise=${SILENCE_DB}dB:d=${MIN_GAP_S}`
    : `silencedetect=noise=${SILENCE_DB}dB:d=${MIN_GAP_S}`;
  const res = spawnSync("ffmpeg", [
    "-hide_banner", ...inputs,
    "-filter_complex", mix,
    "-f", "null", "-",
  ], { encoding: "utf8" });
  // A failed probe MUST NOT look like "no silence found" — that would classify the
  // track as already-clean and silently drop a needed trim. Return null so the
  // caller can distinguish failure from a genuinely clean track.
  if (res.error || res.status !== 0) return null;
  const err = res.stderr || "";
  const spans = [];
  let open = null;
  for (const line of err.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (s) open = Number(s[1]);
    if (e && open !== null) {
      spans.push([Math.max(0, open), Number(e[1])]);
      open = null;
    }
  }
  if (open !== null) spans.push([Math.max(0, open), Infinity]);
  return spans;
}

/**
 * Mean dBFS of one stem over [from, from+len). Returns null if unmeasurable —
 * callers must treat null as "unknown", never as "silent".
 */
function meanDbOver(file, from, len) {
  const res = spawnSync("ffmpeg", [
    "-hide_banner", "-ss", String(from), "-t", String(len),
    "-i", file, "-af", "volumedetect", "-f", "null", "-",
  ], { encoding: "utf8" });
  if (res.error || res.status !== 0) return null;
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(res.stderr || "");
  return m ? Number(m[1]) : null;
}

/**
 * Classify what is actually inside a proposed cut, so we only spend the owner's
 * attention on real judgment calls:
 *   "silence"     — every stem at digital-silence level. Unambiguous junk from the
 *                   rip (Dile Al Amor opens with 10.26s of it). Auto-approved.
 *   "vocals-only" — speech with no instrumental bed: the "guy talking on the phone"
 *                   case, but ALSO an artistic spoken intro (Aventura do this a
 *                   lot). Cutting it is taste, so this always needs a human.
 *   "has-music"   — an instrumental stem is audible in the cut region. Suspicious:
 *                   the detector may be over-reaching. Always needs a human.
 */
const SILENT_DB = -70;
const AUDIBLE_DB = -55;

// TONAL ONSET — the fix for crowd/ambience intros (owner, 2026-08-15: "they're music
// videos so they have crowds or sounds from the video, and if you're just looking at
// silence you'll confuse those things with music").
//
// Silence detection cannot see this: a crowd is not silent, and the separator smears
// it across every stem so the instrumental bed reads as active. Measured on labelled
// regions (~/dj-tools/test-crowd-signal.py):
//     tonal (loudest of bass/guitar/piano)   MUSIC -30.6..-24.8   CROWD -50.4..-39.1
//     spectral entropy                       MUSIC  0.73..0.86    CROWD  0.46..0.60
// Both separate cleanly; stem-spread and flat-factor do not. `tonal` leads because it
// has an obvious physical meaning — a crowd produces no bass line and no guitar part.
// (Note: entropy runs LOWER for crowd than music, the opposite of the naive
// noise-is-high-entropy guess. Used empirically; the mechanism is not established.)
//
// CAVEAT: an a-cappella or vocals-only intro is real music with no tonal content, so
// it will read as non-musical here. That is why nothing but provable digital silence
// is ever auto-approved — vocals-only cuts always go to a human.
const TONAL_DB = -35;
const TONAL_STEMS = ["bass", "guitar", "piano"];
const TONAL_SCAN_S = 60;   // only the head matters; scanning whole tracks is wasteful
const TONAL_STEP_S = 2;
const TONAL_SUSTAIN_S = 4; // must hold this long — ignores one-off video stingers

/**
 * First time pitched content sustains above TONAL_DB, i.e. where the MUSIC starts.
 * Returns null if it never does within the scan window (caller falls back to the
 * silence-based boundary rather than inventing a cut).
 */
function tonalOnset(entryStems, duration) {
  const files = TONAL_STEMS
    .map((s) => entryStems[s] && path.join(STEMS_DIR, entryStems[s]))
    .filter((f) => f && existsSync(f));
  if (!files.length) return null;

  const limit = Math.min(TONAL_SCAN_S, duration);
  let runStart = null;
  for (let t = 0; t + TONAL_STEP_S <= limit; t += TONAL_STEP_S) {
    let loudest = -Infinity;
    for (const f of files) {
      const v = meanDbOver(f, t, TONAL_STEP_S);
      if (v !== null && v > loudest) loudest = v;
    }
    if (loudest >= TONAL_DB) {
      if (runStart === null) runStart = t;
      if (t + TONAL_STEP_S - runStart >= TONAL_SUSTAIN_S) return runStart;
    } else {
      runStart = null;
    }
  }
  return null;
}
function classifyRegion(entryStems, from, len) {
  if (len <= 0.2) return { kind: "none", levels: {} };
  const levels = {};
  for (const [stem, rel] of Object.entries(entryStems)) {
    const f = path.join(STEMS_DIR, rel);
    if (existsSync(f)) levels[stem] = meanDbOver(f, from, len);
  }
  const vals = Object.entries(levels).filter(([, v]) => v !== null);
  if (!vals.length) return { kind: "unknown", levels };
  const bed = vals.filter(([s]) => s !== "vocals");
  const vox = levels.vocals;
  if (vals.every(([, v]) => v < SILENT_DB)) return { kind: "silence", levels };
  if (bed.every(([, v]) => v < SILENT_DB) && vox !== null && vox > AUDIBLE_DB) {
    return { kind: "vocals-only", levels };
  }
  // Audible, but no pitched content — a crowd, room ambience, or video sound effects.
  // Distinguished from "has-music" purely by the tonal stems, which is the signal that
  // separated cleanly on the labelled set. Always needs an ear: the boundary between
  // "crowd noise before the song" and "the live intro IS the song" is taste.
  const tonal = TONAL_STEMS
    .map((s) => levels[s])
    .filter((v) => v !== null && v !== undefined);
  const loudestTonal = tonal.length ? Math.max(...tonal) : null;
  if (bed.some(([, v]) => v > AUDIBLE_DB) && loudestTonal !== null && loudestTonal < TONAL_DB) {
    return { kind: "crowd-or-ambience", levels, loudestTonal };
  }
  if (bed.some(([, v]) => v > AUDIBLE_DB)) return { kind: "has-music", levels, loudestTonal };
  return { kind: "quiet", levels, loudestTonal };
}

/** Last downbeat at or before t, from the real Serato grid. Never returns > t. */
function floorToDownbeat(t, grid) {
  if (!grid || !grid.bpm || grid.bpm <= 0) return null;
  const anchor = typeof grid.anchor === "number" ? grid.anchor : 0;
  const bar = (60 / grid.bpm) * 4;
  if (!Number.isFinite(bar) || bar <= 0) return null;
  const n = Math.floor((t - anchor) / bar);
  const snapped = anchor + n * bar;
  return snapped >= 0 && snapped <= t ? Number(snapped.toFixed(3)) : null;
}

// Batch 2 (register-local-tracks.mjs): local-only tracks keyed `local:<name>`, kept in
// sibling manifests so the live 342-track app data is never altered. Merged in here.
const B2_CRATE = path.join(REPO_ROOT, "src", "data", "crate-manifest-batch2.json");
const B2_STEMS = path.join(REPO_ROOT, "src", "data", "stem-manifest-batch2.json");
const crate = [
  ...JSON.parse(readFileSync(CRATE_MANIFEST, "utf8")),
  ...(existsSync(B2_CRATE) ? JSON.parse(readFileSync(B2_CRATE, "utf8")) : []),
];
if (!existsSync(STEM_MANIFEST)) {
  console.error("No stem-manifest.json yet — run make:stems first (drums stem is the detector).");
  process.exit(1);
}
const stemManifest = {
  ...JSON.parse(readFileSync(STEM_MANIFEST, "utf8")),
  ...(existsSync(B2_STEMS) ? JSON.parse(readFileSync(B2_STEMS, "utf8")) : {}),
};
const byId = new Map(crate.map((t) => [t.id, t]));

// Carry forward any existing plan. Reruns are normal (the stem batch fills in over
// hours), and this file holds HUMAN decisions — `approved`, plus any hand-nudged
// cut points. Rebuilding it from scratch each run would throw those away.
const prev = existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, "utf8")) : {};
const plan = { ...prev };
let analysed = 0, proposed = 0, noGrid = 0, clean = 0, failed = 0, kept = 0;

for (const [id, entry] of Object.entries(stemManifest)) {
  // Instrumental bed = every kept stem EXCEPT vocals (see header).
  const bed = Object.entries(entry.stems ?? {})
    .filter(([stem]) => stem !== "vocals")
    .map(([, rel]) => path.join(STEMS_DIR, rel))
    .filter((f) => existsSync(f));
  if (!bed.length) continue;

  const track = byId.get(id);
  const dur = duration(bed[0]);
  if (!dur) {
    // Same rule as a failed silence probe: unmeasurable is NOT clean. Count it,
    // say so, and leave any prior plan entry untouched.
    failed++;
    console.warn(`  DURATION PROBE FAILED (kept prior plan entry, if any): ${(track?.name ?? id).slice(0, 50)}`);
    continue;
  }
  analysed++;

  // Human decisions are permanent; AUTO decisions are not. When the detector improves
  // (as it did when crowd/ambience heads were discovered), previously auto-approved
  // entries must be re-derived — otherwise a track auto-approved under the old, weaker
  // rules keeps a verdict the current rules would reject, and silently ships wrong.
  if (prev[id]?.approved && String(prev[id].approvedBy ?? "").startsWith("owner")) {
    kept++;
    continue;
  }

  const spans = silenceSpans(bed);
  if (spans === null) {
    failed++;
    console.warn(`  PROBE FAILED (kept prior plan entry, if any): ${(track?.name ?? id).slice(0, 58)}`);
    continue;
  }
  // Head: a silent span that starts at (or effectively at) 0 — its end is music-in.
  let musicIn = 0;
  const head = spans.find(([s]) => s <= 0.5);
  if (head && Number.isFinite(head[1])) musicIn = head[1];

  // A crowd/ambience intro is NOT silent, so the span test above stops too early on
  // it (Un Beso: silence ended at 4.4s, but the guitar — the actual music — did not
  // start until 28s). Where pitched content starts later than the silence boundary,
  // the gap between them is video noise and the tonal onset is the real music start.
  //
  // IMPORTANT — the tonal onset FLAGS the class, it does NOT set the cut point.
  // Measured by ear on Un Beso (true music start 28.0s, downbeat 27.424s):
  //     TONAL_DB = -35  ->  17.84s  (undershoots ~10s: a bass thump inside the crowd
  //                                  noise reads -34.3 dB at 18s and trips it)
  //     TONAL_DB = -30  ->  35.09s  (overshoots ~7s, past the guitar entry)
  // Neither is close enough to cut on, and tuning the constant against a single track
  // is overfitting. What IS reliable is the DISTINCTION: tonal content is absent, so
  // the region is a crowd/ambience/video head rather than music.
  //
  // So we keep the conservative silence-based head (which errs toward keeping audio)
  // and record the tonal estimate as a HINT for the review page. The owner sets the
  // real point with --set-head. Cutting too little is recoverable by ear; cutting into
  // the first bar of a song is not.
  const tonalAt = tonalOnset(entry.stems ?? {}, dur);
  const musicInSource = "silence";
  const tonalHint = tonalAt !== null && tonalAt > musicIn + 1 ? Number(tonalAt.toFixed(3)) : null;
  // Tail: a silent span running to the end of the file — its start is music-out.
  let musicOut = dur;
  const tail = [...spans].reverse().find(([, e]) => !Number.isFinite(e) || e >= dur - 0.5);
  if (tail) musicOut = tail[0];

  const grid = track?.grid;
  const snapped = floorToDownbeat(musicIn, grid);
  if (musicIn >= MIN_HEAD_S && snapped === null) noGrid++;

  const headSeconds = musicIn >= MIN_HEAD_S ? (snapped ?? Number(musicIn.toFixed(3))) : 0;
  const tailSeconds = dur - musicOut >= MIN_TAIL_S ? Number(musicOut.toFixed(3)) : null;

  if (!headSeconds && tailSeconds === null) {
    clean++;
    // A track that now measures clean should not keep a stale proposal — but an
    // approved entry is a human decision and is never removed (handled above).
    delete plan[id];
    continue;
  }
  proposed++;

  // What is actually inside each proposed cut? Only ambiguous cuts cost human time.
  const headClass = headSeconds > 0
    ? classifyRegion(entry.stems ?? {}, 0, headSeconds)
    : { kind: "none", levels: {} };
  const tailClass = tailSeconds !== null
    ? classifyRegion(entry.stems ?? {}, tailSeconds, Math.max(0, dur - tailSeconds))
    : { kind: "none", levels: {} };

  // Auto-approve ONLY when every proposed cut is provable digital silence. Anything
  // with speech, music, or an unmeasurable region goes to the owner. Erring toward
  // review is cheap; a wrongly-auto-approved cut destroys audio.
  const kinds = [headClass.kind, tailClass.kind].filter((k) => k !== "none");
  // A tonal hint means pitched content starts LATER than the silence boundary — a
  // likely crowd/ambience/video head. Such a track must never auto-approve, even when
  // its own cut regions are provable silence: the dangerous case is a track whose TAIL
  // cut is clean silence (auto-approvable) while its HEAD carries 25s of crowd noise
  // the silence test cannot see. Auto-approving that would ship the crowd head
  // untouched and never show it to anyone.
  const autoApprove = kinds.length > 0 && kinds.every((k) => k === "silence") && tonalHint === null;

  plan[id] = {
    name: track?.name ?? entry.name,
    headKind: headClass.kind,
    tailKind: tailClass.kind,
    headLevels: headClass.levels,
    tailLevels: tailClass.levels,
    sourceDuration: Number(dur.toFixed(3)),
    // seconds to remove from the FRONT — this is the value every downstream
    // timeline shift (loop-points, vocal-maps, cue-suggestions) subtracts.
    headSeconds,
    // absolute second in the ORIGINAL audio where the track should end (null = keep to end)
    tailSeconds,
    newDuration: Number(((tailSeconds ?? dur) - headSeconds).toFixed(3)),
    detected: {
      musicIn: Number(musicIn.toFixed(3)),
      musicOut: Number(musicOut.toFixed(3)),
      musicInSource,
      // Where pitched content seems to start, when that is LATER than the silence
      // boundary. A strong signal the head is crowd/ambience/video noise. Advisory
      // only — accurate to roughly +/-10s, so it is a hint for the ear, never a cut.
      tonalHint,
    },
    snappedToDownbeat: snapped !== null && headSeconds === snapped,
    // The PRE-cut Serato grid, captured now so the post-cut grid is just
    // shiftGrid(sourceGrid, headSeconds) with no git ref (apply-trims copies it into
    // trim-applied.json). apply-trims' -map_metadata 0 drops the GEOB frame, so this is
    // the only surviving copy once the cut file exists.
    sourceGrid: grid ?? null,
    // Auto-approved only for provable digital silence; everything else is the
    // owner's call. apply-trims must refuse to cut anything not approved.
    approved: autoApprove,
    approvedBy: autoApprove ? "auto:silence" : null,
  };
}

writeFileSync(OUT_PATH, JSON.stringify(plan, null, 2));
const cuts = Object.values(plan);
cuts.sort((a, b) => b.headSeconds - a.headSeconds);
console.log(
  `analysed=${analysed} proposed=${proposed} alreadyClean=${clean} noGrid=${noGrid} ` +
  `alreadyApproved=${kept} probeFailed=${failed}`,
);
if (failed) {
  console.warn(
    `\n!! ${failed} track(s) could not be probed and were NOT classified. They are ` +
    `absent from the plan, not "clean" — rerun after fixing ffmpeg/the stem files.`,
  );
}
const all = Object.values(plan);
const byKind = {};
for (const c of all) {
  for (const k of [c.headKind, c.tailKind]) {
    if (k && k !== "none") byKind[k] = (byKind[k] ?? 0) + 1;
  }
}
const auto = all.filter((c) => c.approvedBy === "auto:silence").length;
const needsYou = all.filter((c) => !c.approved).length;
console.log(`\ncut regions by content: ${JSON.stringify(byKind)}`);
console.log(`auto-approved (pure silence): ${auto}   NEEDS YOUR EAR: ${needsYou}`);
console.log(`\nlargest proposed head cuts:`);
for (const c of cuts.slice(0, 12)) {
  console.log(
    `  head ${String(c.headSeconds).padStart(7)}s  tail@${String(c.tailSeconds ?? "end").padStart(7)}` +
    `  ${c.sourceDuration}s -> ${c.newDuration}s  ` +
    (c.headSeconds === 0 ? "[tail only]" : c.snappedToDownbeat ? "[snapped]" : "[UNSNAPPED]") +
    `  ${c.name.slice(0, 40)}`,
  );
}
console.log(`\nplan: ${OUT_PATH}\nNOTHING WAS CUT — review, then run apply-trims.`);
