import { describe, expect, it } from "vitest";
import { clock } from "./NotificationRail";

/** H-03：通知栏时钟必须显示「9月18日」而不是「918」。 */
describe("notification rail clock", () => {
  it("把日期拼成「月+日」而不是裸数字", () => {
    const parts = clock(new Date("2026-09-18T02:30:00Z"));
    expect(parts.day).toBe("9月18日");
    expect(parts.time).toBe("10:30");
    expect(parts.weekday).toBe("星期五");
  });

  it("跟随 Asia/Shanghai 日期而不是 UTC 日期", () => {
    expect(clock(new Date("2026-09-18T20:00:00Z")).day).toBe("9月19日");
  });
});
