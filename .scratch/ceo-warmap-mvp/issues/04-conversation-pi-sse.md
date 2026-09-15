# 04: 跑通 global 与对象 Conversation

Type: implementation
Status: resolved
Blocked by: 02 建立可登录的 Monorepo 纵向骨架; 03 提供只读 CompanyMemory MCP 与稳定人员目录

## What to build

让 CEO 能在 global 和一个对象页面完成真实 Pi Conversation。API 保存原始消息与执行态，Web 通过 SSE 展示运行过程，不同 scope 的历史严格隔离。

## Acceptance criteria

- [x] global Conversation 与 Issue、Signal、Meeting、MonthlyPlan 的对象 Conversation 使用稳定且独立的 scope。
- [x] PostgreSQL 只追加保存原始消息，并把 Pi runtime entries 作为可替换 JSONB 分开保存。
- [x] Web 发送 message、scope 和选中的 Card ID/version；referencesSnapshot 由 API 从可信 Card 生成。
- [x] 过期、未授权或不存在的 Card 引用被拒绝，浏览器提交的业务内容不被直接信任。
- [x] SSE 至少传递 message、tool lifecycle、usage、error 与 done，断线不伪造成功消息。
- [x] Pi 通过受控 ResourceLoader 启动，只装配当前对象和只读 CompanyMemory，不拥有业务写入 Tool。
- [x] global 与对象页面均有最小可用 Conversation UI，一个 scope 的消息和 entries 不进入另一个 scope。
- [x] 进程重启后能从 PostgreSQL entries 恢复并继续同一对象 Conversation。

## Comments

- 实现：新增 Conversation TypeBox/OpenAPI 契约、PostgreSQL append-only 原始消息与独立 runtime_entries JSONB、鉴权 HTTP/SSE 路由、可信 Card snapshot 解析和最小 Issue fixture Card。
- Pi：固定 `@earendil-works/pi-*` 0.85.1，自定义零发现 ResourceLoader + in-memory credential/settings/session；只启用复用现有 MCP server 的四个只读 CompanyMemory Tool，关闭 coding tools、retry 与 Ticket 05 compaction/Search。
- Web：首页 global 与 `/issues/fixture-001` 对象 Conversation dock 可发送、引用、停止并诚实展示失败/断线；后续实体只保留可替换 fixture object。
- 验证：contracts/API 公开 seam 覆盖鉴权、四类稳定 scope、scope 隔离、Card ID/version snapshot、过期/不存在/未授权拒绝、SSE 全事件、失败/断线无伪 assistant、PostgreSQL entries 重启恢复和受控 Pi Tool loop；全量 typecheck/test/build 通过。
- Review：以 `main@9f603c6` 为 fixed point 完成 Standards 与 Spec 双轴自审；修复 migration 断言漂移、runtime entries 输入被 Pi Session 原地修改、失败后 Web 局部输出仍标记“运行中”及冗余 message status 字段；未改 `map.md`。
