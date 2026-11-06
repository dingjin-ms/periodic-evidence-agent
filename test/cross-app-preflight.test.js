import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash } from '../src/common.js';
import { inspectCrossAppReadiness } from '../scripts/cross-app-preflight.mjs';
for(const mode of ['qualified','missing-observer','expired','stale-file','missing-module'])test(`canonical cross-app preflight ${mode}`,t=>{
 const root=mkdtempSync(join(tmpdir(),'cross-app-preflight-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'package.json'),'{}');writeFileSync(join(root,'observer.js'),'// fixture qualification');
 const git=args=>execFileSync('git',['-C',root,'-c','core.hooksPath=.git/no-hooks',...args],{encoding:'utf8'}).trim();
 git(['init','--quiet']);git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture']);const sourceRevision=git(['rev-parse','HEAD']);
 const profile={format:'cross-app-readiness-v1',approvalRef:'fixture-qualified',sourceRevision,files:[{path:'observer.js',sha256:hash('// fixture qualification')}],modules:mode==='missing-module'?[{owner:'.',name:'absent-fixture'}]:[],capabilities:[{name:'live-cells',status:mode==='missing-observer'?'unavailable':'qualified',sourceRevision,evidenceRef:'fixture-proof',expiresAt:mode==='expired'?'2000-01-01T00:00:00Z':'2099-01-01T00:00:00Z'}]};
 if(mode==='stale-file')writeFileSync(join(root,'observer.js'),'changed');
 const result=inspectCrossAppReadiness(root,profile);assert.equal(result.status,mode==='qualified'?'ready':'blocked');
});
