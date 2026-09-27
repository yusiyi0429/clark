# 04d · Mission Card 通知、入口与引导状态验收报告

日期：2026-09-27。起点：最新提交 `e461332`（04c）；未执行 Git 写命令。状态：resolved，实现、验证和清理完成，待 Claude 验收提交。

## 交付行为

- 成员通知顶部整体移植概念版 Mission Card 分组：按月份／战场分组、纯色行底、头像、Owner、角色、个人任务数、意见摘要和圆角倒计时。普通 Owner 只有本人行；当前战场 DRI、CEO 看全部行，沿用服务端顺序。CEO 置于现有「战略决策更新」，保留其他战略入口。
- 共用 `GET /api/me/mission-cards` 与既有 CEO 首页轮次投影，不写第二份通知记录。草稿、开放、截止、Review 和待确认都有对应状态；截止不退组，确认才退组，跨月未确认也保留（AC-16）。「N 条待你处理」直接打开第一条待处理意见并恢复焦点。
- 通知和个人卡页头使用同一个 `useRoundNow`，同一 tick 更新；晚挂载及旧响应不把时间拨回，越过截止立即读取最新投影。本人成功动作触发刷新；外部会话的操作通过 20 秒、窗口焦点和可见性刷新同步。截止后快照尚未到时短轮询补齐，断网保留已有内容。
- 引导仍由 `GET /api/me/onboarding` 提供数据。「你这个月的工作」顺序为战场目标 → 我的本月卡 → 既有 Mission 明细；展示原个人卡状态句、占位、任务数及上海时区截止时刻。Owner 没有 Mission 也进入参与战场。确认后本月工作卡保留。
- 「下一件事」优先本轮：CEO 草稿 slot／开放／待处理／待确认；成员开放及截止直接去本人卡。CEO 整理入口只打开现有确认框，仍需显式确认。原有签发、深链、执行事项等逻辑保留。自动刷新不重置步骤、录音、同意、保存状态或输入。
- 现有 Mission 总览与详情已经复用 `MissionStatus` 的草稿／占位／已确定徽标，本次沿用并回归验证。工单 03 尚未落地，成员战场详情状态块及其「我在这里的 Mission」徽标明确留给 03。

## 先读与实现判断

已读 `CLAUDE.md`、`CONTEXT.md`、ADR-0019/0020/0022、map 中 01/01p/01q/04a/04b/04c 摘要及 evidence 报告、本单设计与 spec，以及概念版 SSOT DRI-05、AC-07、AC-16 和 `mission-card-group.tsx`、`mission-card-notice.ts`、`countdown.tsx`、`round.ts`。ADR-0021 仓库仍缺失，没有补造。使用并读过 agent-browser、agent-browser-verify、Next.js、React 审查技能和本地 Next.js client directive 文档。

两处细化：

1. 设计 §6.4 描述 CEO 单入口，本工单验收明确要求 CEO「全部行 + 待办提示」，因此 CEO 嵌入同一分组，避免两套状态和样式。
2. 共享 store 保留在 `useRoundNow.ts`，没有新建 `roundClock.ts`：Windows 上它会与已有 `RoundClock.tsx` 构成大小写模块冲突。职责和测试覆盖符合设计 §2.4。

## 改动文件清单

API 与契约（没有迁移）：

```text
apps/api/src/missionRounds.ts
apps/api/src/onboarding.ts
apps/api/src/routes/cards.ts
apps/api/src/routes/missionCards.ts
apps/api/src/routes/onboarding.ts
apps/api/test/missionCardNotices.test.ts                  新增
packages/contracts/src/missionCards.ts
packages/contracts/src/onboarding.ts
packages/contracts/src/openapi.ts
packages/contracts/test/missionCards.test.ts
packages/contracts/test/onboarding.test.ts
apps/web/src/lib/api/openapi.json                       生成
apps/web/src/lib/api/schema.d.ts                        生成
```

Web 通知、时钟、引导与回归：

```text
apps/web/src/components/NotificationRail.tsx
apps/web/src/components/missionRoundEntry.test.tsx
apps/web/src/components/member/MemberWorkspace.tsx
apps/web/src/components/member/useMemberHome.ts
apps/web/src/components/member/useMemberHome.test.ts
apps/web/src/components/missionCards/MissionCardNoticeGroup.tsx       新增
apps/web/src/components/missionCards/mission-card-notice.module.css   新增
apps/web/src/components/missionCards/missionCardNotices.test.tsx      新增
apps/web/src/components/missionCards/MissionCardScreen.tsx
apps/web/src/components/missionCards/missionCardScreen.test.tsx
apps/web/src/components/missionCards/RoundClock.tsx
apps/web/src/components/missionCards/RoundLine.tsx
apps/web/src/components/missionCards/personalMissionCard.test.tsx
apps/web/src/components/missionCards/useRoundNow.ts
apps/web/src/components/missionCards/useRoundNow.test.tsx
apps/web/src/components/onboarding/WelcomeFlow.tsx
apps/web/src/components/onboarding/welcome.module.css
apps/web/src/components/onboarding/welcome.test.tsx
apps/web/src/components/onboarding/useOnboardingData.ts               新增
apps/web/src/components/onboarding/useOnboardingData.test.ts          新增
```

文档与证据：`CONTEXT.md`、`docs/adr/0022-persist-monthly-mission-card-rounds.md`、本工单、`map.md`、本目录报告／测试日志／演练脚本／截图与索引。生成文件经契约构建与生成脚本产生；没有手改生成类型。API 声纹文件、生产依赖清单、锁文件、候选种子均无差异。

## 测试前后

| 检查 | 前 | 后 |
|---|---|---|
| Web 全量 | 04c 的 390 项；本轮首次全量原有 390 通过、并行加入的 3 个新时钟测试失败 | **425/425，通过 51 文件**，`final-web.log` |
| Contracts | 49 项；先改契约测试时 47 通过／2 失败 | **49/49**，`final-contracts.log` |
| API 全量 | 04c：536 通过／8 项既有 Windows 部署脚本失败 | **540 通过／同样 8 失败**，54 文件／548 项，`final-api.log` |
| API / Web TypeScript | 前序通过 | 本轮通过，`final-api-typecheck.log`、`final-web-typecheck.log`（成功无输出） |
| 客户端生成 | 旧 schema | `api-gen-client.log` 成功 |

API 使用指定命令 `pnpm --filter @warmap/api exec vitest run --maxWorkers=1`，一次完整完成，420.66 秒，无 `ERR_IPC_CHANNEL_CLOSED`、无偶发超时，因此没有分批或重试。8 项失败均在既有 `deployment.test.ts`：备份 2 项、restore 破坏性边界 2 项、volume-backed 4 项，与 04c 名称完全一致，没有新增业务失败。未把全量写成全绿。`git diff --check` 通过，日志 `final-diff-check.log`。

有效 Red → Green 证据：

- API 新端点／Owner 参与战场／引导优先级：`api-red-valid.log` **4/4 失败** → `api-notices-final.log` **4/4 通过**；跨月保留先 **1 失败／3 通过** → 连同通知不重复写入 **5/5 通过**（`api-crossmonth-*.log`）。旧 onboarding/routes 与轮次 Review 回归 **34 项通过**。
- 时钟：晚挂载不倒退、忽略旧样本、两个截止回调同 tick：`clock-red.log` **3 失败／3 通过** → 6/6；状态句先 **4 失败／21 通过** → 25/25，草稿倒计时「本轮未开放」先红后绿。
- 通知：渲染、权限投影使用、待办导航、样式标记、动作事件、在途刷新等测试先红；最后定向 **45 项通过**（`web-notices-green.log` 等；最终全量为准）。
- 引导：新增本月卡、状态／日期、空态、下一件事、定时刷新保留交互、断网及顺序测试先红后绿。顺序变更 `onboarding-order-red.log` **1 失败／23 通过** → `onboarding-order-green.log` **27/27**。
- 两位协作者另行审查 API 权限、刷新生命周期、截止回调、录音与输入保留，未发现阻断问题；没有为既有 Mission 小标复制第二个组件。

夹具修正、脚本试错与环境异常没有算作产品 Red 或通过：最初 API 夹具空卡、SQL 参数类型和不完整计划对象已修正，再取得有效 Red。浏览器副本被 pnpm workspace 自动识别时，pnpm 检查依赖因副本无 vendor tarball 中断；未手工安装依赖，演练期间改用已安装工具，副本清理后才运行全部最终 pnpm 命令。

## 浏览器演练与证据

真实 Next.js + API + 一次性 PostgreSQL，3500/4500；独立 CEO 和孙铭泽浏览器登录，合成人员与口令。主流程：

1. 引导 CEO 下一件事 → 精确草稿确认框 → 真实整理 1 轮／5 卡／12 条 v1 占位 Mission。
2. CEO 通知全部 5 行，成员通知本人 1 行；从通知开卡再返回，键盘焦点回到原行。
3. 开放固定 48 小时，成员引导工作卡刷新为讨论中，下一件事直接打开本人卡。两个真实身份通过 HTTP 写入两条公开意见，后续从 UI 跳转、处理和确认。
4. 将夹具的应用时钟移到截止前 65 秒后自然推进，不修改产品时钟或数据库窗口长度。逐帧采样同一个成员工作区里的卡页 `paper` 与通知 `glass`：**1 分 → 不到 1 分 → 已截止，每次两处完全一致**。约 64.98 秒越过截止；原调度规则生成 Review，通知仍在，CEO 出现 2 条待处理。见 `browser-clock-samples.json`、`browser-cutoff-inspect.json`。
5. CEO 点击待办，焦点落在第一条意见；UI 处理一条、同一正式动作端点处理另一条，显示「意见已全部处理，待你确认」。UI 填核对结论并确认，双方通知退出。`browser-final-check.json`：通知 0、引导已确定工作卡 1；本人已确定卡仍可打开并读取历史。
6. 最终样式复核用新隔离夹具：同样草稿／开放／Review，再从 UI 重新开启。CEO 与成员同步第 2 轮、新截止时间，旧意见保留；`browser-visual-final.json`。

浏览器等待条件、CDP 上下文隔离和完成引导后的导航竞争曾造成自动化脚本失败；改为两个独立浏览器与等待真实页面状态后完成。第一次自然截止／确认流程保存完整数据库事实；最后只改布局后的视觉夹具不覆盖该事实。最终脚本、分阶段日志、错误记录保留，未将脚本错误隐瞒成通过。

取证注意：历史 `browser-*.json` 的顶层 `result.now` 是最近一次外部推进时保存的夹具时钟基准；应用时钟仍随真实时间前进。实际动作时间以数据库 `opened_at`／`snapshot_at`／`confirmed_at` 和页面采样为准，不能把基准字段当成最终采样时刻。

75 张 PNG，均在本目录。三种主尺寸：**1440×900、834×1194、390×844**，演练采集的页面均无横向溢出、无 Next 错误遮罩。可打开 [截图索引](screenshot-index.html)。重点：

| 场景 | 文件前缀（除注明外均含 `-1440` / `-834` / `-390.png`） |
|---|---|
| CEO 草稿下一步／确认 | `ceo-next-draft`、`ceo-draft-confirm` |
| 草稿与开放通知 | `ceo-draft-notice`、`ceo-open-notice`、`member-open-notice` |
| 引导工作卡／直达本人卡 | `member-work-draft`、`member-work-open`、`member-next-open` |
| 自然最后一分钟与截止 | `member-last-minute`、`ceo-last-minute`、`member-cutoff`、`ceo-cutoff-notice` |
| Review 通知与引导 | `ceo-review-notice`、`member-review-notice`、`member-work-review-final`、`member-next-review`、`ceo-next-review` |
| 待确认、退组与确定后保留 | `ceo-confirm-ready-notice`、`ceo-confirmed-home`、`member-confirmed-home`、`member-work-confirmed`、`member-confirmed-card` |
| 重开第 2 轮 | `ceo-reopened-notice`、`member-reopened-notice` |
| 减少动效／透明度 | `member-reduced-motion-transparency-390.png` |

## 未搬部分与原因

| 未搬部分 | 原因／后续归属 |
|---|---|
| 成员战场详情里的轮次状态块、「我在这里的 Mission」徽标 | 工单 03 页面不存在，按用户要求留到 03；没有另造半套详情页 |
| 概念版 local store、localStorage 业务事实与演示拨钟 | 业务事实全部由 API／数据库投影；演练时钟只在隔离夹具中，未放入产品 |
| 模拟 Review／Agent 等待动画 | 真实 04c 规则快照，无法宣称模拟 AI 为真实处理 |
| 概念版外围会议／名单等通知排序和独立 WorkspaceShell | 本单只迁移 Mission 分组；遵守现有工作台与本单「置顶」要求 |
| 10 月原件全文页签 | 04a 来源为有版本的讨论候选，不存在可搬的 10 月原件全文；不伪造 |
| 站外推送、已送达回执、执行进度、已确定后修订 | 不在 04d；站内可见不等于已通知，修订属 GAP-04 |

## 美学自评与剩余边界

**8.7/10**。晨光、厚白玻璃、天枢蓝与现有锁屏／引导／个人卡一致；通知内层采用概念版纯色行块，待处理用蓝色强调；紧迫只用「最后 6 小时」文字，未引入警告色。窄栏不截 Owner、角色或状态；缩紧头像／间距，把人数与草稿徽标放在同一个不拆行组。390 的工作卡提前显示，长明细继续滚动，底部按钮保持可见。未更换全局色板和现有工作台背景。

仍需人工确认：Claude 的视觉验收与提交；真实 iPhone Safari 长姓名、触控和键盘观感。Chromium 的减少动效／透明度已演练，但不能代替真实设备。引导收尾步骤的外部状态变化走 20 秒／焦点刷新，工作卡和个人卡／通知的显示中倒计时在截止 tick 刷新；跨浏览器操作不是实时推送。ADR-0021 缺失和既有 Windows 部署测试问题需要项目侧确认，不在本单补造或改写。

## 清理与约束

- Web 副本为 `apps/web-04d-preview`，与 `apps/web` 同层；src/public 真复制，node_modules 是 junction。清理前 **226 个源文件 hash 全部一致**，见 `browser-source-hashes.json`。
- 4 个本次浏览器临时库及合成人员目录分别由夹具 close 清理；`browser-{first,second,third,fourth}-cleanup.json` 留证。3500/4500、两个专用浏览器、遗留的演练脚本进程、同层副本均已清理，junction 先解除，原依赖仍存在。
- `cleanup-result.json` 对照 `ports-before.json`：3100／4000 PID 22856、3200 PID 58088、4100 PID 63752 未变；3400／4400 前后都无本次占用。没有停止其他服务或 Docker。
- 没有新增依赖、API 声纹修改、真实凭证读取／输出、真实账号或数据操作、Git 写命令；由 Claude 在验收后提交。
