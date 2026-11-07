# RFC：天枢本机程序（apps/local）

v0.1 · 2026-11-06 · 第一版（Windows 先行）。决策见 ADR [0028](../../adr/0028-local-runner-single-binary-with-bun.md)（打包）、[0029](../../adr/0029-local-runner-keys-stay-on-device.md)（钥匙）、[0030](../../adr/0030-local-runner-sessions-clean-by-default.md)（会话默认干净）、[0031](../../adr/0031-local-runner-outside-paths-flagged-not-denied.md)（越界路径）、[0032](../../adr/0032-local-runner-release-and-code-signing.md)（发布与签名，待本人定）、[0037](../../adr/0037-local-runner-roles-via-cli-flags.md)（岗位进会话）、[0038](../../adr/0038-local-runner-card-worktrees.md)（卡的工作树）；接口以 `packages/contracts/src/localRunner.ts` 为准；装、卸、排错见 [runbook](../../guides/local-runner.md)。

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
   └─ desktop/   托盘、确认框、选文件夹框（Windows：首次启动用系统自带 csc 编的 C# 小程序；Mac：osascript）
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
| 网页指使本机读任意目录 | 允许的文件夹只能经本机系统选择框添加，且不能是主目录或它的上级、`~/.claude`、本机程序数据目录（ADR 0031）；开会话的 `cwd` 必须在里面（先解析符号链接）；产出物只收本会话工作目录里的文件 | `sessions.test.ts`、`guard.test.ts` |
| 会话读写允许范围外的文件 | Claude Code 自己会把越界的读写和命令转成权限请求；本机在请求里标出越界路径（`outsidePaths`），网页标红，只能「只允许这一次」；「这张卡都允许」只在本会话内有效，不写进仓库或本人设置（ADR 0031） | `guard.test.ts` |
| 本人全局规则混进卡 | 干净会话用 `claudeMdExcludes` 排除主目录这一层的 `CLAUDE.md` 和 `.claude/`（ADR 0030） | `guard.test.ts`，假网关看上下文实测（附录 G） |
| 内部 MCP 接口被网页调用 | `/internal/...` 带 `Origin` 一律 403（浏览器请求必带），另要本会话密钥（经子进程环境变量交给 Claude Code，不落盘、不进命令行；每次拉起换新，进程退出即作废） | `security.test.ts`、`sessions.test.ts` |
| 怪请求打挂常驻进程 | 路径必须以单个 `/` 开头，否则 400；每个请求的处理都兜住异常，单个请求出错不会带走进程；发件箱发送失败也不往外抛 | `hardening.test.ts` |
| 网页改个地址就把钥匙送走 | 改网关地址不带新钥匙时旧钥匙作废；钥匙和令牌只收可见 ASCII | `sessions.test.ts` |
| 绕过暂停或已移除的文件夹 | 续接也重查暂停和允许的文件夹；网页能暂停，恢复只能在托盘里点 | `hardening.test.ts` |
| 会话里的命令拿走云端令牌 | 天枢 MCP 经本机程序转发，令牌不进 Claude Code 的环境；网关钥匙仍在它的环境里（ADR 0029 接受这个风险） | `sessions.test.ts` |
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
  --mcp-config <sessions/<id>/mcp.json> --allowedTools mcp__tianshu-session__add_artifact,…
  --settings {"skipWebFetchPreflight":true
              [,"claudeMdExcludes":["<主目录>/.claude/**","<主目录>/CLAUDE.md","<主目录>/CLAUDE.local.md"]]（干净会话）
              [,"env":{ANTHROPIC_BASE_URL,ANTHROPIC_MODEL,ANTHROPIC_DEFAULT_HAIKU_MODEL}（网关）]
              [,"ultracode":true]（「无上限」的订阅会话：多 agent）}
  [--model <配置里写的模型，没写按档位和预算模式> --effort <按档位和预算模式>]   # 订阅才传（第 6 节「三种模式和预算」）
  --append-system-prompt-file <sessions/<id>/system.md>   # 工作规矩 + 岗位（ADR 0037）
  [--agents <sessions/<id>/agents.json>]                 # 专题的挑刺子 agent
  [--plugin-dir <数据目录/plugins/tianshu-feishu>]        # 岗位要飞书时
  [--disallowedTools WebSearch]        # 模型配置的 webSearch 关着时（网关默认关，实测白名单除外）
env：白名单 + DISABLE_AUTOUPDATER=1 + TIANSHU_SESSION_SECRET（本会话 MCP 和天枢 MCP 转发共用）
     [+ ANTHROPIC_AUTH_TOKEN、CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1、CLAUDE_CODE_MAX_RETRIES=2、API_TIMEOUT_MS=40000（网关）]
```

`skipWebFetchPreflight` 每个会话都加：WebFetch 抓网页前会先把域名发给 api.anthropic.com 检查，国内网络连不上时 WebFetch 全部失败，这一步不看用哪家模型，`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 也关不掉（11/06 两次独立实测）。

- **启动**：`spawn`（`shell:false`、参数数组、`windowsHide`；Mac/Linux 自成进程组）。先发 `initialize` 控制请求，拿 `claude_code_version`，低于 `2.1.300` 拒绝（`agent_incompatible`）。可执行文件按默认安装位置找，不靠 PATH（附录 C）。
- **事件映射**：`system/init` → `agent_info`；`assistant` 的 text → `assistant_text`、tool_use → `tool_call`（`TodoWrite` 另出 `plan`）；`user` 的 tool_result → `tool_result`（只留 600 字预览）；`control_request{can_use_tool}` → `permission_request`；`control_cancel_request` → `permission_resolved(deny,已撤回)`；`result` → `turn_end`（本轮用量取 `usage`，本轮花费取 `model_usage_since_last_result`，`total_cost_usd` 是会话累计）。子代理内部步骤（带 `parent_tool_use_id`）不逐条上屏。
- **插话**：往 stdin 写一条 `user` 消息。进行中时在下一个工具步骤生效（回 `next_step`，并出一条 `notice: interjection_next_step`）；空闲时开新一轮（`new_turn`）；进程已退出时先 `--resume` 再发（`resumed`）。
- **停下**：发 `control_request{interrupt}`，约 0.2 秒结束本轮（`turn_end.errorKind = interrupted`），进程和会话保留。
- **强停**：Windows `taskkill /PID <pid> /T /F`，Mac 杀进程组；只杀本会话记下的 PID。
- **权限**：`can_use_tool` 挂起，等网页 `allow` 或 `deny`（可附一句理由，Claude 会看到）。请求里标出越界路径 `outsidePaths`（ADR 0031）：非空时网页标红，只能「只允许这一次」。「这张卡都允许」（`allowForSession`）时把 `permission_suggestions` 作为 `updatedPermissions` 回给它，`destination` 一律改成 `session`（Claude Code 给 Bash 的建议原本会写进仓库的 `.claude/settings.local.json`）。一轮结束或进程退出时，没答的请求记为拒绝。
- **登录失效**：看到 `authentication_failed`（`assistant.error` 或 `system/api_retry`）或 `api_error_status 401`，出 `notice: auth_required`，第一次就停，不等它重试十次；`result.subtype` 这时仍是 `success`，要看 `is_error`。
- **模型服务出错**：每次 `system/api_retry` 马上出 `notice: api_retry`（「连不上模型服务…正在重试（第 1/2 次）」），不等最后失败；这一轮最终出错时 `turn_end.errorKind = api`（拒连、超时没有状态码，靠这一轮重试过判断）。网关模型重试 2 次、等响应头 40 秒：回 500 或拒连约 3 秒报错，连上不回约 40 秒出第一条提示、约 2 分钟失败（附录 G）。订阅保留 Claude Code 默认（重试 10 次）。
- **搜索没生效**：WebSearch 的 `tool_use_result.searchCount === 0` 时出 `notice: search_not_effective`（部分网关模型不支持服务端搜索，还会编结果，附录 D）。
- **订阅额度用完（11/07）**：`rate_limit_event`（额度的百分比、重置时间、状态变了才来）不进事件流，交给本机记额度。用完时 Claude Code 先报 `rejected`，再补一条 `assistant`（`error: rate_limit`、`api_error: usage_limit_reached`，文字会变，不看文字），最后 `result` 是 429 的 `is_error`，也可能不交 result 直接以退出码 1 退出（claude-code#103820）；这一轮 `turn_end.errorKind = usage_limit`（只认订阅模型）。这一串没真机复现过，照社区复现和 Claude Code 程序里的字符串（主会话 11/07 的调研）。进程退出时等 stdout 读完再报退出（最多 1 秒），免得退出前最后几行丢掉。
- **网关余额不足（11/07）**：TokenHub 余额不高于钱包的终止线时回 402，正文 `Insufficient wallet balance!`（tokavi-tokenhub f31dd05 的 `exception_handler`）；Claude Code 把它记成 `billing_error`。本机认 `billing_error`、`api_error_status: 402` 或这句正文（只认网关模型），`turn_end.errorKind = balance`，会话停着等本人（`hold.reason = balance`），不重试（第 6 节）。402 那一串是照 TokenHub 源码和 Claude Code 程序里的字符串写的，没真机复现。
- **本轮花费**：只算官方模型按标价算的（`model_usage_since_last_result` 里 `costBasis: list`；没有这个字段的旧版本照算）。网关模型是 `costBasis: unknown`，Claude Code 按 Opus 价瞎算（DeepSeek 高估约 17 倍），不要，`costUsd` 为 null，真钱由本机按价目表估（第 6 节）。

## 6. 会话

状态：`starting → running ⇄ waiting_permission → idle → running …`；进程退出为 `exited`（正常、强停）或 `failed`（异常退出码）；规划员交了计划、验收员交了结论，这一轮做完自己收工，是 `done`（不先停在 idle），不占位置，说一句会续上。本机程序重启时，上次还活着的会话一律记为 `exited`，再发一句话就 `--resume` 续上。会话 id 同时是 Claude Code 的 `--session-id`。

开工请求可带 `role`（岗位）和专题的 `critics`（挑刺岗位，最多 3 个），进会话的方式见 ADR 0037；网页「说一句」带 `kind: "review"` 就是专题的评审会：本机替本人说一句，让会话同时调用挑刺子 agent、合成「分歧和建议」存成 kind = review 的一版（11/06 真跑 haiku 验证过并行和存版本）。

**同时跑的上限和队列（V2 设计 20.6，11/06）**：派活单点一次「开工」用 `POST /v1/sessions/batch` 把一批交给本机（最多 20 件，逐件给结果，开不了的那件不留记录）。同时最多跑 `maxConcurrent` 个（本机设置，默认 3，插件页可改）；占位置的是 starting、running、waiting_permission，一轮做完在等本人回复的 idle 不占。满了（或前面还有人在排）就进队，状态 `queued`（界面叫「等空位」），摘要里 `queuePosition` 是排第几；先来先跑，按进队先后（`queueOrder`，一批里同一毫秒的也分得清）。有空位就自动从队头接上：一轮做完、结束、失败、排队时取消、调大上限、托盘恢复、本机程序启动好以后都会接一次；暂停和关机时不接，暂停时也不收新开工。排着的「停下」「强停」都是取消（出队，不能再续）；排着的不能说一句。给已开工的会话说一句、续接已停下的会话不走队列（本人在网页上的直接操作），可能短暂超过上限。本机程序重启后，排着的照原样排着，刚从队里拉起、还没开始就断了的放回原位；有空位就接上，用新开（`--session-id`）不用续接。健康状态、本机状态、每一批同步载荷都带 `slots { max, running, queued }`；status 同步条目在 queued 时带 `queuePosition`，前面的走了就给还在排的每件重报新位置。计划事件和 plan 条目带 `progress`（第几步 / 共几步）。假 claude 测顺序、让位、取消、调上限、暂停、重启（`test/queue.test.ts`），真跑 haiku：上限 1、同时开 2 件，第 2 件排第 1，第 1 件这一轮做完马上接上（`.scratch/local-runner/实验/K_排队真跑结果.json`，两件共约 $0.002）。

卡和调研专题是同一种会话，只是 `subject.kind` 不同：卡要 `cardId` 和允许文件夹里的 `cwd`；专题要 `topicId`，不给 `cwd` 时用本机程序的专用目录 `topics/<topicId>/`。

**执行方问本人（11/07）**：Claude Code 的「问用户」（AskUserQuestion）以前走权限请求，网页上只看到「要 AskUserQuestion · 批准 / 拒绝」。现在本机把它拦下来：事件 `question`（问题、标题、选项和说明、能不能多选，照它给的原样），会话转成 `idle`（等你回复，不占位置），摘要带 `pendingQuestion`。网页 `POST /v1/sessions/:id/questions/:requestId` 回答：`choices[i]` 是第 i 个问题选中的选项，`text` 是另外写的话；本机交回给 Claude Code 时放行这一步，输入里带 `answers`（问题原文 → 回答：选项用顿号连，没选的问题用 text，都选了就把 text 接在最后一个问题后面），它当成本人的回答接着做（11/07 真跑 haiku 验证过）。事件 `question_resolved` 记下回答；这一轮停了或进程退出了就作废（choices 为 null），再答回 409。在等回答时「说一句」就是回答。停下也能停正在问的会话。

**会话里的后台任务（11/07，新首页右栏「后台任务」）**：卡和专题的会话里，Claude Code 自己开的子 agent（Agent / Task 工具）和放到后台的命令（Bash 的 `run_in_background`）报成后台任务。
- 来源：Claude Code 2.1.318 在 stream-json 里发 `system/task_started`（`task_type`：子 agent 是 `local_agent`，命令是 `local_bash`；`is_backgrounded`）、`task_updated`（`patch.status`）、`task_notification`（`completed`、`failed`、`stopped`）。11/07 用本机程序同样的参数真机抓过，记录在 `.scratch/local-runner/实验/N_后台任务协议实测.jsonl`。
- 报哪些：子 agent 都报；命令只报放到后台的（前台跑完的普通命令不报，后来移到后台的从那时起报）；Claude Code 别的任务也算 command；它内部的任务（`ambient`、`skip_transcript`）不报。
- 每项的字段：`{ id: task_id, title, kind: subagent|command, state: running|done|failed|stopped, startedAt, finishedAt, stoppable }`。`title` 取 Claude Code 给的说明（截到 200 字），没有说明时写「子 agent」或「后台命令」；不另取命令原文和子 agent 的提示词，免得整段同步到云端。
- 报到哪里：会话摘要的 `background`（最近 50 个）、事件 `background`、同步条目 `background`。每次变化都报，云端按 sessionId + id 覆盖，给 `/api/me/background?scope=session:<id>` 用。发件箱重试时可能乱序到达：云端留 key 末尾本机序号最大的那条（契约里写明了）。子 agent 跑完后被续上（SendMessage）时，Claude Code 沿用同一个 task_id，这一项会从 done 回到 running。
- 停：`POST /v1/sessions/:id/background/:itemId/stop` 发 `control_request {subtype:"stop_task"}`，会话本身不停；Claude Code 答应后这一项变成 `stopped`。云端和手机只能看，不能停（云端不指挥本机）。
- 进程退出（停下以后退出、强停、本机程序退出或没正常退出后重启）时，还在跑的后台任务都算 `stopped`。
- 子 agent 在后台跑完时，Claude Code 会自己开一轮（不经本人）：本机见到这一轮的开头（`system/init`），会话从 idle 改回 running，这一轮做完再回到 idle；正在问本人时不改。
- 后台子 agent 来要权限可能跨过主轮的结束（真机见过两者只差几十毫秒）。这一轮结束时只作废这一轮的请求；执行方还在等的（后台子 agent 的）留着。只要还有权限请求在等，会话就是 waiting_permission（正在问本人时也是）。批完回到原来的样子：在一轮里（`system/init` 到这一轮的 `result`）是 running；一轮之外（子 agent 在后台接着跑，跑完 Claude Code 自己再开一轮）或正在问本人时是 idle。子 agent 被停了，它还在等的请求作废（权限请求里的 `agent_id` 就是它的 task_id）。
- 还有后台任务在跑时：不是 git 仓库的文件夹算忙（同一文件夹的下一张卡排队，任务结束或停掉后开工）；卡不让合回（409「卡还有后台任务在跑」）。
- 测试：假 claude 照真机的形状发这些消息（`test/background.test.ts`）；真跑见第 13 节。

**规划员和验收员（V2 设计第 21 节，11/06）**：拆卡和验收不在云端跑，在本人电脑上由本机程序拉起 Claude Code。会话种类加 `plan`（规划员）和 `verify`（验收员），和执行一样占位置；排队先后是验收员 → 规划员 → 执行（卡、专题），同一档先来先跑。
- 规划员：网页开（`subject: { kind: "plan", taskId }`，第一句话是云端的拆卡交代，`role` 是规划员岗位），不给 `cwd` 时用 `plans/<taskId>/`。它用本会话工具 `propose_plan` 交计划（几步、先后、风险）和派活单草稿（每件的交代、完成标准、对约定第几条、岗位名、模型档位），经发件箱同步 `card_plan`。这一轮交了计划就收工：不停在「等你回复」，直接让 Claude Code 退出，状态 `done`（原因「计划交了」）。本人「改一改」（Task 管线）就对它说一句，本机用 `--resume` 续上原来的对话，它改完再交一次（`revision` +1），又收工。
- 验收员：网页不能开。执行方 `hand_back` 以后本机自己起（不经云端）：先排着（`subject: { kind: "verify", cardId, handbackKey }`），等交回条目被云端收下，再向云端取验收交代（`GET /api/local-runner/verify-brief?handbackKey=…`：第一句话、交回时的完成标准、验收员岗位、之前连续没过几次）。取不到（没连天枢、断网、天枢出错）就排着，不挡别人，事件流里用 `notice`（`verify_waiting`）说在等什么，发件箱送出东西（连上天枢时会先把交回送上去）、本机程序启动后、每 15 秒都会再取；云端回 404（没有这次交回）不验，409（已有结论）不用验。拿到交代后按验收员岗位的档位挑模型（和网页一样按模型名认：opus 强、sonnet 普通、haiku/flash/mini/lite 轻，认不出用默认的；没配岗位用普通档），所以可以和执行用的模型不同。它用 `submit_verdict` 逐条判（条数照交代、只交一次），经发件箱同步 `verdict`；一轮做完没交就提醒一次；交完就让 Claude Code 自己退出（`done`，原因「验收完了」），本人想问它，说一句会续上。
- 规划员、验收员只读：`--disallowedTools` 加 Edit、MultiEdit、Write、NotebookEdit、Bash、PowerShell，子 agent（Agent、Task）也不给，免得绕过。没用 Claude Code 的 plan 模式：plan 模式会让模型走「出计划、请求退出」那一套，和交结论的工具不合。
- 没过怎么办：送回改法只走云端一条路。`verdict` 同步上去，云端接收端把改法写进那次交回的记录，网页原有的自动送回按交回送一次（多个标签页也只送一次），经「说一句」送回执行会话（空闲时开新一轮，已退出时续上）；执行方改完再交回，本机再起一个验收员。连续第二次没过停在「受阻」等本人。验收会话和被验的卡的会话里各记一条 `verdict` 事件（结论、算上这次连续没过几次 `failStreak`、`blocked`、改法 `returnText`，格式和云端 `cardAcceptance.ts` 的一样），只给网页显示，网页不据它送回。
- 天枢 MCP 的 `get_task_context`（Task、约定、Mission、近期的事和决定、上一版交付物和评审，带出处；云端在做）预先放行；挂不挂天枢 MCP 仍按岗位的工具名单。
- 假 claude 测三种会话的参数和排队先后、交回后自动起验收、只读、没过送回再验、第二次受阻、取不到交代时排着等、重启后照样排着（`test/planVerify.test.ts`）；真跑见第 13 节。

**卡在自己的 git 工作树里做（ADR 0038，11/06）**：同时跑几张卡时，同一个仓库里的卡不再改同一份文件。
- 开工：本人选的文件夹在 git 仓库里（在分支上、有提交），点「开工」那一刻（排队也一样）在 `<数据目录>/worktrees/<cardId>` 开工作树，新建分支 `tianshu/<卡 id 前 8 位>-<标题里的英文和数字>`（被占了加 `-2`），从主文件夹所在分支的最新提交开出来。会话摘要的 `workspace` 写明工作树、分支、`baseBranch`、`baseCommit`。主文件夹里没提交的改动、`.gitignore` 里的文件（`.env`、`node_modules`）都不带过去：开工时的 `notice`（`workspace`）说明前者，追加的系统提示词告诉执行方工作树是新的、依赖自己装。
- 交回：本机先把没提交的改动提交到卡的分支（不跑提交钩子），交回事件带 `commit`，同步条目带 `git { branch, baseBranch, baseCommit, commit }`。没过以后接着在同一个工作树里改。
- 验收：验收员在卡的工作树里只读地做，交代后面接上 `baseCommit` 到交回提交的改动（`--stat` 和补丁，补丁最多 4 万字）；结论带 `commit`。
- 自动合回（11/07，新首页设计 4.5）：本机设置「验收过就合回」（`autoMerge`，默认开，插件页改）。验收员交了「过了」、收工退出时，卡在工作树里做的，本机先查分支头还是验过的那个提交（交回以后又提交过就不合），再走下面的合回：主文件夹在 `baseBranch` 上、干净、没冲突就合（只合不推），等它的卡接着自己开始。没合成（条件不满足、关了、卡还在跑或有后台任务、交回以后又改过）就在卡的 `workspace.needsMerge` 记原因（`base_not_checked_out`、`dirty`、`conflict`、`auto_merge_off`、`not_ready`）和一句话，事件流记 `notice`（`merge_needed`），等本人合；卡又交回时它作废。自动合回成了、没合成、本人点了合并（成没成）都报一条同步条目 `merge`。
- 合回：`POST /v1/sessions/:id/merge`，本人点了就合（`git merge --no-ff`）。主文件夹不在 `baseBranch` 上、有改动（含没加进 git 的文件）、有冲突时不合，回 `merged: false` 和原因（`base_not_checked_out`、`dirty`、`conflict`）、文件，主文件夹原样不动（冲突时已 `git merge --abort`）。卡不在工作树里、卡或它的验收员还在跑、工作树里有交回以后的改动、已合回过，回 409。合成了先让还开着的进程退出，再清工作树、留分支，摘要记 `mergedCommit`，事件流里记一条 `notice`（`merged`）。
- 清理：合回后、卡没开始就取消时清工作树（分支都留着）；强停正在做的卡不清（还能续）。本机程序启动时对卡用过的仓库跑 `git worktree prune`。同一张卡再开工：上一个工作树还在就接着用，有会话在做时拒绝。
- 不是 git 仓库（或不在分支上、没有提交）：在文件夹里做（`workspace.kind = folder`），同一个文件夹同时只做一张卡，另一张占着位置时排队（状态事件的原因说明），那张一轮做完就让出来。
- 用真的临时 git 仓库测两张卡同时做、交回提交、验收员只看到这张卡的改动、合回四种结果、不是仓库时排队、清理和重启时的 prune（`test/worktree.test.ts`）。
- 工作树里不用问（11/07）：卡在自己的工作树里时，工作树里的读写、认出的路径都在工作树里而且不装东西、不联网、不推拉代码、不改系统设置的命令、天枢 MCP 里读的工具（`get_`、`list_` 开头）直接放行，不弹权限请求；碰工作树外面、装东西、联网、`git push`、`.git` 和 `.claude` 里的文件、别的工具（联网搜索、子 agent）照样问。规则只在 `pathGuard.ts` 的 `autoAllowed`。在文件夹里做的卡照旧每步都问。
- 飞书命令行（11/07）：工作树里只放行读的：快捷命令名字最后一段是读的动词（list、search、get、fetch、download 等）或以 get-、search- 开头、名字里没有写的词（send、create、update、delete 等），按资源调方法的 `<服务> <资源> list|get|search|query|mget`（正好三个词），`auth status` 等，schema、help；`--help`、`--dry-run` 只认放在最后、前面不是参数名的（引号里的不算，`--text --dry-run` 时它是要发的字）。发消息、发邮件、改文档、建日程、改表格、覆盖妙记总结（`minutes +summary`）、登录、直接调接口（`api`）、开头先写全局参数的、套在 `$( )`、反引号、`<( )` 里的照样问（反引号也挡住 PowerShell 里 ``lark`-cli`` 这种拆开的写法；宁可多问）。
- 卡的先后（11/07）：派活单的一件可以写 `after`（要等前面哪几件，位置，只能是前面的）；网页开工时把它换成 cardId 放进开工请求的 `after`。这张卡先排着（状态事件的原因「等前面的卡合回」，摘要和 status 同步条目带 `waitingFor`，少一张就重报），这时没有工作树；等的卡都在这台本机上合回以后，从主文件夹所在分支最新的提交开工作树，有空位就自己开始。等的卡在文件夹里做（没有合回）的，以它最近一次验收过了为准。等的卡取消了或一直没合回，就一直等，本人可以停掉它。合回、验收过了、本机程序启动后都会查一遍。

**订阅额度、停着等、档位、花费（11/07，新首页设计第 11 节「马上」那一批）**：
- 读额度：起一个不发提示的 Claude Code（`--no-session-persistence`，不读本人全局设置），只发 `initialize` 和 `get_usage`（`skip_behaviors: true`），读完就关；不花 token，约 0.7 秒（11/07 实测 2.1.318；它自己标的实验接口，形状可能变）。缓存 5 分钟，存在数据目录 `quota.json`（重启后还认得用完了、几点恢复）。`GET /v1/status` 读缓存，过了 5 分钟就在后台读一次（Claude Code 装了、登着时），下一次轮询就有。跑着的订阅卡报的 `rate_limit_event` 随时更新（5 小时窗口记为 `session`，7 天记为 `weekly_all`）。`quota` 每项：`plan`、`windows[{ kind: session|weekly_all|weekly_scoped, model, usedPercent, state: ok|warning|blocked, resetsAt }]`、`blockedUntil`、`extraUsage`、`updatedAt`、`error`；到 100% 算用完。邮箱、组织等账号信息不取。每批同步（心跳也是）带 `quota`：只有窗口、恢复时间、读到的时间。
- 停着等：订阅的会话一轮碰壁（`usage_limit`）或碰壁后直接退出，不算出错也不算失败。状态照常（一轮做完是 idle，退出是 exited），摘要、状态事件和 status 同步条目带 `hold { reason: "usage_limit", until }`，网页显示「等额度恢复 · HH:MM」（不知道几点恢复时 until 为 null，本机马上读一次额度）。用完时排着、本来能开始的订阅会话也不开始（带 hold）；用完时新开的订阅会话直接排着等（原因「订阅额度用完了，恢复后自动接着做」）。网关的不受影响。停着等的不占位置。只有 `api_error: usage_limit_reached` 或 rejected 的 `rate_limit_event` 才算额度用完；只有 `error: rate_limit` 的别的 429（限流）照旧算模型服务的错（`api`）。没在用的模型（`is_active: false`）的周额度满了不挡别的卡。
- 到点接着做：恢复时间过 1 分钟，本机读一次额度，没在用完的状态就接着做（看同时上限和暂停）：一轮做完停着的，往开着的进程里说一句「额度恢复了，接着把刚才没做完的做完。」（事件流记 `notice: usage_resumed`，不记成本人说的话）；进程已退出的 `--resume` 续上再说；排着的回到队里。不知道几点恢复的，5 分钟后再试（读到的额度说没用完也等：Claude Code 说碰壁、额度却说没满时，不能一直「接着做 → 又碰壁」）；没给时间的 rejected 不沿用上一次已经过了的时间。读到恢复时间推后了（比如周额度也用完了）就改 until 再等。本人说一句、停下、强停都不再等（说一句照常发，额度还没恢复就再停着等）；「暂停全部」不取消，托盘恢复以后照样到点接着做。规划员、验收员交完收工（同一轮接下来碰壁也一样）、本机关掉的进程正常退出时不再等。本机程序重启后照原来的恢复时间接着等，关机不清 hold。
- 档位：开工请求可带 `modelTier`（没有就用岗位的）。订阅按档位传 `--model` 和 `--effort`：强 opus high、标准 opus medium、轻 sonnet low（新首页设计 11.3「自动」），没说按标准；配置里写了模型名的用它的模型，思考强度照档位。网关只用配置的模型，不传思考强度。以前订阅不传 `--model`，每一档都跑账号默认的 Opus。
- 花费：`cost` 条目带 `source`（subscription / gateway）、`model`（这一轮用得最多的模型 id）、`money`。订阅照旧按标价算 `costUsd`（不是另花的钱，云端按来源显示），`money` 为 null。网关的 `costUsd` 为 null，`money` 由本机按 TokenHub 价目表估：`GET <网关主机>/api/tokavi/v1/model/prices?model_name=…`，带本机存的钥匙（`x-api-key`），缓存 1 小时，读不到这一轮为 null；算法照 tokavi-tokenhub f31dd05 的 `price_util.py`（按一次请求的输入长度选档，缓存读写按显式缓存价、没给就按输入价，分时段按价目表时区，参考段乘倍率），`estimated: true`：节假日按周一到周五算工作日；一轮几次请求按平均长度选档，次数按这一轮里不同的助手消息 id 数（主循环和子 agent 都算；TokenHub 上 result 的 `usage.iterations` 总是空的，助手消息里每次请求的输出数只是开头那一刻的，不能逐次算），数不出按整轮；币种照价目表不换算。价目表按配置里的模型名查（result 里的模型名就是它，可能带 `wangsu/` 这种前缀）。
- 用量来源不限几家（11/07 下午，新首页设计 14.4）：`quota` 每一项是右栏「用量」的一格：`{ id, name, kind: subscription|api_balance|daily_spend, remainingPercent, amounts, monthAmounts?, windows, resetsAt, blockedUntil, plan, extraUsage, updatedAt, error }`。订阅的 `remainingPercent` 是 100 减去用得最多的窗口（按模型分的周额度不算，除非只有它），`resetsAt` 跟着那个窗口；TokenHub 是 `daily_spend`，`amounts` 今天、`monthAmounts` 本月；别的 API（MiniMax、DeepSeek 等）是 `api_balance`，`amounts` 是余额，形状先留着，本机还没读。现在有三家：Claude（id `claude`）、Codex（id `codex`）、TokenHub（id `tokenhub:<主机>`）。同步给云端的是同样的形状，去掉计划名、额外额度、出错原因。`quota.json` 里存的照旧（旧文件认得）。
- Codex 订阅的额度（11/07 下午）：装了 Codex 时，`quota` 里多一项 Codex：起一个 `codex app-server`，握手后发 `account/rateLimits/read`（`excludeResetCreditDetails: true`）就关，不开对话、不花 token（11/07 实测 codex-cli 0.159.2 约 5 秒，Plus 计划有 5 小时和本周两个窗口）。按窗口长度认（300 分钟是 `session`，10080 分钟是 `weekly_all`），不按 primary、secondary 的顺序；Codex 不报警戒线，只有到没到 100%（或 `ordinaryUsageAllowed: false`）。缓存 5 分钟，只在内存里；没装 Codex 就不列。只显示、同步，不挡卡（Codex 还没接成执行方）。它也是实验接口，形状变了 `error` 记原因。
- TokenHub 花了多少（11/07 下午，每人一个计费账户）：配了网关模型、存了钥匙时，`quota` 里多一项 TokenHub（kind `daily_spend`）：用本机存的钥匙调 `GET <网关主机>/api/tokavi/v1/log/usage?time_start=<本月 1 日 0 点>&page_size=500`（只能查这把钥匙所在的账户，半小时一格，翻页读完），按 `pay_currency` 加 `wallet_charge`，今天的从本机今天 0 点起；这是 TokenHub 自己的数（`estimated: false`），右栏「TokenHub 今天 ¥x」用它。同一把钥匙配在几个模型上只读一次，同一个账户的几把钥匙只列一项；接口 404（不是 TokenHub）的网关不列。网页问状态时 5 分钟读一次（TokenHub 半小时一格，不用每轮都读）。账户名只用来去重，不出本机。
- 这台电脑逐项（新首页设计 14.4）：`tools` 依次是 Claude Code（照它自己报的登录，每次问状态现查；登录到期算过期）、Codex（`codex login status`，退出码 0 且写着 Logged in 算登着）、gh、飞书命令行，网页一行一行列，有一项不是 ready 就提醒。命令行工具：本机程序启动时和每 10 分钟查一次 Codex、gh（`gh auth status --json hosts` 里 github.com 的当前账号）和飞书命令行（`lark-cli auth status` 的用户身份；刷新令牌过期算过期，只有机器人身份不算登着），放在 `GET /v1/status` 的 `tools[{ kind, state: ready|not_installed|not_logged_in|expired|unknown, version, account, checkedAt }]`，不同步给云端。
**项目的文件夹（11/07 晚，新首页设计 16.6）**：
- 一个项目在这台电脑上对应一个文件夹，存在本机（`projects.json`），不报给云端。文件夹照旧只能经本机选择框加进允许列表（`POST /v1/folders/pick`），再 `PUT /v1/projects/:projectId/folder { folderId | null, name? }` 绑上或解绑；`GET /v1/projects` 列出这台电脑上记着的项目和文件夹；`GET /v1/folders` 每个文件夹带 `projects[{ projectId, name }]`（连接页看挂在哪）。名字只用来显示。文件夹从允许列表删掉后，绑着它的项目读出来就是没绑。
- 开工的 `subject` 可带 `projectId`（天枢的 project_id）。不指定 `cwd` 时：项目绑了文件夹就在那里做（卡在 git 仓库里照样开自己的工作树；专题、规划员直接在那个文件夹）；没绑时卡在本机程序数据目录的 `projects/<项目 id>/` 里做（不是 git 仓库，同一时间一张卡，前后几张卡看得到彼此留下的东西），专题、规划员照旧用各自的专用目录；不带项目又不指定目录的卡照旧 400。指定了 `cwd` 的照旧用 `cwd`。
- 上报：`subject` 在每条同步条目里都有，所以状态、花费、交回等都带 `projectId`；本机起的验收员跟着被验的卡带上。
- 项目转交（16.7）没做（第二批）。
- 测试：`test/projects.test.ts`。

**一句话带附件（11/07 下午，新首页设计 14.5）**：
- `POST /v1/sessions/:id/messages` 可带 `attachments[{ id, fileName, size, sha256 }]`（最多 20 个，带了可以不说话；B 的 334f1ade）：天枢里存着的子会话附件。本机按 id 从天枢取回（`GET <apiBaseUrl>/api/local-runner/attachments/:id`，设备令牌，只给附件主人配对的电脑），核对 sha256，存进这件的工作区：会话的工作目录（卡的工作树、专题和规划员的专用目录）里的 `.tianshu-attachments/<毫秒时间>/<文件名>`，目录里放一个只写 `*` 的 `.gitignore`，卡交回提交时不带上，也不改仓库自己的 `.gitignore`。文件名去掉路径和 Windows 不许的字符，同一句里重名的加「(2)」。
- 给执行方的那句话后面接一段「本人随这句话发来 N 个附件，已存到工作区，用 Read 打开（图片、PDF 能直接看）」和每个文件的绝对路径；在等回答时说的这句当成回答，同样带路径。事件流的 `user_message` 是本人的原话加 `attachments[{ name, path, size }]`。
- 格式照 14.5：图片 PNG、JPEG、GIF、WebP；文档 PDF、DOCX、XLSX、PPTX、CSV、TXT、MD、JSON、HTML、XML、YAML；常见代码和日志（按扩展名认）。每个不超过 30 MB。先看格式和天枢报的大小再取，格式不支持、太大回 400；没连天枢、取不到、sha256 对不上回 409，`message` 是「文件名：原因」；都是整句不发，已存的删掉，会话里记一条 `notice: attachment_failed`。
- 测试：`test/attachments.test.ts`。

**三种模式和预算（11/07 下午，新首页设计 11.3、11.4；预算的形状是 B 的契约 `budget.ts`，f567a85c）**：
- 预算从哪来：开工请求带 `taskBudget { taskId, budget }`，网页把认领回执（`POST /api/me/session-starts/claim`）里的 taskId 和 budget 原样转来；每次开工带的覆盖本机记着的那份。本机按 Task 记账（`budgets.json`）：同一件 Task 的卡、规划员算在一起，验收员随被验的卡；taskId 为 null（不挂 Task 的专题）时只管这一个会话。不带就是「自动」、不记账。
- 每张卡怎么跑（`budget.ts` 的 `runFor`，只管订阅；配置里写了模型名的用配置的；网关用配置的模型名、不传思考强度、不开多 agent）：
  - 自动：按档位（强 Opus high、标准 Opus medium、轻 Sonnet low）；额度到警戒线（Claude Code 报 `warning`，5 小时和本周所有模型的窗口）后，后面拉起的思考强度降一档。
  - 设预算：同自动；预算到 80% 后降一档（和警戒线一起也只降一档）；验收员这时用轻档。
  - 无上限：每张都是 Opus、`--effort max`，多 agent 开（`--settings` 里 `"ultracode": true`，11/07 不发提示实测订阅的 Opus 上 `ultracodeAvailable: true`）；额度（5 小时和本周所有模型里用得最多的）到 95% 起，新的一轮之前用 `apply_flag_settings { ultracode: false }` 关掉（同一处实测可关可开，下一轮生效），好在 100% 时干净停下；验收员用重档 Opus high、不开多 agent。
  - 受阻前返工几轮：自动、设预算连续 2 次没过算受阻，无上限 3 次（`verdict` 事件的 `blocked`；云端按 Task 的模式另算，见交付说明）。
  - 摘要和 `status` 同步条目带 `run { mode, model, effort, multiAgent }`：最近一次拉起时定的跑法（卡行写模型和思考强度）。跑着的进程不换模型和思考强度，只有多 agent 会变。
- 怎么算（`GET /v1/budgets` 的 `spent`）：时长只算 `starting`、`running` 的时间（排队、等额度、等你批准、等你回复都不算），本机程序重启时正跑着的那一段不算；本周额度是 `weekly_all` 从开工起涨了几个百分点（整个账号的，含本人自己同时在用的；读到的百分比往下掉就是重置了，之前涨的累加、从 0 接着算；开工时还没读到就从第一次读到算起）；钱是网关这件 Task 的每一轮按 TokenHub 价目表估的（第 6 节「花费」），只算预算的币种（没设金额时照第一笔的），不用 Claude Code 自带的金额。`ratio` 取各项「用了 ÷ 上限」里最大的。一轮做完、额度变了、有会话在跑时每 30 秒、收到新预算时重算。
- 到 80%：后面开的卡降一档，不打断；报一条 `budget` 同步条目（`state: warning`）和 `notice: budget_warning`。云端照它画「预算 80%」和「加 50%」。
- 到 100%：排着的不开始（`hold { reason: budget, until: null }`，状态原因「预算用完了，等你加预算」）；跑着的（`starting`、`running`、`waiting_permission`，或一轮还没完）往里说一句「这件 Task 的预算用完了：把手上这一步做完就停下，列出还没做完的，不要再开新的步骤。」，这一轮做完就停着等（idle + hold budget），3 分钟还没做完就打断（`interrupt`，会话留着）；一轮做完在等本人回复的不动；用完时新开的直接排着等。报 `budget`（`state: exhausted`）和 `notice: budget_exhausted`。云端照它出「等你」那一行和选项框。只在跨过 100% 那一刻停一次：本人对停着的说一句（比如「现在收尾」）照常做，做完不再停。
- 加预算（「加 50%」「加 50% 继续」）：网页先存到天枢，再 `PUT /v1/budgets { taskId | sessionId, budget }`（或下一次开工带来）。马上重算：不再用完就接着做，排着的回到队里，停着的往开着的进程里说一句「预算加了，接着把刚才没做完的做完。」（`notice: budget_resumed`），进程退出了的 `--resume` 续上再说（看同时上限和暂停）；收到「做完这一步就停」还没停的，说一句「预算加了，不用停，接着做。」并取消 3 分钟的打断。预算加了但订阅额度用完了的，改成等额度；额度恢复了但预算用完的，改成等预算。本人说一句、停下、强停都不再等预算（「暂停全部」不取消）。
- 余额不足（网关回 402，第 5 节）：这一件停着等本人（`hold.reason = balance`），不重试、不自己接着做；用同一个网关模型配置排着的、新开的也先停着等；本人对其中一件说一句（多半是充值了）就放开这个配置，排着的回到队里（还不足就再停）。「换订阅继续」本机不换正在做的会话的模型（网关做的会话换成订阅续上不保证能接上），网页可以停掉它、用订阅重新开这张卡（工作树还在，接着用）。
- 额度到 90% 问一次（11.4）：本机不另做，云端和网页照同步上去的额度百分比问；付费兜底（TokenHub、额外额度）本机从不自己换，都要本人在网页上选。
- 测试：`test/budget.test.ts`（记账：时长、本周额度重置后累加、币种；三种模式的跑法表和返工轮数；TokenHub 花费的今天、本月、翻页、不是 TokenHub、钥匙不对、同一账户；用假 claude 跑：80% 降档和「加 50%」回落、100% 跑着的做完这一步停下和排着的不开始、加了预算接着做、只算真在跑的时长、不理就打断、停之前加了预算说不用停、无上限的参数和 95% 关多 agent、不挂 Task 的专题、余额不足停着等和放开、状态里的花费），`test/planVerify.test.ts` 无上限的验收员和返工轮数，`test/outbox.test.ts` 同步带花费。
- 测试：`test/quota.test.ts`（额度解析、事件、缓存，向假 Claude Code 读额度，命令行工具四种状态，价目表三种策略和缓存，碰壁停着等再往进程里说一句、排着的跟着停、碰壁退出再续接、本人说一句或停下就不再等，花费的来源和真钱，档位，状态接口），`test/outbox.test.ts` 同步带额度，`test/guard.test.ts` 飞书命令行。

## 7. 会话里的 MCP

每个会话的 `mcp.json`（`--strict-mcp-config` 下只有它）挂两个 HTTP MCP：

| 名字 | 地址 | 什么时候挂 | 鉴权 |
|-|-|-|-|
| `tianshu-session`（本会话 MCP） | `http://127.0.0.1:<端口>/internal/sessions/<id>/mcp` | 总是 | 请求头 `x-tianshu-session-secret: ${TIANSHU_SESSION_SECRET}` |
| `tianshu`（天枢 MCP） | `http://127.0.0.1:<端口>/internal/sessions/<id>/cloud-mcp`，本机程序换上云端令牌转发到 `<apiBaseUrl>/mcp/me`（含流式响应） | 关联了云端时 | 同上，会话密钥 |

文件里只写 `${变量名}`，值经 Claude Code 子进程的环境变量传进去，Claude Code 启动时展开（11/06 用假 MCP 服务实测：收到的是展开后的请求头；真机实测本会话 MCP 照常连上）。所以本会话密钥不落盘、不进命令行；云端令牌只在本机程序里，会话和它跑的命令都拿不到。

联网搜索由天枢 MCP 提供（`/mcp/me` 上的只读 `web_search`，博查，钥匙留在服务器、按人限流），本机不另起搜索 MCP、不存博查钥匙。预先放行的只有两个只读工具：`get_task_context`（挂了天枢 MCP 就放行）和 `web_search`（岗位有搜索时放行）；天枢 MCP 的其他工具（写进展、建事项等）每次调用都要网页批准。

本会话 MCP 的工具（每种会话各看到自己那几个）：

| 工具 | 谁有 | 做什么 |
|-|-|-|
| `add_artifact` | 卡、专题 | 交工作目录里的 md/html/pdf/docx/txt（≤10 MB，同名再交是新一版），返回编号 A1、A2… |
| `add_evidence` | 卡、专题 | 交说明、日志片段、链接、改动摘要，返回编号 E1、E2… |
| `hand_back` | 卡 | 逐条完成标准 met/partial/unmet + 证据 + 总结，`outputs` 点名用哪几份（编号）；不点名就是本会话交过的全部，同一个文件交过几次只算最新一版（验收没过改完再交回，没改的产出也在） |
| `save_version` | 专题 | 存一版：工作目录里的 Markdown 文件，`kind` 是 outline/draft/review，`note` 写改了什么；号从开工时的 `versionBase`（交代里的 latestVersion）和本机同一个专题别的会话已存到的号里取大的往下编（云端还没收到本机刚存的版本时也不撞号） |
| `set_feishu_url` | 专题 | 某一版存进本人飞书以后，报回第几版和地址 |
| `propose_plan` | 规划员 | 交计划（summary、steps、risks）和派活单（1–8 件：title、brief、doneDefinition、criterionIndex、role、modelTier、why、after），经发件箱同步 `card_plan`；改了再交是新的一次 |
| `submit_verdict` | 验收员 | 每条完成标准判一次（met/partial/unmet、理由、依据、怎么补）、beyondScope、一句结论；只交一次，经发件箱同步 `verdict`，同时在被验的卡的会话里记一条结论事件 |

用 HTTP 而不是 stdio，是为了不给每个会话再起一个 150 MB 的本机程序进程。真机实测：Claude Code（haiku）经 ToolSearch 找到这几个工具，调用不弹权限，产出物和交回进了发件箱。

## 8. 云端同步（本机 → 云端，单向）

- `POST {apiBaseUrl}/api/local-runner/sync`，`Authorization: Bearer <个人令牌>`，体 `LocalSyncBatchRequest`（≤50 条、≤12 MB），回 `LocalSyncBatchResponse`。
- 心跳：云端 10 分钟没收到同步就当本机离线。本机开着、5 分钟里没同步过任何东西（闲着，或条目都在退避）时，发一批空的（`items: []`，照样带 `slots` 和读到过的 `quota`），云端照样刷新在线时间和位置数；每分钟看一次，没关联云端不发，没发成等下一分钟。
- 每批（心跳也是）带读到过的 `quota`（用量的每一格：Claude、装了 Codex 时的 Codex、配了 TokenHub 时的 TokenHub 当天花费）。
- 条目：`status`（状态变化，带 `hold`、`run`；idle 且执行方在问本人时带原样的 `question`，waiting_permission 时带 `permission { requestId, toolName, title, outsidePaths }`，不传工具的完整输入；在问的、在等批准的那一条变了而状态没变时也重报一条。没带 question 的 idle 云端当成一轮做完停下，不进「等你」，规划员、验收员一样；B 的 aa6aba9e）、`plan`（TodoWrite）、`evidence`、`artifact`（原文 base64）、`handback`（带 `outputKeys`：点名的产出和证据的条目幂等键，云端存成 `local_outputs.client_id`）、`topic_version`（专题新的一版：号、种类、名字或 null、改了什么、Markdown 正文）、`topic_version_feishu`（第几版已存进飞书、地址）、`card_plan`（规划员的计划和派活单草稿）、`verdict`（验收员的逐条结论，subject 带 cardId 和 handbackKey）、`cost`（每轮增量，带 `source`、`model`、网关的 `money`，第 6 节）、`background`（会话里的后台任务开始或变了，每次全部字段）、`budget`（一份预算变了：到 80%、到 100%、加了预算回落、预算被改了，带全部字段，以 updatedAt 最新的为准，第 6 节）、`merge`（卡合回的结果：按交回的 handbackKey，`merged`、`commit`、`baseBranch`、`reason`、`message`、`auto`；同一个交回以本机序号最大的为准）。规划员、验收员的 status、plan、cost 条目 subject.kind 是 plan / verify，云端不能当成卡自己的状态。卡在工作树里做时，`handback` 带 `git`（分支、基线、交回的提交），`verdict` 带 `commit`（ADR 0038）。不传仓库文件、完整工具输出、环境变量、钥匙。
- 幂等键 `<deviceId>:<sessionId>:<本会话同步序号>`。云端按键去重，重复的也回 `accepted`；`rejected` 的本机记一笔后出队；回执里没提到的、网络错、5xx 都退避重试（1 s × 2^n，最长 5 分钟）。发件箱先落盘（`outbox.json`），断网、重启都不丢。
- 令牌被拒（11/07）：同步回 401 时，本机把关联当成没关联（`/v1/cloud`、`/v1/status` 报 `linked: false`），网页原有的自动关联会重新关联一次；发件箱不丢，原因留在 `outbox.lastError`，关联上以后接着发。只认同步接口：会话的天枢 MCP、验收交代碰到 401 时，本机马上发一批空的确认一次，同步也 401 才算被拒（设备令牌调 `/mcp/me` 被拒不能把关联弄掉）。被拒的令牌已经换掉了就不动。
- 关联：网页 `PUT /v1/cloud` 交 `apiBaseUrl` 和令牌；`apiBaseUrl` 的来源必须在白名单里，免得被指到别处。这个令牌同时用于会话里的天枢 MCP（第 7 节）。**建议 api 会话**给个人令牌加一种 `local` 客户端：能调 `/api/local-runner/*` 和 `/mcp/me`，网页配对后建一个这种令牌交给本机程序，设置页能看到、能吊销。

## 9. 模型

- 内置 `subscription`：用本人 Claude Code 的登录，不设任何模型环境变量，模型和思考强度按会话的档位传（第 6 节）。也可以加「订阅 + 指定模型」的配置（如 haiku、sonnet、opus）。
- `gateway`：Anthropic 格式地址 + 模型名 + 钥匙（TokenHub 等）；小模型（WebFetch 摘要用）不填就同主模型。几张卡同时跑、各用各的模型（11/05 实测）。
- WebFetch 走网关能用（要 `skipWebFetchPreflight`）；WebSearch 能不能用看网关背后的模型：DeepSeek v4.1 flash、Opus 能真搜，Qwen 3.8 flash 不搜还编结果（附录 D）。所以模型配置有 `webSearch` 开关：订阅默认开，网关默认关（拉起时加 `--disallowedTools WebSearch`），实测能搜的再打开。调研专题要联网时，用开了搜索的模型，或用天枢提供的搜索工具。

## 10. 托盘与开机自启

托盘助手：Windows 上本机程序第一次启动时，用 .NET Framework 自带的 `csc.exe` 把嵌在程序里的 C# 源码编成约 10 KB 的 `tianshu-tray-<哈希>.exe`，放在数据目录 `bin/` 里，常驻约 30 MB（原先用 PowerShell 宿主约 100 MB）。托盘图标四种状态：灰（没配对）、蓝（已连接）、绿（正在跑，提示里写「正在跑 N 张卡」）、橙（已暂停）。菜单：打开天枢 / 暂停全部（停下所有进行中的会话，不接新会话；再点是「恢复」）/ 退出（停掉所有会话进程后退出）。左键单击打开天枢。开机自启：Windows `HKCU\…\Run\TianshuLocal = "<exe>" run`；Mac LaunchAgent `com.tokenkingos.tianshu-local`（`RunAtLoad`，异常退出自动拉起）。已有一个在跑时再启动会直接退出。

## 11. 安装与卸载

`irm <下载源>/install.ps1 | iex`（Windows）、`curl -fsSL <下载源>/install.sh | sh`（Mac）：装到本人目录（不要管理员）、核对 `SHA256SUMS`、注册开机自启并启动、检查 Claude Code（没装就跑官方脚本，没登录就 `claude auth login`，浏览器里点授权）、打开天枢。下载源默认 `https://tk.tokenkingos.com/downloads/local`，可用 `TIANSHU_LOCAL_DOWNLOAD_BASE` 改；**这次没有发布**。`install.ps1` 一开始查 Windows 智能应用控制，开着「强制」就停下说明（没签名的程序会被拦，ADR 0032）。卸载脚本装时留一份在本机，默认保留本机数据。下载源的文件用 `pnpm --filter @warmap/local release` 准备，上传后用 `release.mjs --verify` 核对（runbook「打包和发布」）。

## 12. 以后接 Codex

`AgentAdapter.start(launch) → AgentRun{ send, interrupt, respondPermission, kill, onEvent, onExit }` 已按 Codex 也能实现的粒度定；`agents/codex.ts` 现在抛 `not_implemented`。12 月接 `codex app-server`（附录 E）：`turn/steer` 插话、`turn/interrupt` 停下、`requestApproval` 批权限（不能附理由，先 steer 一句再拒）、`thread/resume` 续接；网关只能是 Responses API；花费要按 token 自己算；干净会话要用天枢专用 `CODEX_HOME`（代价是本人在天枢里再登一次 ChatGPT）。Codex 的 `web_search` 也是服务端工具、看供应商（11/06：TokenHub 上 DeepSeek 不搜、Qwen 能搜，和 Claude Code 正好相反），非白名单模型要写 `web_search = "disabled"`，否则上游一拒绝整轮就失败；挂天枢 MCP 时要写 `default_tools_approval_mode = "approve"`，否则 MCP 工具在无人值守时直接失败。

## 13. 测试与验证（11/06）

- 单测 52 条（`pnpm --filter @warmap/local test`）：安全 10、会话与适配器 15（假 `claude` 按 stream-json 说话，含参数、环境白名单、事件、SSE 补发、权限、插话、停下、强停、续接、本会话 MCP、天枢 MCP 转发、钥匙不外泄、搜索白名单、版本太旧、登录失效、Codex 未接）、发件箱 3、加固 10、越界与网关 14（第二轮，含目录链接、命令写法、放行建议越界、移除文件夹、旧条目、路径大小写）；契约 6。故意放开环境白名单、去掉续接互斥、去掉换地址作废钥匙、去掉日志补换行，以及第二轮的 14 处（越界不给「都允许」、建议改 session、建议越界、排除全局记忆、网关快速失败、重试提示、主目录提示、不存在的路径解链接、普通词查链接、旧条目复查、整个磁盘、移除文件夹后工作目录越界、工作目录换实际写法、PowerShell 不按 \ 转义），对应用例都会失败（确认用例有效）。
- 独立评审（11/06，xhigh）：13 条，8 条有复现。已修 12 条（怪路径打挂进程、换地址带走旧钥匙、续接不重查文件夹和暂停、并发续接起两个进程、强停追不上启动中的进程、发件箱被不合格条目卡住、发送异常带走进程、日志半行吞事件、钥匙串换行注入、测试页 XSS、安装脚本 BOM、升级残留子进程），带个人配置时钥匙进命令行改为拒绝开工；网关钥匙在会话环境里这条按 ADR 0029 接受。设计层两条见第 14 节。
- 第二轮独立评审（11/06，xhigh）：7 条确认、3 条可能。已修：借目录链接越界判成没越界（不存在的路径、相对路径）、命令切词漏认多种写法（另加「放行建议越界就不给都允许」这一层，不靠切词）、旧版本加的不合规矩的文件夹仍算数、测试超时偏紧、大小写测试测不出问题、`--verify` 整套旧版本也能通过、重试恢复后别的错误被算成模型服务的错、移除文件夹后工作目录仍算数、测试页回放旧事件报错；主目录两种写法都给排除规则；整个磁盘不能选。没改：主目录和仓库之间几层目录里的 CLAUDE.md 照默认读（ADR 0030）。
- 第三轮（11/06，岗位、评审会、排队之后）：单测 64 条（另有排队 4 条：批量、先来先跑、让位、取消、调上限、暂停、重启恢复）、契约 92 条。上一轮自审的 5 处已修，每处都先在旧代码上让测试失败：整理飞书插件链接出错挡开工（另在 Bun 1.3.13 下核对只删链接）、评审版被当成最近一版、带个人配置时提示词说没找到飞书技能、主岗位没有搜索时挑刺子 agent 仍拿搜索、不点名交回漏掉前一轮的产出又重复算同一文件的旧版；另修同一专题两个会话存版本撞号。重新编三个平台后，exe 跑冒烟（$0.0032）和排队真跑（上限 1、同时 2 件，第 2 件排第 1，第 1 件 4.0 秒做完后马上接上）都通过。
- 第四轮（11/06，拆卡和验收改在本机）：单测 68 条（新增 `test/planVerify.test.ts` 4 条：三种会话的参数和排队先后、只读、按档位挑模型、交回后自动起验收员、没过经说一句送回再验、第二次没过受阻、取不到交代时排着等、404 和 409、重启后照样排着、结论校验和提醒），契约 93 条。9 处变异（排队先后、只读、交回后起验收、等交代的不开始、结论报给卡的会话、提醒一次、交回送到再取交代、交完收工、第二次受阻）每处都有测试失败。重新编三个平台后，exe 冒烟通过（$0.003）；exe + 真 Claude Code（订阅 haiku）+ 假天枢真跑一次：规划员先读 get_task_context 再交 2 件的派活单（各对约定第 1、2 条）→ 一批开工 → 两件交回 → 本机各起一个验收员（交回送到天枢后 0.1 秒取到交代，0.4 秒开始）→ 两份结论同步上去（都过），验收员只用了 Glob、Read 和 submit_verdict，没来要过权限，交代里让它试写的 probe.txt 没写出来，交完自己退出；五个会话共 66 秒、$0.0196。记录 `.scratch/local-runner/实验/L_规划验收真跑结果.json`，脚本 `L_plan-verify-e2e.mjs`（第一次跑时汇总那段脚本有错，链路已跑完，结果由 `L_collect.mjs` 从本机程序的会话记录汇总；脚本错误已改）。
- 第五轮（11/06 晚，卡的工作树，ADR 0038）：单测 73 条（新增 `test/worktree.test.ts` 4 条，用真的临时 git 仓库：两张卡同时在各自的工作树里做、交回提交到卡的分支、验收员的交代里只有这张卡的改动、结论带提交、合回的四种结果（主文件夹有改动、不在基线分支、成了、冲突后放弃）、卡这边合不了回 409、不是仓库的文件夹排队、排队时取消清工作树、同一张卡再开工、重启时 prune），契约 94 条。原来几张卡共用一个临时文件夹的测试改成每张卡一个子文件夹（假 claude 往上找配置）。13 处变异（不开工作树、交回不提交、交代不接改动、改动按分支名算、结论不带提交、不查主文件夹改动、不查基线分支、冲突不放弃、文件夹不排队、取消不清、启动不 prune、合回前不关进程、同一张卡开两个）每处都有测试失败。没有真跑 haiku。
- 第六轮（11/07，端到端真跑后的五处修改）：单测 81 条（新增 `test/questions.test.ts` 2 条、`test/cloudReject.test.ts` 2 条、`test/worktree.test.ts` 卡的先后 2 条、`test/planVerify.test.ts` 派活单的 after 和规矩 1 条、`test/guard.test.ts` 工作树里放行的规则 1 条；原来的工作树测试改成工作树里写文件不用批准、碰外面照样问），契约 96 条。22 处变异每处都有测试失败（见下）。真跑一次 haiku（源码起的本机程序，临时 git 仓库）：卡先用 AskUserQuestion 问「写哪个文件」，网页上是等你回复带两个选项，选了 b.txt 以后它说「你选的是 b.txt」只写了 b.txt；工作树里写文件没要批准，主文件夹没动；$0.0026。记录 `.scratch/local-runner/实验/M_提问真跑结果.json`，脚本 `M_question-e2e.mjs`。
- 第七轮（11/07，会话里的后台任务）：单测 88 条（新增 `test/background.test.ts` 7 条：报哪些和字段、跑完、Claude Code 自己开的一轮、停、重复停和前台命令回 409、事件和同步一一对应；进程退出和重启后算 stopped；后台子 agent 的权限请求在主轮结束前到、跨过主轮结束，批了以后回到等你回复；在主轮结束后到（真机的顺序），把子 agent 停了请求作废、回到等你回复；和主轮的提问同时在等时先批、先答两种走法；后来移到后台的命令、没说明的默认名、failed、只来 task_updated 或只来 task_notification；不是仓库的文件夹在后台任务跑着时让下一张卡排队（不关联云端也能接上）、卡有后台任务在跑不让合回），契约 97 条。27 处变异每处都有测试失败（26 处由这个文件抓到，「每轮开头不标在一轮里」由原有的会话测试抓到；报哪些、内部任务、只认 task_updated 或只认 task_notification、停时发 stop_task、结束了不能停、重复停不去问执行方、默认名、后来移到后台、主轮结束只作废这一轮的请求、之后的状态、批完按在不在一轮里和有没有在问本人回到 running 或 idle（三处）、轮末清掉标记、有权限请求在等时提问和回答不改掉 waiting_permission、子 agent 停了作废请求、自己开的一轮算在跑、同步、退出和重启收尾、文件夹忙、结束后排下一张、合回）。 真跑一次 haiku（源码起的本机程序，临时 git 仓库，假天枢）：卡开了一条后台命令和一个子 agent「数文件」，两项都报上来；网页上停了后台命令，变成 stopped，会话没停；子 agent 跑完 done；4 条 background 事件和 4 条同步条目一一对应；没来要过权限；$0.005。记录 `.scratch/local-runner/实验/O_后台任务真跑结果.json`，脚本 `O_background-e2e.mjs`；协议先用 `N_background-probe.ts` 直接抓过（`N_后台任务协议实测.jsonl`）。独立评审（工作流，34 个 agent，找出的每条再派人反驳）：确认 1 条（按工具调用记下的输入一直不清，已删，名字只取说明）；有分歧 1 条（主轮结束时把后台子 agent 的权限请求一起作废，子 agent 一直卡着，已修）；其余判为原有问题或设计如此，其中顺手加了两处保护（不是仓库的文件夹在后台任务跑着时算忙、卡有后台任务在跑不让合回），乱序同步写进契约注释给云端。修完又跑一轮复核（工作流，21 个 agent，三个角度找、每条两人反驳）：两票都认的——后台子 agent 的权限请求在主轮结束后才到（真机就是这个顺序，假 claude 原先发反了），批完或把子 agent 停了会话卡在 running；正在问本人时批完变成 running；子 agent 续上时沿用同一个 task_id，契约注释里「已结束的不被 running 盖回」不对。已改：本机记下每轮从 `system/init` 到 `result` 算在一轮里，批完按它和有没有在问本人回到 running 或 idle；有权限请求在等时提问、回答都不改掉 waiting_permission；契约注释去掉那一句（bb20322b）。一票认的两条没改：子 agent 跑完时同一文件夹排着的卡和 Claude Code 自己开的一轮撞上（见第 14 节第 13 条）；进程退出后 stdout 里迟到的任务消息（反对的一票指出 Windows 上管道的数据先于退出送到）。另把执行方 `stopTask` 里重复的状态检查删了（会话层已查）。
- 第八轮（11/07 凌晨，第二遍真跑之后）：单测 93 条（新增：`test/cloudReject.test.ts` 闲着时心跳 401 1 条；`test/guard.test.ts` 跑仓库自己的脚本、npx 只跑装好的、筛选里的 .git 1 条；`test/planVerify.test.ts` 规划员收工和「改一改」1 条；`test/worktree.test.ts` 自动合回 2 条；原有用例里验收员、规划员收工改成 `done`，测本人点合并的用例关掉自动合回；工作树这组每条给 60 秒，全套并行时最长那条要 30 秒上下），契约 98 条。20 处变异每处都有测试失败：心跳 401 不取消关联、心跳不看 401；筛选里的 .git 也算、有写也放过筛选、匹配模式当路径、采信 Claude Code 报的正则路径、npx 不查装没装、不查名字格式、不拦 -p、一律拦；规划员交了不记、收工记成 exited、收工前停在 idle；验收过不自动合、不看开关、不查验过的提交、合成了不报、没合成不报、合成了不清 needsMerge、又交回不清、合不成不提示。
  - 吊销后显示「已关联」：查第二遍真跑现场（另一个会话 scratchpad 的 `tl-data2`），本机在 18:21 左右心跳收到 401 后已经取消关联；插件页只在本机报没关联时才自动关联（`PluginsPage.tsx` 第 51 行），`cloud.json` 和令牌文件都是 18:25:11Z 重写（本人 18:25:09 重新打开插件页之后两秒），18:25:49 用新令牌同步成功、原因清掉。所以刷新后看到的「已关联」是网页已经用新令牌重新关联上了，本机没有要修的；新加的测试照真跑的路径走一遍（闲着、只靠心跳、401、取消关联、重新关联）。
  - 总验收那张被拦的命令：拦它的不是 `npm test`，是 `-Exclude .git` 和 `-notmatch '\\.git\\'`（碰 `.git` 的规则），以及正则 `'\\.git\\'` 被当成网络路径（越界）。改成：只用来排除、筛选的 `.git`、`.claude` 不算碰（命令里有写、删、挪、重定向时照样算）；PowerShell 比较运算符和 `-Pattern` 后面的词不当路径，Claude Code 在请求里把这种词当越界路径（`blocked_path`）报上来也不算（真跑里那个越界路径是我们认的还是它报的分不出来，08:00 后真跑一次确认）；`npx`、`npm exec`、`bunx` 只放行工作树 `node_modules/.bin` 里已有的程序（没装会去下载）。
  - 没有真跑（额度快用完，主会话要求 08:00 前不跑）。
- 第九轮（11/07 早上，额度这一批）：单测 110 条（新增 `test/quota.test.ts` 15 条，`test/outbox.test.ts` 同步带额度 1 条，`test/guard.test.ts` 飞书命令行 1 条；`test/planVerify.test.ts` 执行的 `--model` 从没有改成按标准档 opus），契约 99 条。假 claude 加了 `get_usage`、碰壁（`rate_limit_event` rejected → 助手报 rate_limit → 429 的 result，或直接退出）、途中报额度、网关用量和请求次数；每轮收到的话记在单独的 `.fake-claude-turns.jsonl`。33 处变异 32 处有测试失败；没抓到的一处是「进程退出时等 stdout 读完再报退出」：Windows 上管道里的数据总在退出事件之前送到（先说 2 MB 再退出也一样），测不出来；Node 文档写明退出事件时 stdio 可能还没关，Mac 上额度用完直接退出时最后几行会丢，所以留着。`get_usage` 的形状和 0.7 秒是主会话 11/07 调研时真机读的，碰壁那一串没真机复现过（见第 5 节）。08:00 后：用本机真装的 Claude Code 读了一次额度（不发提示，2 秒，解析出本周总额度和按模型的窗口，没有 5 小时窗口），真跑一次 haiku 带 `--effort low`（接受，$0.0016）。独立评审（工作流，22 个 agent，每条再派一人反驳）：18 条里 17 条确认，去重 11 件都已修，每处修复先让测试在旧写法上失败：不知道几点恢复时「接着做 → 又碰壁」热循环（只有 rate_limit 的 429 也当用完、读到没满就马上续、没给时间的 rejected 沿用过期时间）、没在用的模型满了照样挡所有卡、交完收工后 hold 不清（一直显示等额度、每 5 分钟读一次）、暂停全部把开着进程的会话的等额度清掉、TokenHub 上数不出请求次数选错档、空用量把累计标价变成 null、`minutes +summary` 当成读、引号里的 `--help` 放行写操作、`$( )` 里套写、方法后面多写一个 get、摘要多出内部字段 `modelTier`（摘要是严格契约）；测试的恢复时间留得更宽，并校验摘要和状态接口合契约。修复的 13 处变异都有测试失败；另有两处（引号切词、每次出现都单独看）删掉也没有测试失败、别的规则已经挡住，按消融删了。判为不成立 1 条：按模型分的周额度用完会挡住别的模型的卡（这个账号没有这种窗口，见第 14 节）。
- 第十轮（11/07 下午，三种模式和预算、TokenHub 花费、Codex 额度）：单测 121 条（新增 `test/budget.test.ts` 8 条、`test/quota.test.ts` Codex 1 条、`test/planVerify.test.ts` 无上限的验收员 1 条、`test/outbox.test.ts` 同步带花费 1 条），契约 100 条。假 claude 加了干活的一轮（不要权限、按时做完，收到「预算用完了」提前收尾或不理）、余额不足（402、billing_error）、跑着时改设置（apply_flag_settings 记进 trace）。用假 claude 跑通：本周额度到 80% 后面开的卡降一档、「加 50%」回落；到 100% 跑着的做完这一步停下、排着的不开始；加了预算往开着的进程说一句接着做、排着的开始；时长到点不理就打断，停着等的时间不算；停之前加了预算说不用停；无上限的参数和 95% 关多 agent；余额不足停着等、说一句放开。28 处变异都有测试失败。消融删了两处：不是 TokenHub 的网关一小时内不再试、网关每轮做完强制重读花费（5 分钟读一次就够）。真机（不发提示、不花 token）：订阅的 Opus 上 `--settings {"ultracode":true}` 生效（`ultracodeAvailable: true`），`apply_flag_settings` 关、开都生效，`--effort max` 接受；`codex app-server` 的 `account/rateLimits/read` 约 5 秒读到 Plus 的 5 小时（0%）和本周（21%）两个窗口、2 次重置。TokenHub `/log/usage` 和 402 照 tokavi-tokenhub f31dd05 的源码写，没用真钥匙调。
- 第十一轮（11/07 下午，「等你」两个字段、这台电脑逐项、用量来源通用形状、附件）：单测 124 条（新增 `test/attachments.test.ts` 4 条：附件的格式、文件名、存放、同名、大小、取不到、sha256 对不上、整句不发、工作树里不进提交、只发附件、没连天枢；状态条目带提问和批准那一步、批了以后不带；`test/quota.test.ts` Codex、Claude Code 的登录和用量格子的剩余百分比），契约 100 条。21 处变异 20 处有测试失败；没抓到的一处是「在问的那一条变了而状态没变时重报」：主轮的提问总伴随状态变化，只有后台子 agent 在一轮做完以后才问时才用得上，假 claude 没有这个顺序，按正确性留着。附件接口照 B 的 334f1ade 写，没和真的天枢联调。
- 第十二轮（11/07 晚，项目的文件夹）：单测 125 条（新增 `test/projects.test.ts` 1 条：绑、解绑、改名、不在允许列表的 404、文件夹列表带项目、卡在项目仓库开工作树、专题在项目文件夹、没绑的卡用项目专用目录、不带项目的卡 400、上报带 projectId、验收员跟着卡、删文件夹后没绑），契约 101 条。8 处变异 7 处有测试失败；没抓到的是「删文件夹时改写绑定」，读的时候已经只认还在允许列表里的文件夹，那段改写多余，按消融删了。
- 和云端联调（11/06）：本机程序分支 + `claude/v2-board-api` 的接收端合进临时分支 `claude/local-runner-sync-e2e`（只在本机），时间机器起 API，真程序 + 真 Claude Code（haiku）走通配对 → 建设备令牌 → 关联云端 → 开卡 → 交产出物和交回 → 云端收到（13 条、2 份产出、1 条交回排队、卡变进行中）→ 断网时排队 6 条 → 恢复后自动补发 → 原样重发 6 条全部 accepted、表里不重复。44 秒，$0.0043。记录在 `.scratch/local-runner/实验/I_云端联调.md`。
- 真机：编出的 exe + 真 Claude Code 2.1.318（haiku），冒烟命令走完配对 → 开工 → 事件 → 3 次批准 → 插话下一步生效（b.txt 改成 22）→ 新一轮 → 停下（interrupted）→ 强停（exited），花费 $0.003；另一次验证本会话 MCP 交证据和交回。真实调用共 2 次会话（4 轮）。
- 托盘模式：配对确认框、选文件夹框、托盘图标/提示/菜单、暂停与恢复、菜单退出都在 Windows 11 上截图验证（`.scratch/local-runner/实验/截图/`）。
- 安装：用本地 exe 跑 `install.ps1`（4.4 秒装好并启动、写入自启项）；按注册表里的命令行启动成功（模拟开机，未真重启）；`uninstall.ps1` 后进程、自启项、程序、数据、端口全部清掉。

## 14. 已知问题与待定

1. **内存**：空闲约 195 MB（主程序 155–165 + 托盘助手约 30）。再要降就评估 Node SEA（ADR 0028）。
2. ~~工具不按文件夹拦~~：已改（11/06 第二轮，ADR 0031）。越界路径在权限请求里标出、网页标红、只能允许这一次；不自动拒绝。Bash 认路径是尽力而为。
3. **项目配置不经网页就生效**：`-p` 模式没有「信任这个文件夹」的确认，仓库里 `.claude/settings.json` 的 hooks 和放行规则直接生效（仓库自己写越界放行规则时，那一步也不会来问）。允许的文件夹应只放本人信得过的仓库（ADR 0030）。以后不再信任项目配置时，可以用 SDK 钩子把越界调用强制拉回网页（ADR 0031 做法 C，已实测可用）。
4. **Mac 没测**：JXA 菜单栏、`osascript` 弹框、钥匙串、LaunchAgent、`install.sh` 都只按文档写了。另外，Windows 上交叉编出的两个 Mac 程序签名都不可用（11/06 离线核对，发布脚本会提醒），上 Mac 版前必须在 Mac 上重签（runbook「打包和发布」第 3 步）。
5. **云端接收端和令牌类型**：接收端和设备令牌已由 V2 后端做好（`claude/v2-board-api` 04c7befb），联调通过（第 13 节）。设备令牌调 `/mcp/me` 现在是 401（等那边改成只读），会话里的天枢 MCP 暂时连不上，不影响开工和交回。
6. **网页**：要做首次授权引导、配对、选文件夹、事件流（fetch 读 SSE）、批权限、插话、停下；测试页可以照抄。
7. **下载源**：文件已能一键准备并自查（`release.mjs`），本机模拟下载源走通了 `irm | iex` 安装；**还没上传**，线上要配 `charset=utf-8`（runbook 有 Caddy 写法，没在线上验证）。Windows 签名、Mac 公证没做，选项和费用见 ADR 0032，等本人定。
8. **Claude Code 安装**：官方脚本在无终端环境下能否跑完没在干净机器上测；国内网络可能连不上 `downloads.claude.ai`。
9. ~~工作目录在本人主目录下时读进本人全局规则~~：已改（11/06 第二轮）。干净会话用 `claudeMdExcludes` 排除主目录这一层；允许的文件夹不能是主目录或它的上级。原先写的「换 `CLAUDE_CONFIG_DIR` 能解决」实测不成立（附录 G）。
10. ~~网关出错时重试太久~~：已改（11/06 第二轮）。网关模型重试 2 次、等响应头 40 秒，每次重试即时提示网页。剩下一种：网关回了响应头之后卡住不动，Claude Code 固定等 5 分钟才重试，`CLAUDE_STREAM_IDLE_TIMEOUT_MS` 改不小（实测），只能本人在网页上点停下。
11. **合规**：「我们的程序替本人拉起官方 CLI、用本人订阅」算不算条款允许的用法，请法务确认；Codex app-server 登录方式文档写着不允许用于商业或托管服务。
12. **卡的工作树（ADR 0038）**：工作树里放行的命令按词认（装东西、联网、推拉代码），认不全：脚本自己联网（如 `node x.js` 里 fetch）认不出，会放行。强停后没合回的卡，工作树一直留着（还没有「丢掉这张卡」的操作）；大仓库开工要等完整检出，子模块不初始化，Windows 上路径可能太长；合回的结果没同步给云端；验收期间本人让卡接着改，验收员读到的文件可能比交回的提交新（以交代里的改动为准）。
13. **会话里的后台任务**：Claude Code 自己开的那一轮（后台子 agent 跑完时）不经排队、也不看文件夹，可能暂时超过同时上限；不是仓库的文件夹里排着等这张卡的后台任务的卡，会在子 agent 跑完那一刻开工，和这一轮同时改这个文件夹（和 ADR 0038 里「空闲的卡被本人说一句」是同一类代价）；后台子 agent 在一轮之外来要权限时，会话变成 waiting_permission 也不经排队，可能超过同时上限，直到本人批了、拒了或停了它（这时本人说一句，网页上报的是「下一步前送达」，实际是新的一轮）；进程退出时还在跑的都记成 stopped，Claude Code 退出时有没有真的结束后台命令起的子进程没核对；停只能在本机网页上点。
14. **令牌被吊销要等心跳**：本机闲着时 5 分钟才发一次心跳，吊销后最多约 6 分钟才知道；网页打开着的插件页不刷新就看不到「没关联」，也就不会自己重新关联（网页侧）。
15. **订阅额度（11/07）**：`get_usage` 是 Claude Code 自己标的实验接口，形状变了就读不到（`quota.error` 记原因，停着等照样靠跑着的卡报的 `rate_limit_event`）。网关读的是 TokenHub 自己报的今天、本月花了多少（11/07 下午接上），读不到余额；Codex 的额度只显示，不挡卡。到点接着做时说的那一句是本机写死的；碰壁时正在等的后台子 agent 不单独处理。gh、lark-cli 的查法按 11/07 的版本写（gh 2.88 起有 `--json`），升级后形状变了会显示没登录；飞书命令行哪些算读按命令名认，新命令名里没有写的词、最后一段又像读的会被放行（宁可多列写的词；更稳的做法是按 lark-cli 每个命令 `--help` 里的 `Risk: read|write` 建一张表，没做）；故意拆开写的（`l\ark-cli`、变量拼出的命令名）认不出，和第 12 条按词认是同一类限制。按模型分的周额度（如 Opus 周额度）用完时，本机把整个订阅当成用完，别的模型的卡也停着等（宁可多等，不会一直重试）。网关一轮的钱按平均请求长度选档，和逐次扣的会有出入。
16. **三种模式和预算（11/07 下午）**：本周额度百分比是整个账号的、按整数涨，同时跑别的（包括本人自己用 Claude）也算进这件 Task，只能粗算；几件 Task 同时跑时每件都记一样的涨幅。时长按本机进程状态算，本机程序重启时正跑着的那一段不算。到 100% 时本机靠 Claude Code 照那句话停下，它可能多做一两步；3 分钟后打断，打断时这一步做到一半的照原样留着。正跑着的进程预算改了只换多 agent 开关，模型和思考强度要等下次拉起。余额不足那一串（402、`billing_error`）没真机复现；「换订阅继续」不在本机做。受阻轮数本机只管 `verdict` 事件里的 `blocked`（给网页看），云端落「受阻」要按 Task 的模式另算。

---

## 附录：实验结论（原始报告在 `.scratch/local-runner/实验/`）

### A. 打包选型

结论：Bun `--compile`（ADR 0028）。证据：三种都在 Windows 11 上做了最小原型——Bun 原型（托盘 + HTTP/SSE + HKCU Run + TypeBox 校验）112 MB、约 0.2 s 起、工作集约 130–155 MB；Go 7.2 MB、89 ms、16.8 MB，但 Mac 托盘要 cgo 只能在 Mac 上编，TypeBox 不能复用；Node SEA 91.8 MB、139 ms、37.4 MB，默认弹控制台窗口，Mac 产物要重签，Node 24 没有 `--build-sea`。Bun 在 Windows 上直接编出 darwin-arm64（63 MB）和 darwin-x64（68 MB），Mach-O 带 `LC_CODE_SIGNATURE`（临时签名）。用 `irm`/`iwr`/`curl` 下载的文件实测都没有 Mark-of-the-Web。拿不准：Bun 的内存；Mac 上实际运行。托盘坑：.NET Framework 的 `Console.In.ReadLineAsync` 实际是阻塞的，会卡住界面线程导致托盘点不动，改用后台线程读 stdin；没有控制台的窗口程序不能设 `Console.InputEncoding`，要在标准流上自己包 UTF-8 读写器。托盘最后换成本机用 `csc.exe` 编的 C# 小程序：编译 0.3–0.8 秒，约 10 KB，常驻约 30 MB。

### B. 一行命令安装

结论：可行，不要管理员。证据：Windows 上用本地 exe 跑 `install.ps1`：复制到 `%LOCALAPPDATA%\Programs\Tianshu\`、写 `HKCU\…\Run\TianshuLocal`、启动并在 4.4 秒内 `/v1/health` 通、检测到 Claude Code 已登录；结束本机程序后按注册表里的命令行启动成功；`uninstall.ps1`（带 `TIANSHU_LOCAL_PURGE=1`）后进程、自启项、程序目录、数据目录、端口都没了。坑：PowerShell 5.1 以 `-File` 跑不带 BOM 的脚本会按本机代码页（GBK）读，中文乱码，所以两个 `.ps1` 带 UTF-8 BOM；`irm | iex` 时服务器要回 `charset=utf-8`。拿不准：真重启后的自启（没重启电脑）；Mac 脚本没跑过；下载和 SHA256 校验分支没跑（没有发布）。

### C. Claude Code 检测、安装、登录

结论：能全程不碰终端。证据（隔离的 `CLAUDE_CONFIG_DIR`，没动本人登录）：`claude auth status --json` 纯本机读、不耗模型、不写文件，已登录退出码 0、未登录 1，但只说明有凭据（假 key 也显示已登录，所以必须清环境变量）；`claude auth login` 在 127.0.0.1 随机端口收回调，浏览器点授权即可，自动跳回失败时把浏览器显示的代码写进它的 stdin 也行（实测被读取）；官方安装 `irm https://claude.ai/install.ps1 | iex`，不要管理员、不再要求 Git for Windows，不支持自定义目录。原生安装默认后台自动更新，我们在子进程里设 `DISABLE_AUTOUPDATER=1`。拿不准：真实完成一次登录后的输出；Mac；无终端环境下跑官方安装脚本。

### D. 第三方模型下的 WebSearch / WebFetch

（这一项后来改由专门的 agent 做了更全的实测，以它为准：主会话目录下 `.scratch/next-phase/实测_第三方模型下的联网搜索_2026-11-06.md`。两次结论一致；本机程序按它的要求配置：每个会话 `skipWebFetchPreflight`、网关用 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 指便宜模型、自带搜索按白名单开、搜索改由天枢 MCP 提供。下面是本会话那次实测的摘要。）

结论：WebFetch 能用，WebSearch 看模型。证据（TokenHub 真钥匙，只读不打印，真实调用 5 次）：WebFetch 在本机抓网页，再用 `ANTHROPIC_SMALL_FAST_MODEL` 的模型摘要；抓之前会连 `api.anthropic.com` 做域名检查，`skipWebFetchPreflight: true` 后不再连。WebSearch 会给网关发 Anthropic 服务端工具 `web_search_20250305`，由网关背后的厂商执行：`wangsu/deepseek-v4.1-flash` 和 `wangsu/claude-opus-5-5` 真搜到了，`aliyun/qwen3.8-flash` 没搜（`searchCount` 0）还编了结果和来源，不报错。要创峰确认：各模型对服务端搜索工具的支持，对不支持的直接报错。

### E. Codex 程序化接口

结论：12 月接 `codex app-server`（stdio JSONL，JSON-RPC 风格），五件事都原生支持（第 12 节）。证据：`codex-cli 0.159.2` 的 `--help` 和 `app-server generate-ts` 生成的协议类型；用本机假网关驱动，0 次真实调用，本人 `~/.codex` 没改。`exec --json` 不能批权限、不能插话；`mcp-server`、`proto` 已没有。按进程配网关用 `-c model_providers.x.*`，钥匙走 `env_key` 指定的环境变量。拿不准：真实 ChatGPT 订阅下的事件细节；全局 AGENTS.md 能否在不换 `CODEX_HOME` 时关掉。

### F. 装成应用（PWA）后连本机的授权

结论：和标签页一样，而且共用。证据（Chrome 156，全新 profile，真安装 PWA）：授权按来源 + profile 保存——标签页允许过，应用窗口直接 200；应用窗口里屏蔽，标签页也屏蔽；第一次就在应用窗口访问，同样弹「想要访问此设备上的其他应用和服务」，挂在标题栏「⋮」下；屏蔽后可在「⋮ → 应用信息 → 设备上的应用」改回，不用刷新。本机程序没启动时授权框照样会弹。Edge 只测了访客模式 `--app` 窗口（表现一致），真安装没测；CDP 模拟不了「点允许」。

### G. 假网关实测：越界路径、全局规则、网关出错（11/06 第二轮）

方法：本机起一个假的 Anthropic 格式网关，把真 Claude Code 2.1.318 的 `ANTHROPIC_BASE_URL` 指过去，参数和本机程序一致（`-p`、stream-json、`manual` 权限、`project,local`）。假网关能看到 Claude Code 发出的完整上下文，也能按脚本假装模型发工具调用；不调真模型，不花钱。脚本和原始记录在 `.scratch/local-runner/实验/G_假网关实测.md`。

| 问题 | 结果 |
|-|-|
| 工作目录外的 Read、Write、Glob、Grep、`cat` 会不会来问 | 都会（`can_use_tool`，原因「Path is outside allowed working directories」，Bash 另带 `blocked_path`）；目录内的读和 `ls` 直接放行。仓库设置写 `allow: ["Read","Bash(cat:*)","Glob","Grep"]` 或 `additionalDirectories` 指向外面，越界的读照样来问 |
| 越界请求的放行建议 | Read/Glob/Grep：本会话放行整个外面目录；Write：`acceptEdits` + 把外面目录加进工作目录；Bash：一条 `destination: localSettings`（写进仓库 `.claude/settings.local.json`） |
| SDK 钩子 | `initialize` 里注册 PreToolUse 回调可用（`hook_callback`），返回 `permissionDecision: "ask"` 能把调用强制转成权限请求，原因原样带到请求里 |
| 工作目录在主目录下读进全局规则 | 会：`~/.claude/rules/pstack-models.md` 以「project instructions」出现在上下文里。`claudeMdExcludes: ["<主目录>/.claude/**"]` 后没有了，仓库 CLAUDE.md 还在；换 `CLAUDE_CONFIG_DIR` 没用 |
| 网关回 500 / 拒连 | 默认重试 10 次约 3 分钟；`CLAUDE_CODE_MAX_RETRIES=2` 后约 3.3 秒报错，每次重试有 `system/api_retry`（带 `attempt`、`max_retries`、`error_status`） |
| 网关连上不回 | `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS=20000` 对网关不起作用（170 秒没报）；`API_TIMEOUT_MS=20000` 时每次 20 秒，重试 2 次共约 63 秒 |
| `API_TIMEOUT_MS` 会不会掐断长回答 | 不会：它只管等响应头，`API_TIMEOUT_MS=20000` 时一个 45 秒流完的回答照常完成 |
| 回了头之后卡住 | 固定约 5 分钟后才重试；`CLAUDE_STREAM_IDLE_TIMEOUT_MS=30000` 不生效（下限 5 分钟） |
