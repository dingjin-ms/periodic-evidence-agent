import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

const script = fileURLToPath(new URL('./prepared-output-observer.ps1', import.meta.url));
const observerContext = new AsyncLocalStorage();

export function withPreparedOutputObserver(factory, action) {
  if (typeof factory !== 'function' || typeof action !== 'function')
    throw new TypeError('Prepared observation requires a factory and an action');
  return observerContext.run(factory, action);
}

export async function createPreparedOutputObserver() {
  const override = observerContext.getStore();
  if (override) return override();
  if (process.platform !== 'win32')
    return { watch, ready: async () => {}, close() {} };

  const child = spawn('pwsh.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const watchers = new Map();
  const barriers = new Map();
  let sequence = 0, closing = false, failure = null, stderr = '';
  const started = Promise.withResolvers();
  const exited = Promise.withResolvers();
  const timer = setTimeout(() => fail(new Error('Windows output observer startup timed out')), 60000);
  const ref = enabled => {
    for (const handle of [child, child.stdin, child.stdout, child.stderr])
      handle[enabled ? 'ref' : 'unref']?.();
  };
  const send = message => {
    if (failure) throw failure;
    if (closing) throw new Error('Output observer is closed');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  function close() {
    if (!closing) {
      closing = true;
      clearTimeout(timer);
      const error = failure ?? new Error('Output observer closed before acknowledgement');
      started.reject(error);
      for (const barrier of barriers.values()) barrier.reject(error);
      barriers.clear();
      ref(true);
      lines.close();
      child.stdin.destroy();
      child.kill();
    }
    return exited.promise;
  }
  function fail(error) {
    if (closing || failure) return;
    failure = error;
    const active = [...watchers];
    close();
    for (const [id, watcher] of active)
      if (watchers.has(id)) watcher.emit('error', error);
  }
  child.on('error', error => {
    fail(error);
    exited.resolve();
  });
  child.on('exit', (code, signal) => {
    if (!closing) fail(new Error(
      `Windows output observer exited (${code ?? signal}): ${stderr.trim()}`));
    exited.resolve();
  });
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.stderr.on('error', fail);
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8192); });
  lines.on('line', line => {
    if (closing) return;
    let message;
    try { message = JSON.parse(line); }
    catch { fail(new Error('Windows output observer returned invalid JSON')); return; }
    if (message.type === 'started') {
      clearTimeout(timer);
      started.resolve();
    } else if (message.type === 'ready' && barriers.has(message.id)) {
      barriers.get(message.id).resolve();
      barriers.delete(message.id);
    } else if (message.type === 'error') {
      fail(new Error(`Windows output observation failed: ${message.message}`));
    } else if (message.type === 'event' &&
      ['change', 'rename'].includes(message.eventType) &&
      (message.filename === null || typeof message.filename === 'string')) {
      watchers.get(message.id)?.emit('change', message.eventType, message.filename);
    } else {
      fail(new Error('Windows output observer returned an invalid message'));
    }
  });
  await started.promise;
  return {
    watch(path, options, callback) {
      const id = ++sequence;
      const watcher = new EventEmitter();
      watcher.on('change', callback);
      watcher.close = () => {
        if (!watchers.delete(id)) return;
        if (!closing) send({ type: 'close', id });
        if (watchers.size === 0) close();
      };
      watcher.unref = () => watcher;
      watchers.set(id, watcher);
      send({ type: 'watch', id, path, recursive: options.recursive });
      return watcher;
    },
    async ready() {
      if (failure) throw failure;
      const id = ++sequence;
      const barrier = Promise.withResolvers();
      barriers.set(id, barrier);
      ref(true);
      const deadline = setTimeout(() =>
        fail(new Error('Windows output observer acknowledgement timed out')), 60000);
      try {
        send({ type: 'barrier', id });
        await barrier.promise;
      } finally {
        clearTimeout(deadline);
        barriers.delete(id);
        ref(false);
      }
    },
    close
  };
}
