# GAP-04 · 已确定个人卡的更正 · 设计

- 日期：2026-09-27。用户原话：「已确定的个人卡发现错了怎么改……你也来思考一下怎么做更好，然后给我解释一下，然后去实现就好」。
- 依据：SSOT GAP-04（已确定之后的重新修订、撤回、重开与跨月结转尚未定义）、ADR-0022、`design-04-mission-cards.md`、04a–04d 的实现。

## 0. 规则（给用户的解释，已在对话里说明）

确认过的个人卡是组织承诺。改它要同时满足三条：拍板人点头、每次都留痕、不把整轮重来。做成「确认后更正」，沿用讨论期大家熟悉的「建议 → 拍板」。

1. **谁能提**：看得到这张卡、又不是拍板人的人（卡的主人等），在某个字段上「申请更正」：写改后的文字和原因。
2. **谁来定**：这张卡的拍板人（CEO 或本战场 DRI，同 `canApprove`）逐条处理。
   - 「采纳」：写回 Mission，只改这一个字段，版本号 +1。
   - 「不采纳」：必须写一句原因。
   - 拍板人自己发现错了，直接「更正」，同样要写原因，立即生效。
3. **看得见**
   - 字段上标「已更正」，历史里写改前改后、谁提的、谁定的、原因、时间。
   - 卡的状态行写「已确定 · {拍板人} {时间} · 更正 N 处」。
   - 拍板人有待处理的申请时，通知栏重新出现这一轮，写「N 条更正申请待你处理」。
4. **边界**
   - 只有**月份还没过**的已确定卡能更正：轮次月份不早于公司时区的当前月份（月底提前确定的下月卡也能更正）。月份过了，卡只读，要改的放进下个月的卡（跨月结转走下一轮草稿）。
   - 不重开整个战场，不撤回整张卡，也不删个人任务。某项个人任务本月不做了，就更正它的「预期结果」「边界」并写明原因；复盘时原承诺和改动都在。
   - 申请提交之后字段又被改过（当前文字 ≠ 申请时的原文），这条申请标为「原文已变化」，不能直接采纳：拍板人可以不采纳，或按最新文字直接更正。
   - 讨论中、截止后到确认前仍按原流程（修改建议、集中 Review），不走更正。

## 1. 数据：迁移 `035_mission_card_corrections.sql`

```sql
CREATE TABLE mission_card_corrections (
  id UUID PRIMARY KEY,
  round_id UUID NOT NULL REFERENCES mission_rounds (id),
  card_id UUID NOT NULL REFERENCES personal_mission_cards (id),
  mission_id TEXT NOT NULL REFERENCES missions (id),
  field TEXT NOT NULL CHECK (field IN ('title','why','outcome','successEvidence','boundaries','keyPath','milestones','resources','dependencies','humanAgentSplit','risk','retrospect')),
  original TEXT NOT NULL,            -- 提交时这个字段的文字（fieldText 口径）
  proposed TEXT NOT NULL CHECK (char_length(proposed) BETWEEN 1 AND 4000),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
  author_id TEXT NOT NULL,
  client_id UUID NOT NULL,
  direct BOOLEAN NOT NULL,           -- 拍板人直接更正（没有经过申请）
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected')),
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  note TEXT CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 300),
  applied_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (author_id, client_id),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'applied') = (applied_version IS NOT NULL)),
  CHECK (status <> 'rejected' OR note IS NOT NULL),
  CHECK (NOT direct OR status = 'applied')
);
CREATE INDEX mission_card_corrections_card ON mission_card_corrections (card_id, created_at DESC);
CREATE INDEX mission_card_corrections_pending ON mission_card_corrections (round_id) WHERE status = 'pending';
```

## 2. 契约（已冻结，`packages/contracts/src/missionCards.ts`）

- `MissionCardCorrectionView`、`CreateMissionCardCorrectionRequest`、`DecideMissionCardCorrectionRequest`、`MissionCardCorrectionResponse`。
- `PersonalMissionCardPayload` 新增：
  - `corrections`：这张卡的全部更正，新的在前。
  - `correctionAccess`：`{ canRequest, canApply, closedReason }`，界面据此决定显示哪些入口。
- `MissionRoundSummary.counts.corrections`：本轮待处理的更正申请数（事实，所有看得到本轮的人一致）。
- `MissionCardRow` 新增 `pendingCorrections` 与 `firstPendingCorrectionId`。
- 路由：
  - `POST /api/mission-cards/{cardId}/corrections`
  - `POST /api/mission-cards/{cardId}/corrections/{correctionId}/decision`

## 3. API 行为

**提交更正** `POST /api/mission-cards/:cardId/corrections`，body `{ clientId, missionId, field, proposed, reason, sourceVersion }`：
1. 看不到卡 → 404 `PERSONAL_MISSION_CARD_NOT_FOUND`；个人任务不在这张卡上 → 404 `MISSION_NOT_FOUND`。
2. 幂等：同一 `(author, clientId)` 重放返回同一条；内容不同 → 409 `CLIENT_ID_CONFLICT`。
3. 轮次没确定 → 409 `CORRECTION_NOT_CONFIRMED`「还没确定：讨论中请用修改建议，截止后由拍板人处理」。
4. 轮次月份早于公司当前月份（`companyPeriod(now)`）→ 409 `CORRECTION_PERIOD_CLOSED`「月份已过，这张卡只读；要改的放进下个月的个人卡」。
5. `sourceVersion` ≠ Mission 当前版本 → 409 `SOURCE_VERSION_CONFLICT`「页面版本已变化，请刷新后重新提交」。
6. 规范化后的 `proposed` 与当前文字一样 → 400 `CORRECTION_UNCHANGED`「新文字和原文一样」；`reason` 为空白 → 400 `INVALID_CORRECTION`。
7. 拍板人：同一事务里锁 Mission 行、写回字段、版本 +1，记 `direct=true, status='applied'`。其他人：记 `pending`。
8. 返回 `{ correction }`。

**处理申请** `POST /api/mission-cards/:cardId/corrections/:id/decision`，body `{ decision: "apply" | "reject", note? }`：
1. 不是当前拍板人 → 403 `FORBIDDEN`「只有拍板人能处理更正申请」；更正不存在或不属于这张卡 → 404 `CORRECTION_NOT_FOUND`。
2. 月份已过 → 409 `CORRECTION_PERIOD_CLOSED`。
3. 已处理：结论相同返回原结果（幂等），不同 → 409 `CORRECTION_DECIDED`「这条更正已经处理过」。
4. reject：`note` 必填 → 否则 400 `CORRECTION_NOTE_REQUIRED`「不采纳要写一句原因」。
5. apply：锁 Mission 行；当前字段文字 ≠ `original` → 409 `CORRECTION_STALE`「申请之后这个字段又改过了，不能直接采纳；可以不采纳，或按最新文字直接更正」（保持 pending）。否则写回、版本 +1、记 `applied`。
6. 返回 `{ correction }`。

**写回**：抽出 `missionRounds.ts` 里确认写回用的列映射与列表字段规则（`successEvidence`、`milestones` 按行拆成 JSON 数组）成一个共用函数，整轮确认与更正共用，不写第二份。

**投影**
- 个人卡 `corrections` 全部可见：看得到卡的人都看得到这张卡的更正历史。
- `correctionAccess.canApply`：已确定、月份未过、且是当前拍板人（`canApprove`）。
- `correctionAccess.canRequest`：已确定、月份未过、看得到卡、且不是拍板人。
- `correctionAccess.closedReason`：未确定时「还没确定：讨论中请用修改建议」；月份已过时「月份已过，这张卡只读」；可更正时为 null。
- 卡状态行：有已采纳的更正时在「已确定 · 名字 时间」后接「 · 更正 N 处」。
- `stale`：pending 且当前字段文字 ≠ original。
- 轮次：
  - `counts.corrections` 为本轮 pending 数。
  - 拍板人在 confirmed 且有 pending 时，`todo` 为「N 条更正申请待你处理」。
  - `cards[]` 行带 `pendingCorrections`、`firstPendingCorrectionId`；拍板人看到的行 `line` 在有待处理时写「N 条更正申请」。
- 通知：`/api/me/mission-cards` 与 CEO 首页的轮次卡，对拍板人额外包含已确定、月份未过、且有待处理更正申请的轮次（其他人不变：确认后整组退出）。

## 4. Web 行为

- 个人卡页正文（CardDocument），在已确定且 `canApply`／`canRequest` 时：
  - 每个字段旁一个轻按钮：拍板人写「更正」，其他人写「申请更正」。
  - 点开后，字段下方出现内联编辑：文本框预填当前文字，一行「原因」（必填），「提交」／「取消」；列表字段每行一条。
  - 发送失败时保留输入，fieldErrors 与错误信息原样显示。
- 字段上有已采纳的更正时标「已更正」，点开看历史：改前 → 改后、原因、谁提的、谁定的、时间；直接更正写「{拍板人} 直接更正」。
- 待处理的申请：
  - 主人看到「更正申请 · 等{拍板人}处理」。
  - 拍板人看到原文与改后的对照、原因，以及「采纳」「不采纳」（不采纳要写一句原因）。
  - `stale` 的申请「采纳」停用，写「原文已变化」。
- 已处理的申请：主人看到「已采纳」或「未采纳 · 原因」。
- 本轮那一行（RoundLine，已确定时）：
  - 状态句接「 · 更正 N 处」。
  - 拍板人有待处理时写「N 条更正申请待你处理」，按钮「从第一条开始」跳到第一条待处理申请所在字段并聚焦。
- `closedReason` 不为空、卡又已确定（月份已过）时，正文上方写一行只读说明；这时仍在 pending 的申请写「未处理 · 月份已过」。
- 通知分组：拍板人看到已确定但有待处理申请的轮次，行写「N 条更正申请」，待办行「N 条更正申请待你处理」直达第一条（`?correction=<id>`）。
- 美学与 04b–04d 一致：
  - 按钮用现有的 ghost／tertiary 样式，实心天枢蓝只用于「提交」「采纳」。
  - 「已更正」小标与「草稿／占位／已确定」同一族。
  - 手机上内联编辑占满宽度，不横向溢出。

## 5. 测试

- **API**
  - 迁移清单与约束。
  - 申请与直接更正的写入规则（上面每个错误码一条）；幂等；拍板人直接更正写回且只升一次版本、只改一个字段；列表字段按行拆分。
  - 处理申请：采纳写回、不采纳要原因、重复处理幂等与冲突、stale 不能采纳。
  - 月份已过只读；未确定时拒绝。
  - 投影：`corrections`、`correction` 权限三种人、状态行「更正 N 处」、`counts.corrections`、拍板人 todo、通知列表对拍板人包含有待处理申请的已确定轮次、对其他人不包含。
  - 整轮确认的写回在抽出共用函数后行为不变（原有 04c 测试全部通过）。
- **Web**
  - 三种人看到的入口；申请与直接更正的表单（原因必填、失败保留输入）。
  - 历史与小标；stale 停用采纳；RoundLine 文案与「从第一条开始」；通知分组的更正待办；只读说明。
