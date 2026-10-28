/**
 * 版本检查：读 profile 的依赖与启用状态，查 registry 的 dist-tags.latest，算出可升级项。
 *
 * 全部为纯读取，不装任何东西。apply 由 Host 负责调用官方 `dsh plugin add` 通道。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 不做自我更新。 */
export const SELF_NAMES = new Set(['dsh-onekey-update']);

/** file: / link: / git / 本地路径等非 registry 依赖，无法按版本升级。 */
export const NON_REGISTRY_SPEC = /^(?:file:|link:|portal:|workspace:|git\+|git:|github:|https?:|ssh:|\/|\.{1,2}[\\/])/i;

export const DEFAULT_REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];

/* ------------------------------------------------------------------ semver */

export function parseVersion(input) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(input ?? '').trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (nx) return -1;
    if (ny) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseVersion(left) : left;
  const b = typeof right === 'string' ? parseVersion(right) : right;
  if (!a || !b) return 0;
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** 只在前向升级时返回 true，避免把预发布版降级。 */
export function isUpgrade(installed, latest) {
  if (!parseVersion(installed) || !parseVersion(latest)) return false;
  return compareVersions(installed, latest) < 0;
}

/* ------------------------------------------------------------------ profile */

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

export function readJsonSafe(file) {
  const text = readTextSafe(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function profileDirFor(profile) {
  return path.join(dshHome(), 'profiles', profile);
}

/**
 * 已下载且已启用的候选插件。
 * @returns {{candidates: {name: string, spec: string, installed: string}[], skipped: {name: string, reason: string}[]}}
 */
export function scanProfile(profileDir) {
  const pkgPath = path.join(profileDir, 'package.json');
  const pkg = readJsonSafe(pkgPath);
  if (!pkg) throw new Error(`找不到或无法解析 profile 清单：${pkgPath}`);

  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles)
    ? pkg.dsh.profile.bundles.filter((item) => typeof item === 'string')
    : [];
  const patchText = readTextSafe(path.join(profileDir, 'cordis.patch.yml')) || '';
  const marketState = readJsonSafe(path.join(profileDir, '.dsh-market', 'state.json')) || {};
  const disabled = new Set(
    Array.isArray(marketState.disabled) ? marketState.disabled.filter((item) => typeof item === 'string') : [],
  );
  const dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};

  const candidates = [];
  const skipped = [];
  for (const [name, spec] of Object.entries(dependencies)) {
    if (SELF_NAMES.has(name)) {
      skipped.push({ name, reason: '插件自身' });
      continue;
    }
    if (!bundles.includes(name) && !patchText.includes(name)) {
      skipped.push({ name, reason: '未启用' });
      continue;
    }
    if (disabled.has(name)) {
      skipped.push({ name, reason: '已在插件页停用' });
      continue;
    }
    if (typeof spec !== 'string' || NON_REGISTRY_SPEC.test(spec)) {
      skipped.push({ name, reason: `非 registry 依赖（${String(spec)}）` });
      continue;
    }
    const installedPkg = readJsonSafe(path.join(profileDir, 'node_modules', name, 'package.json'));
    const installed = typeof installedPkg?.version === 'string' ? installedPkg.version : null;
    if (!installed) {
      skipped.push({ name, reason: '未在 node_modules 中找到' });
      continue;
    }
    candidates.push({ name, spec, installed });
  }
  return { candidates, skipped };
}

/* ----------------------------------------------------------------- registry */

/** 查询 dist-tags.latest，按顺序尝试每个 registry。 */
export async function fetchLatest(name, options = {}) {
  const registries = options.registries ?? DEFAULT_REGISTRIES;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 12_000;
  let lastError = null;
  for (const registry of registries) {
    const base = String(registry).replace(/\/+$/, '');
    const url = `${base}/${name.replace('/', '%2F')}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 600));
      try {
        const response = await fetchImpl(url, {
          headers: { accept: 'application/vnd.npm.install-v1+json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          lastError = new Error(`${new URL(base).host} HTTP ${response.status}`);
          if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
          continue;
        }
        const body = await response.json();
        const latest = body?.['dist-tags']?.latest;
        if (typeof latest !== 'string' || latest === '') throw new Error('响应缺少 dist-tags.latest');
        return { latest, registry: base };
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError || new Error('没有可用的 registry');
}

/** 检查全部候选，最多 4 个并发。 */
export async function checkAll(profileDir, options = {}) {
  const { candidates, skipped } = scanProfile(profileDir);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, candidates.length || 1));
  const results = new Array(candidates.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      const candidate = candidates[index];
      try {
        const { latest } = await fetchLatest(candidate.name, options);
        results[index] = { ...candidate, latest, updateAvailable: isUpgrade(candidate.installed, latest) };
      } catch (error) {
        results[index] = {
          ...candidate,
          latest: null,
          updateAvailable: false,
          checkError: String(error?.message || error),
        };
      }
    }
  };
  if (candidates.length > 0) {
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  const updates = results
    .filter((item) => item.updateAvailable)
    .map((item) => ({ name: item.name, from: item.installed, to: item.latest }));
  const failedChecks = results.filter((item) => item.checkError).map((item) => ({
    name: item.name,
    error: item.checkError,
  }));
  return { checked: results.length, skipped, updates, failedChecks };
}
