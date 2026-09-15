# 03: 提供只读 CompanyMemory MCP 与稳定人员目录

Type: implementation
Status: ready-for-agent
Blocked by: 02 建立可登录的 Monorepo 纵向骨架

## What to build

提供可由 Pi 和独立客户端调用的只读 CompanyMemory MCP，并装载版本化人员目录，使 Meeting、Transcript、DRI import 和 MonthlyPlan 使用稳定 Person 身份。

## Acceptance criteria

- [ ] MCP 提供章节目录、相关章节搜索、段落读取和人员查询能力。
- [ ] 人员 seed 通过 `company-people.v1` 校验，personId 稳定且唯一，displayName 与 roles 只作为可变属性。
- [ ] 不从姓名临时生成 personId；不存在自由文本 participant 绕过目录的路径。
- [ ] MCP 使用独立服务凭据，未授权请求被拒绝。
- [ ] MCP 不暴露 CompanyMemory 写入方法，API 业务 Action 也不能通过内部旁路写入。
- [ ] Markdown repository 被封装在 MCP 后，未来替换存储无需改变公开工具契约。
- [ ] 独立测试客户端和 Pi Runtime 均能读取相同 section、passage 和 Person 结果。

## Comments
