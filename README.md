# @todrink/dsh-http — 给 DSH agent 一个能发 HTTP 请求的工具

一个工具：**`http_request`**。让机器人（以及任何 DSH 会话）能直接发 HTTP(S) 请求，
不经过 PowerShell / curl。

## 为什么要有它

DSH 的 shell 工具本来就能发请求（`pwsh` + `Invoke-WebRequest`、`curl`），但在真实使用里会碰到两类失败：

- **编码**：把中文当命令行参数传，经过 shell 的编码层后到达服务端的已经是乱码，而且请求一旦发出就撤不回；
- **引号**：在会话正文里手写 `<at>` / JSON / 引号，嵌套层数一多就反复出错。

`http_request` 把方法、请求头、body 当**结构化参数**传，不经过 shell 的编码层，
中文和 JSON 原样到达服务端。

## 参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `url` | string | 必填，`http://` 或 `https://` |
| `method` | string | GET（默认）/ POST / PUT / PATCH / DELETE / HEAD / OPTIONS |
| `headers` | object | 请求头；**值只能是 ASCII/Latin-1**（中文报错，放 body） |
| `json` | object | JSON body，自动补 `Content-Type: application/json`；与 `body` 二选一 |
| `body` | string | 原始 body（表单、纯文本、JSON 数组等） |
| `timeout_ms` | number | 默认 30000，上限 180000 |
| `max_preview_bytes` | number | 正文预览上限，默认 100000 |
| `save_to` | string | 绝对路径，把完整响应体写出（图片 / 文件 / 大 JSON） |
| `follow_redirects` | boolean | 默认 true；false 时 3xx 原样返回 |

返回：`status` / `statusText` / `ok` / `headers` / `contentType` / `bytes` /
`bodyPreview` / `json`（合法 JSON 时）/ `truncated` / `binary` / `savedTo` /
`finalUrl` / `redirected` / `elapsedMs`；网络层失败返回 `error` + `errorCode` + `hint`。
**非 2xx 不是错误**（`ok=false`），照常返回。

## 安全边界

- 只允许 `http` / `https`，其他 scheme 直接拒。
- link-local（`169.254.*`，云元数据地址）默认拒；`blockedHosts` 可加名单。
- 不自动带任何凭据，`Authorization` 等头由调用方显式传；工具不记录请求头内容。
- 正文只回预览：没给 `save_to` 时，攒够预览上限就停止下载，不把大响应当全文拉一遍。
- 机器人侧守则仍适用：**不要把 token / Cookie 的值抄进群消息**。

## 安装状态（2026-11-14）

已作为 profile bundle 装好并**热生效**（`plugin_manager install_bundle` + `set_plugin`，不用重启）：

- profile `~/.dsh/profiles/desktop/package.json`：`dependencies["@todrink/dsh-http"] = link:…/插件/http-tool`，
  `dsh.profile.bundles` 末尾追加 `@todrink/dsh-http`
- bundle patch `cordis.patch.yml` 插入行 `id: http-tool`
- 工具在宿主注册后**对所有 agent 可见**（含 `standard` preset 的飞书/QQ 会话）

## 关掉 / 卸载

```powershell
# 临时关掉（热生效，行还留在 patch 里）
plugin_manager set_plugin target=include:http-tool enabled=false
```

```powershell
# 完全卸载
plugin_manager remove_bundle target=@todrink/dsh-http
```

手工兜底：从 `package.json` 的 `dependencies` 和 `dsh.profile.bundles` 里删掉
`@todrink/dsh-http`，再删 `node_modules/@todrink/dsh-http` junction（都在 DSH 退出后做）。

## 自测

```powershell
node 插件/http-tool/_selftest.mjs
```

起一个本地 HTTP 服务，跑 39 条用例（文本/JSON/中文 POST/请求头/404/重定向/超时/
二进制/存盘/截断/参数校验/HEAD/渲染），全过才返回 0。不联网、不写工作区外文件。

## 已知限制

- 请求头只支持 Latin-1（HTTP 规范如此），中文头值会明确报错。
- 不支持客户端证书 / 自签名证书放行（要连自签内网服务先用 pwsh 或改插件）。
- 不支持 multipart 上传（`-F` 那种）；要传文件先 `save_to`/脚本，或后续加 `form` 参数。
- 大文件必须给 `save_to`；不给只回预览（默认 100 KB）。
