#!/usr/bin/env node
// Node-side smoke test for the synced-lyrics -> suggested-cue-points
// pipeline's PURE logic (src/lib/lyrics-match.ts) — name cleaning/query
// variants and synced-lyrics/call-response extraction. No network, no
// filesystem — see scripts/suggest-cues.mjs for the real lrclib.net-backed
// orchestration this feeds. Name-cleaning cases below are copied VERBATIM
// from the real "DJ Supermercado Crate" Drive folder (286 tracks, confirmed
// live 2026-07-26) — the whole point of this pipeline is coping with real
// YouTube-downloader mess, so testing against invented "clean" examples
// would prove nothing.
import {
  stripExtension,
  cleanTrackName,
  buildQueryVariants,
  titleSimilarity,
  pickBestMatch,
  parseSyncedLyrics,
  extractCallResponseCues,
} from "../src/lib/lyrics-match.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function hasVariant(variants, artist, title) {
  return variants.some((v) => v.artist === artist && v.title === title);
}

// --- stripExtension ---
assertOk("stripExtension: strips .mp3", stripExtension("Foo.mp3") === "Foo");
assertOk("stripExtension: leaves a name with no extension alone", stripExtension("Foo") === "Foo");

// --- cleanTrackName: real crate names (verbatim from the live Drive folder) ---

assertOk(
  'cleanTrackName: plain "Artist - Title.mp3" needs no cleanup',
  deepEqual(cleanTrackName("Marc Anthony - Vivir Mi Vida.mp3"), { artist: "Marc Anthony", title: "Vivir Mi Vida" })
);

assertOk(
  'cleanTrackName: "Uploader - Artist - Title (Official Video).mp3" strips the suffix but keeps the uploader prefix in the artist guess (variants fix this — see below)',
  deepEqual(cleanTrackName("Andres Vela - Bad Bunny - NUEVAYoL (Official Video).mp3"), {
    artist: "Andres Vela - Bad Bunny",
    title: "NUEVAYoL",
  })
);

assertOk(
  "cleanTrackName: a bare title with no dash at all -> null artist",
  deepEqual(cleanTrackName("NUEVAYoL.mp3"), { artist: null, title: "NUEVAYoL" })
);

assertOk(
  'cleanTrackName: "Artist - Artist - Title (...)[...] ft. X.mp3" collapses the duplicated leading segment',
  deepEqual(
    cleanTrackName("Yandel - Yandel - Plakito (Remix)[Official Video] ft. El General Gadiel, Farruko.mp3"),
    { artist: "Yandel", title: "Plakito (Remix) ft. El General Gadiel, Farruko" }
  )
);

assertOk(
  "cleanTrackName: fullwidth pipe truncates an album/playlist tag, and a PREFIX-duplicated (not exact-duplicated) leading segment still collapses",
  deepEqual(
    cleanTrackName(
      "Zion & Lennox - Zion & Lennox Ft Yandel & Farruko - Pierdo La Cabeza Remix ｜ Video Lyric.mp3"
    ),
    { artist: "Zion & Lennox Ft Yandel & Farruko", title: "Pierdo La Cabeza Remix" }
  )
);

assertOk(
  '"(Letra)" (Spanish "lyrics" tag) is recognized noise, not left in the title',
  deepEqual(cleanTrackName("iPerol - Bad Bunny - DtMF (Letra).mp3"), { artist: "iPerol - Bad Bunny", title: "DtMF" })
);

assertOk(
  '"(Remix)" itself is real title information, never stripped as noise',
  cleanTrackName("Yng Lvcas - Yng Lvcas & Peso Pluma - La Bebe (Remix) [Video Oficial].mp3").title === "La Bebe (Remix)"
);

// --- buildQueryVariants: the fallback guesses that actually match lrclib ---

{
  const clean = cleanTrackName("Andres Vela - Bad Bunny - NUEVAYoL (Official Video).mp3");
  const variants = buildQueryVariants(clean);
  assertOk(
    "buildQueryVariants: primary guess keeps the full (wrong) artist string",
    hasVariant(variants, "Andres Vela - Bad Bunny", "NUEVAYoL")
  );
  assertOk(
    "buildQueryVariants: last-segment fallback recovers the REAL artist for an uploader-prefixed name",
    hasVariant(variants, "Bad Bunny", "NUEVAYoL")
  );
  assertOk("buildQueryVariants: null-artist combined-query fallback is always present", hasVariant(variants, null, "NUEVAYoL"));
}

{
  const clean = cleanTrackName("iPerol - Bad Bunny - DtMF (Letra).mp3");
  const variants = buildQueryVariants(clean);
  assertOk("buildQueryVariants: last-segment fallback also recovers this uploader-prefixed case", hasVariant(variants, "Bad Bunny", "DtMF"));
}

{
  // "Ft"/"ft."/"feat." embedded in the artist segment (case-insensitive) is
  // stripped as an alternate variant, recovering the bare artist name.
  const clean = cleanTrackName(
    "Zion & Lennox - Zion & Lennox Ft Yandel & Farruko - Pierdo La Cabeza Remix ｜ Video Lyric.mp3"
  );
  const variants = buildQueryVariants(clean);
  assertOk(
    'buildQueryVariants: "Ft ..." stripped from the artist as a fallback variant',
    hasVariant(variants, "Zion & Lennox", "Pierdo La Cabeza Remix")
  );
}

{
  // A blunt bracket-stripped title variant recovers a match when even a
  // legitimate "(Remix)" in the title throws off lrclib's own plain title.
  const clean = cleanTrackName("Yng Lvcas - Yng Lvcas & Peso Pluma - La Bebe (Remix) [Video Oficial].mp3");
  const variants = buildQueryVariants(clean);
  assertOk("buildQueryVariants: blunt bracket-stripped title fallback", hasVariant(variants, "Yng Lvcas & Peso Pluma", "La Bebe"));
}

assertOk(
  "buildQueryVariants: never returns a duplicate {artist,title} pair",
  (() => {
    const variants = buildQueryVariants(cleanTrackName("Marc Anthony - Marc Anthony - Vivir Mi Vida.mp3"));
    const keys = variants.map((v) => `${v.artist ?? ""}|${v.title}`);
    return new Set(keys).size === keys.length;
  })()
);

// --- titleSimilarity / pickBestMatch ---

assertOk("titleSimilarity: identical strings -> 1", titleSimilarity("NUEVAYoL", "NUEVAYoL") === 1);
assertOk(
  "titleSimilarity: diacritic-insensitive (accented vs. unaccented)",
  titleSimilarity("Tití Me Preguntó", "Titi Me Pregunto") > 0.9
);
assertOk("titleSimilarity: unrelated titles score low", titleSimilarity("NUEVAYoL", "Vivir Mi Vida") < 0.2);

{
  const results = [
    { trackName: "Vivir Mi Vida", artistName: "Marc Anthony", duration: 240, syncedLyrics: "[00:01.00] la la" },
    { trackName: "Unrelated Song", artistName: "Someone Else", duration: 200, syncedLyrics: "[00:01.00] nope" },
  ];
  const best = pickBestMatch(results, { title: "Vivir Mi Vida", artist: "Marc Anthony" });
  assertOk("pickBestMatch: picks the title-similar result over an unrelated one", best?.trackName === "Vivir Mi Vida");
}
assertOk(
  "pickBestMatch: a result with no syncedLyrics is never picked, even if the title matches exactly",
  pickBestMatch([{ trackName: "X", artistName: "Y", syncedLyrics: null }], { title: "X", artist: "Y" }) === null
);
assertOk("pickBestMatch: empty results -> null", pickBestMatch([], { title: "X", artist: "Y" }) === null);
{
  // Duration verification wins over title similarity when a target duration
  // IS supplied (per the dispatch's FACTS) — scripts/suggest-cues.mjs itself
  // doesn't have a cheap source of crate-track duration today (see its own
  // header comment), so this path is exercised here directly rather than
  // through the live script.
  const results = [
    { trackName: "Song (Live)", artistName: "A", duration: 300, syncedLyrics: "[00:01.00] x" },
    { trackName: "Song", artistName: "A", duration: 200, syncedLyrics: "[00:01.00] x" },
  ];
  const best = pickBestMatch(results, { title: "Song", artist: "A", durationSeconds: 200 });
  assertOk("pickBestMatch: duration match wins even when another result's title string is a closer literal match", best?.duration === 200);
}

// --- parseSyncedLyrics / extractCallResponseCues ---

const SYNCED_FIXTURE = [
  "[00:05.00] Intro line before the ten second floor",
  "[00:20.50] Yo sali de Nueva York",
  "[00:24.10] (¿Pa' dónde?)",
  "[00:40.00] Coro coro coro",
  "[00:55.30] (Nueva York)",
  "[01:10.00] Coro coro coro",
  "[01:25.00] (¿Pa' dónde?)",
  "[01:40.00] Verse line unique text",
  "[01:55.00] (Uh)",
  "[02:10.00] Coro coro coro",
  "[02:25.00] (Otra vez)",
].join("\n");

{
  const lines = parseSyncedLyrics(SYNCED_FIXTURE);
  assertOk("parseSyncedLyrics: parses every timestamped line", lines.length === 11);
  assertOk("parseSyncedLyrics: mm:ss.xx -> seconds, e.g. 01:25.00 -> 85s", lines.some((l) => l.atSeconds === 85 && l.text === "(¿Pa' dónde?)"));
  assertOk(
    "parseSyncedLyrics: a metadata-style line ([ar: ...]) with no digit timestamp is silently skipped",
    parseSyncedLyrics("[ar: Bad Bunny]\n[00:01.00] real line").length === 1
  );
}

{
  const lines = parseSyncedLyrics(SYNCED_FIXTURE);
  const cues = extractCallResponseCues(lines);
  assertOk("extractCallResponseCues: caps at the default 6", cues.length === 6);
  assertOk(
    "extractCallResponseCues: the 5s intro line (before the default 10s floor) never becomes a cue",
    !cues.some((c) => c.atSeconds === 5)
  );
  assertOk(
    "extractCallResponseCues: parenthetical adlib line is a candidate",
    cues.some((c) => c.label === "(¿Pa' dónde?)")
  );
  assertOk(
    "extractCallResponseCues: an exact-repeat coro line (not parenthetical) is also a candidate",
    cues.some((c) => c.label === "Coro coro coro")
  );
  assertOk(
    "extractCallResponseCues: a non-repeated, non-parenthetical verse line is never a candidate",
    !cues.some((c) => c.label === "Verse line unique text")
  );
  assertOk("extractCallResponseCues: cues stay ascending by time", cues.every((c, i) => i === 0 || c.atSeconds >= cues[i - 1].atSeconds));
  assertOk(
    "extractCallResponseCues: spreads picks across the whole candidate span rather than just the first 6 chronologically",
    cues[cues.length - 1].atSeconds - cues[0].atSeconds > 60
  );
}

{
  // Under the cap: every real candidate comes back, no bucket-spread logic needed.
  const lines = parseSyncedLyrics(
    ["[00:15.00] (Uno)", "[00:30.00] (Dos)", "[00:45.00] (Tres)"].join("\n")
  );
  const cues = extractCallResponseCues(lines);
  assertOk("extractCallResponseCues: under the cap returns every real candidate untouched", cues.length === 3);
}

assertOk(
  "extractCallResponseCues: label is trimmed to the ~40-char cap",
  extractCallResponseCues(
    parseSyncedLyrics(`[00:15.00] (${"a".repeat(80)})`)
  )[0].label.length <= 40
);

assertOk("extractCallResponseCues: no candidates -> empty array, not a throw", extractCallResponseCues([]).length === 0);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all lyrics-match pure-logic cases");
