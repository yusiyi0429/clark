# Agent Runtime 不拥有业务记忆

四层记忆是 WarMap 的产品数据边界：当前运行上下文、对象独立 Conversation、业务对象记忆和 Company Memory。Runtime 只管理一次 agent loop 的上下文及 Conversation 的压缩执行态；PostgreSQL 始终保存原始 Conversation 和业务对象，Company Memory 始终独立，从而允许未来更换 Runtime 而不迁移公司与决策事实。