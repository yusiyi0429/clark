/**
 * 腾讯实时语音识别：URL 签名（排序、编码、expired）与签发接口 POST /api/me/dictation/session。
 * 全部用假密钥，一次网络都不走；签名值是用假密钥离线算好的回归值。
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { DictationSessionResponse } from "@warmap/contracts";
import { createTestApp, type TestApp } from "./helpers.js";
import {
  createSessionRateLimiter,
  DEFAULT_TENCENT_ASR_ENGINE,
  RealtimeAsrNotConfigured,
  realtimeAsrConfigured,
  signRealtimeAsrUrl,
  tencentAsrRealtimeConfig,
  type RealtimeSessionDeps,
  type TencentAsrRealtimeConfig,
} from "../src/tencentAsrRealtime.js";

const FAKE: TencentAsrRealtimeConfig = {
  secretId: "AKIDfakeSecretId0001",
  secretKey: "fake-secret-key-for-tests",
  appId: "1250000000",
  engine: "16k_zh_en_2.0",
};
const FIXED = { nowMs: 1_760_000_000_000, nonce: 1002, voiceId: "c0ffee00-0000-4000-8000-000000000001" };
const SIGNED_QUERY =
  "convert_num_mode=1&engine_model_type=16k_zh_en_2.0&expired=1760000030&filter_modal=0&needvad=1&nonce=1002&secretid=AKIDfakeSecretId0001&timestamp=1760000000&voice_format=1&voice_id=c0ffee00-0000-4000-8000-000000000001";
/** HMAC-SHA1(FAKE.secretKey, "asr.cloud.tencent.com/asr/v2/1250000000?" + SIGNED_QUERY) 的 Base64；同时含 + / =。 */
const SIGNATURE = "K+VZzcipkHlm3jsdm/PSqszFI/g=";

describe("实时识别 URL 签名", () => {
  it("固定密钥 / 时间 / nonce / voice_id 得到固定签名（回归）", () => {
    const signed = signRealtimeAsrUrl(FAKE, FIXED);
    // 回归值本身也按文档规则独立复算一遍：排好序的串（不带 wss://）做 HMAC-SHA1 再 Base64
    expect(createHmac("sha1", FAKE.secretKey).update(`asr.cloud.tencent.com/asr/v2/1250000000?${SIGNED_QUERY}`).digest("base64")).toBe(SIGNATURE);
    expect(signed.url).toBe(`wss://asr.cloud.tencent.com/asr/v2/1250000000?${SIGNED_QUERY}&signature=${encodeURIComponent(SIGNATURE)}`);
    expect(signed.voiceId).toBe(FIXED.voiceId);
    expect(signed.engine).toBe("16k_zh_en_2.0");
  });

  it("参数按字典序；签名里的 + / = 都编码，签名放最后", () => {
    const { url } = signRealtimeAsrUrl(FAKE, FIXED);
    const query = url.slice(url.indexOf("?") + 1);
    const keys = query.split("&").map((kv) => kv.split("=")[0]);
    expect(keys.at(-1)).toBe("signature");
    expect(keys.slice(0, -1)).toEqual([...keys.slice(0, -1)].sort());
    const signature = query.split("&").at(-1)!.slice("signature=".length);
    expect(signature).toBe("K%2BVZzcipkHlm3jsdm%2FPSqszFI%2Fg%3D");
    expect(signature).not.toMatch(/[+/=]/);
    expect(decodeURIComponent(signature)).toBe(SIGNATURE);
  });

  it("expired = 现在 + 30 秒；timestamp 取整秒；带上固定的识别参数", () => {
    const signed = signRealtimeAsrUrl(FAKE, { ...FIXED, nowMs: 1_760_000_000_999 });
    const params = new URL(signed.url.replace(/^wss:/, "https:")).searchParams;
    expect(params.get("timestamp")).toBe("1760000000");
    expect(params.get("expired")).toBe("1760000030");
    expect(signed.expiresAt).toBe(new Date(1_760_000_030_000).toISOString());
    expect(Object.fromEntries(["voice_format", "needvad", "filter_modal", "convert_num_mode"].map((k) => [k, params.get(k)]))).toEqual({
      voice_format: "1", needvad: "1", filter_modal: "0", convert_num_mode: "1",
    });
    expect(params.get("secretid")).toBe(FAKE.secretId);
    expect(signed.url).not.toContain(FAKE.secretKey);
  });

  it("nonce 不超过 10 位；每次签发都换新的 voice_id", () => {
    const urls = Array.from({ length: 20 }, () => signRealtimeAsrUrl(FAKE, { nowMs: FIXED.nowMs }));
    for (const { url } of urls) {
      const nonce = new URL(url.replace(/^wss:/, "https:")).searchParams.get("nonce")!;
      expect(nonce).toMatch(/^[1-9]\d{0,9}$/);
    }
    const voiceIds = new Set(urls.map((u) => u.voiceId));
    expect(voiceIds.size).toBe(urls.length);
    for (const id of voiceIds) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("实时识别配置", () => {
  const env = (over: Record<string, string | undefined>) => ({
    TENCENTCLOUD_SECRET_ID: "fake-id", TENCENTCLOUD_SECRET_KEY: "fake-key", TENCENT_ASR_APP_ID: "1250000000", ...over,
  });

  it("引擎读 TENCENT_ASR_ENGINE，缺省 16k_zh_en_2.0；值两边的空白去掉", () => {
    expect(DEFAULT_TENCENT_ASR_ENGINE).toBe("16k_zh_en_2.0");
    expect(tencentAsrRealtimeConfig(env({})).engine).toBe("16k_zh_en_2.0");
    expect(tencentAsrRealtimeConfig(env({ TENCENT_ASR_ENGINE: " 16k_zh_en " })).engine).toBe("16k_zh_en");
    expect(tencentAsrRealtimeConfig(env({ TENCENT_ASR_APP_ID: " 1250000000 " })).appId).toBe("1250000000");
  });

  it("缺哪个变量就说缺哪个，不带值；AppID 只认数字、引擎只认安全字符", () => {
    expect(() => tencentAsrRealtimeConfig(env({ TENCENT_ASR_APP_ID: undefined, TENCENTCLOUD_SECRET_KEY: "" }))).toThrow(RealtimeAsrNotConfigured);
    try {
      tencentAsrRealtimeConfig(env({ TENCENT_ASR_APP_ID: undefined, TENCENTCLOUD_SECRET_KEY: "" }));
    } catch (err) {
      expect((err as Error).message).toContain("TENCENTCLOUD_SECRET_KEY");
      expect((err as Error).message).toContain("TENCENT_ASR_APP_ID");
      expect((err as Error).message).not.toContain("fake-id");
    }
    expect(() => tencentAsrRealtimeConfig(env({ TENCENT_ASR_APP_ID: "12/../x" }))).toThrow(RealtimeAsrNotConfigured);
    expect(() => tencentAsrRealtimeConfig(env({ TENCENT_ASR_ENGINE: "16k&needvad=0" }))).toThrow(RealtimeAsrNotConfigured);
    expect(realtimeAsrConfigured(env({}))).toBe(true);
    expect(realtimeAsrConfigured(env({ TENCENTCLOUD_SECRET_ID: undefined }))).toBe(false);
  });
});

describe("签发频率", () => {
  it("每人每分钟最多 6 次，按人分开计；窗口滑过去就恢复，告诉还要等几秒", () => {
    const limiter = createSessionRateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) expect(limiter.take("a", t0 + i * 1000)).toEqual({ ok: true });
    expect(limiter.take("a", t0 + 10_000)).toEqual({ ok: false, retryAfterSeconds: 50 });
    expect(limiter.take("b", t0 + 10_000)).toEqual({ ok: true });
    expect(limiter.take("a", t0 + 60_000)).toEqual({ ok: true });
    expect(limiter.take("a", t0 + 60_500)).toEqual({ ok: false, retryAfterSeconds: 1 });
  });
});

const ENV_KEYS = ["TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY", "TENCENT_ASR_APP_ID", "TENCENT_ASR_ENGINE"];

describe("POST /api/me/dictation/session", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.restoreAllMocks();
  });

  const useFakeEnv = (engine?: string) => {
    process.env.TENCENTCLOUD_SECRET_ID = FAKE.secretId;
    process.env.TENCENTCLOUD_SECRET_KEY = FAKE.secretKey;
    process.env.TENCENT_ASR_APP_ID = FAKE.appId;
    if (engine) process.env.TENCENT_ASR_ENGINE = engine;
  };
  const issue = (t: TestApp, cookie?: string) =>
    t.app.inject({ method: "POST", url: "/api/me/dictation/session", headers: { ...(cookie ? { cookie } : {}), origin: t.publicOrigin } });

  it("没登录 401，不签名", async () => {
    useFakeEnv();
    const t = await createTestApp();
    try {
      const res = await issue(t);
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain("wss://");
    } finally {
      await t.close();
    }
  });

  it("缺配置 503 DICTATION_REALTIME_NOT_CONFIGURED，说清缺哪个变量", async () => {
    const t = await createTestApp();
    try {
      const res = await issue(t, await t.memberCookie());
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("DICTATION_REALTIME_NOT_CONFIGURED");
      expect(res.json().message).toContain("TENCENT_ASR_APP_ID");
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally {
      await t.close();
    }
  });

  it("签好 URL：形状对、no-store、引擎读环境变量；响应和日志里都没有 SecretKey，日志里没有 URL 和签名", async () => {
    useFakeEnv("16k_zh_en_speaker_2.0");
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write);
    vi.spyOn(console, "log").mockImplementation((...args) => void written.push(args.map(String).join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => void written.push(args.map(String).join(" ")));
    const t = await createTestApp();
    try {
      for (const cookie of [await t.loginCookie(), await t.memberCookie()]) {
        const before = Date.now();
        const res = await issue(t, cookie);
        expect(res.statusCode).toBe(200);
        expect(res.headers["cache-control"]).toBe("no-store");
        const body = res.json();
        expect(Value.Check(DictationSessionResponse, body)).toBe(true);
        expect(body).toMatchObject({ engine: "16k_zh_en_speaker_2.0", sampleRate: 16000, frameMs: 200 });
        expect(body.url).toMatch(/^wss:\/\/asr\.cloud\.tencent\.com\/asr\/v2\/1250000000\?/);
        expect(body.url).toContain("engine_model_type=16k_zh_en_speaker_2.0");
        expect(body.url).toContain(`voice_id=${body.voiceId}`);
        const expires = Date.parse(body.expiresAt);
        expect(expires - before).toBeGreaterThanOrEqual(28_000);
        expect(expires - before).toBeLessThanOrEqual(31_000);
        expect(res.body).not.toContain(FAKE.secretKey);
        const signature = new URL(body.url.replace(/^wss:/, "https:")).searchParams.get("signature")!;
        expect(written.join("\n")).not.toContain(signature);
        expect(written.join("\n")).not.toContain(encodeURIComponent(signature));
      }
      const logs = written.join("\n");
      expect(logs).toContain("/api/me/dictation/session");
      expect(logs).not.toContain(FAKE.secretKey);
      expect(logs).not.toContain("wss://");
      expect(logs).not.toContain("signature=");
    } finally {
      await t.close();
    }
  });

  it("同一个人一分钟内第 7 次 429，带 Retry-After；另一个人不受影响", async () => {
    useFakeEnv();
    let nowMs = 1_760_000_000_000;
    const deps: Partial<RealtimeSessionDeps> = { nowMs: () => nowMs };
    const t = await createTestApp({}, undefined, { dictationRealtimeDeps: deps });
    try {
      const member = await t.memberCookie();
      for (let i = 0; i < 6; i++) {
        nowMs += 1000;
        expect((await issue(t, member)).statusCode).toBe(200);
      }
      const limited = await issue(t, member);
      expect(limited.statusCode).toBe(429);
      expect(limited.json().code).toBe("DICTATION_SESSION_RATE_LIMITED");
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect(limited.headers["cache-control"]).toBe("no-store");
      expect(limited.body).not.toContain("wss://");
      expect((await issue(t, await t.loginCookie())).statusCode).toBe(200);
      nowMs += 60_000;
      expect((await issue(t, member)).statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });
});
