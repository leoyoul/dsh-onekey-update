/**
 * Client 半：`shell.overlay` 里的原生风格通知条。
 *
 * 视觉规则：只用 DSH 主题 token（--dsw-alias-* / --dsw-radius-* / --dsw-shadow-*），
 * 随主题明暗变化；状态靠左侧竖条 + 徽标表达，不整卡换底色。
 * 只调宿主同源 HTTP 路由，不直接执行任何安装动作。
 */

window.__ModuleLoader__.load({
  // 必须与 package.json 的 name 一致。
  id: 'dsh-onekey-update',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const ROUTE = 'onekey-update';
    const POLL_MS = 2000;

    const CSS = `
.ok-card{position:fixed;right:24px;bottom:24px;z-index:2147483000;width:400px;max-width:calc(100vw - 48px);box-sizing:border-box;display:flex;gap:12px;padding:14px 16px 12px;border-radius:var(--dsw-radius-panel,16px);background:var(--dsw-alias-bg-layer-2,#1b1c22);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));box-shadow:var(--dsw-shadow-lv3,0 14px 40px rgba(0,0,0,.35));color:var(--dsw-alias-label-primary,#f2f2f5);font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;pointer-events:auto}
.ok-bar{flex:0 0 3px;align-self:stretch;border-radius:2px;background:var(--ok-tone,#3b82f6)}
.ok-body{flex:1 1 auto;min-width:0}
.ok-head{display:flex;align-items:center;gap:8px}
.ok-glyph{flex:0 0 auto;font-size:13px;font-weight:600;line-height:1;color:var(--ok-tone,#3b82f6)}
.ok-title{flex:1 1 auto;font-size:14px;font-weight:600;letter-spacing:.01em}
.ok-chip{flex:0 0 auto;padding:3px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.06));color:var(--dsw-alias-label-tertiary,rgba(235,235,240,.6));font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
.ok-list{margin-top:9px;max-height:min(45vh,360px);overflow-y:auto;overscroll-behavior:contain}
.ok-card{max-height:calc(100vh - 48px)}
.ok-entry{border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));padding:4px 0}
.ok-entry:first-child{border-top:none}
.ok-entry .ok-row{border:0}
.ok-notes-toggle{appearance:none;background:transparent;border:0;padding:2px 0;color:var(--dsw-alias-link,#60a5fa);font:inherit;font-size:12px;cursor:pointer}
.ok-notes{max-height:180px;overflow:auto;overscroll-behavior:contain;margin:5px 0;padding:8px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.06));color:var(--dsw-alias-label-secondary,rgba(235,235,240,.8));font-size:12px}
.ok-notes-body{white-space:pre-wrap;overflow-wrap:anywhere}
.ok-notes-version{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-weight:600;margin-top:8px}
.ok-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:4px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
.ok-row:first-child{border-top:none}
.ok-name{min-width:0;font-size:12.5px;color:var(--dsw-alias-label-secondary,rgba(235,235,240,.75));word-break:break-all}
.ok-mark{display:inline-block;width:12px;margin-right:2px;color:var(--ok-tone,#3b82f6)}
.ok-vers{flex:0 0 auto;font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-tertiary,rgba(235,235,240,.6));white-space:nowrap}
.ok-from{opacity:.5;text-decoration:line-through}
.ok-arrow{padding:0 4px;opacity:.6}
.ok-to{color:var(--dsw-alias-label-secondary,rgba(235,235,240,.85))}
.ok-detail{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(235,235,240,.62))}
.ok-progress{display:flex;gap:3px;margin-top:9px}
.ok-seg{flex:1 1 0;height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-4,rgba(255,255,255,.14));transition:background .2s ease}
.ok-seg[data-state="done"]{background:var(--ok-tone,#3b82f6)}
.ok-seg[data-state="active"]{background:var(--ok-tone,#3b82f6);animation:ok-pulse 1.2s ease-in-out infinite}
@keyframes ok-pulse{0%,100%{opacity:1}50%{opacity:.3}}
.ok-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.ok-btn{appearance:none;height:30px;padding:0 12px;border:1px solid transparent;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,rgba(235,235,240,.8));font-family:inherit;font-size:12.5px;font-weight:500;line-height:1;cursor:pointer;transition:background .12s ease,border-color .12s ease}
.ok-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07))}
.ok-btn:disabled{opacity:.55;cursor:default}
.ok-btn.ghost{border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.14))}
.ok-btn.primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,#3b82f6);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:600}
.ok-btn.primary:hover{background:var(--dsw-alias-button-primary-hover,#2563eb)}
@media (prefers-reduced-motion:reduce){.ok-seg[data-state="active"]{animation:none}}
`;

    function directoryBase(value) {
      let url;
      try {
        url = new URL(value === '' || value === undefined ? 'http://dsh.internal/' : value, 'http://dsh.internal/');
      } catch {
        url = new URL('http://dsh.internal/');
      }
      url.search = '';
      url.hash = '';
      if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
      return url.href;
    }

    function routeUrl(path) {
      const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : '';
      return new URL(path.replace(/^\/+/, ''), directoryBase(base)).href;
    }

    async function request(path, method, body) {
      const response = await fetch(routeUrl(`${ROUTE}/${path}`), {
        method: method || 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: 'no-store',
      });
      const result = await response.json();
      if (!response.ok && (path === 'translate' || response.status !== 409)) {
        const error = new Error(result.error || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return result;
    }

    function btn(label, onClick, variant, disabled) {
      return h(
        'button',
        {
          type: 'button',
          className: variant === 'primary' ? 'ok-btn primary' : variant === 'ghost' ? 'ok-btn ghost' : 'ok-btn',
          onClick,
          disabled: disabled === true,
        },
        label,
      );
    }

    function versionCell(item, showResult) {
      const mark = showResult ? h('span', { className: 'ok-mark' }, item.ok ? '✓' : '✗') : null;
      return h(
        'span',
        { className: 'ok-vers' },
        mark,
        h('span', { className: 'ok-from' }, item.from),
        h('span', { className: 'ok-arrow' }, '→'),
        h('span', { className: 'ok-to' }, showResult ? (item.ok ? item.installed || item.to : '失败') : item.to),
      );
    }

    /** 更新进度：插件数 ≤ 12 时分段，超过则只显示整体比例。 */
    function progressBar(progress) {
      const total = Math.max(1, Number(progress.total) || 1);
      const index = Math.max(1, Number(progress.index) || 1);
      const count = Math.min(total, 12);
      const children = [];
      for (let i = 0; i < count; i += 1) {
        const state = i + 1 < index ? 'done' : i + 1 === index ? 'active' : 'todo';
        children.push(h('span', { key: i, className: 'ok-seg', 'data-state': state }));
      }
      if (total > 12) {
        const ratio = Math.min(1, index / total);
        children.push(h('span', { key: 'fill', className: 'ok-seg', 'data-state': 'done', style: { flex: `${ratio}` } }));
      }
      return h('div', { className: 'ok-progress' }, ...children);
    }

    function Card() {
      const [status, setStatus] = useState(null);
      const [busy, setBusy] = useState(false);
      const [expanded, setExpanded] = useState(null);
      const [notes, setNotes] = useState({});
      const [translations, setTranslations] = useState({});
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        const tick = () => {
          request('status')
            .then((next) => {
              if (alive.current) setStatus(next);
            })
            .catch(() => {
              /* 下一次轮询重试 */
            });
        };
        tick();
        const timer = setInterval(tick, POLL_MS);
        return () => {
          alive.current = false;
          clearInterval(timer);
        };
      }, []);

      const act = useCallback(async (path) => {
        setBusy(true);
        try {
          const next = await request(path, 'POST');
          setStatus(next);
        } catch {
          /* 状态由轮询兜底 */
        } finally {
          setBusy(false);
        }
      }, []);

      const dismiss = useCallback(() => {
        setStatus((previous) => (previous === null ? previous : { ...previous, dismissed: true }));
        request('dismiss', 'POST').catch(() => {});
      }, []);

      const toggleNotes = async (item) => {
        const key = `${item.name}@${item.from}:${item.to}`;
        if (expanded === key) { setExpanded(null); return; }
        setExpanded(key);
        if (notes[key] && notes[key].status !== 'error' && !notes[key].stale) return;
        setNotes(previous => ({ ...previous, [key]: { status: 'loading' } }));
        try {
          const result = await request(`release-notes?name=${encodeURIComponent(item.name)}`);
          if (alive.current) setNotes(previous => ({ ...previous, [key]: result.status ? result : { status: 'error' } }));
        } catch {
          if (alive.current) setNotes(previous => ({ ...previous, [key]: { status: 'error' } }));
        }
      };

      const translationKey = (item, release) => `${item.name}@${item.from}:${item.to}:${release.version}:${release.hash}`;
      const startTranslation = async (item, release) => {
        const key = translationKey(item, release);
        setTranslations(previous => ({ ...previous, [key]: { status: 'loading' } }));
        try {
          const result = await request('translate', 'POST', { name: item.name, from: item.from, to: item.to, version: release.version, hash: release.hash });
          if (alive.current) setTranslations(previous => ({ ...previous, [key]: { status: 'done', text: result.text, show: true } }));
        } catch (error) {
          if (alive.current) {
            if (error?.status === 409) {
              const noteKey = `${item.name}@${item.from}:${item.to}`;
              setNotes(previous => ({ ...previous, [noteKey]: { ...previous[noteKey], stale: true } }));
            }
            setTranslations(previous => ({ ...previous, [key]: { status: 'error', error: String(error?.message || '翻译失败，请重试') } }));
          }
        }
      };

      if (status === null || status.dismissed === true) return null;
      const phase = status.phase;
      if (!['available', 'uptodate', 'updating', 'done', 'error'].includes(phase)) return null;

      const updates = Array.isArray(status.updates) ? status.updates : [];
      const results = Array.isArray(status.results) ? status.results : [];
      const progress = status.progress;
      const checked = status.checkedCount ?? 0;
      const skipped = status.skippedCount ?? 0;
      const okCount = results.filter((item) => item.ok).length;
      const failCount = results.length - okCount;

      let tone;
      let glyph;
      let title;
      let chip = null;
      let detail = '';
      let rows = [];
      let actions = [];
      let bar = null;

      if (phase === 'available') {
        tone = 'var(--dsw-alias-button-primary-fill,#3b82f6)';
        glyph = '↑';
        title = '发现插件新版本';
        chip = String(updates.length);
        detail = '确认后逐个升级到最新版，需要重启 DSH 生效。';
        rows = updates.map((item, index) => {
          const key = `${item.name}@${item.from}:${item.to}`;
          const open = expanded === key;
          const entry = notes[key];
          let content = null;
          if (open) {
            if (!entry || entry.status === 'loading') content = '正在获取更新日志…';
            else if (entry.status === 'missing') content = '未找到对应版本的 GitHub 发行说明。';
            else if (entry.status === 'unsupported') content = '未找到支持的 GitHub 仓库信息。';
            else if (entry.status !== 'found') content = '获取失败，请收起后重试。';
            else content = [
              !entry.targetFound ? h('div', { key: 'partial' }, '未找到目标版本说明，以下为找到的其他版本。') : null,
              entry.limited ? h('div', { key: 'limited' }, '仅检索了最近 100 个发行版，结果可能不完整。') : null,
              ...entry.releases.map((release, i) => {
                const key = translationKey(item, release);
                const translated = translations[key];
                const toggleTranslation = () => setTranslations(previous => ({ ...previous, [key]: { ...previous[key], show: !previous[key].show } }));
                const label = translated?.status === 'loading' ? '翻译中…' : translated?.status === 'done' ? (translated.show ? '查看原文' : '查看译文') : translated?.status === 'error' ? '重试翻译' : '翻译为中文（Bing）';
                return h('div', { key: `${release.version}-${i}` },
                  h('div', { className: 'ok-notes-version' },
                    h('span', null, `版本 ${release.version}`),
                    release.hash ? h('button', { type: 'button', className: 'ok-notes-toggle', disabled: translated?.status === 'loading', title: '翻译时将此版本的日志发送给 Bing', onClick: translated?.status === 'done' ? toggleTranslation : () => startTranslation(item, release) }, label) : null,
                  ),
                  translated?.status === 'error' ? h('div', { role: 'status' }, translated.error) : null,
                  h('div', { className: 'ok-notes-body' }, translated?.status === 'done' && translated.show ? translated.text : release.body),
                  release.truncated ? h('div', null, '内容过长，已截断。') : null,
                );
              }),
            ];
          }
          return h('div', { key: `${item.name}@${index}`, className: 'ok-entry' },
            h('div', { className: 'ok-row' }, h('span', { className: 'ok-name' }, item.name), versionCell(item, false)),
            h('button', { type: 'button', className: 'ok-notes-toggle', 'aria-expanded': open, onClick: () => toggleNotes(item) }, open ? '收起更新日志 ▴' : '查看更新日志 ▾'),
            open ? h('div', { className: 'ok-notes', tabIndex: 0 }, content) : null,
          );
        });
        actions = [btn('全部更新', () => act('apply'), 'primary', busy), btn('稍后提醒', dismiss, 'ghost', false)];
      } else if (phase === 'uptodate') {
        tone = 'var(--dsw-alias-state-success-primary,#34d399)';
        glyph = '✓';
        title = '全部插件都是最新版';
        chip = String(checked);
        detail = `已检查 ${checked} 个插件，都是最新版${skipped > 0 ? `；另有 ${skipped} 个未启用或本地链接，未参与检查` : ''}。`;
        actions = [btn('重新检查', () => act('check'), 'ghost', busy), btn('知道了', dismiss, 'primary', false)];
      } else if (phase === 'updating') {
        tone = 'var(--dsw-alias-button-primary-fill,#3b82f6)';
        glyph = '↻';
        title = '正在更新插件';
        chip = progress ? `${progress.index}/${progress.total}` : null;
        detail = progress ? `${progress.name}　${progress.from} → ${progress.to}` : '准备中…';
        bar = progress ? progressBar(progress) : null;
        actions = [btn('更新中…', () => {}, 'primary', true)];
      } else if (phase === 'done') {
        tone = failCount > 0 ? 'var(--dsw-alias-state-warn-primary,#fbbf24)' : 'var(--dsw-alias-state-success-primary,#34d399)';
        glyph = failCount > 0 ? '!' : '✓';
        title = failCount > 0 ? `更新完成，${failCount} 个失败` : '插件已更新';
        chip = `${okCount}/${results.length}`;
        detail = status.message || '重启 DSH 后生效。';
        rows = results.map((item, index) =>
          h(
            'div',
            { key: `${item.name}@${index}`, className: 'ok-row' },
            h('span', { className: 'ok-name' }, item.name),
            versionCell(item, true),
          ),
        );
        actions = [btn('关闭', dismiss, 'primary', false)];
      } else {
        tone = 'var(--dsw-alias-state-error-primary,#f87171)';
        glyph = '!';
        title = '插件更新未完成';
        chip = results.length > 0 ? String(failCount) : null;
        detail = status.message || status.error || '详见插件日志。';
        rows = results.map((item, index) =>
          h(
            'div',
            { key: `${item.name}@${index}`, className: 'ok-row' },
            h('span', { className: 'ok-name' }, item.name),
            versionCell(item, true),
          ),
        );
        actions = [btn('重试检查', () => act('check'), 'primary', busy), btn('关闭', dismiss, 'ghost', false)];
      }

      return h(
        'div',
        { className: 'ok-card', style: { '--ok-tone': tone }, role: 'status' },
        h('style', null, CSS),
        h('div', { className: 'ok-bar' }),
        h(
          'div',
          { className: 'ok-body' },
          h(
            'div',
            { className: 'ok-head' },
            h('span', { className: 'ok-glyph' }, glyph),
            h('span', { className: 'ok-title' }, title),
            chip === null ? null : h('span', { className: 'ok-chip' }, chip),
          ),
          rows.length > 0 ? h('div', { className: 'ok-list' }, ...rows) : null,
          bar,
          detail ? h('div', { className: 'ok-detail' }, detail) : null,
          actions.length > 0 ? h('div', { className: 'ok-actions' }, ...actions) : null,
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-onekey-update.prompt', order: 40 }, Card),
        );
      },
    };
  },
});
