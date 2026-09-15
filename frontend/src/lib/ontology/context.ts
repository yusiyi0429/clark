/**
 * 开局装一份公司上下文 —— **两个源的分派点**。
 *
 * 上面那扇门（`harness.openContext` 与 `company-context.ts`）的签名、三态语义、
 * 返回类型全都不动，动的只有门后面是谁在供货。所以五条链路（A1a/A3/A4/A10/对话）
 * 一行都不用改，换源是一行环境变量的事。
 *
 * ## 叙述这一支为什么是第三档 `mode`
 *
 * `OpenedContext.mode` 原来是两档，两档都放不下它：
 *
 * · 说成 `anchored`，就是在台账上宣称有一个锚点 —— 而这一支的 `anchorCode` 是空的，
 *   一个可引的编号都没有。事后按 `anchorCode` 去比对两次运行会比出一片空。
 * · 说成 `external_only`，就是报告一次并不存在的降级 —— 而这一支手上明明有一整段
 *   真实的公司经营脉络。屏幕上那句「本次无公司上下文」会是假的。
 *
 * 所以加第三档。三档在下游各有各的说法（`harness.contextBlock` 三选一、`anchorChecks`
 * 三选一、`a3/run.ts` 与 `a4/shared.ts` 的溯源行三选一），一档都不能省。
 *
 * ## 这一支交出去的东西比旧路少一样：`memberIds` 是空的
 *
 * 叙述接口不回短码。跟着落空的是 A1a 的 `cited_member_ids` 白名单（`checks.ts` 的
 * `citedOk` 逐个查模型引的编号在不在这一轮上下文里）和屏幕上可点开的锚点。
 * **空数组在下游是合法的、而且是对的**：`harness.externalOnly` 因此为 true，A1a 走
 * `a1aExternal` 那一套检查，其中「引用为空」正是这一支该有的硬约束。
 */
import {
  clip,
  contextExists,
  freezeContext,
  loadContext,
  openContext as openGraphContext,
  type AnchorPrefix,
  type Channel,
  type ContextBundle,
  type OpenedContext,
  type Recipe,
  type TraceNode,
} from "@/lib/graphknowledge";

import { NarrativeClient } from "./narrative";
import { ontologySource } from "./source";

export type OpenOntologyOpts = {
  recipe: Recipe;
  prefix: AnchorPrefix;
  channel: Channel;
  q: string;
  anchorCode?: string;
  judgmentCodes?: string[];
  viewer?: string;
  asOf?: string;
  /**
   * 要上游压缩前那份原文吗。
   *
   * **由调用方定，不按 channel 查表** —— 对话那条路传的 channel 是 `A3`（它借 A3 的
   * 锚点前缀），按 channel 查表会让对话跟着预研一起吃 1851 字的原文，而它要的是首字快。
   *
   * 今天的口径：A3 预研 / A4 深研 / A10 写回要原文（原文里带着来源和确认状态 ——
   * 「CEO 2026-08-24 内部会议原话」「该 PDF 已向管理层汇报且未被推翻」「仅 pending
   * 不 confirm」，压缩版把这些磨掉了，而那正是报告里锚点的出处）；A1a 与对话取压缩版。
   */
  includeRaw?: boolean;
};

/** `as_of` 没有环境变量，理由同旧路：设成某个日期然后忘掉，之后每次都在读过期视图。 */
const today = (): string => new Date().toISOString().slice(0, 10);

export async function openOntologyContext(opts: OpenOntologyOpts): Promise<OpenedContext> {
  if (ontologySource() === "graph") {
    return openGraphContext({
      recipe: opts.recipe,
      prefix: opts.prefix,
      channel: opts.channel,
      q: opts.q,
      anchorCode: opts.anchorCode,
      judgmentCodes: opts.judgmentCodes,
      viewer: opts.viewer,
      asOf: opts.asOf,
    });
  }
  return openNarrativeContext(opts);
}

async function openNarrativeContext(opts: OpenOntologyOpts): Promise<OpenedContext> {
  const client = new NarrativeClient();
  const viewer = opts.viewer ?? "PSN-01";
  const asOf = opts.asOf ?? today();
  const trace: TraceNode[] = [];
  const warnings = [...client.warnings];
  const note = (label: string, kind: TraceNode["kind"], detail: Record<string, unknown>) =>
    trace.push({ at: new Date().toISOString(), label, kind, detail });

  /*
   * 判断号在这一支**进不去**，而且要说出来。
   *
   * 叙述接口只吃一个 `query`，没有第二个入参。旧路上判断号是锚点（图里没有前端这些议题
   * 对象，按标题检索一次都命中不了，所以改按它挂着的在版判断去锚）；这一支上它无处可去。
   * 不记这一条的后果是：调用方照旧传着 `judgmentCodes`、以为它在起作用，而两次运行的
   * 差别永远解释不了 —— 「传了没用」和「没传」在产出上长得一模一样。
   */
  if (opts.judgmentCodes?.length) {
    note("本支不吃判断号", "anchor", {
      judgmentCodes: opts.judgmentCodes,
      why: "叙述接口只有一个 query 入参，判断号在这一支没有落点；相关性由上游沿主导航路径自己算",
    });
  }
  if (opts.anchorCode) {
    note("本支不吃钉住的锚点", "anchor", {
      anchorCode: opts.anchorCode,
      why: "叙述接口不按编号取；复现旧运行要连 TKOS_ONTOLOGY_SOURCE=graph 一起钉回去",
    });
  }

  /*
   * 问句照旧过 `clip`。
   *
   * 上游没说长度上限（OpenAPI 里 `query` 就是个 string），但发一整段进去换回来的东西
   * 不会更准 —— 那一句是拿去做图检索的。裁的口径直接复用旧路那一份（100 字），
   * 不在这里另抄一个常量：抄第二份就一定会有一份忘了跟着改。
   */
  const sent = clip(opts.q ?? "");
  if (sent !== (opts.q ?? "").trim()) {
    warnings.push(`问句超长已裁到 ${sent.length} 字`);
  }

  /*
   * **回放一份冻结的本体叙述（2026-09-04 加）。** `TKOS_ONTOLOGY_SNAPSHOT=ctx-…` 指向
   * `contextSnapshots` 里某一次运行冻下来的那份 bundle，这一步就不打上游，直接用它。
   *
   * 两个用途，都不是「绕开本体」：
   * · 上游躺了（当天 memory-api 后面的 5435 库拒连）而这一轮**必须**带本体内容 —— 冻结的那份
   *   是 9/3 真从本体取回的原文，不是编的，也不是纯外部。
   * · 同题对照：改了链路想看差别，公司上下文这一项必须钉死。ISS-223 那份是
   *   `ctx-c9e1e573b6eb78c6`，用它跑 after，差异里就不混「本体今天回了另一段话」。
   *
   * 三条纪律：只在恰好有这个快照时回放（没有就照旧打上游，不静默降级）；trace 里明写
   * 「来自快照、上游本次未调用」；问句和快照里的问句不一致时记 warning 而不拦 —— 那是
   * 调用方要的对照条件，屏幕上的溯源行会把它印出来。
   */
  const replay = (process.env.TKOS_ONTOLOGY_SNAPSHOT ?? "").trim();
  if (replay) {
    if (!contextExists(replay)) {
      note("本体叙述回放未命中", "context", {
        snapshotId: replay,
        why: "contextSnapshots 里没有这个 id（快照只留最近几十份），照旧打上游",
      });
    } else {
      const frozen = loadContext(replay);
      if (frozen.anchorCode || frozen.calls[0]?.point !== "NARRATIVE") {
        note("本体叙述回放未命中", "context", {
          snapshotId: replay,
          why: "这份快照是 GraphKnowledge 那一支冻的（有锚点/编号），不能当叙述支回放；照旧打上游",
        });
      } else {
      if (frozen.query !== sent) {
        warnings.push(`本体叙述来自回放快照 ${replay}，其问句与本次不同：「${frozen.query.slice(0, 40)}…」`);
      }
      warnings.push(`本体叙述来自冻结快照 ${replay}（${frozen.asOf} 取自本体），上游本次未调用`);
      note("本体叙述来自冻结快照", "context", {
        snapshotId: replay,
        asOf: frozen.asOf,
        chars: frozen.renderedMarkdown.length,
        queryMatches: frozen.query === sent,
        why: "TKOS_ONTOLOGY_SNAPSHOT 指定了回放；这是那一次真从本体取回的原文，不是纯外部",
      });
      const bundle: ContextBundle = { ...frozen, viewer, asOf, warnings: [...(frozen.warnings ?? []), ...warnings] };
      return {
        mode: "narrative",
        bundle,
        anchor: null,
        anchorOrigin: null,
        noAnchorReason: "本体叙述接口不产生锚点：它沿主导航路径装配一段脉络，没有可引编号",
        staticContext: "",
        snapshotId: replay,
        trace,
        warnings: bundle.warnings,
      };
      }
    }
  }

  const r = await client.narrative(sent, { includeRaw: opts.includeRaw });

  if (opts.includeRaw && !r.raw) {
    /*
     * 要了原文却只拿回压缩版。**不失败这一次运行** —— 压缩版仍然是真材料，为它把一轮
     * 深研作废换不来任何诚实。但它必须写在明处：报告的溯源行读的就是 warnings，
     * 少了这一句，「这一轮的报告为什么没引到来源」就查不出是这儿丢的。
     */
    warnings.push("要了 include_raw 但上游没给 narrative_raw，本次吃的是压缩版");
  }

  if (r.attempts > 1) {
    /*
     * 重发过。产物上跟一次正常调用一模一样，差别只有「这一步花了二十几秒」——
     * 不写这一句的话，事后看到的是一轮莫名其妙慢了半分钟的深研，而慢在哪儿没有落点。
     */
    warnings.push(
      `本体这一步头一次没等到回话，重发了一次才成（共 ${r.attempts} 次，这一步 ${r.ms}ms）`
    );
  }

  note("本体叙述已取回", "context", {
    sent,
    includeRaw: Boolean(opts.includeRaw),
    chars: r.text.length,
    rawChars: r.rawChars,
    compressedChars: r.compressedChars,
    hitPaths: r.hitPaths,
    lateralNodes: r.lateralNodes,
    tenant: r.tenant,
    org: r.org,
    /*
     * 上游那个压缩模型要记下来。这段话**不是原始数据，是它写的** —— 报告里一句引自
     * 本体的话追到底是追到这个模型的一次转写，而不是图里的原文。哪天换了模型、
     * 叙述的口气跟着变，这一行是唯一能把两批运行分开的地方。
     */
    model: r.model,
    ms: r.ms,
    /** 打了几个往返（见 `narrative.ts` 的 `ATTEMPTS`）。2 就是上游抖了一下。 */
    attempts: r.attempts,
  });

  /*
   * 造一份 bundle。**不是为了假装装配过** —— 是快照那一层（`freezeContext`）、
   * `store.ts` 的快照上限、报告页那一侧全都按这个形状读，造一份出来它们一行都不用改。
   *
   * 里面每一格都照实填：`anchorCode` 是空串（没有锚点）、`memberIds` 是空数组
   * （没有可引编号）、`calls` 只有一条。填假值的诱惑在 `anchorCode` 上最大 —— 塞一个
   * 「NARRATIVE」进去，屏幕上那行溯源就有东西显示了，而那是一个图里不存在的编号。
   */
  const bundle: ContextBundle = {
    query: sent,
    recipe: opts.recipe,
    anchorCode: "",
    renderedMarkdown: r.text,
    memberIds: [],
    calls: [
      {
        point: "NARRATIVE",
        path: "/v1/context-graph/narrative",
        include_raw: Boolean(opts.includeRaw),
        hit_paths: r.hitPaths,
        lateral_nodes: r.lateralNodes,
        model: r.model,
        ms: r.ms,
        attempts: r.attempts,
      },
    ],
    warnings,
    viewer,
    asOf,
    sourceBaseUrl: r.sourceBaseUrl,
  };

  const snapshotId = freezeContext(bundle);
  note("本体叙述已冻结", "context", { snapshotId, chars: r.text.length });

  return {
    mode: "narrative",
    bundle,
    anchor: null,
    anchorOrigin: null,
    /*
     * `noAnchorReason` 在这一支**必须有话说**，而且不能写成「图谱里没有对应锚点」——
     * 那句话是旧路的一条正常分支（这条议题对公司还太新），而这一支根本没有锚点这个东西。
     * 两句混用的下场是：一号位在屏幕上读到「图谱里没有这条议题」，然后去查一件没有发生
     * 过的事。
     */
    noAnchorReason: "本体叙述接口不产生锚点：它沿主导航路径装配一段脉络，没有可引编号",
    // 空串：这一支的正文在 `bundle.renderedMarkdown` 里，再放一份两处就会各自漂移。
    staticContext: "",
    snapshotId,
    trace,
    warnings,
  };
}
