# 04c · 集中 Review 与确认

基线提交：`ee6943c`（04b），开工时工作区干净。日期：2026-09-27。未执行 Git 写操作；提交由 Claude 验收后完成。

## 改动结果

拍板人可逐条采纳／不采纳、改判，再填写跨人员依赖、冲突与协作核对结论，一次确认本战场全部个人卡。采纳期间只显示候选；确认事务才写 Mission。旧轮次版本、未处理意见、空白核对结论、Mission 快照版本变化、同字段双采纳均拒绝。每个涉及采纳修改的 Mission 合并为一次 UPDATE，未采纳字段、来源、占位标记与其他 Mission 保持原值；重复动作不重复写入。

概念版 `round`、`round-panel`、`card-document`、`model` 对应的本轮入口、三步规则汇总、全战场卡入口、字段原文／建议对照、逐条处理、重开弹窗、核对表单、确认记录接到真实 API。冲突原因和处理结果由服务端统一投影，成员无拍板按钮。群组带 `roundVersion`，无新消息时也更新已有意见的结果；不把处理结论当新消息或增加未读。

跨卡「从第一条开始」定位并聚焦真正待处理意见。核对草稿仅作为未提交输入按人、轮次、窗口存于 sessionStorage，跨卡查看依赖后仍在，重开／确认清空。确认后业务事实和公开意见只读；私人 Agent 仍可只读问答，不进入 Review。Mission 详情显示「已确定」并链接所属个人卡。

已读取 CLAUDE、CONTEXT、ADR-0019/0020/0022、前序 map 与 01/01p/01q/04a/04b 报告，以及概念库 `../clark-main` 的 SSOT M-04、M-05、AC-10/11/12/20 和相关组件。**仓库中不存在 ADR-0021**，没有补造其内容。

## 测试前后

| 检查 | 前／Red | 最终 |
|---|---|---|
| Web 全量 | 实跑 47 文件，372/372 | 49 文件，390/390；新增 18 项 |
| Contracts | 实跑 47/47；新增契约 Red 3 失败，再补群组版本 Red 2 失败 | 49/49；build、gen:client 成功 |
| 04c API 新场景 | 有效 Red 9/9 失败 | 10/10 通过 |
| 旧轮次 API | 原有 14 项 | 14/14 通过 |
| API 全量 | 04b 报告的去重基线：526 通过／8 项部署失败 | 53 文件完整跑完：536 通过／同样 8 项部署失败；新增 10 项全部通过 |
| 类型检查 | 前序已通过 | API／Web 通过；Contracts build 通过 |

证据：`web-baseline.log`、`web-red.log`、`web-sync-red.log`、`web-focus-red.log`、`web-note-red.log`、`web-ui-green.log`、`web-final.log`、`contracts-baseline.log`、`contracts-red.log`、`group-contract-red.log`、`contracts-green.log`、`gen-client.log`、`api-red.log`、`api-review-final.log`、`api-rounds-final.log`、`api-typecheck.log`、`web-typecheck.log`。早期 Web 类型检查曾检出测试 fixture 未补新字段，已修正后通过。

API 新测试覆盖权限、同字段冲突和改判、旧版本 latestCard、跨快照意见拒绝、并发重放、全部 Mission 版本检查、列表拆行、只写采纳字段、无采纳修改不升 Mission 版本、核对非空、重开结转、截止后留言、确认后只读与当前 DRI 撤权。详细记录见 [API 报告](api-report.md)。两次定向运行曾出现 Tinypool `ERR_IPC_CHANNEL_CLOSED`，保留原日志且不计通过，没有放宽断言、超时或更换 pool。

最终严格执行 `pnpm --filter @warmap/api exec vitest run --maxWorkers=1`，408.49 秒完成 53 个文件、544 项测试，无 IPC 中断：52 文件通过，1 文件失败；536 项通过、8 项失败，退出码 1。8 项均在已有 `deployment.test.ts`（backup.sh 的 compose 模式 2 项、restore.sh 的破坏性边界 2 项和卷恢复 4 项），与前序 Windows/Git Bash 路径及 checksum 问题一致；没有新增业务失败。全量原始记录见 [api-final.log](api-final.log)，不将该命令描述为零失败通过。

## 测试库与浏览器演练

使用 Web 3500／API 4500；独立 Web 副本 `apps/web-04c-preview` 与 `apps/web` 同级，src／public 真实复制，node_modules 为 junction。最终 218 个 src 文件与源目录 hash 全部一致，见 `preview-source-check.json`。浏览器使用已安装的 agent-browser 0.38.1 与已有 Playwright CDP 执行交互，没有安装依赖。API 使用合成人员、合成登录与本地一次性 PostgreSQL；不读取真实凭据、不调用外部模型或通知。

第一套库完成完整双轮流程；手机页头修正后第二套库补验跨卡核对草稿与断网输入，再完成确认。两套库均通过 fixture 正常关闭、删除。最终一套证据见 `browser-before.json`、`browser-cutoff-1.json`、`browser-before-reopen.json`、`browser-cutoff-2.json`、`browser-final.json`、`browser-final-check.json` 与 `browser-journey.log`。

1. 已签发目标 → 整理 5 张个人卡、12 项 v1 占位 Mission → 页面统一开放。
2. 成员在真实页面提出预期结果修改；另经真实 HTTP 路由提交同字段第二条建议、列表建议和另一张卡的评论，共 4 条意见。
3. 控制脚本在运行 API 内同时推进应用时钟和截止快照至 10/3 10:00。快照含 4 条意见，识别 1 处同字段冲突。
4. 页面跨卡从第一条开始，焦点实测为 `feedback-*`；逐条处理后，另一采纳按钮禁用且显示「同一字段已采纳另一条」。HTTP 强行采纳返回 409；旧版本改判返回 409；同动作重放轮次版本不变。
5. 成员页面与群组在无手动刷新、无新增消息时同步同句结果，成员没有采纳按钮。
6. 意见处理完才有核对表单；空白按钮禁用，空白 HTTP 请求 400。写核对 → 切另一张卡 → 返回，输入保留。中断动作请求，中文错误可见、输入保留、轮次仍 reviewing。
7. 手机 390 下实际点击「确认前核对」，700 字输入仍完整可见：输入框底边约 508px，底部输入条顶边 749px，确认按钮可操作。见 `phone-note-focused.png`。`confirm-ready-390.png` 为桌面聚焦后缩屏取证，可能没有自动重置滚动，不用它代替手机真实点击验证。
8. 第一轮截止后补留言 → 重开弹窗明确第 2 轮、预计截止、全战场 5 卡与保留规则 → 开放固定 48 小时。旧采纳显示「上一轮已采纳 · 下次截止沿用」，核对草稿清空。
9. 运行 API 时钟推进至 10/5 10:00，第二份快照含 5 条意见，4 条旧结论结转，仅 1 条待处理；候选保留已采纳结果与里程碑。旧 Review 的 note 为空，新表单为空。
10. 处理最后意见，再添本轮截止后留言，仍可确认。通过页面填核对、确认；返回同一卡 id 的已确定页和人／时间／结论记录。确认重放不改变版本；新意见与重开请求 409；两身份公开操作全部消失。
11. 数据库对照：仅 `sun-202610-1` 的 outcome、milestones 写回，v1→v2，`applied_versions={"sun-202610-1":2}`；其余 11 项及被改 Mission 的其余字段逐项相等。共 2 份 Review、6 条意见，快照数为 4／5，轮次最终 version=11。

证据限制：fixture 在动作之间保持固定应用时刻，确认前的末条留言与确认同毫秒，时间线按既定 divider→message 排序，因此截图中它可能列在确认分隔线后；该条实际在确认前提交，确认后的新提交已验证 409。真实截止边界由应用时钟推进和 API 边界测试共同证明，不再沿用 04b 的外部快照／固定时钟不同步方式。

演练脚本发生过两处操作定位等待（首屏尚未稳定、跨卡后的本轮面板收起）和一次 Windows 响应文件 rename EPERM；均定位为验收脚本／文件控制通道问题，没有改产品状态绕过。修正操作顺序后继续，最终重新 inspect 并执行独立数据库断言通过。控制文件不进入产品。

## 截图与视觉复核

48 张截图均在本目录，主要尺寸为 1440×900、834×1194、390×844。带 `{宽度}` 的前缀均有三种宽度，其他文件按名称标明单独取证。

| 前缀／文件 | 内容 |
|---|---|
| `open-{宽度}.png` | 统一开放后的页面 |
| `review-initial-{宽度}.png` | 第一次截止、待处理入口 |
| `field-conflict-{宽度}.png` | 原文／建议对照、冲突禁用及原因 |
| `member-candidate-{宽度}.png` | 成员同句结果与候选内容 |
| `confirm-empty-{宽度}.png` | 空核对禁用 |
| `confirm-network-retry-{宽度}.png` | 失败反馈与输入保留 |
| `phone-note-focused.png` | 手机真实点击聚焦后，700 字输入与确认按钮 |
| `reopen-dialog-{宽度}.png` | 重开弹窗 |
| `reopened-{宽度}.png` | 第 2 轮、旧结论保留 |
| `confirm-ready-{宽度}.png`、`confirm-action-{宽度}.png` | 第二轮核对及可操作确认按钮 |
| `ceo-confirmed-{宽度}.png`、`member-confirmed-{宽度}.png` | 双角色确认记录与只读页 |
| `mission-confirmed-{宽度}.png` | Mission 已确定标记与个人卡链接 |
| `final-overview-{宽度}.png` | 最终源码页头与总体阅读面 |
| `before-header-390.png`、`final-overview-390.png` | 手机焦点环间距修正对照 |
| `reduced-motion-transparency-390.png` | 减少动效／透明度目标依据弹窗 |

所有测量均无横向溢出、无 Next 错误遮罩。手机返回按钮保留 2px 焦点环／3px offset，只在个人卡标题增加 10px 内边距，避免压住首字；桌面、平板不变。减少透明度实测弹窗背景 `rgb(247,249,252)`、backdrop-filter `none`，见 `final-visual-metrics.json`。浏览器未观察到未处理 pageerror；开发控制台有 React Aria PressResponder 警告，未改第三方库或扩大本单范围。

**美学自评 8.6/10。**正文 840px、稳定字段网格、冷白底和淡蓝采纳区域延续个人卡与现有工作台；本轮和确认表单保持相同圆角、文字层级与实心蓝，重开使用厚白玻璃。原文、建议、归属和禁用原因同时可读，避免把处理中假装为 AI 推理。扣分在手机长卡和多条意见的纵向长度，需真实团队进一步体验阅读节奏；没有以更小字号压缩信息。

## 没有移植的部分

| 概念版部分 | 原因／替代 |
|---|---|
| 本机 model/store、localStorage 业务事实与模拟 Agent | 迁为 API／PostgreSQL；仅显示偏好和未提交输入留在浏览器 |
| 演示拨钟、演示窗口、Review 1.3 秒逐步亮起、假 1.6 秒处理与同步扫光 | 设计 §0、§4.6 明确排除；规则直接显示，反馈随真实请求完成 |
| 独立 WorkspaceShell | 复用 04b 的共同工作台、DetailFrame 与两频道对话列，保留同页打开和返回体验 |
| 概念目标签发／模拟起草表单 | 已有月度计划签发与 04a 草稿动作负责 |
| 10 月原件页签、下载与飞书全文 | 设计 §0.A／ADR-0019：没有 10 月原件，不存正文副本；保留来源与 revision |
| 成功证据执行状态、完成率、执行进度 | Mission 是结果承诺，确认不代表执行完成 |
| 成员通知分组／通知时钟接线 | 04d，成员本次通过已有个人卡地址进入 |
| 名单弹层、私聊转公开、会议胶囊与录音 | 既定延后范围；沿用现有群组／私人只读频道，不引入会议交互 |
| 确认后修订／撤回／重开、跨战场合并、外部提醒 | GAP-04／GAP-01 与明确延后项；确认后无普通编辑绕过 |

## 消融与约束

沿用一个锁内动作执行器，没有新增迁移、依赖、通用工作流或审计框架。字段白名单直接约束写回；`roundVersion` 直接解决已有意见结果同步；卡张数、待处理 ID 和冲突原因由 API 统一给出。跨卡草稿 helper 仅三项读／写／清除操作，不保存确认事实。未改 API 声纹文件、候选 JSON、依赖清单或锁文件。

浏览器、3500／4500、两套隔离库与临时人员目录、同层副本已清理，junction 先解除再删除副本。清理脚本先校验绝对目录归属；原 src／依赖仍在。3100／3200／4000／4100 的 PID 与开工一致，3400／4400 前后均无监听；见 `ports-before.json`、`cleanup-preview.json`、`browser-first-cleanup.json`、`browser-cleanup.json`、`final-cleanup-check.json`。另查询 pg_database 确认两套浏览器库均不存在。API 红阶段 9 个失败夹具残留仅按本次时间和对象指纹清理，详见 API 报告。

## 改动文件清单

```text
apps/api/src/missionRounds.ts
apps/api/src/personalMissionCards.ts
apps/api/src/routes/missionCards.ts
apps/api/test/missionRoundReview.test.ts (新增)
packages/contracts/src/missionCards.ts
packages/contracts/src/openapi.ts
packages/contracts/test/missionCards.test.ts
apps/web/src/lib/api/openapi.json (生成)
apps/web/src/lib/api/schema.d.ts (生成)
apps/web/src/components/missionCards/CardDocument.tsx
apps/web/src/components/missionCards/MissionCardScreen.tsx
apps/web/src/components/missionCards/RoundLine.tsx
apps/web/src/components/missionCards/mission-card.module.css
apps/web/src/components/missionCards/round-line.module.css
apps/web/src/components/missionCards/roundNoteDraft.ts (新增)
apps/web/src/components/missionCards/roundNoteDraft.test.ts (新增)
apps/web/src/components/missionCards/roundReview.test.tsx (新增)
apps/web/src/components/missionCards/missionCardScreen.test.tsx
apps/web/src/components/missionCards/personalMissionCard.test.tsx
apps/web/src/components/missionCards/personalMissionFixture.ts
apps/web/src/components/notificationSummary.test.tsx
apps/web/src/conversation/useMissionGroup.ts
apps/web/src/conversation/useMissionGroup.test.ts
apps/web/src/app/(ceo)/missions/[id]/MissionDetailScreen.tsx
apps/web/src/app/(ceo)/missions/[id]/missionDetail.test.tsx
apps/web/src/styles/mission-detail.module.css
CONTEXT.md
docs/adr/0019-promote-mission-to-core-entity.md
docs/adr/0020-members-sign-in-and-own-execution-items.md
docs/adr/0022-persist-monthly-mission-card-rounds.md
.scratch/onboarding/issues/04c-mission-round-review-and-confirm.md
.scratch/onboarding/map.md
.scratch/onboarding/evidence/04c/ (报告、测试日志、截图、验收/清理脚本与数据核验)
```

## 仍需人工确认

- Claude 最终验收与提交；本单未提交。
- 窄屏长期阅读与真实 Safari 键盘／安全区体验，本次为 Chromium 三尺寸与真实交互。
- 实际团队需核对占位来源、10 月日期及协作结论；演练数据不代表真实承诺已签发。
- 已有部署测试与 Windows 测试运行器环境问题需维护者处理；ADR-0021 缺失需文档负责人确认是否尚未创建。
- 04d 通知与确认后纠错 GAP-04 仍待后续，不在本单补造规则。
