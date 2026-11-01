// Private research utilities. No imports into the performer and no audio processing.
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DATA_DIR = process.env.MIX_STUDY_DATA_DIR || path.join(ROOT, 'docs/research');
export const SOURCE_DIR = process.env.MIX_STUDY_SOURCE_DIR || path.join(os.homedir(), 'dev/live-set-analysis');
export const AUDIO_DIR = process.env.MIX_STUDY_AUDIO_DIR || path.join(os.homedir(), 'dj-tools/mix-study');
export const MARKS_FILE = path.join(DATA_DIR, 'mix-study-ear-marks.json');
export const PAGE_FILE = process.env.MIX_STUDY_PAGE || path.join(os.homedir(), 'dj-tools/mix-study-review.html');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
export const LANES = ['trance-progressive', 'reggaeton-party', 'social-salsa', 'social-bachata', 'salsa-drinking', 'bachata-drinking', 'mixed-private-party', 'other'];
export const YES_NO = ['yes', 'no', 'uncertain'];
export const NUMERIC = ['position_in_set_seconds', 'seconds_of_outgoing_heard', 'overlap_seconds', 'seconds_of_silence', 'blend_length_in_8counts', 'phrase_position_bars', 'bpm_out', 'bpm_in', 'bass_swap_t'];
export const BOOLEAN = ['song_change', 'outgoing_played_to_end', 'landed_on_the_1', 'two_vocals_overlapping', 'effect_on_seam'];
export const TEXT = ['room', 'dj', 'recipe', 'bass_swap_mode', 'outgoing_song', 'incoming_song', 'notes'];
export const COLUMNS = ['row_id', 'row_kind', 'review_status', 'set_id', 'lane', 'room', 'dj', 'position_in_set_seconds', 'position_in_set_pct', 'song_change', 'outgoing_song', 'incoming_song', 'outgoing_played_to_end', 'seconds_of_outgoing_heard', 'overlap_seconds', 'seconds_of_silence', 'blend_length_in_8counts', 'landed_on_the_1', 'two_vocals_overlapping', 'effect_on_seam', 'bpm_out', 'bpm_in', 'bass_swap_t', 'bass_swap_mode', 'phrase_position_bars', 'recipe', 'handover_zone_start_seconds', 'handover_zone_end_seconds', 'handover_zone_seconds', 'handover_zone_length_in_8counts', 'basis', 'field_basis', 'source_ref', 'reviewer', 'reviewed_at', 'notes'];

export function atomicWrite(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  writeFileSync(temp, contents);
  renameSync(temp, file);
}

function audioFile(dir, token) {
  const matches = existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.mp3') && n.includes(token)) : [];
  if (matches.length > 1) throw new Error('Ambiguous recording: ' + token);
  return matches[0] ? path.join(dir, matches[0]) : null;
}

export function loadSources() {
  const transitions = read(path.join(SOURCE_DIR, 'transitions.json'));
  const tracks = read(path.join(SOURCE_DIR, 'tracks.json'));
  const extra = read(path.join(SOURCE_DIR, 'extra_candidates.json'));
  const structure = read(path.join(AUDIO_DIR, 'structure.json'));
  const latin = [
    ['Y0_lEkKa2YI', 'DJ Pisto · old-school perreo', 'reggaeton-party', 'party (recording label; confirm)', 'DJ Pisto'],
    ['4GEpEz7O-Lw', 'DJ Adoni · salsa / bachata drinking mix', '', 'drinking mix (not classified as social dance)', 'DJ Adoni'],
    ['UJG9pJSGgBA', 'DJ Joe Catador · private party in Cabrera', '', 'private party', 'DJ Joe Catador'],
  ].map(([id, title, lane, room, dj]) => {
    const meta = structure.measured.find(x => x.id === id);
    if (!meta) throw new Error('Missing set duration: ' + id);
    return { id, title, lane, room, dj, duration: meta.durationSec, audio_path: audioFile(AUDIO_DIR, '[' + id + ']'), family: 'latin', attribution: 'Room and DJ are recording metadata; mark each transition’s lane by ear.' };
  });
  const trance = ['london', 'ibiza'].map(id => ({
    id, title: id === 'london' ? 'London · PvD / Pete Tong, attribution unresolved' : 'Café Mambo · Paul van Dyk, 25-minute slice',
    lane: 'trance-progressive', room: transitions.find(x => x.set === id).room,
    dj: id === 'london' ? 'Paul van Dyk / Pete Tong (transition attribution unknown)' : 'Paul van Dyk',
    duration: tracks[id].tracks.at(-1).end, family: 'trance',
    audio_path: audioFile(SOURCE_DIR, 'set_' + id + '.mp3'),
    attribution: 'Two recordings, not two independent DJs; no default inferred. Café Mambo is a slice.',
  }));
  return { transitions, extra, sets: [...latin, ...trance].map(s => ({ ...s, audio_url: s.audio_path ? pathToFileURL(s.audio_path).href : null })) };
}

function machineRow(t) {
  // Keep source estimates separate from the ear-only overlap/blend columns.
  const b = t.field_basis;
  const row = {
    row_id: t.set + ':' + String(t.index).padStart(2, '0'), row_kind: 'candidate', review_status: 'needs_ear',
    set_id: t.set, lane: t.lane, room: t.room,
    dj: t.set === 'london' ? 'Paul van Dyk / Pete Tong (transition attribution unknown)' : t.dj,
    position_in_set_seconds: t.position_in_set.seconds, position_in_set_pct: t.position_in_set.pct,
    song_change: '', outgoing_played_to_end: '', seconds_of_outgoing_heard: t.seconds_of_outgoing_heard,
    overlap_seconds: null, blend_length_in_8counts: null, seconds_of_silence: t.seconds_of_silence,
    landed_on_the_1: t.landed_on_the_1 === 'unknown' ? '' : t.landed_on_the_1,
    two_vocals_overlapping: '', effect_on_seam: t.effect_on_seam,
    bpm_out: t.bpm_out, bpm_in: t.bpm_in,
    bass_swap_t: t.bass_swap.t, bass_swap_mode: t.bass_swap.mode,
    phrase_position_bars: t.phrase_position_bars, recipe: t.recipe,
    handover_zone_start_seconds: t.t_start, handover_zone_end_seconds: t.t_end,
    handover_zone_seconds: t.overlap_seconds, handover_zone_length_in_8counts: t.blend_length_in_8counts,
    source_ref: 'live-set-analysis/transitions.json#' + t.set + '/' + t.index,
    notes: t.notes, field_basis: {
      lane: 'recording metadata', room: 'recording metadata', dj: 'recording metadata; London attribution unresolved',
      position_in_set_seconds: b.position_in_set, position_in_set_pct: b.position_in_set,
      seconds_of_outgoing_heard: b.seconds_of_outgoing_heard,
      overlap_seconds: 'unmarked; source has a zone upper bound only',
      blend_length_in_8counts: 'unmarked; source has zone length only',
      seconds_of_silence: b.seconds_of_silence, landed_on_the_1: b.landed_on_the_1,
      effect_on_seam: b.effect_on_seam,
      bpm_out: b.bpm_out, bpm_in: b.bpm_in, bass_swap_t: b.bass_swap, bass_swap_mode: b.bass_swap,
      phrase_position_bars: b.phrase_position_bars, recipe: b.recipe,
      handover_zone_start_seconds: b.t_start, handover_zone_end_seconds: b.t_end,
      handover_zone_seconds: 'measured zone length; inferred upper bound on true overlap',
      handover_zone_length_in_8counts: b.blend_length_in_8counts,
    }, basis: 'measured+inferred',
  };
  return row;
}

export function loadMarks() {
  return existsSync(MARKS_FILE) ? read(MARKS_FILE) : { schema_version: 1, marks: [] };
}

export function validateMark(mark, sets, baseRows) {
  if (!mark || typeof mark !== 'object' || Array.isArray(mark)) throw new Error('Invalid mark');
  const set = sets.find(s => s.id === mark.set_id);
  if (!set) throw new Error('Unknown set');
  if (typeof mark.row_id !== 'string') throw new Error('Missing row ID');
  const existing = baseRows.find(r => r.row_id === mark.row_id && r.row_kind === 'candidate');
  if (existing ? existing.set_id !== set.id : !new RegExp('^' + set.id + ':ear:[0-9]+$').test(mark.row_id)) throw new Error('Row ID does not belong to this set');
  if (typeof mark.reviewer !== 'string' || !mark.reviewer.trim() || mark.reviewer.length > 120) throw new Error('Give the listener’s name');
  const f = mark.fields;
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error('Missing fields');
  for (const [k, v] of Object.entries(f)) {
    if (NUMERIC.includes(k)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('Invalid nonnegative number: ' + k);
      if (['position_in_set_seconds', 'seconds_of_outgoing_heard', 'overlap_seconds', 'seconds_of_silence', 'bass_swap_t'].includes(k) && v > set.duration) throw new Error('Time exceeds recording: ' + k);
      if (k.startsWith('bpm_') && (v < 20 || v > 400)) throw new Error('BPM outside 20–400');
    } else if (BOOLEAN.includes(k)) {
      if (!YES_NO.includes(v)) throw new Error('Invalid choice: ' + k);
    } else if (k === 'lane') {
      if (!LANES.includes(v)) throw new Error('Unknown lane');
    } else if (TEXT.includes(k)) {
      if (typeof v !== 'string' || v.length > 4000) throw new Error('Invalid text: ' + k);
    } else throw new Error('Unknown field: ' + k);
  }
  if (!Number.isFinite(f.position_in_set_seconds)) throw new Error('Mark the timestamp');
  if (!YES_NO.includes(f.song_change)) throw new Error('State whether the song changed (uncertain is allowed)');
  if (f.song_change === 'yes' && !f.lane) throw new Error('Choose a lane for a confirmed transition');
  return { row_id: mark.row_id, set_id: mark.set_id, reviewer: mark.reviewer.trim(), fields: f };
}

export function assemble(source, marks) {
  const rows = source.transitions.map(machineRow);
  for (const mark of marks.marks) {
    validateMark(mark, source.sets, rows);
    let row = rows.find(r => r.row_id === mark.row_id);
    if (!row) {
      const s = source.sets.find(s => s.id === mark.set_id);
      row = { row_id: mark.row_id, row_kind: 'candidate', set_id: s.id, lane: s.lane, room: s.room, dj: s.dj, field_basis: { lane: 'recording metadata', room: 'recording metadata', dj: 'recording metadata' }, source_ref: 'listener timestamp in local recording', basis: 'ear+metadata' };
      rows.push(row);
    }
    Object.assign(row, mark.fields);
    for (const k of Object.keys(mark.fields)) row.field_basis[k] = 'ear';
    const s = source.sets.find(s => s.id === row.set_id);
    row.position_in_set_pct = Number((100 * row.position_in_set_seconds / s.duration).toFixed(3));
    row.field_basis.position_in_set_pct = 'derived from ear timestamp / recording duration; not position in a full night';
    row.review_status = row.song_change === 'yes' ? 'ear_confirmed' : row.song_change === 'no' ? 'ear_rejected' : 'ear_uncertain';
    row.basis = row.source_ref.startsWith('live-set-analysis') ? 'measured+inferred+ear' : 'ear+metadata';
    row.reviewer = mark.reviewer; row.reviewed_at = mark.reviewed_at;
  }
  for (const s of source.sets.filter(s => s.family === 'latin')) {
    if (!rows.some(r => r.set_id === s.id)) rows.push({ row_id: s.id + ':placeholder', row_kind: 'set_placeholder', review_status: 'unmarked_set', set_id: s.id, lane: s.lane, room: s.room, dj: s.dj, basis: 'metadata_only', field_basis: { lane: 'recording metadata; confirm by ear', room: 'recording metadata', dj: 'recording metadata' }, source_ref: 'mix-sample-handoff.md', notes: 'No reliable candidate times. Add while listening. Not a transition or a marked set.' });
  }
  return rows;
}

export function toCsv(rows) {
  // Protect human-entered song titles/notes when the CSV is opened in a spreadsheet.
  const cell = v => {
    let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (typeof v === 'string' && /^[\s]*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return COLUMNS.join(',') + '\n' + rows.map(r => COLUMNS.map(k => cell(r[k])).join(',')).join('\n') + '\n';
}
