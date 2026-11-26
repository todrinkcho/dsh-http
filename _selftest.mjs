/**
 * http-tool 的自测：起一个本地 HTTP 服务，把工具的真实行为跑一遍。
 * 不依赖 DSH 宿主、不联网、不落盘（除了 save_to 的临时文件）。
 *
 * 跑法：node 插件/http-tool/_selftest.mjs
 * 退出码 0 = 全过。
 */

import http from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, name as pluginName } from './index.js';

let failures = 0;
let passes = 0;

function ok(cond, label, extra = '') {
  if (cond) {
    passes += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${extra ? `  → ${extra}` : ''}`);
  }
}

/* ------------------------------------------------------- fake cordis ctx */

const captured = { tools: [], promptSections: [] };
const fakeCtx = {
  tools: {
    register(def) {
      captured.tools.push(def);
      return () => {};
    },
  },
  systemPrompt: {
    section(sec) {
      captured.promptSections.push(sec);
      return () => {};
    },
  },
};

apply(fakeCtx, { announceToAgent: true });

console.log(`plugin: ${pluginName}`);
ok(captured.tools.length === 1, '注册了 1 个工具', `实际 ${captured.tools.length}`);
const tool = captured.tools[0];
ok(tool.name === 'http_request', '工具名是 http_request', tool.name);
ok(captured.promptSections.length === 1, '注册了 1 段系统提示');

const call = (args) => tool.execute(args);

/* -------------------------------------------------------------- 测试服务 */

const BIG_TEXT = 'x'.repeat(300 * 1024);
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(992, 0x41),
]);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    switch (url.pathname) {
      case '/text':
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('你好，世界 🌍');
        break;
      case '/json':
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, who: 'selftest', n: 42 }));
        break;
      case '/echo': {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          method: req.method,
          contentType: req.headers['content-type'] || '',
          auth: req.headers['authorization'] || '',
          body,
        }));
        break;
      }
      case '/404':
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not found"}');
        break;
      case '/redirect':
        res.writeHead(302, { Location: '/text' });
        res.end();
        break;
      case '/slow':
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('late');
        }, 1500);
        break;
      case '/bin':
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(PNG_BYTES.length) });
        res.end(PNG_BYTES);
        break;
      case '/big':
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(BIG_TEXT.length) });
        res.end(BIG_TEXT);
        break;
      default:
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('root');
    }
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
console.log(`server: ${baseUrl}`);

/* ------------------------------------------------------------------ cases */

try {
  // 1. GET 文本 + 中文
  let r = await call({ url: `${baseUrl}/text` });
  ok(r.status === 200 && r.ok === true, 'GET /text 200', JSON.stringify(r.status));
  ok(r.bodyPreview.includes('你好，世界'), '中文正文正确解码', JSON.stringify(r.bodyPreview));
  ok(r.binary === false, '文本不被标成二进制');
  ok(typeof r.elapsedMs === 'number' && r.elapsedMs >= 0, '有耗时');

  // 2. GET JSON
  r = await call({ url: `${baseUrl}/json` });
  ok(r.json && r.json.n === 42, 'JSON 正文解析成对象', JSON.stringify(r.json));
  ok(String(r.headers['content-type']).includes('application/json'), '响应头带 content-type');

  // 3. POST JSON body，自动带 Content-Type
  r = await call({ url: `${baseUrl}/echo`, method: 'POST', json: { 名字: '测试值', n: 1 } });
  const echoed = JSON.parse(r.bodyPreview);
  ok(echoed.method === 'POST', 'POST 方法传到服务端', echoed.method);
  ok(echoed.contentType.includes('application/json'), '自动补 Content-Type: application/json', echoed.contentType);
  ok(JSON.parse(echoed.body).名字 === '测试值', 'JSON body 中文无损', echoed.body);

  // 4. 自定义 header + 原始 body（中文）
  r = await call({
    url: `${baseUrl}/echo`,
    method: 'PUT',
    headers: { Authorization: 'Bearer test-token' },
    body: '裸中文表单体',
  });
  const echoed2 = JSON.parse(r.bodyPreview);
  ok(echoed2.auth === 'Bearer test-token', '自定义 Authorization 头传到服务端', echoed2.auth);
  ok(echoed2.body === '裸中文表单体', '原始 body 中文无损', echoed2.body);

  // 5. 非 2xx 不是错误
  r = await call({ url: `${baseUrl}/404` });
  ok(r.status === 404 && r.ok === false && !r.error, '404 正常返回且不算 error', JSON.stringify({ status: r.status, error: r.error }));

  // 6. 默认跟随重定向
  r = await call({ url: `${baseUrl}/redirect` });
  ok(r.status === 200 && r.redirected === true, '默认跟随 302', JSON.stringify({ status: r.status, redirected: r.redirected }));
  ok(r.finalUrl.endsWith('/text'), 'finalUrl 是重定向后的地址', r.finalUrl);

  // 7. follow_redirects false 时原样返回 302
  r = await call({ url: `${baseUrl}/redirect`, follow_redirects: false });
  ok(r.status === 302, 'follow_redirects=false 返回 302', JSON.stringify(r.status));

  // 8. 超时
  const t0 = Date.now();
  r = await call({ url: `${baseUrl}/slow`, timeout_ms: 300 });
  ok(Boolean(r.error), '超时返回 error', JSON.stringify({ error: r.error, code: r.errorCode }));
  ok(Date.now() - t0 < 1400, '超时在 deadline 附近生效', `${Date.now() - t0}ms`);

  // 9. 二进制不展开正文
  r = await call({ url: `${baseUrl}/bin` });
  ok(r.binary === true, 'image/png 标成二进制');
  ok(r.bodyPreview === '', '二进制不给正文预览');
  ok(r.bytes === PNG_BYTES.length, '二进制字节数正确', String(r.bytes));

  // 10. save_to 存盘
  const tmp = await mkdtemp(join(tmpdir(), 'http-tool-'));
  const savedPath = join(tmp, 'nested', 'a.png');
  r = await call({ url: `${baseUrl}/bin`, save_to: savedPath });
  const saved = await readFile(savedPath);
  const savedStat = await stat(savedPath);
  ok(r.savedTo === savedPath, '返回 savedTo', String(r.savedTo));
  ok(savedStat.size === PNG_BYTES.length, '存盘大小正确', String(savedStat.size));
  ok(saved.subarray(0, 8).equals(PNG_BYTES.subarray(0, 8)), '存盘内容与响应一致（PNG 头）');
  await rm(tmp, { recursive: true, force: true });

  // 11. 大响应截断
  r = await call({ url: `${baseUrl}/big`, max_preview_bytes: 1000 });
  ok(r.truncated === true && r.previewBytes <= 1000, '大响应截断到预览上限', JSON.stringify({ truncated: r.truncated, previewBytes: r.previewBytes }));
  ok(r.bytes === BIG_TEXT.length, '截断时仍报真实总大小', String(r.bytes));
  ok(Boolean(r.hint), '截断时给提示');

  // 12. 参数校验
  r = await call({});
  ok(Boolean(r.error) && r.error.includes('url'), '缺 url 报错', String(r.error));
  r = await call({ url: 'file:///C:/x.txt' });
  ok(Boolean(r.error) && r.error.includes('http'), '非 http(s) 拒绝', String(r.error));
  r = await call({ url: 'http://169.254.169.254/latest/meta-data' });
  ok(Boolean(r.error) && r.error.includes('link-local'), 'link-local 被拒', String(r.error));
  r = await call({ url: `${baseUrl}/text`, json: { a: 1 }, body: 'x' });
  ok(Boolean(r.error) && r.error.includes('只能传一个'), 'json 和 body 互斥', String(r.error));
  r = await call({ url: `${baseUrl}/text`, save_to: 'relative/path.txt' });
  ok(Boolean(r.error) && r.error.includes('绝对路径'), 'save_to 必须绝对路径', String(r.error));
  r = await call({ url: `${baseUrl}/text`, method: 'TRACE' });
  ok(Boolean(r.error) && r.error.includes('不支持的方法'), '拒绝未知方法', String(r.error));
  r = await call({ url: `${baseUrl}/text`, headers: { 'X-Test': '中文头' } });
  ok(Boolean(r.error) && r.error.includes('Latin-1'), '中文 header 值给出明确报错', String(r.error));
  r = await call({ url: `${baseUrl}/text`, headers: { 'X-测试': 'abc' } });
  ok(Boolean(r.error) && r.error.includes('ASCII'), '中文 header 名给出明确报错', String(r.error));

  // 13. HEAD 请求
  r = await call({ url: `${baseUrl}/text`, method: 'HEAD' });
  ok(r.status === 200 && r.bodyPreview === '', 'HEAD 返回空正文', JSON.stringify({ status: r.status, body: r.bodyPreview }));

  // 14. 渲染函数不炸
  const rendered = tool.output.render([], r);
  ok(Array.isArray(rendered) && rendered[0].type === 'text' && rendered[0].text.length > 0, 'render 产出文本');
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
