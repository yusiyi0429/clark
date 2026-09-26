# 04b API 与契约验收记录

日期：2026-09-27。范围仅包括 API、契约及生成客户端；页面与浏览器证据由主报告汇总。

## 实现

- 卡页返回 `personal-mission-card` Card，保留稳定卡 id、13 字段、来源、占位、Mission 版本、当前显示版本、已采纳字段和全部意见。版本行、意见处理结果、群组开场及分隔线由服务端统一生成。
- 可见性按持久化卡成员或当前 CEO / 战场 DRI 判断，卡页、群组、意见、已读及个人 Agent scope 一致；不可见对象返回 404。拍板动作继续用 04a 的签名令牌、权限复查和幂等，`viewCardId` 现在返回当前个人卡，版本冲突也返回个人卡的 `latestCard`。
- 公开意见独立写入 `mission_card_feedback`。15 个阶段 × 类型用例分别验证 draft、open、closed、reviewing、confirmed 与 comment、quote、suggestion 的每个组合。引用按连续空白归一比较；开放时对草稿，截止后对候选；服务端保存原文、源版本、依据与窗口号。列表建议先去空行并校验 30 行 / 每行 500 字，名称校验 200 字。
- 按作者 × client_id 串行处理重试；同内容返回同一条，不同内容或跨卡重用返回 409，权限先于重放判断。意见不修改轮次或 Mission 版本。
- 反馈先拿轮次 SHARE 锁，再取应用时间。到点时释放 SHARE，再取 UPDATE 锁并重新判断，以免两个到点写入互相升级锁而死锁；截止快照写入后，允许的消息标为候选依据、截止后留言。并发测试验证取时机和只生成一份快照。
- 开场仅首次开放出现，重开保留一次；系统事件与消息按时间及分隔线 < 开场 < 意见排序。群组 `after` 只筛意见，系统事件始终返回，客户端可按稳定内容合并。
- 已读序号单调递增且夹到本卡最后一条；未读排除自己，系统开场从不计数。`mission-card:<id>` 私聊按人隔离，模型只得到卡正文、公开意见与轮次资料，开场不注入，私聊不进入 Review。
- 04c 的 decide / confirm 动作未实现。候选及确认历史是只读投影；API 测试用隔离测试库 SQL 安排已采纳、已确认的前置状态，不把测试安排当作产品入口。
- 草稿页只读返回当前已签发的目标与签发时间，未写 `goal_snapshot`；开放后继续使用冻结依据，不跟随之后的配置变化。
- 成员在个人卡 Agent 内不下发无对象权限过滤的 `list_missions` 工具，避免从私聊旁路读取其他卡的 Mission；当前卡的授权资料已经完整注入。CEO 与既有首页工具行为保持不变；其他可用工具是原有企业知识章节、人员目录及公开来源工具，没有通用 Card 或私有对话读取入口。

## 测试证据

- 新接口首次 Red：19 / 19 失败，原因是 04a 尚无个人卡端点，见 `api-red.log`。
- 第一轮 Green：新 20 项加原动作路由 3 项，共 23 / 23 通过，见 `api-discussion-green.log`。
- 随后增加一项闭合后重放、跨卡 client_id 及撤销可见性用例；新 API 用例共 21 项，纳入最终全量。
- Contracts：46 → 47 项全部通过；API typecheck 通过；`pnpm --filter @warmap/web gen:client` 成功，生成文件没有手工修改。
- 首次既有 50 文件长跑记录在 `api-baseline.log`：502 通过，9 失败。8 项是 04a 已记录的 Windows 部署脚本失败；另一项是长跑期间测试已更新至 04b、但 worker 仍持有 04a 路由所致的 400 / 404 断言差异。这一运行不是纯净基线，不应对外宣称 9 项都是既有失败；已有可比基线使用 04a 的 503 通过 / 8 失败。该动作路由在定向 Green 中已 3 / 3 通过。
- 最终全量使用用户指定原命令 `pnpm --filter @warmap/api exec vitest run --maxWorkers=1`，完整跑完 51 文件 / 532 用例：**524 通过，8 项同样的 deployment 失败**，无 IPC 中断，见 `api-final.log`。
- 全量结束后，针对审查发现的 Agent 工具权限旁路和草稿目标展示，追加 2 项回归，先 2 / 2 Red（`api-context-red.log`），再最小修复。随后独占跑个人卡 21、上下文 2、Pi Runtime 原 11、动作路由原 3，共 **37 / 37 Green**（`api-context-green.log`）；同轮补查撤换战场 DRI 后页 / 群组 / 已读 / 私聊均 404，以及 comment 禁字段锚点。最终 API typecheck 通过（`api-typecheck.log`）。
- 整个最终文件集合为 52 文件 / 534 用例：原全量与后续受影响文件复测去重后 **526 通过、8 项原有失败**；这一统计是全量加补充回归，不冒充最后一次单命令 534 用例全量。

## 本分工改动文件

新增：

- `apps/api/src/personalMissionCards.ts`
- `apps/api/test/personalMissionCards.test.ts`
- `apps/api/test/personalMissionCardContext.test.ts`

增量修改：

- `apps/api/src/routes/missionCards.ts`
- `apps/api/src/conversations.ts`
- `apps/api/src/routes/conversations.ts`
- `apps/api/src/piConversationRuntime.ts`
- `apps/api/test/missionRoundRoutes.test.ts`
- `packages/contracts/src/missionCards.ts`
- `packages/contracts/src/conversations.ts`
- `packages/contracts/src/openapi.ts`
- `packages/contracts/test/missionCards.test.ts`

由 gen:client 生成：

- `apps/web/src/lib/api/openapi.json`
- `apps/web/src/lib/api/schema.d.ts`

没有新增依赖、数据库迁移、业务开关，也没有修改声纹文件、候选 JSON 或执行 Git 状态修改命令。
