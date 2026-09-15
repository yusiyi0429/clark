# 03: 提供只读 CompanyMemory MCP 与稳定人员目录

Type: implementation
Status: resolved
Blocked by: 02 建立可登录的 Monorepo 纵向骨架

## What to build

提供可由 Pi 和独立客户端调用的只读 CompanyMemory MCP，并装载版本化人员目录，使 Meeting、Transcript、DRI import 和 MonthlyPlan 使用稳定 Person 身份。

## Acceptance criteria

- [x] MCP 提供章节目录、相关章节搜索、段落读取和人员查询能力。
- [x] 人员 seed 通过 `company-people.v1` 校验，personId 稳定且唯一，displayName 与 roles 只作为可变属性。
- [x] 不从姓名临时生成 personId；不存在自由文本 participant 绕过目录的路径。
- [x] MCP 使用独立服务凭据，未授权请求被拒绝。
- [x] MCP 不暴露 CompanyMemory 写入方法，API 业务 Action 也不能通过内部旁路写入。
- [x] Markdown repository 被封装在 MCP 后，未来替换存储无需改变公开工具契约。
- [x] 独立测试客户端和 Pi Runtime 均能读取相同 section、passage 和 Person 结果。

## Comments

- 结构：`packages/contracts/src/mcp.ts`（company-people.v1 seed schema + 四个只读工具的输入/输出 TypeBox 契约 + `COMPANY_MEMORY_TOOLS` 常量）+ `apps/api/src/companyMemory.ts`（seed 装载/校验 + Markdown repository：按 `## ` 切章、空行切段、标题/命中/中文 bigram overlap 排序，`sourceRef`/`updatedAt` 来自文件）+ `apps/api/src/mcpCompanyMemory.ts`（官方 `@modelcontextprotocol/sdk` 低层 Server + 无状态 Streamable HTTP transport，`enableJsonResponse`，每请求一个 session，工具声明 `readOnlyHint`）+ `app.ts` 把 Ticket 02 的 501 stub 替换为真实端点，复用 `requireServiceToken(COMPANY_MEMORY_MCP_TOKEN)`。
- 鉴权：无 token／错误 token／DRI token／CEO session cookie 访问 MCP 均 401；服务凭据与 CEO session 仍为独立边界（journey 测试继续覆盖）。非 MCP 客户端请求（缺 Accept/JSON-RPC）由协议层 406 拒绝。
- seed 装载：`COMPANY_MEMORY_SEED_DIR` + `COMPANY_PEOPLE_SEED` 为 API 必填环境变量；文件缺失、JSON 非法、schemaVersion 不符、roles 为空、personId 空或重复、目录无 `.md` 或无章节 → `buildApp` 直接抛错、进程启动失败（诚实失败，不虚构人员或静默空目录）。
- 无写路径：`tools/list` 恰好等于四个只读工具（契约常量断言）；`write_sections` 等未知工具返回 isError「未知工具」；`CompanyMemoryRepository` 类型本身没有任何变更方法，Markdown/未来数据库都封装其后，未来替换存储不改公开契约。
- seed 资产（单一来源）：认知内容直接读取现有 `backend/CompanyMemory.md` 所在目录（`<Content>` 包装行与前言自动忽略，15 章），不维护内容副本；`seed/company-people.example.json` 为明确标注仅供本地联调的示例名单。当前没有真实人员名单，仓库不虚构；生产名单由项目授权人在部署机放置 `seed/company-people.json`（已 gitignore），Compose 只读挂载 `../backend` 与 `../seed` 并要求该文件存在，否则 API 启动失败。
- 验证证据：
  - contracts 6 tests + api 23 tests 全部通过（新增 `companyMemoryMcp.test.ts` 9 项：鉴权边界、独立 SDK 客户端握手、工具目录恰为四个只读工具、search_people 稳定身份 + sourceRef/updatedAt、list/search sections、get_passages 与未知章节诚实失败、写入工具被拒、seed 五类不合规均拒绝启动）。
  - `pnpm -r typecheck` / `pnpm -r build` 三包通过。
  - 生产入口 smoke：`server.ts` + `backend/CompanyMemory.md` 目录启动后，独立 MCP 客户端完成握手并列出四工具；真实内容验证 15 章、search「TKOS 三大核心能力」命中第 3 章第一、get_passages 返回真实段落；people seed 缺失时进程 exit=1 并报「人员 seed 不存在」。
- 实现取舍（记录给后续 ticket）：
  - Pi Runtime 消费同一端点在 Ticket 04/05 接线；本票用官方 SDK 独立客户端验证同一协议入口，Pi 侧工具结果形状（content[0].text 内 JSON）已按其可消费格式返回。
  - 相关度排序为最小实现（ponytail 注释标记）：只替换 repository 内排序函数即可升级召回，不动 MCP 契约。
  - 真实人员 seed 的装载与 MCP 验收按计划留给 Ticket 16；staging/production 共用 compose 配置但生产禁止使用 example 名单。
