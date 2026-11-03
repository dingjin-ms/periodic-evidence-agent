import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { boundedPath, hash, json, now, requireThat } from './common.js';

const app = 'ooui/apps/excel-agent-declarative-e2e';
export const unitDiagnosticFiles = [
  '01-provision-custom-skill.open-custom-skills.open-category.png',
  '02-provision-custom-skill.ensure-skills-folder.create-skills-folder.png',
  '08-close-manage-skills.close-manage.png',
  '09-remove-custom-skill.remove-custom-skill.png'
].map(name => `${app}/${name}`);
const png = Buffer.from('89504e470d0a1a0a', 'hex');

export function captureUnitDiagnostics(workspace, directory, sourceRevision) {
  const part = relative(workspace, directory);
  requireThat(isAbsolute(directory) && part &&
    (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) &&
    !existsSync(directory),
  'Unit diagnostics need a fresh external artifact directory', 'blocked-validation');
  const tracked = execFileSync('git', ['-c', 'core.longpaths=true', 'ls-files', '--',
    ...unitDiagnosticFiles], { cwd: workspace, windowsHide: true, encoding: 'utf8', timeout: 120000 }).trim();
  requireThat(!tracked && unitDiagnosticFiles.every(file =>
    !lstatSync(join(workspace, file), { throwIfNoEntry: false })),
    'Unit diagnostic paths must not contain tracked or pre-existing files', 'blocked-validation');
  const observed = new Map(), captures = [], deferrals = {};
  let failure = null, finished = false;
  const collect = force => {
    for (const file of unitDiagnosticFiles) {
      if (!existsSync(join(workspace, file))) { observed.delete(file); continue; }
      const source = boundedPath(workspace, file, { write: true });
      const info = lstatSync(source);
      requireThat(info.isFile() && !info.isSymbolicLink() && info.size <= 20 * 1024 * 1024,
        'Unexpected native unit diagnostic entry', 'blocked-validation');
      const signature = `${info.size}:${info.mtimeMs}`;
      if (!force && observed.get(file) !== signature) { observed.set(file, signature); continue; }
      requireThat(captures.length < 64, 'Native unit diagnostic count exceeded its bound',
        'blocked-validation');
      const bytes = readFileSync(source);
      requireThat(bytes.subarray(0, png.length).equals(png),
        'Native unit diagnostic is not a PNG', 'blocked-validation');
      mkdirSync(directory, { recursive: true });
      const destination = join(directory, `${String(captures.length).padStart(3, '0')}-${file.split('/').at(-1)}`);
      try { renameSync(source, destination); }
      catch (error) {
        if (!force && ['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) {
          deferrals[error.code] = (deferrals[error.code] ?? 0) + 1;
          continue;
        }
        throw error;
      }
      captures.push({ source: file, path: destination, sha256: hash(bytes),
        bytes: bytes.length, capturedAt: now() });
      observed.delete(file);
    }
  };
  const timer = setInterval(() => {
    try { collect(false); }
    catch (error) { failure = error; clearInterval(timer); }
  }, 250);
  timer.unref();
  return {
    finish() {
      requireThat(!finished, 'Unit diagnostic capture is already finalized', 'blocked-reconciliation');
      finished = true;
      clearInterval(timer);
      if (failure) throw failure;
      collect(true);
      requireThat(captures.every(capture => hash(readFileSync(capture.path)) === capture.sha256),
        'Captured native unit diagnostic changed', 'blocked-validation');
      const receipt = { format: 'native-unit-diagnostics-v1', sourceRevision, captures, deferrals };
      mkdirSync(directory, { recursive: true });
      const artifactRef = join(directory, 'receipt.json');
      writeFileSync(artifactRef, json(receipt), { flag: 'wx', mode: 0o600 });
      return { ...receipt, artifactRef };
    }
  };
}
