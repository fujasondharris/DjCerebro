// Google Drive crate loader — M5 Deliverable 1, part two: proxies the file
// bytes for one track so the client can wrap them in a File/Blob and run them
// through the same parse-and-add path local files use. CORS-blocked direct
// from the browser, same reason as /api/crate/route.ts.
import { NextResponse } from "next/server";
import { checkPasscode } from "@/lib/passcode";
import {
  isSuspiciousDownloadContentType,
  isUsableGoogleApiKey,
  shouldRetryDriveDownload,
  buildUpstreamRangeHeaders,
  buildProxyResponseHeaders,
} from "@/lib/crate";

// One retry on Google's abuse/rate-limit block (see shouldRetryDriveDownload)
// before giving up — never more than this, so a rate-limit incident can't
// turn into an unbounded retry loop that makes the block worse.
const ABUSE_RETRY_DELAY_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Edge runtime, NOT nodejs: Vercel's Node serverless functions cap response
// bodies at ~4.5MB on the Hobby plan, which silently breaks full-track
// downloads (most MP3s are 5-15MB) — found live at first soundcheck
// 2026-07-26. Edge functions stream responses without that cap, and this
// handler is pure fetch/Response passthrough, so it runs on Edge unchanged.
export const runtime = "edge";

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const passcodeCheck = checkPasscode(process.env.DJ_PASSCODE, request.headers.get("x-dj-passcode"));
  if (!passcodeCheck.ok) {
    return NextResponse.json({ error: passcodeCheck.error }, { status: 401 });
  }

  const id = params.id;
  if (!id) {
    return NextResponse.json({ error: "Missing file id." }, { status: 400 });
  }

  const STUDIO_TRACK_IDS = new Set([
    "el_cerebro_dembow_fuego",
    "supermercado_salsa_brava",
    "medianoche_tech_guaracha",
    "costa_dorada_bachata_vip",
  ]);
  if (STUDIO_TRACK_IDS.has(id)) {
    return NextResponse.redirect(new URL(`/audio/tracks/${id}.mp3`, request.url), 307);
  }
  if (id.startsWith("/audio/")) {
    return NextResponse.redirect(new URL(id, request.url), 307);
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  // Keyless fallback (M5 scope addendum, hardened M6.2): an empty/whitespace
  // GOOGLE_API_KEY (isUsableGoogleApiKey) is treated as absent, same as the
  // listing route. drive.usercontent.google.com/download is the direct host
  // that drive.google.com/uc?export=download redirects to — hitting it
  // directly drops one redirect hop (one less surface for Google's abuse
  // detector to block); works unauthenticated for link-shared files under
  // Drive's virus-scan size threshold (our mp3s are well under it).
  const url = isUsableGoogleApiKey(apiKey)
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&key=${encodeURIComponent(apiKey as string)}`
    : `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;

  // Partial-fetch tag parsing (lazy-crate architecture): the client can send
  // a Range header (e.g. "bytes=0-262143") to fetch just the ID3v2 header
  // instead of the whole file — see src/lib/crate-lazy.ts. Forwarded to
  // whichever upstream path is active; both generally honor Range.
  // Absent on a normal full-file
  // download (deck load / autopilot queue), which behaves exactly as before.
  const rangeHeaders = buildUpstreamRangeHeaders(request.headers.get("range"));

  try {
    let upstream = await fetch(url, { headers: rangeHeaders });

    if (!upstream.ok) {
      const contentType = upstream.headers.get("content-type");
      const text = await upstream.text().catch(() => "");

      // Google's abuse/rate-limit block (the "Sorry..." page) is transient —
      // one retry after a short pause before giving up, per the incident
      // this fix responds to. Anything else (bad id, real permission error)
      // is NOT retried; it fails the same way it always did.
      if (shouldRetryDriveDownload(upstream.status, text, contentType)) {
        await sleep(ABUSE_RETRY_DELAY_MS);
        upstream = await fetch(url, { headers: rangeHeaders });
        if (!upstream.ok) {
          return NextResponse.json(
            { error: "Google is rate-limiting downloads — pause and retry shortly." },
            { status: 502 }
          );
        }
      } else {
        return NextResponse.json(
          { error: `Drive download failed: HTTP ${upstream.status} ${text.slice(0, 200)}` },
          { status: 502 }
        );
      }
    }

    if (!upstream.body) {
      return NextResponse.json({ error: "Drive download failed: empty response body" }, { status: 502 });
    }

    // The keyless drive.google.com/uc path can return HTTP 200 with an HTML
    // body instead of file bytes (virus-scan interstitial, or a not-shared/
    // removed file's error page) — never hand that to the client as if it
    // were audio. Checked regardless of key presence; harmless when it isn't.
    const contentType = upstream.headers.get("content-type");
    if (isSuspiciousDownloadContentType(contentType)) {
      return NextResponse.json(
        {
          error: `Drive returned a non-audio response (${contentType ?? "unknown content-type"}) — the file may not be shared "anyone with link", or Drive's virus-scan interstitial is blocking the direct download.`,
        },
        { status: 502 }
      );
    }

    // upstream.status is 206 (partial) when Range was honored, 200 (whole
    // file) otherwise — passed straight through rather than hardcoded, so a
    // Range request against an upstream that ignores Range still gets an
    // honest 200 instead of a lying 206.
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: buildProxyResponseHeaders({
        contentRange: upstream.headers.get("content-range"),
        contentLength: upstream.headers.get("content-length"),
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Drive download failed: ${message}` }, { status: 502 });
  }
}
