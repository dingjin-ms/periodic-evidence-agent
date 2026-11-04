import { existsSync, lstatSync, realpathSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';

async function eachFile(files, action) {
  let index = 0;
  let failure;
  await Promise.all(Array.from({ length: Math.min(16, files.length) }, async () => {
    try { while (!failure && index < files.length) await action(files[index++]); }
    catch (error) { failure ??= error; }
  }));
  if (failure) throw failure;
}
import { execFileSync } from 'node:child_process';
import { hash, json, requireThat, boundedPath, safeError, now } from './common.js';

const relativePath = path => typeof path === 'string' && path.length > 0 && !isAbsolute(path) &&
  !path.includes('\\') && !path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git');
const git = (workspace, args) => execFileSync('git', ['-C', workspace, ...args], { timeout: 10000, maxBuffer: 16 * 1024 * 1024 });

export function requestToolManifest(repo) {
  const policy = repo.requestExecution?.tools;
  if (!policy) return null;
  requireThat(policy.scopeApproved === true && policy.approvalRef?.trim() && isAbsolute(policy.manifest?.path ?? '') &&
    /^[a-f0-9]{64}$/.test(policy.manifest?.sha256 ?? '') && Number.isSafeInteger(policy.timeoutMs) &&
    policy.timeoutMs > 0 && policy.timeoutMs <= 300000, 'Candidate tools need pinned bounded local authority', 'blocked-config');
  const bytes = readFileSync(policy.manifest.path);
  requireThat(hash(bytes) === policy.manifest.sha256, 'Candidate tool manifest changed', 'blocked-reconciliation');
  const manifest = JSON.parse(bytes);
  requireThat(manifest.format === 'request-local-tools-v1' && manifest.sourceRevision === repo.baseRef &&
    manifest.targetRef === repo.pr?.targetRef && manifest.provenance?.trim() &&
    Array.isArray(manifest.sourcePins) && manifest.sourcePins.length > 0 &&
    Array.isArray(manifest.roots) && manifest.roots.length > 0 && manifest.roots.every(relativePath) &&
    Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 100000 &&
    Array.isArray(manifest.links) && Array.isArray(manifest.runtimePins) && manifest.runtimePins.length > 0 &&
    /^[a-f0-9]{40}$/.test(manifest.targetRevision ?? ''), 'Invalid source-bound local tool closure', 'blocked-config');
  for (const pin of manifest.runtimePins) requireThat(isAbsolute(pin.path) && /^[a-f0-9]{64}$/.test(pin.sha256) &&
    hash(readFileSync(pin.path)) === pin.sha256, 'Pinned local runtime changed', 'blocked-reconciliation');
  const paths = new Set();
  for (const file of [...manifest.files, ...manifest.links]) {
    requireThat(relativePath(file.path) && manifest.roots.some(root => file.path === root || file.path.startsWith(root + '/')) &&
      !paths.has(file.path), 'Tool destination escapes or overlaps the declared closure', 'blocked-scope');
    paths.add(file.path);
  }
  for (const file of manifest.files) requireThat(isAbsolute(file.source) && /^[a-f0-9]{64}$/.test(file.sha256) &&
    [0o644, 0o755].includes(file.mode), 'Invalid exact tool file', 'blocked-config');
  for (const link of manifest.links) requireThat(relativePath(link.target) &&
    manifest.files.some(file => file.path === link.target || file.path.startsWith(link.target + '/')),
  'Tool links must resolve inside the copied closure', 'blocked-scope');
  return { policy, manifest };
}

export async function materializeRequestTools(config, ledger, job, repo, namespace = 'candidate') {
  const input = requestToolManifest(repo);
  if (!input) return null;
  const { policy, manifest } = input;
  const id = `${job.id}:request-tools:${namespace}`;
  requireThat(!ledger.status().operations.some(row => row.id === id), 'Tool preparation attempted; reconcile without replay', 'blocked-reconciliation');
  const started = Date.now(), deadline = started + policy.timeoutMs;
  const check = () => requireThat(Date.now() < deadline, 'Local tool preparation deadline exceeded', 'blocked-budget');
  const configurationSha256 = hash(json(config));
  const assertPins = () => {
    check();
    requireThat(hash(json(config)) === configurationSha256 && hash(readFileSync(policy.manifest.path)) === policy.manifest.sha256,
      'Tool preparation authority changed', 'blocked-reconciliation');
    requireThat(git(job.workspace, ['rev-parse', `refs/remotes/origin/${manifest.targetRef.slice(11)}`]).toString().trim() === manifest.targetRevision,
      'Candidate native-hook target ref changed', 'blocked-reconciliation');
    for (const pin of manifest.sourcePins) {
      requireThat(relativePath(pin.path) && /^[a-f0-9]{64}$/.test(pin.sha256) &&
        hash(git(job.workspace, ['show', `${job.base_revision}:${pin.path}`])) === pin.sha256 &&
        hash(readFileSync(boundedPath(job.workspace, pin.path))) === pin.checkoutSha256,
      'Candidate lock/runtime/hook source differs from tool closure', 'blocked-reconciliation');
    }
  };
  ledger.operation(id, job.id, 'request-tool-materialization', { workspace: job.workspace, manifest: policy.manifest, configurationSha256, startedAt: now() });
  try {
    const target = `refs/remotes/origin/${manifest.targetRef.slice(11)}`;
    try { git(job.workspace, ['show-ref', '--verify', '--quiet', target]); }
    catch {
      // A local clone need not copy its donor's remote-tracking refs. Bind only the
      // pinned existing object; never fetch or guess a newer branch tip.
      git(job.workspace, ['cat-file', '-e', `${manifest.targetRevision}^{commit}`]);
      git(job.workspace, ['update-ref', target, manifest.targetRevision, '0000000000000000000000000000000000000000']);
    }
    assertPins();
    for (const root of manifest.roots) {
      requireThat(!existsSync(boundedPath(job.workspace, root, { write: true })), 'Candidate tool root already exists', 'blocked-reconciliation');
      requireThat(!git(job.workspace, ['ls-files', '--', root]).length, 'Tool closure cannot overwrite tracked source', 'blocked-scope');
      // Require the repository's own ignore contract, not a new local exclusion.
      git(job.workspace, ['check-ignore', '--no-index', root + '/__closure_probe__']);
    }
    // Check every source before writing any destination. Sources may be qualified local cache links;
    // destination links below always resolve to this candidate, never back to that cache.
    await eachFile(manifest.files, async file => { check(); requireThat(hash(await readFile(file.source)) === file.sha256,
      'Pinned local tool source changed or is unavailable', 'blocked-reconciliation'); });
    let bytesCopied = 0;
    await eachFile(manifest.files, async file => {
      check(); const bytes = await readFile(file.source);
      requireThat(hash(bytes) === file.sha256, 'Local tool source changed during materialization', 'blocked-reconciliation');
      const target = boundedPath(job.workspace, file.path, { write: true });
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx', mode: file.mode });
      await chmod(target, file.mode); bytesCopied += bytes.length;
    });
    for (const link of manifest.links) {
      check(); const target = boundedPath(job.workspace, link.path, { write: true });
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(boundedPath(job.workspace, link.target), target, link.directory ? 'junction' : 'file');
    }
    assertPins();
    await eachFile(manifest.files, async file => { check(); requireThat(hash(await readFile(boundedPath(job.workspace, file.path))) === file.sha256,
      'Materialized tool bytes changed', 'blocked-reconciliation'); });
    const receipt = { manifest: policy.manifest, configurationSha256, sourceRevision: job.base_revision,
      workspace: job.workspace, files: manifest.files.length, links: manifest.links.length, bytesCopied,
      elapsedMs: Date.now() - started, finishedAt: now(), copied: true, liveReadiness: false };
    ledger.finishOperation(id, 'complete', receipt); return receipt;
  } catch (error) {
    ledger.finishOperation(id, 'blocked', { manifest: policy.manifest, configurationSha256, elapsedMs: Date.now() - started, error: safeError(error) });
    throw error;
  }
}

export async function verifyRequestTools(repo, workspace) {
  const input = requestToolManifest(repo);
  if (!input) return;
  await eachFile(input.manifest.files, async file => requireThat(hash(await readFile(boundedPath(workspace, file.path))) === file.sha256,
    'Candidate tool bytes drifted across phase boundary', 'blocked-reconciliation'));
  for (const link of input.manifest.links) requireThat(lstatSync(join(workspace, link.path)).isSymbolicLink() &&
    realpathSync(join(workspace, link.path)) === realpathSync(boundedPath(workspace, link.target)),
  'Candidate tool link changed', 'blocked-reconciliation');
}
