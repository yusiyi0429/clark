/**
 * **一次调用最多等多久。**
 *
 * ## 2026-09-01：流式那一支连同它的两组用例一起删了
 *
 * `alt`（Claude）从 Bedrock 换到网宿之后，走的是 `complete.ts` 里那段非流式的 OpenAI 兼容
 * `fetch` —— `callClaudeOnBedrock`、`normalizeStopReason` 和 `@anthropic-ai/bedrock-sdk`
 * 那条流式链路整个不在了。跟着删掉的是 `complete.idle-retry.test.ts` 整个文件，那四条：
 *
 *   · 「第一次被掐、第二次成 —— 正文拿得回来」
 *   · 「重发用的是**新的**控制器」（`AbortController` abort 过就永远是 aborted，复用等于
 *     第二次一进门就被上一次的闸掐掉）
 *   · 「只重发一次」
 *   · 「墙上超时一次都不重发 —— 它一直在吐字」
 *
 * 它们测的是空闲看门狗（`streamEvent` 每来一个分片拨一次表）和它那条一次性重发路，而这两样
 * 东西是流式独有的：非流式那条 `fetch` 只有一个往返，没有分片可数，也就没有「流着流着停住」
 * 这种状态。**删的不是判据变松了，是被判的那个东西没了。** `complete.cache.test.ts` 里那条
 * 「给流挂了 streamEvent 监听」同理，一起没了。
 *
 * 那条重发路答的问题（出口偶发吊连接，`RUN-A4-mth5jkf0-6` 里三次整齐停在 60 秒看门狗上）
 * **现在没有人答**：非流式这条路上，出口吊住连接的表现是等满墙上那道闸然后超时，一次都不
 * 重发。这是换网关带出来的一笔账，记在这里。
 *
 * ## 还在的是这一道闸：墙上超时，而且上层压得动
 *
 * `timeoutFor` 把调用方给的余量压进 `[5s, 这个口的天花板]`，挂在每一次请求的
 * `AbortSignal` 上。天花板分三档（`ceilingFor`）：网宿那条慢的口是 `SLOW_CALL_TIMEOUT_MS`
 * （420s，实测一个只回 300 token 的小问题就要 67 秒），方舟是 `ARK_CALL_TIMEOUT_MS`
 * （300s，为的是兑现 `COST.plan` 那 200 秒），其余照旧 `MODEL_TIMEOUT_MS`（180s）。
 *
 * 这道闸坏掉的时候一条测试都不会红、屏幕上也看不出来 —— 坏法是「允许一次调用跑得比上层给
 * 的余量更久」，表现出来只是「这一轮又超了」。所以下面第一组从**真实调用路径**上钉它：
 * `timeoutFor` / `ceilingFor` 都没有导出，但它们算出来的秒数写在超时那句话里
 * （`waitedLine`），一个字都不含糊。
 *
 * **三段都要推一遍**：余量比最小那一档小、卡在两档天花板中间、比最大那一档还大。中间那一段
 * 正是几档天花板唯一分得开的地方 —— 只验两头的话，`ceilingFor` 写成恒等 180 或恒等 420
 * 都是绿的。
 *
 * ## 反过来的那一半：天花板压得太狠，一条测试也不会红
 *
 * 2026-09-01 实测两轮真跑：`a4.plan` 一轮**整整 180.0 秒**超时（→ 零条命题 → 取证整段跳过
 * → 零证据），另一轮 77.6 秒侥幸过。上层给它的预算是 200 秒（`COST.plan`），而
 * `timeoutFor` 只会往下压不会往上放 —— 那 20 秒是一句上层说了、下层兑现不了的话，而它的
 * 表现是「模型没答上来」。所以下面最后一条拿 `COST.plan` 直接对着这一档比，不是记一个数。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COST } from "@/lib/agent/a4/deadline";

import {
  ARK_CALL_TIMEOUT_MS,
  MODEL_TIMEOUT_MS,
  SLOW_CALL_TIMEOUT_MS,
  STREAM_TIMEOUT_MS,
  streamWallFor,
} from "./complete";
/*
 * 生产代码里那一次请求走的是 **undici 的 `fetch`**，不是全局的（原因整段写在
 * `complete.ts` 的 `httpFetch` 上：Node 内置 fetch 用的是它自己捆的那份 undici，
 * 递一个外部 `Agent` 给它会当场 `UND_ERR_INVALID_ARG`）。
 *
 * 这里把它转回全局那一个，好让下面所有 `vi.stubGlobal("fetch", …)` 照旧生效 ——
 * 这些用例要验的是**发出去的那一份长什么样**，跟走哪个 fetch 实现无关。
 */
vi.mock("undici", async (importActual) => {
  const actual = await importActual<typeof import("undici")>();
  return {
    ...actual,
    fetch: (...args: unknown[]) =>
      (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
  };
});


const KEYS = ["ARK_API_KEY", "WANGSU_API_KEY", "WANGSU_BASE_URL", "TKOS_MODEL_MOCK", "TKOS_COST_TAP"];
let saved: Record<string, string | undefined> = {};
/** 每次调用挂上去的那个 signal。闸没挂上的话这里是 undefined。 */
const signals: (AbortSignal | undefined)[] = [];

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  process.env.WANGSU_API_KEY = "wangsu-key";
  signals.length = 0;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

/**
 * 让 `fetch` 立刻抛一个「超时」——名字和真闸掐断时抛的一样（`AbortSignal.timeout` 抛的是
 * `TimeoutError`）。真等几分钟是没法测的，而这一层要验的本来就不是计时器准不准，
 * 是**那句话里的秒数是从哪个数算出来的**。
 */
const stubTimeout = () => {
  vi.stubGlobal("fetch", async (_u: string, init: { signal?: AbortSignal }) => {
    signals.push(init.signal);
    const e = new Error("");
    e.name = "TimeoutError";
    throw e;
  });
};

/** `alt` 走网宿（慢的那一档），`pro` 走方舟（180s 那一档）。两档只在中间那一段分得开。 */
const call = async (timeoutMs?: number, slot: "alt" | "pro" = "alt") => {
  if (slot === "pro") process.env.ARK_API_KEY = "ark-key";
  const { callModel } = await import("./complete");
  return callModel({
    slot,
    messages: [{ role: "user", content: "写这一节" }],
    maxTokens: 100,
    json: false,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
};

describe("墙上那道闸（非流式这条口上还在）", () => {
  it("每一次请求都挂着 signal —— 不挂等于这道闸根本没上", async () => {
    stubTimeout();
    await expect(call()).rejects.toThrow();
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("三档天花板是三个数，一档比一档大 —— 否则分成三档就没意义", () => {
    expect(MODEL_TIMEOUT_MS).toBe(180_000);
    expect(ARK_CALL_TIMEOUT_MS).toBe(300_000);
    expect(SLOW_CALL_TIMEOUT_MS).toBe(420_000);
    expect(ARK_CALL_TIMEOUT_MS).toBeGreaterThan(MODEL_TIMEOUT_MS);
    expect(SLOW_CALL_TIMEOUT_MS).toBeGreaterThan(ARK_CALL_TIMEOUT_MS);
  });

  it("上层没给余量：网宿这条口等满它自己那一档（420s），不是 180", async () => {
    /*
     * 2026-09-01 实测网宿上的 `claude-opus-5`：一个只回 300 token 的小问题要 67 秒。深研
     * 真正写字那几步一次要生成几千 token —— 按 180 秒掐会把它们成片掐掉，**而掐出来的失败
     * 长得像「模型没答上来」**，不像「等的时间不够」。这一条就是那个换档的落点。
     */
    stubTimeout();
    await expect(call()).rejects.toThrow(/等了 420s 没等到回复。思考型模型/);
  });

  it("上层没给余量：方舟等满它自己那一档（300s），不是 180", async () => {
    /*
     * 180 那一版让 `a4.plan` 那一步**永远用不满自己的预算**（`COST.plan` 是 200 秒），
     * 而超时长得像「模型没答上来」。实测那一轮死在 180.0 秒整 —— 整秒是天花板留下的指纹。
     */
    stubTimeout();
    await expect(call(undefined, "pro")).rejects.toThrow(/等了 300s 没等到回复/);
  });

  it("方舟这一档必须兑现得了 `COST.plan` —— 它存在的全部理由就是这个", () => {
    /*
     * 记一个数没用：改小 `ARK_CALL_TIMEOUT_MS` 或改大 `COST.plan` 都会重新打开那条缝，
     * 而两处各在一个文件里，谁也不会想起去看另一处。所以直接对着比。
     */
    expect(ARK_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(COST.plan);
  });

  it("超时那句话要报出**哪个出口、哪把 key** —— 拿到它的人要去查的正是那两样", async () => {
    stubTimeout();
    await expect(call()).rejects.toThrow(/网宿网关调用超时 \[claude-opus-5\]（用的是 WANGSU_API_KEY）/);
  });

  it("上层压小了余量：听上层的，并说出**是从这个口自己那一档**压下来的", async () => {
    /*
     * 两句话要分得开：等了 40 秒就超时（这一轮时间快用完了）和等满天花板才超时（这次调用
     * 真的卡住了）—— 该去查的东西不一样。不写的话结果页上两者长得一模一样。
     *
     * 「从多少压下来的」那个数必须是这个口自己那一档。写死 180 的那一版会在网宿上说
     * 「从 180s 压到了 300s」—— 这句话是结果页上唯一的现场，它自相矛盾的时候没有第二处能对。
     */
    stubTimeout();
    await expect(call(40_000)).rejects.toThrow(/等了 40s[\s\S]*从 420s 压到了这个数/);
    await expect(call(40_000, "pro")).rejects.toThrow(/等了 40s[\s\S]*从 300s 压到了这个数/);
  });

  it("**几档天花板之间那一段**：网宿照放，方舟压回它自己那一档", async () => {
    /*
     * 这一条是这一组存在的理由。几档天花板只在这一段上分得开 —— 只验两头的话，
     * `ceilingFor` 写成恒等 180（网宿那几步被成片掐掉）或恒等 420（方舟那条白占墙钟）
     * 都照样绿。
     *
     * 上层给的余量本身在这一段之内，所以哪条口都不该超过它：`a4/deadline.ts` 那套编排的
     * 前提就是「单次调用不会超过上层给的余量」。
     */
    stubTimeout();
    await expect(call(350_000)).rejects.toThrow(/等了 350s/);
    await expect(call(350_000, "pro")).rejects.toThrow(/等了 300s/);
    // 200s 那一档：方舟这里照放，正是 `COST.plan` 要的那个数。
    await expect(call(200_000, "pro")).rejects.toThrow(/等了 200s/);
  });

  it("上层余量比天花板还大：压回天花板，不无限放大", async () => {
    stubTimeout();
    await expect(call(600_000)).rejects.toThrow(/等了 420s/);
    await expect(call(600_000, "pro")).rejects.toThrow(/等了 300s/);
  });

  it("余量小到荒唐时有下限 —— 发一个必死的请求不如不发", async () => {
    /*
     * 压到两秒的话每一次调用都是超时，那不是「按时收口」，是把一轮跑成一串超时异常。
     * 真要那么紧，该做的是这一步根本不发（`room()` 判的就是这个）。
     */
    stubTimeout();
    await expect(call(1_000)).rejects.toThrow(/等了 5s/);
  });
});

/**
 * **下面这一组测的是三个还导出着、但当前没有任何调用方的函数**（`streamWallFor` /
 * `STREAM_TIMEOUT_MS` / `MODEL_TIMEOUT_MS` 里的前两个）。
 *
 * 留着不删，是因为它钉的那个错**极容易再犯一次**，而实现还在原地：
 *
 *     const streamWallMs = timeoutMs < MODEL_TIMEOUT_MS ? timeoutMs : STREAM_TIMEOUT_MS;
 *
 * 2026-08-30 第一版就是这么写的，而 `timeoutMs` 早被压进 ≤180s —— 比较的另一半永远够不着，
 * 于是「上层剩 250 秒」那一档拿到的是 420 秒。**注释写着「它比 420 小就听它的」，真实语义
 * 是「它比 180 小就听它的」。** 那一档正是一轮跑到后半程、`room()` 刚好还肯放行的那一段。
 *
 * 所以这一组现在的身份是**给流式回来的那一天用的规格**，不是在测线上跑着的东西。
 * 哪天决定不再上流式了，删那两个导出的同时把这一组一起删掉 —— 别让它单独留着，
 * 一组绿着的用例会让人以为那条路还在跑。
 */
describe("streamWallFor（当前没有调用方，见上面那段）", () => {
  it("上层没给余量：用流式那一档的天花板", () => {
    expect(streamWallFor(undefined)).toBe(STREAM_TIMEOUT_MS);
    expect(streamWallFor(Number.POSITIVE_INFINITY)).toBe(STREAM_TIMEOUT_MS);
    expect(streamWallFor(Number.NaN)).toBe(STREAM_TIMEOUT_MS);
  });

  it("上层余量比天花板小：听上层的（这是那套预算的全部意义）", () => {
    expect(streamWallFor(120_000)).toBe(120_000);
    expect(streamWallFor(300_000)).toBe(300_000);
  });

  it("**180s 到 420s 那一段**：不许悄悄放宽到 420", () => {
    for (const want of [180_001, 200_000, 250_000, 419_999]) {
      expect(streamWallFor(want), `剩 ${want}ms 时不该放宽`).toBe(want);
    }
    // 边界：正好等于非流式那个天花板时也听上层的，不跳到 420。
    expect(streamWallFor(MODEL_TIMEOUT_MS)).toBe(MODEL_TIMEOUT_MS);
  });

  it("余量比天花板大：压到天花板，不无限放大", () => {
    expect(streamWallFor(STREAM_TIMEOUT_MS + 1)).toBe(STREAM_TIMEOUT_MS);
    expect(streamWallFor(3_600_000)).toBe(STREAM_TIMEOUT_MS);
  });

  it("余量小到荒唐时有下限 —— 和非流式那一档同一个下限", () => {
    expect(streamWallFor(1)).toBeGreaterThanOrEqual(5_000);
    expect(streamWallFor(0)).toBeGreaterThanOrEqual(5_000);
  });

  it("流式的天花板确实比非流式那档大 —— 否则分成两个数就没意义", () => {
    expect(STREAM_TIMEOUT_MS).toBeGreaterThan(MODEL_TIMEOUT_MS);
  });
});
