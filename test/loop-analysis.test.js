import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Ledger} from '../src/ledger.js';
import {analysisImplementation,prepareControllerAnalysis} from '../src/loop-analysis.js';
import {hash} from '../src/common.js';
import {runEvidenceLoop,loopStages,roleReceipt,captureArtifact,normalizeLoopRequest,loopOperation,digest,readLoopArtifact} from '../src/loop-controller.js';

import {fixture,providerResponse} from './loop-analysis-fixture.js';
import {loadLoopRequest} from '../src/loop-cli.js';
const root=realpathSync.native(process.env.P63_TEST_ROOT??tmpdir());
test('new opt-in cannot activate or rewrite a historical admission',async()=>{
  let calls=0;const f=fixture(mkdtempSync(join(root,'analysis-old-')),async()=>{calls++;throw Error('No call authorized');});
  try {
    const historical=structuredClone(f.input);delete historical.analysis;
    const report=await runEvidenceLoop(historical,f.ledger,f.adapters);assert.equal(report.state,'complete');
    const original=loopOperation(f.ledger,report.runId);
    assert.equal((await runEvidenceLoop(f.input,f.ledger,f.adapters)).state,'blocked');
    assert.deepEqual(loopOperation(f.ledger,report.runId),original);assert.equal(calls,0);
  }finally{f.ledger.close();rmSync(f.ledger.directory,{recursive:true,force:true});}
});
test('scheduled wrapper request loader preserves explicit host pins without environment discovery or collection',()=>{
  const f=fixture(mkdtempSync(join(root,'analysis-wrapper-')),()=>{throw Error('No network');});
  try {
    const path=join(f.ledger.directory,'request.json');writeFileSync(path,JSON.stringify(f.input));
    const request=loadLoopRequest('scheduled',['--request',path]);
    assert.deepEqual(request.analysis,f.input.analysis);assert.equal(request.origin,'scheduled');
    assert.ok(readFileSync(new URL('../scripts/loop-scheduled.mjs',import.meta.url),'utf8').includes("printLoopMain('scheduled')"));
    assert.equal(loopOperation(f.ledger,normalizeLoopRequest(request).runId),null);
  }finally{f.ledger.close();rmSync(f.ledger.directory,{recursive:true,force:true});}
});
test('concurrent controller ownership rejects a second model invocation',async()=>{
  let started,release,calls=0;
  const entered=new Promise(r=>{started=r;}),held=new Promise(r=>{release=r;});
  const f=fixture(mkdtempSync(join(root,'analysis-overlap-')),async(_e,r)=>{calls++;started();await held;return providerResponse(r.body);});
  const other=new Ledger(f.ledger.directory);
  try {
    const first=runEvidenceLoop(f.input,f.ledger,f.adapters);await entered;
    await assert.rejects(runEvidenceLoop(f.input,other,f.adapters),/Ownership held/);release();
    assert.equal((await first).state,'complete');assert.equal(calls,1);
  }finally{other.close();f.ledger.close();rmSync(f.ledger.directory,{recursive:true,force:true});}
});
test('controller report readback and fresh ledger resume use exactly one fixture call; schema and pinned host binding',async()=>{
  let calls=0;
  const f=fixture(mkdtempSync(join(root,'analysis-')),async(endpoint,request)=>{
    calls++;assert.equal(endpoint,f.input.analysis.endpoint);const body=JSON.parse(request.body);
    assert.equal(body.model,f.input.analysis.model);assert.deepEqual(body.tools,[]);assert.equal(body.text.format.strict,true);
    return providerResponse(request.body);
  });
  try {
    const report=await runEvidenceLoop(f.input,f.ledger,f.adapters);assert.equal(report.state,'complete');assert.equal(report.analysis.state,'completed');
    assert.deepEqual(loopOperation(f.ledger,report.runId).detail.report,report);
    f.reopen();assert.deepEqual(await runEvidenceLoop(f.input,f.ledger,f.adapters),report);assert.equal(calls,1);
    const changed=structuredClone(f.input);changed.analysis.model='other';assert.throws(()=>normalizeLoopRequest(changed));
    const old=structuredClone(f.input);delete old.analysis;const pins=normalizeLoopRequest(old).pins;assert.equal(pins.analysis,undefined);
    assert.equal(report.analysis.manifest.components.find(c=>c.id==='proposer').status,'skipped');
  } finally {f.ledger.close();rmSync(f.ledger.directory,{recursive:true,force:true});}
});
for(const fault of ['throw','invalid-json','timeout','receipt-write']) test('durable failed '+fault+' never retries on fresh resume',async()=>{
  let calls=0;const f=fixture(mkdtempSync(join(root,'analysis-fault-')),async(_endpoint,request)=>{
    calls++;
    if(fault==='throw'||fault==='timeout') throw new Error(fault);
    if(fault==='receipt-write') {
      const {runId}=normalizeLoopRequest(f.input);mkdirSync(join(f.ledger.directory,'private-analysis',runId,'raw-response.json'));
    }
    return fault==='invalid-json'?{status:200,ok:true,text:async()=>'{bad'}:providerResponse(request.body);
  });
  try {const result=await runEvidenceLoop(f.input,f.ledger,f.adapters);assert.equal(result.state,'blocked');assert.equal(result.analysis.state,'failed');
    assert.equal(result.analysis.result,undefined);f.reopen();assert.equal((await runEvidenceLoop(f.input,f.ledger,f.adapters)).state,'blocked');assert.equal(calls,1);
  }finally{f.ledger.close();rmSync(f.ledger.directory,{recursive:true,force:true});}
});
test('pending claim, changed artifact provenance and missing selectors do not invoke model',async()=>{
  let calls=0;const f=fixture(mkdtempSync(join(root,'analysis-pending-')),async(_e,r)=>{calls++;return providerResponse(r.body);});
  try {
    const result=await runEvidenceLoop(f.input,f.ledger,f.adapters);assert.equal(calls,1);
    const op=loopOperation(f.ledger,result.runId+':analysis');f.ledger.finishOperation(op.id,'started',{state:'claimed',inputSha256:op.detail.inputSha256});
    f.reopen();assert.equal((await runEvidenceLoop(f.input,f.ledger,f.adapters)).state,'blocked');assert.equal(calls,1);
    const pins=normalizeLoopRequest(f.input).pins;pins.analysis.sources=[{stage:'collect',index:99,profile:'receipt-summary'}];
    const prepared=prepareControllerAnalysis({runId:result.runId,occurrence:f.input.occurrence,pins,receipts:result.receipts,readArtifact:a=>readLoopArtifact(f.ledger,a)});
    assert.equal(prepared.manifest.evidence[0].available,false);
    pins.analysis.sources=[{stage:'collect',index:0,profile:'receipt-summary',sha256:'0'.repeat(64)}];
    assert.throws(()=>prepareControllerAnalysis({runId:result.runId,pins,receipts:result.receipts,readArtifact:a=>readLoopArtifact(f.ledger,a)}),/digest/);
  }finally{f.ledger.close();rmSync(f.ledger.directory,{recursive:true,force:true});}
});

