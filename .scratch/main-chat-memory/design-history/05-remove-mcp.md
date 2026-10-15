# 05 · 人员目录独立与移除 CompanyMemory MCP

Type: implementation
Status: ready-for-agent
Blocked by: 02（Company 可供共同调用方读取）

## 工作

- 拆出 PeopleDirectory，保持 company-people 稳定 personId、登录角色、会话校验和业务人员解析。
- 迁移主 Runtime 与 radarAgent/preflightAgent 的旧章节调用到 Company，只做解除 MCP 依赖所需的适配。
- 清查 missionRounds 等直接读 companyMemory 的认知依赖，改用 Company；不能只删除 import 后留下旧 Markdown 暗中补事实。
- 删除 mcpCompanyMemory、旧 memoryTools 定义和 HTTP `/mcp/company-memory`，移除专用 Token、seed 启动条件和对应健康项。
- 同步 server/AppEnv、env 示例、Compose、存储卷权限与测试 fixture。其他 MCP（例如 /mcp/me）、既有材料工具、群组/批注/M2 行为不扩展。
- 替代 ADR-0013 与相关 ADR-0004 规则，更新 CONTEXT/CLAUDE 的当前架构说明，保留历史 ADR 关系。

## 完成定义

- 登录、会话角色、本人隔离和人员名解析行为不变，不能从 World 负责人推导登录权限。
- 所有旧企业知识读入口都被清查，旧 Markdown 不再作为任何公司事实兜底。
- 无旧 MCP 端点、主聊旧章节工具或必要配置依赖；其他 MCP 功能仍正常。
- 缺 World 时 Company 依赖如实降级，身份目录缺失仍按原规则启动失败；非主聊服务不因删除模块崩溃。
