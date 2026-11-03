import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Ledger} from '../src/ledger.js';
import {analysisImplementation,prepareControllerAnalysis} from '../src/loop-analysis.js';
import {hash} from '../src/common.js';
import {nativeAnalysisObservation} from '../src/loop-native-adapter.js';
export function nativeObservationValue(runId){
  const payload={kind:'app-flow',outcome:'complete',evidenceTrust:'captured-controller-state-not-independent-e2e-qualification',
    data:{run:{runId},summary:{state:'complete',collection:[]},events:[],upstreamExecution:'app-tool-receipts-not-cryptographic-execution-attestation'}};
  const observation={id:'synthetic-observation',payload,payloadSha256:hash(JSON.stringify(payload))};
  return {observation:nativeAnalysisObservation({get:()=>observation},observation.id,runId,2000000)};
}
import {runEvidenceLoop,loopStages,roleReceipt,captureArtifact,fileArtifact,normalizeLoopRequest,loopOperation,digest,readLoopArtifact} from '../src/loop-controller.js';

export function fixture(directory,fetchImpl,retained) {
  mkdirSync(directory,{recursive:true});
  const config=join(directory,'config.json');writeFileSync(config,'{}');
  let ledger=new Ledger(directory);
  const binding={id:'isolated-replay-fixture',revision:hash('isolated-replay-fixture')};
  const input={format:'evidence-loop-v1',workflowId:'analysis-integration',origin:'scheduled',timeZone:'UTC',
    occurrence:'2026-10-30T00:00:00Z',window:{start:'2026-10-28T00:00:00Z',end:'2026-10-29T00:00:00Z'},
    stateOwner:{id:'isolated-test',directory,accessApproved:true,retentionDays:7},sourcePolicySha256:hash('source'),executionPolicySha256:hash('execution'),
    rsiMode:'capture-only',configuration:[{path:config,sha256:hash('{}')}],deadlineAt:new Date(Date.now()+180000).toISOString(),
    adapters:Object.fromEntries(loopStages.map(s=>[s,binding])),budgets:Object.fromEntries(loopStages.map(s=>[s,{maxEffects:1,timeoutMs:1000}])),
    analysis:{mode:'analysis-only-v1',host:'agent-maestro',endpoint:'http://127.0.0.1:23333/api/openai/v1/responses',model:'gpt-6-astra',
      timeoutMs:75000,maxCalls:1,maxInputBytes:2000000,implementation:analysisImplementation(),producerRelease:'a'.repeat(40),
      sources:[{stage:'collect',index:0,profile:'receipt-summary'},{stage:'filter',index:0,profile:'filter-result'}]}};
  if(retained) Object.assign(input.analysis,retained.config);
  const execute=async (role,db)=>({state:'complete',receipt:roleReceipt(role,
    ({collect:'collected',filter:'no-candidate',rsi:'captured'})[role.stage],
    [retained?.artifactPaths?.[role.stage] ? fileArtifact(retained.artifactPaths[role.stage]) :
      captureArtifact(db,retained?.values[role.stage]??(role.stage==='rsi'?nativeObservationValue(role.runId):role.stage==='collect'?{sourceCoverageComplete:true,eligibleSourceKinds:['ado','workiq']}:{candidates:[],details:[]}))],[role.stage])});
  const adapter={binding,capabilities:loopStages,preflight:async()=>{},verify:async()=>{},execute,
    resume:async()=>{throw Error('Unexpected role replay');}};
  const adapters={...Object.fromEntries(loopStages.map(s=>[s,adapter])),analysisFetch:fetchImpl};
  return {input,adapters,get ledger(){return ledger;},reopen(){ledger.close();ledger=new Ledger(directory);}};
}
export function providerResponse(body) {
  const prompt=JSON.parse(JSON.parse(body).input[0].content[0].text);
  return {status:200,ok:true,text:async()=>JSON.stringify({id:'fixture-response',model:'gpt-6-astra',status:'completed',usage:{input_tokens:1,output_tokens:1},
    output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({analysisId:prompt.manifest.analysisId,producer:prompt.manifest.producer,
      outcome:'no-change',rationale:'Fixture only',findings:[],proposals:[]})}]}]})};
}

