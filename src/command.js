import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function command(executable, args, cwd, timeout = 120000, env = process.env) {
  return exec(executable, args, { cwd, env, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
}
