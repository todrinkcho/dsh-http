/**
 * @todrink/dsh-http — 给 agent 一个能发 HTTP 请求的工具。
 *
 * 一个工具 `http_request`：
 *   - 任意方法（GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS）
 *   - 自定义请求头、原始 body 或 JSON body
 *   - 超时、重定向开关、响应分段预览、大响应/二进制存盘
 *   - 只用 Node 内置能力（fetch / TextDecoder），不引第三方依赖
 *
 * 为什么要有它：蜗蜗壳儿在群里有 pwsh，但用 PowerShell 拼中文 body / JSON
 * 出过两次乱码事故（2026-11-10「???」），手写 curl 也容易被引号坑。
 * 有原生工具之后，HTTP 请求走参数，不经过 shell 的编码层。
 *
 * 安全边界：
 *   - 只允许 http/https，其他 scheme 直接拒绝
 *   - 默认拦 link-local（169.254.0.0/16，云元数据地址），可用 blockedHosts 扩展
 *   - 响应体只回预览（默认 100 KB）：超出部分截断或存盘，不塞爆上下文
 *   - 不自动带任何凭据；Authorization 等头由调用方显式传
 *
 * @module @todrink/dsh-http
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { Readable } from 'node:stream';

/** 插件身份。 */
export const name = '@todrink/dsh-http';

/** 需要宿主注入的服务。 */
export const inject = ['tools', 'systemPrompt'];

/** 系统提示段在引导带里的排序位（跟 leak-guard 的 202 邻着）。 */
const SECTION_ORDER = 203;

/** 默认值。 */
const DEFAULTS = {
  method: 'GET',
  timeoutMs: 30_000,
  maxPreviewBytes: 100_000,
  maxTimeoutMs: 180_000,
  maxPreviewCap: 5_000_000,
};

/** 允许的方法。 */
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** 面向模型的公告：有这个工具、什么时候用。 */
export const HTTP_TOOL_GUIDANCE = [
  '本机已安装 **http-tool**：提供 `http_request` 工具，可以直接发任意 HTTP(S) 请求（方法 / 请求头 / JSON 或原始 body / 超时 / 重定向），不需要经过 PowerShell 或 curl。',
  '**什么时候用**：调外部 API、查接口返回、POST 表单或 JSON、带 Authorization 头请求、下载文件或图片时。',
  '用它的理由：参数直接传给工具，不经过 shell 的编码层，**不会像 PowerShell 那样把中文变成 `???`，也不用跟引号搏斗**。',
  '用法：`http_request({ url, method, headers, json | body, timeout_ms, save_to })`。返回 `status` / `headers` / `bodyPreview`；非 2xx 也正常返回（看 `ok=false`），不是错误。',
  '**大响应/二进制**（图片、音频、zip、视频）要传 `save_to` 存到绝对路径，返回体只给预览，别指望在正文里看到二进制。',
  '**安全**：不要把 Authorization、token、Cookie 的值抄进群消息或最终回答；只报状态码和结论。',
  '**中文位置**：中文放 URL 参数或 body 里都行；**不要放请求头**——HTTP 头只支持 ASCII/Latin-1，工具会当场报错。',
  '只支持 http/https；默认拦 link-local 地址（云元数据），其余地址不设限。',
].join('\n');

/**
 * 动态取 `defineTool`：宿主里有就用真的（带 schema 校验），
 * 单独跑测试时退化成恒等函数，方便脱离宿主自测核心逻辑。
 */
let defineTool = (def) => def;
try {
  const mod = await import('@deepseek-ai/dsh-tools');
  if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool;
} catch {
  /* 宿主外运行：保持恒等实现 */
}

/* ------------------------------------------------------------------ helpers */

/** 把参数里的 headers 归一成普通对象。接受对象或 JSON 字符串。 */
function normalizeHeaders(input) {
  if (input === undefined || input === null) return {};
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed === '') return {};
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('headers 不是合法 JSON，请传对象（如 {"Authorization":"Bearer x"}）');
    }
    return normalizeHeaders(parsed);
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('headers 必须是对象');
  }
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`header「${key}」的值只能是字符串/数字/布尔`);
    }
    // HTTP 头按规范只能放 ASCII/Latin-1：中文在这里会变成乱码或被 fetch 直接拒，
    // 与其让模型猜，不如明确报错并指路。
    if (!isLatin1(key)) {
      throw new Error(`header 名「${key}」含非 ASCII 字符，HTTP 头名只能是 ASCII`);
    }
    if (!isLatin1(String(value))) {
      throw new Error(`header「${key}」的值含非 Latin-1 字符（中文等），HTTP 头放不下；把中文放 body，或先做 URL/Base64 编码`);
    }
    out[String(key)] = String(value);
  }
  return out;
}

/** 全部字符是否都在 0x00–0xFF（HTTP 头允许的范围）。 */
function isLatin1(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0xff) return false;
  }
  return true;
}

/** 从 content-type 里取 charset。 */
function charsetOf(contentType) {
  const match = /charset\s*=\s*"?([^";,\s]+)"?/i.exec(contentType || '');
  return match ? match[1].toLowerCase() : '';
}

/** 这个 content-type 是不是文本类，能不能当文本预览。 */
function isTextLike(contentType) {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  if (type === '') return true; // 没给类型：当文本试一次
  if (type.startsWith('text/')) return true;
  return (
    type.includes('json')
    || type.includes('xml')
    || type.includes('javascript')
    || type.includes('x-www-form-urlencoded')
    || type.includes('graphql')
    || type === 'application/x-yaml'
    || type === 'application/yaml'
    || type.endsWith('+json')
    || type.endsWith('+xml')
  );
}

/** 按 charset 解码；不认识的 charset 退回 utf-8，永不抛。 */
function decodeText(buffer, contentType) {
  const charset = charsetOf(contentType) || 'utf-8';
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

/** 主机名是否 link-local（云元数据地址）。 */
function isLinkLocal(hostname) {
  const host = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === '169.254.169.254' || host.startsWith('169.254.');
}

/** 字节数转人话。 */
function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 把结果压成一段可读文本（给渲染用）。 */
function summarize(value) {
  if (value.error) {
    const code = value.errorCode ? ` [${value.errorCode}]` : '';
    return [`http_request 失败${code}：${value.error}`, value.hint ? `提示：${value.hint}` : '']
      .filter(Boolean)
      .join('\n');
  }

  const head = `HTTP ${value.status} ${value.statusText || ''}`.trim()
    + `（${value.method} ${value.finalUrl || value.url}，${formatBytes(value.bytes ?? 0)}，${value.elapsedMs ?? 0} ms）`;
  const lines = [head];

  if (value.redirected) lines.push(`→ 跟随重定向到 ${value.finalUrl}`);
  if (value.savedTo) lines.push(`已存盘：${value.savedTo}`);
  if (value.binary) lines.push('响应是二进制，正文不展开；需要内容就传 save_to。');
  if (value.truncated && !value.savedTo) {
    lines.push(`正文已截断，只返回前 ${formatBytes(value.previewBytes ?? 0)}（共 ${formatBytes(value.bytes ?? 0)}）。`);
  }
  if (value.hint) lines.push(`提示：${value.hint}`);

  if (typeof value.bodyPreview === 'string' && value.bodyPreview !== '') {
    lines.push('', value.bodyPreview);
  }
  return lines.join('\n');
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 网络错误码 → 给模型看的一句话提示。 */
function hintForCode(code, url) {
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '域名解析失败：检查 URL 拼写和本机网络/DNS。';
    case 'ECONNREFUSED':
      return '目标端口拒绝连接：服务没起，或地址/端口不对。';
    case 'ECONNRESET':
      return '连接被重置：对方中途断开，可能被防火墙或 TLS 拦截。';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'ABORT_ERR':
      return '超时：调大 timeout_ms，或确认目标可达。';
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return '证书校验失败：确认目标证书，别对公网关校验。';
    default:
      return `请求没有完成：目标 ${url}`;
  }
}

/* ------------------------------------------------------------------ plugin */

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ announceToAgent?: boolean, enabled?: boolean, blockedHosts?: string[], defaultTimeoutMs?: number, maxPreviewBytes?: number, allowSaveTo?: boolean }} [config]
 */
export function apply(ctx, config) {
  const cfg = config ?? {};
  if (cfg.enabled === false) return;

  const blockedHosts = Array.isArray(cfg.blockedHosts)
    ? cfg.blockedHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean)
    : [];
  const defaultTimeoutMs = clampInt(cfg.defaultTimeoutMs, 1_000, DEFAULTS.maxTimeoutMs, DEFAULTS.timeoutMs);
  const defaultPreviewBytes = clampInt(cfg.maxPreviewBytes, 1_000, DEFAULTS.maxPreviewCap, DEFAULTS.maxPreviewBytes);
  const allowSaveTo = cfg.allowSaveTo !== false;

  const disposers = [];

  if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') {
    const definition = defineTool({
      name: 'http_request',
      description: [
        '发一个 HTTP(S) 请求，拿回状态码、响应头和正文预览。',
        '支持任意方法、自定义请求头、JSON 或原始 body、超时、重定向开关；大响应或二进制文件可用 save_to 存到本地绝对路径。',
        '不经过 shell，中文和 JSON 不会像 PowerShell 那样变乱码。',
        '非 2xx 也正常返回（ok=false），不是错误；网络层失败才返回 error/errorCode。',
        '只允许 http/https；link-local 地址（169.254.*）默认拒绝。',
        '响应正文默认只回前 100 KB 预览；要完整内容就传 save_to。',
        '示例：http_request({ url: "https://api.example.com/v1/x", method: "POST", headers: { Authorization: "Bearer ..." }, json: { a: 1 } })',
      ].join('\n'),
      timeoutMs: DEFAULTS.maxTimeoutMs + 5_000,
      parameters: {
        type: 'object',
        required: ['url'],
        properties: {
          url: {
            type: 'string',
            description: '完整 URL，必须 http:// 或 https:// 开头。',
          },
          method: {
            type: 'string',
            description: 'HTTP 方法：GET（默认）/POST/PUT/PATCH/DELETE/HEAD/OPTIONS。',
          },
          headers: {
            type: 'object',
            additionalProperties: true,
            description: '请求头对象，如 {"Authorization":"Bearer xxx","X-Request-Id":"1"}；值一律按字符串发送。',
          },
          json: {
            type: 'object',
            additionalProperties: true,
            description: 'JSON 请求体（对象）。会自动加 Content-Type: application/json；和 body 二选一。',
          },
          body: {
            type: 'string',
            description: '原始请求体字符串（表单、纯文本、JSON 数组等）。与 json 二选一。',
          },
          timeout_ms: {
            type: 'number',
            description: `超时毫秒，默认 ${DEFAULTS.timeoutMs}，上限 ${DEFAULTS.maxTimeoutMs}。`,
          },
          max_preview_bytes: {
            type: 'number',
            description: `正文预览上限字节，默认 ${DEFAULTS.maxPreviewBytes}，上限 5 MB。`,
          },
          save_to: {
            type: 'string',
            description: '把完整响应体写到这个绝对路径（下载图片/文件/大 JSON 用）。目录不存在会自动建。',
          },
          follow_redirects: {
            type: 'boolean',
            description: '是否跟随重定向，默认 true；传 false 时 3xx 原样返回。',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string' },
            method: { type: 'string' },
            status: { type: 'number' },
            statusText: { type: 'string' },
            ok: { type: 'boolean' },
            headers: { type: 'object', additionalProperties: true },
            contentType: { type: 'string' },
            bytes: { type: 'number' },
            previewBytes: { type: 'number' },
            truncated: { type: 'boolean' },
            binary: { type: 'boolean' },
            bodyPreview: { type: 'string' },
            json: { description: '解析后的 JSON 正文；不是合法 JSON 时不出现。' },
            savedTo: { type: 'string' },
            finalUrl: { type: 'string' },
            redirected: { type: 'boolean' },
            elapsedMs: { type: 'number' },
            error: { type: 'string' },
            errorCode: { type: 'string' },
            hint: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: summarize(value ?? {}) }],
      },
      async execute(args) {
        return runRequest(args ?? {}, { blockedHosts, defaultTimeoutMs, defaultPreviewBytes, allowSaveTo });
      },
    });

    disposers.push(ctx.tools.register(definition));
  }

  if (cfg.announceToAgent !== false && ctx.systemPrompt !== undefined
    && typeof ctx.systemPrompt.section === 'function') {
    disposers.push(ctx.systemPrompt.section({
      name: 'plugin:http-tool',
      order: SECTION_ORDER,
      text: HTTP_TOOL_GUIDANCE,
    }));
  }

  if (typeof ctx.effect === 'function' && disposers.length > 0) {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          /* 卸载失败不阻断其它清理 */
        }
      }
    }, '@todrink/dsh-http: teardown');
  }
}

/* --------------------------------------------------------------- execution */

/** 真正的请求逻辑。参数已归一，返回值直接进 schema。 */
async function runRequest(args, opts) {
  const startedAt = Date.now();
  const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
  const method = (typeof args.method === 'string' && args.method.trim() !== ''
    ? args.method.trim().toUpperCase()
    : DEFAULTS.method);

  const base = { url: rawUrl, method, elapsedMs: 0 };

  if (rawUrl === '') {
    return { ...base, error: '缺少 url 参数', hint: 'url 必须是完整地址，例如 https://api.example.com/v1/x' };
  }
  if (!METHODS.has(method)) {
    return { ...base, error: `不支持的方法 ${method}`, hint: `可用：${[...METHODS].join(' / ')}` };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ...base, error: 'URL 解析失败', hint: '传完整地址（含 http:// 或 https://）' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ...base, error: `只支持 http/https，收到 ${parsed.protocol.replace(':', '')}`, hint: '本地文件请用 read 工具，不要走 HTTP 工具。' };
  }

  const host = parsed.hostname.toLowerCase();
  if (isLinkLocal(host)) {
    return { ...base, error: '目标地址是 link-local（云元数据地址），已按安全策略拒绝', hint: '确实需要就改插件配置的 blockedHosts，不要绕过。' };
  }
  if (opts.blockedHosts.length > 0 && opts.blockedHosts.some((b) => host === b || host.endsWith(`.${b}`))) {
    return { ...base, error: `目标主机 ${host} 在 blockedHosts 名单里`, hint: '要放开就改插件配置。' };
  }

  let headers;
  try {
    headers = normalizeHeaders(args.headers);
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  const hasJson = args.json !== undefined && args.json !== null;
  const hasBody = typeof args.body === 'string' && args.body !== '';
  if (hasJson && hasBody) {
    return { ...base, error: 'json 和 body 只能传一个', hint: 'JSON 用 json，表单/纯文本/数组用 body。' };
  }
  let bodyText;
  if (hasJson) {
    bodyText = JSON.stringify(args.json);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }
  } else if (hasBody) {
    bodyText = args.body;
  }

  const timeoutMs = clampInt(args.timeout_ms, 1_000, DEFAULTS.maxTimeoutMs, opts.defaultTimeoutMs);
  const previewLimit = clampInt(args.max_preview_bytes, 1_000, DEFAULTS.maxPreviewCap, opts.defaultPreviewBytes);

  let saveTo = '';
  if (typeof args.save_to === 'string' && args.save_to.trim() !== '') {
    if (!opts.allowSaveTo) {
      return { ...base, error: '本插件的 save_to 被配置关掉了', hint: '需要存盘就让管理员打开 allowSaveTo。' };
    }
    saveTo = args.save_to.trim();
    if (!isAbsolute(saveTo)) {
      return { ...base, error: 'save_to 必须是绝对路径', hint: '例如 C:/Users/xxx/Downloads/a.png' };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  let res;
  try {
    res = await fetch(parsed.toString(), {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : bodyText,
      redirect: args.follow_redirects === false ? 'manual' : 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const cause = err && err.cause ? err.cause : err;
    const code = (cause && (cause.code || cause.name)) || (err && err.name) || 'UNKNOWN';
    const message = (err instanceof Error ? err.message : String(err)) || '请求失败';
    return {
      ...base,
      error: message,
      errorCode: String(code),
      hint: hintForCode(String(code), rawUrl),
      elapsedMs: Date.now() - startedAt,
    };
  }

  try {
    const respHeaders = {};
    for (const [k, v] of res.headers.entries()) respHeaders[k] = v;
    const contentType = res.headers.get('content-type') || '';
    const contentLength = Number(res.headers.get('content-length') || 0) || 0;

    const drained = res.body
      ? await drainBody(res.body, { previewLimit, saveTo, contentLength })
      : { preview: Buffer.alloc(0), bytes: 0, truncated: false };

    const textLike = isTextLike(contentType);
    const result = {
      url: rawUrl,
      method,
      status: res.status,
      statusText: res.statusText || '',
      ok: res.ok,
      headers: respHeaders,
      contentType,
      bytes: drained.bytes,
      previewBytes: drained.preview.byteLength,
      truncated: drained.truncated,
      binary: !textLike,
      finalUrl: res.url || rawUrl,
      redirected: Boolean(res.redirected),
      elapsedMs: Date.now() - startedAt,
    };
    if (saveTo) result.savedTo = saveTo;

    if (textLike) {
      const text = decodeText(drained.preview, contentType);
      result.bodyPreview = text;
      if (contentType.includes('json') && text.trim() !== '' && !drained.truncated) {
        try {
          result.json = JSON.parse(text);
        } catch {
          /* 不是合法 JSON 就只留文本 */
        }
      }
    } else {
      result.bodyPreview = '';
    }
    if (drained.truncated && !saveTo) {
      result.hint = '正文被截断：要完整内容就传 save_to，或调大 max_preview_bytes。';
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读响应体：边读边留预览。
 *   - 给了 save_to：整段落盘，预览另存。
 *   - 没给 save_to：攒够 previewLimit 就停，不再往下拉（省流量/内存）。
 */
async function drainBody(webBody, { previewLimit, saveTo, contentLength }) {
  const previewChunks = [];
  let previewBytes = 0;
  let bytes = 0;
  let truncated = false;

  let writeStream = null;
  if (saveTo) {
    await mkdir(dirname(saveTo), { recursive: true });
    writeStream = createWriteStream(saveTo);
  }

  const source = Readable.fromWeb(webBody);
  try {
    for await (const value of source) {
      const chunk = Buffer.from(value);
      bytes += chunk.byteLength;
      if (previewBytes < previewLimit) {
        const room = previewLimit - previewBytes;
        const slice = chunk.byteLength <= room ? chunk : chunk.subarray(0, room);
        previewChunks.push(slice);
        previewBytes += slice.byteLength;
      }
      if (writeStream) {
        if (!writeStream.write(chunk)) {
          await new Promise((resolve) => writeStream.once('drain', resolve));
        }
      } else if (previewBytes >= previewLimit) {
        // 没要存盘：够预览了就停，别把大响应当全文下载。
        truncated = true;
        break;
      }
    }
  } finally {
    if (writeStream) {
      await new Promise((resolve, reject) => {
        writeStream.end((err) => (err ? reject(err) : resolve()));
      });
    }
    try {
      source.destroy();
    } catch {
      /* 忽略关流失败 */
    }
  }

  return {
    preview: Buffer.concat(previewChunks),
    // 有 Content-Length 就报真实总大小（提前停止时读到的字节数会偏小）。
    bytes: contentLength > 0 ? contentLength : bytes,
    truncated,
  };
}
