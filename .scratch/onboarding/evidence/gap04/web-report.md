# GAP-04 · 已确定个人卡的更正 · Web 实现记录

日期：2026-09-27。范围：设计 `design-gap04-corrections.md` 第 0、4、5 节中的 Web 部分，外加负责人给的界面定稿要求 1–10。
没有执行任何改变 git 状态的命令。没有启动或停止服务，没有新增依赖。以下文件没有改：契约、生成的客户端、页面路由、`member/`、`shell/`、`NotificationRail.tsx`、`onboarding/`、全局样式。

## 改了哪些文件

| 文件 | 做了什么 |
| --- | --- |
| `apps/web/src/components/missionCards/CorrectionPanel.tsx`（新） | 放在字段下方的更正区。<br>• 内联编辑：预填当前文字（列表字段一行一条），必填一行「原因」（≤300 字），按钮「提交」（实心）和「取消」。<br>• 历史（点开）：已采纳的改动，写改前 → 改后、原因、谁申请、谁定、时间；直接更正写「{名字} 直接更正」。<br>• 待处理和未采纳的申请：<br>　– 非拍板人看到「更正申请 · 等{deciderName}处理」。<br>　– 拍板人看到「采纳」和「不采纳」。「不采纳」会展开一行必填原因，再点「确认不采纳」。<br>　– `stale` 时停用「采纳」，旁边写「原文已变化」。<br>　– 月份已过写「未处理 · 月份已过」，不给按钮。<br>　– 已驳回的写「未采纳 · {note}」。<br>• 同时导出 `Correction`、`CorrectionDraft`、`CorrectionControls` 三个类型。 |
| `CardDocument.tsx` | • `DocumentControls` 新增可选的 `corrections`。<br>• 入口只看 `correctionAccess`：`canApply` 写「更正」，`canRequest` 写「申请更正」，两者都为 false 时不显示入口。入口放在现有 `.fieldActions` 里。<br>• 字段有已采纳更正时，`dt` 里标「已更正」小标：这是一个按钮，带 `aria-expanded`，点开这个字段的历史。<br>• `closedReason` 不为空、且 `card.shown === "confirmed"` 时，正文最上方写一行只读说明。 |
| `MissionCardScreen.tsx` | • 新增状态：更正草稿、草稿错误、展开历史的字段、正在不采纳的申请、处理错误。<br>• `sendCorrection`：POST corrections，成功后关闭草稿并调用 `void refresh()`，做法同修改建议。<br>• `decideCorrection`：POST decision；不采纳没写原因时不发请求。成功后先 `await refresh()`，再广播 `mission-round-changed` 并调用 `router.refresh()`，做法同现有的处理意见；用 `actionInFlight` 防止重复点击。<br>• 失败时保留输入，服务端 message 和 fieldErrors 原样拼在一行显示（新函数 `failureText`）。<br>• 深链 `?correction=<id>` 和 `?feedback=` 共用一段逻辑：等两帧后聚焦，并按 reduced-motion 决定滚动方式。原 `focusFeedback` 改为通用的 `focusTarget`。<br>• 已确定时，「从第一条开始」找 `firstPendingCorrectionId`：在本卡就聚焦，在别的卡就带 `?correction=` 打开，成员与 CEO 各走自己的路径前缀。 |
| `RoundLine.tsx` | • 状态句传入本卡已采纳的更正数，以及月份是否已过。<br>• 已确定、`correctionAccess.canApply` 为真且 `counts.corrections > 0` 时，显示「从第一条开始」。 |
| `roundStatusText.ts` | 新增可选参数 `corrections: { applied, closed }`。<br>已确定时：拍板人有待处理申请且月份未过，句子是 `todo ?? "N 条更正申请待你处理"`；其他情况是「已确定 · 名字 时间 · 更正 N 处」。 |
| `MissionCardNoticeGroup.tsx` | • 已确定的轮次只在「拍板人 + `counts.corrections > 0`」时显示。<br>• 待办直达 `firstPendingCorrectionId` 所在的卡，并带 `?correction=`。<br>• 已确定时不显示「草稿」小标，因为时钟已写「已确定」。<br>• 有待处理更正的行和待处理意见一样加 `data-waiting` 突出。 |
| `mission-card.module.css` | • 新增样式：`.corrected`（和「占位」同一族的胶囊小标）、`.readonly`、`.history`／`.historyMeta`、`.fixStatus`、`.rejectNote`，以及一行输入框。<br>• 高对比度模式补上新增的边框。<br>• 只用现有的颜色 token；输入框 `width: 100%`，手机上占满宽度。 |
| 测试 | `corrections.test.tsx`（新，18 条）；`missionCardScreen.test.tsx` +7；`missionCardNotices.test.tsx` +3；`roundStatusText.test.ts` +1。 |
| 夹具，只补必填字段 | `personalMissionFixture.ts`（`corrections: 0`、`pendingCorrections`、`firstPendingCorrectionId`、`corrections: []`、`correctionAccess`）、`missionCardNotices.test.tsx` 的行、`roundReview.test.tsx` 与 `notificationSummary.test.tsx` 的 counts。`MemberBattlefieldScreen.test.tsx`、`missionRoundEntry.test.tsx` 靠展开共享夹具已带上新字段，没有改。 |

页面 `page.tsx` 两处都没有改：`?correction=` 和已有的 `?feedback=` 一样，在客户端从 `window.location.search` 读。

## 测试与检查

- 运行方式：在 `apps/web` 下执行 `node node_modules/vitest/vitest.mjs run …`。
- 新增 29 条测试，全部通过，覆盖设计第 5 节 Web 部分的每一条：
  - 三种人看到的入口。
  - 申请与直接更正：原因必填；请求 body（clientId、missionId、field、proposed、reason 去首尾空白、sourceVersion）；失败保留输入并原样显示 message 与 fieldErrors；原样重试复用 clientId，改过后换新；断网时写中文提示。
  - 「已更正」小标与历史，包括「直接更正」、改前改后、原因、谁提谁定、时间。
  - 拍板人的采纳与不采纳：不采纳必须写原因；stale 时停用采纳；失败原因显示在那一条旁边；重复点击只发一次请求。
  - 只读说明（讨论期不显示）；月份已过时写「未处理 · 月份已过」。
  - RoundLine：「更正 N 处」、拍板人的待办、「从第一条开始」；月份已过不再催。
  - 深链聚焦（在入场焦点之后执行）；跨卡与本卡的「从第一条开始」。
  - 通知分组：更正待办的 CEO 与成员 href；非拍板人和没有待处理申请时，已确定的轮次整组退出。
- Red（`web-red.log`）：保留新测试和夹具，把 5 个源文件临时换回 HEAD 版本后运行。
  - 新测试 27 条失败，2 条通过。通过的 2 条是反向守卫：「都不能更正时没有入口」和「非拍板人的已确定轮次不出现」。
  - 这 6 个文件里原有的 58 条测试全部通过，说明旧行为不变。
  - 之后从备份恢复，用 `cmp` 确认字节一致。
- Green（`web-green.log`）：目标 6 个文件 87/87 通过。
- 整个 web 测试集（`web-final.log`）：61 个文件、536 条全部通过。开工前的基线是 60 个文件、507 条。
- 类型检查（`web-typecheck.log`）：`pnpm --filter @warmap/web typecheck` 通过。开工前有 4 个错误，全部是夹具缺新必填字段，已补齐。
- `git diff --check`（`web-diff-check.log`）：退出码 0，只有 LF/CRLF 提示。两个新文件单独检查过，没有行尾空白。

## 消融检查

- **月份已过的守卫要保留**：`roundStatusText` 里的 `!corrections.closed`。
  - 后端在月份过后把 `todo` 置空，但 `counts.corrections` 仍然计算没处理的申请。没有这个守卫，兜底文案会写「N 条更正申请待你处理」。
  - 临时去掉后 2 条测试变红（`web-ablation-closed-guard.log`），已恢复。
- **已删除：RoundLine「全战场」人名胶囊上的待处理更正高亮。** 验收用不到。而且月份过后后端的行文案仍写「N 条更正申请」，高亮会催促一件已经不能办的事。
- **已删除：两个请求上的 `401 → /access` 跳转。** 跳转会丢掉草稿，违背「失败保留输入」，现有的修改建议也不跳转。现在 401 时显示服务端给的「未登录」。
- 其余新增内容都直接对应设计或定稿要求：fieldErrors、广播与 `router.refresh`、「已更正」的悬停与展开边框、只读说明。

## 与设计的偏差和原因

1. **测试没有用 Testing Library。** 仓库里没有 `@testing-library/*` 和 jsdom，约束又不允许新增依赖。所以照 `personalMissionCard.test.tsx`、`missionCardScreen.test.tsx` 的做法，用 `renderToStaticMarkup` 加 hook mock 写测试。
2. **未采纳的申请留在字段下方显示「未采纳 · 原因」，历史里只放已采纳的改动。**
   - 只有被驳回申请的字段不会出现「已更正」小标，申请人仍然要能看到结果。
   - 这样同一条也不会出现两遍。
   - 已采纳的申请在历史里写「{申请人} 申请 · {拍板人} 已采纳」。
3. **拍板人看到的待处理申请不写状态句**，直接给「采纳」「不采纳」。非拍板人看到「更正申请 · 等{拍板人}处理」。
4. **「不采纳」分两步**：先展开一行必填原因，再点「确认不采纳」（ghost 样式）或「取消」。实心天枢蓝只用在「提交」和「采纳」上。
5. **clientId**：草稿打开时生成，原样重试复用；改了文字或原因就重新生成。这和现有修改建议的「编辑后成为新尝试」一致，也避免改过内容后撞上 `CLIENT_ID_CONFLICT`。
6. **fieldErrors** 按「message；key：value」原样拼在同一行显示。
7. **深链聚焦的是这条申请的 `<article id="correction-…">`**，里面包含操作区；滚动方式按 reduced-motion 决定。已采纳的更正在折叠的历史里，不作为深链目标，因为通知和「从第一条开始」只指向待处理的申请。
8. **入口放在现有的 `.fieldActions` 里**：桌面悬停或聚焦时出现，触屏和 ≤759px 时常显，和 04b 的「建议修改」一致。

契约够用，没有需要改契约的地方。

## 需要负责人处理的事项

1. **必须改：`NotificationRail.tsx`。** 第 89 行把已确定的轮次全部过滤掉了，所以 CEO 现在看不到更正待办；成员侧经过 `MemberWorkspace` 已经能显示。建议改成：
   ```ts
   if ("phase" in payload && payload.phase === "confirmed" && !(payload.approver && payload.counts.corrections > 0)) return [];
   ```
   可以顺手改的两处：
   - `missionRoundMeta` 加已确定分支，比如 `return payload.todo ?? "已确定"`。它只用在 `railGroups` 的 meta 和测试里，界面上显示的是 `MissionCardNoticeGroup`。
   - `needsRoundRefresh` 把「已确定且有待处理更正」也算进去，这样 CEO 那边能每 20 秒同步。
2. **可选：`MemberBattlefieldScreen.tsx`。**
   - 它的「下一步」只在集中 Review 时带 `?feedback=`；已确定且有待处理更正时，可以按同样写法带 `?correction=`。
   - 它调用 `roundStatusText` 时没有传 `corrections`。所以战场状态句不写「更正 N 处」，但拍板人有待办时仍会显示服务端的 `todo`。
3. **待产品决定**（来自后端报告第 3 点）：月份过后，拍板人看到的行 `line` 仍是「N 条更正申请」。Web 原样显示，通知已经退出。
4. **浏览器验收时请重点看这几处：**
   - 「已更正」小标：热区最小高度 32px，用负外边距收拢；在 1440、834、390 三个宽度下看 `dt` 里的位置。
   - 390px 下内联编辑和「不采纳」原因框是否占满宽度，页面有没有横向溢出。
   - 桌面上「更正／申请更正」要悬停才出现，是否好找。
   - 提交或取消后，焦点不会回到入口按钮，和现有修改建议一样。

## 证据文件（`.scratch/onboarding/evidence/gap04/`）

- `web-red.log`
- `web-green.log`
- `web-final.log`
- `web-typecheck.log`
- `web-diff-check.log`
- `web-ablation-closed-guard.log`
