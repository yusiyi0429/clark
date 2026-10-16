# 天枢 Company + Personal 记忆：独立源码研究

日期：2026-10-16。研究技能：`mattpocock-skills:research`。本文件只记录研究，无业务代码修改。未以前次聊天结论为事实；先读根 CLAUDE.md、CONTEXT.md、ADR-0004/0010/0013。当前本地文档可能早于 World/Personal 新实现，所以以下关于天枢的论证是设计边界评估，不代替当前业务源码诊断。

## 证据范围与可复核来源

已实际 clone、读取 README/目录与五个 notebook 的代码 cell。固定 NirDiamant/Agent_Memory_Techniques commit **4767c0341ccd8b714147334c5f17c26ff99d8e41**。README 宣称30本，但该 SHA `all_techniques` 实有01–28；不能把路线图/宣传当作已实现能力。下面链接的行号是 notebook 原始JSON源码行号，有些整个cell存于同一行，函数名与cell序号辅助定位（从0起）。未调用外部模型执行notebook、未对天枢做运行实验，故不报告效果增益。

- [S14 consolidation](https://github.com/NirDiamant/Agent_Memory_Techniques/blob/4767c0341ccd8b714147334c5f17c26ff99d8e41/all_techniques/14_memory_consolidation/memory_consolidation.ipynb)：`ConflictResolver` cell23 [L406](https://github.com/NirDiamant/Agent_Memory_Techniques/blob/4767c0341ccd8b714147334c5f17c26ff99d8e41/all_techniques/14_memory_consolidation/memory_consolidation.ipynb#L406)，`_process_single_cluster` cell30 L495，`consolidate` cell32 L548，`rescore_importance` cell25 L428。
- [S16 reflection](https://github.com/NirDiamant/Agent_Memory_Techniques/blob/4767c0341ccd8b714147334c5f17c26ff99d8e41/all_techniques/16_self_reflection_memory/self_reflection_memory.ipynb)：`evaluate_output` cell18 L428，`_build_reflection_context` cell27 L641，`_execute_and_reflect` cell30 L691。
- [S21 cross-session](https://github.com/NirDiamant/Agent_Memory_Techniques/blob/4767c0341ccd8b714147334c5f17c26ff99d8e41/all_techniques/21_cross_session_memory/cross_session_memory.ipynb)：`SessionState` cell9 L184，`SQLiteBackend` cell11 L246，`extract_facts` cell13 L299，`CrossSessionAgent.end_session` cell21 L538。
- [S22 shared-memory](https://github.com/NirDiamant/Agent_Memory_Techniques/blob/4767c0341ccd8b714147334c5f17c26ff99d8e41/all_techniques/22_multi_agent_shared_memory/multi_agent_shared_memory.ipynb)：`AccessControl` cell11 L235，`SharedMemoryPool.write` cell15 L305，`Agent.write_shared` cell21 L441，`Blackboard` cell25 L523。
- [S28 evaluation](https://github.com/NirDiamant/Agent_Memory_Techniques/blob/4767c0341ccd8b714147334c5f17c26ff99d8e41/all_techniques/28_memory_evaluation/memory_evaluation.ipynb)：`_eval_retrieval` cell28 L673，`_eval_faithfulness` cell30 L691，讨论/局限cell44 L881。
- 第一方 LangGraph 实际源码固定 **e77a5cb08c1f3ff306d997dd76fc7169afdab5ea**：[BaseCheckpointSaver L199–224](https://github.com/langchain-ai/langgraph/blob/e77a5cb08c1f3ff306d997dd76fc7169afdab5ea/libs/checkpoint/langgraph/checkpoint/base/__init__.py#L199) 明确thread_id用于checkpoint；[BaseStore](https://github.com/langchain-ai/langgraph/blob/e77a5cb08c1f3ff306d997dd76fc7169afdab5ea/libs/checkpoint/langgraph/store/base/__init__.py#L708)提供namespace/key存储，[TTLConfig L545](https://github.com/langchain-ai/langgraph/blob/e77a5cb08c1f3ff306d997dd76fc7169afdab5ea/libs/checkpoint/langgraph/store/base/__init__.py#L545)、put L866、delete L952提供生命周期接口。这支持把会话执行态和持久知识分开；namespace本身不证明应用已落实ACL。

## 1. 最强支持论证：简单只读投影是正确的安全与权威边界

Company知识不是一个Agent自己的经验缓存。组织事实已有确认者、版本和更新流程；若再让每个Agent把“我认为”写入一份长期真相，会产生两个互相竞争的事实源。天枢ADR-0004把认知更新另立提案并由CEO确认，ADR-0010把原始Conversation和业务事实留在产品持久层，ADR-0013将MCP限制为目录、检索、读来源。这个边界可换Runtime、可追证，且阻断“回答→反思→自认正确→成为公司知识”的循环污染。

S22 `Blackboard`直接把有权限的共享条目聚成只读视图；Agent的private scratchpad不自动进入shared pool。它说明共享读取与私有思考隔离本身就是完整设计选项，不要求共享记忆自动写入。World已经拥有的事实，应读取当前权威版本或按版本引用，没必要靠会话抽取再造一份。Personal以人可读文件/记录承载偏好与经验，也便于本人理解、更正，少一套向量库不等于少了记忆能力。

适用边界：知识规模可控、领域对象和权限清楚、MVP尚未证明检索质量为瓶颈。这是对边界的支持，不代表仅接通只读工具就能获得持续学习。

## 2. 最强反对论证：只读接口和可读文件不是记忆闭环

如果用户在事项A纠正自己的沟通偏好，在事项B仍要重复；或World对象已改版而对话仍引用旧缓存，那么系统虽然保存了信息，却没有在正确范围、正确时间使用它。问题不在文件vs向量，而在提取、取舍、更新、检索和验证有没有明确契约。

S21用`user_id`作为唯一主键，每用户只有一个SessionState；`end_session`从当前`last_n_messages`重新提取并**替换**`extracted_facts`，没有与旧facts逐项合并。summary/last_n加载策略会裁消息，因此不能据此证明不丢失跨会话事实，也不适用于天枢同一人多个对象thread并行。长期Personal必须绑定person，公司知识绑定company/World scope；thread仅是来源与执行态，不该成为长期记忆唯一地址。LangGraph将thread checkpoint与namespace store分离，提供了可核验的实现层对照。

如果Personal只读给Agent、没有任何被授权更新链路，它只能使用预置知识，不能把新信息留给下次。应明确“谁能写、何时写、写入何种证据”，不能靠提示词一句“记住”代替持久化。

## 3. 最小根本方案：保留权威分离，补一个有证据的更新闭环

以下是本研究建议，非教程已验证生产方案：

1. **分三种地址**：thread执行摘要；person长期Personal；company共享Company/World。长期条目保存稳定key、文本、适用范围、来源message/object/version、有效时间、状态（当前/被替代）即可。复用现有存储，不先引新框架。
2. **提取候选**：从新增用户原话、已确认业务对象、可验证工具结果提取。助手回答是解释材料，不独立作为事实证据。偏好只来自本人明确表达；反思是待验证经验，不自动升级成公司事实。
3. **查重与冲突先保真**：同subject/predicate/scope寻找现有条目；同义可合并但保留source refs；不同时间有效的事实不是互斥错误。Company冲突交权威业务流程；Personal明确新偏好可替代旧偏好，不确定则保留争议并询问或不注入。
4. **受控写入**：个人明确“记住/以后这样”可按既有授权直接写Personal并告知；推断记忆先候选。Company更新走既定确认边界，禁止Agent通过记忆写绕过Action。写前检查源版本，源内容变化时重新比较。
5. **检索使用**：先按company/person权限与对象范围过滤，再按相关性/时效挑少量；取回证据与当前版本；无依据时明确未知。固定注入少量稳定偏好，按需检索细节，避免全量Personal每次灌入。
6. **遗忘/更正**：旧信息保留被替代关系、不再作为当前答案；用户可看/改/删Personal。删除须覆盖派生摘要/索引，Company正式记录遵循其业务保留规则。TTL/衰减是候选与缓存策略，不能按访问频率删除低频但有效的组织事实。

MVP无需通用记忆平台、全自动每日大复盘、复杂图谱或多Agent治理。先用一条真实跨thread偏好变化、一条组织事实改版跑通上述最小链路，再决定是否增加语义检索或后台批处理。

## 4. consolidation教程值得学，但不能照搬的点

S14教会了分阶段维护：embedding→cluster→duplicate merge→contradiction resolve→importance/prune→replace。但其`_process_single_cluster`**先把相似条目合并成一个LLM新文本，再检测剩余条目冲突**；语义相近的相反陈述可能先被当duplicate合并，冲突证据随旧条目移除。新条目只继承最新条目的source/time，未保留全部父证据；loser被删除；`replace_all`整体替换内存字典。源码没有事务并发或业务授权保证。

`source_priority`固定 `user:3, inferred:2, tool:1`：这只是教程策略，组织场景工具从权威系统取出的已确认事实，完全可能比用户随口推测更可靠。“最新”也可能是过时材料今天才上传。必须区分recorded_at和effective_at、引用对象版本与确认状态。O(n²)相似比较、0.8/0.92阈值和0.15剪枝值都是演示参数，不是天枢生产标准。

## 5. 反思不等于事实验证

S16的`evaluate_output`按关键词覆盖率判success/partial/failure，`expected`参数虽传入却不参与比较；“success”阈值是0.8，与docstring称ALL不一致。`_execute_and_reflect`把非success结果送给同类模型生成root cause/insight并存储，下次 `_build_reflection_context`注入“Apply these lessons”。因此错误评价会制造错误归因，再通过持久注入强化；反思结构化并不能保证因果解释正确。

可借鉴：把任务、实际输出、预期、结果一起保留；区分episodic证据和procedural经验；已验证经验按相关任务检索。不可照搬：将一次自我解释直接当正确经验，更不能把反思中的公司陈述写入权威Company。优先记录“观察到什么/证据是什么/下次验证什么”，证据不足就保留假说身份。

## 6. 评测必须同时测记住、用对、改对、不越权

S28分解Recall@K、Precision@K、MRR、faithfulness、temporal与contradiction，比“觉得聪明了”可靠；但其示例是合成Alice资料和关键词检索，作者自己说明无下游task评测、LLM judge有偏差、真实更新可能被误判contradiction。Faithfulness只说明回答忠于给定记忆，不说明记忆是真的或可给当前用户看。

建议天枢先建少量真实验收案例，分别跑无Personal/现状/改进方案；人工标注允许范围、当前有效事实与证据，模型评分只辅助。最低覆盖：A thread记偏好B thread使用；用户更正后旧偏好不再胜出；并行thread写不丢；公司候选不变成事实；World改版后引用当前版；另一person不可读；删除后不从摘要复活；无证据的反思不变成事实。指标同时看任务成功、正确证据率、过期使用率、权限泄漏、错误持久化、延迟/token。固定问题、版本与模型后对比，才能判定是否需要更复杂检索。

## 7. 最终取舍

根本问题应表述为“共享与私人知识如何在保留权威边界下可靠更新并在正确上下文使用”，不能简化成“缺了某种记忆技术”。支持方最强证据是只读共享投影避免竞争事实源，反对方最强证据是无更新/冲突/检索契约就没有跨thread持续学习。优先补最小证据闭环，保留可读Personal与World只读边界；只有验收显示召回或规模瓶颈时再加向量/图谱/批量consolidation。
