import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

function call(handler, method, url, payload) {
  return new Promise(resolve => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, { method, url, headers: { 'content-type': 'application/json', host: 'localhost' } });
    handler(req, { writeHead(status) { this.status = status; }, end(body) { resolve({ status: this.status, data: JSON.parse(body.toString()) }); } });
  });
}

test('翻译接口认证、只允许缓存中的准确版本，失败时保留原文', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onekey-translate-'));
  process.env.DSH_HOME = home; process.env.DSH_PROFILE = 'qa';
  const dir = path.join(home, 'profiles/qa');
  fs.mkdirSync(path.join(dir, 'node_modules/demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { demo: '1.0.0' }, dsh: { profile: { bundles: ['demo'] } } }));
  fs.writeFileSync(path.join(dir, 'node_modules/demo/package.json'), JSON.stringify({ version: '1.0.0', repository: 'https://github.com/example/demo' }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('edge.microsoft.com') ? [{ translations: [{ text: '修复启动问题' }] }] : String(url).includes('api.github.com') ? [{ tag_name: 'v1.1.0', body: 'Fix startup issue' }] : { 'dist-tags': { latest: '1.1.0' } }), { status: 200 });
  let handler, permitted = false, connectionAvailable = true, translatorAvailable = true, calls = 0; const disposers = [];
  const translator = { maxTextChars: 4000, resolve: request => request, translate: async () => { calls++; return '修复启动问题'; } };
  try {
    const { apply } = await import('../lib/index.js');
    apply({ webServer: { register(spec) { handler = spec.handler; return () => {}; } }, effect(fn) { disposers.push(fn()); }, get(name) { if (name === 'connection') return connectionAvailable ? { requestRejection: () => permitted ? undefined : 401 } : undefined; if (name === 'translator') return translatorAvailable ? translator : undefined; } });
    await call(handler, 'POST', '/onekey-update/check');
    let state;
    for (let i = 0; i < 100; i++) { state = (await call(handler, 'GET', '/onekey-update/status')).data; if (state.phase === 'available') break; await new Promise(r => setTimeout(r, 10)); }
    const notes = (await call(handler, 'GET', '/onekey-update/release-notes?name=demo')).data;
    assert.equal(notes.status, 'found');
    const payload = { name: 'demo', from: '1.0.0', to: '1.1.0', version: '1.1.0', hash: notes.releases[0].hash };
    assert.equal((await call(handler, 'POST', '/onekey-update/translate', payload)).status, 401);
    permitted = true;
    connectionAvailable = false;
    assert.equal((await call(handler, 'POST', '/onekey-update/translate', payload)).status, 503);
    connectionAvailable = true;
    assert.equal((await call(handler, 'POST', '/onekey-update/translate', { ...payload, hash: 'bad' })).status, 409);
    assert.equal((await call(handler, 'POST', '/onekey-update/translate', { ...payload, name: 'other' })).status, 404);
    translatorAvailable = false;
    const fallback = await call(handler, 'POST', '/onekey-update/translate', payload);
    assert.equal(fallback.status, 200, '即使未启用独立翻译插件也能翻译');
    assert.equal(fallback.data.text, '修复启动问题');
    translatorAvailable = true;
    const result = await call(handler, 'POST', '/onekey-update/translate', payload);
    assert.equal(result.status, 200); assert.equal(result.data.text, '修复启动问题'); assert.equal(calls, 1);
  } finally {
    disposers.forEach(fn => fn?.()); globalThis.fetch = originalFetch;
    delete process.env.DSH_HOME; delete process.env.DSH_PROFILE;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
