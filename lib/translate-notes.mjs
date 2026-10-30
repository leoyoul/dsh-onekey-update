import { randomBytes } from 'node:crypto';

const MAX_SOURCE = 20000;
const PROTECTED = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`|!?\[[^\]\n]*\]\([^\n)]*\)|https?:\/\/[^\s<>]+|\bv?\d+\.\d+\.\d+(?:-[\w.-]+)?\b/g;

/** Independent fallback for the same Bing endpoint used by DSH's translator service. */
export function createBingTranslator(fetchImpl = fetch) {
  return {
    maxTextChars: 4000,
    resolve: request => request,
    async translate(spec, signal) {
      const response = await fetchImpl('https://edge.microsoft.com/translate/translatetext?to=zh-Hans&isEnterpriseClient=false', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify([spec.text]), credentials: 'omit', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      });
      if (!response.ok || !response.body) throw new Error('Bing 翻译服务请求失败');
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) { await reader.cancel(); throw new Error('Bing 翻译响应过大'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const text = data?.[0]?.translations?.[0]?.text;
      if (typeof text !== 'string' || !text.trim()) throw new Error('Bing 翻译返回无效结果');
      return text;
    },
  };
}

/** Translate release notes without sending code, links, or version identifiers to the provider. */
export async function translateNote(source, translator, signal) {
  if (!translator || typeof translator.resolve !== 'function' || typeof translator.translate !== 'function') throw new Error('翻译服务未启用');
  if (typeof source !== 'string' || !source || source.length > MAX_SOURCE) throw new Error('日志内容无效或过长');
  const limit = Math.floor(translator.maxTextChars);
  if (!Number.isFinite(limit) || limit < 12) throw new Error('翻译服务字符上限无效');
  const nonce = randomBytes(4).toString('hex').toUpperCase();
  const marks = [];
  const masked = source.replace(PROTECTED, value => {
    const token = `DSHPROTECT${nonce}X${marks.length}END`;
    marks.push({ token, value });
    return token;
  });
  if (marks.some(({ token }) => token.length > limit)) throw new Error('翻译服务字符上限不足');
  let pos = 0, translated = '';
  const timeout = AbortSignal.timeout(60000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  while (pos < masked.length) {
    let end = Math.min(masked.length, pos + limit);
    // Never split a protected marker or a UTF-16 surrogate pair.
    for (const { token } of marks) {
      const at = masked.indexOf(token, pos);
      if (at >= pos && at < end && at + token.length > end) end = at;
    }
    if (end < masked.length && /[\uD800-\uDBFF]/.test(masked[end - 1])) end--;
    if (end <= pos) throw new Error('无法拆分日志');
    if (end < masked.length) {
      const boundary = Math.max(masked.lastIndexOf('\n', end - 1), masked.lastIndexOf(' ', end - 1));
      if (boundary > pos + Math.floor(limit / 2)) end = boundary + 1;
    }
    const chunk = masked.slice(pos, end);
    const leading = chunk.match(/^\s*/)[0], trailing = chunk.match(/\s*$/)[0];
    const core = chunk.slice(leading.length, chunk.length - trailing.length);
    if (core) {
      const spec = translator.resolve({ text: core, targetLanguage: 'zh-CN', provider: 'bing' });
      const result = await translator.translate(spec, combined);
      if (typeof result !== 'string' || !result.trim()) throw new Error('翻译服务返回空结果');
      translated += leading + result + trailing;
    } else translated += chunk;
    pos = end;
  }
  for (const { token, value } of marks) {
    if (translated.split(token).length !== 2) throw new Error('翻译服务未保留保护标记');
    translated = translated.replace(token, value);
  }
  return translated;
}
