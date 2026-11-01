// Explicitly opt-in: ONE paid Grok request with the actual 599-track crate.
// Real audio, isolated storage, lesson sync blocked. Never part of npm check:*.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
if(process.env.RUN_PAID_GROK_TEST!=='1')throw new Error('Set RUN_PAID_GROK_TEST=1 to authorize one paid request');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base=process.env.TEST_BASE_URL || 'http://127.0.0.1:3199';
const manifest=JSON.parse(readFileSync(new URL('../src/data/crate-manifest.json',import.meta.url)));
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1280,height:1000}});
try {
 if(process.env.DJ_PASSCODE)await context.addCookies([{name:'dj_pass',value:process.env.DJ_PASSCODE,url:base}]);
 await context.addInitScript(entries=>{
  localStorage.setItem('djsm.crate-metadata',JSON.stringify(entries));
  localStorage.setItem('djsm.brain-model','grok');
  window.__peakRms=0;
  const connect=AudioNode.prototype.connect;
  AudioNode.prototype.connect=function(destination,...args){
   if(destination instanceof AudioDestinationNode&&!window.__audioProbe){
    const probe=this.context.createAnalyser();probe.fftSize=2048;connect.call(this,probe);window.__audioProbe=probe;
    const values=new Float32Array(2048);setInterval(()=>{probe.getFloatTimeDomainData(values);window.__peakRms=Math.max(window.__peakRms,Math.sqrt(values.reduce((s,x)=>s+x*x,0)/values.length));},100);
   }
   return connect.call(this,destination,...args);
  };
 },manifest);
 await context.route('**/api/lessons',r=>r.fulfill({json:{events:[]}}));
 let paidRequests=0,blockedExtraRequests=0,requestCrateCount=0;
 await context.route('**/api/dj',async r=>{
  if(r.request().method()!=='POST')return r.continue();
  if(paidRequests){blockedExtraRequests++;return r.fulfill({json:{command:{action:'none',say:'Live test request cap'},cost_usd:0}});}
  const body=r.request().postDataJSON();assert.equal(body.brainModel,'grok');
  requestCrateCount=body.crate.length;assert.equal(requestCrateCount,manifest.length);
  paidRequests++;return r.continue();
 });
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.waitForFunction(()=>document.querySelector('[aria-label="Cerebro model"]')?.value==='grok'&&!document.querySelector('[aria-label="Cerebro model"] option[value="grok"]').disabled);
 const responsePromise=page.waitForResponse(r=>r.url().endsWith('/api/dj')&&r.request().method()==='POST',{timeout:60000});
 const began=Date.now();
 await page.getByLabel('Vibe note to the brain').fill('Start playing salsa/bachata now. Play 30 seconds per track, blend continuously with no gaps. Choose an opener from the crate now.');
 await page.getByRole('button',{name:'Send',exact:true}).click();
 const response=await responsePromise,data=await response.json();
 console.log(JSON.stringify({stage:'real provider response',http:response.status(),provider:data.provider,model:data.model,action:data.command?.action,latency_ms:data.latency_ms,cost_usd:data.cost_usd,error:data.error}));
 assert.equal(response.status(),200);assert.equal(data.provider,'grok');assert.equal(data.command?.action,'queue');
 await page.getByRole('button',{name:'Pause',exact:true}).first().waitFor({timeout:50000});
 await page.waitForFunction(()=>window.__peakRms>0.001,{},{timeout:10000});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({result:'PASS',case:'real Grok opens a real track from full crate',requestCrateCount,paidRequests,blockedExtraRequests,playingAfterSeconds:(Date.now()-began)/1000,peakRms:await page.evaluate(()=>window.__peakRms),cost_usd:data.cost_usd}));
}finally{await context.close();await browser.close();}
