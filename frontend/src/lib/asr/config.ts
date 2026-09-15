/**
 * 听那一层的配置。和播报层一样：全在 `demo/voice.json` 里，一行都不写死在代码里。
 *
 * 这一层的配置比播报层更需要留在文件里，因为它有两个数**必须在会议室现场调**：
 *
 * - `voiceRms` —— 多大的声音算「他在说话」。这个阈值取决于房间多大、麦克风离他多远、
 *   空调多响。在我这台机器上调好的值，搬到那个会议室很可能就不对了。
 * - `bargeInRms` —— 参谋正在念的时候，多大的声音才算抢话。它必须比上面那个高：投影音箱
 *   的声音会被麦克风收回来，阈值低了参谋就会被自己的声音打断，一句话都念不完。
 *
 * 改完不用重启：路由每次请求重读（`next dev` 会因为这个 import 监听文件）。
 */

import raw from "../../../demo/voice.json";

export type ListenProviderName = "paraformer";

export interface ListenConfig {
  provider: ListenProviderName;
  endpoint: string;
  model: string;
  /** PCM 采样率。前端建 `AudioContext` 用同一个数，两边必须一致。 */
  sampleRate: number;
  /** 静了多久算一句说完。厂商 VAD 和前端那个保险定时器都用它。 */
  silenceMs: number;
  /**
   * 前端那个保险定时器比厂商多等多久。
   *
   * 厂商先来 —— 它切句比本地的能量检测准。这个宽限期是留给它的：只有它到点还没报
   * `sentence_end`，本地才自己把这句提交上去。设成 0 等于两边抢，抢赢的经常是本地那个
   * 更笨的判断。
   */
  graceMs: number;
  /** 多大的声音算他在说话。0–1 的 RMS。 */
  voiceRms: number;
  /** 参谋正在念的时候，多大的声音算抢话。必须比 `voiceRms` 高，见文件头。 */
  bargeInRms: number;
  /** 连续多久超过阈值才算真的在说话。挡的是咳嗽、翻纸、椅子响。 */
  voiceHoldMs: number;
  /** 抢话要连续多久。比 `voiceHoldMs` 长一点 —— 抢话的代价是把参谋掐断，不能误判。 */
  bargeInHoldMs: number;
  /**
   * 往前多留一点音频。
   *
   * 判断「他开口了」必然滞后于他真的开口（要连续 `voiceHoldMs` 才算），所以第一个字总是
   * 已经过去了。前端留一个环形缓冲，触发的时候把之前这些毫秒的音频一起补发出去，否则厂商
   * 收到的第一句永远缺一个字头 —— 「们这个月」。
   */
  preRollMs: number;
  /** 一块音频攒到多少毫秒就发一次。越小越及时，越大越省请求。 */
  chunkMs: number;
  /** 服务端这条厂商连接空转多久就先关掉，省额度。下一块音频到了会自己重开。 */
  idleMs: number;
}

interface RawShape {
  listen?: Record<string, unknown>;
}

const FILE = raw as RawShape;

export function listenConfig(): ListenConfig {
  const block = FILE.listen ?? {};
  return {
    provider: "paraformer",
    endpoint:
      str(process.env.ASR_ENDPOINT) ??
      str(block.endpoint) ??
      "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    model: str(process.env.ASR_MODEL) ?? str(block.model) ?? "paraformer-realtime-v2",
    sampleRate: num(block.sampleRate) ?? 16000,
    silenceMs: num(block.silenceMs) ?? 700,
    graceMs: num(block.graceMs) ?? 600,
    voiceRms: num(block.voiceRms) ?? 0.02,
    bargeInRms: num(block.bargeInRms) ?? 0.06,
    voiceHoldMs: num(block.voiceHoldMs) ?? 160,
    bargeInHoldMs: num(block.bargeInHoldMs) ?? 320,
    preRollMs: num(block.preRollMs) ?? 400,
    chunkMs: num(block.chunkMs) ?? 120,
    idleMs: num(block.idleMs) ?? 8000,
  };
}

/**
 * 前端要知道的那几个数。
 *
 * 单独挑出来是因为它是**下发到浏览器**的那一份 —— 端点和模型名没必要给前端知道，
 * 而门槛、静音时长、分块大小是前端自己在算的。这个类型就是那条边界。
 */
export type ClientListenConfig = Pick<
  ListenConfig,
  | "sampleRate"
  | "silenceMs"
  | "graceMs"
  | "voiceRms"
  | "bargeInRms"
  | "voiceHoldMs"
  | "bargeInHoldMs"
  | "preRollMs"
  | "chunkMs"
>;

export function clientListenConfig(cfg: ListenConfig): ClientListenConfig {
  return {
    sampleRate: cfg.sampleRate,
    silenceMs: cfg.silenceMs,
    graceMs: cfg.graceMs,
    voiceRms: cfg.voiceRms,
    bargeInRms: cfg.bargeInRms,
    voiceHoldMs: cfg.voiceHoldMs,
    bargeInHoldMs: cfg.bargeInHoldMs,
    preRollMs: cfg.preRollMs,
    chunkMs: cfg.chunkMs,
  };
}

const str = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
};

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
