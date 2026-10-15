# 允许托管 Agent 和 LangSmith 处理完整业务上下文

CEO 明确允许 CompanyMemory、Conversation、Transcript 及完整模型输入输出进入选定的托管 Agent 环境和 LangSmith，以换取完整调试与回放能力。服务端密钥、访问令牌和凭据始终排除在输入与 trace 之外；生产环境仍需使用独立项目、访问控制和供应商数据保留配置。
> 记忆正文策略由 [ADR-0027](0027-company-world-and-personal-memory.md) 窄范围替代：Company/Personal Reference 默认只记录必要的模块、命中与可用状态，正文不复制到普通日志或 LangSmith；其他业务上下文的既有完整调试授权继续有效，凭据仍始终排除。
