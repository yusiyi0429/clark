# Ticket 24 · Prompt 治理 + 人类中文表述

状态: planned（在 Ticket 23 完成后执行，基于拆分后的文件布局）
来源: assessment-2026-09-22.md 维度 3；用户要求参考 human-writing skill 优化输出文风，
特别强调禁止"不是……而是……"。

## 原则

1. **规则单一来源**：数量/枚举类硬规则（leader_lens 3–5 条、entries 七类各几条、
   decisionQuestion ≤25 字等）定义为常量（contracts 或校验模块），校验器用常量校验，
   prompt 模板用字符串插值引用同一常量。改一处，prompt 与校验自动同步。
2. **prompt 只留意图**：把校验器已兜底的机械约束从 prompt 手写句改为插值；
   意图性表述（"站在一号位视角追问""不冒充 CEO"）保留。
3. **共享风格片段**：新建 `promptStyle.ts` 导出中文风格约束段，5 个 Agent prompt +
   对话运行时统一拼接，不再各自复制。

## W1 抽 makeMemoryTools()

`memoryTools.ts` 导出 `makeMemoryTools(call)` 返回 list_sections/search_sections/
get_passages 三个 defineTool；radarAgent、preflightAgent（Ticket 23 后在 meetingPreflight
相关文件）、piConversationRuntime 三处替换。mcpCompanyMemory 的 MCP server 工具描述不动。

## W2 硬规则常量化

盘点五个 prompt 与校验器重复的规则，逐条改为常量插值：
- leader_lens / meeting_question 条数（校验在原 meetings.ts L908 一带，Ticket 23 后位置以
  实际为准）
- preflight entries 七类与各自条数下限
- Radar decisionQuestion maxLength=25（contracts 已有，prompt 插值引用）
- 禁字样清单（"视角预判""非权威发言"、英文 slug 例子）收敛为共享常量，校验与 prompt 同源。
服务端校验一条都不能删。

## W3 人类中文风格片段（参考 ~/.agents/skills/human-writing/SKILL.md）

`promptStyle.ts` 的风格段内容（适配业务文档语境，非全文照搬）：
- 自然中文，判断从正面直接下：先给判断，再给依据。
- **严禁翻案句**（重点）："不是……而是……"、"并非……而是……"、"不在于……而在于……"、
  "与其说……不如说……"、"表面……实际……"、"看似……实则……"、"你以为……其实……"、
  "说到底"、"A 不重要，重要的是 B"，以及同一动作的任何字面变体。
- 不用洞察路标："值得注意的是""需要指出的是""更微妙的是""说白了""先说结论"。
- 不把动词名词化（"完成了对流程的优化"→"把流程改顺了"）。
- 同构排比最多两项。
- 散文文本（summary、回复正文、entries）不用破折号，提示性冒号只留引出原话；
  字段名、URL、列表结构不受限。
- 不用商业黑话与模型腔抬价。
应用到：researchAgent、preflightAgent、radarAgent（summary/strategicImpact 用户可见）、
postMeetingAgent、monthlyDraftAgent、piConversationRuntime。

## W4 翻案句服务端校验

在候选校验中加共享 `findForbiddenPhrase(text)`（正则覆盖核心变体：
不是…而是 / 并非…而是 / 不在于…而在于 / 与其说…不如说），命中即走既有 invalid-candidate
拒绝路径。适用字段：ResearchDoc summary/options.consequences/unknowns、
preflight entries body/brief/summary。对话流式回复不做拒绝（无重试路径），仅靠 prompt 约束。

## W5 验证

- 单测：常量插值后 prompt 包含正确数字；findForbiddenPhrase 正反例。
- 全量：typecheck ×3、API 307+（测试库 localhost:54329）、web、contracts。
- staging：重建 api；重跑 TKOS Issue（5757b4da…）预研，断言新报告无"CompanyMemory"
  字样、无翻案句、内容仍可读（该重跑同时清除评估发现的存量瑕疵）。
- 每 W 一个 commit。

## 边界

- prompt 语义边界（不可信输入声明、只读约束、submit_candidate 收口）逐字保留。
- 不改契约 schema（maxLength 等已有值只引用不改）。
- 不动 apps/web。
