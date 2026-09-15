# 15: 建立全链测试、观测与安全门槛

Type: implementation
Status: ready-for-agent
Blocked by: 14 完成真实数据驱动的像素级 Web

## What to build

建立能阻止错误发布的最高可观察 seam、结构化观测和安全边界，使每个 Spec 行为都有一条可信验证路径，失败能从页面、日志或 AgentRun 定位。

## Acceptance criteria

- [ ] 每个 Spec 行为至少映射到 contract、API、Pi/MCP、Web、端到端或真实验收中的一个最高 seam。
- [ ] CEO 主旅程贯穿 Web Card、Action、SSE、API、PostgreSQL、Pi 与 MCP，并验证外部可观察结果。
- [ ] 核心矩阵覆盖 Signal/Issue、Meeting/Outcome、MonthlyPlan、Conversation、Action 幂等、version conflict 和 effect 撤回。
- [ ] health 与 GET 不调用模型、搜索或产生持久化副作用，能够区分 API、数据库和必要依赖状态。
- [ ] 结构化日志含 requestId、runId、scope、objectRef、actionType、agentKind、provider/model、duration、status 与 errorCode。
- [ ] LangSmith 记录应用可见输入输出、Tool 事件、usage 和错误；故障只降级为 warning，不阻断业务。
- [ ] 日志、Prompt 和 trace 清除密码、Cookie、token、模型 key、完整 CompanyMemory passage 与完整 Transcript。
- [ ] 安全检查覆盖 session 过期、service token、MCP 未授权、Action HMAC、CSRF/Origin、上传大小、速率限制和生产 Pi 资源隔离。
- [ ] CI 只运行确定性检查；付费 Provider、模型与备份恢复保留为带成本上限的上线验收。

## Comments
