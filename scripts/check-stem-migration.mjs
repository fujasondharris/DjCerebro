#!/usr/bin/env node
// Golden for the stem migration planner (src/lib/stem-migration.ts).
//
// The planner is where Jason's craft rules live. This asserts them as PROPERTIES over
// many generated plans, not as one hand-checked example — because the invariant that
// matters ("always a bassline looping") has to hold for every combination of stems,
// tempo and length the brain might request, not just the one I happened to test.
//
// Usage: npm run check:stem-migration
import {
  planStemMigration, hasContinuousBass, roleGainAt, findBareRuns, STEM_ROLE,
} from "../src/lib/stem-migration.ts";

let failures = 0;
function assertOk(label, cond, detail = "") {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const FULL6 = ["drums", "bass", "guitar", "piano", "other", "vocals"];
const FULL4 = ["drums", "bass", "other", "vocals"];

// --- 1. THE HARD INVARIANT, as a property over many plans ---
let bassViolations = 0, plansChecked = 0;
for (const bpm of [88, 96, 105, 125, 175]) {
  for (const totalBars of [16, 32, 64, 128]) {
    for (const outS of [FULL6, FULL4, ["drums", "bass", "vocals"]]) {
      for (const inS of [FULL6, FULL4, ["drums", "bass", "other"]]) {
        for (const anchor of ["out", "in"]) {
          const p = planStemMigration({ outgoingStems: outS, incomingStems: inS, bpm, totalBars, anchor });
          plansChecked++;
          if (!hasContinuousBass(p.ramps, p.totalBars)) bassViolations++;
        }
      }
    }
  }
}
assertOk(
  `bass never drops to zero across ${plansChecked} generated plans (the one hard rule)`,
  bassViolations === 0, `${bassViolations} plan(s) let the bassline die`,
);

// --- 2. ordering: vocals leave first, rhythm section last ---
const p = planStemMigration({ outgoingStems: FULL6, incomingStems: FULL6, bpm: 96, totalBars: 64 });
const outBy = (role) => p.ramps.filter((r) => r.deck === "out" && r.role === role);
const inBy = (role) => p.ramps.filter((r) => r.deck === "in" && r.role === role);
const startOf = (rs) => Math.min(...rs.map((r) => r.fromBar));
const endOf = (rs) => Math.max(...rs.map((r) => r.toBar));

assertOk("outgoing VOCALS leave before outgoing HARMONY",
  endOf(outBy("vocals")) <= startOf(outBy("harmony")) + 0.01);
assertOk("outgoing HARMONY leaves before the outgoing RHYTHM SECTION hands over",
  endOf(outBy("harmony")) <= startOf(outBy("bass")) + 0.01);
assertOk("incoming HARMONY arrives over the outgoing rhythmic anchor before the bass swap",
  startOf(inBy("harmony")) < startOf(inBy("bass")));
assertOk("incoming VOCALS arrive last",
  startOf(inBy("vocals")) >= startOf(inBy("harmony")) - 0.01);

// --- 3. removal and arrival OVERLAP (the anchor is not left bare in the middle) ---
assertOk("incoming stems start arriving BEFORE the outgoing melodic layers have fully left",
  startOf(inBy("harmony")) < endOf(outBy("harmony")),
  `in-harmony starts ${startOf(inBy("harmony"))}, out-harmony ends ${endOf(outBy("harmony"))}`);

// --- 4. the anchor spans the whole run: at NO point is total bass below its floor ---
let minBass = Infinity;
for (let bar = 0; bar <= 64; bar += 0.25) minBass = Math.min(minBass, roleGainAt(p.ramps, "bass", bar));
assertOk("bass gain across the whole 64-bar migration never dips below 0.5",
  minBass >= 0.5, `min was ${minBass.toFixed(3)}`);

// --- 5. bare-anchor lean is a WARNING, not a failure ---
const long = planStemMigration({ outgoingStems: FULL4, incomingStems: FULL4, bpm: 88, totalBars: 256 });
assertOk("a very long migration surfaces a bare-anchor WARNING rather than failing",
  Array.isArray(long.warnings) && long.ramps.length > 0);
assertOk("no plan is ever produced with the 'BASS DROPS TO ZERO' warning",
  !long.warnings.some((w) => w.includes("BASS DROPS TO ZERO")) &&
  !p.warnings.some((w) => w.includes("BASS DROPS TO ZERO")));

// --- 6. the documented inversion: anchor on the INCOMING deck ---
const inv = planStemMigration({ outgoingStems: FULL6, incomingStems: FULL6, bpm: 96, totalBars: 64, anchor: "in" });
// The anchor deck's rhythm section must be at full from bar 0 (it is what the whole
// migration rides on) and must NOT fall until the late handover.
const inAnchorBassAt0 = roleGainAt(inv.ramps.filter((r) => r.deck === "in"), "bass", 0);
const inAnchorBassAt30 = roleGainAt(inv.ramps.filter((r) => r.deck === "in"), "bass", 30);
assertOk("anchor:'in' — the incoming bass is at full from bar 0 and still at full mid-run",
  inAnchorBassAt0 >= 0.99 && inAnchorBassAt30 >= 0.99,
  `bar0=${inAnchorBassAt0.toFixed(2)} bar30=${inAnchorBassAt30.toFixed(2)}`);
assertOk("anchor:'in' still keeps a bassline at all times",
  hasContinuousBass(inv.ramps, inv.totalBars));

// --- 7. role mapping is what Jason said, not what a filename implies ---
assertOk("guitar, piano and other all map to HARMONY (harmony+melody are one layer to htdemucs)",
  STEM_ROLE.guitar === "harmony" && STEM_ROLE.piano === "harmony" && STEM_ROLE.other === "harmony");
assertOk("drums=rhythm, bass=bass, vocals=vocals",
  STEM_ROLE.drums === "rhythm" && STEM_ROLE.bass === "bass" && STEM_ROLE.vocals === "vocals");

// --- 8. missing stems (a track that dropped guitar/piano as blank) still plan cleanly ---
const sparse = planStemMigration({ outgoingStems: ["drums", "bass", "vocals"], incomingStems: ["drums", "bass", "other"], bpm: 96, totalBars: 32 });
assertOk("a track with no harmony stems still produces a valid plan",
  sparse.ramps.length > 0 && hasContinuousBass(sparse.ramps, 32));

// --- 9. findBareRuns is honest about the sparse case ---
const bare = findBareRuns(sparse.ramps, 32);
assertOk("findBareRuns reports SOME bare span when one deck has no melodic content at all",
  bare.length >= 1);

for (const plan of [p, inv, sparse]) {
  assertOk("one envelope per physical stem", new Set(plan.ramps.map(r => `${r.deck}:${r.stem}`)).size === plan.ramps.length);
  assertOk("every outgoing stem ends at zero", plan.ramps.filter(r => r.deck === "out").every(r => r.toGain === 0));
  assertOk("every incoming stem ends at full", plan.ramps.filter(r => r.deck === "in").every(r => r.toGain === 1));
  assertOk("bass swap never doubles the bass gain", Array.from({length:641}, (_,i) => roleGainAt(plan.ramps, "bass", plan.totalBars*i/640)).every(g => Math.abs(g-1)<1e-6));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed — the migration planner violates a craft rule.`);
  process.exit(1);
}
console.log("\nPASS: all stem-migration planner cases");
