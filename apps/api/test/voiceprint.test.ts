/**
 * 本人声纹录入 / 删除（/api/me/voiceprint）。ffmpeg 与腾讯云全用假实现，不走网络。
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { VoiceprintStatus } from "@warmap/contracts";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";
import { tencentVoiceprintConfig, VoiceprintMissing, VoiceprintProviderError } from "../src/tencentVoiceprint.js";
import type { VoiceprintDeps } from "../src/voiceprints.js";

const PCM_PER_SECOND = 32_000;

function fakeVoiceprint(over: Partial<VoiceprintDeps> & { seconds?: number } = {}) {
  const { seconds = 20, ...rest } = over;
  const log = {
    conversions: [] as { input: string; inputBytes: string; opts: unknown }[],
    enrolls: [] as { pcmBytes: number; groupId: string }[],
    updates: [] as { voicePrintId: string; pcmBytes: number }[],
    removes: [] as string[],
  };
  let next = 0;
  const deps: VoiceprintDeps = {
    configured: () => true,
    requireConfig: () => ({ groupId: "tianshu" }),
    async toPcm(inputPath, outputPath, opts) {
      log.conversions.push({ input: inputPath, inputBytes: (await readFile(inputPath)).toString("utf8"), opts });
      await writeFile(outputPath, Buffer.alloc(seconds * PCM_PER_SECOND));
    },
    async enroll({ pcm, groupId }) {
      log.enrolls.push({ pcmBytes: pcm.length, groupId });
      return `vp-${++next}`;
    },
    async update({ voicePrintId, pcm }) {
      log.updates.push({ voicePrintId, pcmBytes: pcm.length });
    },
    async remove(voicePrintId) {
      log.removes.push(voicePrintId);
    },
    async groupVerify() {
      return [];
    },
    ...rest,
  };
  return { deps, log };
}

function multipart(fields: Record<string, string>, audio?: { body: string; name?: string; field?: string }) {
  const boundary = "----voiceprint-test";
  const chunks: Buffer[] = [];
  if (audio) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${audio.field ?? "audio"}"; filename="${audio.name ?? "voiceprint.webm"}"\r\nContent-Type: audio/webm\r\n\r\n`));
    chunks.push(Buffer.from(audio.body), Buffer.from("\r\n"));
  }
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, payload: Buffer.concat(chunks) };
}

const enroll = (t: TestApp, cookie: string, form: ReturnType<typeof multipart>) =>
  t.app.inject({ method: "POST", url: "/api/me/voiceprint", headers: { cookie, origin: t.publicOrigin, "content-type": form.contentType }, payload: form.payload });
const status = async (t: TestApp, cookie: string) => (await t.app.inject({ method: "GET", url: "/api/me/voiceprint", headers: { cookie } })).json();
const remove = (t: TestApp, cookie: string) => t.app.inject({ method: "DELETE", url: "/api/me/voiceprint", headers: { cookie, origin: t.publicOrigin } });
const rows = (t: TestApp) => t.sql("SELECT person_id, provider_voiceprint_id, group_id, consented_at, updated_at FROM person_voiceprints ORDER BY person_id");

describe("本人声纹", () => {
  it("requires explicit consent before touching the audio", async () => {
    const { deps, log } = fakeVoiceprint();
    const t = await createTestApp({}, undefined, { voiceprintDeps: deps });
    try {
      const cookie = await t.memberCookie();
      for (const fields of [{}, { consent: "false" }]) {
        const res = await enroll(t, cookie, multipart(fields, { body: "webm bytes" }));
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("VOICEPRINT_CONSENT_REQUIRED");
      }
      expect(log.conversions).toEqual([]);
      expect(log.enrolls).toEqual([]);
      expect(await rows(t)).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("converts the upload to 16 kHz PCM (≤ 30 s), enrolls into the configured group, stores consent and keeps no audio", async () => {
    const { deps, log } = fakeVoiceprint({ seconds: 30 });
    const t = await createTestApp({}, undefined, { voiceprintDeps: deps });
    try {
      const cookie = await t.memberCookie();
      expect(await status(t, cookie)).toEqual({ enrolled: false, updatedAt: null, configured: true });

      const res = await enroll(t, cookie, multipart({ consent: "true" }, { body: "webm bytes" }));
      expect(res.statusCode).toBe(200);
      expect(Value.Check(VoiceprintStatus, res.json())).toBe(true);
      expect(res.json()).toEqual({ enrolled: true, updatedAt: expect.any(String), configured: true });
      expect(log.conversions).toHaveLength(1);
      expect(log.conversions[0]).toMatchObject({ inputBytes: "webm bytes", opts: { maxSeconds: 30 } });
      expect(log.enrolls).toEqual([{ pcmBytes: 30 * PCM_PER_SECOND, groupId: "tianshu" }]);
      // 上传和转码产物所在的临时目录已删
      expect(existsSync(dirname(log.conversions[0].input))).toBe(false);
      const [row] = await rows(t);
      expect(row).toMatchObject({ person_id: TEST_MEMBER.personId, provider_voiceprint_id: "vp-1", group_id: "tianshu" });
      expect(row.consented_at).toBeInstanceOf(Date);
      expect(await status(t, cookie)).toEqual(res.json());

      // CEO 同样只能录自己的
      const ceo = await t.loginCookie();
      expect(await status(t, ceo)).toEqual({ enrolled: false, updatedAt: null, configured: true });
      expect((await enroll(t, ceo, multipart({ consent: "true" }, { body: "ceo webm" }))).statusCode).toBe(200);
      expect((await rows(t)).map((r) => r.person_id)).toEqual([TEST_CEO.personId, TEST_MEMBER.personId]);
    } finally {
      await t.close();
    }
  });

  it("re-enrolling updates the same voiceprint and upserts the row; a changed group is deleted and re-enrolled", async () => {
    const { deps, log } = fakeVoiceprint();
    const t = await createTestApp({}, undefined, { voiceprintDeps: deps });
    try {
      const cookie = await t.memberCookie();
      await enroll(t, cookie, multipart({ consent: "true" }, { body: "first" }));
      const [first] = await rows(t);
      await t.sql("UPDATE person_voiceprints SET updated_at = updated_at - interval '1 day', consented_at = consented_at - interval '1 day'");

      const again = await enroll(t, cookie, multipart({ consent: "true" }, { body: "second" }));
      expect(again.statusCode).toBe(200);
      expect(log.enrolls).toHaveLength(1);
      expect(log.updates).toEqual([{ voicePrintId: "vp-1", pcmBytes: 20 * PCM_PER_SECOND }]);
      const [second] = await rows(t);
      expect(second.provider_voiceprint_id).toBe("vp-1");
      expect((second.updated_at as Date).getTime()).toBeGreaterThanOrEqual((first.updated_at as Date).getTime());
      expect((second.consented_at as Date).getTime()).toBeGreaterThanOrEqual((first.consented_at as Date).getTime());

      // 控制台里被删掉了：更新报不存在 → 重新注册
      deps.update = async () => {
        throw new VoiceprintMissing("不存在的说话人id");
      };
      await enroll(t, cookie, multipart({ consent: "true" }, { body: "third" }));
      expect((await rows(t))[0].provider_voiceprint_id).toBe("vp-2");

      // 换了声纹组：更新接口不带分组，只能删掉旧的再注册进新组
      deps.requireConfig = () => ({ groupId: "tianshu_next" });
      await enroll(t, cookie, multipart({ consent: "true" }, { body: "fourth" }));
      expect(log.removes).toEqual(["vp-2"]);
      expect(log.enrolls.at(-1)).toEqual({ pcmBytes: 20 * PCM_PER_SECOND, groupId: "tianshu_next" });
      expect(await rows(t)).toEqual([expect.objectContaining({ provider_voiceprint_id: "vp-3", group_id: "tianshu_next" })]);
    } finally {
      await t.close();
    }
  });

  it("rejects recordings that are too short or silent with a Chinese message and stores nothing", async () => {
    const { deps, log } = fakeVoiceprint({ seconds: 6 });
    const t = await createTestApp({}, undefined, { voiceprintDeps: deps });
    try {
      const cookie = await t.memberCookie();
      const short = await enroll(t, cookie, multipart({ consent: "true" }, { body: "short" }));
      expect(short.statusCode).toBe(400);
      expect(short.json()).toMatchObject({ code: "VOICEPRINT_TOO_SHORT", message: expect.stringContaining("至少需要 10 秒") });
      expect(log.enrolls).toEqual([]);

      const noAudio = await enroll(t, cookie, multipart({ consent: "true" }));
      expect(noAudio.json().code).toBe("VOICEPRINT_AUDIO_REQUIRED");

      deps.toPcm = async (_input, output) => writeFile(output, Buffer.alloc(20 * PCM_PER_SECOND));
      deps.enroll = async () => {
        throw new VoiceprintProviderError("腾讯云声纹接口报错（InvalidParameterValue.NoHumanVoice）：音频内容没有人声", "InvalidParameterValue.NoHumanVoice");
      };
      const silent = await enroll(t, cookie, multipart({ consent: "true" }, { body: "silence" }));
      expect(silent.statusCode).toBe(400);
      expect(silent.json()).toMatchObject({ code: "VOICEPRINT_NO_VOICE", message: expect.stringContaining("没听到清楚的人声") });
      expect(await rows(t)).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("deletes at Tencent and then the row; deleting again is a no-op 204", async () => {
    const { deps, log } = fakeVoiceprint();
    const t = await createTestApp({}, undefined, { voiceprintDeps: deps });
    try {
      const cookie = await t.memberCookie();
      expect((await remove(t, cookie)).statusCode).toBe(204);
      expect(log.removes).toEqual([]);
      await enroll(t, cookie, multipart({ consent: "true" }, { body: "webm" }));
      const first = await remove(t, cookie);
      expect(first.statusCode).toBe(204);
      expect(log.removes).toEqual(["vp-1"]);
      expect(await rows(t)).toEqual([]);
      expect((await remove(t, cookie)).statusCode).toBe(204);
      expect(log.removes).toEqual(["vp-1"]);
      expect(await status(t, cookie)).toEqual({ enrolled: false, updatedAt: null, configured: true });
    } finally {
      await t.close();
    }
  });

  it("not configured: enrolling is 503 naming the missing variables, GET says configured=false, health reports it", async () => {
    const keys = ["TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY"];
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    const { deps, log } = fakeVoiceprint({ configured: () => false, requireConfig: () => ({ groupId: tencentVoiceprintConfig().groupId }) });
    const t = await createTestApp({}, undefined, { voiceprintDeps: deps });
    try {
      const cookie = await t.memberCookie();
      const res = await enroll(t, cookie, multipart({ consent: "true" }, { body: "webm" }));
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "VOICEPRINT_NOT_CONFIGURED", message: expect.stringContaining("TENCENTCLOUD_SECRET_ID、TENCENTCLOUD_SECRET_KEY") });
      expect(log.conversions).toEqual([]);
      expect(await status(t, cookie)).toEqual({ enrolled: false, updatedAt: null, configured: false });

      // 有声纹却没凭据时不删行：否则腾讯那边留下一条没人管的声纹
      await t.sql("INSERT INTO person_voiceprints (person_id, provider_voiceprint_id, group_id, consented_at) VALUES ($1, 'vp-old', 'tianshu', now())", [TEST_MEMBER.personId]);
      expect((await remove(t, cookie)).statusCode).toBe(503);
      expect(await rows(t)).toHaveLength(1);

      const health = await t.app.inject({ method: "GET", url: "/healthz" });
      expect(health.json().dependencies.voiceprint).toBe(false);
      expect((await t.app.inject({ method: "GET", url: "/api/me/voiceprint" })).statusCode).toBe(401);
    } finally {
      await t.close();
      for (const key of keys) if (saved[key] !== undefined) process.env[key] = saved[key];
    }
  });

  it("health reports voiceprint=true when the credentials are configured", async () => {
    const { deps } = fakeVoiceprint();
    const t = await createTestApp({}, undefined, { voiceprintDeps: deps });
    try {
      expect((await t.app.inject({ method: "GET", url: "/healthz" })).json().dependencies.voiceprint).toBe(true);
    } finally {
      await t.close();
    }
  });
});
