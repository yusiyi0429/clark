# 06: 从真实来源生成可管理的 Signal

Type: implementation
Status: resolved
Blocked by: 02 建立可登录的 Monorepo 纵向骨架; 05 补齐 Search、compaction 与 Runtime 恢复

## What to build

跑通 Radar 从 scheduled/manual 触发、来源采集、Agent 研判到 Signal Card 的完整链路，让 CEO 能查看并独立管理 Signal 状态。

## Acceptance criteria

- [x] scheduled scan 按 Company Day 每日最多启动一次，manual scan 不占 scheduled 轮次，两者复用同一管线。
- [x] PostgreSQL 锁阻止同一时刻重复运行，重启补跑不会重复创建同一公司日期的 scheduled run。
- [x] Web Search 与微信公众号账号级来源归一化为 title、URL、publishedAt、excerpt 和 sourceRef。
- [x] URL canonicalization、时间窗与来源 fingerprint 由确定性代码执行。
- [x] Radar Agent 通过严格 schema 提交候选，API 校验 excerpt 连续引文、归属和字段边界后保存 Signal。
- [x] CEO 可分别设置 read、saved 与 dismissed，任一状态不覆盖另外两项。
- [x] Radar、Signal 详情和来源状态通过真实 Card/API 展示；公众号未配置时明确显示未配置。
- [x] Provider 失败可见且不自动重试，不把普通关键词搜索冒充公众号账号订阅。

## Comments

- 管线：`radar_config` + `signals`（migration 005）是本票最小持久化对象，不含 Issue promotion 字段，也不建 ScanRun 实体。`createRadarService` 的 manual/scheduled 共用同一个 `run(trigger)`：advisory lock → 读取并校验配置 → scheduled 写公司日键 → 采集 → canonicalize/时间窗/fingerprint 去重 → 分批 assess → 候选校验 → 插入 → 写 last_run。manual 不写 `scheduled_company_day`。
- 来源：`radarSources.ts` 提供可替换的一个 Web adapter（Brave 风格 JSON，按 anchor query + domains）与一个账号级公众号 adapter（按 accountId 调外部 endpoint，Bearer 凭据）。两者只在 endpoint/凭据存在时报告 configured，Radar Card 如实显示“未配置微信公众号账号级来源”。确定性响应测试覆盖两类归一化，并断言公众号走账号级请求而不是 `site:mp.weixin.qq.com` 关键词搜索。
- 确定性门槛：URL canonicalization（去 fragment、剔除 utm_*/fbclid/gclid/spm、排序 query、去尾斜杠）、时间窗（lookback hours）与 `sha256("v1\n" + canonicalUrl)` 来源 fingerprint 全部在代码里执行，重复来源只落一条 Signal。
- Agent 边界：`radarAgent.ts` 用 Ticket 05 的临时 Session + 严格 `submit_candidate` Tool（RadarCandidateSubmission，字段与分值范围全约束，行内候选越界即被 schema 拒绝）。代码再校验候选的 sourceFingerprint 归属、anchorId 合法性与 `excerpt.includes(evidenceQuote)` 连续引文，未通过只记 warning，不落库。
- 状态：read/saved/dismissed 各自独立的时间列，任一 PATCH 不影响另外两项；重复同一状态不递增 version（version 仍是变更指示器）。Signal Card/列表/详情与 Radar Card（含未读数、lastRun、来源配置状态、手动补扫）全部走真实鉴权 API，Web 侧新增 radar/signal renderer 与 `/radar`、`/signals`、`/signals/[id]` 路由，OpenAPI 与生成 client 已重新生成。
- 失败可见：Provider 失败/超时只尝试一次，warnings 与 `last_run.status=failed` 一并持久化，不做自动重试；单次扫描有 180 秒上限并 abort Provider；进程重启把遗留 running 标为 failed（含 radar-assess AgentRun），GET 不触发补偿。
- 边界：scheduled 采用进程内 tick + PostgreSQL 公司日键保证每日一次，没有引入 `RADAR_DAILY_CRON` 与 `SEARCH_PROVIDER` 这类当前无人读取的配置（触发时刻归 Ticket 08 部署、Provider 选择与真实凭据归 Ticket 16）。RadarConfig 的 anchors/sources 更新 Action 也未实现：本票验收项都是扫描/来源/候选/Signal 状态，配置编辑是新的 Action 面，需要单独 ticket 才做。
- Review：Herdr 只读 Standards/Spec 双轴 review 两轮。第一轮 8 项有效发现全部 red→green 修复：DB 不可用不再抛穿调度器（tick 只告警）、启动补偿把中断 running 标 failed、监测方向上限 20 与 assess 分批 5（批失败只丢该批候选）、扫描超时真正 abort Provider 并释放锁、删除误导性 `FOR UPDATE` 与未使用索引/OpenAPI 组件、Radar Card 补未读数与 lastScheduledAt、no-op PATCH 不再改 version。第二轮发现并修复：重启补偿先取同一 advisory lock（不覆盖正在运行的扫描）并顺带结算遗留 radar-assess run、全部 assess 批失败如实标 failed、批量测试改为断言批次数与成功批候选数。
- 验证：`pnpm test`（contracts 11、API 60，含 radar 14）、`pnpm typecheck`、`pnpm build`、`git diff --check` 全部通过；未改 `map.md`。
