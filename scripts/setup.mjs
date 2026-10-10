import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function without(args, name) {
  return args.filter(value => value !== name);
}

export function buildSetupPlan(args = process.argv.slice(2)) {
  const skipInstall = args.includes('--skip-install');
  const skipChecks = args.includes('--skip-checks');
  let repositoryArgs = without(without(args, '--skip-install'), '--skip-checks');
  if (!repositoryArgs.includes('--config'))
    repositoryArgs = ['--config', 'pilot.local.json', ...repositoryArgs];
  return {
    repositoryArgs,
    steps: [
      ...skipInstall ? [] : [{ kind: 'npm', args: ['ci', '--ignore-scripts'], label: 'Installing locked dependencies' }],
      { kind: 'node', args: ['src/cli.js', 'setup', ...repositoryArgs], label: 'Setting up repository checkouts and skills' },
      { kind: 'node', args: ['src/cli.js', 'doctor', ...repositoryArgs.filter((value, index) =>
        value === '--config' || repositoryArgs[index - 1] === '--config')],
      label: 'Checking local configuration' },
      ...skipChecks ? [] : [
        { kind: 'npm', args: ['run', 'check'], label: 'Running the complete offline check' },
        { kind: 'npm', args: ['run', 'demo'], label: 'Running the synthetic demo' }
      ]
    ]
  };
}

function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli)
    return spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit', windowsHide: true });
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args,
    { stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' });
}

function runStep(step) {
  console.log(`\n[setup] ${step.label}`);
  const result = step.kind === 'npm'
    ? runNpm(step.args)
    : spawnSync(process.execPath, step.args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function runSetup(args = process.argv.slice(2)) {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 24)
    throw new Error(`Setup requires Node.js 24 or newer; found ${process.version}`);
  const plan = buildSetupPlan(args);
  for (const step of plan.steps) runStep(step);
  console.log('\n[setup] Devbox setup completed successfully.');
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runSetup();
