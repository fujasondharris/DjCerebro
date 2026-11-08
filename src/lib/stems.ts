// M8.2 — the STEM PLAYER: loads a track's separated stems and plays them as one
// grid-locked, per-stem-gain-controlled source.
//
// This is the audio half of the migration. stem-migration.ts decides WHAT to fade and
// WHEN (as bars); this file makes it sound. Keeping them separate is what lets the
// craft rules be goldened without an AudioContext.
//
// HOW IT FITS THE EXISTING GRAPH. Each stem is an AudioBufferSourceNode -> its own
// GainNode -> a per-set GainNode -> core.master. Same master as the decks. Stems are
// fetched through /api/crate/[id] exactly like tracks — they are just more Drive files,
// so the proxy, passcode and abuse-retry logic all apply unchanged.
//
// ALL STEMS OF A SET START ON THE SAME AudioContext TIMESTAMP. That is the entire
// point: separated stems are sample-aligned copies of one performance, so a shared
// `start(when, offset)` keeps them phase-locked. Starting them one at a time as they
// decode would smear them by tens of milliseconds and the mix would sound flanged.
//
// PITCH — HONEST LIMITATION. Stems ride playbackRate for tempo, which pitch-shifts.
// That is acceptable for a short bridge and NOT acceptable for a migration measured
// in minutes (GOAL-M8-stems.md, M8.3). Until the PitchShifter path is done, callers
// should keep long migrations at tempo 1.0 (i.e. only migrate between tracks whose
// BPMs already match, or after a loop-covered tempo sweep has landed the deck there).
//
// PHONE COST. The caller retains only the two performance windows, under a shared
// byte budget. One complete stem is still decoded temporarily before cropping it;
// browser/decoder overhead and peak phone memory still need a real-device check.

import type { AudioCore } from "./audio-core";
import type { MigrationPlan, StemRamp } from "./stem-migration";
import { STEM_ROLE } from "./stem-migration.ts";

/** What stem-manifest.json records per track — mirrors scripts/make-stems.mjs output. */
export interface StemManifestEntry {
  name: string;
  model: string;
  /** stem name -> Drive file id (after upload) OR local relative path (before). */
  stems: Record<string, string>;
  dropped?: string[];
  compingLayer?: string[];
  loudness?: Record<string, { meanDb: number; silentPct: number }>;
}

export interface LoadedStem {
  name: string;
  buffer: AudioBuffer;
  source: AudioBufferSourceNode | null;
  gain: GainNode;
}

export interface StemSet {
  trackId: string;
  stems: Map<string, LoadedStem>;
  /** Per-set trim, so a whole set can be ducked or killed in one move. */
  setGain: GainNode;
  /** AudioContext time the set was started at, or null if not playing. */
  startedAt: number | null;
  /** Source-seconds offset the set was started from. */
  startOffset: number;
  playbackRate: number;
  /** The retained window's offset in the original track. */
  bufferOffset: number;
  decodedBytes: number;
}

export type StemFetcher = (fileId: string) => Promise<ArrayBuffer>;

/**
 * Load every stem for a track. Decodes sequentially; resolves when ALL are ready, so a
 * partially-loaded set is never handed back (playing 4 of 6 stems is not "the track").
 */
export async function loadStemSet(
  core: AudioCore,
  trackId: string,
  entry: StemManifestEntry,
  fetchBytes: StemFetcher,
  options: { fromSeconds?: number; toSeconds?: number; signal?: AbortSignal; maxDecodedBytes?: number } = {},
): Promise<StemSet> {
  const ctx = core.ensureContext();
  const names = Object.keys(entry.stems);
  if (!names.length) throw new Error("Empty stem set");
  const offset = Math.max(0, options.fromSeconds ?? 0);
  const decoded: [string, AudioBuffer][] = [];
  let decodedBytes = 0;
  // Keep network latency out of the serial decode path. At most two compressed
  // downloads are ahead of decoding; decoded full tracks remain strictly
  // sequential, preserving the existing phone-memory budget. Every fetch has
  // a rejection handler immediately, including a prefetched file not yet used.
  const pending = new Map<number, Promise<{ bytes: ArrayBuffer; error?: never } | { error: unknown; bytes?: never }>>();
  const prefetch = (index: number) => {
    if (index >= names.length) return;
    pending.set(index, Promise.resolve().then(() => {
      options.signal?.throwIfAborted();
      return fetchBytes(entry.stems[names[index]]);
    }).then(bytes => ({ bytes }), error => ({ error })));
  };
  prefetch(0); prefetch(1);
  // Decode one file at a time, keep only the performance window, then release
  // the full-track buffer. Never retain twelve entire decoded tracks on a phone.
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    options.signal?.throwIfAborted();
    const fetched = await pending.get(index)!;
    pending.delete(index);
    if ("error" in fetched) throw fetched.error;
    options.signal?.throwIfAborted();
    prefetch(index + 2);
    const full = await ctx.decodeAudioData(fetched.bytes);
    options.signal?.throwIfAborted();
    const first = Math.round(offset * full.sampleRate);
    const last = Math.min(full.length, Math.ceil((options.toSeconds ?? full.duration) * full.sampleRate));
    if (last <= first) throw new Error(`Stem ${name} ends before its entry cue`);
    decodedBytes += (last - first) * full.numberOfChannels * 4;
    if (decodedBytes > (options.maxDecodedBytes ?? 320 * 1024 * 1024)) throw new Error("Stem preparation exceeds the decoded-audio budget; use a shorter move");
    const buffer = ctx.createBuffer(full.numberOfChannels, last - first, full.sampleRate);
    for (let channel = 0; channel < full.numberOfChannels; channel++) buffer.copyToChannel(full.getChannelData(channel).subarray(first, last), channel);
    decoded.push([name, buffer]);
  }

  const setGain = ctx.createGain();
  setGain.gain.value = 1;
  setGain.connect(core.master);

  const stems = new Map<string, LoadedStem>();
  for (const [name, buffer] of decoded) {
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(setGain);
    stems.set(name, { name, buffer, source: null, gain });
  }
  return { trackId, stems, setGain, startedAt: null, startOffset: 0, playbackRate: 1, bufferOffset: offset, decodedBytes };
}

/**
 * Start every stem in the set at ONE shared context time. `when` defaults to "now",
 * but callers doing a migration should pass the next phrase-boundary time so the set
 * lands on the "1" — the same phrase-alignment the decks already do.
 */
export function startStemSet(
  core: AudioCore,
  set: StemSet,
  opts: { offsetSeconds?: number; when?: number; playbackRate?: number; loopRhythmSeconds?: number } = {},
): void {
  const ctx = core.ensureContext();
  const rawWhen = opts.when ?? ctx.currentTime;
  const offset = opts.offsetSeconds ?? 0;
  const rate = opts.playbackRate ?? 1;
  if (![rawWhen, offset, rate].every(Number.isFinite) || rawWhen < 0 || rate <= 0 || offset < set.bufferOffset || Array.from(set.stems.values()).some(st => offset - set.bufferOffset >= st.buffer.duration)) throw new Error("Stem start is outside the prepared window");
  const when = Math.max(ctx.currentTime, rawWhen);
  stopStemSet(set);
  const relOffset = Math.max(0, offset - set.bufferOffset);
  for (const stem of Array.from(set.stems.values())) {
    const src = ctx.createBufferSource();
    src.buffer = stem.buffer;
    src.playbackRate.value = rate;
    const role = STEM_ROLE[stem.name];
    if (opts.loopRhythmSeconds && opts.loopRhythmSeconds > 0 && role !== "vocals") {
      const loopEnd = Math.min(stem.buffer.duration, relOffset + opts.loopRhythmSeconds);
      if (loopEnd - relOffset > 0.1) {
        src.loop = true;
        src.loopStart = relOffset;
        src.loopEnd = loopEnd;
      }
    }
    src.connect(stem.gain);
    src.start(when, relOffset);
    stem.source = src;
  }
  set.startedAt = when;
  set.startOffset = offset;
  set.playbackRate = rate;
}

/**
 * Loads and mixes the non-vocal stem roles needed for a vocal-free hook + bassline + beat loop.
 * Includes full `drums` (1.0) + `bass` (1.0) plus the track's active horn/harmony stems
 * (`other`, `guitar`, `piano` at 1.0 in "melody" mode and 0.85 in "beat" mode), with
 * `vocals` completely excluded so signature horn/synth hooks and basslines loop cleanly
 * with zero vocal clash. Returns null if the required stems are unavailable.
 */
export async function loadStemLoopMixBuffer(
  core: AudioCore,
  entry: StemManifestEntry,
  fetchBytes: StemFetcher,
  options: {
    isolation: "beat" | "melody";
    fromSeconds?: number;
    toSeconds?: number;
    signal?: AbortSignal;
    expectedTrackDuration?: number;
  }
): Promise<{ buffer: AudioBuffer; bufferOffset: number } | null> {
  const ctx = core.ensureContext();
  const activeHarmony = ["other", "guitar", "piano"].filter((name) => {
    if (!entry.stems[name]) return false;
    const stats = entry.loudness?.[name];
    if (stats && stats.silentPct >= 0.9 && !entry.compingLayer?.includes(name)) return false;
    return true;
  });
  const wantedNames = ["drums", "bass", ...activeHarmony].filter((name) => Boolean(entry.stems[name]));
  if (wantedNames.length === 0) return null;

  const offset = Math.max(0, options.fromSeconds ?? 0);
  let mixed: AudioBuffer | null = null;

  const pending = wantedNames.map((name) =>
    Promise.resolve()
      .then(() => {
        options.signal?.throwIfAborted();
        return fetchBytes(entry.stems[name]);
      })
      .then((bytes) => ({ name, bytes }))
  );

  for (const itemPromise of pending) {
    options.signal?.throwIfAborted();
    const { name, bytes } = await itemPromise;
    options.signal?.throwIfAborted();
    const full = await ctx.decodeAudioData(bytes);
    options.signal?.throwIfAborted();
    // Guard against synthetic test stubs where /api/crate/* returns a tiny dummy WAV
    // (<10s) for a full-length song (>30s), without rejecting trimmed or VBR stems.
    if (
      typeof options.expectedTrackDuration === "number" &&
      options.expectedTrackDuration > 30 &&
      full.duration < 10
    ) {
      return null;
    }
    const first = Math.round(offset * full.sampleRate);
    const last = Math.min(full.length, Math.ceil((options.toSeconds ?? full.duration) * full.sampleRate));
    if (last <= first) return null;
    const frameCount = last - first;
    if (!mixed) {
      mixed = ctx.createBuffer(full.numberOfChannels, frameCount, full.sampleRate);
    }
    const stemWeight =
      name === "drums" || name === "bass"
        ? 1.0
        : options.isolation === "beat"
          ? 0.85
          : 1.0;
    const channels = Math.min(mixed.numberOfChannels, full.numberOfChannels);
    const length = Math.min(mixed.length, frameCount);
    for (let ch = 0; ch < channels; ch++) {
      const dst = mixed.getChannelData(ch);
      const src = full.getChannelData(ch).subarray(first, first + length);
      for (let i = 0; i < length; i++) {
        dst[i] += src[i] * stemWeight;
      }
    }
  }
  if (mixed) {
    let peak = 0;
    for (let ch = 0; ch < mixed.numberOfChannels; ch++) {
      const data = mixed.getChannelData(ch);
      for (let i = 0; i < data.length; i++) {
        const abs = Math.abs(data[i]);
        if (abs > peak) peak = abs;
      }
    }
    if (peak > 0.92) {
      const scale = 0.92 / peak;
      for (let ch = 0; ch < mixed.numberOfChannels; ch++) {
        const data = mixed.getChannelData(ch);
        for (let i = 0; i < data.length; i++) {
          data[i] *= scale;
        }
      }
    }
  }
  return mixed ? { buffer: mixed, bufferOffset: offset } : null;
}

export function stopStemSet(set: StemSet): void {
  for (const stem of Array.from(set.stems.values())) {
    if (stem.source) {
      try { stem.source.stop(); } catch { /* already stopped */ }
      try { stem.source.disconnect(); } catch { /* already disconnected */ }
      stem.source = null;
    }
  }
  set.startedAt = null;
}

/** Free everything. Buffers are large; call this the moment a set is no longer needed. */
export function disposeStemSet(set: StemSet): void {
  stopStemSet(set);
  for (const stem of Array.from(set.stems.values())) {
    try { stem.gain.disconnect(); } catch { /* ignore */ }
  }
  try { set.setGain.disconnect(); } catch { /* ignore */ }
  set.stems.clear();
}

/** Set one stem's gain immediately (a pad-style mute/unmute). */
export function setStemGain(set: StemSet, stemName: string, value: number, at?: number, ctx?: AudioContext): void {
  const stem = set.stems.get(stemName);
  if (!stem) return;
  if (at !== undefined && ctx) {
    stem.gain.gain.setValueAtTime(value, at);
  } else {
    const nodeCtx = ctx ?? (stem.gain.context as AudioContext | undefined);
    if (nodeCtx && typeof stem.gain.gain.setTargetAtTime === "function") {
      stem.gain.gain.setTargetAtTime(value, nodeCtx.currentTime, 0.010);
    } else {
      stem.gain.gain.value = value;
    }
  }
}

/** Mute/unmute every stem of a ROLE (e.g. all harmony stems at once). */
export function setRoleGain(set: StemSet, role: string, value: number): void {
  for (const [name, stem] of Array.from(set.stems.entries())) {
    if (STEM_ROLE[name] === role) {
      const nodeCtx = stem.gain.context as AudioContext | undefined;
      if (nodeCtx && typeof stem.gain.gain.setTargetAtTime === "function") {
        stem.gain.gain.setTargetAtTime(value, nodeCtx.currentTime, 0.010);
      } else {
        stem.gain.gain.value = value;
      }
    }
  }
}

/**
 * Serato-style "Acapella" / "Instrumental" quick toggles, expressed on stems.
 * Acapella = vocals only. Instrumental = everything but vocals.
 */
export function setAcapella(set: StemSet, on: boolean): void {
  for (const [name, stem] of Array.from(set.stems.entries())) {
    const target = on ? (name === "vocals" ? 1 : 0) : 1;
    const nodeCtx = stem.gain.context as AudioContext | undefined;
    if (nodeCtx && typeof stem.gain.gain.setTargetAtTime === "function") {
      stem.gain.gain.setTargetAtTime(target, nodeCtx.currentTime, 0.010);
    } else {
      stem.gain.gain.value = target;
    }
  }
}
export function setInstrumental(set: StemSet, on: boolean): void {
  for (const [name, stem] of Array.from(set.stems.entries())) {
    const target = on ? (name === "vocals" ? 0 : 1) : 1;
    const nodeCtx = stem.gain.context as AudioContext | undefined;
    if (nodeCtx && typeof stem.gain.gain.setTargetAtTime === "function") {
      stem.gain.gain.setTargetAtTime(target, nodeCtx.currentTime, 0.010);
    } else {
      stem.gain.gain.value = target;
    }
  }
}

/**
 * Schedule a whole migration plan onto two live stem sets, using AudioParam
 * automation so the ramps run sample-accurately on the audio thread — nothing here
 * depends on JS timers. `startTime` is the AudioContext time bar 0 lands on; pass
 * the next phrase boundary.
 *
 * Every ramp is a linear gain change from fromGain to toGain between its bar
 * boundaries. Bars convert to seconds via plan.barSeconds — both sets MUST already
 * be running at the same effective BPM for that to hold (that is the caller's job;
 * this function does not tempo-sync).
 */
export function scheduleMigration(
  ctx: AudioContext,
  plan: MigrationPlan,
  outgoing: StemSet,
  incoming: StemSet,
  startTime: number,
): void {
  const unique = new Set<string>();
  for (const ramp of plan.ramps) {
    const key = `${ramp.deck}:${ramp.stem}`;
    if (unique.has(key)) throw new Error(`Conflicting gain schedules for ${key}`);
    unique.add(key);
  }
  const setFor = (deck: StemRamp["deck"]) => (deck === "out" ? outgoing : incoming);
  for (const ramp of plan.ramps) {
    const set = setFor(ramp.deck);
    const stem = set.stems.get(ramp.stem);
    if (!stem) continue; // that stem was dropped as blank for this track — nothing to ramp
    const t0 = startTime + ramp.fromBar * plan.barSeconds;
    const t1 = startTime + ramp.toBar * plan.barSeconds;
    const g = stem.gain.gain;
    g.cancelScheduledValues(startTime);
    g.setValueAtTime(ramp.fromGain, startTime);
    g.setValueAtTime(ramp.fromGain, t0);
    g.linearRampToValueAtTime(ramp.toGain, t1);
  }
  // Incoming stems that have NO ramp (e.g. the anchor deck's rhythm section when
  // anchor:"in") should be at full from bar 0; outgoing stems with no ramp hold at 1
  // and are killed at the end. Anything not mentioned by the plan gets a safe default.
  for (const [name, stem] of Array.from(incoming.stems.entries())) {
    if (!plan.ramps.some((r) => r.deck === "in" && r.stem === name)) {
      stem.gain.gain.setValueAtTime(1, startTime);
    }
  }
  const end = startTime + plan.totalBars * plan.barSeconds;
  for (const [name, stem] of Array.from(outgoing.stems.entries())) {
    if (!plan.ramps.some((r) => r.deck === "out" && r.stem === name)) {
      stem.gain.gain.setValueAtTime(1, startTime);
      stem.gain.gain.setValueAtTime(1, Math.max(startTime, end - 0.05));
      stem.gain.gain.linearRampToValueAtTime(0, end);
    }
  }
  // Dual-stem-set overlap headroom: summing two mastered songs' stems at unity
  // drives peaks ~+4..+6 dB above 0 dBFS. Trim both setGain nodes to 0.78 during
  // the two-track mashup overlap and ramp incoming setGain to 0.95 over the final
  // 4 bars so the handoff back to the full deck is seamless and unclipped.
  const resolveStart = Math.max(startTime, end - Math.min(4, plan.totalBars * 0.25) * plan.barSeconds);
  outgoing.setGain.gain.cancelScheduledValues(startTime);
  outgoing.setGain.gain.setValueAtTime(0.78, startTime);
  incoming.setGain.gain.cancelScheduledValues(startTime);
  incoming.setGain.gain.setValueAtTime(0.78, startTime);
  incoming.setGain.gain.setValueAtTime(0.78, resolveStart);
  incoming.setGain.gain.linearRampToValueAtTime(0.95, end);
}
