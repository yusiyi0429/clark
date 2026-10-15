# 06 · 历史迁移、端到端与语义验收

Type: implementation
Status: ready-for-agent
Blocked by: 01–05

## 工作

- 新增 context_schema_version 与 memory_epoch：切换仅重建可替换 Pi entries，保留原始 conversation_messages 与历史记录。
- 清理旧 JSON prompt 回放路径；历史快照按历史理解，不复制成最新 Company/Personal。
- 执行 validation.md 的至少 30 条场景集及三种输入策略对比，记录实际模型/样本与输入用量、时延、语义结果。
- 补齐 PostgreSQL 上的锁、排队、写入中断恢复、版本冲突、遗忘、撤权和跨人隔离集成测试。
- 验证 World 真实只读接口与覆盖。原有产品写回只验证其已实现范围，不假造全公司双向同步已完成。
- 更新部署文档，说明卷挂载、依赖状态、旧 Runtime 失效与回退兼容；本工单不自动授权发布。

## 完成定义

- 端到端覆盖首页、对象私聊、focus/Reference 区别、公司事实冲突、World 故障与 Personal 更新/遗忘。
- 未授权内容泄露、公司记忆反向写 World、已遗忘属性复活、明显超预算发送为零。
- 新旧前端请求兼容；重新生成 OpenAPI 后无手工生成文件差异。
- 实际业务质量与机制测试分别报告，未执行检查明确列出；仅通过离线 SDK 原型不能标记本工单完成。
- 完成相关测试、类型检查和构建；Git 差异无群组、批注或 M2 的无关改造。
