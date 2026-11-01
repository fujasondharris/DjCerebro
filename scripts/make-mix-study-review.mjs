#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR, SOURCE_DIR, PAGE_FILE, loadSources, loadMarks, assemble, atomicWrite, toCsv, LANES } from './mix-study.mjs';

const source = loadSources();
const marks = loadMarks();
const rows = assemble(source, marks);
const data = {
  schema_version: 1, source_directory: SOURCE_DIR,
  caveats: [
    'Machine candidates are not confirmed song changes. Nothing was auditioned by this generator.',
    'Overlap and blend-length columns remain blank where only a breakdown-zone bound was measured.',
    'A bass-stem energy drop is not silence. Source separation can bleed.',
    'London has two credited DJs; per-transition attribution is unresolved. Café Mambo is a 25-minute slice.',
    'Three Latin sets have no reliable candidate timestamps. The four radio slices are excluded.',
    'Position percent means position in the recording, not in a complete night.',
    'No lane has met the sample stopping rule. This tool does not tune or deploy Cerebro.',
  ],
  sets: source.sets, rows, ear_marks: marks.marks, extra_candidates: source.extra,
};
atomicWrite(path.join(DATA_DIR, 'marked-transitions.csv'), toCsv(rows));
atomicWrite(path.join(DATA_DIR, 'mix-study-review.json'), JSON.stringify(data, null, 2) + '\n');
const payload = { ...data, lanes: LANES, repo_root: ROOT };
const serialized = JSON.stringify(payload).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const template = readFileSync(new URL('./mix-study-review.html', import.meta.url), 'utf8');
atomicWrite(PAGE_FILE, template.replace('/*__STUDY_DATA__*/', () => serialized));
console.log(`${rows.filter(r => r.row_kind === 'candidate').length} candidate rows · ${marks.marks.length} listener annotations · ${rows.filter(r => r.row_kind === 'set_placeholder').length} unmarked Latin sets`);
console.log('Review page: ' + PAGE_FILE);
console.log('Table: ' + path.join(DATA_DIR, 'marked-transitions.csv'));
