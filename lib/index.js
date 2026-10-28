/**
 * Host 半：启动后检查已启用插件的新版本，并通过本机同源 HTTP 路由提供状态与一键更新。
 *
 * 路由（与 Web 页面同源）：
 *   GET  /onekey-update/status   当前状态
 *   POST /onekey-update/check    重新检查
 *   POST /onekey-update/apply    依次升级所有列出的插件
 *   POST /onekey-update/dismiss  本次启动不再提示
 *
 * 更新走官方 CLI 通道（`dsh plugin --profile <p> add <name>@<version>`），逐条执行，
 * 每条成功或失败都记录在 results 里，不因为一条失败就放弃其余。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkAll, dshHome, profileDirFor, readJsonSafe } from './check.mjs';

export const name = 'dsh-onekey-update';
export const inject = ['webServer'];

const ROUTE_PREFIX = '/onekey-update';
const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(dshHome(), 'onekey-update');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_FILE = path.join(DATA_DIR, 'onekey-update.log');
const CHECK_DELAY_MS = Number(process.env.DSH_ONEKEY_UPDATE_DELAY_MS || 8_000);
const ADD_TIMEOUT_MS = 5 * 60_000;

const state = {
  phase: 'idle', // idle | checking | available | uptodate | updating | done | error
  profile: process.env.DSH_PROFILE || 'desktop',
  checkedAt: null,
  checkedCount: 0,
  skippedCount: 0,
  skipped: [],
  failedChecks: [],
  updates: [],
  results: [],
  progress: null,
  dismissed: false,
  error: null,
  message: null,
};

let checkPromise = null;
let applyPromise = null;
let disposed = false;

/* --------------------------------------------------------------------- 工具 */

function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

function log(line) {
  ensureDir(DATA_DIR);
  try {
    writeFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
  } catch {
    /* ignore */
  }
}

function persist() {
  ensureDir(DATA_DIR);
  try {
    writeFileSync(STATE_FILE, `${JSON.stringify(snapshot(), null, 2)}\n`);
  } catch {
    /* ignore */
  }
}

function snapshot() {
  return {
    phase: state.phase,
    profile: state.profile,
    checkedAt: state.checkedAt,
    checkedCount: state.checkedCount,
    skippedCount: state.skippedCount,
    skipped: state.skipped,
    failedChecks: state.failedChecks,
    updates: state.updates,
    results: state.results,
    progress: state.progress,
    dismissed: state.dismissed,
    error: state.error,
    message: state.message,
  };
}

/* ---------------------------------------------------------------- 官方 CLI */

/**
 * 解析“如何调用 dsh CLI”。优先用应用自带的 CLI 可执行文件；否则退回
 * `Electron 可执行文件 + --expose-internals + desktop-host/lib/cli.js`。
 * 两条路径都不依赖 PATH 里的 `dsh`，也不需要判断 `.exe` 后缀。
 */
export function resolveLauncher() {
  const resources = process.resourcesPath;
  if (typeof resources === 'string' && resources !== '') {
    for (const binName of ['dsh', 'dsh.cmd', 'dsh.exe']) {
      const bin = path.join(resources, 'runtime', 'cli', 'bin', binName);
      if (existsSync(bin)) {
        return { command: bin, leadingArgs: [], env: {} };
      }
    }
    for (const dirName of ['app.asar', 'app']) {
      const cli = path.join(
        resources,
        dirName,
        'dsh',
        'node_modules',
        '@deepseek-ai',
        'dsh-desktop-host',
        'lib',
        'cli.js',
      );
      if (existsSync(cli)) {
        return {
          command: process.execPath,
          leadingArgs: ['--expose-internals', cli],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        };
      }
    }
  }
  return null;
}

/** 执行一条 `dsh plugin add`，返回退出码与输出尾部。 */
function runOneUpdate(launcher, profileDir, name_, version) {
  return new Promise((resolve) => {
    const args = [
      ...launcher.leadingArgs,
      'plugin',
      '--profile',
      state.profile,
      'add',
      `${name_}@${version}`,
      '--config.minimum-release-age=0',
    ];
    let child;
    try {
      child = spawn(launcher.command, args, {
        cwd: profileDir,
        env: { ...process.env, ...launcher.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, code: null, output: String(error?.message || error) });
      return;
    }
    const LIMIT = 64 * 1024;
    let output = '';
    const collect = (chunk) => {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-LIMIT);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, code: null, output: `${output}\n[超时] 超过 ${ADD_TIMEOUT_MS / 60_000} 分钟未完成` });
    }, ADD_TIMEOUT_MS);

    child.on('error', (error) => finish({ ok: false, code: null, output: `${output}\n${String(error?.message || error)}` }));
    child.on('close', (code) => finish({ ok: code === 0, code, output }));
  });
}

function installedVersion(profileDir, packageName) {
  const pkg = readJsonSafe(path.join(profileDir, 'node_modules', packageName, 'package.json'));
  return typeof pkg?.version === 'string' ? pkg.version : null;
}

/** 从 pnpm 输出里挑一行最像原因的文字，供卡片展示。 */
function summarizeFailure(output) {
  const lines = String(output || '')
    .split('\n')
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((line) => line !== '');
  const key = lines.find((line) => /ERR_|error|Failed|E404|ETARGET|denied|not found/i.test(line));
  return (key || lines[lines.length - 1] || '未知错误').slice(0, 240);
}

/* -------------------------------------------------------------- 检查与更新 */

async function runCheck() {
  if (disposed || state.phase === 'updating') return null;
  if (checkPromise) return checkPromise;
  const profileDir = profileDirFor(state.profile);
  state.phase = 'checking';
  state.error = null;
  state.results = [];
  state.progress = null;
  state.dismissed = false;
  state.message = null;
  persist();
  log(`检查开始 profile=${state.profile}`);
  checkPromise = (async () => {
    try {
      const result = await checkAll(profileDir);
      state.checkedAt = new Date().toISOString();
      state.checkedCount = result.checked;
      state.skippedCount = result.skipped.length;
      state.skipped = result.skipped;
      state.failedChecks = result.failedChecks;
      state.updates = result.updates;
      // 没有更新也给出提示，避免用户不知道检查已经跑过。
      state.phase = result.updates.length > 0 ? 'available' : 'uptodate';
      state.error = result.failedChecks.length > 0 ? `${result.failedChecks.length} 个插件查询版本失败` : null;
      log(
        `检查结束 可更新=${result.updates.length} 检查=${result.checked} 跳过=${result.skipped.length}${
          state.error ? ` 注意=${state.error}` : ''
        }`,
      );
    } catch (error) {
      state.phase = 'idle';
      state.updates = [];
      state.error = String(error?.message || error);
      log(`检查异常：${state.error}`);
    }
    persist();
    return snapshot();
  })().finally(() => {
    checkPromise = null;
  });
  return checkPromise;
}

async function runApply() {
  if (disposed || state.phase === 'updating') return null;
  if (state.updates.length === 0) return null;
  if (applyPromise) return applyPromise;

  const targets = state.updates.slice();
  const launcher = resolveLauncher();
  if (!launcher) {
    state.phase = 'error';
    state.error = '找不到 DSH CLI，无法执行更新';
    state.message = '插件更新未完成';
    log(`更新中止：${state.error}`);
    persist();
    return snapshot();
  }

  const profileDir = profileDirFor(state.profile);
  state.phase = 'updating';
  state.results = [];
  state.error = null;
  state.message = null;
  log(`用户确认更新：${targets.map((item) => `${item.name} ${item.from}->${item.to}`).join('，')}`);
  persist();

  applyPromise = (async () => {
    for (const [index, item] of targets.entries()) {
      state.progress = { index: index + 1, total: targets.length, name: item.name, from: item.from, to: item.to };
      persist();
      const outcome = await runOneUpdate(launcher, profileDir, item.name, item.to);
      const got = installedVersion(profileDir, item.name);
      const ok = outcome.ok && got === item.to;
      state.results.push({
        name: item.name,
        from: item.from,
        to: item.to,
        ok,
        installed: got,
        error: ok ? null : summarizeFailure(outcome.output),
      });
      log(
        `更新 ${index + 1}/${targets.length} ${item.name} ${item.from}->${item.to} ok=${ok}${
          ok ? '' : ` 错误=${state.results[state.results.length - 1].error}`
        }`,
      );
      persist();
    }

    const okCount = state.results.filter((item) => item.ok).length;
    const failCount = state.results.length - okCount;
    state.progress = null;
    state.updates = state.results.filter((item) => !item.ok);
    if (okCount === 0) {
      state.phase = 'error';
      state.error = `全部 ${failCount} 个更新失败`;
      state.message = '插件更新未完成，详见日志。';
    } else {
      state.phase = 'done';
      state.error = failCount > 0 ? `${failCount} 个更新失败` : null;
      state.message = `成功 ${okCount} 个${failCount > 0 ? `，失败 ${failCount} 个` : ''}。重启 DSH 后生效。`;
    }
    log(`更新结束 成功=${okCount} 失败=${failCount}`);
    persist();
    return snapshot();
  })().finally(() => {
    applyPromise = null;
  });
  return applyPromise;
}

/* ------------------------------------------------------------------ HTTP */

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function createHandler() {
  return (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.internal');
      if (!url.pathname.startsWith(ROUTE_PREFIX)) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const route = url.pathname.slice(ROUTE_PREFIX.length) || '/';
      const method = req.method ?? 'GET';
      if (method === 'GET' && route === '/status') {
        sendJson(res, 200, snapshot());
        return;
      }
      if (method === 'POST' && route === '/check') {
        runCheck().catch(() => {});
        sendJson(res, 202, snapshot());
        return;
      }
      if (method === 'POST' && route === '/apply') {
        if (state.phase === 'updating') {
          sendJson(res, 200, snapshot());
          return;
        }
        if (state.updates.length === 0) {
          sendJson(res, 409, { ...snapshot(), error: '没有可更新的插件' });
          return;
        }
        runApply().catch(() => {});
        sendJson(res, 202, snapshot());
        return;
      }
      if (method === 'POST' && route === '/dismiss') {
        state.dismissed = true;
        persist();
        sendJson(res, 200, snapshot());
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message || error) });
    }
  };
}

/* ------------------------------------------------------------------ 入口 */

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  ensureDir(DATA_DIR);
  log(`插件启动 pid=${process.pid} profile=${state.profile} electron=${process.versions.electron ?? '-'}`);
  persist();

  if (process.env.DSH_ONEKEY_UPDATE_DISABLE === '1') {
    log('已被 DSH_ONEKEY_UPDATE_DISABLE=1 关闭：本次不检查、不显示卡片');
    return;
  }
  if (!existsSync(path.join(profileDirFor(state.profile), 'package.json'))) {
    log(`找不到 profile 目录，跳过检查：${profileDirFor(state.profile)}`);
    return;
  }

  const webServer = ctx.webServer;
  if (webServer === undefined || typeof webServer.register !== 'function') {
    log('未找到 webServer 服务，不做检查也不显示卡片');
    return;
  }

  ctx.effect(() =>
    webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: createHandler() }),
  );
  ctx.effect(() => {
    const timer = setTimeout(() => {
      runCheck().catch(() => {});
    }, CHECK_DELAY_MS);
    timer.unref?.();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  });
}
