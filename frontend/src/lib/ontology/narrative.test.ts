/**
 * 本体叙述客户端的离线用例。
 *
 * 这一批喂的是我照实测回包造的帧，所以它证明的是「**如果**回包长成那样，这段代码接得住」。
 * 真回包长什么样由 `narrative.live.test.ts` 那一次真调用去答 —— 两件事不要合并到一个文件里，
 * 合并之后离线那批就得跟着被 `TKOS_ONTOLOGY_LIVE` 一起跳过，而它们本来每次都该跑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OntologyUnavailable } from "./errors";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return { ...actual, request: requestMock };
});

const { NarrativeClient, narrativeSettings } = await import("./narrative");

const KEYS = [
  "TKOS_MEMORY_API_BASE_URL",
  "TKOS_MEMORY_API_KEY",
  "TKOS_MEMORY_API_TENANT",
  "TKOS_MEMORY_API_ORG",
  "TKOS_ONTOLOGY_TIMEOUT_MS",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  requestMock.mockReset();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** 一份长得像真回包的帧。字段名照上游的下划线写法，不照前端的驼峰。 */
const frame = (over: Record<string, unknown> = {}) => ({
  query: "本期要达成什么",
  tenant: "local",
  org: "local-org",
  hit_paths: 2,
  lateral_nodes: 0,
  root_statement: "公司经营愿景是……",
  narrative: "压缩过的那一段。",
  narrative_raw_chars: 1851,
  narrative_chars: 762,
  compression_ratio: 0.41,
  model: "deepseek-v4-flash-ga-260731",
  ...over,
});

const reply = (body: unknown, statusCode = 200) => ({
  statusCode,
  body: { text: async () => (typeof body === "string" ? body : JSON.stringify(body)) },
});

const configured = () => {
  process.env.TKOS_MEMORY_API_BASE_URL = "https://memory.test";
  process.env.TKOS_MEMORY_API_KEY = "k";
};

describe("narrativeSettings", () => {
  it("什么都没配时给出空地址空 key，且不抛 —— 一个解析失败会让每条路由都 500", () => {
    const s = narrativeSettings();
    expect(s.baseUrl).toBe("");
    expect(s.apiKey).toBe("");
    expect(s.warnings).toEqual([]);
  });

  it("地址末尾的斜杠去掉 —— 否则拼出来是 //v1/context-graph/narrative", () => {
    process.env.TKOS_MEMORY_API_BASE_URL = "https://memory.test/api//";
    expect(narrativeSettings().baseUrl).toBe("https://memory.test/api");
  });

  it("超时值解析不出来时回落到默认**并且说一声** —— 静默回落等于那个变量从没被读进去", () => {
    process.env.TKOS_ONTOLOGY_TIMEOUT_MS = "25s";
    const s = narrativeSettings();
    expect(s.timeoutMs).toBe(45_000);
    expect(s.warnings.join()).toContain("不是正数");
  });
});

describe("NarrativeClient · 请求发不出去的那几种", () => {
  it("没配地址时说「地址是空的」，而不是报一个像服务掉了的底层错", async () => {
    process.env.TKOS_MEMORY_API_KEY = "k";
    const c = new NarrativeClient();
    await expect(c.narrative("问一句")).rejects.toThrow(OntologyUnavailable);
    await expect(c.narrative("问一句")).rejects.toThrow(/地址是空的/);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("缺 key 和地址错分开报 —— 两条排查路径，而且不打印 key 本身也不打印长度", async () => {
    process.env.TKOS_MEMORY_API_BASE_URL = "https://memory.test";
    const c = new NarrativeClient();
    await expect(c.narrative("问一句")).rejects.toThrow(/TKOS_MEMORY_API_KEY/);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("空问句不打上游 —— 那一次必然没结果，却照样要走一个往返和整个预算", async () => {
    configured();
    await expect(new NarrativeClient().narrative("   ")).rejects.toThrow(/问句是空的/);
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe("NarrativeClient · 回包", () => {
  it("正常回包折成前端的形状，压缩模型要带出来 —— 那段话是它写的，不是图里的原文", async () => {
    configured();
    requestMock.mockResolvedValue(reply(frame()));
    const r = await new NarrativeClient().narrative("本期要达成什么");
    expect(r.text).toBe("压缩过的那一段。");
    expect(r.model).toBe("deepseek-v4-flash-ga-260731");
    expect(r.hitPaths).toBe(2);
    expect(r.sourceBaseUrl).toBe("https://memory.test");
  });

  it("要原文时吃 narrative_raw，不要时吃压缩版", async () => {
    configured();
    requestMock.mockResolvedValue(reply(frame({ narrative_raw: "未压缩那一整段。" })));
    const c = new NarrativeClient();
    expect((await c.narrative("q", { includeRaw: true })).text).toBe("未压缩那一整段。");
    expect((await c.narrative("q")).text).toBe("压缩过的那一段。");
  });

  it("要了原文却没给时**回落到压缩版而不是失败** —— 压缩版仍然是真材料", async () => {
    configured();
    requestMock.mockResolvedValue(reply(frame()));
    const r = await new NarrativeClient().narrative("q", { includeRaw: true });
    expect(r.text).toBe("压缩过的那一段。");
    // `raw` 空着是上层判「这一轮吃的是哪一份」的依据，不能顺手填成 text。
    expect(r.raw).toBe("");
  });

  it("include_raw 只在要的时候发；tenant/org 留空就不发，由服务端填自己的默认", async () => {
    configured();
    requestMock.mockResolvedValue(reply(frame()));
    await new NarrativeClient().narrative("q");
    const sent = JSON.parse(requestMock.mock.calls[0][1].body as string);
    expect(sent).toEqual({ query: "q" });

    requestMock.mockClear();
    process.env.TKOS_MEMORY_API_TENANT = "tk";
    process.env.TKOS_MEMORY_API_ORG = "tk-org";
    await new NarrativeClient().narrative("q", { includeRaw: true });
    expect(JSON.parse(requestMock.mock.calls[0][1].body as string)).toEqual({
      query: "q",
      include_raw: true,
      tenant: "tk",
      org: "tk-org",
    });
  });

  it("Bearer 认证，打的是 /v1/context-graph/narrative", async () => {
    configured();
    requestMock.mockResolvedValue(reply(frame()));
    await new NarrativeClient().narrative("q");
    expect(requestMock.mock.calls[0][0]).toBe("https://memory.test/v1/context-graph/narrative");
    expect(requestMock.mock.calls[0][1].headers.authorization).toBe("Bearer k");
  });

  it("非 2xx 要把正文截一段带出来 —— 只报状态码的话「body 解析失败」和「key 不对」长得一样", async () => {
    configured();
    requestMock.mockResolvedValue(reply({ detail: "There was an error parsing the body" }, 400));
    await expect(new NarrativeClient().narrative("q")).rejects.toThrow(/parsing the body/);
  });

  it("回的不是 JSON 时报出原文开头，不是一句 SyntaxError", async () => {
    configured();
    requestMock.mockResolvedValue(reply("<html>502 Bad Gateway</html>"));
    await expect(new NarrativeClient().narrative("q")).rejects.toThrow(/不是 JSON/);
  });

  it("**200 但正文是空的也算取不到** —— 否则一段空白会被当公司上下文塞进 prompt", async () => {
    configured();
    requestMock.mockResolvedValue(reply(frame({ narrative: "   " })));
    await expect(new NarrativeClient().narrative("q")).rejects.toThrow(/正文是空的/);
  });

  it("网络错要带上目标 URL —— 只报 errno 的话服务没起和网络不通分不出来", async () => {
    configured();
    requestMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(new NarrativeClient().narrative("q")).rejects.toThrow(/memory\.test/);
  });
});

/*
 * 重发那一次。**只对「请求发出去了、没等到回话」这一类**。
 *
 * 用假表推时间：真等一秒的话这三条各慢一秒，而它们验的是「重发了没有」，不是「等了多久」。
 */
describe("NarrativeClient · 抖一下重发一次", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 起一次调用，把中间那一秒推过去，再等它的结果。 */
  const runPastDelay = async <T>(work: Promise<T>): Promise<T> => {
    const settled = work.catch((e: unknown) => ({ __err: e }) as never);
    await vi.advanceTimersByTimeAsync(2_000);
    const r = (await settled) as T & { __err?: unknown };
    if (r && typeof r === "object" && "__err" in r) throw r.__err;
    return r;
  };

  it("第一次超时、第二次成了 —— 这一步是整条链最便宜的一次调用，不该由它判死一轮深研", async () => {
    configured();
    requestMock
      .mockRejectedValueOnce(new Error("Headers Timeout Error"))
      .mockResolvedValue(reply(frame()));
    const r = await runPastDelay(new NarrativeClient().narrative("q"));
    expect(r.text).toBe("压缩过的那一段。");
    // 试了几次要摆到明处：上层拿它写 warnings，不然「这一轮为什么慢了 26 秒」查不出来。
    expect(r.attempts).toBe(2);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("502/503/504 是网关后面没起来，不是拒绝：隔 2s/5s/10s 重发三次（2026-09-04）", async () => {
    configured();
    const db502 = reply(
      { detail: 'OperationalError: connection to server at "127.0.0.1", port 5435 failed: Connection refused' },
      502
    );
    requestMock.mockResolvedValueOnce(db502).mockResolvedValueOnce(db502).mockResolvedValue(reply(frame()));
    const work = new NarrativeClient().narrative("q");
    const settled = work.catch((e: unknown) => ({ __err: e }) as never);
    await vi.advanceTimersByTimeAsync(2_000 + 5_000 + 100);
    const r = (await settled) as { text: string; __err?: unknown };
    if ("__err" in r) throw r.__err;
    expect(r.text).toBe("压缩过的那一段。");
    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it("三次重发仍是 502 才判死，错误里写明重发过、并指向库没起", async () => {
    configured();
    requestMock.mockResolvedValue(reply({ detail: "port 5435 failed: Connection refused" }, 502));
    const work = new NarrativeClient().narrative("q");
    const settled = work.catch((e: unknown) => ({ __err: e }) as never);
    await vi.advanceTimersByTimeAsync(2_000 + 5_000 + 10_000 + 100);
    const r = (await settled) as { __err?: unknown };
    expect(r.__err).toBeInstanceOf(Error);
    expect(String((r.__err as Error).message)).toMatch(/重发了 3 次/);
    expect(String((r.__err as Error).message)).toMatch(/5435/);
    expect(requestMock).toHaveBeenCalledTimes(4);
  });

  it("4xx 照旧一次都不重发 —— 那是它读懂了并且拒绝", async () => {
    configured();
    requestMock.mockResolvedValue(reply({ detail: "bad key" }, 401));
    await expect(new NarrativeClient().narrative("q")).rejects.toThrow(/401/);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("两次都超时才算取不到，而且要说清它试过两次", async () => {
    configured();
    requestMock.mockRejectedValue(new Error("Headers Timeout Error"));
    await expect(runPastDelay(new NarrativeClient().narrative("q"))).rejects.toThrow(/两次/);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("没抖的那一次照旧只打一个往返，`attempts` 是 1", async () => {
    configured();
    requestMock.mockResolvedValue(reply(frame()));
    const r = await new NarrativeClient().narrative("q");
    expect(r.attempts).toBe(1);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("上游**答了**的那几种一律不重发 —— 4xx/5xx、不是 JSON、200 但正文空，重发一次只是白打一个往返", async () => {
    configured();
    requestMock.mockResolvedValue(reply({ detail: "key 不对" }, 401));
    await expect(new NarrativeClient().narrative("q")).rejects.toThrow(/401/);
    expect(requestMock).toHaveBeenCalledTimes(1);

    requestMock.mockReset();
    requestMock.mockResolvedValue(reply(frame({ narrative: "   " })));
    await expect(new NarrativeClient().narrative("q")).rejects.toThrow(/正文是空的/);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
