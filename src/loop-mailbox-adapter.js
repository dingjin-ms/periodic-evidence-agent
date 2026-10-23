import { requireThat } from './common.js';
import { digest, loopOperation, readLoopArtifact } from './loop-controller.js';

// A second adapter: durable host handoff, with no model/provider/session dependency.
// The foreground host explicitly drains one bounded role; polling never dispatches it.
export function createMailboxLoopAdapter(backend) {
  const binding = { id: 'mailbox:' + backend.binding.id, revision: backend.binding.revision };
  const key = request => request.operationId + ':mailbox';
  const inspect = (request, ledger) => {
    const entry = loopOperation(ledger, key(request));
    requireThat(entry && digest(entry.detail.request) === digest(request) &&
      digest(entry.detail.backend) === digest(backend.binding), 'Mailbox request/backend changed', 'blocked-reconciliation');
    return entry.detail.result ?? { state: 'awaiting-host', code: 'mailbox-pending',
      action: 'Drain the original mailbox role ' + request.operationId + '; never launch a replacement host.' };
  };
  return { binding, capabilities: backend.capabilities, qualification: backend.qualification,
    preflight: context => backend.preflight(context),
    execute(request, ledger) {
      ledger.operation(key(request), request.runId, 'loop-mailbox', { request, backend: backend.binding });
      return inspect(request, ledger);
    },
    resume: inspect,
    verify: (request, receipt, ledger) => backend.verify(request, receipt, ledger),
    async drain(request, ledger) {
      inspect(request, ledger);
      const id = key(request), owner = ledger.acquire(id);
      try {
        request.pins.configuration.forEach(pin => readLoopArtifact(ledger, { ...pin, kind: 'file' }));
        requireThat(backend.capabilities.includes(request.stage), 'Mailbox capability is unavailable', 'blocked-capability');
        await backend.preflight({ runId: request.runId, pins: request.pins, stage: request.stage });
        const entry = loopOperation(ledger, id);
        if (entry.detail.result?.state === 'complete') return entry.detail.result;
        const resume = entry.detail.started === true;
        requireThat(resume || Date.now() < Date.parse(request.pins.deadlineAt),
          'Mailbox start deadline exhausted', 'blocked-budget');
        ledger.finishOperation(id, 'started', { ...entry.detail, started: true });
        const result = await backend[resume ? 'resume' : 'execute'](request, ledger);
        ledger.finishOperation(id, result.state === 'complete' ? 'recorded' : 'started',
          { ...entry.detail, started: true, result });
        return result;
      } finally { ledger.release(id, owner); }
    }
  };
}
