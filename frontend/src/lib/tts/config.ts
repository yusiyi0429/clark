/**
 * 音色、语速、厂商、端点 —— 全在 `demo/voice.json` 里，一行都不写死在代码里。
 *
 * 为什么这条要当硬规矩：试听是会前最后一件事，而它的产出就是两个值（选哪个音色、快多少）。
 * 如果这两个值住在代码里，改一次要动一次 diff、要重跑一次 lint、要重启一次；住在 JSON 里
 * 就是打开文件改两个字。会前十一点这个差别是决定性的。
 *
 * JSON 是 import 进来的，不是请求时 `fs.readFile` 的 —— 和 `demo/agenda.json` 一个路数。
 * `next dev` 会因为这个 import 把文件纳入监听，改完自己热更，不用重启。
 *
 * 环境变量只管两样东西：**key** 和**覆盖**。key 绝不进文件（文件是要提交的）；覆盖是留给
 * 会议室现场的 —— 万一 JSON 改坏了，`TTS_VOICE=longshu` 一个环境变量能把音色抢回来。
 */

import raw from "../../../demo/voice.json";

export type ProviderName = "cosyvoice" | "minimax";

export interface VoiceConfig {
  provider: ProviderName;
  endpoint: string;
  model: string;
  voice: string;
  speed: number;
  /** PCM 的采样率。前端 AudioContext 要用这个数去建 buffer，两边必须一致。 */
  sampleRate: number;
  volume: number;
  pitch: number;
  /** 第一段话攒到几个字就送去合成。 */
  firstClauseChars: number;
  /** 一段最长多少字。超了硬切 —— 厂商对单次输入有上限，而模型偶尔会写出一整段不带句号的话。 */
  maxSegmentChars: number;
  audition: { voices: string[]; speeds: number[] };
}

interface RawShape {
  provider?: string;
  cosyvoice?: Record<string, unknown>;
  minimax?: Record<string, unknown>;
  flush?: Record<string, unknown>;
  audition?: { voices?: unknown; speeds?: unknown };
}

const FILE = raw as RawShape;

/**
 * 这一场用的那一套值。
 *
 * 每次调用重新算，不缓存：dev 下热更之后 `FILE` 是新的，缓存住就得重启才生效 —— 正好把
 * 上面那条「改完不用重启」的好处抵消掉。这几个字段的解析成本可以忽略。
 */
export function voiceConfig(): VoiceConfig {
  const provider = pickProvider(process.env.TTS_PROVIDER ?? FILE.provider);
  const block = (provider === "minimax" ? FILE.minimax : FILE.cosyvoice) ?? {};
  const flush = FILE.flush ?? {};

  return {
    provider,
    endpoint: str(process.env.TTS_ENDPOINT) ?? str(block.endpoint) ?? DEFAULT_ENDPOINT[provider],
    model: str(process.env.TTS_MODEL) ?? str(block.model) ?? DEFAULT_MODEL[provider],
    voice: str(process.env.TTS_VOICE) ?? str(block.voice) ?? DEFAULT_VOICE[provider],
    speed: num(process.env.TTS_SPEED) ?? num(block.speed) ?? 1,
    sampleRate: num(block.sampleRate) ?? 22050,
    volume: num(block.volume) ?? 50,
    pitch: num(block.pitch) ?? 1,
    firstClauseChars: num(flush.firstClauseChars) ?? 14,
    maxSegmentChars: num(flush.maxSegmentChars) ?? 120,
    audition: {
      voices: strList(FILE.audition?.voices),
      speeds: numList(FILE.audition?.speeds),
    },
  };
}

/** 试听清单：音色 × 语速。空的就退回当前那一套，至少产出一个文件。 */
export function auditionMatrix(cfg: VoiceConfig): { voice: string; speed: number }[] {
  const voices = cfg.audition.voices.length ? cfg.audition.voices : [cfg.voice];
  const speeds = cfg.audition.speeds.length ? cfg.audition.speeds : [cfg.speed];
  return voices.flatMap((voice) => speeds.map((speed) => ({ voice, speed })));
}

const DEFAULT_ENDPOINT: Record<ProviderName, string> = {
  cosyvoice: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
  minimax: "https://api.minimax.chat/v1/t2a_v2",
};

const DEFAULT_MODEL: Record<ProviderName, string> = {
  cosyvoice: "cosyvoice-v1",
  minimax: "speech-01-turbo",
};

const DEFAULT_VOICE: Record<ProviderName, string> = {
  cosyvoice: "longcheng",
  minimax: "male-qn-jingying",
};

const pickProvider = (v: unknown): ProviderName => (v === "minimax" ? "minimax" : "cosyvoice");

const str = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
};

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter((s): s is string => Boolean(s)) : [];

const numList = (v: unknown): number[] =>
  Array.isArray(v) ? v.map(num).filter((n): n is number => typeof n === "number") : [];
