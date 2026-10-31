import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createNativeLoopAdapter} from '../src/loop-native-adapter.js';
import {join} from 'node:path';
import {generateAnalysisRequest,generateMain} from '../scripts/generate-analysis-request.mjs';
import {loadLoopRequest} from '../src/loop-cli.js';
import {hash} from '../src/common.js';
import {normalizeLoopRequest,digest} from '../src/loop-controller.js';
import {analysisImplementation} from '../src/loop-analysis.js';
globalThis.fetch=()=>{throw Error('Live network forbidden');};
test('offline generator, actual manual/scheduled loaders, inactive defaults and bounded native pins',async t=>{
 const dir=mkdtempSync(join(realpathSync.native(process.env.P63_TEST_ROOT??tmpdir()),'generator-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const config=JSON.parse(readFileSync('pilot.example.json'));config.schedule.enabled=false;config.dryRun.collectionOnly=true;config.statePolicy.accessApproved=true;config.sources.ado={enabled:true,scopeApproved:true};
 const collector=join(dir,'collector.json'),proposer=join(dir,'proposer.json'),bundlePath=join(dir,'bundle.json');
 writeFileSync(collector,JSON.stringify(config));writeFileSync(proposer,JSON.stringify(config));
 const deadlineAt=new Date(Date.now()+60000).toISOString();
 const bundle={format:'loop-native-settings-v1',collectorConfig:collector,proposerConfig:proposer,executeProposer:false,collection:{dryRun:true,passes:['ado:created'],authorization:{deadlineAt,maxItems:2000,maxCalls:300}}};
 writeFileSync(bundlePath,JSON.stringify(bundle));
 const spec={authorizationRef:'synthetic-only',bundlePath,workflowId:'new-synthetic-release',producerRelease:'b'.repeat(40),occurrence:new Date().toISOString(),timeZone:'UTC',deadlineAt,
 stateOwner:{id:'fixture',directory:dir,accessApproved:true,retentionDays:7},budgets:Object.fromEntries(['collect','filter','proposer','rsi'].map(s=>[s,{maxEffects:1000,timeoutMs:1000}]))};
 const specPath=join(dir,'spec.json'),out=join(dir,'request.json');writeFileSync(specPath,JSON.stringify(spec));
 assert.equal(generateMain(['--spec',specPath,'--check']).state,'inactive');assert.equal(existsSync(out),false);assert.equal(existsSync(join(dir,'ledger.sqlite')),false);
 generateMain(['--spec',specPath,'--out',out]);assert.throws(()=>generateMain(['--spec',specPath,'--out',out]),/EEXIST/);
 const request=loadLoopRequest('manual',['--request',out]);assert.equal(request.rsiMode,'capture-only');assert.deepEqual(request.analysis.implementation,analysisImplementation());
 assert.deepEqual(request.analysis.sources.map(s=>[s.stage,s.index]),[['collect',0],['filter',4],['proposer',0],['rsi',0]]);
 const scheduled=loadLoopRequest('scheduled',['--request',out,'--occurrence',new Date().toISOString()]);
 assert.equal(normalizeLoopRequest(request).runId,normalizeLoopRequest(scheduled).runId);
 assert.equal(readFileSync(bundlePath,'utf8'),JSON.stringify(bundle));
 for(const mode of ['evaluated','full-cycle'])assert.throws(()=>normalizeLoopRequest({...request,rsiMode:mode}),/capture-only/);
 const old=structuredClone(request);delete old.analysis;assert.equal(normalizeLoopRequest(old).pins.analysis,undefined);
 for(const change of [{analysisTimeoutMs:95001},{maxInputBytes:2000001},{producerRelease:'stale'}])assert.throws(()=>generateAnalysisRequest({...spec,...change}));

 // Stop at the next offline FILTER-host guard: no execute/collection/provider calls.
 const native=createNativeLoopAdapter();
 for(const offset of [0,-10000,10000]) {
   const authorization={...bundle.collection.authorization,deadlineAt:new Date(Date.parse(deadlineAt)+offset).toISOString()};
   writeFileSync(bundlePath,JSON.stringify({...bundle,collection:{...bundle.collection,authorization}}));
   const before=readFileSync(bundlePath,'utf8');
   if(offset>0) assert.throws(()=>generateAnalysisRequest(spec),/deadlines/);
   else assert.doesNotThrow(()=>generateAnalysisRequest(spec));
   // Re-pin the unchanged authorization even when generation correctly rejects it.
   const candidate={...request,configuration:request.configuration.map(a=>({...a,sha256:hash(readFileSync(a.path))}))};
   candidate.executionPolicySha256=digest({collector:candidate.configuration[1],proposer:candidate.configuration[2],executeProposer:false,rsiMode:'capture-only'});
   await assert.rejects(native.preflight(normalizeLoopRequest(candidate)),offset>0?/Collection exceeds aggregate reservation/:/Bind an approved bounded FILTER host/);
   assert.equal(readFileSync(bundlePath,'utf8'),before);
 }
 writeFileSync(bundlePath,JSON.stringify({...bundle,collection:{...bundle.collection,authorization:{...bundle.collection.authorization,deadlineAt:new Date(Date.now()-1000).toISOString()}}}));
 assert.throws(()=>generateAnalysisRequest(spec),/deadlines/);
 writeFileSync(bundlePath,JSON.stringify({...bundle,executeProposer:true}));assert.throws(()=>generateAnalysisRequest(spec),/publication/);
 assert.ok(readFileSync('scripts/loop-manual.mjs','utf8').includes("printLoopMain('manual')"));
 assert.ok(readFileSync('scripts/loop-scheduled.mjs','utf8').includes("printLoopMain('scheduled')"));
});
