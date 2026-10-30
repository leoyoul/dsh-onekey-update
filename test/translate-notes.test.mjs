import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as service from '../lib/translate-notes.mjs';

function fakeTranslator(limit, translate) {
  return { maxTextChars: limit, resolve: request => request, translate };
}

test('按服务字符上限分段并依次合并结果', async () => {
  const seen = [];
  const translator = fakeTranslator(12, async spec => { seen.push(spec.text); return spec.text.toUpperCase(); });
  const result = await service.translateNote('alpha beta gamma delta epsilon', translator);
  assert.equal(result, 'ALPHA BETA GAMMA DELTA EPSILON');
  assert.ok(seen.length > 1 && seen.every(s => s.length <= 12));
});

test('保护代码块、内联代码、Markdown 链接和版本号', async () => {
  const source = 'Fix version 1.2.3 using `npm install` and [Docs](https://example.com/a).\n```sh\nnpm install\n```';
  const translator = fakeTranslator(4000, async spec => spec.text.replace('Fix version', '修复版本').replace('using', '使用').replace('and', '以及'));
  const result = await service.translateNote(source, translator);
  assert.match(result, /修复版本 1\.2\.3/);
  for (const piece of ['`npm install`', '[Docs](https://example.com/a)', '```sh\nnpm install\n```']) assert.ok(result.includes(piece));
});

test('翻译服务破坏占位符时不返回被破坏的译文', async () => {
  const translator = fakeTranslator(4000, async spec => spec.text.replace(/DSHPROTECT[A-F0-9]+X\d+END/g, ''));
  await assert.rejects(() => service.translateNote('use `npm install`', translator), /保护标记/);
});

test('服务缺失或翻译请求失败时保留错误供调用方处理', async () => {
  await assert.rejects(() => service.translateNote('hello', null), /翻译服务/);
  await assert.rejects(() => service.translateNote('hello', fakeTranslator(4000, async () => { throw new Error('offline'); })), /offline/);
});

test('调用方取消时传递中止信号给翻译服务', async () => {
  const controller = new AbortController();
  const translator = fakeTranslator(4000, (_spec, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const pending = service.translateNote('hello', translator, controller.signal);
  controller.abort(new Error('已取消'));
  await assert.rejects(pending, /已取消/);
});

test('直接 Bing 回退不接受无效或过大的响应', async () => {
  const invalid = service.createBingTranslator(async () => new Response(JSON.stringify([{ translations: [] }]), { status: 200 }));
  await assert.rejects(() => service.translateNote('hello', invalid), /无效结果/);
  const oversized = service.createBingTranslator(async () => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }));
  await assert.rejects(() => service.translateNote('hello', oversized), /响应过大/);
});
