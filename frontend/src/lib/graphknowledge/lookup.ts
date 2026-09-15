/**
 * 对齐自 tkos-lab/src/tkos_lab/graphknowledge/lookup.py
 *
 * 按自然语言问题找锚点。上游给的是一句问题（正式版是 `issue.statement`），
 * 不是编号 —— 让人去背 `ISS-D6` 这种编码既不现实，也会把「这次跑哪个议题」
 * 变成一件容易填错、且填错了看不出来的事。
 *
 * 自动选并不等于不可见：选中的编号、分数、以及**落选的次名**都进 trace 和
 * 结果页。次名咬得很紧说明这句问题本身指向不清，自检会标出来由人判断 ——
 * 而不是悄悄用一条「差不多」的议题去装配上下文。
 *
 * `autopick` 有三种结局，三种必须分开：
 *   ① 命中       —— 返回锚点记录，正常装配上下文
 *   ② 图里没有   —— `AnchorNotFound`。**这不是故障**，调用方改走纯外部
 *   ③ 服务不可用 —— `GraphKnowledgeUnavailable` 原样抛出，**绝不能**折成 ②
 *
 * `findAnchors` 是给排查/浏览用的，服务不可用时也得有个返回值，所以它**吞**
 * 异常。autopick 走的是内部 `search`，不吞。
 */
import type { GkSeed, GraphKnowledgeClient } from "./client";
import { GraphKnowledgeClient as Client } from "./client";
import { AnchorNotFound, GraphKnowledgeError } from "./errors";
import { P3_MAX_QUERY_CHARS, clip } from "./limits";

export type Channel = "A1a" | "A3" | "A4" | "A5" | "A10" | "A6" | "A7";
export type AnchorPrefix = "CARD-" | "ISS-";

/**
 * 每个频道只接受一种锚点：A1a 从信号出发，其余几条从议题出发。
 *
 * **A6 和 A5 在这张表上，但它们现在不开上下文。** A6 是每轮对话都跑、不挡屏幕
 * （见 `a6/extract.ts` 文件头）；A5 读的是同一个议题刚跑完的深研报告，那份报告
 * 装配时已经带过公司上下文，为它再打一次图服务等于为同一批材料付两次钱，还多一条
 * 「图挂了连判断也生不出来」的失败路径（见 `a5/run.ts` 文件头）。
 *
 * 它们在这里是因为 harness 的 `openContext` 用 `PREFIX[this.agent]` 取前缀，
 * `HarnessAgent` 因此必须是 `Channel` 的子集；要在类型上把「不开上下文的链路」
 * 摘出去，得给 `Harness` 加一个类型参数，代价比这两行大得多。填 `ISS-` 不是敷衍：
 * 哪天它们要开上下文，锚点也是议题。
 */
export const PREFIX: Record<Channel, AnchorPrefix> = {
  "A1a": "CARD-",
  A3: "ISS-",
  A4: "ISS-",
  A5: "ISS-",
  A10: "ISS-",
  A6: "ISS-",
  /* A7 是会后提炼，同样不开上下文（材料就是那份录音的文字）。理由同上面两条。 */
  A7: "ISS-",
};

export const MAX_CANDIDATES = 8;

/**
 * 次名分数达到首名的这个比例，就当「同一档」。**这不是相关性阈值** —— 不是说
 * 0.95 以下就不相关，而是「同一个打分器分不开这两条」。所以它是相对值，换个
 * embedding 模型仍然成立；绝对阈值换个模型就废了。
 */
export const TIE_RATIO = 0.95;

/**
 * 全体种子里最低分达到最高分的这个比例，就当这个池子「拉不开」。
 *
 * 为什么需要它：P3 几乎总会返回点什么。问「VPN 服务器部署在新加坡还是香港」，
 * 图谱照样回 8 条，只是全挤在 0.278–0.299 里 —— 里面恰好有条 ISS-*，于是就会
 * 拿它当锚点，A4 接着按一条毫不相干的议题跑完全程。分布拉不开的意思是「打分
 * 器认为这句话跟库里每样东西都一样远」，那就是没有对应议题。
 */
export const FLAT_RATIO = 0.9;

/** 池子太小时分布没有意义（两三条种子的首末比天然就高），不做平坦判定。 */
export const FLAT_MIN_SEEDS = 4;

export type Pool = {
  n: number;
  topScore: number;
  bottomScore: number;
  topCode: string;
  flatness: number | null;
};

const scoreOf = (s: GkSeed): number => s.score ?? 0;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** 全体种子（不按前缀过滤）的分布。判「有没有对应议题」要看整池。 */
export function poolOf(seeds: GkSeed[]): Pool {
  const scores = seeds.map(scoreOf);
  const topScore = scores.length ? Math.max(...scores) : 0;
  const bottomScore = scores.length ? Math.min(...scores) : 0;
  return {
    n: seeds.length,
    topScore,
    bottomScore,
    topCode: String(seeds.find((s) => scoreOf(s) === topScore)?.code ?? ""),
    flatness: topScore ? round4(bottomScore / topScore) : null,
  };
}

/**
 * 这句问题在图谱里到底有没有对应议题？返回空字符串表示有。
 *
 * 两条规则任一命中就算没有，两条是互补的：
 *   · 池子拉不开 —— 打分器认为这句话跟库里每样东西都一样远
 *   · 不在同一档 —— 池子拉得开，但图谱认为有别的东西明显更贴近，最高的议题
 *                   只是陪跑（问某份文档里的细节时是这种）
 *
 * 只用前者会漏掉后者：某份 Document 0.7、其余 0.3，池子不平，但最高的 ISS-*
 * 只有 0.31。只用后者会漏掉前者：整池都挤在一起时，谁跟谁都「同一档」。
 *
 * 两个常数都是**相对**的（比例，不是分数）。实测值一律进 trace，误判了直接调常数。
 */
export function noMatchReason(top: { code: string; score?: number }, pool: Pool): string {
  const flat = pool.flatness;
  if (flat !== null && pool.n >= FLAT_MIN_SEEDS && flat >= FLAT_RATIO) {
    return (
      `P3 这一池 ${pool.n} 条种子的分数拉不开（最低/最高 = ${flat}，≥${FLAT_RATIO}），` +
      `说明打分器认为这句问题跟库里每样东西都一样远`
    );
  }
  const score = top.score ?? 0;
  if (pool.topScore && score / pool.topScore < TIE_RATIO) {
    return (
      `最贴近的 ${top.code}（${score}）不在全体首名 ${pool.topCode}（${pool.topScore}）的同一档里` +
      `（比值 ${round4(score / pool.topScore)} < ${TIE_RATIO}），图谱认为更贴近这句问题的不是一条议题`
    );
  }
  return "";
}

export type Candidate = {
  code: string;
  type?: string;
  score?: number;
  label: string;
  state: string;
  /** 在**全体**种子里排第几。判「这句问题是不是在问某条议题」看的是这个，
   *  而不是它在同前缀里排第几 —— 同前缀里它总是第一。 */
  rankOverall: number;
};

export type SearchResult = {
  candidates: Candidate[];
  prefix: AnchorPrefix;
  warnings: string[];
  pool: Pool;
  query: string;
  querySent: string;
  degraded: string;
};

/** 跑一次 P3，按前缀筛候选。**服务不可用时原样抛出。** */
async function search(
  query: string,
  prefix: AnchorPrefix,
  opts: { client?: GraphKnowledgeClient; limit: number }
): Promise<SearchResult> {
  const q = (query ?? "").trim();
  if (!q) {
    return {
      candidates: [],
      prefix,
      warnings: ["问题为空，无法检索"],
      pool: poolOf([]),
      query: q,
      querySent: q,
      degraded: "",
    };
  }

  /*
   * 送进 P3 的必须是裁过的：一条真实信号有两三百字，而 q 的服务端上限是 100
   * 字符，超了整个请求 422。裁过这件事进 warnings —— 「按前 100 字选的锚点」
   * 和「按整条信号选的锚点」不是一回事，人得看得见。
   */
  const sent = clip(q);
  const gk = opts.client ?? new Client();
  const warnings: string[] = [];
  if (sent !== q) {
    warnings.push(
      `P3 的 q 上限 ${P3_MAX_QUERY_CHARS} 字符，原文 ${q.length} 字，` +
        `本次按前 ${sent.length} 字检索：${sent}`
    );
  }

  const result = await gk.dynamic(sent, { k: MAX_CANDIDATES, budget: 2000 });
  if (result.warning) warnings.push(String(result.warning));

  const everything = [...(result.seeds ?? [])].sort((a, b) => scoreOf(b) - scoreOf(a));
  const pool = poolOf(everything);
  const codes = everything.map((s) => String(s.code ?? ""));

  const candidates: Candidate[] = [];
  const matched = everything
    .filter((s) => String(s.code ?? "").startsWith(prefix))
    .slice(0, opts.limit);
  for (const s of matched) {
    const code = String(s.code);
    const item: Candidate = {
      code,
      type: s.type,
      score: s.score,
      label: "",
      state: "",
      rankOverall: codes.indexOf(code) + 1,
    };
    try {
      // 补标题；失败只记告警，不影响其余候选 —— 只有编号的候选对人是不可判断的。
      const ent = await gk.entity(code);
      item.label = ent.label ?? "";
      item.state = String((ent.properties ?? {}).state ?? "");
    } catch (e) {
      if (e instanceof AnchorNotFound) throw e;
      if (!(e instanceof GraphKnowledgeError)) throw e;
      warnings.push(`${code} 取不到标题`);
    }
    candidates.push(item);
  }

  if (!candidates.length) {
    warnings.push(
      `P3 没有返回 ${prefix}* 候选——可能这个问题在库里还没有对应议题，` +
        `或 embedding 检索被降级。可以直接手工填写锚点。`
    );
  }

  /*
   * 一条种子都没回、而且服务端自己报了 warning：这是**检索没跑出来**，不是
   * 「库里没有对应议题」。两者的结论完全相反，不能共用一句话（真实服务上对
   * 新问题会回 query_embedding_failed，池子是空的而不是拉不开的）。
   */
  const degraded = everything.length ? "" : String(result.warning ?? "");

  return { candidates, prefix, warnings, pool, query: q, querySent: sent, degraded };
}

/**
 * 排查/浏览用：列出候选，服务不可用也要有个返回值，所以异常被吞成 `unavailable`。
 * harness 不走这条，走 `autopick`。
 */
export async function findAnchors(
  query: string,
  channel: Channel,
  opts: { client?: GraphKnowledgeClient; limit?: number } = {}
): Promise<SearchResult & { unavailable?: true }> {
  const prefix = PREFIX[channel];
  try {
    return await search(query, prefix, { client: opts.client, limit: opts.limit ?? 5 });
  } catch (e) {
    if (e instanceof AnchorNotFound) throw e;
    if (!(e instanceof GraphKnowledgeError)) throw e;
    const q = (query ?? "").trim();
    return {
      candidates: [],
      prefix,
      warnings: [`${e.name}: ${e.message}`],
      pool: poolOf([]),
      query: q,
      querySent: clip(q),
      degraded: "",
      unavailable: true,
    };
  }
}

export type AnchorPick = {
  origin: "auto";
  anchorCode: string;
  score?: number;
  label: string;
  state: string;
  channel: Channel;
  prefix: AnchorPrefix;
  rank: 1;
  rankOverall: number;
  k: number;
  /** 次名咬得紧：这句问题指向不唯一。**只提示不拦截**，由人判断。 */
  ambiguous: boolean;
  pool: Pool;
  querySent: string;
  runnersUp: { code: string; score?: number; label: string }[];
  warnings: string[];
};

/**
 * harness 用：按问题定这次运行的锚点。
 *
 * 取 P3 里该频道前缀下分数最高的一条，但**要先过「这句问题在图谱里到底有没有
 * 对应议题」这一关**（见 `noMatchReason`）。过不了就抛 `AnchorNotFound`，不允许
 * 「随便挑一个凑合」：上下文装错了议题，产出看着仍然合理，而错误的方向会被当成
 * prompt 的问题去改。
 */
export async function autopick(
  query: string,
  channel: Channel,
  client?: GraphKnowledgeClient
): Promise<AnchorPick> {
  const prefix = PREFIX[channel];
  const r = await search(query, prefix, { client, limit: 3 });
  const cands = r.candidates;
  const top = cands[0];

  let why: string;
  if (r.degraded) {
    why =
      `P3 这一次没算出检索结果（服务端 warning：${r.degraded}），` +
      `一条种子都没回，锚点无从选起`;
  } else if (!top) {
    why = `P3 没有返回任何 ${prefix}* 候选`;
  } else {
    why = noMatchReason(top, r.pool);
  }

  if (why) {
    /*
     * 「检索没跑出来」和「图谱里还没有这条议题」的结论相反：后者说明这条输入
     * 对公司现有方向来说太新，前者只说明这一次没检索成功。混成一句话会让人把
     * 一次检索故障读成一个战略判断。
     */
    const tail = r.degraded
      ? "检索没跑出来时**不能**读作「图谱里没有这条议题」——这一次拿不到公司上下文，但它不是关于这条输入的判断。"
      : "这不代表这个问题与战略无关——可能它对公司战略方向来说还太新。";
    throw new AnchorNotFound(
      `按这条问题在 GraphKnowledge 里找不到 ${prefix}* 锚点：${why}。${tail}`,
      {
        query,
        querySent: r.querySent,
        channel,
        prefix,
        why,
        degraded: r.degraded,
        pool: r.pool,
        bestEffort: top ?? null,
        warnings: r.warnings,
      }
    );
  }

  const rest = cands.slice(1);
  const s1 = top.score;
  const s2 = rest[0]?.score;
  const ambiguous = Boolean(s1 && s2 && s2 / s1 >= TIE_RATIO);

  return {
    origin: "auto",
    anchorCode: top.code,
    score: s1,
    label: top.label,
    state: top.state,
    channel,
    prefix,
    rank: 1,
    rankOverall: top.rankOverall,
    k: MAX_CANDIDATES,
    ambiguous,
    pool: r.pool,
    querySent: r.querySent,
    runnersUp: rest.map((c) => ({ code: c.code, score: c.score, label: c.label })),
    warnings: r.warnings,
  };
}
