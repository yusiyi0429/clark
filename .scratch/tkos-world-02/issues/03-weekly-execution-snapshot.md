# 03 · 每周执行状态快照

Type: implementation
Status: ready-for-agent
Blocked by: 01、02

## 要做什么

每周一（上海时间）为每个已链接的 Mission 推上一周的执行状态快照，替代旧的拉取接口。

1. 先记来源事件：`world_record_event`，`category:"other"`，主体该 Mission，内容「天枢每周同步 <ISO 周>」，幂等键 `tianshu:weekly-sync:<missionCode>:<ISO周>`。
2. 再写快照：`world_refresh_state`，`payload_type:"execution_state"`，`subject_ref` 为 Mission 对象引用，`as_of` = 该周周日 `23:59:59+08:00`，`source_event_refs:["event:<上一步事件 id>"]`，幂等键 `tianshu:weekly:<missionCode>:<ISO周>`，声明 `human_acceptance.required=false`；不带 `generator`。
3. 块：`progress` 里每人 × 每个执行事项一个 `progress_item` 组件，组件 id `todo:<uuid>`，属性 `principal_id`、`principal_name`、`external_status`（天枢状态原样）、`entries`（本周条目，`{at, source, text, url?}`，`source` 与天枢一致：web／codex／claude／github／other；主链接进 `url`，其余链接进组件 `artifacts`）；`issues` 暂空（09 接）；`materials` 放天枢任务卡链接。
- 数据来源复用 `apps/api/src/weeklyProgress.ts`（现有按周、按人汇总的逻辑）；该周没有任何条目的 Mission 仍推一份（进展块写一句说明），保证每周都有快照。
- 周一由调度器触发，失败按幂等键重放；`INVALID_STATE`（同 as_of 已有）视为已推过。
- 完成后删除 `GET /api/ontology/weekly-progress`、`ONTOLOGY_SERVICE_TOKEN` 及其契约与测试。

## 完成定义

- 用示例 §3 的请求／返回做桩测试：两步顺序、组件形状、周边界（周日 23:59:59+08:00 与 ISO 周一致）、同周重跑不重复。
- 联调时对 world-02 推一周真实数据，取对象的 `records` 能看到最新快照、`progress` 组件 id 为 `todo:<uuid>`。
