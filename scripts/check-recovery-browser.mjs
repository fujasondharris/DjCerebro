// Real Drive audio + real browser audio engine; deterministic model replies.
// No paid inference, no cloud lesson writes, and isolated browser storage.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {musicLabel} from '../src/lib/music-metadata.ts';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base=process.env.TEST_BASE_URL || 'http://127.0.0.1:3198';
const manifest=JSON.parse(readFileSync(new URL('../src/data/crate-manifest.json',import.meta.url)));
const poor=manifest.find(t=>t.name==='Don Omar - Pobre Diabla.mp3');
const merced=manifest.find(t=>t.name.includes('A Tu Merced'));
const fixture=readFileSync(new URL('../public/fixtures/test-120bpm.mp3',import.meta.url));
// A long, deliberately untagged signal for negative/control tests. It must
// never be mistaken for one of the manifest's analyzed MP3 timelines.
const rate=16000,frames=rate*40,wav=Buffer.alloc(44+frames*2);
wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);
wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(frames*2,40);
for(let i=0;i<frames;i++)wav.writeInt16LE(Math.round(Math.sin(i/rate*2*Math.PI*180)*6000),44+i*2);
const browser=await chromium.launch({headless:true});
const catalog=['claude','fable','openai','grok','gemini','muse'].map(id=>({id,label:id,model:id,available:true}));
async function setup(entries,reply) {
 const context=await browser.newContext({viewport:{width:1280,height:1000}});
 if(process.env.DJ_PASSCODE)await context.addCookies([{name:'dj_pass',value:process.env.DJ_PASSCODE,url:base}]);
 await context.addInitScript(entries=>{
  localStorage.setItem('djsm.crate-metadata',JSON.stringify(entries));
  localStorage.setItem('djsm.brain-model','muse');
  window.__audioProof={loopStarts:0,peakRms:0,loopPeakRms:0,starts:[],samples:[]};
  const loopWindows=[];
  const start=AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start=function(...args){
   window.__audioProof.starts.push({when:args[0]??0,duration:this.buffer?.duration??0});
   if(this.loop){window.__audioProof.loopStarts++;const loopWindow={from:args[0]??this.context.currentTime,to:Infinity};
    loopWindows.push(loopWindow);this.addEventListener('ended',()=>{loopWindow.to=this.context.currentTime;});}
   return start.apply(this,args);
  };
  const connect=AudioNode.prototype.connect;
  AudioNode.prototype.connect=function(destination,...args){
   if(destination instanceof AudioDestinationNode&&!window.__audioProbe){
    const probe=this.context.createAnalyser();probe.fftSize=2048;connect.call(this,probe);window.__audioProbe=probe;
    const values=new Float32Array(2048);
    setInterval(()=>{probe.getFloatTimeDomainData(values);const rms=Math.sqrt(values.reduce((sum,x)=>sum+x*x,0)/values.length);
     window.__audioProof.peakRms=Math.max(rms,window.__audioProof.peakRms);
     window.__audioProof.samples.push({when:probe.context.currentTime,rms});
     if(loopWindows.some(w=>probe.context.currentTime>=w.from&&probe.context.currentTime<w.to))window.__audioProof.loopPeakRms=Math.max(rms,window.__audioProof.loopPeakRms);
    },100);
   }
   return connect.call(this,destination,...args);
  };
 },entries);
 await context.route('**/api/lessons',r=>r.fulfill({json:{events:[]}}));
 await context.route('**/api/crate-metadata',r=>r.fulfill({json:{overrides:[]}}));
 await context.route('**/sfx/**/*.mp3',r=>r.fulfill({contentType:'audio/mpeg',body:fixture}));
 const requests=[];
 await context.route('**/api/dj',async r=>{
  if(r.request().method()!=='POST')return r.fulfill({json:{models:catalog}});
  const body=r.request().postDataJSON();requests.push(body);
  const result=await reply(body,requests.length);
  await r.fulfill(result.error?{status:502,json:{error:result.error,provider:body.brainModel}}:
   {json:{command:result,provider:body.brainModel,model:'fixture-muse',latency_ms:1,cost_usd:0}}).catch(()=>{});
 });
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 if(process.env.TEST_NETWORK){
  const started=new Map();
  page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/crate/'))started.set(r,Date.now());});
  page.on('requestfinished',async r=>{if(!started.has(r))return;try{const response=await r.response();console.log(JSON.stringify({audioDownload:new URL(r.url()).pathname.split('/').at(-1),seconds:(Date.now()-started.get(r))/1000,status:response?.status(),bytes:(await r.sizes()).responseBodySize}));}catch{/* browser closed after test completion */}});
  page.on('requestfailed',r=>{if(started.has(r))console.log(JSON.stringify({audioDownload:new URL(r.url()).pathname.split('/').at(-1),seconds:(Date.now()-started.get(r))/1000,error:r.failure()?.errorText}));});
 }
 await page.goto(base);await page.waitForFunction(()=>!document.querySelector('[aria-label="Cerebro model"] option[value="muse"]')?.disabled);
 return {context,page,errors,requests};
}
async function send(page,message){await page.getByLabel('Vibe note to the brain').fill(message);await page.getByRole('button',{name:'Send',exact:true}).click();}
const deck=(page,name)=>page.locator('section').filter({has:page.getByText(name,{exact:true})});
const selectedCase=process.env.TEST_CASE || 'all';
try {
 if(selectedCase==='genre_recovery') {
  // Baile's old top-five recipes are ALL outside salsa/bachata. Recovery
  // must find a matching normal handoff beyond those recipes, not stop or
  // return to reggaeton. Controlled audio preserves ID/genre producer shapes.
  const run=await setup([manifest[415],manifest[350],poor].map(t=>({...t,size:wav.length})),(_body,n)=>{
   if(n===1)return {action:'queue',trackId:'0',transition:'cut',durationBars:4,startAt:'beginning'};
   return n===2?{error:'controlled provider failure'}:{action:'none',say:'Unexpected extra inference — test probe'};
  });
  try {
   await run.context.route('**/api/crate/*',r=>r.fulfill({contentType:'audio/wav',body:wav}));
   await send(run.page,'Salsa and bachata, 30 seconds per track, blend without breaks');
   await deck(run.page,'Deck A').getByRole('button',{name:'Pause',exact:true}).waitFor();
   await run.page.getByRole('checkbox',{name:/Ask selected model/}).check();
   await run.page.getByRole('button',{name:'Start autopilot',exact:true}).click();
   await run.page.getByText('handoff within your requested genres',{exact:false}).waitFor({timeout:22000});
   await deck(run.page,'Deck B').getByRole('button',{name:'Pause',exact:true}).waitFor({timeout:35000});
   assert.ok((await deck(run.page,'Deck B').innerText()).includes('Valio La Pena'));
   assert.ok(run.requests.every(r=>r.crate.every(t=>/salsa|bachata/i.test(t.genre))));
   assert.equal(run.requests.length,2);assert.deepEqual(run.errors,[]);
   await run.page.getByRole('button',{name:'Autopilot: ON',exact:true}).click();
   console.log('PASS: genre-constrained local recovery beyond stale top-five recipes; no off-genre song or extra inference');
  }catch(error){console.error('Browser log:',await run.page.locator('ul[aria-live="polite"]').innerText());throw error;}
  finally{await run.context.close();}
 }
 if(selectedCase==='real_salsa') {
  const salsa=manifest.find(t=>t.name.includes('Valio La Pena (Salsa Version)'));
  const target=manifest.find(t=>t.name.includes('Marc Anthony - Marc Anthony - Flor Pálida'));
  const run=await setup([salsa,target],(_body,n)=>({action:'queue',trackId:String(n-1),transition:n===1?'cut':'gap',durationBars:8,startAt:'beginning',...(n===1?{followUpSeconds:5}:{})}));
  try {
   await send(run.page,'30 seconds per track, salsa and bachata, blend without breaks');
   await deck(run.page,'Deck A').getByRole('button',{name:'Pause',exact:true}).waitFor({timeout:45000});
   const began=Date.now();
   await run.page.getByText('completed — "'+target.name,{exact:false}).waitFor({timeout:45000});
   assert.ok(await deck(run.page,'Deck B').getByRole('button',{name:'Pause',exact:true}).isVisible());
   assert.equal(await deck(run.page,'Deck A').getByRole('button',{name:'Pause',exact:true}).count(),0);
   assert.equal(run.requests.length,2);assert.deepEqual(run.errors,[]);
   const elapsed=(Date.now()-began)/1000,proof=await run.page.evaluate(()=>window.__audioProof);
   assert.ok(elapsed>=26&&elapsed<38,'real salsa handoff must land around the requested 30s, not song end');
   assert.ok(proof.peakRms>0.001);
   console.log(JSON.stringify({result:'PASS',case:'real salsa Valio La Pena to Flor Palida',elapsedSeconds:elapsed,peakRms:proof.peakRms,paidCalls:0}));
  }catch(e){console.error('Browser log:',await run.page.locator('ul[aria-live="polite"]').innerText());throw e;}
  finally{await run.context.close();}
 }
 if(['all','pending','short_gap'].includes(selectedCase)) {
  const salsa=manifest.find(t=>t.name.includes('Valio La Pena (Salsa Version)'));
  const recipes=JSON.parse(readFileSync(new URL('../src/data/transition-recipes.json',import.meta.url)));
  const first=manifest.find(t=>t.id===recipes.recipes[salsa.id][0].toId);
  const second=manifest.find(t=>t.id===recipes.recipes[first.id].find(r=>r.toId!==salsa.id).toId);
  const run=await setup([salsa,first,second].map(t=>({...t,size:wav.length})),(_body,n)=>{
   assert.ok(n<=3,'pending handoffs must not cause repeated inference');
   return {action:'queue',trackId:String(n-1),transition:n===1?'cut':'gap',durationBars:8,startAt:'beginning',followUpSeconds:5};
  });
  try {
   await run.context.route('**/api/crate/*',r=>r.fulfill({contentType:'audio/wav',body:wav}));
   await send(run.page,'30 seconds per track, blend without breaks');
   await deck(run.page,'Deck A').getByRole('button',{name:'Pause',exact:true}).waitFor();
   const began=Date.now();
   await deck(run.page,'Deck B').getByRole('button',{name:'Pause',exact:true}).waitFor({timeout:37000});
   assert.equal(await deck(run.page,'Deck A').getByRole('button',{name:'Pause',exact:true}).count(),0,'incoming must really take over, not be mislabeled Playing during a full-song wait');
   assert.ok(Date.now()-began>=27000&&Date.now()-began<36000,'first handoff lands near 30 seconds');
   await deck(run.page,'Deck A').getByRole('button',{name:'Pause',exact:true}).waitFor({timeout:37000});
   assert.equal(await deck(run.page,'Deck B').getByRole('button',{name:'Pause',exact:true}).count(),0);
   assert.ok((await deck(run.page,'Deck A').innerText()).includes(musicLabel(second)));
   assert.ok(Date.now()-began<69000,'second handoff must not wait for a whole song either');
   assert.equal(run.requests.length,3);assert.ok(run.requests.every(r=>!r.state.live?.transitionPending));
   assert.deepEqual(run.errors,[]);
   console.log('PASS: two consecutive 30-second salsa handoffs; full-song queue commands adapted; only three model calls, none during pending transitions');
  }catch(e){console.error('Browser log:',await run.page.locator('ul[aria-live="polite"]').innerText());throw e;}
  finally{await run.context.close();}
 }
 if(['all','pending','pending_edges'].includes(selectedCase)) for(const mode of ['full_gap','recipe_30','recovery_30','stalled_download','stop_gap','override_gap']) {
  const salsa=manifest.find(t=>t.name.includes('Valio La Pena (Salsa Version)'));
  const recipes=JSON.parse(readFileSync(new URL('../src/data/transition-recipes.json',import.meta.url)));
  const target=manifest.find(t=>t.id===recipes.recipes[salsa.id][0].toId);
  const run=await setup([salsa,target].map(t=>({...t,size:wav.length})),(_body,n)=>{
   if(n===1)return {action:'queue',trackId:'0',transition:'cut',durationBars:4,startAt:'beginning'};
   if(mode==='stalled_download'&&n>2)return {action:'none',say:'Preparation failed; no replacement requested by this test'};
   if(['stop_gap','override_gap'].includes(mode)&&n>2)return {action:'none',say:'Status probe'};
   if(mode==='recovery_30')return {error:'Gemini fixture unavailable (503)'};
   return {action:'queue',trackId:'1',transition:'gap',durationBars:8,startAt:'beginning',followUpSeconds:5};
  });
  let releaseDownload;
  try {
   await run.context.route('**/api/crate/*',async r=>{
    if(mode==='stalled_download'&&r.request().url().endsWith(target.id))await new Promise(resolve=>{releaseDownload=resolve;});
    await r.fulfill({contentType:'audio/wav',body:wav}).catch(()=>{});
   });
   await send(run.page,mode.endsWith('_30')?'30 seconds per track':'Start');
   await deck(run.page,'Deck A').getByRole('button',{name:'Pause',exact:true}).waitFor();
   if(mode.endsWith('_30')){
    // Age the standing request past the 45s fresh-note window that previously
    // let a default full-song recipe silently override the owner's instruction.
    await run.page.evaluate(()=>{const now=Date.now;Date.now=()=>now()+46000;});
    if(mode==='recovery_30')await run.page.getByRole('checkbox',{name:/Ask selected model/}).check();
    await run.page.getByRole('button',{name:'Start autopilot',exact:true}).click();
    await deck(run.page,'Deck B').getByRole('button',{name:'Pause',exact:true}).waitFor();
    assert.equal(await deck(run.page,'Deck A').getByRole('button',{name:'Pause',exact:true}).count(),0);
    await run.page.getByRole('button',{name:'Autopilot: ON',exact:true}).click();
    assert.equal(run.requests.length,mode==='recipe_30'?1:2);
    assert.ok(!(await run.page.locator('ul[aria-live="polite"]').innerText()).includes('full-song handoff'));
   }else{
    if(['stalled_download','override_gap'].includes(mode))await run.page.clock.install();
    await send(run.page,'Queue the next full song');
    await run.page.getByText('downloading "'+target.name,{exact:false}).waitFor();
    if(mode==='stalled_download'){
     await run.page.clock.runFor(46000);
     await run.page.getByText('audio preparation exceeded 45 seconds',{exact:false}).waitFor();
     releaseDownload();await run.page.waitForTimeout(500);
    }else{
     await run.page.getByText('full-song handoff armed',{exact:false}).waitFor();
     if(mode==='stop_gap'){
      await run.page.getByRole('button',{name:'Start autopilot',exact:true}).click();
      await run.page.getByRole('button',{name:'Autopilot: ON',exact:true}).click();
      await send(run.page,'Status only');
      await run.page.getByText('Status probe',{exact:false}).waitFor();
      assert.equal(run.requests[2].state.live.transitionPending,false);
     }else if(mode==='override_gap'){
      await send(run.page,'30 seconds per track, blend without breaks');
      await run.page.getByText('30s residency',{exact:false}).waitFor();
      await run.page.clock.runFor(31000);
      await deck(run.page,'Deck B').getByRole('button',{name:'Pause',exact:true}).waitFor();
      assert.equal(await deck(run.page,'Deck A').getByRole('button',{name:'Pause',exact:true}).count(),0);
     }else await run.page.waitForTimeout(6500);
    }
    if(mode!=='override_gap')assert.equal(await deck(run.page,'Deck B').getByRole('button',{name:'Pause',exact:true}).count(),0);
    assert.equal(run.requests.length,['stalled_download','stop_gap','override_gap'].includes(mode)?3:2,'follow-up waits locally until preparation ends');
    if(mode==='stalled_download')assert.equal(run.requests[2].state.live.transitionPending,false,'the single post-failure consultation sees a released queue');
   }
   assert.deepEqual(run.errors,[]);console.log(`PASS: ${mode}; pending queue semantics and bounded preparation`);
  }catch(e){console.error('Browser log:',await run.page.locator('ul[aria-live="polite"]').innerText());throw e;}
  finally{releaseDownload?.();await run.context.close();}
 }
 if(['all','sample_mix','stem_migrate','partner_stems','loop'].includes(selectedCase)) {
 const stemCase=['stem_migrate','partner_stems'].includes(selectedCase), loopCase=selectedCase==='loop';
 const partner=selectedCase==='partner_stems';
 const pair=partner?[manifest[350],manifest[225]]:[poor,merced];
 const run=await setup(pair,(_body,n)=>n===1?
  {action:'queue',trackId:'0',transition:'cut',durationBars:4,startAt:'beginning',say:'Start the test track'}:
  stemCase?{action:'stem_migrate',trackId:'1',bars:8,anchor:'out',say:'Request actual stems'}:
  loopCase?{action:'loop',captureBars:2,isolation:'beat',holdSeconds:8,halvings:0,say:'Request actual loop'}:
  {action:'routine',routine:'sample_mix',sample:{captureBars:2,isolation:'beat',holdSeconds:8,halvings:0,sweepToBpm:92},queue:{trackId:'1',transition:'bass_swap',durationBars:4,startAt:'auto'},say:'Request a sampled beat handoff'});
 const {page}=run;
 try {
  await send(page,partner?'Start Valio La Pena':'Start Pobre Diabla');
  await deck(page,'Deck A').getByRole('button',{name:'Pause',exact:true}).waitFor({timeout:45000});
  assert.match(await deck(page,'Deck A').innerText(),/BeatGrid: yes/);
  await send(page,partner?'Salsa with stems and loops, blend into Tu Amor Me Hace Bien':stemCase?'Use stems to bring in A Tu Merced':loopCase?'Loop the beat for 8 seconds':'Sample the beat and bring in A Tu Merced');
  await page.getByText(stemCase?'full-track return prepared':loopCase?'held 2 bar(s)':'sample_mix armed:',{exact:false}).waitFor({timeout:55000});
  assert.equal(run.requests[1].state.live.hasRealBeatGrid,true);
  assert.equal(run.requests[1].state.live.hasStems,true);
  assert.ok(run.requests[1].state.live.stemRoles.includes('drums'));
  assert.equal(run.requests[1].state.live.genre,partner?'Salsa':'Reggaeton');
  assert.ok(run.requests[1].crate.every(t=>t.genre&&t.stemRoles?.includes('bass')));
  if(loopCase){
   await page.waitForTimeout(12000);
   const proof=await page.evaluate(()=>window.__audioProof);
   assert.ok(proof.loopStarts>0&&proof.loopPeakRms>0.001);
   assert.ok(await deck(page,'Deck A').getByRole('button',{name:'Pause',exact:true}).isVisible());
   assert.deepEqual(run.errors,[]);
   console.log(JSON.stringify({result:'PASS',case:'real standalone loop',loopStarts:proof.loopStarts,loopPeakRms:proof.loopPeakRms,paidCalls:0}));
  }else{
  assert.match(await deck(page,'Deck B').innerText(),/BeatGrid: yes/);
  await page.getByText(stemCase?'completed on the audio clock':'sample_mix completed',{exact:false}).waitFor({timeout:45000});
  await deck(page,'Deck B').getByRole('button',{name:'Pause',exact:true}).waitFor();
  assert.equal(await deck(page,'Deck A').getByRole('button',{name:'Pause',exact:true}).count(),0);
  const proof=await page.evaluate(()=>window.__audioProof);
  if(stemCase){
   const groups=Object.values(Object.groupBy(proof.starts.filter(s=>s.when>0&&s.duration>10),s=>s.when));
   const stems=groups.find(g=>g.length>=8);
   assert.ok(stems,'both actual stem sets must start at one shared audio-clock time');
   const during=proof.samples.filter(s=>s.when>stems[0].when+1&&s.when<stems[0].when+15);
   assert.ok(during.length>80&&during.every(s=>s.rms>0.001),'master stays audible DURING the actual stems, not just before/after');
  }else{
  assert.ok(proof.loopStarts>0,'a real loop source must have started');
  assert.ok(proof.peakRms>0.001,'audio reached the master output');
  assert.ok(proof.loopPeakRms>0.001,'master audio remained audible during the actual loop window');
  }
  assert.deepEqual(run.errors,[]);assert.equal(run.requests.length,2);
  console.log(JSON.stringify({result:'PASS',case:partner?'real salsa stems with explicit owner override':stemCase?'real Pobre Diabla to A Tu Merced STEMS':'real Pobre Diabla to A Tu Merced sample_mix',loopStarts:proof.loopStarts,peakRms:proof.peakRms,incomingPlaying:true,paidCalls:0,pageErrors:run.errors.length}));
  if(process.env.TEST_SCREENSHOT)await page.screenshot({path:process.env.TEST_SCREENSHOT,fullPage:true});
  }
 }catch(e){console.error('Browser log:',await page.locator('ul[aria-live="polite"]').innerText());throw e;}
 finally{await run.context.close();}
 }
 if(['all','missing_grid'].includes(selectedCase)) {
  const entries=[poor,merced].map((t,i)=>({...t,id:`no-grid-${i}`,name:`Unanalyzed test ${i}.mp3`,size:wav.length,grid:null,bpm:null}));
  const run=await setup(entries,(_body,n)=>n===1?
   {action:'queue',trackId:'0',transition:'cut',durationBars:4,startAt:'beginning'}:
   {action:'routine',routine:'sample_mix',sample:{captureBars:2,isolation:'beat',holdSeconds:8,halvings:0,sweepToBpm:92},queue:{trackId:'1',transition:'bass_swap',durationBars:4,startAt:'auto'},say:'Request a loop, not an execution claim',followUpSeconds:5});
  try {
   await run.context.route('**/api/crate/*',r=>r.fulfill({contentType:'audio/wav',body:wav}));
   await send(run.page,'Start');await deck(run.page,'Deck A').getByRole('button',{name:'Pause',exact:true}).waitFor();
   await send(run.page,'Loop and bring in next');
   await run.page.getByText('sample_mix did not run',{exact:false}).waitFor();
   await deck(run.page,'Deck B').getByRole('button',{name:'Pause',exact:true}).waitFor();
   assert.equal(run.requests[1].state.live.hasRealBeatGrid,false);
   assert.equal(await run.page.evaluate(()=>window.__audioProof.loopStarts),0);
   await new Promise(r=>setTimeout(r,5500));
   assert.equal(run.requests.length,2,'rejected routine must not schedule its misleading follow-up');
   assert.deepEqual(run.errors,[]);
   console.log('PASS: genuinely missing grid refuses loop, truthfully labels plan and falls back to requested next track; no follow-up storm');
  }catch(e){console.error('Browser log:',await run.page.locator('ul[aria-live="polite"]').innerText());throw e;}
  finally{await run.context.close();}
 }
 if(['all','recovery'].includes(selectedCase)) for(const mode of ['http_error','slow_reply','manual_stop']) {
  const target=manifest.find(t=>t.name==='Shakira - Soltera (Official Video).mp3');
  let releaseReply;
  const run=await setup([poor,target].map(t=>({...t,size:wav.length})),(_body,n)=>{
   if(n===1)return {action:'queue',trackId:'0',transition:'cut',durationBars:4,startAt:'beginning'};
   assert.equal(n,2,'recovery must not immediately spend on another model call');
   if(mode==='http_error')return {error:'muse: response exceeded the 50-second deadline; no DJ command received.'};
   return new Promise(resolve=>{releaseReply=()=>resolve({action:'queue',trackId:'0',transition:'cut',durationBars:4,startAt:'beginning',say:'stale reply'});});
  });
  try {
   await run.context.route('**/api/crate/*',r=>r.fulfill({contentType:'audio/wav',body:wav}));
   await send(run.page,'Start');await deck(run.page,'Deck A').getByRole('button',{name:'Pause',exact:true}).waitFor();
   await run.page.getByRole('checkbox',{name:/Ask selected model/}).check();
   await run.page.getByRole('button',{name:'Start autopilot',exact:true}).click();
   await run.page.waitForFunction(()=>document.querySelector('[aria-label="Cerebro model"]').disabled || document.body.innerText.includes('brain delayed or unavailable'));
   if(mode==='manual_stop'){
    await run.page.getByRole('button',{name:'Autopilot: ON',exact:true}).click();
    releaseReply();await run.page.getByText('discarded stale response',{exact:false}).waitFor();
    assert.equal(await deck(run.page,'Deck B').getByRole('button',{name:'Pause',exact:true}).count(),0);
    assert.ok(await deck(run.page,'Deck A').getByRole('button',{name:'Pause',exact:true}).isVisible());
   }else{
    await run.page.getByText('brain delayed or unavailable',{exact:false}).waitFor({timeout:22000});
    await deck(run.page,'Deck B').getByRole('button',{name:'Pause',exact:true}).waitFor();
    assert.match(await deck(run.page,'Deck B').innerText(),/Soltera/);
    await run.page.getByRole('button',{name:'Autopilot: ON',exact:true}).click();
    releaseReply?.();
    if(mode==='slow_reply')assert.ok(await run.page.getByText('1 call(s) have no cost estimate',{exact:false}).isVisible());
   }
   assert.equal(run.requests.length,2);assert.deepEqual(run.errors,[]);
   console.log(`PASS: ${mode}; ${mode==='manual_stop'?'late reply cannot restart stopped automation':'local recipe takes over without a model substitution or extra inference request'}`);
  }catch(e){console.error('Browser log:',await run.page.locator('ul[aria-live="polite"]').innerText());throw e;}
  finally{releaseReply?.();await run.context.close();}
 }
}finally{await browser.close();}
