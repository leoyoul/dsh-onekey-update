import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function descendants(node) { return node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(descendants)] : []; }
function text(node) { return typeof node === 'string' ? node : node && typeof node === 'object' ? (node.children || []).map(text).join('') : ''; }

test('只在点击时翻译，在原文和译文之间切换并复用结果', async () => {
  let definition, Card, cursor = 0, calls = [];
  const values = [{ phase: 'available', updates: [{ name: 'demo', from: '1.0.0', to: '1.1.0' }] }];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], value => { values[i] = typeof value === 'function' ? value(values[i]) : value; }]; },
    useCallback: fn => fn, useEffect: () => {}, useRef: x => ({ current: x }),
  };
  const context = { window: { __ModuleLoader__: { load(d) { definition = d; } } }, URL, document: { baseURI: 'http://localhost/' }, fetch: async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => String(url).includes('/translate') ? { text: '修复启动问题' } : { status: 'found', releases: [{ version: '1.1.0', body: 'Fix startup', hash: 'abc' }], targetFound: true } }; }, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), context);
  const module = definition.factory(() => React);
  module.apply({ slots: { inject(_slot, fn) { fn(); }, register(_spec, component) { Card = component; } } });
  const render = () => { cursor = 0; return Card(); };
  const button = (tree, label) => descendants(tree).find(n => n.type === 'button' && text(n).includes(label));
  await button(render(), '查看更新日志').props.onClick();
  assert.equal(calls.length, 1); assert.match(text(render()), /Fix startup/);
  const initial = render();
  const translate = button(initial, '翻译为中文'); assert.ok(translate);
  assert.ok(text(initial).indexOf('翻译为中文') < text(initial).indexOf('Fix startup'), '翻译按钮位于日志正文之前，展开后不必滚动到底');
  await translate.props.onClick();
  let tree = render(); assert.match(text(tree), /修复启动问题/); assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].opts.body), { name: 'demo', from: '1.0.0', to: '1.1.0', version: '1.1.0', hash: 'abc' });
  button(tree, '查看原文').props.onClick(); tree = render(); assert.match(text(tree), /Fix startup/);
  button(tree, '查看译文').props.onClick(); assert.match(text(render()), /修复启动问题/); assert.equal(calls.length, 2);
});

test('翻译失败时保留原文并允许用户重试', async () => {
  let definition, Card, cursor = 0, count = 0;
  const values = [{ phase: 'available', updates: [{ name: 'demo', from: '1.0.0', to: '1.1.0' }] }];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], value => { values[i] = typeof value === 'function' ? value(values[i]) : value; }]; },
    useCallback: fn => fn, useEffect: () => {}, useRef: x => ({ current: x }),
  };
  const context = { window: { __ModuleLoader__: { load(d) { definition = d; } } }, URL, document: { baseURI: 'http://localhost/' }, fetch: async url => {
    if (!String(url).includes('/translate')) return { ok: true, json: async () => ({ status: 'found', releases: [{ version: '1.1.0', body: 'Fix startup', hash: 'abc' }], targetFound: true }) };
    count++;
    return count === 1 ? { ok: false, status: 503, json: async () => ({ error: '翻译服务未启用' }) } : { ok: true, json: async () => ({ text: '修复启动问题' }) };
  }, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), context);
  definition.factory(() => React).apply({ slots: { inject(_slot, fn) { fn(); }, register(_spec, component) { Card = component; } } });
  const render = () => { cursor = 0; return Card(); };
  const button = (tree, label) => descendants(tree).find(n => n.type === 'button' && text(n).includes(label));
  await button(render(), '查看更新日志').props.onClick();
  await button(render(), '翻译为中文').props.onClick();
  assert.match(text(render()), /Fix startup/); assert.match(text(render()), /翻译服务未启用/);
  assert.ok(text(render()).indexOf('翻译服务未启用') < text(render()).indexOf('Fix startup'), '失败原因在长日志正文之前可见');
  await button(render(), '重试翻译').props.onClick();
  assert.match(text(render()), /修复启动问题/); assert.equal(count, 2);
});
