{{SKILL:m1a-s01-issue-framing}}

---

## 这一次走技能里的后三步：New Issue

前三步（找 real tension、Real Issue Qualification、Match Issue History）上一次调用
已经做完，结论就在输入里的【上一步的定性结论】那一段：这条信号背后是一个真实、
material、decision-relevant 的问题，而公司现在还没有议题在承接它。**不要重做那三步**，
也不要推翻它 —— 这一次做的是：

- **Step 4 Form Candidate Potential Issue** —— 基于 real tension 首次形成议题正文；
- **Step 5 Valid Framing Check** —— 对象、分类轴 / 因果前提、层级、core uncertainty、
  是否把答案偷塞进了问题。不过就在心里改完再写，不要把检查过程写出来；
- **Step 6 Final Quality Gate** —— claim strength 不超过 Evidence，标题与正文回答
  同一个 underlying issue。

## 技能里那四块，对应下面 JSON 的哪个字段

**§5.1 那四块是一块一块交的，不是一段字。** 技能里写成

    Sharp Title：…
    What Happened：…

是为了让人读懂结构；这里每一块单独占一个字段，段名、加粗、顺序、「证据边界：」那类
前缀全部由屏幕负责。所以 `Sharp Title：` / `What Happened：` 这种写法**不要出现在
输出里**，一个星号一个井号都不要 —— 屏幕按纯文本渲染，写了就原样显示出来。

| 技能里的块 | 这里的字段 |
|---|---|
| Sharp Title | `sharp_title` —— 短问句，一行 |
| §5.2 Potential Issue Statement | `issue_statement` —— 交给下一步预研的就是它 |
| What Happened 的 decisive observation | `what_happened` |
| What Happened 的 Evidence boundary | `evidence_boundary` —— **单独一格，不要并进上一格** |
| Implication 的 business consequence | `business_consequence` |
| Implication 的 real question | `real_question` —— **单独一格，不要并进正文** |
| Source | `source_line` |
| Relevant Company Context 里被动摇的那一条 | `shakes_assumption` |
| Issue-origin Evidence | `cited_member_ids` |

拆成两格是有原因的。Evidence boundary 和 real question 是这四块里最容易被吞掉的
两句 —— 并进正文时它们变成长段落的最后一个从句，而 boundary 要否掉的恰恰是读完
观察最自然的那个假设（「这些都已经核实过了」），real question 是下一步预研照着跑的
那一句。单独一格意味着**空着就是空着**，看得见。

## 这一步最容易出的四种错

技能 §6 十三条里，落到这个字段表上最常犯的是这四条：

- **Signal Restatement** —— `what_happened` 把信号逐条复述一遍，`issue_statement` 只是
  给它换了个标题。判据：`issue_statement` 里如果没有一处「不确定」，它就不是议题；
- **Hypothesis as Premise** —— `sharp_title` 写成「因为 A 导致 B，我们该怎么办？」，
  而 A 导致 B 本身就是这次要判的东西；
- **Wrong Level** —— `shakes_assumption` 指不到上面上下文里具体的某一条，只能写
  「影响公司战略方向」。指不到就回去把对象问准；
- **Mini Pre-research** —— 在 `business_consequence` 里展开论证、列情形、给研究计划。
  到 Implication 停。下一步预研会做，在这里做完等于替它把结论先下了。

还有一条 **Multi-question Handoff**：`issue_statement` 里出现第二个问号，通常就是把
两条议题塞进了一条。技能要求一个 Statement 只承载一个核心 uncertainty。
