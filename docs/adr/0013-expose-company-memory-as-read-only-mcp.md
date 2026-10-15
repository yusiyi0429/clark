# Company Memory 通过只读 MCP 提供

> 已被 [ADR-0027](0027-company-world-and-personal-memory.md) 替代；以下保留历史决策。


尽管 CEO WarMap 的 Pi Runtime 与 API 可以同进程调用，公司认知仍封装为只读 CompanyMemory MCP，因为未来 DRI Agent 和 CoAgent 需要复用同一目录、检索和证据协议。MCP 只提供章节目录、相关段落检索和来源读取，不提供写入；未来每日认知复盘的确认写入走独立后端链路。