import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,providerResponse,nativeObservationValue} from './loop-analysis-fixture.js';
import {completeControllerAnalysis,prepareControllerAnalysis} from '../src/loop-analysis.js';
import {prepareAnalysisRequest,analysisHash} from '../src/rsi-analysis-only.js';
import {serializeAnalysisRequest,createAnalysisResponsesReasoner} from '../src/rsi-analysis-responses.js';
import {runEvidenceLoop,normalizeLoopRequest,loopOperation,readLoopArtifact,captureArtifact} from '../src/loop-controller.js';

function setup(t,fetchImpl,retained) {
  const f=fixture(mkdtempSync(join(tmpdir(),'analysis-remediation-')),fetchImpl,retained);
  t.after(()=>{const directory=f.ledger.directory;f.ledger.close();rmSync(directory,{recursive:true,force:true});});
  return f;
}

test('retained producer is verified even without an observation selector',async t=>{
  let calls=0;
  const f=setup(t,async()=>{calls++;throw Error('unexpected');});
  f.input.analysis.retainedProducer={runId:'unrelated',occurrence:f.input.occurrence,release:'a'.repeat(40),observationSha256:'b'.repeat(64)};
  const report=await runEvidenceLoop(f.input,f.ledger,f.adapters);
  assert.equal(report.state,'blocked');assert.equal(calls,0);
  assert.equal(loopOperation(f.ledger,report.runId+':analysis'),null);
});

for(const matching of [false,true]) test('retained observation requires matching upstream artifact: '+matching,async t=>{
  let calls=0;
  const values={collect:{sourceCoverageComplete:true,eligibleSourceKinds:['ado']},filter:{candidates:[],details:[]},rsi:nativeObservationValue('retained')};
  const retained={values,config:{}};
  const f=setup(t,async(_url,r)=>{calls++;return providerResponse(r.body);},retained);
  const upstream=['collect','filter'].map(stage=>({operationId:'retained:'+stage,artifacts:[captureArtifact(f.ledger,matching?values[stage]:{unrelated:true})]}));
  const observation=values.rsi.observation;
  observation.payload.data.summary.loop={receipts:upstream};
  observation.payloadSha256=analysisHash(JSON.stringify(observation.payload));
  observation.payloadJson=JSON.stringify(observation.payload);
  f.input.analysis.retainedProducer={runId:'retained',occurrence:f.input.occurrence,release:'a'.repeat(40),observationSha256:observation.payloadSha256};
  const report=await runEvidenceLoop(f.input,f.ledger,f.adapters);
  assert.equal(report.state,matching?'complete':'blocked',JSON.stringify(report));assert.equal(calls,Number(matching));
  if(matching) assert.equal(report.analysis.manifest.producer.runId,'retained');
});

for(const expansion of ['duplicates','provenance']) test('serialized '+expansion+' budget rejects before claim or fetch',async t=>{
  let calls=0;const f=setup(t,async()=>{calls++;throw Error('unexpected');});
  f.input.analysis.maxInputBytes=10000;
  if(expansion==='duplicates') f.input.analysis.sources=Array.from({length:16},()=>({stage:'collect',index:0,profile:'receipt-summary'}));
  else f.input.analysis.sourceProvenance=[{description:'漢\"'.repeat(5000)}];
  const result=await runEvidenceLoop(f.input,f.ledger,f.adapters);
  assert.equal(result.state,'blocked');assert.equal(calls,0);
  assert.equal(loopOperation(f.ledger,result.runId+':analysis'),null);
});

test('transport uses the measured body and enforces exact UTF-8 boundary',async t=>{
  const f=setup(t,async(_url,r)=>providerResponse(r.body));
  const report=await runEvidenceLoop(f.input,f.ledger,f.adapters);assert.equal(report.state,'complete');
  const {runId,pins}=normalizeLoopRequest(f.input);
  const prepared=prepareControllerAnalysis({runId,occurrence:f.input.occurrence,pins,receipts:report.receipts,readArtifact:a=>readLoopArtifact(f.ledger,a)});
  const {prompt}=prepareAnalysisRequest(prepared),body=serializeAnalysisRequest(pins.analysis.model,prompt);
  let calls=0;const options={endpoint:'http://synthetic',model:pins.analysis.model,persist:async()=>{},fetchImpl:async(_url,r)=>{calls++;assert.equal(r.body,body);return providerResponse(r.body);}};
  await assert.rejects(createAnalysisResponsesReasoner({...options,maxInputBytes:Buffer.byteLength(body)-1})({prompt,tools:[]}),/input limit/);
  assert.equal(calls,0);
  await createAnalysisResponsesReasoner({...options,maxInputBytes:Buffer.byteLength(body)})({prompt,tools:[]});assert.equal(calls,1);
});

test('real timer abort retains bounded transport failure and never retries on reopen',async t=>{
  let calls=0;const f=setup(t,async(_url,r)=>{calls++;return new Promise((resolve,reject)=>{
    r.signal.addEventListener('abort',()=>reject(r.signal.reason),{once:true});
  });});
  f.input.analysis.timeoutMs=40;
  const report=await runEvidenceLoop(f.input,f.ledger,f.adapters);
  assert.equal(report.state,'blocked');assert.equal(report.analysis.state,'failed');
  assert.equal(report.analysis.responseReceipts.length,1);
  const record=JSON.parse(readLoopArtifact(f.ledger,report.analysis.responseReceipts[0]));
  assert.equal(record.phase,'transport-failure');assert.equal(record.usage,null);assert.equal(record.rawBody,null);
  assert.ok(record.invocation.startedAt);assert.ok(record.invocation.completedAt);assert.equal(record.invocation.status,null);
  f.reopen();assert.equal((await runEvidenceLoop(f.input,f.ledger,f.adapters)).state,'blocked');assert.equal(calls,1);
});

test('revoked owner cannot persist timeout material or finish the durable claim',async t=>{
  const f=setup(t,async()=>{throw Error('unexpected');});
  const historical=structuredClone(f.input);delete historical.analysis;
  const report=await runEvidenceLoop(historical,f.ledger,f.adapters);assert.equal(report.state,'complete');
  const {pins}=normalizeLoopRequest(f.input),owner=new AbortController();
  f.ledger.db.prepare("UPDATE operations SET detail=? WHERE job_id=? AND kind='loop-occurrence'").run(JSON.stringify({producerOccurrence:f.input.occurrence}),report.runId);
  let calls=0;
  await assert.rejects(completeControllerAnalysis({runId:report.runId,occurrence:f.input.occurrence,pins,receipts:report.receipts,ledger:f.ledger,
    readArtifact:a=>readLoopArtifact(f.ledger,a),ownerAbortSignal:owner.signal,fetchImpl:async()=>{calls++;owner.abort();throw Error('synthetic');}}),/owner revoked/);
  assert.equal(calls,1);assert.equal(loopOperation(f.ledger,report.runId+':analysis').detail.state,'claimed');
  assert.equal(existsSync(join(f.ledger.directory,'private-analysis',report.runId,'transport-failure.json')),false);
});

for(const envelope of ['native','array','direct','payloadJson']) test('citation pointers resolve in '+envelope+' artifact',()=>{
  const observation=nativeObservationValue('producer').observation;
  const source=envelope==='native'?{observation}:envelope==='array'?[observation]:envelope==='payloadJson'?{payloadJson:JSON.stringify(observation.payload),payloadSha256:observation.payloadSha256}:observation;
  const bytes=Buffer.from(JSON.stringify(source)),artifact={sha256:analysisHash(bytes)};
  const pins={analysis:{maxInputBytes:2000000,producerRelease:'a'.repeat(40),implementation:{},sources:[{stage:'rsi',index:0,profile:'app-observation'}]}};
  const prepared=prepareControllerAnalysis({runId:'producer',occurrence:'2026-10-30T00:00:00Z',pins,receipts:[{operationId:'producer:rsi',artifacts:[artifact]}],readArtifact:()=>bytes});
  const projection=JSON.parse(prepared.suppliedBytes['component-0']);
  const resolved=projection.provenance.selectors.map(pointer=>pointer.slice(1).split('/').reduce((v,k)=>v[k],source));
  assert.deepEqual(resolved,envelope==='payloadJson'?[JSON.stringify(observation.payload)]:['producer','complete',[]]);
});
