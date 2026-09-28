/**
 * 输入框语音转文字（/api/me/dictation）。ffmpeg 与火山全用假实现，不走网络。
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { DictationResult } from "@warmap/contracts";
import { createTestApp, type TestApp } from "./helpers.js";
import { RecordingNotConfigured } from "../src/recordingConfig.js";
import { AsrRejected } from "../src/volcAsr.js";
import type { DictationDeps } from "../src/dictation.js";

function fakeDictation(over: Partial<DictationDeps> = {}) {
  const log = { uploads: [] as string[], recognized: [] as string[], dirs: [] as string[] };
  const deps: DictationDeps = {
    requireConfig: () => {},
    async toMp3(inputPath, outputPath) {
      log.uploads.push((await readFile(inputPath)).toString("utf8"));
      log.dirs.push(dirname(inputPath));
      await writeFile(outputPath, "mp3 bytes");
      return outputPath;
    },
    async recognize(mp3) {
      log.recognized.push(mp3.toString("utf8"));
      return "下周一前把渠道预算定下来。";
    },
    ...over,
  };
  return { deps, log };
}

function multipart(audio?: { body: string; field?: string }) {
  const boundary = "----dictation-test";
  const chunks: Buffer[] = [];
  if (audio) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${audio.field ?? "audio"}"; filename="dictation.webm"\r\nContent-Type: audio/webm\r\n\r\n`));
    chunks.push(Buffer.from(audio.body), Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, payload: Buffer.concat(chunks) };
}

const dictate = (t: TestApp, cookie: string | undefined, form = multipart({ body: "webm bytes" })) =>
  t.app.inject({
    method: "POST",
    url: "/api/me/dictation",
    headers: { ...(cookie ? { cookie } : {}), origin: t.publicOrigin, "content-type": form.contentType },
    payload: form.payload,
  });

describe("输入框语音转文字", () => {
  it("CEO 和成员都能用：录音转 mp3 送识别，回文字，临时文件不留", async () => {
    const { deps, log } = fakeDictation();
    const t = await createTestApp({}, undefined, { dictationDeps: deps });
    try {
      for (const cookie of [await t.loginCookie(), await t.memberCookie()]) {
        const res = await dictate(t, cookie);
        expect(res.statusCode).toBe(200);
        expect(Value.Check(DictationResult, res.json())).toBe(true);
        expect(res.json()).toEqual({ text: "下周一前把渠道预算定下来。" });
      }
      expect(log.uploads).toEqual(["webm bytes", "webm bytes"]);
      expect(log.recognized).toEqual(["mp3 bytes", "mp3 bytes"]);
      expect(log.dirs.some((dir) => existsSync(dir))).toBe(false);
    } finally {
      await t.close();
    }
  });

  it("没登录 401；没带录音 400，不调识别", async () => {
    const { deps, log } = fakeDictation();
    const t = await createTestApp({}, undefined, { dictationDeps: deps });
    try {
      expect((await dictate(t, undefined)).statusCode).toBe(401);
      const res = await dictate(t, await t.memberCookie(), multipart());
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("DICTATION_AUDIO_REQUIRED");
      expect(log.recognized).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("缺配 503 并说清缺哪个变量；厂商判掉 400、别的失败 502，都带原因", async () => {
    const cases: [Partial<DictationDeps>, number, string][] = [
      [{ requireConfig: () => { throw new RecordingNotConfigured("语音识别还没配，配 VOLC_ASR_API_KEY"); } }, 503, "DICTATION_NOT_CONFIGURED"],
      [{ recognize: async () => { throw new AsrRejected("这份音频的格式厂商不认", "45000151"); } }, 400, "DICTATION_REJECTED"],
      [{ recognize: async () => { throw new Error("socket hang up"); } }, 502, "DICTATION_PROVIDER_FAILED"],
    ];
    for (const [over, status, code] of cases) {
      const { deps } = fakeDictation(over);
      const t = await createTestApp({}, undefined, { dictationDeps: deps });
      try {
        const res = await dictate(t, await t.memberCookie());
        expect(res.statusCode).toBe(status);
        expect(res.json().code).toBe(code);
        expect(res.json().message).toBeTruthy();
      } finally {
        await t.close();
      }
    }
  });
});
