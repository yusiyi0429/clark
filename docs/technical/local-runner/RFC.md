# RFC：天枢本机程序（apps/local）

v0.1 · 2026-11-06 · 第一版（Windows 先行）。决策见 ADR [0028](../../adr/0028-local-runner-single-binary-with-bun.md)（打包）、[0029](../../adr/0029-local-runner-keys-stay-on-device.md)（钥匙）、[0030](../../adr/0030-local-runner-sessions-clean-by-default.md)（会话默认干净）、[0031](../../adr/0031-local-runner-outside-paths-flagged-not-denied.md)（越界路径）、[0032](../../adr/0032-local-runner-release-and-code-signing.md)（发布与签名，待本人定）、[0033](../../adr/0033-local-runner-roles-via-cli-flags.md)（岗位进会话）；接口以 `packages/contracts/src/localRunner.ts` 为准；装、卸、排错见 [runbook](../../guides/local-runner.md)。

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
              [,"env":{ANTHROPIC_BASE_URL,ANTHROPIC_MODEL,ANTHROPIC_DEFAULT_HAIKU_MODEL}（网关）]}
  [--model <订阅时选的模型>]
  --append-system-prompt-file <sessions/<id>/system.md>   # 工作规矩 + 岗位（ADR 0033）
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

## 6. 会话

状态：`starting → running ⇄ waiting_permission → idle → running …`；进程退出为 `exited`（正常、强停）或 `failed`（异常退出码）。本机程序重启时，上次还活着的会话一律记为 `exited`，再发一句话就 `--resume` 续上。会话 id 同时是 Claude Code 的 `--session-id`。

开工请求可带 `role`（岗位）和专题的 `critics`（挑刺岗位，最多 3 个），进会话的方式见 ADR 0033；网页「说一句」带 `kind: "review"` 就是专题的评审会：本机替本人说一句，让会话同时调用挑刺子 agent、合成「分歧和建议」存成 kind = review 的一版（11/06 真跑 haiku 验证过并行和存版本）。

**同时跑的上限和队列（V2 设计 20.6，11/06）**：派活单点一次「开工」用 `POST /v1/sessions/batch` 把一批交给本机（最多 20 件，逐件给结果，开不了的那件不留记录）。同时最多跑 `maxConcurrent` 个（本机设置，默认 3，插件页可改）；占位置的是 starting、running、waiting_permission，一轮做完在等本人回复的 idle 不占。满了（或前面还有人在排）就进队，状态 `queued`（界面叫「等空位」），摘要里 `queuePosition` 是排第几；先来先跑，按进队先后（`queueOrder`，一批里同一毫秒的也分得清）。有空位就自动从队头接上：一轮做完、结束、失败、排队时取消、调大上限、托盘恢复、本机程序启动好以后都会接一次；暂停和关机时不接，暂停时也不收新开工。排着的「停下」「强停」都是取消（出队，不能再续）；排着的不能说一句。给已开工的会话说一句、续接已停下的会话不走队列（本人在网页上的直接操作），可能短暂超过上限。本机程序重启后，排着的照原样排着，刚从队里拉起、还没开始就断了的放回原位；有空位就接上，用新开（`--session-id`）不用续接。健康状态、本机状态、每一批同步载荷都带 `slots { max, running, queued }`；status 同步条目在 queued 时带 `queuePosition`，前面的走了就给还在排的每件重报新位置。计划事件和 plan 条目带 `progress`（第几步 / 共几步）。假 claude 测顺序、让位、取消、调上限、暂停、重启（`test/queue.test.ts`），真跑 haiku：上限 1、同时开 2 件，第 2 件排第 1，第 1 件这一轮做完马上接上（`.scratch/local-runner/实验/K_排队真跑结果.json`，两件共约 $0.002）。

卡和调研专题是同一种会话，只是 `subject.kind` 不同：卡要 `cardId` 和允许文件夹里的 `cwd`；专题要 `topicId`，不给 `cwd` 时用本机程序的专用目录 `topics/<topicId>/`。

**规划员和验收员（V2 设计第 21 节，11/06）**：拆卡和验收不在云端跑，在本人电脑上由本机程序拉起 Claude Code。会话种类加 `plan`（规划员）和 `verify`（验收员），和执行一样占位置；排队先后是验收员 → 规划员 → 执行（卡、专题），同一档先来先跑。
- 规划员：网页开（`subject: { kind: "plan", taskId }`，第一句话是云端的拆卡交代，`role` 是规划员岗位），不给 `cwd` 时用 `plans/<taskId>/`。它用本会话工具 `propose_plan` 交计划（几步、先后、风险）和派活单草稿（每件的交代、完成标准、对约定第几条、岗位名、模型档位），经发件箱同步 `card_plan`；改了再交 `revision` +1。
- 验收员：网页不能开。执行方 `hand_back` 以后本机自己起（不经云端）：先排着（`subject: { kind: "verify", cardId, handbackKey }`），等交回条目被云端收下，再向云端取验收交代（`GET /api/local-runner/verify-brief?handbackKey=…`：第一句话、交回时的完成标准、验收员岗位、之前连续没过几次）。取不到（没连天枢、断网、天枢出错）就排着，不挡别人，事件流里用 `notice`（`verify_waiting`）说在等什么，发件箱送出东西（连上天枢时会先把交回送上去）、本机程序启动后、每 15 秒都会再取；云端回 404（没有这次交回）不验，409（已有结论）不用验。拿到交代后按验收员岗位的档位挑模型（和网页一样按模型名认：opus 强、sonnet 普通、haiku/flash/mini/lite 轻，认不出用默认的；没配岗位用普通档），所以可以和执行用的模型不同。它用 `submit_verdict` 逐条判（条数照交代、只交一次），经发件箱同步 `verdict`；一轮做完没交就提醒一次；交完就让 Claude Code 自己退出（`exited`，原因「验收完了」），本人想问它，说一句会续上。
- 规划员、验收员只读：`--disallowedTools` 加 Edit、MultiEdit、Write、NotebookEdit、Bash、PowerShell，子 agent（Agent、Task）也不给，免得绕过。没用 Claude Code 的 plan 模式：plan 模式会让模型走「出计划、请求退出」那一套，和交结论的工具不合。
- 没过怎么办：验收会话和被验的卡的会话里各记一条 `verdict` 事件（结论、算上这次连续没过几次 `failStreak`、`blocked`、改法 `returnText`，改法的格式和云端 `cardAcceptance.ts` 的一样）。网页在卡的会话里看到没过又没受阻，就把改法经「说一句」送回执行会话（原来的那条路：空闲时开新一轮，已退出时续上）；执行方改完再交回，本机再起一个验收员。连续第二次没过 `blocked = true`，停在「受阻」等本人。
- 天枢 MCP 的 `get_task_context`（Task、约定、Mission、近期的事和决定、上一版交付物和评审，带出处；云端在做）预先放行；挂不挂天枢 MCP 仍按岗位的工具名单。
- 假 claude 测三种会话的参数和排队先后、交回后自动起验收、只读、没过送回再验、第二次受阻、取不到交代时排着等、重启后照样排着（`test/planVerify.test.ts`）；真跑见第 13 节。

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
| `propose_plan` | 规划员 | 交计划（summary、steps、risks）和派活单（1–8 件：title、brief、doneDefinition、criterionIndex、role、modelTier、why），经发件箱同步 `card_plan`；改了再交是新的一次 |
| `submit_verdict` | 验收员 | 每条完成标准判一次（met/partial/unmet、理由、依据、怎么补）、beyondScope、一句结论；只交一次，经发件箱同步 `verdict`，同时在被验的卡的会话里记一条结论事件 |

用 HTTP 而不是 stdio，是为了不给每个会话再起一个 150 MB 的本机程序进程。真机实测：Claude Code（haiku）经 ToolSearch 找到这几个工具，调用不弹权限，产出物和交回进了发件箱。

## 8. 云端同步（本机 → 云端，单向）

- `POST {apiBaseUrl}/api/local-runner/sync`，`Authorization: Bearer <个人令牌>`，体 `LocalSyncBatchRequest`（≤50 条、≤12 MB），回 `LocalSyncBatchResponse`。
- 条目：`status`（状态变化）、`plan`（TodoWrite）、`evidence`、`artifact`（原文 base64）、`handback`（带 `outputKeys`：点名的产出和证据的条目幂等键，云端存成 `local_outputs.client_id`）、`topic_version`（专题新的一版：号、种类、名字或 null、改了什么、Markdown 正文）、`topic_version_feishu`（第几版已存进飞书、地址）、`card_plan`（规划员的计划和派活单草稿）、`verdict`（验收员的逐条结论，subject 带 cardId 和 handbackKey）、`cost`（每轮增量）。规划员、验收员的 status、plan、cost 条目 subject.kind 是 plan / verify，云端不能当成卡自己的状态。不传仓库文件、完整工具输出、环境变量、钥匙。
- 幂等键 `<deviceId>:<sessionId>:<本会话同步序号>`。云端按键去重，重复的也回 `accepted`；`rejected` 的本机记一笔后出队；回执里没提到的、网络错、5xx 都退避重试（1 s × 2^n，最长 5 分钟）。发件箱先落盘（`outbox.json`），断网、重启都不丢。
- 关联：网页 `PUT /v1/cloud` 交 `apiBaseUrl` 和令牌；`apiBaseUrl` 的来源必须在白名单里，免得被指到别处。这个令牌同时用于会话里的天枢 MCP（第 7 节）。**建议 api 会话**给个人令牌加一种 `local` 客户端：能调 `/api/local-runner/*` 和 `/mcp/me`，网页配对后建一个这种令牌交给本机程序，设置页能看到、能吊销。

## 9. 模型

- 内置 `subscription`：用本人 Claude Code 的登录，不设任何模型环境变量。也可以加「订阅 + 指定模型」的配置（如 haiku、sonnet、opus）。
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
