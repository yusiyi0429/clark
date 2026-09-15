# 认知指令段（第 ③ 段）

这个目录是**方法部门唯一要编辑的地方**。工程段（`prompts/engineering/`）管输入
契约、上下文注入、输出格式、硬约束；认知段管「你要想清楚什么」——同一个工程
骨架配不同的认知指令，产出的判断质量差得远。

## 目录长什么样

```
prompts/cognitive/
  skills/                        ← 方法部门给的技能文档原件，一个文件一份技能
    m1a-s01-issue-framing.md
    m1a-s02-pre-research.md
    m1a-s03-strategic-deep-research.md
  a1a.triage.md                  ← 按 prompt key 建，每个引一份技能 + 说这一次做哪一步
  a1a.issue.new.md
  a1a.issue.update.md
  a1a.issue.external.md
  a3.pre-research.md
  a4.research.md
```

## 技能文档怎么引

认知段文件里写 `{{SKILL:m1a-s01-issue-framing}}`，装配时会换成
`skills/m1a-s01-issue-framing.md` 的正文（YAML frontmatter 会被剥掉 —— 那是登记
信息，不是给模型看的；版本号在正文第一行的标题里，所以剥掉不丢溯源）。

**引，不要抄。** S01 一份技能同时管四个 prompt key：抄成四份之后，方法部门给
v0.5 时改三份漏一份 —— 漏的那一个照样跑、照样出格式正确的议题，只是它按上一版
的标准在判断，而结果页上看不出任何区别。

技能文件不存在或名字不合法，装配会抛 `SkillNotFoundError`，不会换成空串。跟
`PromptKeyError` 同一个道理：装没装上，必须在跑起来的那一刻就炸。

## 一份认知段文件写什么

两块，顺序固定：

1. `{{SKILL:<名字>}}` —— 完整的方法标准；
2. `---` 之后，**这一次**的落法：走技能里的哪几步、技能里那几块对应输出 JSON
   的哪个字段、这条路上最容易犯的失败模式。

技能文档里的 Output Contract 是文本块（`Sharp Title：` 那种），和工程段的 JSON
schema 冲突。所以技能正文放前面，字段对应表放最后 —— 离紧跟其后的「输出格式」
段最近，模型最后读到的是真正要交的形状。

## 改完怎么生效

改完重启 dev server（`prompts.ts` 首次用到时读盘并缓存）。文件不进 webpack
产物，靠 `next.config.ts` 的 `outputFileTracingIncludes: ["./prompts/**/*.md"]`
带进容器 —— 那个 glob 已经覆盖 `skills/` 子目录。

运行时也能传：`assemble(key, { cognitive })` 或 `new Harness({ cognitive })` 传进
来的优先，用于一次性试不同写法而不改文件。A3 / A4 不走 `assemble()`（它们的 user
段是手写的一整份），但用同一个 `cognitiveFor()` 取值 —— 两条取值路径的话，「这个
agent 的认知段到底装上了没有」得分开查两遍。

S03 那份技能的 §6 Output Contract 要的是**一份可署名分发的正式报告**，而屏幕上要的
是四节。**这两件事现在都交** —— A4 先按 §6 写那份报告（存进 `ResearchDoc.sourceText`，
报告页签默认给的就是它），再把它压成四节 JSON 给判断板和划词溯源取值。`a4.research.md`
第一节写的就是这个两层落法。

**这里踩过一次坑，值得记下来。** 上一版的落法段写的是「这一次的交付不是那份 Word
报告」，于是 §6 整段被关掉了：技能装得好好的、`cognitiveSource` 记着 `default`，跑出来
却永远是四节，没人能从台账上看出那份报告是被我们自己压掉的 —— 它看起来像模型写不出。
**落法段能压掉技能里任何一段，所以「不适用」这三个字要用得比技能本身更谨慎**：写下它
之前先问，这一段是真的和载体冲突，还是只是当时那块屏幕上没有它的位置。后者的解法是
多给一层交付，不是关掉标准。

**技能升版时，落法段里那些 §x.y 要跟着重锚一遍。** v0.4 → v0.5（2026-08-20）这一次
就是活例子：v0.5 重排了 §4、把 §6 的四小节改成五小节、§7 从两栏并成五条、§8 从
十四条收成七条，而 v0.4 的 §4.5（四档强度 + 高强度表达 Gate）、§4.6（Challenge 必须
改变结论）、§4.7（Company Relevance / Recommendation）、§8.8（末尾免责）、§8.9
（Pseudo Precision）在 v0.5 里整条没有了。只换 `skills/` 那个文件的话，落法段照旧
引着一批已经指不到东西的编号 —— 模型读到的是一份自相矛盾的标准，而结果页上看不出
任何区别。v0.5 新增的 §2 研究模式（Mode A / Mode B）也需要落法：内部材料不够时哪个
字段承接哪一块，`a4.research.md` 第三节写的就是这件事。

确定性质量门（`src/lib/agent/a4/validate.ts` 的 A4-01…A4-13、`rules.ts` 的 G-05）
不跟着技能编号动，它数的是字段形状、条数、字数和溯源。技能升版**不要顺手改它** ——
那是两套东西：技能定「该想清楚什么」，质量门定「交出来的形状对不对」。

文件不存在时 `{{COGNITIVE}}` 会被换成「（本条 Prompt 的认知指令段尚未提供）」，
`cognitiveSource` 记成 `empty`，跟着 Run 记录落盘 —— 所以「这次跑的时候还没有
认知段」事后查得出来。**不要为了占位建空文件**：空文件会被记成
`cognitiveSource: "default"`，反而把这件事藏起来。

## 故意不在这里的：A5 判断生成

`a5.judgements` **没有认知段文件，也不去 `cognitiveFor()` 取。** 这不是还没装 ——
把深研报告收成几条待一号位确认的判断，不归方法部门管，它的整份 prompt 写在
`src/lib/agent/a5/prompt.ts` 里（形状照的是 Package 04b 那份 Judgment）。

所以看到这里少一个文件时，**不要为了「补齐」给它建一个**。建了会有两个后果：
台账上多出一条「这一轮带了标准」的记录，而那份标准是我们自己编的；以及下一次
方法部门升版时，有人会去改一份根本不该由他们维护的文件。
