---
name: m1a-s01-issue-framing
description: 从 External Signal / Internal Operating Signal / CEO Insight 中识别真实、重要、decision-relevant 的 underlying issue；在交给 S02 前完成 issue history 匹配、正确 framing 与质量校验，输出当前有效的 Potential Issue。
version: v0.4
date: 2026-08-18
owner: Method Domain
status: Calibration Draft
---

# M1-A｜S01 Issue Framing Skill v0.4

## 0. Positioning｜S01 负责“有没有真实问题，以及这个问题有没有问对”

统一自动认知链：

`Signal → S01 Issue Framing → Valid Potential Issue → S02 Pre-research（Mandatory）→ CEO Confirmation → Strategic Issue / 新一轮 Deep Research → S03 Strategic Deep Research → Research Result`

**S01 与 S02 默认在 CEO Confirmation 前自动连续发生。** S01 形成的内容必须达到 CEO-ready 表达质量，但有效 Issue 在正常产品链路中不要求 S01 单独、立即呈现给 CEO；系统应先完成 Mandatory S02，再把最终有效 Issue 与 Pre-research 一起交给 CEO Confirmation。

S01 解决两个连续问题：

1. **有没有真实 Issue？** Signal 背后是否存在真实、material、decision-relevant 的 tension / uncertainty；
2. **这个 Issue 有没有问对？** 当前 Potential Issue 是否准确抓住真正的对象、tension、分类轴 / causal assumption 与决策层级。

S01 不是 Signal 摘要器，也不负责 Pre-research / Deep Research。它的终点只有两种：

- **No Issue**：不进入 S02；
- **Valid Potential Issue**：当前认为已经问对，进入 S02。

Issue history 只保留 **New / Existing** 两种属性。`New Evidence` 是本轮输入 Context，`Reframing` 是 S01 的处理动作，不新增并列 Issue 类型。

---

## 1. Purpose｜解决什么业务问题

战略认知最昂贵的浪费，不只是研究了“不重要的问题”，还包括围绕一个**真实但问错的问题**继续投入资源。

S01 要降低三类错误：

- 把新闻声量、CEO 焦虑、一次执行异常、proposed solution 或 plausible explanation 包装成战略 Issue；
- 把真正挑战客户价值、商业模式、战略假设、Outcome、资源配置或 operating logic 的变化降格为普通信息；
- Real tension 已经存在，却用错误对象、错误分类轴、错误因果前提或错误层级来提问，使后续 S02 / S03 围绕错误 framing 投入认知资源。

S01 的成功标准不是“生成一个漂亮问题”，而是：**换一个未预制 Signal，Agent 能稳定找到 real tension，判断是否值得成为 Issue，并在交给 S02 前把问题问到当前 Evidence 支持的正确层级。**

---

## 2. Applicable Situation｜何时适用

### Applicable

当系统把以下任一输入交给 S01 时适用：

- **External Signal**：市场、竞争、技术、政策、供给、客户行为等外部变化；
- **Internal Operating Signal**：客户、Mission、产品、交付、经营数据或真实运行 Evidence；
- **CEO Insight**：会议、访谈或对话中的观察、顾虑、intuition、尚未结构化的问题；
- **Downstream Return**：S02 / S03 基于新增 Evidence 返回 `Reframing Needed`。

### Not Applicable

S01 不负责：

- Signal 如何持续监测、聚合、筛选和触发；
- Context Retrieval、Ontology Schema、权限和检索实现；
- Pre-research / Deep Research；
- 创建、关闭、重开或修改系统对象；
- Routing、Orchestration、通知、任务分发或产品交互；
- 替 CEO 完成 CEO Confirmation。

---

## 3. Required Context｜最低需要什么 Context

### Must-have

1. **Input Signal / Insight / Evidence**：原始输入及最低来源信息；
2. **Relevant Company Context**：与输入直接相关的 Strategy、Outcome、assumption、choice、历史 Judgment / Agreement 或当前经营现实；
3. **Issue History（如有）**：现有 Issue ID、当前 Potential / Strategic Issue Statement、Research Result、Judgment、Close rationale、Re-open Trigger 等；
4. **New Evidence（如有）**：使 Existing Issue 重新进入认知链的新增事实或观察；
5. **Return Evidence（如由 S02 / S03 返回）**：为什么现有 framing 已无法解释 real tension 的最关键 Evidence。

### Context 不足时

- 缺少原始 Evidence：不得把二手描述写成已确认 Fact；
- 缺少 Company Context：不得只凭“行业重要”升级为公司级 Issue；
- 只有 CEO intuition：可以识别其背后的 tension，但不能把 intuition 当 Fact；
- 无法说明答案不同会改变什么重要判断：不形成 CEO-level Issue；
- 无法确认是否 Existing：不要凭相似 Topic 猜历史关系；系统 / Ontology 应提供 Issue identity。

**Company Context 用于判断 relevance 与 consequence，不用于反向制造 underlying issue。**

---

## 4. Cognitive Task｜真正要想清楚什么

### 4.1 三类 Signal 使用不同 Lens

**External Signal**：外部世界发生了什么，使原来的战略地图可能不再准确？

重点看竞争边界、客户行为、技术 / 政策 / economics 约束、多个弱 Signal 是否开始指向结构性变化。

**Internal Operating Signal**：真实运行与原假设之间出现了什么 Gap？

重点看结果持续偏离、问题跨场景重复、规模化持续依赖异常人工、客户购买 / 使用偏离假设、未预期的复用 / 增长路径。

**CEO Insight**：CEO 有什么尚未结构化、但可能影响重要判断的认知？

重点看反复顾虑、明确“没想清楚”、既有假设动摇、重要目标之间的 tension，以及对现实 Evidence 的直觉性反应。

### 4.2 S01 固定认知顺序：Reality → Qualification → History → Framing → Quality

#### Step 1｜Understand Signal & Find Real Tension

内部逻辑：

`Signal → 去除表层 framing → real tension / challenged assumption → possible business consequence`

主动去除三类污染：

- **Symptom / Surface Behavior**：先问它真正挑战了什么价值假设、经营逻辑或约束；
- **Proposed Solution / Binary Choice**：移除“是否做 X”，回到决定该方案是否必要的更前置 tension；
- **Plausible Explanation / Working Hypothesis**：可以保留为待验证解释，但不能写成已成立前提。

#### Step 2｜Real Issue Qualification

在 framing 之前先判断 underlying tension 是否值得成为 Issue：

1. **Rooted in a Real Issue**：不是情绪、研究兴趣、单次 execution matter 或 solution；
2. **Material & Relevant**：答案不同可能改变当前重要经营判断；
3. **Decision-oriented**：理解清楚后能够支持管理层形成真实判断或选择。

任一关键条件不成立，输出 **No Issue**，不再为了“问得更漂亮”继续 framing。

#### Step 3｜Match Issue History：只区分 New / Existing

通过 Real Issue Qualification 后，判断是否存在同一 underlying issue：

- **New**：此前不存在同一 unresolved tension / decision object；
- **Existing**：underlying tension 与 CEO 最终需要判断的战略对象仍然相同。

`New Evidence` 不构成新的 Issue 类型；它只是 Existing Issue 本轮重新进入链路的原因。

判断 Reframe vs New Issue 的边界：

- **同一 underlying tension / decision object，只是对象、分类轴、因果前提或表述需要修正** → 保留 Existing identity，由 S01 Reframe；
- **新增 Evidence 暴露了另一个 underlying tension 或另一个管理层决策对象** → 形成 New Issue，不把所有相关问题硬塞进旧 Issue。

#### Step 4｜Form Candidate Potential Issue

- New Issue：基于 real tension 首次形成 Candidate Potential Issue；
- Existing Issue：先读取当前 Statement 与 New Evidence；若现有 framing 仍准确，原则上保留或做最小必要更新；若已不能描述 real tension，在 S01 内完成 Reframing 后再形成 Candidate。

**S01 → S02 的时点不存在“待 Reframe 的 Potential Issue”。** 交给 S02 的永远是 S01 当前认为已经问对的问题。

#### Step 5｜Valid Framing Check

Valid Framing Check 发生在 **Real Issue Qualification 之后、Final Quality Gate 之前**。它检查的是 semantic correctness，而不是文案质量：

- **Object**：真正需要判断的对象是否正确；
- **Framing axis / causal assumption**：分类轴或隐含因果前提是否被 Evidence 支持，还是把 plausible explanation 当题设；
- **Level**：问题是否落在真正会改变客户价值、商业模式、战略假设、核心 operating logic 或重大经营选择的层级；
- **Core uncertainty**：是否抓住一个最前置 unresolved tension，而不是多个下游问题；
- **Open question**：是否没有把答案 / solution 偷塞进问题。

若不通过，**S01 内部 Reframe 并重新检查，直到形成 Valid Framing 或发现其实 No Issue。**

#### Step 6｜Final Quality Gate

问题已经问对以后，再检查表达质量：

- **Specific & Well-scoped**：对象、tension 与本轮认知边界清楚；
- **Open to Evidence**：存在合理不同答案，Evidence 能强化、削弱或改变判断；
- **Claim Strength**：certainty / materiality / scope / mechanism 不超过 Evidence；
- **Title–Statement Consistency**：Sharp Title 与 Potential Issue Statement 回答同一个 underlying issue；
- **CEO Compression**：输出只保留能帮助后续理解和判断的信息。

这些检查不要求逐项展示，不输出内部评分或 chain-of-thought。

### 4.3 Reframing Ownership｜下游可以发现题错，只有 S01 改题

S01 是 S01–S03 中唯一拥有 Issue Framing / Reframing 内容责任的 Skill。

如果 S02 / S03 返回 `Reframing Needed`：

1. S01 读取 Return Evidence；
2. 回到 real tension，判断是同一 Existing Issue 的 framing 失效，还是出现新的 underlying issue；
3. 对 Existing Issue 完成必要 Reframing，或形成 New Issue；
4. 重新通过 Valid Framing Check 与 Final Quality Gate；
5. 更新后的有效 Potential Issue **必须再次进入 S02**，不能直接进入 S03。

`Reframing Needed` 是下游 Skill return condition，不是新的 M1-A 业务对象或状态。

### 4.4 Origin 决定 Visibility，不改变 S01 内容标准

- **External / Internal → No Issue**：后台 Stop，CEO 不看；
- **CEO Insight → No Issue**：不进入 S02，但必须给 CEO 一个简短、可解释的 feedback，说明为什么当前不形成 Issue；
- **CEO Insight 被 Reframe**：S01 形成一个最小 `Calibration Note`，说明原关注点为什么需要校准以及当前有效问题是什么；随后仍进入 S02。最终是否呈现、如何组合由 Agent / Products&Applications 负责；
- **External / Internal 被 Reframe**：后台完成，不向 CEO 展示返工过程；CEO 只看最终有效 Issue。

---

## 5. Output Contract｜输出与 S01 → S02 Handoff

### 5.1 Valid Potential Issue｜CEO-ready Issue Framing Content

S01 仍使用四块 CEO-ready 结构，但在自动链路中它首先是 S02 的高质量输入，不代表立即向 CEO 展示：

```text
Sharp Title：<一个直接呈现最值得判断战略议题的短问句>

What Happened：<一个 decisive observation + 必要 Evidence boundary>

Implication：<一个 business consequence + 一个 real question>

Source：<最小来源信息>
```

#### Sharp Title

- 默认使用**短问句**；
- 只保留一个最值得判断的 underlying strategic tension；
- 不使用“是否应该 / 要不要做 X”的 solution-seeking 句式；
- 不把 plausible hypothesis 写成题设；
- 不停留在 UI、功能或局部 execution symptom。

#### What Happened

只回答：**哪一个 decisive observation，使原有判断值得重新审视？**

- 原则上一个核心 observation；
- 保留必要 Evidence boundary；
- 不逐项复述输入；
- observation / intuition 不写成已确认 Fact。

#### Implication

只完成两个动作：

1. **Business Consequence**：如果 tension 成立，哪一个当前重要判断可能需要重新审视；
2. **Real Question**：当前真正需要进一步回答的一个核心问题。

到这里停止，不展开 S02 的议题理解或 research case。

#### Source

极简、可追溯，不承担正文论证。

### 5.2 Internal Handoff｜只有一个 Current Potential Issue

对每个有效 Issue，S01 至少提供：

```text
Issue History：New | Existing
Issue ID：<Existing 时必须提供；New 时按系统规则创建>
Potential Issue Statement：<一句稳定、neutral、decision-oriented、open-to-evidence 的当前有效问题>
Issue-origin Evidence：<最关键 Evidence>
Relevant Company Context：<与本 Issue 直接相关的当前 Context>
New Evidence：<仅在 Existing 本轮因新增 Evidence 重新进入链路时提供>
Previous Statement：<仅在本轮发生 Reframing 且对下游理解必要时提供>
Calibration Note：<仅 CEO Insight 被 Reframe 时按需提供>
```

规则：

- **正式 history 属性只有 New / Existing**；不要创建 `Existing with New Evidence`、`Existing Reframed` 等新的 Issue 类型；
- `New Evidence` 是 Context；`Previous Statement` 是版本历史；`Reframing` 是动作；
- `Potential Issue Statement` 与 Sharp Title 必须来自同一个 underlying issue；
- Statement 只表达一个核心 uncertainty；
- Existing Issue framing 未失效时，原则上沿用现有 Statement；
- Existing Issue 被 Reframe 时，保留 Issue identity 与必要版本历史，但交给 S02 的是**新的 Current Statement**。

### 5.3 No Issue

#### External / Internal

```text
No Issue
Reason：<一句说明为什么不满足 real / material / decision-relevant>
```

仅内部返回，不进入 S02，不生成 CEO-facing Issue。

#### CEO Insight

```text
当前判断：暂不形成 Potential Issue。
为什么：<最关键 Evidence / reasoning，说明为什么当前 concern 不足以成为独立 Issue>
Source：<极简>
```

不进入 S02，也不为了“回应 CEO”强造新的 research question。

---

## 6. Quality Standard & Guardrails｜什么叫高质量

### Quality

1. **Real tension first**：先找到真实 tension，再决定是否形成 Issue；
2. **Right issue before sharp wording**：问题语义正确优先于标题漂亮；
3. **History disciplined**：New / Existing identity 稳定，不因每条 New Evidence 造新 Issue；
4. **Framing valid**：对象、分类轴、层级与 core uncertainty 都能回到 Evidence；
5. **CEO-ready but not overbuilt**：S01 足够 sharp，但不提前完成 S02；
6. **Return-safe**：下游发现 framing break 时能回到 S01，而不是静默漂移。

### Calibrated Claim Strength

Claim strength must not exceed Evidence strength，同时控制 **Certainty / Materiality / Scope / Mechanism**。

### Failure Modes

1. **Signal Restatement**：把 Signal 换一个标题；
2. **Over-strategizing**：普通 execution issue 被拔高；
3. **Solution Frame Inheritance**：沿用输入自带的“是否做 X”；
4. **Hypothesis as Premise**：把 plausible explanation 当成题设；
5. **Invalid Axis**：real tension 存在，但用错误客户分类、因果变量或竞争维度提问；
6. **Wrong Level**：问题停留在操作层或被无 Evidence 拔高到公司战略层；
7. **Multi-question Handoff**：一个 Statement 承载多个 downstream questions；
8. **Issue Type Proliferation**：把 New Evidence / Reframing 继续设计成新的 Issue 类型；
9. **Issue Inflation / Duplication**：每条 Evidence 都造新 Issue；
10. **History Loss**：Existing Issue 被当成新 Topic；
11. **Silent Reframing**：改变 Issue 但不保留 identity / 版本关系；
12. **Overclaiming**：certainty / materiality / scope / mechanism 超出 Evidence；
13. **Mini Pre-research**：在 Implication 里展开 S02 应完成的理解和论证。

### Human / System Boundary

S01 定义“什么叫问题内容正确、如何 Reframe、什么可以交给 S02”；Products&Applications / Agent 负责对象识别、状态、Routing、自动 rerun 与最终呈现。S01 不替 CEO 做 CEO Confirmation。

---

## 7. Test Cases｜如何验收

后续测试不再扩展 Issue 类型，重点验证以下能力：

- **New Issue straight-through**：Real Tension → Valid Framing → S02；
- **Existing Issue + New Evidence**：保留 identity，判断 current framing 是否仍有效；
- **Existing Issue Reframe**：同一 underlying tension 下修正 framing，交给 S02 的是 current valid Statement；
- **Different tension → New Issue**：不把新战略问题硬塞进 Existing Issue；
- **S02 Return**：`Reframing Needed → S01 → S02` 能闭环；
- **External / Internal No Issue**：Silent Stop；
- **CEO Insight No Issue / Reframe**：给出足够透明的解释，但不制造额外研究；
- **Title–Statement Continuity**：Sharp Title 与 Statement 始终是同一个问题。

统一通过标准：**S01 → S02 的输入永远是一个当前认为已经问对、且 history identity 清楚的 Potential Issue。**
