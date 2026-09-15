# 使用 Pi SDK 作为 Agent Runtime

TypeScript API 服务使用 Pi SDK 承载 Chat 的 agent loop、自定义 Web Search Tool、对象级 Session 和上下文压缩；批处理 Agent 使用临时 Session。真实探针验证了现有 OpenAI-compatible Responses 端点、按问题自主调用 Tool、200 条消息压缩及 Session entries JSON round-trip 恢复；PostgreSQL 仍保存原始 Conversation 和业务对象，Pi runtime entries 只作为可替换的执行态。搜索不设三次正常上限，单 turn 超时 180 秒，并以八次调用作为异常保护。