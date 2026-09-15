# 允许托管 Agent 和 LangSmith 处理完整业务上下文

CEO 明确允许 CompanyMemory、Conversation、Transcript 及完整模型输入输出进入选定的托管 Agent 环境和 LangSmith，以换取完整调试与回放能力。服务端密钥、访问令牌和凭据始终排除在输入与 trace 之外；生产环境仍需使用独立项目、访问控制和供应商数据保留配置。