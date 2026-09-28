/**
 * 火山录音文件识别：映射（移植自概念版 volc-asr.test.ts）、提交/查询的请求形状与状态码、缺配消息。
 * 不走真实网络：fetch 被替换成记录请求的假实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsrRejected, mapResult, queryTask, recognizeFlash, submitTask } from "../src/volcAsr.js";
import { RecordingNotConfigured, assertRecordingConfigured, recordingConfigured, tosConfig, volcAsrConfig } from "../src/recordingConfig.js";

/** 文档里那段返回的形状。`us` 是要塞进 `result.utterances` 的那几条。 */
const doc = (us: unknown[]): unknown => ({
  audio_info: { duration: 6312 },
  result: { text: "刚刚还在想…", utterances: us },
});

const utt = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  additions: { channel_id: "1", speaker: "1" },
  start_time: 480,
  end_time: 5880,
  text: "刚刚还在想…",
  words: [{ confidence: 0, start_time: 480, end_time: 600, text: "刚" }],
  ...over,
});

describe("mapResult：正常的一条", () => {
  it("一条进一条出，每一格都落在对应的位置上", () => {
    const { utterances, speakers } = mapResult(doc([utt()]));
    expect(utterances).toEqual([{ idx: 0, speakerId: "1", startMs: 480, endMs: 5880, text: "刚刚还在想…" }]);
    expect(speakers).toEqual([{ speakerId: "1" }]);
  });

  it("正文两端的空格去掉，中间的留着", () => {
    const [u] = mapResult(doc([utt({ text: "  他说 这事 再看看  " })])).utterances;
    expect(u.text).toBe("他说 这事 再看看");
  });

  it("厂商多给的字段（words、channel_id、audio_info）不往下带", () => {
    const [u] = mapResult(doc([utt()])).utterances;
    expect(Object.keys(u).sort()).toEqual(["endMs", "idx", "speakerId", "startMs", "text"]);
  });
});

describe("mapResult：说话人", () => {
  it("多个说话人时，speakers 按第一次出现的顺序，不多不少", () => {
    const { speakers } = mapResult(
      doc([
        utt({ additions: { speaker: "2" } }),
        utt({ additions: { speaker: "1" } }),
        utt({ additions: { speaker: "2" } }),
        utt({ additions: { speaker: "3" } }),
        utt({ additions: { speaker: "1" } }),
      ]),
    );
    expect(speakers).toEqual([{ speakerId: "2" }, { speakerId: "1" }, { speakerId: "3" }]);
  });

  it("additions 整个不出现时退成 \"1\"，而且这句话仍然进结果", () => {
    const { utterances, speakers } = mapResult(doc([utt({ additions: undefined })]));
    expect(utterances).toHaveLength(1);
    expect(utterances[0].speakerId).toBe("1");
    expect(speakers).toEqual([{ speakerId: "1" }]);
  });

  it("additions 是 null、或者里面没有 speaker：一样退成 \"1\"，句子不丢", () => {
    const { utterances } = mapResult(doc([utt({ additions: null }), utt({ additions: { channel_id: "1" } }), utt({ additions: { speaker: "" } })]));
    expect(utterances.map((u) => u.speakerId)).toEqual(["1", "1", "1"]);
  });

  it("speaker 是数字 1 时也折成字符串 \"1\"，不跟 \"1\" 分成两个人", () => {
    const { utterances, speakers } = mapResult(doc([utt({ additions: { speaker: 1 } }), utt({ additions: { speaker: "1" } })]));
    expect(utterances.map((u) => u.speakerId)).toEqual(["1", "1"]);
    expect(speakers).toEqual([{ speakerId: "1" }]);
  });

  it("只有一部分句子取不到说话人：那几句单独归「未标注」，不许安到 1 号头上", () => {
    const { utterances, speakers } = mapResult(
      doc([
        utt({ text: "甲说的", additions: { speaker: "1" } }),
        utt({ text: "没人认领", additions: {} }),
        utt({ text: "乙说的", additions: { speaker: "2" } }),
      ]),
    );
    expect(utterances.map((u) => u.speakerId)).toEqual(["1", "?", "2"]);
    expect(speakers).toContainEqual({ speakerId: "?", displayName: "未标注" });
  });

  it("全都取不到说话人：整份退成一个人，每一句都还在", () => {
    const { utterances, speakers } = mapResult(doc([utt({ text: "第一句", additions: {} }), utt({ text: "第二句", additions: {} })]));
    expect(utterances.map((u) => u.speakerId)).toEqual(["1", "1"]);
    expect(speakers).toEqual([{ speakerId: "1" }]);
  });
});

describe("mapResult：时间戳", () => {
  it("缺 start_time / end_time 时退成 0，句子仍然进结果", () => {
    const { utterances } = mapResult(doc([utt({ start_time: undefined, end_time: undefined })]));
    expect([utterances[0].startMs, utterances[0].endMs]).toEqual([0, 0]);
  });

  it("不是数字（null、对象、NaN）时也退成 0，不写进 NaN", () => {
    const { utterances } = mapResult(doc([utt({ start_time: null, end_time: {} }), utt({ start_time: "abc", end_time: Number.NaN })]));
    expect(utterances.map((u) => [u.startMs, u.endMs])).toEqual([[0, 0], [0, 0]]);
  });

  it("字符串数字照收，小数四舍五入到整毫秒", () => {
    const [u] = mapResult(doc([utt({ start_time: "480", end_time: 5880.6 })])).utterances;
    expect([u.startMs, u.endMs]).toEqual([480, 5881]);
  });
});

describe("mapResult：空句子与 idx", () => {
  it("text 是空串或全空格的那条被跳过，跳过之后 idx 连着不留空号", () => {
    const { utterances } = mapResult(doc([utt({ text: "第一句" }), utt({ text: "  " }), utt({ text: "第二句" }), utt({ text: "" }), utt({ text: "第三句" })]));
    expect(utterances.map((u) => u.idx)).toEqual([0, 1, 2]);
    expect(utterances.map((u) => u.text)).toEqual(["第一句", "第二句", "第三句"]);
  });

  it("text 不是字符串（数字、null、缺）时同样跳过；只有空句子时说话人表也是空的", () => {
    expect(mapResult(doc([utt({ text: 123 }), utt({ text: null }), utt({ text: undefined })])).utterances).toEqual([]);
    expect(mapResult(doc([utt({ text: "" })])).speakers).toEqual([]);
  });

  it("按进入结果的次序重排，不照抄厂商下标", () => {
    const { utterances } = mapResult(doc([utt({ index: 7, text: "甲" }), utt({ index: 2, text: "乙" }), utt({ index: 99, text: "丙" })]));
    expect(utterances.map((u) => u.idx)).toEqual([0, 1, 2]);
  });
});

describe("mapResult：形状不对时", () => {
  it("result 缺失 / null / utterances 不是数组，以及 raw 本身是垃圾：都给空，不抛", () => {
    for (const raw of [
      { audio_info: { duration: 6312 } },
      { result: null },
      { result: {} },
      { result: { utterances: null } },
      { result: { utterances: "刚刚还在想…" } },
      { result: { utterances: {} } },
      null,
      undefined,
      "",
      "<html>502</html>",
      0,
      true,
      [],
    ]) {
      expect(mapResult(raw)).toEqual({ utterances: [], speakers: [] });
    }
  });

  it("utterances 里混进字符串、数字、布尔、空对象、null：跳过那几条，好的那条还在", () => {
    const { utterances } = mapResult(doc(["一句话", 42, true, {}, null, undefined, utt({ text: "真的那句" })]));
    expect(utterances).toEqual([{ idx: 0, speakerId: "1", startMs: 480, endMs: 5880, text: "真的那句" }]);
  });
});

/** 记录每次请求的假 fetch；按 URL 决定回什么。 */
type Reply = { status?: number; headers?: Record<string, string>; body?: unknown };
function stubFetch(reply: (url: string) => Reply) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = reply(url);
    const body = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(body, { status: r.status ?? 200, headers: r.headers });
  });
  return calls;
}

const ENV_KEYS = ["VOLC_ASR_API_KEY", "VOLC_ASR_APP_KEY", "VOLC_ASR_ACCESS_KEY", "VOLC_ASR_RESOURCE_ID", "TOS_ACCESS_KEY", "TOS_SECRET_KEY", "TOS_ENDPOINT", "TOS_REGION", "TOS_BUCKET"];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
});

const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

describe("submitTask / queryTask", () => {
  it("新版 API Key：X-Api-Key，提交与查询用同一个 resource id 和同一个任务 id", async () => {
    process.env.VOLC_ASR_API_KEY = "fake-api-key";
    process.env.VOLC_ASR_RESOURCE_ID = "volc.bigasr.auc";
    const calls = stubFetch((url) =>
      url.endsWith("/submit")
        ? { headers: { "X-Api-Status-Code": "20000000" } }
        : { headers: { "X-Api-Status-Code": "20000000" }, body: doc([utt({ text: "我确认这个方向。" })]) },
    );

    const taskId = await submitTask({ url: "https://tos.example/presigned", hotwords: ["渠道投入决策会", "测试甲"] });
    const result = await queryTask(taskId);

    expect(calls.map((c) => c.url)).toEqual([
      "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit",
      "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
    ]);
    for (const call of calls) {
      expect(headerOf(call.init, "X-Api-Key")).toBe("fake-api-key");
      expect(headerOf(call.init, "X-Api-App-Key")).toBeNull();
      expect(headerOf(call.init, "X-Api-Resource-Id")).toBe("volc.bigasr.auc");
      expect(headerOf(call.init, "X-Api-Request-Id")).toBe(taskId);
    }
    expect(headerOf(calls[0].init, "X-Api-Sequence")).toBe("-1");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.audio).toEqual({ url: "https://tos.example/presigned", format: "mp3", codec: "raw", rate: 16000, bits: 16, channel: 1 });
    expect(body.audio.language).toBeUndefined();
    expect(body.request).toMatchObject({ enable_speaker_info: true, show_utterances: true, ssd_version: "300", enable_punc: true, enable_itn: true });
    // 热词是序列化后的 JSON 字符串
    expect(JSON.parse(body.request.corpus.context)).toEqual({ hotwords: [{ word: "渠道投入决策会" }, { word: "测试甲" }] });
    expect(result).toMatchObject({ state: "done", utterances: [{ speakerId: "1", text: "我确认这个方向。" }] });
  });

  it("旧版一对凭据：X-Api-App-Key + X-Api-Access-Key；未配 resource id 时用默认的 2.0", async () => {
    process.env.VOLC_ASR_APP_KEY = "fake-app-id";
    process.env.VOLC_ASR_ACCESS_KEY = "fake-access-token";
    const calls = stubFetch(() => ({ headers: { "X-Api-Status-Code": "20000000" } }));

    await submitTask({ url: "https://tos.example/presigned" });

    expect(headerOf(calls[0].init, "X-Api-App-Key")).toBe("fake-app-id");
    expect(headerOf(calls[0].init, "X-Api-Access-Key")).toBe("fake-access-token");
    expect(headerOf(calls[0].init, "X-Api-Key")).toBeNull();
    expect(headerOf(calls[0].init, "X-Api-Resource-Id")).toBe("volc.seedasr.auc");
    expect(JSON.parse(String(calls[0].init.body)).request.corpus).toBeUndefined();
  });

  it("状态在响应头里、按字符串比较：20000001 / 20000002 是还在跑", async () => {
    process.env.VOLC_ASR_API_KEY = "fake-api-key";
    for (const code of ["20000001", "20000002"]) {
      stubFetch(() => ({ headers: { "X-Api-Status-Code": code } }));
      await expect(queryTask("task-1")).resolves.toEqual({ state: "running" });
    }
  });

  it("20000003 没有人声、45 开头的码不给重试（AsrRejected），都带原码与 logid", async () => {
    process.env.VOLC_ASR_API_KEY = "fake-api-key";
    stubFetch(() => ({ headers: { "X-Api-Status-Code": "20000003" } }));
    await expect(queryTask("task-1")).rejects.toThrow(/没有检测到人声/);

    stubFetch(() => ({ headers: { "X-Api-Status-Code": "45000151", "X-Tt-Logid": "log-123", "X-Api-Message": "unsupported format" } }));
    const err = await queryTask("task-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AsrRejected);
    expect((err as AsrRejected).code).toBe("45000151");
    expect((err as Error).message).toContain("格式厂商不认");
    expect((err as Error).message).toContain("45000151 · log-123");
  });

  it("550 开头是服务端的事：普通 Error，不是 AsrRejected", async () => {
    process.env.VOLC_ASR_API_KEY = "fake-api-key";
    stubFetch(() => ({ headers: { "X-Api-Status-Code": "55000031" } }));
    const err = await submitTask({ url: "https://tos.example/presigned" }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(AsrRejected);
    expect((err as Error).message).toContain("服务繁忙");
  });

  it("状态说成功但一句话都没有：是失败，不是一份空逐字稿", async () => {
    process.env.VOLC_ASR_API_KEY = "fake-api-key";
    stubFetch(() => ({ headers: { "X-Api-Status-Code": "20000000" }, body: doc([]) }));
    await expect(queryTask("task-1")).rejects.toBeInstanceOf(AsrRejected);
  });
});

describe("缺配消息", () => {
  it("语音识别缺配：两条路都说出来，且不发请求", async () => {
    const calls = stubFetch(() => ({}));
    const err = await submitTask({ url: "https://tos.example/presigned" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecordingNotConfigured);
    expect((err as Error).message).toContain("VOLC_ASR_API_KEY");
    expect((err as Error).message).toContain("VOLC_ASR_APP_KEY");
    expect(calls).toHaveLength(0);
  });

  it("对象存储缺配：只点名缺的变量，不带任何已配的值", () => {
    process.env.TOS_ACCESS_KEY = "fake-ak-value";
    process.env.TOS_SECRET_KEY = "fake-sk-value";
    process.env.TOS_ENDPOINT = "tos-cn-beijing.volces.com";
    const err = (() => {
      try {
        tosConfig();
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(RecordingNotConfigured);
    expect(err!.message).toContain("TOS_REGION");
    expect(err!.message).toContain("TOS_BUCKET");
    expect(err!.message).not.toContain("TOS_ACCESS_KEY");
    expect(err!.message).not.toContain("fake-ak-value");
    expect(err!.message).not.toContain("fake-sk-value");
  });

  it("recordingConfigured 不抛，只回两个布尔；assertRecordingConfigured 先查 TOS", () => {
    expect(recordingConfigured()).toEqual({ tos: false, asr: false });
    expect(() => assertRecordingConfigured()).toThrow(/对象存储还没配全/);
    process.env.VOLC_ASR_API_KEY = "  ";
    expect(() => volcAsrConfig()).toThrow(RecordingNotConfigured);
    for (const key of ["TOS_ACCESS_KEY", "TOS_SECRET_KEY", "TOS_ENDPOINT", "TOS_REGION", "TOS_BUCKET"]) process.env[key] = "x";
    process.env.VOLC_ASR_API_KEY = "fake-api-key";
    expect(recordingConfigured()).toEqual({ tos: true, asr: true });
    expect(() => assertRecordingConfigured()).not.toThrow();
  });
});

describe("recognizeFlash（极速版）", () => {
  it("一次请求：极速版地址、和会议录音同一个资源 id、音频 base64 放 body、回 result.text", async () => {
    process.env.VOLC_ASR_API_KEY = "fake-api-key";
    process.env.VOLC_ASR_RESOURCE_ID = "volc.seedasr.auc";
    const calls = stubFetch(() => ({ headers: { "X-Api-Status-Code": "20000000" }, body: { audio_info: { duration: 2499 }, result: { text: " 关闭透传。 " } } }));

    expect(await recognizeFlash(Buffer.from("mp3 bytes"))).toBe("关闭透传。");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash");
    expect(headerOf(calls[0].init, "X-Api-Key")).toBe("fake-api-key");
    expect(headerOf(calls[0].init, "X-Api-Resource-Id")).toBe("volc.seedasr.auc");
    expect(headerOf(calls[0].init, "X-Api-Sequence")).toBe("-1");
    expect(headerOf(calls[0].init, "X-Api-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
    const body = JSON.parse(String(calls[0].init.body));
    expect(Buffer.from(body.audio.data, "base64").toString()).toBe("mp3 bytes");
    expect(body.request).toMatchObject({ model_name: "bigmodel", enable_punc: true, enable_itn: true });
  });

  it("静音回空串；45 开头判掉是 AsrRejected", async () => {
    process.env.VOLC_ASR_API_KEY = "fake-api-key";
    stubFetch(() => ({ headers: { "X-Api-Status-Code": "20000003" } }));
    expect(await recognizeFlash(Buffer.from("x"))).toBe("");
    stubFetch(() => ({ status: 400, headers: { "X-Api-Status-Code": "45000151", "X-Tt-Logid": "log-1" } }));
    const err = await recognizeFlash(Buffer.from("x")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AsrRejected);
    expect((err as Error).message).toContain("45000151 · log-1");
  });
});
