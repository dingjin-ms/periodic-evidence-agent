import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder, isDeepStrictEqual } from 'node:util';
import { analysisHash, prepareAnalysisRequest, runAnalysisOnly } from './rsi-analysis-only.js';
import { createAnalysisResponsesReasoner, serializeAnalysisRequest } from './rsi-analysis-responses.js';
import { requireThat, utc, windowCheck, exclusions } from './common.js';

export function analysisImplementation() {
  return Object.fromEntries(['loop-analysis.js','rsi-analysis-only.js','rsi-analysis-responses.js'].map(name =>
    [name, analysisHash(readFileSync(new URL(name, import.meta.url)))]));
}
export function validateAnalysisPins(c) {
  if (c === undefined) return;
  requireThat(c && typeof c === 'object','Invalid analysis configuration','blocked-binding');
  const release=x=>typeof x==='string' && /^[a-f0-9]{40}$/.test(x);
  if(c.retainedProducer !== undefined){
    const p=c.retainedProducer;
    requireThat(p && typeof p.runId==='string' && /^[A-Za-z0-9:_-]{1,160}$/.test(p.runId) && release(p.release) &&
      typeof p.observationSha256==='string' && /^[a-f0-9]{64}$/.test(p.observationSha256),'Incomplete retained producer','blocked-binding');
    requireThat(Object.keys(p).length===4 && Object.keys(p).every(k=>['runId','occurrence','release','observationSha256'].includes(k)),
      'Incompatible retained producer fields','blocked-binding');
    utc(p.occurrence);
    requireThat(c.producerRelease===undefined || c.producerRelease===p.release,'Conflicting producer releases','blocked-binding');
  }else requireThat(release(c.producerRelease),'Explicit producer release required','blocked-binding');
  requireThat(c.mode === 'analysis-only-v1' && c.host === 'agent-maestro' &&
    c.endpoint === 'http://127.0.0.1:23333/api/openai/v1/responses' && c.model === 'gpt-6-astra' &&
    Number.isSafeInteger(c.timeoutMs) && c.timeoutMs > 0 && c.timeoutMs <= 95000 && c.maxCalls === 1 &&
    Number.isSafeInteger(c.maxInputBytes) && c.maxInputBytes > 0 && c.maxInputBytes <= 2000000,
    'Explicit bounded existing analysis host required','blocked-binding');
  const code = analysisImplementation();
  requireThat(Object.keys(code).every(k => c.implementation?.[k] === code[k]),'Analysis implementation changed','blocked-binding');
  requireThat(Array.isArray(c.sources) && c.sources.length <= 16 && c.sources.every(s =>
    s && ['collect','filter','proposer','rsi'].includes(s.stage) && Number.isSafeInteger(s.index) && s.index >= 0 &&
    ({collect:'receipt-summary',filter:'filter-result',proposer:'proposer-result',rsi:'app-observation'})[s.stage]===s.profile), 'Invalid analysis source selectors','blocked-binding');
}
const allowed = (x, values) => values.includes(x) ? x : x == null ? 'missing' : 'withheld-unrecognized';
const count = x => Array.isArray(x) ? x.length : null;
// Fixed JSON selectors only. No path/URL discovery, SQL execution or artifact evaluation.
export function prepareControllerAnalysis({runId,occurrence,pins,receipts,readArtifact}) {
  const config=pins.analysis;
  const cache=new Map();let total=0;
  const read=artifact=>{
    if(cache.has(artifact.sha256))return cache.get(artifact.sha256);
    const bytes=readArtifact(artifact);total+=bytes.length;
    requireThat(total<=config.maxInputBytes,'Analysis input limit exceeded','blocked-budget');
    requireThat(analysisHash(bytes)===artifact.sha256,'Source digest changed','blocked-reconciliation');
    const source=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));cache.set(artifact.sha256,source);return source;
  };
  const unwrap=source=>{const o=source?.observation ?? (Array.isArray(source)?source[0]:source);
    if(!o?.payloadJson)return o;
    const payload=JSON.parse(o.payloadJson);
    requireThat(!o.payload || isDeepStrictEqual(o.payload,payload),'Observation envelopes disagree','blocked-reconciliation');
    return {...o,payload};};
  const observationArtifact=receipts.find(r=>r.operationId===runId+':rsi')?.artifacts[0];
  requireThat(observationArtifact,'Native observation missing','blocked-reconciliation');
  const observation=unwrap(read(observationArtifact));
  const producer=config.retainedProducer??{runId,occurrence,release:config.producerRelease,observationSha256:observation?.payloadSha256};
  requireThat(observation?.payload?.data?.run?.runId===producer.runId &&
    observation.payloadSha256===producer.observationSha256 &&
    analysisHash(JSON.stringify(observation.payload))===producer.observationSha256,
    'Observation producer mismatch','blocked-reconciliation');
  const components=['collect','filter','proposer','rsi'].map((id,i)=>({id,
    status:id==='proposer' && receipts[1]?.outcome!=='eligible'?'skipped':receipts[i]?'available':'missing',
    reason:id==='proposer'?(receipts[1]?.outcome!=='eligible'?'filter '+(receipts[1]?.outcome??'missing')+'; proposer not executed':
      'proposer '+(receipts[i]?.outcome??'missing')):'receipt availability'}));
  const evidence=[],suppliedBytes={}; let broadAppStatus='missing',selectedCoverage={status:'not supplied'};
  for(const [i,s] of config.sources.entries()) {
    const artifact=receipts.find(r=>r.operationId===runId+':'+s.stage)?.artifacts[s.index],id='component-'+i;
    if(s.stage==='proposer' && components.find(c=>c.id==='proposer').status==='skipped') {
      evidence.push({id,component:s.stage,producer,available:false,supplied:false,reason:'Proposer not executed; receipt refers to FILTER evidence'});continue;
    }
    if(!artifact) { evidence.push({id,component:s.stage,producer,available:false,supplied:false,reason:'selected artifact missing'}); continue; }
    requireThat(!s.sha256 || s.sha256===artifact.sha256,'Source digest changed','blocked-reconciliation');
    if(config.retainedProducer && s.stage!=='rsi') {
      const upstream=observation.payload.data.summary?.loop?.receipts;
      requireThat(Array.isArray(upstream) && upstream.some(r=>r.operationId===producer.runId+':'+s.stage &&
        r.artifacts?.[s.index]?.sha256===artifact.sha256),
        'Selected artifact is not bound to retained producer','blocked-reconciliation');
    }
    const source=read(artifact);
    let projection,selectors;
    if(s.profile==='filter-result') {
      selectors=['/candidates','/titles/decisions','/details'];
      projection={candidateCount:count(source.candidates),titleCount:count(source.titles?.decisions),detailCount:count(source.details),
        titleDecisions:(source.titles?.decisions??[]).map((r,index)=>({index,
          disposition:allowed(r.disposition,['no-title','screen-out','likely-relevant','needs-details']),
          exclusionCategory:allowed(r.exclusionType,exclusions)})),
        decisions:(source.details??[]).map((r,index)=>({index,status:allowed(r.status,['reviewed','excluded-title']),
          rationaleCategories:['missing','insufficient','resolved','repro','regression'].filter(k=>typeof r.reason==='string' && r.reason.toLowerCase().includes(k)),
          originalReason:typeof r.reason==='string'?'withheld':'missing'}))};
    } else if(s.profile==='app-observation') {
      const o=unwrap(source);
      requireThat(o?.payload?.data?.run?.runId===producer.runId && o.payloadSha256===producer.observationSha256 &&
        analysisHash(JSON.stringify(o.payload))===producer.observationSha256,'Observation producer mismatch','blocked-reconciliation');
      const data=o.payload.data;
      const prefix=source?.observation?'/observation':Array.isArray(source)?'/0':'';
      const raw=source?.observation??(Array.isArray(source)?source[0]:source);
      selectors=!raw?.payload && raw?.payloadJson?[prefix+'/payloadJson']:
        ['/run/runId','/summary/state','/summary/collection'].map(path=>prefix+'/payload/data'+path);
      broadAppStatus=allowed(data.summary?.state,['partial-or-blocked','complete']);
      projection={broadAppStatus,passes:(data.summary?.collection??[]).map(p=>({pass:allowed(p.pass,['ado:created','ado:changed','workiq:created','workiq:changed','icm:created']),
        state:allowed(p.state,['complete','partial','blocked','not-started','blocked-auth','unavailable','failed-source']),error:!Object.hasOwn(p,'error')?'missing':p.error===null?'explicit-null':'withheld'}))};
    } else if(s.profile==='proposer-result'){
      selectors=['/assignment','/result/outcome','/result/draftPR/isDraft'];
      const executed=receipts.find(r=>r.operationId===runId+':proposer')?.outcome==='proposed';
      projection={executed,assignmentPresent:!!source.assignment,resultPresent:!!source.result,
        outcome:executed?allowed(source.result?.outcome,['draft-pr-validated']):'not-executed',
        draft:executed && typeof source.result?.draftPR?.isDraft==='boolean'?source.result.draftPR.isDraft:null};
    } else {
      selectors=['/sourceCoverageComplete','/eligibleSourceKinds'];
      selectedCoverage={complete:typeof source.sourceCoverageComplete==='boolean'?source.sourceCoverageComplete:null,
        eligibleSourceKinds:(source.eligibleSourceKinds??[]).map(k=>allowed(k,['ado','workiq','icm']))};
      projection={selectedCoverage};
    }
    projection.telemetry={duration:'missing: no paired primary timestamps selected',historicalUsage:'uninspected/not supplied; not an absence claim'};
    projection.provenance={artifactSha256:artifact.sha256,stage:s.stage,index:s.index,profile:s.profile,selectors,
      source:config.sourceProvenance?.[i]??null,rawContent:'withheld',projectionRead:'supplied to analysis'};
    const projected=Buffer.from(JSON.stringify(projection)); suppliedBytes[id]=projected;
    evidence.push({id,component:s.stage,producer,available:true,supplied:true,sha256:analysisHash(projected),sourceArtifactSha256:artifact.sha256});
  }
  return {manifest:{analysisId:runId+':analysis',producer,analysisCode:config.implementation,broadAppStatus,selectedCoverage,components,evidence},suppliedBytes};
}
function durable(path,value) {
  const bytes=Buffer.from(JSON.stringify(value)),fd=openSync(path,'wx',0o600);
  try { writeFileSync(fd,bytes); fsyncSync(fd); } finally { closeSync(fd); }
  return {kind:'file',path,sha256:analysisHash(bytes)};
}
// SQLite primary key and BEGIN IMMEDIATE reserve the effect durably before invoking.
export async function completeControllerAnalysis({runId,occurrence,pins,receipts,ledger,readArtifact,fetchImpl,check=()=>{},ownerAbortSignal,successWrite=write=>write()}) {
  if(!pins.analysis) return undefined;
  validateAnalysisPins(pins.analysis);
  const id=runId+':analysis',get=()=>{const row=ledger.db.prepare('SELECT detail FROM operations WHERE id=?').get(id);return row?JSON.parse(row.detail):null;};
  const admission=ledger.db.prepare("SELECT detail FROM operations WHERE job_id=? AND kind='loop-occurrence'").get(runId);
  const admittedOccurrence=admission && JSON.parse(admission.detail).producerOccurrence;
  requireThat(pins.analysis.retainedProducer || admittedOccurrence,'Original producer occurrence missing','blocked-reconciliation');
  const prepared=prepareControllerAnalysis({runId,occurrence:admittedOccurrence??occurrence,pins,receipts,readArtifact});
  const {prompt}=prepareAnalysisRequest(prepared);
  requireThat(Buffer.byteLength(serializeAnalysisRequest(pins.analysis.model,prompt))<=pins.analysis.maxInputBytes,
    'Analysis input limit exceeded','blocked-budget');
  const inputSha256=analysisHash(JSON.stringify(prepared.manifest)),old=get();
  const directory=join(ledger.directory,'private-analysis',runId),confirmationPath=join(directory,'completion-confirmed.json');
  if(old) {
    requireThat(old.inputSha256===inputSha256,'Analysis provenance drift','blocked-reconciliation');
    if(old.state!=='completed') return {...old,state:'blocked',reconciliationRequired:true,reason:'Prior claim failed or uncertain; no retry'};
    if(old.completionConfirmationRequired && (!existsSync(confirmationPath) ||
      readFileSync(confirmationPath,'utf8')!==JSON.stringify({inputSha256,resultSha256:old.resultReceipt?.sha256})))
      return {...old,state:'blocked',reconciliationRequired:true,reason:'Completion commit was not confirmed; no retry'};
    requireThat(old.responseReceipts?.length === 2 && old.resultReceipt,'Completed analysis receipt missing','blocked-reconciliation');
    for(const ref of [...old.responseReceipts,old.resultReceipt]) readArtifact(ref);
    const saved=JSON.parse(readArtifact(old.resultReceipt));
    requireThat(JSON.stringify(saved.result)===JSON.stringify(old.result) && JSON.stringify(saved.usage)===JSON.stringify(old.usage),
      'Completed analysis report/result mismatch','blocked-reconciliation');
    return old;
  }
  const timeoutMs=Math.floor(Math.min(check()??Infinity,Date.parse(pins.deadlineAt)-Date.now(),pins.analysis.timeoutMs));
  requireThat(timeoutMs>0,'Insufficient analysis deadline','blocked-budget');
  const invocationDeadline=performance.now()+timeoutMs;
  mkdirSync(directory,{recursive:true,mode:0o700});
  check();
  ledger.db.exec('PRAGMA synchronous=FULL');
  check();
  ledger.transaction(()=>{check();requireThat(!get(),'Analysis already claimed','blocked-reconciliation');
    ledger.operation(id,runId,'analysis-only',{state:'claimed',inputSha256,claimedAt:new Date().toISOString(),maxCalls:1});check();});
  const responseReceipts=[];
  const remaining=()=>Math.floor(Math.min(invocationDeadline-performance.now(),check()??Infinity,Date.parse(pins.deadlineAt)-Date.now()));
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),Math.max(0,remaining()));
  const signal=AbortSignal.any([abort.signal,...(ownerAbortSignal?[ownerAbortSignal]:[])]);
  try {
    check();
    const invocationTimeout=remaining();
    requireThat(invocationTimeout>0 && !signal.aborted,'Insufficient analysis deadline','blocked-budget');
    const reasoner=createAnalysisResponsesReasoner({...pins.analysis,timeoutMs:invocationTimeout,fetchImpl:(url,options)=>{
      requireThat(remaining()>0 && !signal.aborted,'Analysis cancelled','blocked-budget');
      return (fetchImpl??fetch)(url,{...options,signal:AbortSignal.any([signal,options.signal])});
    },persist:async record=>{
      check();requireThat(!ownerAbortSignal?.aborted && (record.phase==='transport-failure' || !signal.aborted),
        'Analysis cancelled','blocked-budget');
      responseReceipts.push(durable(join(directory,record.phase+'.json'),record));
      check();
    }});
    check();
    const result=await runAnalysisOnly({...prepared,reasoner}); check();
    const resultReceipt=durable(join(directory,'result.json'),result);
    check();requireThat(!signal.aborted,'Analysis cancelled','blocked-budget');
    const value={state:'completed',inputSha256,result:result.result,usage:result.usage,invocation:result.invocation,
      readTrace:result.readTrace,manifest:result.manifest,responseReceipts,resultReceipt,completionConfirmationRequired:true};
    successWrite(()=>{check();ledger.finishOperation(id,'recorded',value);check();});
    check();durable(confirmationPath,{inputSha256,resultSha256:resultReceipt.sha256});check();return value;
  } catch (error) {
    const value={state:'failed',inputSha256,responseReceipts,reconciliationRequired:true,reason:'Analysis invocation, validation or persistence failed; no retry'};
    // A lost owner cannot persist even private failure material. The durable claim remains no-retry.
    try{check();requireThat(!ownerAbortSignal?.aborted,'Analysis owner revoked','blocked-budget');}catch(ownerError){
      // Preserve the persistence/invocation failure without restoring revoked authority.
      ownerError.cause=error;ownerError.analysisResponse=error.analysisResponse;throw ownerError;
    }
    ledger.finishOperation(id,'started',value); return value;
  } finally {clearTimeout(timer);}
}
