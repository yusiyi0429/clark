# 04: 跑通 global 与对象 Conversation

Type: implementation
Status: ready-for-agent
Blocked by: 02 建立可登录的 Monorepo 纵向骨架; 03 提供只读 CompanyMemory MCP 与稳定人员目录

## What to build

让 CEO 能在 global 和一个对象页面完成真实 Pi Conversation。API 保存原始消息与执行态，Web 通过 SSE 展示运行过程，不同 scope 的历史严格隔离。

## Acceptance criteria

- [ ] global Conversation 与 Issue、Signal、Meeting、MonthlyPlan 的对象 Conversation 使用稳定且独立的 scope。
- [ ] PostgreSQL 只追加保存原始消息，并把 Pi runtime entries 作为可替换 JSONB 分开保存。
- [ ] Web 发送 message、scope 和选中的 Card ID/version；referencesSnapshot 由 API 从可信 Card 生成。
- [ ] 过期、未授权或不存在的 Card 引用被拒绝，浏览器提交的业务内容不被直接信任。
- [ ] SSE 至少传递 message、tool lifecycle、usage、error 与 done，断线不伪造成功消息。
- [ ] Pi 通过受控 ResourceLoader 启动，只装配当前对象和只读 CompanyMemory，不拥有业务写入 Tool。
- [ ] global 与对象页面均有最小可用 Conversation UI，一个 scope 的消息和 entries 不进入另一个 scope。
- [ ] 进程重启后能从 PostgreSQL entries 恢复并继续同一对象 Conversation。

## Comments
