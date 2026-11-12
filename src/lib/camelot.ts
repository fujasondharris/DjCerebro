// Craft pass #2, Part 3 — pure musical-key -> Camelot-notation converter.
// TKEY (src/lib/id3.ts) is free-text per the ID3v2 spec (a note letter A-G,
// optional #/b accidental, optional trailing "m" for minor — e.g. "Cm",
// "F#", "Dbm"); some real tagged tracks already carry Camelot
// notation directly (e.g. "8A", confirmed against the committed fixtures —
// see CLAUDE_STATE.md), others carry musical notation (per the M3-era
// note: "source keys are musical notation, not Camelot").
// toCamelot() normalizes either input to Camelot's own "<1-12><A|B>" form so
// SYSTEM_PROMPT's harmonic-mixing rules can reason about one consistent
// vocabulary. Unknown/unparseable input (e.g. TKEY's own "o" for "off key",
// or plain garbage) returns null — callers omit the field entirely rather
// than sending unusable text (see brain.ts's buildCompactCrateEntry/
// deckLiveState wiring).

/** Standard Camelot wheel (Mixed In Key convention) — one entry per of the 12 pitch classes, by note name; enharmonic aliases (C#/Db, D#/Eb, F#/Gb, G#/Ab, A#/Bb) share the same entry. */
const CAMELOT_BY_PITCH_CLASS: Record<string, { major: string; minor: string }> = {
  C: { major: "8B", minor: "5A" },
  "C#": { major: "3B", minor: "12A" },
  Db: { major: "3B", minor: "12A" },
  D: { major: "10B", minor: "7A" },
  "D#": { major: "5B", minor: "2A" },
  Eb: { major: "5B", minor: "2A" },
  E: { major: "12B", minor: "9A" },
  F: { major: "7B", minor: "4A" },
  "F#": { major: "2B", minor: "11A" },
  Gb: { major: "2B", minor: "11A" },
  G: { major: "9B", minor: "6A" },
  "G#": { major: "4B", minor: "1A" },
  Ab: { major: "4B", minor: "1A" },
  A: { major: "11B", minor: "8A" },
  "A#": { major: "6B", minor: "3A" },
  Bb: { major: "6B", minor: "3A" },
  B: { major: "1B", minor: "10A" },
  // Rarer enharmonic spellings (theoretically valid, occasionally seen from
  // a tagger) — same pitch class as the entries above.
  Cb: { major: "1B", minor: "10A" }, // == B
  Fb: { major: "12B", minor: "9A" }, // == E
  "E#": { major: "7B", minor: "4A" }, // == F
  "B#": { major: "8B", minor: "5A" }, // == C
};

/** Already-Camelot notation, e.g. "8A", "11B" — case/whitespace-insensitive. */
const CAMELOT_RE = /^\s*(1[0-2]|[1-9])\s*([ab])\s*$/i;

/** Musical-key notation: a note letter, optional accidental (#/b, or the unicode sharp/flat glyphs some taggers use), optional mode marker. Mirrors what TKEY's own spec allows (note + accidental + optional trailing "m"), plus tolerant "maj(or)"/"min(or)" spellings. */
const MUSICAL_KEY_RE = /^\s*([A-Ga-g])\s*([#b♯♭]?)\s*(maj(?:or)?|min(?:or)?|m)?\s*$/i;

/**
 * Converts a raw TKEY string to Camelot notation ("<1-12><A|B>"), or null
 * when unparseable. Pass-through (normalized case) when the input is already
 * Camelot notation.
 */
export function toCamelot(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const camelotMatch = CAMELOT_RE.exec(raw);
  if (camelotMatch) {
    return `${camelotMatch[1]}${camelotMatch[2].toUpperCase()}`;
  }

  const musicalMatch = MUSICAL_KEY_RE.exec(raw);
  if (!musicalMatch) return null;

  const noteLetter = musicalMatch[1].toUpperCase();
  const accidentalRaw = musicalMatch[2] ?? "";
  const accidental = accidentalRaw === "♯" ? "#" : accidentalRaw === "♭" ? "b" : accidentalRaw;
  const modeToken = (musicalMatch[3] ?? "").toLowerCase();
  const isMinor = modeToken.startsWith("min") || modeToken === "m";

  const pitchClass = `${noteLetter}${accidental}`;
  const entry = CAMELOT_BY_PITCH_CLASS[pitchClass];
  if (!entry) return null; // e.g. a nonsense accidental combination

  return isMinor ? entry.minor : entry.major;
}
