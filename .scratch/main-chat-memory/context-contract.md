# 主私聊上下文开发规格：Anchor 与 Reference

Status: ready-for-agent（方案与离线验证完成；生产切换依赖 World 读取联调）
日期：2026-10-15

## 1. 范围与完成目标

改造 apps/web 主私聊 → apps/api Conversation API → Pi Runtime 的上下文与长期记忆，不开发群组消息、任务卡批注或 apps/m2。移除旧 CompanyMemory MCP 的共同依赖适配见工单 05，不因此扩展其他产品能力。

交付目标：用户本轮 Query 明确、当前场景 Anchor 可靠、Reference 相关有界；Company 只有 World 一个事实源，Personal 每人私有；历史上下文不累积过期 Anchor 或自动固化长期记忆。

“最近一天 User Message”按后续对话解释为“最近一条 User Message”。不存在按最近 24 小时拼接所有用户消息的规则。

## 2. 四种职责，不做一个混合权重分数

| 类型 | 职责 | 权限与事实规则 |
| --- | --- | --- |
| Rules | 系统角色、边界、工具使用规则 | 由应用装配；不可由 Card、记忆、检索结果覆盖 |
| Query | 本轮用户原话和明确要求 | 决定本轮要做什么；不绕过授权 |
| Anchor | 当前页面、对象、选中项及工作状态 | 在 Query 之外，最高优先的场景相关上下文；不因此成为最高事实权威 |
| Reference | Company、Personal、历史、资料、MCP 返回内容 | 提供参考；按来源语义判断可用于哪些事实与偏好 |
| Procedure | 本轮适用的 Skill 方法 | 服务 Query，在应用许可范围内执行；不可覆盖 Rules 或获得新工具权限 |

产品上只有 Anchor / Reference 两个上下文概念，Rules 与 Procedure 是运行时职责，不增加四套产品导航。MCP 是获取能力，Skill 是方法载体，System Prompt 是指令载体，不能按传输来源统一降权。

冲突处理分轴：指代与工作范围看 Query/Anchor；公司事实看 World；个性化看 Personal；是否能执行看服务端权限。高相关度不等于高事实权威。

## 3. Anchor 来源、摘要与索引

### 3.1 全局场景

以登录用户有权读取的业务数据库 Card 集合作为 Anchor 的数据基础。复用首页 projector/service，不在聊天模块重写一套首页汇总，也不让 API 服务通过 HTTP 调自己的首页接口。

- CEO 首页：当前可见的战场、能力、议题、会议、计划等 Card 的精简目录。
- 成员首页：仅本人可见的工作台对象，不能复用 CEO 总览后再让模型忽略其他内容。
- 显式选中项是 focus；未选中时是首页整体，不凭聊天历史猜测用户选中了谁。
- 索引分页先授权再计数，不能暴露隐藏对象的标题、数量或是否存在。
- 默认先给 focus 摘要和最多 12 项目录，其他通过工具分页；全局 Anchor 不装入所有 Mission 正文。

### 3.2 对象场景

scope 已经过对象授权，再从同一对象投影中提取标题、当前状态、正在阅读的材料及本轮需要的内容。材料长文、逐字稿、所有关联对象不自动整份注入。保持既有的私聊 scope 隔离规则。

### 3.3 三种指向不能混淆

- 页面 Anchor：当前所在场景，自动刷新。
- focus：用户在该场景明确选中的对象或字段；需显式操作，不能因为 Reference 被召回就改变。
- 显式引用篮：仍是用户主动提供的 Reference，默认不提升为 Anchor；仅“围绕此对象工作”的明确操作才改变 focus。

不自动切换 conversation scope。跨页面“在全局讨论”仍使用原 global 私聊。

### 3.4 模型侧数据示例

```ts
type AnchorView = {
  scene: string;                     // 公司首页／议题详情／执行事项详情
  period?: string;                   // 2026-10，业务语义，不是同步元数据
  focus?: { handle: string; title: string; selection?: string };
  summary: string;
  items: Array<{
    handle: string;                  // A1；可用于展开，不发送 UUID、HMAC 或哈希
    kind: string;
    title: string;
    state: string;
    meaning: "当前页面内容" | "本地草稿" | "历史快照";
    summary: string;
  }>;
  more: boolean;
};
```

索引不是空 ID 列表：摘要应足以理解场景，目录应足以选中需要展开的内容。保留业务日期、结果、状态和必要限制，删除 actionId、请求指纹、storageKey、源文档元数据等无关字段。

后端 TurnContext 保存 handle → 对象 ID、版本、访问范围的映射，模型看不到这份映射。每次展开重新授权；A1 仅对当前 run 有效，不能跨轮使用历史 A1。

## 4. World 事实与本地页面的关系

例：页面草稿目标是“新增 10 家客户”，World 当前目标是“新增 8 家客户”。

- 用户说“把这份草稿第二项改清楚”：Anchor 保留草稿 10 家，围绕用户明确的草稿操作；不声称它已成为公司正式目标。
- 用户说“公司目前目标是多少”：从 World 读取 8 家；必要时说明当前页面草稿不同，不能让 Anchor 覆盖它。
- World 暂时不可读：仍可解释本地草稿，但不能用 10 家补齐 Company 或冒充最新正式目标。

这种区分在输入结构与工具路由上实现，不仅靠 system prompt。不能直接把任意本地 Card.payload 同时当作公司事实和流程状态发送。

首版不要求改动所有本地业务写入；对未联通 World 的产品确认明确标为本地流程结果。后续业务写回属于原产品流程，不新增给主 Agent 的 World 写工具。

## 5. 前后端契约

在 `packages/contracts/src/conversations.ts` 增加可选 `anchorSelection`，沿用 scope、message、references、attachments 与 viewingMaterialId。客户端只提交对象标识和用户选择，不提交 Anchor 正文或记忆内容：

```ts
type AnchorSelectionInput = {
  cardId: string;
  version: number;
  selectedText?: string;  // 用户提供的选中文字，不作为服务端事实或授权
};
```

- scope 决定页面场景；anchorSelection 决定场景内 focus，二者分别校验。
- scope 与 focus 不相容或对象不可见返回 404；明确选中项版本过期返回 409 `ANCHOR_VERSION_CONFLICT`，提示刷新，不悄悄解释另一版。
- 无显式 focus 的首页读取当前可见 Card 目录。无需浏览器上传整页 Card，也不伪装用户看到的旧页面仍是当前版本。
- 原 references 的 Card 版本校验保留，转成新的 Reference 正文；划词继续按用户提供的引用解析，不等同可信服务端字段。
- 附件抽取文本进入 Reference，而不再拼接进 Query；message 始终保存用户原话。
- 缺少新字段的现有客户端仍可使用默认场景 Anchor；不维护两套长期 Runtime。
- 修改 TypeBox 后生成 OpenAPI/Web 类型，禁止手改生成文件。

Web 改造点：`ConversationHost` 传当前对象/focus，`useConversation` 提交新增选择与处理错误，现有 Dock/ColumnComposer 保持外观与 scope 行为。页面 Card 与 Anchor 使用同一后端数据与权限边界。

## 6. TurnContext 与只读展开工具

后端类型单独定义，不将完整结构暴露为 Web DTO：

```ts
type TurnContext = {
  runId: string;
  viewer: { personId: string; role: "ceo" | "member" };
  scope: string;
  query: string;
  anchor: AnchorView;
  references: ReferenceView[];
  procedure?: string;
  handles: Map<string, AuthorizedResource>;  // 只在服务端；每次读取复查权限
};
type ReferenceView = {
  handle: string;               // R1；只有需要展开时才分配
  kind: "company" | "personal" | "explicit" | "attachment" | "history" | "external";
  title: string;
  text: string;
  state?: string;               // 只保留会改变理解的业务语义，例如历史、草稿、无法核实当前状态
};
```

新工具最小集合：

| 工具 | 参数与用途 | 服务端要求 |
| --- | --- | --- |
| `read_anchor` | `{handle?, cursor?}`，展开当前场景项或下一页 | handle/cursor 绑定 run 与 viewer；返回有界正文，过期不沿用旧映射 |
| `search_memory` | `{module:"company"|"personal", query}`，返回相关章节摘要和 handle | 由 viewer 限定文档；Company 需验证当前事实可用性；不能传 personId 或文件路径 |
| `read_reference` | `{handle, cursor?}`，读取已授权的参考内容 | 重新授权、按文档版本检查；正文不含哈希或来源模板 |
| `query_company` | `{query, kind?, period?}`，查询当前公司事实 | 映射到已验证的 World 读取接口；无通用 URL、SQL 或 World Action 参数 |

`query_company` 的自然语言 query 用于检索本次已授权对象目录与正文，不假设 World 自带语义搜索。首版支持经联调确认的类型和过滤器；索引未覆盖时报告覆盖不足，不能返回“公司没有”。

旧工具迁移：本地 `get_warmap_overview` 的页面用途由 `read_anchor` 承接；本地 `list_missions` 的公司事实用途由 `query_company` 承接；待办议题可作为页面流程状态展开。主模型不同时保留新旧同义工具。人员解析从独立 PeopleDirectory 提供，登录角色不从模型推断。

现有材料工具与业务权限按原对象规则保持，不借记忆改造删除它们；外部搜索与媒体 Feed 结果归 Reference 语义。MCP 返回的内容不自动获得信任，也不自动变成 Company。

## 7. Provider 组装顺序与 Pi 接入

物理顺序：

```text
System：Rules + 本轮明确适用的 Procedure（如有）
History：用户/助手讨论和有效工具调用链（可能有历史摘要）
Reference：本轮召回的精简参考块，明确为数据
Latest User：{ "anchor": <当前 Anchor>, "query": <本轮原话> }
Assistant toolCall / toolResult：保持 Pi 原有顺序
```

“Latest User”是最近一条真实用户消息，不是列表最后一条消息；工具回合后最后一条通常是 toolResult。不得破坏调用与返回的配对。Query 放在该用户消息末尾，避免长 Reference 把当前问题埋住。

生产建议：在主 Runtime 的 ModelRuntime provider dispatch 边界，对本次请求的 `Context.messages` 副本临时注入；`session.prompt` 只接收原始用户文字。用 `AsyncLocalStorage<TurnContext>` 隔离共享 Runtime 中的并发请求，不使用模块级 mutable currentTurn。

- 用应用装配完成的主 System Prompt 或受控调用阶段区分主回答和 SDK 压缩；不能按模型名称区别，因为两槽位可能配置同一模型。
- 预验证通过公开 `ModelRuntime.streamSimple` 方法包装完成。正式实现将其封装在一个应用适配器里，类型检查并固定 Pi 0.85.1 行为；不修改 SDK 私有字段。
- `resourceLoaderFor` 依旧不加载用户级 Skills、AGENTS、扩展、文件系统或 Shell。Procedure 来自应用显式允许的 Skill 注册表，不能开启任意本机 Skill。
- 注入前对 Query 与当前用户消息做一致性检查；缺失 TurnContext、组装超限或身份不匹配时阻止 provider 调用，不能发送无 Anchor 的降级请求。
- 不选 `prepareNextTurnWithContext` 单独承担注入：当前 SDK 首次回答不经过该 follow-up 钩子。
- 不选仅靠 extension context hook：当前 SDK 捕获 hook 异常后可能继续调用，不能把授权与必需上下文检查仅放在那里。
- 本轮 Anchor/初始 Reference 冻结；工具展开时若对象已变化，返回冲突/新读取结果并说明变化，不在后台悄悄替换用户选中的对象。

### 历史、压缩和遗忘

临时 Anchor/Reference 不进入 Pi entries 或 conversation_messages。它们不能靠压缩摘要变成永久公司记忆。助手回答可能包含事实，因此“临时内容不持久化”不等于历史里绝不会出现相关事实；历史始终按当时讨论解释，当前公司状态仍需查询 World。

SDK 手动与自动压缩读取原始讨论态，主请求在压缩完成后再次注入当前 Anchor。压缩提示保留用户意图、承诺的下一步与未决问题，不把历史目标标成当前事实。需要展开历史时按当前 viewer、scope 查询原始消息；首版不实现跨所有 scope 的全文历史检索。

首次切换按 `context_schema_version` 重建可替换 Pi entries，保留数据库原始聊天。不要将旧 JSON prompt 整段重放，也不要自动将所有旧聊天导入 Personal。个人遗忘后失效本人的可替换 Runtime 与相关检索缓存，防止旧 Session 重新带回已删除的偏好；历史原文删除与长期记忆删除是不同操作。

## 8. 召回与预算（首版可验证默认值）

按 Query + focus 摘要选取参考，保留模块标签；不把上下文相关性与事实权威加权成一个分数。先过滤权限、失效和删除，再做标题/关键词/中文 bigram 召回、去重与排序；相同个人属性选择最新有效条目，不能只按时间选出所有无关新内容。

| 部分 | 首版上限 | 超限动作 |
| --- | --- | --- |
| Anchor | 12 项目录，8 KiB UTF-8 正文 | 先保留 focus 和必要状态，其他分页，不截断关键字段 |
| 初始 Reference | 合计 24 KiB，单片段 4 KiB | 保留相关章节摘要与展开 handle，移除无关片段 |
| Personal 常驻偏好 | 上述 Reference 预算中最多 2 KiB | 其他按需召回，不每轮全量注入 |
| Procedure | 最多一份适用方法，8 KiB | 使用任务所需小节，不加载整套技能库 |
| 每次工具展开 | 最多 8 KiB 正文 | 按段落分页，cursor 绑定资源与版本 |

这些是应用初始限制，不是研究证明的最佳值。字符、字节与 token 不等价，不能将 KiB 写成 token 用量。

最终完整请求（含 System、工具 schema、历史、临时注入与工具结果）按实际 tokenizer（若可用）或 Pi token 估算计算。当前注册窗口 128,000 token，保留 16,384 输出与 8,192 估算裕量，初始输入估算上限 103,424。不能仅用 SDK 针对持久历史的压缩判断，因为它看不到临时注入的全部增量。

首次调用前，超限先裁减 Reference/可展开目录，再通过 Session 公共接口压缩历史，保留 Query 与必需 Anchor；仍超限返回 `TURN_CONTEXT_TOO_LARGE`。工具循环期间仍校验完整预算，但不能在 provider 回调里嵌套调用 session.compact（可能重入正在执行的 loop）；先裁减临时参考，持久历史压缩交给 SDK 的回合边界，仍超限则终止本轮。工具链只能成对裁剪；不得为了塞入记忆静默截断用户问题。估算不是 provider 精确计费，真实模型需测试超限处理。

对关键词未命中的概念问题，模型仍可看有界章节目录后按需调用 `search_memory/read_reference`。首版不引入向量库；用测试集判断是否存在必须用语义检索才能解决的漏召回。

## 9. 错误与可观测性

| 情况 | 行为 |
| --- | --- |
| focus / 显式引用不可见 | 404，不泄露对象存在 |
| focus / 显式引用版本过期 | 409，保留输入和选中内容，提示刷新 |
| 索引 handle 跨 run 或资源被撤权 | 工具返回不可用，不读取其他 run 的映射 |
| World 未配置、拒绝或超时 | Company/query_company 如实不可用；仍能讨论本地页面或个人问题，不静默查旧库补事实 |
| Personal 读取失败 | 无 Personal 继续主回答，记录后台故障；不读另一个人的文件 |
| Personal 蒸馏失败 | 主回答不受影响，后台任务可重试；遗忘操作不能被失败静默忽略 |
| provider 组装失败 | 使用现有 SSE error 路径，禁止报告成功 |

保留 runId、scope、viewer、Anchor 数量、各类估算用量、读取时延与错误码。`agent_runs` 的受控快照可存 Anchor 及内部句柄映射，不把 Personal 正文复制到普通日志或 LangSmith；Reference 默认仅记模块/章节标识和是否命中。内部诊断元数据与模型视图使用不同 DTO。

## 10. 改造位置与验收

| 位置 | 变化 |
| --- | --- |
| `packages/contracts/src/conversations.ts`、OpenAPI 生成 | anchorSelection 与错误约定；原 references 兼容 |
| `apps/web/src/conversation/*` | 提交 focus、刷新冲突处理、保留用户输入；不自行生成业务 Anchor |
| `apps/api/src/routes/cards.ts`、`routes/me.ts` | 提取可复用的权限内 Card 集合读取，页面与 Anchor 共用 |
| `conversationContext.ts` | 由混合公司事实摘要改为 Anchor builder + Reference selector |
| `conversations.ts`、`routes/conversations.ts` | 保留原始 Query；区分页面值、草稿和历史；构建 TurnContext |
| `piConversationRuntime.ts` | 临时组装、模块工具与 Rules 更新；移除旧全量 JSON prompt 与章节 MCP |
| `companyMemory.ts`、`mcpCompanyMemory.ts`、`memoryTools.ts` | 人员目录拆出；以 World/Company 模块替代旧认知读法，最后移除 MCP |
| `app.ts`、`server.ts`、Compose、healthz | 装配 Company/Personal、存储与任务；健康状态区分配置和实际可读 |

验收至少包括：Card/Anchor 同源、显式选中定位、首页有界目录、旧 Anchor 不累积、工具回合与压缩后 Anchor 不丢失、Company/页面冲突、World 不可用、权限撤销、跨人隔离、个人纠正/遗忘、长请求预算。详见验证报告和工单，不以离线假模型通过代替真实模型判断质量。
