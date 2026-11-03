import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisHash, createAnalysisInput, runAnalysisOnly } from '../src/rsi-analysis-only.js';
import { createAnalysisResponsesReasoner } from '../src/rsi-analysis-responses.js';
const fixture = () => {
  const bytes = Buffer.from('{"count":8}');
  const producer = {runId:'retained-run',occurrence:'2026-10-27T01:00:00Z',release:'a'.repeat(40),observationSha256:'b'.repeat(64)};
  return { manifest: {analysisId:'analysis-test',producer,analysisCode:'c'.repeat(40),broadAppStatus:'partial-or-blocked',selectedCoverage:{ado:'complete',workiq:'complete'},components:[{id:'collector',status:'available'},{id:'proposer',status:'skipped',reason:'no candidate'},{id:'timing',status:'missing',reason:'not retained'}],evidence:[{id:'counts',component:'collector',producer,available:true,supplied:true,sha256:analysisHash(bytes),sourceArtifactSha256:'d'.repeat(64)}]},suppliedBytes:{counts:bytes}};
};
const answer = f => ({analysisId:f.manifest.analysisId,producer:f.manifest.producer,outcome:'no-change',rationale:'Coverage alone cannot establish a safe improvement.',findings:[{text:'Eight records.',citations:[{id:'counts',sha256:f.manifest.evidence[0].sha256}]}],proposals:[]});
for (const kind of ['ArrayBuffer','offset Uint8Array','Buffer']) test(`owned ${kind} snapshot survives mutation and awaited reasoner`, async()=>{
  const f=fixture(), expected=Buffer.from(f.suppliedBytes.counts);
  const backing=new ArrayBuffer(expected.length+4), view=new Uint8Array(backing,2,expected.length);view.set(expected);
  f.suppliedBytes.counts=kind==='ArrayBuffer'?backing.slice(2,-2):kind==='Buffer'?Buffer.from(view):view;
  const input=createAnalysisInput(f.manifest,f.suppliedBytes), before=input.read('counts');
  const result=await runAnalysisOnly({...f,reasoner:async({prompt})=>{
    await Promise.resolve();
    if(kind==='ArrayBuffer')new Uint8Array(f.suppliedBytes.counts).fill(0);else f.suppliedBytes.counts.fill(0);
    assert.deepEqual(input.read('counts'),before);
    const evidence=JSON.parse(prompt).evidence[0];
    assert.equal(evidence.text,expected.toString());
    assert.equal(analysisHash(Buffer.from(evidence.text)),evidence.receipt.sha256);
    assert.equal(evidence.receipt.sha256,input.manifest.evidence[0].sha256);
    return {result:answer(f)};
  }});
  assert.deepEqual(result.readTrace,[before.receipt]);
});
for(const kind of ['direct','view']) test(`reject shared bytes ${kind} before reasoner`,async()=>{
  const f=fixture(), shared=new SharedArrayBuffer(f.suppliedBytes.counts.length);new Uint8Array(shared).set(f.suppliedBytes.counts);
  f.suppliedBytes.counts=kind==='direct'?shared:new Uint8Array(shared);let calls=0;
  await assert.rejects(runAnalysisOnly({...f,reasoner:()=>{calls++;}}),/shared evidence bytes/);assert.equal(calls,0);
});
for(const sequence of [[0xff],[0x80],[0xc0,0xaf],[0xed,0xa0,0x80],[0xe2,0x82],[0xf4,0x90,0x80,0x80],[0xef,0xbb,0xbf,0xc2]]) test(`reject malformed UTF-8 ${sequence.join('-')} before reasoner or fetch`,async()=>{
  const f=fixture();f.suppliedBytes.counts=Buffer.from(sequence);f.manifest.evidence[0].sha256=analysisHash(f.suppliedBytes.counts);let calls=0,fetches=0;
  const host=createAnalysisResponsesReasoner({endpoint:'http://mock',model:'same-model',persist:async()=>{},fetchImpl:async()=>{fetches++;throw new Error('unexpected');}});
  await assert.rejects(runAnalysisOnly({...f,reasoner:request=>{calls++;return host(request);}}),/invalid UTF-8 evidence/);
  assert.equal(calls,0);assert.equal(fetches,0);
});
test('valid UTF-8 preserves BOM, non-ASCII and replacement character exactly',async()=>{
  const f=fixture(), text='\ufeffé中文😀\ufffd';f.suppliedBytes.counts=Buffer.from(text);f.manifest.evidence[0].sha256=analysisHash(f.suppliedBytes.counts);
  const input=createAnalysisInput(f.manifest,f.suppliedBytes);assert.equal(input.read('counts').text,text);
  assert.deepEqual(Buffer.from(input.read('counts').text),f.suppliedBytes.counts);
  await runAnalysisOnly({...f,reasoner:async({prompt})=>{assert.equal(JSON.parse(prompt).evidence[0].text,text);return {result:answer(f)};}});
});
for(const kind of ['fetch','body-read']) test(`${kind} plus persistence failure retains fatal context without diagnostic reflection`,async()=>{
  const f=fixture();let calls=0,persists=0;
  const host=createAnalysisResponsesReasoner({endpoint:'http://mock',model:'same-model',persist:async record=>{
    persists++;assert.equal(record.phase,'transport-failure');throw new Error('private persistence diagnostic');
  },fetchImpl:async()=>{calls++;if(kind==='fetch')throw new Error('private transport diagnostic');return {status:503,text:async()=>{throw new Error('private body diagnostic');}};}});
  await assert.rejects(runAnalysisOnly({...f,reasoner:host}),error=>{
    assert.match(error.message,/transport-failure persistence failed/);assert.doesNotMatch(error.message,/private/);
    const r=error.analysisResponse;assert.equal(r.persistence,'failed');assert.equal(r.rawBody,null);assert.equal(r.text,null);assert.equal(r.usage,null);
    assert.equal(r.invocation.modelRequested,'same-model');assert.equal(r.invocation.modelReturned,null);assert.equal(r.invocation.responseId,null);assert.equal(r.invocation.status,null);
    assert.equal(r.invocation.httpStatus,kind==='fetch'?null:503);
    assert.ok(Number.isFinite(Date.parse(r.invocation.startedAt)));assert.ok(Date.parse(r.invocation.completedAt)>=Date.parse(r.invocation.startedAt));
    assert.ok(r.failure.startsWith('Network/body-read failure'));assert.doesNotMatch(JSON.stringify(r),/private/);
    assert.equal(error.analysisContext.manifest.analysisId,f.manifest.analysisId);
    assert.equal(error.analysisContext.readTrace[0].sha256,f.manifest.evidence[0].sha256);
    assert.equal(error.analysisContext.promptSha256,analysisHash(error.analysisContext.prompt));return true;
  });assert.equal(calls,1);assert.equal(persists,1);
});
test('immutable copied bytes, explicit missing/skipped, no host capabilities', async () => {
  const f = fixture(); const before = JSON.stringify(f.manifest);
  const input = createAnalysisInput(f.manifest,f.suppliedBytes);
  f.suppliedBytes.counts.fill(0);
  assert.equal(input.read('counts').text,'{"count":8}');
  assert.throws(() => {input.manifest.components[0].status='skipped';});
  const g = fixture();
  const result = await runAnalysisOnly({...g, reasoner: async request => {
    assert.deepEqual(Object.keys(request).sort(),['prompt','tools']); assert.deepEqual(request.tools,[]);
    assert.match(request.prompt,/no candidate/); return {result:answer(g)};
  }});
  assert.equal(JSON.stringify(f.manifest),before); assert.equal(result.readTrace.length,1); assert.equal(result.usage,null);
});
for (const kind of ['tamper','cross-run','missing-bytes','not-supplied','skipped','missing-component','unknown-bytes']) test(`reject ${kind} before invocation`, async () => {
  const f=fixture();
  if(kind==='tamper') f.suppliedBytes.counts=Buffer.from('bad');
  if(kind==='cross-run') f.manifest.evidence[0].producer={...f.manifest.producer,runId:'another'};
  if(kind==='missing-bytes') delete f.suppliedBytes.counts;
  if(kind==='not-supplied') f.manifest.evidence[0].supplied=false;
  if(kind==='skipped') f.manifest.evidence[0].component='proposer';
  if(kind==='missing-component') f.manifest.evidence[0].component='timing';
  if(kind==='unknown-bytes') f.suppliedBytes.other=Buffer.from('other');
  let calls=0; await assert.rejects(runAnalysisOnly({...f,reasoner:()=>{calls++;}})); assert.equal(calls,0);
});
for (const kind of ['unknown','digest','skipped','four-proposals']) test(`reject output ${kind}`, async () => {
  const f=fixture(), result=answer(f);
  if(kind==='unknown') result.findings[0].citations[0].id='other';
  if(kind==='digest') result.findings[0].citations[0].sha256='e'.repeat(64);
  if(kind==='skipped') result.findings[0].citations[0].id='proposer';
  if(kind==='four-proposals') {result.outcome='proposals';result.proposals=[{},{},{},{}];}
  await assert.rejects(runAnalysisOnly({...f,reasoner:async()=>({result})}));
});
test('host request is tool-free; provider failure stops without retry', async()=>{
  let calls=0; const reasoner=createAnalysisResponsesReasoner({endpoint:'http://host/responses',model:'same-model',persist:async()=>{},fetchImpl:async(_,request)=>{
    calls++;const body=JSON.parse(request.body);assert.deepEqual(body.tools,[]);assert.equal(body.tool_choice,'none');assert.equal(body.store,false);return {ok:false,status:429,text:async()=>JSON.stringify({error:{message:'quota'}})};
  }});
  await assert.rejects(reasoner({prompt:'sanitized',tools:[]}),/HTTP 429/);assert.equal(calls,1);
});
test('invalid JSON is rejected with output and usage retained for the host', async()=>{
  const reasoner=createAnalysisResponsesReasoner({endpoint:'http://host/responses',model:'same-model',persist:async()=>{},fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({status:'completed',model:'same-model',usage:{input_tokens:3,output_tokens:2},output:[{type:'message',content:[{type:'output_text',text:'not JSON'}]}]})})});
  await assert.rejects(reasoner({prompt:'sanitized',tools:[]}),e=>e.analysisResponse.text==='not JSON' && e.analysisResponse.usage.input_tokens===3);
});
test('available but not supplied evidence cannot be read or cited', async()=>{
  const f=fixture();f.manifest.evidence.push({...f.manifest.evidence[0],id:'held-back',supplied:false});
  const input=createAnalysisInput(f.manifest,f.suppliedBytes);assert.throws(()=>input.read('held-back'));
  const result=answer(f);result.findings[0].citations[0].id='held-back';
  await assert.rejects(runAnalysisOnly({...f,reasoner:async()=>({result})}),/citation not read/);
});

for (const kind of ['fenced','truncated','bad-body','incomplete','refusal','tool','provider','wrong-analysis','wrong-producer','wrong-citation','unread']) test(`persist complete response before rejecting ${kind}`, async()=>{
  const f=fixture(), result=answer(f), records=[]; let calls=0;
  if(kind==='wrong-analysis') result.analysisId='wrong';
  if(kind==='wrong-producer') result.producer={...result.producer,runId:'wrong'};
  if(kind==='wrong-citation') result.findings[0].citations[0].sha256='0'.repeat(64);
  if(kind==='unread') {f.manifest.evidence.push({...f.manifest.evidence[0],id:'unread',supplied:false});result.findings[0].citations[0].id='unread';}
  let text=JSON.stringify(result);
  if(kind==='fenced') text='```json' + String.fromCharCode(10) + text + String.fromCharCode(10) + '```';
  if(kind==='truncated') text=text.slice(0,-2);
  const body={id:'mock',model:'same-model',status:kind==='incomplete'?'incomplete':'completed',usage:{input_tokens:5,output_tokens:7},output:[{type:'message',content:[{type:'output_text',text}]}]};
  if(kind==='refusal') body.output[0].content.push({type:'refusal',refusal:'no'});
  if(kind==='tool') body.output.push({type:'function_call'});
  const raw=kind==='bad-body'?'not HTTP JSON':JSON.stringify(body);
  const host=createAnalysisResponsesReasoner({endpoint:'http://mock',model:'same-model',persist:async r=>records.push(structuredClone(r)),fetchImpl:async(_,req)=>{calls++;assert.equal(JSON.parse(req.body).text.format.strict,true);return {ok:kind!=='provider',status:kind==='provider'?500:200,text:async()=>raw};}});
  await assert.rejects(runAnalysisOnly({...f,reasoner:host}),e=>{assert.equal(e.analysisResponse.rawBody,raw);assert.equal(e.analysisContext.readTrace.length,1);if(kind!=='bad-body')assert.equal(e.analysisResponse.usage.output_tokens,7);return true;});
  assert.equal(calls,1);assert.equal(records[0].rawBody,raw);assert.equal(records[0].phase,'raw-response');
});
test('persistence failure prevents acceptance; network failure records unknown usage without retry',async()=>{
  let calls=0;const host=createAnalysisResponsesReasoner({endpoint:'http://mock',model:'same-model',persist:async()=>{throw new Error('disk failure');},fetchImpl:async()=>({ok:true,status:200,text:async()=>'{ }'})});
  await assert.rejects(host({prompt:'x',tools:[]}),/disk failure/);
  const records=[];const network=createAnalysisResponsesReasoner({endpoint:'http://mock',model:'same-model',persist:async r=>records.push(r),fetchImpl:async()=>{calls++;throw new Error('sensitive transport diagnostic');}});
  await assert.rejects(network({prompt:'x',tools:[]}),e=>e.analysisResponse.usage===null && !e.message.includes('sensitive'));assert.equal(calls,1);assert.equal(records[0].phase,'transport-failure');
});
test('successful mock persists exact body and keeps strict citations',async()=>{
  const f=fixture(), records=[];const raw=JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(answer(f))}]}]});
  const reasoner=createAnalysisResponsesReasoner({endpoint:'http://mock',model:'same-model',persist:async r=>records.push(r),fetchImpl:async()=>({ok:true,status:200,text:async()=>raw})});
  assert.equal((await runAnalysisOnly({...f,reasoner})).result.outcome,'no-change');assert.equal(records[0].rawBody,raw);
});
