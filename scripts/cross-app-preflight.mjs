import { createRequire } from 'node:module';
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { hash, json, requireThat } from '../src/common.js';

// Read-only, maintained command for requestExecution.preflight. Qualifications
// describe supplied observers; this script never manufactures one or signs in.
export function inspectCrossAppReadiness(workspace, profile) {
  requireThat(isAbsolute(workspace) && profile?.format === 'cross-app-readiness-v1' && profile.approvalRef?.trim() &&
    /^[a-f0-9]{40}$/.test(profile.sourceRevision ?? '') && Array.isArray(profile.capabilities) &&
    Array.isArray(profile.files) && profile.files.length > 0 && Array.isArray(profile.modules),
  'Invalid cross-app readiness profile', 'blocked-config');
  const head = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 }).trim();
  requireThat(head === profile.sourceRevision, 'Readiness profile belongs to a different source', 'blocked-reconciliation');
  const problems = [];
  for (const file of profile.files) {
    requireThat(typeof file.path === 'string' && !isAbsolute(file.path) && !file.path.split(/[\\/]/).includes('..') &&
      /^[a-f0-9]{64}$/.test(file.sha256), 'Invalid readiness file pin', 'blocked-scope');
    const path = resolve(workspace, file.path);
    if (!existsSync(path) || !lstatSync(path).isFile() || hash(readFileSync(path)) !== file.sha256) problems.push(`unavailable-or-stale:${file.path}`);
  }
  for (const module of profile.modules) {
    requireThat(typeof module.owner === 'string' && !isAbsolute(module.owner) && !module.owner.split(/[\\/]/).includes('..') &&
      typeof module.name === 'string' && module.name.length > 0, 'Invalid candidate module requirement', 'blocked-config');
    try { createRequire(resolve(workspace, module.owner, 'package.json')).resolve(module.name); }
    catch { problems.push(`unresolved:${module.owner}:${module.name}`); }
  }
  const qualified = profile.capabilities.filter(capability => {
    requireThat(/^[a-z][a-z0-9-]{1,79}$/.test(capability.name), 'Invalid capability name');
    const ready = capability.status === 'qualified' && capability.evidenceRef?.trim() &&
      capability.sourceRevision === head && Date.parse(capability.expiresAt) > Date.now();
    if (!ready) problems.push(`unqualified:${capability.name}`);
    return ready;
  }).map(capability => capability.name);
  return { status: problems.length ? 'blocked' : 'ready', sourceRevision: head,
    evidenceRef: profile.approvalRef, capabilities: qualified, problems,
    qualification: 'source-bound-operator-evidence-not-new-product-observation' };
}

if (process.argv[1]?.endsWith('cross-app-preflight.mjs')) {
  try {
    const [workspace, file] = process.argv.slice(2);
    requireThat(workspace && file, 'Usage: cross-app-preflight.mjs WORKSPACE PROFILE');
    const result = inspectCrossAppReadiness(resolve(workspace), JSON.parse(readFileSync(file)));
    console.log(json(result));
    if (result.status !== 'ready') process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
