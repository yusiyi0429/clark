/**
 * 跨 agent 共用的确定性检查原语。**不调模型。**
 *
 * 这里放的是 rubric 里 G-* 组（全局规则）和几条前端渲染带来的硬约束 ——
 * 它们对 A3 预研、A4 深研、A10 写回同样成立。各 agent 自己的 validate.ts
 * 只写它独有的那几条（句数、块数、章节结构）。
 *
 * 为什么必须是确定性的：CQ101 里有一半要求是**可数的**。可数的东西写进 prompt
 * 然后指望模型每次都数对，是这类项目最常见也最贵的失败 —— 它在评测里表现为
 * 「模型不稳定」，而真实原因是没人在数。可数的就去数。
 */

export type Severity = "p0" | "p1";
export type Violation = {
  rule: string;
  severity: Severity;
  message: string;
  /**
   * 这条违规出在第几个块（从 0 数）。**只有区块报告的校验器会填**（`a4/blocks/lint.ts`）。
   *
   * 存在的理由是返修那一轮只重发被拒的那几块：拒的粒度是块，而「第几个块」这件事已经
   * 写在 `message` 里了（「第 3 个块（kpi_cards · …）」）—— 但那是给人读的一句话，
   * 让代码去正则里抠一个序号出来，等于把提示词的文案变成接口。所以单独一栏。
   */
  block?: number;
};

/** 中文断句。—— 和 …… 不算句末。 */
export const sentences = (s: string): string[] =>
  s
    .split(/(?<=[。！？!?])\s*/)
    .map((x) => x.trim())
    .filter((x) => x.length > 1);

export const paragraphs = (s: string): string[] =>
  s.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

export const isRhetorical = (p: string): boolean => /^反问[：:]/.test(p);

export const chars = (s: string): number => s.replace(/\s/g, "").length;

/**
 * CQ101 §05-3 与 §08 点名的回避式措辞。
 *
 * 它们的共同点不是「说得含糊」，是**说了等于没说**：把这句话删掉，读者的判断
 * 一点都不会变。一号位读到它只会想「所以呢」，而那正是这份东西要回答的问题。
 */
export const HEDGES = [
  "机会与挑战并存",
  "建议持续关注",
  "后续需要再看",
  "值得持续观察",
  "有待进一步观察",
  "总体来看形势复杂",
  "需要综合考虑",
  "仁者见仁",
  "各有利弊",
];

/** CQ101 §04-3 / §05：标题要写 synthesis，不用「市场 / 技术 / 竞争」这种分类词。 */
export const CATEGORY_HEAD =
  /^(市场|竞争|技术|客户|行业|政策|产品|财务|团队|运营|数据)(分析|格局|趋势|概况|现状|情况|方面)?[:：]?$/;

/** 屏幕上的 AgentText 按空行分段渲染纯文本 —— markdown 记号会原样显示。 */
export const MARKDOWN = /\*\*|^#{1,6}\s|^[-*]\s|^\d+\.\s/m;

/** 空词。写进给一号位看的东西里，等于在说「我没想清楚」。 */
export const BUZZ = ["赋能", "抓手", "闭环打通", "顶层设计", "生态位", "打法", "组合拳"];

/**
 * 判断已经越过那道权力转移的写法。
 *
 * 这是这条链路唯一的 p0 内容规则，也是它存在的理由：参谋写的是候选，确认只能由
 * 一号位按下。一条自称已经确认的判断摊在板的上半层，屏幕上和真候选长得一模一样，
 * 而他会以为这件事已经过了他 —— 于是这个产品里唯一一次权力转移被绕过去了。
 */
export const SELF_CONFIRMED = /(已确认|已经确认|已获确认|已形成(共识|一致)|已成为公司(口径|决定)|公司据此|据此执行|已达成一致)/;

/** 写了等于没写的重开条件。「情况有变化」不是条件，是一句安慰。 */
export const VAGUE_REOPEN = /^(如果|若|一旦)?(情况|外部环境|市场|形势)?(有|发生)?(变化|变动|新情况)/;

/**
 * 一段文字里的通用违规。所有 agent 的 validate 都先跑这一遍。
 *
 * @param label 出现在报错里的位置名，方便一眼看出是哪一节坏了。
 */
export function commonViolations(text: string, label: string): Violation[] {
  const v: Violation[] = [];
  if (!text) return v;

  for (const h of HEDGES) {
    if (text.includes(h)) v.push({ rule: "G-08", severity: "p0", message: `${label} 出现回避式措辞「${h}」。` });
  }
  for (const b of BUZZ) {
    if (text.includes(b)) v.push({ rule: "G-09", severity: "p1", message: `${label} 出现空词「${b}」。` });
  }
  if (MARKDOWN.test(text)) {
    v.push({
      rule: "FE-md",
      severity: "p0",
      message: `${label} 里有 markdown 记号；屏幕按纯文本渲染，会原样显示成星号井号。`,
    });
  }
  // 本体内部编号点不开。溯源里出现它等于给了一个死链接。
  if (/member:[A-Za-z0-9_-]+/.test(text)) {
    v.push({
      rule: "A7-03",
      severity: "p0",
      message: `${label} 里出现本体内部编号 member:xxx —— 屏幕认不出、点不开，要换成对应的短码或文档标题。`,
    });
  }
  if (/[！]/.test(text)) {
    v.push({ rule: "G-10", severity: "p1", message: `${label} 里有感叹号。` });
  }
  return v;
}

/**
 * 无依据的绝对化。CQ101 §05-3：结论强度必须匹配依据强度。
 *
 * 只在**没有任何数字、也没有引用编号**的句子上判 —— 有依据的断言本来就该硬。
 */
export function overclaim(text: string, label: string): Violation[] {
  const v: Violation[] = [];
  const HARD = /(必然|一定会|毫无疑问|唯一的|完全不可能|铁定|百分之百)/;
  for (const s of sentences(text)) {
    if (!HARD.test(s)) continue;
    const hasEvidence = /\d/.test(s) || /(0[0-9]-J\d+|ISS-\d+|DOC-\d+|CARD-\d+)/.test(s);
    if (!hasEvidence) {
      v.push({
        rule: "G-05",
        severity: "p1",
        message: `${label} 有一句无依据的绝对化：「${s.slice(0, 28)}…」。`,
      });
    }
  }
  return v;
}

export const blocking = (v: Violation[]): Violation[] => v.filter((x) => x.severity === "p0");

export const summarize = (v: Violation[]): string =>
  v.map((x) => `${x.rule}[${x.severity}] ${x.message}`).join("；");

/**
 * 落进 Run 记录的一条违规。**规则名在最前面**：运营台要按它分组数「哪条规则老是
 * 被违反」，前面多任何东西这个分组就散了。A3/A4 两处必须同一种写法，否则同一条
 * 规则在台账上会因为格式不同而算成两条。
 */
export const fmt = (v: Violation): string => `${v.rule} ${v.severity} ${v.message}`;
