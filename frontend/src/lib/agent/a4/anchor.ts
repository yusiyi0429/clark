/**
 * N0 主体锚定。**这一步定的是「这次研究的行业边界在哪」，而且必须由主体自己的一手材料定。**
 *
 * 上一版没有这一步，后果是行业定义被检索结果反向定义了：搜到的碰巧是智能手机面板份额
 * 数据，于是「维信诺所处的行业」就变成了「AMOLED 智能手机面板」，而这家公司 550 亿的
 * 战略下注（第 8.6 代线、ViP 光刻）整篇一个字没出现 —— 落回主体那一节因此只能说出
 * 「份额 9.4%、同比 +8.9%」，答不出「这家公司未来靠什么」。
 *
 * 所以这里有一条硬账：**投资额权重过线的在建项目必须出现在行业定义里**（`cardGaps`）。
 * 它不是文风要求，是「N0 到 N5 这条链有没有断」唯一机检得出来的地方。
 *
 * ## 这是草稿前唯一允许的检索
 *
 * 只搜主体的年报、半年报、投资者关系材料、官网业务介绍、最近四个季度的重大公告。
 * 行业面的东西一条都不许在这里搜 —— 那些进来之后，命题就又被首波检索种下了。
 */

import type { A4Input } from "./prompt";

export const LIFECYCLES = ["现金流", "成长", "投入期"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export type SubjectCard = {
  subject: string;
  segments: { name: string; weight: string; lifecycle: Lifecycle }[];
  /** `heavy` = 投资额占市值或净资产两成以上。由模型读年报判断，代码只负责让它进行业定义。 */
  projects: { name: string; investment: string; onlineAt: string; techRoute: string; heavy: boolean }[];
  customers: string;
  /**
   * 官网域名，`visionox.com` 这样一段，不带协议也不带路径。模型不给就是空串。
   *
   * 2026-09-07 加（ISS-238）。它有两个下游，都不是「顺手记一下」：
   * · 确定性命题 `D8-F3` 拿它拼 `site:` 检索式去搜重大公告（`card-props.ts`）；
   * · 抓取位保留把它当成一手披露域名并进 `DISCLOSURE_HOSTS`（`research/slots.ts`），
   *   抓取超时和 PDF 体积也跟着放宽（`research/fetch.ts`）。
   *
   * 空串是合法值，两处都会因此少一格 —— 但**不许落成一段脏字符串**：域名匹配靠后缀段比，
   * 「维信诺官网」这种进去之后 `D8-F3` 会发一条 `site:维信诺官网` 的废检索式。所以
   * `compileCard` 里认不出域名形状的一律落空串。
   */
  website: string;
  /** 一句话，必须覆盖全部有战略权重的板块。 */
  industry: string;
  window: string;
  /**
   * **这道题问的是提问的这家公司自己家里的事**（要记什么、怎么设计、要不要做、先做哪个），
   * 答案在它自己的经营和数据里，外部世界没有可查的主体。
   *
   * 2026-09-05 加。ISS-208「验证看板要记哪几样」那一轮：主体卡把「看板验证指标」当成研究主体，
   * 草稿按「行业研究员」把它写成工程效能度量工具的市场分析（Gartner、DORA、SEI 厂商格局），
   * 四条链 685 条命中入账 0，五分钟白花，未核清单里全是这些外部说法。这个标记为真时，
   * 通义种子、检索计划、分维度取证整段不跑，草稿按「我们自己的做法」写。
   * 主体是外部公司或行业的题一律为假，默认为假。
   */
  inward: boolean;
  /**
   * **这道题要的是一个决策**：主体是外面的某家公司或某个市场，但问的是提问的这家公司**对它
   * 该怎么做**（首访怎么开、要不要合作、怎么报价、先做哪个）。答案的形状是「要定什么、
   * 为什么、怎么做、怎么退」，不是一份行业分析。
   *
   * 2026-09-05 加。ISS-231「首访维信诺怎么开」：Claude 草稿在第 2 分钟就写出了议程、材料、
   * 禁区、成功判据 19 行，全部被判成「不认识的行类型」扔掉，再花 174 秒按 8 维重写（R-11）。
   * 为真时草稿多交一份决策骨架（`draft_playbook`），8 维退成背景，成稿第一节是「要您定的事」。
   * 与 `inward` 互斥：inward 是自己家里的事，decision 是对外部主体的动作。拿不准为假。
   */
  decision: boolean;
};

/** 模型不给时用它。写死在代码里，不写在提示词里 —— 提示词里的默认值会被模型改。 */
const DEFAULT_WINDOW = "当前时点 ± 未来 3 年";

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const objs = (v: unknown): Record<string, unknown>[] =>
  (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");

const lifecycle = (v: unknown): Lifecycle =>
  (LIFECYCLES as readonly string[]).includes(s(v)) ? (s(v) as Lifecycle) : "投入期";

/** 域名的形状：至少两段，只收字母数字和连字符。端口、下划线、中文一律不算。 */
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * 模型给的官网 → 域名。整条 URL、带 `www.`、带路径和末尾斜杠都规整掉。
 *
 * 认不出形状的落空串（见 `SubjectCard.website` 那条注释）：这一栏的两个下游一个拼
 * `site:` 检索式、一个做域名后缀比，喂进去一段人话的话前者发废检索式、后者永远不命中，
 * 两件事都不报错。
 */
const domain = (v: unknown): string => {
  const one = s(v)
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/^www\./i, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  return DOMAIN.test(one) ? one : "";
};

/** 模型交的那份 → 主体卡。缺的栏位落空字符串，**不落 undefined**：下游拼提示词要它。 */
export function compileCard(raw: unknown): SubjectCard {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const external = s(o.externalSubject);
  const inward = o.inward === true && !external;
  // 被代码改判成外部题时，「本公司」不能再当主体 —— 主体就是题目点名的那一家。
  const subject = !inward && (!s(o.subject) || /^(本公司|我们|我司|我方)$/.test(s(o.subject))) ? external : s(o.subject);
  return {
    subject,
    segments: objs(o.segments)
      .map((x) => ({ name: s(x.name), weight: s(x.weight), lifecycle: lifecycle(x.lifecycle) }))
      .filter((x) => x.name),
    projects: objs(o.projects)
      .map((x) => ({
        name: s(x.name),
        investment: s(x.investment),
        onlineAt: s(x.onlineAt),
        techRoute: s(x.techRoute),
        heavy: x.heavy === true,
      }))
      .filter((x) => x.name),
    customers: s(o.customers),
    website: domain(o.website),
    industry: s(o.industry),
    window: s(o.window) || DEFAULT_WINDOW,
    /*
     * **点名了外部主体的题一律不是自己家里的事。** 2026-09-06 ISS-233：同一道「首访维信诺怎么开」，
     * 相隔四十分钟被判成 `inward`（主体「本公司」），取证整段不跑、骨架不写，交了一份零证据的通用稿。
     * 「我们对它该怎么做」和「我们自己要怎么做」在提示词里靠语义分不稳，所以多要一栏
     * `externalSubject`：题目点名的外部公司或市场。它非空时 `inward` 在代码里落假，不由模型定。
     */
    inward,
    decision: !inward && o.decision === true,
  };
}

/**
 * 泛类目的下限。
 *
 * 由 footprint 导出的定义一定带方向（「正向高世代中尺寸扩张」），而「显示面板行业」
 * 这种五六个字的类目名不可能带。按长度判是粗的，但它拦得住那一类，而且**不会今天成立
 * 明天不成立** —— 换成关键词表的话，表上没有的泛类目照样过。
 */
const GENERIC_MAX = 11;

/** 名字和行业定义有没有共同的两字片段。中文没有词边界，两字够指认「V5」「8.6 代」这类。 */
export const shares = (name: string, industry: string): boolean => {
  for (let i = 0; i + 2 <= name.length; i += 1) {
    if (industry.includes(name.slice(i, i + 2))) return true;
  }
  return false;
};

/** 主体卡的缺口。空数组 = 这张卡能往下走。一条一句人话，直接进 trace 和打回理由。 */
export function cardGaps(card: SubjectCard): string[] {
  const gaps: string[] = [];
  if (!card.industry) gaps.push("没有行业定义 —— 这一轮的分析边界没定下来");
  else if (card.industry.length <= GENERIC_MAX) {
    gaps.push(
      `行业定义「${card.industry}」像一个泛类目：它要由主体 footprint 导出，既写现有主业也写战略投入方向`
    );
  }
  // 问的是自己家里的事时没有外部主体，业务构成本来就该是空的。
  if (!card.segments.length && !card.inward) gaps.push("业务构成是空的 —— 行业定义没有可导出的依据");
  for (const p of card.projects) {
    if (p.heavy && card.industry && !shares(p.name, card.industry)) {
      gaps.push(`在建项目「${p.name}」投资额过线却没进行业定义，这一轮的行业边界会漏掉它`);
    }
  }
  return gaps;
}

export const ANCHOR_SYSTEM = `你在给一次行业研究定边界。这一步的产物是一张主体卡。

## 这一步允许检索什么

只许检索**研究主体自己的一手材料**：最新年报与半年报、投资者关系材料、官网业务介绍、
最近四个季度的重大公告。**不做行业面检索** —— 行业里在发生什么由后面的节点去查，这一步
一旦搜进行业数据，行业边界就会被那几页碰巧讲的东西定死。

纯议题类研究（没有具体主体）不检索，直接给议题边界。

## 先答一个问题：题目里点名了外部主体吗

\`externalSubject\` = 题目里点名的外部公司、行业或市场（「维信诺」「显示面板行业」「灯塔客户」），
原样抄进去；一个都没点名就留空。**这一栏非空，这道题就不是自己家里的事，哪怕问的是「我们该
怎么做」** —— 有外部主体就有可查的一手材料。

## 然后分：自己家里的事 / 对外部主体的决策 / 外部主体的分析

\`inward\` 为真 = \`externalSubject\` 为空，且问的是**提问的这家公司自己**要怎么做：要记什么、怎么
设计、要不要做、先做哪个、怎么证明自己的某件事成了。答案在它自己的经营方式和数据里。为真时：
\`subject\` 写「本公司」，\`segments\` 与 \`projects\` 留空，\`industry\` 改写成一句这道题的边界。
\`externalSubject\` 非空的题一律为假。

\`decision\` 为真 = \`externalSubject\` 非空，且问的是**提问的这家公司对它该怎么做**：首访怎么开、
要不要合作、怎么报价、先推哪个、谈什么条件。答案是「要定什么、为什么、怎么做、怎么退」，行业分析
只是背景。主体卡照常填（\`subject\` 就是那个外部主体，一手材料照常查）—— 变的是后面草稿和成稿的
形状。问的是这个主体或行业本身会怎样的题为假（那是分析）。

## 交什么

一行 JSON：

{"subject":"","externalSubject":"","inward":false,"decision":false,
 "segments":[{"name":"","weight":"收入或战略权重","lifecycle":"现金流|成长|投入期"}],
 "projects":[{"name":"","investment":"","onlineAt":"","techRoute":"","heavy":true}],
 "customers":"","website":"官网域名，如 visionox.com","industry":"","window":""}

\`website\` 只写域名，不要写整条网址，也不要写「官网」两个字；查不到就留空。后面要拿它
直接去搜这家公司自己发的公告。

## 两条硬要求

1. \`industry\` 是一句话，必须**同时**写出现有主业和战略投入方向。禁止写泛类目 ——
   「显示面板行业」这种等于没定边界，要写成「柔性中小尺寸 AMOLED，正向高世代中尺寸扩张」
   这种。
2. \`heavy\` 标的是「这个在建项目的投资额占公司市值或净资产两成以上」。标了 true 的项目，
   它的名字必须能在 \`industry\` 里找到 —— 一笔押上两成身家的下注不在行业定义里，这次研究
   就会绕开它。`;

/**
 * `A4Input`（`prompt.ts:43`）**没有 `question` 这一栏**：议题的补充说明在 `scope`，预研的
 * 结论在 `preTake`，两者都可能是 null。深研不许从头再来一遍（`preTake` 的注释），所以预研
 * 有结论时要递进去 —— 但**不许因此跳过一手材料检索**：预研那一轮不读年报。
 */
export function buildAnchorUser(input: Pick<A4Input, "title" | "scope" | "preTake">): string {
  return [
    "## 研究问题",
    input.title,
    input.scope?.trim() ? `\n范围：${input.scope.trim()}` : "",
    input.preTake?.trim() ? `\n预研已有的结论（接着往下，不重来）：${input.preTake.trim()}` : "",
    "\n先识别研究主体，再按上面的形状交那一行 JSON。",
  ]
    .filter(Boolean)
    .join("\n");
}
