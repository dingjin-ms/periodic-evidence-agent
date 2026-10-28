import { AzureCliCredential } from '@azure/identity';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, requireThat, PilotError, safeError } from './common.js';
import { nativeCommand } from './native-command.js';

const agency = 'https://copilotswe.app.prod.gitops.startclean.microsoft.com/api/agency';
const agencyScope = 'api://81bbac67-d541-4a6d-a48b-b1c0f9a57888/.default';
const adoScope = '499b84ac-1321-427f-aa17-267ca6975798/.default';
export const agencyArtifactTransportPath = fileURLToPath(
  new URL('../scripts/validation/agency-remote-validation.ps1', import.meta.url));

export function createAgencyValidationTransport(config, dependencies = {}) {
  const identity = config.identity;
  requireThat(identity?.tenantId && identity.objectId && typeof dependencies.save === 'function',
    'Remote validation needs the designated Azure CLI tenant and user', 'blocked-auth');
  const credential = dependencies.credential ??
    new AzureCliCredential({ tenantId: identity.tenantId, processTimeoutInMs: 120000 });
  const fetchResponse = dependencies.fetch ?? fetch;
  const execute = dependencies.execute ?? nativeCommand;
  const tokens = new Map();
  async function request(url, scope, deadline, method = 'GET', body) {
    let token = tokens.get(scope);
    if (!token || token.expiresOnTimestamp < Date.now() + 120000) {
      try { token = await credential.getToken(scope); }
      catch { throw new PilotError('blocked-auth', 'Designated Azure CLI sign-in unavailable; credential diagnostics not recorded'); }
      requireThat(token?.token && token.expiresOnTimestamp > Date.now(),
        'Designated sign-in returned no usable token', 'blocked-auth');
      let claims;
      try { claims = JSON.parse(Buffer.from(token.token.split('.')[1], 'base64url').toString('utf8')); }
      catch { throw new PilotError('blocked-auth', 'Designated identity claims are unavailable'); }
      requireThat(claims.tid === identity.tenantId && claims.oid === identity.objectId,
        'Remote validation account differs from the designated tenant/user', 'blocked-auth');
      tokens.set(scope, token);
    }
    requireThat(Date.now() < deadline, 'Remote transport deadline exceeded before request', 'blocked-reconciliation');
    const response = await fetchResponse(url, {
      method, headers: { Authorization: `Bearer ${token.token}`, Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
    });
    requireThat(response.ok, `Approved remote endpoint returned HTTP ${response.status}`,
      [401, 403].includes(response.status) ? 'blocked-auth' : 'blocked-result');
    if (response.body === null) return null;
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      requireThat(bytes <= 4 * 1024 * 1024, 'Remote metadata exceeds its bounded response budget', 'blocked-result');
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return null;
    return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
  }
  return async (operation, input, directory) => {
    const { contract } = input, p = contract.pipeline;
    const deadline = Date.now() + (operation === 'download' ? 10 * 60000 : 120000);
    const ado = (path, method = 'GET', body) =>
      request(`${p.organization}/${p.project}/_apis/${path}`, adoScope, deadline, method, body);
    const agencyRequest = (path, method = 'GET', body) =>
      request(`${agency}${path}`, agencyScope, deadline, method, body);
    const pipelineContent = async branch => {
      const query = new URLSearchParams({ path: p.yamlPath, 'versionDescriptor.version':
        branch ? p.ref.slice('refs/heads/'.length) : p.revision,
      'versionDescriptor.versionType': branch ? 'branch' : 'commit',
      includeContent: 'true', '$format': 'json', 'api-version': '7.1' });
      const item = await ado(`git/repositories/${p.repositoryId}/items?${query}`);
      requireThat(item?.commitId === p.revision && typeof item.content === 'string' &&
        hash(item.content) === p.yamlSha256, 'Pinned pipeline source/ref differs; submission refused', 'blocked-result');
      return item.content;
    };
    if (operation === 'preflight') {
      const yaml = await pipelineContent(true);
      if (['agency-oa-workspace-loop-contract-v1', 'agency-oa-workspace-authoring-contract-v1'].includes(contract.schema)) {
        const inlineScripts = [...yaml.matchAll(/^[ \t]*-[ \t]+pwsh:[ \t]+([^\r\n]*)/gm)]
          .map(([, script]) => script);
        requireThat(inlineScripts.every(script => script.length <= 32766),
        'Loop inline PowerShell exceeds the Windows input budget; materialize a pinned script file',
        'blocked-validation');
        for (const script of inlineScripts.filter(script => script.startsWith('"'))) {
          try { JSON.parse(script); }
          catch {
            requireThat(false, 'Loop generated PowerShell must be a valid single-line JSON/YAML string',
              'blocked-validation');
          }
        }
        const query = new URLSearchParams({ path: contract.loop.agentPath,
          'versionDescriptor.version': p.revision, 'versionDescriptor.versionType': 'commit',
          includeContent: 'true', '$format': 'json', 'api-version': '7.1' });
        const agent = await ado(`git/repositories/${p.repositoryId}/items?${query}`);
        requireThat(agent?.commitId === p.revision && typeof agent.content === 'string' &&
          hash(agent.content) === contract.loop.agentSha256,
        'The pinned restricted remote agent differs from the private contract', 'blocked-result');
        query.set('path', contract.loop.pluginManifestPath);
        const manifest = await ado(`git/repositories/${p.repositoryId}/items?${query}`);
        requireThat(manifest?.commitId === p.revision && typeof manifest.content === 'string' &&
          hash(manifest.content) === contract.loop.pluginManifestSha256,
        'The pinned restricted agent plugin manifest differs from the private contract', 'blocked-result');
      }
      return { preflightPassed: true };
    }
    if (operation === 'submit') {
      const wire = readFileSync(join(directory, 'request.json'));
      requireThat(!existsSync(join(directory, 'created.json')) &&
        !['validate-started', 'validated', 'create-started'].some(phase =>
          existsSync(join(directory, `submission-${phase}.json`))) &&
        hash(wire) === input.requestSha256,
      'Reserved request changed or submission already started; never resubmit', 'blocked-reconciliation');
      const recordPhase = phase => dependencies.save(join(directory, `submission-${phase}.json`), {
        schema: 'agency-validation-submission-phase-v1', phase,
        requestSha256: input.requestSha256, observedAt: new Date().toISOString()
      });
      let phase = 'request-validation';
      try {
        recordPhase('validate-started');
        await agencyRequest('/v2/jobs/validate', 'POST', wire.toString('utf8'));
        recordPhase('validated');
        phase = 'job-creation';
        recordPhase('create-started');
        const created = await agencyRequest('/v2/jobs', 'POST', wire.toString('utf8'));
        phase = 'creation-recording';
        dependencies.save(join(directory, 'created.json'), { jobId: created?.jobId });
        return { jobId: created?.jobId };
      } catch (error) {
        const safe = safeError(error);
        const causeCode = ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
          'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
          'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
          'CERT_HAS_EXPIRED'].find(code => code === error?.cause?.code);
        throw new PilotError(safe.code,
          `Remote submission failed during ${phase}${causeCode ? ` (${causeCode})` : ''}: ${safe.message}`);
      }
    }
    requireThat(/^[a-zA-Z0-9_.-]+$/.test(input.jobId ?? ''), 'Recorded job ID required', 'blocked-reconciliation');
    const rawJob = await agencyRequest(`/jobs/${input.jobId}`);
    const job = { jobId: rawJob?.jobId, state: rawJob?.state, result: rawJob?.result,
      pipelineRun: rawJob?.pipelineRun ? {
        runId: rawJob.pipelineRun.runId, definitionId: rawJob.pipelineRun.definitionId
      } : null };
    requireThat(job.jobId === input.jobId, 'Agency returned a different job', 'blocked-result');
    if (operation === 'reconcile') return {
      job: { ...job, metadata: rawJob.metadata, createdAt: rawJob.createdAt }
    };
    const id = job.pipelineRun?.runId ?? input.buildId;
    requireThat(id == null || Number.isSafeInteger(id) && id > 0, 'Invalid actual build identity', 'blocked-result');
    const rawBuild = id ? await ado(`build/builds/${id}?api-version=7.1`) : null;
    const build = rawBuild ? {
      id: rawBuild.id, status: rawBuild.status, result: rawBuild.result,
      definitionId: rawBuild.definition?.id, definitionRevision: rawBuild.definition?.revision,
      sourceVersion: rawBuild.sourceVersion, sourceBranch: rawBuild.sourceBranch,
      queueTime: rawBuild.queueTime, startTime: rawBuild.startTime, finishTime: rawBuild.finishTime
    } : null;
    if (build) requireThat(build.id === id && build.definitionId === p.definitionId &&
      build.sourceVersion === p.revision && build.sourceBranch === p.ref,
    'Actual build is outside the reserved pipeline/source; no cancellation or acceptance', 'blocked-result');
    const terminal = ['Completed', 'Failed', 'Cancelled'].includes(job.state);
    if (operation === 'cancel') {
      if (!terminal) await agencyRequest(`/jobs/${input.jobId}/cancel`, 'POST');
      if (build && build.status !== 'completed')
        await ado(`build/builds/${id}?api-version=7.1`, 'PATCH', { status: 'cancelling' });
      return { cancellationRequested: true };
    }
    if (operation === 'inspect') return { job, build };
    requireThat(operation === 'download' && terminal && build?.status === 'completed',
      'Both Agency and actual build must be terminal before download', 'blocked-result');
    const rawTimeline = await ado(`build/builds/${id}/timeline?api-version=7.1`);
    requireThat(Array.isArray(rawTimeline?.records), 'Actual build timeline missing', 'blocked-result');
    const timeline = rawTimeline.records.map(task => ({
      id: task.id, parentId: task.parentId, type: task.type, name: task.name,
      state: task.state, result: task.result, logId: task.log?.id,
      startTime: task.startTime, finishTime: task.finishTime
    }));
    const logs = [];
    for (const name of [contract.prepareTask, contract.validationTask]) {
      const tasks = timeline.filter(task => task.type === 'Task' && task.name === name);
      requireThat(tasks.length === 1 && Number.isSafeInteger(tasks[0].logId),
        'Trusted producer task/log missing or ambiguous', 'blocked-result');
      const task = tasks[0], log = await ado(`build/builds/${id}/logs/${task.logId}?api-version=7.1`);
      const lines = typeof log === 'string' ? log.split(/\r?\n/) : Array.isArray(log) ? log : log?.value;
      requireThat(Array.isArray(lines) && lines.every(line => typeof line === 'string'),
        'Trusted producer log has an unsupported representation', 'blocked-result');
      const marker = ['agency-oa-workspace-loop-contract-v1', 'agency-oa-workspace-authoring-contract-v1'].includes(contract.schema)
        ? /LOOP_PREPARED |LOOP_RESULT / : /PROBE_PREPARED |PROBE_STAGE_END |PROBE_RESULT /;
      logs.push({ taskId: task.id, logId: task.logId, lines: lines.filter(line => marker.test(line)) });
    }
    const rawArtifacts = await ado(`build/builds/${id}/artifacts?api-version=7.1`);
    requireThat(Array.isArray(rawArtifacts?.value), 'Actual artifact list missing', 'blocked-result');
    const artifacts = rawArtifacts.value.map(artifact => ({
      id: artifact.id, name: artifact.name, type: artifact.resource?.type
    }));
    requireThat(artifacts.filter(artifact => artifact.name === `${p.artifactPrefix}${id}`).length === 1,
      'Exact build-owned artifact missing or ambiguous', 'blocked-result');
    const yaml = await pipelineContent(false);
    const inputFile = join(directory, `artifact-download-${id}.json`);
    dependencies.save(inputFile, { contract, jobId: input.jobId, buildId: id });
    requireThat(Date.now() < deadline, 'Artifact transport deadline exhausted', 'blocked-reconciliation');
    const downloaded = await execute('pwsh.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', agencyArtifactTransportPath,
      '-InputFile', inputFile, '-OutputDirectory', directory
    ], dirname(agencyArtifactTransportPath), deadline - Date.now(), process.env);
    requireThat(JSON.parse(downloaded.stdout.trim()).downloaded === true,
      'Artifact download did not confirm completion', 'blocked-result');
    return { job, build, timeline, logs, artifacts, pipelineYaml: yaml };
  };
}
