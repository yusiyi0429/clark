# 天枢记忆：干净基线复现、根因与方案

## 范围与基线

目标固定为 `73e05cdcf87ba1d322f4a6214e09b31972c4374f`。本次复现由不继承父聊天历史的新 subagent 执行，不以旧 Thread 的累计结果推断当前版本。隔离源码位于 `/tmp/tianshu-clean-ceo`；260 个 API、迁移、契约及配置文件逐一校验 Git blob SHA，无差异。原工作区业务代码未修改。

新建本地 PostgreSQL 容器与 CEO 账号 `clean-ceo`，不连接生产数据。初始化时 conversations、conversation_messages、memory_documents、personal_memory_jobs 均为 0。真实 HTTP 登录和 session 均返回 CEO，global history 返回 messages=[]。实验与体验账号分离，体验库保持空白。凭据仅存权限 600 文件，不写入本报告。该环境是 API 诊断环境，没有交付公网网页；World 为合成只读服务，不能证明真实 World 授权或数据覆盖。

## 已执行证据

| 实验 | 结果 | 边界 |
| --- | --- | --- |
| 新用户单轮显式偏好，真实模型生成候选 | 真实 PostgreSQL 与文件写入成功，revision 1，下轮 select 含偏好 | 捕获真实模型候选后回放业务模块；非 UI 与后台调度实时全链路 |
| 新用户两轮自然偏好、memory=[]，真实模型生成候选 | 模型提取两项，分别引用旧轮与本轮；NO_CURRENT_USER_EVIDENCE，整批拒绝，revision 0 | 仅一个成功自然模型样本，不代表失败概率或普通连续两轮 UI 必现 |
| 仅去掉上述旧轮候选，保留当前候选 | 保存、召回成功 | 受控单变量对照，无源码改动 |
| 把旧证据伪装成本轮 sequence，但保留原 quote | INVALID_USER_EVIDENCE | 证明引用校验确实保护来源 |
| 真实 SQL 下更新偏好、遗忘、同 key 自然重放 | 更新可读；遗忘后为空；同 key 重放仍被阻止 | 不证明同义新 key 的语义屏障 |
| 当轮合法 change 同时带非空 clarification | AMBIGUOUS_MEMORY_CHANGE；无 change 的 clarification 可完成但不写 | 受控候选；本次两个真实模型样本 clarification 均为空，排除为它们的诱因 |
| Company 12 个合成对象分页 | 首页 8，次页 4，第 12 个对象可读 | 正确 cursor/query 的分页通过 |
| 真实 Company cursor/query 对照 | 同查询续页 ready、3 条；旧 cursor 改查询 unavailable、0 条 | 独立于受控 Pi Reader 实验，真实 Company 与本地 World HTTP 验证底层保护 |
| Company 查询、翻页与并发读取 | 每次 14 次 HTTP；3 请求 42 次；对象数改为 1 后每次 3 次 | 单域、单列表页；本地时延人为注入，不能外推生产秒数 |
| Company 无关键词命中 | 返回全域首页，明确附未精确匹配警告 | 是产品宽召回策略，不直接定为 bug |
| 真实 composeTurnContext 临时正文 | 本轮 provider 有正文，原 history 不含；下一轮不恢复旧正文 | 该项只执行上下文函数，不外推完整 Pi checkpoint 全链路 |
| 真实 Pi Runtime、空 entries 与受控 provider | 本轮模型请求含正文，返回 runtimeEntries 不含正文；工具 Trace 为占位，模型 Trace 输入含正文 | CompanyReader 为替身；真实 LangSmith 埋点与 RunTree 字段由内存传输采集，没有上传云端 |

原始实验入口及输出：

- `/tmp/fresh-personal-repro/run-pg.ts`：真实 PostgreSQL 回放入口。
- `/tmp/fresh-personal-repro/pg-replay-output.log`：真实 SQL、文件及召回结果。
- `/tmp/fresh-personal-repro/real-model-output.json`：两个真实模型样本的合成输入与原始候选。
- `/tmp/fresh-personal-repro/REPORT.md`：个人记忆实验边界、负对照与方案。
- `/tmp/fresh-company-repro/repro.ts`、`repro-output.txt`：公司读取及分页实验。
- `/tmp/fresh-company-repro/lifecycle-only.ts`：当轮副本与下一轮正文隔离。
- `/tmp/tianshu-clean-ceo-runtime/http-proof.json`、`initial-counts.json`：CEO 权限与初始空状态。
- `/tmp/tianshu-clean-ceo/apps/api/clean-runtime-probe.ts`、`/tmp/tianshu-clean-ceo-runtime/runtime-proof.json`：真实 Pi Runtime 与埋点受控实验。

## 定位：首次失败在哪里

### 个人记忆：候选范围与写入范围不一致

[personalDistillation.ts](https://github.com/TokenkingOS/Tianshu-MVP/blob/73e05cdcf87ba1d322f4a6214e09b31972c4374f/apps/api/src/personalDistillation.ts#L17) 的提示词允许依据本人消息归纳，输入包含最多 12 条用户消息。schema 允许候选引用其中任意 sequence；第 106 行进一步要求每条 change 都有 currentSequence 证据，这个更强约束没有明确传达给模型。真实自然样本在此首次失败。apply 发生在整批校验之后，故当前有效项也未保存。

这不是数据库丢写，也不是 select 漏召回；失败发生在二者之前。原子拒绝有保护价值，不能仅为成功率改成任意部分写入。该输入包含尚未入库的历史偏好；当前调度若已先成功保存历史项，输入可能不同，不能据一次样本推断普遍失忆。较早归纳失败或遗漏后，这种输入条件仍值得作为回归案例。

clarification 也有类似的协议易误解风险：它表示需要澄清，不能兼作成功说明。但本次自然失败的真实输出为空，因此不是本次根因。

### 公司知识：强一致读取成本与检索语义必须显式化

[company.ts:114–126](https://github.com/TokenkingOS/Tianshu-MVP/blob/73e05cdcf87ba1d322f4a6214e09b31972c4374f/apps/api/src/company.ts#L114) 每次 list、逐对象 read、再次 list 校验，随后才筛选并分页；第 184–186 行用实例队列串行执行。实验确认单域单列表页每次 N+2 次 HTTP。投影存在，但尚未承担有效的增量读侧加速。

这有一致性收益：没有把旧公司正文静默当最新。是否需要增量索引，取决于实际对象量、并发、World 限流及可接受新鲜度；合成实验不足以证明当前线上已达规模瓶颈。

无命中回退全域首页已明确警告，因此不是隐瞒失败。潜在风险在于下游仍可能把宽召回误当精确命中，再将“本次未读取到”升级为“公司不存在”。应返回可机读的匹配类型与覆盖范围，并评测回答是否遵守，不用一个 ready 混合各种证据强度。

### Pi 源正文隔离：保留，不能当作失忆根因

[turnContext.ts](https://github.com/TokenkingOS/Tianshu-MVP/blob/73e05cdcf87ba1d322f4a6214e09b31972c4374f/apps/api/src/turnContext.ts) 在 provider 副本加入 Anchor、Reference，并恢复当轮工具正文。函数级实验通过。它减少旧事实在历史与压缩中累积，但不删除助手回答中的事实，也不自动完成语义遗忘。跨轮连续性要靠稳定对象指代和按当前权限重查，不能靠永久保存所有源正文解决。

随后空 entries 的真实 Pi Runtime 受控实验进一步确认：provider 请求含正文，返回 runtimeEntries 不含正文。工具 Span 仍为占位是包装顺序的独立观测问题：[piConversationRuntime.ts:653](https://github.com/TokenkingOS/Tianshu-MVP/blob/73e05cdcf87ba1d322f4a6214e09b31972c4374f/apps/api/src/piConversationRuntime.ts#L653) 在 ephemeral 包装后再 trace，后者只看见替换后的结果。应保持 Pi 看到占位、Trace 在获准脱敏后看到真实工具返回；不能为修复观测而取消历史隔离。

同一 Runtime 实验显示工具 schema 接受 query 与 cursor 同传；入口允许新 query 覆盖 continuation 原 query。下一页应使用原 query 的语义没有被接口表达。该实验底层拒绝使用的是受控 Reader，不能冒称真实 World 返回。随后另一独立真实 Company + 本地 World HTTP 对照确认：同查询续页 ready、3 条；旧 cursor 改查询 unavailable、0 条。两段实验证明入口允许不相容参数、底层正确拒绝，不能称为完整组合链路或权限绕过。底层 Company 的版本保护应继续保留。推荐新查询与续页使用互斥参数或独立工具，错误区分参数不匹配、权限变化和源版本变化。

## 双向钢人论证

### 最强支持

World 唯一权威、Company 只读可重建，阻止 Agent 回答自我强化成公司事实。Personal 可读且本人可纠正，严格证据、原子提交、epoch 与排除记录保护不误写与遗忘。逐次重读牺牲吞吐换来可解释的一致性。MVP 可以优先避免污染，不应因为教程包含向量、反思、图谱就全部引入。

### 最强反对

边界正确不能保证 Agent 能可靠学习。模型收到的候选协议、业务接受的协议与用户理解的“记住”不是同一件事；即使模型提取准确，也会在隐藏约束处整批失败。只读投影每次全域重建又使扩大检索次数成为昂贵行为。只记录工具调用成功，无法证明校验、提交、召回和回答采用成功。自然连续理解必须成为可验收的链路，而非若干安全模块的推论。

### 本质分歧及决策变量

1. 自然归纳只学习本轮新增偏好，还是允许补录历史遗漏？两种合理目标需要不同任务和证据边界。
2. 公司查询是否要求每次全域强一致，还是允许有权限、版本和新鲜度标识的派生索引？
3. 写错、漏记和中断无关会话的代价如何排序？
4. 当前对象数与并发是否已达到检索层重构的收益点？

## 三套方案与副作用

| 方案 | 改动 | 代价与风险 | 验收 |
| --- | --- | --- | --- |
| A：对齐现有契约，推荐先做 | 明确每项必须由本轮支持；本轮无变化返回 noop；needs_clarification 与成功说明分开；暴露校验和写入结果；分页 query/cursor 互斥；Trace 记录真实工具结果、Pi 仍占位；保留原子提交与删除屏障 | 仍可能遗漏历史偏好；模型仍可能违约，必须可见失败 | 本次自然案例能处理本轮偏好；旧引用和假引用仍拒绝；纠正/遗忘继续通过；续页不允许改 query，工具 Trace 可审计 |
| B：分离当前治理与历史归纳 | explicit 只处理当前意图；自然历史归纳有明确证据窗口、水位及排除规则；必要时按不可分操作组提交 | 更多任务状态、历史补录可能导致被忘内容重生 | 历史遗漏可补录、并发不覆盖、删除不从旧任务/同义 key 复活 |
| C：Company 增量检索层 | 保持 World 权威，按授权域与源版本维护派生索引；明确匹配/覆盖；有界并发或合并在途读；达到瓶颈再加语义检索 | 索引同步与撤权失效更复杂；不会自动修复个人写入协议 | 更新/撤权后不返回旧内容；真实对象量下延迟、HTTP数和覆盖满足目标 |

推荐先 A。只有产品明确要跨轮历史补录时再选择 B；C 以真实读取负载和覆盖评测为准，不把向量库当默认答案。实现前由用户选定范围，业务源码本轮保持不变。

## 开源证据与不可照搬的部分

详见 [独立研究](research.md)，固定 `NirDiamant/Agent_Memory_Techniques@4767c0341ccd8b714147334c5f17c26ff99d8e41`，实际读取 consolidation、reflection、cross-session、shared-memory、evaluation 五个 notebook。它是技术教程集合，不能等同生产标准。

- shared-memory 的只读 Blackboard 支持共享事实与私人思考分离。
- consolidation 提示记忆需要查重、更新、冲突治理，但示例合并会丢父证据，inferred/tool 固定优先级不适用于 World 权威。
- cross-session 示例按 user_id 存单一状态并覆盖 facts，不适合直接承载同一人的多个并行对象会话。
- reflection 将评价和模型归因继续存入记忆，评价错会放大错误经验，不应自动进入 Company。
- evaluation 支持把检索、忠实性、时效和冲突分别测量；仍需补任务成功、越权、错误写入和遗忘后复活的产品验收。

最终验收应沿“源存在 → 候选 → 校验 → 提交 → 选中 → 发给模型 → 回答采用”逐段定位首次断点，固定代码、模型、数据和权限后比较。
