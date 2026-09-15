/**
 * N1 先验草稿。**这一节点是整条链路的内容主体，而且它不检索。**
 *
 * 上一版最贵的那个错误在这里被撤销：那一版要求每句话绑一个证据编号，等于把模型九成的
 * 价值扔掉，只留一个检索转述器 —— 于是 2 条证据撑不起结论时，它「正确地」输出了
 * 「不足以判断」。行业分析的骨架（固定成本结构、良率经营杠杆、世代线切割经济性、产能
 * 迁移史）**全部来自模型先验**，检索只是往骨架上补新数。
 *
 * 所以这里的规矩反过来了：先凭知识写完整、写出立场、全断言标 `[P]`；后面的证据只能
 * **更新**或**证伪**它，缺证据不构成删除理由，只构成标签降级理由（`[P]` → `[P!]`）。
 *
 * ## 为什么一行一节
 *
 * 一整份草稿塞进一个 JSON 字符串字段，两千多字中文转义一次，任何一处裸引号让整份 parse
 * 不出来（同 `blocks/schema.ts` 头部那一段）。一行一节之后坏掉的是**那一维**，别的七维
 * 照样读得出来，而缺的那一维会被 `draftGaps` 指名报出来。
 */

import { DIMENSIONS, DIM_IDS, isDimId, type DimId } from "./dims";
import type { SubjectCard } from "./anchor";
import {
  companyContextLines,
  premiseGaps,
  readPremise,
  readRoute,
  routeGaps,
  userPremiseLines,
  PREMISE_FIELDS,
  ROUTE_MAX,
  type Premise,
  type RouteOption,
  type UserPremise,
} from "./premise";

/**
 * 四态标签。
 *
 *  · `E*` 已验证：有独立外部证据支持。
 *  · `P`  先验：来自模型知识，未验证，非承重。行业常识、机制原理不强制验证。
 *  · `P!` 先验承重：未验证但结论依赖它。正文可用，但必须显式标出并进待核清单。
 *  · `X`  已证伪：证据与先验矛盾。它承重的论点必须重写，正文不许留它。
 */
export const TAGS = ["E*", "P", "P!", "X"] as const;
export type Tag = (typeof TAGS)[number];

export const CONFIDENCES = ["高", "中", "低"] as const;
export type DraftConfidence = (typeof CONFIDENCES)[number];

/**
 * 这条事实断言的**答案在谁手里**。
 *
 * ## 为什么分桶要发生在出题这一步
 *
 * 2026-09-07 的 ISS-240：那一轮 24 分 20 秒，报告正文只剩 1 块，取回来的 24 条证据一条都
 * 没被引用。覆盖表上五条「会改变路线」的关键问题清一色是「已搜未得｜试过 4 条问法，一条
 * 可用来源都没回来」—— 而它们问的是：对方集团层有没有独立的数字化中心、现有制造与经营
 * 系统栈的自研比例、IT 采购走不走集团招标、单笔立项的审批门槛。**这四件事外网本来就查
 * 不到，它们是首访当面问的事**，却各自吃掉了一轮取证的时间和一个抓取位子。
 *
 * 同一轮在另一头对称地错了一次：草稿要写的「我方已实现能力 / 可演示场景 / 承诺边界」，
 * 答案在**我们自己手里**（本体、产品说明），既不该让模型去猜，更不该变成一道检索题 ——
 * 猜出来的那一套，就是那份报告替我方许下「私有化部署、数据不出厂、知识产权归客户」的来路。
 *
 * 所以这一栏挂在**出题**上，不是搜完四轮空手之后再补的标签：搜之前就知道该不该搜它。
 *
 *  · `公开可查` —— 公告、年报、监管口径、行业惯例、可信媒体上查得到。**只有这一桶进检索计划。**
 *  · `要问对方` —— 只有对方内部知道：组织与权责、系统栈构成、采购流程与审批门槛、人事变动、
 *    预算。它进的是首访当面要问的清单，不是查询队列。
 *  · `在我方手里` —— 我方能力、可演示场景、承诺边界、授权边界。会前由我方内部确认；既不许
 *    去外网搜，也不许模型凭空断言。
 *
 * 它和 `Tag` 是两回事：`Tag` 说的是「这句话现在的可信状态」，这一栏说的是「谁能把它变成
 * 已验证」。两栏合并过一次的下场在上面那一段里。
 */
export const ANSWER_SOURCES = ["公开可查", "要问对方", "在我方手里"] as const;
export type AnswerSource = (typeof ANSWER_SOURCES)[number];

export type Assertion = {
  text: string;
  tag: Tag;
  confidence: DraftConfidence;
  /** 这个数在知识截止后可能已经变了（出货量、价格、份额、投产进度、政策）。 */
  timeSensitive: boolean;
  /** 承重：它被推翻时有论点跟着倒。N2 的优先级排序读它。 */
  loadBearing: boolean;
  /** 答案在谁手里（`ANSWER_SOURCES`）。判不出来落「公开可查」，理由在 `answerIn()` 上。 */
  answerIn: AnswerSource;
};

export type DraftSection = { dim: DimId; thesis: string; body: string; assertions: Assertion[] };

/**
 * 决策骨架的一段（`draft_playbook` 行）。**只在决策题上出现**（`SubjectCard.decision`）。
 *
 * 2026-09-05 加。R-11：Claude 在 ISS-231 的草稿里直接写了「首访议程 / 分角色沟通脚本 / 必须
 * 准备的三份材料 / 高风险问题与应答 / 首访禁区 / 成功判据 / 第二次会议的钩子」19 行，全部被
 * 判成「不认识的行类型」扔掉，再花 174 秒按 8 维重写。一号位要的那份东西在第 2 分钟就写出来了，
 * 链路把它删了。现在它是一种合法的行：`heading` 是这一段要定的事，`body` 是怎么做、为什么，
 * `assertions` 是它依赖的外部事实（和维度行同一个形状，N2 照样拿去排检索）。
 */
export type PlaybookEntry = { heading: string; body: string; assertions: Assertion[] };

/**
 * 后两栏是 2026-09-07（ISS-239）加的，语义和形状都在 `premise.ts` 上。
 *
 * **为什么是选填。** `parseDraft` 一定把它们填出来（哪怕是空数组），所以生产上它们恒有值；
 * 选填是给那些手写 `Draft` 字面量的地方留的（`gate.test.ts` / `pipeline.test.ts` /
 * `plan.test.ts` 里的夹具）—— 这两栏跟它们要测的东西无关，改成必填只会让别人的文件跟着红。
 * 读的时候一律 `?? []`。
 */
export type Draft = {
  thesis: string;
  sections: DraftSection[];
  unknowns: string[];
  playbook: PlaybookEntry[];
  /** 结构化前提（决策题）。N4 按 ID 更新，N5 只许从更新后的那份写承诺。 */
  premises?: Premise[];
  /** 候选路线，至多 `ROUTE_MAX` 条。ID 稳定，N4 逐条对账。 */
  routes?: RouteOption[];
};

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v : []).map(s).filter(Boolean);
const FENCE = /^```[a-zA-Z]*$/;

const tag = (v: unknown): Tag => ((TAGS as readonly string[]).includes(s(v)) ? (s(v) as Tag) : "P");
const conf = (v: unknown): DraftConfidence =>
  (CONFIDENCES as readonly string[]).includes(s(v)) ? (s(v) as DraftConfidence) : "中";

/**
 * 答案归属。**认不出的一律落「公开可查」。这个默认值是挑出来的，不是随手挑的。**
 *
 * 三桶的下游完全不同：只有「公开可查」进检索计划，另外两桶分别进首访要问的清单和会前的
 * 我方内部确认。所以两种落错的代价不对称 ——
 *
 *  · 落错到「公开可查」：代价是白花一次检索（一条查询、几秒、一个抓取位子）。
 *  · 落错到另外两桶：代价是这条事实**从此没有人去查** —— 它既不会进查询队列，也不会真的
 *    有人拿着首访清单去问一条模型顺手编出来的问题。
 *
 * 一边可恢复、一边不可恢复，所以判不出来的时候宁可多搜一次。
 */
const answerIn = (v: unknown): AnswerSource =>
  (ANSWER_SOURCES as readonly string[]).includes(s(v)) ? (s(v) as AnswerSource) : "公开可查";

/**
 * 这条断言的四元标注模型是不是真填了。**填没填要分得出**：默认值和「写了中档」长得一样。
 *
 * 2026-09-07（ISS-240）把 `answerIn` 也算进来。它非算不可的理由和别的三样不同：它的默认值
 * 恰恰是最贵的那一个 —— 不算进标注率，模型整份少填这一栏一声不响，而所有断言会因此落进
 * 「公开可查」、全部排进检索计划，那正是 ISS-240 那一轮的样子（24 条证据零引用）。
 */
const annotated = (o: Record<string, unknown>): boolean =>
  (TAGS as readonly string[]).includes(s(o.tag)) &&
  (CONFIDENCES as readonly string[]).includes(s(o.confidence)) &&
  typeof o.timeSensitive === "boolean" &&
  (ANSWER_SOURCES as readonly string[]).includes(s(o.answerIn));

function readAssertions(v: unknown): { list: Assertion[]; annotated: number } {
  const raw = (Array.isArray(v) ? v : []).filter(
    (x): x is Record<string, unknown> => !!x && typeof x === "object"
  );
  const list = raw
    .map((o) => ({
      text: s(o.text),
      tag: tag(o.tag),
      confidence: conf(o.confidence),
      timeSensitive: o.timeSensitive === true,
      loadBearing: o.loadBearing === true,
      answerIn: answerIn(o.answerIn),
    }))
    .filter((a) => a.text);
  return { list, annotated: raw.filter(annotated).length };
}

/** 解析出来的同时记一笔标注率 —— 机检要它，而它算完就没地方存了。 */
const rates = new WeakMap<Draft, { assertions: number; annotated: number }>();

/**
 * 读一份草稿。三种行：`draft_meta`（总判断）、`draft_section`（一维一行）、
 * `draft_unknowns`（我知道我不知道的）。围栏和空行跳过，别的坏行留账。
 */
export function parseDraft(text: string): { draft: Draft; bad: { line: number; why: string }[] } {
  const draft: Draft = { thesis: "", sections: [], unknowns: [], playbook: [], premises: [], routes: [] };
  const bad: { line: number; why: string }[] = [];
  let total = 0;
  let ann = 0;
  /*
   * 前提和路线**共用一个 ID 命名空间**：路线的 `dependsOn` 引的是前提 ID，N4 的更新引的是
   * 路线 ID，两边同名一次，对账就不知道那一条说的是谁。重号的那一条整条拒并留账。
   */
  const seenIds = new Set<string>();

  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || FENCE.test(line)) return;
    let o: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("不是一个对象");
      o = parsed as Record<string, unknown>;
    } catch (e) {
      bad.push({ line: i + 1, why: e instanceof Error ? e.message : "读不出来" });
      return;
    }
    switch (s(o.type)) {
      case "draft_meta":
        draft.thesis = s(o.thesis);
        return;
      case "draft_unknowns":
        draft.unknowns = strs(o.items);
        return;
      case "draft_section": {
        const dim = s(o.dim);
        if (!isDimId(dim)) {
          bad.push({ line: i + 1, why: `不认识的维度编号「${dim.slice(0, 8)}」` });
          return;
        }
        const a = readAssertions(o.assertions);
        total += a.list.length;
        ann += a.annotated;
        draft.sections.push({ dim, thesis: s(o.thesis), body: s(o.body), assertions: a.list });
        return;
      }
      case "draft_playbook": {
        const heading = s(o.heading);
        if (!heading) {
          bad.push({ line: i + 1, why: "决策骨架这一行没有 heading" });
          return;
        }
        const a = readAssertions(o.assertions);
        total += a.list.length;
        ann += a.annotated;
        draft.playbook.push({ heading, body: s(o.body), assertions: a.list });
        return;
      }
      /*
       * 前提与候选路线（2026-09-07，ISS-239）。解析全在 `premise.ts` —— N4 读回自己的更新时
       * 要用同一套规矩，两处各写一遍就会在「什么叫站不住」上分叉。
       *
       * 拒掉的那一条进 `bad`，和坏 JSON 走同一条账：这两种行是 N4/N5 的输入，静默少一条，
       * 表现是成稿里少比较了一条路，而屏幕上什么也不会说。
       */
      case "draft_premise": {
        const r = readPremise(o, seenIds);
        if (!r.ok) bad.push({ line: i + 1, why: r.why });
        else draft.premises?.push(r.value);
        return;
      }
      case "draft_route": {
        const r = readRoute(o, seenIds);
        if (!r.ok) bad.push({ line: i + 1, why: r.why });
        else draft.routes?.push(r.value);
        return;
      }
      default:
        bad.push({ line: i + 1, why: `不认识的行类型「${s(o.type).slice(0, 20)}」` });
    }
  });

  rates.set(draft, { assertions: total, annotated: ann });
  return { draft, bad };
}

/** 总判断的字数上限（§N1 验收）。 */
const THESIS_MAX = 150;
/**
 * 骑墙话。有它就是没给立场 —— 而这一步的产物如果没有立场，后面的节点没有可验证的东西。
 *
 * **2026-08-31 补进后四条。** 前五条拦不住 `RUN-A4-mth5jkf0-6` 那一份：它的总判断写的是
 * 「尚不能判断自顶向下与执行层切入哪一条更容易产出成功案例」—— 一句标准的弃权，而这道闸
 * 一声没响。同一批还有「暂时无法判断」「有待进一步研究」「难以判断」，都是同一个动作的
 * 不同写法。
 *
 * 这张表是**按写法列的，不是按语义判的**，所以它必然漏。漏了的表现不是报错，是一份读起来
 * 很稳、其实什么也没说的报告 —— 再遇到一种新写法就补进来，别在调用处各写一个正则。
 */
export const HEDGES = [
  "有待观察",
  "喜忧参半",
  "尚难判断",
  "还需进一步",
  "各有利弊",
  "尚不能判断",
  "无法判断",
  "有待进一步",
  "难以判断",
];
/** 断言标注率下限。 */
const ANNOTATION_FLOOR = 0.9;

/**
 * ## 2026-09-07（ISS-240）减重：下面这三个数各降一档
 *
 * 那一轮 N1 的**第一次调用撞了 420 秒墙钟，一个字都没交出来** —— trace 里是 `ms: 420016`
 * 加一段网关超时原文，不是额度用完，也不是交回来一份空 JSON。紧接着的补正那一次，**同一份
 * 契约 204 秒就交完了**。所以契约装得下，坏的是方差；而在不删下游要用的字段的前提下，能压
 * 方差的只有一件事：要写的字少一点。
 *
 * 结构一个都没动（`draft_premise` / `draft_route` / `draft_playbook` 三种行、五栏前提、
 * 至多三条路线照旧），动的只有篇幅上的三个数：
 *
 *  · `BODY_MAX` 200 → 150 字。这一栏**不进正文** —— 成稿那一步会照着证据整段重写（下面
 *    「这是骨架，不是报告」那一节），所以它多写的每个字都是纯成本。
 *  · 每维断言 5–7 → 4–6 条。行业题上 N2 每维只取 2 条去排命题
 *    （`maxPerDimFor(INDUSTRY_SCOPE, 16) === 2`，`plan.test.ts` 里钉着这个数），第 6、7 条
 *    从来没有被检索过；三桶分完之后「公开可查」那一桶还要再小一圈，6 条仍然远超下游取得走的量。
 *  · `UNKNOWNS_FLOOR` 5 → 4。会改变路线的那几条现在有了正式去处（「要问对方」那一桶），
 *    这一栏不再是它们唯一的容器；而它是 `worth` 认都不认的账面缺口（`pipeline.ts` 只认
 *    「没有总判断 / 决策骨架 0 段 / 两维以上空掉」），补回来的东西本来也不进报告。
 *
 * 这三个数同时进提示词和这道闸（下面 `DRAFT_SYSTEM` 直接插值），省得两处各写一遍再分叉。
 */
const BODY_MAX = 150;
const ASSERTIONS_MIN = 4;
const ASSERTIONS_MAX = 6;
/** 「我知道我不知道的」下限。 */
const UNKNOWNS_FLOOR = 4;

/** 决策题的骨架至少几段。少于它成稿没有可用的行动骨架。 */
const PLAYBOOK_FLOOR = 3;

/**
 * 决策题的草稿只写这三维。
 *
 * 2026-09-07（批 V §3）。草稿是这条链里最长的一段（Claude 3.5–5.5 分钟），而决策题上它写的
 * 八维里有五维**没有一个下游会读**：成稿形状里八维「只作背景，合并稿里那几维只在支撑某件要
 * 定的事时引一句」（`prompt.ts` 的 `DECISION_SHAPE`），命题又优先从主体卡确定性生成
 * （`card-props.ts`）。也就是说 D1/D4/D5/D6/D7 那五段写完之后，只被自己重读了一遍。
 *
 * 留下的三维各有下游：D2 供给端（对方的产线与在建项目 = 这次要谈的标的）、D3 技术路线
 * （我们能接上哪一段）、D8 对主体的含义（要盯的那几个指标，决策骨架直接踩在它上面）。
 *
 * **这一条单独一次提交、单独实测**：它碰的是内容不是形状，减掉的那五段有没有在别处被需要，
 * 只有同题对照看得出来。看坏了就把这张表删掉，别的都不用动。
 */
const DECISION_DIMS: readonly DimId[] = ["D2", "D3", "D8"];

/**
 * 草稿的缺口。空数组 = 可以进 N2。`decision` 为真时另查决策骨架、结构化前提和候选路线
 * （`SubjectCard.decision`）。
 *
 * `corpus` 是这一轮**真实输入的原文**（题目 + 公司上下文 + 一号位给的前提），给了才能查
 * 「前提里引的那句原话是不是编的」（`premiseGaps`）。不给不报那一项，不假装查过。
 */
export function draftGaps(draft: Draft, o: { decision?: boolean; corpus?: string } = {}): string[] {
  const gaps: string[] = [];

  if (o.decision && draft.playbook.length < PLAYBOOK_FLOOR) {
    gaps.push(
      `这道题要的是一个决策，决策骨架（draft_playbook）只有 ${draft.playbook.length} 段，不足 ${PLAYBOOK_FLOOR} 段`
    );
  }

  /*
   * 前提与路线只在决策题上要求。行业题上那五栏（我方能力/可演示/承诺边界/接触对象/此次目标）
   * 问的不是这道题 —— 在那种题上报这五条缺口，等于每一轮都挂五条读了也不用管的账。
   */
  if (o.decision) {
    gaps.push(...premiseGaps(draft.premises ?? [], o.corpus ? { corpus: o.corpus } : {}));
    gaps.push(...routeGaps(draft.routes ?? [], draft.premises ?? []));
  }

  if (!draft.thesis) gaps.push("开头没有总判断");
  else {
    if (draft.thesis.replace(/\s/g, "").length > THESIS_MAX) {
      gaps.push(`总判断 ${draft.thesis.replace(/\s/g, "").length} 字，超过 ${THESIS_MAX} 字`);
    }
    const hedge = HEDGES.find((h) => draft.thesis.includes(h));
    if (hedge) gaps.push(`总判断在骑墙（「${hedge}」）—— 它要是一句能被证据推翻的判断句`);
  }

  /*
   * 决策题只要那三维（`DECISION_DIMS`）。**放宽的是要求，不是检查** —— 少写的那五维
   * 照旧一条条报，只是不再报「没写就是缺口」。多写了不拦：模型自己觉得某一维要紧时
   * 写出来的那一段是它的判断，拦掉等于用格式压判断。
   */
  const want = o.decision ? DECISION_DIMS : DIM_IDS;
  const have = new Set(draft.sections.map((x) => x.dim));
  for (const dim of want) if (!have.has(dim)) gaps.push(`${dim} 这一维没有内容`);
  for (const sec of draft.sections) {
    if (!sec.thesis) gaps.push(`${sec.dim} 没有论点 —— 每一维要落到一句能被推翻的话上`);
    if (!sec.body) gaps.push(`${sec.dim} 只有论点没有机制`);
  }

  if (draft.unknowns.length < UNKNOWNS_FLOOR) {
    gaps.push(`「我知道我不知道的」只有 ${draft.unknowns.length} 条，不足 ${UNKNOWNS_FLOOR} 条`);
  }

  const r = rates.get(draft);
  if (r && r.assertions && r.annotated / r.assertions < ANNOTATION_FLOOR) {
    gaps.push(
      `${r.assertions} 条断言里只有 ${r.annotated} 条带完整标注（标签+置信度+时效+答案在谁手里），不足九成`
    );
  }
  return gaps;
}

export const DRAFT_SYSTEM = `你是行业研究员。现在**不检索**，只凭你已有的知识和递给你的主体卡，
写一份完整的行业宏观分析草稿。

## 你的知识就是这份分析的骨架

不留白。你的知识截止之后可能过期的数字**照写**，标上「时效敏感」就行；后面会有专门的节点
拿外部材料来更新或推翻它们。写「资料不足无法判断」是这一步唯一不可接受的答法 —— 那句话
把该由你回答的问题推给了检索。

## 一行一节，交 JSONL

第一行总判断：
{"type":"draft_meta","thesis":"≤150 字，一句能被证据推翻的判断句"}

然后每个维度一行：
{"type":"draft_section","dim":"D1","thesis":"这一维的论点，一句话，可被证据推翻",
 "body":"机制：为什么会这样，因果链写透。这一栏是正文的主体",
 "assertions":[{"text":"事实断言原文","tag":"P","confidence":"高|中|低",
   "timeSensitive":true,"loadBearing":true,"answerIn":"公开可查|要问对方|在我方手里"}]}

最后一行：
{"type":"draft_unknowns","items":["你的知识覆盖不到、但会改变结论的数据点，≥${UNKNOWNS_FLOOR} 条"]}

## 每条事实断言先分桶：这个答案在谁手里

\`answerIn\` 三选一。它不是给人看的标签，它决定这条断言接下来**由谁去回答**：

· **公开可查** —— 公告、年报、监管口径、行业惯例、可信媒体上查得到。**只有这一桶会进
  检索计划**，也只有这一桶会被联网取证。
· **要问对方** —— 只有对方内部才知道的事：组织与权责、系统栈构成、采购流程与审批门槛、
  人事变动、预算盘子。这一桶**不搜**，它进的是首访当面要问的清单。
· **在我方手里** —— 我方已实现能力、可演示场景、承诺边界、授权边界。这一桶**既不搜也不猜**，
  会前由我方内部照材料确认。

判据是「谁知道这件事」，不是「这件事重不重要」。举一个最容易分错的：
「对方的 IT 采购要不要走集团招标」是**要问对方**，不是公开可查 —— 采购制度不写在公告和
年报里，换四种问法去搜，回来的仍然是零条可用来源。反过来「对方去年的资本开支」是**公开
可查**，因为它在年报上。同理：「对方集团层有没有独立的数字化中心」「现有系统栈的自研
比例」「单笔立项的审批门槛」全是**要问对方**。

**判不出来的一律填「公开可查」。** 两种错的代价不对称：错填「公开可查」，代价是白花一次
检索；错填另外两桶，代价是这条事实**从此没有人去查**（那两桶都不进检索计划）。

## 篇幅：这是骨架，不是报告

**这一份不会被任何人原样读到。** 它的全部用处是让下一步挑出「该拿外部材料去核哪几条」，
以及给成稿那一步一份对完账的底子 —— 正文到那一步会照着证据重写一遍。

所以：每一维的 \`body\` **控制在 ${BODY_MAX} 字以内**，只写机制和因果链的骨头，不铺开、
不举例、不复述已经写在 \`assertions\` 里的数字。省下来的时间会花在联网取证上，而那才是
这份报告真正值钱的地方。

**\`assertions\` 每一维写 ${ASSERTIONS_MIN} 到 ${ASSERTIONS_MAX} 条，按「最该拿外部材料去核」从高到低排。** 排序的依据是
承重度 × 时效敏感度 ÷ 置信度：会被外部数据推翻、推翻了又有论点跟着倒的那几条排前面；
机制类、结构类的（成本结构、经营杠杆、切割经济性）本来就不靠检索验证，不必占名额。

**多写一条不会让这一轮多查一条。** 下一步每维只取前几条去排检索计划，而且**只从「公开
可查」那一桶里取**；多出来的那条不会被检索、也不会进报告 —— 它只花掉这一轮的时间，而
时间是和联网取证共用的。所以这几条的价值全在**分桶、排序和标注**（\`answerIn\` /
\`confidence\` / \`timeSensitive\` / \`loadBearing\`）准不准，不在条数。

## 四条硬要求

1. 总判断和每一维的论点都必须是判断句。「有待观察」「喜忧参半」这类骑墙表述一律不算。
2. 每条事实断言都要标全四样：\`tag\`（这一步一律 \`P\`）、\`confidence\`、\`timeSensitive\`、
   \`answerIn\`。\`timeSensitive\` 为真 = 这个数在你的知识截止后可能已经变了（出货量、价格、份额、投产
   进度、政策）；为假 = 机制与结构性事实（成本结构、经营杠杆、切割经济性这类）。
3. \`loadBearing\` 标的是「它被推翻时有论点跟着倒」。标得准，后面的检索预算才花在该花的地方。
4. 最后那份「我知道我不知道的」要具体到数据点，不是「缺最新数据」这种笼统话。`;

/**
 * 在版判断按认知状态分的三栏。
 *
 * ## 为什么这一段在 user 里，不在 `DRAFT_SYSTEM` 里
 *
 * 它**常常是空的**（图里没这条议题、或者这条议题还没挂上判断）。写进静态 system 就得写成
 * 「如果下面给了判断……」，而条件句写在 system 里，模型读到的是一条随时可能不适用的规矩。
 * 用法紧挨着数据，给了才出现，没给整段不出现。
 *
 * ## 为什么要封顶
 *
 * N1 的输出额度是**含思考的**（`DRAFT_MAX_TOKENS`）。输入长了，模型想得更久，正文被挤掉，
 * 而失败方式是静默的 —— 2026-08-31 在 N2 上真发生过一次：思考吃掉九成额度，命题归零，
 * N3 整段被跳过，这一轮照旧报 ok。所以这一段每栏五条、每条 80 字，硬上限。
 */
const PREMISE_PER_BUCKET = 5;
const PREMISE_CHARS = 80;

/** 状态的中文。**认不出的一律进「该查的」那一栏** —— 落到前提栏等于把一个来路不明的
 *  状态悄悄升成公司口径，而那一栏的意思是「这一步不许再论证」。 */
const STANDING_CN: Record<string, string> = {
  confirmed: "已确认",
  unverified: "未验证",
  shaking: "正在动摇",
  dropped: "已放弃",
};

const premiseLines = (
  list: readonly { id: string; statement: string; standing: string }[],
  withStanding: boolean
): string[] => {
  const shown = list.slice(0, PREMISE_PER_BUCKET).map((j) => {
    const text =
      j.statement.length > PREMISE_CHARS ? `${j.statement.slice(0, PREMISE_CHARS)}…` : j.statement;
    return `- ${j.id}${withStanding ? `（${STANDING_CN[j.standing] ?? j.standing}）` : ""}：${text}`;
  });
  const rest = list.length - shown.length;
  if (rest > 0) shown.push(`- （另有 ${rest} 条未列出）`);
  return shown;
};

export function premiseBlock(
  judgments: readonly { id: string; statement: string; standing: string }[]
): string[] {
  if (!judgments.length) return [];
  const settled = judgments.filter((j) => j.standing === "confirmed");
  const dropped = judgments.filter((j) => j.standing === "dropped");
  const doubt = judgments.filter((j) => j.standing !== "confirmed" && j.standing !== "dropped");

  const parts = ["\n## 公司已经有的判断"];
  if (settled.length) {
    parts.push(
      "\n【已确认的口径】当前提用，**不要在这一步再论证一遍**。后面证据与它冲突时，对账那一步会显式处理。",
      ...premiseLines(settled, false)
    );
  }
  if (doubt.length) {
    parts.push(
      "\n【公司自己也没把握的】**这几条正是这一轮该查的**：每条都要落成 `assertions` 里的一条，" +
        "`loadBearing` 标真 —— 公司押着它，它倒了有论点跟着倒。",
      ...premiseLines(doubt, true)
    );
  }
  if (dropped.length) {
    parts.push("\n【已经放弃的方向】不要在草稿里重新推荐它们。", ...premiseLines(dropped, false));
  }
  return parts;
}

export function buildDraftUser(o: {
  title: string;
  card: SubjectCard;
  /**
   * 这条议题正在动摇的在版判断。**给了才出现。**
   *
   * 加这一栏是因为这一步原来只看得见标题和主体卡：公司已经押了哪些注、哪几条正在动摇，
   * 全都要到 N5 写报告那一刻才第一次出现（`prompt.ts` 的 `buildA4Material`）。而命题是从
   * 这份草稿里抽的（N2 只收 draft），所以「公司已知的事」对**这一轮去查什么**零影响。
   *
   * 它不违反这一步「不检索」那条规矩：**前提不是检索结果**。
   */
  judgments?: readonly { id: string; statement: string; standing: string }[];
  /**
   * 公司上下文（`Harness.contextBlock`）。**给了才出现，没给出现的是「这一轮没有我方材料」那一句。**
   *
   * 2026-09-07（ISS-239）加。原来它到 N5 写报告那一刻才第一次出现（`prompt.ts` 的
   * `buildA4Material`），于是 N1 在完全不知道我方是干什么的情况下写「我们对它该怎么做」，
   * 而那一步正是候选路线和决策骨架的出生地 —— 后面几步改的是措辞，改不动它挑的那条路。
   *
   * 它不违反这一步「不检索」那条规矩：**公司上下文不是检索结果**，同在版判断那一栏。
   */
  companyContext?: string;
  /**
   * 一号位在提问里明确给出的前提（预研抽的 `PreResearchPremise` 形状：一句话 + 原话）。
   *
   * **来源身份保留在 `standing:"用户提供"` 上。** 它不因为进了这一步就变成外部已核实事实，
   * 也不写进本体 —— 那是另一件事，而且是一件不可逆的事。
   */
  userPremises?: readonly UserPremise[];
}): string {
  const c = o.card;
  return [
    "## 研究问题",
    o.title,
    ...companyContextLines(o.companyContext),
    ...userPremiseLines(o.userPremises ?? []),
    ...premiseBlock(o.judgments ?? []),
    "\n## 主体卡",
    `主体：${c.subject || ""}`,
    `行业定义：${c.industry || ""}`,
    `业务构成：${(c.segments || []).map((x) => `${x.name}（${x.weight}，${x.lifecycle}）`).join("；") || "（未给）"}`,
    `在建与战略项目：${
      (c.projects || [])
        .map((p) => `${p.name}（${p.investment}，${p.onlineAt} 投产，${p.techRoute}${p.heavy ? "，权重过线" : ""}）`)
        .join("；") || "（未给）"
    }`,
    `客户结构：${c.customers || "（未给）"}`,
    `分析时间窗：${c.window || ""}`,
    ...(c.decision
      ? [
          "\n## 这道题要的是一个决策，不是一份行业分析",
          "主体是外面那家公司或那个市场，但问的是**我们对它该怎么做**。所以这道题**只写下面列出的那三维**（它们是背景，每维的 `body` 可以短到 80 字），别的维度一个都不要写，" +
            "这份草稿的主体是**双方背景 → 候选路线 → 决策骨架**这三段，都排在那三维之后、「我知道我不知道的」之前。",

          /*
           * 前提这一段是 2026-09-07 加的（ISS-239）。那一轮报告把首访锁死成 G6/ViP 产线验收，
           * 而当轮公司上下文只说明我方是一套经营系统 —— 「客户问题 → 我方**已实现**能力 →
           * 可演示价值 → 接触对象」这条链一次都没被写下来，于是「大概能做」和「已经能做」在
           * 后面几步里长得一模一样。字段语义在 `premise.ts`。
           */
          "\n### 第一段：把双方的背景摊成结构化前提（`draft_premise`，每条一行）",
          `${PREMISE_FIELDS.map((f) => `「${f}」`).join("、")}这五栏**一栏都不许缺**。`,
          /*
           * 这一句是三桶（`ANSWER_SOURCES`）在前提这一段的落点。这五栏问的几乎全是「答案在
           * 我方手里」那一桶的事，而 ISS-240 那一轮的错法正是把它们当成了可以推理出来的东西：
           * 我方能力、可演示场景、承诺边界三栏全靠猜补齐，然后被下游当成已经核过的事实。
           */
          "这五栏的答案基本都**在我方手里**（我方能力、可演示什么、能承诺什么、认识谁、这次要拿到什么），" +
            "所以它们**一条都不进检索计划**：写得出来的照材料写，写不出来的写「未知」等会前内部确认。**不许推理，也不许折中成一句好听的话。**",
          '{"type":"draft_premise","id":"P1（短、无空格，后面每一步都按它引这条）","field":"上面五栏之一","statement":"这一条前提本身；不知道就写「未知」","source":"引真实输入：一号位提问的原话（用「」引起来）或公司材料里的那一段","standing":"用户提供|材料记载|推测|未知","stage":"当前已实现|规划中|未知（只有能力那两栏要，别的栏不写）"}',
          "三条硬规矩：",
          "1. **不知道就显式写一条「未知」**，不要跳过那一栏。空着的栏，后面几步只能猜，而猜出来的东西读起来和查出来的一模一样。",
          "2. **规划中的能力不许写成当前已实现。** 材料没说我们做得了某件具体的事，就既不是「有」也不是「没有」，是「未知」。" +
            "承诺边界那一栏尤其：没有依据的部署方式、数据归属、知识产权口径，一个字都不要往外承诺。",
          "3. `source` 只能引**上面真给了你的东西**。引不到就把 `standing` 标成「推测」，不要编一句原话出来。一号位给的前提身份是「用户提供」，它是研究前提，不是已经核过的外部事实。",

          "\n### 第二段：候选路线（`draft_route`，每条一行，**至多 " + ROUTE_MAX + " 条**）",
          '{"type":"draft_route","id":"R1","claim":"这条路线主张做的那件事，一句判断","fit":"它踩在我方哪几条已实现能力上","clientCondition":"对方要满足什么，这条才成立","payoff":"走通了拿到什么","dependsOn":["P1","P3"],"switchWhen":"看到什么就该改走别的路"}',
          `**${ROUTE_MAX} 条是上限不是指标：实质不同的只有两条就交两条，一条就交一条。** 凑数编出来的那一条，后面每一步都会当真去核、去比较、去写进正文。` +
            "路线之间要**实质不同**（换一个接触对象、换一种价值主张、换一个先后次序才算不同；同一件事换个说法不算）。",
          /*
           * `fit` 是「在我方手里」那一桶在候选路线上的出口。ISS-240 的报告里出现了替我方许下的
           * 「私有化部署、数据不出厂、知识产权归客户」—— 公司上下文里没有任何依据，它是在这一栏
           * 和决策骨架里被第一次写出来的。所以这里只许**引**上面那一段已经写下来的前提，不许现编：
           * 关于我方的话在这一步只有一个合法来源，就是 `draft_premise`。
           */
          "`fit` 只能引上面 `draft_premise` 里已经写下来的前提，按 ID 引，并且写清引的是哪一条；" +
            "**关于我方的话（我们做得了什么、能演示什么、能承诺什么）在这一段里不许第一次出现。** " +
            "上面那条前提标着「规划中」或「未知」的，这里就只能写成条件式，不能当作现在就能交付。",
          "证据不足**不是**交白卷的理由：「先用一次低成本的问题澄清把最要紧的那个未知问掉」本身就可以是一条合法路线，写清它要问到什么、问到之后怎么分岔。" +
            "但不许把每一条缺证据的题都写成一句「无法判断」。",

          "\n### 第三段：决策骨架（`draft_playbook`，3 到 6 行）",
          `{"type":"draft_playbook","heading":"要定的一件事（一句判断，不是类目名）","body":"怎么做、为什么这么做、做错了怎么退，≤${BODY_MAX} 字","assertions":[{"text":"这一段依赖的外部事实","tag":"P","confidence":"高|中|低","timeSensitive":true,"loadBearing":true,"answerIn":"公开可查|要问对方|在我方手里"}]}`,
          "骨架按一号位要拍板的顺序排：第一段是他必须先定的那件事。每段的 `assertions` 只写它依赖的**外部**事实（对方的产线、人事、窗口、条款），我们自己的意图不算事实。",
          /*
           * 决策骨架是 ISS-240 里那三句承诺（私有化部署、数据不出厂、知识产权归客户）真正落地的
           * 地方 —— 「怎么做」写着写着就把我方还没有的东西写成了已经能给的东西。所以这一段和 `fit`
           * 收同一道口子：承诺类的话只有一个来源，就是上面那条「承诺边界」前提。
           */
          "**承诺类的口径（部署方式、数据归属、知识产权、服务边界、价格）只能照抄上面「承诺边界」那条前提。** 那条写着「未知」，这里就一个字都不许承诺 —— 写成「这一条会前要先定下来」。",
          "每段的 `assertions` 照样标 `answerIn`：对方的组织、系统栈、采购流程、审批门槛标「要问对方」（那是首访当面问的事，不是检索题），只有公告年报上真查得到的才标「公开可查」。",
        ]
      : []),
    ...(c.inward
      ? [
          "\n## 这道题问的是我们自己",
          "主体是提问的这家公司自己（公司层上下文里那一家），不是外部的某个行业或厂商。答案在它自己的经营方式和数据里。",
          "八个维度按这道题本身最要紧的八个角度写，维度名只是编号；不要引入外部厂商、市场规模、行业格局、采购趋势、第三方报告这类内容，除非题目问的就是它们。",
          "断言写成能被公司内部的数据或记录推翻的句子；「我知道我不知道的」列的是公司内部还没建起来的那几样记录，不是外部数据点。",
        ]
      : []),
    "\n## 维度框架",
    // 决策题只列三维（`DECISION_DIMS`，理由整段在它自己那条注释上）。**列出来的就是要写的**：
    // 把八维全列出来再说「只写三维」，交回来的一定是八维。
    ...DIMENSIONS.filter((d) => !c.decision || DECISION_DIMS.includes(d.id)).map(
      (d) => `${d.id} ${d.name}：${d.brief}`
    ),
    c.decision
      ? "\n上面这三维一个都不许省，也不要写别的维度。按上面的形状交 JSONL。"
      : "\n八个维度一个都不许省。按上面的形状交 JSONL。",
  ].join("\n");
}
