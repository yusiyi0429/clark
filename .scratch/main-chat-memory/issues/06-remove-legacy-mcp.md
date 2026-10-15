# 06 — 停用旧 CompanyMemory MCP，保留共同调用方能力

Type: implementation
Status: ready-for-agent

**What to build:** 旧企业知识端点、专用配置和 Markdown 事实源退出；主聊、雷达、预审等已有调用方使用共同 Company 能力，身份与其他 MCP 保持可用。

**Blocked by:** 01、03（先有独立人员目录和可替代公司读取路径，再 contract）。

- [ ] 没有旧 CompanyMemory MCP 或旧 Markdown 的隐藏公司事实回退。
- [ ] 停用专用端点/Token/启动条件，其他 MCP 和既有服务仍可运行。
- [ ] 配置、健康状态、部署存储与领域文档一致，旧 ADR 明确被替代。
- [ ] 不扩展群消息、任务卡批注或 M2 功能。

**TDD seams:** 应用启动与 health HTTP、旧端点停用、现有雷达/预审公共运行入口、其他 MCP 现有接口。

## Execution

Each ticket uses one implement subagent in an isolated worktree; red/green evidence and Standards/Spec review evidence must be recorded before resolution. User-approved public seams and fixed point are in ticket-breakdown.md.
