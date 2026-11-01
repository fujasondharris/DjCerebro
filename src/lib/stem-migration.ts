// M8.2 — the stem MIGRATION planner: Jason's real transition, as data.
//
// This is the move he described (2026-08-15): "some live club and radio DJs will do
// a bass loop for minutes while they migrate out the vocals, bass, guitar, other and
// migrate in them from the next song." It is not a crossfade between two tracks — it
// is a per-stem handover over a held rhythmic anchor.
//
// Pure functions only. No Web Audio here: this produces a SCHEDULE of gain ramps that
// stems.ts executes. That split is deliberate — the craft rules are the part worth
// testing, and they are testable exactly because there is no audio in this file.
//
// THE RULES, in his words:
//  - "vocals go out first, the other and guitar are usually 2nd, and bass and drums
//    last — like separate the harmony, melody, rhythm and bass."
//  - "You always need rhythm and bass, and the harmony and melody can change around it."
//  - "I don't think there's necessarily a mandatory sequence PROVIDED YOU ALWAYS HAVE
//    A BASSLINE LOOPING."  <- the one hard invariant
//  - "you can't do just bass for very long... maybe 15 or 20 seconds of just a BORING
//    bass line without harmony or melody."  <- a lean, not a ceiling; "boring" is the
//    operative word, so this is a warning and never a hard failure
//  - "you almost never would leave a bassline looping by itself... during the first
//    15 or 30 seconds you're pulling out the components and then the next you're
//    swapping in new ones."  <- removal and arrival OVERLAP; the anchor is the floor
//    under the whole migration, not a phase of its own.

/** Functional role, not a filename. htdemucs stem names map onto these. */
export type StemRole = "rhythm" | "bass" | "harmony" | "vocals";

export const STEM_ROLE: Record<string, StemRole> = {
  drums: "rhythm",
  bass: "bass",
  guitar: "harmony",
  piano: "harmony",
  other: "harmony",
  vocals: "vocals",
};

export type Deck = "out" | "in";

/** One gain ramp for one stem on one deck, in BARS from the start of the migration. */
export interface StemRamp {
  deck: Deck;
  stem: string;
  role: StemRole;
  fromBar: number;
  toBar: number;
  fromGain: number;
  toGain: number;
}

export interface MigrationPlan {
  totalBars: number;
  barSeconds: number;
  ramps: StemRamp[];
  /** Bars where the anchor (rhythm/bass) is the only thing audible. */
  bareRuns: { fromBar: number; toBar: number }[];
  warnings: string[];
}

export interface MigrationInput {
  /** Stem names present on the outgoing track (e.g. ["drums","bass","other","vocals"]). */
  outgoingStems: string[];
  incomingStems: string[];
  /** Effective BPM the migration runs at — both decks are locked to this. */
  bpm: number;
  /** Total length in bars. Song-dependent; the caller decides, this does not invent one. */
  totalBars: number;
  /**
   * Which deck's rhythm section anchors. "out" is the default (hold the outgoing
   * groove, bring the new track in under it). "in" is the documented inversion —
   * a strong incoming hook can anchor while the rhythm section changes beneath it.
   */
  anchor?: Deck;
}

const ORDER_OUT: StemRole[] = ["vocals", "harmony", "bass", "rhythm"];

/** Bare-anchor lean, in seconds. NOT a ceiling — see the header. */
export const BARE_ANCHOR_WARN_SECONDS = 20;

function rolesOf(stems: string[]): Map<StemRole, string[]> {
  const m = new Map<StemRole, string[]>();
  for (const s of stems) {
    const role = STEM_ROLE[s];
    if (!role) continue;
    if (!m.has(role)) m.set(role, []);
    m.get(role)!.push(s);
  }
  return m;
}

/**
 * Build the migration schedule.
 *
 * Shape: the anchor deck's rhythm+bass hold at full for most of the run and hand over
 * late. The non-anchor roles leave in ORDER_OUT and arrive in ORDER_IN, staggered so
 * that departures and arrivals OVERLAP rather than running end-to-end — that overlap
 * is what stops the middle of the migration from collapsing into bare bass.
 */
export function planStemMigration(input: MigrationInput): MigrationPlan {
  const { outgoingStems, incomingStems, bpm, totalBars } = input;
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(totalBars) || totalBars <= 0) throw new Error("Invalid migration tempo or duration");
  const anchor: Deck = input.anchor ?? "out";
  const barSeconds = (60 / bpm) * 4;
  const ramps: StemRamp[] = [];
  const warnings: string[] = [];

  const outRoles = rolesOf(outgoingStems);
  const inRoles = rolesOf(incomingStems);

  // Departures occupy the first ~55% of the run, arrivals the last ~70%. The deliberate
  // overlap in the middle is the point: something melodic is nearly always present.
  const outSpan = totalBars * 0.55;
  const inStart = totalBars * 0.3;
  const inSpan = totalBars - inStart;

  const nonAnchorOut = ORDER_OUT.filter((r) => r !== "rhythm" && r !== "bass");
  nonAnchorOut.forEach((role, i) => {
    const stems = outRoles.get(role) ?? [];
    const step = outSpan / Math.max(1, nonAnchorOut.length);
    for (const stem of stems) {
      ramps.push({
        deck: "out", stem, role,
        fromBar: round2(i * step),
        toBar: round2(i * step + step),
        fromGain: 1, toGain: 0,
      });
    }
  });

  const nonAnchorIn: StemRole[] = ["harmony", "vocals"];
  nonAnchorIn.forEach((role, i) => {
    const stems = inRoles.get(role) ?? [];
    const step = inSpan / Math.max(1, nonAnchorIn.length);
    for (const stem of stems) {
      ramps.push({
        deck: "in", stem, role,
        fromBar: round2(inStart + i * step),
        toBar: round2(inStart + i * step + step),
        fromGain: 0, toGain: 1,
      });
    }
  });

  // Each physical stem owns exactly one envelope. The former planner scheduled
  // bass/drums twice and its evaluator double-counted them. Both variants END on
  // the incoming track: anchor:"in" swaps its rhythm in at the start, not back out
  // to the old song at the end. Complementary ramps avoid doubled bass gain.
  const handoverStart = anchor === "in" ? 0 : totalBars * 0.72;
  const handoverEnd = anchor === "in" ? Math.min(1, totalBars / 8) : totalBars * 0.95;
  const anchorRoles: StemRole[] = ["rhythm", "bass"];
  for (const role of anchorRoles) {
    for (const stem of outRoles.get(role) ?? []) {
      ramps.push({
        deck: "out", stem, role,
        fromBar: round2(handoverStart),
        toBar: round2(handoverEnd),
        fromGain: anchor === "in" ? 0 : 1, toGain: 0,
      });
    }
    for (const stem of inRoles.get(role) ?? []) {
      ramps.push({
        deck: "in", stem, role,
        fromBar: round2(handoverStart),
        toBar: round2(handoverEnd),
        fromGain: anchor === "in" ? 1 : 0, toGain: 1,
      });
    }
  }

  const bareRuns = findBareRuns(ramps, totalBars);
  for (const run of bareRuns) {
    const seconds = (run.toBar - run.fromBar) * barSeconds;
    if (seconds > BARE_ANCHOR_WARN_SECONDS) {
      warnings.push(
        `bare anchor for ${seconds.toFixed(1)}s (bars ${run.fromBar}-${run.toBar}) — ` +
        `"you can't do just bass for very long"; bring something in sooner unless the loop is genuinely interesting`,
      );
    }
  }
  if (!hasContinuousBass(ramps, totalBars)) {
    warnings.push("BASS DROPS TO ZERO — this violates the one hard rule and must not be played");
  }

  return { totalBars, barSeconds, ramps, bareRuns, warnings };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Total gain for a role across both decks at a given bar. */
export function roleGainAt(ramps: StemRamp[], role: StemRole, bar: number): number {
  let total = 0;
  for (const r of ramps) {
    if (r.role !== role) continue;
    if (bar <= r.fromBar) { total += r.fromGain; continue; }
    if (bar >= r.toBar) { total += r.toGain; continue; }
    const t = (bar - r.fromBar) / (r.toBar - r.fromBar);
    total += r.fromGain + (r.toGain - r.fromGain) * t;
  }
  return total;
}

/**
 * THE HARD INVARIANT: a bassline is looping at all times. Sampled densely rather than
 * only at ramp edges — a gap can open mid-ramp between a falling and a rising bass.
 */
export function hasContinuousBass(ramps: StemRamp[], totalBars: number, step = 0.1): boolean {
  for (let bar = 0; bar <= totalBars + 1e-9; bar += step) {
    if (roleGainAt(ramps, "bass", bar) <= 0.001) return false;
  }
  return true;
}

/** Spans where only rhythm/bass are audible — no harmony, no vocals, on either deck. */
export function findBareRuns(
  ramps: StemRamp[], totalBars: number, step = 0.1,
): { fromBar: number; toBar: number }[] {
  const runs: { fromBar: number; toBar: number }[] = [];
  let start: number | null = null;
  for (let bar = 0; bar <= totalBars + 1e-9; bar += step) {
    const melodic = roleGainAt(ramps, "harmony", bar) + roleGainAt(ramps, "vocals", bar);
    const bare = melodic <= 0.02;
    if (bare && start === null) start = bar;
    if (!bare && start !== null) {
      runs.push({ fromBar: round2(start), toBar: round2(bar) });
      start = null;
    }
  }
  if (start !== null) runs.push({ fromBar: round2(start), toBar: round2(totalBars) });
  return runs;
}
