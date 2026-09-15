{{SKILL:m1a-s01-issue-framing}}

---

## 这一次走技能里的后三步：Existing Issue 的 Reframing

前三步上一次调用已经做完，结论在输入里的【上一步的定性结论】那一段：这是一个
**Existing Issue** —— underlying tension 和公司最终要判断的对象没变，变的是现有说法
已经不能准确描述它了。所以这一次做的是技能里的 **Reframing**：

- **Step 4** —— 先读上面上下文里那条议题的现说法，再看这条信号新增了什么。现说法
  仍然准确的，原则上不动；不能描述 real tension 了，才改；
- **Step 5 Valid Framing Check** —— 改完的那条，对象、分类轴 / 因果前提、层级、core
  uncertainty 逐项要站得住；
- **Step 6 Final Quality Gate** —— claim strength 不超过 Evidence。

技能里那条边界在这一步最要紧：**同一个 underlying tension 只是说法要修** → 就是这一
条路；**新增 Evidence 暴露了另一个 tension 或另一个决策对象** → 那是一条新议题，不是
取代。说不出「为什么是取代而不是另开一条」的，通常就是后者。

## 「取代」怎么对上技能里的版本历史

技能要求 Reframe 时保留 Issue identity 和必要的版本历史，交给下游的是新的 Current
Statement。这里的做法是**旧那条一个字都不改**（它已经被引用过、被讨论过），另写一条
新的去取代它：

| 技能里的概念 | 这里的字段 |
|---|---|
| Current Statement（Reframe 之后的当前问题） | `issue_statement` |
| Previous Statement（版本历史） | `replaces.statement_before` —— 从上下文**照录**，不要改写 |
| Issue identity | `target_issue_code` / `replaces.code` |
| Reframing reason | `what_changed` 与 `why_replace_not_new` |
| Sharp Title | `sharp_title` —— 短问句，一行 |
| What Happened 的 decisive observation | `what_happened` |
| What Happened 的 Evidence boundary | `evidence_boundary` —— **单独一格，不要并进上一格** |
| Implication 的 business consequence | `business_consequence` |
| Implication 的 real question | `real_question` —— **单独一格，不要并进正文** |
| Source | `source_line` |
| Relevant Company Context 里被动摇的那一条 | `shakes_assumption` |

`what_changed` 要指到具体一处（范围 / 前提 / 时点 / 取舍的方向）。写「更全面了」
「更清晰了」的，是技能里的 **Silent Reframing** —— 改了题却说不清改的是哪一处，
事后没人能对出新旧两条差在哪里。

**§5.1 那四块是一块一块交的，不是一段字。** 技能里 `Sharp Title：` / `What Happened：`
那种写法**不要出现在输出里**，一个星号一个井号都不要 —— 段名、加粗、顺序、
「证据边界：」那类前缀由屏幕负责，屏幕按纯文本渲染，写了就原样显示出来。

## 这条路上最容易出的三种错

- **Multi-question Handoff** —— 这一步最容易犯：旧说法加上新证据，最省事的写法就是
  把两者并列成两问。那不是 reframe，是拼接。`issue_statement` 里出现第二个问号，
  回去挑出真正变了的那一个；
- **Overclaiming** —— 一条信号能支持「旧说法的某一处需要修」，不等于能支持
  「旧判断已经被推翻」。`evidence_boundary` 就是拦这个的：新说法这次到底被证到
  哪一步，写出来；
- **Mini Pre-research** —— 在 `business_consequence` 里展开论证、列情形。到 Implication
  停，下一步预研会做。

`what_changed` 对着旧说法说，`what_happened` 对着世界说 —— 两格写成同一句话，
说明其中一格你没答。
