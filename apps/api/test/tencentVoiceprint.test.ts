/**
 * 腾讯云说话人验证适配层：请求形状（PCM / 16000 / base64 / 分组）、分数解析、错误码分类、配置。
 * SDK 客户端换成假实现，一次网络都不走。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTencentVoiceprintApi,
  tencentVoiceprintConfig,
  voiceprintConfigured,
  VoiceprintMissing,
  VoiceprintNotConfigured,
  VoiceprintProviderError,
  type AsrVoiceprintClient,
  type TencentVoiceprintConfig,
} from "../src/tencentVoiceprint.js";

const KEYS = ["TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY", "TENCENT_ASR_REGION", "TENCENT_VOICEPRINT_GROUP"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  process.env.TENCENTCLOUD_SECRET_ID = "fake-id";
  process.env.TENCENTCLOUD_SECRET_KEY = "fake-key";
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const sdkError = (code: string, message: string) => Object.assign(new Error(message), { code, requestId: "req-1" });

function fakeClient(impl: Partial<Record<keyof AsrVoiceprintClient, (req: never) => Promise<unknown>>>) {
  const calls: { method: string; req: Record<string, unknown> }[] = [];
  const configs: TencentVoiceprintConfig[] = [];
  const client = (cfg: TencentVoiceprintConfig) => {
    configs.push(cfg);
    const method = (name: keyof AsrVoiceprintClient) => async (req: Record<string, unknown>) => {
      calls.push({ method: name, req });
      return impl[name] ? impl[name]!(req as never) : {};
    };
    return {
      VoicePrintEnroll: method("VoicePrintEnroll"),
      VoicePrintUpdate: method("VoicePrintUpdate"),
      VoicePrintDelete: method("VoicePrintDelete"),
      VoicePrintGroupVerify: method("VoicePrintGroupVerify"),
    } as unknown as AsrVoiceprintClient;
  };
  return { client, calls, configs };
}

describe("腾讯云声纹请求形状", () => {
  it("sends 16 kHz PCM as base64 with the group on enroll and verify, and reads scores as numbers, highest first", async () => {
    const { client, calls, configs } = fakeClient({
      VoicePrintEnroll: async () => ({ Data: { VoicePrintId: "vp-new", SpeakerNick: null }, RequestId: "r" }),
      VoicePrintGroupVerify: async () => ({
        Data: { VerifyTops: [{ Score: "71.5", VoicePrintId: "vp-b", SpeakerId: "" }, { Score: "88.0", VoicePrintId: "vp-a", SpeakerId: "" }, { Score: null, VoicePrintId: "vp-c" }] },
      }),
    });
    const api = createTencentVoiceprintApi(client);
    const pcm = Buffer.from("pcm-bytes");

    expect(await api.enroll({ pcm, groupId: "tianshu" })).toBe("vp-new");
    await api.update({ voicePrintId: "vp-new", pcm });
    expect(await api.groupVerify({ pcm, groupId: "tianshu", topN: 1 })).toEqual([
      { voicePrintId: "vp-a", score: 88 },
      { voicePrintId: "vp-b", score: 71.5 },
    ]);

    const data = pcm.toString("base64");
    expect(calls).toEqual([
      { method: "VoicePrintEnroll", req: { VoiceFormat: 0, SampleRate: 16000, Data: data, GroupId: "tianshu" } },
      { method: "VoicePrintUpdate", req: { VoiceFormat: 0, SampleRate: 16000, VoicePrintId: "vp-new", Data: data } },
      { method: "VoicePrintGroupVerify", req: { VoiceFormat: 0, SampleRate: 16000, Data: data, GroupId: "tianshu", TopN: 1 } },
    ]);
    expect(configs[0]).toEqual({ secretId: "fake-id", secretKey: "fake-key", region: "ap-shanghai", groupId: "tianshu" });
  });

  it("delete removes the voiceprint itself (DelMod 0) and treats an already-missing voiceprint as deleted", async () => {
    let missing = false;
    const { client, calls } = fakeClient({
      VoicePrintDelete: async () => {
        if (missing) throw sdkError("FailedOperation.NotExistentVoicePrintId", "不存在的说话人id");
        return { Data: { VoicePrintId: "vp-1" } };
      },
    });
    const api = createTencentVoiceprintApi(client);
    await api.remove("vp-1");
    missing = true;
    await expect(api.remove("vp-1")).resolves.toBeUndefined();
    expect(calls.map((c) => c.req)).toEqual([{ VoicePrintId: "vp-1", DelMod: 0 }, { VoicePrintId: "vp-1", DelMod: 0 }]);
  });

  it("classifies vendor error codes: missing voiceprint on update, everything else keeps its code", async () => {
    const { client } = fakeClient({
      VoicePrintUpdate: async () => {
        throw sdkError("FailedOperation.NotExistentVoicePrintId", "不存在的说话人id");
      },
      VoicePrintEnroll: async () => {
        throw sdkError("InvalidParameterValue.NoHumanVoice", "音频内容没有人声或有效人声小于1秒");
      },
    });
    const api = createTencentVoiceprintApi(client);
    await expect(api.update({ voicePrintId: "vp-x", pcm: Buffer.from("a") })).rejects.toBeInstanceOf(VoiceprintMissing);
    const err = await api.enroll({ pcm: Buffer.from("a"), groupId: "tianshu" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceprintProviderError);
    expect((err as VoiceprintProviderError).code).toBe("InvalidParameterValue.NoHumanVoice");
    expect((err as Error).message).toContain("InvalidParameterValue.NoHumanVoice");
  });
});

describe("腾讯云声纹配置", () => {
  it("names the missing variables without echoing any value", () => {
    delete process.env.TENCENTCLOUD_SECRET_KEY;
    expect(voiceprintConfigured()).toBe(false);
    const err = (() => {
      try {
        tencentVoiceprintConfig();
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(VoiceprintNotConfigured);
    expect(err!.message).toContain("TENCENTCLOUD_SECRET_KEY");
    expect(err!.message).not.toContain("TENCENTCLOUD_SECRET_ID");
    expect(err!.message).not.toContain("fake-id");
  });

  it("reads region and group overrides and rejects a group id Tencent would refuse", () => {
    process.env.TENCENT_ASR_REGION = "ap-guangzhou";
    process.env.TENCENT_VOICEPRINT_GROUP = "tianshu_team";
    expect(tencentVoiceprintConfig()).toMatchObject({ region: "ap-guangzhou", groupId: "tianshu_team" });
    expect(voiceprintConfigured()).toBe(true);
    process.env.TENCENT_VOICEPRINT_GROUP = "tianshu-2026";
    expect(() => tencentVoiceprintConfig()).toThrow(VoiceprintNotConfigured);
    expect(voiceprintConfigured()).toBe(false);
  });
});
