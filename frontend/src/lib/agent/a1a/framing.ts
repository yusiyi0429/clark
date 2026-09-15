/**
 * S01 Issue Framing 的**格式层**。不调模型，不改内容。
 *
 * 这个文件回答一个问题：那四块 CEO-ready 的东西，从模型给的 JSON 到屏幕上那几段字，
 * 中间那一步谁做。答案是这里，不是 prompt。
 *
 * ## 为什么这一步不留给 prompt
 *
 * 方法域给的技能（`prompts/cognitive/skills/m1a-s01-issue-framing.md` §5.1）要的是
 * 四个文本块：
 *
 *     Sharp Title：…
 *     What Happened：…（一个 decisive observation + 必要 Evidence boundary）
 *     Implication：…（一个 business consequence + 一个 real question）
 *     Source：…
 *
 * 让模型直接交这四段字，等于让它每一轮同时赌两件事：**想清楚了什么**，和**摆成什么
 * 样子**。第二件有唯一正确答案 —— 小标题就叫「发生了什么」，证据边界那一句前面就缀
 * 「证据边界：」，来源在最后。赌它只有两种结果：赌赢了没赚到，赌输了屏幕上多两个
 * 星号或者少一个小标题，而两次跑出来的同一条议题长得不一样。
 *
 * 所以拆开：**prompt 只问内容**（六个平铺字段，一段一件事），**这里定形状**。
 * 好处不是省 token，是这四块从此不会再变形 —— 换模型、换温度、换一条信号都不会。
 *
 * ## 存的是内容，拼是渲染时的事
 *
 * `readIssueFraming()` 把模型给的字段收成 `IssueFraming` 存进卡（`Card.framing`）；
 * `framingBlocks()` 是纯函数，屏幕每次渲染时调它。**不在写入时就拼成一段字**：拼好
 * 存下来的话，改一次小标题措辞救不了已经落库的那些议题，而它们仍然在屏幕上 —— 于是
 * 同一个产品里会有两代格式并存，而这正是这层要消灭的东西。
 */
import { plain } from "@/lib/agent/plain-text";
import type { IssueFraming } from "@/lib/data/types";

/**
 * 从 A1a 的产出里读出那四块。**读不到议题正文就返回 null** —— 一条没有正文的议题
 * 等于在池子里放一条编的，调用方照实说这一句（见 `issueFromSignal`）。
 *
 * 三条回落是有意的，各有来路：
 *
 *  - `title` 回落到 `statement`：`sharp_title` 是这一版新加的字段，跑在它之前的产出、
 *    和忘了给的那一轮，仍然要有一行能摆上卡面的字；
 *  - `businessConsequence` 认三个字段名：锚定路（new/update）历史上给的是 `why_now`，
 *    纯外部路给的是 `why_it_qualifies`，这一版统一叫 `business_consequence`。三个都认，
 *    因为这一格空着的后果是卡面上写「系统还没查过」而其实查过了；
 *  - 其余字段没有回落。**空就是空** —— 拿 `what_happened` 去顶 `evidence_boundary`
 *    会让「这次的证据到哪儿为止」凭空多出一句，而那一句是四块里最贵的。
 */
export function readIssueFraming(out: Record<string, unknown>): IssueFraming | null {
  const statement = plain(out.issue_statement);
  if (!statement) return null;

  return {
    title: plain(out.sharp_title) || statement,
    statement,
    whatHappened: plain(out.what_happened),
    evidenceBoundary: plain(out.evidence_boundary),
    businessConsequence:
      plain(out.business_consequence) || plain(out.why_it_qualifies) || plain(out.why_now),
    realQuestion: plain(out.real_question),
    source: plain(out.source_line),
  };
}

/**
 * 屏幕上的一块。`label` 是空串时不出小标题。
 *
 * `paragraphs` 而不是一整段字：屏幕按段落排版（段间留白），拼成 `\n\n` 再让渲染层
 * split 一遍，等于把结构先压平再猜回来。
 */
export type FramingBlock = { id: string; label: string; paragraphs: string[] };

/** 证据边界那一句前面缀的词。改这一个常量，全产品的这一句跟着改。 */
const BOUNDARY_LABEL = "证据边界：";

/**
 * Implication 里那个 real question 前面缀的词。
 *
 * 必须有这个前缀：business consequence 和 real question 都是问句气味的长句，摆在
 * 一起读不出哪一句才是「现在要回答的」。技能里 Implication 只完成两个动作，屏幕上
 * 就该看得出是两个。
 */
const QUESTION_LABEL = "真正要回答的问题：";

/**
 * 那四块，按屏幕上的顺序和小标题摊开。
 *
 * ## 小标题：除了标题那一块，每块都有
 *
 * 卡面上一个小标题都没有（见 `Card` 的注释 —— 标签把一段连贯的话切成四个待办事项）。
 * 详情页反过来：这一页他是坐下来读的，四块各自回答一个不同的问题，而**没有小标题时
 * 「哪一句是证据边界、哪一句是真正要回答的问题」只能靠他自己数**。区别在于卡面那三拍
 * 本来是一句话，这四块本来是四件事。
 *
 * Sharp Title 那一块不配小标题：它已经是页面上最大的那行字（`Card.headline`），
 * 给标题再加一个写着「标题」的标签是同一句话说两遍。这里第一块出的是 §5.2 那条
 * Potential Issue Statement —— 比标题完整、交给预研的就是它，所以它属于标题那一档，
 * 跟着不配小标题。
 *
 * ## 空块不出
 *
 * 模型没给的那一块整个不渲染，不留一个写着「（未提供）」的空槽。这一页上每一段都
 * 是他要读进去的东西，占着位置说自己没内容的段落只会让他多扫一遍。
 */
export function framingBlocks(f: IssueFraming | null | undefined): FramingBlock[] {
  if (!f) return [];

  const blocks: FramingBlock[] = [];
  const push = (id: string, label: string, paragraphs: (string | false)[]) => {
    const ps = paragraphs.filter((p): p is string => Boolean(p && p.trim()));
    if (ps.length) blocks.push({ id, label, paragraphs: ps });
  };

  /*
   * 标题一样时不重复出。
   *
   * `sharp_title` 没给的那一轮，`title` 回落成了 `statement` —— 那时这一块和页面
   * 顶上那行大字一个字不差，摆出来是把同一句话印两遍。
   */
  push("statement", "", [f.statement !== f.title && f.statement]);

  /*
   * 证据边界单独一段，不接在观察后面。
   *
   * 技能里的产出案例把它写成同一段的末尾一句。这里另起一段，因为屏幕上这一栏只有
   * 26rem 宽：接在末尾时它是一个长段落的最后一个从句，而它要否掉的正是读完那一段
   * 最自然的那个假设 ——「这些都已经核实过了」。它是这四块里最容易被压掉、也最贵
   * 的一句，值得占一段。
   */
  push("what-happened", "发生了什么", [
    f.whatHappened,
    f.evidenceBoundary && `${BOUNDARY_LABEL}${f.evidenceBoundary}`,
  ]);

  push("implication", "这意味着什么", [
    f.businessConsequence,
    f.realQuestion && `${QUESTION_LABEL}${f.realQuestion}`,
  ]);

  push("source", "来源", [f.source]);

  return blocks;
}
