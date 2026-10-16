# 原始 Pi 与记忆方案

本文保留 Runtime 设计依据。当前 Company/Personal 边界以 [ADR-0027](../../adr/0027-company-world-and-personal-memory.md)为准；完整观测规则见 [ADR-0028](../../adr/0028-langsmith-thread-turn-spans.md)。旧 MCP 与内容脱敏描述不再适用。

## 1. 职责

本分片提供受控 Pi Runtime、对象级 Conversation、SSE、compaction、Web Search Tool 和授权 World Company 与本人 Personal。

它不负责业务 Action、业务对象写入或每日认知复盘。

## 2. Runtime Factory

Pi 使用固定版本并通过自定义 factory 创建：

- 内存 credential store；
- 显式 OpenAI-compatible Responses Provider；
- 自定义 ResourceLoader；
- 不读取 `~/.pi`；
- 不加载用户 Skills、AGENTS、Prompt、Extension；
- 关闭 read/bash/edit/write 等 coding tools；
- provider retry 关闭；
- compaction 开启。

模型槽位：

```text
LIGHT_MODEL
HEAVY_MODEL
COMPACTION_MODEL
```

base URL 加载时规范化，避免重复 `/responses`。

## 3. 四层装配

```text
L1 当前 turn
  用户消息、引用快照、Tool 结果
L2 Conversation
  Pi entries、compactionSummary
L3 当前业务对象
  API 每轮注入最新只读 snapshot
L4 Company / Personal
  Pi 按需读取 Reference；公司事实只来自授权 World
```

Session 中的旧对象内容不能覆盖 API 本轮 snapshot。

## 4. Conversation 存储

```text
conversations
  scope UNIQUE
  pi_session_id
  runtime_entries JSONB
  runtime_updated_at
  recreated_at

conversation_messages
  conversation_id
  sequence UNIQUE per conversation
  role
  content
  references_snapshot
  run_id
  created_at
```

原始消息只追加。runtime entries 可覆盖，损坏不影响原始历史。

## 5. Chat 请求

```text
POST /api/conversations/:scope/messages
Accept: text/event-stream
```

处理：

1. 校验 scope；
2. 获取 Conversation advisory lock；
3. 后端根据 Card ID/version 生成 referencesSnapshot；
4. 保存 user message；
5. 从 JSONB 创建 in-memory Pi Session；
6. 注入当前对象；
7. 启动 180 秒 timeout；
8. 运行 Agent loop 并流式转发；
9. 保存 assistant message 与 entries；
10. 释放锁。

同一 scope 同时一个 turn，冲突返回 409。

## 6. SSE

```text
turn.started
text.delta
tool.started
tool.completed
compaction.started
compaction.completed
turn.completed
turn.failed
turn.aborted
```

每个事件带 runId、scope、sequence。客户端断开则 abort，本轮保存 aborted，不保留伪完整回答。

## 7. Compaction 与恢复

Pi 自动 compaction 使用独立 Prompt 和 COMPACTION_MODEL。每次 compaction 后立刻保存 entries。

恢复：

- 正常：JSONB entries → `SessionManager.inMemory`；
- 不兼容／损坏：当前对象 + 最近 20 条原始消息创建新 Session；
- 写 `recreatedAt` 和 warning；
- 不递归构建自有摘要系统。

Pi 升级前用真实 entries 做一次兼容检查。

## 8. Web Search Tool

输入：query、可选 freshness、可选 domains。

输出：真实 title、URL、publishedAt、excerpt、provider、warnings。

RunContext 记录次数：

- Agent 自主决定搜索；
- Prompt 要求证据充分即停止；
- 单 Tool 有 timeout；
- 单 turn 180 秒；
- 第 8 次为异常保护，返回预算耗尽并 terminate；
- URL 规范化与去重在 Tool 内完成。

MVP 只有一个 Search Provider 实现。

## 9. Company / Personal 与人员目录

原 CompanyMemory MCP 已退役，决策见 ADR-0027。主聊通过 query_company / search_memory / read_reference 按需消费授权 World 正文；Reference 不携带旧来源模板、协议哈希或本地 Markdown 回退。Company 不可用不等于公司没有对象。

PeopleDirectory 只负责 company-people.v1 的稳定身份、姓名与登录角色。雷达、预审等直接使用同一 CompanyReader，后台读取必须显式配置授权的系统 personId，不能把 World service token 当作成员权限。

Personal.md 按本人隔离，自然蒸馏与遗忘机制见主私聊记忆规格。当前页面 Card 形成 Anchor，Query 和 Anchor 的本轮装配临时进入 Pi，上下文不污染持久化用户原文。

## 10. Chat Prompt

Chat Prompt 必须明确：

- 当前对象 snapshot 优先；
- internal/external/inference 分开；
- 需要当前外部事实时可搜索；
- 证据充分后停止；
- Conversation 不能创建 Issue 或修改 ResearchDoc；
- 不声称已经执行确认、分派、签发或撤回。

## 11. 批处理 Runtime 基座

提供 `runCandidateAgent(kind, input, schema, tools)`：

- 临时 in-memory Session；
- 独立 Prompt；
- 场景只读 tools；
- 严格 `submit_candidate` Tool；
- Tool 只把结果交给 orchestrator 并 terminate；
- orchestrator 二次领域校验；
- 没有合法 submit 则失败。

不建设工作流 DSL 或多 Runtime adapter。

## 12. AgentRun

每轮保存 kind、objectRef、status、model slot、prompt hash、输入快照、候选输出、错误、usage、LangSmith runId 和时间。

状态：running → succeeded/failed/aborted。失败不自动重试。

## 13. LangSmith

从 Pi 事件建立应用级 trace：输入、Prompt hash、Tool、输出、usage、错误。LangSmith 故障只写 warning，不阻断业务；trace 前删除密钥和 token。

## 14. 测试 seam

- 无外部事实问题不搜索；
- 需要事实时搜索并停止；
- 8 次保护；
- global 与两个对象 scope 隔离；
- referencesSnapshot 后端生成；
- 200 条消息 compaction；
- entries JSON round-trip；
- runtime 损坏重建；
- Company 授权只读、无旧 Markdown 回退、Personal 本人隔离；
- company-people.v1 唯一 ID、角色和 search_people；
- production tools 不含 coding tools；
- 客户端断开 abort。

## 15. 完成条件

- Pi 使用指定模型端点完成真实 loop；
- PostgreSQL 可恢复 Session；
- 原始消息不因 compaction 删除；
- CompanyMemory 旧端点返回 404，个人 MCP 保持原授权边界；
- Chat 无业务写 Tool；
- LangSmith 不成为业务依赖。
