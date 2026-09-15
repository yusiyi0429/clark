# company-people.v1

CompanyMemory MCP 的最小稳定人员目录契约。真实人员 seed 是 Meeting、Transcript、DRI import 和 MonthlyPlan owner 的前置输入，不得从显示姓名临时生成 personId。

```json
{
  "schemaVersion": "company-people.v1",
  "people": [
    {
      "personId": "person-stable-id",
      "displayName": "真实姓名",
      "roles": ["ceo", "dri"]
    }
  ]
}
```

## 约束

- `personId` 必填、稳定、全目录唯一，创建后不得因改名复用或重写。
- `displayName` 必填，只用于展示。
- `roles` 至少一项；MVP 只需要识别 CEO、DRI 和普通 participant。
- 战场归属不放在 Person 中；todo 和 feedback 自己携带可选 battlefieldId。
- 当前真实人员内容由项目授权人提供，不使用演示人名填充 production。
- CompanyMemory MCP 的 `search_people` 读取该契约；未来迁移数据库时保持返回结构不变。
