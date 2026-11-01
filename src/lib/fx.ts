// Polyphonic one-shot sound-effect player for DJ Supermercado's FX pad
// (airhorn/siren/riser/rewind/laser/brake/cheer) — Milestone 4 Part C,
// extended by the FX-upgrade and real-SFX-swap milestones. UI-free like the
// rest of src/lib/, follows the same DI pattern as Deck (constructed with a
// shared AudioCore). Plays straight to AudioCore.master, independent of
// either deck's own gain/EQ chain, since FX are deck-agnostic stingers, not
// part of either track's signal path (contrast src/lib/scratch.ts, which
// DOES route through a deck's own graph since a scratch should be affected
// by that deck's kill/EQ). airhorn/siren/rewind/brake/laser/cheer are real
// licensed recordings (see public/sfx/LICENSES.txt for provenance); riser is
// still the synthesized clip from scripts/make-sfx.mjs (build texture, no
// real-recording candidate needed). The old user-suppliable "tag" clip is
// retired from this module — "tag" is now a vocal-category name handled by
// src/lib/vocal.ts's manifest-backed rotation, not a single probed file.
import type { AudioCore } from "./audio-core";
import { runWithConcurrency } from "./concurrency.ts";

export type SfxName =
  | "airhorn"
  | "siren"
  | "riser"
  | "rewind"
  | "laser"
  | "brake"
  | "cheer"
  | "subdrop"
  | "crash"
  | "timbale"
  | "downlifter"
  | "dub_siren"
  | "horn_stab"
  | "cryo_jet"
  | "booyaka"
  | "gunshot";

const SFX_FILES: Record<SfxName, string> = {
  airhorn: "/sfx/airhorn.mp3",
  siren: "/sfx/siren.mp3",
  riser: "/sfx/riser.mp3",
  rewind: "/sfx/rewind.mp3",
  laser: "/sfx/laser.mp3",
  brake: "/sfx/brake.mp3",
  cheer: "/sfx/cheer.mp3",
  subdrop: "/sfx/subdrop.mp3",
  crash: "/sfx/crash.mp3",
  timbale: "/sfx/timbale.mp3",
  downlifter: "/sfx/downlifter.mp3",
  dub_siren: "/sfx/dub_siren.mp3",
  horn_stab: "/sfx/horn_stab.mp3",
  cryo_jet: "/sfx/cryo_jet.mp3",
  booyaka: "/sfx/booyaka.mp3",
  gunshot: "/sfx/gunshot.mp3",
};

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export class FxPlayer {
  private core: AudioCore;
  private buffers = new Map<SfxName, AudioBuffer>();
  private loading = new Map<SfxName, Promise<AudioBuffer>>();

  constructor(core: AudioCore) {
    this.core = core;
  }

  /** Fetches + decodes a clip on first use, caching the result; concurrent calls for the same name share one in-flight promise instead of double-fetching. */
  private async load(name: SfxName): Promise<AudioBuffer> {
    const cached = this.buffers.get(name);
    if (cached) return cached;
    const inFlight = this.loading.get(name);
    if (inFlight) return inFlight;

    const ctx = this.core.ensureContext();
    const promise = fetch(SFX_FILES[name])
      .then((res) => res.arrayBuffer())
      .then((arrayBuffer) => ctx.decodeAudioData(arrayBuffer))
      .then((buffer) => {
        this.buffers.set(name, buffer);
        this.loading.delete(name);
        return buffer;
      })
      .catch((err) => {
        // A failed fetch/decode must NOT stay cached as "in flight" forever
        // — the next play() call for this name should retry, not hang on a
        // dead promise (same fix applied to vocal.ts's VocalPlayer.load()).
        this.loading.delete(name);
        throw err;
      });
    this.loading.set(name, promise);
    return promise;
  }

  /**
   * Fire-and-forget playback: a fresh AudioBufferSourceNode + fresh GainNode
   * per call, so overlapping plays are polyphonic by construction — no
   * handle is returned. Must be called from (or shortly after) a user
   * gesture the first time, same iOS rule as every other AudioContext use in
   * this app — callers should have already called AudioCore.ensureContext()
   * in the originating tap handler. Returns a Promise<boolean> resolving to
   * whether playback actually started — callers use this to only count a
   * clip toward the fx frequency-cap cooldown when it truly fired (see
   * page.tsx's recordFxFired()); never throws/rejects.
   */
  play(name: SfxName, opts: { gainDb?: number } = {}): Promise<boolean> {
    return this.load(name)
      .then((buffer) => {
        const ctx = this.core.ensureContext();
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = dbToLinear(opts.gainDb ?? 0);
        source.connect(gain);
        gain.connect(this.core.master);
        source.start();
        return true;
      })
      .catch((err) => {
        // Graceful failure path — never throw/unhandled-reject into the
        // caller just because a clip 404s or fails to decode.
        console.warn(`fx: could not play "${name}":`, err);
        return false;
      });
  }

  /**
   * FX warm-up (scope addendum — a wifi drop before a stinger's FIRST use
   * left it dead for the rest of the set, since load() otherwise only
   * fetches on demand): eagerly fetches+decodes every known SFX clip ahead
   * of time via the same load() play() already uses, so it's cached before
   * wifi can die. Additive only — play()'s own on-demand load() path is
   * unchanged. Bounded concurrency so a slow connection doesn't open 7
   * requests at once; never throws, reports per-clip success/failure.
   */
  async preloadAll(concurrency = 4): Promise<{ loaded: SfxName[]; failed: SfxName[] }> {
    const names = Object.keys(SFX_FILES) as SfxName[];
    const loaded: SfxName[] = [];
    const failed: SfxName[] = [];
    await runWithConcurrency(names, concurrency, async (name) => {
      try {
        await this.load(name);
        loaded.push(name);
      } catch {
        failed.push(name);
      }
    });
    return { loaded, failed };
  }
}
