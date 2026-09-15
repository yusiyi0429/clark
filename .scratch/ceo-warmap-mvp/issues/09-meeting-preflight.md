# 09: 完成 Meeting 创建与会前准备

Type: implementation
Status: ready-for-agent
Blocked by: 03 提供只读 CompanyMemory MCP 与稳定人员目录; 05 补齐 Search、compaction 与 Runtime 恢复; 07 自动升级 Issue 并接收 DRI Issue

## What to build

让 CEO 从 Issue 创建或加入 Meeting，并完成可持久化的会前材料、participant 管理、核对状态、Supplement Request 与 scheduled Meeting 取消。

## Acceptance criteria

- [ ] CEO 可从 Issue 新建 Meeting 或加入已有 scheduled Meeting，DRI 服务接口也可导入合法 Meeting 元数据。
- [ ] participant 只能从稳定 Person 目录选择并保存身份快照；CEO 身份可确定识别。
- [ ] Meeting Agent 使用关联 Issue、ResearchDoc 和 CompanyMemory 生成 Candidate Preflight，失败可见且不自动重试。
- [ ] CEO 的已阅、已核对和带到会议状态持久化；已核对条目内容变化时自动取消核对。
- [ ] Supplement Request 保存真实状态：已记录、pending_export、delivered 或 failed；没有渠道回执时不显示已送达。
- [ ] 只有 scheduled Meeting 可以取消，held 或 reviewed Meeting 不可取消。
- [ ] Meeting Card、对象页面、会前通知和独立 Conversation 投影同一 Meeting。
- [ ] 本 ticket 不建设日历同步、会议管理中心、录音或会后 Action 分派。

## Comments
