/**
 * N2 命题抽取与检索规划。**命题从草稿里抽，不从首波检索结果里长出来。**
 *
 * 这一步和 N1 的先后顺序是上一版的死因所在：那一版先检索再定题，于是早期查询撞上一个
 * 数据群之后，后续命题全围着它展开，越挖越深，再也没跳出去。倒过来之后，检索计划由
 * **草稿的结构**驱动 —— 八个维度各自领自己的命题，谁也不许吃掉别人的预算。
 *
 * 验证工作量导向「承重 × 时效敏感 × 低置信」那一批：优先级不由模型自己排，由这三样
 * 相乘（承重与时效的阈值判定复用 `props.ts`，不在这里另立一套）。
 */

import {
  decisionScope,
  dimName,
  DIM_IDS,
  INDUSTRY_SCOPE,
  inScope,
  isDimId,
  keyQuestions,
  overBudget,
  type DimId,
  type ScopeQuestion,
  type TaskScope,
} from "./dims";
import type { Draft } from "./draft";
import { compile, type Proposition } from "./props";

/**
 * 来源类型。一条命题的查询要覆盖 ≥2 类 —— 全砸在媒体转载上的话，取回来的十几条会是同
 * 一份统计的十几个转发，而共源折叠之后只剩一条。
 */
export const SOURCE_KINDS = ["行业机构", "公司披露", "监管与政策", "媒体线索"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type PlannedProposition = Proposition & {
  dimension: DimId;
  sourceKinds: SourceKind[];
  /**
   * 这条命题在替哪条关键问题取证（`ScopeQuestion.id`）。
   *
   * 决策题上这是**命题和任务范围之间唯一的绑定**：维度只是分类标签，一条问题的状态
   * （未搜 / 已搜未得 / 已得）是从挂在它下面的命题的入账情况算出来的，不是从它那一维的
   * 覆盖行算出来的。行业题上恒为空 —— 那种题的范围就是八个维度本身。
   */
  questionId?: string;
};

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const kinds = (v: unknown): SourceKind[] => {
  const out: SourceKind[] = [];
  for (const one of (Array.isArray(v) ? v : []).map(s)) {
    if ((SOURCE_KINDS as readonly string[]).includes(one) && !out.includes(one as SourceKind)) {
      out.push(one as SourceKind);
    }
  }
  return out;
};

/** ```json 这类围栏。模型经常自作主张套一层，它不是错误。 */
const FENCE = /^```/;

/**
 * 模型交回来的计划 → 一串命题，**按行读**。
 *
 * ## 为什么按行，而不是一个整的 JSON 对象
 *
 * 这一步换过一次形状，理由是一笔真账（2026-08-31）：这几个模型的**思考也算在
 * `max_tokens` 里**，而计划这一步的思考能吃掉九成额度 —— 实测两次都是 `out=8001`、
 * 其中思考 7194 和 5416，留给正文的只剩几百到两千多。上一版交的是一个整的 JSON 对象、
 * 而且不允许续写，截一刀整个对象就解析不出来，`compilePlan` 拿到零条，于是
 * **N3 分维度取证整段被跳过**，而这一轮照旧出稿、照旧报 ok。
 *
 * 一行一条之后，截断的代价从「整轮取证没了」降到「最后一条没了」。这不是新写法：同一条
 * 链上的 N1 草稿一直就是这么交的（`draft.ts`），而它在同样的上限下活了下来。
 *
 * ## 为什么老形状也照收
 *
 * 换完之后模型偶尔仍旧交回 `{"propositions":[...]}`。那一份完全能用 —— 丢掉它等于为了
 * 形状好看而扔掉一次已经付过钱的调用。所以两种都读：整份能解析成那个对象就用它，
 * 否则按行读。
 *
 * 坏行**要报出来**（`bad`），口径同 `parseDraft`：静默吞掉正是上面那个 bug 最贵的地方。
 */
export function parsePlanLines(text: string): {
  propositions: Record<string, unknown>[];
  bad: { line: number; why: string }[];
} {
  const whole = text.trim().replace(/^```[a-z]*|```$/g, "").trim();
  // 老形状：整份就是那一个对象。能读出来就直接用，一条都不丢。
  try {
    const parsed: unknown = JSON.parse(whole);
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { propositions?: unknown }).propositions)) {
      const list = (parsed as { propositions: unknown[] }).propositions.filter(
        (x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x)
      );
      return { propositions: list, bad: [] };
    }
  } catch {
    /* 不是那一份，按行读。 */
  }

  const propositions: Record<string, unknown>[] = [];
  const bad: { line: number; why: string }[] = [];
  text.split(String.fromCharCode(10)).forEach((raw, i) => {
    const line = raw.trim().replace(/,$/, "");
    if (!line || FENCE.test(line)) return;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("不是一个对象");
      propositions.push(parsed as Record<string, unknown>);
    } catch (e) {
      bad.push({ line: i + 1, why: e instanceof Error ? e.message : "读不出来" });
    }
  });
  return { propositions, bad };
}

/**
 * 模型交的清单 → 带维度的命题。**按维度分组各自封顶**，不是全局取前 N 条。
 *
 * 全局封顶等于让排在前面的维度把配额吃光 —— 而模型交上来的顺序通常就是它自己关注度的
 * 顺序，那正是要拦的偏斜。承重/时效的阈值判定转交 `props.compile`：两处各写一套的话，
 * 同一个 0.7 会在某次只改了一头之后变成两个数。
 */
export function compilePlan(
  raw: { propositions?: unknown },
  maxPerDim: number,
  scope: TaskScope = INDUSTRY_SCOPE
): PlannedProposition[] {
  /** 这一轮认得的关键问题号。认不出的号一律落空 —— 编出来的号绑不到任何一条问题上。 */
  const knownQuestions = new Set(scope.questions.map((q) => q.id));
  const list = ((Array.isArray(raw.propositions) ? raw.propositions : []) as Record<string, unknown>[])
    // 认不出的维度编号直接丢 —— 让它悄悄落到 D1 上，等于把一条无主命题记在别人账上。
    .filter((p) => isDimId(s(p.dimension)))
    /*
     * **范围外的维度也丢。** 决策题上模型仍会时不时交一条 D6 政策题回来，而这一轮压根
     * 没有 D6：留着它的后果不是多一条命题，是多一整条检索链的时间 —— 它会被分到「政策、
     * 风险与主体」那条链上，占一波，而下游没有任何一处会读它（成稿形状里那几维只在支撑
     * 某件要定的事时引一句，`prompt.ts` 的 `DECISION_SHAPE`）。
     */
    .filter((p) => inScope(scope, s(p.dimension) as DimId));
  const out: PlannedProposition[] = [];
  for (const dim of scope.dims) {
    const mine = list.filter((p) => s(p.dimension) === dim);
    if (!mine.length) continue;
    /*
     * `compile` 会先滤掉 <6 字的陈述再截断（props.ts:76），所以它交回来的第 i 条不一定是
     * `mine[i]`。**按陈述文本回配**，不按下标 —— 按下标的话，一条陈述太短被丢掉之后，
     * 它后面每一条的来源类型都串到了上一条身上，而产出看不出任何异常。
     *
     * 同一陈述出现多次时取第一条。用 `new Map(entries)` 会取最后一条，所以显式循环。
     */
    const byStatement = new Map<string, Record<string, unknown>>();
    for (const p of mine) {
      const stmt = s(p.statement);
      if (!byStatement.has(stmt)) byStatement.set(stmt, p);
    }
    compile({ propositions: mine }, maxPerDim).forEach((p, i) => {
      const qid = s(byStatement.get(p.statement)?.questionId);
      out.push({
        ...p,
        // 编号带维度：跨维度不撞号，而且台账上一眼看得出这条证据是替哪一维取的。
        id: `${dim}-P${i + 1}`,
        dimension: dim,
        sourceKinds: kinds(byStatement.get(p.statement)?.sourceKinds),
        ...(knownQuestions.has(qid) ? { questionId: qid } : {}),
      });
    });
  }
  return out;
}

/** 一条命题的查询至少覆盖几类来源。 */
const MIN_SOURCE_KINDS = 2;

/**
 * 检索计划的缺口。空数组 = 可以进 N3。
 *
 * **按 `scope` 判，不按八维判。** 不传就是行业题那一份（八维各 2 条、单维不过三成），
 * 老调用点一个字不用改。
 *
 * 决策题上换的是**问哪几条缺口**，不是问得松：
 *  · 范围外的维度不问（`scope.dims`）—— 「无关命题不足不触发补正」
 *  · 每条**会改变选择**的关键问题必须有命题接着（`keyQuestions`），没有就是缺口
 *  · 来源类型 ≥2 类、至少一条反向问法**两种范围都照旧查** —— 交接文档 §3.B 第二条：
 *    放宽的只有「要不要填满八维」这一件，来源质量和反证不放
 */
export function planGaps(
  props: readonly PlannedProposition[],
  scope: TaskScope = INDUSTRY_SCOPE
): string[] {
  const gaps: string[] = [];

  for (const dim of scope.dims) {
    const mine = props.filter((p) => p.dimension === dim);
    if (mine.length < scope.minPropsPerDim) {
      gaps.push(`${dim} ${dimName(dim)} 只有 ${mine.length} 条命题，不足 ${scope.minPropsPerDim} 条`);
    }
  }

  /*
   * 关键问题这一头。**这才是决策题上「够不够」的真问题** —— 「D6 只有 1 条命题」在这种题上
   * 不值一次三分钟的补正调用（ISS-235 为八条这样的缺口补了 2 分 59 秒，换回来的计划每维条数
   * 一模一样），而「会改变选哪条路线的那件事这一轮没人去查」值。
   *
   * `needsInternal` 的不在这里（`keyQuestions` 已经滤掉）：它们的补法是要内部材料或问客户，
   * 再发一轮检索无论发多少条都不会有结果。
   */
  for (const q of keyQuestions(scope)) {
    if (props.some((p) => p.questionId === q.id)) continue;
    const routes = q.routeIds.length ? `（关联路线 ${q.routeIds.join("、")}）` : "";
    gaps.push(`关键问题 ${q.id}「${q.question}」没有命题接着${routes} —— 它的答案会改变选哪条路线`);
  }

  for (const p of props) {
    if (p.sourceKinds.length < MIN_SOURCE_KINDS) {
      gaps.push(`${p.id} 的查询只覆盖 ${p.sourceKinds.length} 类来源类型，不足 ${MIN_SOURCE_KINDS} 类`);
    }
  }

  /*
   * 单维占比。`scope.dimShareCap` 为 `null` 时整段不查 —— 决策题上这条门是必然误报
   * （三维平摊每维就是 33%），理由整段写在 `dims.ts` 的 `decisionScope` 上。
   */
  if (scope.dimShareCap !== null) {
    const byDim: Record<string, number> = {};
    for (const p of props) {
      byDim[p.dimension] = (byDim[p.dimension] ?? 0) + p.queries.length + p.counterQueries.length;
    }
    for (const over of overBudget(byDim, scope.dimShareCap)) {
      gaps.push(
        `${over.dim} ${dimName(over.dim as DimId)} 吃掉了 ${Math.round(over.share * 100)}% 的检索式，超过三成上限`
      );
    }
  }

  if (props.length && !props.some((p) => p.counterQueries.length)) {
    gaps.push("一条反向问法都没有 —— 这一轮不会去找推翻结论的东西");
  }
  return gaps;
}

/* -------------------------------------------------------------------------- */
/* 任务范围怎么长出来                                                           */
/* -------------------------------------------------------------------------- */

/**
 * 决策骨架依赖的外部事实落在哪一维。
 *
 * 按 `prompt.ts` 的说法，骨架每段的 `assertions` 写的是「对方的产线、人事、窗口、条款」，
 * 那是 D2 供给端的东西（`draft.ts` 的 `DECISION_DIMS` 留下 D2 的理由也正是「对方的产线与
 * 在建项目 = 这次要谈的标的」）。所以兜底落 D2；这一维不在范围里时落范围里的第一维。
 *
 * **这只是个分类标签。** 一条关键问题的状态是从挂在它下面的命题（`questionId`）算的，
 * 不是从这一维的覆盖行算的 —— 所以标错了不会让状态出错，只会让 trace 上的分组难看一点。
 * `premise.ts` 落地之后这一段作废：那时候路线和前提自带维度。
 */
const questionDim = (dims: readonly DimId[]): DimId =>
  dims.includes("D2") ? "D2" : (dims[0] ?? "D8");

/**
 * 这一轮的任务范围。**决策题从草稿真的写了什么推出来，不从一张写死的表推。**
 *
 * · 维度 = 草稿真的写了的那几维 ∪ `extraDims`（`pipeline.ts` 递主体卡命题的维度进来，
 *   见那一处的注释）。草稿一维都没写时落 `decisionScope` 的兜底表。
 * · 关键问题 = 调用方给的那份（`premise.ts` 的候选路线与依赖前提）；没给就从草稿的
 *   决策骨架推：一段骨架 = 一条候选路线，它的每条依赖断言 = 一条关键问题，`loadBearing`
 *   的那些标 `changesChoice`（承重 = 它倒了这一段建议跟着倒，那就是会改变选择）。
 *
 * 行业题一律拿 `INDUSTRY_SCOPE`，一个字不动。
 */
export function taskScopeFor(o: {
  decision?: boolean;
  draft: Draft;
  /** 计划之外还会进这一轮的命题的维度（主体卡命题）。 */
  extraDims?: readonly DimId[];
  /** N1 已经定出候选路线时直接给。给了就不从草稿推。 */
  questions?: readonly ScopeQuestion[];
}): TaskScope {
  if (!o.decision) return INDUSTRY_SCOPE;
  const dims = [
    ...new Set<DimId>([...o.draft.sections.map((x) => x.dim), ...(o.extraDims ?? [])]),
  ];
  if (o.questions) return decisionScope({ dims, questions: o.questions });

  const dim = questionDim(dims.length ? DIM_IDS.filter((d) => dims.includes(d)) : []);
  const questions: ScopeQuestion[] = o.draft.playbook.flatMap((seg, si) =>
    seg.assertions.map((a, ai) => ({
      id: `Q${si + 1}-${ai + 1}`,
      question: a.text,
      dimension: dim,
      // 一段骨架就是一条候选路线。`premise.ts` 落地后这里换成它给的真 ID。
      routeIds: [`R${si + 1}`],
      // TODO(2026-09-07)：依赖前提 ID 要等 `premise.ts`。草稿这一头没有前提编号，
      // 空表在这里是**照实留白**，不是「没有依赖」。
      dependsOn: [],
      changesChoice: a.loadBearing,
      /*
       * **三桶在这里落成一道闸**（2026-09-07，ISS-240）。
       *
       * 「要问对方」和「在我方手里」那两桶一律 `needsInternal`：`keyQuestions` 会把它们
       * 从检索计划、补搜队列和覆盖门里一起滤掉，`buildPlanUser` 把它们列进「这几条不要
       * 检索」。ISS-240 那一轮它们全部当研究题去搜了 —— 五条各试 4 条问法、一条可用来源
       * 都没回来，吃掉的是取证的时间和抓取位子，而答案本来就在首访的会议室里。
       *
       * 判不出来的断言在 `draft.ts` 那一侧已经落成「公开可查」，所以这道闸的默认方向是
       * **搜一下**，不是**不搜**：漏搜一条会改变结论的事，比多搜一条贵得多。
       */
      needsInternal: a.answerIn !== "公开可查",
    }))
  );
  return decisionScope({ dims, questions });
}

/**
 * 每维最多几条命题。**除以范围里的维度数，不是除以 8。**
 *
 * `pipeline.ts` 原来写的是 `ceil(maxProps / DIM_IDS.length)`。决策题上范围只有三维，
 * 按 8 摊的结果是整轮预算只用掉三成八 —— 而少掉的那部分不是省下来的，是本来该花在
 * 那三维上的深度。
 */
export const maxPerDimFor = (scope: TaskScope, maxProps: number): number =>
  Math.max(scope.minPropsPerDim, Math.ceil(maxProps / Math.max(1, scope.dims.length)));

export const PLAN_SYSTEM = `你在给一份**已经写好的**行业分析草稿排检索计划。

草稿是凭知识写的，里面每条事实断言都标了 \`P\`（先验、未验证）。你的活是挑出该拿外部材料
去核的那些，转成可检索的命题。**命题只从草稿里抽** —— 不要另起题目，不要等搜索结果回来
再决定研究什么。

## 挑哪些

优先级 = 承重度（它被推翻时有几个论点跟着倒）× 时效敏感度 × (1 / 置信度)。机制类、结构类
的断言（成本结构、经营杠杆、切割经济性）不必验证；出货量、价格、份额、投产进度、政策这类
时效敏感的承重断言必须验证。

## 三件事一起做

1. **验证命题**：每条给 2-3 条查询，覆盖 ≥2 类来源（行业机构原始数据 / 公司披露 /
   监管与政策原文 / 媒体线索）。媒体只作线索，不作终点。
2. **盲区查询**：对每个维度，针对草稿最后那份「我知道我不知道的」和该维度的时效敏感断言，
   生成带年份或季度限定词的「最新数据」型查询。
3. **反向命题**：对总判断和每一维的论点，各给 ≥1 条「若为假会是什么样」的查询 —— 去找
   反例，不是去找确认。

## 交什么

**一行一条命题，每行一个独立的 json 对象**，不要外层数组、不要围栏、不要解释：

{"dimension":"D1","statement":"一句可证伪的陈述","requiredEvidence":"什么样的证据才算回答了它","queries":["正向问法"],"counterQueries":["反向问法"],"sourceKinds":["行业机构","公司披露"],"materialityWeight":0.8,"freshnessUrgency":0.9}
{"dimension":"D2","statement":"下一条","requiredEvidence":"...","queries":["..."],"counterQueries":["..."],"sourceKinds":["监管与政策","媒体线索"],"materialityWeight":0.6,"freshnessUrgency":0.4}

一行一条是有原因的：额度用完时**已经写完的那几行照旧作数**，而写在一个大数组里的话，
截在半路整份就都读不出来了。所以按重要性从高到低写，把最该核的那几条放前面。

## 预算纪律

每个维度至少 2 条命题，**上限由下面「每维最多几条」那一行给** —— 那不是建议，是系统真的
只会取那么多条：超出去的那几条一条都不会被检索，写它们只是在花时间。所以每一维**按重要性
从高到低写，写满上限就停**，把那几条名额花在承重且时效敏感的断言上。

**任何一个维度的检索式不得超过总量的三成** —— 上一轮就是一个维度把预算吃光，最后交出一份
只覆盖一个角落的行业分析。`;

/**
 * 决策题那一份系统提示。
 *
 * 和上面那份的差别只有一处，但那一处是这次要修的东西本身：**这道题的范围是几条能改变
 * 选择的关键问题，不是八个维度。** 所以这里去掉了「每个维度至少 2 条」和「任何一个维度
 * 不得超过三成」，换成「每条关键问题至少一条命题」和「不要为了填维度编命题」。
 *
 * 三件事**没有**跟着放宽，写在提示词里也钉在 `planGaps` 里：来源覆盖 ≥2 类、每一轮要有
 * 反向问法、时效敏感的断言要带年份或季度限定词。放宽的只有「要不要填满八维」这一件。
 */
export const PLAN_SYSTEM_DECISION = `你在给一份**已经写好的**决策草稿排检索计划。

这道题要的是在几条路线里选一条。所以检索的目标不是「把这个行业讲全」，是**把那几条能改变
选择的问题弄清楚**：一条问题的答案如果不会让建议改变，它就不值这一轮的时间。

## 挑哪些

只挑下面「这一轮要弄清的关键问题」列出的那些，以及草稿里承重且时效敏感的断言。优先级 =
它被推翻时有几条建议跟着改 × 时效敏感度 × (1 / 置信度)。

**不要为了填满维度编命题。** 维度（D1–D8）在这道题上只是分类标签：下面「这一轮适用的维度」
里没有的，一条都不要写 —— 写了系统会直接丢弃，那几条只是在花时间。

**答案在我方内部或客户那里的问题不要生成检索式**（我们自己有没有做过某件事、客户内部谁
拍板、预算挂在谁头上）。那种缺口外网搜多少轮都不会有结果，它要的是内部材料或者当面问。
遇到这类就跳过，不要把它改写成一条「行业里一般怎么做」的替代查询。

## 三件事一起做

1. **验证命题**：每条给 2-3 条查询，覆盖 ≥2 类来源（行业机构原始数据 / 公司披露 /
   监管与政策原文 / 媒体线索）。媒体只作线索，不作终点。
2. **最新数据**：时效敏感的断言要带年份或季度限定词。
3. **反向命题**：对每条会改变选择的关键问题，各给 ≥1 条「若为假会是什么样」的查询 ——
   去找反例，不是去找确认。

## 交什么

**一行一条命题，每行一个独立的 json 对象**，不要外层数组、不要围栏、不要解释：

{"dimension":"D2","questionId":"Q1-1","statement":"一句可证伪的陈述","requiredEvidence":"什么样的证据才算回答了它","queries":["正向问法"],"counterQueries":["反向问法"],"sourceKinds":["公司披露","行业机构"],"materialityWeight":0.9,"freshnessUrgency":0.9}

\`questionId\` 填下面关键问题清单里的编号 —— **这一栏是这条命题和那条问题之间唯一的绑定**，
不填的话系统不知道它在替哪条问题取证，那条问题最后会被记成「没搜过」。不对应任何一条
关键问题的命题把这一栏留空。

一行一条是有原因的：额度用完时**已经写完的那几行照旧作数**，而写在一个大数组里的话，
截在半路整份就都读不出来了。所以按重要性从高到低写，把最该核的那几条放前面。

## 预算纪律

**每条会改变选择的关键问题至少 1 条命题**，上限由下面「每维最多几条」那一行给 —— 那不是
建议，是系统真的只会取那么多条：超出去的那几条一条都不会被检索。`;

/** 这一轮该用哪份系统提示。范围定的，不是调用点各挑各的。 */
export const planSystemFor = (scope: TaskScope): string =>
  scope.kind === "decision" ? PLAN_SYSTEM_DECISION : PLAN_SYSTEM;

/**
 * 每维最多几条。**这个数必须递给模型，不能只在代码里截。**
 *
 * `compilePlan` 一直是 `.slice(0, maxPerDim)`（`props.ts:79`），而模型这一头从来没被告知
 * 过上限 —— 提示词里只有「每个维度至少 2 条」这个下限。于是它按八维各写五到八条，代码留
 * 下十六条，其余整整齐齐地扔掉。
 *
 * 代价不是多花的那点钱，是**墙上时间**：2026-09-03 那两轮这一步交了 7948 和 20372 个输出
 * token，花了 152 秒和 368 秒，而按 50 tok/s 这条实测吞吐算，扔掉的那部分就是扔掉的那部分
 * 时间。这一步又恰好在链的最窄处 —— 它慢一分钟，后面取证就少一波。
 */
/**
 * 会改变选择、又没有任何命题接着的那几条关键问题 → **确定性补一条命题**。
 *
 * ## 为什么不再靠提示词（2026-09-07，ISS-240）
 *
 * `buildPlanUser` 已经把关键问题逐条列出来、写着「每条标了会改变选择的，至少要有一条命题
 * 接着它」，`planGaps` 也会为漏掉的那几条报缺口、触发一次补正。ISS-240 那一轮**这一整套都
 * 跑过了**：补正为 Q2-1 / Q3-1 / Q4-2 / Q5-1 各报了一条，回来之后仍然有五条没有命题接着，
 * 于是覆盖表上它们的状态是「未搜」——而报告里那句「这一轮的检索计划里没有它」，一号位读到
 * 的就是"这件会改变结论的事，没人去查过"。
 *
 * 教训和主体卡命题（`card-props.ts`，T-2）是同一条：**这一步该由代码保证的东西，不要交给
 * 提示词。** 提示词已经写到位了，模型也补正过一次，仍然漏——那就不是措辞的问题。
 *
 * 补出来的这一条**只用问题原文**，不推理、不扩写：它的正向问法就是那句问题本身加主体名，
 * 反向问法去找相反的说法。质量当然不如模型想的那几条，但它保证的是**这条问题真的被搜过一次**
 * ——「搜过没找到」和「没人去搜」在报告里是两句完全不同的话，而后者是这一版最要防的一种。
 *
 * `needsInternal` 的不补：那几条外网本来就没有（`keyQuestions` 已经滤掉），补一条命题只会
 * 换来一轮空手。
 */
export function fillQuestionGaps(
  scope: TaskScope,
  props: readonly PlannedProposition[],
  subject: string
): PlannedProposition[] {
  const covered = new Set(props.map((p) => p.questionId).filter(Boolean));
  const who = subject.trim();
  return keyQuestions(scope)
    .filter((q) => !covered.has(q.id))
    .map((q) => {
      const text = q.question.replace(/\s+/g, " ").trim();
      return {
        id: `${q.dimension}-Q${q.id.replace(/[^0-9]/g, "") || "0"}`,
        dimension: q.dimension,
        questionId: q.id,
        statement: text,
        requiredEvidence: "公告、年报、监管口径或可信媒体里能正面回答这一问的原文",
        queries: [who ? `${who} ${text}` : text, text],
        counterQueries: [who ? `${who} ${text} 否 没有 不需要` : `${text} 否 没有 不需要`],
        sourceKinds: ["公司披露", "媒体线索"],
        // 会改变选哪条路线 —— 按定义就是实质命题。
        material: true,
        freshnessUrgent: true,
        extraRoundsCap: 1,
      } satisfies PlannedProposition;
    });
}

export function buildPlanUser(
  draft: Draft,
  maxPerDim: number,
  scope: TaskScope = INDUSTRY_SCOPE
): string {
  const internal = scope.questions.filter((q) => q.needsInternal);
  return [
    `## 每维最多几条\n\n**每个维度最多 ${maxPerDim} 条命题**，超出的部分系统会直接丢弃。`,
    /*
     * 适用维度这一段**只在决策题上出现**。行业题的范围就是八维，多写一句「这一轮适用
     * D1–D8」只是在提示词里加噪声。
     */
    ...(scope.kind === "decision"
      ? [
          `\n## 这一轮适用的维度\n\n**只有 ${scope.dims
            .map((d) => `${d} ${dimName(d)}`)
            .join("、")}**。别的维度这一轮不适用，写了会被丢弃。`,
        ]
      : []),
    ...(scope.questions.length
      ? [
          "\n## 这一轮要弄清的关键问题",
          "**这就是这一轮的范围。** 每条标了「会改变选择」的，至少要有一条命题接着它，并在那条命题上填 `questionId`。",
          ...scope.questions
            .filter((q) => !q.needsInternal)
            .map(
              (q) =>
                `- ${q.id}｜${q.question}｜${q.changesChoice ? "会改变选择" : "背景"}｜关联路线 ${
                  q.routeIds.join("、") || "未挂"
                }${q.dependsOn.length ? `｜依赖前提 ${q.dependsOn.join("、")}` : ""}`
            ),
        ]
      : []),
    ...(internal.length
      ? [
          "\n## 这几条不要检索",
          "它们的答案在我方内部材料或客户那里，外网搜不到。**不要为它们生成查询，也不要改写成一条『行业里一般怎么做』的替代查询。**",
          ...internal.map((q) => `- ${q.id}｜${q.question}`),
        ]
      : []),
    "## 草稿的总判断",
    draft.thesis,
    "\n## 各维度的论点与待核断言",
    ...draft.sections.map((sec) =>
      [
        `### ${sec.dim} ${dimName(sec.dim)}`,
        `论点：${sec.thesis}`,
        ...sec.assertions.map(
          (a) =>
            `- ${a.text}｜置信度 ${a.confidence}｜${a.timeSensitive ? "时效敏感" : "时效不敏感"}｜${
              a.loadBearing ? "承重" : "非承重"
            }`
        ),
      ].join("\n")
    ),
    /*
     * 决策骨架这一段和上面的关键问题清单**是同一批东西的两种写法**（后者正是从前者推出来
     * 的，见 `taskScopeFor`）。所以有了清单就不再重复写一遍：同一条依赖在提示词里出现两次，
     * 模型会当成两件事各排一条命题，而那两条命题会各占一个 `maxPerDim` 的名额。
     */
    ...(!scope.questions.length && draft.playbook.some((p) => p.assertions.length)
      ? [
          "\n## 决策骨架依赖的外部事实",
          "这道题要的是一个决策，下面是骨架各段依赖的外部事实。**它们优先于上面各维的断言**：一条被推翻，对应的建议就要改。归到最相关的维度去排命题。",
          ...draft.playbook.flatMap((p) =>
            p.assertions.map(
              (a) =>
                `- 「${p.heading}」依赖：${a.text}｜置信度 ${a.confidence}｜${a.timeSensitive ? "时效敏感" : "时效不敏感"}｜${
                  a.loadBearing ? "承重" : "非承重"
                }`
            )
          ),
        ]
      : []),
    "\n## 我知道我不知道的",
    ...draft.unknowns.map((x) => `- ${x}`),
  ].join("\n");
}
