import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,providerResponse} from './loop-analysis-fixture.js';
import {configAt,json,hash} from '../src/common.js';
import {beginApp,openApp,appStatus,unavailableApp} from '../src/app-native.js';
import {createNativeLoopAdapter,nativeLoopSettings} from '../src/loop-native-adapter.js';
import {normalizeLoopRequest,fileArtifact,digest,runEvidenceLoop,readLoopArtifact,loopOperation,roleReceipt,captureArtifact} from '../src/loop-controller.js';
import {prepareControllerAnalysis} from '../src/loop-analysis.js';

globalThis.fetch=()=>{throw Error('Live network forbidden');};
// Upstream source/FILTER/proposer receipts are synthetic boundaries. RSI execution,
// producer binding/capture, artifact selection and controller analysis are production code.
for(const proposed of [false,true])test('normal native RSI capture to analysis report '+proposed,async()=>{
 const directory=mkdtempSync(join(realpathSync.native(process.env.P63_TEST_ROOT??tmpdir()),'native-'));let calls=0,rsiCalls=0,proposerCalls=0;
 const f=fixture(directory,async(_url,r)=>{calls++;return providerResponse(r.body);});
 try{
 const c=configAt('pilot.example.json');c.statePolicy.accessApproved=true;
 const verificationRef=join(directory,'verification.json');writeFileSync(verificationRef,'{}');
 const profilePath=join(directory,'profile.js');writeFileSync(profilePath,'// Synthetic profile');
 c.repositories=[{id:'fixture',projectId:'fixture',routingApproved:true,referenceCheckout:directory,
 validationGates:[{id:'synthetic',approved:true,isolationVerified:true,profilePath:'profile.js',profileSha256:hash(readFileSync(profilePath)),executable:process.execPath,args:['--test'],timeoutMs:1000}],
 allowedWritePrefixes:['test'],skillBindings:[{id:'synthetic',enabled:true,qualification:'qualified',capability:'integration-test-authoring',skillPath:'synthetic/SKILL.md',requestedOutcomes:['add-or-update-tests'],allowedWritePrefixes:['test'],requiresBehaviorCard:false,sideEffects:{commit:false,push:false,createDraftPR:false}}]}];
 c.agency={profiles:{},selections:[],budgetId:'derived',maxRequests:1,maxConcurrent:1,maxDraftPullRequests:0,maxExecutionSeconds:60,preflightMaxAgeSeconds:300,monitorOwner:'synthetic',monitorCadenceSeconds:60};
 c.filterBatching={approved:true,mode:'verified',model:'synthetic',profile:'synthetic',tokenizer:'synthetic',verifiedBy:'test',verifiedAt:new Date().toISOString(),verificationRef,verificationSha256:hash(readFileSync(verificationRef)),contextTokens:1000,maxInputTokens:500,maxPayloadBytes:1000000,maxBatches:1,reserves:{instructions:10,sourceAnalysis:20,output:100,safety:10,requestOverhead:5}};
 c.sources.ado={enabled:true,scopeApproved:true};c.sources.workiq.enabled=false;
 c.rsi=JSON.parse(readFileSync('scaffold/rsi-flow.example.json'));
 Object.assign(c.limits,{workerMinutes:1,maxValidationRepairRounds:0,workerMaxToolCalls:10,maxAiCreditsPerSession:1,maxWorkers:1,maxAssignments:1});
 const collectorConfig=join(directory,'collector.json'),proposerConfig=join(directory,'proposer.json');
 writeFileSync(collectorConfig,json(c));writeFileSync(proposerConfig,json(c));
 const bundle={format:'loop-native-settings-v1',collectorConfig,proposerConfig,executeProposer:proposed,
 filterHost:{id:'synthetic',approvalRef:'synthetic-only',qualificationRef:verificationRef,maxRequests:1,maxExecutionSeconds:60,maxReservedTokens:1000},
 collection:{dryRun:true,passes:['ado:created'],authorization:{maxItems:100000,maxCalls:100000,deadlineAt:f.input.deadlineAt}}};
 const bundlePath=join(directory,'bundle.json');writeFileSync(bundlePath,json(bundle));
 f.input.configuration=[bundlePath,collectorConfig,proposerConfig].map(fileArtifact);
 f.input.sourcePolicySha256=digest({identity:c.identity,sources:c.sources,passes:bundle.collection.passes});
 f.input.executionPolicySha256=digest({collector:f.input.configuration[1],proposer:f.input.configuration[2],executeProposer:proposed,rsiMode:'capture-only'});
 for(const budget of Object.values(f.input.budgets)){budget.maxEffects=100000;budget.timeoutMs=60000;}
 f.input.analysis.sources=[{stage:'filter',index:4,profile:'filter-result'},{stage:'proposer',index:0,profile:'proposer-result'},{stage:'rsi',index:0,profile:'app-observation'}];
 const native=createNativeLoopAdapter();f.input.adapters.rsi=native.binding;
 f.adapters.rsi={...native,execute:(r,l)=>{rsiCalls++;return native.execute(r,l);}};
 const filter={candidates:proposed?[{}]:[],titles:{decisions:[{disposition:'screen-out',reason:'PRIVATE TITLE'}]},details:[{status:'reviewed',reason:'PRIVATE regression'}]};
 f.adapters.filter={...f.adapters.filter,execute:async role=>({state:'complete',receipt:roleReceipt(role,proposed?'eligible':'no-candidate',[...Array.from({length:4},()=>captureArtifact(f.ledger,{syntheticDescriptor:true})),captureArtifact(f.ledger,filter)],['synthetic-filter'])})};
 f.adapters.proposer={...f.adapters.proposer,execute:async role=>{proposerCalls++;return {state:'complete',receipt:roleReceipt(role,'proposed',[captureArtifact(f.ledger,{assignment:{id:'synthetic'},result:{outcome:'draft-pr-validated',draftPR:{isDraft:true}}})],['synthetic-proposer'])};}};
 const {runId,pins}=normalizeLoopRequest(f.input),settings=nativeLoopSettings(pins,runId);
 // Production beginApp establishes the immutable source run and producer binding,
 // but performs no collection. Unstarted source passes must remain partial.
 beginApp(settings.collector,{runId,dryRun:true,provenance:'synthetic'});
 const report=await runEvidenceLoop(f.input,f.ledger,f.adapters);assert.equal(report.state,'complete',JSON.stringify(report));
 assert.equal(report.analysis.manifest.broadAppStatus,'partial-or-blocked');
 assert.equal(calls,1);assert.equal(rsiCalls,1);assert.equal(proposerCalls,Number(proposed));
 const captured=JSON.parse(readLoopArtifact(f.ledger,report.receipts[3].artifacts[0]));
 const {ledger:source}=openApp(settings.collector,runId,true);let observation,binding;
 try{observation=source.get('rsiFlowObservation',report.receipts[3].ledgerIds[0]);binding=source.all('rsiFlowBinding');assert.equal(binding.length,1);}
 finally{source.close();}
 assert.equal(captured.observation.payloadSha256,observation.payloadSha256);
 assert.equal(hash(json(observation.payload)),observation.payloadSha256);
 assert.equal(report.analysis.manifest.producer.observationSha256,observation.payloadSha256);
 assert.equal(report.analysis.manifest.producer.runId,runId);
 assert.deepEqual(observation.payload.data.summary.loop.receipts.map(r=>r.outcome),['collected',proposed?'eligible':'no-candidate',proposed?'proposed':'no-candidate']);
 const prepared=prepareControllerAnalysis({runId,occurrence:f.input.occurrence,pins,receipts:report.receipts,readArtifact:a=>readLoopArtifact(f.ledger,a)});
 const projection=JSON.parse(prepared.suppliedBytes['component-0']);
 assert.equal(projection.titleDecisions[0].disposition,'screen-out');assert.equal(projection.decisions[0].status,'reviewed');
 assert.equal(projection.decisions[0].disposition,undefined);assert.ok(!prepared.suppliedBytes['component-0'].toString().includes('PRIVATE'));
 const reservations=f.ledger.db.prepare("SELECT id,detail FROM operations WHERE kind='loop-reservation'").all();
 assert.equal(reservations.length,4);
 assert.deepEqual(loopOperation(f.ledger,runId).detail.report,report);
 f.reopen();f.input.occurrence='2026-10-30T12:00:00Z';f.input.origin='manual';
 const resumed=await runEvidenceLoop(f.input,f.ledger,f.adapters);assert.deepEqual(resumed,report);
 assert.equal(calls,1);assert.equal(rsiCalls,1);assert.equal(proposerCalls,Number(proposed));
 assert.equal(f.ledger.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='loop-trigger-audit'").get().n,2);
 writeFileSync(join(directory,'native-proof-'+proposed+'.json'),JSON.stringify({runId,proposed,calls,rsiCalls,proposerCalls,reservations,artifact:report.receipts[3].artifacts[0],bindingSha256:hash(json(binding)),observationSha256:observation.payloadSha256,preparedManifest:prepared.manifest,report,resumed},null,2));
 }finally{f.ledger.close();rmSync(directory,{recursive:true,force:true});}
});

test('partial app status preserves public pass enums and citations while withholding diagnostics',()=>{
 const directory=mkdtempSync(join(realpathSync.native(process.env.P63_TEST_ROOT??tmpdir()),'projection-'));
 const c=configAt('pilot.example.json');c.stateDirectory=directory;c.statePolicy.accessApproved=true;
 const runId='synthetic-projection';beginApp(c,{runId,dryRun:true,provenance:'synthetic'});
 const {ledger}=openApp(c,runId,true);
 try {
   unavailableApp(ledger,runId,{pass:'icm:created',reason:'no-approved-connector'});
   for(const [pass,state] of [['ado:created','complete'],['ado:changed','failed-source'],['workiq:created','partial'],['workiq:changed','blocked-auth']])
     ledger.db.prepare('INSERT INTO app_passes VALUES(?,?,?)').run(runId,pass,JSON.stringify({pass,state,error:{message:'PRIVATE secret diagnostic'},reason:'PRIVATE'}));
   const summary=appStatus(ledger,runId);
   assert.equal(summary.state,'partial-or-blocked');
   const payload={data:{run:{runId},summary}};
   const observation={payload,payloadSha256:hash(JSON.stringify(payload))};
   const bytes=Buffer.from(JSON.stringify({observation})),artifact={sha256:hash(bytes)};
   const pins={analysis:{maxInputBytes:2000000,producerRelease:'a'.repeat(40),implementation:{},sources:[{stage:'rsi',index:0,profile:'app-observation'}]}};
   const project=()=>prepareControllerAnalysis({runId,occurrence:'2026-10-30T00:00:00Z',pins,receipts:[{operationId:runId+':rsi',artifacts:[artifact]}],readArtifact:()=>bytes});
   const prepared=project(),projection=JSON.parse(prepared.suppliedBytes['component-0']);
   assert.deepEqual(projection.passes.map(p=>[p.pass,p.state]),summary.collection.map(p=>[p.pass,p.state]));
   assert.ok(!prepared.suppliedBytes['component-0'].toString().includes('PRIVATE'));
   assert.equal(projection.provenance.artifactSha256,artifact.sha256);
   assert.equal(prepared.manifest.evidence[0].sha256,hash(prepared.suppliedBytes['component-0']));
   for(const pointer of projection.provenance.selectors) {
     const resolved=pointer.slice(1).split('/').reduce((value,key)=>value[key],JSON.parse(bytes));
     assert.notEqual(resolved,undefined);
   }
   assert.deepEqual(projection.provenance.selectors.map(pointer=>pointer.slice(1).split('/').reduce((value,key)=>value[key],JSON.parse(bytes))),
     [runId,summary.state,summary.collection]);
   // Unknown values stay withheld; missing/null diagnostics stay distinguishable.
   summary.collection=[{pass:'PRIVATE unknown',state:'PRIVATE unknown',error:'PRIVATE'}, {pass:'ado:created',state:'not-started'}, {pass:'ado:changed',state:'blocked',error:null}];
   observation.payloadSha256=hash(JSON.stringify(payload));
   const unknown=Buffer.from(JSON.stringify({observation}));
   const result=prepareControllerAnalysis({runId,occurrence:'2026-10-30T00:00:00Z',pins,receipts:[{operationId:runId+':rsi',artifacts:[{sha256:hash(unknown)}]}],readArtifact:()=>unknown});
   const rows=JSON.parse(result.suppliedBytes['component-0']).passes;
   assert.deepEqual(rows[0],{pass:'withheld-unrecognized',state:'withheld-unrecognized',error:'withheld'});
   assert.equal(rows[1].state,'not-started');assert.equal(rows[1].error,'missing');assert.equal(rows[2].error,'explicit-null');
 }finally{ledger.close();rmSync(directory,{recursive:true,force:true});}
});
