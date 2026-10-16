# 允许托管 Agent 和 LangSmith 处理完整业务上下文

CEO 明确允许 CompanyMemory、Conversation、Transcript 及完整模型输入输出进入选定的托管 Agent 环境和 LangSmith，以换取完整调试与回放能力。服务端密钥、访问令牌和凭据始终排除在输入与 trace 之外；生产环境仍需使用独立项目、访问控制和供应商数据保留配置。
完整业务观测包括 Company/Personal 正文和个人蒸馏输入输出。当前实现遵循用户明确授权，不再按记忆类型隐藏正文。凭据过滤、项目访问控制和数据保留要求继续有效。节点与重试协议见 [ADR-0028](0028-langsmith-thread-turn-spans.md)。
