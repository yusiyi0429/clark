# CEO WarMap MVP implementation map

Type: effort
Status: ready-for-agent
Spec: `spec.md`

## Goal

以可独立验收的 tracer bullets 实现 CEO WarMap MVP：新 Web 只渲染 Card 并提交 Action，API 持有业务、Pi、MCP、调度与持久化，Caddy 是唯一公网入口；最终在用户验收后切换入口并删除旧前端。

## Execution

- claim ticket 前把对应文件的 `Status` 改为 `claimed`。
- 只从 frontier 领取，即所有 `Blocked by` 均已 resolved。
- 完成后把 `Status` 改为 `resolved`，并在本文件 `Results` 追加结果摘要与验证证据。
- 每张 ticket 遵循已发布 Spec、领域词表、ADR 和对应技术分片；发生冲突时停止并报告，不自行改写产品边界。
- 17 是人工验收门槛；拆票批准不等于 cutover、删除数据或删除旧前端授权。

## Tickets

| ID | Ticket | Blocked by | Status |
|---|---|---|---|
| 01 | 冻结 CEO WarMap 视觉与交互证据 | None | resolved |
| 02 | 建立可登录的 Monorepo 纵向骨架 | None | resolved |
| 03 | 提供只读 CompanyMemory MCP 与稳定人员目录 | 02 | resolved |
| 04 | 跑通 global 与对象 Conversation | 02, 03 | resolved |
| 05 | 补齐 Search、compaction 与 Runtime 恢复 | 04 | resolved |
| 06 | 从真实来源生成可管理的 Signal | 02, 05 | resolved |
| 07 | 自动升级 Issue 并接收 DRI Issue | 03, 04, 05, 06 | resolved |
| 08 | 完成 Issue 预研与直接决定闭环 | 07 | resolved |
| 09 | 完成 Meeting 创建与会前准备 | 03, 05, 07 | resolved |
| 10 | 导入 Transcript 并抽取 MeetingOutcome | 09 | resolved |
| 11 | 逐项确认 MeetingOutcome 效果 | 06, 10 | resolved |
| 12 | 生成并协商 MonthlyPlan | 03, 05, 08 | resolved |
| 13 | 签发 MonthlyPlan 并刷新业务投影 | 06, 12 | resolved |
| 14 | 完成真实数据驱动的像素级 Web | 01, 08, 11, 13 | resolved |
| 15 | 建立全链测试、观测与安全门槛 | 14 | resolved |
| 16 | 完成 Compose 部署与真实外部验收 | 15 | resolved |
| 17 | 执行用户像素级验收与 cutover 授权 | 16 | resolved |
| 18 | 切换生产入口并删除旧 frontend | 17 | resolved |
| 19 | Meeting 内嵌会前材料 | 解析实现验证、联合备份恢复设计 | blocked |

## Current frontier

- 19 Meeting 内嵌会前材料

16 已按用户明确风险豁免收口；17 于 2026-09-21 人工验收通过并授权 cutover 与整体删除旧 `frontend/`；18 已据此完成入口切换与旧前端删除。19 已完成设计与领域收口，等待解析实现验证后实施。

## Results

- 01 resolved：提交 `de96165`，冻结 46 张双视口截图、66 项公开交互断言、design tokens、health 与可重复采集工具；像素内容复跑一致，内部 Standards/Spec review 通过。
- 02 resolved：提交 `18f04cb`，跑通 Caddy → Web/API → PostgreSQL、CEO 登录、fixture Card、OpenAPI 客户端与 Action 幂等链；20 个测试、三包构建、Caddy/Compose/浏览器旅程通过，内部 Standards/Spec review 通过。
- 03 resolved：提交 `b5145b5`，提供四个只读 CompanyMemory MCP 工具、稳定 Person seed 校验与独立服务鉴权；contracts 6 + API 23 测试、构建和真实 endpoint smoke 通过。Master 消融审查删除了 603 行 CompanyMemory 重复副本，改为直接读取现有单一来源。
- 04 resolved：提交 `9826f0d`，跑通鉴权 Conversation HTTP/SSE、scope 隔离、可信 Card 快照、PostgreSQL 原始消息/runtime entries 恢复和受控 Pi + 只读 MCP；39 项测试、全 workspace typecheck/build 与双轴 review 通过。
- 05 resolved：提交 `92adfdb`，补齐自主 Search、180 秒/8 次保护、Pi compaction、entries 损坏重建、严格 Candidate Tool 与 AgentRun。Herdr review 的 5 项有效发现均经 red→green 修复；contracts 9 + API 46 测试、typecheck/build 通过。
- 06 resolved：提交 `cc2c2a5`，跑通 scheduled/manual Radar、Web/公众号来源规范化、严格候选到 Signal、独立 read/saved/dismissed 状态和真实 Card。Herdr review 修复全部有效发现；API 60 + contracts 11 测试、typecheck/build 通过。
- 07 resolved：提交 `77e7a48`，实现确定性 Signal promotion、Red deadline quote/location 门槛、DRI Issue import、pending research 和启动丢失恢复。Herdr reviewer 三轮收口无 blocking；contracts 12 + API 85 测试、typecheck/build 通过。
- 08 resolved：提交 `d1a0abb`，跑通唯一深度 ResearchDoc、CEO 直接决定与 Research Override、Dismissed Issue、统一 effect revoker 与幂等/冲突语义。Herdr deepseek-flash reviewer 三轮收口无 blocking；contracts 12 + API 106 测试、typecheck/build 通过。
- 09 resolved：提交 `8f85295`，跑通 Issue/DRI → Meeting、stable Person participant、Preflight、准备状态、Supplement Request 和 scheduled cancel。rebase 后 Herdr reviewer 确认 08/09 两条链无覆盖；contracts 15 + API 134 测试、typecheck/build 通过。
- 12 resolved：提交 `3818f78`，跑通 Company Day 唯一 MonthlyPlan draft、严格候选、显式 retry、versioned 编辑、stable Person todo 与 DRI feedback 幂等协商。Herdr deepseek-flash 双轴 review 无 blocking；contracts 19 + API 146 测试、typecheck/build 通过。
- 10 resolved：提交 `07c86d9`，跑通 Transcript v1 双入口整份校验、scheduled → held、严格 MeetingOutcome 抽取、失败重试和无 confirmed effect 时的危险替换。rebase 后 API 171 + contracts 22 测试、typecheck/build 通过。
- 11 resolved：提交 `2fabfa6`，跑通 MeetingOutcome 逐项 confirm/dismiss、精确 Issue Receipt、DRI Handoff、reopenWhen Radar anchor 与统一 effect 撤回。Herdr deepseek-flash 三轮双轴 review 无 blocking；API 190 + contracts 25 测试、typecheck/build 通过。
- 13 resolved：提交 `ddd4222`，跑通 CEO-only MonthlyPlan 签发、唯一 confirmed 计划、战场与 Radar ontology 投影、普通 todo DRI 出站状态。rebase 后 contracts 26 + API 200 测试、typecheck/build 通过。
- 14 resolved：提交 `007e52a`，将登录、首页、Issue、Meeting、Radar、Signal、MonthlyPlan、Conversation 与 opaque Action 接入真实 API，恢复双视口布局和微交互，并移除目标路由 fixture。contracts 26 + Web 9 + API 199 测试、typecheck/build 与 diff check 通过；双视口浏览器证据已记录。
- 15 resolved：提交 `16ce136`，建立 Spec 最高 seam 矩阵、CEO 主旅程、结构化脱敏日志、可选 LangSmith、health 依赖状态、安全测试与确定性 CI。contracts 26 + Web 9 + API 210 测试、typecheck/build 通过；Herdr 双轴 review 无 blocking。
- 16 resolved：完成 Compose/Caddy/非 root 镜像、Bocha 与真实 Pi/三模型槽、账号级 WeChat MCP 接线、真实人员 MCP 一致性、age/checksum 备份脚本和本机独立恢复后继续 Conversation。API 串行 233 项与双轴 review 通过。公众号真实文章仍受微信频控、异机 SSH/SFTP 尚未执行；用户于 2026-09-16 明确选择方案 C，接受风险并延期，两项未被描述为技术通过。
- 19 blocked：Q30/Q31/Q32 已收口为 Meeting 内嵌会前材料、scheduled-only 的确认回退和 Outcome 只读视图；新增 ADR 0017，规格、部署及验收文档已同步。待验证 Node 22/Alpine 的 PDF、DOCX、Markdown 受限解析与 DOCX 安全 HTML 后实施。
- 17 resolved：2026-09-21 用户在 `https://localhost` 完成像素级交互验收（“前端交互目前没什么问题”），并以明确文字批准 cutover、观察窗口与整体删除旧 `frontend/`。记录与口径说明见 ticket 17 Comments。
- 18 resolved：2026-09-21 生产入口为 Caddy → `apps/web`（无旧前端路由、未加兼容路由）；整体删除 `frontend/`（905 MB、41 262 文件、883 个跟踪文件），未迁移业务逻辑、localStorage、兼容路由或旧 Agent；清理 `.dockerignore`、`apps/api/src/webSearch.ts` 注释、`CLAUDE.md`、`docs/visual-baseline/README.md` 的旧前端引用，workspace/Compose/Caddy/CI 原本无引用；docs 历史性提及与视觉基线证据保留。验证：`pnpm install --frozen-lockfile`、`@warmap/web` 与 `@warmap/api` typecheck、`docker compose -f infra/docker-compose.yml config` 均通过。运行期 smoke、观察窗口与最终回归未在本 ticket 重跑（依据 ticket 16 证据与 CEO 人工验收）。
- 23 resolved：2026-09-22 纯机械拆分 `meetings.ts`（1564→492）与 `app.ts`（1540→270）。W1 `c3bdc97` 抽出 `meetingStore/meetingPreflight/meetingMaterials`；W2 `9651641` 将 52 条路由拆入 `routes/` 域模块 + `routes/shared.ts`，`buildApp` 签名不变。仅整函数搬移，未改逻辑/错误码/契约/测试断言。`pnpm -r typecheck` 通过，contracts 28 + web 94 + API 307 测试全过，staging 重建 api 后 `/healthz` 200。
- 25 resolved：2026-09-22 注册表对象编辑。W1 `c291c8e` 战场/能力 PATCH config 路由（id 稳定、version+1、重名 409）+ `GET /api/config/capabilities`；W2 `0630e82` `meeting.edit_details` opaque action（仅 scheduled、fingerprint 幂等、版本锚定、换 lead 同步 participants）；W3 `c5184d8` 三处编辑 UI（战场行铅笔弹层、`/config/capabilities` 新页与配置页「管理能力」入口、MeetingCard 编辑会议弹层）。W4 在 staging 发现并修复两处缺陷（`da96838`）：改名去重原先只比 `id`，漏掉 migration 手写 id（`growth` 显示名「增长战场」）导致可造显示重名；`PatchBattlefieldRequest.owner` 的 `minLength: 1` 与 `owner NOT NULL DEFAULT ''` 冲突，使负责人为空的行点保存必然 400，改为按显示名去重 + owner 允许空串 + 弹层只提交改动字段。验证：typecheck ×3、contracts 28、web 108、API 323，staging 重建 api+web 后 curl 与浏览器复验通过，验证对象已删、会议内容已恢复。

## Comments
- 26 resolved：2026-09-22 战场图结构化模型（A+B）。W1 `bd3fd29` 新增 ADR 0018、migration 019（只改结构）与契约重构（`code` 必填、`sortOrder` 整数、`ownerId` 可空、Strategy GET/PATCH、`MonthlyPlanCapability`）；W2 `762b918` `/api/config/strategy` 与战场/能力结构化写入、owner/supportRefs 校验；W3 `520f6ed` 能力 PCO 贯穿草案生成/编辑/核对/签发；W4 `3b9a1da` 首页 3/2/1 列、战场卡负责人+六个月目标、能力面板与两处管理编辑弹层、配置页 LTCO；W5 通过 API 导入 3 战场 / 7 能力 / LTCO，删除 `growth`（受影响议题 0），并授权用受控 SQL 事务把已签发 2026-09 计划修订为 v6（3 战场 PCO + 7 能力 PCO）；关系图 `supportRefs` 重出并通过 Archify 9/9 与全视口 visual-check。验证：typecheck ×3、contracts 32、web 123、API 326/328（2 项既有波动），staging 重建 + Chrome 双宽验收通过；工作区干净，未 push。
- 26 收尾修复：2026-09-22 按方案 A + T1 追根因补 1 个 fix commit。A1 `MonthlyDraftAgentInput` 注入 Company LTCO 与按 sortOrder 的战场长期目标/Mission（此前长期约束根本没进 Agent input），prompt 明确不得原样复制；A2 `deleteBattlefield` 同事务清理 `capability_config.support_refs` 中指向该战场及其 Mission 的 ref（仅受影响能力 version+1，历史 MonthlyPlan 快照不回写）；A3 `MonthlyPlanCard` 保存只提交真正改动的字段（`monthlyDraftPatch`），无改动不发请求，`checkedItemIds` 仍由 checkbox Action 单独提交，不再清掉无关核对；T1 `createOutletFeedAdapter` 注入 `now`（默认真实时钟），测试钉到与 fixture 对齐的固定时间，消除 2 项长期时间窗波动。另移除负责人 Select 重复的「待指派」标签。验证：typecheck ×3、contracts 32、web 126、API 331 全过，staging 重建后 healthz 200 / 首页 3+7 / 计划 v6 已核对 11 项，浏览器复验弹层标签与只读核对项；工作区干净，未 push。
- 26 Mission 编号唯一与解析收口：2026-09-22。API `missionCodeConflict()` 在 create/patch 拒绝同 payload 与跨战场重复的 Mission code（`409 MISSION_CODE_CONFLICT`）；`updateBattlefield` 改事务 + `FOR UPDATE`，删除/改名旧 Mission 时同事务清 `capability_config.support_refs` 旧 code（仅受影响能力 version+1），`deleteBattlefield` 不动。Web `parseMissions` 返回 `{ok,error}`，缺编号/缺标题/重复编号给出行号错误并阻止 PATCH，空文本合法；`battlefieldEditPatch` 同步返回结果结构，弹层显示错误并禁用保存。验证：typecheck ×3、contracts 32、web 127、API 333 全过（`--maxWorkers=1`），staging 重建后 healthz 200 / 3 战场 / 7 能力 / LTCO 在；并用临时对象跑完冲突与级联 journey（create/patch 同 payload 与跨战场重复均 409 `MISSION_CODE_CONFLICT`；PATCH 移除 Mission → 该能力 v2 refs 只剩 `ZZ-2 + all-battlefields`；再改名 `ZZ-2→ZZ-3` → v3 refs 只剩 `all-battlefields`；另 7 个能力 version 不变），journey 后删临时战场（API 204）与临时能力（受控 SQL）并逐字段对比快照，3 战场（四/一/零 Mission）、7 能力、LTCO、首页 14 卡、2026-09 计划 11 核对项均未变；工作区干净，未 push。
- 24 resolved：2026-09-22 Prompt 治理 + 人类中文表述。W1 `baa2b1d` 抽出 `makeMemoryTools()` 作为 CompanyMemory 只读工具单一来源；W2 `0cf649c` 把跨 Agent 硬规则提升为 `promptRules.ts` 常量；W3 `9200bbe` 新增 `promptStyle.ts` 统一人类中文表述约束；W4 `318bff5` 加 `findForbiddenPhrase`（复用 `TURN_PHRASE_PATTERNS`）；W5 `42b348b` 验证并在 staging 重跑 TKOS，prompt hash 与仓库一致。Prompt 语义边界逐字保留、未删除任何校验，契约值未改；API 307→315，typecheck ×3 通过；工作区干净，未 push。
- 27 resolved：2026-09-22 妙记 Markdown Transcript 导入确认。W1 `2c58e75` 契约（`TranscriptSource`/候选投影/speaker mapping/confirm·discard input、`MeetingCardPayload.transcriptCandidate`）、migration 020 `meetings.transcript_candidate JSONB`、确定性 parser `transcriptMarkdown.ts`、ADR 0007 受限例外；W2 `00550ac` `POST /api/meetings/:id/transcript-candidate` 与 opaque `meeting.confirm_transcript_candidate`/`meeting.discard_transcript_candidate`；W3 `cb7575d` Web Header 按扩展名分流 + aB4pK 预览弹层。验证：typecheck ×3、contracts 33、web 141、API 351（`--maxWorkers=1`）；真实样本仅本地 dry-run（396 turns、4 speakers、首 offset 1、末 4591、无 warning、四人 exact 映射），未上传未落库；staging 重建 api+web 后用临时合成 Meeting + 短 Markdown 跑完 upload→preview→confirm→held→Outcome（候选不改 status/不跑 Outcome；确认后 participants 补齐、写入带 `source` 的 `warmap-transcript.v1`、`startedAt=scheduledAt+offset`、候选清空、Outcome 落 ready），journey 后删除临时 Meeting 与 agent_run 及临时文件；浏览器 1440×900 与 2560×1440 预览弹层无横向溢出。旧 JSON immediate import 与危险替换行为不变；工作区干净，未 push。
