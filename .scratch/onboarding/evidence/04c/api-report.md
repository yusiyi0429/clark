# 04c API 实现与核验

## 已完成

- `mission-round.decide` 与 `mission-round.confirm` 接入现有个人卡动作端点。逐条动作限定当前 Review 的快照意见，允许改判；同一 Mission 字段只能采纳一条建议。
- 共用轮次行锁执行器：锁后读取当前战场 DRI，先复查权限，再处理 fingerprint 重放、轮次版本冲突与业务条件。决定和确认均以应用时钟留痕，成功一次只升一次轮次版本。
- 确认要求所有快照意见都有决定、核对结论 trim 后非空且最多 2000 字，并再次核对同字段冲突。全部 Mission 先按稳定顺序锁定，与快照版本集合逐项比较，任一变化即拒绝，尚未写回任何字段。
- 接受的建议按 Mission 合并，通过字段白名单一次 UPDATE；列表按行拆开。每个被修改 Mission 只升一次版本，未采纳字段、来源、占位标记和其他 Mission 保持原值。`applied_versions` 只记录实际写回 Mission 的最终版本；没有采纳字段时保存 `{}`。
- 全轮卡张数、各卡第一条待处理意见、冲突停用原因、反馈动作与确认动作均由 API 投影。统一 `projectFeedback` 供正文、群组和反馈响应使用；群组新增 `roundVersion`，让已读序号未变化时仍可发现处理结果变化。
- 已重开窗口中的旧截止后留言显示「截止后留言 · 已并入这一轮」。上一轮已采纳结论下一次截止结转到候选，旧核对备注不结转。确认后正文与历史保留，全部处理动作消失，发新意见、重开及新确认请求返回 409。

## 测试先行与结果

1. 先新增 `missionRoundReview.test.ts` 的 9 组 HTTP 集成测试。最初两次调试发现测试夹具自身的 PostgreSQL 参数类型、测试应用未暴露 pool 两个问题，修正后才记录有效产品 Red；不将夹具错误冒称产品缺失。有效 [api-red.log](api-red.log) 为 **9/9 失败**，原因是未实现动作及相关投影。
2. 实现后新测试 7 通过 / 2 失败：两处测试误读了 `replayed`，它是既有仓储内部字段，HTTP 按既有契约只返回 `cards`。改为核验两个响应版本相同、数据库只升一次版本与只写一次决定，不修改 HTTP 契约或削弱幂等要求。
3. 增补「无采纳字段时确认不升 Mission 版本」、群组版本与未读互不影响、重开即时留言文案检查。最终新文件 **10/10 通过**，见 [api-review-final.log](api-review-final.log)。旧轮次仓储 **14/14 通过**，见 [api-rounds-final.log](api-rounds-final.log)。这两次运行去重共 **24 项通过**。
4. API `typecheck` 通过，见 [api-typecheck.log](api-typecheck.log)。全量测试由主代理在浏览器清理后独占执行，最终报告以主代理全量日志为准。

API 测试全部使用 `pnpm --filter @warmap/api exec vitest run --maxWorkers=1 ...`。一次 4 文件串行运行在个人卡旧测试期间遭遇既有 Tinypool `ERR_IPC_CHANNEL_CLOSED`，以及旧轮次单文件首次运行同样中断；分别见 [api-review-green.log](api-review-green.log)、[api-rounds-regression.log](api-rounds-regression.log)。两次没有完整统计，**均不计为通过**。后续旧轮次单文件自然完成 14/14；没有放宽断言、超时或换 pool。

## 覆盖的真实 API 链路

在每个自动创建和销毁的一次性 PostgreSQL 库里，通过登录会话与真实 HTTP 路由完成开放 → 发意见 → 应用时钟推进到截止 → 写路径取锁并生成快照 → 逐条处理 → 核对 → 确认。重开用例另经过第 2 次完整 48 小时窗口，并验证两份 Review、意见和采纳结论留存。没有演示拨钟或生产数据操作。

重点断言包括：两条同字段建议冲突、先拒绝原采纳再采纳另一条、并发同 fingerprint、旧版本携带个人卡 `latestCard`、跨快照/缺失意见拒绝、成员无动作及 403、当前 DRI 撤权后重放仍 403、所有 Mission 版本检查、列表写回、未改字段保持、无修改确认、当前截止后留言不挡确认、确认后所有动作只读。

## 清理证据

首次测试夹具在返回测试对象前失败，留下 9 个一次性库。已按**首次迁移时间 2026-09-26 23:05:06–23:05:20 UTC + 唯一草稿轮次 + 04c 的固定创建时间 + 1 张卡 + 0 个 Mission**五项证据逐库确认后删除，见 [api-cleanup.json](api-cleanup.json)。没有按 `warmap_test_*` 批量删除，其他库不符合证据即保留。

另按 IPC 日志中的明确轮次 ID 与迁移时间复核中断残留，符合时间的残留库为 0，见 [api-ipc-cleanup.json](api-ipc-cleanup.json)。清理脚本 [api-cleanup.mjs](api-cleanup.mjs) 只用于此次证据核验，不属于产品代码；不读取或输出真实密钥。

## 产品源码清单

```text
apps/api/src/missionRounds.ts
apps/api/src/personalMissionCards.ts
apps/api/src/routes/missionCards.ts
apps/api/test/missionRoundReview.test.ts
```

契约与生成客户端由主代理负责。没有新增依赖、迁移或 API 声纹文件改动，没有执行任何 Git 写操作。

审查消融：保留共享的锁内执行器，避免 decide/confirm 复制权限、重放和版本检查；字段白名单直接服务确认写回，未增加通用工作流、审计框架或后台任务。独立审查代理未发现阻断问题。
