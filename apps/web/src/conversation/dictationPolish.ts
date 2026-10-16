/**
 * 听写文字的整理请求（POST /api/me/dictation/polish，服务端调方舟小模型；见选型报告 §5 与 `.superpowers/sdd/dictation-polish-v4.md`）。
 *
 * 两档（像微信输入法）：
 * - sentence（逐句）：说话过程中每定稿一句就在后台整理这一句，好了原地替换（快、不分点）。
 * - full（整段）：停下后把这次听写插入的全部内容再整理一次（含列举分点），替换成最终结果。
 *
 * - 本地预判（与 apps/api/src/dictationPolish.ts 的 needsPolish / needsFullPolish 同一套）：已经干净的不送，省一次往返。
 * - 接口总是 200，失败返回原文（polished:false）；这里再加一层超时（服务端超时 + 网络余量），超时也当原文，不报错。
 */

export type PolishMode = "sentence" | "full";

const FILLER = /嗯|呃|啊|额|哦|唉|诶|那个|就是/;
const CORRECTION = /不对|说错|我是说|不是|哦不|应该是/;
const REPEAT = /(\p{Script=Han}{2,6})[，,、]?\1/u;
const SENTENCE_END = /[。！？!?…]$/;
/** 列举的口头序号（「第三季度」这类不算）。 */
const LIST_CUE = /第[一二三四五六七八九十][个点条件是，,、：:]|[一二三四五]是|首先|其次|最后/;
/** 服务端超过 2000 字回 413：太长的不送。 */
const MAX_POLISH_CHARS = 2000;

export function needsPolish(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > MAX_POLISH_CHARS) return false;
  return FILLER.test(t) || CORRECTION.test(t) || REPEAT.test(t) || !SENTENCE_END.test(t);
}

/** 整段：逐句的预判之外，有列举词或三句以上（可能要分点）也送。 */
export function needsFullPolish(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > MAX_POLISH_CHARS) return false;
  return needsPolish(t) || LIST_CUE.test(t) || (t.match(/[。！？!?；;]/g)?.length ?? 0) >= 3;
}

/** 服务端逐句的硬超时（DICTATION_POLISH_TIMEOUT_MS 缺省）。 */
const SERVER_SENTENCE_TIMEOUT_MS = 1200;
/** 网络余量。 */
const NETWORK_MARGIN_MS = 400;
/** 单句整理请求的超时：服务端 1.2 秒 + 余量。 */
export const POLISH_REQUEST_TIMEOUT_MS = SERVER_SENTENCE_TIMEOUT_MS + NETWORK_MARGIN_MS;
/** 按 ↑ 之后、只剩逐句整理时最多再等多久（选型报告 §5 第 4 层）：超时就发原文，迟到的结果丢掉。 */
export const SEND_POLISH_DEADLINE_MS = 1200;

/** 整段整理的超时：与服务端同一条公式（1200ms + 每 100 字 400ms，封顶 4 秒）再加网络余量。 */
export function fullPolishTimeoutMs(text: string): number {
  return Math.min(4000, SERVER_SENTENCE_TIMEOUT_MS + Math.round(Array.from(text).length * 4)) + NETWORK_MARGIN_MS;
}

export type PolishJob = {
  text: string;
  mode: PolishMode;
  /** 整理后的文字；没送、失败、超时都是原文。 */
  result: Promise<string>;
  /** 已经有结果（同步可读）。 */
  done: boolean;
  value: string | null;
  abort: () => void;
};

type Timers = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

export function startPolish(text: string, fetcher: typeof fetch, timers: Timers = globalThis, mode: PolishMode = "sentence"): PolishJob {
  const job: PolishJob = { text, mode, result: Promise.resolve(text), done: false, value: null, abort: () => {} };
  const settle = (value: string) => {
    job.done = true;
    job.value = value;
    return value;
  };
  if (!(mode === "full" ? needsFullPolish(text) : needsPolish(text))) {
    settle(text);
    return job;
  }
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveEarly: (value: string) => void = () => {};
  job.abort = () => {
    controller?.abort();
    resolveEarly(text);
  };
  const timeout = new Promise<string>((resolve) => {
    resolveEarly = resolve;
    timer = timers.setTimeout(() => {
      controller?.abort();
      resolve(text);
    }, mode === "full" ? fullPolishTimeoutMs(text) : POLISH_REQUEST_TIMEOUT_MS);
  });
  const request = fetcher("/api/me/dictation/polish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mode === "full" ? { text, mode } : { text }),
    signal: controller?.signal,
  })
    .then(async (response) => {
      if (!response.ok) return text;
      const body = (await response.json().catch(() => null)) as { text?: unknown; polished?: unknown } | null;
      return body?.polished === true && typeof body.text === "string" && body.text.trim() ? body.text : text;
    })
    .catch(() => text);
  job.result = Promise.race([request, timeout]).then((value) => {
    if (timer !== undefined) timers.clearTimeout(timer);
    return settle(value);
  });
  return job;
}
