/**
 * 图谱四层自检。**不调模型，一个 token 不烧。**
 *
 * 卡在哪层报哪层。这一条通了，「api + 本体连接跑通」就算立住了。
 */
import { GraphKnowledgeClient, gkSettings } from "./client";
import { AnchorNotFound, GraphKnowledgeError } from "./errors";
import { MAX_CANDIDATES, autopick, type Channel } from "./lookup";
import { buildS01, buildS02, buildS03, bundleSummary, type Recipe } from "./recipes";
import { clip } from "./limits";

export type CheckLayer = {
  layer: "网络" | "P0" | "锚点" | "P3" | "配方";
  ok: boolean;
  detail: Record<string, unknown>;
  error?: string;
};

const msg = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/**
 * 服务端在应答正文里说的那句话。**必须跟着 `error` 一起记下来。**
 *
 * 这一条是拿本机跑起来的 memory-adapter 对着自检打了一遍才发现的：库连不上时它返回
 * 503，而正文是一份完整的 `HealthzReport` —— 里面写着「数据库不可达：connection timeout
 * expired」、还写着哪几个环境变量没配。那正是「为什么不通」唯一的答案，而这一层原来只记
 * 一句 `GraphKnowledge 返回 503`，读的人只能去登服务器。
 *
 * 客户端早就把它接住了（`GraphKnowledgeError.detail` 里是解析过的正文，解析不了就是前
 * 500 字），丢掉它的是这一层。空对象不记 —— 一个恒定出现的 `serverSaid: {}` 会让人以为
 * 服务端确实答了点什么。
 */
function serverSaid(e: unknown): Record<string, unknown> | undefined {
  if (!(e instanceof GraphKnowledgeError)) return undefined;
  return Object.keys(e.detail).length > 0 ? e.detail : undefined;
}

export const RECIPES: readonly Recipe[] = ["S01", "S02", "S03"];

/** 给路由层用：字符串是不是一个配方名。路由不许直接 import `@/lib/graphknowledge`。 */
export const asRecipe = (value: string): Recipe | null =>
  (RECIPES as readonly string[]).includes(value) ? (value as Recipe) : null;

/**
 * 配方各自认哪种锚点：S01 从信号出发，S02/S03 从议题出发（见 `lookup.ts` 的 `PREFIX`）。
 * 带 `?recipe=` 时锚点层也要换成对应频道 —— 拿 A3 的议题锚点去跑 S01 是在验一件
 * 真实链路上不存在的事。
 *
 * 这张表是**配方 → 锚点前缀**，一个配方只能填一个频道。S03 有两个调用方（A4 深研、
 * A10 写回），这里填 A4 —— 两者的前缀都是 `ISS-`，自检要验的锚点层因此完全一样。
 * 哪天有两个调用方的前缀不同，这张表就不够用了，得按频道而不是按配方来问。
 */
const CHANNEL_OF: Record<Recipe, Channel> = { S01: "A1a", S02: "A3", S03: "A4" };

export async function runGraphKnowledgeCheck(opts: {
  /** 一条**真实的** issue.statement。拿假问题跑锚点层等于没测。 */
  probeQuery: string;
  /**
   * 给了就把第 ④ 层换成**整条配方装配**（S03 的两次 P3、双路合并、版本链、共识段
   * 都在里面）；不给则只验最后一跳 P3。
   */
  recipe?: Recipe;
  viewer?: string;
  asOf?: string;
}): Promise<{ ok: boolean; stoppedAt: string | null; layers: CheckLayer[]; warnings: string[] }> {
  const settings = gkSettings();
  const client = new GraphKnowledgeClient(settings);
  const viewer = opts.viewer ?? settings.viewer;
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const layers: CheckLayer[] = [];

  // ── ① 网络：地址配了没有、TLS 校验开没开、能不能建连 ──
  /*
   * 认证只报「配了没有」，凭据不进返回值 —— 这个结构会经 HTTP 暴露出去。
   *
   * `baseUrl` 是唯一带出去的具体值：**这是给自己人看的诊断口**（`src/proxy.ts` 把它挡在
   * 门禁后面），而「连不上」这类问题第一句要问的就是「连的是哪个地址」，只报一个
   * boolean 的话每次都得再去翻部署环境。内网 IP 不是凭据，但也别往门禁外面搬。
   */
  const net: CheckLayer = {
    layer: "网络",
    ok: false,
    detail: {
      baseUrlConfigured: Boolean(settings.baseUrl),
      baseUrl: settings.baseUrl,
      authConfigured: settings.auth !== null,
      verifyTls: settings.verifyTls,
    },
  };
  try {
    net.detail.healthz = await client.health();
    net.ok = true;
  } catch (e) {
    net.error = msg(e);
    net.detail.serverSaid = serverSaid(e);
  }
  layers.push(net);
  if (!net.ok) return done(layers, settings.warnings);

  // ── ② P0：公司经营状态取到没有，viewer / as_of 生效没有 ──
  const p0: CheckLayer = { layer: "P0", ok: false, detail: { viewer, asOf } };
  try {
    const text = await client.staticContext({ viewer, asOf });
    p0.detail.chars = text.length;
    p0.detail.head = text.slice(0, 200);
    // 取到一个空串和取到内容是两件事，而两者都是 200。
    p0.ok = text.trim().length > 0;
    if (!p0.ok) p0.error = "P0 返回了空正文：viewer 或 as_of 可能不对";
  } catch (e) {
    p0.error = msg(e);
    p0.detail.serverSaid = serverSaid(e);
  }
  layers.push(p0);
  if (!p0.ok) return done(layers, settings.warnings);

  // ── ③ 锚点：拿一条真实 issue.statement 跑 autopick ──
  const channel: Channel = opts.recipe ? CHANNEL_OF[opts.recipe] : "A3";
  const anchor: CheckLayer = {
    layer: "锚点",
    ok: false,
    detail: {
      probeQuery: opts.probeQuery,
      querySent: clip(opts.probeQuery),
      k: MAX_CANDIDATES,
      channel,
    },
  };
  /** 装配层要用。`AnchorNotFound` 时留 null —— 那条路上没有可装配的上下文。 */
  let anchorCode: string | null = null;
  try {
    const pick = await autopick(opts.probeQuery, channel, client);
    anchorCode = pick.anchorCode;
    anchor.ok = true;
    anchor.detail = {
      ...anchor.detail,
      anchorCode: pick.anchorCode,
      label: pick.label,
      score: pick.score,
      rankOverall: pick.rankOverall,
      ambiguous: pick.ambiguous,
      pool: pick.pool,
      runnersUp: pick.runnersUp,
    };
  } catch (e) {
    /*
     * `AnchorNotFound` **不算这一层不通**：它说明这条探针问题在图里没有对应
     * 议题，而不是锚点机制坏了。把它记成失败会让人去修一个没坏的东西。
     */
    if (e instanceof AnchorNotFound) {
      anchor.ok = true;
      anchor.detail = {
        ...anchor.detail,
        outcome: "AnchorNotFound（正常分支：转纯外部）",
        why: e.detail.why,
        pool: e.detail.pool,
      };
    } else {
      anchor.error = msg(e);
      anchor.detail = { ...anchor.detail, serverSaid: serverSaid(e) };
    }
  }
  layers.push(anchor);
  if (!anchor.ok) return done(layers, settings.warnings);

  // ── ④ 不带 recipe：只验最后一跳 P3 —— 语义段取到没有、有没有降级 ──
  if (!opts.recipe) {
    const p3: CheckLayer = { layer: "P3", ok: false, detail: {} };
    try {
      const r = await client.dynamic(clip(opts.probeQuery), { k: 3, budget: 1200 });
      p3.detail = {
        seeds: (r.seeds ?? []).map((s) => ({ code: s.code, type: s.type, score: s.score })),
        chars: (r.text ?? "").length,
        // 降级不是错误：P0/P1/P2 的确定性上下文照用。但要报出来。
        degraded: r.warning ?? null,
      };
      p3.ok = true;
    } catch (e) {
      p3.error = msg(e);
      p3.detail.serverSaid = serverSaid(e);
    }
    layers.push(p3);
    return done(layers, settings.warnings);
  }

  /*
   * ── ④ 带 recipe：跑**整条配方装配** ──
   *
   * 这一层存在的理由：单跑一次 P3 证明不了配方。S03 那条最重 —— 两次 P3（各自的
   * k/budget）、双路合并去重、版本链渲染、共识段 —— 只有真的调 `buildS03` 才走得到。
   * `calls` 原样带出来，是为了让「这次到底按什么参数打了哪些端点」能对回台账。
   *
   * 不冻结快照：自检是只读的，写一份快照进 store 会挤掉真实运行的那些。
   */
  const asm: CheckLayer = { layer: "配方", ok: false, detail: { recipe: opts.recipe, anchorCode } };
  if (!anchorCode) {
    // 没锚点不是这一层不通：纯外部路本来就不装配公司上下文。
    asm.ok = true;
    asm.detail.outcome = "AnchorNotFound（正常分支）：纯外部路不装配上下文，配方层跳过";
  } else {
    try {
      const bundle =
        opts.recipe === "S01"
          ? await buildS01(client, anchorCode, { query: opts.probeQuery, viewer, asOf })
          : opts.recipe === "S02"
            ? await buildS02(client, anchorCode, { query: opts.probeQuery, viewer, asOf })
            : await buildS03(client, anchorCode, {
                coreQuestion: opts.probeQuery,
                viewer,
                asOf,
              });
      asm.detail = {
        ...asm.detail,
        ...bundleSummary(bundle),
        calls: bundle.calls,
        // 语义段降级不是错误，但装配出来的上下文少一段，必须报出来。
        degraded: bundle.warnings,
        head: bundle.renderedMarkdown.slice(0, 200),
      };
      asm.ok = true;
    } catch (e) {
      asm.error = msg(e);
      asm.detail.serverSaid = serverSaid(e);
    }
  }
  layers.push(asm);
  return done(layers, settings.warnings);
}

function done(layers: CheckLayer[], warnings: string[]) {
  const failed = layers.find((l) => !l.ok);
  return { ok: !failed, stoppedAt: failed?.layer ?? null, layers, warnings };
}
