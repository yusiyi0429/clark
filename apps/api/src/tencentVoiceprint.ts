/**
 * 腾讯云语音识别的「说话人验证」接口（asr 2019-06-14，asr.tencentcloudapi.com，官方 Node SDK，TC3-HMAC-SHA256 签名由 SDK 做）：
 * VoicePrintEnroll 注册 / VoicePrintUpdate 更新 / VoicePrintDelete 删除 / VoicePrintGroupVerify 1:N。
 *
 * 文档里写着、容易踩的几件事：
 * - 音频只收 PCM(VoiceFormat=0) 或 WAV(1)，16 bit、单声道，采样率只认 16000；单段不超过 30 秒、数据不超过 2 MB；
 *   有效人声不到 1 秒报 InvalidParameterValue.NoHumanVoice。
 * - 分组只能在注册时指定（VoicePrintEnroll.GroupId，仅字母和下划线）；更新接口不带分组，也没有「加入分组」接口。
 *   一个分组最多 20 个声纹，一个 AppID 最多 10000 个。
 * - 1:N 返回按分数降序的 TopN，分数是 0–100 的字符串；文档建议 70 分以上认为是同一个人。
 *
 * 凭据全部服务端读取，不打印、不下发，也不打印长度。
 */
import { asr } from "tencentcloud-sdk-nodejs-asr";

/** 缺配。消息写明缺哪个变量（不含值）。 */
export class VoiceprintNotConfigured extends Error {}
/** 腾讯那边没有这个声纹（已经删过，或在控制台里被删了）。 */
export class VoiceprintMissing extends Error {}
/** 腾讯拒绝了这次调用；code 是它的错误码，如 InvalidParameterValue.NoHumanVoice。 */
export class VoiceprintProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export const DEFAULT_TENCENT_ASR_REGION = "ap-shanghai";
export const DEFAULT_VOICEPRINT_GROUP = "tianshu";
const GROUP_ID = /^[A-Za-z_]{1,128}$/;
/** VoiceFormat：0 = pcm。转码那一步固定出 16 kHz 单声道 s16le（见 recordingMedia.toVoiceprintPcm）。 */
const PCM = 0;
const SAMPLE_RATE = 16000;

const env = (name: string): string | undefined => {
  const value = process.env[name];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
};

export type TencentVoiceprintConfig = { secretId: string; secretKey: string; region: string; groupId: string };

export function tencentVoiceprintConfig(): TencentVoiceprintConfig {
  const secretId = env("TENCENTCLOUD_SECRET_ID");
  const secretKey = env("TENCENTCLOUD_SECRET_KEY");
  if (!secretId || !secretKey) {
    const missing = [secretId ? null : "TENCENTCLOUD_SECRET_ID", secretKey ? null : "TENCENTCLOUD_SECRET_KEY"].filter(Boolean);
    throw new VoiceprintNotConfigured(`声纹识别还没配，缺 ${missing.join("、")}（腾讯云访问密钥，填在服务器配置里）。`);
  }
  const groupId = env("TENCENT_VOICEPRINT_GROUP") ?? DEFAULT_VOICEPRINT_GROUP;
  if (!GROUP_ID.test(groupId)) {
    throw new VoiceprintNotConfigured("TENCENT_VOICEPRINT_GROUP 只能由英文字母和下划线组成、不超过 128 个字符（腾讯云声纹分组的要求）。");
  }
  return { secretId, secretKey, region: env("TENCENT_ASR_REGION") ?? DEFAULT_TENCENT_ASR_REGION, groupId };
}

/** health 与 GET /api/me/voiceprint 要问 —— 问的时候不许抛。 */
export function voiceprintConfigured(): boolean {
  try {
    tencentVoiceprintConfig();
    return true;
  } catch {
    return false;
  }
}

/** 本模块用到的 SDK 方法；测试注入假实现，不走网络。 */
export type AsrVoiceprintClient = Pick<
  InstanceType<typeof asr.v20190614.Client>,
  "VoicePrintEnroll" | "VoicePrintUpdate" | "VoicePrintDelete" | "VoicePrintGroupVerify"
>;

const sdkClient = (cfg: TencentVoiceprintConfig): AsrVoiceprintClient =>
  new asr.v20190614.Client({
    credential: { secretId: cfg.secretId, secretKey: cfg.secretKey },
    region: cfg.region,
    profile: { httpProfile: { reqTimeout: 30 } },
  });

export type VoiceprintScore = { voicePrintId: string; score: number };

export type TencentVoiceprintApi = {
  enroll(input: { pcm: Buffer; groupId: string }): Promise<string>;
  update(input: { voicePrintId: string; pcm: Buffer }): Promise<void>;
  /** 幂等：腾讯那边已经没有这个声纹时照样算删掉了。 */
  remove(voicePrintId: string): Promise<void>;
  groupVerify(input: { pcm: Buffer; groupId: string; topN: number }): Promise<VoiceprintScore[]>;
};

/** 每次调用现读配置、现建客户端：改了凭据不用重启。 */
export function createTencentVoiceprintApi(client: (cfg: TencentVoiceprintConfig) => AsrVoiceprintClient = sdkClient): TencentVoiceprintApi {
  async function call<T>(fn: (c: AsrVoiceprintClient) => Promise<T>): Promise<T> {
    const c = client(tencentVoiceprintConfig());
    try {
      return await fn(c);
    } catch (err) {
      throw providerError(err);
    }
  }
  return {
    async enroll({ pcm, groupId }) {
      const res = await call((c) => c.VoicePrintEnroll({ VoiceFormat: PCM, SampleRate: SAMPLE_RATE, Data: pcm.toString("base64"), GroupId: groupId }));
      const id = res.Data?.VoicePrintId;
      if (!id) throw new VoiceprintProviderError("腾讯云说话人注册没有返回声纹 id。", "EmptyVoicePrintId");
      return id;
    },
    async update({ voicePrintId, pcm }) {
      await call((c) => c.VoicePrintUpdate({ VoiceFormat: PCM, SampleRate: SAMPLE_RATE, VoicePrintId: voicePrintId, Data: pcm.toString("base64") }));
    },
    async remove(voicePrintId) {
      try {
        // DelMod 0：删掉这条声纹本身（1 只移出分组、2 只删分组信息）
        await call((c) => c.VoicePrintDelete({ VoicePrintId: voicePrintId, DelMod: 0 }));
      } catch (err) {
        if (!(err instanceof VoiceprintMissing)) throw err;
      }
    },
    async groupVerify({ pcm, groupId, topN }) {
      const res = await call((c) => c.VoicePrintGroupVerify({ VoiceFormat: PCM, SampleRate: SAMPLE_RATE, Data: pcm.toString("base64"), GroupId: groupId, TopN: topN }));
      return (res.Data?.VerifyTops ?? [])
        .flatMap((top) => {
          // Score 是字符串且可能为 null；Number(null) 是 0，不能当成一个分数
          const score = typeof top.Score === "string" && top.Score.trim() ? Number(top.Score) : Number.NaN;
          return top.VoicePrintId && Number.isFinite(score) ? [{ voicePrintId: top.VoicePrintId, score }] : [];
        })
        .sort((a, b) => b.score - a.score);
    },
  };
}

/** SDK 把接口错误码放在 err.code（Response.Error.Code）。 */
function providerError(err: unknown): Error {
  const code = (err as { code?: unknown } | null)?.code;
  const said = err instanceof Error ? err.message : String(err);
  if (code === "FailedOperation.NotExistentVoicePrintId") return new VoiceprintMissing(said);
  if (typeof code === "string" && code) return new VoiceprintProviderError(`腾讯云声纹接口报错（${code}）：${said}`.slice(0, 500), code);
  return err instanceof Error ? err : new Error(said);
}
