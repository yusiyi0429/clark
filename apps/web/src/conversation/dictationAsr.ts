/**
 * 腾讯实时识别的消息解析，以及「出错了走哪条路」的决策表（调研 §1.2、§6）。纯函数，可单测。
 *
 * 返回格式：顶层 code / message / voice_id / final，result 里 slice_type（0 一句开始、1 识别中、2 一句定稿）/
 * index / start_time / end_time / voice_text_str。V2 文档另写了 sentences{sentence, sentence_type, sentence_id}，
 * 16k_zh_en_2.0 实测仍是 result 老格式；两种都认。
 */

export type AsrSlice = {
  /** 句子序号（这条连接内从 0 开始）。 */
  index: number;
  /** 0 一句开始，1 识别中（非稳态），2 一句定稿。 */
  type: 0 | 1 | 2;
  text: string;
  /** 这句在这条连接音频里的结束时间（毫秒）。 */
  endMs: number;
};

export type AsrMessage = {
  code: number;
  message: string;
  final: boolean;
  slice: AsrSlice | null;
};

function sliceType(value: unknown): 0 | 1 | 2 {
  const n = Number(value);
  return n === 2 ? 2 : n === 0 ? 0 : 1;
}

export function parseAsrMessage(raw: unknown): AsrMessage | null {
  if (typeof raw !== "string") return null;
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const code = Number(body.code ?? 0);
  const message = typeof body.message === "string" ? body.message : "";
  const final = Number(body.final ?? 0) === 1;
  let slice: AsrSlice | null = null;
  const result = body.result as Record<string, unknown> | undefined;
  if (result && typeof result === "object" && typeof result.voice_text_str === "string") {
    slice = { index: Number(result.index ?? 0), type: sliceType(result.slice_type), text: result.voice_text_str, endMs: Number(result.end_time ?? 0) };
  } else if (body.sentences) {
    const list = Array.isArray(body.sentences) ? body.sentences : [body.sentences];
    const last = list[list.length - 1] as Record<string, unknown> | undefined;
    if (last && typeof last.sentence === "string") {
      slice = { index: Number(last.sentence_id ?? 0), type: sliceType(last.sentence_type), text: last.sentence, endMs: Number(last.end_time ?? 0) };
    }
  }
  return { code: Number.isFinite(code) ? code : -1, message, final, slice };
}

export const NOTICE_UNAVAILABLE = "实时转写不可用，已改为说完再转";
export const NOTICE_QUOTA = "语音额度用完，已改为说完再转";
export const NOTICE_PROXY = "检测到境外网络代理，实时转写不可用，已改为说完再转";

export type FailureStage =
  /** 签发接口（POST /api/me/dictation/session）没给地址。 */
  | "session"
  /** 连上之前、或第一条消息就是错误。 */
  | "handshake"
  /** 握手成功之后。 */
  | "streaming";

export type FailureDecision = {
  /** reconnect：换新地址重连一次；fallback：这次改成「录完再转」（火山）。 */
  action: "reconnect" | "fallback";
  /** 提示一次的文案；null 不提示。 */
  notice: string | null;
  /** 本页后面几次听写直接走「录完再转」，不再试腾讯。 */
  disableRealtime: boolean;
};

/**
 * 决策表（调研 §6）：
 * - 签发接口 503（没配置）→ 后备，本页不再试；429 / 其他 → 后备这一次。
 * - 4004 / 4005（额度用完、欠费）→ 后备 + 额度提示，本页不再试。
 * - 6001（境外代理）→ 后备 + 代理提示。
 * - 4001 / 4002 / 4003 / 4006 等握手错误 → 后备这一次。
 * - 握手后断线、4009、5000–5002、4000、4008 → 重连一次；已经重连过 → 后备补出剩下那段。
 */
export function decideFailure({ stage, code, status, reconnected }: { stage: FailureStage; code?: number; status?: number; reconnected: boolean }): FailureDecision {
  if (stage === "session") {
    return { action: "fallback", notice: NOTICE_UNAVAILABLE, disableRealtime: status === 503 };
  }
  if (code === 4004 || code === 4005) return { action: "fallback", notice: NOTICE_QUOTA, disableRealtime: true };
  if (code === 6001) return { action: "fallback", notice: NOTICE_PROXY, disableRealtime: false };
  const transient = code === undefined || code >= 5000 || code === 4009 || code === 4000 || code === 4008;
  if (stage === "streaming" && transient && !reconnected) return { action: "reconnect", notice: null, disableRealtime: false };
  if (stage === "handshake" && code !== undefined && code >= 5000 && code < 6000 && !reconnected) {
    return { action: "reconnect", notice: null, disableRealtime: false };
  }
  return { action: "fallback", notice: NOTICE_UNAVAILABLE, disableRealtime: false };
}
