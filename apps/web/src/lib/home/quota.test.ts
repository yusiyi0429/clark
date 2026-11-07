import { describe, expect, it } from "vitest";
import { money, toneOf, usageCells, type UsageSourceLike } from "./quota";

const now = new Date(2026, 10, 7, 6, 0).getTime();
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
const claude = (patch: Partial<UsageSourceLike> = {}): UsageSourceLike => ({
  id: "claude", name: "Claude", kind: "subscription", remainingPercent: 17, amounts: [],
  windows: [
    { kind: "session", model: null, usedPercent: 83, state: "warning", resetsAt: at(2) },
    { kind: "weekly_all", model: null, usedPercent: 40, state: "ok", resetsAt: at(72) },
  ],
  blockedUntil: null, extraUsage: false, updatedAt: new Date(now).toISOString(), ...patch,
});

describe("右栏用量格子（14.4）", () => {
  it("订阅一格：圆环用剩的百分比，≤25% 琥珀；明细每个窗口一行", () => {
    const [cell] = usageCells([claude()], now);
    expect(cell).toMatchObject({ name: "Claude", percent: 17, value: "17%", tone: "warning", stale: false });
    expect(cell!.tip.split("\n")).toEqual(["5 小时：剩 17% · 08:00 重置", "本周：剩 60% · 11/10 06:00 重置", "额外额度：未开"]);
  });

  it("用完写「用完」、红，明细带恢复时刻；超过 15 分钟没更新标出来", () => {
    const [cell] = usageCells([claude({ blockedUntil: at(2), remainingPercent: 0, updatedAt: new Date(now - 20 * 60_000).toISOString(),
      windows: [{ kind: "session", model: null, usedPercent: 100, state: "blocked", resetsAt: at(2) }] })], now);
    expect(cell).toMatchObject({ value: "用完", percent: 0, tone: "danger", stale: true });
    expect(cell!.tip).toContain("08:00 恢复");
    expect(cell!.tip).toContain("20 分钟前更新");
  });

  it("TokenHub 当天花费、API 余额：「¥」一格，写金额，不上色", () => {
    const cells = usageCells([
      { id: "tokenhub:x", name: "TokenHub", kind: "daily_spend", remainingPercent: null, amounts: [{ amount: 12.43, currency: "CNY" }],
        monthAmounts: [{ amount: 186, currency: "CNY" }], windows: [], blockedUntil: null, updatedAt: new Date(now).toISOString() },
      { id: "api:deepseek", name: "DeepSeek", kind: "api_balance", remainingPercent: null, amounts: [{ amount: 86, currency: "CNY" }], windows: [], blockedUntil: null, updatedAt: new Date(now).toISOString() },
    ], now);
    expect(cells.map((cell) => [cell.name, cell.percent, cell.value, cell.tone])).toEqual([["TokenHub", null, "¥12.4", "ok"], ["DeepSeek", null, "¥86", "ok"]]);
    expect(cells[0]!.tip).toBe("今天花了 ¥12.4\n本月 ¥186");
    expect(cells[1]!.tip).toBe("余额 ¥86");
  });

  it("云端报的别的设备：名字带设备名；还没读到的不画；色阶 ≤10% 红、≤25% 琥珀", () => {
    expect(usageCells([claude({ device: "ThinkPad", remainingPercent: null })], now)[0]).toMatchObject({ name: "Claude · ThinkPad", value: "17%" });
    expect(usageCells([claude({ windows: [], remainingPercent: null })], now)).toEqual([]);
    expect(usageCells([{ ...claude(), kind: "daily_spend", updatedAt: null }], now)).toEqual([]);
    expect([toneOf(60, false), toneOf(25, false), toneOf(10, false), toneOf(50, true)]).toEqual(["ok", "warning", "danger", "danger"]);
    expect(money([])).toBe("¥0");
  });
});
