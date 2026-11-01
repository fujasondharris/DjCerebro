#!/usr/bin/env node
// Import an explicit listener annotation. Replaces only that row's ear overlay.
import { atomicWrite, loadSources, loadMarks, assemble, validateMark, MARKS_FILE } from './mix-study.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--base64' || !/^[A-Za-z0-9_-]+$/.test(args[1])) throw new Error('Usage: node scripts/mark-mix-study.mjs --base64 <page-generated payload>');
  const source = loadSources();
  const store = loadMarks();
  const rows = assemble(source, store);
  const mark = validateMark(JSON.parse(Buffer.from(args[1], 'base64url').toString('utf8')), source.sets, rows);
  mark.reviewed_at = new Date().toISOString();
  store.marks = [...store.marks.filter(m => m.row_id !== mark.row_id), mark];
  atomicWrite(MARKS_FILE, JSON.stringify(store, null, 2) + '\n');
  console.log('Recorded ' + mark.row_id + ' · ' + mark.fields.song_change + ' song change · listener ' + mark.reviewer);
  await import('./make-mix-study-review.mjs');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
