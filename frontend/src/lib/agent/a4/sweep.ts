/**
 * N3 分维度取证。**链按维度切，不按模型切。**
 *
 * 上一版是四个模型各跑一整套研究。两次实验都证明它买到的不是信息多样性而是共源冗余：
 * 四条链撞上同一批稿子，然后各自把它们读一遍。信息多样性来自**查询分解**，不来自模型
 * 数量 —— 所以这一版把并行的轴换成维度，模型只是链的执行引擎，可以互换。
 *
 * 每条链自己领几个维度的全部命题，自己跑 `gatherEvidence`（检索→抓取→抽取→入账→折叠
 * →判定那六段一个字不改），跑完一波看入账：共源过半就换方向再发一波，一条都没入账就换问法
 * 再发一波（只给一次，`cosource.ts` 的 `waveDecision`）。
 *
 * ## 收口只有两种合法形态
 *
 * 每个维度要么有独立来源，要么有一条「已搜未得」的记录（列出试过的全部问法，并声明这一维
 * 将以 `[P]`/`[P!]` 成稿）。**缺维度不许静默消失** —— 上一版的「未能核实」只覆盖已生成的
 * 命题，压根没生成过的命题不在任何清单上。
 *
 * ## 几条链是并着跑的，账按链序合
 *
 * 链之间没有任何依赖：各领几个维度、各自一份台账、各自判定。串着跑只是把四段等待加起来
 * —— 这一处加上每波里那五页串行抽取，就是 2026-08-27 那一轮 47 分钟的形状（ISS-112）。
 * 现在四条一起跑（`CHAIN_CONCURRENCY`），合账时按 `CHAINS` 的顺序合，所以台账编号和
 * trace 上的链序跟改动之前一样。
 *
 * ## 时间不够就少发一波，并且说出来
 *
 * 每波开始之前问一次「还剩多少、后面出稿要留多少」（`deadline.ts`）。不够就停在这一波，
 * 往 `capped` 里记一句原话 —— 那句话最后印在报告文首的机检清单里。**少搜而不说**的话，
 * 一份因为到点收口的报告和一份「外面就是没有材料」的报告在屏幕上一模一样。
 */

import type { Harness } from "@/lib/agent/harness";
import { mapPool } from "@/lib/agent/pool";
import type { Slot } from "@/lib/models/slots";
import { fetchPages } from "@/lib/research/fetch";
import { Ledger } from "@/lib/research/ledger";
import { searchAll, type SearchHit, type SearchProvider } from "@/lib/research/search";
import { attributable } from "@/lib/research/coverage";
import type { Evidence } from "@/lib/research/ledger";

import { COST, room, shedNote, WRITE_RESERVE_MS } from "./deadline";
import {
  dimName,
  gateOpen,
  INDUSTRY_SCOPE,
  keyQuestions,
  type DimCoverage,
  type DimId,
  type ScopeQuestionTrace,
  type TaskScope,
} from "./dims";
import { buildRewriteUser, readRewrite, rewriteSystemFor, waveDecision, waveShare } from "./cosource";
import { gatherEvidence, SEEDS_PER_ROUND, type Round } from "./evidence";
import { resupply, shortfalls } from "./resupply";
import { routeSeeds } from "./seed";
import type { PlannedProposition } from "./plan";
import type { Verdict } from "./props";

/**
 * 几条链各领哪几维。
 *
 * 分组按「会撞上同一批来源」聚：需求端和供给端问的是同一批出货与产能统计，技术路线和
 * 上游问的是同一批供应链材料。同一条链里的两维共享一份台账，共源折叠因此看得见它们的
 * 重叠 —— 分到两条链上就看不见了。
 */
export const CHAINS: readonly { label: string; dims: readonly DimId[] }[] = [
  { label: "需求与供给", dims: ["D1", "D2"] },
  { label: "技术与上游", dims: ["D3", "D5"] },
  { label: "格局", dims: ["D4"] },
  { label: "政策、风险与主体", dims: ["D6", "D7", "D8"] },
] as const;

/**
 * 补旁证时一条种子搜几条、抓几页。
 *
 * 比正常取证那一波的 `searchK` 小：这一步找的是「还有谁也这么说」，命中通常就在前几条；
 * 开大只会多抓几页转载 —— 而转载在独立性折叠里本来就并成一组，抓了也不涨覆盖。
 */
const RESUPPLY_K = 4;

/** 一条链最多攒几条证据。超了按现状收口并记缺口 —— 无上限的补搜会一直搜到超时。 */
const MAX_EVIDENCE_PER_CHAIN = 24;
/** 一条链最多几波。 */
export const MAX_WAVES = 3;

/**
 * 这条链这一轮最多发几波。
 *
 * **决策题上少发波。** 格局一波，其余三条两波，行业题照旧三波。
 *
 * · 格局那一刀是 2026-09-06 切的。ISS-232：格局一维三波入账 49 条，占全部 82 条的六成，全是
 *   排位转载 —— 对「首访怎么开」这道题，排位是背景，一波够用；那两波是四分半钟。
 * · 其余三条压到 2 是 2026-09-07 切的。依据是三轮的共源率：232 / 235 / 236 里**第三波从未
 *   换回过独立来源**（74% / 77% / 50% 共源），而每波两分半 —— 第三波买到的是同一批稿子
 *   再读一遍。
 * · 行业题不动：那种题的整份价值就在证据的宽度上，少一波是少一块内容，不是少一次重复。
 *
 * 拎成一个函数是为了能钉住：这几个数写在循环条件里的话，改一个链名就悄悄换了一条链的波数，
 * 而那件事要跑一轮真模型（十几分钟、真花钱）才看得见。
 */
export const maxWavesFor = (decision: boolean, label: string): number =>
  decision ? (label === "格局" ? 1 : 2) : MAX_WAVES;

/**
 * 同时跑几条链。**四条全撒出去，并发靠 `models/gate.ts` 兜底，不再靠这里压。**
 *
 * 2026-09-07 从 2 改上来。上一版压在 2 的理由是：一条链一波里有五页在并着抽
 * （`evidence.ts` 的 `EXTRACT_CONCURRENCY`），四条链就是二十个调用同时在飞，而**撞上 429
 * 之后重来一遍比排队慢** —— 何况那时候压根不重来：`complete.ts` 4xx 一律不重发，限流的
 * 报错会被读成「这一页抽不出来」，静默变成台账上少几条证据。
 *
 * 那句话里的「排队」现在是真的了。出口限速器把二十个并发按各家的限额排成队（方舟默认 12），
 * 429 也不再等于失败（退避 + 重发一次）。所以这里不必再替出口压并发 —— **压在这里的代价是
 * 两条链干等着另外两条**，而它们要的位子在别的出口上。
 *
 * 这个数改回 2 的唯一理由会是「限速器不管用了」。那时候先看 trace 里的 `queuedMs`：真在排队
 * 的话它是个大数，那该调的是 `TKOS_GATE_*`，不是这里。
 */
const CHAIN_CONCURRENCY = 4;

export type SweepResult = {
  ledger: Ledger;
  rounds: Round[];
  verdicts: Verdict[];
  coverage: DimCoverage[];
  gate: { ok: boolean; missing: string[] };
  rewrites: { dimension: string; from: string[]; to: string[] }[];
  /** 超了预算按现状收口的那几条链，一条一句原话。 */
  capped: string[];
  /**
   * 每条关键问题的账。行业题是空表（那种题的范围就是八个维度，覆盖表已经是它的账）。
   *
   * 这一栏**必须和 `coverage` 并列存在**，不能二选一：覆盖表按维度记，而决策题上一个维度
   * 里有会改变路线的问题、也有背景问题，两者在覆盖表上合成一个数之后就分不开了。
   *
   * 可选**只是为了 `pipeline.ts` 里那份「本轮没取证」的空账**（`emptySweep`）能照旧构造 ——
   * `sweep()` 本身一定给。下游按 `?? []` 读，那一支的语义正好是「一条关键问题都没搜过」。
   */
  questions?: ScopeQuestionTrace[];
};

/**
 * 覆盖表：一维一行。**每个维度都上表**，包括压根没有命题的那几个 —— 那正是上一版静默消失
 * 的那一类。
 *
 * `independentGroups` 只数**背后有机构担责**的那些独立来源组（`coverage.ts` 的
 * `attributable`）。这不是个细节：`gateOpen` 拿这个数判强判断那几维够不够两组（§2.2），而
 * 一条知乎回答和一份机构报告折叠出来是两个不同的 `independenceGroup` —— 按全部组数算的话，
 * 「两个独立来源都印证了」这句话可以由一条论坛帖子凑成第二个，而屏幕上那条判断读起来和
 * 两份机构数据支撑的一模一样。
 *
 * 这一段原来先用 `tally(...).citableGroups` 当一个真假开关，再把那条命题的**全部**组数并进来
 * —— 于是 `citableGroups` 的门槛只筛掉了「一组可引用的都没有」，剩下的一律按全部组数报。
 * 现在按条过滤，`tally` 在这里就没有位置了（它算的两个数这里一个都不用），所以连它的
 * import 一起撤了；那个函数在漏斗那一侧照旧。
 */
export function coverageTable(
  props: readonly PlannedProposition[],
  entries: readonly Evidence[],
  tried: ReadonlyMap<DimId, string[]>,
  /**
   * 这一轮的任务范围。**表上只出现范围里的维度** —— 范围外的是「不适用」，它不该在覆盖
   * 表上占一行「0 组、已搜未得」的位置：那一行会让 `gateOpen` 报一条永远补不上的缺失，
   * 也会让屏幕上那张表看起来像是我们搜过它。不传就是行业题那一份（八维），一个字不变。
   */
  scope: TaskScope = INDUSTRY_SCOPE
): DimCoverage[] {
  return scope.dims.map((dim) => {
    const groups = new Set<string>();
    for (const p of props.filter((x) => x.dimension === dim)) {
      for (const e of entries.filter((x) => x.propositionId === p.id)) {
        if (attributable(e.sourceDomain)) groups.add(e.independenceGroup);
      }
    }
    const row: DimCoverage = { dim, independentGroups: groups.size };
    if (!groups.size) row.notFound = { tried: [...new Set(tried.get(dim) ?? [])] };
    return row;
  });
}

/**
 * 每条关键问题的账。**「没搜」和「搜了没找到」在这里必须分得开。**
 *
 * ISS-239 那一轮最贵的一处错就在这个区分上：报告写「外界没有公开材料」，而真实情况是
 * 那条问题压根没进过检索。两者在屏幕上长得一模一样，一个是结论，一个是欠账。
 *
 * 判法：
 *  · `needsInternal` → `不适用`。它的补法是要内部材料或问客户，不是再发一轮检索。
 *  · 一条命题都没挂上 → `未搜`，原因写「计划里没有它」（这是 N2 漏了，该退回去补）。
 *  · 挂了命题、但它的问法一条都没真的发出去 → `未搜`，原因写「这一波没发出去」
 *    （时间不够那一路。`tried` 是**发出去之后才记**的，见 `runChain` 里那一段）。
 *  · 发出去了、一条证据都没入账 → `已搜未得`，并把试过的问法列全。
 *  · 有入账 → `已得`。
 *
 * 只看入账、不看「够不够两组独立来源」是有意的：够不够是 `coverageTable` + `gateOpen`
 * 那一层的事，这一层回答的是**这条问题这一轮到底发生了什么**。两层各答一个问题，混成
 * 一个数之后「查到一条但不够印证」会被记成「没查到」。
 */
export function scopeTrace(
  scope: TaskScope,
  o: {
    props: readonly PlannedProposition[];
    entries: readonly Evidence[];
    tried: ReadonlyMap<DimId, string[]>;
  }
): ScopeQuestionTrace[] {
  return scope.questions.map((q) => {
    const mine = o.props.filter((p) => p.questionId === q.id);
    const sent = mine.flatMap((p) =>
      [...p.queries, ...p.counterQueries].filter((x) => (o.tried.get(p.dimension) ?? []).includes(x))
    );
    const ids = new Set(mine.map((p) => p.id));
    const evidenceIds = o.entries.filter((e) => ids.has(e.propositionId)).map((e) => e.id);
    const base = {
      id: q.id,
      question: q.question,
      dimension: q.dimension,
      routeIds: [...q.routeIds],
      dependsOn: [...q.dependsOn],
      changesChoice: q.changesChoice,
      evidenceIds,
      tried: [...new Set(sent)],
    };
    if (q.needsInternal) {
      return {
        ...base,
        status: "不适用" as const,
        why: "答案在我方内部材料或客户那里，外网查不到 —— 需要内部材料或客户确认",
      };
    }
    if (evidenceIds.length) return { ...base, status: "已得" as const, why: "" };
    if (!mine.length) {
      return { ...base, status: "未搜" as const, why: "这一轮的检索计划里没有它 —— 没搜过，不是外面没有" };
    }
    if (!base.tried.length) {
      return {
        ...base,
        status: "未搜" as const,
        why: `排了 ${mine.length} 条命题，但那几条问法这一轮一条都没发出去 —— 没搜过，不是外面没有`,
      };
    }
    return {
      ...base,
      status: "已搜未得" as const,
      why: `试过 ${base.tried.length} 条问法，一条可用来源都没回来`,
    };
  });
}

/** 一条链跑完之后交回来的东西。**不往共用的账上写** —— 几条链是并着跑的，见文件头。 */
type ChainRun = {
  entries: Evidence[];
  rounds: Round[];
  verdicts: Verdict[];
  rewrites: SweepResult["rewrites"];
  capped: string[];
  /** 这条链**真的发出去过**的问法，按维度分。没发出去的不许记（那是编的）。 */
  tried: { dim: DimId; queries: string[] }[];
};

/** 跑一条链：领自己那几维的命题，一波一波搜到闭合、到上限、或者时间不够。 */
async function runChain(
  h: Harness,
  search: SearchProvider[],
  props: readonly PlannedProposition[],
  opts: {
    slot: Slot;
    substep: (suffix: string) => void;
    seeds: readonly SearchHit[];
    subject?: string;
    decision?: boolean;
    /** 主体官网域名等。往下传给抓取位保留（`research/slots.ts`）与抓取放宽（`research/fetch.ts`）。 */
    disclosureDomains?: readonly string[];
  },
  chain: (typeof CHAINS)[number],
  ci: number
): Promise<ChainRun> {
  const out: ChainRun = { entries: [], rounds: [], verdicts: [], rewrites: [], capped: [], tried: [] };
  const mine = props.filter((p) => (chain.dims as readonly string[]).includes(p.dimension));
  if (!mine.length) return out;

  /*
   * 试过的问法**在发出去之后才记**。原来是进这个循环之前一次性把计划里的问法全记上，
   * 那时候不出错是因为第一波一定会跑；现在第一波可能因为时间不够整波不发，而那时候
   * 「已搜未得，试过这 12 条问法」就是一句假话 —— 覆盖表上它和真搜过一遍没找到长得一样。
   */
  const sentQueries = (todo: readonly PlannedProposition[], dim: DimId): string[] =>
    todo.filter((p) => p.dimension === dim).flatMap((p) => [...p.queries, ...p.counterQueries]);

  let wave = 0;
  let todo = [...mine];
  /** 这条链的种子表已经切到哪儿了。见下面递给 `gatherEvidence` 那一句。 */
  let seedAt = 0;
  /** 零入账的补搜只给一次，共源改写也只给一次（`waveDecision`）。 */
  let zeroYieldRetried = false;
  let coSourceRetried = false;
  /** 决策题上少发波，理由整段在 `maxWavesFor` 上。 */
  const maxWaves = maxWavesFor(Boolean(opts.decision), chain.label);
  while (todo.length && wave < maxWaves) {
    /*
     * 这一波发不发得起。判的是「这一波要多久 + 后面出稿那一整段要留多久」——
     * 几条链并着跑时它们看到的是同一个余量，而并着跑本来就只花一波的时间，所以两条链
     * 同时判「还够一波」是对的，不是超发。
     */
    if (!room(h.msLeft, COST.wave, WRITE_RESERVE_MS)) {
      out.capped.push(
        shedNote(
          wave === 0
            ? `「${chain.label}」这条链一波都没发（${chain.dims.join("、")} 这几维没搜过）`
            : `「${chain.label}」停在第 ${wave} 波`,
          h.msLeft
        )
      );
      break;
    }
    wave += 1;
    opts.substep(`第 ${ci + 1}/${CHAINS.length} 条链「${chain.label}」· 第 ${wave} 波`);
    for (const d of chain.dims) out.tried.push({ dim: d, queries: sentQueries(todo, d) });
    const ev = await gatherEvidence(
      h,
      search,
      todo,
      { ...h.budget, maxRounds: 1 },
      { slot: opts.slot, label: chain.label, substep: opts.substep },
      /*
       * **种子按波往下切，不能每一波都把整份递进去。**
       *
       * `gatherEvidence` 里那句「抓过的不再排队」认的是**它自己那本台账**，而每一波各建一本
       * 新的（上面 `maxRounds: 1`，一波一次调用）—— 所以整份递进去的话，第二波看到的是一本
       * 空台账，挑出来的还是同样那三条，后面的种子一条都轮不到。
       *
       * 切过去之后就不再回来了，抓失败的那几条也不补发：那一条已经证明抓不动，同一个地址
       * 再排一次只是把这一波的位置让给一个已知的死链。
       */
      {
        seeds: opts.seeds.slice(seedAt, seedAt + SEEDS_PER_ROUND),
        subject: opts.subject,
        disclosureDomains: opts.disclosureDomains,
      }
    );
    seedAt += SEEDS_PER_ROUND;
    out.entries.push(...ev.ledger.entries);
    out.rounds.push(...ev.rounds);
    out.verdicts.push(
      ...ev.verdicts.filter((v) => !out.verdicts.some((x) => x.propositionId === v.propositionId))
    );

    const share = waveShare(ev.ledger.entries);
    h.note(
      `${chain.label} · 第 ${wave} 波共源`,
      { 入账: share.total, 独立组: share.distinct, 共源率: `${Math.round(share.share * 100)}%` },
      "local"
    );
    if (ev.ledger.entries.length >= MAX_EVIDENCE_PER_CHAIN) {
      out.capped.push(`${chain.label} 攒到 ${ev.ledger.entries.length} 条，到了单链上限，按现状收口`);
      break;
    }
    /*
     * 这一波之后做什么，由一个纯函数定（`cosource.ts` 的 `waveDecision`）：共源过半换方向、
     * 零入账换问法（只给一次）、其余收口。零入账原来在这里直接 `break`：共源率是 0，在账上
     * 和「来源很分散」长得一样，而它的意思是什么都没拿到。
     */
    const zeroDims = chain.dims.filter(
      (d) =>
        todo.some((p) => p.dimension === d) &&
        !ev.ledger.entries.some((e) => todo.some((p) => p.id === e.propositionId && p.dimension === d))
    );
    const { kind: decision, dims: onlyDims } = waveDecision({
      total: share.total,
      share: share.share,
      zeroYieldRetried,
      coSourceRetried,
      zeroDims,
    });
    if (decision === "stop") break;
    if (decision === "zeroYield") zeroYieldRetried = true;
    else coSourceRetried = true;
    // 只为零入账的那几维改写时，别的维度到此收口 —— 它们这一波已经有入账。
    if (onlyDims) todo = todo.filter((p) => (onlyDims as readonly string[]).includes(p.dimension));
    const because = decision === "zeroYield" ? `${onlyDims ? onlyDims.join("、") + " " : ""}一条都没入账` : "共源过半";
    /*
     * 改写一次要 30 秒上下，改完那一波还要一波的时间。凑不出这两笔就别改 —— 改了问法
     * 却发不出去，等于花一次调用换一份不会被用到的问法清单。
     */
    if (!room(h.msLeft, COST.rewrite + COST.wave, WRITE_RESERVE_MS)) {
      out.capped.push(shedNote(`「${chain.label}」第 ${wave} 波${because}，没有再改一次问法`, h.msLeft));
      break;
    }

    // 换方向或换问法再发一波。改写失败（读不出问法）就收口，不重发原问法。
    const raw = await h
      .callMessages(
        `模型调用 · a4.rewrite（${chain.label}）`,
        [
          { role: "system", content: rewriteSystemFor(decision) },
          {
            role: "user",
            content: buildRewriteUser({
              dimension: (onlyDims ?? chain.dims).map((d) => `${d} ${dimName(d as DimId)}`).join("、"),
              tried: todo.flatMap((p) => p.queries),
              // `siteName` 是「新浪财经」这种中文台名（可能缺），`sourceDomain` 一律有。
              // 两个都给：改写要认的是「这批稿子出自谁」，而域名和台名各说得清一半。
              coSourced: ev.ledger.entries.map((e) => `${e.siteName || e.sourceDomain}｜${e.claim}`),
              reason: decision,
              statements: todo.map((p) => p.statement),
            }),
          },
        ],
        { slot: opts.slot, maxTokens: 2000 },
        { promptKey: "a4.rewrite", lane: chain.label },
        "a4.rewrite"
      )
      .then((r) => r.text)
      /*
       * **挂了要说出来，不能咽掉。**
       *
       * 原来这里是 `.catch(() => "")`，于是「模型调用挂了」和「模型交回来的问法读不出」
       * 走同一条出口 —— 两者的处置本来一样（都收口），但**要查的东西完全不同**：前者去
       * 看那个出口的 key 和限流，后者去看提示词。而文件头那条纪律说的正是这件事：少搜
       * 而不说，一份因为出错收口的报告和一份「外面就是没有材料」的报告在屏幕上一模一样。
       *
       * 记进 `capped`（会印在报告文首），不抛：改写失败只该让这条链停在这一波，不该让
       * 整轮深研挂掉。
       */
      .catch((e) => {
        out.capped.push(
          `「${chain.label}」第 ${wave} 波想换个问法再搜，但那次调用没跑成（` +
            `${e instanceof Error ? e.message : String(e)}）—— 这条链停在这一波`
        );
        return "";
      });
    const next = readRewrite(raw);
    if (!next.length) break;
    out.rewrites.push({ dimension: chain.label, from: todo.flatMap((p) => p.queries), to: next });
    // 改写后的问法挂回还没闭合的那几条命题上：命题本身不变，只换问法。改写出来的问法
    // 下一波才发得出去，所以这里不记进 `tried`（上面那一句在发之前记）。
    todo = todo
      .filter((p) => !out.verdicts.find((v) => v.propositionId === p.id)?.ok)
      .map((p) => ({ ...p, queries: next }));
  }
  return out;
}

export async function sweep(
  h: Harness,
  search: SearchProvider[],
  props: readonly PlannedProposition[],
  opts: {
    slot: Slot;
    /** 打算下「当前更支持」及以上判断的维度，它们要两组独立来源。 */
    strongDims: readonly DimId[];
    /** 决策题（`SubjectCard.decision`）：背景维度少发波。 */
    decision?: boolean;
    substep: (suffix: string) => void;
    /** 研究主体的名字（主体卡 `subject`），用来给命中排序（`research/rank.ts`）。 */
    subject?: string;
    /**
     * 主体官网域名（主体卡 `website`）。**不参与排序** —— ISS-238 里排序是对的，位子是不够的。
     * 它管两件事：给一手披露留抓取位（`research/slots.ts`），以及把这几页的超时与 PDF
     * 体积上限放宽到披露站那一档（`research/fetch.ts` 的 `limitsFor`）。
     */
    disclosureDomains?: readonly string[];
    /**
     * 这个议题的预研那一轮已经核过的证据（`A4Input.preEvidence`）。
     *
     * **必须在这里递进来，不能等 `sweep` 返回之后在外面垫**：覆盖表是在下面用
     * `merged.entries` 算的，垫在外面的话预研那几条不计入覆盖判定 —— 而「这一维有没有
     * 两组独立来源」正是垫它们的全部意义。
     *
     * 排在本轮新取的**前面**：预研先跑，编号跟着时间走，同一批输入跑两遍得到同一套号。
     */
    prior?: readonly Evidence[];
    /**
     * N2′ 交回来的那一面 url（`seed.ts`）。空表就是没有这一步 —— 各链照旧自己搜。
     *
     * **分派在这里做，不在外面做**：分派要按 `CHAINS` 的分组算，而那张表是这个文件的东西。
     */
    seeds?: readonly SearchHit[];
    /**
     * 这一轮的任务范围（`dims.ts` 的 `TaskScope`）。
     *
     * 它管三件事，都在这个文件里：覆盖表出哪几行、覆盖门查哪几维、补搜先补谁。不传就是
     * 行业题那一份（八维全要），所以老调用点一个字不用改。
     *
     * **决策题必须传。** 不传的话覆盖表照旧出八行，其中五行永远是「0 组、已搜未得、试过 0
     * 条问法」—— 那五行不但过不了门，还会在报告文首那份机检清单里挤掉真正的缺口。
     */
    scope?: TaskScope;
  }
): Promise<SweepResult> {
  const scope = opts.scope ?? INDUSTRY_SCOPE;
  /*
   * 先把种子分给各链，再撒出去。分派是纯计算（字面重合度，`seed.ts` 的 `routeSeeds`），
   * 放在并发之前做，几条链看到的分派结果才是同一份 —— 各自分各自的话同一条 url 会进两条链。
   */
  const routed = routeSeeds(opts.seeds ?? [], CHAINS, props);
  if (opts.seeds?.length) {
    h.note(
      "N2′ 种子分派",
      Object.fromEntries(CHAINS.map((c, i) => [c.label, `${routed[i].length} 条`])),
      "local"
    );
  }

  const runs = await mapPool(CHAINS, CHAIN_CONCURRENCY, (chain, ci) =>
    runChain(
      h,
      search,
      props,
      {
        slot: opts.slot,
        substep: opts.substep,
        seeds: routed[ci],
        subject: opts.subject,
        decision: opts.decision,
        disclosureDomains: opts.disclosureDomains,
      },
      chain,
      ci
    )
  );

  /*
   * 按 `CHAINS` 的顺序合（`mapPool` 保序）。台账编号是入账顺序，跟着谁先跑完走的话
   * 同一批输入跑两遍会得到两套编号，而报告正文引的是编号。
   *
   * 合并走 `adopt` 而不是 `entries.push`：每条链自己那本账、以及链里每一波各建的那本，
   * 编号都是**从 E1 起各数各的**（`Ledger` 的 `n` 是实例内自增）。原样 push 过来的话，
   * 合完的证据包里会有好几条不同的证据都叫 `E1` —— 而报告正文引的就是这个编号，
   * 一号位看到「[E1]」时它指向哪一条，取决于下游先遇到谁。`adopt` 接着往下编，
   * 顺序不变，重号没了。
   */
  const merged = new Ledger();
  const rounds: Round[] = [];
  const verdicts: Verdict[] = [];
  const rewrites: SweepResult["rewrites"] = [];
  const capped: string[] = [];
  /** 每个维度**真的发出去过**的全部问法。已搜未得那一栏要它。 */
  const tried = new Map<DimId, string[]>();
  /*
   * 预研那一轮的证据先并进来，再并本轮各条链的。
   *
   * 它们是**同一个议题**上一轮已经核过的东西（`store.ts` 按 `issueId` 取的那份
   * `PreResearchDoc`），引句、跨度、档次都是那时候定位出来的结论，这里只重编号。
   * 一条都没有是常态 —— 预研可能没联网、或者那一轮 Qwen 空手（实测六轮里有一轮），
   * 所以下游一律按「可能是空的」写。
   */
  if (opts.prior?.length) merged.adopt(opts.prior);
  for (const run of runs) {
    merged.adopt(run.entries);
    rounds.push(...run.rounds);
    verdicts.push(...run.verdicts);
    rewrites.push(...run.rewrites);
    capped.push(...run.capped);
    for (const t of run.tried) tried.set(t.dim, [...(tried.get(t.dim) ?? []), ...t.queries]);
  }

  // ---- 先补会改变路线的那几条 ---------------------------------------------
  /*
   * **零收获的关键问题要补，而且排在补旁证前面。**
   *
   * 这一段之前的形状是反的：补搜只有「补旁证」一层，而它按设计跳过一组来源都没有的维度
   * （`resupply.ts` 的 `shortfalls`：没有种子就无从找旁证）。于是「这一维有 1 组、去凑第 2
   * 组」会补，「这条会改变选哪条路线的问题一条证据都没拿到」反而不补 —— 后者才是这一轮
   * 该花时间的地方（交接文档 §3.B 第三条）。
   *
   * 补的对象是**问题**不是维度：挑出会改变选择、又一条证据都没入账的那几条，把挂在它们
   * 下面的命题凑成一波再发一次。范围内一条关键问题都没有时（行业题恒如此）整段不跑，所以
   * 行业题的行为一个字没变。
   *
   * 只发**一波**，不是每条问题各一波：无上限的补搜会一直搜到超时，而超时的报告和搜不到的
   * 报告在结果页上都是空白（同 `resupply.ts` 的 `extraRoundsCap`）。
   */
  const keys = keyQuestions(scope);
  if (keys.length) {
    const stuck = new Set(
      scopeTrace(scope, { props, entries: merged.entries, tried })
        .filter((t) => t.changesChoice && t.status !== "已得" && t.status !== "不适用")
        .map((t) => t.id)
    );
    const retry = props.filter((p) => p.questionId && stuck.has(p.questionId));
    /*
     * 报的是**补得动的那几条**，不是 `stuck` 的全部。`stuck` 里还有一类是「计划里压根没有
     * 它的命题」—— 那一类没有问法可发，再来一波也无从发起，它的出口是 trace 上的「未搜」
     * 和出口检查那条 A4-G08，不是这里的一句「没来得及」。两者混成一个数会把「没时间」和
     * 「没排进计划」说成同一件事。
     */
    const retried = new Set(retry.map((p) => p.questionId));
    if (retry.length && !room(h.msLeft, COST.wave, WRITE_RESERVE_MS)) {
      capped.push(
        shedNote(`还有 ${retried.size} 条会改变路线的关键问题零收获，没来得及再搜一波`, h.msLeft)
      );
    } else if (retry.length) {
      opts.substep(`关键问题补搜 · ${retried.size} 条`);
      for (const p of retry) {
        tried.set(p.dimension, [...(tried.get(p.dimension) ?? []), ...p.queries, ...p.counterQueries]);
      }
      try {
        const ev = await gatherEvidence(
          h,
          search,
          [...retry],
          { ...h.budget, maxRounds: 1 },
          { slot: opts.slot, label: "关键问题", substep: opts.substep },
          { subject: opts.subject, disclosureDomains: opts.disclosureDomains }
        );
        merged.adopt(ev.ledger.entries);
        rounds.push(...ev.rounds);
        /*
         * 判定**只在变好时覆盖**。这一波各命题是重新起一本台账算的，所以它的判定只看得见
         * 这一波拿到的东西 —— 原来那条判定是在更多证据上算出来的，拿这一条盖过去会让一条
         * 已经闭合的命题倒退回「未闭合」。
         */
        for (const v of ev.verdicts) {
          const at = verdicts.findIndex((x) => x.propositionId === v.propositionId);
          if (at < 0) verdicts.push(v);
          else if (v.ok) verdicts[at] = v;
        }
        h.note(
          "关键问题补搜",
          { 问题: [...retried], 命题: retry.map((p) => p.id), 新入账: ev.ledger.entries.length },
          "local"
        );
      } catch (e) {
        capped.push(
          `${retried.size} 条会改变路线的关键问题想再搜一波，但那一波没跑成（` +
            `${e instanceof Error ? e.message : String(e)}）`
        );
      }
    }
  }

  // ---- 补旁证 -------------------------------------------------------------
  /*
   * 先按现状算一遍覆盖，挑出还差组的那几维，各补一轮，再算最终那一遍。
   *
   * **补进来的证据必须参与覆盖判定**，所以这一段夹在合并和最终覆盖表之间。补完再算是
   * 唯一说得通的顺序：算在前面等于报一个补之前的数，而屏幕上那张表是一号位判「这一维
   * 站不站得住」的依据。
   *
   * 这一层不重搜命题（那样回来的是同一批页，见文件头），它拿**已入账那条证据的说法**
   * 去搜「还有谁也这么说」，全程不叫模型 —— 细节在 `resupply.ts` 文件头。
   */
  const before = coverageTable(props, merged.entries, tried, scope);
  /*
   * 补的顺序按「这一维上有没有会改变路线的问题」排。时间不够时下面那个循环是 `break` 掉的
   * ——**先补哪一维就是这一轮真正补到的那一维**，所以顺序不是排版，是取舍本身。
   *
   * `sort` 是稳定的（ES2019 起），所以同一档里照旧是 `shortfalls` 给的 `DIM_IDS` 顺序，
   * 行业题（一条关键问题都没有）上这一句是恒等变换。
   */
  const keyDims = new Set(keys.map((q) => q.dimension));
  const short = shortfalls({
    coverage: before,
    props,
    entries: merged.entries,
    strongDims: opts.strongDims,
  }).sort((a, b) => Number(keyDims.has(b.dim)) - Number(keyDims.has(a.dim)));
  /** 补到了几条 —— 这一栏只进 trace，它是好消息，报告文首不必写。 */
  const resupplied: string[] = [];
  for (const s of short) {
    if (!room(h.msLeft, COST.resupply, WRITE_RESERVE_MS)) {
      /*
       * **没补成的进 `capped`，不是只进 trace。**
       *
       * `pipeline.ts` 那条纪律（「少发的那几波上报告文首，不是只上 trace —— 后者是我们
       * 自己为了赶时间压掉的，而读报告的人凭正文分不出来」）对这一步逐字成立：一维
       * 「只有一家在说」而我们**没来得及去找第二家**，和「外面真的只有一家」，在报告
       * 正文里长得一模一样。
       */
      capped.push(shedNote(`${s.dim} ${dimName(s.dim)} 这一维没来得及补旁证`, h.msLeft));
      break;
    }
    opts.substep(`${dimName(s.dim)} · 补旁证`);
    try {
      const r = await resupply({
        short: s,
        ledger: merged,
        k: RESUPPLY_K,
        room: () => room(h.msLeft, COST.resupply, WRITE_RESERVE_MS),
        search: async (query, k) => (await searchAll(search, [query], k)).hits,
        // 补旁证这一路也按一手披露放宽（2026-09-07）：年报 PDF 在哪一步抓都一样大。
        fetch: (urls) => fetchPages(urls, undefined, opts.disclosureDomains ?? []),
      });
      // 发出去的问法要并进 `tried`：「已搜未得」那一栏读它，而这几条是真发出去过的。
      if (r.tried.length) tried.set(s.dim, [...(tried.get(s.dim) ?? []), ...r.tried]);
      if (r.added) resupplied.push(`${s.dim} ${dimName(s.dim)}：补到 ${r.added} 条旁证`);
    } catch (e) {
      /*
       * 补旁证挂了**不影响这一轮**：它是加料，不是取证本身。整段套 try 而不是逐次，
       * 因为出网失败通常是一整段都不通（限流、断网），逐次接住只会把同一件事记很多遍。
       */
      capped.push(`${s.dim} ${dimName(s.dim)} 这一维补旁证没跑成（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  if (resupplied.length) h.note("补旁证", { 各维: resupplied }, "local");

  // ---- 覆盖表 -------------------------------------------------------------
  const coverage = coverageTable(props, merged.entries, tried, scope);
  const questions = scopeTrace(scope, { props, entries: merged.entries, tried });

  /*
   * ---- 补完仍然空手的，明确留给当面问（2026-09-07，ISS-240）--------------------
   *
   * ISS-240 那一轮的覆盖表上有五条这样的：各试过 4 条问法，一条可用来源都没回来。它们问的是
   * 「对方集团层有没有独立的数字化中心」「现有系统栈的自研比例」「IT 采购走不走集团招标、
   * 单笔立项门槛多少」——**这些是首访当面问的事，外网本来就没有**。
   *
   * 补搜那一层照旧给它们一次机会（交接文档 §3.B：零收获的重要问题也要补）。这一段管的是
   * 那一次之后：**再没有第三次**，而它该变成一句可执行的话，不是缺陷清单上又一条「没查到」。
   * 出口那条 A4-G08 仍然照报 —— 这里不藏缺口，只是把它换个说法交给下一步。
   *
   * 门槛是**至少发过两条问法**（正问加反问各一条就够）：只发过一条就断言「外面没有」太早，
   * 而 `已搜未得` 这个状态本身已经保证了「真的发出去过、回来是空的」。
   */
  const askInPerson = questions.filter(
    (t) => t.changesChoice && t.status === "已搜未得" && t.tried.length >= 2
  );
  if (askInPerson.length) {
    capped.push(
      ...askInPerson.map(
        (t) =>
          `「${t.question}」外网试过 ${t.tried.length} 条问法，一条可用来源都没回来 —— ` +
          "这一条外面查不到，留到首访当面问"
      )
    );
    h.note(
      "留给当面问的关键问题",
      { 条数: askInPerson.length, 明细: askInPerson.map((t) => `${t.id} ${t.question}`) },
      "local"
    );
  }

  const gate = gateOpen(coverage, opts.strongDims, scope);
  h.note(
    "覆盖表",
    {
      范围: `${scope.kind}｜${scope.dims.join("、")}${scope.questions.length ? `｜关键问题 ${scope.questions.length} 条` : ""}`,
      各维: coverage.map(
        (r) => `${r.dim} ${dimName(r.dim)}：${r.independentGroups} 组${r.notFound ? `（已搜未得，试过 ${r.notFound.tried.length} 条问法）` : ""}`
      ),
      // 状态写在最前面：这一栏读的人第一眼要分清的就是「没搜」和「搜了没找到」。
      关键问题: questions.map(
        (q) => `${q.id} ${q.status}｜${q.question}｜路线 ${q.routeIds.join("、") || "未挂"}｜${q.why || `证据 ${q.evidenceIds.join("、")}`}`
      ),
      门: gate.ok ? "开" : gate.missing,
      改写: rewrites.map((r) => `${r.dimension}：${r.from.length} 条 → ${r.to.length} 条`),
      收口: capped,
    },
    "local"
  );

  return { ledger: merged, rounds, verdicts, coverage, gate, rewrites, capped, questions };
}
