# LangSmith 按 Thread、Turn attempt 和真实调用边界观测

使用 `langsmith` SDK 的 Client/RunTree，替代运行结束后的手写单条 `/runs` 汇总。主私聊通过 HTTP 路由建立 Turn root，Pi Runtime 建实际 Agent、模型与工具子 Run。共享候选 Runtime 接入同一协议；没有实际执行的 Agent、工具或模型不创建节点，不创建 graph 节点。本次不增加事项群组消息、任务卡批注或独立 apps/m2 的入口编排。

- `trace_threads` 将业务会话绑定到应用生成的 UUID7；主私聊绑定 `conversation:{durable_conversation_id}`，不依赖可替换的 Pi session。所有子 Run 继承相同 `thread_id`。
- `trace_turns` 持久保存 `logical_turn_id` 和递增 attempt。Web 为一轮输入生成 UUID7，失败后原样重发沿用该 ID。服务端恢复后从数据库继续计数，每次执行新建 `turn:{logical_turn_id}#a{attempt}` chain root。
- 原样重试失败轮次复用原始用户消息，并从原始历史重建运行态；不重复写用户消息。已完成轮次的重复投递返回保存的回答，不生成执行 Trace。修改输入或在已有后续轮次后重试旧失败轮次返回 409。
- 模型节点位于 Provider 的真实 `streamSimple` 调用边界，位于异步凭据/取消准备之后；compaction 的真实模型请求也记录。工具节点包装实际注册工具的 execute。SSE 仅负责展示，不据此事后合成 Span。
- Personal 后台蒸馏以 `personal-memory-job-{job_id}` 为稳定逻辑执行 ID，同一业务会话 Thread 下重试递增 attempt；同步处理本轮请求时可作为其实际 Agent 步骤。其他独立候选按人员和业务对象绑定 Thread。后台与 Web 通过 `caller:worker` / `caller:web` tags 区分。

Run 名全小写：`turn:{logical_turn_id}#a{attempt}`、`agent:{agent_role}`、`model:{provider}/{model_id}`、`tool:{tool_name}`、`retrieve:{source}`。Agent chain 的 `ls_agent_type` 为 root 或 subagent；实际检索使用 retriever 类型。Provider 使用实际注册名 `warmap`，不将示例 provider 名冒充实际接入方。

metadata 只使用：`thread_id`、`logical_turn_id`、`attempt`、`scope`、`anon_user_id`、`agent_role`、`ls_agent_type`、`ls_provider`、`ls_model_name`、`ls_tool_name`、`ls_message_format`。不再发送 user_id、user_name、对象标题或其他近义字段。`anon_user_id` 是稳定密钥 HMAC；默认使用 SESSION_SECRET，可独立设置 LANGSMITH_IDENTITY_SALT。SDK 自动运行环境 metadata 关闭。接入方放 tags，不扩充 metadata 白名单。

模型 outputs 使用 OpenAI 消息格式与 LangSmith `usage_metadata` 契约。只保存 Provider 返回的 input/output/cache/total token，不写 SDK 模型价格表中的占位 cost，也不手工拼父节点聚合指标。全零占位 usage 无法证明 Provider 报送了用量，保留缺口。首个非空 text/thinking/toolcall delta 才产生带实际时间的 `new_token` event；最终消息、start/end 或本地文本回放不算首 token。没有事件就不补写时延；Run 起止时间由实际执行边界产生。

按完整业务观测授权，Company/Personal Reference 正文、对应工具返回和个人蒸馏的输入输出进入 Trace。不得把候选提交成功当作业务写入成功。凭据仍不进入 payload 或传输错误日志。没有 key 或关闭 LANGSMITH_TRACING 时不上传；SDK 上传失败与业务结果隔离，关闭时等待已排队上报。当前为有界超时、无重试的尽力上报，不承诺进程崩溃后的离线补传。

LangSmith 原生 Threads 视图按 `thread_id` 聚合；切到 Traces 查看每个 Turn attempt，再展开 Agent/model/tool/retrieve Span。用 `logical_turn_id` 比较同轮 attempt，用 `scope`、`agent_role`、`anon_user_id` 和 caller tags 筛选。Thread 不是跨轮次的伪 root，不预聚合 Coze metrics_info。
