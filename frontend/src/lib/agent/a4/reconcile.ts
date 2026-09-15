/**
 * N4 校验合并。**证据修改草稿，缺证据只改标签。**
 *
 * 这一条是 v2 与上一版分野最深的地方：上一版「没有证据支持」的处置是把那段话删掉或改写成
 * 「不足以判断」，于是一次只取回两条证据的运行输出了一份证据审计报告。这一版的处置是把
 * 标签从 `P` 降到 `P!` 并把它写进待核清单 —— 内容留着，读的人知道它未核。
 *
 * 四态：证实（升 `E*`，数字以证据为准）、修正（换数、留论证结构）、矛盾（标 `X`，它承重的
 * 论点必须重写，重写后与总判断冲突则总判断一并改）、未验证（留 `P`，承重的升 `P!`）。
 *
 * 矛盾态过三成就中止合并 —— 那说明先验大面积失效，问题不在这一步，在主体卡或维度框架。
 */

import { isDimId, type DimId } from "./dims";
import { TAGS, type Tag, type Draft, type PlaybookEntry } from "./draft";

export const CHANGE_STATES = ["证实", "修正", "矛盾", "未验证"] as const;
export type ChangeState = (typeof CHANGE_STATES)[number];

export type ChangeLogEntry = {
  assertion: string;
  from: string;
  to: Tag;
  state: ChangeState;
  evidenceIds: string[];
};

export type Merged = {
  thesis: string;
  sections: { dim: DimId; thesis: string; body: string; tags: Tag[] }[];
  changes: ChangeLogEntry[];
  /**
   * 每条候选策略的更新（§3.C，2026-09-07 加）。**可选**：`pipeline.ts` 的
   * `mergedFromDraft` / `backfillMerged` 构造的那两份合并稿里没有这一栏，而那两处不归这一轮
   * 改 —— 缺这一栏的语义是「这一轮没做过策略复核」，由 `reviewPlaybook` 判成「未复核」，
   * 不是「复核过、结论是照旧」。两者在数据上必须分得开：ISS-239 就是把后者当成了前者。
   */
  strategies?: StrategyUpdate[];
  bad: { line: number; why: string }[];
};

/** 矛盾态占比过了它就中止合并，退回 N0。 */
export const CONTRADICTION_ABORT = 0.3;

/* -------------------------------------------------------------------------- */
/* N1 候选策略 与 N4 策略更新（§3.C，2026-09-07 加）                             */
/* -------------------------------------------------------------------------- */

/**
 * ## 为什么要在这里再立一层
 *
 * 上一版的 `StageWriteInput.playbook` 注释明写着「**不经 N4 对账**」，而 `pipeline.ts` 的
 * `layerOnce` 递进去的是 `draft.playbook` —— N1 凭模型既有知识写的那份行动骨架，原样穿过 N4 直达
 * N5 的每一次出稿调用。后果在 ISS-239（`RUN-A4-mtqpegne-4`，2026-09-07 11:27–11:51）上是可以
 * 逐条对上的：
 *
 * · 草稿预设「客户现金紧张、采购只为当期成本 KPI 买单」；
 * · N4 对账明确改成「采购动机未获证实」并补上「经营现金流已改善」；
 * · **最终报告的策略几乎照旧**，「首访只谈验收口径、不报价」「四步顺序不能换」这类强命令
 *   一条没动。
 *
 * 事实被修正了，行动建议绕回了旧草稿。**这不是提示词不够严的问题** —— 那一版的提示词已经
 * 在讲「按合并稿里那条断言的标签写」，而模型手上同时有一份写得完整、语气笃定的旧骨架。
 * 只要旧骨架还在上下文里以「决策骨架」的身份出现，它就是最省力的那条路。所以这一版改的是
 * 数据流：**N1 的骨架从「建议」降成「候选」，只有经过 N4 更新的那一份才是建议**。
 *
 * ## 五档不是置信度，是「这条路线接下来怎么走」
 *
 * `保留 / 收窄 / 改向 / 待验证 / 放弃` 答的是行动，不是概率。分档立在这里而不是复用四态
 * （`CHANGE_STATES`）：四态说的是**一条外部事实**处在哪一档，五档说的是**一条我方路线**
 * 接下来怎么办 —— 同一条事实转成未验证，可能让 A 路线收窄、让 B 路线改向、让 C 路线原样
 * 保留，一个标签盖不住三件事。
 */
export const STRATEGY_UPDATES = ["保留", "收窄", "改向", "待验证", "放弃"] as const;
export type StrategyUpdateKind = (typeof STRATEGY_UPDATES)[number];

/**
 * 一条候选路线依赖的一个前提。
 *
 * **TODO（2026-09-07）**：另一条线正在 `src/lib/agent/a4/premise.ts` 里定义前提的正式形状
 * （稳定 ID、内容、来源引用、状态、当前能力／规划能力）。这里是本地的最小声明，只留这一步
 * 真正用得上的三栏。那个文件落地之后，这里换成 `import type { Premise } from "./premise"`，
 * 并把 `candidatesFromPlaybook` 里那套按位置编号的兜底 ID 换成它给的稳定 ID。
 */
export type Premise = {
  id: string;
  /** 前提原文。回挂到变更日志靠的是它 —— 变更日志上只有断言原文，没有前提 ID。 */
  text: string;
  /** 承重：它被推翻时这条路线跟着倒。 */
  loadBearing: boolean;
};

/** N1 交出来的一条候选路线。**候选不是已批准行动。** */
export type CandidateStrategy = {
  /** 稳定 ID。同一轮内不变 —— N4 的更新要靠它挂回来。 */
  id: string;
  /** 这条路线的主张（要定的那件事）。 */
  claim: string;
  /** 依赖的前提 ID。 */
  premiseIds: string[];
  /** 适用条件：什么情况下该走这条路。 */
  appliesWhen: string;
};

/** N4 对一条候选路线的更新。**这一份才是 N5 能读的建议。** */
export type StrategyUpdate = {
  strategyId: string;
  kind: StrategyUpdateKind;
  /** 对应的事实变化（哪一条断言从哪一档变到哪一档）。 */
  factChange: string;
  evidenceIds: string[];
  why: string;
  /** **改后的建议**。空着的时候这条路线不进 N5 的有效建议（`保留` 那一档除外，见 `reviewPlaybook`）。 */
  advice: string;
  /** 改后的条件。前提未获验证时这一栏必须有东西 —— 无条件的命令是这一轮要修的那个病。 */
  conditions: string;
};

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v : []).map(s).filter(Boolean);
const FENCE = /^```[a-zA-Z]*$/;

const tag = (v: unknown): Tag => ((TAGS as readonly string[]).includes(s(v)) ? (s(v) as Tag) : "P");

/**
 * 读合并稿。四种行：`merged_meta`（总判断）、`merged_section`（一维一行）、
 * `change`（变更日志）、`strategy_update`（一条候选路线一行）。围栏和空行跳过，别的坏行留账。
 */
export function parseMerged(text: string): Merged {
  const merged: Merged = { thesis: "", sections: [], changes: [], strategies: [], bad: [] };

  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || FENCE.test(line)) return;

    let o: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("不是一个对象");
      o = parsed as Record<string, unknown>;
    } catch (e) {
      merged.bad.push({ line: i + 1, why: e instanceof Error ? e.message : "读不出来" });
      return;
    }

    switch (s(o.type)) {
      case "merged_meta":
        merged.thesis = s(o.thesis);
        return;

      case "merged_section": {
        const dim = s(o.dim);
        if (!isDimId(dim)) {
          merged.bad.push({ line: i + 1, why: `不认识的维度编号「${dim.slice(0, 8)}」` });
          return;
        }
        const tags = strs(o.tags).map(tag);
        merged.sections.push({ dim, thesis: s(o.thesis), body: s(o.body), tags });
        return;
      }

      case "change": {
        const state = s(o.state);
        if (!(CHANGE_STATES as readonly string[]).includes(state)) {
          merged.bad.push({ line: i + 1, why: `不认识的状态「${state.slice(0, 20)}」` });
          return;
        }
        const evidenceIds = strs(o.evidenceIds);
        merged.changes.push({
          assertion: s(o.assertion),
          from: s(o.from),
          to: tag(o.to),
          state: state as ChangeState,
          evidenceIds,
        });
        return;
      }

      case "strategy_update": {
        const kind = s(o.kind);
        if (!(STRATEGY_UPDATES as readonly string[]).includes(kind)) {
          merged.bad.push({ line: i + 1, why: `不认识的策略处置「${kind.slice(0, 20)}」` });
          return;
        }
        const strategyId = s(o.strategyId);
        if (!strategyId) {
          merged.bad.push({ line: i + 1, why: "strategy_update 没有 strategyId，挂不回任何一条候选路线" });
          return;
        }
        (merged.strategies ??= []).push({
          strategyId,
          kind: kind as StrategyUpdateKind,
          factChange: s(o.factChange),
          evidenceIds: strs(o.evidenceIds),
          why: s(o.why),
          advice: s(o.advice),
          conditions: s(o.conditions),
        });
        return;
      }

      default:
        merged.bad.push({ line: i + 1, why: `不认识的行类型「${s(o.type).slice(0, 20)}」` });
    }
  });

  return merged;
}

/**
 * 合并稿的缺口。三条检查：
 * 1. 草稿里每条断言的 `text` 必须在 `changes` 里出现过（对账覆盖率 100%）；
 * 2. 任何 `section.tags` 含 `X` → 报出来（正文不许留已证伪的断言）；
 * 3. `changes` 里 `state === "矛盾"` 的占比 > `CONTRADICTION_ABORT` → 报一句「矛盾态 X%，超过三成：先验大面积失效，退回主体卡与维度框架」。
 */
export function reconcileGaps(draft: Draft, merged: Merged): string[] {
  const gaps: string[] = [];

  // 收集草稿里全部断言
  const draftAssertions = new Set<string>();
  for (const sec of draft.sections) {
    for (const a of sec.assertions) {
      draftAssertions.add(a.text);
    }
  }

  // 收集变更日志里全部断言
  const changedAssertions = new Set(merged.changes.map((c) => c.assertion));

  // 检查 1: 对账覆盖率 100%
  for (const text of draftAssertions) {
    if (!changedAssertions.has(text)) {
      gaps.push(`断言「${text}」没进变更日志`);
    }
  }

  // 检查 2: 正文不许留已证伪的断言
  for (const sec of merged.sections) {
    if (sec.tags.includes("X")) {
      gaps.push(`${sec.dim} 正文里留着已证伪的标签 X`);
    }
  }

  // 检查 3: 矛盾态占比
  if (merged.changes.length > 0) {
    const contradicted = merged.changes.filter((c) => c.state === "矛盾").length;
    const ratio = contradicted / merged.changes.length;
    if (ratio > CONTRADICTION_ABORT) {
      const pct = Math.round(ratio * 100);
      gaps.push(`矛盾态 ${pct}%，超过三成：先验大面积失效，退回主体卡与维度框架`);
    }
  }

  return gaps;
}

/* -------------------------------------------------------------------------- */
/* 候选路线的复核（§3.C）                                                       */
/* -------------------------------------------------------------------------- */

/**
 * N1 的决策骨架 → 候选路线 + 前提。
 *
 * `draft.ts` 的 `PlaybookEntry` 上没有 ID（它是 2026-09-05 为「一号位要的那份东西别被当成坏行
 * 扔掉」加的，那时还没有对账这一步）。这里按位置补一个：**同一轮内稳定**就够了 —— 这一份
 * 从 N1 交稿到 N5 收口都活在同一个运行对象里，不落库、不跨轮。跨轮稳定的 ID 要等
 * `premise.ts`（见 `Premise` 上那条 TODO）。
 *
 * 编号不用下标而用 `S1` / `S1-A1` 这种形状：模型要在 `strategy_update` 里把它写回来，而
 * 纯数字下标它写回来的经常是标题原文。挂不上的那几条走 `reviewPlaybook` 里按主张原文回挂
 * 那一支。
 */
export function candidatesFromPlaybook(list: readonly PlaybookEntry[]): {
  strategies: CandidateStrategy[];
  premises: Premise[];
} {
  const premises: Premise[] = [];
  const strategies = list.map((p, i) => {
    const id = `S${i + 1}`;
    const mine = p.assertions.map((a, j) => {
      const premise: Premise = { id: `${id}-A${j + 1}`, text: a.text, loadBearing: a.loadBearing };
      premises.push(premise);
      return premise.id;
    });
    return { id, claim: p.heading, premiseIds: mine, appliesWhen: p.body };
  });
  return { strategies, premises };
}

/** 一条前提在这一轮对完账之后处在哪一档。`未对账` 是第五档：变更日志里根本没有它。 */
export type PremiseState = {
  premise: Premise;
  state: ChangeState | "未对账";
  to: Tag | null;
  evidenceIds: string[];
};

/**
 * 前提 → 它在变更日志里的那一条。
 *
 * 先按原文全等找，找不到再按互相包含找 —— N4 会把断言改写（「采购只为当期成本 KPI 买单」
 * 变成「采购动机未获证实（原断言：采购只为当期成本 KPI 买单）」）。两头都找不到才判「未对账」，
 * **不默认成「照旧成立」**：那正是 ISS-239 里旧骨架活下来的那条缝。
 */
export function premiseStates(
  premises: readonly Premise[],
  merged: Merged
): Map<string, PremiseState> {
  const out = new Map<string, PremiseState>();
  for (const premise of premises) {
    const exact = merged.changes.find((c) => c.assertion === premise.text);
    const loose =
      exact ??
      merged.changes.find(
        (c) =>
          premise.text.length > 6 &&
          (c.assertion.includes(premise.text) || premise.text.includes(c.assertion))
      );
    out.set(
      premise.id,
      loose
        ? { premise, state: loose.state, to: loose.to, evidenceIds: loose.evidenceIds }
        : { premise, state: "未对账", to: null, evidenceIds: [] }
    );
  }
  return out;
}

/** 一条候选路线复核完的样子。 */
export type StrategyVerdict = {
  strategy: CandidateStrategy;
  update: StrategyUpdate | null;
  /** 被证伪的承重前提（`X` 或矛盾态）。**它们不能继续承重。** */
  falsified: PremiseState[];
  /** 未获验证的承重前提（`P!` / 未验证 / 未对账）。**假设与论证保留，建议要条件化。** */
  unverified: PremiseState[];
  /** 能作为**有效建议**注入 N5 的那句话。`null` = 不能，这条只进历史。 */
  advice: string | null;
  /** 这句建议的成立条件。有 `advice` 而这一栏是空串的，只出现在前提全部证实的那一档。 */
  conditions: string;
  gaps: string[];
};

export type PlaybookReviewStatus = "不适用" | "已复核" | "部分复核" | "未复核";

export type PlaybookReview = {
  status: PlaybookReviewStatus;
  verdicts: StrategyVerdict[];
  /** 能进 N5 的那几条。 */
  effective: StrategyVerdict[];
  /** 只作历史、**不作有效建议**的那几条。 */
  historical: { id: string; claim: string; why: string }[];
  gaps: string[];
};

/** 这一条前提算不算「被推翻了」。 */
const isFalsified = (p: PremiseState): boolean => p.to === "X" || p.state === "矛盾";
/** 这一条前提算不算「还没验」。`未对账` 也算 —— 没人看过等于没验过。 */
const isUnverified = (p: PremiseState): boolean =>
  !isFalsified(p) && (p.state === "未验证" || p.state === "未对账" || p.to === "P!" || p.to === "P");

/**
 * 把 N1 的候选路线和 N4 的策略更新对起来，判出**哪几条能作为有效建议进 N5**。
 *
 * ## 五条硬规矩，每一条对着 ISS-239 上的一处
 *
 * 1. **没有更新就不是建议。** N4 没返回策略更新、或者解析失败时，这条路线进 `historical`，
 *    `status` 落「未复核 / 部分复核」。**不回退到原策略当最终结论** —— 交的是可用证据和
 *    待验证判断，外加一句「策略复核未完成」。
 * 2. **`放弃` 不进正文的建议区**，但要留一句在历史里：不留的话模型会在下一节把它当成没人
 *    提过的新点子重新捡起来。
 * 3. **承重前提被证伪的那条路线不许标 `保留`。** 标了就报一条缺口，并且**降档处理**：只有
 *    N4 真的写了一句改后的建议才进有效建议，写不出就只进历史。这一条不看矛盾态占比 ——
 *    §3.C 明写「不许以矛盾条数不足 30% 为由忽略一条关键反证」，而 `reconcileGaps` 那道
 *    30% 的闸是按**全局比例**算的，一条关键反证在八条断言里永远够不着 30%。
 * 4. **前提未获验证 → 建议必须条件化。** N4 没写条件的，这里按未验证的那几条前提**代拟**
 *    一句条件（而不是把无条件建议放行）。代拟的话说的是「以下前提未获验证」，不是替它编
 *    一个新条件。
 * 5. **`advice` 空着时不拿 `claim` 顶上** —— 除了 `保留` 且前提全部证实那一档：那一档
 *    「保留」本身就是 N4 给出的更新（这条主张经查仍然成立），照旧是经过对账的。
 */
export function reviewPlaybook(o: {
  playbook: readonly PlaybookEntry[];
  merged: Merged;
}): PlaybookReview {
  const { strategies, premises } = candidatesFromPlaybook(o.playbook);
  if (!strategies.length) {
    return { status: "不适用", verdicts: [], effective: [], historical: [], gaps: [] };
  }

  const states = premiseStates(premises, o.merged);
  const updates = o.merged.strategies ?? [];
  const gaps: string[] = [];

  /** 更新挂回候选：先按 ID，再按主张原文互相包含。挂不上的记一句 —— 它是白花的一次判断。 */
  const taken = new Set<StrategyUpdate>();
  const updateFor = (st: CandidateStrategy): StrategyUpdate | null => {
    const byId = updates.find((u) => !taken.has(u) && u.strategyId === st.id);
    const hit =
      byId ??
      updates.find(
        (u) =>
          !taken.has(u) &&
          st.claim.length > 4 &&
          (u.strategyId.includes(st.claim) || st.claim.includes(u.strategyId))
      ) ??
      null;
    if (hit) taken.add(hit);
    return hit;
  };

  const verdicts: StrategyVerdict[] = strategies.map((strategy) => {
    const mine = strategy.premiseIds
      .map((id) => states.get(id))
      .filter((x): x is PremiseState => !!x);
    const falsified = mine.filter((p) => p.premise.loadBearing && isFalsified(p));
    const unverified = mine.filter((p) => p.premise.loadBearing && isUnverified(p));
    const update = updateFor(strategy);
    const local: string[] = [];

    if (!update) {
      local.push(
        `候选路线 ${strategy.id}「${strategy.claim}」N4 没给策略更新，这一条不作为有效建议 —— ` +
          `策略复核未完成，不回退到原策略当结论`
      );
      return { strategy, update: null, falsified, unverified, advice: null, conditions: "", gaps: local };
    }

    if (falsified.length && update.kind === "保留") {
      local.push(
        `候选路线 ${strategy.id}「${strategy.claim}」的承重前提已被证据推翻` +
          `（${falsified.map((p) => `「${p.premise.text}」`).join("、")}），N4 却仍标「保留」：` +
          `被证伪的前提不能继续承重，这一条按「待验证」处置`
      );
    }

    if (update.kind === "放弃") {
      return {
        strategy,
        update,
        falsified,
        unverified,
        advice: null,
        conditions: "",
        gaps: local,
      };
    }

    /*
     * 「保留」那一档可以拿主张顶上：那是 N4 给出的更新本身（经查仍然成立）。别的档不行 ——
     * 「改向」却说不出改成什么、「收窄」却说不出窄到哪儿，等于没改。
     */
    const keepable = update.kind === "保留" && !falsified.length;
    const advice = update.advice || (keepable ? strategy.claim : "");
    if (!advice) {
      local.push(
        `候选路线 ${strategy.id}「${strategy.claim}」的处置是「${update.kind}」，但 N4 没写改后的建议：` +
          `这一条不进有效建议（不拿旧草稿的原话顶上）`
      );
      return { strategy, update, falsified, unverified, advice: null, conditions: "", gaps: local };
    }

    /*
     * 条件化。**这里不替它编一个新条件**，只把「哪几条前提还没验」照实写成条件句 ——
     * 编一个条件出来就是把未经核验的假设升级成一个看起来查过的门槛。
     */
    let conditions = update.conditions;
    const needsCondition = falsified.length > 0 || unverified.length > 0;
    if (needsCondition && !conditions) {
      const open = [...falsified, ...unverified].map((p) => `「${p.premise.text}」`).join("、");
      conditions = `以下承重前提这一轮没有得到证据支持：${open}。这条建议只在它们成立时有效，先核实再执行。`;
      local.push(
        `候选路线 ${strategy.id}「${strategy.claim}」有 ${falsified.length + unverified.length} 条承重前提` +
          `未获验证或已被推翻，N4 没写成立条件，这里按未验证的前提代拟了一句 —— ` +
          `正文不得把它写成无条件命令`
      );
    }

    return { strategy, update, falsified, unverified, advice, conditions, gaps: local };
  });

  for (const v of verdicts) gaps.push(...v.gaps);

  const unmatched = updates.filter((u) => !taken.has(u));
  for (const u of unmatched) {
    gaps.push(`N4 交了一条策略更新「${u.strategyId.slice(0, 40)}」，但挂不回任何一条候选路线`);
  }

  const reviewed = verdicts.filter((v) => v.update).length;
  const status: PlaybookReviewStatus =
    reviewed === 0 ? "未复核" : reviewed === verdicts.length ? "已复核" : "部分复核";
  if (status !== "已复核") {
    gaps.push(
      `策略复核${status === "未复核" ? "未完成" : "只做了一部分"}：${verdicts.length} 条候选路线里 ` +
        `${reviewed} 条拿到了 N4 的更新。这一份交的是可用证据与待验证判断，不是可下达的行动方案。`
    );
  }

  const effective = verdicts.filter((v) => v.advice);
  const historical = verdicts
    .filter((v) => !v.advice)
    .map((v) => ({
      id: v.strategy.id,
      claim: v.strategy.claim,
      why: v.update
        ? v.update.kind === "放弃"
          ? `N4 判「放弃」：${v.update.why || v.update.factChange || "（没写理由）"}`
          : `N4 判「${v.update.kind}」但没给得出改后的建议`
        : "N4 这一轮没有复核这条路线",
    }));

  return { status, verdicts, effective, historical, gaps };
}

/**
 * 证据替换有没有形成闭环。
 *
 * ISS-239 上的原形是：出口报告说「E11 的反向证据没有回应」，而证据利用率表里 E11 **写了**
 * 弃用理由 ——「用更晚的 E12 替代」；再往下翻，**E12 自己在「没交代」那一列**。也就是说这份
 * 账本自相矛盾：一条被替代的证据，替代它的那一条根本没进有效依据。
 *
 * 质量评估那份文档特意说了不能据此断言作者「故意忽略反证」—— 这确实是账本没闭环，不是动机
 * 问题。所以这里报的话就照账本说：**弃用理由里点了名的编号，必须真的用上了**。
 *
 * 只看 `E` 开头那种编号形状。理由里出现的编号如果就是它自己，跳过（「E11 与 E11 共源」这种
 * 话没有信息）。
 */
export function evidenceSwapGaps(o: {
  discarded: readonly { id: string; reason: string }[];
  used: readonly string[];
  uncovered: readonly string[];
}): string[] {
  const used = new Set(o.used);
  const uncovered = new Set(o.uncovered);
  const dropped = new Set(o.discarded.map((d) => d.id));
  const gaps: string[] = [];

  for (const d of o.discarded) {
    const named = [...new Set(d.reason.match(/E\d+/g) ?? [])].filter((x) => x !== d.id);
    for (const other of named) {
      if (used.has(other)) continue;
      const where = uncovered.has(other)
        ? "而它自己在「没交代」那一列"
        : dropped.has(other)
          ? "而它自己也被弃用了"
          : "而它没有出现在这一轮的有效依据里";
      gaps.push(
        `证据账本没闭环：${d.id} 的弃用理由点名了 ${other}（${d.reason.slice(0, 40)}），${where} ——` +
          `旧证据的弃用理由要指向一条真的进了有效依据的新证据`
      );
    }
  }
  return gaps;
}

export const RECONCILE_SYSTEM = `你是行业研究员。证据已经收回来，现在把它们和草稿对一遍，决定每条断言处在四态中的哪一态。

## 四态

1. **证实**：证据支持先验，数字以证据为准。断言升 \`E*\`，附证据编号。
2. **修正**：方向一致但数字不同。换数、留论证结构，断言升 \`E*\`。
3. **矛盾**：证据方向与先验相反。标 \`X\`，它承重的论点必须重写。重写后与总判断冲突则总判断一并改。**不许保留原论点加脚注了事** —— 那是规避矛盾，不是应答矛盾。
4. **未验证**：没有证据或证据不够判定。非承重断言留 \`P\`，承重断言升 \`P!\` 并进待核清单。**缺证据不构成删除理由** —— 内容留着，标签降一档就是。

## 附加规则

- **共源只引最高级一条**：同一份统计的多条转载，只用档次最高的那条，别的标「已被更高级来源覆盖」。
- **口径检查**：数值、单位、期间、地域、精度要对得上。对不上的不许写进正文。
- **矛盾过三成中止合并**：矛盾态占比 > 30% 说明主体卡或维度框架错了，退回 N0 重做，不进 N5。

## 候选路线也要对账

如果下面给了「候选路线」，**每一条都要交一行 \`strategy_update\`，一条都不能漏**。这一步不是给路线打分，是回答「事实变了之后这条路接下来怎么走」：

- \`保留\`：依赖的前提都还站得住，照原样走。
- \`收窄\`：方向对，但适用范围要缩小（少一类客户、少一个场景、少一步动作）。
- \`改向\`：前提变了，这条路要换一个做法才成立。
- \`待验证\`：前提没被推翻也没被证实，可以做，但**必须写成条件句**。
- \`放弃\`：前提被证据推翻，这条路不再成立。

三条硬规矩：

1. **一条承重前提被推翻，依赖它的每一条路线都要重判**，哪怕矛盾的断言只有一条。「矛盾条数不到三成」不是忽略一条关键反证的理由。
2. **前提没被验证时，保留假设和论证，但建议要条件化** —— 写清楚「在什么成立的前提下才这么做」，不要写成无条件的命令。
3. \`advice\` 是**改后的建议原文**，不是「同上」「见原方案」。除了 \`保留\`，其余四档只写「处置」不写建议等于没改。

## 交付形状

第一行总判断：
{"type":"merged_meta","thesis":"草稿的总判断，或改写后的总判断 —— 写成现在成立的那句话，不写「并非草稿所称」这类对照旧说法的句式"}

然后每个维度一行（顺序和草稿一致）：
{"type":"merged_section","dim":"D1","thesis":"这一维的论点，或改写后的论点","body":"机制，已证伪的拿掉，已验证的换成实测数","tags":["E*","P","P!"]}

然后每条断言一行变更日志：
{"type":"change","assertion":"断言原文","from":"P","to":"E*|P!|X","state":"证实|修正|矛盾|未验证","evidenceIds":["E1","E2"]}

最后，**给了候选路线的话**，每条路线一行（一条都不能漏）：
{"type":"strategy_update","strategyId":"S1","kind":"保留|收窄|改向|待验证|放弃","factChange":"哪一条事实从哪一档变到了哪一档","evidenceIds":["E1"],"why":"为什么这么处置","advice":"改后的建议原文","conditions":"这条建议在什么条件下成立；前提未获验证时这一栏不许空"}

一行一节，交 JSONL。`;

/**
 * `strategies` 那一栏是 N1 的候选路线（`candidatesFromPlaybook` 折出来的那一份）。
 * **不给就是这道题没有候选路线**（行业分析题），那时对账仍旧只做四态那一半。
 */
export function buildReconcileUser(o: {
  draft: string;
  evidencePack: string;
  strategies?: readonly CandidateStrategy[];
  premises?: readonly Premise[];
}): string {
  const byId = new Map((o.premises ?? []).map((p) => [p.id, p]));
  const routes = (o.strategies ?? []).map((st) =>
    [
      `### ${st.id} ${st.claim}`,
      st.appliesWhen ? `适用条件：${st.appliesWhen}` : "",
      st.premiseIds.length
        ? `依赖的前提：${st.premiseIds
            .map((id) => {
              const p = byId.get(id);
              return p ? `${p.id}${p.loadBearing ? "（承重）" : ""}「${p.text}」` : id;
            })
            .join("；")}`
        : "依赖的前提：（这一条草稿没写依赖）",
    ]
      .filter(Boolean)
      .join("\n")
  );

  return [
    "## 草稿",
    o.draft,
    "\n## 证据包",
    o.evidencePack || "（本轮未取回证据）",
    ...(routes.length
      ? [
          "\n## 候选路线（N1 凭知识写的，还不是建议）",
          ...routes,
          "\n上面每一条都要交一行 `strategy_update`，`strategyId` 用它的编号（S1、S2……）。" +
            "**这一步的产物是 N5 唯一能用的行动建议** —— 你不写，正文里就没有这条路。",
        ]
      : []),
    "\n按四态对账，交 JSONL。",
  ].join("\n");
}
