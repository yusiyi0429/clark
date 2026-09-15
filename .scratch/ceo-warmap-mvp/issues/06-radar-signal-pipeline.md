# 06: 从真实来源生成可管理的 Signal

Type: implementation
Status: ready-for-agent
Blocked by: 02 建立可登录的 Monorepo 纵向骨架; 05 补齐 Search、compaction 与 Runtime 恢复

## What to build

跑通 Radar 从 scheduled/manual 触发、来源采集、Agent 研判到 Signal Card 的完整链路，让 CEO 能查看并独立管理 Signal 状态。

## Acceptance criteria

- [ ] scheduled scan 按 Company Day 每日最多启动一次，manual scan 不占 scheduled 轮次，两者复用同一管线。
- [ ] PostgreSQL 锁阻止同一时刻重复运行，重启补跑不会重复创建同一公司日期的 scheduled run。
- [ ] Web Search 与微信公众号账号级来源归一化为 title、URL、publishedAt、excerpt 和 sourceRef。
- [ ] URL canonicalization、时间窗与来源 fingerprint 由确定性代码执行。
- [ ] Radar Agent 通过严格 schema 提交候选，API 校验 excerpt 连续引文、归属和字段边界后保存 Signal。
- [ ] CEO 可分别设置 read、saved 与 dismissed，任一状态不覆盖另外两项。
- [ ] Radar、Signal 详情和来源状态通过真实 Card/API 展示；公众号未配置时明确显示未配置。
- [ ] Provider 失败可见且不自动重试，不把普通关键词搜索冒充公众号账号订阅。

## Comments
