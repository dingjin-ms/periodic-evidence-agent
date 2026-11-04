import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { preflightRequestExecution, formatAcceptedMarkdown, requestHookEnvironment } from '../src/request-execution.js';
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'request-exec-')), workspace=join(root,'work');mkdirSync(workspace);
  const git=args=>execFileSync('git',['-C',workspace,'-c','core.hooksPath=.git/no-hooks',...args],{encoding:'utf8'}).trim();
  git(['init','--quiet']);mkdirSync(join(workspace,'.githooks'));writeFileSync(join(workspace,'.githooks/pre-commit'),'#!/bin/sh\nexit 0\n');writeFileSync(join(workspace,'.githooks/pre-push'),'#!/bin/sh\nexit 0\n');
  git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture']);
  const tool=join(root,'tool.mjs');writeFileSync(tool,'// pinned fixture');
  const step={executable:process.execPath,executableSha256:hash(readFileSync(process.execPath)),args:[tool],timeoutMs:1000,files:[{path:tool,sha256:hash(readFileSync(tool))}]};
  const repo={requestExecution:{enabled:true,scopeApproved:true,approvalRef:'fixture',nativeHooks:'.githooks',requiredCapabilities:['live'],preflight:step,formatMarkdown:{...step,args:[tool,'--write']}}};
  const ledger=new Ledger(join(root,'state')),config={stateDirectory:join(root,'state')},job={id:'job',workspace,base_revision:git(['rev-parse','HEAD'])};
  t.after(()=>{ledger.close();rmSync(root,{recursive:true,force:true});});return{root,workspace,repo,ledger,config,job,tool};
}
test('native hooks receive approved target and reject bypass environment',t=>{
 const f=fixture(t);f.repo.pr={targetRef:'refs/heads/feature/fixture'};
 assert.equal(requestHookEnvironment(f.repo,{}).SYSTEM_PULLREQUEST_TARGETBRANCH,f.repo.pr.targetRef);
 for(const env of [{SKIP_PRE_PUSH:'true'},{SKIP_PRE_COMMIT:'1'},{HUSKY:'0'}])assert.throws(()=>requestHookEnvironment(f.repo,env),/bypass/);
});
for(const mode of ['ready','missing','stale','source-write','revoked'])test(`normal preflight ${mode}`,async t=>{
 const f=fixture(t);const execute=async()=>{
  if(mode==='source-write')writeFileSync(join(f.workspace,'unexpected.js'),'mutation');
  if(mode==='revoked')f.repo.requestExecution.scopeApproved=false;
  return{stdout:JSON.stringify({status:'ready',sourceRevision:mode==='stale'?'other':f.job.base_revision,capabilities:mode==='missing'?[]:['live'],evidenceRef:'fixture-qualified'}),stderr:''};
 };
 if(mode==='ready'){assert.equal((await preflightRequestExecution(f.config,f.ledger,f.job,f.repo,execute)).readiness.status,'ready');}
 else await assert.rejects(preflightRequestExecution(f.config,f.ledger,f.job,f.repo,execute));
 await assert.rejects(preflightRequestExecution(f.config,f.ledger,f.job,f.repo,execute));
});
for(const mode of ['wrapping','code','content','uncertain'])test(`accepted formatting ${mode}`,async t=>{
 const f=fixture(t);writeFileSync(join(f.workspace,'README.md'),'Keep all\nassertions.\n');writeFileSync(join(f.workspace,'test.js'),'original();');
 const execute=async()=>{writeFileSync(join(f.workspace,'README.md'),mode==='content'?'Drop assertions.':'Keep all assertions.\n');if(mode==='code')writeFileSync(join(f.workspace,'test.js'),'changed();');if(mode==='uncertain')throw Error('lost result');return{stdout:'formatted',stderr:''};};
 const proposal={outcome:'propose-change',findings:'model original'};
 if(mode==='wrapping'){const r=await formatAcceptedMarkdown(f.config,f.ledger,f.job,f.repo,proposal,0,execute);assert.equal(r.controllerTransform,true);assert.equal(readFileSync(r.originals[0].artifact,'utf8'),'Keep all\nassertions.\n');}
 else await assert.rejects(formatAcceptedMarkdown(f.config,f.ledger,f.job,f.repo,proposal,0,execute));
 if(mode==='wrapping')assert.equal((await formatAcceptedMarkdown(f.config,f.ledger,f.job,f.repo,proposal,0,()=>assert.fail('No repeated formatter'))).replayed,true);
 else await assert.rejects(formatAcceptedMarkdown(f.config,f.ledger,f.job,f.repo,proposal,0,execute),/uncertain/);
});
