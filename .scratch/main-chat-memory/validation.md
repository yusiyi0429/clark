# 外部研究、源码证据与离线预验证

日期：2026-10-15
范围：开发方案的技术可行性，不是生产发布验收。

实施后的机制验收与实际检查记录见 [Ticket07 集成报告](reviews/07-integration.md) 和 [30条覆盖矩阵](acceptance-matrix.md)。下文保留实施前的研究/原型证据，不作为当前生产实现已通过真实模型或 World 验收的声明。

## 研究依据与适用边界

1. [Anthropic：Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) 将上下文视为有限资源，讨论按需展开、压缩和外部记忆。这里据此选择“简短 Anchor 目录 + 按需正文”，不是全量复制业务库。文章不证明本项目的具体 token 配额或文件结构最优。
2. [Lost in the Middle](https://arxiv.org/abs/2307.03172) 在其测试任务和模型上观察到相关信息位置影响表现。因此本方案把当前 Query/Anchor 放在最新用户消息，并控制参考量；不能据此承诺新模型一定遵守 Anchor 优先级。
3. [LongMemEval](https://arxiv.org/abs/2410.10813) 区分信息提取、多会话推理、时间推理、知识更新和拒答，并将记忆流程拆成索引、检索和阅读。因此评测须覆盖更新/遗忘和不知道，而非只看摘要或召回数量。

这些是设计依据，不是对当前模型业务质量的实测。研究正文中的引用与内部版本信息不应复制进 Company/Personal 模型视图。

## 项目源码确认

- `piConversationRuntime.ts` 当前每轮 `session.prompt(JSON.stringify({currentObject,references,globalContext,message}))`，使快照进入 Pi 历史；新方案应只持久化用户 Query，临时组装其余内容。
- `app.ts` 与 `conversationContext.ts` 当前从本地库装配公司摘要和 Mission；应分别迁移为页面 Anchor 和 World 事实 Reference，而不是笼统删除本地页面上下文。
- `routes/cards.ts:/api/cards/home` 和成员投影提供首页 Card；Anchor 必须复用授权后的读取服务。
- SDK 版本：`@earendil-works/pi-coding-agent` / `pi-ai` 0.85.1；运行环境 Node 24.19.0（本次测试环境，并非所有部署容器版本）。
- SDK `agent-loop.js` 的 prepareNextTurn 只在已有 lastCompletedTurn 后调用；单独包装它会漏掉首次回答。
- SDK `extensions/runner.js:emitContext` 捕获 context handler 错误后继续，因此不能只依赖该 hook 执行必须成功的上下文检查。
- SDK `ModelRuntime.streamSimple` 是公开类型方法，实际会被 createAgentSession 的 provider streamFn 使用。这里用应用包装 + AsyncLocalStorage 验证临时注入，不新增生产工具/扩展资源。
- 主 System Prompt 经过 SDK 装配可能附带环境文字；不能仅比较自定义 prompt 原字符串就判断主调用。正式适配器应匹配已装配主 Prompt/受控阶段，且区分压缩请求。
- World 仓库 fixture 的对象有 business/identity/records，正文块可重复投影；当前 worldClient 类型只描述窄子集。真实新实例的完整接口与覆盖尚未验证。

## 可复现检查

从仓库根目录运行（先按仓库 lockfile 安装依赖）：

```sh
node --test .scratch/main-chat-memory/prevalidate.test.mjs
```

结果：10 项通过、0 失败。使用安装的真实 Pi SDK，模型流与工具结果受控，无数据库、无外部请求、无真实模型费用，不读取生产凭据。

| 检查 | 结果 | 证明范围 |
| --- | --- | --- |
| 有界 Anchor 与可见集合计数 | 通过 | 原型先权限过滤再取 12 项；不证明生产全部权限路径 |
| 最新用户消息注入、Reference 顺序、工具对配 | 通过 | 副本组装不改变输入；不是模型遵循性测试 |
| Pi 首次调用 | 通过 | provider 看见 Anchor/Query，持久 entries 只保留原话 |
| JSON 保存恢复与换 Anchor | 通过 | 旧临时 Anchor/Personal 不随 entries 重复加载 |
| 真实 Pi tool loop | 通过 | 后续请求只有一个当前 Anchor，toolCall/toolResult 保持 |
| 两人并发共享 ModelRuntime | 通过 | AsyncLocalStorage 下测试输入不串人；不是生产鉴权验收 |
| 无 TurnContext 阻止发送 | 通过 | 包装层缺失上下文时没有调用受控 provider |
| 手动压缩与再次注入 | 通过 | 压缩读取不到临时注入，下轮仍看到新 Anchor |
| World fixture 正文提取 | 通过 | 有意义正文/状态保留，无协议哈希或来源模板；不是完整适配器 |
| 回合内自动压缩 | 通过 | 当前 Anchor 在自动压缩后的主请求恢复，不进入 entries |

原型位于 `prototype.mjs` 和 `prevalidate.test.mjs`，未被 apps/api 或 apps/web 引入。原型没有实现真实授权、完整预算、World 分页更新、Personal 蒸馏或持久化；不直接复制成生产实现。

特别注意：助手正常回答可能复述 Reference，测试不意味着历史永远不包含相关内容。遗忘必须处理 Runtime、历史召回和缓存；正文无来源标签也不意味着后台可以不维护更新关系。

## 实施阶段必须补齐的测试

已提供 [30 条固定合成评测样例](evaluation-cases.json)：场景/focus 6、事实一致性与时效 6、权限隔离 6、Personal 更新遗忘 6、工具压缩与预算 6。defaults 与各 case.inputs 合并后作为测试输入。实现阶段应将它们接到实际 API/运行轨迹及模型评测中；目前只是验收数据集，尚未运行这 30 条真实模型评测。

机制门槛：未授权读取、跨人泄露、失效 handle 越权、记忆反向写 World、已遗忘属性复活、明显超预算请求必须为零。真实模型的指代解析、召回与蒸馏语义另行验收，不能由假模型响应证明。

对比至少三种输入策略：当前全量 JSON 基线、Anchor+有界 Reference、仅索引。记录任务正确性、应拒答时拒答、过时事实误用、输入用量与 p50/p95 时延；报告实际模型、测试集与样本数，不以单次示例宣称“科学最优”。

真实 World 需验证：授权身份、完整类型/域覆盖、分页、正文块、负责人显示名、关系引用、对象状态、更正/撤销、读取失败及中途变化。只读联调不足以证明产品写回闭环已完成。

本次没有运行真实 World 或真实模型语义评测，没有运行依赖 PostgreSQL 的新增集成测试，没有删除 MCP、迁移数据或发布。后续上线必须依照实施工单补齐这些检查。
