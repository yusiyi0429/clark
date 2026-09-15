/**
 * 节奏算法本身。**不碰 store**，所以这个文件里没有那两行环境变量。
 *
 * 钉住的是三件「坏掉也全绿」的事：中位数被写回平均数、轮次不够却硬报一个数、
 * 以及最要紧的那一条 —— **没有 `trigger` 的老记录被当成自动的**。
 */
import { describe, expect, it } from "vitest";

import type { ScanRound } from "@/lib/data/types";
import { formatScanCadence, scanCadence } from "./cadence";

/** 一条扫描记录。`scannedAt` 给的是「距 `T0` 多少小时」，读起来比一串 ISO 直观。 */
const T0 = Date.parse("2026-08-20T00:00:00Z");
const at = (hoursFromT0: number) => new Date(T0 + hoursFromT0 * 3_600_000).toISOString();
const round = (hoursFromT0: number, trigger?: "auto" | "manual"): ScanRound => ({
  runId: `r-${hoursFromT0}`,
  scannedAt: at(hoursFromT0),
  nominated: 0,
  at: at(hoursFromT0),
  ...(trigger ? { trigger } : {}),
});

describe("scanCadence", () => {
  it("间隔取中位数，不是平均数 —— 漏跑的那一轮不该把周期拖长", () => {
    // 间隔 24 / 24 / 72（中间漏跑了两天）。平均 40，中位 24。
    const c = scanCadence([round(0, "auto"), round(24, "auto"), round(48, "auto"), round(120, "auto")]);
    expect(c.counted).toBe(4);
    expect(c.medianHours).toBe(24);
  });

  it("偶数个间隔取中间两个的平均", () => {
    // 间隔 10 / 20 / 30 / 40 —— 中间两个是 20 和 30。
    const c = scanCadence([
      round(0, "auto"),
      round(10, "auto"),
      round(30, "auto"),
      round(60, "auto"),
      round(100, "auto"),
    ]);
    expect(c.medianHours).toBe(25);
  });

  it("不到三轮自动记录就不报周期 —— 一个间隔不是节奏", () => {
    expect(scanCadence([round(0, "auto"), round(24, "auto")]).medianHours).toBeNull();
    // 但「上一轮什么时候」照样说得出来，它不需要攒。
    expect(scanCadence([round(0, "auto"), round(24, "auto")]).lastAt).toBe(at(24));
  });

  /*
   * 这一条是整份改动的地基。
   *
   * 库里已有的历史轮次没有 `trigger` 这一格，它们的真实来路我们不知道；而他在屏幕上
   * 连点两下「主动开始扫描」也会各落一条账。把「不知道」当成自动，算出来的节奏就是
   * 几分钟一轮 —— 那比不说更坏，因为它看起来像个答案。
   *
   * 所以这里同时钉两头：混进来的那些一条都不许进 `counted`，而且**光看 counted 不够** ——
   * 中位数必须还是纯自动那三轮的 24 小时，不能被中间那几条几分钟的记录拉下来。
   */
  it("没有 trigger 的老记录和手点的那几轮都不算节奏", () => {
    const c = scanCadence([
      round(0, "auto"),
      round(0.1), // 老记录，来路不明
      round(0.2, "manual"), // 他手点的
      round(0.3, "manual"),
      round(24, "auto"),
      round(48, "auto"),
    ]);
    expect(c.counted).toBe(3);
    expect(c.medianHours).toBe(24);
  });

  it("一条自动的都没有：说不出节奏，但上一轮是谁起的不影响「上次什么时候」", () => {
    const c = scanCadence([round(0, "manual"), round(5), round(9, "manual")]);
    expect(c.counted).toBe(0);
    expect(c.medianHours).toBeNull();
    // 最近那一轮是手点的，它照样是「上次扫的时间」。
    expect(c.lastAt).toBe(at(9));
  });

  it("最近一轮取全部轮次里最晚的那一条，和台账的存放顺序无关", () => {
    // 故意乱序，而且最晚的那一条是手点的。
    const c = scanCadence([round(48, "auto"), round(96, "manual"), round(0, "auto"), round(24, "auto")]);
    expect(c.lastAt).toBe(at(96));
  });

  it("一轮都没有", () => {
    expect(scanCadence([])).toEqual({ counted: 0, medianHours: null, lastAt: null });
  });
});

describe("formatScanCadence", () => {
  const now = T0 + 100 * 3_600_000;

  it("算得出节奏时三样都说", () => {
    const s = formatScanCadence({ counted: 12, medianHours: 23.4, lastAt: at(97) }, now);
    expect(s).toBe("最近 12 轮 · 约每 23 小时一轮 · 上一轮 3 小时前");
  });

  it("算不出节奏时只说上一轮什么时候，后面不跟任何解释", () => {
    const s = formatScanCadence({ counted: 2, medianHours: null, lastAt: at(97) }, now);
    expect(s).toBe("上一轮 3 小时前");
  });

  it("一轮都没有就一个字都不说 —— 那一行整个不渲染", () => {
    expect(formatScanCadence({ counted: 0, medianHours: null, lastAt: null }, now)).toBe("");
  });

  it("不足一小时的节奏写成分钟，屏幕上不出现「约每 0 小时一轮」", () => {
    const s = formatScanCadence({ counted: 5, medianHours: 0.5, lastAt: at(99.9) }, now);
    expect(s).toBe("最近 5 轮 · 约每 30 分钟一轮 · 上一轮 6 分钟前");
  });

  it("跨过两天改说天", () => {
    const s = formatScanCadence({ counted: 4, medianHours: 24, lastAt: at(0) }, now);
    expect(s).toBe("最近 4 轮 · 约每 24 小时一轮 · 上一轮 4 天前");
  });
});
