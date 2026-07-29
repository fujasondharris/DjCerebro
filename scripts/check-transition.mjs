#!/usr/bin/env node
// Node-side smoke test for the engine-level auto-transition (Milestone 3
// Part B, extended M4 Part B): imports the exact same src/lib/transition.ts
// used by the UI and drives it with fake decks + injectable timers/clock
// (transition.ts accepts now/setIntervalFn/clearIntervalFn/setTimeoutFn/
// clearTimeoutFn precisely so this is possible without real wall-clock
// waits). Plain asserts, no test framework, mirrors check-beatclock.mjs /
// check-command.mjs.
//
// This is the "one runnable check" for transition.ts's non-trivial logic
// that no other VERIFY command covers (build/lint don't execute it; M4 adds
// bass_swap's EQ-swap timing, echo_out's delay/feedback/wet-ramp/cut
// sequence, mid-transition drift correction (firing + NOT firing when
// clamped/estimated/missing grids), and auto-degrade-on-clamp.
import { createTransitionEngine } from "../src/lib/transition.ts";
import { beatPhase } from "../src/lib/beatclock.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

function approxEqual(a, b, epsilon = 1e-6) {
  return Math.abs(a - b) < epsilon;
}

class FakeDeck {
  constructor({ tempo = 1, positionSeconds = 0 } = {}) {
    this.tempo = tempo;
    this.positionSeconds = positionSeconds;
    this.gain = 1;
    this.playing = false;
    this.paused = false;
    this.seeks = [];
    this.tempoSets = [];
    this.gainSets = [];
    this.eq = { low: 0, mid: 0, high: 0 };
    this.eqCalls = [];
    this.echoTailCalls = [];
    this.endedListeners = [];
  }
  onEnded(listener) {
    this.endedListeners.push(listener);
    return () => {
      this.endedListeners = this.endedListeners.filter((l) => l !== listener);
    };
  }
  /** Test helper: simulates this deck's track finishing naturally. */
  fireEnded() {
    for (const listener of this.endedListeners.slice()) listener();
  }
  play() {
    this.playing = true;
  }
  pause() {
    this.playing = false;
    this.paused = true;
  }
  setTempo(t) {
    this.tempo = t;
    this.tempoSets.push(t);
  }
  seekBy(s) {
    this.positionSeconds += s;
    this.seeks.push(s);
  }
  setGain(v) {
    this.gain = v;
    this.gainSets.push(v);
  }
  setEq(eq) {
    this.eqCalls.push(eq);
    Object.assign(this.eq, eq);
  }
  echoTail(effectiveBpm, beats, feedback, wetLevel, ringSeconds) {
    this.echoTailCalls.push({ effectiveBpm, beats, feedback, wetLevel, ringSeconds });
  }
}

// Fake env supporting MULTIPLE concurrent intervals/timeouts (M4 needs this:
// beatmatch_crossfade/bass_swap can have both the ~30Hz gain-ramp tick AND a
// much-slower drift-correction interval running at once; echo_out schedules
// a timeout nested inside another timeout).
function makeFakeEnv() {
  let currentTime = 0;
  let nextId = 1;
  const intervals = new Map(); // id -> {cb, ms}
  const timeouts = new Map(); // id -> {cb, ms}
  return {
    now: () => currentTime,
    setIntervalFn: (cb, ms) => {
      const id = nextId++;
      intervals.set(id, { cb, ms });
      return id;
    },
    clearIntervalFn: (id) => {
      intervals.delete(id);
    },
    setTimeoutFn: (cb, ms) => {
      const id = nextId++;
      timeouts.set(id, { cb, ms });
      return id;
    },
    clearTimeoutFn: (id) => {
      timeouts.delete(id);
    },
    setTime(t) {
      currentTime = t;
    },
    // Fires the interval with the smallest registered ms — always the
    // ~30Hz gain-ramp tick, since the drift-correction interval (every 4
    // bars) is always several seconds, much larger.
    tickInterval() {
      const entries = Array.from(intervals.values());
      if (entries.length === 0) return;
      const smallest = entries.reduce((a, b) => (a.ms <= b.ms ? a : b));
      smallest.cb();
    },
    // Fires the drift-correction interval specifically (whichever
    // registered interval is NOT the smallest-ms one).
    tickDriftInterval() {
      const entries = Array.from(intervals.values());
      if (entries.length < 2) return;
      const smallest = entries.reduce((a, b) => (a.ms <= b.ms ? a : b));
      for (const entry of entries) {
        if (entry !== smallest) entry.cb();
      }
    },
    // Fires every currently-registered timeout once, clearing them first —
    // any timeout newly scheduled from within a firing callback lands in
    // the (now-empty) map fresh, ready for the NEXT fireTimeout() call, so
    // nested setTimeoutFn chains (echo_out) can be driven step by step.
    fireTimeout() {
      const entries = Array.from(timeouts.values());
      timeouts.clear();
      for (const entry of entries) entry.cb();
    },
    get hasInterval() {
      return intervals.size > 0;
    },
    get intervalCount() {
      return intervals.size;
    },
    get hasTimeout() {
      return timeouts.size > 0;
    },
    get timeoutCount() {
      return timeouts.size;
    },
  };
}

const gridA = { anchor: 0, bpm: 120, estimated: false };
const gridB = { anchor: 0, bpm: 120, estimated: false };

// --- guard: only one transition at a time ---
{
  const engine = createTransitionEngine();
  const env = makeFakeEnv();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 10 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  let done = null;

  const first = engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 120,
    fromGrid: gridA,
    toGrid: gridB,
    durationBars: 4,
    now: env.now,
    setIntervalFn: env.setIntervalFn,
    clearIntervalFn: env.clearIntervalFn,
    setTimeoutFn: env.setTimeoutFn,
    clearTimeoutFn: env.clearTimeoutFn,
    onDone: (r) => (done = r),
  });
  assertOk("guard: first call starts", first.started === true);
  assertOk("guard: engine reports running", engine.isRunning === true);

  const second = engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 120,
    fromGrid: gridA,
    toGrid: gridB,
    durationBars: 4,
  });
  assertOk("guard: second call rejected while running", second.started === false && typeof second.reason === "string");

  // Drive the first transition to completion (bars=4, 120bpm -> 8s duration).
  env.setTime(8000);
  env.tickInterval();
  assertOk("guard: onDone fired after completion", done !== null && done.liveDeck === "to");
  assertOk("guard: engine no longer running after completion", engine.isRunning === false);

  const third = engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 120,
    fromGrid: gridA,
    toGrid: gridB,
    durationBars: 4,
    now: env.now,
    setIntervalFn: env.setIntervalFn,
    clearIntervalFn: env.clearIntervalFn,
    setTimeoutFn: env.setTimeoutFn,
    clearTimeoutFn: env.clearTimeoutFn,
  });
  assertOk("guard: a new transition can start once the previous one is done", third.started === true);
}

// --- beatmatch_crossfade: gain ramp, resnap, completion ---
{
  const engine = createTransitionEngine();
  const env = makeFakeEnv();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 3 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 1 });
  const progressSamples = [];
  let done = null;

  const outcome = engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 120,
    fromGrid: gridA,
    toGrid: gridB,
    durationBars: 4, // -> 8s duration at 120bpm/tempo=1
    now: env.now,
    setIntervalFn: env.setIntervalFn,
    clearIntervalFn: env.clearIntervalFn,
    setTimeoutFn: env.setTimeoutFn,
    clearTimeoutFn: env.clearTimeoutFn,
    onGain: (p) => progressSamples.push(p),
    onDone: (r) => (done = r),
  });

  assertOk("crossfade: starts", outcome.started === true);
  assertOk("crossfade: toDeck started playing immediately", toDeck.playing === true);
  assertOk("crossfade: toDeck tempo-synced to fromDeck's effective bpm", toDeck.tempo === 1);
  assertOk("crossfade: initial phase-snap attempted (toDeck seeked)", toDeck.seeks.length === 1);
  assertOk("crossfade: progress 0 reported at start", progressSamples[0] === 0);
  assertOk("crossfade: resnap timeout scheduled", env.hasTimeout === true);
  assertOk("crossfade: fromDeck not yet paused", fromDeck.paused === false);
  assertOk("crossfade: real grids + no clamp -> drift-correction interval also scheduled", env.intervalCount === 2);

  // Fire the ~1s corrective resnap.
  env.fireTimeout();
  assertOk("crossfade: corrective resnap re-seeked toDeck once more", toDeck.seeks.length === 2);

  // Halfway through the 8s ramp.
  env.setTime(4000);
  env.tickInterval();
  const half = progressSamples[progressSamples.length - 1];
  assertOk("crossfade: halfway progress ~0.5", approxEqual(half, 0.5, 1e-3));
  assertOk(
    "crossfade: halfway gains follow equal-power curve",
    approxEqual(fromDeck.gain, Math.cos(Math.PI / 4), 1e-3) && approxEqual(toDeck.gain, Math.sin(Math.PI / 4), 1e-3)
  );
  assertOk("crossfade: not done yet at halfway", done === null);
  assertOk("crossfade: no EQ swap for plain crossfade", fromDeck.eqCalls.length === 0 && toDeck.eqCalls.length === 0);

  // Full duration.
  env.setTime(8000);
  env.tickInterval();
  assertOk("crossfade: progress reaches 1 at completion", progressSamples[progressSamples.length - 1] === 1);
  assertOk("crossfade: fromDeck paused on completion", fromDeck.paused === true);
  assertOk("crossfade: fromDeck gain reset to 1 (coherent state) after pause", fromDeck.gain === 1);
  assertOk("crossfade: toDeck at full gain on completion", toDeck.gain === 1);
  assertOk("crossfade: onDone reports liveDeck 'to'", done !== null && done.liveDeck === "to");
  assertOk("crossfade: onDone reports not clamped (in-range bpm match)", done.clamped === false);
  assertOk("crossfade: onDone reports the requested transition kind", done.transition === "beatmatch_crossfade");
  assertOk("crossfade: onDone reports not degraded", done.degraded === false && done.degradeReason === undefined);
  assertOk("crossfade: drift interval torn down on completion", env.hasInterval === false);
}

// --- tempo clamp reporting + auto-degrade ---
{
  const engine = createTransitionEngine();
  const env = makeFakeEnv();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  let done = null;

  // fromBpm 90 -> toBpm 120 requires tempo 0.75 (90/120), well outside the
  // default +-8% range: must clamp, and the transition still proceeds.
  // Deliberately NOT 90-vs-180 (an exact double-time pair, which the
  // half/double matching added by the owner soundcheck fix would now lock
  // at ~1.0 unclamped, defeating the point of this test) — 90/120 is a
  // genuine hard mismatch at every multiplier (1x needs 0.75, 2x needs
  // 0.375, 0.5x needs 1.5 — 1x stays closest), so it still clamps exactly
  // like before.
  engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 90,
    toBpm: 120,
    fromGrid: { anchor: 0, bpm: 90, estimated: false },
    toGrid: { anchor: 0, bpm: 120, estimated: false },
    durationBars: 4,
    transition: "cut",
    onDone: (r) => (done = r),
  });

  assertOk("clamp: toDeck tempo clamped to the +-8% range", approxEqual(toDeck.tempo, 0.92, 1e-9));
  assertOk("clamp: onDone reports clamped true", done !== null && done.clamped === true);
  assertOk("clamp: cut is exempt from auto-degrade", done.degraded === false && done.degradeReason === undefined);
}

// --- auto-degrade on clamp: beatmatch_crossfade shortens to 8 bars ---
{
  const engine = createTransitionEngine();
  const env = makeFakeEnv();
  // fromBpm 90 tempo 1 -> effective 90; toBpm 120 needs tempo 0.75, clamps to
  // 0.92 (same 90/120 pair as the clamp test above — see its comment for why
  // this stays a genuine hard mismatch under half/double matching).
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  let done = null;
  const progressSamples = [];

  engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 90,
    toBpm: 120,
    fromGrid: null,
    toGrid: null,
    durationBars: 32, // would be a long blend — degrade should shorten to 8
    now: env.now,
    setIntervalFn: env.setIntervalFn,
    clearIntervalFn: env.clearIntervalFn,
    setTimeoutFn: env.setTimeoutFn,
    clearTimeoutFn: env.clearTimeoutFn,
    onGain: (p) => progressSamples.push(p),
    onDone: (r) => (done = r),
  });

  // Expected shortened duration: 8 bars * 4 beats / 90 effective bpm * 60 = 21.333...s
  const expectedDurationSeconds = (8 * 4 * 60) / 90;
  env.setTime(expectedDurationSeconds * 1000);
  env.tickInterval();

  assertOk("degrade: completes at the SHORTENED (8-bar) duration, not the requested 32 bars", done !== null);
  assertOk("degrade: onDone reports degraded true", done.degraded === true);
  assertOk(
    "degrade: degradeReason mentions clamped + the shortened bar count",
    typeof done.degradeReason === "string" && done.degradeReason.includes("clamped") && done.degradeReason.includes("8 bars")
  );

  // Confirm it did NOT run the full 32-bar duration: at the (much earlier)
  // 8-bar mark progress must already be essentially 1, not still ramping.
  const last = progressSamples[progressSamples.length - 1];
  assertOk("degrade: progress reached 1 at the shortened mark", last === 1);
}

// --- degrade does not fire when not clamped ---
{
  const engine = createTransitionEngine();
  const env = makeFakeEnv();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  let done = null;

  engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 124, // within +-8%, no clamp
    fromGrid: null,
    toGrid: null,
    durationBars: 16,
    transition: "bass_swap",
    now: env.now,
    setIntervalFn: env.setIntervalFn,
    clearIntervalFn: env.clearIntervalFn,
    setTimeoutFn: env.setTimeoutFn,
    clearTimeoutFn: env.clearTimeoutFn,
    onDone: (r) => (done = r),
  });

  env.setTime(999999); // any large time — no drift interval since grids are null, only the main tick matters
  env.tickInterval();
  assertOk("no-degrade: bass_swap in-range bpm -> degraded false", done !== null && done.degraded === false);
  assertOk("no-degrade: no degradeReason", done.degradeReason === undefined);
}

// --- bass_swap: EQ swap fires at the halfway point, not before, and resets on finish ---
{
  const engine = createTransitionEngine();
  const env = makeFakeEnv();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  let done = null;

  engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 120,
    fromGrid: gridA,
    toGrid: gridB,
    durationBars: 4, // 8s duration
    transition: "bass_swap",
    now: env.now,
    setIntervalFn: env.setIntervalFn,
    clearIntervalFn: env.clearIntervalFn,
    setTimeoutFn: env.setTimeoutFn,
    clearTimeoutFn: env.clearTimeoutFn,
    onDone: (r) => (done = r),
  });

  // Choir round #2 (P3): the INCOMING deck's low is killed immediately at
  // start, before any ramp ticks — fixes "two basslines fighting for the
  // first half" (toDeck used to keep whatever low-EQ it already had until
  // the halfway swap).
  assertOk("bass_swap (P3): toDeck's low killed immediately at transition start", toDeck.eq.low === -40);
  assertOk("bass_swap (P3): fromDeck's low untouched at start (only toDeck kills up front)", fromDeck.eqCalls.length === 0);

  // Just before halfway: fromDeck still untouched, toDeck still at the start kill (no swap yet).
  env.setTime(3000);
  env.tickInterval();
  assertOk("bass_swap: no EQ swap before halfway", fromDeck.eqCalls.length === 0 && toDeck.eq.low === -40);

  // At/after halfway: EQ swap fires exactly once.
  env.setTime(4000);
  env.tickInterval();
  assertOk("bass_swap: fromDeck low killed at halfway", fromDeck.eq.low === -40);
  assertOk("bass_swap: toDeck low opened at halfway", toDeck.eq.low === 0);
  assertOk("bass_swap: fromDeck EQ call happened exactly once", fromDeck.eqCalls.filter((c) => c.low !== undefined).length === 1);

  // Later ticks before completion: swap does not fire again.
  env.setTime(6000);
  env.tickInterval();
  assertOk("bass_swap: EQ swap only fires once", fromDeck.eqCalls.filter((c) => c.low !== undefined).length === 1);

  // Completion: both decks' low reset to flat.
  env.setTime(8000);
  env.tickInterval();
  assertOk("bass_swap: onDone fired", done !== null && done.transition === "bass_swap");
  assertOk("bass_swap: fromDeck low reset to flat on finish", fromDeck.eq.low === 0);
  assertOk("bass_swap: toDeck low reset to flat on finish", toDeck.eq.low === 0);
}

// --- bass_swap: cancel() mid-ramp restores both decks' EQ to neutral (choir round #2, C2 + P3) ---
{
  const engine = createTransitionEngine();
  const env = makeFakeEnv();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });

  engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 120,
    fromGrid: gridA,
    toGrid: gridB,
    durationBars: 4,
    transition: "bass_swap",
    now: env.now,
    setIntervalFn: env.setIntervalFn,
    clearIntervalFn: env.clearIntervalFn,
    setTimeoutFn: env.setTimeoutFn,
    clearTimeoutFn: env.clearTimeoutFn,
  });

  // Cancel BEFORE the halfway swap — toDeck's low is already killed (P3's
  // start-of-transition kill) and must be restored to flat, not left dead.
  env.setTime(2000);
  env.tickInterval();
  assertOk("bass_swap cancel (pre-halfway): toDeck's low is killed going in", toDeck.eq.low === -40);
  const canceled = engine.cancel();
  assertOk("bass_swap cancel: cancel() reports it actually canceled something", canceled === true);
  assertOk("bass_swap cancel: engine no longer running", engine.isRunning === false);
  assertOk("bass_swap cancel: toDeck's low restored to flat, not left killed", toDeck.eq.low === 0);
  assertOk("bass_swap cancel: fromDeck's low stays flat too", fromDeck.eq.low === 0);
  assertOk("bass_swap cancel: the gain-ramp interval is torn down", env.hasInterval === false);
  assertOk("bass_swap cancel: a second cancel() is a safe no-op", engine.cancel() === false);
}

// --- echo_out: delay/feedback/wet-ramp/cut sequence ---
{
  const engine = createTransitionEngine();
  const env = makeFakeEnv();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 5 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  let done = null;
  const progressSamples = [];

  const outcome = engine.runTransition({
    fromDeck,
    toDeck,
    // 120 vs 150 — a big jump requiring tempo 0.8 (clamps), exactly the
    // scenario echo_out is the escape hatch for. Deliberately NOT 120-vs-200
    // (too close to an exact 5:3-ish neighbor of a half/double candidate —
    // 150 keeps 1x the clear winner: 1x needs 0.8, 2x needs 0.4, 0.5x needs
    // 1.6 — 1x stays closest at every multiplier).
    fromBpm: 120,
    toBpm: 150,
    fromGrid: gridA,
    toGrid: { anchor: 0, bpm: 150, estimated: false },
    durationBars: 16,
    transition: "echo_out",
    now: env.now,
    setIntervalFn: env.setIntervalFn,
    clearIntervalFn: env.clearIntervalFn,
    setTimeoutFn: env.setTimeoutFn,
    clearTimeoutFn: env.clearTimeoutFn,
    onGain: (p) => progressSamples.push(p),
    onDone: (r) => (done = r),
  });

  assertOk("echo_out: starts", outcome.started === true);
  assertOk("echo_out: toDeck still tempo-synced even though it's a big jump", toDeck.tempoSets.length === 1);
  assertOk("echo_out: toDeck does NOT start playing immediately", toDeck.playing === false);
  assertOk("echo_out: toDeck not phase-snapped yet", toDeck.seeks.length === 0);
  assertOk("echo_out: echoTail armed on fromDeck exactly once", fromDeck.echoTailCalls.length === 1);
  const echoCall = fromDeck.echoTailCalls[0];
  assertOk("echo_out: echoTail's effectiveBpm = fromBpm * fromDeck.tempo", approxEqual(echoCall.effectiveBpm, 120, 1e-9));
  assertOk("echo_out: echoTail's beats = 0.75 (dotted feel, the delay's own repeat interval)", echoCall.beats === 0.75);
  assertOk("echo_out: echoTail's feedback", echoCall.feedback === 0.55);
  assertOk("echo_out: echoTail's wetLevel is capped to the pro rule (<=0.4)", echoCall.wetLevel <= 0.4 && echoCall.wetLevel > 0);
  // ringSeconds = delayTime(0.75 beat @ 120bpm = 0.375s) * DEFAULT_ECHO_RING_REPEATS(3) = 1.125s
  assertOk("echo_out: ringSeconds = 3 repeats of the 0.375s delay interval", approxEqual(echoCall.ringSeconds, 1.125, 1e-9));
  assertOk("echo_out: onGain(0) reported at start", progressSamples[0] === 0);
  assertOk("echo_out: no normal equal-power gain ramp — no interval scheduled", env.hasInterval === false);
  assertOk("echo_out: not yet done", done === null);

  // Fire the dry-cut timeout (choir round #2, C1: ECHO_CUT_BEATS=1 — one
  // BEAT @120bpm = 0.5s later, strictly BEFORE the 1.125s ring window ends,
  // so the tail keeps ringing audibly past the cut; was 4 beats/2s pre-fix,
  // which finished the whole transition AFTER the ring had already faded
  // to silence — see scripts/check-fx-sends.mjs's dedicated production-
  // values assertion for the timeline math itself). fromDeck cuts, toDeck
  // phase-snaps and plays — the echo TAIL itself (armed above, ringing for
  // another ~0.625s beyond this cut) is now entirely Deck.echoTail's own
  // internally-scheduled responsibility, not transition.ts's — nothing
  // further to observe on the fake deck here, by design (see deck.ts, no
  // browser AudioContext available in this environment to verify the real
  // ramp-down/stop sequence, same standing caveat as every other real-node
  // Deck method).
  env.fireTimeout();
  assertOk("echo_out: fromDeck paused one beat after echo armed (0.5s @ 120bpm) — strictly before the ring finishes", fromDeck.paused === true);
  assertOk("echo_out: fromDeck dry gain set to 0 (not the usual 1) so only the tail remains audible", fromDeck.gain === 0);
  assertOk("echo_out: toDeck phase-snapped right before it plays", toDeck.seeks.length === 1);
  assertOk("echo_out: toDeck at full gain", toDeck.gain === 1);
  assertOk("echo_out: toDeck now playing", toDeck.playing === true);
  assertOk("echo_out: onGain(1) reported at the end", progressSamples[progressSamples.length - 1] === 1);
  assertOk("echo_out: onDone fired with liveDeck 'to'", done !== null && done.liveDeck === "to" && done.transition === "echo_out");
  assertOk("echo_out: onDone reports not degraded (echo_out is exempt)", done.degraded === false);
  assertOk("echo_out: echoTail still only called once (the dry cut doesn't re-arm it)", fromDeck.echoTailCalls.length === 1);

  // Re-derive the phase-snap: after the snap, toDeck's phase should match fromDeck's.
  const phaseFrom = beatPhase(fromDeck.positionSeconds, gridA.anchor, gridA.bpm);
  const phaseTo = beatPhase(toDeck.positionSeconds, 0, 150);
  assertOk("echo_out: phase-snap actually re-aligns beats", approxEqual(phaseFrom, phaseTo, 1e-6));
}

// --- echo_out: cancel() before the dry-cut timeout fires tears it down (choir round #2, C2) ---
{
  const engine = createTransitionEngine();
  const env = makeFakeEnv();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 5 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });

  const outcome = engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 120,
    fromGrid: gridA,
    toGrid: gridB,
    durationBars: 16,
    transition: "echo_out",
    now: env.now,
    setIntervalFn: env.setIntervalFn,
    clearIntervalFn: env.clearIntervalFn,
    setTimeoutFn: env.setTimeoutFn,
    clearTimeoutFn: env.clearTimeoutFn,
  });
  assertOk("echo_out cancel: starts, ring armed, dry-cut timeout pending", outcome.started === true && env.hasTimeout === true);

  const canceled = engine.cancel();
  assertOk("echo_out cancel: cancel() reports true", canceled === true);
  assertOk("echo_out cancel: engine no longer running", engine.isRunning === false);
  assertOk("echo_out cancel: the pending dry-cut timeout is torn down", env.hasTimeout === false);
  assertOk("echo_out cancel: toDeck never started (the canceled timeout never fired)", toDeck.playing === false);

  // The now-dead timeout firing anyway (e.g. a real setTimeout that already
  // queued before cancel ran) must be a no-op — cleared from the fake env's
  // own map means fireTimeout() has nothing left to call.
  env.fireTimeout();
  assertOk("echo_out cancel: a stray late fire is a no-op (fromDeck still not paused)", fromDeck.paused === false);
  assertOk("echo_out cancel: a fresh transition can start after cancel", engine.runTransition({ fromDeck, toDeck, fromBpm: 120, toBpm: 120, fromGrid: gridA, toGrid: gridB, durationBars: 4, transition: "cut" }).started === true);
}

// --- mid-transition drift correction: fires when grids are real and not clamped ---
{
  const engine = createTransitionEngine();
  const env = makeFakeEnv();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  // toDeck deliberately NOT phase-perfect after the initial snap — simulate
  // accumulated drift by nudging it slightly right after start.
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });

  engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 120,
    fromGrid: gridA,
    toGrid: gridB,
    durationBars: 64, // long ramp so the drift interval has time to matter
    now: env.now,
    setIntervalFn: env.setIntervalFn,
    clearIntervalFn: env.clearIntervalFn,
    setTimeoutFn: env.setTimeoutFn,
    clearTimeoutFn: env.clearTimeoutFn,
  });

  assertOk("drift: interval scheduled for real, unclamped grids", env.intervalCount === 2);
  const seeksBeforeDrift = toDeck.seeks.length;

  // Introduce >25ms-equivalent drift by hand (0.05s source-seconds, well
  // over the 25ms threshold at tempo 1) and fire the drift interval.
  toDeck.positionSeconds += 0.05;
  env.tickDriftInterval();
  assertOk("drift: correction seeks toDeck when offset exceeds the 25ms threshold", toDeck.seeks.length > seeksBeforeDrift);

  // Re-verify it actually re-aligns phase.
  const phaseFrom = beatPhase(fromDeck.positionSeconds, gridA.anchor, gridA.bpm);
  const phaseTo = beatPhase(toDeck.positionSeconds, gridB.anchor, gridB.bpm);
  assertOk("drift: correction re-aligns phase", approxEqual(phaseFrom, phaseTo, 1e-6));

  // Tiny (<25ms) drift should NOT trigger a correction.
  const seeksBeforeTiny = toDeck.seeks.length;
  toDeck.positionSeconds += 0.005; // 5ms — under threshold
  env.tickDriftInterval();
  assertOk("drift: sub-threshold offset does not trigger a correction", toDeck.seeks.length === seeksBeforeTiny);
}

// --- mid-transition drift correction: does NOT fire when clamped ---
{
  const engine = createTransitionEngine();
  const env = makeFakeEnv();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });

  engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 90,
    toBpm: 120, // forces a clamp (same 90/120 hard-mismatch pair as above — immune to half/double rescue)
    fromGrid: { anchor: 0, bpm: 90, estimated: false },
    toGrid: { anchor: 0, bpm: 120, estimated: false },
    durationBars: 64,
    now: env.now,
    setIntervalFn: env.setIntervalFn,
    clearIntervalFn: env.clearIntervalFn,
    setTimeoutFn: env.setTimeoutFn,
    clearTimeoutFn: env.clearTimeoutFn,
  });

  assertOk("drift: NOT scheduled when the tempo-sync clamped", env.intervalCount === 1);
}

// --- mid-transition drift correction: does NOT fire with an estimated grid ---
{
  const engine = createTransitionEngine();
  const env = makeFakeEnv();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });

  engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 120,
    fromGrid: { anchor: 0, bpm: 120, estimated: true }, // anchor-0 fallback, not a real Serato grid
    toGrid: gridB,
    durationBars: 64,
    now: env.now,
    setIntervalFn: env.setIntervalFn,
    clearIntervalFn: env.clearIntervalFn,
    setTimeoutFn: env.setTimeoutFn,
    clearTimeoutFn: env.clearTimeoutFn,
  });

  assertOk("drift: NOT scheduled when either grid is estimated", env.intervalCount === 1);
}

// --- mid-transition drift correction: does NOT fire with a missing grid ---
{
  const engine = createTransitionEngine();
  const env = makeFakeEnv();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });

  engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 120,
    fromGrid: null,
    toGrid: gridB,
    durationBars: 64,
    now: env.now,
    setIntervalFn: env.setIntervalFn,
    clearIntervalFn: env.clearIntervalFn,
    setTimeoutFn: env.setTimeoutFn,
    clearTimeoutFn: env.clearTimeoutFn,
  });

  assertOk("drift: NOT scheduled when a grid is missing", env.intervalCount === 1);
}

// --- half/double-time match: toGrid.bpm gets multiplier-adjusted for
// phase-snap (owner soundcheck fix, 2026-07-26) — a dembow-tagged 86bpm
// track syncing against a 172bpm deck locks at double-time (multiplier 2,
// tempo ~1.0, unclamped), and the phase-snap must align on the SAME shared
// pulse (86*2=172), not toDeck's raw tag. ---
{
  const engine = createTransitionEngine();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 5 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 2 });
  let done = null;

  const outcome = engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 172,
    toBpm: 86, // exactly half of fromBpm's tag -> should lock at 2x (double-time)
    fromGrid: { anchor: 0, bpm: 172, estimated: false },
    toGrid: { anchor: 0, bpm: 86, estimated: false },
    durationBars: 8,
    transition: "cut",
    onDone: (r) => (done = r),
  });

  assertOk("half/double: starts and completes", outcome.started === true && done !== null);
  assertOk(
    "half/double: locks at ~1.0 tempo (double-time), not clamped",
    done.clamped === false && approxEqual(toDeck.tempo, 1, 1e-6)
  );
  // Re-derive: the phase-snap must have used toGrid.bpm * 2 (172), the
  // shared pulse — not toDeck's raw tagged 86 — so phase computed at 172 on
  // BOTH sides should now match.
  const phaseFrom = beatPhase(fromDeck.positionSeconds, 0, 172);
  const phaseToAtSharedPulse = beatPhase(toDeck.positionSeconds, 0, 172);
  assertOk(
    "half/double: phase-snap aligns on the multiplier-adjusted shared pulse (86*2=172)",
    approxEqual(phaseFrom, phaseToAtSharedPulse, 1e-6)
  );
}

// --- cut: instant switch, no fade, phase-starts if grids allow ---
{
  const engine = createTransitionEngine();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 5 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  let done = null;

  const outcome = engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 128,
    fromGrid: gridA,
    toGrid: { anchor: 0, bpm: 128, estimated: false },
    durationBars: 8,
    transition: "cut",
    onDone: (r) => (done = r),
  });

  assertOk("cut: starts and completes synchronously", outcome.started === true && done !== null);
  assertOk("cut: toDeck at full gain", toDeck.gain === 1);
  assertOk("cut: fromDeck at zero gain before pause-reset, then reset to 1", fromDeck.gain === 1);
  assertOk("cut: fromDeck paused", fromDeck.paused === true);
  assertOk("cut: toDeck playing", toDeck.playing === true);
  assertOk("cut: liveDeck reported as 'to'", done.liveDeck === "to");
  assertOk("cut: transition kind echoed back", done.transition === "cut");
  assertOk("cut: phase-snap attempted since both grids present", toDeck.seeks.length === 1);
  // Re-derive: after the snap, toDeck's phase should match fromDeck's phase (accounting for the tempo change).
  const phaseFrom = beatPhase(fromDeck.positionSeconds, gridA.anchor, gridA.bpm);
  const phaseTo = beatPhase(toDeck.positionSeconds, 0, 128);
  assertOk("cut: phase-snap actually re-aligns beats", approxEqual(phaseFrom, phaseTo, 1e-6));
}

// --- no grid on either side: phase-snap skipped, transition still proceeds ---
{
  const engine = createTransitionEngine();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 5 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  let done = null;

  engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 120,
    fromGrid: null,
    toGrid: null,
    durationBars: 4,
    transition: "cut",
    onDone: (r) => (done = r),
  });

  assertOk("no grid: phase-snap skipped (no seek)", toDeck.seeks.length === 0);
  assertOk("no grid: transition still completes", done !== null && done.liveDeck === "to");
}

// --- gap: waits for fromDeck's natural end, no overlap, no phase-snap ---
{
  const engine = createTransitionEngine();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 5 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  // fromDeck represents the currently-LIVE deck this "gap" is waiting on —
  // choir round #2 (C2)'s already-ended guard checks fromDeck.playing, so
  // this scenario (the normal case) needs it explicitly marked playing.
  fromDeck.playing = true;
  let done = null;
  const progressSamples = [];

  const outcome = engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 124,
    fromGrid: gridA,
    toGrid: { anchor: 0, bpm: 124, estimated: false },
    durationBars: 16,
    transition: "gap",
    onGain: (p) => progressSamples.push(p),
    onDone: (r) => (done = r),
  });

  assertOk("gap: starts", outcome.started === true);
  assertOk("gap: engine reports running while waiting for the natural end", engine.isRunning === true);
  assertOk("gap: toDeck does NOT start playing immediately", toDeck.playing === false);
  assertOk("gap: toDeck NOT phase-snapped (nothing to align against a fresh start)", toDeck.seeks.length === 0);
  assertOk("gap: onGain(0) reported at start", progressSamples[0] === 0);
  assertOk("gap: not yet done", done === null);

  // A second call must still be rejected while the gap is pending.
  const second = engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 124,
    fromGrid: gridA,
    toGrid: { anchor: 0, bpm: 124, estimated: false },
    durationBars: 16,
  });
  assertOk("gap: guard rejects a second call while pending", second.started === false);

  // fromDeck's track finishes on its own (real DJ-app event, not a timer).
  fromDeck.fireEnded();
  assertOk("gap: fromDeck paused once its track naturally ends", fromDeck.paused === true);
  assertOk("gap: toDeck starts plainly at full gain, no ramp", toDeck.gain === 1 && toDeck.playing === true);
  assertOk("gap: still no phase-snap even after the start", toDeck.seeks.length === 0);
  assertOk("gap: onGain(1) reported once toDeck starts", progressSamples[progressSamples.length - 1] === 1);
  assertOk("gap: onDone fires with liveDeck 'to', not degraded", done !== null && done.liveDeck === "to" && done.transition === "gap" && done.degraded === false);
  assertOk("gap: engine no longer running after completion", engine.isRunning === false);

  const third = engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 124,
    fromGrid: gridA,
    toGrid: { anchor: 0, bpm: 124, estimated: false },
    durationBars: 16,
  });
  assertOk("gap: a new transition can start once the gap has completed", third.started === true);
}

// --- gap: fromDeck already NOT playing when the call arrives -> starts toDeck immediately rather than waiting forever (choir round #2, C2, "already ended before subscribe") ---
{
  const engine = createTransitionEngine();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 180 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  fromDeck.playing = false; // the "wait" condition is already satisfied — the track already ended (or never started)
  let done = null;

  const outcome = engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 124,
    fromGrid: gridA,
    toGrid: { anchor: 0, bpm: 124, estimated: false },
    durationBars: 16,
    transition: "gap",
    onDone: (r) => (done = r),
  });

  assertOk("gap (already ended): starts immediately", outcome.started === true);
  assertOk("gap (already ended): toDeck starts right away, no onEnded wait", toDeck.playing === true && toDeck.gain === 1);
  assertOk("gap (already ended): onDone fires synchronously, not wedged waiting", done !== null && done.transition === "gap");
  assertOk("gap (already ended): engine no longer running", engine.isRunning === false);
}

// --- gap: cancel() while pending unwedges the engine — the concrete C2 bug (a manual pause mid-wait means onEnded never fires again) ---
{
  const engine = createTransitionEngine();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 90 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  fromDeck.playing = true;

  const outcome = engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 124,
    fromGrid: gridA,
    toGrid: { anchor: 0, bpm: 124, estimated: false },
    durationBars: 16,
    transition: "gap",
  });
  assertOk("gap cancel: starts, waiting on the natural end", outcome.started === true && engine.isRunning === true);

  // The DJ manually pauses fromDeck mid-wait — its own onEnded will NEVER
  // fire again (the track didn't end, the DJ stopped it), so without
  // cancel() `running` would stay true forever (the pre-fix bug).
  fromDeck.pause();
  const canceled = engine.cancel();
  assertOk("gap cancel: cancel() reports it actually canceled something", canceled === true);
  assertOk("gap cancel: engine no longer running — unwedged", engine.isRunning === false);
  assertOk("gap cancel: toDeck never started", toDeck.playing === false);

  // The track's own onEnded firing LATE (e.g. a stray real event) after
  // cancel must be a no-op — the listener was unsubscribed.
  fromDeck.fireEnded();
  assertOk("gap cancel: a stray late onEnded after cancel is a no-op (toDeck still not started)", toDeck.playing === false);
  assertOk("gap cancel: a fresh transition can start after cancel", engine.runTransition({ fromDeck, toDeck, fromBpm: 120, toBpm: 124, fromGrid: gridA, toGrid: { anchor: 0, bpm: 124, estimated: false }, durationBars: 4, transition: "cut" }).started === true);
}

// --- cancel(): a safe no-op when nothing is running ---
{
  const engine = createTransitionEngine();
  assertOk("cancel(): no-op when nothing is running", engine.cancel() === false);
}

// --- loop_blend: duck the outgoing deck fully, fade the incoming deck in over the loop, exit on "the final 1" ---
{
  const engine = createTransitionEngine();
  const env = makeFakeEnv();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 40 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  const progressSamples = [];
  let done = null;
  let startCalls = 0;
  let endCalls = 0;

  const loopBlend = { loopStart: 32, loopEnd: 40, totalDurationSeconds: 8 }; // 16 beats @120bpm = 8s

  const outcome = engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 120,
    fromGrid: gridA,
    toGrid: gridB,
    durationBars: 16,
    transition: "loop_blend",
    loopBlend,
    now: env.now,
    setIntervalFn: env.setIntervalFn,
    clearIntervalFn: env.clearIntervalFn,
    setTimeoutFn: env.setTimeoutFn,
    clearTimeoutFn: env.clearTimeoutFn,
    onLoopBlendStart: () => startCalls++,
    onLoopBlendEnd: () => endCalls++,
    onGain: (p) => progressSamples.push(p),
    onDone: (r) => (done = r),
  });

  assertOk("loop_blend: starts", outcome.started === true);
  assertOk("loop_blend: fromDeck ducked fully (gain 0) immediately — the loop overlay replaces it", fromDeck.gain === 0);
  assertOk("loop_blend: fromDeck NOT paused yet (still advancing under the loop until the final 1)", fromDeck.paused === false);
  assertOk("loop_blend: onLoopBlendStart fired exactly once, immediately", startCalls === 1);
  assertOk("loop_blend: toDeck starts muted then plays (fades in over the loop)", toDeck.gain === 0 && toDeck.playing === true);
  assertOk("loop_blend: no phase-snap (nothing to align — fromDeck is silent)", toDeck.seeks.length === 0);
  assertOk("loop_blend: onGain(0) reported at start", progressSamples[0] === 0);
  assertOk("loop_blend: onLoopBlendEnd not fired yet", endCalls === 0);
  assertOk("loop_blend: not yet done", done === null);

  // Halfway through the 8s blend: toDeck should be partway up the equal-power curve, fromDeck still silent and NOT paused.
  env.setTime(4000);
  env.tickInterval();
  assertOk("loop_blend: toDeck gain rising mid-blend", toDeck.gain > 0 && toDeck.gain < 1);
  assertOk("loop_blend: fromDeck stays silent and un-paused mid-blend (still under the loop overlay)", fromDeck.gain === 0 && fromDeck.paused === false);
  assertOk("loop_blend: onLoopBlendEnd still not fired mid-blend", endCalls === 0);

  // "The final 1" — the full 8s has elapsed.
  env.setTime(8000);
  env.tickInterval();
  assertOk("loop_blend: onLoopBlendEnd fired exactly once at completion", endCalls === 1);
  assertOk("loop_blend: toDeck at full gain", toDeck.gain === 1);
  assertOk("loop_blend: fromDeck paused and gain reset to 1 for reuse", fromDeck.paused === true && fromDeck.gain === 1);
  assertOk("loop_blend: onGain(1) reported at the end", progressSamples[progressSamples.length - 1] === 1);
  assertOk("loop_blend: onDone fired with liveDeck 'to', not degraded", done !== null && done.liveDeck === "to" && done.transition === "loop_blend" && done.degraded === false);
  assertOk("loop_blend: engine no longer running after completion", engine.isRunning === false);
}

// --- loop_blend: cancel() mid-blend stops the loop overlay too, not just the interval (choir round #2, C2) ---
{
  const engine = createTransitionEngine();
  const env = makeFakeEnv();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 40 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });
  let endCalls = 0;

  const loopBlend = { loopStart: 32, loopEnd: 40, totalDurationSeconds: 8 };

  const outcome = engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 120,
    fromGrid: gridA,
    toGrid: gridB,
    durationBars: 16,
    transition: "loop_blend",
    loopBlend,
    now: env.now,
    setIntervalFn: env.setIntervalFn,
    clearIntervalFn: env.clearIntervalFn,
    setTimeoutFn: env.setTimeoutFn,
    clearTimeoutFn: env.clearTimeoutFn,
    onLoopBlendEnd: () => endCalls++,
  });
  assertOk("loop_blend cancel: starts", outcome.started === true);

  env.setTime(3000);
  env.tickInterval();
  assertOk("loop_blend cancel: mid-blend, loop overlay still running (onLoopBlendEnd not yet fired)", endCalls === 0);

  const canceled = engine.cancel();
  assertOk("loop_blend cancel: cancel() reports true", canceled === true);
  assertOk("loop_blend cancel: engine no longer running", engine.isRunning === false);
  assertOk(
    "loop_blend cancel: onLoopBlendEnd fired by cancel() — the native loop overlay must stop, not keep looping forever",
    endCalls === 1
  );
  assertOk("loop_blend cancel: the blend interval is torn down", env.hasInterval === false);
}

// --- loop_blend: a missing/degenerate plan fails the start cleanly (never mis-times an unsnapped loop) ---
{
  const engine = createTransitionEngine();
  const fromDeck = new FakeDeck({ tempo: 1, positionSeconds: 5 });
  const toDeck = new FakeDeck({ tempo: 1, positionSeconds: 0 });

  const noPlan = engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 120,
    fromGrid: gridA,
    toGrid: gridB,
    durationBars: 16,
    transition: "loop_blend",
    // no loopBlend supplied
  });
  assertOk("loop_blend: missing plan fails the start, not a silent no-op", noPlan.started === false && typeof noPlan.reason === "string");
  assertOk("loop_blend: engine not left stuck 'running' after a failed start", engine.isRunning === false);

  const zeroDuration = engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 120,
    fromGrid: gridA,
    toGrid: gridB,
    durationBars: 16,
    transition: "loop_blend",
    loopBlend: { loopStart: 0, loopEnd: 8, totalDurationSeconds: 0 },
  });
  assertOk("loop_blend: zero-duration plan also fails the start", zeroDuration.started === false);
  assertOk("loop_blend: a fresh transition can start right after a failed loop_blend start", engine.runTransition({
    fromDeck,
    toDeck,
    fromBpm: 120,
    toBpm: 120,
    fromGrid: gridA,
    toGrid: gridB,
    durationBars: 4,
    transition: "cut",
  }).started === true);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all transition engine cases");
