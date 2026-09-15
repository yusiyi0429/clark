import { describe, expect, it } from "vitest";
import { formatLockDate, formatLockTime } from "./lockscreen-time";

describe("lock screen clock", () => {
  const reference = new Date(Date.UTC(2026, 8, 12, 0, 8));

  it("formats the time in the Tianshu operating timezone", () => {
    expect(formatLockTime(reference)).toBe("08:08");
  });

  it("formats a compact Chinese lock-screen date", () => {
    expect(formatLockDate(reference)).toBe("9月12日 · 星期六");
  });
});
