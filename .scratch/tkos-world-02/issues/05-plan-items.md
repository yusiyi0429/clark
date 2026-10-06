# 05 · 执行事项 → 计划条目

Type: implementation
Status: ready-for-agent
Blocked by: 01、02

## 要做什么

天枢里新建执行事项（`apps/api/src/tasks.ts` 的 `createMyTask`）且它挂在已链接的个人任务下时，立即修订对应 Mission 的执行计划块，加一条 `plan_item` 组件；E&O 据此建 Task，并把同一个 `todo:<uuid>` 写进 Task 的外部引用。

- `world_revise_object` 目标为该 Mission（先取 `business` 组的 `revision_id`／`object_version`），`payload.blocks.<执行计划块>.components: [{id:"todo:<uuid>", type:"plan_item", text:<事项标题>, attributes:{responsible:<执行人 principal_id>}}]`；组件按 id 合并，不整块替换。声明 `human_acceptance.required=false`。
- 事项改标题 → 同 id 改写；删除 → `{"id":"todo:<uuid>","removed":true}`（删掉的 id 不能再用）。
- 版本冲突重取再写一次；执行人不在 principal 映射里的（非试用三人）不推，记台账。

## 完成定义

- 示例 §6、§8 请求／返回的桩测试：新增、改写、删除三种补丁形状；并发两条新增不丢。
