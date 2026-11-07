import { describe, expect, it } from "vitest";
import { quotaRows, toneOf, type QuotaSourceLike } from "./quota";

const now = new Date(2026, 10, 7, 6, 0).getTime();
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
const source = (patch: Partial<QuotaSourceLike> = {}): QuotaSourceLike => ({
  source: "claude_subscription",
  windows: [
    { kind: "session", model: null, usedPercent: 83, state: "warning", resetsAt: at(2) },
    { kind: "weekly_all", model: null, usedPercent: 40, state: "ok", resetsAt: at(72) },
  ],
  blockedUntil: null, extraUsage: false, updatedAt: new Date(now).toISOString(), ...patch,
});

describe("右栏额度行（5.4.5）", () => {
  it("一个来源一行，取剩得最少的窗口：剩 17% · 08:00 重置，≤25% 琥珀", () => {
    const [row] = quotaRows([source()], now);
    expect(row).toMatchObject({ name: "Claude 订阅", amount: "剩 17%", resets: "08:00", left: 17, tone: "warning", stale: null });
    expect(row!.details).toEqual(["5 小时 · 剩 17% · 08:00 重置", "本周 · 剩 60% · 11/10 06:00 重置", "额外额度 · 未开"]);
  });

  it("用完写「用完」、到恢复时刻，红；超过 15 分钟没更新写几分钟前", () => {
    const [row] = quotaRows([source({ blockedUntil: at(2), updatedAt: new Date(now - 20 * 60_000).toISOString(),
      windows: [{ kind: "session", model: null, usedPercent: 100, state: "blocked", resetsAt: at(2) }] })], now);
    expect(row).toMatchObject({ amount: "用完", resets: "08:00", left: 0, tone: "danger", stale: "20 分钟前" });
  });

  it("云端报的别的设备：名字带设备名，读不到额外额度就不写那一行", () => {
    const [row] = quotaRows([source({ device: "ThinkPad", extraUsage: null })], now);
    expect(row!.name).toBe("Claude 订阅 · ThinkPad");
    expect(row!.details).toEqual(["5 小时 · 剩 17% · 08:00 重置", "本周 · 剩 60% · 11/10 06:00 重置"]);
  });

  it("还没读到窗口的不画；色阶 ≤10% 红、≤25% 琥珀", () => {
    expect(quotaRows([source({ windows: [] })], now)).toEqual([]);
    expect([toneOf(60, false), toneOf(25, false), toneOf(10, false), toneOf(50, true)]).toEqual(["ok", "warning", "danger", "danger"]);
  });
});
