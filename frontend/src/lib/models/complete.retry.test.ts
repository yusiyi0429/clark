/**
 * 哪些失败可以重发。
 *
 * ## 为什么值得单独钉
 *
 * 这个判据两边都坏得没有症状：
 *
 * · **放得太紧**（该重发的没重发）—— 就是 2026-08-31 撞上的那一次：Bedrock 上的
 *   Claude 1.1 秒回一个 `Connection error.`，N1 草稿整份没了，后面每一步都建立在草稿上，
 *   于是 N3 取证整段跳过。而这一轮照旧出稿、照旧报 `ok`、照旧把后面那十几次调用的钱
 *   花完（那一轮 Opus 一家 $0.9）。**屏幕上唯一的表现是「这份报告写得有点空」。**
 *
 * · **放得太松**（不该重发的重发了）—— 一次 400、一次模型拒答、一次内容不合格重发过去
 *   拿回来的是同一个答案，**而钱付了两次**。这一头更隐蔽：它永远不报错，只是账单慢慢变高。
 *
 * 所以下面两组用例是对称的，缺哪一组这个判据都可以悄悄滑到另一边。
 *
 * ## 2026-09-01：这个判据**当前没有调用方**
 *
 * `alt` 与 `synth` 换到网宿之后，`callClaudeOnBedrock` 那条流式链路整个删掉了，连着删掉的
 * 还有它里面那个按这个判据重发的循环。`isTransportFailure` 照旧导出着，但现在没有任何一处
 * 调它 —— **换句话说，上面那两头当前都没人守**：连不上时一次都不重发，直接记一条缺口。
 * 这是换网关带出来的一笔账，不是这一份测试放松了。
 *
 * 这一份留着不删，因为判据本身一个字都没变，而它写对写错的代价（上面那两段）也一点没变。
 * 哪天把重发接回来（或者给兼容口接上流式），接的就是它。真决定不再重发了，删这个导出的
 * 同时把这一份一起删掉 —— 别让它单独绿着，一组绿着的用例会让人以为那条路还在跑。
 *
 * 下面那些 Bedrock 的错误原话**一字不改地留着**：它们是这个判据唯一的现场证据（真跑出来
 * 的 message 长什么样），换成网宿的措辞等于把证据改成猜测。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isTransportFailure } from "./complete";

/*
 * 生产代码里那一次请求走的是 **undici 的 `fetch`**，不是全局的（理由整段在 `complete.ts`
 * 的 `httpFetch` 上）。这里把它转回全局那一个，好让下面 `vi.stubGlobal("fetch", …)` 生效。
 */
vi.mock("undici", async (importActual) => {
  const actual = await importActual<typeof import("undici")>();
  return {
    ...actual,
    fetch: (...args: unknown[]) =>
      (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
  };
});

describe("哪些失败算「请求根本没走通」", () => {
  it("认得出真跑出来的那两条", () => {
    /*
     * 一字不改地抄自 2026-08-31 那一轮的运行记录。它们的 `name` 都是 `Error`
     * （`@anthropic-ai/bedrock-sdk` 把 `APIConnectionError` / `APIConnectionTimeoutError`
     * 抛出来时就是这样），所以判据只能落在 message 上 —— 这也是这个函数按 message 认
     * 而不是按类名认的全部理由。
     */
    expect(
      isTransportFailure(
        new Error(
          "Bedrock Claude 口调用失败 [us.anthropic.claude-opus-5]（用的是 BEDROCK_API_KEY）: Error: Connection error.",
        ),
      ),
    ).toBe(true);
    expect(
      isTransportFailure(
        new Error(
          "Bedrock Claude 口调用失败 [us.anthropic.claude-opus-5]（用的是 BEDROCK_API_KEY）: Error: Request timed out.",
        ),
      ),
    ).toBe(true);
  });

  it("认得出别的几种连不上", () => {
    for (const m of [
      "socket hang up",
      "fetch failed",
      "read ECONNRESET",
      "connect ECONNREFUSED 127.0.0.1:443",
      "terminated",
    ]) {
      expect(isTransportFailure(new Error(m)), m).toBe(true);
    }
  });

  it("**不认**那些重发一次只会多付一次钱的", () => {
    /*
     * 这一组是这个文件真正防的那一头。每一条都是「服务端确实答复了」——
     * 重发拿回来的是同一句话。
     */
    for (const m of [
      "HTTP 400 — model not supported for on-demand throughput",
      "HTTP 401 — invalid api key",
      "HTTP 429 — rate limit exceeded",
      "HTTP 500 — internal server error",
      "模型返回里没有正文。",
      "交回来的东西读不出：Unexpected end of JSON input",
      "这一轮只有 system，没有任何一条对话消息",
    ]) {
      expect(isTransportFailure(new Error(m)), m).toBe(false);
    }
  });

  it("**不认**我们自己掐的那两种", () => {
    /*
     * 空闲和墙上超时说明这一次**确实在跑**（响应头回来了、甚至一直在吐字），不是「没走通」
     * ——所以这个判据不认它们。
     *
     * 2026-08-31 起空闲那一种在循环里**另有一条重发路**（`IDLE_RETRIES`），走的不是这个
     * 判据。两条路分开正是要点：它按「偶发吊连接」重发一次，而这个判据答的是「请求根本没
     * 走通吗」——空闲那一种的答案照旧是「不是」。
     *
     * **那两个标记 2026-09-01 起不再有人抛**：它们是流式那条链路掐断时打的，而那条链路连同
     * `complete.idle-retry.test.ts` 整个删掉了（为什么删写在 `complete.timeout.test.ts`
     * 文件头）。这两条断言留着的理由是判据的形状：**「我们自己掐的」永远不等于「没走通」**
     * —— 流式哪天接回来，标记也跟着回来，而那时这个区别照旧是重发多付一次钱的分界。
     */
    expect(isTransportFailure(new Error("tkos:stream-idle"))).toBe(false);
    expect(isTransportFailure(new Error("tkos:stream-wall"))).toBe(false);
  });

  it("大小写和非 Error 都不许把它绕过去", () => {
    expect(isTransportFailure(new Error("CONNECTION ERROR"))).toBe(true);
    expect(isTransportFailure("Connection error.")).toBe(true);
    expect(isTransportFailure(null)).toBe(false);
  });
});

/**
 * **429 是这条重发路上唯一一种「4xx 也要重发」。**
 *
 * 上面那一组的分界是「服务端确实答复了 → 重发拿回来的是同一句话，只是多付一次钱」。429 不在
 * 那一类：它没有答案，它说的是**位子没了**。不重发的代价在链路上是两种静默降级 —— 抽取那一步
 * 读成「这一页抽不出来」（台账少几条证据），分节那一步读成「那一节没写成」（报告少一节），
 * 两种在屏幕上都不像故障。
 *
 * 所以这一组要钉三件事：真的重发了一次、重发之前**整个出口退避**了（队里那几个发出去也是
 * 429，只罚撞上的那一个等于把一次退避摊成一串失败）、以及重发仍然 429 就照旧抛。
 *
 * 上面那条 `isTransportFailure` **一个字都没动**：它答的仍然是「请求根本没走通吗」，而 429
 * 的答案照旧是「不是」。两条路分开正是要点 —— 一条按异常判，一条按状态码判。
 */
describe("429：位子没了，不是「同一个答案多付一次钱」", () => {
  const KEYS = ["ARK_API_KEY", "WANGSU_API_KEY", "TKOS_MODEL_MOCK", "TKOS_COST_TAP", "TKOS_GATE_WANGSU"];
  let saved: Record<string, string | undefined> = {};
  /** 每次发出去记一条状态码，好数「发了几次」。 */
  let sent: number;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    process.env.WANGSU_API_KEY = "wangsu-key";
    sent = 0;
    vi.resetModules();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.unstubAllGlobals();
  });

  /** 头 `n` 次回 429（`Retry-After: 0` → 退避压到下限 1 秒），之后回一份正常应答。 */
  const stub429 = (n: number) => {
    vi.stubGlobal("fetch", async () => {
      sent += 1;
      if (sent <= n) {
        return new Response("rate limit exceeded", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "写完了" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
  };

  const call = async () => {
    const { callModel } = await import("./complete");
    return callModel({
      slot: "alt",
      messages: [{ role: "user", content: "写这一节" }],
      maxTokens: 100,
      json: false,
    });
  };

  it("撞一次：退避之后重发一次，正文照旧交得出来", async () => {
    stub429(1);
    const r = await call();
    expect(r.text).toBe("写完了");
    expect(sent).toBe(2);
  });

  it("重发那一次的等待记进 `queuedMs`，**不记进 `ms`**", async () => {
    /*
     * 并进 `ms` 的话，限速器一生效 trace 上每一条都会变慢，而那只能被读成「这个模型今天慢」
     * —— 于是去查出口、去调超时，查的是一件没发生的事。退避的下限是 1 秒（`COOLDOWN_MIN_MS`），
     * 所以撞过一次的这一条至少排了那么久。
     */
    stub429(1);
    const { COOLDOWN_MIN_MS } = await import("./gate");
    const r = await call();
    expect(r.queuedMs).toBeGreaterThanOrEqual(COOLDOWN_MIN_MS);
    // `ms` 只算拿到位子之后那一段。桩里的 fetch 是立刻返回的，所以它必须远小于退避。
    expect(r.ms).toBeLessThan(COOLDOWN_MIN_MS);
  });

  it("退避罚的是**整个出口**，不是只罚撞上的那一次", async () => {
    /*
     * 这一条是这一组里最要紧的。只让撞上的那一个等，队里剩下的每一个都会各撞一次 ——
     * 一次退避被摊成一串失败，而每一串失败在链路上都长成「这一页抽不出来」。
     */
    stub429(1);
    const { snapshot } = await import("./gate");
    const p = call();
    // 撞上那一刻起，这个出口整体在退避里；`coolUntil` 是唯一看得见这件事的地方。
    await vi.waitFor(() => expect(snapshot().wangsu.coolUntil).toBeGreaterThan(Date.now()));
    await p;
  });

  it("重发仍然 429 就照旧抛，而且话要指到限额上，不指到模型上", async () => {
    /*
     * 第二次仍然 429 说明限额本身不够 —— 该调 `TKOS_GATE_*` 或者少并发几条链，不是再等一轮。
     * 这句话说错的代价是有人去查网宿的模型开通状态，而那边一切正常。
     */
    stub429(2);
    await expect(call()).rejects.toThrow(/HTTP 429/);
    expect(sent).toBe(2);
  });

  it("别的 4xx 一个都不重发 —— 这条分界没有被 429 那一支带松", async () => {
    vi.stubGlobal("fetch", async () => {
      sent += 1;
      return new Response("invalid api key", { status: 401 });
    });
    await expect(call()).rejects.toThrow(/HTTP 401/);
    expect(sent).toBe(1);
  });
});
