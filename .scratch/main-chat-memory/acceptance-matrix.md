# 主私聊记忆：30 条固定场景的机制覆盖

范围：`evaluation-cases.json` 的固定 30 条合成场景。这里将每条要求映射到运行中的公开 HTTP / Pi provider / 公司与个人模块边界，不把读取 JSON 或断言常量当验收。受控 provider 只提供确定性工具调用，不能证明自然语言回答正确、指代正确或蒸馏质量；所有行的真实模型语义验收及真实 World 联调均**未执行**。

路径以仓库根为起点。API 测试使用独立 PostgreSQL 数据库、真实迁移、真实 Pi SDK；World 使用本地 HTTP fixture，既不读生产数据也不写真实 World。

| Case | 已执行的公开机制检查（测试文件 / 行为） | 尚未证明的语义 / 外部条件 |
| --- | --- | --- |
| S01 | `conversation.test.ts` authorized home Cards、visible pagination：目录同源、无 focus 时不造 focus | “今天先看什么”的选择质量 |
| S02 | 同文件 validates focus；Web `useConversation.events.test.ts` 单独提交选择；`conversationHost.behavior.test.tsx` 当前 Card version | 模型“这一项”正确指代；没有新增首页选择器 UI |
| S03 | `conversation.test.ts` reference snapshot版本校验；scope isolation；Pi temporary reference 测试 | 两份材料比较的正确性 |
| S04 | `conversation.test.ts` 当前材料变更冲突；对象 Card scope；Web quotes 无损保留选文 | 材料段落分析质量；引用文本并非服务端授权 |
| S05 | Web Host 全局讨论清 focus；API global/object scope isolation | 从公司视角推理的质量 |
| S06 | HTTP `ANCHOR_VERSION_CONFLICT`；Web failed input retryable | 用户浏览器端实际刷新体验需人工验收 |
| F01 | `company.test.ts` main private runtime 工具只读 World，local facts函数若被调用即抛错；草稿状态保留 | “10 vs 8”模型正确判断正式值 |
| F02 | 同上：World只出现 GET，工具列表无写入；Anchor与Company分离 | 模型围绕10家草稿编辑但不宣称正式目标 |
| F03 | Company successful projection后模拟失败，返回unavailable不消费旧投影 | 不知道/拒答的自然表达 |
| F04 | World unchanged读取仍重读；更正后返回新事实；旧reference失效 | 真实World修订协议 |
| F05 | World全量分页失败不发布部分Company（专项测试）；覆盖不足与empty不同 | 真实域完整性、生产分页上限 |
| F06 | Company fixture lifecycle draft及正文提取保留“草稿” | 不将计划交付改述为已完成 |
| P01 | HTTP member目录不含CEO隐藏标题；计数和分页在授权集合内 | 真实组织权限配置 |
| P02 | Personal HTTP本人接口；service跨人引用拒绝；`mainMemoryIntegration.test.ts` production app共享P1可展开 | 生产存储隔离配置 |
| P03 | 本轮短handle映射；旧Company文档句柄失效；Runtime restore不保留临时Anchor | 短别名可在新轮重新分配，工具含义始终是当前轮资源 |
| P04 | Company read中途撤权及显式重新读取；Anchor重新取授权Card集合 | 真实World撤权实时性 |
| P05 | HTTP鉴权，Personal forged owner400；Card焦点404；契约不接收Anchor正文 | 任意模型攻击成功率未评测 |
| P06 | service bearer全量能力下ungranted viewer仍coverage_unavailable且零HTTP；显式授权域读取 | 正式人员到World域授权表需部署配置 |
| M01 | `personalDistillation.test.ts` 成功主聊durable natural job，worker重启处理；仅本人原话证据 | 模型自然提取“先结论”的质量 |
| M02 | worker prompt明确排除假设、角色扮演、一次性要求；结构化证据校验 | 假设识别依赖模型，**尚未实测通过** |
| M03 | stable attribute更新、版本冲突、本人PUT与显式任务治理 | 自然措辞能否准确匹配旧属性 |
| M04 | forget排除旧任务、跨scope历史cutoff、running checkpoint防回流；main失败的任意措辞请求durable等待worker | 模型定位约束是否准确；非regex请求后台执行有延迟 |
| M05 | newer explicit intents、manual forget取消旧任务；同人锁、revision/epoch检查 | 模型新旧偏好含义识别 |
| M06 | 自然任务仅本人原文、current-turn evidence及inferred约束；公司事实排除的prompt | 归纳谨慎性和事实分类依赖模型，**尚未实测通过** |
| R01 | real Pi先后两轮Anchor切换、entries不带临时内容；HTTP raw Query；legacy重建历史保留 | 助手可能复述事实，历史始终是当时讨论 |
| R02 | real Pi read_anchor toolCall/toolResult配对，首次/工具续轮均恰好一Anchor | 模型何时选择调用工具 |
| R03 | real Pi自动/手动compact测试：压缩看不到临时Anchor/Reference，主请求重注入 | 压缩摘要内容质量 |
| R04 | 完整query/focus保留、超大Reference先缩减；超限query provider零调用；工具对配不裁剪 | tokenizer是估算；真实provider计费、时延未测 |
| R05 | 默认缺World配置的真实Pi HTTP仍可回答用户文本；旧Markdown启动依赖已删除 | 真实模型润色质量 |
| R06 | main工具列表仅World读取；Reference显式标数据；无确认计划/World写工具 | prompt injection遵循性**未实测通过** |

未运行三策略真实模型对比（旧全量 JSON、Anchor+有界Reference、仅索引），未记录模型正确率、拒答率、p50/p95时延；因此本实现验证了约束机制，不宣称容量配额科学最优或模型业务效果已验收。
