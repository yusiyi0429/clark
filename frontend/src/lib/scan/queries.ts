/**
 * 拟检索式 —— 一轮扫描的第一步：**把策略里那十几条 KIQ 变成能发给搜索的问法。**
 *
 * 实验台那条路上这一步叫 plan，干的是「选源」：从 RSS 和发布页里挑今天该访问哪几个。
 * 这条路上没有源清单（`CATCHING_SPEC` 里 `pinned_sources` 是空的），能问的只有搜索，
 * 所以这一步换成「拟问法」。要回答的问题是同一个：**今天去哪儿看。**
 *
 * ## 每条问法都必须挂着它回答哪条 KIQ
 *
 * 不是记账癖。策略第四节写着「信号的价值以『回答了哪条 KIQ』衡量」，而屏幕上每条
 * 信号也确实摆着那个编号。编号只能从这一步带下去 —— 研判那一步看到的是一堆搜索
 * 结果，它答不出「这一条是被哪个问题捞上来的」。丢了这一格，屏幕上那个编号就只能
 * 由模型现编，而编出来的编号指不回策略里的任何一行。
 *
 * ## 模型挂了不等于这一轮完
 *
 * 拟问法是**一次可以退化的调用**：模型不给、给的解析不了，就拿 KIQ 原文当问法
 * （`fallbackQueries`）。退化的产出确实差一档 —— KIQ 是写给人读的长句，直接发给搜索
 * 引擎召回不如短问法 —— 但它是**真的题**，不是编的。这一步一挂就整轮失败，代价是
 * 一号位按下那个键之后什么都没有；而退化之后他至少拿到按常备域扫的一批。
 *
 * 退化了要说出来（`degraded`），那句话会进日志，也会算进这一轮的账。
 */
import { callJson } from "@/lib/agent/json";
import { parseJson } from "@/lib/agent/json";

import type { ScanStrategy } from "./strategy";

/** 一条要发给搜索的问法。 */
export type ScanQuery = {
  /** 发给搜索引擎的那句话。 */
  q: string;
  /** 它回答哪条 KIQ（`KIQ2.2` 这种）。跟着命中的条目一路带到屏幕上。 */
  kiq: string;
};

export type QueryPlan = {
  queries: ScanQuery[];
  /** 非空 = 这一轮的问法是退化来的，里面是原因。 */
  degraded: string;
};

/** 一轮最多几条问法。18 条 KIQ 全上是上限，实际由模型按域收敛。 */
const MAX_QUERIES = 18;

/** 模型这一次的额度。18 条短句加编号，一千五百够写完还有富余。 */
const MAX_TOKENS = 1500;

type Call = (prompt: string) => Promise<string>;

const defaultCall: Call = (prompt) =>
  callJson([{ role: "user", content: prompt }], {
    slot: "flash",
    maxTokens: MAX_TOKENS,
    hint: "scan.queries",
  });

/**
 * 拟出这一轮的问法。
 *
 * `focus` 是一号位当面交代的那句「这一轮多盯着点什么」。它**只改取向，不改阈值**
 * （同 `MonitorFocus` 上那段）：它进的是这一步的提示词，让模型在挑域、拟问法的时候
 * 侧重那件事，而准入门槛和过线分数仍然由策略第四节说了算。
 */
export async function buildQueries(opts: {
  strategy: ScanStrategy;
  focus?: string;
  /** 打桩用。测试不出网、不叫模型。 */
  call?: Call;
}): Promise<QueryPlan> {
  const { strategy, focus = "" } = opts;
  const call = opts.call ?? defaultCall;

  const kiqs = strategy.domains.flatMap((d) =>
    d.kiqs.map((k) => ({ domain: `${d.code} ${d.title}`, text: k })),
  );
  if (kiqs.length === 0) {
    // 策略正文解析不出 KIQ = 策略格式变了。这不是可以退化的事：没有题库，
    // 拟出来的问法就没有一条挂得上编号，而那正是这一整条链路的锚。
    throw new Error("靶点策略里一条 KIQ 都没认出来 —— 正文格式变了，先修策略解析。");
  }

  const prompt = [
    strategy.body,
    "",
    "---",
    "",
    "上面是你的靶点策略。现在只做第一步：**为这一轮扫描拟检索式**，不做研判。",
    "",
    focus
      ? `一号位这一轮交代了一句：「${focus}」。挑观察域和拟问法时侧重它 —— 但常备域（D1/D2/D3）仍然每次必扫。`
      : "本轮没有指定主题：按策略全域扫描，常备域（D1/D2/D3）必扫。",
    "",
    "要求：",
    `1. 一共 8–${MAX_QUERIES} 条，每条对应一个 KIQ，同一个 KIQ 最多一条。`,
    "2. 每条是**发给中文搜索引擎的短问法**，10–25 个字，含具体的公司名/产品名/政策名，",
    "   不要写成疑问句，不要带「有无」「是否」这类检索引擎读不懂的措辞。",
    "3. `kiq` 填策略里的编号原文（如 KIQ1.2），不要自己编号。",
    "",
    '只输出 JSON：{"queries":[{"q":"…","kiq":"KIQ1.2"}]}',
  ].join("\n");

  try {
    const text = await call(prompt);
    const out = parseJson<{ queries?: unknown }>(text);
    const queries = clean(out.queries, kiqs.map((k) => k.text));
    if (queries.length === 0) {
      return { queries: fallbackQueries(kiqs), degraded: "模型没有给出一条可用的检索式" };
    }
    return { queries, degraded: "" };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { queries: fallbackQueries(kiqs), degraded: `拟检索式那一次调用没成：${why}` };
  }
}

/**
 * 把模型给的那一份收干净。
 *
 * **编号对不上策略的一律丢掉。** 模型偶尔会把 `KIQ1.2` 写成 `KIQ 1.2` 或者干脆编一个
 * `KIQ7.1`（策略里只有六个域）。留着它等于在屏幕上摆一个指不回任何一行的编号，
 * 而一号位点开监控策略去对的时候会发现那一条不存在。
 */
function clean(raw: unknown, kiqTexts: string[]): ScanQuery[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(kiqTexts.map(codeOf).filter(Boolean));
  const seen = new Set<string>();
  const out: ScanQuery[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const q = String((item as Record<string, unknown>).q ?? "").trim();
    const kiq = String((item as Record<string, unknown>).kiq ?? "")
      .trim()
      .replace(/\s+/g, "");
    if (!q || !known.has(kiq)) continue;
    if (seen.has(kiq)) continue;
    seen.add(kiq);
    out.push({ q, kiq });
    if (out.length >= MAX_QUERIES) break;
  }
  return out;
}

/**
 * 退化的那一份：KIQ 原文自己当问法。
 *
 * 掐掉编号和句末的问号 —— 编号发给搜索引擎是噪音，问号让它去匹配问句。剩下那句话
 * 就是策略里写的原题，长是长了点，但一个字不是编的。
 */
function fallbackQueries(kiqs: { text: string }[]): ScanQuery[] {
  const out: ScanQuery[] = [];
  for (const k of kiqs) {
    const code = codeOf(k.text);
    if (!code) continue;
    const q = k.text
      .slice(code.length)
      .replace(/[？?]\s*$/, "")
      .trim();
    if (q) out.push({ q, kiq: code });
    if (out.length >= MAX_QUERIES) break;
  }
  return out;
}

/** `KIQ2.2 全双工语音…` → `KIQ2.2`。认不出来返回空串。 */
export const codeOf = (kiqText: string): string =>
  /^(KIQ\S*?)(?:\s|$)/.exec(kiqText.trim())?.[1] ?? "";
