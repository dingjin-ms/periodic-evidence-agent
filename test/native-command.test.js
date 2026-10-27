import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeCommand } from '../src/native-command.js';
import { minimalEnvironment, command } from '../src/workers.js';

function fixture(t, cleanup = true) {
  const root = mkdtempSync(join(tmpdir(), 'native containment '));
  if (cleanup) t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('contained native command preserves arguments, cwd, output and environment boundaries',
  { skip: process.platform !== 'win32' }, async t => {
    const root = fixture(t), script = join(root, 'child.mjs');
    writeFileSync(script, `console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),
      marker:process.env.TEST_MARKER,requestPresent:'PILOT_NATIVE_COMMAND' in process.env}));`);
    const args = ['--', '', 'with spaces', 'with"quote', 'single\'quote', 'trailing\\', 'slash\\"quote'];
    const result = await nativeCommand(process.execPath, [script, ...args], root, 15000,
      { ...minimalEnvironment(), TEST_MARKER: 'synthetic' });
    const observed = JSON.parse(result.stdout);
    assert.equal(statSync(observed.cwd).ino, statSync(root).ino);
    assert.equal(statSync(observed.cwd).dev, statSync(root).dev);
    assert.deepEqual({ ...observed, cwd: root }, { args, cwd: root, marker: 'synthetic', requestPresent: false });
    assert.equal(result.stderr, '');
  });

test('concurrent native commands keep separate jobs, input and environments while reusing compiled code',
  { skip: process.platform !== 'win32' }, async t => {
    const root = fixture(t);
    const { nativeCommand: coldCommand } = await import('../src/native-command.js?cold-concurrency');
    const runs = ['first', 'second', 'third'].map(marker => {
      const run = coldCommand(process.execPath, ['-e',
        'console.log(JSON.stringify({marker:process.env.TEST_MARKER,pid:process.pid,request:process.env.PILOT_NATIVE_COMMAND}))'],
      root, 15000, { ...minimalEnvironment(), TEST_MARKER: marker });
      assert(Number.isInteger(run.child?.pid));
      return run;
    });
    assert.equal(new Set(runs.map(run => run.child.pid)).size, runs.length);
    const results = await Promise.all(runs);
    const observed = results.map(result => JSON.parse(result.stdout));
    assert.deepEqual(observed.map(value => value.marker), ['first', 'second', 'third']);
    assert.equal(new Set(observed.map(value => value.pid)).size, runs.length);
    for (const [index, result] of results.entries()) {
      assert.equal(result.ownedProcessesExited, true);
      assert.equal(result.stderr, '');
      assert.equal(observed[index].request, undefined);
      assert.throws(() => process.kill(observed[index].pid, 0), { code: 'ESRCH' });
    }
  });

test('aborting a cold native launch does not poison compilation or launch the cancelled application',
  { skip: process.platform !== 'win32' }, async t => {
    const root = fixture(t), marker = join(root, 'launched');
    const { nativeCommand: coldCommand } = await import('../src/native-command.js?cold-abort');
    const controller = new AbortController();
    controller.abort();
    const args = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'launched')`];
    await assert.rejects(coldCommand(process.execPath, args, root, 15000,
      minimalEnvironment(), { signal: controller.signal }),
    error => error.code === 'ABORT_ERR' && error.ownedProcessesExited === true);
    assert.equal(existsSync(marker), false);
    const result = await coldCommand(process.execPath, args, root, 15000, minimalEnvironment());
    assert.equal(result.ownedProcessesExited, true);
    assert.equal(readFileSync(marker, 'utf8'), 'launched');
  });

for (const input of ['not-base64!', Buffer.from('not an assembly').toString('base64')]) {
  test(`invalid native assembly input cannot launch an application (${input})`,
    { skip: process.platform !== 'win32' }, async t => {
      const root = fixture(t), marker = join(root, 'unexpected-launch');
      const run = promisify(execFile)('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
        fileURLToPath(new URL('../src/native-command.ps1', import.meta.url))], {
        cwd: root, timeout: 15000, windowsHide: true,
        env: { ...minimalEnvironment(), PILOT_NATIVE_COMMAND: JSON.stringify({
          jobName: `Local\\PilotNative-${randomUUID()}`, assemblyFromStdin: true,
          executable: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'launched')`]
        }) }
      });
      run.child.stdin.end(`${input}\n`);
      await assert.rejects(run, error => error.code === 1 && !error.killed);
      assert.equal(existsSync(marker), false);
    });
}

for (const pathExt of [undefined, '', ' ', '.CMD;.BAT']) {
  test(`native launch rejects unusable PATHEXT (${JSON.stringify(pathExt)}) before execution`,
    { skip: process.platform !== 'win32' }, async t => {
      const root = fixture(t), marker = join(root, 'unexpected-launch');
      const env = minimalEnvironment();
      delete env.PATHEXT;
      if (pathExt !== undefined) env.PATHEXT = pathExt;
      await assert.rejects(nativeCommand(process.execPath,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'launched')`],
        root, 15000, env), { code: 'blocked-native-environment' });
      assert.equal(existsSync(marker), false);
      assert.equal(env.PATHEXT, pathExt, 'The runner must not manufacture environment defaults');
    });
}

test('direct supervisor also rejects missing PATHEXT without a success-shaped exit',
  { skip: process.platform !== 'win32' }, async t => {
    const root = fixture(t), marker = join(root, 'unexpected-launch');
    const env = { ...minimalEnvironment(), PILOT_NATIVE_COMMAND: JSON.stringify({
      jobName: `Local\\PilotNative-${randomUUID()}`,
      executable: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'launched')`]
    }) };
    delete env.PATHEXT;
    await assert.rejects(command('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      fileURLToPath(new URL('../src/native-command.ps1', import.meta.url))], root, 15000, env),
    error => error.code !== 0 && /requires PATHEXT including .EXE/.test(error.stderr));
    assert.equal(existsSync(marker), false);
  });

test('direct supervisor retains trusted-source compilation without an assembly input',
  { skip: process.platform !== 'win32' }, async t => {
    const root = fixture(t), marker = join(root, 'launched');
    await command('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      fileURLToPath(new URL('../src/native-command.ps1', import.meta.url))], root, 15000, {
      ...minimalEnvironment(), PILOT_NATIVE_COMMAND: JSON.stringify({
        jobName: `Local\\PilotNative-${randomUUID()}`, executable: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'launched')`]
      })
    });
    assert.equal(readFileSync(marker, 'utf8'), 'launched');
  });

for (const exitCode of [0, 23]) test(`native silent exit ${exitCode} requires actual execution`,
  { skip: process.platform !== 'win32' }, async t => {
    const root = fixture(t), marker = join(root, 'launched');
    const env = { ...minimalEnvironment(), PATHEXT: '.com;.exe;.bat;.cmd' };
    const run = nativeCommand(process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'launched');process.exit(${exitCode})`],
      root, 15000, env);
    assert.ok(run.child && Number.isInteger(run.child.pid), 'Expose the supervisor handle for cancellation and drain');
    if (exitCode === 0) {
      const output = await run;
      assert.equal(output.stdout, ''); assert.equal(output.stderr, '');
    } else {
      await assert.rejects(run, error => error.code === exitCode && error.stdout === '' && error.stderr === '');
    }
    assert.equal(readFileSync(marker, 'utf8'), 'launched');
  });

for (const mode of ['missing', 'cmdlet', 'script', 'invalid-binary']) {
  test(`native ${mode} resolution cannot substitute for an application launch`,
    { skip: process.platform !== 'win32' }, async t => {
      const root = fixture(t), marker = join(root, 'unexpected-script-launch');
      let executable = join(root, 'missing.exe');
      if (mode === 'cmdlet') executable = 'Write-Output';
      if (mode === 'script') {
        executable = join(root, 'not-native.ps1');
        writeFileSync(executable, `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value 'launched'; exit 0`);
      }
      if (mode === 'invalid-binary') {
        executable = join(root, 'invalid.exe');
        writeFileSync(executable, 'Not an executable image');
      }
      await assert.rejects(nativeCommand(executable, [], root, 15000, minimalEnvironment()),
        error => error.code !== 0 && Boolean(error.stderr));
      assert.equal(existsSync(marker), false);
    });
}

for (const mode of ['timeout', 'abort', 'nonzero-exit', 'success', 'output-overflow']) test(`native ${mode} drains owned descendants`,
  { skip: process.platform !== 'win32' }, async t => {
    const root = fixture(t, false), leaf = join(root, 'leaf.mjs'), parent = join(root, 'parent.mjs');
    const idsPath = join(root, 'pids.json'), grandchildPath = join(root, 'grandchild.json');
    const grandchildScript = join(root, 'grandchild.mjs');
    writeFileSync(grandchildScript, 'setInterval(()=>{},1000);');
    writeFileSync(leaf, `import{spawn}from'node:child_process';import{writeFileSync,renameSync}from'node:fs';
      const child=spawn(process.execPath,[${JSON.stringify(grandchildScript)}],{stdio:'ignore'});
      writeFileSync(${JSON.stringify(grandchildPath + '.tmp')},JSON.stringify(child.pid));
      renameSync(${JSON.stringify(grandchildPath + '.tmp')},${JSON.stringify(grandchildPath)});
      setInterval(()=>{},1000);`);
    writeFileSync(parent, `import{spawn}from'node:child_process';import{writeFileSync,existsSync,renameSync}from'node:fs';
      const child=spawn(process.execPath,[${JSON.stringify(leaf)}],{stdio:'ignore'});
      writeFileSync(${JSON.stringify(idsPath + '.tmp')},JSON.stringify({parent:process.pid,child:child.pid}));
      renameSync(${JSON.stringify(idsPath + '.tmp')},${JSON.stringify(idsPath)});
      while(!existsSync(${JSON.stringify(grandchildPath)}))await new Promise(resolve=>setTimeout(resolve,10));
      console.log('synthetic-started');
      ${mode === 'timeout' || mode === 'abort' ? 'setInterval(()=>{},1000);' :
        mode === 'output-overflow' ? "process.stdout.write('x'.repeat(5*1024*1024));setInterval(()=>{},1000);" :
        mode === 'success' ? 'process.exit(0);' : "console.error('synthetic-failure');process.exit(23);"}
    `);
    t.after(async () => {
      try {
        if (!existsSync(idsPath)) return;
        const ids = Object.values(JSON.parse(readFileSync(idsPath)));
        if (existsSync(grandchildPath)) ids.push(JSON.parse(readFileSync(grandchildPath)));
        await command('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
          `foreach($id in @(${ids.join(',')})){$p=Get-CimInstance Win32_Process -Filter "ProcessId = $id";` +
          `if($p -and $p.CommandLine.Contains('${root.replaceAll("'", "''")}')){Stop-Process -Id $id -Force}}`],
        root, 10000, minimalEnvironment());
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
    const controller = new AbortController();
    const abortTimer = mode === 'abort' ? setTimeout(() => controller.abort(), 5000) : null;
    t.after(() => clearTimeout(abortTimer));
    let failure, output;
    try { output = await nativeCommand(process.execPath, [parent], root, mode === 'timeout' ? 5000 : 15000,
      minimalEnvironment(), { signal: controller.signal }); }
    catch (error) { failure = error; }
    assert.match((failure ?? output).stdout, /synthetic-started/);
    if (mode === 'success') assert.equal(failure, undefined);
    else {
      assert.ok(failure, 'The failed command must not look successful');
      if (mode === 'timeout') assert.equal(failure.killed, true);
      else if (mode === 'abort') {
        assert.equal(failure.code, 'ABORT_ERR');
        assert.equal(failure.ownedProcessesExited, true);
      }
      else if (mode === 'output-overflow') assert.equal(failure.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      else { assert.equal(failure.code, 23); assert.match(failure.stderr, /synthetic-failure/); }
    }
    const ids = [...Object.values(JSON.parse(readFileSync(idsPath))), JSON.parse(readFileSync(grandchildPath))];
    await new Promise(resolve => setTimeout(resolve, 200));
    for (const id of ids)
      assert.throws(() => process.kill(id, 0), error => error.code === 'ESRCH', `Owned process ${id} survived`);
  });
