import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function call(handler, method, url) {
  return new Promise(resolve => handler({ method, url }, { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, data: JSON.parse(body.toString()) }); } }));
}

test('仅允许查询当前待更新插件的日志', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onekey-notes-'));
  const originalHome = process.env.DSH_HOME, originalProfile = process.env.DSH_PROFILE, originalFetch = globalThis.fetch;
  process.env.DSH_HOME = home; process.env.DSH_PROFILE = 'qa';
  const dir = path.join(home, 'profiles/qa');
  fs.mkdirSync(path.join(dir, 'node_modules/demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { demo: '1.0.0' }, dsh: { profile: { bundles: ['demo'] } } }));
  fs.writeFileSync(path.join(dir, 'node_modules/demo/package.json'), JSON.stringify({ version: '1.0.0', repository: 'https://github.com/example/demo' }));
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('api.github.com') ? [{ tag_name: 'v1.1.0', body: '测试日志' }] : { 'dist-tags': { latest: '1.1.0' } }), { status: 200 });
  let handler; const disposers = [];
  try {
    const { apply } = await import('../lib/index.js');
    apply({ webServer: { register(spec) { handler = spec.handler; return () => {}; } }, effect(fn) { disposers.push(fn()); } });
    await call(handler, 'POST', '/onekey-update/check');
    let state;
    for (let i = 0; i < 100; i++) { state = (await call(handler, 'GET', '/onekey-update/status')).data; if (state.phase === 'available') break; await new Promise(r => setTimeout(r, 10)); }
    assert.equal(state.phase, 'available');
    assert.equal((await call(handler, 'GET', '/onekey-update/release-notes?name=other')).status, 404);
    const result = await call(handler, 'GET', '/onekey-update/release-notes?name=demo');
    assert.equal(result.status, 200);
    assert.equal(result.data.status, 'found');
    assert.equal(result.data.releases[0].body, '测试日志');
  } finally {
    disposers.forEach(fn => fn?.()); globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
    if (originalProfile === undefined) delete process.env.DSH_PROFILE; else process.env.DSH_PROFILE = originalProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
