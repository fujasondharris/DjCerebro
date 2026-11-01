// Vocal-clip library playback for DJ Supermercado — produced tag/drop/adlib/
// crowd/cue_warm/cue_hype clips (src/data/vocal-manifest.json), rotated by
// category so the same line never repeats twice in a row, with an
// auto-duck on both decks while a clip plays. Mirrors src/lib/fx.ts's
// FxPlayer shape (fetch+decode+cache, fresh AudioBufferSourceNode+GainNode
// per play, straight to AudioCore.master) but adds category-based random
// selection and the duck.
//
// Duck routing: reuses Deck.duck()/unduck() (src/lib/deck.ts) — the exact
// mechanism src/lib/scratch.ts already uses to duck a deck under a scratch
// overlay — rather than inventing a second gain path. That's the least
// invasive point in the existing architecture: it never touches
// AudioCore.master, the crossfader's own setGain() calls, or any node the
// transition engine (src/lib/transition.ts) owns. Per the dispatch: if a
// transition is currently running, the duck is skipped entirely rather than
// fighting the transition engine's gain ramp — the clip still plays, it
// just doesn't duck (vocal clips firing mid-transition is prompt-forbidden
// anyway, see brain.ts's SYSTEM_PROMPT, so this is a defensive fallback,
// not the expected path).
import type { AudioCore } from "./audio-core";
import type { Deck } from "./deck";
import type { VocalCategory, VocalManifestEntry } from "./vocal-manifest";
import { runWithConcurrency } from "./concurrency.ts";

export type { VocalCategory, VocalManifestEntry };

export const VOCAL_CATEGORIES: VocalCategory[] = ["tag", "drop", "adlib", "crowd", "cue_warm", "cue_hype"];

/**
 * Occasion shout-outs (birthday/anniversary-style callouts) — a real
 * VocalCategory sharing the same manifest/rotation/duck machinery as every
 * category above, but deliberately kept OUT of VOCAL_CATEGORIES: that list
 * is what page.tsx's executeFxCommand() checks to route a brain "fx" command
 * into playCategory(), so a category absent from it can never be
 * brain-triggered — only a human tapping its own separate "host" pad
 * (page.tsx's FxPanel) can fire it. See vocal-manifest.ts's VocalCategory doc
 * comment for why.
 */
export const HOST_ONLY_CATEGORIES: VocalCategory[] = ["shoutout"];

/** Groups manifest entries by category (file paths only), preserving manifest order within each category. Pure. */
export function groupManifestByCategory(manifest: VocalManifestEntry[]): Record<VocalCategory, string[]> {
  const groups: Record<VocalCategory, string[]> = {
    tag: [],
    drop: [],
    adlib: [],
    crowd: [],
    cue_warm: [],
    cue_hype: [],
    shoutout: [],
  };
  for (const entry of manifest) {
    groups[entry.category].push(entry.file);
  }
  return groups;
}

/**
 * Picks a random file from `files`, never repeating `lastFile` when more
 * than one candidate is available. Pure (random is injectable for tests —
 * see scripts/check-vocal.mjs). Returns null for an empty category.
 */
export function pickNextVocalClip(
  files: string[],
  lastFile: string | null,
  random: () => number = Math.random
): string | null {
  if (files.length === 0) return null;
  if (files.length === 1) return files[0];
  const candidates = lastFile === null ? files : files.filter((f) => f !== lastFile);
  const pool = candidates.length > 0 ? candidates : files; // lastFile wasn't actually in this category — fall back to the full list
  const index = Math.min(Math.floor(random() * pool.length), pool.length - 1);
  return pool[index];
}

export class VocalPlayer {
  private core: AudioCore;
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Map<string, Promise<AudioBuffer>>();
  private lastPlayed = new Map<VocalCategory, string>();

  constructor(core: AudioCore) {
    this.core = core;
  }

  private async load(file: string): Promise<AudioBuffer> {
    const cached = this.buffers.get(file);
    if (cached) return cached;
    const inFlight = this.loading.get(file);
    if (inFlight) return inFlight;

    const ctx = this.core.ensureContext();
    const promise = fetch(`/sfx/vocal/${file}`)
      .then((res) => {
        if (!res.ok) throw new Error(`vocal fetch failed: HTTP ${res.status} for "${file}"`);
        return res.arrayBuffer();
      })
      .then((arrayBuffer) => ctx.decodeAudioData(arrayBuffer))
      .then((buffer) => {
        this.buffers.set(file, buffer);
        this.loading.delete(file);
        return buffer;
      })
      .catch((err) => {
        // A failed fetch/decode must NOT stay cached as "in flight" forever
        // — the next attempt to play this clip should retry, not hang on a
        // dead promise (same fix applied to fx.ts's FxPlayer.load() below).
        this.loading.delete(file);
        throw err;
      });
    this.loading.set(file, promise);
    return promise;
  }

  /**
   * Plays a random clip from `category` (rotation, no immediate repeat) and
   * ducks `decks` for the clip's duration — unless `opts.isTransitionRunning`
   * reports true, in which case the duck is skipped (see file header).
   * Returns the filename picked, or null if the category has no clips in
   * this manifest (no-op). `opts.onResult`, if given, is called
   * asynchronously once playback actually starts (true) or the fetch/decode
   * fails (false) — callers use this to only count a clip toward the fx
   * frequency-cap cooldown when it truly fired (see page.tsx's
   * recordFxFired()).
   */
  playCategory(
    category: VocalCategory,
    filesByCategory: Record<VocalCategory, string[]>,
    decks: Deck[],
    opts: { isTransitionRunning?: () => boolean; random?: () => number; onResult?: (success: boolean) => void } = {}
  ): string | null {
    const files = filesByCategory[category] ?? [];
    const file = pickNextVocalClip(files, this.lastPlayed.get(category) ?? null, opts.random);
    if (!file) {
      opts.onResult?.(false);
      return null;
    }
    this.lastPlayed.set(category, file);
    this.playResolvedFile(file, decks, opts, `category "${category}"`);
    return file;
  }

  /**
   * Cue-point live firing (rehearsal → mark → assign → live-fire — see
   * CLAUDE_STATE.md): plays ONE SPECIFIC clip by filename, not a category
   * rotation — a pre-authored cue names an exact vocal line to land on an
   * exact lyric/beat, so there's no "pick next" step here at all. Same
   * duck/skip-during-transition/onResult contract as playCategory() (shares
   * playResolvedFile() below), just without touching `lastPlayed` (a cue
   * fire shouldn't perturb category rotation's no-repeat memory).
   */
  playFile(
    file: string,
    decks: Deck[],
    opts: { isTransitionRunning?: () => boolean; onResult?: (success: boolean) => void } = {}
  ): void {
    this.playResolvedFile(file, decks, opts, "cue");
  }

  private playResolvedFile(
    file: string,
    decks: Deck[],
    opts: { isTransitionRunning?: () => boolean; onResult?: (success: boolean) => void },
    logContext: string
  ): void {
    void this.load(file)
      .then((buffer) => {
        const ctx = this.core.ensureContext();
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = 1;
        source.connect(gain);
        gain.connect(this.core.master);

        source.start();
        opts.onResult?.(true);
      })
      .catch((err) => {
        console.warn(`vocal: could not play "${file}" (${logContext}):`, err);
        opts.onResult?.(false);
      });
  }

  /**
   * FX warm-up (scope addendum — same wifi-drop-kills-a-clip's-first-use
   * problem as fx.ts's FxPlayer.preloadAll(), mirrored here for the vocal
   * library): eagerly fetches+decodes every clip named in `manifest` via the
   * same load() playCategory() already uses. Additive only — playCategory's
   * on-demand load() path is unchanged. Bounded concurrency, never throws,
   * reports per-clip success/failure.
   */
  async preloadAll(
    manifest: VocalManifestEntry[],
    concurrency = 4
  ): Promise<{ loaded: string[]; failed: string[] }> {
    const files = Array.from(new Set(manifest.map((entry) => entry.file)));
    const loaded: string[] = [];
    const failed: string[] = [];
    await runWithConcurrency(files, concurrency, async (file) => {
      try {
        await this.load(file);
        loaded.push(file);
      } catch {
        failed.push(file);
      }
    });
    return { loaded, failed };
  }
}
