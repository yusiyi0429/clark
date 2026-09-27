# GAP-04 · 已确定个人卡的更正 · API 报告

日期：2026-09-27。分支 `feat/mvp-member-workspace`。范围：设计 `design-gap04-corrections.md` 第 1、3、5 节中的 API 部分。

- 没有执行任何 Git 写命令。
- 没有改 `packages/contracts`、`apps/web`、`docs`。
- 没有启停服务。
- 测试只连 54329 上的一次性 `warmap_test_*` 库。

状态：实现与验证完成，待验收。

## 改动文件

| 文件 | 做什么 |
| --- | --- |
| `apps/api/migrations/035_mission_card_corrections.sql`（新增） | 建 `mission_card_corrections` 表和两个索引，见下节 |
| `apps/api/src/missionCardCorrections.ts`（新增） | 两个写入口：`createMissionCardCorrection`（提交申请／直接更正）、`decideMissionCardCorrection`（采纳／不采纳） |
| `apps/api/src/missionRounds.ts` | ① `correctionPeriodClosed(round, now)`：`period < companyPeriod(now)`。② 抽出共用写回 `writeMissionFields`，整轮确认改为调用它，行为不变。③ `projectMissionRoundCard` 增加 `counts.corrections`、拍板人的 `todo`，以及每行的 `pendingCorrections`／`firstPendingCorrectionId`／`line`。④ `listMissionRoundCards` 对拍板人额外包含已确定、月份未过、仍有待处理申请的轮次，带 period 时同样生效。⑤ `ROUND_CONFIRMED` 文案改为指向更正 |
| `apps/api/src/personalMissionCards.ts` | ① 读侧：`CorrectionRow`、`projectCorrection`（含 `stale`、人名）、`currentMissions`（已确定卡的正文）。② `getPersonalMissionCard` 增加 `corrections`（新的在前）、`correctionAccess`，状态行加「 · 更正 N 处」。③ 把修改建议的规范化与长度规则抽成 `normalizedProposal`／`proposalProblem`，讨论期建议与更正共用，行为不变。④ 导出 `fieldText` |
| `apps/api/src/routes/missionCards.ts` | 新增 `POST /api/mission-cards/:cardId/corrections` 与 `POST /api/mission-cards/:cardId/corrections/:correctionId/decision`，body 用冻结契约的 schema 校验 |
| `apps/api/src/missions.ts` | `MISSION_IN_MISSION_CARD` 文案改为「讨论中请在个人卡上提修改建议；已确定之后请在个人卡上申请更正」 |
| `apps/api/test/missionCardCorrections.test.ts`（新增） | 9 条，覆盖设计第 5 节 API 部分 |
| `apps/api/test/migrate.test.ts` | 迁移清单加 035，计数改为 35，断言新表存在 |

没有测试断言旧的两句「……待定（GAP-04）」文案，所以不需要同步改已有断言。

## 迁移 035

- 字段、`CHECK`、`UNIQUE (author_id, client_id)`、两个索引（`mission_card_corrections_card`、部分索引 `mission_card_corrections_pending`）与设计第 1 节一致。
- 四条表级约束按 034 的写法命名：
  - `mission_card_corrections_decided`：pending ⇔ 没有 `decided_at`。
  - `mission_card_corrections_applied`：applied ⇔ 有 `applied_version`。
  - `mission_card_corrections_rejected_note`：rejected 必须有 note。
  - `mission_card_corrections_direct`：direct 只能是 applied。
- 外键指向 `mission_rounds`、`personal_mission_cards`、`missions`。

## 实现要点

**提交** `POST .../corrections`，按设计第 3 节顺序校验：

1. advisory lock 按 author+clientId 串行（同 feedback）。
2. 看不到卡 → 404 `PERSONAL_MISSION_CARD_NOT_FOUND`。
3. `SELECT … FROM missions WHERE id=? AND personal_mission_card_id=? FOR UPDATE`，没有 → 404 `MISSION_NOT_FOUND`。
4. 幂等：同内容返回原记录，内容不同或换卡 → 409 `CLIENT_ID_CONFLICT`。
5. 没确定 → 409 `CORRECTION_NOT_CONFIRMED`。
6. 月份已过 → 409 `CORRECTION_PERIOD_CLOSED`。
7. `sourceVersion` 不符 → 409 `SOURCE_VERSION_CONFLICT`。
8. 规范化后为空或超长 → 400 `INVALID_CORRECTION`。
9. 与原文一样 → 400 `CORRECTION_UNCHANGED`。
10. `reason` trim 后为空 → 400 `INVALID_CORRECTION`。

通过后分两种人：

- 拍板人：用 `writeMissionFields` 写回，版本 +1，记 `direct=true`、`status='applied'`、`decided_by=本人`、`decided_at=at`、`applied_version=新版本`。
- 其他人：记 `pending`，`original` 取当前 `fieldText`。
- 时间 `at` 在取锁之后读。

**处理** `POST .../decision`：

1. 看不到卡 → 404。
2. 不是拍板人 → 403 `FORBIDDEN`。
3. 更正不存在或不属于该卡（含非 UUID）→ 404 `CORRECTION_NOT_FOUND`。
4. 先锁 Mission 行，再锁更正行。
5. 月份已过 → 409。
6. 已处理：结论相同原样返回；不同 → 409 `CORRECTION_DECIDED`。
7. 不采纳且 note trim 后为空 → 400 `CORRECTION_NOTE_REQUIRED`。
8. 采纳时当前文字 ≠ `original` → 409 `CORRECTION_STALE`，申请保持 pending；否则写回、版本 +1、记 applied。

**不改的**：

- 轮次 `version` 不变（测试断言仍为 5）。
- 不加通知表，不加申请人结果通知。
- Co-Agent 上下文代码未动。

## 测试结果

运行方式：在 `apps/api` 下执行 `node node_modules/vitest/vitest.mjs run --maxWorkers=1 …`，分小批运行。没有遇到 `ERR_IPC_CHANNEL_CLOSED`。

| 测试文件 | 通过 |
| --- | --- |
| `missionCardCorrections.test.ts`（新增） | 9/9 |
| `migrate.test.ts` | 4/4 |
| `missionCardMigrations.test.ts` | 2/2 |
| `missionCardNotices.test.ts` | 4/4 |
| `missionDraftHome.test.ts` | 1/1 |
| `missionDraftScript.test.ts` | 1/1 |
| `missionRoundGuards.test.ts` | 2/2 |
| `missionRoundHomeMerge.test.ts` | 1/1 |
| `missionRoundReview.test.ts`（04c 整轮确认写回） | 10/10 |
| `missionRoundRoutes.test.ts` | 3/3 |
| `missionRoundScheduler.test.ts` | 2/2 |
| `missionRounds.test.ts` | 14/14 |
| `mission.test.ts` | 6/6 |
| `personalMissionCards.test.ts` | 21/21 |
| `personalMissionCardContext.test.ts` | 2/2 |
| `onboarding.test.ts` | 7/7 |
| `memberHome.test.ts` | 5/5 |
| `meetingFollowThrough.test.ts` | 12/12 |
| `auth.test.ts`（调用首页／引导） | 6/6 |
| `journey.test.ts`（同上） | 8/8 |
| `config.test.ts`（同上） | 22/22 |
| `issueDecision.test.ts`（同上） | 24/24 |
| `observabilitySecurity.test.ts`（同上） | 9/9 |
| `myRadar.test.ts`（同上） | 15/15 |
| **合计 24 个文件** | **190/190** |

`missionRounds.test.ts` 改动前的基线是 9 条失败：冻结契约新增的必填字段让它的 `Value.Check(MissionRoundSummary)` 不通过。实现后全部通过。

新测试 9 条的覆盖面：

1. 迁移约束：12 个字段都可写；非法字段、长度、状态与处理字段的组合被拒（23514）；幂等键重复被拒（23505）；外键被拒（23503）。
2. 写入：
   - Owner 的申请保持 pending，原文按 `fieldText` 口径，Mission 不变。
   - 拍板人直接更正列表字段时按行拆分，只改这一个字段，版本只 +1；并发重放和事后重放返回同一条，不再写。
3. 错误码按顺序覆盖：404×2、`MISSION_NOT_FOUND`、`SOURCE_VERSION_CONFLICT`、`CORRECTION_UNCHANGED`（文本和列表）、`INVALID_CORRECTION`（空白原因、空、只有空行、31 行、501 字、名称 201 字）、`INVALID_INPUT`、`CLIENT_ID_CONFLICT`（换内容、跨卡）、`CORRECTION_NOT_CONFIRMED`（reviewing、open）；重放先于状态判断；失败路径不写任何行。
4. 处理：
   - 看不到卡 → 404；非拍板人 → 403；不存在、非 UUID、不属于该卡 → 404。
   - 并发采纳只写一次；重复采纳幂等，反向结论 → 409。
   - 不采纳缺 note 或只有空白 → 400；note 按 trim 保存。
   - 采纳列表字段时按行拆分；采纳时的 note 按 trim 保存。
5. stale：
   - 同字段被直接更正后，申请标 `stale`（页面和重放都能看到），采纳 → 409 且保持 pending。
   - 其他字段的申请照常采纳；stale 的申请可以不采纳。
6. 月份（可控时钟，上海时区）：
   - 10/31 23:59:59 可提交；11/1 00:00 起，提交和处理都返回 409，`correctionAccess` 为只读，`todo` 为空，通知退出。
   - 11 月的卡在 10 月底可以更正，跨入 11 月后仍可以处理。
7. 投影：
   - 历史按时间倒序，人名正确。
   - 三种人的 `correctionAccess`：Owner 可申请；CEO 拍板人可直接更正；本战场 DRI 拍板人可直接更正；看不到卡的人得到 404。
   - 状态行「已确定 · 测试甲 10/4 10:00 · 更正 N 处」。
   - `counts.corrections`、拍板人的 `todo`、行上的 `pendingCorrections`／`firstPendingCorrectionId`（最早一条）、`line`（拍板人看到「N 条更正申请」，Owner 看到「已确定」）；处理完恢复。
   - 未确定的卡给出「还没确定」的只读原因。
   - 页面 payload 通过 `Value.Check(PersonalMissionCardPayload)`。
8. 通知：`/api/me/mission-cards` 和 CEO 首页只对拍板人（CEO，或切换成 DRI 的成员）包含该轮，Owner 看不到；处理完即退出。
9. 按月限定的 `listMissionRoundCards` 同样生效：本月拍板人包含，Owner、其他月份、月份已过都不包含。

变异抽查：临时去掉 notice 列表里的月份判断、去掉采纳时的 stale 判断，新测试有 3 条变红。随后从备份恢复，`cmp` 确认字节一致，复跑 9/9 通过。

## 类型检查与格式

- `pnpm --filter @warmap/api typecheck`（`tsc --noEmit`）通过。它只覆盖 `src`，测试文件不在 tsc 范围内。
- `git diff --check` 退出码 0。新文件没有行尾空白。

## 与设计的偏差及原因

1. **提交第 6 步的顺序**：设计只写了「与原文一样 → `CORRECTION_UNCHANGED`；原因空白 → `INVALID_CORRECTION`」。我把「规范化后为空、超长 → 400 `INVALID_CORRECTION`」放在二者之前，先校验改后文字本身，再比对原文，最后看原因。
2. **幂等比对不含 `sourceVersion`**：设计的表不存 source_version，所以重放按卡、个人任务、字段、规范化后的 proposed 和 trim 后的 reason 比对。内容相同、只换了 `sourceVersion` 的重放返回原记录，不算冲突。
3. **迁移约束命名**：给四条表级 CHECK 起了名字（沿用 034 写法），语义与设计一致。索引名沿用设计。
4. **`ROUND_CONFIRMED` 文案**：用的是「本月 Mission Card 已确定；要改字段，请在个人卡上更正」，而不是示例里的「申请更正」。这个分支之前已有 403 拍板权检查，只有拍板人会看到，而拍板人在卡上是直接「更正」。
5. **非拍板人提交也 `FOR UPDATE` 锁 Mission 行**：设计只要求拍板人路径加锁。统一加锁只需一条代码路径，而且原文与版本判断在同一把锁下，锁持有时间很短。
6. **处理申请的判断时机**：可见性、拍板权和更正归属在取锁前判断，取锁（先 Mission、再更正行）后不再重读拍板权。锁等待很短，MVP 不加二次校验。
7. **采纳时的 note**：契约允许在采纳时附 note，trim 后保存，空白视为没有。

## 未解决的问题与提醒

1. **Co-Agent 上下文会带上更正**：`conversations.ts` 的 `getScopeObject` 把整份个人卡 payload 作为对话快照，所以 `corrections`／`correctionAccess` 会随 payload 进入 Co-Agent 上下文。按要求没改上下文代码；如果要排除，需要改 `conversations.ts`（不在本次范围）。
2. **引导「下一件事」不提示更正**：`onboarding.ts` 的 `ceoRoundNext` 只认 draft／reviewing，拍板人有待处理更正时引导不会提示；通知栏和 CEO 首页已经提示。`onboarding.ts` 不在允许修改的范围内。
3. **月份过后仍在 pending 的申请**：`todo` 和通知都已退出，但拍板人看到的行 `line` 仍是「N 条更正申请」，`counts.corrections` 仍计数。这是按「拍板人看到的已确定行：pending>0 时 line 为 N 条更正申请」字面实现的。如果希望月份过后行回到「已确定」，只需在 `missionCardLine` 的调用处加月份判断，一行改动。请产品决定。
4. **成员战场详情**：`memberBattlefields.ts` 用轮次行的 `line` 作卡状态，DRI 拍板人在那里也会看到「N 条更正申请」。与规则一致，仅提示。
5. **已确定后发公开意见的文案未改**：仍返回 `ROUND_CONFIRMED`「本月 Mission Card 已确定，不再收留言」，不在本次要求内。
6. **测试夹具提醒**：`monthly_plans` 的 `negotiation`／`generation` 写成 `'{}'` 时，`GET /api/cards/home` 会 500。原因是月度通知投影要读完整结构，与本次改动无关（没有任何轮次时用最小夹具也能复现，换成完整 JSON 就是 200）。新测试已改用完整 JSON。
7. **未执行的检查**：
   - `deployment.test.ts`：按要求没跑。
   - `apps/api` 全量测试没跑，只跑了上表 24 个文件，即 mission 相关的全部文件和所有调用首页／引导的文件。
8. **文档**：`CONTEXT.md`、ADR-0019／0022 里「确认后纠错仍属 GAP-04」的说法需要文档侧更新。工作区里已经有其他代理改了 `CONTEXT.md` 并新增 ADR-0023，我没有碰。
