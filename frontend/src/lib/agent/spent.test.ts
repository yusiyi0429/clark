/**
 * **失败的那几次调用也要进账。**
 *
 * ## 为什么这件事会悄悄坏掉
 *
 * 「额度用完在思考上」「被 max_tokens 截断」这几种失败发生在模型**已经算完之后** ——
 * token 真的烧掉了，`usage` 就在手上。而上一版把它扔了：`callModelJson` 抛的是一个光秃秃
 * 的 `Error`，`harness` 的 catch 只记一句 error，累计一个数都不加。
 *
 * 代价在 `RUN-A4-mth5jkf0-6` 上量得出来：N2 检索计划那两次各烧满 8000 输出 token（错误
 * 原文自己写着「这一次思考花了 8000 token」），落进运行记录的 `usage` 是 0。
 * `pnpm cost:report` 照着这份记录算，于是那一轮报出来的 ¥5.74 里一分钱都不含这两次。
 *
 * **失败越多、账看起来越便宜。** 这是最坏的一种偏：它让「这条链哪里贵」这个问题的答案
 * 系统性地指向错的地方，而且没有任何症状 —— 没人会去核一张比预期低的账。
 *
 * 所以这一组两头各钉一条：抛的那一头要带着账（`SpentError`），接的那一头要把账记上。
 *
 * ## 替身为什么建在 `importActual` 的那个类上
 *
 * `harness` 认这个异常用的是 `instanceof`，比的是**它自己那次 import 拿到的类对象**。
 * 测试文件顶上再 import 一次 `SpentError` 拿到的可能是另一份（mock 之后的模块注册表和
 * 之前不是同一个），拿它造出来的异常 `instanceof` 是 false —— 于是这条测试会红在
 * 「没记账」上，而真实原因是两个类不是同一个对象。所以下面统一从 `importActual` 那一份取。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CallResult } from "@/lib/models/complete";

/** 这一次 `callModelJson` 要抛什么。每条用例自己摆。 */
let throwing: unknown = null;

vi.mock("@/lib/agent/json", async () => {
  const real = await vi.importActual<typeof import("./json")>("./json");
  return {
    ...real,
    callModelJson: vi.fn(async () => {
      throw throwing;
    }),
  };
});

const spent = (over: Partial<CallResult> = {}): CallResult => ({
  text: "",
  usage: { inputTokens: 1200, outputTokens: 8000, cachedInputTokens: 0, reasoningTokens: 8000 },
  ms: 137_419,
  queuedMs: 0,
  slot: "pro",
  alias: "deepseek-pro",
  providerModelId: "ep-m-20260810161932-8jl72",
  effortSent: null,
  stopReason: "length",
  ...over,
});

/** `harness` 会拿来做 `instanceof` 的那一份。 */
const spentError = async (message: string, r: CallResult) => {
  const real = await vi.importActual<typeof import("./json")>("./json");
  return new real.SpentError(message, r);
};

beforeEach(() => {
  throwing = null;
});

describe("SpentError 带着这一次的账", () => {
  it("是 Error，能被普通 catch 接住 —— 换成它不改变任何一处调用方的控制流", async () => {
    const e = await spentError("额度用完在思考上了", spent());
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("SpentError");
    expect(e.message).toContain("额度用完在思考上了");
  });

  it("账原样挂在上面，不是复制几个数上去", async () => {
    const r = spent();
    expect((await spentError("x", r)).spent).toBe(r);
  });
});

describe("harness 把失败那一次也记进账", () => {
  it("usage 进累计、进 trace，模型和收笔原因照实写", async () => {
    throwing = await spentError(
      "模型返回里没有正文：额度用完在思考上了（这一次思考花了 8000 token，正文 0）。",
      spent()
    );
    const { Harness } = await import("./harness");

    const h = new Harness({ agent: "A4", slot: "pro" });
    await expect(
      h.callMessages("模型调用 · a4.plan", [{ role: "user", content: "排检索计划" }], {
        slot: "pro",
        maxTokens: 16000,
      })
    ).rejects.toThrow("额度用完在思考上了");

    // 累计：这一轮的总账要含这一次。
    expect(h.usage.outputTokens).toBe(8000);
    expect(h.usage.reasoningTokens).toBe(8000);

    // trace：`cost:report` 读的是这一份，两处漏一处就会让同一轮出现两个价钱。
    const node = h.finish({ status: "ok" }).trace.find((n) => n.kind === "model");
    expect(node?.usage?.outputTokens).toBe(8000);
    expect(node?.error).toContain("额度用完在思考上了");
    // 哪个模型烧的、为什么停 —— 失败那一条同样要答得出，否则查不到该调大哪个额度。
    expect(node?.detail?.alias).toBe("deepseek-pro");
    expect(node?.detail?.stopReason).toBe("length");
  });

  it("普通异常照旧不记账 —— 连不上的那一次一个 token 都没烧", async () => {
    throwing = new Error("Connection error.");
    const { Harness } = await import("./harness");

    const h = new Harness({ agent: "A4", slot: "pro" });
    await expect(
      h.callMessages("模型调用 · a4.draft", [{ role: "user", content: "写草稿" }], { slot: "alt" })
    ).rejects.toThrow("Connection error.");
    expect(h.usage.outputTokens).toBe(0);
    const node = h.finish({ status: "ok" }).trace.find((n) => n.kind === "model");
    expect(node?.usage).toBeUndefined();
  });
});
