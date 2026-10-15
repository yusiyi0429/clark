# 04 · Reference 召回与 Pi 请求期上下文

Type: implementation
Status: ready-for-agent
Blocked by: 01、02、03（可先用可控接口联调）

## 工作

- 将现有全量 JSON session.prompt 改为保存原始 Query，附件文本/显式引用/Company/Personal/历史作为 Reference。
- 实现 TurnContext 组装、授权后召回、章节目录及 read_reference/search_memory/query_company。
- 采用 context-contract.md §7 的 provider 边界适配 + AsyncLocalStorage，匹配已装配主 Prompt；压缩请求不注入临时内容。
- 验证缺失上下文时阻断 provider，首轮及工具 follow-up 都注入一次；不使用全局 mutable turn 或 SDK 私有字段。
- 完整预算包含临时内容和工具 schema，首轮前可压缩，工具回合不得在 provider 回调内重入 compact。
- 更新 CEO/成员 Rules 与应用允许的 Procedure 装配；不加载用户级 Skill/AGENTS/Shell。
- 路由所有公司查询至 World Reference；本地页面查询改用 Anchor，不同时保留旧同义公司查询工具。

## 完成定义

- 本轮原始 Query 始终可核对，锚点/参考不累积进 entries，历史讨论语义保留。
- 首轮、JSON 恢复、工具回合、手动/自动压缩与双人并发用真实 Pi SDK 测试通过。
- 公司事实优先不受 Anchor 高相关性影响；Reference 注入指令不能授予工具权限。
- 不丢 toolCall/toolResult 配对，不截断用户意图；完整请求超限走明确失败路径。
- 参考正文不复制进普通日志/LangSmith，usage/错误沿用现有 SSE 行为；不能把原型断言当真实模型评测。
