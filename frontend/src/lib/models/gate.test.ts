/**
 * 出口限速器。**这几条守的是「撞限时排队而不是失败」这句话本身。**
 *
 * ## 为什么这一份值得写全
 *
 * 限速器坏掉的两头都没有症状：
 *
 * · **放得太松**（该等的没等）—— 就是这个文件出现之前的状态：429 走 `complete.ts` 那条
 *   「4xx 一律不重发」，于是抽取那一步读成「这一页抽不出来」、分节那一步读成「那一节没写成」。
 *   台账少几条证据、报告少一节，而屏幕上一切正常。
 * · **放得太紧**（不该等的等了）—— 位子漏还一次、队里留一个已经走掉的人、退避时刻只增不减，
 *   任何一条的表现都是「越跑越慢」，最后所有调用卡在门口等一个不会回来的位子。**没有一条
 *   会红，也没有一处会报错。**
 *
 * 所以下面每一组都是成对的：等住了，以及**等到点真的放行**。
 *
 * ## 时间靠假表推，不靠真等
 *
 * 每分钟那道闸的窗口是 60 秒，退避是几秒到一分钟 —— 真等一遍这一份要跑几分钟。假表推的
 * 是同一段逻辑（`Date.now()` 和 `setTimeout` 都被换掉了），而这一层要验的本来就不是计时器
 * 准不准，是**哪个时刻该放行**。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEYS = [
  "TKOS_GATE_WANGSU",
  "TKOS_GATE_ARK",
  "TKOS_GATE_DEEPSEEK",
  "TKOS_GATE_BOCHA",
  "TKOS_GATE_DOUBAO",
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  // 每条用例要一份干净的池子。`dev-pin` 在单测里默认不钉，所以重置模块就够。
  vi.resetModules();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const load = () => import("./gate");

describe("并发上限", () => {
  it("满了的时候第 N+1 个等着，前面还回来一个才放行", async () => {
    process.env.TKOS_GATE_ARK = "2/0";
    const { acquire, snapshot } = await load();

    const r1 = await acquire("ark");
    await acquire("ark");

    let third = false;
    const p3 = acquire("ark").then((r) => {
      third = true;
      return r;
    });
    // 让所有已经能跑的微任务跑完 —— 之后还没进来，那才叫「被拦住了」。
    await Promise.resolve();
    await Promise.resolve();
    expect(third).toBe(false);
    expect(snapshot().ark).toMatchObject({ inFlight: 2, queued: 1 });

    r1();
    await p3;
    expect(third).toBe(true);
    expect(snapshot().ark).toMatchObject({ inFlight: 2, queued: 0 });
  });

  it("**位子只算还一次**：同一个 release 叫两遍不许多放一个进来", async () => {
    /*
     * 这一条守的是反过来那一头。`finally` 里叫一次、异常路径上又叫一次是很容易写出来的，
     * 而多减一次 `inFlight` 的表现不是报错，是这个出口从此比配的额度多放一个 ——
     * 也就是限速器**看起来在跑，实际上限额是错的**。
     */
    process.env.TKOS_GATE_ARK = "1/0";
    const { acquire, snapshot } = await load();

    const r1 = await acquire("ark");
    r1();
    r1();
    expect(snapshot().ark.inFlight).toBe(0);

    await acquire("ark");
    let second = false;
    void acquire("ark").then(() => (second = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(second).toBe(false);
  });

  it("先到先得，不按谁的活大", async () => {
    // 写手和抽取抢同一个池时的顺序。有优先级的版本以后再说（`gate.ts` 头上那段）。
    process.env.TKOS_GATE_ARK = "1/0";
    const { acquire } = await load();

    const held = await acquire("ark");
    const order: string[] = [];
    const waits = ["甲", "乙", "丙"].map((n) =>
      acquire("ark").then((r) => {
        order.push(n);
        r();
      }),
    );
    held();
    await Promise.all(waits);
    expect(order).toEqual(["甲", "乙", "丙"]);
  });
});

describe("每分钟上限（滑动窗口）", () => {
  it("配额用完就等，而且等的是**最早那一次掉出窗口**的时刻，不是从现在再数一整分钟", async () => {
    /*
     * 这一条是滑动窗口和固定窗唯一分得开的地方。
     *
     * 两次放行分别落在第 0 秒和第 30 秒，限额 2/分钟。第三个该在**第 60 秒**放行 ——
     * 那一刻第 0 秒那一次掉出了最近 60 秒。写成「从现在再等一分钟」的话它会等到第 90 秒，
     * 而写成固定窗（按整分钟分格）的话它会在格子翻页时连放两个，也就是任意连续 60 秒里
     * 出现 4 次 —— 上游数的正是任意连续 60 秒。
     */
    vi.useFakeTimers();
    process.env.TKOS_GATE_ARK = "0/2";
    const { acquire } = await load();

    (await acquire("ark"))();
    await vi.advanceTimersByTimeAsync(30_000);
    (await acquire("ark"))();

    let third = false;
    void acquire("ark").then((r) => {
      third = true;
      r();
    });

    await vi.advanceTimersByTimeAsync(29_000); // 第 59 秒
    expect(third).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000); // 第 61 秒
    expect(third).toBe(true);
  });

  it("`0` 是不限，不是「一个都不放」", async () => {
    // 写反了的表现是那个出口整个停摆，而配置上看着像「我没限它」。
    process.env.TKOS_GATE_ARK = "0/0";
    const { acquire, snapshot } = await load();
    for (let i = 0; i < 50; i += 1) await acquire("ark");
    expect(snapshot().ark).toMatchObject({ inFlight: 50, queued: 0 });
  });
});

describe("429 退避", () => {
  it("退避期间一律等，到点自己放行", async () => {
    vi.useFakeTimers();
    const { acquire, coolDown, snapshot } = await load();

    coolDown("ark", 5_000);
    let got = false;
    void acquire("ark").then((r) => {
      got = true;
      r();
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(got).toBe(false);
    expect(snapshot().ark.queued).toBe(1);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(got).toBe(true);
  });

  it("退避只延长不缩短 —— 后一次报了个更短的数，不许把前一次的账松开", async () => {
    /*
     * 几条链并着跑时，同一秒里可以有好几次 429 各报各的 `Retry-After`。取短的那一版会让
     * 最后一次调用说了算，而那正好是最不该信的那一次（它是撞得最狠的时候回来的）。
     */
    vi.useFakeTimers();
    const { coolDown, snapshot } = await load();
    coolDown("ark", 30_000);
    const long = snapshot().ark.coolUntil;
    coolDown("ark", 2_000);
    expect(snapshot().ark.coolUntil).toBe(long);
  });

  it("`Retry-After` 压进上下限 —— 一小时的退避不许照收", async () => {
    /*
     * 一轮深研有总时长（`a4/deadline.ts` 那 20 分钟）。照收一个 3600 秒的退避，这一次调用会
     * 占着一个已经不属于它的余量睡一小时，而屏幕上写着「正在取证」。
     */
    vi.useFakeTimers();
    const { coolDown, snapshot, COOLDOWN_MAX_MS, COOLDOWN_MIN_MS } = await load();
    coolDown("ark", 3_600_000);
    expect(snapshot().ark.coolUntil - Date.now()).toBe(COOLDOWN_MAX_MS);

    vi.resetModules();
    const two = await load();
    two.coolDown("bocha", 0);
    expect(two.snapshot().bocha.coolUntil - Date.now()).toBe(COOLDOWN_MIN_MS);
  });

  it("`Retry-After` 秒数和 HTTP 日期都认，读不懂就用兜底值", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T10:00:00Z"));
    const { retryAfterMs } = await load();
    expect(retryAfterMs("12")).toBe(12_000);
    expect(retryAfterMs("Mon, 07 Sep 2026 10:00:20 GMT")).toBe(20_000);
    // 头缺了、或者是一句看不懂的话 —— 429 是真的，不该因此变成「不退避」。
    expect(retryAfterMs(null)).toBe(5_000);
    expect(retryAfterMs("soon")).toBe(5_000);
  });
});

describe("中止", () => {
  it("排队时被中止：抛 AbortError，并且**当场从队里摘掉**", async () => {
    process.env.TKOS_GATE_ARK = "1/0";
    const { acquire, snapshot } = await load();

    const held = await acquire("ark");
    const ac = new AbortController();
    const p = acquire("ark", ac.signal);
    expect(snapshot().ark.queued).toBe(1);

    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    // 留着的话，`snapshot()` 那个数会一直偏高，而它是运营台上唯一看得见「堵了多少」的地方。
    expect(snapshot().ark.queued).toBe(0);

    // 摘掉的人不许占掉那个位子：还回来时下一个真的进得来。
    held();
    const next = await acquire("ark");
    expect(next).toBeTypeOf("function");
  });

  it("已经中止的 signal 进来就拒，不先排一次队", async () => {
    const { acquire, snapshot } = await load();
    const ac = new AbortController();
    ac.abort();
    await expect(acquire("ark", ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(snapshot().ark.queued).toBe(0);
  });
});

describe("限额从哪来", () => {
  it("默认值就是文件头写的那几个 —— 换了就得同时改注释", async () => {
    const { limitOf } = await load();
    expect(limitOf("wangsu")).toEqual({ concurrency: 4, perMinute: 60 });
    expect(limitOf("ark")).toEqual({ concurrency: 12, perMinute: 300 });
    expect(limitOf("bocha")).toEqual({ concurrency: 4, perMinute: 60 });
    expect(limitOf("doubao")).toEqual({ concurrency: 4, perMinute: 60 });
  });

  it("环境变量盖得住，而且是**在取用时**读的", async () => {
    // 在模块加载时定死的表现是：`.env` 改了、进程没重启的话仍按旧数放行，日志里看不出来。
    const { limitOf } = await load();
    expect(limitOf("wangsu").concurrency).toBe(4);
    process.env.TKOS_GATE_WANGSU = "1/10";
    expect(limitOf("wangsu")).toEqual({ concurrency: 1, perMinute: 10 });
  });

  it("配歪了当没配，不抛 —— 一个笔误不该让每条出口一起停摆", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.TKOS_GATE_ARK = "4";
    const { limitOf } = await load();
    expect(limitOf("ark")).toEqual({ concurrency: 12, perMinute: 300 });
    // 但要出声。静默退回默认值等于让人以为自己配上了。
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain("TKOS_GATE_ARK");
  });
});

describe("几个出口是几个池", () => {
  it("网宿满了不该把方舟一起挡住", async () => {
    /*
     * 这一条守的是这个文件的第一句话：池按**出口**分。写成一个全局信号量的话，写手那条链
     * 一堵，逐页抽取（走方舟）跟着一起停 —— 而那两家的配额毫无关系。
     */
    process.env.TKOS_GATE_WANGSU = "1/0";
    const { acquire, snapshot } = await load();
    await acquire("wangsu");
    void acquire("wangsu");
    await acquire("ark");
    await Promise.resolve();
    expect(snapshot().wangsu.queued).toBe(1);
    expect(snapshot().ark).toMatchObject({ inFlight: 1, queued: 0 });
  });
});
