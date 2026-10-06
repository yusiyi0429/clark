# 07 · 执行事项生命周期代记

Type: implementation
Status: ready-for-agent
Blocked by: 01、05、08

## 要做什么

执行事项状态变化时，按 `todo:<uuid>` 查回 E&O 建好的 Task，代记对应的生命周期事件（示例 §7）：

| 天枢 | 本体动作 | 代谁记 |
|-|-|-|
| 建事项（或查回 Task 时尚未指派） | `world_assign`（指派给执行人） | 该 Mission 的 Owner |
| 进入 `in_progress` | `world_start` | 执行人 |
| `done` | `world_deliver` | 执行人 |
| `returned` | `world_reject` | Owner |
| 通过（08） | `world_accept` | Owner |

- 触发点：`apps/api/src/tasks.ts` 的 `updateMyTaskStatus`、`returnMyTask` 及 08 的新动作；每次带 `on_behalf_of`（`external_record_id` 用天枢的状态变更记录 id）。
- Task 还没建（E&O 尚未处理计划条目）时进待推队列，定时重查外部引用；已按顺序补齐（先 assign，再 start，再 deliver）。与当前状态不匹配的 `INVALID_STATE` 视为已推过，不重试。
- Task 责任人只能是人（于斯一、刘人豪）；执行人不在映射里的不推。

## 完成定义

- 示例 §7 请求／返回的桩测试：正常顺序、Task 晚建时补推、重复推送不产生第二次状态变化、打回后重新开始。
