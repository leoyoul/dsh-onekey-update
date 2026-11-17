import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';

function call(handler, method, url) {
  return new Promise(resolve => handler({ method, url }, {
    writeHead(status) { this.status = status; },
    end(body) { resolve({ status: this.status, data: JSON.parse(body.toString()) }); },
  }));
}

async function waitForState(handler, phase) {
  for (let i = 0; i < 100; i++) {
    const { data } = await call(handler, 'GET', '/onekey-update/status');
    if (data.phase === phase) return data;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('未到达预期状态：' + phase);
}

test('停用插件进入更新列表并逐条升级，失败不阻塞其余插件且启停配置保持不变', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onekey-apply-'));
  const dir = path.join(home, 'profiles', 'qa');
  const envBefore = { DSH_HOME: process.env.DSH_HOME, DSH_PROFILE: process.env.DSH_PROFILE };
  const fetchBefore = globalThis.fetch;
  const resourcesBefore = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  const calls = [];
  const disposers = [];
  const names = ['dsh-failed-off', 'dsh-unlisted', 'dsh-market-off', 'dsh-on'];
  const pkgFile = path.join(dir, 'package.json');
  const patchFile = path.join(dir, 'cordis.patch.yml');
  const marketFile = path.join(dir, '.dsh-market', 'state.json');
  try {
    process.env.DSH_HOME = home;
    process.env.DSH_PROFILE = 'qa';
    fs.mkdirSync(path.dirname(marketFile), { recursive: true });
    const pkg = {
      dependencies: Object.fromEntries(names.map(name => [name, '1.0.0'])),
      dsh: { profile: { bundles: ['dsh-on', 'dsh-market-off'] } },
    };
    fs.writeFileSync(pkgFile, JSON.stringify(pkg));
    fs.writeFileSync(patchFile, '- id: dsh-on\n');
    fs.writeFileSync(marketFile, JSON.stringify({ disabled: ['dsh-market-off', 'dsh-failed-off'], other: 'preserved' }));
    const patchBefore = fs.readFileSync(patchFile, 'utf8');
    const marketBefore = fs.readFileSync(marketFile, 'utf8');
    for (const name of names) {
      const file = path.join(dir, 'node_modules', name, 'package.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ name, version: '1.0.0' }));
    }
    const bin = path.join(home, 'runtime', 'cli', 'bin', 'dsh');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '');
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: home });
    globalThis.fetch = async () => new Response(JSON.stringify({ 'dist-tags': { latest: '1.1.0' } }));
    mock.method(childProcess, 'spawn', (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      const spec = args[4];
      const name = spec.slice(0, spec.lastIndexOf('@'));
      setImmediate(() => {
        if (name === 'dsh-failed-off') {
          child.stderr.emit('data', Buffer.from('ERR_PNPM_TEST simulated failure'));
          child.emit('close', 1);
          return;
        }
        const current = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        current.dependencies[name] = '1.1.0';
        fs.writeFileSync(pkgFile, JSON.stringify(current));
        fs.writeFileSync(path.join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.1.0' }));
        child.emit('close', 0);
      });
      return child;
    });
    syncBuiltinESMExports();
    const { apply } = await import('../lib/index.js');
    let handler;
    apply({
      webServer: { register(spec) { handler = spec.handler; return () => {}; } },
      effect(fn) { disposers.push(fn()); },
    });
    assert.equal((await call(handler, 'POST', '/onekey-update/check')).status, 202);
    const available = await waitForState(handler, 'available');
    assert.equal(available.checkedCount, 4);
    assert.deepEqual(available.updates.map(item => item.name), names);
    assert.equal((await call(handler, 'POST', '/onekey-update/apply')).status, 202);
    const done = await waitForState(handler, 'done');
    assert.deepEqual(done.results.map(item => item.ok), [false, true, true, true]);
    assert.match(done.results[0].error, /simulated failure/);
    assert.deepEqual(done.updates.map(item => item.name), ['dsh-failed-off']);
    assert.deepEqual(calls, names.map(name => ({
      command: bin,
      args: ['plugin', '--profile', 'qa', 'add', name + '@1.1.0', '--config.minimum-release-age=0'],
      cwd: dir,
    })));
    assert.deepEqual(JSON.parse(fs.readFileSync(pkgFile, 'utf8')).dsh, pkg.dsh);
    assert.equal(fs.readFileSync(patchFile, 'utf8'), patchBefore);
    assert.equal(fs.readFileSync(marketFile, 'utf8'), marketBefore);
  } finally {
    disposers.forEach(dispose => dispose?.());
    mock.restoreAll();
    syncBuiltinESMExports();
    globalThis.fetch = fetchBefore;
    if (resourcesBefore) Object.defineProperty(process, 'resourcesPath', resourcesBefore);
    else delete process.resourcesPath;
    for (const [key, value] of Object.entries(envBefore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
