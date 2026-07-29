#!/usr/bin/env node
// Node-side smoke test for the /api/crate routes' pure building blocks (M5):
// imports src/lib/crate.ts's Drive-listing filter and src/lib/passcode.ts's
// gate straight from the modules the routes call, no network/server needed.
// Plain asserts, no test framework, mirrors check-route.mjs.
import {
  filterAudioFiles,
  toListing,
  mergeDrivePages,
  resolveListingSource,
  manifestToListing,
  isSuspiciousDownloadContentType,
  buildUpstreamRangeHeaders,
  buildProxyResponseHeaders,
  isUsableGoogleApiKey,
  shouldRetryDriveDownload,
  hasUsableTags,
  buildManifestTagIndex,
  matchLocalFilename,
} from "../src/lib/crate.ts";
import { checkPasscode } from "../src/lib/passcode.ts";

let failures = 0;

function assertOk(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    failures++;
  } else {
    console.log(`PASS: ${name}`);
  }
}

// --- filterAudioFiles / toListing ---

const rawFiles = [
  { id: "1", name: "01 - Is This Love.mp3", mimeType: "audio/mpeg", size: "4200000" },
  { id: "2", name: "02 - Big Wav.wav", mimeType: "audio/x-wav", size: "80000000" },
  { id: "3", name: "notes.txt", mimeType: "text/plain", size: "120" },
  { id: "4", name: "some-folder", mimeType: "application/vnd.google-apps.folder" },
  { id: "5", name: "Ambiguous", mimeType: "audio/mp3" }, // no size field, no extension
];

{
  const listing = filterAudioFiles(rawFiles);
  assertOk("filterAudioFiles: drops non-audio files (text, folders)", listing.length === 3);
  assertOk(
    "filterAudioFiles: keeps mp3 and wav, in source order",
    listing.map((t) => t.id).join(",") === "1,2,5"
  );
}

{
  const mp3 = toListing(rawFiles[0]);
  assertOk("toListing: mp3 by mimeType is playable", mp3.playable === true);
  assertOk("toListing: size string parsed to number", mp3.size === 4200000);
}

{
  const wav = toListing(rawFiles[1]);
  assertOk("toListing: wav is NOT playable (soundtouchjs pipeline is mp3-tested)", wav.playable === false);
}

{
  const noSize = toListing(rawFiles[4]);
  assertOk("toListing: missing size -> null, not NaN/0", noSize.size === null);
  assertOk("toListing: audio/mp3 mimeType (no .mp3 extension) still playable", noSize.playable === true);
}

{
  const byExtension = toListing({ id: "6", name: "track.MP3", mimeType: "application/octet-stream" });
  assertOk("toListing: .MP3 extension (case-insensitive) counts as playable even with a generic mimeType", byExtension.playable === true);
}

assertOk("filterAudioFiles: empty input -> empty output", filterAudioFiles([]).length === 0);

// --- mergeDrivePages (pagination — folders bigger than one Drive API page) ---

{
  const page1 = [{ id: "1", name: "a.mp3", mimeType: "audio/mpeg" }];
  const page2 = [{ id: "2", name: "b.mp3", mimeType: "audio/mpeg" }];
  const merged = mergeDrivePages([page1, page2]);
  assertOk("mergeDrivePages: two pages merge to one flat list", merged.length === 2);
  assertOk("mergeDrivePages: ordering preserved across pages", merged.map((f) => f.id).join(",") === "1,2");
}

{
  const merged = mergeDrivePages([[], [{ id: "1", name: "a.mp3", mimeType: "audio/mpeg" }], []]);
  assertOk("mergeDrivePages: empty pages (e.g. an empty final page) don't drop or duplicate entries", merged.length === 1);
}

assertOk("mergeDrivePages: no pages -> empty list", mergeDrivePages([]).length === 0);

{
  // Simulates a folder spanning 3 pages of 2 files each (6 total) — the scenario the bug allowed to silently truncate.
  const pages = [
    [{ id: "1", name: "a.mp3", mimeType: "audio/mpeg" }, { id: "2", name: "b.mp3", mimeType: "audio/mpeg" }],
    [{ id: "3", name: "c.mp3", mimeType: "audio/mpeg" }, { id: "4", name: "d.mp3", mimeType: "audio/mpeg" }],
    [{ id: "5", name: "e.mp3", mimeType: "audio/mpeg" }, { id: "6", name: "f.mp3", mimeType: "audio/mpeg" }],
  ];
  const merged = mergeDrivePages(pages);
  assertOk("mergeDrivePages: 3-page folder (6 files) merges completely, none truncated", merged.length === 6);
  assertOk(
    "mergeDrivePages: 3-page folder preserves fetch order",
    merged.map((f) => f.id).join(",") === "1,2,3,4,5,6"
  );
}

// --- checkPasscode ---

assertOk("checkPasscode: unset DJ_PASSCODE always ok (local dev unchanged)", checkPasscode(undefined, null).ok === true);
assertOk("checkPasscode: unset DJ_PASSCODE ok even with a header present", checkPasscode(undefined, "whatever").ok === true);
assertOk("checkPasscode: empty-string DJ_PASSCODE treated as unset", checkPasscode("", "whatever").ok === true);

assertOk("checkPasscode: set + matching header -> ok", checkPasscode("letmein", "letmein").ok === true);

{
  const result = checkPasscode("letmein", null);
  assertOk("checkPasscode: set + missing header -> rejected", result.ok === false);
  assertOk("checkPasscode: rejection carries the exact error string", result.error === "passcode required");
}

{
  const result = checkPasscode("letmein", "wrong");
  assertOk("checkPasscode: set + wrong header -> rejected", result.ok === false);
}

assertOk("checkPasscode: case-sensitive match required", checkPasscode("LetMeIn", "letmein").ok === false);

// --- resolveListingSource (keyless-fallback precedence, M5 addendum) ---

assertOk("resolveListingSource: key present -> live, regardless of manifest", resolveListingSource(true, true) === "live");
assertOk("resolveListingSource: key present, no manifest -> still live", resolveListingSource(true, false) === "live");
assertOk("resolveListingSource: no key, manifest present -> manifest", resolveListingSource(false, true) === "manifest");
assertOk("resolveListingSource: no key, no manifest -> none (the 500 path)", resolveListingSource(false, false) === "none");

// --- manifestToListing ---

{
  const listing = manifestToListing([]);
  assertOk("manifestToListing: empty manifest -> empty listing (the current real state of the crate folder)", listing.length === 0);
}

{
  const listing = manifestToListing([
    { id: "d1", name: "Track One.mp3", size: 4200000 },
    { id: "d2", name: "notes.txt" }, // shouldn't really appear in a manifest, but must not crash or count as playable
  ]);
  assertOk("manifestToListing: mp3 entry is playable with size passed through", listing[0].playable === true && listing[0].size === 4200000);
  assertOk("manifestToListing: missing size -> null, not undefined/NaN", listing[1].size === null);
  assertOk("manifestToListing: non-mp3 name is NOT playable", listing[1].playable === false);
}

// --- isSuspiciousDownloadContentType (keyless drive.google.com/uc HTML-interstitial guard) ---

assertOk("isSuspiciousDownloadContentType: audio/mpeg is fine", isSuspiciousDownloadContentType("audio/mpeg") === false);
assertOk(
  "isSuspiciousDownloadContentType: application/octet-stream is fine (real binary responses use this)",
  isSuspiciousDownloadContentType("application/octet-stream") === false
);
assertOk("isSuspiciousDownloadContentType: missing header is fine (not rejected outright)", isSuspiciousDownloadContentType(null) === false);
assertOk(
  "isSuspiciousDownloadContentType: text/html flagged (virus-scan interstitial / error page)",
  isSuspiciousDownloadContentType("text/html; charset=utf-8") === true
);
assertOk("isSuspiciousDownloadContentType: text/plain flagged", isSuspiciousDownloadContentType("text/plain") === true);
assertOk(
  "isSuspiciousDownloadContentType: case-insensitive HTML match",
  isSuspiciousDownloadContentType("APPLICATION/XHTML+XML") === true
);

// --- buildUpstreamRangeHeaders / buildProxyResponseHeaders (lazy-crate
// partial-fetch proxy support — /api/crate/[id] forwarding a client Range
// header upstream and passing the 206/200 response through honestly) ---

assertOk(
  "buildUpstreamRangeHeaders: no client Range -> no Range forwarded (whole-file download unchanged)",
  Object.keys(buildUpstreamRangeHeaders(null)).length === 0
);
assertOk(
  "buildUpstreamRangeHeaders: a client Range header is forwarded verbatim",
  buildUpstreamRangeHeaders("bytes=0-1023").Range === "bytes=0-1023"
);

{
  const headers = buildProxyResponseHeaders({ contentRange: null, contentLength: null });
  assertOk("buildProxyResponseHeaders: always sets audio/mpeg + Accept-Ranges", headers["Content-Type"] === "audio/mpeg" && headers["Accept-Ranges"] === "bytes");
  assertOk("buildProxyResponseHeaders: no Content-Range/Content-Length when upstream didn't send them", !("Content-Range" in headers) && !("Content-Length" in headers));
}

{
  const headers = buildProxyResponseHeaders({ contentRange: "bytes 0-1023/4200000", contentLength: "1024" });
  assertOk("buildProxyResponseHeaders: passes through a real partial-content Content-Range", headers["Content-Range"] === "bytes 0-1023/4200000");
  assertOk("buildProxyResponseHeaders: passes through Content-Length", headers["Content-Length"] === "1024");
}

// --- isUsableGoogleApiKey (M6.2: empty/whitespace GOOGLE_API_KEY treated as absent) ---

assertOk("isUsableGoogleApiKey: undefined -> false", isUsableGoogleApiKey(undefined) === false);
assertOk("isUsableGoogleApiKey: null -> false", isUsableGoogleApiKey(null) === false);
assertOk("isUsableGoogleApiKey: empty string -> false", isUsableGoogleApiKey("") === false);
assertOk("isUsableGoogleApiKey: whitespace-only -> false", isUsableGoogleApiKey("   ") === false);
assertOk("isUsableGoogleApiKey: real key -> true", isUsableGoogleApiKey("AIzaSy-real-key") === true);

// --- shouldRetryDriveDownload (M6.2: retry Google's abuse/rate-limit block once, never a real error) ---

assertOk(
  "shouldRetryDriveDownload: 403 + html body -> retry",
  shouldRetryDriveDownload(403, "<html>Sorry...</html>", "text/html; charset=utf-8") === true
);
assertOk(
  "shouldRetryDriveDownload: 403 + body mentioning Sorry, non-html content-type -> retry",
  shouldRetryDriveDownload(403, "Sorry, we can't process this download right now.", "text/plain") === true
);
assertOk(
  "shouldRetryDriveDownload: 403 + JSON permission-denied body -> NOT retried (real error)",
  shouldRetryDriveDownload(403, '{"error":{"code":403,"message":"The user does not have sufficient permissions"}}', "application/json") === false
);
assertOk(
  "shouldRetryDriveDownload: non-403 status -> never retried, even with an html body",
  shouldRetryDriveDownload(500, "<html>Sorry...</html>", "text/html") === false
);
assertOk("shouldRetryDriveDownload: 404 -> not retried", shouldRetryDriveDownload(404, "Not Found", null) === false);

// --- hasUsableTags (M6.2: manifest/crate entry with both null means "checked, nothing found") ---

assertOk("hasUsableTags: bpm known -> true", hasUsableTags({ bpm: 120, key: null }) === true);
assertOk("hasUsableTags: key known -> true", hasUsableTags({ bpm: null, key: "8A" }) === true);
assertOk("hasUsableTags: both known -> true", hasUsableTags({ bpm: 120, key: "8A" }) === true);
assertOk("hasUsableTags: both null -> false (unmatched-locally, not yet-checked)", hasUsableTags({ bpm: null, key: null }) === false);
assertOk("hasUsableTags: null entry -> false", hasUsableTags(null) === false);
assertOk("hasUsableTags: undefined entry -> false", hasUsableTags(undefined) === false);

// --- buildManifestTagIndex (M6.2: manifest tag lookup by Drive id, independent of listing source) ---

{
  const index = buildManifestTagIndex([
    { id: "d1", name: "Track One.mp3", bpm: 120, key: "8A", durationSeconds: 210.5, grid: null },
    { id: "d2", name: "Track Two.mp3" }, // no local match during the refresh -- every tag field absent
  ]);
  assertOk("buildManifestTagIndex: matched entry carries its real tag data", index.get("d1")?.bpm === 120 && index.get("d1")?.key === "8A");
  assertOk("buildManifestTagIndex: unmatched entry normalizes missing fields to null, not undefined", index.get("d2")?.bpm === null && index.get("d2")?.durationSeconds === null);
  assertOk("buildManifestTagIndex: unknown id -> undefined (caller falls back to a live probe)", index.get("nope") === undefined);
  assertOk("buildManifestTagIndex: empty manifest -> empty index", buildManifestTagIndex([]).size === 0);
}

// --- matchLocalFilename (M6.2: Drive name -> local dj-crate mirror filename) ---

{
  const local = ["Track One.mp3", "TRACK-two.mp3"];
  assertOk("matchLocalFilename: exact match", matchLocalFilename("Track One.mp3", local) === "Track One.mp3");
  assertOk("matchLocalFilename: case-insensitive fallback", matchLocalFilename("track-two.mp3", local) === "TRACK-two.mp3");
  assertOk("matchLocalFilename: no match -> null", matchLocalFilename("Track Three.mp3", local) === null);
  assertOk("matchLocalFilename: empty local list -> null", matchLocalFilename("Track One.mp3", []) === null);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nPASS: all crate-route building-block cases");
