import { toCamelot } from "./camelot.ts";
import { syncTempo } from "./beatmatch.ts";
import { resolveMusicMetadata } from "./music-metadata.ts";

export type HarmonicModulationMode =
  | "tonic_lock"
  | "relative_pivot"
  | "dominant_fifth"
  | "subdominant_fourth"
  | "energy_boost_whole_step"
  | "parallel_mode_shift"
  | "semitone_surge"
  | "diagonal_camelot_step"
  | "non_harmonic_percussion_bridge";

export interface HarmonicAnalysis {
  fromCamelot: string | null;
  toCamelot: string | null;
  fromMusicalKey: string;
  toMusicalKey: string;
  fromSubBassHz: number | null;
  toSubBassHz: number | null;
  mode: HarmonicModulationMode;
  wheelStepDelta: number | null;
  semitoneDelta: number | null;
  harmonicScore: number; // 0.0 .. 1.0
  compatibleForMelodicBlend: boolean;
  requiresPercussionLock: boolean;
  headline: string;
  djCoachingNote: string;
  recommendedEqSwap: "gradual-low-shelf" | "instant-bass-swap" | "stem-bass-cut-bar-4";
}

export type GrooveFamilyId =
  | "dembow_tresillo"
  | "cubaton_timba"
  | "salsa_son_clave"
  | "bachata_derecho_majao"
  | "merengue_marcha"
  | "guaracha_tribal_4x4"
  | "hiphop_boom_trap"
  | "trance_progressive_4x4";

export interface GrooveDNA {
  family: GrooveFamilyId;
  label: string;
  clavePattern: string;
  kickAccentBeats: string;
  subBassCharacter: string;
  socialDanceProtected: boolean;
}

export interface GrooveInterlockAnalysis {
  fromGroove: GrooveDNA;
  toGroove: GrooveDNA;
  interlockScore: number; // 0.0 .. 1.0
  tempoRatio: number;
  halfDoubleTimeUsed: boolean;
  tempoClamped: boolean;
  subBassCrossoverHz: number;
  recommendedTransition: "stem_migrate" | "bass_swap" | "beatmatch_crossfade" | "loop_blend" | "echo_out" | "cut" | "gap";
  recommendedBars: number;
  interlockSummary: string;
}

export interface TurntablistStage {
  stageNumber: 1 | 2 | 3 | 4;
  code: "stage1_tension" | "stage2_fill" | "stage3_impact" | "stage4_vocal_stamp";
  timingLabel: string;
  moveName: string;
  sfxOrAction: string;
  vocalClipFile?: string;
  reason: string;
}

export interface TurntablistChoreography {
  comboId: string;
  comboTitle: string;
  autoSafe: boolean;
  stages: [TurntablistStage, TurntablistStage, TurntablistStage, TurntablistStage];
  summaryLine: string;
}

export interface MusicTheoryTrackInput {
  id: string;
  name: string;
  bpm: number | null;
  key: string | null;
  genre?: string | null;
  hasStems?: boolean;
  hasRealGrid?: boolean;
}

export interface MusicTheoryTrackRecommendation {
  track: MusicTheoryTrackInput;
  totalScore: number;
  harmonic: HarmonicAnalysis;
  groove: GrooveInterlockAnalysis;
  choreography: TurntablistChoreography;
  subBassPhaseCoherence: number;
  pitchShiftSemitones: number;
}

const CAMELOT_INFO: Record<
  string,
  { musicalKey: string; pitchClass: number; subBassHz: number }
> = {
  "1A": { musicalKey: "A♭ Minor", pitchClass: 8, subBassHz: 51.91 },
  "1B": { musicalKey: "B Major", pitchClass: 11, subBassHz: 61.74 },
  "2A": { musicalKey: "E♭ Minor", pitchClass: 3, subBassHz: 38.89 },
  "2B": { musicalKey: "F♯ Major", pitchClass: 6, subBassHz: 46.25 },
  "3A": { musicalKey: "B♭ Minor", pitchClass: 10, subBassHz: 58.27 },
  "3B": { musicalKey: "D♭ Major", pitchClass: 1, subBassHz: 69.30 },
  "4A": { musicalKey: "F Minor", pitchClass: 5, subBassHz: 43.65 },
  "4B": { musicalKey: "A♭ Major", pitchClass: 8, subBassHz: 51.91 },
  "5A": { musicalKey: "C Minor", pitchClass: 0, subBassHz: 65.41 },
  "5B": { musicalKey: "E♭ Major", pitchClass: 3, subBassHz: 38.89 },
  "6A": { musicalKey: "G Minor", pitchClass: 7, subBassHz: 49.00 },
  "6B": { musicalKey: "B♭ Major", pitchClass: 10, subBassHz: 58.27 },
  "7A": { musicalKey: "D Minor", pitchClass: 2, subBassHz: 36.71 },
  "7B": { musicalKey: "F Major", pitchClass: 5, subBassHz: 43.65 },
  "8A": { musicalKey: "A Minor", pitchClass: 9, subBassHz: 55.00 },
  "8B": { musicalKey: "C Major", pitchClass: 0, subBassHz: 65.41 },
  "9A": { musicalKey: "E Minor", pitchClass: 4, subBassHz: 41.20 },
  "9B": { musicalKey: "G Major", pitchClass: 7, subBassHz: 49.00 },
  "10A": { musicalKey: "B Minor", pitchClass: 11, subBassHz: 61.74 },
  "10B": { musicalKey: "D Major", pitchClass: 2, subBassHz: 36.71 },
  "11A": { musicalKey: "F♯ Minor", pitchClass: 6, subBassHz: 46.25 },
  "11B": { musicalKey: "A Major", pitchClass: 9, subBassHz: 55.00 },
  "12A": { musicalKey: "D♭ Minor", pitchClass: 1, subBassHz: 69.30 },
  "12B": { musicalKey: "E Major", pitchClass: 4, subBassHz: 41.20 },
};

export function parseCamelotCode(raw: string | null | undefined): {
  code: string;
  num: number;
  letter: "A" | "B";
  musicalKey: string;
  pitchClass: number;
  subBassHz: number;
} | null {
  const code = toCamelot(raw);
  if (!code) return null;
  const m = /^(\d{1,2})([AB])$/.exec(code);
  if (!m) return null;
  const info = CAMELOT_INFO[code];
  if (!info) return null;
  return {
    code,
    num: Number(m[1]),
    letter: m[2] as "A" | "B",
    musicalKey: info.musicalKey,
    pitchClass: info.pitchClass,
    subBassHz: info.subBassHz,
  };
}

/**
 * Signed circular wheel step delta in [-5, +6] from `fromNum` to `toNum` on the 1..12 Camelot clock.
 */
function signedWheelDelta(fromNum: number, toNum: number): number {
  const raw = (toNum - fromNum + 12) % 12;
  return raw > 6 ? raw - 12 : raw;
}

/**
 * Signed semitone distance in [-5, +6] between two pitch classes (0..11).
 */
function signedSemitoneDelta(fromPc: number, toPc: number): number {
  const raw = (toPc - fromPc + 12) % 12;
  return raw > 6 ? raw - 12 : raw;
}

/**
 * 8-Mode Camelot & Circle-of-Fifths Harmonic Modulation Analyzer.
 */
export function analyzeHarmonicRelationship(
  fromKeyRaw: string | null | undefined,
  toKeyRaw: string | null | undefined
): HarmonicAnalysis {
  const left = parseCamelotCode(fromKeyRaw);
  const right = parseCamelotCode(toKeyRaw);

  if (!left || !right) {
    return {
      fromCamelot: left?.code ?? null,
      toCamelot: right?.code ?? null,
      fromMusicalKey: left?.musicalKey ?? "Untagged",
      toMusicalKey: right?.musicalKey ?? "Untagged",
      fromSubBassHz: left?.subBassHz ?? null,
      toSubBassHz: right?.subBassHz ?? null,
      mode: "non_harmonic_percussion_bridge",
      wheelStepDelta: null,
      semitoneDelta: null,
      harmonicScore: 0.68,
      compatibleForMelodicBlend: false,
      requiresPercussionLock: true,
      headline: "Untagged Key — Rhythm-First Percussion Bridge",
      djCoachingNote:
        "Key metadata missing on one deck; isolate drums/bass loop and execute a crisp 250Hz bass swap.",
      recommendedEqSwap: "instant-bass-swap",
    };
  }

  const wheelDelta = signedWheelDelta(left.num, right.num);
  const semitones = signedSemitoneDelta(left.pitchClass, right.pitchClass);
  const sameLetter = left.letter === right.letter;

  // 1. Tonic Lock (e.g. 8A -> 8A)
  if (wheelDelta === 0 && sameLetter) {
    return {
      fromCamelot: left.code,
      toCamelot: right.code,
      fromMusicalKey: left.musicalKey,
      toMusicalKey: right.musicalKey,
      fromSubBassHz: left.subBassHz,
      toSubBassHz: right.subBassHz,
      mode: "tonic_lock",
      wheelStepDelta: 0,
      semitoneDelta: 0,
      harmonicScore: 1.0,
      compatibleForMelodicBlend: true,
      requiresPercussionLock: false,
      headline: `${left.code} (${left.musicalKey}) → ${right.code} · 1:1 Tonic Lock`,
      djCoachingNote: `Identical root (${left.subBassHz.toFixed(1)}Hz sub fundamental). Full 16–32 bar 4-stem melodic & vocal weave is 100% phase-pure.`,
      recommendedEqSwap: "stem-bass-cut-bar-4",
    };
  }

  // 2. Relative Minor/Major Pivot (e.g. 8A <-> 8B, Am <-> C Major)
  if (wheelDelta === 0 && !sameLetter) {
    const direction = left.letter === "A" ? "Minor → Relative Major Lift" : "Major → Relative Minor Deepening";
    return {
      fromCamelot: left.code,
      toCamelot: right.code,
      fromMusicalKey: left.musicalKey,
      toMusicalKey: right.musicalKey,
      fromSubBassHz: left.subBassHz,
      toSubBassHz: right.subBassHz,
      mode: "relative_pivot",
      wheelStepDelta: 0,
      semitoneDelta: semitones,
      harmonicScore: 0.96,
      compatibleForMelodicBlend: true,
      requiresPercussionLock: false,
      headline: `${left.code} (${left.musicalKey}) ↔ ${right.code} (${right.musicalKey}) · ${direction}`,
      djCoachingNote:
        "Zero key-signature alteration (all 7 diatonic notes shared). Ideal for shifting emotional color without harmonic friction.",
      recommendedEqSwap: "gradual-low-shelf",
    };
  }

  // 3. Circle of Fifths Dominant Lift (+1 Camelot, same mode, e.g. 8A -> 9A)
  if (wheelDelta === 1 && sameLetter) {
    return {
      fromCamelot: left.code,
      toCamelot: right.code,
      fromMusicalKey: left.musicalKey,
      toMusicalKey: right.musicalKey,
      fromSubBassHz: left.subBassHz,
      toSubBassHz: right.subBassHz,
      mode: "dominant_fifth",
      wheelStepDelta: 1,
      semitoneDelta: semitones,
      harmonicScore: 0.94,
      compatibleForMelodicBlend: true,
      requiresPercussionLock: false,
      headline: `${left.code} → ${right.code} (${right.musicalKey}) · +1 Dominant Fifth Lift`,
      djCoachingNote:
        "Up a Perfect 5th (+7 semitones, 6 of 7 scale tones shared). Brightens the room and naturally raises dancefloor momentum.",
      recommendedEqSwap: "gradual-low-shelf",
    };
  }

  // 4. Subdominant Fourth Groove (-1 Camelot, same mode, e.g. 8A -> 7A)
  if (wheelDelta === -1 && sameLetter) {
    return {
      fromCamelot: left.code,
      toCamelot: right.code,
      fromMusicalKey: left.musicalKey,
      toMusicalKey: right.musicalKey,
      fromSubBassHz: left.subBassHz,
      toSubBassHz: right.subBassHz,
      mode: "subdominant_fourth",
      wheelStepDelta: -1,
      semitoneDelta: semitones,
      harmonicScore: 0.92,
      compatibleForMelodicBlend: true,
      requiresPercussionLock: false,
      headline: `${left.code} → ${right.code} (${right.musicalKey}) · -1 Subdominant Deep Groove`,
      djCoachingNote:
        "Up a Perfect 4th (-5 semitones, 6 of 7 scale tones shared). Resolves harmonic tension into a deeper, heavier pocket.",
      recommendedEqSwap: "gradual-low-shelf",
    };
  }

  // 5. Peak-Hour Whole-Step Energy Boost (+2 Camelot, same mode, e.g. 8A -> 10A)
  if (wheelDelta === 2 && sameLetter) {
    return {
      fromCamelot: left.code,
      toCamelot: right.code,
      fromMusicalKey: left.musicalKey,
      toMusicalKey: right.musicalKey,
      fromSubBassHz: left.subBassHz,
      toSubBassHz: right.subBassHz,
      mode: "energy_boost_whole_step",
      wheelStepDelta: 2,
      semitoneDelta: 2,
      harmonicScore: 0.89,
      compatibleForMelodicBlend: false,
      requiresPercussionLock: true,
      headline: `${left.code} → ${right.code} (${right.musicalKey}) · +2 Whole-Step Energy Boost`,
      djCoachingNote:
        "Classic +2 semitone hands-in-the-air modulation! Keep blend tight (4–8 bars) with a crisp Beat-1 bass swap so the key lift hits hard.",
      recommendedEqSwap: "instant-bass-swap",
    };
  }

  // 6. Parallel Minor/Major Modulation (same tonic root pitch class, e.g. 8A [Am] <-> 11B [A Maj], wheelDelta +3 for A->B or -3 for B->A)
  if (
    !sameLetter &&
    ((left.letter === "A" && wheelDelta === 3) || (left.letter === "B" && wheelDelta === -3))
  ) {
    return {
      fromCamelot: left.code,
      toCamelot: right.code,
      fromMusicalKey: left.musicalKey,
      toMusicalKey: right.musicalKey,
      fromSubBassHz: left.subBassHz,
      toSubBassHz: right.subBassHz,
      mode: "parallel_mode_shift",
      wheelStepDelta: wheelDelta,
      semitoneDelta: 0,
      harmonicScore: 0.86,
      compatibleForMelodicBlend: true,
      requiresPercussionLock: false,
      headline: `${left.code} (${left.musicalKey}) → ${right.code} (${right.musicalKey}) · Parallel Root Sun-Break`,
      djCoachingNote: `Shared tonic sub-bass root (${left.subBassHz.toFixed(1)}Hz) while flipping the 3rd degree between minor & major! Basslines lock 100%.`,
      recommendedEqSwap: "stem-bass-cut-bar-4",
    };
  }

  // 7. Semitone Surge (+7 Camelot / -5 wheelDelta, same mode, +1 semitone, e.g. 8A [Am] -> 3A [Bbm])
  if ((wheelDelta === -5 || semitones === 1) && sameLetter) {
    return {
      fromCamelot: left.code,
      toCamelot: right.code,
      fromMusicalKey: left.musicalKey,
      toMusicalKey: right.musicalKey,
      fromSubBassHz: left.subBassHz,
      toSubBassHz: right.subBassHz,
      mode: "semitone_surge",
      wheelStepDelta: wheelDelta,
      semitoneDelta: 1,
      harmonicScore: 0.84,
      compatibleForMelodicBlend: false,
      requiresPercussionLock: true,
      headline: `${left.code} → ${right.code} (${right.musicalKey}) · +1 Semitone Adrenaline Surge`,
      djCoachingNote:
        "Half-step (+1 semitone) festival drop modulation! Never overlap melodic pads; fire a 4-beat snare/timbale roll and hard-cut or bass-swap on Beat 1.",
      recommendedEqSwap: "instant-bass-swap",
    };
  }

  // 8. Diagonal Camelot Step (±1 wheelDelta with A<->B mode flip)
  if (Math.abs(wheelDelta) === 1 && !sameLetter) {
    return {
      fromCamelot: left.code,
      toCamelot: right.code,
      fromMusicalKey: left.musicalKey,
      toMusicalKey: right.musicalKey,
      fromSubBassHz: left.subBassHz,
      toSubBassHz: right.subBassHz,
      mode: "diagonal_camelot_step",
      wheelStepDelta: wheelDelta,
      semitoneDelta: semitones,
      harmonicScore: 0.78,
      compatibleForMelodicBlend: false,
      requiresPercussionLock: true,
      headline: `${left.code} → ${right.code} (${right.musicalKey}) · Diagonal Modal Step`,
      djCoachingNote:
        "Diagonal Camelot bridge: hold drums-only loop on outgoing deck, duck mids, and swap bass on the phrase boundary.",
      recommendedEqSwap: "instant-bass-swap",
    };
  }

  // 9. Non-Harmonic Percussion Bridge (incompatible keys)
  return {
    fromCamelot: left.code,
    toCamelot: right.code,
    fromMusicalKey: left.musicalKey,
    toMusicalKey: right.musicalKey,
    fromSubBassHz: left.subBassHz,
    toSubBassHz: right.subBassHz,
    mode: "non_harmonic_percussion_bridge",
    wheelStepDelta: wheelDelta,
    semitoneDelta: semitones,
    harmonicScore: 0.52,
    compatibleForMelodicBlend: false,
    requiresPercussionLock: true,
    headline: `${left.code} (${left.musicalKey}) ⚡ ${right.code} (${right.musicalKey}) · Percussion-Lock Guard`,
    djCoachingNote:
      "Dissonant interval if blended melodically — isolate Outgoing Drums (kill Vocals + Other stems), run Space Sweep, and drop Incoming on Beat 1.",
    recommendedEqSwap: "instant-bass-swap",
  };
}

/**
 * Classifies a track's rhythmic pulse, clave pattern, and low-end pocket DNA.
 */
export function classifyRhythmicGroove(track: {
  name: string;
  bpm?: number | null;
  genre?: string | null;
}): GrooveDNA {
  const resolvedGenre = (track.genre || resolveMusicMetadata({ name: track.name }).genre || "").toLowerCase();
  const lowerName = track.name.toLowerCase();
  const bpm = track.bpm ?? 100;

  if (/\b(salsa|son|mambo|gilberto santa rosa|hector lavoe|willie colon|celia cruz|grupo niche|marc anthony)\b/.test(resolvedGenre + " " + lowerName)) {
    return {
      family: "salsa_son_clave",
      label: "Salsa Son Clave (2-3 / 3-2)",
      clavePattern: "Son Clave 2-3 · Tumbao Bass on &2 + 4",
      kickAccentBeats: "Anticipated Bass Tumbao (No 4x4 Kick)",
      subBassCharacter: "Acoustic Baby-Bass Tumbao (70–140Hz)",
      socialDanceProtected: true,
    };
  }

  if (/\b(bachata|aventura|romeo santos|prince royce|monchy|frank reyes)\b/.test(resolvedGenre + " " + lowerName)) {
    return {
      family: "bachata_derecho_majao",
      label: "Bachata Derecho / Majao",
      clavePattern: "4/4 Bongo Martillo + Syncopated Bass Pick on 4&",
      kickAccentBeats: "Beats 1, 2&, 3, 4",
      subBassCharacter: "Warm Fingered Electric Bass (60–125Hz)",
      socialDanceProtected: true,
    };
  }

  if (/\b(merengue|mambo urbano|omega|elvis crespo|juan luis guerra| Eddy Herrera)\b/i.test(resolvedGenre + " " + lowerName)) {
    return {
      family: "merengue_marcha",
      label: "Merengue 2/4 Tambora Marcha",
      clavePattern: "2/4 Driving Tambora & Güira Pulse",
      kickAccentBeats: "Every Quarter Beat (1-2-3-4 Marcha)",
      subBassCharacter: "Punchy Staccato Tambora + Sub (65–120Hz)",
      socialDanceProtected: true,
    };
  }

  if (/\b(guaracha|tribal|aleteo|tech house|house|latin house)\b/.test(resolvedGenre + " " + lowerName) || (bpm >= 122 && bpm <= 134 && /medianoche|zapateo|club/i.test(lowerName))) {
    return {
      family: "guaracha_tribal_4x4",
      label: "Guaracha / Tribal House 4x4",
      clavePattern: "4x4 Club Kick + Syncopated Offbeat Brass/Zapateo",
      kickAccentBeats: "Four-on-the-Floor (1-2-3-4) + Offbeat High-Perc",
      subBassCharacter: "Tight Sidechained Sub-Bass (45–95Hz)",
      socialDanceProtected: false,
    };
  }

  if (/\b(trance|paul van dyk|oakenfold|tiesto|ferry corsten|above|eurodance)\b/.test(resolvedGenre + " " + lowerName)) {
    return {
      family: "trance_progressive_4x4",
      label: "Trance / Progressive 4x4 Rolling Bass",
      clavePattern: "4x4 Kick + 16th-Note Rolling Offbeat Arpeggio",
      kickAccentBeats: "Four-on-the-Floor (1-2-3-4)",
      subBassCharacter: "Sustained Saw/Sub Rolling Bassline (40–90Hz)",
      socialDanceProtected: false,
    };
  }

  if (/\b(cubaton|reparto|gente de zona|charanga habanera|chacal|yomil|jacob forever|el micha)\b/.test(resolvedGenre + " " + lowerName)) {
    return {
      family: "cubaton_timba",
      label: "Cubaton / Reparto Timba-Dembow",
      clavePattern: "Havana Timba Campana + Tresillo Dembow (3+3+2)",
      kickAccentBeats: "4x4 Kick + Syncopated Cuban Snare/Bell on 2& / 4&",
      subBassCharacter: "Deep 808 + Timba Bombo Sub (45–100Hz)",
      socialDanceProtected: false,
    };
  }

  if (/\b(hip-hop|hip hop|rap|trap|r&b)\b/.test(resolvedGenre + " " + lowerName)) {
    return {
      family: "hiphop_boom_trap",
      label: "Hip-Hop / 808 Half-Time Pocket",
      clavePattern: "Backbeat Snare on 2 & 4 + Triplet 808 Hi-Hats",
      kickAccentBeats: "Syncopated Boom-Bap / 808 Kick on 1 & 3&",
      subBassCharacter: "Long Sustained 808 Sub Glide (32–75Hz)",
      socialDanceProtected: false,
    };
  }

  return {
    family: "dembow_tresillo",
    label: "Dembow Tresillo (3+3+2)",
    clavePattern: "Jamaican/PR Dembow 3+3+2 Tresillo Snare",
    kickAccentBeats: "Heavy 4/4 Kick + Snare on 1+(3/4) and 2&",
    subBassCharacter: "Saturated Reggaeton 808 Sub (42–88Hz)",
    socialDanceProtected: false,
  };
}

const GROOVE_COMPATIBILITY_MATRIX: Record<GrooveFamilyId, Record<GrooveFamilyId, number>> = {
  dembow_tresillo: {
    dembow_tresillo: 1.0,
    cubaton_timba: 0.96,
    hiphop_boom_trap: 0.88,
    guaracha_tribal_4x4: 0.84,
    merengue_marcha: 0.78,
    trance_progressive_4x4: 0.68,
    bachata_derecho_majao: 0.58,
    salsa_son_clave: 0.52,
  },
  cubaton_timba: {
    cubaton_timba: 1.0,
    dembow_tresillo: 0.96,
    guaracha_tribal_4x4: 0.88,
    merengue_marcha: 0.85,
    hiphop_boom_trap: 0.8,
    salsa_son_clave: 0.72,
    bachata_derecho_majao: 0.62,
    trance_progressive_4x4: 0.68,
  },
  guaracha_tribal_4x4: {
    guaracha_tribal_4x4: 1.0,
    trance_progressive_4x4: 0.9,
    cubaton_timba: 0.88,
    dembow_tresillo: 0.84,
    merengue_marcha: 0.86,
    hiphop_boom_trap: 0.72,
    salsa_son_clave: 0.55,
    bachata_derecho_majao: 0.52,
  },
  trance_progressive_4x4: {
    trance_progressive_4x4: 1.0,
    guaracha_tribal_4x4: 0.9,
    dembow_tresillo: 0.68,
    cubaton_timba: 0.68,
    hiphop_boom_trap: 0.64,
    merengue_marcha: 0.65,
    salsa_son_clave: 0.45,
    bachata_derecho_majao: 0.45,
  },
  hiphop_boom_trap: {
    hiphop_boom_trap: 1.0,
    dembow_tresillo: 0.88,
    cubaton_timba: 0.8,
    guaracha_tribal_4x4: 0.72,
    trance_progressive_4x4: 0.64,
    merengue_marcha: 0.62,
    bachata_derecho_majao: 0.55,
    salsa_son_clave: 0.5,
  },
  salsa_son_clave: {
    salsa_son_clave: 1.0,
    cubaton_timba: 0.72,
    merengue_marcha: 0.76,
    bachata_derecho_majao: 0.74,
    dembow_tresillo: 0.52,
    guaracha_tribal_4x4: 0.55,
    hiphop_boom_trap: 0.5,
    trance_progressive_4x4: 0.45,
  },
  bachata_derecho_majao: {
    bachata_derecho_majao: 1.0,
    salsa_son_clave: 0.74,
    merengue_marcha: 0.72,
    dembow_tresillo: 0.58,
    cubaton_timba: 0.62,
    hiphop_boom_trap: 0.55,
    guaracha_tribal_4x4: 0.52,
    trance_progressive_4x4: 0.45,
  },
  merengue_marcha: {
    merengue_marcha: 1.0,
    guaracha_tribal_4x4: 0.86,
    cubaton_timba: 0.85,
    dembow_tresillo: 0.78,
    salsa_son_clave: 0.76,
    bachata_derecho_majao: 0.72,
    hiphop_boom_trap: 0.62,
    trance_progressive_4x4: 0.65,
  },
};

export function analyzeGrooveInterlock(
  fromTrack: MusicTheoryTrackInput,
  toTrack: MusicTheoryTrackInput,
  harmonic: HarmonicAnalysis
): GrooveInterlockAnalysis {
  const fromGroove = classifyRhythmicGroove(fromTrack);
  const toGroove = classifyRhythmicGroove(toTrack);
  const baseInterlock = GROOVE_COMPATIBILITY_MATRIX[fromGroove.family][toGroove.family] ?? 0.75;

  const fromBpm = fromTrack.bpm ?? 100;
  const toBpm = toTrack.bpm ?? 100;
  const sync = syncTempo(fromBpm, 1, toBpm);
  const rawRatio = fromBpm / Math.max(1, toBpm);
  const halfDoubleTimeUsed = rawRatio > 1.35 || rawRatio < 0.72;

  const tempoPenalty = sync.clamped ? 0.22 : Math.abs(1 - sync.tempo) * 1.4;
  const interlockScore = Math.max(0.35, Math.min(1.0, baseInterlock - tempoPenalty));

  // Choose optimal DJ transition and bar length
  let recommendedTransition: GrooveInterlockAnalysis["recommendedTransition"] = "bass_swap";
  let recommendedBars = 8;

  if (fromGroove.socialDanceProtected || toGroove.socialDanceProtected) {
    recommendedTransition = "gap";
    recommendedBars = 8;
  } else if (fromTrack.hasStems && toTrack.hasStems && !sync.clamped && Math.abs(1 - sync.tempo) <= 0.025 && harmonic.compatibleForMelodicBlend) {
    recommendedTransition = "stem_migrate";
    recommendedBars = 16;
  } else if (sync.clamped) {
    recommendedTransition = fromTrack.hasRealGrid ? "loop_blend" : "echo_out";
    recommendedBars = 4;
  } else if (!harmonic.compatibleForMelodicBlend) {
    recommendedTransition = "bass_swap";
    recommendedBars = 4;
  } else if (fromGroove.family === "trance_progressive_4x4" || toGroove.family === "trance_progressive_4x4") {
    recommendedTransition = "beatmatch_crossfade";
    recommendedBars = 16;
  } else {
    recommendedTransition = "bass_swap";
    recommendedBars = 8;
  }

  const subBassCrossoverHz =
    fromGroove.family === "hiphop_boom_trap" || toGroove.family === "dembow_tresillo" ? 180 : 220;

  const interlockSummary = `${fromGroove.label} → ${toGroove.label}${
    halfDoubleTimeUsed ? " (Half/Double-Time Lock)" : ""
  } · ${recommendedTransition.toUpperCase()} (${recommendedBars} bars)`;

  return {
    fromGroove,
    toGroove,
    interlockScore: Math.round(interlockScore * 1000) / 1000,
    tempoRatio: Math.round(sync.tempo * 10000) / 10000,
    halfDoubleTimeUsed,
    tempoClamped: sync.clamped,
    subBassCrossoverHz,
    recommendedTransition,
    recommendedBars,
    interlockSummary,
  };
}

/**
 * Computes the 4-Stage Phrase-Locked Turntablist Choreography for a track pair.
 */
export function planTurntablistChoreography(
  fromTrack: MusicTheoryTrackInput,
  toTrack: MusicTheoryTrackInput,
  harmonic: HarmonicAnalysis,
  groove: GrooveInterlockAnalysis
): TurntablistChoreography {
  // Partner dance floor rule: zero mid-track SFX/scratches, warm sonero coro only
  if (groove.fromGroove.socialDanceProtected || groove.toGroove.socialDanceProtected) {
    return {
      comboId: "sonero_clean_handoff",
      comboTitle: "🌴 Social-Dance Clean Ending + Warm Sonero Stamp",
      autoSafe: true,
      stages: [
        {
          stageNumber: 1,
          code: "stage1_tension",
          timingLabel: "Outro Phrase",
          moveName: "Natural Outro Sustain",
          sfxOrAction: "none",
          reason: "Preserve unbroken clave/tumbao timing for partner dancers.",
        },
        {
          stageNumber: 2,
          code: "stage2_fill",
          timingLabel: "Final Bar",
          moveName: "Clean Decay (Zero Overlap)",
          sfxOrAction: "none",
          reason: "Let outgoing instrumentals ring out naturally before switching partners.",
        },
        {
          stageNumber: 3,
          code: "stage3_impact",
          timingLabel: "Beat 1 (Incoming)",
          moveName: "Full-Volume Intro Start",
          sfxOrAction: "gap",
          reason: "Start incoming salsa/bachata from 0:00 so dancers catch the intro call.",
        },
        {
          stageNumber: 4,
          code: "stage4_vocal_stamp",
          timingLabel: "Montuno / Coro Window",
          moveName: "Warm Sonero Support",
          sfxOrAction: "cue_warm",
          vocalClipFile: "cue-suave-warm.mp3",
          reason: "Soft sonero-style 'Con calma, que la noche es joven' in the vocal-free intro.",
        },
      ],
      summaryLine: "Clean Gap Handoff → Warm Sonero Stamp (cue-suave-warm.mp3)",
    };
  }

  // Guaracha / Tribal / Trance / Club 4x4 lane
  if (
    groove.toGroove.family === "guaracha_tribal_4x4" ||
    groove.toGroove.family === "trance_progressive_4x4"
  ) {
    return {
      comboId: "club_riser_cryo_zapateo",
      comboTitle: "🌪️ Club Riser → Crash Swell → CO2 Cryo Blast → ¡Fuego!",
      autoSafe: true,
      stages: [
        {
          stageNumber: 1,
          code: "stage1_tension",
          timingLabel: "Bars -4 to -2",
          moveName: "4s Supersaw Club Riser + ¼ Beat Roll",
          sfxOrAction: "riser",
          reason: "Sweeps 200Hz→8.5kHz while looping the outgoing kick to build peak-room tension.",
        },
        {
          stageNumber: 2,
          code: "stage2_fill",
          timingLabel: "Beats -4 to -1",
          moveName: "Reverse Metallic Crash Swell + ⅛ Tight Roll",
          sfxOrAction: "crash",
          reason: "1.2s reverse cymbal swell crests right on the incoming Beat 1.",
        },
        {
          stageNumber: 3,
          code: "stage3_impact",
          timingLabel: "Beat 1 Drop",
          moveName: "CO2 Cryo Jet + Brass Horn Stab",
          sfxOrAction: "cryo_jet",
          reason: "Pressurized festival CO2 blast + brass stab masks the 220Hz bass swap.",
        },
        {
          stageNumber: 4,
          code: "stage4_vocal_stamp",
          timingLabel: "Bar +2 Down-Part",
          moveName: "El Cerebro Laser Drop Stamp",
          sfxOrAction: "drop",
          vocalClipFile: "drop-fuego-laser.mp3",
          reason: "Drops '¡Fuego! El Cerebro en la mezcla' in the instrumental zapateo pocket.",
        },
      ],
      summaryLine: "Riser (Bar -4) → Crash + ⅛ Roll (Bar -1) → CO2 Cryo Jet (Beat 1) → drop-fuego-laser.mp3",
    };
  }

  // Hip-Hop / Wide BPM Jump / Semitone Surge lane
  if (
    groove.toGroove.family === "hiphop_boom_trap" ||
    harmonic.mode === "semitone_surge" ||
    groove.tempoClamped
  ) {
    return {
      comboId: "turntablist_chirp_spinback_808",
      comboTitle: "🎛️ Chirp Scratch → Spinback Wheel-Up → 808 Booyaka → Puro Cerebro",
      autoSafe: true,
      stages: [
        {
          stageNumber: 1,
          code: "stage1_tension",
          timingLabel: "Bar -2",
          moveName: "⅛ Slip Beat Roll + High-Pass Sweep",
          sfxOrAction: "roll_eighth",
          reason: "Locks the outgoing pocket into a tight 1/8th stutter while thinning low end.",
        },
        {
          stageNumber: 2,
          code: "stage2_fill",
          timingLabel: "Beats -3 to -1",
          moveName: "Chirp Scratch + Vinyl Spinback",
          sfxOrAction: "rewind",
          reason: "Classic turntablist wheel-up clears harmonic memory before the key/tempo jump.",
        },
        {
          stageNumber: 3,
          code: "stage3_impact",
          timingLabel: "Beat 1 Drop",
          moveName: "808 Booyaka Sub Shot + Dub Siren",
          sfxOrAction: "booyaka",
          reason: "Saturated 808 sub glide + Jamaican dub siren anchors the new downbeat.",
        },
        {
          stageNumber: 4,
          code: "stage4_vocal_stamp",
          timingLabel: "Bar +1 Intro Pocket",
          moveName: "Puro Cerebro Laser Stamp",
          sfxOrAction: "drop",
          vocalClipFile: "drop-purocerebro-laser.mp3",
          reason: "Stamps the new groove before firstVocalSeconds begins.",
        },
      ],
      summaryLine: "⅛ Roll (Bar -2) → Chirp + Rewind (Bar -1) → 808 Booyaka (Beat 1) → drop-purocerebro-laser.mp3",
    };
  }

  // Default Flagship Reggaeton / Dembow / Cubaton Perreo Combo
  return {
    comboId: "latin_timbale_subdrop_perreo",
    comboTitle: "🥁 Latin Timbale Fill → 808 Sub Drop → Brass Stab → ¡No Pare La Fiesta!",
    autoSafe: true,
    stages: [
      {
        stageNumber: 1,
        code: "stage1_tension",
        timingLabel: "Bars -3 to -2",
        moveName: "¼ Beat Roll + Dub Siren Echo",
        sfxOrAction: "dub_siren",
        reason: "Signals incoming perreo handoff while locking the 3+3+2 dembow pulse.",
      },
      {
        stageNumber: 2,
        code: "stage2_fill",
        timingLabel: "Beats -4 to -1",
        moveName: "8-Hit Tito-Style Timbale + Mambo Bell Fill",
        sfxOrAction: "timbale",
        reason: "Syncopated macho/hembra timbale roll + cowbell crack leads into Beat 1.",
      },
      {
        stageNumber: 3,
        code: "stage3_impact",
        timingLabel: "Beat 1 Bass Swap",
        moveName: "808 Sub-Bass Impact Drop (98Hz→33Hz)",
        sfxOrAction: "subdrop",
        reason: "Reinforces the 180Hz instant bass swap with chest-hitting sub weight.",
      },
      {
        stageNumber: 4,
        code: "stage4_vocal_stamp",
        timingLabel: "Bar +2 Vocal-Free Pocket",
        moveName: "El Cerebro Paisa Tag",
        sfxOrAction: "tag",
        vocalClipFile: "tag2-nopare.mp3",
        reason: "Fires '¡DJ Cerebro! ¡No pare la fiesta!' cleanly inside the beat-in window.",
      },
    ],
    summaryLine: "Dub Siren (Bar -2) → Timbale Fill (Bar -1) → 808 Sub Drop (Beat 1) → tag2-nopare.mp3",
  };
}

/**
 * Ranks candidate tracks from the crate against the currently playing track
 * using complete DJ music theory (Camelot modulation + Groove DNA + Tempo sync + Stem readiness).
 */
export function rankCandidatesByMusicTheory(
  liveTrack: MusicTheoryTrackInput,
  candidates: MusicTheoryTrackInput[],
  excludedIds: Set<string> = new Set()
): MusicTheoryTrackRecommendation[] {
  const results: MusicTheoryTrackRecommendation[] = [];

  for (const candidate of candidates) {
    if (candidate.id === liveTrack.id || excludedIds.has(candidate.id)) continue;

    const harmonic = analyzeHarmonicRelationship(liveTrack.key, candidate.key);
    const groove = analyzeGrooveInterlock(liveTrack, candidate, harmonic);
    const choreography = planTurntablistChoreography(liveTrack, candidate, harmonic, groove);

    const tempoScore = groove.tempoClamped
      ? 0.42
      : Math.max(0.6, 1 - Math.abs(1 - groove.tempoRatio) * 3.5);
    const stemBonus =
      (liveTrack.hasStems && candidate.hasStems ? 0.12 : candidate.hasStems ? 0.07 : 0) +
      (candidate.hasRealGrid ? 0.04 : 0);

    const totalScore =
      Math.round(
        (harmonic.harmonicScore * 0.36 +
          tempoScore * 0.30 +
          groove.interlockScore * 0.24 +
          stemBonus) *
          1000
      ) / 1000;

    const subBassPhaseCoherence = Math.round(
      Math.min(
        0.99,
        Math.max(
          0.62,
          0.78 +
            (harmonic.compatibleForMelodicBlend ? 0.11 : 0.02) +
            (groove.tempoClamped ? -0.1 : 0.06) +
            (candidate.hasRealGrid ? 0.04 : 0)
        )
      ) * 1000
    ) / 1000;

    const pitchShiftSemitones =
      Math.round(Math.max(-1.5, Math.min(1.5, 12 * Math.log2(Math.max(0.5, groove.tempoRatio)))) * 100) /
      100;

    results.push({
      track: candidate,
      totalScore,
      harmonic,
      groove,
      choreography,
      subBassPhaseCoherence,
      pitchShiftSemitones,
    });
  }

  return results.sort((a, b) => b.totalScore - a.totalScore);
}
