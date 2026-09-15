/**
 * N1 的**结构化前提**与**候选路线**：类型、解析、机检、以及往后几步的渲染。
 *
 * ## 为什么单独一个文件，而不是塞进 `draft.ts`
 *
 * 这两样东西是 N1 生产、**N4 和 N5 消费**的：N4 要按路线 ID 逐条更新（保留/收窄/改向/
 * 待验证/放弃），N5 只能从更新后的那份生成主张。三个节点共用同一份类型和同一个解析器
 * 才谈得上「同一条路线」；各写各的，ID 对不上，对账那一步就退化成又写一遍。
 * `draft.ts` 只留提示词和它自己那几种行（`draft_meta` / `draft_section` / `draft_unknowns`
 * / `draft_playbook`）的解析。
 *
 * ## 这是运行内的对象，不是知识库
 *
 * 前提**不写进本体**，也不跨运行保存。ISS-239（2026-09-07）那一轮报告把首访锁死成
 * G6/ViP 产线验收，而当轮 791 字公司上下文只说明 TKOS 是企业经营系统 —— 它没有证明
 * TKOS 能做工艺缺陷分析、历史数据离线复现、良率优化，也没有证明不能。缺的是「客户问题 →
 * 我方**已实现**能力 → 可演示价值 → 接触对象」这条链在**这一轮之内**被显式写下来、被后面
 * 几步引用。把它升级成全局知识库是另一件事，而且会把「一号位说的」变成「公司已核实的」。
 *
 * ## 三条不许松的规矩
 *
 * 1. **来源身份保留。** 一号位在提问里给的事实是「用户提供」，不因为进了这份结构就变成
 *    「外部已核实」。`PREMISE_STANDINGS` 里根本没有「已验证」这一档 —— 那一档只有 N4
 *    拿到外部证据之后才谈得上，而它记在证据那边，不回填到这里。
 * 2. **规划不等于已实现。** 能力栏另带一个 `stage`，认不出的一律落「未知」，绝不落
 *    「当前已实现」（`readPremise` 里那一行）。把规划中的能力读成当前能力，就是 ISS-239
 *    那份报告让团队主动承诺内网私有部署、数据不出厂、知识资产归客户的那条路。
 * 3. **没有的字段显式写「未知」。** 五栏一栏都不许缺 —— 留空的那一栏，下游只能猜，而它
 *    猜出来的东西读起来和查出来的一模一样。
 */

import { NO_COMPANY_CONTEXT } from "@/lib/agent/prompts";
// 只取类型。`draft.ts` 运行时依赖这个文件，反过来再拿值就成环了；三桶的定义留在断言那一头
// （它是断言的一栏），这里只借它的字面量类型把「哪一栏天然属于哪一桶」钉住。
import type { AnswerSource } from "./draft";

/* -------------------------------------------------------------------------- */
/* 类型                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 一条前提的来源身份。**这四档全都不是「已核实」**：
 *
 *  · `用户提供`：一号位在提问、范围或预研前提里明确说的。是研究前提，不是外部事实。
 *  · `材料记载`：公司上下文（本体那一段）里写着的。
 *  · `推测`：模型按常识补的。正文里必须能看出它是补的。
 *  · `未知`：这一栏问过了，答案是不知道 —— 和「没写」要分得开。
 */
export const PREMISE_STANDINGS = ["用户提供", "材料记载", "推测", "未知"] as const;
export type PremiseStanding = (typeof PREMISE_STANDINGS)[number];

/** 能力的两态加一个不知道。**只有能力栏有这一栏。** */
export const CAPABILITY_STAGES = ["当前已实现", "规划中", "未知"] as const;
export type CapabilityStage = (typeof CAPABILITY_STAGES)[number];

/**
 * 必须被回答的五栏。缺一栏，「客户问题 → 我方能力 → 可演示价值 → 接触对象」这条链就断在那里。
 *
 * 顺序是有意的：先说我们**现在**能干什么，再说其中哪些能当场演示，再说哪些事不许承诺，
 * 然后才是找谁谈、这次要拿到什么。反过来排（先定目标再找能力）就是先有结论后有论证。
 */
export const PREMISE_FIELDS = [
  "我方已实现能力",
  "可演示场景",
  "承诺边界",
  "客户关系与接触对象",
  "此次目标",
] as const;
export type PremiseField = (typeof PREMISE_FIELDS)[number];

/** 这两栏说的是「我们能干什么」，所以要分当前与规划。别的三栏 `stage` 恒为 null。 */
export const CAPABILITY_FIELDS: readonly PremiseField[] = ["我方已实现能力", "可演示场景"];

/**
 * 这一栏的前提**天然属于哪一桶**（`ANSWER_SOURCES`，定义在 `draft.ts`）。判不出的返回 `null`。
 *
 * ## `field` 和 `answerIn` 是两个维度，这张表不是把它们合并
 *
 * `field` 说的是「这条前提讲的是哪一类事」，桶说的是「这个答案在谁手里」。两者多对一：下面
 * 四栏都落进同一个桶，而同一个桶里还装着大量根本不是前提的东西（决策骨架依赖的我方能力、
 * 授权边界）。合并成一栏，就等于宣布「凡是前提都不用查」，而「客户关系与接触对象」里恰恰
 * 有一半是要问对方的。
 *
 * ## 为什么只钉四栏，第五栏留 null
 *
 * 「客户关系与接触对象」是一栏两半：我们认识谁、谁欠我们一次人情 —— 在我方手里；对方内部
 * 谁拍板、走不走集团招标、审批门槛多少 —— 要问对方（ISS-240 那四条搜了 4 种问法零结果的
 * 关键问题就是后半截）。钉死其中任何一个都会把另一半判错，所以这里照实返回 `null`：**不知道
 * 就说不知道**，同这份文件里别的几处默认值的规矩。
 */
const FIELD_ANSWER_SOURCE: Readonly<Record<PremiseField, AnswerSource | null>> = {
  我方已实现能力: "在我方手里",
  可演示场景: "在我方手里",
  承诺边界: "在我方手里",
  客户关系与接触对象: null,
  此次目标: "在我方手里",
};

export const answerSourceForField = (f: PremiseField): AnswerSource | null =>
  FIELD_ANSWER_SOURCE[f] ?? null;

export type Premise = {
  /** 稳定、可被外部引用的短 ID。路线的 `dependsOn` 和 N4 的更新都按它对。 */
  id: string;
  field: PremiseField;
  statement: string;
  /** 来源引用。只能引真实输入（提问原话、公司上下文里的段落名），不许编。 */
  source: string;
  standing: PremiseStanding;
  /** 能力栏才有；别的栏 null。**认不出一律「未知」，不是「当前已实现」。** */
  stage: CapabilityStage | null;
};

/**
 * 一条候选路线。**至多三条，可以少于三条** —— 凑数编出来的第三条，在 N4 那里会消耗一次
 * 真实的对账，还会在成稿里以「我们比较过三条路」的面貌出现。
 *
 * `switchWhen`（改走别路的条件）是这一条里最要紧的一栏：它是这条路线的证伪条件，也是 N2
 * 该优先去查什么的依据。少了它，路线就是一句主张，证据来了也不知道该改哪里。
 */
export type RouteOption = {
  id: string;
  /** 主张：这条路线要做的那件事，一句判断。 */
  claim: string;
  /** 我方能力匹配：踩在哪几条已实现能力上。 */
  fit: string;
  /** 客户条件：对方要满足什么，这条才成立。 */
  clientCondition: string;
  /** 收益：走通了拿到什么。 */
  payoff: string;
  /** 关键依赖，引 `Premise.id`。 */
  dependsOn: string[];
  /** 改走别路的条件：看到什么就该换一条。 */
  switchWhen: string;
};

/** 宽容解析的结果：整条站得住就收，站不住交一句能上屏的理由（不静默丢）。 */
export type ReadResult<T> = { ok: true; value: T } | { ok: false; why: string };

/** 至多几条路线。超了不丢，报账 —— 丢掉第四条等于替一号位做了取舍。 */
export const ROUTE_MAX = 3;
/** ID 的字数上限。超了多半是把内容写进了 ID，而那种 ID 后面引不动。 */
export const ID_MAX = 24;

/* -------------------------------------------------------------------------- */
/* 解析                                                                        */
/* -------------------------------------------------------------------------- */

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v : []).map(s).filter(Boolean);

/**
 * ID 要能被后面两步原样引用，所以它必须**没有空白、不长**。
 *
 * 带空格的 ID 在 N4 的自由文本里引一次就断成两半，长 ID 通常是模型把主张写进了 ID 栏。
 * 这两种都不是「缺一栏」，是这条记录不能被引用 —— 所以整条拒，并且报出来。
 */
function readId(v: unknown, seen?: Set<string>): ReadResult<string> {
  const id = s(v);
  if (!id) return { ok: false, why: "没有 id —— 后面对账要按 id 逐条更新，没有 id 就引不动" };
  if (/\s/.test(id)) return { ok: false, why: `id「${id.slice(0, ID_MAX)}」里有空白，引不动` };
  if (id.length > ID_MAX) return { ok: false, why: `id 有 ${id.length} 字，超过 ${ID_MAX} 字` };
  if (seen?.has(id)) return { ok: false, why: `id「${id}」和前面某一条重了` };
  return { ok: true, value: id };
}

const field = (v: unknown): PremiseField | null =>
  (PREMISE_FIELDS as readonly string[]).includes(s(v)) ? (s(v) as PremiseField) : null;

/**
 * 来源身份。**认不出的落「推测」。**
 *
 * 不落「用户提供」是显然的（凭空给它一个来源）；不落「未知」是因为「未知」在这份结构里
 * 是一个有内容的答案 ——「这一栏我们问过，答案是不知道」，而这里的情况是「有一句话，不知道
 * 它哪来的」。两件事混在一起，下游就分不出「没查」和「查了没有」。
 */
const standing = (v: unknown): PremiseStanding =>
  (PREMISE_STANDINGS as readonly string[]).includes(s(v)) ? (s(v) as PremiseStanding) : "推测";

/**
 * 能力的当前/规划。**只认原话，别的一律「未知」。**
 *
 * 这一行是第 2 条规矩的全部实现：默认值只要不是「未知」，一条没标注的规划能力就会被下游
 * 当成手上已经有的东西，然后写进对客户的承诺。ISS-239 §主要问题 3 就是这么来的。
 */
const stageOf = (v: unknown, f: PremiseField): CapabilityStage | null => {
  if (!CAPABILITY_FIELDS.includes(f)) return null;
  return (CAPABILITY_STAGES as readonly string[]).includes(s(v)) ? (s(v) as CapabilityStage) : "未知";
};

/**
 * 读一条前提。宽容：缺栏落空/落「未知」；**站不住才拒** —— 没有 ID（引不动）、不认识的
 * 栏位（不知道它回答的是哪一问）、没有内容。
 */
export function readPremise(o: Record<string, unknown>, seen?: Set<string>): ReadResult<Premise> {
  const id = readId(o.id, seen);
  if (!id.ok) return id;
  const f = field(o.field);
  if (!f) return { ok: false, why: `前提 ${id.value} 的 field「${s(o.field).slice(0, 12)}」不是那五栏之一` };
  const statement = s(o.statement);
  if (!statement) return { ok: false, why: `前提 ${id.value} 没有内容（不知道就写「未知」，别留空）` };
  seen?.add(id.value);
  return {
    ok: true,
    value: { id: id.value, field: f, statement, source: s(o.source), standing: standing(o.standing), stage: stageOf(o.stage, f) },
  };
}

/** 读一条候选路线。同样宽容：只有 ID 和主张是承重的，别的栏缺了落空、进机检。 */
export function readRoute(o: Record<string, unknown>, seen?: Set<string>): ReadResult<RouteOption> {
  const id = readId(o.id, seen);
  if (!id.ok) return id;
  const claim = s(o.claim);
  if (!claim) return { ok: false, why: `路线 ${id.value} 没有主张（claim）` };
  seen?.add(id.value);
  return {
    ok: true,
    value: {
      id: id.value,
      claim,
      fit: s(o.fit),
      clientCondition: s(o.clientCondition),
      payoff: s(o.payoff),
      dependsOn: strs(o.dependsOn),
      switchWhen: s(o.switchWhen),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 机检                                                                        */
/* -------------------------------------------------------------------------- */

/** 提问原话里的引文长这样：「……」。只有引号里的那一段能拿去和真实输入比对。 */
const QUOTES = /[「『]([^」』]{4,})[」』]/g;
const flat = (t: string): string => t.replace(/\s+/g, "");

/**
 * 前提的缺口。
 *
 * `corpus` 给了就多做一项：**声称「用户提供 / 材料记载」的那几条，引号里的原话必须在真实
 * 输入里找得到。** 这一项只查显式引文，不查转述 —— 转述判不了，而编造的引文查得出来，
 * 且正是「源引用只能引真实输入」这条规矩唯一能机检的部分。
 */
export function premiseGaps(list: readonly Premise[], o: { corpus?: string } = {}): string[] {
  const gaps: string[] = [];
  const have = new Set(list.map((p) => p.field));
  for (const f of PREMISE_FIELDS) {
    if (!have.has(f)) gaps.push(`前提里「${f}」这一栏一条都没有 —— 不知道就显式写一条「未知」，不要留空让后面猜`);
  }
  for (const p of list) {
    if (!p.source && (p.standing === "用户提供" || p.standing === "材料记载")) {
      gaps.push(`前提 ${p.id} 标了「${p.standing}」却没写来源引用`);
    }
    /*
     * 矛盾组合：答案在我方手里的那几栏（`answerSourceForField`）标着「推测」。
     *
     * 2026-09-07（ISS-240）。「在我方手里」这一桶的定义里带着一条禁令 —— 既不许去外网搜，
     * **也不许凭空断言**，因为它有确定的出处（本体、产品说明），会前问一句就有答案。所以
     * 这一栏上的「推测」不是一种偏弱的证据，它是一次绕过：它和「材料记载」在下游长得一模
     * 一样，而「未知」不会。ISS-239/240 那两轮替我方许下的私有化部署、数据不出厂、知识
     * 产权归客户，就是这么进的报告。
     *
     * 注意 `standing` 认不出时的兜底也是「推测」（`standing()`），所以这道闸同时罩住了
     * 「压根没标来源身份的我方能力」—— 那种也是一句来路不明的话。
     */
    if (answerSourceForField(p.field) === "在我方手里" && p.standing === "推测") {
      gaps.push(
        `前提 ${p.id}（${p.field}）的答案在我方手里，却标着「推测」—— 这一栏只能照我方材料写或显式写「未知」，不许猜`
      );
    }
  }
  const corpus = flat(o.corpus ?? "");
  if (corpus) {
    for (const p of list) {
      if (p.standing !== "用户提供" && p.standing !== "材料记载") continue;
      for (const m of p.source.matchAll(QUOTES)) {
        if (!corpus.includes(flat(m[1]))) gaps.push(`前提 ${p.id} 引的那句「${m[1].slice(0, 20)}」在这一轮的输入里找不到`);
      }
    }
  }
  return gaps;
}

/**
 * 候选路线的缺口。**少于三条不算缺口** —— 编一条出来凑，比只给两条差得多。
 *
 * 一条都没有要报：那是「这道题不用选」或者「模型没答」，两者都得让人看见。它不触发 N1 补正
 * （`pipeline.ts` 的 `worth` 只认总判断/决策骨架/维度那三种措辞），只进这一轮的缺口清单。
 */
export function routeGaps(list: readonly RouteOption[], premises: readonly Premise[] = []): string[] {
  const gaps: string[] = [];
  if (!list.length) {
    gaps.push("候选路线一条都没有 —— 至多三条、少于三条合法，但一条不给等于这道选择题没被当成选择题");
    return gaps;
  }
  if (list.length > ROUTE_MAX) gaps.push(`候选路线有 ${list.length} 条，超过 ${ROUTE_MAX} 条`);

  const byId = new Map(premises.map((p) => [p.id, p]));
  for (const r of list) {
    if (!r.fit) gaps.push(`路线 ${r.id} 没写我方能力匹配`);
    if (!r.clientCondition) gaps.push(`路线 ${r.id} 没写客户条件`);
    if (!r.payoff) gaps.push(`路线 ${r.id} 没写收益`);
    if (!r.switchWhen) gaps.push(`路线 ${r.id} 没写改走别路的条件 —— 那是它的证伪条件，缺了证据来了也不知道改哪里`);
    if (!r.dependsOn.length) gaps.push(`路线 ${r.id} 没有关键依赖（要引前提 ID）`);
    for (const d of r.dependsOn) {
      const p = byId.get(d);
      if (!p) {
        gaps.push(`路线 ${r.id} 依赖的前提 ${d} 不在前提表里`);
        continue;
      }
      /*
       * 踩在规划中/未知的能力上不禁止 —— 那可能正是这次要去问的东西。但它必须被看见：
       * ISS-239 那一轮就是把一条没有依据的能力当成现成的，直接写成了对客户的承诺。
       */
      if (p.stage === "规划中" || p.stage === "未知") {
        gaps.push(`路线 ${r.id} 踩在「${p.stage}」的能力 ${p.id} 上，成稿里必须写成条件式，不能当作现在就能交付`);
      }
    }
  }
  return gaps;
}

/**
 * 现在就能拿出去的那几条能力。**N5 写承诺时只许读这一份。**
 *
 * 判据是三样同时成立：是能力栏、`stage` 是「当前已实现」、来源不是「推测」。推测出来的
 * 「已实现」不是能力，是一句好听的话。
 */
export function deliverableNow(list: readonly Premise[]): Premise[] {
  return list.filter((p) => p.stage === "当前已实现" && p.standing !== "推测" && p.standing !== "未知");
}

/* -------------------------------------------------------------------------- */
/* 渲染（N4 / N5 往下传的时候用这一份，别各写各的）                             */
/* -------------------------------------------------------------------------- */

export function premiseLines(list: readonly Premise[]): string[] {
  return list.map(
    (p) =>
      `- ${p.id}｜${p.field}｜${p.standing}${p.stage ? ` · ${p.stage}` : ""}：${p.statement}` +
      `（来源：${p.source || "未注明"}）`
  );
}

export function routeLines(list: readonly RouteOption[]): string[] {
  return list.flatMap((r) => [
    `- ${r.id}：${r.claim}`,
    `  · 我方能力匹配：${r.fit || "（未写）"}`,
    `  · 客户条件：${r.clientCondition || "（未写）"}`,
    `  · 收益：${r.payoff || "（未写）"}`,
    `  · 关键依赖：${r.dependsOn.join("、") || "（未写）"}`,
    `  · 改走别路的条件：${r.switchWhen || "（未写）"}`,
  ]);
}

/**
 * 公司上下文封顶多少字进 N1。
 *
 * N1 的输出额度是**含思考的**（`DRAFT_MAX_TOKENS`）：输入长了，模型想得更久，正文被挤掉，
 * 而失败方式是静默的（同 `draft.ts` 里在版判断那一段的封顶理由）。ISS-239 那一轮的公司
 * 上下文是 791 字，这个上限给的是它的四倍多；真到了上限，截掉的部分下面那句话会说出来。
 */
export const CONTEXT_CHARS = 3500;

/**
 * 公司上下文那一段。**没有就明说没有**，不悄悄整段消失 —— 「这一轮没有我方材料」本身
 * 就是 N1 该知道的事：它决定了我方能力那几栏只能写「未知」，而不是按常识补一套。
 *
 * `NO_COMPANY_CONTEXT` 那一段原样落进来会带一句 `cited_member_ids 必须是空数组`，那是给
 * 出稿那几步的格式约束，在这一步是噪音（这一步交的是 JSONL），所以换成一句话。
 */
export function companyContextLines(text: string | null | undefined): string[] {
  const t = (text ?? "").trim();
  if (!t || t === NO_COMPANY_CONTEXT.trim()) {
    return [
      "\n## 我方（提问的这家公司）的材料",
      "**这一轮没有取到公司上下文。** 所以凡是关于我方的话 —— 我们有什么能力、能演示什么、" +
        "能对外承诺什么 —— 一律写「未知」，不许按常识补一套我们大概会有的能力：补出来的那一套，" +
        "读起来和查出来的一模一样。",
    ];
  }
  const body = t.length > CONTEXT_CHARS ? `${t.slice(0, CONTEXT_CHARS)}\n（上下文过长，此处截断）` : t;
  return [
    "\n## 我方（提问的这家公司）的材料",
    "这一段是我方的既有材料。**它说明了什么，就只能推出什么**：一段说明我方是做什么的材料，" +
      "推不出我们做得了其中某个具体场景 —— 也推不出做不了。没说的一律是「未知」，不是「没有」，更不是「有」。",
    body,
  ];
}

/** 一号位在提问里明确给出的前提。它是**研究前提**，不是外部已核实事实。 */
export type UserPremise = { text: string; quote?: string };

export function userPremiseLines(list: readonly UserPremise[]): string[] {
  const kept = list.map((p) => ({ text: s(p.text), quote: s(p.quote) })).filter((p) => p.text);
  if (!kept.length) return [];
  return [
    "\n## 一号位在提问里给定的前提",
    "**当事实用，不要在这一步质疑它们，也不要把它们当成已经核过的外部事实。** 它们的来源身份是" +
      "「用户提供」，下面填结构化前提时照这个身份标；后面对账那一步会拿外部证据去碰它们。",
    ...kept.map((p) => `- ${p.text}${p.quote ? `（原话：「${p.quote}」）` : ""}`),
  ];
}
