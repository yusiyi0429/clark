/**
 * 逐条研判 —— 一轮扫描里**唯一花钱的那一步**，也是「宁可漏掉平庸的，不可让噪音过线」
 * 这条产品原则真正落地的地方。
 *
 * 进来的是一批搜索命中（标题、摘要、来源、日期、它是被哪条 KIQ 捞上来的），出去的是
 * 一批带分的信号。策略第四节是这一步的全部依据，正文原样发给模型。
 *
 * ## 分数由这边算，不问模型要
 *
 * 策略第四节写着五个维度各 1–5 分、加权平均（假设关联 ×0.3、幅度 ×0.25、时窗 ×0.2、
 * 新颖 ×0.15、可行动 ×0.1）。模型只给五个维度的分，**综合分在这边算**。
 *
 * 让模型自己报一个综合分，屏幕上那个数就没人核得动：它可能是加权算的，也可能是它
 * 觉得「差不多四分」。而这个数是过线阈值（3.5）比的那个数 —— 门槛必须是一道算式，
 * 不能是一次印象。算在这边之后，「为什么这条 3.7 那条 3.4」永远答得出来：把五个数
 * 摆出来，乘一遍。
 *
 * ## 不过门槛的不打分
 *
 * 策略里准入门槛（有明确事实与来源、在时间窗内、与任一 KIQ 沾边）是**淘汰制**，不是
 * 低分。所以模型对这一类只回一句淘汰理由（`reject`），不回维度分 —— 硬给它打个 1 分
 * 会让「够不上门槛」和「够上了但不重要」混成同一个数。
 *
 * ## 一批挂了不拖垮整轮
 *
 * 三十条分三批，一批一次调用。某一批模型挂了或者回的东西解析不了，**那一批丢掉、
 * 别的批照收**，原话进 `errors` 由调用方带进日志。全部批都挂才算这一轮失败 ——
 * 判据在调用方（`run.ts`）：`scored` 空且 `errors` 满，那是失败；`scored` 空而
 * `errors` 空，那是「这一批真的一条都没过线」，是合法结果。
 */
import { callJson, parseJson } from "@/lib/agent/json";

/** 送进来研判的一条。 */
export type Candidate = {
  url: string;
  title: string;
  /** 搜索给的摘要。研判只看得到它 —— 正文要等过线之后才抓（见 `run.ts`）。 */
  snippet: string;
  source: string;
  publishedAt?: string;
  /** 它是被哪条 KIQ 的问法捞上来的。研判可以改判成别的编号。 */
  kiq: string;
};

/** 研判完的一条。 */
export type Scored = Candidate & {
  /** 五维加权算出来的综合分，1–5。 */
  score: number;
  dimensions: Record<string, number>;
  /** 一句话理由：「若为真意味着什么」，不复述原文。 */
  why: string;
  /** 一句可进提请台的问题句。 */
  suggestedIssue: string;
};

/**
 * 五维与权重，抄策略第四节。**改这里等于改产品**：它决定什么端到一号位面前。
 *
 * 名字用中文原文而不是英文 key：这五个字段会原样存进信号的 `dimensions`，
 * 而屏幕上摊开它们的时候写的就是这五个词。中间多一层译名，屏幕和策略就对不上。
 */
export const WEIGHTS: Record<string, number> = {
  假设关联: 0.3,
  影响幅度: 0.25,
  时间窗: 0.2,
  新颖度: 0.15,
  可行动: 0.1,
};

/** 一批多少条。太大，一条摘要长的会把这批的上下文吃光；太小，策略全文每批重发一遍的固定开销占比太高。 */
const BATCH = 10;

/** 一批的额度。十条各写一句理由加一句议题方向，两千够。 */
const MAX_TOKENS = 2000;

type Call = (prompt: string) => Promise<string>;

const defaultCall: Call = (prompt) =>
  callJson([{ role: "user", content: prompt }], {
    slot: "flash",
    maxTokens: MAX_TOKENS,
    hint: "scan.triage",
  });

export type TriageResult = {
  /** 过了准入门槛、算出了分的那几条。**没有按阈值筛** —— 筛在调用方，因为阈值是 spec 里的数。 */
  scored: Scored[];
  /** 被判为够不上门槛的条数。它和「一条都没搜到」是两件事，账要分开记。 */
  rejected: number;
  /** 出错的那几批的原话，每批一句。 */
  errors: string[];
};

/**
 * 把一批候选逐条研判。
 *
 * `onBatch` 是给进度条用的：这一步是整轮里最慢的，屏幕上那行字要说出走到第几批。
 */
export async function triage(opts: {
  candidates: Candidate[];
  /** 策略正文。原样发给模型 —— 这一步的尺子就是它。 */
  strategyBody: string;
  call?: Call;
  onBatch?: (no: number, total: number) => void;
}): Promise<TriageResult> {
  const call = opts.call ?? defaultCall;
  const batches: Candidate[][] = [];
  for (let i = 0; i < opts.candidates.length; i += BATCH) {
    batches.push(opts.candidates.slice(i, i + BATCH));
  }

  const scored: Scored[] = [];
  const errors: string[] = [];
  let rejected = 0;

  for (const [i, batch] of batches.entries()) {
    opts.onBatch?.(i + 1, batches.length);
    try {
      const text = await call(prompt(opts.strategyBody, batch));
      const out = parseJson<{ items?: unknown }>(text);
      const got = collect(out.items, batch);
      scored.push(...got.scored);
      rejected += got.rejected;
      // 解析不了的单条只记一句，不算这一批失败：九条好的不该被第十条拖走。
      errors.push(...got.notes.map((n) => `第 ${i + 1} 批：${n}`));
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      errors.push(`第 ${i + 1} 批研判没成，这一批丢掉：${why}`);
    }
  }

  return { scored, rejected, errors };
}

/** 五维加权。缺任何一维就返回 undefined —— 缺一维的加权平均不是这条算式。 */
export function weigh(dimensions: Record<string, unknown>): number | undefined {
  let sum = 0;
  for (const [name, w] of Object.entries(WEIGHTS)) {
    const v = dimensions[name];
    if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
    // 越界的分不夹紧，直接判为不可用：一个 12 分的「影响幅度」说明模型没按 1–5 答，
    // 夹成 5 分会把一次没读懂题的回答洗成一个看起来正常的高分。
    if (v < 1 || v > 5) return undefined;
    sum += v * w;
  }
  return Math.round(sum * 100) / 100;
}

function collect(
  raw: unknown,
  batch: Candidate[],
): { scored: Scored[]; rejected: number; notes: string[] } {
  const scored: Scored[] = [];
  const notes: string[] = [];
  let rejected = 0;
  if (!Array.isArray(raw)) return { scored, rejected, notes: ["回包里没有 items 数组"] };

  const seen = new Set<number>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const i = typeof o.i === "number" ? o.i : Number.NaN;
    const cand = batch[i - 1];
    // 编号指不到这一批里的任何一条 —— 丢掉，不猜是哪条。按顺序对齐是最坏的猜法：
    // 模型少回一条，后面每一条的理由就都挂错了对象，而屏幕上看不出来。
    if (!cand || seen.has(i)) continue;
    seen.add(i);

    const reject = String(o.reject ?? "").trim();
    if (reject) {
      rejected += 1;
      continue;
    }

    const dims = o.dimensions;
    if (!dims || typeof dims !== "object") {
      notes.push(`第 ${i} 条既没有 dimensions 也没有 reject，丢掉`);
      continue;
    }
    const score = weigh(dims as Record<string, unknown>);
    if (score === undefined) {
      notes.push(`第 ${i} 条的五维分不全或超出 1–5，丢掉`);
      continue;
    }
    const why = String(o.why ?? "").trim();
    if (!why) {
      // 策略要求每条必须带一句理由。没有理由的一条在屏幕上是一个没有出处的分数。
      notes.push(`第 ${i} 条没有给理由，丢掉`);
      continue;
    }

    scored.push({
      ...cand,
      score,
      dimensions: Object.fromEntries(
        Object.keys(WEIGHTS).map((k) => [k, (dims as Record<string, number>)[k]]),
      ),
      why,
      kiq: String(o.kiq ?? "").trim() || cand.kiq,
      suggestedIssue: String(o.suggested_issue ?? "").trim(),
    });
  }
  return { scored, rejected, notes };
}

function prompt(strategyBody: string, batch: Candidate[]): string {
  const list = batch
    .map((c, i) =>
      [
        `【${i + 1}】${c.title}`,
        `来源：${c.source}${c.publishedAt ? ` · ${c.publishedAt}` : " · 未标日期"}`,
        `捞它上来的问题：${c.kiq}`,
        `摘要：${c.snippet || "（搜索没给摘要）"}`,
      ].join("\n"),
    )
    .join("\n\n");

  return [
    strategyBody,
    "",
    "---",
    "",
    "上面是你的靶点策略。现在做第四节那一步：**逐条研判下面这批搜索命中**。",
    "",
    list,
    "",
    "对每一条：",
    "1. 先过准入门槛（有明确事实与来源、在时间窗内、与任一 KIQ 沾边）。",
    '   **过不了的只回 `{"i":N,"reject":"一句话说清为什么淘汰"}`，不要打分。**',
    "2. 过得了的，按五维各给 1–5 分（假设关联 / 影响幅度 / 时间窗 / 新颖度 / 可行动）。",
    "   **不要自己算综合分** —— 加权由程序做。",
    "3. 每条标注命中的 KIQ 编号、一句话理由（说清「若为真意味着什么」，不复述原文）、",
    "   以及一句可进提请台的问题句。",
    "",
    "宁缺毋滥：这一批全部淘汰是合法结果，硬凑过线是最严重的失败。",
    "",
    "只输出 JSON：",
    '{"items":[{"i":1,"reject":"纯营销通稿"},' +
      '{"i":2,"dimensions":{"假设关联":5,"影响幅度":4,"时间窗":3,"新颖度":4,"可行动":2},' +
      '"kiq":"KIQ2.2","why":"…","suggested_issue":"…"}]}',
  ].join("\n");
}
