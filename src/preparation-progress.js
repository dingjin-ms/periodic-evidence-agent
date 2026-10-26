import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { PilotError } from './common.js';

const progress = new AsyncLocalStorage();
const systemErrorCodes = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'ENOMEM', 'ENOSPC', 'EMFILE', 'ENFILE',
  'EIO', 'E2BIG', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
]);
const processSignals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGBREAK']);

export function preparationFailureDiagnostic(error) {
  try {
    const { code, signal, killed } = error ?? {};
    return {
      exitCode: Number.isSafeInteger(code) && code >= 0 && code <= 0xffffffff ? code : null,
      systemCode: systemErrorCodes.has(code) ? code : null,
      signal: processSignals.has(signal) ? signal : null,
      killed: killed === true
    };
  } catch {
    return { secondaryError: {
      code: 'preparation-diagnostic-unavailable',
      message: 'Secondary preparation failure details could not be inspected.'
    } };
  }
}

async function notify(context, event) {
  try {
    await context.onProgress(Object.freeze({ gateId: context.gateId, ...event }));
  } catch {
    throw new PilotError('blocked-preparation-progress',
      'Controller preparation progress could not be recorded');
  }
}

export async function preparationStage(stage, action) {
  const context = progress.getStore();
  if (!context) return action();
  const id = ++context.nextId;
  const started = performance.now();
  await notify(context, { id, stage, phase: 'start' });
  let result;
  try { result = await action(); }
  catch (error) {
    try { await notify(context, { id, stage, phase: 'failed', durationMs: performance.now() - started }); }
    catch {
      error.secondaryError ??= {
        code: 'preparation-progress-failed',
        message: 'Secondary preparation progress could not be recorded.'
      };
    }
    throw error;
  }
  await notify(context, { id, stage, phase: 'finish', durationMs: performance.now() - started });
  return result;
}

export function withPreparationProgress(gateId, onProgress, action) {
  if (!onProgress) return action();
  if (typeof onProgress !== 'function')
    throw new PilotError('blocked-preparation-progress',
      'Controller preparation progress must be a function');
  return progress.run({ gateId, onProgress, nextId: 0 },
    () => preparationStage('preparation', action));
}
