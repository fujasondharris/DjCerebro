#!/usr/bin/env node
// Drive the actual audio-node scheduling APIs with a recording AudioContext.
// This verifies emitted clocks, offsets, envelopes and cleanup, not musical taste.
import assert from 'node:assert/strict';
import { Deck } from '../src/lib/deck.ts';
import { loadStemSet, startStemSet, disposeStemSet, scheduleMigration } from '../src/lib/stems.ts';
import { planStemMigration, roleGainAt } from '../src/lib/stem-migration.ts';
import { abortable, stemClock, planTranceBreakdown } from '../src/lib/stem-performance.ts';
import { scratch, planScratchSegments } from '../src/lib/scratch.ts';
import { CommandSchema } from '../src/lib/brain.ts';
import { compatibleLoopPoints, isTranceTrackName } from '../src/lib/transition-recipes.ts';
import manifest from '../src/data/crate-manifest.json' with { type: 'json' };
import recipes from '../src/data/transition-recipes.json' with { type: 'json' };

class Param {
  value = 1; events = [];
  cancelScheduledValues(t) { this.events = this.events.filter(e => e.t < t); }
  cancelAndHoldAtTime(t) { const v = this.at(t); this.cancelScheduledValues(t); this.setValueAtTime(v,t); }
  setValueAtTime(v,t) { this.events.push({kind:'set',v,t}); }
  linearRampToValueAtTime(v,t) { this.events.push({kind:'ramp',v,t}); }
  setTargetAtTime(v,t) { this.setValueAtTime(v,t); }
  setValueCurveAtTime(values,t,d) { this.setValueAtTime(values[0],t); this.linearRampToValueAtTime(values.at(-1),t+d); }
  at(t) {
    let prev = {t:0,v:this.value};
    for (const e of [...this.events].sort((a,b) => a.t-b.t)) {
      if (e.t > t) return e.kind === 'ramp' ? prev.v + (e.v-prev.v)*(t-prev.t)/(e.t-prev.t) : prev.v;
      prev=e;
    }
    return prev.v;
  }
}
class Node extends EventTarget {
  gain = new Param(); frequency = new Param(); Q = new Param(); playbackRate = new Param(); delayTime = new Param();
  connections = []; disconnected = false;
  connect(n) { this.connections.push(n); }
  disconnect() { this.disconnected=true; }
  start(...args) { this.startArgs=args; }
  stop(...args) { this.stopArgs=args; }
}
const buffer = (channels,length,sampleRate) => {
  const data = Array.from({length:channels},() => new Float32Array(length));
  return { numberOfChannels:channels,length,sampleRate,duration:length/sampleRate,getChannelData:c => data[c],copyToChannel:(src,c) => data[c].set(src) };
};
class Context {
  currentTime=10; sampleRate=8000; state='running'; nodes=[];
  make() { const n=new Node();this.nodes.push(n);return n; }
  createGain=() => this.make(); createBiquadFilter=() => this.make(); createDelay=() => this.make();
  createConvolver=() => this.make(); createBufferSource=() => this.make(); createScriptProcessor=() => this.make();
  createBuffer=buffer;
  async decodeAudioData() { return buffer(2,120*this.sampleRate,this.sampleRate); }
}
const ctx=new Context(), core={ensureContext:() => ctx,master:new Node()};
const deck=new Deck(core);
await deck.decode(new ArrayBuffer(1));
const preparedBuffer = deck.audioBuffer, cancelledDecode = new AbortController();
const decoding = deck.decode(new ArrayBuffer(1), cancelledDecode.signal);
cancelledDecode.abort();
await assert.rejects(decoding);
assert.equal(deck.audioBuffer,preparedBuffer,'late canceled decode must not replace the prepared track');
const neverFinishes = new AbortController();
const bounded = abortable(new Promise(() => {}),neverFinishes.signal);
neverFinishes.abort();await assert.rejects(bounded);
deck.setGain(1);
deck.scheduleGainEnvelope([1,0],0.05,12);
assert.equal(deck.gainNode.gain.at(11),1,'the live deck must not fade while waiting for a phrase');
assert.equal(deck.gainNode.gain.at(12),1);
assert.equal(deck.gainNode.gain.at(12.05),0);
deck.scheduleEqEnvelope('high',[0,-20],4,14);
assert.equal(deck.highFilter.gain.at(14),0);assert.equal(deck.highFilter.gain.at(18),-20);

deck.scheduleBufferPlayback(50,20,96/97);
const native=deck.scheduledSource.source;
assert.deepEqual(native.startArgs,[50,20]);
ctx.currentTime=63; // Simulate a delayed browser callback: source already scheduled.
assert.ok(Math.abs(deck.positionSeconds-(20+13*96/97))<1e-9);
deck.seekBy(0.08);
assert.ok(Math.abs(deck.positionSeconds-(20+13*96/97+0.08))<1e-9,'manual nudge must use the live native clock, not the stale entry offset');
deck.pause();assert.ok(native.stopArgs);assert.equal(deck.playing,false);
assert.equal(deck.scheduledSource,null,'pause cancels a future/native start and its UI timer');
assert.throws(() => deck.scheduleBufferPlayback(80,200,1),/not prepared/);
assert.equal(deck.playing,false);
ctx.currentTime=10;

const clock=stemClock({now:10,delay:2,outgoingPosition:20,outgoingRate:1,outgoingBpm:96,incomingBpm:97,incomingAnchor:0.25,beatIn:13,bars:16});
assert.equal(clock.incomingRate,96/97);
assert.ok(Math.abs((clock.incomingOffset-0.25)/(240/97)-Math.round((clock.incomingOffset-0.25)/(240/97)))<1e-9);
assert.ok(clock.incomingOffset>=13);
const drop=stemClock({now:10,delay:2,outgoingPosition:20,outgoingRate:1,outgoingBpm:140,incomingBpm:140,incomingAnchor:0,beatIn:0,bars:16,dropSeconds:80});
assert.ok(Math.abs(drop.incomingOffset+drop.duration*drop.incomingRate-80)<1e-9);
assert.throws(() => stemClock({now:10,delay:2,outgoingPosition:20,outgoingRate:1,outgoingBpm:140,incomingBpm:140,incomingAnchor:0,beatIn:0,bars:64,dropSeconds:5}));

const entry={name:'test',model:'test',stems:{drums:'d',bass:'b',other:'h',vocals:'v'}};
let concurrent=0,maxConcurrent=0;
const fetcher=async () => { concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);await Promise.resolve();concurrent--;return new ArrayBuffer(1); };
const out=await loadStemSet(core,'out',entry,fetcher,{fromSeconds:10,toSeconds:20,maxDecodedBytes:3e6});
const inc=await loadStemSet(core,'in',entry,fetcher,{fromSeconds:5,toSeconds:15,maxDecodedBytes:3e6});
assert.equal(maxConcurrent,2,'prefetch at most two compressed stem files at a time');
assert.equal(out.stems.get('bass').buffer.duration,10);
assert.equal(out.decodedBytes,4*2*10*ctx.sampleRate*4);
startStemSet(core,out,{when:12,offsetSeconds:11,playbackRate:1});
startStemSet(core,inc,{when:12,offsetSeconds:6,playbackRate:96/97});
assert.deepEqual(out.stems.get('bass').source.startArgs,[12,1],'source offset accounts for retained window');
assert.equal(inc.stems.get('bass').source.playbackRate.value,96/97);
const plan=planStemMigration({outgoingStems:Object.keys(entry.stems),incomingStems:Object.keys(entry.stems),bpm:96,totalBars:16});
scheduleMigration(ctx,plan,out,inc,12);
for (let bar=0;bar<=16;bar+=0.125) {
  const t=12+bar*plan.barSeconds;
  assert.ok(Math.abs(out.stems.get('bass').gain.gain.at(t)+inc.stems.get('bass').gain.gain.at(t)-1)<1e-7,'actual emitted automation preserves one bass carrier');
}
assert.throws(() => scheduleMigration(ctx,{...plan,ramps:[...plan.ramps,plan.ramps[0]]},out,inc,12),/Conflicting/);
await assert.rejects(loadStemSet(core,'over-budget',entry,fetcher,{maxDecodedBytes:1}),/budget/);
const aborted=new AbortController();aborted.abort();
await assert.rejects(loadStemSet(core,'aborted',entry,fetcher,{signal:aborted.signal}));
disposeStemSet(out);disposeStemSet(inc);
assert.equal(out.stems.size,0);

const trance=planTranceBreakdown(Object.keys(entry.stems),Object.keys(entry.stems),140,16);
assert.equal(roleGainAt(trance.ramps,'bass',8),0,'intentional bass gap is scoped to this distinct plan');
assert.ok(roleGainAt(trance.ramps,'harmony',8)>0.9);
assert.equal(roleGainAt(trance.ramps,'bass',16),1);
assert.equal(roleGainAt(trance.ramps,'rhythm',16),1);
assert.throws(() => planTranceBreakdown(['bass'],['bass','drums'],140,16),/melody/);
assert.equal(isTranceTrackName('Aventura Bachata Mix'),false);
assert.equal(isTranceTrackName('Paul van Dyk - For an Angel'),true);
assert.equal(isTranceTrackName('ATB - 9Pm (Till I Come).mp3'),true);
assert.equal(isTranceTrackName('Alice Deejay - Alice Deejay - Better Off Alone (Official Video).mp3'),true);
assert.equal(isTranceTrackName('Tiësto - Tiësto - Adagio For Strings.mp3'),true);
assert.equal(isTranceTrackName('Energy 52 - Energy 52： Café Del Mar (Three \'n One Radio Remix) (official video).mp3'),true);
assert.equal(isTranceTrackName('Robert Miles - Robert Miles - Children (Official Video).mp3'),true);
assert.equal(isTranceTrackName('protectorofillinois3 - Delerium feat. Sarah McLachlan - Silence (Tiesto\'s In Search of Sunrise Remix) [HD].mp3'),true);
assert.ok(CommandSchema.safeParse({action:'trance_breakdown',trackId:'1',bars:16,dropSeconds:80,say:'A melodic handover'}).success);
assert.equal(CommandSchema.safeParse({action:'trance_breakdown',trackId:'1',bars:16,say:'Guess'}).success,false);
assert.ok(CommandSchema.safeParse({action:'eq_sweep',band:'high',toDb:-20,bars:4,say:'Open the top on the phrase'}).success);

for (const bpm of [88,96,140]) for (const pattern of ['baby','chirp','spinback']) {
  const segments=planScratchSegments(pattern,30,120,bpm);
  const gaps=pattern==='chirp'? (120/bpm)*0.25:0;
  assert.ok(Math.abs(segments.reduce((sum,s) => sum+s.durationSeconds,0)+gaps-120/bpm)<1e-9,'scratch occupies two beats at the actual tempo');
  assert.ok(segments.every(s => s.offsetSeconds+s.durationSeconds*(s.rateStart+s.rateEnd)/2<=120));
}
const startNodes=ctx.nodes.length;
assert.ok(scratch(deck,core,'spinback',96));
const scratchSources=ctx.nodes.slice(startNodes).filter(n => n.startArgs);
assert.equal(scratchSources.length,2);
assert.ok(scratchSources.every(s => s.startArgs.length===2 && s.stopArgs.length===1),'scratch uses output-time stops, not rate-dependent source durations');
assert.equal(deck.overlayDucker.gain.at(12),1,'underlying music recovers without a JS timer');
deck.dispose();

const ids=new Set(manifest.map(t => t.id));
assert.ok(Object.values(recipes.recipes).flat().every(r => ids.has(r.fromId)&&ids.has(r.toId)));
const track={...manifest.find(t => t.grid&&t.durationSeconds),source:'drive'};
const key='drive:'+track.id, analysis={bpm:track.grid.bpm,anchor:track.grid.anchor,durationSeconds:track.durationSeconds,loops:[],drops:[]};
assert.ok(compatibleLoopPoints([track],{[key]:analysis})[key]);
assert.equal(Object.keys(compatibleLoopPoints([track],{[key]:{...analysis,durationSeconds:analysis.durationSeconds+5}})).length,0,'trimmed timeline cannot inherit old drop cues');
// Compressed downloads overlap, while loadStemSet still decodes serially.
let fetching = 0, peakFetching = 0, activeDecodes = 0, peakDecoding = 0;
const pipelinedContext = new Context();
pipelinedContext.decodeAudioData = async () => {
  activeDecodes++; peakDecoding = Math.max(peakDecoding, activeDecodes);
  await new Promise(resolve => setTimeout(resolve, 2));
  activeDecodes--; return buffer(1, 20 * 8000, 8000);
};
const pipelined = await loadStemSet({ ensureContext: () => pipelinedContext, master: new Node() }, 'test', {
  name: 'Test', model: 'test', stems: { drums: 'drums', bass: 'bass', vocals: 'vocals', other: 'other' },
}, async () => {
  fetching++; peakFetching = Math.max(peakFetching, fetching);
  await new Promise(resolve => setTimeout(resolve, 8));
  fetching--; return new ArrayBuffer(1);
}, { fromSeconds: 0, toSeconds: 10 });
assert.equal(peakFetching, 2, 'exactly two compressed downloads may overlap');
assert.equal(peakDecoding, 1, 'phone memory: full stem decodes never overlap');
assert.equal(pipelined.stems.size, 4);
disposeStemSet(pipelined);
await assert.rejects(loadStemSet(core, 'test', {name:'Test',model:'test',stems:{drums:'ok',bass:'fail'}}, async id => {
  if(id==='fail') throw new Error('prefetch failed'); return new ArrayBuffer(1);
}), /prefetch failed/);
console.log('PASS: real scheduling APIs, clocks/cancel, stem windows, bounded fetch overlap/serial decode, bass carrier, trance gap, scratch, validation and catalog joins.');
