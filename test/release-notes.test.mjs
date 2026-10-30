import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as notes from '../lib/release-notes.mjs';

const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('展示已安装版本之后到目标版本的发布说明，不包含其他版本', async () => {
  const fetchImpl = async () => response([
    { tag_name: 'v1.3.0', body: '目标版本说明', draft: false },
    { tag_name: 'v1.2.0', body: '中间版本说明', draft: false },
    { tag_name: 'v1.1.0', body: '旧版本', draft: false },
    { tag_name: 'v1.4.0', body: '未来版本', draft: false },
  ]);
  const result = await notes.fetchReleaseNotes({ repository: 'https://github.com/example/demo.git', name: 'demo', from: '1.1.0', to: '1.3.0' }, { fetchImpl });
  assert.equal(result.status, 'found');
  assert.deepEqual(result.releases.map(r => [r.version, r.body]), [['1.3.0', '目标版本说明'], ['1.2.0', '中间版本说明']]);
});

test('没有对应版本的发布说明与网络失败分别报告', async () => {
  const input = { repository: 'github:example/demo', name: 'demo', from: '1.0.0', to: '1.1.0' };
  assert.equal((await notes.fetchReleaseNotes(input, { fetchImpl: async () => response([]) })).status, 'missing');
  assert.equal((await notes.fetchReleaseNotes(input, { fetchImpl: async () => { throw new Error('offline'); } })).status, 'error');
});

test('拒绝其他主机或带路径穿越的仓库，不能访问任意地址', async () => {
  let called = false;
  for (const repository of ['https://evil.example/a/b', 'http://github.com/a/b', 'https://github.com/a/../b', 'https://github.com/a/b?x=1']) {
    const result = await notes.fetchReleaseNotes({ repository, name: 'demo', from: '1.0.0', to: '1.1.0' }, { fetchImpl: async () => { called = true; return response([]); } });
    assert.equal(result.status, 'unsupported');
  }
  assert.equal(called, false);
});

test('多包仓库只认指定包标签，不把其他包的日志当成自己的', async () => {
  const result = await notes.fetchReleaseNotes({ repository: { url: 'https://github.com/example/monorepo', directory: 'packages/demo' }, name: 'demo', from: '1.0.0', to: '1.2.0' }, { fetchImpl: async () => response([
    { tag_name: 'other@1.2.0', body: '别的包' }, { tag_name: 'demo@1.2.0', body: '本包' }, { tag_name: 'v1.1.0', body: '无归属' },
  ]) });
  assert.deepEqual(result.releases.map(r => r.body), ['本包']);
});
