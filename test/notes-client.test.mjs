import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function descendants(node) { return node && typeof node === 'object' ? [node, ...(node.children || []).flatMap(descendants)] : []; }
function text(node) { return typeof node === 'string' ? node : node && typeof node === 'object' ? (node.children || []).map(text).join('') : ''; }

test('点击插件的更新日志后在卡片内显示内容，并可收起', async () => {
  let definition, Card, cursor = 0;
  const values = [{ phase: 'available', updates: [{ name: 'demo', from: '1.0.0', to: '1.1.0' }] }];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], value => { values[i] = typeof value === 'function' ? value(values[i]) : value; }]; },
    useCallback: fn => fn, useEffect: () => {}, useRef: x => ({ current: x }),
  };
  const context = { window: { __ModuleLoader__: { load(d) { definition = d; } } }, URL, document: { baseURI: 'http://localhost/' }, fetch: async () => ({ ok: true, json: async () => ({ status: 'found', releases: [{ version: '1.1.0', body: '修复崩溃' }], targetFound: true }) }), setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), context);
  const module = definition.factory(() => React);
  module.apply({ slots: { inject(_slot, fn) { fn(); }, register(spec, component) { Card = component; } } });
  const render = () => { cursor = 0; return Card(); };
  let tree = render();
  const open = descendants(tree).find(n => n.type === 'button' && text(n).includes('更新日志'));
  assert.ok(open, '每个插件有查看更新日志按钮');
  await open.props.onClick();
  tree = render();
  assert.match(text(tree), /修复崩溃/);
  assert.match(text(tree), /1\.1\.0/);
  const close = descendants(tree).find(n => n.type === 'button' && text(n).includes('收起'));
  assert.ok(close);
  await close.props.onClick();
  assert.doesNotMatch(text(render()), /修复崩溃/);
});
