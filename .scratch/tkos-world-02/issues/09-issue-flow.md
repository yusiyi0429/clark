# 09 · 议题流转

Type: implementation
Status: needs-info
Blocked by: 01、02、03

## 要做什么

天枢里 E&O 相关的议题按 0.2 的 Issue 事件流转进本体（示例 §9）：

- 议题本体上是主受影响对象（Mission 或 E&O 单元）快照 `issues` 块里的 `issue` 组件，组件 id 用天枢议题 id（`issue:<id>`），属性 `core_question`（必填）、`responsible_hint`（可选）。先随 03 的快照或单独一份快照写入组件，再记事件。
- 提出 `world_raise_issue`、路由 `world_route_issue`（`to_principal_id`）由天枢以自己的身份记（带写入声明）；承接 `world_own_issue`、处置 `world_dispose_issue`（六类之一 + 理由）、退回形成 `world_return_issue` 以代记记（议题族委托已登记）。五个动作都不带 `target`，用 `params.issue_ref` = `<快照 id>@<版本>#issues/<组件 id>`。

## 待补信息

- 天枢里哪类「议题」进本体：`apps/api/src/issues.ts` 的 CEO 议题、DRI 推送的议题，还是两者；天枢议题状态到本体 提出／路由／承接／处置 的对应，以及六类处置在天枢里的来源。
- 主受影响对象怎么从天枢议题上确定（关联的个人任务，还是默认 E&O 单元）。

## 完成定义

- 示例 §9 请求／返回的桩测试：完整流转、改路由、退回形成后重新提出、已处置不再提出。
