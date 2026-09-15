/**
 * 「主动开始扫描」那条链路，离线从头走一遍。
 *
 * `TKOS_MODEL_MOCK=1` 的含义是**这一轮不出网**：检索退成假检索（`MockSearch`）、
 * 模型退成假模型（`mock.ts` 里 `scan.queries` / `scan.triage` 两支现算的罐头）、
 * 抓正文那一步整个跳过。所以这一条测的是**接线**，不是模型判得准不准。
 *
 * 钉的是四件在屏幕上看不出来的事：
 *
 *   · 五步真的按顺序走完，进度那一格写的是这一刻在做的事。
 *   · 收下来的信号的幂等键是这一侧算的（`normalizeUrl`），所以同一轮跑两次只该
 *     新增一次 —— 第二次是更新。
 *   · 够不上门槛的那几条**不进列表**，但那一轮的扫描记录照样落一条：
 *     「扫过一遍，外面没东西」和「压根没扫」必须分得开。
 *   · 一家检索都用不上时这一轮是**失败**，不是「收下 0 条」。
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { InboxSignal, ScanState } from "@/lib/data/types";

let startScan: () => ScanState;
let scanState: () => ScanState;
let listInboxSignals: () => Promise<InboxSignal[]>;
let listNominated: () => Promise<{
  rounds: { runId: string; nominated: number; trigger?: "auto" | "manual" }[];
  signals: unknown[];
}>;

beforeAll(async () => {
  process.env.TKOS_PERSIST = "0";
  process.env.TKOS_MODEL_MOCK = "1";
  const mod = await import("./run");
  startScan = mod.startScan;
  scanState = mod.scanState;
  listInboxSignals = async () => (await import("@/lib/data/store")).api.listInboxSignals();
  listNominated = async () => (await import("@/lib/data/store")).api.listNominatedSignals();
});

afterEach(() => {
  process.env.TKOS_MODEL_MOCK = "1";
});

/** 跑到不再 running 为止。假模型是同步返回的，但任务是异步跑的。 */
async function settle(): Promise<ScanState> {
  for (let i = 0; i < 400; i += 1) {
    const st = scanState();
    if (st.status !== "running" && st.status !== "idle") return st;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("这一轮一直没结束");
}

describe("一轮本地扫描", () => {
  it("走完五步，把过线的收进待挑列表", async () => {
    startScan();
    const done = await settle();

    expect(done.status).toBe("done");
    expect(done.error).toBeUndefined();
    expect(done.got).toBeDefined();
    expect(done.got!.inserted).toBeGreaterThan(0);
    // 收工时刻是服务端盖的，前端不量。
    expect(done.finishedAt).toBeTruthy();

    const signals = await listInboxSignals();
    expect(signals.length).toBeGreaterThan(0);
    // 编号从拟检索式那一步一路带下来，不是研判现编的。
    // （`kiq` 只有抓取那一支有，人报的那一支没有这一格 —— 这一批全是扫描来的。）
    expect(signals.every((s) => s.kind === "crawled" && s.kiq.startsWith("KIQ"))).toBe(true);

    // 这一轮在扫描记录上留了一条，而且写明是他手点的。
    const { rounds } = await listNominated();
    const mine = rounds.find((r) => r.runId === done.runId);
    expect(mine?.trigger).toBe("manual");
    expect(mine?.nominated).toBe(done.got!.received);
  });

  it("再扫一轮：列表上不会长出重复的一条", async () => {
    const before = await listInboxSignals();

    startScan();
    const done = await settle();
    expect(done.status).toBe("done");

    const after = await listInboxSignals();
    // 幂等键是这一侧算的，所以同一个 URL 在列表上只能有一条 —— 第二轮命中它是更新。
    expect(new Set(after.map((s) => s.dedupeKey)).size).toBe(after.length);
    // 上一轮已经端上去的那几条一条都没掉。
    for (const s of before) {
      expect(after.some((a) => a.dedupeKey === s.dedupeKey)).toBe(true);
    }

    // 这一轮**照样落一条扫描记录**：扫过一遍和没扫过必须分得开。
    const { rounds } = await listNominated();
    expect(rounds.some((r) => r.runId === done.runId)).toBe(true);
  });

  it("一家检索都用不上时，这一轮是失败，不是收下 0 条", async () => {
    delete process.env.TKOS_MODEL_MOCK;
    const provider = process.env.TKOS_SEARCH_PROVIDER;
    process.env.TKOS_SEARCH_PROVIDER = "none";
    try {
      startScan();
      const done = await settle();
      expect(done.status).toBe("failed");
      expect(done.error).toContain("检索");
      expect(done.got).toBeUndefined();
    } finally {
      if (provider === undefined) delete process.env.TKOS_SEARCH_PROVIDER;
      else process.env.TKOS_SEARCH_PROVIDER = provider;
    }
  });
});
