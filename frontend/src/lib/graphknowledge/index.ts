/**
 * GraphKnowledge 对外**只有这一扇门**。
 *
 * `AnchorNotFound` 在门里面就被吃掉、转成 `mode:"external_only"`；
 * `GraphKnowledgeUnavailable` 原样抛出去。这是三态不被混淆的**结构保证**：
 * 调用方拿不到「没找到」这个异常，所以没法误接成失败；也没法把「连不上」当成
 * 「没找到」，因为那个异常它必须处理。
 *
 * 路由与 UI 层不许直接 import 这个目录下的其它文件。
 */
import { GraphKnowledgeClient } from "./client";
import { AnchorNotFound, GraphKnowledgeUnavailable } from "./errors";
import { clip } from "./limits";
import { autopick, type AnchorPick, type AnchorPrefix, type Channel } from "./lookup";
import {
  buildS01,
  buildS02,
  buildS02FromJudgments,
  buildS03,
  buildS03FromJudgments,
  bundleSummary,
  type ContextBundle,
  type Recipe,
} from "./recipes";
import { freezeContext } from "./snapshot";

export { GraphKnowledgeClient, gkSettings } from "./client";
export {
  AnchorNotFound,
  GraphKnowledgeError,
  GraphKnowledgeNotFound,
  GraphKnowledgeRejected,
  GraphKnowledgeUnavailable,
} from "./errors";
export { findAnchors, PREFIX, type AnchorPick, type AnchorPrefix, type Channel } from "./lookup";
/*
 * `clip` 也从这扇门出去：P3 的 q 超 100 字是服务端 422 **不是**悄悄截断（见
 * `limits.ts`），所以每一处发语义检索的调用方都得先裁。自己再抄一份长度常量，
 * 就是那个文件头写的「抄第二份就一定会有一份忘了跟着改，而表现是线上 422、离线全绿」。
 */
export { clip, P3_MAX_QUERY_CHARS } from "./limits";
export { MAX_CONTEXT_CHARS, type ContextBundle, type Recipe } from "./recipes";
export { contextExists, freezeContext, loadContext } from "./snapshot";

export type TraceNode = {
  at: string;
  label: string;
  kind: "graph" | "anchor" | "context";
  detail: Record<string, unknown>;
};

export type OpenedContext = {
  /**
   * 三档。**`narrative` 不是这一层产生的** —— 这个文件只会回前两档；第三档来自本体
   * 叙述接口那一支（`src/lib/ontology/context.ts`），类型定在这里是因为两支共用这一个
   * 返回形状，门上面的调用方（harness、`company-context.ts`）不该知道货是谁供的。
   *
   * 三档在下游各有各的说法，一档都不能省：`harness.contextBlock` 三选一、
   * `anchorChecks` 三选一、`a3/run.ts` 与 `a4/shared.ts` 的溯源行三选一。
   * 把 `narrative` 折进 `anchored`，台账上就多了一个不存在的锚点；折进 `external_only`，
   * 屏幕上那句「本次无公司上下文」就是假的 —— 而它手上有一整段真实的经营脉络。
   */
  mode: "anchored" | "external_only" | "narrative";
  /** `external_only` 时为 null。 */
  bundle: ContextBundle | null;
  anchor: AnchorPick | null;
  /**
   * 这次的锚点是怎么来的。`external_only` 时为 null。
   *
   * `anchor` 为空有两种完全不同的原因（调用方钉住 / 按判断号定），台账上必须分得开：
   * 把按判断定的那一档写成「调用方钉住」，就成了「有人手工指定过」，而没有人。
   */
  anchorOrigin: "auto" | "explicit" | "judgmentRefs" | null;
  /** 命中了哪条相对规则。`anchored` 时为 null。 */
  noAnchorReason: string | null;
  /**
   * 【公司经营状态】那一段（P0）的正文。**`external_only` 时才有值。**
   *
   * 为什么纯外部也取它：P0 跟锚点没有关系 —— 它是「公司现在是什么状况」（本期
   * Outcome 还剩几天、八个域的在版判断、跟你说话的人是谁），一次调用就能拿到全文，
   * 不需要先找到一条议题。可原来只要锚点没命中，这一段就跟着判断链一起被扔了，
   * 于是深研和定题拿到的公司上下文是**零**，而其中有一半本来拿得到。
   *
   * `anchored` 时是空串：那条路的 P0 已经在 `bundle.renderedMarkdown` 里，
   * 这里再放一份，两处就会各自漂移。
   *
   * 空串还有第二种含义 —— 见下面取它那一段：取不到不算这一次运行失败。
   */
  staticContext: string;
  snapshotId: string | null;
  trace: TraceNode[];
  /** q 被裁、语义段降级、TLS 未校验…… 都在这里。 */
  warnings: string[];
};

/** 从图里取回来的一条。`lookupMembers` 的产物。 */
export type OntologyMember = {
  code: string;
  label: string;
  /** 这一条的正文。判断取最新版陈述，别的取 `properties.text`。语义那一路是空串。 */
  text: string;
  /**
   * 图给的状态。**只有判断的版本链上有**（`confirmed` 这一类），别的对象是空串。
   *
   * 空串**不许读成「已确认」** —— 那是「图没说」，不是「图说了它是准的」。这两件事在
   * 屏幕上长得一样，而把前者当后者用，就是拿一条没人确认过的东西当公司口径。
   */
  status: string;
  /** 语义召回给的类型与分数。按编号取的那条没有。 */
  type?: string;
  score?: number;
};

export type MemberLookup = {
  /**
   * 三档。**`narrative` 不是这一层产生的** —— 同 `OpenedContext.mode`，它来自本体叙述
   * 接口那一支（`src/lib/ontology/lookup.ts`）。类型定在这里是因为两支共用这一个形状，
   * `turn.ts` 的 `renderMembers` 按它分派。
   *
   * `narrative` 那一档 `items` **永远是空的**（叙述接口不回短码），正文走 `recall`。
   */
  mode: "code" | "semantic" | "narrative";
  /** 真正送出去的那一句。语义那一路已经过 `clip`（超 100 字服务端 422）。 */
  sent: string;
  items: OntologyMember[];
  /** 语义召回随手带回来的那段正文。按编号取时是空串。 */
  recall: string;
  /** 服务端自己报的降级（`query_embedding_not_cached` 这一类）。不是错误。 */
  warning: string;
};

/**
 * 长得像编号吗。
 *
 * 判据是**形状**不是前缀白名单：图里的编号形如 `ISS-D1` / `01-J2` / `DOC-05` /
 * `AGR-2026-03`，共同点是没有空格、由连接符分段。写死一张前缀表的代价是图里新增一类
 * 对象时这里静默把它当成自然语言去做语义检索 —— 而那一路照样回得来东西，看不出错。
 */
export const looksLikeCode = (q: string): boolean =>
  /^[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)+$/.test(q.trim()) && q.trim().length <= 40;

/** 语义那一路取几条、给多少预算。**这不是配方**，是这扇门自己的档 —— 轮内一次调用，
 *  比 S02 装配那次（k=3）宽一点，比 S03 的 core question（k=10/6000）窄得多。 */
const LOOKUP_K = 5;
const LOOKUP_BUDGET = 1500;

/**
 * 从图里**按编号或按语义取几条**，不装配上下文。
 *
 * ## 它和 `openContext` 是两件事
 *
 * `openContext` 是「开局装一份上下文」：选一个锚点、按配方跑一整套 P0/P1/P2/P3、把结果
 * 拼成一段 Markdown 冻结存档。一次运行只开一次，开完就定了。
 *
 * 这一扇是「研究进行中再取一条」：对谈里他问到一件开局没带进来的事，模型要能当场去图里
 * 取。所以它**不选锚点、不装配、不冻结、不进 snapshot** —— 取回来的东西由调用方决定怎么
 * 用（对谈那边是挂进这条议题的锚点集合）。
 *
 * ## 两种模式，各自一次往返
 *
 * 看起来像编号的（`ISS-D1` / `01-J2` / `DOC-05`）走 P1+P2，**并着发** —— P1 给卡面
 * （label、properties），P2 给版本链（判断的确认状态只在版本上）。串着发是白等一次网络
 * 往返，而这扇门是给轮内那 30 秒预算用的。P2 挂了不影响这一条取回来，只是 `status` 空着。
 *
 * 别的走 P3 语义召回。P3 只回 `seeds`（编号、类型、分数）和一段召回正文 —— **它给不出每
 * 条的 label 和正文**，所以语义那一路回来的是「有哪几条可以再问」，不是「这几条说了什么」。
 * 要正文，拿编号再调一次。这不是缺陷，是 P3 的形状。
 *
 * ## 失败语义与 `openContext` 一致
 *
 * `GraphKnowledgeUnavailable` 原样抛（连不上就是连不上）；**取不到不是异常**，回一个空的
 * `items`。两件事在这一层就分开，调用方拿不到「没找到」这个异常，所以没法把它误接成
 * 「图挂了」—— 同 `AnchorNotFound` 在这扇门里被吃掉的那条结构保证。
 */
export async function lookupMembers(
  q: string,
  opts: { client?: GraphKnowledgeClient } = {}
): Promise<MemberLookup> {
  const client = opts.client ?? new GraphKnowledgeClient();
  const query = (q ?? "").trim();

  if (looksLikeCode(query)) {
    // P1 与 P2 并着发：P2 只为了拿版本上的状态，它挂了这一条照样取得回来。
    const [card, chain] = await Promise.allSettled([client.entity(query), client.chain(query)]);
    if (card.status === "rejected") {
      // `GraphKnowledgeUnavailable` 要原样往外走，`GraphKnowledgeNotFound` 折成空。
      if (card.reason instanceof GraphKnowledgeUnavailable) throw card.reason;
      return { mode: "code", sent: query, items: [], recall: "", warning: "" };
    }
    const versions = chain.status === "fulfilled" ? (chain.value.versions ?? []) : [];
    const latest = versions[versions.length - 1];
    const props = card.value.properties ?? {};
    return {
      mode: "code",
      sent: query,
      items: [
        {
          code: String(card.value.code ?? query),
          label: String(card.value.label ?? ""),
          text: String(latest?.statement ?? props.text ?? ""),
          status: String(latest?.status ?? ""),
        },
      ],
      recall: "",
      warning: "",
    };
  }

  const sent = clip(query);
  const r = await client.dynamic(sent, { k: LOOKUP_K, budget: LOOKUP_BUDGET });
  return {
    mode: "semantic",
    sent,
    items: (r.seeds ?? [])
      .filter((s) => s.code)
      .map((s) => ({
        code: String(s.code),
        label: "",
        text: "",
        status: "",
        ...(s.type ? { type: String(s.type) } : {}),
        ...(typeof s.score === "number" ? { score: s.score } : {}),
      })),
    recall: String(r.text ?? ""),
    warning: String(r.warning ?? ""),
  };
}

/** `as_of` **没有环境变量**：给它一个变量意味着有人会设成某个日期然后忘掉，
 *  之后每次运行都在读一份过期视图，而产出看不出任何异常。 */
const today = (): string => new Date().toISOString().slice(0, 10);

export async function openContext(opts: {
  recipe: Recipe;
  prefix: AnchorPrefix;
  channel: Channel;
  /** 自然语言问题，**不含指令样板**。正式版传 `issue.statement` 这类结构化字段。 */
  q: string;
  /** 显式钉锚点：复现旧运行走这条。给了它就不检索、也不看判断号。 */
  anchorCode?: string;
  /**
   * 这条议题挂着的判断号（`01-J3` 这一类）。**S02 和 S03 认它，S01 不认。**
   *
   * 给了非空的一串就不检索锚点了：图里没有前端这十条议题的 Issue 对象，检索
   * 一次都命中不了；而判断在图里是真实存在的。空数组照旧走检索 —— 有议题确实
   * 不动摇任何在版判断（ISS-009），那是诚实的空，不该在这里被当成「配错了」。
   *
   * S01 不认是因为它的锚点是 Signal 不是议题：那类编号在图里查得到，检索也命
   * 得中，这条绕行对它没有意义。
   */
  judgmentCodes?: string[];
  viewer?: string;
  asOf?: string;
  client?: GraphKnowledgeClient;
}): Promise<OpenedContext> {
  const client = opts.client ?? new GraphKnowledgeClient();
  const viewer = opts.viewer ?? client.viewer;
  const asOf = opts.asOf ?? today();
  const trace: TraceNode[] = [];
  const warnings = [...client.warnings];
  const note = (label: string, kind: TraceNode["kind"], detail: Record<string, unknown>) =>
    trace.push({ at: new Date().toISOString(), label, kind, detail });

  /** 两处 catch 共用：`AnchorNotFound` 转纯外部这件事只能有一种写法。 */
  const externalOnly = async (e: AnchorNotFound): Promise<OpenedContext> => {
    note("图谱里没有对应锚点，转纯外部", "anchor", { why: e.detail.why, ...e.detail });
    const extra: string[] = [];

    /*
     * 锚点没命中，P0 照样取。
     *
     * 【公司经营状态】不需要锚点 —— 它答的是「公司现在是什么状况」，一次调用拿全文。
     * 原来这一段跟着判断链一起被丢掉，于是深研拿到的公司上下文是零，而其中一半本来
     * 拿得到。**`mode` 仍然是 `external_only`**：这一步没有找到任何锚点，把它升成
     * `anchored` 就等于在台账上宣称有一个并不存在的锚点。
     *
     * 取不到**不失败这一次运行**，跟锚定那条路（P0 挂了就挂了）故意不一样：那条路
     * 上 P0 是正文的一部分，这条路上它是外加的一段。为它把一次本来能跑完的运行变成
     * 失败，换不来任何诚实 —— 空串时屏幕上写的就是原来那句「本次无公司上下文」，
     * 而且 warnings 里记着这次是因为取不到才没有。
     */
    try {
      const p0 = await client.staticContext({ viewer, asOf });
      note("纯外部也装上【公司经营状态】", "context", { p0Chars: p0.length });
      return {
        mode: "external_only",
        bundle: null,
        anchor: null,
        anchorOrigin: null,
        noAnchorReason: e.message,
        staticContext: p0,
        snapshotId: null,
        trace,
        warnings: [...warnings, ...((e.detail.warnings as string[]) ?? [])],
      };
    } catch (pe) {
      const why = pe instanceof Error ? pe.message : String(pe);
      extra.push(`【公司经营状态】也没取到：${why}`);
      note("纯外部下 P0 也失败，这一次连公司经营状态都没有", "context", { why });
    }

    return {
      mode: "external_only",
      bundle: null,
      anchor: null,
      anchorOrigin: null,
      noAnchorReason: e.message,
      staticContext: "",
      snapshotId: null,
      trace,
      warnings: [...warnings, ...((e.detail.warnings as string[]) ?? []), ...extra],
    };
  };

  // 按判断定锚点。显式钉锚点（复现旧运行）优先，其次判断号，最后才检索。
  const byJudgment =
    !opts.anchorCode &&
    (opts.recipe === "S02" || opts.recipe === "S03") &&
    (opts.judgmentCodes?.length ?? 0) > 0;

  let anchor: AnchorPick | null = null;
  if (opts.anchorCode) {
    note("锚点由调用方钉住", "anchor", { anchorCode: opts.anchorCode, origin: "explicit" });
  } else if (byJudgment) {
    // `recipe` 也记进去：S02 和 S03 都走这一档，而两档装回来的东西不一样厚，
    // 事后比对两次运行时这一行是唯一看得出走的是哪一档的地方。
    note("锚点按议题挂着的判断号定", "anchor", {
      judgmentCodes: opts.judgmentCodes,
      recipe: opts.recipe,
      origin: "judgmentRefs",
    });
  } else {
    try {
      anchor = await autopick(opts.q, opts.channel, client);
      warnings.push(...anchor.warnings);
      note("锚点自动选定", "anchor", {
        anchorCode: anchor.anchorCode,
        label: anchor.label,
        score: anchor.score,
        rankOverall: anchor.rankOverall,
        ambiguous: anchor.ambiguous,
        pool: anchor.pool,
        runnersUp: anchor.runnersUp,
        querySent: anchor.querySent,
      });
    } catch (e) {
      // AnchorNotFound 必须在基类之前判。不是故障，是分支。
      if (!(e instanceof AnchorNotFound)) throw e;
      return await externalOnly(e);
    }
  }

  /*
   * 按判断那一档的「图里一条都没有」是在装配里才发现的（要逐个探过才知道），所以
   * 这里也得接一次 `AnchorNotFound`。同一条规矩：**它必须在基类之前判**，
   * `GraphKnowledgeUnavailable` 原样往外抛。
   */
  let bundle: ContextBundle;
  try {
    const anchorCode = opts.anchorCode ?? anchor?.anchorCode ?? "";
    bundle = byJudgment
      ? opts.recipe === "S03"
        ? await buildS03FromJudgments(client, opts.judgmentCodes!, {
            coreQuestion: opts.q,
            viewer,
            asOf,
          })
        : await buildS02FromJudgments(client, opts.judgmentCodes!, { query: opts.q, viewer, asOf })
      : opts.recipe === "S01"
        ? await buildS01(client, anchorCode, { query: opts.q, viewer, asOf })
        : opts.recipe === "S02"
          ? await buildS02(client, anchorCode, { query: opts.q, viewer, asOf })
          : await buildS03(client, anchorCode, { coreQuestion: opts.q, viewer, asOf });
  } catch (e) {
    if (!(e instanceof AnchorNotFound)) throw e;
    return await externalOnly(e);
  }

  warnings.push(...bundle.warnings);
  const snapshotId = freezeContext(bundle);
  note(`${opts.recipe} 上下文已装配并冻结`, "context", {
    ...bundleSummary(bundle),
    snapshotId,
    calls: bundle.calls,
  });

  return {
    mode: "anchored",
    bundle,
    anchor,
    anchorOrigin: opts.anchorCode ? "explicit" : byJudgment ? "judgmentRefs" : "auto",
    noAnchorReason: null,
    // 空串：这条路的 P0 已经在 `bundle.renderedMarkdown` 里，再放一份两处就会各自漂移。
    staticContext: "",
    snapshotId,
    trace,
    warnings,
  };
}
