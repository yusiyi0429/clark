# Company 读取 World，Personal 由本人主私聊自然形成

替代 ADR-0004 的旧认知更新方式及 ADR-0013 的 CompanyMemory MCP；ADR-0010 的原始聊天和业务事实不归 Runtime 持有原则继续有效。

World 是公司事实唯一权威。Company 是经过授权读取、提取和治理的可重建 Markdown 阅读投影；本地产品库保留产品状态、草稿、Card 与历史。主 Agent 只读，World 写回由产品流程完成，不从旧 CompanyMemory Markdown 回退公司事实。

PeopleDirectory 独立保存稳定 personId 与登录角色。雷达、预审、预研与已有共同读取方直接使用 CompanyReader，不再经 CompanyMemory MCP。后台必须配置 COMPANY_SYSTEM_PERSON_ID，并在 COMPANY_WORLD_ACCESS_FILE 为该 personId 显式列出允许的 World domain；服务 bearer 不赋予任何额外范围。缺配置时公司事实不可用，身份登录与其他 MCP 仍独立工作。

主私聊区分当前 Query、有权 Card 投影形成的 Anchor 和按需 Reference。Anchor 是场景重要性，不是公司事实权威；Reference 消费 Company 与每人 Personal.md，正文不带来源哈希或协议元数据。用户原话保持原样保存，当轮上下文仅临时提供给 Pi；规则和 Procedure 的执行语义不变。

Personal 只保存本人长期偏好与协作约束，通过主私聊后台自然蒸馏并支持本人查看、纠正与遗忘。公司的业务事实不进入 Personal。遗忘同时使相关旧运行态失效并阻止旧蒸馏任务复活被删记忆。

个人归纳只处理本轮新增或明确改变的偏好。历史消息用于理解指代，每项候选必须包含 currentSequence 对应的本人逐字证据，不在后续轮次补录历史遗漏。候选状态为 apply、noop 或 needs_clarification；只有 apply 可携带变更，只有 needs_clarification 可携带澄清问题。成功说明不得占用澄清字段。业务校验与整批写入完成后才报告执行成功；模型提交候选不等于记忆已保存。原子提交、版本检查、epoch 与遗忘排除继续生效。

公司新查询使用 query 或空参数，后续分页只传 cursor。续页沿用服务端保存的原查询条件，不能携带新的 query；更换关键词须开始新查询。正文仅在本轮模型请求中恢复，工具 Trace 在历史占位替换之前记录获准观测并已脱敏的真实返回。

运行文档保存在 MEMORY_STORAGE_DIR 的 Company/Personal 子目录中；目录仅 API uid 可读写，部署使用持久卷。旧 /mcp/company-memory、专用 token 和 Markdown seed 启动依赖删除；/mcp/me 保留个人授权。

获准的业务观测完整记录 Company/Personal 正文与个人蒸馏内容，不再按记忆类型隐藏输入输出。凭据始终排除。托管处理授权与访问控制见 [ADR-0008](0008-allow-full-model-traces-in-hosted-services.md)，真实节点协议见 [ADR-0028](0028-langsmith-thread-turn-spans.md)。
