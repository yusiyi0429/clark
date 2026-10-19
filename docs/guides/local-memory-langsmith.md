# 本地验收：对话、记忆与 LangSmith

先按[本地开发](local-development.md)启动开发库、API 和 Web。本指南验证真实模型、本体和 LangSmith，不能用自动测试的替身代替。

## 前置条件

- 模型地址、凭据和三个模型槽位可用。个人记忆召回可另配 `MEMORY_RECALL_MODEL`。
- 验证本体公司事实时：配置 `TKOS_WORLD_API_URL`、`TKOS_WORLD_AGENT_TOKEN`（或 `_FILE`）和 `COMPANY_WORLD_ACCESS_FILE`。授权文件结构为 `{"<personId>":["<domain_id>"]}`，personId 要和登录账号一致。服务令牌本身不扩大任何人的可见范围。
- 验证追踪时：`LANGSMITH_TRACING=true`、`LANGSMITH_API_KEY`、`LANGSMITH_PROJECT`，网络能访问 LangSmith。全局 Shell 里已有 LangSmith 变量时，先确认它们没有覆盖 `apps/api/.env`。
- 只做轨迹冒烟时，可以用 `apps/api/scripts/langsmith-smoke.ts`：它在一次性测试库里发一条真实对话并打印 Trace 链接，用法见文件头。

## 验收步骤

1. **两轮对话的轨迹**：在主对话连续发两轮。LangSmith 里两轮的 `thread_id` 相同、`logical_turn_id` 不同，根节点名为 `turn:<logical_turn_id>#a<attempt>`。展开后能看到真实的 `agent:`、`model:`、`tool:`、`retrieve:` 节点，接入方以 `client:web` 等 tag 区分，用户只以 `anon_user_id` 出现。
2. **用量与首 token**：模型节点的 token 用量来自 Provider 实际返回；没有返回时保留缺口，不估算。
3. **凭据过滤**：业务正文、个人记忆和公司事实正文会进入追踪；API key、token、password 等凭据字段不得出现。
4. **个人记忆写入**：自然说出一条稳定的个人偏好。后台提炼完成后，在记忆页（CEO `/memory`，成员 `/me/memory`）看到新条目，而不只是工具调用成功。
5. **纠正与遗忘**：明确改口或说“这条不要再记”，记忆页里旧条目显示为已替代或已删除；删除的条目可以恢复。
6. **召回与标记**：再问一个相关问题，回答里用到某条记忆的句子末尾出现记忆标记，点开能看到并修改这条记忆。
7. **隔离**：换另一个账号登录，看不到前一个人的个人记忆。
8. **记忆导入**：在记忆页粘贴一段资料导入，系统拆分、分类、找出重复与冲突后等本人确认，确认前不写入。
9. **本体公司事实**：问一个授权域里有的公司事实，对话步骤显示“查本体”并引用本体正文。去掉本人的域授权后再问，回答应先说明这次没读到本体，再用本地 CompanyMemory 回答并注明来源。
10. **关闭追踪**：设置 `LANGSMITH_TRACING=false` 并重启 API，对话照常可用，LangSmith 不再出现新轨迹。

## 判定与证据

记录请求时间、追踪链接、记忆条目 id 和实际结果。失败项保持失败；缺少外部资源的项标为未验证。只看最近一页追踪不能证明完整历史。
