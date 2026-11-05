import { hash, json, requireThat, now } from './common.js';
import { command } from './command.js';

// The same pinned entry is delivered to both stages; a path or installation is
// not evidence that a worker received its contents.
export async function requestSkillPayload(config, repo, binding, qualification, revision, execute = command) {
  requireThat(!binding.externalBundle, 'Request skill delivery requires repository-native source', 'blocked-config');
  requireThat(qualification?.baseRevision === revision && qualification.skillPath === binding.skillPath &&
    /^[a-f0-9]{64}$/.test(qualification.skillSha256 ?? ''),
  'Request skill qualification is missing or stale', 'blocked-reconciliation');
  const output = await execute('git', ['--no-pager', 'show', `${revision}:${binding.skillPath}`], repo.referenceCheckout, 30000);
  const content = output.stdout;
  requireThat(typeof content === 'string' && Buffer.byteLength(content) > 0 && Buffer.byteLength(content) <= config.limits.maxFileBytes &&
    hash(content) === qualification.skillSha256, 'Request skill bytes differ from qualification or exceed budget', 'blocked-reconciliation');
  return { path: binding.skillPath, revision, sha256: hash(content), content };
}

export function skillDeliveryReceipt(ledger, jobId, stage, sessionId, payload, round = 0) {
  requireThat(['FILTER', 'PROPOSER'].includes(stage) && typeof sessionId === 'string' && sessionId &&
    payload?.path && /^[a-f0-9]{40,64}$/.test(payload.revision) && hash(payload.content) === payload.sha256,
  'Skill delivery needs exact stage/session/source bytes', 'blocked-reconciliation');
  requireThat(Number.isSafeInteger(round) && round >= 0, 'Invalid skill delivery round', 'blocked-reconciliation');
  const detail = { stage, sessionId, round, skillPath: payload.path, sourceRevision: payload.revision,
    skillSha256: payload.sha256, bytes: Buffer.byteLength(payload.content),
    payloadSha256: hash(json(payload)), deliveredAt: now(), evidence: 'submitted-model-input-not-model-comprehension' };
  const id = `${jobId}:skill-delivery:${stage}:${sessionId}:${round}`;
  ledger.operation(id, jobId, 'repository-skill-delivery', detail);
  ledger.finishOperation(id, 'submitted', detail);
  return detail;
}
