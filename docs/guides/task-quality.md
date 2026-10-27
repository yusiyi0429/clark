# Task 数据质量与本人补齐

入口：个人菜单 → 任务数据质量；会议记录卡 → 核对会议结论与任务缺口。一号位页面为 `/task-quality`，成员页面为 `/me/task-quality`，身份来自本人当前登录视角。

先选已有 Task 并“现在核对”。可自行设置执行状态核对周期；不设置就不判过期。检查显示缺项、未知来源、来源更正、未归位事件与待治理确认。旧检查有明确时间，不能当作当前状态。只补材料不会把进展未知变成已知。

补齐草稿展示原文、时间、改前/拟改后和处理职责。建议、问题、未知时间及未定位字段会停在待处理；补充信息仍关联原候选。会议必须有当前确认版且全文来源一致，分析逐段保留未覆盖项；也可从已核对段落手动补齐。模型输出不直接写 world。

“复制给个人 Agent”只复制指令。Agent 通过下列个人 MCP 工具取得同一项：

| 工具 | 权限与作用 |
| --- | --- |
| `list_task_repairs` | `tianshu:read`；明确本人 `viewerRole`，读取私有候选 |
| `get_task_repair_handoff` | `tianshu:read`；核对当前来源/范围并给一项请求，读取丢失字段回执 |
| `report_task_repair_receipt` | `tianshu:write`；保存实际回执核对结果，不提交 world 业务动作 |

来源阶段先显示准确原文和 scope，取得本人对此项依据的确认。用个人已配置的 `tkos-world act world_record_event` 执行原 params、reason 和 idempotency key，再回报来源回执。来源核验后重新获取 package，用 `tkos-task-writeback import ... --save ...` 导入，审阅完整差异与指纹，取得本人具体确认后 apply。字段回执可以回报，也可不带 receiptId 查找原请求结果。

下载、来源登记、字段核验、治理确认是不同状态。已有回执但内容/来源变化时继续显示需复核；不能自动通过业务门。世界范围变化、无权或源版本变化返回具体错误，不换凭证或实例兜底。服务不传人凭证，既有 Task 服务写白名单和 TK 只读限制保持有效。

## 开发与版本

依赖 Chat PR #3 的服务端上下文分支及天枢 PR #51 的可信 Chat 代理；Runtime 需 quality/verify 扩展。天枢使用 `CHAT_SERVICE_URL` 与 `INTERNAL_CHAT_TOKEN`；未配置时界面显示尚未接通。Chat 需先应用自己的新增迁移，天枢本次没有数据库迁移。

公共类型来自 Chat 的固定源码快照，不手写第二套：

```sh
node scripts/sync-chat-task-quality.mjs /path/to/Chat_Service
pnpm --filter @warmap/web gen:client
```

`packages/contracts/src/vendor/chat-task-quality.json` 记录来源 commit 与 SHA-256；源码字节应与该版本一致。浏览器类型从公开 OpenAPI 生成。现有 OpenAPI 路径/字段语义没有变化。

`apps/api/acceptance/task-quality.ts` 由 Runtime `acceptance/task_quality/test_services.py` 启动，使用隔离 PostgreSQL 55212、三个真实 HTTP 服务和个人 CLI；没有真实模型、会议或业务写入。真实三人试点仍等会议纪要就绪。本次 PR 不合入个人资料 #52，不代表部署、启用定时巡检或真实试点验收。
