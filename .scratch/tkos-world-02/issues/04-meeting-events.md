# 04 · 会议事件

Type: implementation
Status: ready-for-agent
Blocked by: 01、02

## 要做什么

会议纪要在天枢确认后，给本体记一条 `category:"meeting"` 外部事件。

- 主体：会议关联到的已链接 Mission（可多个，`subject_refs` 去重）；没有关联 Mission 时用 E&O 单元（按 `capability:05` 查回）。不属于 E&O 的会议不推。
- `occurred_at` = 会议开始时刻（带 +08:00，不晚于写入时刻）；`content.text` 写会议结论（天枢已确认的 Outcome 条目），`content.artifacts` 放天枢会议页链接；幂等键 `tianshu:meeting:<meetingId>`；声明 `scene` = 第一个主体、`human_acceptance.required=false`。
- 触发点：会后 Outcome 确认完成（`apps/api/src/outcome.ts` 的确认流程）后异步推送，失败按键重放；纪要更正时记 `correction` 类事件并 `supersedes_event_id` 指向原事件。

## 完成定义

- 示例 §4 请求／返回的桩测试；主体选择三种情况（有 Mission、无 Mission 回落单元、非 E&O 不推）。
