export interface GenreOverride { id: string; genre: string; updatedAt: string }
export function parseGenreOverride(body: unknown, ids: ReadonlySet<string>): { id: string; genre: string } | null {
  if (!body || typeof body !== "object") return null;
  const { id, genre } = body as Record<string, unknown>;
  if (typeof id !== "string" || !ids.has(id) || typeof genre !== "string" || genre.length > 80 || /[\x00-\x1f]/.test(genre)) return null;
  return { id, genre: genre.trim() };
}
