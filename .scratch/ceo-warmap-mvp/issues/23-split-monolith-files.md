# Ticket 23 · 拆分巨石文件（纯机械重构，零行为变化）

状态: resolved（2026-09-22）
来源: assessment-2026-09-22.md 维度 5

## 目标

meetings.ts（1564 行）与 app.ts（1540 行 / 52 路由）拆为职责单一的文件。
**零行为变化**：不改任何函数逻辑、错误码、契约、测试断言；diff 应以整块搬移为主。

## W1 拆 meetings.ts

按现有职责切四块（行数目标每文件 <600）：
- `meetings.ts` 保留：Meeting row 类型、CRUD、投影 projectMeetingCard、meeting actions 执行。
- `meetingMaterials.ts`：材料上传校验/存储/解析编排、edit_materials 锁语义。
- `meetingPreflight.ts`：runPreflight 输入组装、candidate 校验（含 L908 leader_lens 检查）、
  preflight 状态机。
- Outcome 确认已有 outcome.ts，如 meetings.ts 内仍有 outcome 编排逻辑一并移过去。
切法：整函数搬移 + 明确 import；类型放共用处避免环。调用方（app.ts、effects.ts、测试的
import 路径）同步更新；不做 re-export 兼容层（仓内引用全改）。

## W2 拆 app.ts

app.ts 变组装根（env 解析、服务装配、插件注册），路由按域拆 Fastify plugin：
`routes/auth.ts`、`routes/cards.ts`、`routes/config.ts`、`routes/meetings.ts`、
`routes/conversations.ts`、`routes/radar.ts`、`routes/monthlyPlans.ts`（按实际路由归属定，
名单可增减）。buildApp 签名与行为不变（全部测试 import buildApp，必须原样通过）。
共享的 fail()/requireCEO 等助手放 routes/shared.ts 或保留 app.ts 导出。

## W3 验证

- pnpm -r typecheck；contracts/web 测试；API 全量 `npx vitest run --poolOptions.forks.maxForks=1`
  307 用例必须全过且**不修改任何测试断言**（import 路径调整除外）。
- 测试库：localhost:54329（容器 warmap-pg，已在跑）。
- staging 重建 api 冒烟 healthz 200。
- 每 W 一个 commit；`git diff --stat` 附在报告里证明是搬移为主。

## 边界

- 不顺手改逻辑、不改名、不加抽象；发现疑似 bug 只记录不修。
- 不动 apps/web、packages/contracts。

## Comments

- 2026-09-22 resolved（W1 `c3bdc97`，W2 `9651641`，W3 验证）：
  - W1：`meetings.ts` 1564 → 492 行；新增 `meetingStore.ts`（238）、`meetingPreflight.ts`（317）、`meetingMaterials.ts`（182），outcome 编排移入 `outcome.ts`（737）。仓内 import 全改，无 re-export 兼容层。
  - W2：`app.ts` 1540 → 270 行；52 条路由按域拆入 `routes/{auth,cards,config,radar,conversations,meetings,actions,dri,system}.ts` 与共享 `routes/shared.ts`；`buildApp` 签名与行为不变。
  - 零行为变化：整函数/整块搬移，未改逻辑、错误码、契约、测试断言（测试只改 import 路径）。
  - 验证：`pnpm -r typecheck` 通过；contracts 28、web 94、API 全量 307 用例全过；staging 重建 api 后 `/healthz` 返回 200。
  - 拆分过程未发现需记录的疑似 bug。
