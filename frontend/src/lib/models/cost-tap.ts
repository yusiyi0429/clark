/**
 * 算账用的计量口。**默认完全不生效，配了 `TKOS_COST_TAP` 才写一个字节。**
 *
 * ## 为什么需要它，而不是读运行台账
 *
 * `AgentRunRecord.usage` 只覆盖走 `Harness` 的那几条链路。2026-08-31 那一轮算账里，
 * 两条最要紧的用量恰好都不在台账上：
 *
 * · **定题（A2）** 走的是 `callJson`，那个函数只返回正文，token 数当场丢掉。
 * · **对谈**（`/api/chat`）压根不经过 `models/complete.ts`，它有自己的流式 `fetch`，
 *   而请求里没要用量、路由里也没有任何地方累加 —— 一号位用得最频繁的一条线，
 *   在这台机器上答不出「花了多少」。
 *
 * 只看台账会把「没记账」读成「没花钱」。所以这一口装在**真正的出口**上：非流式那一支
 * 是 `complete.ts` 的 `callModel`，流式那一支是 `/api/chat` 的 `pump`，检索是
 * `research/search.ts` 的 `searchAll`。三处加起来没有第四条路。
 *
 * ## 为什么是文件，不是库
 *
 * 它量的东西横跨进程（单测里跑一段、dev server 上跑另一段），而且要能在跑完之后拿别的
 * 工具去汇总。落进库里就得为它加一张表、一个读口、一个清理策略 —— 而这是一次性的账，
 * 不是产品数据。
 *
 * ## 怎么用
 *
 *     TKOS_COST_TAP=/tmp/cost.jsonl TKOS_COST_STAGE=A4-深研 pnpm ...
 *
 * 每一次调用往那个文件追加一行 JSON。`TKOS_COST_STAGE` 是给行打的标签，跑到哪一段就
 * 改成哪一段的名字（不给就是空串，汇总时全落在一组里）。
 *
 * ## 三条不许越的线
 *
 * · **不许抛。** 量钱的东西弄挂了正经链路，是这个文件能犯的最坏的错。所有写盘都吞掉异常。
 * · **不许记正文。** 只记 token 数、耗时、模型名。提示词和答复都不进这个文件 ——
 *   它可能被拷来拷去，而那两样是公司经营内容。检索式只留前 60 个字符，用来对上是哪一轮。
 * · **关着的时候零开销。** 第一句就是读环境变量，没配就直接返回。
 */

/** 换行。写成常量，免得这一段被生成脚本处理时要转义。 */
const LF = String.fromCharCode(10);

/** 量钱的口开着吗。开着时返回那个文件路径。 */
export const costTapPath = (): string => (process.env.TKOS_COST_TAP ?? "").trim();

/** 这一行算在哪一段上。跑到哪改到哪，不给就是空串。 */
export const costStage = (): string => (process.env.TKOS_COST_STAGE ?? "").trim();

/** 一次模型调用的账。字段名和 `Usage` 对齐，汇总脚本可以直接加。 */
export type ModelCostRow = {
  /** 哪一步（`a4.draft` 这样的 promptKey）。 */
  hint: string;
  slot: string | null;
  /** 注册表里的别名（`claude-opus-5`）。失败到没解析出模型时是空串。 */
  alias: string;
  /** 真正发出去的那个 model 字段（方舟上是 `ep-m-…` 接入点 id）。 */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  ms: number;
  ok: boolean;
  /** 没跑成时那句原话，截断。**只留错误信息，不留正文。** */
  error?: string;
};

/** 一次检索请求的账。检索按**次**收钱，而台账原来只记「入账几条证据」—— 那是两回事。 */
export type SearchCostRow = {
  provider: string;
  /** 检索式前 60 个字符，用来对上是哪一轮。全文不留。 */
  query: string;
  hits: number;
  ms: number;
  ok: boolean;
};

const append = async (row: Record<string, unknown>): Promise<void> => {
  const tap = costTapPath();
  if (!tap) return;
  try {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(tap, JSON.stringify({ stage: costStage(), ...row }) + LF, "utf8");
  } catch {
    /* 量钱的东西不许把正经链路弄挂。写不进去就算了。 */
  }
};

export const tapModelCall = (row: ModelCostRow): void => {
  if (!costTapPath()) return;
  void append({ kind: "model", ...row });
};

export const tapSearchCall = (row: SearchCostRow): void => {
  if (!costTapPath()) return;
  void append({ kind: "search", ...row, query: row.query.slice(0, 60) });
};
