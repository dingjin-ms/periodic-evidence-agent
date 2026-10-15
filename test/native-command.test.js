import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

for (const mode of ['timeout', 'nonzero-exit', 'success', 'output-overflow']) test(`native ${mode} drains owned descendants`,
  { skip: process.platform !== 'win32' }, async t => {
    const root = fixture(t, false), leaf = join(root, 'leaf.mjs'), parent = join(root, 'parent.mjs');
    const idsPath = join(root, 'pids.json'), grandchildPath = join(root, 'grandchild.json');
    const grandchildScript = join(root, 'grandchild.mjs');
    writeFileSync(grandchildScript, 'setInterval(()=>{},1000);');
    writeFileSync(leaf, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
      const child=spawn(process.execPath,[${JSON.stringify(grandchildScript)}],{stdio:'ignore'});
      writeFileSync(${JSON.stringify(grandchildPath)},JSON.stringify(child.pid));setInterval(()=>{},1000);`);
    writeFileSync(parent, `import{spawn}from'node:child_process';import{writeFileSync,existsSync}from'node:fs';
      const child=spawn(process.execPath,[${JSON.stringify(leaf)}],{stdio:'ignore'});
      writeFileSync(${JSON.stringify(idsPath)},JSON.stringify({parent:process.pid,child:child.pid}));
      while(!existsSync(${JSON.stringify(grandchildPath)}))await new Promise(resolve=>setTimeout(resolve,10));
      console.log('synthetic-started');
      ${mode === 'timeout' ? 'setInterval(()=>{},1000);' :
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
    let failure, output;
    try { output = await nativeCommand(process.execPath, [parent], root, mode === 'timeout' ? 5000 : 15000,
      minimalEnvironment()); }
    catch (error) { failure = error; }
    assert.match((failure ?? output).stdout, /synthetic-started/);
    if (mode === 'success') assert.equal(failure, undefined);
    else {
      assert.ok(failure, 'The failed command must not look successful');
      if (mode === 'timeout') assert.equal(failure.killed, true);
      else if (mode === 'output-overflow') assert.equal(failure.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      else { assert.equal(failure.code, 23); assert.match(failure.stderr, /synthetic-failure/); }
    }
    const ids = [...Object.values(JSON.parse(readFileSync(idsPath))), JSON.parse(readFileSync(grandchildPath))];
    await new Promise(resolve => setTimeout(resolve, 200));
    for (const id of ids)
      assert.throws(() => process.kill(id, 0), error => error.code === 'ESRCH', `Owned process ${id} survived`);
  });
