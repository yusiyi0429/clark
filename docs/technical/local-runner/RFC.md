# RFC：天枢本机程序（apps/local）

v0.1 · 2026-11-06 · 第一版（Windows 先行）。决策见 ADR [0028](../../adr/0028-local-runner-single-binary-with-bun.md)（打包）、[0029](../../adr/0029-local-runner-keys-stay-on-device.md)（钥匙）、[0030](../../adr/0030-local-runner-sessions-clean-by-default.md)（会话默认干净）；接口以 `packages/contracts/src/localRunner.ts` 为准；装、卸、排错见 [runbook](../../guides/local-runner.md)。

## 0. 一句话

DRI 在天枢网页上把活派给自己电脑上的官方 Claude Code：网页直连本机程序（只监听 127.0.0.1），本机程序拉起 `claude`、把事件转给网页、替网页插话、停下、批权限；结果（状态、计划、证据、产出物、交回、花费）由本机程序单向报给天枢云端。**云端从不指挥本机。**

## 1. 范围

| 做了 | 没做（不在这次） |
|-|-|
| 本机 HTTP API 和契约；配对；Claude Code 适配器；会话、事件日志、SSE 补发；本会话 MCP；发件箱；模型配置和钥匙存储；托盘和开机自启；Windows/Mac 安装卸载脚本；测试页和冒烟命令 | 云端接收端（apps/api，另一会话）；网页界面（apps/web，另一会话）；Codex 实现（12 月，只留接口）；桌面壳；发布到任何下载源；Mac 实测 |

## 2. 组成

```
浏览器（tk.tokenkingos.com，标签页或装成应用）
   │ fetch，口令在请求头；事件流用 fetch 读 SSE
   ▼
天枢本机程序 127.0.0.1:47610（单文件 exe，托盘，开机自启）
   ├─ http/      安全检查 → 路由 → 处理；/internal/sessions/:id/mcp 给本会话 MCP
   ├─ pairing    配对（本机弹框确认）、口令（只存哈希）
   ├─ sessions   会话状态机、权限挂起、插话、停下、强停、续接
   ├─ agents/    claudeCode（stream-json 双向）、claudeSetup（检测/安装/登录）、codex（占位）
   ├─ eventLog   每会话 JSONL 事件日志，序号递增
   ├─ outbox     发件箱：落盘、退避重试、幂等键 → POST /api/local-runner/sync
   ├─ models / secrets / folders / cloud   模型配置、钥匙（DPAPI/钥匙串）、允许的文件夹、云端关联
   └─ desktop/   托盘、确认框、选文件夹框（Windows：PowerShell+WinForms；Mac：osascript）
   │ spawn（shell:false，参数数组，环境变量白名单）
   ▼
claude -p --input-format stream-json --output-format stream-json …（每张卡一个进程，各用各的模型）
```

数据目录（Windows `%LOCALAPPDATA%\Tianshu\local`，Mac `~/Library/Application Support/Tianshu/local`）：`config.json`（人改）、`settings.json`、`device.json`、`tokens.json`（口令哈希）、`secrets.json`（DPAPI 密文）、`models.json`、`folders.json`、`cloud.json`、`outbox.json`、`sessions/<id>/{session.json,events.jsonl,mcp.json}`、`topics/<topicId>/`（调研专题的工作目录）。

## 3. 安全

| 威胁 | 做法 | 测试 |
|-|-|-|
| 局域网或别的电脑来连 | 只监听 127.0.0.1 | 11/05 spike：用局域网 IP 连被拒 |
| DNS 重绑定 | `Host` 只能是 `127.0.0.1:<端口>` 或 `localhost:<端口>`，否则 421 | `security.test.ts` |
| 别的网站来调 | 必须带 `Origin` 且在白名单（默认只有 `https://tk.tokenkingos.com`，本机 `config.json` 里改，网页改不了）；不带、`null`、别的来源都 403；跨域头只回本来源，不用通配 | 同上 |
| 表单跨站提交 | `POST/PUT/PATCH` 只收 `application/json`（415）；口令在自定义请求头，HTML 表单带不了、必须过预检 | 同上 |
| 同一来源页面被注入脚本后悄悄配对 | 配对要本人在本机弹框里核对四位确认码点「是」；口令只交付一次，按来源绑定，本机只存 SHA-256 | 同上，另有托盘模式真机截图 |
| 网页指使本机读任意目录 | 允许的文件夹只能经本机系统选择框添加；开会话的 `cwd` 必须在里面（先解析符号链接）；产出物只收本会话工作目录里的文件 | `sessions.test.ts` |
| 内部 MCP 接口被网页调用 | `/internal/...` 带 `Origin` 一律 403（浏览器请求必带），另要本会话密钥（写在 `mcp.json` 文件里，不进命令行） | `security.test.ts` |
| 钥匙外泄 | 见 ADR 0029：只写不读，不进命令行，不出本机 | `sessions.test.ts`（钥匙不在 argv、不在任何响应里） |
| 别的程序伪造登录 | 子进程环境变量白名单，不继承 `ANTHROPIC_*`、`CLAUDE_*` | `sessions.test.ts`（故意注入后检查子进程环境） |

浏览器侧：Chrome 156 访问 127.0.0.1 要「本地网络访问」授权（`loopback-network`），按来源和 profile 保存，标签页和装成应用的窗口共用（附录 F）。网页要做首次授权引导；本人点过「屏蔽」后浏览器不会再弹，要引导到站点设置（应用窗口里是「⋮ → 应用信息」）改回允许。

## 4. 本机 API

契约 `packages/contracts/src/localRunner.ts`，路由表 `LOCAL_RUNNER_ROUTES`（网页客户端和本机程序共用）。要点：

- 端口默认 47610。口令头 `x-tianshu-local-token`。只有 `GET /v1/health`、`POST /v1/pairings`、`GET /v1/pairings/:id` 不要口令（仍要白名单来源）。
- 配对：网页 `POST /v1/pairings` 拿四位码 → 本机弹框 → 网页每秒轮询 `GET /v1/pairings/:id`，批准后第一次查询返回口令（只这一次），网页存本来源 localStorage。
- 事件流：`GET /v1/sessions/:id/events`，`text/event-stream`，每条 `id: <seq>` + `data: <LocalSessionEvent>`。**浏览器的 EventSource 不能带口令头，网页要用 fetch + ReadableStream 读**（测试页 `src/http/devPage.ts` 有现成写法）；断线带 `Last-Event-ID`（或 `?after=`）重连，本机从事件日志补发。15 秒一次心跳注释。
- 事件已归一化（`status`、`agent_info`、`user_message`、`assistant_text`、`tool_call`、`tool_result`、`plan`、`permission_request`、`permission_resolved`、`turn_end`、`artifact`、`handback`、`notice`），以后 Codex 也映射到这几种。
- 错误统一 `{ error: { code, message } }`，`code` 见 `LocalRunnerErrorCode`。

## 5. 拉起 Claude Code

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --permission-mode manual --permission-prompts host --permission-prompt-tool stdio
  --session-id <会话 uuid>            # 续接时换成 --resume <同一个 uuid>
  --setting-sources project,local --strict-mcp-config   # 默认干净（ADR 0030）；带个人配置时去掉
  --mcp-config <sessions/<id>/mcp.json> --allowedTools mcp__tianshu__add_artifact,…
  [--model <订阅时选的模型>] [--settings {"skipWebFetchPreflight":true,"env":{ANTHROPIC_BASE_URL,ANTHROPIC_MODEL,ANTHROPIC_SMALL_FAST_MODEL}}]
  [--disallowedTools WebSearch]        # 模型配置的 webSearch 关着时（网关默认关）
env：白名单 + DISABLE_AUTOUPDATER=1 [+ ANTHROPIC_AUTH_TOKEN、CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1（网关）]
```

- **启动**：`spawn`（`shell:false`、参数数组、`windowsHide`；Mac/Linux 自成进程组）。先发 `initialize` 控制请求，拿 `claude_code_version`，低于 `2.1.300` 拒绝（`agent_incompatible`）。可执行文件按默认安装位置找，不靠 PATH（附录 C）。
- **事件映射**：`system/init` → `agent_info`；`assistant` 的 text → `assistant_text`、tool_use → `tool_call`（`TodoWrite` 另出 `plan`）；`user` 的 tool_result → `tool_result`（只留 600 字预览）；`control_request{can_use_tool}` → `permission_request`；`control_cancel_request` → `permission_resolved(deny,已撤回)`；`result` → `turn_end`（本轮用量取 `usage`，本轮花费取 `model_usage_since_last_result`，`total_cost_usd` 是会话累计）。子代理内部步骤（带 `parent_tool_use_id`）不逐条上屏。
- **插话**：往 stdin 写一条 `user` 消息。进行中时在下一个工具步骤生效（回 `next_step`，并出一条 `notice: interjection_next_step`）；空闲时开新一轮（`new_turn`）；进程已退出时先 `--resume` 再发（`resumed`）。
- **停下**：发 `control_request{interrupt}`，约 0.2 秒结束本轮（`turn_end.errorKind = interrupted`），进程和会话保留。
- **强停**：Windows `taskkill /PID <pid> /T /F`，Mac 杀进程组；只杀本会话记下的 PID。
- **权限**：`can_use_tool` 挂起，等网页 `allow` 或 `deny`（可附一句理由，Claude 会看到）；`allowForSession` 时把 `permission_suggestions` 原样作为 `updatedPermissions` 回给它（「这张卡都允许」）。一轮结束或进程退出时，没答的请求记为拒绝。
- **登录失效**：看到 `authentication_failed`（`assistant.error` 或 `system/api_retry`）或 `api_error_status 401`，出 `notice: auth_required`，第一次就停，不等它重试十次；`result.subtype` 这时仍是 `success`，要看 `is_error`。
- **搜索没生效**：WebSearch 的 `tool_use_result.searchCount === 0` 时出 `notice: search_not_effective`（部分网关模型不支持服务端搜索，还会编结果，附录 D）。

## 6. 会话

状态：`starting → running ⇄ waiting_permission → idle → running …`；进程退出为 `exited`（正常、强停）或 `failed`（异常退出码）。本机程序重启时，上次还活着的会话一律记为 `exited`，再发一句话就 `--resume` 续上。会话 id 同时是 Claude Code 的 `--session-id`。

卡和调研专题是同一种会话，只是 `subject.kind` 不同：卡要 `cardId` 和允许文件夹里的 `cwd`；专题要 `topicId`，不给 `cwd` 时用本机程序的专用目录 `topics/<topicId>/`。

## 7. 本会话 MCP

每个会话的 `mcp.json` 配一个 HTTP MCP `tianshu`，地址 `http://127.0.0.1:<端口>/internal/sessions/<id>/mcp`，请求头带本会话密钥。工具：`add_artifact`（工作目录里的 md/html/pdf/docx/txt，≤10 MB，同名再交是新一版）、`add_evidence`（说明/日志片段/链接/改动摘要）、`submit_handback`（逐条完成标准 met/partial/unmet + 证据 + 总结）。用 HTTP 而不是 stdio，是为了不给每个会话再起一个 150 MB 的本机程序进程。真机实测：Claude Code（haiku）经 ToolSearch 找到这几个工具，调用不弹权限，产出物和交回进了发件箱。

## 8. 云端同步（本机 → 云端，单向）

- `POST {apiBaseUrl}/api/local-runner/sync`，`Authorization: Bearer <个人令牌>`，体 `LocalSyncBatchRequest`（≤50 条、≤12 MB），回 `LocalSyncBatchResponse`。
- 条目：`status`（状态变化）、`plan`（TodoWrite）、`evidence`、`artifact`（原文 base64）、`handback`、`cost`（每轮增量）。不传仓库文件、完整工具输出、环境变量、钥匙。
- 幂等键 `<deviceId>:<sessionId>:<本会话同步序号>`。云端按键去重，重复的也回 `accepted`；`rejected` 的本机记一笔后出队；回执里没提到的、网络错、5xx 都退避重试（1 s × 2^n，最长 5 分钟）。发件箱先落盘（`outbox.json`），断网、重启都不丢。
- 关联：网页 `PUT /v1/cloud` 交 `apiBaseUrl` 和令牌；`apiBaseUrl` 的来源必须在白名单里，免得被指到别处。**建议 api 会话**给个人令牌加一种 `local` 客户端（像已下线的 `collector`，只能调 `/api/local-runner/*`），网页配对后建一个这种令牌交给本机程序。

## 9. 模型

- 内置 `subscription`：用本人 Claude Code 的登录，不设任何模型环境变量。也可以加「订阅 + 指定模型」的配置（如 haiku、sonnet、opus）。
- `gateway`：Anthropic 格式地址 + 模型名 + 钥匙（TokenHub 等）；小模型（WebFetch 摘要用）不填就同主模型。几张卡同时跑、各用各的模型（11/05 实测）。
- WebFetch 走网关能用（要 `skipWebFetchPreflight`）；WebSearch 能不能用看网关背后的模型：DeepSeek v4.1 flash、Opus 能真搜，Qwen 3.8 flash 不搜还编结果（附录 D）。所以模型配置有 `webSearch` 开关：订阅默认开，网关默认关（拉起时加 `--disallowedTools WebSearch`），实测能搜的再打开。调研专题要联网时，用开了搜索的模型，或用天枢提供的搜索工具。

## 10. 托盘与开机自启

托盘图标四种状态：灰（没配对）、蓝（已连接）、绿（正在跑，提示里写「正在跑 N 张卡」）、橙（已暂停）。菜单：打开天枢 / 暂停全部（停下所有进行中的会话，不接新会话；再点是「恢复」）/ 退出（停掉所有会话进程后退出）。左键单击打开天枢。开机自启：Windows `HKCU\…\Run\TianshuLocal = "<exe>" run`；Mac LaunchAgent `com.tokenkingos.tianshu-local`（`RunAtLoad`，异常退出自动拉起）。已有一个在跑时再启动会直接退出。

## 11. 安装与卸载

`irm <下载源>/install.ps1 | iex`（Windows）、`curl -fsSL <下载源>/install.sh | sh`（Mac）：装到本人目录（不要管理员）、核对 `SHA256SUMS`、注册开机自启并启动、检查 Claude Code（没装就跑官方脚本，没登录就 `claude auth login`，浏览器里点授权）、打开天枢。下载源默认 `https://tk.tokenkingos.com/downloads/local`，可用 `TIANSHU_LOCAL_DOWNLOAD_BASE` 改；**这次没有发布**。卸载脚本装时留一份在本机，默认保留本机数据。

## 12. 以后接 Codex

`AgentAdapter.start(launch) → AgentRun{ send, interrupt, respondPermission, kill, onEvent, onExit }` 已按 Codex 也能实现的粒度定；`agents/codex.ts` 现在抛 `not_implemented`。12 月接 `codex app-server`（附录 E）：`turn/steer` 插话、`turn/interrupt` 停下、`requestApproval` 批权限（不能附理由，先 steer 一句再拒）、`thread/resume` 续接；网关只能是 Responses API；花费要按 token 自己算；干净会话要用天枢专用 `CODEX_HOME`（代价是本人在天枢里再登一次 ChatGPT）。

## 13. 测试与验证（11/06）

- 单测 24 条（`pnpm --filter @warmap/local test`）：安全 10、会话与适配器 8（假 `claude` 按 stream-json 说话，含参数、环境白名单、事件、SSE 补发、权限、插话、停下、强停、续接、本会话 MCP、钥匙不外泄、版本太旧、登录失效、Codex 未接）、发件箱 3；契约 6。故意放开环境白名单后对应用例失败（确认用例有效）。
- 真机：编出的 exe + 真 Claude Code 2.1.318（haiku），冒烟命令走完配对 → 开工 → 事件 → 3 次批准 → 插话下一步生效（b.txt 改成 22）→ 新一轮 → 停下（interrupted）→ 强停（exited），花费 $0.003；另一次验证本会话 MCP 交证据和交回。真实调用共 2 次会话（4 轮）。
- 托盘模式：配对确认框、选文件夹框、托盘图标/提示/菜单、暂停与恢复、菜单退出都在 Windows 11 上截图验证（`.scratch/local-runner/实验/截图/`）。
- 安装：用本地 exe 跑 `install.ps1`（4.4 秒装好并启动、写入自启项）；按注册表里的命令行启动成功（模拟开机，未真重启）；`uninstall.ps1` 后进程、自启项、程序、数据、端口全部清掉。

## 14. 已知问题与待定

1. **内存**：空闲约 255 MB（主程序 155 + PowerShell 托盘 100）。先把托盘换成原生小助手；再不够就评估 Node SEA（ADR 0028）。
2. **Mac 没测**：JXA 菜单栏、`osascript` 弹框、钥匙串、LaunchAgent、`install.sh` 都只按文档写了。
3. **云端接收端和令牌类型**：等 api 会话；本机这边在没关联时只排队。
4. **网页**：要做首次授权引导、配对、选文件夹、事件流（fetch 读 SSE）、批权限、插话、停下；测试页可以照抄。
5. **下载源**：服务器给 `install.ps1` 要带 `charset=utf-8`（PowerShell 5.1 默认按 ISO-8859-1 解码，中文会乱）；Windows 签名、Mac 公证没做。
6. **Claude Code 安装**：官方脚本在无终端环境下能否跑完没在干净机器上测；国内网络可能连不上 `downloads.claude.ai`。
7. **合规**：「我们的程序替本人拉起官方 CLI、用本人订阅」算不算条款允许的用法，请法务确认；Codex app-server 登录方式文档写着不允许用于商业或托管服务。

---

## 附录：实验结论（原始报告在 `.scratch/local-runner/实验/`）

### A. 打包选型

结论：Bun `--compile`（ADR 0028）。证据：三种都在 Windows 11 上做了最小原型——Bun 原型（托盘 + HTTP/SSE + HKCU Run + TypeBox 校验）112 MB、约 0.2 s 起、工作集约 130–155 MB；Go 7.2 MB、89 ms、16.8 MB，但 Mac 托盘要 cgo 只能在 Mac 上编，TypeBox 不能复用；Node SEA 91.8 MB、139 ms、37.4 MB，默认弹控制台窗口，Mac 产物要重签，Node 24 没有 `--build-sea`。Bun 在 Windows 上直接编出 darwin-arm64（63 MB）和 darwin-x64（68 MB），Mach-O 带 `LC_CODE_SIGNATURE`（临时签名）。用 `irm`/`iwr`/`curl` 下载的文件实测都没有 Mark-of-the-Web。拿不准：Bun 的内存；Mac 上实际运行。托盘坑：.NET Framework 的 `Console.In.ReadLineAsync` 实际是阻塞的，会卡住界面线程导致托盘点不动，改用后台线程读 stdin。

### B. 一行命令安装

结论：可行，不要管理员。证据：Windows 上用本地 exe 跑 `install.ps1`：复制到 `%LOCALAPPDATA%\Programs\Tianshu\`、写 `HKCU\…\Run\TianshuLocal`、启动并在 4.4 秒内 `/v1/health` 通、检测到 Claude Code 已登录；结束本机程序后按注册表里的命令行启动成功；`uninstall.ps1`（带 `TIANSHU_LOCAL_PURGE=1`）后进程、自启项、程序目录、数据目录、端口都没了。坑：PowerShell 5.1 以 `-File` 跑不带 BOM 的脚本会按本机代码页（GBK）读，中文乱码，所以两个 `.ps1` 带 UTF-8 BOM；`irm | iex` 时服务器要回 `charset=utf-8`。拿不准：真重启后的自启（没重启电脑）；Mac 脚本没跑过；下载和 SHA256 校验分支没跑（没有发布）。

### C. Claude Code 检测、安装、登录

结论：能全程不碰终端。证据（隔离的 `CLAUDE_CONFIG_DIR`，没动本人登录）：`claude auth status --json` 纯本机读、不耗模型、不写文件，已登录退出码 0、未登录 1，但只说明有凭据（假 key 也显示已登录，所以必须清环境变量）；`claude auth login` 在 127.0.0.1 随机端口收回调，浏览器点授权即可，自动跳回失败时把浏览器显示的代码写进它的 stdin 也行（实测被读取）；官方安装 `irm https://claude.ai/install.ps1 | iex`，不要管理员、不再要求 Git for Windows，不支持自定义目录。原生安装默认后台自动更新，我们在子进程里设 `DISABLE_AUTOUPDATER=1`。拿不准：真实完成一次登录后的输出；Mac；无终端环境下跑官方安装脚本。

### D. 第三方模型下的 WebSearch / WebFetch

结论：WebFetch 能用，WebSearch 看模型。证据（TokenHub 真钥匙，只读不打印，真实调用 5 次）：WebFetch 在本机抓网页，再用 `ANTHROPIC_SMALL_FAST_MODEL` 的模型摘要；抓之前会连 `api.anthropic.com` 做域名检查，`skipWebFetchPreflight: true` 后不再连。WebSearch 会给网关发 Anthropic 服务端工具 `web_search_20250305`，由网关背后的厂商执行：`wangsu/deepseek-v4.1-flash` 和 `wangsu/claude-opus-5-5` 真搜到了，`aliyun/qwen3.8-flash` 没搜（`searchCount` 0）还编了结果和来源，不报错。要创峰确认：各模型对服务端搜索工具的支持，对不支持的直接报错。

### E. Codex 程序化接口

结论：12 月接 `codex app-server`（stdio JSONL，JSON-RPC 风格），五件事都原生支持（第 12 节）。证据：`codex-cli 0.159.2` 的 `--help` 和 `app-server generate-ts` 生成的协议类型；用本机假网关驱动，0 次真实调用，本人 `~/.codex` 没改。`exec --json` 不能批权限、不能插话；`mcp-server`、`proto` 已没有。按进程配网关用 `-c model_providers.x.*`，钥匙走 `env_key` 指定的环境变量。拿不准：真实 ChatGPT 订阅下的事件细节；全局 AGENTS.md 能否在不换 `CODEX_HOME` 时关掉。

### F. 装成应用（PWA）后连本机的授权

结论：和标签页一样，而且共用。证据（Chrome 156，全新 profile，真安装 PWA）：授权按来源 + profile 保存——标签页允许过，应用窗口直接 200；应用窗口里屏蔽，标签页也屏蔽；第一次就在应用窗口访问，同样弹「想要访问此设备上的其他应用和服务」，挂在标题栏「⋮」下；屏蔽后可在「⋮ → 应用信息 → 设备上的应用」改回，不用刷新。本机程序没启动时授权框照样会弹。Edge 只测了访客模式 `--app` 窗口（表现一致），真安装没测；CDP 模拟不了「点允许」。
