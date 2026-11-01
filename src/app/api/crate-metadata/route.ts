import { NextResponse } from "next/server";
import { get, list, put } from "@vercel/blob";
import { checkPasscode } from "@/lib/passcode";
import { parseGenreOverride, type GenreOverride } from "@/lib/crate-metadata-sync";
import manifest from "@/data/crate-manifest.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const prefix = "crate-metadata/v1/";
const ids = new Set(manifest.map(t => t.id));
function denied(request: Request) {
  if (!checkPasscode(process.env.DJ_PASSCODE, request.headers.get("x-dj-passcode")).ok)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!process.env.BLOB_READ_WRITE_TOKEN)
    return NextResponse.json({ error: "Shared genres unavailable; changes are not saved to the cloud." }, { status: 503 });
  return null;
}
export async function GET(request: Request) {
  const error = denied(request); if (error) return error;
  try {
    const overrides: GenreOverride[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, limit: 1000, cursor });
      // Separate files prevent two devices editing DIFFERENT songs from
      // overwriting each other's library. Same-song edits are last-write-wins.
      const paths = page.blobs.map(b => b.pathname).filter(p => ids.has(p.slice(prefix.length).replace(/\.json$/, "")));
      for (let offset = 0; offset < paths.length; offset += 8) {
        const rows = await Promise.all(paths.slice(offset, offset + 8).map(async path => {
          const blob = await get(path, { access: "private", useCache: false });
          if (!blob) return null;
          const row = await new Response(blob.stream).json();
          const parsed = parseGenreOverride(row, ids);
          return parsed && typeof row.updatedAt === "string" ? { ...parsed, updatedAt: row.updatedAt } : null;
        }));
        overrides.push(...rows.filter((r): r is GenreOverride => r !== null));
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return NextResponse.json({ overrides }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not read shared genres." }, { status: 502 });
  }
}
export async function POST(request: Request) {
  const error = denied(request); if (error) return error;
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 512) return NextResponse.json({ error: "Metadata is too large." }, { status: 413 });
    body = JSON.parse(text);
  } catch { return NextResponse.json({ error: "Expected JSON." }, { status: 400 }); }
  const parsed = parseGenreOverride(body, ids);
  if (!parsed) return NextResponse.json({ error: "Unknown library track or invalid genre." }, { status: 400 });
  const override: GenreOverride = { ...parsed, updatedAt: new Date().toISOString() };
  try {
    await put(`${prefix}${parsed.id}.json`, JSON.stringify(override), {
      access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json",
    });
    return NextResponse.json({ override });
  } catch { return NextResponse.json({ error: "Genre not saved to cloud. Retry when connected." }, { status: 502 }); }
}
