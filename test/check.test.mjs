import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkAll,
  compareVersions,
  isUpgrade,
  parseVersion,
  scanProfile,
} from '../lib/check.mjs';

test('parseVersion 解析正式版与预发布版', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion('v0.2.1-rc.3'), { major: 0, minor: 2, patch: 1, prerelease: ['rc', '3'] });
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion(''), null);
});

test('compareVersions 处理主次修订与预发布优先级', () => {
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('1.3.0', '1.2.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1, '预发布低于正式版');
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1, '数字段按数值比较');
});

test('isUpgrade 只认前向升级', () => {
  assert.equal(isUpgrade('1.2.13', '1.2.18'), true);
  assert.equal(isUpgrade('1.2.18', '1.2.13'), false);
  assert.equal(isUpgrade('0.2.1-rc.3', '0.0.1-rc.1'), false);
  assert.equal(isUpgrade(null, '1.0.0'), false);
});

test('fetchLatest 在一个 registry 失败后改用下一个', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('broken.example')) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: '2.0.0' } }) };
  };
  const { checkAll: _ } = await import('../lib/check.mjs');
  const { fetchLatest } = await import('../lib/check.mjs');
  const result = await fetchLatest('demo', {
    registries: ['https://broken.example', 'https://good.example'],
    fetchImpl,
  });
  assert.equal(result.latest, '2.0.0');
  assert.equal(result.registry, 'https://good.example');
  assert.equal(calls.length, 3, '坏源重试一次后切源');
});

test('scanProfile 跳过非 registry、未启用与自身，保留可升级候选', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onekey-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: {
          'dsh-onekey-update': '0.1.0',
          'dsh-good': '1.0.0',
          'dsh-local': 'link:/tmp/local',
          'dsh-off': '1.0.0',
        },
        dsh: { profile: { bundles: ['dsh-onekey-update', 'dsh-good', 'dsh-local'] } },
      }),
    );
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '- id: dsh-good\n');
    for (const [name, version] of [['dsh-good', '1.0.0'], ['dsh-local', '0.0.1']]) {
      fs.mkdirSync(path.join(dir, 'node_modules', name), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ version }));
    }
    const { candidates, skipped } = scanProfile(dir);
    assert.deepEqual(candidates.map((item) => item.name), ['dsh-good']);
    const reasons = Object.fromEntries(skipped.map((item) => [item.name, item.reason]));
    assert.match(reasons['dsh-onekey-update'], /自身/);
    assert.match(reasons['dsh-local'], /非 registry/);
    assert.match(reasons['dsh-off'], /未启用/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkAll 汇总可更新项与查询失败项', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onekey-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        dependencies: { 'dsh-newer': '1.0.0', 'dsh-same': '2.0.0', 'dsh-boom': '1.0.0' },
        dsh: { profile: { bundles: ['dsh-newer', 'dsh-same', 'dsh-boom'] } },
      }),
    );
    for (const [name, version] of [['dsh-newer', '1.0.0'], ['dsh-same', '2.0.0'], ['dsh-boom', '1.0.0']]) {
      fs.mkdirSync(path.join(dir, 'node_modules', name), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ version }));
    }
    const latestMap = { 'dsh-newer': '1.5.0', 'dsh-same': '2.0.0' };
    const fetchImpl = async (url) => {
      const name = decodeURIComponent(url.split('/').pop());
      const version = latestMap[name];
      if (!version) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ 'dist-tags': { latest: version } }) };
    };
    const result = await checkAll(dir, { fetchImpl, registries: ['https://registry.example'] });
    assert.equal(result.checked, 3);
    assert.deepEqual(result.updates, [{ name: 'dsh-newer', from: '1.0.0', to: '1.5.0' }]);
    assert.equal(result.failedChecks.length, 1);
    assert.equal(result.failedChecks[0].name, 'dsh-boom');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
