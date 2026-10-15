/**
 * 腾讯云实时语音识别（WebSocket，asr.cloud.tencent.com/asr/v2/<appid>）的签名与签发。
 *
 * 方案：服务端用 SecretKey 签好一个短时 wss 地址，浏览器拿着它直连腾讯（调研 §3 方案 a）。
 * - 签名：除 signature 外的参数按字典序拼成 `asr.cloud.tencent.com/asr/v2/<appid>?k=v&…`（不带 wss://），
 *   HMAC-SHA1(SecretKey) → Base64 → URL 编码（+ / = 都要编码，否则偶发 4002），拼在最后。
 * - expired = 现在 + 30 秒：签名只在握手时校验，只需盖住握手；同一 URL 在有效期内能重复连，所以窗口越短越好。
 * - nonce ≤ 10 位；voice_id 每次新生成 UUID。
 *
 * 凭据和 TENCENT_ASR_REGION / TENCENT_VOICEPRINT_GROUP 一样与声纹（tencentVoiceprint.ts）共用 TENCENTCLOUD_SECRET_*。
 * 签好的 URL 与签名不打印、不进日志；配置缺失只说缺哪个变量，不带值。
 */
import { createHmac, randomInt, randomUUID } from "node:crypto";

export const DEFAULT_TENCENT_ASR_ENGINE = "16k_zh_en_2.0";
const HOST = "asr.cloud.tencent.com";
/** 签名有效期（秒）：盖住握手即可。 */
export const REALTIME_URL_TTL_SECONDS = 30;
export const REALTIME_SAMPLE_RATE = 16000 as const;
/** 浏览器每 200ms 发一包（6400 字节 PCM16）。 */
export const REALTIME_FRAME_MS = 200 as const;
/**
 * 固定的识别参数：pcm；人声切分（超过 60 秒的语音必须开）；不过滤语气词（整理交给模型）；数字转阿拉伯数字。
 */
const RECOGNITION_PARAMS = { voice_format: 1, needvad: 1, filter_modal: 0, convert_num_mode: 1 } as const;

const APP_ID = /^\d{1,20}$/;
const ENGINE = /^[A-Za-z0-9_.-]{1,64}$/;

/** 缺配或配错。消息写明是哪个变量（不含值）。 */
export class RealtimeAsrNotConfigured extends Error {}

export type TencentAsrRealtimeConfig = { secretId: string; secretKey: string; appId: string; engine: string };

type Env = Record<string, string | undefined>;
const read = (env: Env, name: string): string | undefined => {
  const value = env[name];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
};

/** 每次调用现读：改了配置不用重启。 */
export function tencentAsrRealtimeConfig(env: Env = process.env): TencentAsrRealtimeConfig {
  const secretId = read(env, "TENCENTCLOUD_SECRET_ID");
  const secretKey = read(env, "TENCENTCLOUD_SECRET_KEY");
  const appId = read(env, "TENCENT_ASR_APP_ID");
  if (!secretId || !secretKey || !appId) {
    const missing = [
      secretId ? null : "TENCENTCLOUD_SECRET_ID",
      secretKey ? null : "TENCENTCLOUD_SECRET_KEY",
      appId ? null : "TENCENT_ASR_APP_ID",
    ].filter(Boolean);
    throw new RealtimeAsrNotConfigured(`实时语音识别还没配，缺 ${missing.join("、")}（腾讯云访问密钥与语音识别 AppID，填在服务器配置里）。`);
  }
  if (!APP_ID.test(appId)) throw new RealtimeAsrNotConfigured("TENCENT_ASR_APP_ID 只能是数字（腾讯云账号的 AppID）。");
  const engine = read(env, "TENCENT_ASR_ENGINE") ?? DEFAULT_TENCENT_ASR_ENGINE;
  if (!ENGINE.test(engine)) throw new RealtimeAsrNotConfigured("TENCENT_ASR_ENGINE 只能由字母、数字和 _ . - 组成（腾讯云引擎名，如 16k_zh_en_2.0）。");
  return { secretId, secretKey, appId, engine };
}

/** health / 前端判断用：问的时候不许抛。 */
export function realtimeAsrConfigured(env: Env = process.env): boolean {
  try {
    tencentAsrRealtimeConfig(env);
    return true;
  } catch {
    return false;
  }
}

export type SignedRealtimeUrl = { url: string; voiceId: string; engine: string; expiresAt: string };

/** nonce：1–9 位正整数，满足「最长 10 位」。 */
const randomNonce = (): number => randomInt(1, 1_000_000_000);

/** 签一个实时识别地址。nonce / voiceId 不给就随机生成（测试固定它们来做回归）。 */
export function signRealtimeAsrUrl(
  cfg: TencentAsrRealtimeConfig,
  at: { nowMs: number; nonce?: number; voiceId?: string },
): SignedRealtimeUrl {
  const timestamp = Math.floor(at.nowMs / 1000);
  const expired = timestamp + REALTIME_URL_TTL_SECONDS;
  const voiceId = at.voiceId ?? randomUUID();
  const params: Record<string, string | number> = {
    ...RECOGNITION_PARAMS,
    secretid: cfg.secretId,
    timestamp,
    expired,
    nonce: at.nonce ?? randomNonce(),
    engine_model_type: cfg.engine,
    voice_id: voiceId,
  };
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(String(params[key]))}`)
    .join("&");
  const path = `${HOST}/asr/v2/${cfg.appId}`;
  const signature = createHmac("sha1", cfg.secretKey).update(`${path}?${query}`).digest("base64");
  // encodeURIComponent 会把 + / = 都编码成 %2B %2F %3D
  return { url: `wss://${path}?${query}&signature=${encodeURIComponent(signature)}`, voiceId, engine: cfg.engine, expiresAt: new Date(expired * 1000).toISOString() };
}

/** 签发接口的外部依赖：配置与时钟（真实时间，不是业务时钟：腾讯按真实时间校验 timestamp / expired）。测试注入假实现。 */
export type RealtimeSessionDeps = {
  /** 缺配时抛 RealtimeAsrNotConfigured。 */
  readConfig(): TencentAsrRealtimeConfig;
  nowMs(): number;
};

export const realRealtimeSessionDeps: RealtimeSessionDeps = {
  readConfig: () => tencentAsrRealtimeConfig(),
  nowMs: () => Date.now(),
};

export const SESSION_RATE_LIMIT = { max: 6, windowMs: 60_000 } as const;

/**
 * 每人每分钟最多签 6 次（滑动窗口，进程内计数；单进程 MVP 够用，多实例时换共享存储）。
 * 被拒的那次不计数。
 */
export function createSessionRateLimiter({ max, windowMs }: { max: number; windowMs: number } = SESSION_RATE_LIMIT) {
  const hits = new Map<string, number[]>();
  return {
    take(key: string, nowMs: number): { ok: true } | { ok: false; retryAfterSeconds: number } {
      const recent = (hits.get(key) ?? []).filter((at) => at > nowMs - windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + windowMs - nowMs) / 1000)) };
      }
      recent.push(nowMs);
      hits.set(key, recent);
      return { ok: true };
    },
  };
}

export type SessionRateLimiter = ReturnType<typeof createSessionRateLimiter>;

export type RealtimeSessionResult =
  | { ok: true; value: SignedRealtimeUrl & { sampleRate: typeof REALTIME_SAMPLE_RATE; frameMs: typeof REALTIME_FRAME_MS } }
  | { ok: false; status: 429 | 503; code: string; message: string; retryAfterSeconds?: number };

/** 签发一次：先看配置（缺配时前端立即退回录完再转，不占次数），再限流，最后签名。 */
export function issueRealtimeSession(deps: RealtimeSessionDeps, limiter: SessionRateLimiter, personId: string): RealtimeSessionResult {
  let cfg: TencentAsrRealtimeConfig;
  try {
    cfg = deps.readConfig();
  } catch (err) {
    if (err instanceof RealtimeAsrNotConfigured) return { ok: false, status: 503, code: "DICTATION_REALTIME_NOT_CONFIGURED", message: err.message };
    throw err;
  }
  const nowMs = deps.nowMs();
  const taken = limiter.take(personId, nowMs);
  if (!taken.ok) {
    return { ok: false, status: 429, code: "DICTATION_SESSION_RATE_LIMITED", message: `实时听写开得太频繁了，${taken.retryAfterSeconds} 秒后再试`, retryAfterSeconds: taken.retryAfterSeconds };
  }
  return { ok: true, value: { ...signRealtimeAsrUrl(cfg, { nowMs }), sampleRate: REALTIME_SAMPLE_RATE, frameMs: REALTIME_FRAME_MS } };
}
