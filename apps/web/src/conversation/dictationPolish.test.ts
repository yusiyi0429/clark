import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fullPolishTimeoutMs, needsFullPolish, needsPolish, POLISH_REQUEST_TIMEOUT_MS, startPolish } from "./dictationPolish";

describe("本地预判：已经干净的句子不送整理", () => {
  it("有填充词 / 改口词 / 叠词 / 没有句末标点 → 送；干净的句子 → 不送", () => {
    expect(needsPolish("嗯，下午三点开会。")).toBe(true);
    expect(needsPolish("下午两点，不对，三点开会。")).toBe(true);
    expect(needsPolish("讨论一下，讨论一下预算。")).toBe(true);
    expect(needsPolish("下午三点开会")).toBe(true);
    expect(needsPolish("下午三点开会。")).toBe(false);
    expect(needsPolish("   ")).toBe(false);
    expect(needsPolish(`${"很长".repeat(1001)}嗯`)).toBe(false);
  });
});

describe("整理请求", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("干净的句子不发请求，立刻有结果", async () => {
    const fetcher = vi.fn();
    const job = startPolish("下午三点开会。", fetcher as unknown as typeof fetch);
    expect(job.done).toBe(true);
    expect(job.value).toBe("下午三点开会。");
    expect(await job.result).toBe("下午三点开会。");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("POST /api/me/dictation/polish {text}，polished:true 用整理后的文字", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ text: "下午三点开会。", polished: true }));
    const job = startPolish("嗯，下午三点开会。", fetcher as unknown as typeof fetch);
    expect(job.done).toBe(false);
    expect(await job.result).toBe("下午三点开会。");
    expect(job.done).toBe(true);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me/dictation/polish");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ text: "嗯，下午三点开会。" });
  });

  it("polished:false、HTTP 失败、断网、超时 → 原文", async () => {
    const original = "嗯，下午三点开会。";
    for (const response of [Promise.resolve(Response.json({ text: original, polished: false })), Promise.resolve(new Response("", { status: 500 })), Promise.reject(new Error("offline"))]) {
      const job = startPolish(original, vi.fn().mockReturnValue(response) as unknown as typeof fetch);
      expect(await job.result).toBe(original);
    }
    let aborted = false;
    const hanging = vi.fn((_url: string, init: RequestInit) => {
      init.signal?.addEventListener("abort", () => (aborted = true));
      return new Promise<Response>(() => {});
    });
    const job = startPolish(original, hanging as unknown as typeof fetch);
    vi.advanceTimersByTime(POLISH_REQUEST_TIMEOUT_MS);
    expect(await job.result).toBe(original);
    expect(aborted).toBe(true);
  });
});

describe("整段整理（停下后，含分点）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("预判：有列举词或三句以上也送；「第三季度」不算列举；一句干净话不送", () => {
    expect(needsFullPolish("请把第三季度的销售报表发给我。")).toBe(false);
    expect(needsFullPolish("第一，先把预算批下来；第二，下周一启动招聘。")).toBe(true);
    expect(needsFullPolish("把报价单发给客户。约法务看一下合同。安排周四的供应商面谈。")).toBe(true);
    expect(needsFullPolish("嗯，明天开会")).toBe(true);
  });

  it("超时按字数放宽（与服务端同一条公式 + 400ms 余量），封顶 4.4 秒；逐句保持短", () => {
    expect(POLISH_REQUEST_TIMEOUT_MS).toBe(1600);
    expect(fullPolishTimeoutMs("好".repeat(10))).toBe(1640);
    expect(fullPolishTimeoutMs("好".repeat(100))).toBe(2000);
    expect(fullPolishTimeoutMs("好".repeat(2000))).toBe(4400);
  });

  it("POST {text, mode:\"full\"}，换行原样带回；超时（按字数）当原文", async () => {
    const listed = "下周有三件事。\n1. 签合同。\n2. 催回款。\n3. 对口径。";
    const fetcher = vi.fn().mockResolvedValue(Response.json({ text: listed, polished: true }));
    const job = startPolish("下周有三件事，第一个签合同，第二个催回款，第三个对口径。", fetcher as unknown as typeof fetch, globalThis, "full");
    expect(await job.result).toBe(listed);
    expect(JSON.parse((fetcher.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({ text: "下周有三件事，第一个签合同，第二个催回款，第三个对口径。", mode: "full" });

    const original = "嗯，下午三点开会。";
    const hanging = vi.fn(() => new Promise<Response>(() => {}));
    const slow = startPolish(original, hanging as unknown as typeof fetch, globalThis, "full");
    vi.advanceTimersByTime(POLISH_REQUEST_TIMEOUT_MS);
    await Promise.resolve();
    expect(slow.done).toBe(false);
    vi.advanceTimersByTime(fullPolishTimeoutMs(original) - POLISH_REQUEST_TIMEOUT_MS);
    expect(await slow.result).toBe(original);
  });

  it("取消：立刻当原文结束", async () => {
    const job = startPolish("嗯，下午三点开会。", vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch, globalThis, "full");
    job.abort();
    expect(await job.result).toBe("嗯，下午三点开会。");
  });
});
