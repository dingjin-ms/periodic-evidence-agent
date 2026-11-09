import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { hash, requireThat } from './common.js';

const revision = /^[a-f0-9]{40}$/;
const branch = /^[a-zA-Z0-9._/-]+$/;
const skillName = 'excel-agent-in-container-proxy-integration-tests';
const assetChunkLength = 480;
const asset = path => {
  const bytes = readFileSync(path);
  const gzipBase64 = gzipSync(bytes).toString('base64');
  const chunks = Array.from({ length: Math.ceil(gzipBase64.length / assetChunkLength) }, (_, index) => {
    const value = gzipBase64.slice(index * assetChunkLength, (index + 1) * assetChunkLength);
    return `${index}:${hash(Buffer.from(value))}:${value}`;
  });
  return { sha256: hash(bytes), chunks };
};

export function createAlAgencyLiveE2eRequest(input) {
  const validBranch = value => branch.test(value ?? '') && !value.startsWith('/') &&
    !value.endsWith('/') && !value.split('/').includes('..');
  requireThat(input?.schema === 'pea-al-agency-live-e2e-request-v1' &&
    revision.test(input.baseRevision ?? '') && revision.test(input.peaRevision ?? '') &&
    isAbsolute(input.runnerPath ?? '') &&
    isAbsolute(input.preloadPath ?? '') && /^[a-f0-9]{64}$/.test(input.skillSha256 ?? '') &&
    typeof input.organization === 'string' &&
    input.organization.length > 0 && typeof input.project === 'string' && input.project.length > 0 &&
    typeof input.repository === 'string' && input.repository.length > 0 &&
    validBranch(input.branch) && input.pipelineRef?.startsWith('refs/heads/') &&
    validBranch(input.pipelineRef.slice('refs/heads/'.length)) &&
    Number.isSafeInteger(input.pipelineId) && input.pipelineId > 0,
  'Invalid explicit AL Agency live E2E request', 'blocked-config');
  const runner = asset(input.runnerPath), preload = asset(input.preloadPath);
  const skillPlugin = `ado-git:${input.organization}/${input.project}/${input.repository}:` +
    `utils/excel-agent-in-container-proxy@${input.baseRevision}`;
  const prompt = `This is the explicitly opted-in AL same-workspace live E2E from exact tested PEA revision ${input.peaRevision}. Work only in the existing augloop-workflows checkout at exact base ${input.baseRevision}. Do not push, create a branch, PR, work item or merge. Root .npmrc may be pipeline-owned and dirty; do not edit or commit it. Stop for any other initial tracked change.

Invoke and follow utils/excel-agent-in-container-proxy/.github/skills/excel-agent-in-container-proxy-integration-tests/SKILL.md and references/suites.md. Before authoring, verify the SKILL.md SHA-256 is ${input.skillSha256}; stop on mismatch. Author one small deterministic meaningful integration test in exactly one approved owner test directory, then create one authoring commit. Production, shared harness, configuration, manifests, lockfiles, generated files and flaky-tests/flaky-tests.json are read-only.

Do not design or regenerate validation infrastructure. Materialize the following prebuilt controller assets verbatim into untracked .agency-controller/augloop-agency-runner.mjs and .agency-controller/augloop-agency-node-preload.cjs. Each line is index:SHA-256:base64-chunk. The per-line SHA-256 is over the literal ASCII/UTF-8 bytes of the base64-chunk string itself, before Base64 decoding; never hash decoded chunk bytes. In separate ordinary PowerShell calls of at most four lines each, append only the chunk value to the corresponding untracked base64 file after verifying its index and that literal-string SHA-256; stop on any mismatch. Concatenate in index order, Base64-decode, then use GZipStream to materialize the asset. Runner chunks begin:
${runner.chunks.join('\n')}
Runner chunks end. Preload chunks begin:
${preload.chunks.join('\n')}
Preload chunks end. Verify final SHA-256 ${runner.sha256} and ${preload.sha256}; stop on mismatch. These assets were implemented and tested in PEA before this job. Never manually repair, infer, delete or substitute a chunk.

After the authoring commit, do not run any focused product test, build or validation command first; the prebuilt controller exclusively owns validation. In one ordinary powershell tool call, create an untracked runner input JSON with schema pea-al-agency-runner-input-v1, workspaceRoot from git rev-parse --show-toplevel, evidenceDirectory under $env:BUILD_ARTIFACTSTAGINGDIRECTORY\\agency-logs\\al-live-e2e-attempt-0, baseRevision ${input.baseRevision}, candidate from git rev-parse HEAD, repairAttempt 0, maximumJobMinutes 90, maximumControllerMinutes 180, maxRepairAttempts 2, controllerDeadlineAt exactly 180 minutes after job start, expectedSkillSha256 ${input.skillSha256}, expectedRunnerSha256 ${runner.sha256}, and expectedPreloadSha256 ${preload.sha256}; finish that tool call without launching the runner. Then use a separate ordinary powershell tool call with mode "sync" and initial_wait 600. Its command must contain only a direct invocation in this form: & '<absolute real node.exe>' '<absolute augloop-agency-runner.mjs>' '<absolute runner-input.json>'. Do not combine input creation, checks, variables, assignments, error preferences, exit handling or any other statement with this launch call. Do not use async mode, a background process, a privileged or sandbox-bypass tool, and do not request interactive approval or special permissions. This exact bare synchronous launch form already succeeded in the same Agency pipeline. Run the controller once only. The controller emits periodic heartbeats while a gate is active; after the initial wait, use read_powershell on that same shell until it completes. Never call stop_powershell merely because the controller remains running or a gate is quiet, and never submit a second launch. Stop and report an indeterminate result only if the shell disappears or the platform returns a terminal result that cannot establish completion. The controller owns Excel-first ordering, all unchanged 16 owner gates, process drain, exact LAGE_GIT_IGNORED_FILES removal, VS environment, tracked-output restoration, nonzero native population parsing, Excel native proof, logs and receipt.

If product gates fail, the controller prints a bounded failure diagnostic to the same shell. Repair only when that output proves the defect is in the new test or its dedicated fixture. Create a separate test-only repair commit, at most two, and rerun all 16 gates with a fresh evidence directory. Copy the final complete attempt directory to $env:BUILD_ARTIFACTSTAGINGDIRECTORY\\agency-logs\\al-live-e2e without overwriting prior attempts. Never repair production, environment, dependencies, configuration or a pre-existing failure.

If the prebuilt controller itself fails, you may modify only its untracked staged runner copy. Save the exact unified diff from the original runner to the modified runner as an untracked patch file. Record its path, SHA-256 and the concrete reason in the next runner input using allowRunnerRepair, runnerRepairPatchPath, runnerRepairPatchSha256 and runnerRepairReason. Do not commit controller changes or count them as product repair. The independent local controller will reject an unaudited modification or a patch hash that does not match the retained patch bytes.

Keep model gpt-6-luna, one model session, 30 soft credits, two product repairs, 90 job minutes and 180 controller minutes. Complete with the candidate commit, repair count, final receipt path and status; never claim local controller acceptance.`;
  return {
    prompt,
    modelConfiguration: { model: 'gpt-6-luna', reasoningEffort: 'medium' },
    context: { repository: { $type: 'ado', organization: input.organization,
      project: input.project, repository: input.repository, branch: input.branch } },
    plugins: [{ name: skillPlugin, type: 'Spec' }],
    additionalOptions: { pluginOptions: { includeDefaults: false } },
    compute: { $type: 'pipeline', pipelineId: input.pipelineId,
      pipelineRefOverride: input.pipelineRef },
    metadata: { repoId: 'augloop-workflows', baseRevision: input.baseRevision, peaRevision: input.peaRevision,
      model: 'gpt-6-luna', maxModelSessions: '1', softCreditLimit: '30',
      maxRepairAttempts: '2', maximumJobMinutes: '90', maximumControllerMinutes: '180',
      runnerSha256: runner.sha256, preloadSha256: preload.sha256, skillSha256: input.skillSha256,
      skillName, skillPlugin,
      productPush: 'forbidden', productPullRequest: 'forbidden', productMerge: 'forbidden' }
  };
}
