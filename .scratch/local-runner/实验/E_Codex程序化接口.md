# 天枢本机程序接 Codex CLI：协议调研结论

- 调研对象：`codex-cli 0.159.2`（Windows，npm 全局安装）
- 日期：2026-11-06
- 范围：只调研协议，不写适配器代码。
- 真实模型调用：**0 次**。所有事件流都是让 Codex 连到本机 `127.0.0.1:18555` 上一个假的 Responses API 网关（`fake-gw.mjs`）观察到的。网关脚本化地返回文字、命令调用、补丁调用和慢速流式输出。
- 唯一一次外网请求：在空的 `CODEX_HOME` 下跑 `codex exec` 看未登录表现。它对 `api.openai.com` 发了约 12 次不带凭据的请求，全部返回 401，没有消耗模型额度。
- 本人的 `C:\Users\10021\.codex\`：`auth.json` 和 `config.toml` 的修改时间前后一致，没有写入。每次启动 codex 都会在 `tmp/arg0/` 下自动生成运行时辅助目录，这次跑的 `codex --help` 和 `codex login status` 可能也生成了一个，那不是配置文件。

## 0. 一句话结论

**12 月的适配器应接 `codex app-server`。** 它是 stdio 上的 JSONL，格式是 JSON-RPC 2.0，只是省略了 `"jsonrpc"` 字段。我们要的五件事它全部原生支持：

| 能力 | 怎么做 |
|---|---|
| 事件流 | `item/*`、`turn/*`、`thread/tokenUsage/updated` |
| 插话 | `turn/steer` |
| 停下 | `turn/interrupt`，之后会话还能继续用 |
| 批权限 | 服务端向客户端发 `item/commandExecution/requestApproval` 和 `item/fileChange/requestApproval` 请求，客户端回复决定 |
| 续接 | `thread/resume`，换一个进程也能续 |

`codex exec --json` 只适合一次性跑批：没有批权限通道，不能插话，停下只能杀进程。`codex mcp-server` 和 `codex proto` 在这个版本已经没有了。

和 Claude Code 的主要差别：

| 方面 | Claude Code | Codex |
|---|---|---|
| 协议 | 自定义 stream-json | 请求/响应/通知三类 JSON-RPC |
| 批准时附理由 | 可以 | 决定里**不能附理由**，要用 steer 补一句 |
| 自建网关协议 | Messages API | **只支持 Responses API**（`wire_api = "responses"` 是唯一取值） |
| 花费 | 有 | 只有 token 数，**没有金额** |

---

## 1. 程序化入口

### 1.1 入口一览

| 入口 | 结论 | 证据 |
|---|---|---|
| `codex app-server`（默认 `--listen stdio://`） | **推荐**。双向 JSON-RPC，按行分隔 JSON。另有 `unix://`、`ws://`（实验性，官方说不受支持）、`off` 三种传输 | `codex app-server --help`；官方文档 [App Server · Protocol](https://learn.chatgpt.com/docs/app-server)（原 developers.openai.com/codex/app-server 已 308 跳转到这里），原文：「`stdio` (`--listen stdio://`, default): newline-delimited JSON (JSONL)」；本机实测全流程见 `app-basic.jsonl` |
| `codex exec --json` | 输出 JSONL 事件，适合跑批。实测**没有文字增量**：助手文本只在 `item.completed` 里整段出现。需要批准的动作会被自动拒绝，没有批准通道，也不能插话 | 实测 `exec-ping.jsonl`。`RUN` 场景里模型的命令被直接拒绝，模型收到 `exec_command failed: ... Rejected(...)` |
| `codex exec resume <SESSION_ID> [PROMPT]` | 按 id 续接，可以加 `--json`。实测换进程后把历史带上了：网关收到的 input 里有上一轮的问答 | `codex exec resume --help`；实测 |
| `codex mcp-server` | **已移除**。官方 SDK 文档原文：「The `codex mcp-server` command and standalone `codex-mcp-server` binary have been removed. Use the Codex app server」 | [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)；本机执行 `codex mcp-server --help` 会落到主命令的帮助 |
| `codex proto` | 不存在，同样落到主命令的帮助 | 实测 |
| `codex app-server daemon …`、`remote-control`、`agents`、`queue` | 共享的后台 app-server 守护进程和远程控制。**本机程序不要用**，按会话自己起 stdio 进程才隔离 | `--help` |
| `codex app-server generate-ts` / `generate-json-schema` | 生成**与当前 CLI 版本精确对应**的协议类型。加 `--experimental` 会包含实验方法 | 已生成到 `ts/`（96 个顶层文件，`v2/` 下 639 个）、`ts-exp/`、`schema/` |
| TS SDK `@openai/codex-sdk`、Python SDK `openai-codex` | 官方封装。Python 版明确走 app-server。TS 版文档只展示了 `startThread/run/resumeThread`，本次**未验证**它能否批权限或插话 | [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) |

### 1.2 app-server 线协议要点（实测加文档）

**握手。** 先发 `initialize`，再发 `initialized` 通知，之后才能调其他方法。没握手就调用会报 `Not initialized`，重复握手会报 `Already initialized`。

```json
>> {"id":1,"method":"initialize","params":{"clientInfo":{"name":"tianshu_local_probe","title":"Tianshu probe","version":"0.0.1"},"capabilities":{"experimentalApi":false}}}
<< {"id":1,"result":{"userAgent":"tianshu_local_probe/0.159.2 (Windows ...)","codexHome":"...\\exp-codex\\home","platformFamily":"windows","platformOs":"windows"}}
>> {"method":"initialized","params":{}}
```

**三类消息怎么区分。**
- 同时带 `id` 和 `method`：服务端发来的请求，例如批准请求。
- 只带 `id`：对我们某个请求的响应。
- 只带 `method`：通知。

**服务端请求的 id 是它自己的序列，从 0 开始**（实测 `[id 0] item/commandExecution/requestApproval`），和我们发出的 id 可能重号。按上面三条判别，不能只看 id。

**`experimentalApi`。** 设成 `false` 就停在稳定接口上。`turn/steer`、`turn/interrupt`、`thread/resume` 和两种批准请求都在**稳定**的 `ClientRequest.ts` / `ServerRequest.ts` 里，不需要打开实验开关。

**其他：**
- stderr 是带 ANSI 颜色的 tracing 日志，只记录，不解析。
- 关掉 stdin，进程自己以退出码 0 退出（实测 `EXIT 0`）。
- Windows 上的 `codex` 是 `.cmd` 外壳。宿主程序应直接 spawn `node <npm>/@openai/codex/bin/codex.js`，或者那个包下的原生 `codex.exe`。本机原生文件在 `...\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`。

**生成的类型里的关键定义**（`ts/ClientRequest.ts` 抽出的 method，节选）：

```
initialize, thread/start, thread/resume, thread/fork, thread/read, thread/turns/list, thread/items/list,
turn/start, turn/steer, turn/interrupt, model/list, account/read, account/login/start,
account/login/cancel, account/logout, account/rateLimits/read, account/usage/read, config/read ...
```

`ServerRequest.ts`（服务端发给客户端，等我们回复）：

```
item/commandExecution/requestApproval, item/fileChange/requestApproval, item/tool/requestUserInput,
mcpServer/elicitation/request, item/permissions/requestApproval, item/tool/call,
account/chatgptAuthTokens/refresh, attestation/generate, applyPatchApproval(旧), execCommandApproval(旧)
```

`ServerNotification.ts`（与本次相关的部分）：

```
thread/started, thread/status/changed, turn/started, turn/completed, turn/plan/updated, turn/diff/updated,
item/started, item/completed, item/agentMessage/delta, item/reasoning/summaryTextDelta, item/plan/delta,
item/commandExecution/outputDelta, serverRequest/resolved, thread/tokenUsage/updated,
account/rateLimits/updated, account/login/completed, account/updated, mcpServer/startupStatus/updated,
error, warning, configWarning, model/rerouted
```

---

## 2. 五件事逐条对照

### 2.1 事件流

**结论：** 用 app-server，步骤如下。

1. `thread/start` 开线程，拿到 `thread.id`（UUIDv7）。
2. `turn/start` 开一轮。响应里**立刻**带回 `turn.id`，状态是 `inProgress`。
3. 之后按下面的顺序收通知（实测）：

```
turn/start 响应 {turn:{id, status:"inProgress"}}
thread/status/changed {type:"active", activeFlags:[]}
turn/started
item/started {userMessage} → item/completed {userMessage}
item/started {agentMessage, text:""}
item/agentMessage/delta {itemId, delta} × N         ← 逐段助手文本
item/completed {agentMessage, text:"完整文本", phase}
thread/tokenUsage/updated {tokenUsage:{total,last,modelContextWindow}}
account/rateLimits/updated                           ← 每次模型响应后都会来一条（订阅额度）
thread/status/changed {type:"idle"}
turn/completed {turn:{id, status:"completed"|"interrupted"|"failed", error, durationMs}}
```

**工具调用**都是 `ThreadItem` 联合类型的一个成员（`v2/ThreadItem.ts`）：

| 类型 | 关键字段 |
|---|---|
| `commandExecution` | `command`、`cwd`、`commandActions`（解析后的命令，适合展示）、`status`、`aggregatedOutput`、`exitCode`、`durationMs`。输出增量走 `item/commandExecution/outputDelta` |
| `fileChange` | `changes:[{path, kind:{type:add\|delete\|update}, diff}]`、`status`。整轮累积的 diff 走 `turn/diff/updated` |
| `mcpToolCall` | `server`、`tool`、`arguments`、`result`、`error` |
| 其他 | `webSearch`、`dynamicToolCall`、`reasoning`、`plan`、`contextCompaction` 等 |

状态枚举：`CommandExecutionStatus` 和 `PatchApplyStatus` 都是 `"inProgress" | "completed" | "failed" | "declined"`。

**计划：** `turn/plan/updated {explanation, plan:[{step, status: pending|inProgress|completed}]}`。

**用量：** `thread/tokenUsage/updated`，定义来自 `v2/ThreadTokenUsage.ts` 和 `v2/TokenUsageBreakdown.ts`：

```ts
ThreadTokenUsage = { total: TokenUsageBreakdown, last: TokenUsageBreakdown, modelContextWindow: number | null }
TokenUsageBreakdown = { totalTokens, inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens }
```

**整个协议里没有金额字段**，花费要由天枢按 token 数和价格自己算。`account/usage/read` 只给 ChatGPT 订阅的 token 统计，用 API key 时不可用。`turn/completed` 里不带用量，用量只在 `thread/tokenUsage/updated` 里；`exec --json` 则在 `turn.completed.usage` 里带。

**一轮结束：** 收到 `turn/completed` 就算结束。之前出现的 `error` 通知如果带 `willRetry:true`，说明服务端会重试，这一轮还没结束。

**实测发现的坑：**
- **被中断的那条 `agentMessage` 只有 `item/started` 和若干 delta，收不到 `item/completed`。** 证据：`app-basic.jsonl` 里 `msg_10` 共出现 7 次，都是 started 或 delta。
- 等待批准时被中断，那条 `commandExecution` 同样收不到 `item/completed`，只会来一条 `serverRequest/resolved` 表示请求已清理。
- 所以适配器必须在 `turn/completed` 时，把还没关闭的 item 按「被中断」统一收尾。
- 每一轮都会发一条 `warning`：「Model metadata for `fake-model` not found…」（见 3.4）。

### 2.2 插话：`turn/steer`（稳定接口）

```ts
// v2/TurnSteerParams.ts
TurnSteerParams = { threadId, clientUserMessageId?, input: UserInput[], expectedTurnId: string }
TurnSteerResponse = { turnId }
```

实测结果：

| 情况 | 结果 |
|---|---|
| 正常插话 | 成功，返回当前 `turnId`，不会产生新的 `turn/started` |
| `expectedTurnId` 不对 | `{"code":-32600,"message":"expected active turn id `nope` but found `01a1…`"}` |
| 当前没有进行中的一轮 | `{"code":-32600,"message":"no active turn to steer"}` |

**插话什么时候生效（重要）：** 插话不会打断正在流式输出的那次模型响应。它会排队，等这次响应结束后，作为一条 `userMessage` item 插进**同一轮**，然后模型再采样一次。

实测时间线（`app-basic.summary.txt`）：
- 5571 ms 发出 steer。
- 当前回复一直流到 10260 ms 才结束。
- 10350 ms 出现 `userMessage "插话：换个说法"`，接着同一轮内模型再回复一次。
- 网关那边的第 9 次请求末尾正是 `[assistant 慢慢说…, user 插话：换个说法]`。

如果要「立刻改口」，就先 `turn/interrupt` 再开一轮 `turn/start`。

**另一个坑：** 一轮进行中再调 `turn/start`，不会报错，而是**返回同一个进行中的 turn id，效果等同于 steer**。实测：第七轮期间再发 `turn/start`，返回的 id 和正在跑的那轮相同，消息排在那轮之后。类型注释里也写了「Ignored when this request steers an already-active turn」。适配器在有进行中的一轮时应显式调 `turn/steer`。

### 2.3 停下：`turn/interrupt`

```ts
TurnInterruptParams = { threadId, turnId }   // 响应 {}
```

实测：发出后约 80 ms 收到 `{}`，随后 `turn/completed status:"interrupted"`，`error:null`。

**会话可以继续用：**
- 紧接着 `turn/start "PING 中断后还能用吗"` 正常完成。
- Codex 会在历史里自动插一条 `<turn_aborted> The user interrupted the previous turn on purpose…` 的 user 消息，网关第 11 次请求可以看到。

**正在等批准时中断也可以：** 这一轮变成 `interrupted`，挂着的那个批准请求收到 `serverRequest/resolved`，之后不用再回复它。

**批准里回 `cancel`** 等于「拒绝并中断这一轮」：实测 item 变成 `declined`，这一轮变成 `interrupted`。

### 2.4 批权限

**消息顺序**（实测，和官方文档的 Approvals 一节一致）：

```
item/started {commandExecution|fileChange, status:"inProgress"}
thread/status/changed {active, activeFlags:["waitingOnApproval"]}
[server→client 请求] item/commandExecution/requestApproval 或 item/fileChange/requestApproval
→ 客户端回复 {decision}
serverRequest/resolved {threadId, requestId}
item/completed {status: completed|failed|declined}
```

**命令批准的请求参数**（`v2/CommandExecutionRequestApprovalParams.ts`）：

```ts
{ kind:"command"|"writeStdin", threadId, turnId, itemId, startedAtMs, approvalId?, environmentId,
  reason?, networkApprovalContext?, command?, cwd?, commandActions?, proposedExecpolicyAmendment?,
  proposedNetworkPolicyAmendments? }
```

实测请求里还带了一个 `availableDecisions` 字段：

```json
"availableDecisions":["accept",{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["…pwsh.exe","-Command","echo codex-probe > probe.txt"]}},"cancel"]
```

Windows 上命令被包成 `"…\pwsh.exe" -Command '…'`。界面上应展示 `commandActions[].command`。

**决定的取值：**

```ts
// v2/CommandExecutionApprovalDecision.ts
"accept" | "acceptForSession" | {acceptWithExecpolicyAmendment:{execpolicy_amendment}} | {applyNetworkPolicyAmendment:{…}} | "decline" | "cancel"
// v2/FileChangeApprovalDecision.ts
"accept" | "acceptForSession" | "decline" | "cancel"
// FileChangeRequestApprovalParams = { threadId, turnId, itemId, startedAtMs, reason?, grantRoot? }
```

**实测结果：**

| 回复 | 结果 |
|---|---|
| `decline` | item 变成 `declined`。模型收到 `exec_command failed: CreateProcess { message: "Rejected(\"rejected by user\")" }`，补丁则是 `patch rejected by user`。**这一轮继续** |
| `accept` | 命令执行，`exitCode 0`；补丁写入，文件 `work/patched-3.txt` 和 `patched-5.txt` 已生成 |
| `acceptForSession`（补丁） | 这次通过了，但**同一会话里下一个新文件的补丁仍然要批**。推测「本会话允许」只覆盖相同路径或范围，未深挖 |
| `cancel` | 拒绝，并且整轮 `interrupted` |

注意：`availableDecisions` 里没列 `decline`，但回 `decline` 照样被接受。适配器应**以 `availableDecisions` 为准渲染按钮**，同时保留「拒绝」。

**能不能附理由：不能。** 两种决定类型里都没有理由字段。

**替代做法（已实测可行）：** 收到批准请求后，**先**调 `turn/steer` 发一句「拒绝理由：…」，**再**回 `decline`。模型看到的顺序是：被拒的工具结果，然后是理由那条 user 消息，并且在同一轮里接着处理。证据：`app-patch` 场景 A，`serverRequest/resolved` 后紧跟 `userMessage "拒绝理由：不要新建文件"`。

**其他服务端请求，适配器也应接住：**

| 请求 | 回复方式 |
|---|---|
| `item/permissions/requestApproval`（模型要额外权限） | 回 `{permissions:<授予的子集>, scope:"turn"\|"session"}` |
| `item/tool/requestUserInput`（模型提问） | 回答内容 |
| `mcpServer/elicitation/request` | `{action:"accept"\|"decline"\|"cancel", content}` |

不回复的话这一轮会一直挂着，处于 `waitingOnApproval`。

**什么时候会弹批准：** 由 `approvalPolicy` 和 `sandbox` 决定，二者可以在 `thread/start` 或 `turn/start` 上按线程或按轮设置。

| approvalPolicy | 含义 |
|---|---|
| `untrusted` | 非白名单命令都要批 |
| `on-request` | 越出沙箱时要批 |
| `never` | 不批 |
| `{granular:{…}}` | 细粒度配置 |

- 实测 `untrusted + workspace-write`：命令要批。
- 实测 `on-request + read-only`：补丁和命令都要批。
- `approvalsReviewer:"auto_review"` 会让 Codex 自己的审查代理代批，天枢不要用。

### 2.5 续接

`thread/resume {threadId, excludeTurns:true}`，之后正常 `turn/start`。历史可以用 `thread/turns/list` 或 `thread/items/list` 分页读取。

实测：
- 新起一个 app-server 进程，续接上一轮的线程 `01a1acda-…`，第一轮请求就把 33 条历史发给了网关（`app-resume.jsonl`）。
- `thread/turns/list` 返回最近几轮。

限制：
- 线程持久化在 `CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`，路径见 `thread.path`。`thread/start {ephemeral:true}` 不落盘，也就**不能续接**。
- **必须用同一个模型提供方续接。** 官方文档：提供方不一致时返回 `-32600`，`data.type` 为 `modelProviderMismatch`；要换提供方得用 `thread/fork`。所以天枢的会话记录要存 `threadId + providerId + codexHome`。
- `exec` 场景对应 `codex exec resume <id> "prompt"`，实测可用。

---

## 3. 每个进程单独配模型（不改 `~/.codex/config.toml`）

### 3.1 实测可用的组合（推荐）

在 app-server 的命令行上用 `-c` 定义提供方，钥匙只放在**子进程的环境变量**里：

```
codex app-server
  -c model_provider="tsgw"
  -c model="<模型名>"
  -c model_providers.tsgw.name="tianshu-gw"
  -c model_providers.tsgw.base_url="http://<网关>/v1"
  -c model_providers.tsgw.env_key="TS_GW_KEY"           # 钥匙只放在 env，不进命令行
  -c model_providers.tsgw.wire_api="responses"
  -c model_providers.tsgw.supports_websockets=false     # 否则可能先试 wss
  -c model_providers.tsgw.request_max_retries=0          # 可选：网关错误时尽快失败
  -c model_providers.tsgw.stream_max_retries=0
env: TS_GW_KEY=<钥匙>, CODEX_HOME=<天枢专用目录>
```

网关日志实测：
- 请求是 `POST /v1/responses`，`authorization` 为 `Bearer <钥匙>`（日志里只记了「与预期一致：true」）。
- 请求体 `stream:true`、`store:false`，`model` 就是 `-c model` 给的值。
- 额外请求头：`x-codex-beta-features`、`x-codex-window-id`、`x-codex-turn-metadata`、`x-client-request-id`、`session-id`、`thread-id`、`originator`。
- 用自定义提供方时，`account/read` 返回 `{"account":null,"requiresOpenaiAuth":false}`，**不需要登录 OpenAI 或 ChatGPT**。

### 3.2 要 Responses API 还是 Chat Completions？

**只能用 Responses API。** 官方配置参考中 `model_providers.<id>.wire_api` 一项写的是：「`responses` is the only supported value, and it is the default when omitted.」见 [Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference)。

自建的 OpenAI 兼容网关必须实现 `POST {base_url}/responses`，并且用 SSE 流式返回。实测 Codex 能正常消费这些事件：

- `response.created`
- `response.output_item.added` / `.done`
- `response.output_text.delta`
- `response.function_call_arguments.delta`
- `response.completed`，`response.usage` 里带 `input_tokens`、`input_tokens_details.cached_tokens`、`output_tokens` 等

工具调用会以 `function_call`（`exec_command`）和 `custom_tool_call`（`apply_patch`，自由格式）两种形式出现在模型输出里，结果以 `function_call_output` / `custom_tool_call_output` 回传。网关如果后接的是只支持 Chat Completions 的模型，就要在网关里做 Responses 和 Chat 之间的转换，**包括 custom 工具**。

### 3.3 其他方式及取舍

| 方式 | 说明 | 取舍 |
|---|---|---|
| `-c` 命令行覆盖 | 实测可用，只对这个进程生效 | **推荐** |
| `thread/start` / `turn/start` 的 `model`、`modelProvider`、`config` 参数 | 可以按线程换模型。`config` 是任意 JSON | 提供方定义（`model_providers.*`）放在进程级更稳。按线程定义提供方本次**没测** |
| `--profile name` | 叠加读取 `$CODEX_HOME/name.config.toml` | 要往 CODEX_HOME 里写文件。用天枢专用的 CODEX_HOME 时可行 |
| `CODEX_HOME=<独立目录>` 加该目录下的 `config.toml` | 完全隔离 | 见第 5 节。缺点是 ChatGPT 登录也跟着隔离 |
| `experimental_bearer_token` | 钥匙会出现在进程命令行里，官方也说 discouraged | 不用 |
| `[model_providers.<id>.auth] command=…` | 命令式凭据，每次要令牌时运行一个命令拿 | 可以让它去本机程序取短期令牌，适合以后做令牌轮换 |
| `openai_base_url` | 只能改内置 openai 提供方的地址 | 不能用来接自建提供方的钥匙，不推荐 |
| `CODEX_API_KEY` 环境变量 | 只对 exec、review、SDK 生效（官方 non-interactive 文档） | 只适用于官方 OpenAI 地址 |

### 3.4 自建模型名的大坑：模型元数据

`codex debug models` 能列出内置目录，本机 11 个，例如 `gpt-5.5`、`gpt-6.1-sol`。目录里的 `apply_patch_tool_type` 和 `shell_type` 决定给模型哪些工具。

**模型名不在目录里时**（实测 `fake-model`）：
- 每一轮都会发 `warning`：「Model metadata … not found. Defaulting to fallback metadata」。
- **不给 `apply_patch` 工具**。模型想改文件只能走 shell，改文件的批准事件也就变成命令批准。
- 网关第 1 次请求里的工具清单：`exec_command, write_stdin, request_user_input, view_image, multi_agent_v1, get_goal, create_goal, update_goal, web_search`。

**模型名在目录里时**（实测 `gpt-5.5`）有 `apply_patch`，`fileChange` 批准正常。

对策：
- 用 `model_catalog_json=<路径>` 提供自建模型的元数据。官方配置参考：「Optional path to a JSON model catalog loaded on startup」。格式可以照 `codex debug models` 的输出写。
- 或者让网关接受 Codex 已知的模型名再映射。这条只是方案，**未验证**是否会触发 OpenAI 专属行为。

---

## 4. 登录（本人 ChatGPT 订阅）

**检测：**
- `codex login status`：已登录时输出 `Logged in using ChatGPT`，退出码 0；没登录时输出 `Not logged in`，**退出码 1**。都实测过：本人默认目录是只读调用，临时目录是空目录。
- app-server：`account/read {refreshToken:false}` 返回 `{account:{type:"chatgpt",email,planType}|{type:"apiKey"}|null, requiresOpenaiAuth}`。

**登录：**
- CLI `codex login`：浏览器流程，本机回调端口 `localhost:1455`。另有 `--device-auth`（设备码），以及 `--with-api-key` / `--with-access-token`（从 stdin 读）。
- **app-server 代为拉起（实测）：**
  - `account/login/start {type:"chatgpt"}` 立刻返回 `{type:"chatgpt", loginId, authUrl:"https://auth.openai.com/oauth/authorize?…"}`，app-server 自己在 1455 端口起回调服务（实测期间 1455 端口有连接）。
  - 宿主程序把 `authUrl` 在用户浏览器里打开，用户点完后收到 `account/login/completed {loginId, success, error}` 和 `account/updated {authMode, planType}`。
  - `account/login/cancel {loginId}` 返回 `{status:"canceled"}`，随后收到 `completed success:false`。
  - **结论：可以由本机程序代为拉起，用户只需要在浏览器里点。**
  - 另有设备码流程 `type:"chatgptDeviceCode"`，返回 `verificationUrl + userCode`，适合回调端口被占用的情况。
- 令牌保存在 `CODEX_HOME/auth.json`，或系统钥匙串（`cli_auth_credentials_store = file|keyring|auto|ephemeral`）。所以**换一个 CODEX_HOME 就等于换一套登录**。

**未登录时的表现（实测）：** `exec` 不会马上失败，会先重试 wss 和 https 各约 5 次，大约 40 秒后才 `turn.failed 401`。宿主程序**必须先做登录检查**（`login status` 或 `account/read`），再开会话。

**合规提醒（需要明华或用户判断）：** 官方 App Server 文档 Auth 一节写道：「App-server authentication has never been permitted for commercial or hosted services.」并推荐「Sign in with ChatGPT」方案。天枢是在员工本机、用员工自己的订阅，不算托管服务，但对外商用前要确认这一条。

---

## 5. 干净会话（对标 `--setting-sources project,local --strict-mcp-config`）

在 `home-dirty`（模拟本人全局配置：全局 AGENTS.md、一个全局 MCP、一个 hook）和 `work2`（项目 AGENTS.md，加一个只放在项目 `.codex/config.toml` 里的 MCP）上做了对照，结果来自 `thread/start` 返回的 `instructionSources`、`mcpServer/startupStatus/updated` 通知和网关收到的请求：

| 配置 | 全局 AGENTS.md | 项目 AGENTS.md | 全局 MCP | 项目 `.codex` 里的 MCP |
|---|---|---|---|---|
| 本人式 CODEX_HOME，不加参数 | 加载 | 加载 | 启动（失败） | **不加载**（项目未受信任） |
| 同上，加 `-c project_doc_max_bytes=0 -c mcp_servers.dummyglobal.enabled=false --disable hooks -c skills.bundled.enabled=false -c plugins._default.enabled=false` | **仍加载**（网关能看到全局标记文字） | 不加载 | 不启动 | 不加载 |
| 天枢专用的空 CODEX_HOME | 无 | 加载 | 无 | 不加载 |
| 专用 CODEX_HOME 加 `-c project_doc_max_bytes=0` | 无 | 不加载（`instructionSources:[]`） | 无 | 不加载 |

结论：
1. **`CODEX_HOME` 指向天枢专用目录**是唯一能一次性排除本人全局配置的办法：`config.toml`、全局 `AGENTS.md`、MCP、hooks、skills、plugins、记忆。**app-server 没有 `--ignore-user-config`**，实测报 `unexpected argument`。`codex exec` 有这个参数（「auth still uses CODEX_HOME」），但它不跳过全局 AGENTS.md，这一点本次没测。
2. 项目里的 `.codex/config.toml` 和项目级 hooks 只在项目被信任（`projects.<path>.trust_level="trusted"`）时加载。专用 CODEX_HOME 里没有信任记录，所以默认不加载，这相当于 `--setting-sources` 不含 project。
3. 项目 `AGENTS.md` 要不要带是产品决定：带上就什么都不加；不带就加 `-c project_doc_max_bytes=0`。注意 **`project_doc_max_bytes=0` 挡不住 `$CODEX_HOME/AGENTS.md`**。
4. 这次的配置里没观察到 hook 执行的通知，推测用户级 hook 需要持久化信任（CLI 有 `--dangerously-bypass-hook-trust`）。稳妥起见一律加 `--disable hooks`。
5. 自带技能清单（`<skills_instructions>`）即使设了 `skills.bundled.enabled=false` 仍出现在开发者消息里，影响不大。要更精简可以再查 `skills.include_instructions`，本次没测。

**这里有一个取舍要拍板：**

| 方案 | 做法 | 好处 | 代价 |
|---|---|---|---|
| **A（推荐）** | 天枢专用 CODEX_HOME（例如 `%LOCALAPPDATA%\Tianshu\codex-home`），用户在天枢里用 `account/login/start` 再登录一次 ChatGPT | 完全干净；会话历史也和本人的 Codex 分开 | 要登录两次 |
| B | 沿用本人 `~/.codex`，复用订阅登录，逐项关掉：用 `codex mcp list --json` 读出 MCP 名字逐个设 `enabled=false`，加 `--disable hooks`、`plugins._default.enabled=false`、`project_doc_max_bytes=0` | 不用再登录 | **全局 AGENTS.md 没有已验证的关闭开关**；会话会混进本人的 Codex 历史；本人以后加的新配置会漏网 |
| 不推荐 | 复制 `auth.json` 到专用目录 | — | 两边各自刷新令牌会冲突，等于共享令牌 |

---

## 6. TypeScript 适配器接口建议

### 6.1 进程与会话模型

- **一个 Codex 会话对应一个 `codex app-server` 子进程。** 和现在每个 Claude Code 进程单独配模型的做法对齐，坏了也只影响一个会话。
- 一个进程里也能开多个 thread，但提供方是进程级配置，所以按「每个进程固定一个提供方」处理。
- spawn 参数：原生 `codex.exe app-server` 加第 3 节的 `-c` 参数，按需加 `--disable hooks`、`-c project_doc_max_bytes=0`。
- 环境变量：`{CODEX_HOME: 天枢专用目录, TS_GW_KEY: 钥匙}`。stdin 和 stdout 走 JSONL；stderr 只进日志，日志里注意打码。

```ts
export type AgentEngine = 'claude-code' | 'codex';

export interface StartOptions {
  sessionKey: string;                 // 天枢自己的会话 id
  cwd: string;
  resumeThreadId?: string;            // 有就 thread/resume，没有就 thread/start
  provider:
    | { kind: 'subscription' }        // ChatGPT 登录（专用 CODEX_HOME 内）
    | { kind: 'gateway'; baseUrl: string; apiKeyEnv: string; apiKey: string; model: string; modelCatalogPath?: string };
  approvalPolicy: 'untrusted' | 'on-request' | 'never';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  loadProjectInstructions: boolean;   // false → -c project_doc_max_bytes=0
  developerInstructions?: string;     // thread/start.developerInstructions
}

export type PermissionDecision =
  | { kind: 'allow' }                 // accept
  | { kind: 'allow_session' }         // acceptForSession（只有 availableDecisions 包含它时才显示）
  | { kind: 'deny'; reason?: string } // 先 turn/steer(reason)，再回 decline
  | { kind: 'deny_and_stop' };        // cancel（拒绝并中断这一轮）

export interface AgentSession {
  readonly engine: AgentEngine;
  readonly threadId: string | null;
  start(opts: StartOptions): Promise<{ threadId: string }>;
  /** 空闲时 turn/start；有进行中的一轮时 turn/steer(expectedTurnId=当前轮) */
  send(text: string, opts?: { images?: string[] }): Promise<{ turnId: string; steered: boolean }>;
  interrupt(): Promise<void>;                                    // turn/interrupt
  respondPermission(requestId: string, d: PermissionDecision): Promise<void>;
  close(): Promise<void>;                                        // 关 stdin，等退出，超时再 kill
  on(listener: (e: NormalizedEvent) => void): () => void;
}

export type NormalizedEvent =
  | { type: 'session_started'; threadId: string; model: string; provider: string; instructionSources: string[] }
  | { type: 'turn_started'; turnId: string }
  | { type: 'assistant_text'; turnId: string; itemId: string; delta?: string; final?: string; phase?: string | null }
  | { type: 'reasoning'; turnId: string; itemId: string; delta: string }
  | { type: 'plan'; turnId: string; steps: { step: string; status: 'pending' | 'inProgress' | 'completed' }[]; explanation?: string | null }
  | { type: 'tool_call'; turnId: string; callId: string; tool: 'command' | 'file_change' | 'mcp' | 'web_search' | 'other'; display: string; raw: unknown }
  | { type: 'tool_output_delta'; turnId: string; callId: string; delta: string }
  | { type: 'tool_result'; turnId: string; callId: string; status: 'completed' | 'failed' | 'declined' | 'interrupted'; output?: string; exitCode?: number | null; raw: unknown }
  | { type: 'permission_request'; requestId: string; turnId: string; callId: string; kind: 'command' | 'file_change' | 'permissions' | 'user_input' | 'mcp_elicitation'; summary: string; reason?: string | null; allowed: PermissionDecision['kind'][]; raw: unknown }
  | { type: 'permission_resolved'; requestId: string }
  | { type: 'usage'; turnId: string; last: TokenUsage; total: TokenUsage; contextWindow: number | null }
  | { type: 'turn_end'; turnId: string; status: 'completed' | 'interrupted' | 'failed'; error?: { message: string; code?: unknown } }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string; willRetry: boolean; code?: unknown; fatal: boolean };

type TokenUsage = { input: number; cachedInput: number; output: number; reasoningOutput: number; total: number };
```

### 6.2 Codex 事件到归一化事件的映射

| Codex（app-server） | 归一化 | 说明 |
|---|---|---|
| `thread/start` 或 `thread/resume` 的响应 | `session_started` | 取 `thread.id`、`model`、`modelProvider`、`instructionSources` |
| `turn/started` | `turn_started` | 以 `turn/start` 响应里的 `turn.id` 为准，这个 id 来得更早 |
| `item/agentMessage/delta` | `assistant_text{delta}` | 按 `itemId` 拼接 |
| `item/completed` 且 `type=agentMessage` | `assistant_text{final}` | 以 completed 为准；`phase` 可以是 commentary / final_answer |
| `item/reasoning/summaryTextDelta` | `reasoning` | 可选显示 |
| `turn/plan/updated` | `plan` | |
| `item/started`，类型为 commandExecution、fileChange、mcpToolCall、webSearch、dynamicToolCall | `tool_call` | `display`：命令取 `commandActions[].command`，补丁取 `changes[].path` |
| `item/commandExecution/outputDelta` | `tool_output_delta` | |
| `turn/diff/updated` | （另发 `diff` 事件，或附在 tool_result 上） | 整轮累积的 diff |
| 同上几类的 `item/completed` | `tool_result` | `status` 直接映射；`aggregatedOutput` 和 `exitCode` |
| 服务端请求 `item/commandExecution/requestApproval` | `permission_request{kind:'command'}` | `requestId` 等于 JSON-RPC 的 id（服务端序列）；`allowed` 由 `availableDecisions` 推出，加上 deny |
| 服务端请求 `item/fileChange/requestApproval` | `permission_request{kind:'file_change'}` | 补丁内容来自先前 `item/started` 的 `changes` |
| `item/permissions/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request` | `permission_request`（对应的 kind） | 回复格式各不相同 |
| `serverRequest/resolved` | `permission_resolved` | 网页上把对应的批准卡片收起 |
| `thread/tokenUsage/updated` | `usage` | 金额由天枢按价格表计算 |
| `turn/completed` | `turn_end` | 发出前，把这一轮还没关闭的 item 都补一个 `tool_result{status:'interrupted'}`，或补一个助手文本收尾 |
| `error`（通知） | `error{willRetry}` | `willRetry=true` 时不结束这一轮 |
| JSON-RPC 错误响应 | `error` | steer 或 turn 被拒等，`fatal:false` |
| 子进程退出（非 `close()` 引起） | `error{fatal:true}`，再补 `turn_end{failed}` | |
| `warning` / `configWarning` | `warning` | 「模型元数据缺失」这类提示只记一次 |
| `account/rateLimits/updated` | （订阅额度提示，另行处理） | |

**`respondPermission` 的映射：**

| 归一化决定 | 发给 Codex |
|---|---|
| `allow` | `{decision:"accept"}` |
| `allow_session` | `{decision:"acceptForSession"}` |
| `deny` | 有 `reason` 时先 `turn/steer {expectedTurnId:请求里的 turnId, input:[{type:"text", text:"（拒绝理由）…"}]}`，再回 `{decision:"decline"}` |
| `deny_and_stop` | `{decision:"cancel"}` |

**`send` 的逻辑：**
- 在 `turn/started` 和 `turn/completed` 之间算「进行中」，这时调 `turn/steer`。
- steer 如果返回 `-32600 no active turn`，说明这一轮刚好结束了，自动退回 `turn/start`。

### 6.3 适配器启动前的检查顺序

1. 用 `codex --version` 核对版本，**锁定适配器支持的版本区间**。官方文档已经提到 0.166 的新行为，协议在快速变化。建议在构建时用 `generate-ts` 生成类型，并纳入版本校验。
2. 订阅模式下 `account/read`：`account==null` 时走 `account/login/start` 打开浏览器，等 `account/login/completed`。网关模式下 `requiresOpenaiAuth:false`，跳过这一步。
3. `thread/start` 或 `thread/resume`，记录 `threadId + 提供方 + CODEX_HOME`。

---

## 7. 证据文件（都在本目录）

| 文件 | 内容 |
|---|---|
| `ts/`、`ts-exp/`、`schema/` | `codex app-server generate-ts` / `generate-json-schema` 生成的 0.159.2 协议类型 |
| `fake-gw.mjs` | 本机假 Responses 网关（脚本化返回文字、命令、补丁、慢速流） |
| `drive.mjs`、`summarize.cjs` | app-server 驱动脚本和时间线摘要脚本 |
| `app-basic.jsonl`、`app-basic.summary.txt` | 基础流、拒绝或允许命令、补丁、插话、中断、进行中再 `turn/start`、空闲时插话、等批准时中断 |
| `app-patch.jsonl` | 补丁的拒绝加理由、本会话允许、`cancel` |
| `app-resume.jsonl` | 新进程续接 |
| `app-login.jsonl` | 登录拉起与取消（authUrl 只截到域名） |
| `app-clean1..4.jsonl` | 干净会话对照实验 |
| `fake-gw.log` | 网关只保留了最后一个场景的请求日志（请求头名、鉴权是否一致、工具清单、输入摘要），前面几个场景跑之前日志被清空，当时的结论已摘进正文 |
| `exec-ping.jsonl` | `exec --json` 样例 |
| `exec-unauth.err` | 未登录时 exec 的 stderr |
| `models.json` | `codex debug models` 的内置模型目录 |
| `docs/*.md` | 官方文档快照：app-server、config-advanced、config-reference、auth、non-interactive、codex-sdk、agents-md，来源 learn.chatgpt.com，`*.md` 版本 |
| `home/`、`home-dirty/` | 实验用的临时 CODEX_HOME，可以删 |

官方链接：
- [App Server](https://learn.chatgpt.com/docs/app-server)
- [Advanced Configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)
- [Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Authentication](https://learn.chatgpt.com/docs/auth)
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

## 8. 没做或没验证的

- 没有对真实 OpenAI 模型跑过事件流，0 次。真实模型会多出 `reasoning`、`plan`、`commentary` 阶段等 item，但事件结构和假网关下观察到的一致，因为都由同一份类型定义约束。
- `acceptForSession` 的作用范围、`item/permissions/requestApproval`、MCP 工具批准、`hook/*` 通知都没有实际触发过。
- 按线程用 `config` 参数定义提供方没测；TS SDK 有没有批权限或插话的能力没测。
- macOS 没测，本次只在 Windows 上跑。
