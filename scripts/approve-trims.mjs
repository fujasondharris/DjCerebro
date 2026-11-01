#!/usr/bin/env node
// Mark trim-plan entries as owner-approved. The review page emits the exact
// command; this just records the decision so apply-trims will act on it.
//
// Approval is the ONLY thing that authorises a cut — make-trim-plan never
// re-derives an approved entry, and apply-trims refuses to touch an unapproved
// one. Kept as its own tiny script so approving is never a side effect of
// regenerating the plan.
//
// --set-head records an OWNER-CORRECTED cut point and is the mechanism for cases the
// detector cannot see. Real example (2026-08-15): Aventura's "Un Beso" opens with 27s
// of live crowd noise and talking. That is neither silence nor music — it smears
// broadband energy across every stem, so the instrumental-bed test reads it as music
// and proposed a 4.4s head. Jason heard it correctly: the guitar enters at ~27s.
// Overrides are snapped to a downbeat like any other cut, marked ownerSet, and
// never re-derived by make-trim-plan.
//
// Usage: npm run trims:approve -- <id> [<id> ...]
//        npm run trims:approve -- --list                (show pending)
//        npm run trims:approve -- --revoke <id>         (undo)
//        npm run trims:approve -- --set-head <id> <sec> (owner-corrected head cut)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLAN = path.join(fileURLToPath(new URL("..", import.meta.url)), "src", "data", "trim-plan.json");
if (!existsSync(PLAN)) {
  console.error("No trim-plan.json — run make:trim-plan first.");
  process.exit(1);
}
const plan = JSON.parse(readFileSync(PLAN, "utf8"));
const args = process.argv.slice(2).filter((a) => a !== "(none" && a !== "selected)");

if (!args.length || args.includes("--list")) {
  const pending = Object.entries(plan).filter(([, c]) => !c.approved);
  console.log(`approved: ${Object.values(plan).filter((c) => c.approved).length}   pending: ${pending.length}`);
  for (const [id, c] of pending) {
    console.log(`  ${id}  head=${c.headSeconds}s(${c.headKind}) tail=${c.tailSeconds ?? "-"}(${c.tailKind})  ${c.name.slice(0, 46)}`);
  }
  process.exit(0);
}

// Find the flag ANYWHERE in argv rather than assuming index 0 — npm's `--`
// forwarding does not reliably preserve position, and requiring args[0] made every
// `npm run trims:approve -- --set-head <id> <sec>` silently fall through to the
// bulk-approve branch and report "unknown id".
const setHeadAt = args.indexOf("--set-head");
if (setHeadAt >= 0) {
  const id = args[setHeadAt + 1];
  const secRaw = args[setHeadAt + 2];
  const seconds = Number(secRaw);
  if (!plan[id]) { console.error(`unknown id: ${id}`); process.exit(1); }
  if (!Number.isFinite(seconds) || seconds < 0) { console.error(`bad seconds: ${secRaw}`); process.exit(1); }

  // Snap back to a real downbeat, exactly as make-trim-plan does, so an owner
  // correction never lands mid-bar either.
  const CRATE = JSON.parse(readFileSync(
    path.join(fileURLToPath(new URL("..", import.meta.url)), "src", "data", "crate-manifest.json"), "utf8"));
  const grid = CRATE.find((t) => t.id === id)?.grid ?? plan[id]?.sourceGrid; // batch-2 ids live in the plan, not crate-manifest
  let head = Number(seconds.toFixed(3));
  let snapped = false;
  if (grid?.bpm > 0) {
    const anchor = typeof grid.anchor === "number" ? grid.anchor : 0;
    const bar = (60 / grid.bpm) * 4;
    const n = Math.floor((seconds - anchor) / bar);
    const cand = anchor + n * bar;
    if (cand >= 0 && cand <= seconds) { head = Number(cand.toFixed(3)); snapped = true; }
  }

  const c = plan[id];
  const prevHead = c.headSeconds;
  c.headSeconds = head;
  c.newDuration = Number(((c.tailSeconds ?? c.sourceDuration) - head).toFixed(3));
  c.snappedToDownbeat = snapped;
  c.headKind = "owner-set";
  c.approved = true;
  c.approvedBy = "owner:set-head";
  writeFileSync(PLAN, JSON.stringify(plan, null, 2));
  console.log(`  ${c.name}`);
  console.log(`  head ${prevHead}s -> ${head}s${
    head === 0 ? " (NO CUT — intro kept)"
      : snapped ? " (snapped to downbeat)"
      : " (NO GRID — not snapped)"}`);
  console.log(`  new duration ${c.newDuration}s, approved by owner`);
  process.exit(0);
}

const revoke = args.includes("--revoke");
const ids = args.filter((a) => !a.startsWith("--"));
let hit = 0, miss = 0;
for (const id of ids) {
  if (!plan[id]) { miss++; console.warn(`  unknown id: ${id}`); continue; }
  plan[id].approved = !revoke;
  plan[id].approvedBy = revoke ? null : "owner";
  hit++;
  console.log(`  ${revoke ? "revoked" : "approved"}: ${plan[id].name.slice(0, 56)}`);
}
writeFileSync(PLAN, JSON.stringify(plan, null, 2));
console.log(`\n${revoke ? "revoked" : "approved"} ${hit}${miss ? `, ${miss} unknown` : ""}` +
  `   total approved now: ${Object.values(plan).filter((c) => c.approved).length}`);
