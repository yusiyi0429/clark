/**
 * 八维度框架，以及「这一轮的检索预算有没有偏到一个维度上」「合成前每个维度够不够」
 * 这两道确定性的门。
 *
 * ## 为什么维度要写死在代码里
 *
 * 上一版的维度是模型自己想的，于是它想到哪算哪 —— 一次深研只覆盖了智能手机面板一个
 * 维度，而供给端扩产周期、技术路线之争、上游国产化压根没进过检索。缺失的维度不会
 * 报错，它静默消失：屏幕上那份报告看起来完整，只是「行业」被悄悄换成了「行业的一个
 * 角落」。写死之后，缺哪一维要么有独立来源，要么留一条「已搜未得」，两者必居其一。
 *
 * 行业宏观题固定用这八维；别的题型由 N1 自己生成维度（≥6 个），那时这张表只提供
 * 判定用的形状（`DimCoverage`），不提供内容。
 */

export type DimId = "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7" | "D8";

export type Dimension = { id: DimId; name: string; brief: string };

/** 行业宏观题的固定维度。顺序就是草稿里分节的顺序。 */
export const DIMENSIONS: readonly Dimension[] = [
  { id: "D1", name: "需求端", brief: "分应用、分场景，各自处在渗透期/成熟期/衰退期的哪一段" },
  { id: "D2", name: "供给端", brief: "产能周期、在建项目、扩产节奏、供需平衡预期" },
  { id: "D3", name: "技术路线", brief: "现有路线、挑战者路线、切换的经济学逻辑" },
  { id: "D4", name: "竞争格局", brief: "梯队划分、份额趋势、区域格局迁移" },
  { id: "D5", name: "上游与产业链", brief: "关键环节、瓶颈、国产化与垂直整合动向" },
  { id: "D6", name: "政策与外部环境", brief: "监管、产业政策、外部约束" },
  { id: "D7", name: "风险与周期位置", brief: "当前处在周期的哪一段、最大的下行风险是什么" },
  { id: "D8", name: "对主体的含义", brief: "主体的关键变量、未来两三年该盯的三到五个指标" },
] as const;

export const DIM_IDS: readonly DimId[] = DIMENSIONS.map((d) => d.id);

export const isDimId = (v: unknown): v is DimId =>
  typeof v === "string" && (DIM_IDS as readonly string[]).includes(v);

export const dimName = (id: DimId): string => DIMENSIONS.find((d) => d.id === id)?.name ?? id;

/**
 * 一个维度最多占这一轮检索式的几成。
 *
 * 这道门拦的是上一版真正的死法：早期查询撞上一个数据群，后续命题全围着它展开，越挖
 * 越深再也没跳出去 —— 26 条证据弃用 15 条，全是同几份统计的转载。**深度不是问题，
 * 预算被一个维度吃掉才是。**
 */
export const DIM_SHARE_CAP = 0.3;

/** 超预算的维度，按占比从大到小。总数为 0 时不报 —— 那是覆盖门控要拦的事，不是预算。 */
export function overBudget(
  byDim: Record<string, number>,
  cap = DIM_SHARE_CAP
): { dim: string; share: number }[] {
  const total = Object.values(byDim).reduce((n, x) => n + x, 0);
  if (total <= 0) return [];
  return Object.entries(byDim)
    .map(([dim, n]) => ({ dim, share: n / total }))
    .filter((x) => x.share > cap)
    .sort((a, b) => b.share - a.share);
}

/* -------------------------------------------------------------------------- */
/* 任务范围                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 候选路线的最小形状。
 *
 * TODO(2026-09-07)：另一条线正在 `a4/premise.ts` 里定义候选路线与前提（N1 产出至多 3 条
 * 实质不同的路线，每条带依赖前提 ID）。那份落地之后把这里换成 `import type { Route } from
 * "./premise"`，字段名以那边为准。**在此之前不要往这里加字段** —— 两处各长一套的话，合并
 * 那天要改的是所有引用点，而不是这一行。
 */
export type RouteRef = { id: string; dependsOn: string[] };

/**
 * 一条关键问题这一轮的状态。**四挡，不能合并成两挡。**
 *
 * 这是 ISS-239 那一轮最贵的一处错：报告里写「外界没有公开材料」，而 trace 上那条问题的
 * 真实状态是**压根没搜过**。两者在屏幕上长得一模一样，但一个是「查过，世界上没有」，
 * 一个是「我们没查」—— 前者是结论，后者是欠账。
 *
 *  · `未搜`     这一轮没有为它发出过任何检索式（时间不够、或者它压根没进计划）
 *  · `已搜未得` 真的发出去过，回来是空的
 *  · `不适用`   答案不在外部：要内部材料或客户确认（我方能力、客户内部权责这一类）
 *  · `已得`     拿到了可计入印证的独立来源
 */
export type ScopeQuestionStatus = "未搜" | "已搜未得" | "不适用" | "已得";

/**
 * 一条**能改变选择**的关键问题。
 *
 * 决策题的任务范围由这些问题组成，不由八个维度组成。维度退回它本来的身份 —— 一个分类
 * 标签，用来把命题分给某条链、在覆盖表上占一行；它不再是配额（「每维至少 2 条」）也不再
 * 是门槛（「八维各要一组独立来源」）。
 */
export type ScopeQuestion = {
  /** 稳定 ID。同一份草稿跑两遍要得到同一套号 —— trace 和报告都按它对齐。 */
  id: string;
  /** 一句话：这条要弄清的是什么。 */
  question: string;
  /** 分类标签。命题按它分链、覆盖表按它占行。 */
  dimension: DimId;
  /** 关联到哪几条候选路线（`RouteRef.id`）。空表 = 还没挂上，按「不改变选择」处理。 */
  routeIds: string[];
  /** 关联到候选路线的哪几条依赖前提（`RouteRef.dependsOn` 里的 ID）。 */
  dependsOn: string[];
  /** 它的答案会不会改变选哪条路线。补搜优先级只看这一栏。 */
  changesChoice: boolean;
  /**
   * 答案在内部材料或客户那里，外网搜不到。
   *
   * 我方已实现能力、客户内部权责这一类落在这里。**它们必须有地方可落**，否则唯一的出口
   * 是「再搜一轮」—— 而那一轮无论发多少条问法都不会有结果，只会把时间烧光（ISS-239 的
   * 24 分 14 秒里有一块正是这个）。
   */
  needsInternal: boolean;
};

/**
 * 这一轮研究的任务范围。**一处定义，处处读。**
 *
 * 2026-09-07（ISS-239 复盘 §3.B）。在这之前，「这道题该覆盖哪几维」这件事在五个地方各猜
 * 一次：草稿按 `DECISION_DIMS` 只写 D2/D3/D8（`draft.ts:202`，同日改的），而计划那一侧
 * `planGaps` 照旧按八维各要 2 条命题、`overBudget` 照旧查单维占比不过三成、`gateOpen` 照旧
 * 要八维各有一组独立来源。于是决策题每一轮都挂着五维「命题不足」，触发补正，再扩查一圈
 * 没有任何下游会读的维度。**只改「聚焦关键问题」那句提示词没有用** —— 闸不改，模型交上来
 * 就被打回。
 *
 * 所以这个对象是**唯一的口径**：计划生成（`buildPlanUser` / `planSystemFor`）、编译
 * （`compilePlan`）、缺口判定（`planGaps`）、覆盖表（`coverageTable`）、覆盖门
 * （`gateOpen`）、补搜排序与出口检查（`gateScope`）全部读它。
 *
 * **放宽的只有「决策题要不要填满八维」这一件。** 来源质量（`coverage.ts` 的
 * `attributable`）、反证（`planGaps` 的反向问法、`gate.ts` 的 A4-G03）、时效
 * （`props.ts` 的 `freshnessUrgent`）三道检查在任何范围下都照旧 —— 那三件和题型无关。
 */
export type TaskScope = {
  /** `decision` = 要在几条路线里选一条；`industry` = 行业宏观研究，八维全要。 */
  kind: "decision" | "industry";
  /** 这一轮真正适用的维度。不在表上的维度标「不适用」，不计入缺失。 */
  dims: readonly DimId[];
  /** 关键问题。行业题是空表 —— 那种题的范围就是八个维度本身。 */
  questions: readonly ScopeQuestion[];
  /** 适用维度里每维至少几条命题。 */
  minPropsPerDim: number;
  /** 单维检索式占比上限。`null` = 这道题不查占比（理由见 `decisionScope`）。 */
  dimShareCap: number | null;
};

/** 每个维度至少几条命题（行业题）。原来写死在 `plan.ts` 里，提上来供两种范围共用。 */
export const MIN_PROPS_PER_DIM = 2;

/**
 * 行业宏观题的范围：八维全要，一个字不动。
 *
 * 这一份是所有 `scope` 参数的默认值 —— 不传就是它。这样写是为了让「行业题的现有覆盖
 * 要求」在代码上是**同一段代码**而不是同一段被复制的代码：决策题那一支改坏了，行业题
 * 那一支的回归测试不会替它兜底，因为两者根本不共享行为。
 */
export const INDUSTRY_SCOPE: TaskScope = Object.freeze({
  kind: "industry",
  dims: DIM_IDS,
  questions: [],
  minPropsPerDim: MIN_PROPS_PER_DIM,
  dimShareCap: DIM_SHARE_CAP,
});

/**
 * 决策题的范围**兜底**用的那几维。
 *
 * 正常路径不走它：范围里的维度从草稿真的写了哪几维推出来（`plan.ts` 的 `taskScopeFor`）。
 * 只有草稿一维都没写、而这道题又要出决策时才落到这里。
 *
 * 这三个数**必须和 `draft.ts:202` 的 `DECISION_DIMS` 一致**，而那个常量没有导出、
 * 那个文件这一轮由别人在改，所以这里不 import 它。对不上的症状是：草稿写了 D2/D3/D8，
 * 兜底表却给了别的三维，于是覆盖表上出现三行永远为空的维度。真要改的话两处一起改。
 */
const DECISION_FALLBACK_DIMS: readonly DimId[] = ["D2", "D3", "D8"];

/**
 * 决策题的范围。
 *
 * · `minPropsPerDim` 降到 1。决策题的量在关键问题上，不在维度上 —— 一条链上两三个维度
 *   各挂一条命题、而关键问题挂了六条，这是对的形状。仍然要 ≥1：一个进了范围却一条命题
 *   都没有的维度，是计划漏了它，不是它不重要。
 * · `dimShareCap` 关掉（`null`）。三成上限拦的是「一个维度把预算吃光、报告只覆盖行业的一个
 *   角落」（`DIM_SHARE_CAP` 上那段）。决策题**本来就该偏**：要谈的是对方的产线，D2 吃掉一半
 *   检索式是这道题的正确形状。三维题上这条门还必然误报 —— 三维平摊每维就是 33%。
 *   预算不失控由别处兜：每维 `maxPerDim` 条上限、每条命题 3 正 2 反的封顶（`props.ts`）、
 *   决策题少发波（`sweep.ts` 的 `maxWavesFor`）。
 */
export function decisionScope(o: {
  dims?: readonly DimId[];
  questions?: readonly ScopeQuestion[];
}): TaskScope {
  const fromQuestions = (o.questions ?? []).map((q) => q.dimension);
  const wanted = new Set<DimId>([...(o.dims ?? []), ...fromQuestions]);
  // 按 `DIM_IDS` 的顺序排：覆盖表、trace 和报告都按这个顺序读，跟着 Set 的插入序走的话
  // 同一份输入换个书写顺序就换一张表。
  const dims = DIM_IDS.filter((d) => wanted.has(d));
  return {
    kind: "decision",
    dims: dims.length ? dims : DECISION_FALLBACK_DIMS,
    questions: o.questions ?? [],
    minPropsPerDim: 1,
    dimShareCap: null,
  };
}

/**
 * 一条关键问题这一轮的账。**四挡状态 + 未得原因，缺一不可。**
 *
 * 「已获信息」是 `evidenceIds`，「未得原因」是 `why`，「关联的路线」是 `routeIds` ——
 * 交接文档 §3.B 最后一条要的就是这三样能在一行里读全。最要紧的仍然是 `status`：
 * **不能把「没搜」写成「外界不存在」**，所以 `未搜` 和 `已搜未得` 在这里是两个值，
 * 在 `why` 里也是两句不同的话。
 */
export type ScopeQuestionTrace = {
  id: string;
  question: string;
  dimension: DimId;
  routeIds: string[];
  dependsOn: string[];
  changesChoice: boolean;
  status: ScopeQuestionStatus;
  /** 已获信息：替它入账的证据编号。 */
  evidenceIds: string[];
  /** 真的替它发出去过的问法。没发出去的一条都不许上表。 */
  tried: string[];
  /** 未得原因。`已得` 时为空。 */
  why: string;
};

/** 这个维度在不在这一轮的范围里。不在 = 「不适用」，不计入缺失。 */
export const inScope = (scope: TaskScope, dim: DimId): boolean =>
  (scope.dims as readonly string[]).includes(dim);

/**
 * 该优先补搜的那几条问题：**会改变选择、而且外部搜得到**。
 *
 * `needsInternal` 那些不在这里 —— 它们的缺口是真的，但补法是去要内部材料或问客户，不是
 * 再发一轮检索。把它们混进来的后果是无限次网络查询（交接文档 §3.B 第四条）。
 */
export const keyQuestions = (scope: TaskScope): ScopeQuestion[] =>
  scope.questions.filter((q) => q.changesChoice && !q.needsInternal);

/**
 * 一个维度这一轮的覆盖情况。
 *
 * `notFound` 有值 = 这个维度**搜过但没得到**，它将以 `[P]`/`[P!]` 标签成稿。这一栏不是
 * 免责声明，是账：不留它的话，「这一维搜了四轮一无所获」和「这一维压根没进过检索」
 * 在产出上长得一模一样。
 */
export type DimCoverage = {
  dim: DimId;
  /** 折叠后可计入印证的独立来源组数（`coverage.tally` 的 `citableGroups`）。 */
  independentGroups: number;
  notFound?: { tried: string[] };
};

/** 「已搜未得」至少要试过这么多条问法才算数。三条以内多半是同一个问法的微调。 */
export const MIN_TRIED_FOR_NOT_FOUND = 4;

/**
 * 合成前那道门。**范围内的每个维度要么有独立来源，要么有一条已搜未得的记录。**
 *
 * `strongDims` 是这一轮打算下「当前更支持」及以上判断的维度，它们要两组（§2.2）。
 * 门没开时不抛异常 —— 由调用方决定是再补一波还是按现状收口并记缺口。
 *
 * `scope` 决定**查哪几维**，不决定查得松不松：范围内的每一维照旧要一组（强判断两组）
 * 或者一条列了 ≥4 条问法的「已搜未得」。不传就是行业题那一份（八维全查），所以老调用点
 * 一个字不用改，行为也一个字不变。
 *
 * 范围外的维度**不报缺失**，这正是要修的那件事：决策题的草稿只写三维
 * （`draft.ts` 的 `DECISION_DIMS`），而这道门照旧要八维，于是每一轮都挂着五条永远补不上
 * 的缺口 —— 挂着的义务等于没有义务，真正缺的那一条被淹在里面看不见了。
 */
export function gateOpen(
  rows: readonly DimCoverage[],
  strongDims: Iterable<DimId>,
  scope: TaskScope = INDUSTRY_SCOPE
): { ok: boolean; missing: string[] } {
  const strong = new Set(strongDims);
  const byDim = new Map(rows.map((r) => [r.dim, r] as const));
  const missing: string[] = [];
  for (const dim of scope.dims) {
    const row = byDim.get(dim);
    if (!row) {
      // 和「有表但空着」分两句：没上表说明这一维压根没进过检索计划，该退回 N2；
      // 空着说明搜过没搜着，该再改一次问法或落已搜未得。
      missing.push(`${dim} ${dimName(dim)}：整个维度没进过覆盖表 —— 检索计划里没有它`);
      continue;
    }
    const need = strong.has(dim) ? 2 : 1;
    if (row.independentGroups >= need) continue;
    const tried = row.notFound?.tried ?? [];
    if (tried.length >= MIN_TRIED_FOR_NOT_FOUND) continue;
    missing.push(
      row.notFound
        ? `${dim} ${dimName(dim)}：独立来源 ${row.independentGroups} 组（要 ${need} 组），已搜未得只记了 ${tried.length} 条问法，不足 ${MIN_TRIED_FOR_NOT_FOUND} 条`
        : `${dim} ${dimName(dim)}：独立来源 ${row.independentGroups} 组，要 ${need} 组；也没有已搜未得的记录`
    );
  }
  return { ok: missing.length === 0, missing };
}
