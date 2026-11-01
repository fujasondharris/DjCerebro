import assert from 'node:assert/strict';
import manifest from '../src/data/crate-manifest.json' with { type: 'json' };
import {playbackMetadata} from '../src/lib/playback-metadata.ts';
for (const name of ['Pobre Diabla', 'A Tu Merced']) {
  const entry=manifest.find(t=>t.name.includes(name));
  const identity={id:entry.id,source:'drive',size:entry.size};
  const tags={bpm:92,key:'Am'};
  const restored=playbackMetadata(tags,null,identity,entry,entry.durationSeconds);
  assert.equal(restored.grid,entry.grid);assert.equal(restored.gridSource,'manifest');
  assert.equal(playbackMetadata(tags,null,identity,entry).grid,null,'do not trust before decoding');
  for (const changed of [{...identity,id:'old-id'},{...identity,size:entry.size-1},{...identity,source:'local'}]) {
    assert.equal(playbackMetadata(tags,null,changed,entry,entry.durationSeconds).grid,null);
  }
  assert.equal(playbackMetadata(tags,null,identity,entry,entry.durationSeconds+1).grid,null);
  assert.equal(playbackMetadata({...tags,bpm:120},null,identity,entry,entry.durationSeconds).grid,null);
  assert.equal(playbackMetadata(tags,null,identity,{...entry,grid:{...entry.grid,anchor:NaN}},entry.durationSeconds).grid,null);
  const embedded={...entry.grid,anchor:0.3};
  assert.equal(playbackMetadata(tags,embedded,identity,entry,entry.durationSeconds).grid,embedded);
}
console.log('PASS: current Pobre Diabla/A Tu Merced grids restored only after exact ID/size and decoded timeline match; embedded grids preserved; mismatches refused');
