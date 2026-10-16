# 本地验收：主私聊、记忆与 LangSmith

先按[本地开发](local-development.md)启动独立数据库、API 和 Web。配置集中在根目录 `.env`。本指南验证真实服务，不以测试替身代替外部验收。

## 前置条件

- 模型地址、凭据和三个模型槽位可用。
- World 地址与只读凭据可用。
- 人员目录中的 `personId` 与登录账号一致。
- `COMPANY_WORLD_ACCESS_FILE` 明确列出每人的可见 domain。
- 后台读取使用的 `COMPANY_SYSTEM_PERSON_ID` 也有显式授权。
- LangSmith 配置使用实际项目名；示例为 `Tianshu_Oct`。
- 网络允许访问模型、World 和 `api.smith.langchain.com`。

World 服务令牌不授予成员额外可见范围。授权文件示例结构为 `{"person-id":["authorized-domain-id"]}`。不得把示例人员当作真实公司名单。

缺少公司读取配置时，公司事实必须显示不可用。不得用旧 Markdown 或页面快照补作 World 事实。保持 TLS 校验开启。

## 验收步骤

1. 在主私聊连续发送两轮。
   在 LangSmith 核对相同 `thread_id` 与不同 `logical_turn_id`。
2. 展开 Agent、model、tool 和 retrieve 节点。
   核对真实调用边界、名称、metadata 与 caller tags。
3. 记录一次请求的 `logicalTurnId`。
   失败后原样重试，核对新 attempt 和沿用的用户消息。
4. 重复投递已完成请求。
   核对保存的回答，不得新增执行 Trace 或重复用户消息。
5. 表达稳定个人偏好。
   等待蒸馏后检查个人记忆正文与版本，不只看工具成功状态。
6. 明确纠正或遗忘该偏好。
   检查记忆变化，并用另一账号验证隔离。
7. 询问授权 World 中已有的公司事实。
   核对可读正文、人员范围及只读边界。
8. 引用可见 Card 后提问。
   核对当轮 Anchor，并确认下一轮不复用旧页面正文。
9. 检查模型实际用量和首 token 事件。
   Provider 未返回的指标保留缺口。
10. 检查完整业务观测。
    Company/Personal 正文与蒸馏内容必须可读；API key、token、password 不得进入追踪。
11. 设置 `LANGSMITH_TRACING=false` 并重启 API。
    确认聊天可用且不上传新追踪。

## 判定与证据

记录请求 ID、追踪链接、记忆版本及实际结果。失败项保持失败，缺少外部资源的项目标为未验证。查询最近一页追踪不能证明完整历史。

个人蒸馏只学习本轮内容，历史消息用于理解指代。检查候选状态 apply、noop 或 needs_clarification，以及后续校验和写入节点；`submit_candidate` 成功只表示候选已提交。最终 memoryOutcome、revision 和变更数量才说明业务处理结果。故意提交只引用历史的变更时，应看到 `NO_CURRENT_USER_EVIDENCE` 且记忆保持不变。

协议见 [ADR-0028](../adr/0028-langsmith-thread-turn-spans.md)。记忆边界见 [ADR-0027](../adr/0027-company-world-and-personal-memory.md)。
