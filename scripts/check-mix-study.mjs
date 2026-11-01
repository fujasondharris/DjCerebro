// Exercise real import/rebuild commands in an isolated directory; never marks real audio.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { ROOT } from './mix-study.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'cerebro-study-test-'));
const source = path.join(dir, 'source'), audio = path.join(dir, 'audio'), data = path.join(dir, 'data');
for (const d of [source,audio,data]) mkdirSync(d);
const env = { ...process.env, MIX_STUDY_SOURCE_DIR: source, MIX_STUDY_AUDIO_DIR: audio, MIX_STUDY_DATA_DIR: data, MIX_STUDY_PAGE: path.join(dir,'page.html') };
const put = (dir,name,obj) => writeFileSync(path.join(dir,name),JSON.stringify(obj));
const run = (script,args = []) => spawnSync(process.execPath,[path.join(ROOT,'scripts',script),...args],{env,encoding:'utf8'});
const read = name => JSON.parse(readFileSync(path.join(data,name),'utf8'));
const mark = m => run('mark-mix-study.mjs',['--base64',Buffer.from(JSON.stringify(m)).toString('base64url')]);
const fixture = set => ({set,index:1,lane:'trance-progressive',room:'club',dj:'unresolved',position_in_set:{seconds:100,pct:10},t_start:80,t_end:100,overlap_seconds:20,blend_length_in_8counts:6,seconds_of_outgoing_heard:100,seconds_of_silence:0,bass_swap:{t:100,mode:'gap'},landed_on_the_1:'no',effect_on_seam:'no',recipe:'R1',field_basis:{position_in_set:'measured',seconds_of_outgoing_heard:'inferred',landed_on_the_1:'inferred (+/-0.75 beat)',effect_on_seam:'inferred (riser only)',seconds_of_silence:'measured'}});
try {
  put(source,'transitions.json',['london','ibiza'].map(fixture));
  put(source,'tracks.json',{london:{tracks:[{end:1000}]},ibiza:{tracks:[{end:1000}]}});
  put(source,'extra_candidates.json',[]);
  put(audio,'structure.json',{measured:['Y0_lEkKa2YI','4GEpEz7O-Lw','UJG9pJSGgBA'].map(id => ({id,durationSec:1200}))});
  const beforeSource = readFileSync(path.join(source,'transitions.json'),'utf8');
  let r = run('make-mix-study-review.mjs');assert.equal(r.status,0,r.stderr);
  let snapshot = read('mix-study-review.json');
  assert.equal(snapshot.rows.length,5);
  assert.equal(snapshot.rows.filter(r => r.row_kind === 'set_placeholder').length,3);
  assert.equal(snapshot.rows.filter(r => r.review_status === 'ear_confirmed').length,0);
  assert.equal(snapshot.rows[0].overlap_seconds,null,'zone must never become true audible overlap');
  assert.equal(snapshot.rows[0].blend_length_in_8counts,null);
  assert.equal(snapshot.rows[0].handover_zone_seconds,20);
  const note = {row_id:'london:01',set_id:'london',reviewer:'Test listener',fields:{position_in_set_seconds:101,song_change:'yes',lane:'trance-progressive',overlap_seconds:4,notes:'=IMPORTXML("example")\nHeard <script> café 🎵'}};
  r = mark(note);assert.equal(r.status,0,r.stderr);
  snapshot = read('mix-study-review.json');let row = snapshot.rows.find(r => r.row_id === note.row_id);
  assert.equal(row.overlap_seconds,4);assert.equal(row.field_basis.overlap_seconds,'ear');
  assert.equal(row.field_basis.effect_on_seam,'inferred (riser only)','reviewing a row must not promote all source hints to ear evidence');
  assert.equal(row.handover_zone_seconds,20);assert.equal(row.position_in_set_pct,10.1);
  const csv = readFileSync(path.join(data,'marked-transitions.csv'),'utf8');
  assert.ok(csv.includes("'=IMPORTXML"),'protect spreadsheet cells');
  const html = readFileSync(path.join(dir,'page.html'),'utf8');
  assert.ok(!html.includes('Heard <script>'),'escape inline study JSON');
  const script = html.slice(html.indexOf('<script>')+8,html.lastIndexOf('</script>'));
  new vm.Script(script); // All emitted JS must parse, including Unicode listener text.
  const latin = {row_id:'Y0_lEkKa2YI:ear:100',set_id:'Y0_lEkKa2YI',reviewer:'Test listener',fields:{position_in_set_seconds:150,song_change:'uncertain',notes:'Need full song identity'}};
  r = mark(latin);assert.equal(r.status,0,r.stderr);
  snapshot = read('mix-study-review.json');
  assert.equal(snapshot.rows.filter(r => r.row_kind === 'set_placeholder').length,2);
  assert.equal(snapshot.rows.find(r => r.row_id === latin.row_id).review_status,'ear_uncertain');
  const stable = readFileSync(path.join(data,'mix-study-ear-marks.json'),'utf8');
  for (const bad of [
    {...note,fields:{...note.fields,position_in_set_seconds:1001}},
    {...note,fields:{...note.fields,overlap_seconds:-1}},
    {...note,fields:{...note.fields,field_basis:'ear'}},
    {...note,fields:{...note.fields,lane:''}},
    {...note,set_id:'unknown'},
    {...note,row_id:'Y0_lEkKa2YI:placeholder',set_id:'Y0_lEkKa2YI'},
    {...note,row_id:'ibiza:01'},
  ]) {
    r = mark(bad);assert.notEqual(r.status,0,'reject invalid or cross-set annotations');
    assert.equal(readFileSync(path.join(data,'mix-study-ear-marks.json'),'utf8'),stable,'invalid input cannot mutate saved marks');
  }
  r = mark({...note,fields:{position_in_set_seconds:101,song_change:'no'}});assert.equal(r.status,0,r.stderr);
  snapshot = read('mix-study-review.json');row = snapshot.rows.find(r => r.row_id === note.row_id);
  assert.equal(row.review_status,'ear_rejected');assert.equal(row.overlap_seconds,null,'clearing an ear overlay must restore the source, not preserve stale values');
  assert.equal(snapshot.ear_marks.length,2,'editing a row preserves other annotations without duplication');
  assert.ok(snapshot.rows.some(r => r.row_id === latin.row_id));
  r = run('make-mix-study-review.mjs');assert.equal(r.status,0,r.stderr);
  assert.equal(read('mix-study-review.json').ear_marks.length,2,'regeneration preserves ear work');
  assert.equal(readFileSync(path.join(source,'transitions.json'),'utf8'),beforeSource,'analysis files remain untouched');
  console.log('PASS: inferred bounds stay separate; partial ear provenance; safe Unicode/CSV/HTML; validated imports; edits and regeneration preserve annotations.');
} finally {rmSync(dir,{recursive:true,force:true});}
