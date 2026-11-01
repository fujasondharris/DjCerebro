#!/usr/bin/env node
// M8.1c — build the listening page for trim cuts that need a human ear.
//
// make-trim-plan.mjs auto-approves only provable digital silence. Everything else
// — a spoken intro (Aventura open with Romeo talking), a quiet passage, or a region
// where an instrumental stem is still audible — is a taste call and lands here.
// This page shows ONLY those, so reviewing the crate is an evening of real
// decisions instead of clicking through hundreds of obvious ones.
//
// Per entry you hear two things: the audio being REMOVED, and the audio that
// becomes the new start (or new ending). That is the whole decision — "is what
// I'm cutting junk, and does what's left begin cleanly?"
//
// The page cannot write files, so it emits a ready-to-paste approve command.
// Approvals live in src/data/trim-plan.json, which make-trim-plan.mjs preserves
// across reruns and never re-derives.
//
// Usage: node --experimental-strip-types --no-warnings scripts/make-trim-review.mjs [--only=local:]
//        open ~/dj-tools/trim-review.html
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAN = path.join(REPO_ROOT, "src", "data", "trim-plan.json");
const CRATE_DIR = process.env.CRATE_DIR || path.join(os.homedir(), "Music", "dj-crate");
const OUT = path.join(os.homedir(), "dj-tools", "trim-review.html");

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const furl = (p) => "file://" + encodeURI(p).replace(/#/g, "%23");
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

if (!existsSync(PLAN)) {
  console.error("No trim-plan.json — run make:trim-plan first.");
  process.exit(1);
}
const plan = JSON.parse(readFileSync(PLAN, "utf8"));
// --only=<id prefix> limits the page to one batch (e.g. --only=local: for batch 2).
const ONLY = process.argv.slice(2).find((a) => a.startsWith("--only="))?.slice(7) ?? "";
const pending = Object.entries(plan).filter(([id, c]) => id.startsWith(ONLY) && !c.approved);

const KIND_NOTE = {
  "vocals-only": "Speech with no instruments. Could be the video's dialogue — or an artistic spoken intro. Your call.",
  "quiet": "Very low level but not digital silence. Check it isn't a soft musical intro.",
  "has-music": "An instrumental stem is AUDIBLE in this region. The detector may be over-reaching — listen carefully.",
  "unknown": "Could not measure this region. Do not approve without listening.",
};

const rows = pending.map(([id, c]) => {
  const src = path.join(CRATE_DIR, c.name);
  const u = furl(src);
  const parts = [];
  // A likely crowd/ambience head — the detector can flag the class but not the point,
  // so this asks for a listen at the hint and offers the exact command to set it.
  const hint = c.detected?.tonalHint ?? null;
  if (hint !== null) {
    parts.push(`
      <div class="pair crowd">
        <div class="lbl cut">LIKELY CROWD / VIDEO NOISE · music may not start until ~${mmss(hint)} (${hint}s)</div>
        <div class="note">Silence detection stops at ${c.headSeconds}s, but pitched content
          (bass/guitar/piano) doesn't appear until ~${hint}s. That gap is usually a crowd,
          room ambience, or video sound. The estimate is only good to about &plusmn;10s — listen
          and set the real point.</div>
        <div class="lbl keep">LISTEN FROM ${mmss(Math.max(0, hint - 6))}</div>
        <audio controls preload="none" src="${u}#t=${Math.max(0, hint - 6)},${hint + 12}"></audio>
        <div class="cmd">npm run trims:approve -- --set-head ${esc(id)} &lt;seconds&gt;</div>
      </div>`);
  }
  if (c.headSeconds > 0) {
    parts.push(`
      <div class="pair">
        <div class="lbl cut">REMOVING · head · 0:00 → ${mmss(c.headSeconds)} (${c.headSeconds}s)
          <span class="kind k-${esc(c.headKind)}">${esc(c.headKind)}</span></div>
        <audio controls preload="none" src="${u}#t=0,${c.headSeconds}"></audio>
        <div class="lbl keep">NEW START · from ${mmss(c.headSeconds)}</div>
        <audio controls preload="none" src="${u}#t=${c.headSeconds},${c.headSeconds + 15}"></audio>
        <div class="note">${esc(KIND_NOTE[c.headKind] ?? "")}</div>
      </div>`);
  }
  if (c.tailSeconds !== null) {
    const from = Math.max(0, c.tailSeconds - 10);
    parts.push(`
      <div class="pair">
        <div class="lbl keep">NEW ENDING · ${mmss(from)} → ${mmss(c.tailSeconds)}</div>
        <audio controls preload="none" src="${u}#t=${from},${c.tailSeconds}"></audio>
        <div class="lbl cut">REMOVING · tail · ${mmss(c.tailSeconds)} → end (${(c.sourceDuration - c.tailSeconds).toFixed(1)}s)
          <span class="kind k-${esc(c.tailKind)}">${esc(c.tailKind)}</span></div>
        <audio controls preload="none" src="${u}#t=${c.tailSeconds},${c.sourceDuration}"></audio>
        <div class="note">${esc(KIND_NOTE[c.tailKind] ?? "")}</div>
      </div>`);
  }
  const levels = Object.entries({ ...c.headLevels, ...c.tailLevels })
    .map(([s, v]) => `${s} ${v === null ? "?" : v.toFixed(0)}`).join(" · ");
  return `
  <section>
    <label class="hdr"><input type="checkbox" data-id="${esc(id)}">
      <span class="tname">${esc(c.name)}</span></label>
    <div class="meta">${c.sourceDuration}s → ${c.newDuration}s${c.snappedToDownbeat ? " · snapped to downbeat" : ""}
      <span class="lv">${esc(levels)}</span></div>
    ${parts.join("")}
  </section>`;
}).join("");

const doc = `<!doctype html>
<meta charset="utf-8"><title>Trim review — ${pending.length} judgment calls</title>
<style>
 :root{color-scheme:dark}
 body{font:15px/1.5 -apple-system,system-ui,sans-serif;background:#111;color:#eee;margin:0;padding:24px;max-width:900px}
 h1{font-size:20px;margin:0 0 4px} p.sub{color:#999;margin:0 0 20px}
 section{border:1px solid #333;border-radius:6px;padding:14px;margin-bottom:14px;background:#181818}
 .hdr{display:flex;gap:10px;align-items:center;cursor:pointer}
 .tname{font-weight:600}
 .meta{color:#888;font-size:12px;margin:4px 0 10px 26px}
 .lv{color:#666;margin-left:8px}
 .pair{margin:0 0 12px 26px;padding-left:12px;border-left:2px solid #2a2a2a}
 .lbl{font-size:11px;letter-spacing:.05em;text-transform:uppercase;margin:8px 0 4px}
 .cut{color:#f87171} .keep{color:#4ade80}
 .kind{margin-left:8px;padding:1px 6px;border-radius:3px;font-size:10px}
 .k-vocals-only{background:#78350f} .k-quiet{background:#1e3a5f}
 .k-has-music{background:#7f1d1d} .k-unknown{background:#4c1d95}
 .note{font-size:12px;color:#999;margin-top:4px}
 .crowd{border-left-color:#b45309;background:#1c1411}
 .cmd{margin-top:8px;padding:6px 8px;background:#000;border:1px solid #333;border-radius:4px;
      font:11px ui-monospace,monospace;color:#fbbf24;user-select:all}
 audio{width:100%;height:32px}
 #bar{position:sticky;bottom:0;background:#0d0d0d;border-top:1px solid #333;padding:12px;margin:20px -24px -24px}
 textarea{width:100%;height:62px;background:#000;color:#6ee7b7;border:1px solid #333;
          border-radius:4px;font:12px ui-monospace,monospace;padding:8px}
</style>
<h1>Trim review — ${pending.length} judgment call${pending.length === 1 ? "" : "s"}</h1>
<p class="sub">Pure-silence cuts were auto-approved and are not shown. Red is what gets deleted;
green is what survives. Tick the ones you agree with, then paste the command below.</p>
${rows || "<p>Nothing pending — every proposed cut was provable silence.</p>"}
<div id="bar">
  <textarea id="cmd" readonly>npm run trims:approve --</textarea>
</div>
<script>
 const boxes=[...document.querySelectorAll('input[type=checkbox]')];
 const out=document.getElementById('cmd');
 const sync=()=>{const ids=boxes.filter(b=>b.checked).map(b=>b.dataset.id);
   out.value='npm run trims:approve -- '+(ids.length?ids.join(' '):'(none selected)');};
 boxes.forEach(b=>b.addEventListener('change',sync)); sync();
</script>`;

writeFileSync(OUT, doc);
const approved = Object.values(plan).filter((c) => c.approved).length;
console.log(`pending review: ${pending.length}   already approved: ${approved}`);
console.log(`page: ${OUT}`);
