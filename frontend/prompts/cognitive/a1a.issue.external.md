{{SKILL:m1a-s01-issue-framing}}

---

## 这一次没有 Company Context，所以技能里两条规矩变成主约束

上面那份技能把 **Relevant Company Context** 列为 Must-have，而这一次它不存在：公司
战略数据库里没有与这条信号对应的锚点。技能对这种情况已经给了答案，就在 §3
「Context 不足时」那一段，这次要严格照它办：

- **不得只凭「行业重要」升级为公司级 Issue。** 热度、声量、别人都在讨论，都不是
  material；
- **不得把二手描述写成已确认 Fact。** 这次唯一的一手材料就是信号原文本身；
- **Company Context 用于判断 relevance 与 consequence，不用于反向制造 underlying
  issue** —— 反过来说，没有 Company Context 时更不许凭空造一个出来。所以不要写
  「公司现有战略假设是……」「公司此前认为……」：你不知道，这次没有材料告诉你。

## 走技能里的哪几步

这一次把前后两半合成一次调用，但顺序不变：

- **Step 1 Find Real Tension** —— 去掉表层 framing，找到真正被挑战的假设或约束；
- **Step 2 Real Issue Qualification** —— 三条里 material 那一条这次最吃紧：判断依据只有
  信号本身和公开可查的通行事实。不合格就是技能里的 **No Issue**，在这里对应
  `ignore`；
- **Step 3 Match Issue History** —— 这次跳过。看不到任何既有议题，Existing 无从判断，
  所以「取代」这条路不成立，只剩新建或忽略；
- **Step 4–6** —— 判值得时，形成议题正文并过一遍 Valid Framing Check 与 Final Quality
  Gate。

## 字段对应

**§5.1 那四块是一块一块交的，不是一段字。** 技能里 `Sharp Title：` / `What Happened：`
那种写法**不要出现在输出里**，一个星号一个井号都不要 —— 段名、加粗、顺序、
「证据边界：」那类前缀由屏幕负责，屏幕按纯文本渲染，写了就原样显示出来。

| 技能里的块 | 这里的字段 |
|---|---|
| Sharp Title | `sharp_title` —— 短问句，一行 |
| §5.2 Potential Issue Statement | `issue_statement` |
| What Happened 的 decisive observation | `what_happened` |
| What Happened 的 Evidence boundary | `evidence_boundary` —— **单独一格，这条路上它最要紧** |
| Implication 的 business consequence | `business_consequence` |
| Implication 的 real question | `real_question` —— **单独一格，不要并进正文** |
| Source | `source_line` |
| Real Issue Qualification 的结论 | `why_it_qualifies` —— 说清「一旦成立，什么会不得不变」 |
| No Issue 的 Reason | `reason` |
| 什么情况下它会重新值得处理 | `what_would_change_it` |

`business_consequence` 和 `why_it_qualifies` 不是同一件事：前者说哪一个当前重要判断
需要重新审视，后者说这件事够不够分量进议题队列。两格写成同一句话，说明其中一格
你没答。这次说不出「公司的哪一条」（没有锚点），就说清「做这门生意的人的哪一条」。

## 这条路上最容易出的三种错

- **Overclaiming** —— 技能 §6 里的这一条在这条路上最容易犯：没有内部材料兜底，
  certainty / materiality / scope / mechanism 四项里任意一项超出信号本身能支持的
  强度，就是编。`evidence_boundary` 是专门拦它的那一格：**这一格是这条路上最贵的
  一句**，唯一的一手材料就是信号原文，所以「哪一句是媒体叙事而不是事实」必须
  由你写出来，没有第二个人会补；
- **Over-strategizing** —— 一次性事件、执行层面的操作问题、只是热度高的话题被拔高成
  公司级议题。宁可判不值得：把不够分量的信号放进议题队列，后面每一步都会照着它跑；
- **Mini Pre-research** —— 在 `business_consequence` 或 `why_it_qualifies` 里展开论证、
  列三种情形、给研究计划。到 Implication 停，下一步预研会做。
