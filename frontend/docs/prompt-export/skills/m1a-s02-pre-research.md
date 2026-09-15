---
name: m1a-s02-pre-research
description: 对每一个 S01 已完成正确 framing 的 Potential Issue 执行 Mandatory Pre-research；以最低认知成本帮助 CEO 看懂议题、判断为什么值得或不值得继续投入认知，并在形成 Judgment 之前停止。
version: v0.5.1
date: 2026-08-19
owner: Method Domain
status: Calibration Draft
---

# M1-A｜S02 Pre-research Skill v0.5.1

## 0. Positioning｜S02 要论证“为什么这个问题值得搞清楚”，而不是提前论证某个答案

统一自动认知链：

`Signal → S01 Issue Framing → Valid Potential Issue → S02 Pre-research（Mandatory）→ CEO Confirmation → Strategic Issue / 新一轮 Deep Research → S03 Strategic Deep Research → Research Result`

S01 负责把问题问对；S02 接受当前 **Valid Potential Issue**，完成两个并列任务：

1. **Understand the Issue**：让 CEO 比 S01 多理解一层现实——这件事实际是什么、关键 Evidence 在说明什么、真正触及公司的哪个判断；
2. **Make the Case for the Question**：讲清为什么这个**未知**值得被进一步搞清楚，如果不搞清可能误判什么；**不负责证明某个答案已经更可能正确。**

> **核心原则：Make the Case for the Question, not for an Answer。**
> S02 的说服力来自“这个问题值得被搞清楚”，不是来自“Agent 已经基本找到了答案”。

`Minimum Sufficient Understanding` 仍是研究边界：信息量只做到足以支持 CEO 配置下一轮认知资源。S02 不是 mini Deep Research，也不是 Judgment。

S02 对每个有效 Potential Issue 都必须运行，但**不是每个 Issue 都必须生成完整 CEO-facing Card**。v0.5.1 延续 v0.5 的两阶段执行：

1. **Phase A｜Status Decision**：只判断 `Valid / Invalid / Reframing Needed`，不生成任何正常 Pre-research 正文；
2. **Phase B｜Content Generation + Final Compression**：只有 `Valid` 才进入内容生成，并在输出前完成 CEO-facing 压缩。

> **Branch Lock：一旦 Phase A 判为 Invalid / Reframing Needed，本轮 S02 立即结束。不得用新想象的未来情景、潜在客户、长期趋势或新 research question 把当前 Issue “救回 Valid”。**

---

## 1. Purpose｜解决什么业务问题

Potential Issue framing 正确，不等于 CEO 已有足够理解去决定是否投入更深认知。S02 要同时减少三类错误：

* **理解不足**：只看到标题或 concern，不知道现实到底是什么；
* **重要性不清**：有事实，但不知道为什么值得现在占用 CEO / Deep Research 资源；
* **过早下结论**：为了 Make the Case，把有限 Evidence 写成规律、把 plausible explanation 写成当前答案，提前进入 Judgment。

高质量 S02 应让 CEO 快速得到：

> **这件事现在可以确定到哪里；为什么仍有一个值得搞清楚的关键未知；不同答案会改变什么重要判断。**

成功不以搜索数量、信息增量、字段完整度或篇幅衡量，而以：

1. 是否显著降低 CEO 对“要不要继续投入认知”的判断难度；
2. 是否在证据不支持时敢于停止；
3. 是否在形成 Strategic Issue 的答案、方案或 Judgment 之前停止；
4. 是否以 CEO 可以直接消费的方式表达，而不是让 CEO 再做一轮 synthesis / editing。

---

## 2. Applicable Situation｜何时适用

### Mandatory

只要 S01 已形成一个 **Valid Potential Issue**，S02 必须运行。

Issue history 只影响读取重点，不形成新的正式 Mode：

* **New**：建立议题本身的最低充分理解，并判断是否值得第一次 CEO Confirmation；
* **Existing**：继承 Issue identity、Current Research / Judgment 与本轮 New Evidence，重点说明**新 Evidence 改变了什么，以及为什么值得或不值得再次占用 CEO 认知资源**；
* Existing Issue 若刚在 S01 完成 Reframing，仍然只是 **Existing**。Current Statement 是唯一当前问题，Previous Statement 只在理解变化需要时作为历史 Context。

### Not Applicable

* S01 已判断 **No Issue**；
* 已完成 CEO Confirmation，目标是系统回答 Strategic Issue：进入 S03；
* 只是摘要 / 信息整理，没有 CEO Confirmation 目的；
* 需要完整市场扫描、系统案例比较、专项访谈、因果验证：属于 S03 或独立 Research Task；
* 对象创建、升级、Routing、通知、权限、Context Retrieval 或系统 Trigger：属于 Products&Applications / Engine&Ontology。

---

## 3. Required Context｜最低需要什么 Context

### Must-have

1. **Current Potential Issue Statement**：S01 当前认为已经问对的核心问题；S02 默认继承，不静默重写；
2. **S01 CEO-ready Issue Framing Content**：Sharp Title / What Happened / Implication / Source；
3. **Issue History**：New | Existing；
4. **Issue-origin Evidence**：原始 Signal / CEO Insight / Internal Evidence；
5. **Relevant Company Context**：直接相关的 Strategy、Outcome、assumption / choice、当前经营现实；
6. **Readily Available Evidence**：无需启动专项研究即可取得、且可能显著改变议题理解或 CEO Confirmation 的信息。

### Existing Issue｜额外读取

* Issue ID 与 Current Statement；
* 当前有效 Research Result / Judgment（如有）；
* 本轮 New Evidence；
* Previous Statement / Reframing reason（仅在本轮发生 Reframing 且有助于理解时）；
* Close rationale / Re-open Trigger（如适用）。

### Context 不足时

* 缺少原始 Evidence：不把二手表述写成 Fact；
* 缺少 Company Context：不以行业热度替代 company relevance；
* Evidence 很弱：可以使用低确定性表达，但不能制造确定性；
* 没有 material unknown：不要为了模板完整强造“还需要研究什么”；这通常意味着 `Invalid` 或当前无需更深研究。

---

## 4. Cognitive Task｜真正要想清楚什么

### 4.1 Issue Continuity Check｜不静默改题

S02 的起点是 S01 当前有效的 Potential Issue。S02 不重新做一遍 Issue Framing，也不为了写出更聪明的报告偷偷改题。

只有当 **S02 新获取 / 整理的 Evidence** 明确表明 Current Statement 已不能描述真实 tension 时，才返回 `Reframing Needed`。

如果只是标题写得不够 sharp，但问题本身没有变化，可做**纯表达层压缩**；一旦需要改变问题含义、分类轴或核心未知，必须返回 S01。

### 4.2 Evidence Scan｜先找能改变结论的证据，不先写正文

优先顺序：

1. **Start local**：原始 Signal / Case / CEO Insight / Internal Evidence；
2. **Company Context**：直接相关的 Strategy / Outcome / Judgment；
3. **Discriminating Evidence**：能够区分两个关键解释；
4. **Quick Reality Check**：确认现象是否真实、范围如何、是否孤例；
5. **Cheap Falsification**：是否存在低成本 Evidence 会显著削弱当前 concern。

S02 不要求产生 new evidence。Evidence 是否“新”不是质量标准；它是否改变 CEO 对 Issue 的理解和资源配置才是。

### 4.3 Phase A｜Status Decision：先决定“要不要继续”，再决定“写什么”

**这是 v0.5 已验证有效的流程性硬改，v0.5.1 保持不变。** Status Decision 与内容生成必须在执行上分离。

Phase A 内部只能完成三件事：

1. `Issue Continuity`：Current Statement 是否仍描述真实 tension；
2. `Cheap Falsification`：低成本 Evidence 是否已经显著削弱当前 concern；
3. `Material Unknown`：在**当前 Issue 的时间边界和问题边界内**，是否仍有真实、重要、未解决、答案会改变判断的未知。

在 Phase A 完成前，**禁止草拟 Sharp Title、核心观点、Mainbody、Decisive Unknown 或任何正常 Pre-research Card。**

#### Phase A 只允许三个结果

##### Reframing Needed

若 Evidence 表明 Current Potential Issue Statement 已不能准确描述真实 tension：

→ 立即停止当前 S02；
→ 内部返回 S01；
→ 不生成 CEO-facing Pre-research；
→ S01 Reframe 后重新运行 S02。

##### Invalid

若最低必要 Evidence 已说明：

* 原 concern 当前并不构成 material Issue；或
* concern 已被低成本 Evidence 显著削弱，当前没有一个尚未解决且值得占用 CEO / S03 资源的关键未知；

→ **Branch Lock：本轮直接 Stop。**

执行规则：

* 不进入 Phase B；
* 不生成 Sharp Title / 核心观点 / Mainbody / “还需要搞清楚什么”；
* 不得因为“样本还少”自动继续研究；
* 不得把现在时问题改成“未来会不会……”来维持 Valid；
* 不得创造潜在客户、长期 ROI、价格弹性、市场趋势等 hypothetical unknown。

> **Current Issue only：S02 只判断当前 Potential Issue 是否值得继续。未来可能出现的新风险，如果未来真实 Evidence 出现，应作为新 Signal 回到 S01；不能在本轮 S02 中作为救回 Invalid 的理由。**

External / Internal：后台 Stop；
CEO Insight：给最小反馈；
Existing Issue：只表示“本轮 trigger / New Evidence 不值得重新提交 CEO”，不自动否定已有 Strategic Issue / Judgment。

##### Valid

只有当 Phase A 后仍存在一个：

* 真实；
* 对词元云集 material；
* 尚未解决；
* 不同答案会改变重要判断；

的问题，才允许进入 Phase B。

### 4.4 Understand the Issue｜比 S01 多一层现实理解

Valid 后，用最低必要 Evidence 让 CEO 看懂：

* 这件事实际发生了什么；
* 哪些现实特征决定我们不能只停留在 S01 的一句问题描述；
* 对词元云集而言，真正被触及的是哪个 assumption、choice、客户进入逻辑、产品化逻辑、Outcome、资源配置或经营机制。

不是补完整背景，而是补齐**会改变理解的现实轮廓**。

### 4.5 Make the Case for the Question｜论证未知值得研究，不论证答案

必须回答：

* **为什么这个未知值得继续搞清楚？**
* **如果现在误判，会改变什么重要选择、资源投入或经营理解？**
* **为什么当前 Evidence 还不足以直接回答？**

禁止把 Make the Case 写成：

* “为什么我的解释更可能正确”；
* “为什么现有 Working Judgment 应该被保留”；
* “为什么某个解决方案应该推进”。

如果正文读起来像一份初步 Judgment，而不是对“问题值得被研究”的论证，S02 已经越界。

### 4.6 Claim Strength Calibration｜表达强度不能超过 Evidence

每个关键句必须先判断自己属于哪一层：

|层级|定义|推荐表达|
|-|-|-|
|Fact|输入中直接观察、记录或明确确认|“3 个项目均未重新议价”|
|Interpretation|由 Fact 支撑的当前含义|“这说明短期客户行为尚未出现变化”|
|Hypothesis|值得后续验证、但当前证据不足的解释|“一种可能是需求在项目运行后才显现”|

**有限样本不得直接升级为普遍规律。** 2–6 个观察通常使用：

* “在当前样本中…”
* “初步提示…”
* “开始出现…”
* “现有 Evidence 尚不能区分…”

以下词语会显著提高 claim strength，使用前必须确认 Evidence 足够：

`证明 / 证伪 / 真正的分界线 / 本质就是 / 唯一 / 必然 / 已经定义 / 上限 / 结构性 / 全部`

如果有两个仍可成立的解释，必须保持 competing explanations 开放，不能为了 sharpness 强行二选一。

### 4.7 Mainbody｜2–3 个 What + So What，先事实再含义

S02 默认形成 2–3 个连续认知单元。每个单元必须同时完成：

`关键 Evidence / Reality → 这意味着什么 → 对 Issue / Company 判断有什么后果`

要求：

* 判断式短标题先给本段 takeaway；
* 每条原则上 1–2 句；
* Fact 与 Interpretation 可以连续表达，但不能混成一个未经标识的“事实”；
* 每条只讲一个判断；
* 只保留真正增加 understanding 或支撑“为什么值得研究”的信息。

### 4.8 Decisive Unknown｜区分不同战略世界，不提前 solutioning

“还需要搞清楚什么”默认只保留 **1 个 decisive unknown**。

它应回答：

> **哪一个未知的不同答案，会改变我们对 Issue 的理解或后续战略判断？**

好的 unknown 通常区分两个仍可能成立的现实解释，例如：

* “当前拒绝意味着没有该类需求，还是需求尚未在当前阶段显现？”
* “持续付费主要取决于公司可复制地创造使用结果，还是主要取决于客户自身组织条件？”

以下不合格：

* “应该如何设计首轮交付？”
* “下一步产品怎么做？”
* “需要采取哪些措施？”
* 把完整 S03 research scope 列成多个问题；
* 为了字段完整制造“未来继续观察什么”。

**Anti-solutioning test：**回答这个 Unknown，是改变我们“怎么看这个 Issue”，还是只是告诉我们“怎么做”？如果主要是后者，已经太下游。

不要强行制造 exhaustive binary。A / B 只是帮助说明不同答案的管理含义，不代表现实只有两个可能。

### 4.9 Stop Rule｜足以支持资源配置就停

当以下条件满足，停止 S02：

1. **Comprehension sufficient**：CEO 已能理解 Issue 的现实含义；
2. **Case sufficient**：为什么值得 / 不值得继续研究已经清楚；
3. **Uncertainty bounded**：只剩一个真正 decisive unknown；
4. **Cheap reversal checked**：没有明显低成本反证尚未检查；
5. **Next evidence becomes S03-like**：剩余问题需要专项访谈、大规模数据、完整 competitor / market scan、多案例系统比较或因果验证。

边际认知价值从“帮助 CEO Confirmation”转为“回答 Strategic Issue”时，立即停止。

### 4.10 Phase B Final Compression｜分析完成后必须再做一次“只删不扩”

只有 `Valid` 才进入 Phase B。完成内部认知合成后，不直接输出；先执行一次 **Final Compression Pass**。

Final Compression 不是重新研究，也不能加入新判断。它只做四件事：

1. **删重复**：同一 Evidence / implication 只保留一次；
2. **降表达成本**：长复句拆短，抽象词改成具体经营语言；
3. **清理内部语言**：删除内部 ID、对象状态、检索状态、Prompt / Skill / GraphKnowledge 等后台元信息；
4. **校准强度**：压缩不能把 hypothesis 写得比内部分析更确定。

#### Claim Preservation Lock｜压缩可以变短，但不能变得更确定

Round 4 显示，内部分析已经保持 competing explanations 开放，但压缩后的核心观点仍可能把其中一个解释写成“直接决定 / 失去支撑”等结论。v0.5.1 因此增加一条 presentation-layer 硬约束：

> **Compression may remove words, but must not increase certainty.**
> **压缩可以删信息，但不得提高判断确定性。**

执行规则：

* 如果某个解释仍出现在 `Decisive Unknown` 中，它就**不能**在核心观点或 Mainbody 中被写成已成立的因果结论；
* 压缩前是 hypothesis / competing explanation，压缩后仍必须保持同等强度；
* 以下词在 Final Compression 后必须二次检查：`直接决定 / 必然 / 就会 / 失去支撑 / 已经定义 / 唯一 / 核心变量就是 / 必须`；
* 若 Evidence 只支持“尚未验证”，就写“尚未验证 / 仍缺证据”，不要为了 sharpness 写成“模式不成立 / 商业逻辑失去支撑”；
* 若删除 Evidence boundary 会让一句话看起来更确定，必须保留最短必要边界。

**Consistency Check：**最终输出中的核心观点、Mainbody 与 Decisive Unknown 必须处在同一 claim strength 上。若下文仍问“是 A 还是 B”，上文不得已经把 A 写成结论。

#### 默认信息预算

* Sharp Title：1 行；
* 核心观点：默认 2 句，最多 3 句；
* Mainbody：默认 2 个判断，只有第三个判断会明显改变 CEO 理解时才保留第 3 条；
* 每条 Mainbody：判断式短标题 + 1–2 句；
* “还需要搞清楚什么”：1 个 unknown，原则上 1–2 句；
* Source：只保留最小、可识别、可追溯的来源名称。

> **Minimum Sufficient 的最后一道 Gate：不是“还能补什么”，而是“还能删什么而不损失 CEO 判断”。**

---

## 5. Output Contract｜CEO-facing Pre-research Result

### 5.1 Valid｜默认输出结构

```text
Sharp Title：<原则上继承 S01；可做不改变 Issue identity 的表达压缩>

核心观点：<2–3 句。先说当前 Evidence 让我们知道到哪里，再说为什么仍值得继续搞清楚 / 误判会影响什么。>

发生了什么 / 这意味着什么：
- **<判断式短标题>** <关键事实>。<基于事实的含义。>
- **<判断式短标题>** <关键事实>。<基于事实的含义。>
[默认 2–3 条]

还需要搞清楚什么：<一个 decisive unknown；说明不同答案会改变什么判断，不写 solution plan>

Source：<最小、可追溯来源>
```

#### Sharp Title

* 优先短问句；原则上一行内让 CEO 看懂真正要判断什么；
* 默认继承 S01 的 Issue identity；
* 允许删掉冗余限定词、中文化非必要英文、压缩表达；
* **如果需要改变问题含义才能写 sharp，返回 S01，而不是 S02 自行改题。**

#### 核心观点

* 2–3 句，不写成长复句；
* 第一句优先说明“现在知道到哪里”；
* 第二句说明“为什么仍值得 / 不值得继续投入认知”；
* 可以有边界，但不把所有 caveat 塞进同一句；
* 不用“本质上 / 真正 / 唯一”等强词代替证据。

#### 发生了什么 / 这意味着什么

* 默认 2–3 条，每条 1–2 句；
* 判断式小标题本身应提供 insight；
* 同一个意思只出现一次；
* 删除不改变 CEO 判断的信息。

#### 还需要搞清楚什么

* 默认 1 个；
* 是“认知未知”，不是“方案问题”；
* 不同答案的 implication 可以说明，但不提前给 recommendation；
* 如果没有这样的未知，重新检查是否应为 `Invalid`。

#### Source

* 极简、可追溯；
* Source 只写人可以识别的最小来源，例如“内部 M2 运行记录；客户 A/B 沟通记录”；
* 内部 Issue ID、对象状态、研究代码、GraphKnowledge / 检索命中状态等**不进入 CEO-facing Source**，如系统需要追溯，单独写入后台 Trace。

### 5.2 Invalid｜Stop 要真的短

#### External / Internal

```text
Invalid
Reason：<1–2 句，说明为什么当前不值得进入 CEO Confirmation>
Decisive Evidence：<最关键 1–3 条>
```

内部使用，默认不展示给 CEO。

#### CEO Insight

```text
当前判断：暂不继续研究这一 Issue。
为什么：<1–2 句，直接说明什么 Evidence 已显著削弱原 concern；同时说明这是“当前”判断，不外推永久结论。>
Source：<极简>
```

不得生成完整 Pre-research Card；不得另造长期 unknown。

### 5.3 Reframing Needed｜只做 Internal Return

```text
Reframing Needed
Reason：<1–2 句，说明为什么当前 Statement 已不能描述真实 tension>
Key Evidence：<最关键 1–3 条>
```

不生成新问题，不生成 CEO-facing Pre-research。

---

## 6. CEO-ready Writing Gate｜分析正确但写不到位，同样不通过

S02 的输出对象是 CEO。写作不是 post-polish，而是认知质量的一部分。

### 6.1 中文优先

CEO-facing 正文默认中文。仅保留必要且稳定的术语，例如：`CEO / AI / Agent / TKOS / TokenOps / API / Products&Applications`。

以下词若可以自然中文化，默认不直接暴露：

`material / top-down / Working Judgment / readily available evidence / Context / Current Read / decisive unknown / make the case / Domain / Mission / Evidence`

其中 `Domain / Mission / Evidence` 若正在讨论 Method 对象本身可以保留；若只是描述业务事实，优先写“责任域 / 经营任务 / 证据”等自然中文。

内部 Method 文档可以使用 Glossary；CEO-facing 正文不靠中英夹杂制造专业感。

### 6.2 信息压缩

* Sharp Title：短、直接、可一眼理解；
* 核心观点：默认 2 句，最多 3 句；
* Mainbody：默认 2 条，最多 3 条；每条 1–2 句；
* 一个段落只表达一个判断；
* 不把 3–4 层逻辑塞进一个长句；
* 能删掉而不影响 CEO 判断的内容，删除或放 Source。

内部删除测试：

> **删掉这句话，会不会明显影响 CEO 对“这件事是什么、为什么值得 / 不值得继续、还不知道什么”的判断？**

如果不会，删掉。

### 6.3 不泄露后台工作语言

以下默认不得出现在 CEO-facing Mainbody：

* 内部对象 ID / 研究编号 / Issue lifecycle 状态；
* GraphKnowledge / Knowledge Base / 检索命中与否等工具状态；
* “按 S02 规则…”等流程自述；
* 对 Prompt / Agent / 检索过程的解释；
* 无必要的 Domain / Method 英文缩写堆叠。

### 6.4 CEO-ready 谨慎

“谨慎”不是把所有可能性都保留在正文，而是：

> **在清楚 Evidence boundary 后，仍给出当前最有用的判断。**

不要用“可能、也许、还需持续观察”回避 Status Gate；也不要为了 sharpness 把假设写成事实。

### 6.5 Final Writing Check

提交前逐项检查：

1. CEO 只看 Title + 核心观点，能否知道为什么值得 / 不值得继续？
2. 是否存在可删掉的长句、重复解释或抽象词？
3. 是否有不必要的中英夹杂？
4. 是否使用了超过 Evidence 强度的强词？
5. **核心观点 / Mainbody 是否把仍在 Decisive Unknown 中的某个解释提前写成结论？**
6. **压缩后是否新增了“直接决定 / 失去支撑 / 必然 / 唯一”等原分析并未成立的强因果？**
7. 是否有内部 ID / 工具状态 / 方法自述泄露到正文？
8. 是否已经开始给 solution / recommendation？

任何一项明显失败，先修改表达，再输出。

---

## 7. Quality Standard & Guardrails｜什么叫高质量

### A. Analytical Quality

1. **Issue is understood**：CEO 比 S01 多理解一层现实；
2. **Question case is explicit**：说清为什么“这个未知”值得继续搞清楚，而不是论证某个答案；
3. **Status is correct**：Invalid / Reframing 能在正文前 Stop；
4. **Evidence strength is calibrated**：Fact / Interpretation / Hypothesis 不混淆，claim strength 与 Evidence 匹配；
5. **Claim survives compression**：Final Compression 不提升确定性，开放解释在最终成品中仍保持开放；
6. **What–So What continuity**：Evidence 被立即翻译成对 Issue / Company 的含义；
7. **Company-specific**：明确触及词元云集哪个 assumption / choice / operating logic；
8. **Competing explanations stay open**：证据不足时不强行锁定解释；
9. **Decisive unknown only**：只留改变判断的未知，不 solutioning；
10. **Stop at Pre-research**：明显比 S01 深，但没有开始系统回答 Strategic Issue。

### B. CEO Communication Quality

1. **Conclusion first**：Title / 核心观点先告诉 CEO 当前最重要的判断；
2. **Sharp and concise**：短句、少重复、每段一件事；
3. **Information budget respected**：默认 2 个 Mainbody 判断，不因为“分析到了”就全部写出来；
4. **No analytical overstatement hidden by wording**：强词与 Evidence 匹配；
5. **Low synthesis burden**：CEO 不需要自己从多段 Fact 拼结论；
6. **Stop is also communication**：Invalid 时最好的 CEO-ready 输出可能只有三句话，而不是一张完整 Card。

### C. Language Discipline

1. **Chinese-first**：除必要且稳定术语外，正文优先中文；
2. **Natural business language**：能说“跨责任域取舍”时，不为了方法感写“跨 Domain Decision Context”；
3. **No meta leakage**：内部 ID、对象状态、GraphKnowledge / 检索状态、Prompt / Skill 自述不进入 CEO-facing 输出，包括 Source；
4. **Stable terminology only**：CEO / AI / Agent / TKOS / TokenOps / API / Products&Applications 等必要术语可保留；
5. **No mixed-language decoration**：英文只用于精确术语，不用于强调、修辞或制造专业感。

### Failure Modes

1. **Mechanical Field Filling**：为了字段完整机械填表；
2. **Bland Core View**：只是摘要，没有说明为什么值得 / 不值得继续；
3. **News / Data Summary**：堆 Evidence，CEO 自己 synthesis；
4. **What without So What**：事实清楚，但含义不清；
5. **Generic Importance**：只说“值得关注 / 具有战略意义”；
6. **Answer Advocacy**：Make the Case 变成论证某个答案更正确；
7. **Claim-strength Overreach**：有限样本写成规律，或使用“证明 / 真正 / 唯一”等过强表达；
8. **False Binary**：把两个示例性解释写成现实只有 A / B 两种可能；
9. **Forced Unknown**：Issue 已被反证，却强造未来未知；
10. **Solutioning Unknown**：“还需要搞清楚什么”变成“下一步怎么设计 / 怎么做”；
11. **Mini Deep Research**：完整 market / competitor / issue tree / case universe；
12. **Premature Judgment**：CEO Confirmation 前形成事实上的 Judgment / recommendation；
13. **Fact–Interpretation Blur**：推测写成 Fact；
14. **Confirmation Bias**：为了“说服 CEO”忽略反证；
15. **Status Gate Bypass**：先写完整 Card，再决定 Invalid；
16. **Invalid Rescue**：原 Issue 已 Invalid，却用未来情景 / 新假设把它重新拉回 Valid；
17. **Silent Reframing**：发现题错却自己改题继续；
18. **Existing Issue Amnesia**：忽略当前 Judgment / history；
19. **Issue State Confusion**：Existing 的本轮 Invalid 被误写成旧 Issue 失效；
20. **Executive Writing Failure**：长复句、重复、抽象词堆叠，正确分析无法被 CEO 快速消费；
21. **Mixed-language / Meta Leakage**：不必要的中英夹杂、内部 ID 或工具状态进入 CEO 正文；
22. **Compression Strength Inflation**：内部分析保持开放，但最终压缩把某个 hypothesis 写成“直接决定 / 失去支撑 / 唯一”等更强结论；
23. **No Stop Rule**：有资料就继续搜。

### Human / System Boundary

S02 定义：

* 什么样的 Pre-research 内容足以让 CEO 理解议题并配置下一轮认知资源；
* 什么情况下应返回 Invalid / Reframing Needed；
* 什么叫 CEO-ready 的最终内容质量。

Products&Applications / Agent 负责自动运行、Routing、rerun、对象状态与最终组合呈现。S02 不替 CEO 完成 CEO Confirmation，也不改变 M1-A 的正式对象体系。
