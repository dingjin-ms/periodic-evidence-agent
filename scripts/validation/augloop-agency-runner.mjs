import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const owners = [
  { id: 'excel-agent-in-container-proxy', package: '@augloop-utils/excel-agent-in-container-proxy', runner: 'jest' },
  { id: 'session-protocol', package: '@augloop/session-protocol', runner: 'mocha' },
  { id: 'doclab-serialization', package: '@augloop-utils/doclab-serialization', runner: 'jest' },
  { id: 'eval-vnext-config-resolver', package: '@augloop-utils/eval-vnext-config-resolver', runner: 'jest' }
];
const steps = ['cli-build', 'workspace-build', 'eslint', 'test'];
const allowedPrefixes = [
  'server/session-protocol/test/integration-evolution/',
  'utils/doclab-serialization/tests/',
  'utils/eval-vnext-config-resolver/tests/',
  'utils/excel-agent-in-container-proxy/tests/'
];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const scriptPath = fileURLToPath(import.meta.url);
const preloadPath = join(dirname(scriptPath), 'augloop-agency-node-preload.cjs');
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });

function requireValue(value, message) {
  if (!value) throw new Error(message);
}

function command(owner, step, root, evidence) {
  const node = process.execPath;
  const yarn = join(root, '.yarn', 'releases', 'yarn-3.2.1.cjs');
  const cli = join(root, 'tools', 'node_modules', '@augloop-tools', 'cli', 'lib', 'src', 'cli.js');
  if (step === 'cli-build') return [node, [cli, 'build', owner.package]];
  if (step === 'workspace-build') return [node, [yarn, 'workspace', owner.package, 'build']];
  if (step === 'eslint') return [node, [yarn, 'workspace', owner.package, 'exec', 'gulp', 'eslint']];
  const args = [yarn, 'workspace', owner.package, 'test'];
  if (owner.runner === 'jest') args.push('--cacheDirectory', join(evidence, 'jest-cache', owner.id));
  return [node, args];
}

function population(owner, text) {
  const plain = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  if (owner.runner === 'mocha') {
    const matches = [...plain.matchAll(/(?:^|\n)\s*(\d+) passing(?:\s|$)/g)];
    return matches.length ? Number(matches.at(-1)[1]) : 0;
  }
  const matches = [...plain.matchAll(/Tests:\s+(?:(?:\d+) skipped,\s+)?(\d+) passed(?:,\s+(\d+) total)?/g)];
  return matches.length ? Number(matches.at(-1)[2] ?? matches.at(-1)[1]) : 0;
}

function nativeAsset(root, fileName) {
  const found = globSync(`server/tracelogger/**/${fileName}`, { cwd: root }).sort().at(0) ?? null;
  const path = found?.replaceAll('\\', '/') ?? null;
  return { present: path !== null, path, sha256: path ? sha256(readFileSync(join(root, path))) : null };
}

async function drain(pid) {
  if (process.platform !== 'win32') return;
  await new Promise(resolveDrain => {
    const child = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true, stdio: 'ignore'
    });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveDrain();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, 20000);
    child.once('close', finish).once('error', finish);
  });
}

async function bypassInteractiveAzureLogin(pid) {
  if (process.platform !== 'win32') return false;
  const script = [
    `$all = @(Get-CimInstance Win32_Process)`,
    `$queue = [Collections.Generic.Queue[int]]::new(); $queue.Enqueue(${pid})`,
    `$descendants = [Collections.Generic.List[object]]::new()`,
    `while ($queue.Count) { $parent = $queue.Dequeue(); foreach ($process in $all) {`,
    `if ([int]$process.ParentProcessId -eq $parent) { $descendants.Add($process); $queue.Enqueue([int]$process.ProcessId) } } }`,
    `$matches = @($descendants | Where-Object {`,
    `$candidate = [int]$_.ProcessId; $hasChild = @($descendants | Where-Object { [int]$_.ParentProcessId -eq $candidate }).Count -gt 0;`,
    `$line = [string]$_.CommandLine; -not $hasChild -and $line -match '(?i)(az(\\.cmd|\\.exe)?\\s+login|python.*azure\\.cli.*login|azure[-_]?cli.*login|__main__\\.py\\s+login)' })`,
    `if ($matches.Count -ne 1) { exit 2 }`,
    `Stop-Process -Id ([int]$matches[0].ProcessId) -Force; Write-Output $matches[0].ProcessId`
  ].join('; ');
  const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    cwd: process.cwd(), env: process.env, timeoutMs: 20000,
    stdoutPath: join(process.env.TEMP ?? process.cwd(), `agency-azure-login-${pid}.stdout.tmp`),
    stderrPath: join(process.env.TEMP ?? process.cwd(), `agency-azure-login-${pid}.stderr.tmp`),
    detectInteractiveLogin: false
  });
  return result.exitCode === 0;
}

async function run(executable, args, { cwd, env, timeoutMs, stdoutPath, stderrPath,
  detectInteractiveLogin = false }) {
  return new Promise((resolveRun, rejectRun) => {
    const stdout = [], stderr = [];
    const child = spawn(executable, args, { cwd, env, windowsHide: true, shell: false });
    let timedOut = false, settled = false, loginBypassStarted = false, interactiveLoginBypassed = false;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
      writeFileSync(stdoutPath, out); writeFileSync(stderrPath, err);
      resolveRun({ exitCode: code ?? -1, timedOut, interactiveLoginBypassed,
        stdout: out.toString('utf8'), stderr: err.toString('utf8') });
    };
    const timer = setTimeout(async () => {
      timedOut = true;
      await drain(child.pid);
      child.kill();
      finish(-1);
    }, timeoutMs);
    const capture = target => chunk => {
      target.push(chunk);
      if (!detectInteractiveLogin || loginBypassStarted) return;
      const text = `${Buffer.concat(stdout).toString('utf8')}\n${Buffer.concat(stderr).toString('utf8')}`;
      if (!/interactive Azure login window will appear/i.test(text) &&
        !(/Azure CLI login is required for lage remote cache to work/i.test(text) &&
          /Launching interactive login/i.test(text))) return;
      loginBypassStarted = true;
      bypassInteractiveAzureLogin(child.pid).then(bypassed => { interactiveLoginBypassed = bypassed; });
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', error => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('close', finish);
  });
}

async function git(root, args, temporaryDirectory) {
  const output = await run(process.platform === 'win32' ? 'git.exe' : 'git', args, {
    cwd: root, env: process.env, timeoutMs: 120000,
    stdoutPath: join(temporaryDirectory, 'git.stdout.tmp'),
    stderrPath: join(temporaryDirectory, 'git.stderr.tmp')
  });
  requireValue(output.exitCode === 0, `git ${args.join(' ')} failed`);
  return output.stdout.trimEnd();
}

async function restoreGeneratedChanges(root, evidence, candidateFiles, initialTrackedStatus) {
  const status = (await git(root, ['status', '--porcelain=v1', '--untracked-files=no'], evidence))
    .split(/\r?\n/).filter(Boolean);
  const paths = status.map(line => line.slice(3).replaceAll('\\', '/'));
  const generated = paths.filter(path => path !== '.npmrc' && !candidateFiles.has(path));
  if (generated.length) await git(root, ['restore', '--worktree', '--', ...generated], evidence);
  const finalStatus = (await git(root, ['status', '--porcelain=v1', '--untracked-files=no'], evidence))
    .split(/\r?\n/).filter(Boolean);
  requireValue(JSON.stringify(finalStatus) === JSON.stringify(initialTrackedStatus),
    'Gate changed tracked files outside the candidate and pipeline-owned .npmrc');
}

async function main() {
  const inputPath = process.argv[2];
  requireValue(inputPath && isAbsolute(inputPath), 'Runner requires an absolute contract path');
  const input = readJson(inputPath), root = resolve(input.workspaceRoot), evidence = resolve(input.evidenceDirectory);
  requireValue(input.schema === 'pea-al-agency-runner-input-v1', 'Unsupported AL runner input');
  requireValue(input.maximumJobMinutes === 90 && input.maximumControllerMinutes === 180 && input.maxRepairAttempts === 2,
    'AL runner budget/deadline contract changed');
  requireValue(Number.isFinite(Date.parse(input.controllerDeadlineAt)) &&
    Date.parse(input.controllerDeadlineAt) > Date.now() &&
    Date.parse(input.controllerDeadlineAt) - Date.now() <= input.maximumControllerMinutes * 60000,
  'AL runner controller deadline is absent, expired or exceeds the contract');
  requireValue(/^[a-f0-9]{40}$/.test(input.baseRevision) && /^[a-f0-9]{40}$/.test(input.candidate),
    'AL runner requires exact revisions');
  requireValue(isAbsolute(root) && isAbsolute(evidence) && !existsSync(evidence),
    'Evidence directory must be fresh and absolute');
  mkdirSync(join(evidence, 'logs'), { recursive: true });
  mkdirSync(join(evidence, 'assets'), { recursive: true });
  const head = await git(root, ['rev-parse', 'HEAD'], evidence);
  requireValue(head === input.candidate && head !== input.baseRevision,
    'Workspace is not the exact authored candidate');
  requireValue(Number.isSafeInteger(input.repairAttempt) && input.repairAttempt >= 0 &&
    input.repairAttempt <= input.maxRepairAttempts, 'Invalid repair attempt');
  await git(root, ['merge-base', '--is-ancestor', input.baseRevision, input.candidate], evidence);
  const commitCount = Number(await git(root,
    ['rev-list', '--count', `${input.baseRevision}..${input.candidate}`], evidence));
  requireValue(commitCount === input.repairAttempt + 1,
    'Candidate commit count does not match one authoring commit plus bounded repairs');
  const changed = (await git(root,
    ['diff', '--name-only', '--no-renames', input.baseRevision, input.candidate, '--'], evidence))
    .split(/\r?\n/).filter(Boolean).map(path => path.replaceAll('\\', '/'));
  requireValue(changed.length > 0 && changed.every(path =>
    allowedPrefixes.some(prefix => path.startsWith(prefix))),
  'Candidate changed files exceed the four owner test scopes');
  const candidateFiles = new Set(changed);
  const initialTrackedStatus = (await git(root,
    ['status', '--porcelain=v1', '--untracked-files=no'], evidence)).split(/\r?\n/).filter(Boolean);
  requireValue(initialTrackedStatus.every(line => line === ' M .npmrc'),
    'Workspace has an unsupported tracked modification before gates');
  requireValue(existsSync(preloadPath), 'Pinned Node preload is missing');
  const runnerSha256 = sha256(readFileSync(scriptPath)), preloadSha256 = sha256(readFileSync(preloadPath));
  const runnerChanged = input.expectedRunnerSha256 && input.expectedRunnerSha256 !== runnerSha256;
  const skillPath = join(root, 'utils', 'excel-agent-in-container-proxy', '.github', 'skills',
    'excel-agent-in-container-proxy-integration-tests', 'SKILL.md');
  requireValue(existsSync(skillPath) && /^[a-f0-9]{64}$/.test(input.expectedSkillSha256 ?? '') &&
    sha256(readFileSync(skillPath)) === input.expectedSkillSha256, 'Native AL skill hash changed');
  if (runnerChanged)
    requireValue(input.allowRunnerRepair === true && typeof input.runnerRepairReason === 'string' &&
      input.runnerRepairReason.length > 0 && typeof input.runnerRepairPatchSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(input.runnerRepairPatchSha256) &&
      isAbsolute(input.runnerRepairPatchPath ?? '') && existsSync(input.runnerRepairPatchPath) &&
      sha256(readFileSync(input.runnerRepairPatchPath)) === input.runnerRepairPatchSha256,
    'Runner changed without an explicitly recorded controller repair');
  if (input.expectedPreloadSha256)
    requireValue(input.expectedPreloadSha256 === preloadSha256, 'Preload hash changed');
  copyFileSync(scriptPath, join(evidence, 'assets', 'augloop-agency-runner.mjs'));
  copyFileSync(preloadPath, join(evidence, 'assets', 'augloop-agency-node-preload.cjs'));
  if (runnerChanged) copyFileSync(input.runnerRepairPatchPath,
    join(evidence, 'assets', 'augloop-agency-runner.patch'));
  const auditPath = join(evidence, 'node-preload-audit.ndjson');
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''}--require=${preloadPath}`,
    AGENCY_AL_PRELOAD_AUDIT: auditPath,
    npm_config_msvs_version: 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise',
    VCINSTALLDIR: 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\',
    VSCMD_VER: '17.14.37827.9',
    WindowsSDKVersion: '10.0.26100.0\\',
    LAGE_CONCURRENCY: '1'
  };
  delete env.LAGE_GIT_IGNORED_FILES;
  const startedAt = new Date().toISOString(), gates = [];
  for (const owner of owners) {
    for (const step of steps) {
      const gateId = `${owner.id}-${step}`, [executable, args] = command(owner, step, root, evidence);
      const stdoutPath = join(evidence, 'logs', `${gateId}.stdout.log`);
      const stderrPath = join(evidence, 'logs', `${gateId}.stderr.log`);
      const start = new Date().toISOString();
      const remainingMs = Date.parse(input.controllerDeadlineAt) - Date.now() - 20 * 60000;
      requireValue(remainingMs > 0, 'AL runner reached the required twenty-minute stop reserve');
      const result = await run(executable, args, {
        cwd: root, env, timeoutMs: Math.min(80 * 60000, remainingMs), stdoutPath, stderrPath,
        detectInteractiveLogin: step === 'cli-build'
      });
      await restoreGeneratedChanges(root, evidence, candidateFiles, initialTrackedStatus);
      const text = `${result.stdout}\n${result.stderr}`;
      const testPopulation = step === 'test' ? population(owner, text) : null;
      gates.push({ gateId, owner: owner.id, package: owner.package, step, runner: owner.runner,
        executable: basename(executable), args, cwd: root, start, end: new Date().toISOString(),
        exitCode: result.exitCode, timedOut: result.timedOut,
        interactiveAzureLoginBypassed: result.interactiveLoginBypassed, testPopulation,
        stdout: { path: `logs/${gateId}.stdout.log`, sha256: sha256(readFileSync(stdoutPath)) },
        stderr: { path: `logs/${gateId}.stderr.log`, sha256: sha256(readFileSync(stderrPath)) } });
    }
  }
  const passed = gates.every(gate => gate.exitCode === 0 && !gate.timedOut &&
    (gate.step !== 'test' || gate.testPopulation > 0));
  const excelCli = gates.find(gate => gate.owner === 'excel-agent-in-container-proxy' &&
    gate.step === 'cli-build');
  const excelCliText = excelCli ? `${readFileSync(join(evidence, excelCli.stdout.path), 'utf8')}\n${
    readFileSync(join(evidence, excelCli.stderr.path), 'utf8')}` : '';
  const alTraceLoggerNode = nativeAsset(root, 'ALTraceLogger.node');
  const perfCounters = nativeAsset(root, 'PerfCountersDll.dll');
  const excelNativeProof = {
    traceLoggerBuild: /@augloop\/tracelogger build success/i.test(excelCliText),
    sfNativeBuild: /@augloop\/sf-native build success/i.test(excelCliText),
    alTraceLoggerNode: alTraceLoggerNode.present,
    perfCounters: perfCounters.present,
    assets: { alTraceLoggerNode, perfCounters }
  };
  const nativePassed = excelNativeProof.traceLoggerBuild && excelNativeProof.sfNativeBuild &&
    excelNativeProof.alTraceLoggerNode && excelNativeProof.perfCounters;
  const receipt = {
    schema: 'pea-al-agency-runner-receipt-v1', startedAt, finishedAt: new Date().toISOString(),
    baseRevision: input.baseRevision, candidate: input.candidate, changedFiles: changed,
    skill: { path: 'utils/excel-agent-in-container-proxy/.github/skills/excel-agent-in-container-proxy-integration-tests/SKILL.md',
      sha256: input.expectedSkillSha256 },
    model: 'gpt-6-luna', softCreditLimit: 30, maximumJobMinutes: 90,
    maximumControllerMinutes: 180, maxRepairAttempts: 2, repairAttempt: input.repairAttempt,
    runner: { path: 'assets/augloop-agency-runner.mjs', originalSha256: input.expectedRunnerSha256 ?? runnerSha256,
      sha256: runnerSha256, modifiedRemotely: Boolean(runnerChanged),
      repairReason: runnerChanged ? input.runnerRepairReason : null,
      repairPatchPath: runnerChanged ? 'assets/augloop-agency-runner.patch' : null,
      repairPatchSha256: runnerChanged ? input.runnerRepairPatchSha256 : null },
    preload: { path: 'assets/augloop-agency-node-preload.cjs', sha256: preloadSha256 },
    gateOrder: owners.map(owner => owner.id), gateCount: gates.length, gates,
    excelNativeProof, initialTrackedStatus,
    status: passed && nativePassed ? 'passed' : 'failed', controllerAcceptanceClaimed: false
  };
  writeJson(join(evidence, 'receipt.json'), receipt);
  appendFileSync(join(evidence, 'runner.complete'), `${receipt.status}\n`);
  if (!passed || !nativePassed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
