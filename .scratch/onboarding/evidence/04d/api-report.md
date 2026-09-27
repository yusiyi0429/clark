# 04d API 与契约实现记录

## 实现

- 新增 `GET /api/me/mission-cards`，使用已有轮次投影生成 `{rounds}`。登录人是当前战场 DRI 或 CEO 时列出全部个人卡并保留 `sort_order`；其他人只列 Owner 是自己的卡。旧成员关系本身不产生通知入口。所有数据从轮次现算，不写 `notifications`。
- CEO `/api/cards/home` 沿用已有轮次投影与整理草稿 slot。本次通过真实 HTTP 验证待处理、确认后退出和第一卡导航。服务端 `todo` 补齐「N 条待你处理」，供所有入口复用。
- 严格按 AC-16 的「截止不退、确认才退」解释：CEO 与成员通知跨月保留未确认轮次，按月份倒序、战场排序；引导工作与下一件事仍限公司当前月份。跨月保留先修改测试得 1 失败／3 通过（`api-crossmonth-red.log`），实现后连同通知去重测试 5/5 通过（`api-crossmonth-green.log`）。
- 成员引导 `work.missionCards` 返回本月本人 Owner 的卡，包含阶段、个人卡版本行原句、截止时刻、服务端时间、占位来源、数量及本人卡深链。已确定卡仍保留。Owner 对应战场并入 `work.battlefields`，即使该卡暂时没有 Mission 也能参与。
- 下一件事优先本轮：成员开放／截止直达本人的卡；CEO 有来源可整理时指向准确 slot 的确认框，草稿直达首卡，待处理直达首个有待处理意见的卡并携带 `feedback` 定位；全部处理完提示确认。旧目标签发、红色议题、当日会议及执行事项保留为后续优先级。
- 契约先修改 TypeBox，再通过 `gen:client` 生成 OpenAPI 与 Web 类型，没有手写生成文件。没有迁移、依赖、API 声纹文件修改。

## 测试先行

- `api-red.log` 最初为 4 失败，其中 1 个是新夹具的空卡不能开放；随后发现 SQL 参数复用造成类型推导冲突，保留事实，不把夹具问题算产品 Red。
- 修正夹具后、实现前的 `api-red-valid.log` 为有效 **4/4 失败**：端点 404、Owner 未进入参与战场、引导无草稿 slot。
- Contracts 的 `api-contracts-red.log` 为 **47 通过／2 失败**，缺少通知端点和新引导 shape。
- `api-green.log` 的旧 onboarding 7 项、missionRoundRoutes 3 项通过；本次 4 项中 3 通过，1 个失败是首页读取的测试计划缺少 `negotiation.feedback`，已补成完整合法计划夹具。
- 修正后 `api-notices-final.log` 为 **4/4 通过**。覆盖登录、Owner/拍板人/其他人、sort_order、所有关键阶段、精确截止、读路径不写快照、CEO 与成员同一投影、待处理深链、确认退出但引导保留、Owner 无 Mission 的参与关系、公司时区、原状态句和执行事项优先级。
- `api-round-regression.log` 的既有轮次与集中 Review **24/24 通过**。
- `api-contracts-green.log` **49/49 通过**，`api-typecheck.log` API 类型检查通过，`api-gen-client.log` Contracts build 与生成客户端成功。

浏览器运行期间，父代理按要求创建的同层 Web 副本被 pnpm workspace 自动发现；一次 pnpm 重跑试图检查／安装该副本依赖，因副本没有 vendor tarball 而中断。未执行手工安装。父代理要求暂缓 pnpm，后续定向改为在 `apps/api` 内直接运行已安装的 `node node_modules/vitest/vitest.mjs run --maxWorkers=1`。跨月描述调整后，生成客户端也使用 `gen:client` 等价的本地三步（Contracts tsc → OpenAPI emit → openapi-typescript），见 `api-gen-crossmonth.log`；生成文件未手改。

副本、浏览器和 3500/4500 服务清理后，严格执行指定命令 `pnpm --filter @warmap/api exec vitest run --maxWorkers=1`，一次完整完成 **54 文件／548 项，540 通过／8 失败**，耗时 **420.66 秒**，退出码 **1**，无 IPC 中断或偶发超时，不需分批重跑。对比 04c 全量 **536 通过／8 失败**，新增 4 项全部通过。8 项失败均在既有 `deployment.test.ts`：backup compose 2 项、restore 破坏性边界 2 项、volume-backed recovery 4 项；已用完整测试名称逐条与 04c 原日志比较，一致。原因仍为本机 Windows/Git Bash 路径与 checksum 测试问题，没有新增业务失败。原日志见 `final-api.log`，机器可读对照见 `final-api-summary.json`；不将此次全量表述为零失败通过。

## 时间与状态口径

- `phase` 仍由数据库状态和本次请求同一个 `ctx.now()` 推导；每个响应内的 `serverNow` 一致。
- 到达 `closes_at` 立即投影 `closed`；读取不做状态迁移，快照生成后投影 `reviewing`；确认后通知退出。
- 通知 `line` 与 `todo` 使用同一服务端轮次投影。引导的 `status` 直接取个人卡原有 `card.status`，包括草稿角色、候选改动数、拍板人和确认记录，不另造状态文案。
- 截止显示使用 `Asia/Shanghai`。API 不生成剩余分钟数字；共享分钟时钟由 Web 消费同一 `closesAt` 和 `serverNow`。

## API / Contracts 文件

```text
apps/api/src/missionRounds.ts
apps/api/src/onboarding.ts
apps/api/src/routes/missionCards.ts
apps/api/src/routes/cards.ts
apps/api/src/routes/onboarding.ts
apps/api/test/missionCardNotices.test.ts
packages/contracts/src/missionCards.ts
packages/contracts/src/onboarding.ts
packages/contracts/src/openapi.ts
packages/contracts/test/missionCards.test.ts
packages/contracts/test/onboarding.test.ts
apps/web/src/lib/api/openapi.json (生成)
apps/web/src/lib/api/schema.d.ts (生成)
```

消融检查：复用轮次及个人卡原有投影，没有第二套状态或通知持久化。引导只新增直接需要的两个 next 选择函数；不增加通用通知框架。所有新增测试一次性数据库均在 `finally` 关闭；新草稿目录用逐文件删除和空目录删除清理。
