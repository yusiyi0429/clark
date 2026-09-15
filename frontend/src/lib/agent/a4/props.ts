/**
 * 命题编译与「够不够」的判定。
 *
 * ## 先定研究什么，再检索
 *
 * 顺序不能反。先搜再定题，问题框架就被第一页搜索结果锚住了 —— 那一页碰巧讲什么，
 * 这次研究就变成讲什么。所以这一步在任何检索之前跑，输入只有议题、预研结论和公司
 * 上下文。
 *
 * 「论证 X」这类议题一律改写成**待检验的命题**，不预设成立。区别是可证伪性：
 * 「我们该不该做 X」搜不出结果也说不清对错；「X 的月活在 2026 年 Q2 超过了 Y」搜得到
 * 就是搜得到，搜不到就明说搜不到。
 *
 * ## 判定「够不够」是确定性的，不问模型
 *
 * 问模型「证据够了吗」，它会答够 —— 它没有不够的动机。所以这里全部按数：几组独立
 * 来源、有没有高档次来源、有没有真的发过一次反向检索。三条义务，各自可算。
 *
 * `judge()` 里的 `counterQuery` 检的是**行为不是结果**：这一轮有没有真的发出去一条
 * 反向问法。查了没查到是合法结果（HP-5），没查是漏了工序 —— 只看结果的话这两种
 * 长得一模一样。
 */

import type { Evidence } from "@/lib/research/ledger";
import { satisfied, weakness, type Tally } from "@/lib/research/coverage";

/** 判定口径的版本号。改了阈值就改它 —— 不然跨两次运行的判定结果没法比。 */
export const POLICY_VERSION = "cr-v1";

/** 重要度到这个分以上算「实质命题」，补搜轮数上限翻倍。 */
const MATERIAL_THETA = 0.7;
/** 时效紧迫度到这个分以上，要求至少一条现状证据带统计期间。 */
const FRESH_URGENT = 0.7;

export type Proposition = {
  id: string;
  /** 一句可证伪的陈述。 */
  statement: string;
  /** 什么样的证据才算回答了它。写给检索用，也写给「为什么这条还差着」用。 */
  requiredEvidence: string;
  /** 正向检索式。 */
  queries: string[];
  /** 反向检索式 —— 专门去找推翻它的东西。发没发出去是可查的。 */
  counterQueries: string[];
  /** 实质命题：结论主要靠它。 */
  material: boolean;
  /** 时效紧迫：拿旧数描述现状会出错。 */
  freshnessUrgent: boolean;
  /** 这条最多再补搜几轮。 */
  extraRoundsCap: number;
};

/** 模型交上来的形状。分数由模型给，阈值由代码定。 */
type RawProp = {
  statement?: unknown;
  requiredEvidence?: unknown;
  queries?: unknown;
  counterQueries?: unknown;
  materialityWeight?: unknown;
  freshnessUrgency?: unknown;
};

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const strs = (v: unknown, cap: number): string[] =>
  (Array.isArray(v) ? v : []).map(s).filter(Boolean).slice(0, cap);

/**
 * 模型产出 → 命题清单。**阈值判定在这里，不在提示词里。**
 *
 * `maxProps` 来自 `Harness.budget`，随思考深度变。命题数是这条链最贵的乘数 ——
 * 每多一条就多一轮检索、抓取和抽取。
 */
export function compile(raw: { propositions?: unknown }, maxProps: number): Proposition[] {
  const list = (Array.isArray(raw.propositions) ? raw.propositions : []) as RawProp[];
  return list
    .map((p) => ({ p, statement: s(p.statement) }))
    .filter((x) => x.statement.length >= 6)
    .slice(0, maxProps)
    .map((x, i) => {
      const material = num(x.p.materialityWeight) >= MATERIAL_THETA;
      return {
        id: `P${i + 1}`,
        statement: x.statement,
        requiredEvidence: s(x.p.requiredEvidence),
        queries: strs(x.p.queries, 3),
        counterQueries: strs(x.p.counterQueries, 2),
        material,
        freshnessUrgent: num(x.p.freshnessUrgency) >= FRESH_URGENT,
        // 实质命题给两轮，其余一轮。无上限的补搜循环是这类系统最容易长出来的坑：
        // 它会一直搜到超时，而超时的报告和搜不到的报告在结果页上都是空白。
        extraRoundsCap: material ? 2 : 1,
      };
    });
}

/* -------------------------------------------------------------------------- */
/* 判定                                                                        */
/* -------------------------------------------------------------------------- */

/** 高档次来源。「核心结论只有媒体转述在撑」要判得出来。 */
const HIGH_TIER = new Set(["A", "B"]);

export type Verdict = {
  propositionId: string;
  /** 三条义务全过。 */
  ok: boolean;
  tally: Tally;
  /** 没过的义务，人话。直接进漏斗和报告的「未能核实」一节。 */
  unmet: string[];
  /**
   * 终态。非空表示**不再补搜**了，而且报告必须照实说。
   *  · `unknown_snapshot_gap` 一条来源都没找到
   *  · `unavailable`          找到了来源但凑不齐独立印证，且轮数用完
   */
  terminal: "" | "unknown_snapshot_gap" | "unavailable";
};

/**
 * 一条命题够不够。
 *
 * `counterQueriesSent` 传的是**这条命题实际发出去过的反向检索式条数**，不是搜到几条。
 */
export function judge(
  p: Proposition,
  tally: Tally,
  entries: Evidence[],
  counterQueriesSent: number,
  roundsUsed: number
): Verdict {
  const unmet: string[] = [];

  const covered = satisfied(tally);
  if (!covered) unmet.push(weakness(tally));

  // 实质命题不能只有媒体转述撑着。非实质的不管 —— 那道门开在所有命题上会让每次
  // 深研都挂着几条永远补不上的义务，而挂着的义务等于没有义务。
  if (p.material && entries.length && !entries.some((e) => HIGH_TIER.has(e.sourceTier))) {
    unmet.push("这条是结论的主要支撑，但入账的证据里没有一条来自监管、官方统计、公司披露或行业机构");
  }

  if (p.freshnessUrgent && !entries.some((e) => e.usedAs === "current_state" && (e.period ?? "").trim())) {
    unmet.push("这条对时效敏感，但没有一条标了统计期间的现状证据 —— 无从判断是不是拿旧数在说现在");
  }

  // 行为义务：查了没查到是结果，没查是工序漏了。
  if (counterQueriesSent === 0) unmet.push("这一轮没有发出过任何反向检索，没找过推翻它的东西");

  const exhausted = roundsUsed > p.extraRoundsCap;
  const terminal: Verdict["terminal"] = covered
    ? ""
    : tally.groups === 0 && exhausted
      ? "unknown_snapshot_gap"
      : exhausted
        ? "unavailable"
        : "";

  return { propositionId: p.id, ok: unmet.length === 0, tally, unmet, terminal };
}

/** 终态的人话。报告的「未能核实」一节直接用。 */
export function terminalText(v: Verdict): string {
  switch (v.terminal) {
    case "unknown_snapshot_gap":
      return "本轮检索没有找到任何可用来源";
    case "unavailable":
      return `补搜轮数用完仍未闭合：${v.unmet.join("；")}`;
    default:
      return "";
  }
}
