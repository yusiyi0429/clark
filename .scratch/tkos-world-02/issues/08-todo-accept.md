# 08 · 执行事项「通过」

Type: implementation
Status: needs-triage
Blocked by: —

## 要做什么

用户已决定（2026-09-29）：在执行事项已有的「打回」对面加一个「通过」，由 Owner 点，表示验收通过；本体侧由 07 代记 `world_accept`（本体做「Task 带不带 Activity」对照实验需要验收数据）。

- 契约：`TaskStatus` 是否新增 `accepted`，或在 `done` 上加验收标记；「打回」的现有入口与权限在 `apps/api/src/tasks.ts` 的 `returnMyTask` 与对应 web 组件，通过与之对称。
- 网页：Owner 在执行事项上看到「通过」「打回」一对操作；通过后事项显示已验收，执行人与 Owner 都能看到；可撤销与否与「打回」保持一致。
- 这是影响体验的改动，交互与文案由 Claude 自己做并在浏览器里核对（参照 clark 对应的执行事项界面）。

## 待定（triage）

- 状态模型二选一（新状态 vs 标记），以及「通过」之后能否再打回；已完成未验收的事项在列表里如何区分。

## 完成定义

- API 与网页测试覆盖通过、权限（只有 Owner）、与打回互斥；浏览器里走一遍 Owner 与执行人两个视角。
