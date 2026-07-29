// Pure filename -> category rules for the vocal-clip library
// (public/sfx/vocal/*.mp3), shared by scripts/make-vocal-manifest.mjs (which
// scans the folder and writes src/data/vocal-manifest.json) and
// scripts/check-vocal.mjs (which unit-checks the mapping without touching
// the filesystem). Kept separate from src/lib/vocal.ts (playback/rotation)
// the same way src/lib/crate.ts's pure listing helpers are separate from the
// route that calls them — no AudioContext/fetch here, just string rules.
// "shoutout" (occasion/host callouts — birthday, anniversary, etc.) is
// HOST-TRIGGERED ONLY: it's a real VocalCategory so it shares the exact same
// manifest/rotation/duck machinery as every other category, but it is
// deliberately excluded from brain.ts's FxCommandSchema fx enum — the brain
// can never request it, only a human tapping its pad can (see
// src/lib/vocal.ts's HOST_ONLY_CATEGORIES and page.tsx's separate "host" pad
// spot). Research note: an autonomously-fired birthday shout-out is exactly
// the kind of thing that spawns a confused request line at the booth.
export type VocalCategory = "tag" | "drop" | "adlib" | "crowd" | "cue_warm" | "cue_hype" | "shoutout";

export interface VocalManifestEntry {
  file: string;
  category: VocalCategory;
}

/**
 * Prefix rules (per the produced-library naming convention):
 *   tag-*, tag2-*  -> "tag"   (brand/announcer stamps)
 *   drop-*         -> "drop"  (produced voice+SFX composites)
 *   adlib-*        -> "adlib" (coro/hype-man call-and-response shouts)
 *   crowd-*        -> "crowd" (crowd-work callouts)
 *   cue-*-warm     -> "cue_warm"
 *   cue-*-hype     -> "cue_hype"
 *   shoutout-*     -> "shoutout" (host-only occasion callouts — see VocalCategory's doc comment)
 * Anything else is unrecognized — defaults to "tag" and flags `unknown` so
 * the caller can warn rather than silently mis-file it.
 */
export function categorizeFilename(filename: string): { category: VocalCategory; unknown: boolean } {
  const base = filename.replace(/\.[^/.]+$/, "");
  if (/^cue-.*-warm$/.test(base)) return { category: "cue_warm", unknown: false };
  if (/^cue-.*-hype$/.test(base)) return { category: "cue_hype", unknown: false };
  if (/^tag2?-/.test(base)) return { category: "tag", unknown: false };
  if (/^drop-/.test(base)) return { category: "drop", unknown: false };
  if (/^adlib-/.test(base)) return { category: "adlib", unknown: false };
  if (/^crowd-/.test(base)) return { category: "crowd", unknown: false };
  if (/^shoutout-/.test(base)) return { category: "shoutout", unknown: false };
  return { category: "tag", unknown: true };
}

/** Builds a manifest (preserving input order) + a warning per unrecognized-prefix filename. Pure — no filesystem access. */
export function buildVocalManifest(filenames: string[]): { manifest: VocalManifestEntry[]; warnings: string[] } {
  const manifest: VocalManifestEntry[] = [];
  const warnings: string[] = [];
  for (const file of filenames) {
    const { category, unknown } = categorizeFilename(file);
    if (unknown) {
      warnings.push(`vocal-manifest: unrecognized prefix for "${file}" — defaulting to category "tag"`);
    }
    manifest.push({ file, category });
  }
  return { manifest, warnings };
}
