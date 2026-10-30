import { compareVersions, parseVersion } from './check.mjs';

const MAX_RESPONSE = 1024 * 1024;
const MAX_BODY = 20000;

function repositoryParts(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (typeof raw !== 'string') return null;
  let value = raw.trim().replace(/^git\+/, '');
  if (value.startsWith('github:')) value = `https://github.com/${value.slice(7)}`;
  if (value.startsWith('git@github.com:')) value = `https://github.com/${value.slice(15)}`;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(value);
  if (!match || ['.', '..'].includes(match[1]) || ['.', '..'].includes(match[2])) return null;
  return { owner: match[1], repo: match[2], monorepo: Boolean(repository?.directory) };
}

async function limitedJson(response) {
  const length = Number(response.headers?.get?.('content-length'));
  if (length > MAX_RESPONSE) throw new Error('response too large');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE) throw new Error('response too large');
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error('response too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8'));
}

function versionFromTag(tag, name, monorepo) {
  if (typeof tag !== 'string') return null;
  const short = name.split('/').pop();
  let version = tag;
  const prefix = [name + '@', short + '@'].find(p => tag.startsWith(p));
  if (prefix) version = tag.slice(prefix.length);
  else if (monorepo) return null;
  version = version.replace(/^v/, '');
  return parseVersion(version) ? version : null;
}

/** Only requests GitHub's public API. Repository URLs and release bodies are untrusted. */
export async function fetchReleaseNotes({ repository, name, from, to }, options = {}) {
  const repo = repositoryParts(repository);
  if (!repo || !parseVersion(from) || !parseVersion(to) || typeof name !== 'string') return { status: 'unsupported', releases: [] };
  try {
    const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/releases?per_page=100`;
    const response = await (options.fetchImpl || fetch)(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-onekey-update' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (response.status === 404) return { status: 'missing', releases: [] };
    if (!response.ok) return { status: 'error', releases: [] };
    const data = await limitedJson(response);
    if (!Array.isArray(data)) throw new Error('invalid response');
    const releases = data.flatMap(item => {
      const version = versionFromTag(item?.tag_name, name, repo.monorepo);
      if (!version || item.draft || compareVersions(version, from) <= 0 || compareVersions(version, to) > 0 || typeof item.body !== 'string' || !item.body.trim()) return [];
      return [{ version, body: item.body.slice(0, MAX_BODY), truncated: item.body.length > MAX_BODY }];
    }).sort((a, b) => compareVersions(b.version, a.version));
    return { status: releases.length ? 'found' : 'missing', releases, limited: data.length >= 100, targetFound: releases.some(r => compareVersions(r.version, to) === 0) };
  } catch {
    return { status: 'error', releases: [] };
  }
}
