# 04a 本月 Mission Card：数据、状态机与讨论候选

Type: feature
Status: ready-for-agent
Blocked by: 01（只在迁移编号和 CEO 通知栏入口上有交点）
Design: `../design-04-mission-cards.md`（本单依据；先读 §0、§1、§2、§5、§6.4、§7、§9 的 04a）
Spec: `../spec.md` §6、§7；产品论证：`../why.md` §（e）（f）

## 目标

在后端建好"本月 Mission Card"的对象和状态机：
- 一轮制定（战场 × 月份）、个人卡、挂在卡上的 Mission（13 字段）
- 统一 48 小时窗口、截止快照、重开
- 拍板人的动作：整理草稿、开放、重开
- 10 月讨论候选（占位）的载入：拍板人在 CEO 通知栏按「整理个人卡草稿」载入，运维也能用脚本载入

本单以后端和契约为主。前端只做 CEO 通知栏里"整理个人卡草稿"的最小入口（确认弹窗 + 执行动作）；个人卡页属于 04b。

## 范围

按设计文档，另加下面几条决定：

1. **迁移 032–034**（设计 §1.3）
   - 写之前确认编号：030 是工单 01 的 `person_onboarding`，031 预留给工单 02（个人雷达）。031 空着也不要挪用，从 032 开始。
   - 同步 `apps/api/test/migrate.test.ts` 的迁移计数。
2. **契约**
   - `packages/contracts/src/missions.ts` 加增量字段（设计 §5.2 末尾）。
   - 新文件 `packages/contracts/src/missionCards.ts`：轮次部分、`MissionCardField`、`MissionRoundSummary`、动作请求等。
   - 在 `openapi.ts` 里登记，然后运行 `gen:client`。
3. **`apps/api/src/missionRounds.ts`**
   - `importMissionCardDrafts`（设计 §7.3）
   - `canApprove`；卡成员的计算
   - 各动作：`draft`、`open`、`reopen`（设计 §2.1、§2.2）
   - `closeIfDue` 和 `closeDueRounds`（§2.3）；快照与结转（§4.1）
   - `mission-round` Card 投影（§5.3）
4. **新端点** `POST /api/mission-rounds/actions/execute`、`GET /api/mission-rounds/:roundId`，写在新路由文件 `apps/api/src/routes/missionCards.ts`。
5. **定时任务** `createMissionRoundScheduler`，接到 `server.ts`。
6. **已有规则的交点**（§1.5）
   - `mission.edit` 遇到挂在卡上的 Mission，返回 409 `MISSION_IN_MISSION_CARD`；投影里不再下发编辑动作；配置页写明原因。
   - 战场下有轮次时，删除战场返回 409。
7. **草稿文件与导入**
   - 草稿文件已经由 Claude 生成：`seed/placeholders/2026-10-mission-cards.battlefield-01.json`（`mission-card-drafts.v1`）。只读，不要改。
   - 服务端从 `MISSION_CARD_DRAFTS_DIR`（默认 `seed/placeholders`，路径解析参照 `COMPANY_MEMORY_SEED_DIR`）按 `{period}-mission-cards.battlefield-{code}.json` 查找。写进 `.env.example`；如果 compose 是逐个传环境变量的，也补上。
   - 能力域按 `capability_config.code` 查找，Owner 按人员名单查找，战场按 `battlefield_config.code` 查找。找不到的立即失败，写明是哪一条。
8. **导入脚本** `apps/api/scripts/import-mission-card-drafts.ts`，并在 `apps/api/package.json` 加 `mission-cards:import`。脚本和 `mission-round.draft` 动作调用同一个函数。
9. **CEO 首页入口**（设计 §6.4）
   - 条件：当月计划已签发、找得到草稿文件、这一轮还没建。满足时，`/api/cards/home` 给 CEO 多一张入口 Card，带 `mission-round.draft` 动作（签名对象是 slot，见 §2.2）。
   - 通知栏「战略决策更新」组显示一条「{M} 月 Mission Card · {战场} · 可以整理个人卡草稿」。
   - 点开弹出确认框，写明"草稿是占位：Agent 起草未接入，由 9 月个人卡生成，待大家讨论修改"。确认后执行动作。
   - 成功后通知栏这一条变成「草稿 · 可以统一开放讨论」。打开卡的页面归 04b；在那之前，点它先停在首页，只提示"个人卡页即将上线"。
   - 已经建好的轮次，也在这一组显示对应阶段的一条（设计 §6.4 的说明文案），倒计时在 04d 接共享时钟之前，按分钟显示即可。
10. **文档**
    - 新增 ADR-0022：本月 Mission Card 在 MVP 的落地方式（与月度计划签发的关系；草稿 Mission 与生效 Mission 的区别；拍板人动作走新端点；确认后编辑被锁，GAP-04）。
    - 修订 ADR-0019 §4、§6 和 ADR-0020 §3 的相关口径。
    - 更新 `CONTEXT.md`：修改 Mission 词条，新增「本月 Mission Card」「Mission Card 轮次」「公开意见」「集中 Review」「讨论候选（占位草稿）」。

## 质量标准

- 业务含义第一：
  - 目标签发和个人卡确认是两次不同的决定。
  - 草稿 Mission 不能冒充生效事实：投影里带 `personalCard.status`，界面打小标。
  - 占位的来源必须如实写出。
- 时间只信应用时钟 `ctx.now()`；48 小时由数据库 CHECK 保证。
- 并发和幂等要有测试（设计 §9 的 04a 测试清单全部覆盖）。

## 约束

- 遵守 `CLAUDE.md`。
- 不新增依赖。
- 不提交、不推送，不改 git 状态，提交由 Claude 在验收后做。
- 不读、不打印密钥。
- 共享文件只做增量修改，动手前重读一遍。
- 生成文件只用 `gen:client` 生成。
- 命名：新代码不单写 `MissionCard`，用 `PersonalMissionCard` 或 `mission-round`（设计 §1.5）。

## 验证

- 开工前先跑一次基线；完成后跑下面这组：
  - `pnpm --filter @warmap/contracts build && pnpm --filter @warmap/contracts test`
  - `pnpm --filter @warmap/web gen:client`
  - `pnpm --filter @warmap/api typecheck && pnpm --filter @warmap/api exec vitest run --maxWorkers=1`
  - `pnpm --filter @warmap/web typecheck && pnpm --filter @warmap/web test`
- 在测试库里走一遍：签发一份 2026-10 计划，整理草稿，核对轮次、卡和 Mission 的数量与标记；开放，拨时钟到截止，看快照；重开。
- 浏览器：CEO 通知栏入口在 1440 和 375 宽下都能正常显示，确认弹窗可用。

## 验收

- [ ] 迁移 032–034 生效，CHECK 和唯一约束有测试。
- [ ] 签发计划之前，整理草稿被拒，说明写清楚；签发之后，CEO 可以在通知栏整理草稿。结果是 1 个轮次、5 张卡、12 条 Mission：`placeholder=true`，版本都是 1，里程碑带「待定 · 」，来源写成讨论候选（占位）。
- [ ] 同一文件重复整理没有任何变化；文件改动之后被拒；非拍板人被拒。
- [ ] 开放正好 48 小时；重复开放 409；重放不重开；旧版本 409 并带 latestCard。
- [ ] 截止快照只收 `created_at < closes_at` 的意见；重复执行不重复写快照；两个战场互不影响。
- [ ] 重开的前置条件、`reopens`、`window_seq` 和结转都正确。
- [ ] 挂在卡上的 Mission 不能用 `mission.edit` 改，配置页写明原因；有轮次时不能删战场。
- [ ] ADR-0022、ADR 修订和 CONTEXT 词条已写。
- [ ] 契约、类型检查、测试全部通过（原本就有的失败除外）。

## 完成后

- 把 `Status` 改为 `resolved`，在 `../map.md` 追加结果摘要。
- 最终回复列出：改动文件、测试前后对比、仍需人确认的点。
