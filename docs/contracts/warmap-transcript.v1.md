# warmap-transcript.v1

CEO WarMap MVP 唯一接受的逐字稿导入格式。系统不做录音、ASR、格式转换或说话人映射。

```json
{
  "schemaVersion": "warmap-transcript.v1",
  "meetingId": "meeting-2026-09-15-01",
  "turns": [
    {
      "id": "turn-001",
      "speakerId": "person-ceo",
      "startedAt": "2026-09-15T09:00:05+08:00",
      "text": "灯塔项目优先，TokenOps 保留最低验证力量。"
    },
    {
      "id": "turn-002",
      "speakerId": "person-dri-01",
      "startedAt": "2026-09-15T09:00:20+08:00",
      "text": "我周五前提交资源排期。"
    }
  ]
}
```

## 校验

- `schemaVersion` 必须精确等于 `warmap-transcript.v1`。
- `meetingId` 必须对应已有 Meeting。
- `turns` 至少包含一项，并保持原始发言顺序。
- `turn.id` 必填且在文件内唯一。
- `turn.speakerId` 必须对应该 Meeting 的 participant。
- `turn.text` 去除首尾空白后不能为空。
- `turn.startedAt` 可选；有值时必须是带时区的 ISO 8601 时间，且不能破坏发言顺序。
- 任一项不合法时整份拒绝，不保存部分 turns，也不调用会后复盘 Agent。

participant 的姓名、角色和 CEO 身份只保存在 Meeting，不在 Transcript 中复制。