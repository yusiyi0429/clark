# 04b 个人卡页与讨论验收记录

日期：2026-09-27。基础提交：`543c972`（04a）。04b 实现与验证完成，待 Claude 验收、提交。服务、测试库与临时人员目录已清理；唯一未完成的清理是 `apps/web-04b-preview`：自动审批拒绝删除，junction 已解除，副本待人工清理。没有提交代码。

## 改动结果

成员与 CEO 共用 `MissionCardScreen`，分别通过 `/me/mission-cards/[cardId]` 与 `/mission-cards/[cardId]` 打开。同一张卡的正文、来源、版本与意见来自同一份服务端投影。概念版的页头胶囊、本轮单行与展开五步、版本来源行、13 字段阅读页、行内建议、字段意见、整卡意见、右侧群组及个人 Agent 的布局已经移植。

CEO 工作台原有展开、关闭、返回来源、焦点还原与对话宿主提取到 `WorkspaceFrame`，CEO 与成员共同使用；成员首页保留在外壳主区，详情打开后保持原 DOM 并暂停其交互。成员战场详情和雷达页以后可使用同一个展开区。原有 CEO 整理入口现在能打开已建的个人卡；成员通知分组仍属 04d，本单浏览器通过成员个人卡地址进入，没有把直接地址验收描述成已实现通知入口。

草稿阶段能查看已签发目标与签发时间，首次打开本轮按人、按轮展开一次五步说明。开放由现有签名动作执行，固定 48 小时；页头时钟按服务端时间校准、在截止秒位换分钟。正文显示草稿、候选或已确定版本，保留每项 Mission 的占位与来源 revision。版本行、处理结果、开场与分隔线由服务端生成，所有读者看到一致的句子。

公开评论、引用及建议写入独立意见表，保留原文、源版本、作者、窗口与依据；意见不会直接改正文。成员只能看自己相关的卡，当前战场 DRI 能看本战场全部卡，CEO 能看全部，不可见对象返回 404。群组每 3 秒轮询、支持未读及单调已读位置，开放后的开场只出现一次。个人 Agent 按人和卡隔离，不进入公开 Review；成员个人卡 scope 不再下发可绕过卡权限的全表 `list_missions` 工具。

## 测试前后

| 检查 | 基线 | 本次已取得结果 |
|---|---|---|
| Contracts build / tests | 04a build 通过；46/46 | build、gen:client 通过；47/47 |
| API typecheck | 04a 通过 | 通过，见 [api-typecheck.log](api-typecheck.log) |
| API 全量 | 04a 503 通过、8 项 deployment 失败，共 511 | 原指定命令完整跑完 51 文件 / 532 项：524 通过、同样 8 项失败；之后受影响文件 37/37 通过 |
| API 最终文件集合 | 50 文件 / 511 项 | 全量与补充回归去重后 52 文件 / 534 项：526 通过、8 项既有失败；不是单次 534 项长跑 |
| Web 全量 | 本次开工实跑 39 文件，314/314 | 最终 47 文件，372/372，见 [web-final.log](web-final.log) |
| 页面专属测试 | 模块未实现，先建立失败检查 | 30/30，含断网输入保留及行内错误可见性；详见 [web-page-notes.md](web-page-notes.md) |
| Web typecheck | 通过 | 全部收尾改动后 `tsc --noEmit` exit 0，无诊断 |
| 最终差异检查 | — | `git diff --check` 通过；锁文件、候选文件 hash 未变 |

API 始终使用 `pnpm --filter @warmap/api exec vitest run --maxWorkers=1`，未在参数前插入额外 `--`。第一次新接口 Red 为 19/19 失败；实现后先取得新 20 项与原路由 3 项共 23/23 Green，再补权限与重放回归。全量结束后，草稿目标展示与 Agent 工具可见性两项先 Red，再最小修正，相关四个文件共 37/37 Green。证据见 [api-red.log](api-red.log)、[api-discussion-green.log](api-discussion-green.log)、[api-final.log](api-final.log)、[api-context-red.log](api-context-red.log)、[api-context-green.log](api-context-green.log)。

设计 §3.2 的 15 个阶段 × 意见类型组合均分别测试。另覆盖草稿／候选原文引用、源版本冲突、列表建议边界、同 client_id 重放及改内容拒绝、撤换当前战场 DRI 后的权限、锁后取应用时间、并发截止只生成一次快照、首次开场与重开、确认分隔线、自己消息不计未读、已读夹到最后一条且只增不减、私聊隔离与不进快照。

本次首次既有 API 长跑 [api-baseline.log](api-baseline.log) 是 502 通过、9 失败：8 项为已知 deployment 问题；另 1 项发生在长跑期间测试已经更新为 04b 预期，但 worker 仍加载 04a 路由，产生 400 / 404 差异。它不是纯净基线，不把第 9 项算作既有故障；可比初始数使用 04a 的 503 / 8。该路由随后在独占定向及最终全量均通过。本次全量没有出现 04a 记录过的 IPC 中断。

Web 测试覆盖阶段按钮、输入条可用性、引用取消、频道切换隔离草稿、重复提交保护、同内容重试 clientId、中文输入法组词、读标记与轮询、倒计时文本、首次讲解、共享壳返回与焦点行为。页面最初倒计时失败定位为 Windows 不区分大小写导致 `RoundClock.tsx` 与 `roundClock.ts` 解析冲突，时钟模块改名 `useRoundNow.ts` 后通过。浏览器断网又发现错误文案离编辑位置太远，已先加失败测试，再把建议错误放到行内、群组错误放入输入条。成员首页后台轮询的网络拒绝也已加错误边界：2 项先红后绿，保留原内容，恢复后清除连接提示。最终全量 372 项全部通过。

## 测试库演练与边界

浏览器使用 Web 3500 / API 4500，隔离数据库 `warmap_test_fbbf518b5f07`。Web 副本 `apps/web-04b-preview` 与 `apps/web` 同级，`src`、`public` 为真实复制，`node_modules` 为 junction。运行脚本为 [browser-server.ts](browser-server.ts) 与 [start-web-preview.ps1](start-web-preview.ps1)。使用合成人员与登录资料；个人 Agent 使用测试 stub，不连接外部模型或声纹供应商。

已经通过实际页面完成：

1. CEO 从通知栏整理草稿，得到 1 个轮次、5 张个人卡、12 条 Mission，均保留占位来源；从卡页点击「统一开放 48 小时讨论」，再切换至孙铭泽卡。
2. 成员打开 `/me/mission-cards/633142c8-6462-4590-8ae9-3abedb4a94d8`，通过界面分别发 1 条评论、1 条引用、1 条修改建议。数据库共 3 条公开意见，引用／建议保存 `source_version=1` 及原文，依据为 draft。见 [browser-before-cutoff.json](browser-before-cutoff.json)。
3. 成员在个人 Agent 频道发送私聊并收到 stub 回复，公开意见条数没有因此增加；此处证明私有链路与边界，不代表验证了真实模型回答质量。
4. 断网后提交修改建议，输入保留，恢复后可重试成功。发现错误显示在页首而非编辑处后，已移到行内；群组失败反馈也已放到输入条。修复后持续断网覆盖成员首页 20 秒后台轮询，并再次提交建议：新增 `error` / `unhandledrejection` 事件为 0，三处连接提示均为中文，文本保留，见 [browser-offline-fixed.json](browser-offline-fixed.json)。`member-suggestion-offline.png` 已更新为修复后的截图；`offline-dev-overlay.png` 仅保留排查过程，不作为最终合格页面。
5. 独立控制脚本按截止时刻调用 `closeDueRounds`，形成 1 份含 3 条意见的快照。见 [browser-cutoff.json](browser-cutoff.json)、[browser-after-cutoff.json](browser-after-cutoff.json)。之后通过界面再发截止后评论及引用，公开意见共 5 条，新增两条均 `late=true`、`basis=candidate`，当轮快照仍为 3 条。
6. CEO 通过真实页面的重开按钮进入第 2 轮；再在字段内划选部分原文，界面自动切回群组并带入引用，发送成功。最终仍是 1 轮次／5 卡／12 条任务，`window_seq=2`、6 条意见、1 份仍含 3 条意见的旧快照；见 [browser-final-state.json](browser-final-state.json)。两端开场各仅 1 条。
7. CEO 切到私人 Agent 时看不到成员私聊，显示「暂无消息」；成员再发公开引用后 CEO 群组出现未读 1，切回群组后已读。正常关闭 CEO 通知打开的卡，焦点回原通知；两端直接深链接关闭时回各自首页的首页按钮，见 `ceo-source-focus.json`、`ceo-close-focus.json`、`member-close-focus.json`。

**时间演练限制必须保留：**浏览器服务器使用固定应用时钟。原本通过 stdin 推进时钟的控制通道已关闭，因此外部脚本只推进了截止快照，运行中的应用时钟没有同步前移。该浏览器演练验证了 reviewing／late／reopen 界面与持久化状态，不能用后续意见的 `created_at` 证明真实截止边界，也不能声称浏览器倒计时自然走到零。截止前 1ms、恰在截止点、锁后取时以及下一轮时间规则以可控应用时钟的 API 测试为证。

04c 的逐条处理和整轮确认尚未实现，浏览器没有执行这些动作。API 测试里的已采纳及已确定状态由隔离库 SQL 安排前置数据，只用来核验候选引用、只读投影和写入拒绝，不是产品确认入口。

## 浏览器尺寸与截图

成员、CEO 两种身份均在最终源码下重新查看并截图 1440×900、834×1194、390×844，六次 `scrollWidth` 均等于视口；两端正文宽度分别为 840／400／288px，桌面符合 760–880px，窄屏随可用空间收缩。手机群组以浮层打开，输入条和频道切换可操作。成员最后一轮同时启用减少动效；结果见 [browser-metrics.json](browser-metrics.json)。Web 副本与源目录全部 215 个 src 文件 hash 一致，见 [preview-source-check.json](preview-source-check.json)。

| 截图 | 已记录状态 |
|---|---|
| [ceo-1440-draft.png](ceo-1440-draft.png) | CEO 草稿页与统一开放入口 |
| [ceo-1440-open.png](ceo-1440-open.png) | CEO 1440，开放中的个人卡 |
| [ceo-834-open.png](ceo-834-open.png) | CEO 834，开放中的个人卡 |
| [ceo-390-open.png](ceo-390-open.png) | CEO 390，手机阅读 |
| [member-1440-open.png](member-1440-open.png) | 成员 1440，正文与右列 |
| [member-834-open.png](member-834-open.png) | 成员 834 |
| [member-390-open.png](member-390-open.png) | 成员 390，手机阅读 |
| [member-390-group-overlay.png](member-390-group-overlay.png) | 成员手机群组浮层 |
| [member-private.png](member-private.png) | 成员个人 Agent 私聊 |
| [member-suggestion-offline.png](member-suggestion-offline.png) | 最终断网输入保留；行内中文错误，输入条宽度稳定 |
| [member-1440-late.png](member-1440-late.png) | 成员截止后留言 |
| [ceo-1440-reviewing.png](ceo-1440-reviewing.png) | CEO 待拍板页 |
| [ceo-1440-reopened.png](ceo-1440-reopened.png) | CEO 重新开放后的第 2 轮 |
| [ceo-private-unread.png](ceo-private-unread.png) | CEO 私聊为空、公开群组未读 1 |
| [member-home-return.png](member-home-return.png) / [ceo-home-return.png](ceo-home-return.png) | 关闭卡页回到各自首页 |

## 没有从概念版搬来的部分

| 概念版部分 | 本次取舍与原因 |
|---|---|
| 独立 `WorkspaceShell` 实例 | 正文结构整体移植，宿主接现有 `DetailFrame` 与共同 `WorkspaceFrame`，避免两套外壳和重复对话列；CEO 与成员使用同一过渡和焦点实现 |
| 本机 `model.ts` / `store.ts`、localStorage 业务事实与模拟 Agent 回复 | 替换为真实 API、数据库和按人私有 scope；浏览器只保存未提交输入与是否讲过本轮的显示偏好 |
| 演示控制台、演示拨钟、模拟起草等待、Review 渐亮、胶囊扫光节拍 | 设计明确排除，界面只随真实状态变化；浏览器测试控制脚本不进入产品 |
| 目标签发弹窗与整理草稿表单 | MVP 已有月度计划签发及 04a 整理入口；个人卡页只读目标，并执行统一开放 |
| 10 月原件页签、原件下载及飞书全文 | 设计 §0.A：没有 10 月原件且不保存正文副本；保留来源链接和 revision。原件可选阅读分支未接 API、不显示入口 |
| 「未报告」、成功证据执行状态、完成率、达成路径权重 | Mission 在本期是结果承诺，不是执行追踪；证据与里程碑保留原文 |
| Review 逐条采纳／不采纳、从第一条开始、协作核对表单、整轮确认 | 属 04c；本单保留处理结果和候选版本的读投影，不摆放不可执行按钮。04a 已实现的重开动作在本页可用 |
| 成员 Mission Card 通知分组、通知栏共享分钟时钟接线 | 属 04d；本页时钟已支持共享，成员本次使用个人卡深链接验收 |
| 群组头像与成员名单弹层 | 设计 §8 明确延后；本期人数和「成员可见」脚注来自同一成员数据，另显示 Co-Agent |
| 私聊「转为公开意见」 | 设计 §3.3 / §8 明确延后；私聊不会自动进入公开讨论 |
| 会议用 Co-Agent 胶囊、会议录音与麦克风交互 | 本页不是会议现场；个人卡输入条保留停用语音说明，未请求麦克风 |
| 截止催办、确认后的修订、飞书提醒、跨战场合并 | 分别为明确延后项及 GAP-04 / GAP-09 / GAP-01；本单不引入替代规则 |

## 美学自评与人工确认

**自评 8.5 / 10。**保留了概念版「稳定正文 + 清楚版本 + 可追溯意见」的阅读层次；桌面正文 840px、接近不透明，页头和浮层使用晨光厚白玻璃，主要行动与选中使用实心天枢蓝。Owner、拍板人、截止时刻及来源可直接阅读，没有缩进难辨的小灰字。三级圆角、两行输入条、右列收起和手机浮层与现有工作台一致；减少动效、减少透明度和高对比有对应回退。

扣分主要在窄屏的信息密度：13 字段、引用、来源、处理状态同时出现时仍需要真实团队阅读来判断节奏，截图与自动测量只能证明没有横向溢出，不能代替日常使用感受。蓝色主按钮沿用已定品牌色和字号，没有为本页另造一套颜色。

仍需人工确认：

- Claude 验收本单并决定提交；本次没有执行提交或其他 Git 状态修改命令。
- 已知 8 项 Windows deployment 测试失败仍需环境／部署维护者处理，本单未改相关脚本，不宣称全套 API 零失败。
- 讨论候选来自 9 月个人卡；占位、来源与待定里程碑保留，草稿和开放不代表团队已作出本月承诺。
- 外部飞书来源链接与 revision 已呈现，但没有点击或验证每位真实成员的外部文档权限。
- 390 / 834 宽下长期阅读与讨论密度需要产品人工审阅，尤其是长引用和多条意见集中在同一字段的情形。
- 真机 Safari 的键盘、安全区与文本选择手感需要人工体验；本次使用 Chromium 设备尺寸和实际 DOM 交互。
- 后续闭环还需要 04c、04d，以及确认后纠错 GAP-04 的产品规则。

## 清理与最终收尾

- 两个专用浏览器已关闭；Web 进程 48380／64248、API 进程 42152／26976 已停止，3500／4500 无监听。
- 隔离库 `warmap_test_fbbf518b5f07` 已删除并确认剩余 0；临时人员目录 `warmap-04b-browser-mn4JXb` 已删除。见 [browser-cleanup.json](browser-cleanup.json)。
- 3100／4000 PID 22856、3200 PID 58088、4100 PID 63752 与开工时一致；3400／4400 始终没有本次监听。见 [cleanup-ports.json](cleanup-ports.json)。
- 自动审批拒绝预览副本递归删除；拆成已校验文件和空目录的非递归清理也被拒绝，均只返回 `blocked by policy`，未给具体理由。已单独解除 node_modules junction，原依赖目录完整；`apps/web-04b-preview` 仍存在，需人工删除。这是唯一剩余清理项，不能把它写成已完成。
- 预览期间一次辅助 pnpm 调用触发工作区检查，因已知 vendor tarball 缺失而在进入脚本前失败；锁文件未变。随后均直接调用现有 node / tsx / tsc / vitest。没有安装新依赖或修改依赖声明。
- 锁文件 SHA256 保持 `6E98E889889159EED8F731A4C1886490E647FE318149C1D1750A5313968458FC`；候选 JSON 保持 `5C133D53A18025E9F8466FA58FDA30AEDF25F6AC4713641D5480715756086712`。API 声纹文件无差异；未执行任何 Git 写命令。
- 工单已标 resolved（待 Claude 验收、提交，明示清理遗留）；map、CONTEXT、ADR-0022 已同步。

## 改动文件清单

下列为只读 `git status` / `git diff` 核对的完整产品与文档文件。`apps/web-04b-preview` 是自动审批拦截删除的临时运行副本，不属于交付源码，验收提交时不要包含它。

### API 与 API 测试

```text
apps/api/src/personalMissionCards.ts
apps/api/src/conversations.ts
apps/api/src/piConversationRuntime.ts
apps/api/src/routes/conversations.ts
apps/api/src/routes/missionCards.ts
apps/api/test/personalMissionCards.test.ts
apps/api/test/personalMissionCardContext.test.ts
apps/api/test/missionRoundRoutes.test.ts
```

### 契约与自动生成客户端

```text
packages/contracts/src/missionCards.ts
packages/contracts/src/conversations.ts
packages/contracts/src/openapi.ts
packages/contracts/test/missionCards.test.ts
apps/web/src/lib/api/openapi.json
apps/web/src/lib/api/schema.d.ts
```

末两项仅通过 `gen:client` 生成，没有手工修改。

### 路由、成员与共同工作台外壳

```text
apps/web/src/app/(member)/me/layout.tsx
apps/web/src/app/(member)/me/page.tsx
apps/web/src/app/(member)/me/mission-cards/[cardId]/page.tsx
apps/web/src/app/(ceo)/mission-cards/[cardId]/page.tsx
apps/web/src/components/member/MemberWorkspace.tsx
apps/web/src/components/member/memberWorkspace.test.tsx
apps/web/src/components/member/useMemberHome.ts
apps/web/src/components/member/useMemberHome.test.ts
apps/web/src/components/shell/WorkspaceFrame.tsx
apps/web/src/components/shell/workspaceFrame.test.tsx
apps/web/src/components/shell/CeoWorkspace.tsx
apps/web/src/components/shell/WorkspaceContext.tsx
apps/web/src/components/NotificationRail.tsx
apps/web/src/components/missionRoundEntry.test.tsx
apps/web/src/styles/member-home.module.css
```

### 个人卡页面与页面测试

```text
apps/web/src/components/missionCards/MissionCardScreen.tsx
apps/web/src/components/missionCards/CardDocument.tsx
apps/web/src/components/missionCards/RoundLine.tsx
apps/web/src/components/missionCards/RoundClock.tsx
apps/web/src/components/missionCards/useRoundNow.ts
apps/web/src/components/missionCards/loadPersonalMissionCard.ts
apps/web/src/components/missionCards/mission-card.module.css
apps/web/src/components/missionCards/round-line.module.css
apps/web/src/components/missionCards/round-clock.module.css
apps/web/src/components/missionCards/personalMissionFixture.ts
apps/web/src/components/missionCards/personalMissionCard.test.tsx
apps/web/src/components/missionCards/missionCardScreen.test.tsx
apps/web/src/components/missionCards/useRoundNow.test.tsx
```

### 群组、对话宿主与输入条

```text
apps/web/src/conversation/ConversationHost.tsx
apps/web/src/conversation/ColumnComposer.tsx
apps/web/src/conversation/ComposerPill.tsx
apps/web/src/conversation/MissionGroupComposer.tsx
apps/web/src/conversation/MissionGroupTranscript.tsx
apps/web/src/conversation/missionCardGroup.ts
apps/web/src/conversation/useMissionGroup.ts
apps/web/src/conversation/missionCardGroup.test.tsx
apps/web/src/conversation/missionGroupComposer.behavior.test.tsx
apps/web/src/conversation/useMissionGroup.test.ts
apps/web/src/styles/mission-group.module.css
```

### 领域文档与验收证据

```text
CONTEXT.md
docs/adr/0022-persist-monthly-mission-card-rounds.md
.scratch/onboarding/issues/04b-mission-card-page-and-discussion.md
.scratch/onboarding/map.md
.scratch/onboarding/evidence/04b/report.md
.scratch/onboarding/evidence/04b/api-report.md
.scratch/onboarding/evidence/04b/web-page-notes.md
.scratch/onboarding/evidence/04b/browser-server.ts
.scratch/onboarding/evidence/04b/browser-control.ts
.scratch/onboarding/evidence/04b/browser-control.md
.scratch/onboarding/evidence/04b/start-web-preview.ps1
```

本目录同时保存上述截图，以及 `api-*.log`、`web-*.log`、`group-*.log`、`shell-fallback-*.log` 测试／运行记录；`browser-*.json`、`*-focus.json` 为隔离库与浏览器核验；`cleanup-ports.json`、`preview-source-check.json` 为清理及一致性证据。`web-preview-process.json` 保留本次运行 PID 作为审计记录，所列进程已停止。

没有新增依赖或数据库迁移；没有修改 API 声纹文件；没有读取真实密钥；没有 Git add / commit / reset / checkout / stash / push 等改变 Git 状态的操作。
