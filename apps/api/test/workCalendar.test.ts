import { describe, expect, it } from "vitest";
import { HOLIDAYS_2026, MAKEUP_2026, isWorkday, monthDays, weekOf } from "../src/workCalendar.js";

describe("工作日历", () => {
  it("平常的周一到周五是工作日，周末不是", () => {
    expect(isWorkday("2026-10-22")).toBe(true);
    expect(isWorkday("2026-10-24")).toBe(false);
    expect(isWorkday("2026-10-25")).toBe(false);
  });

  it("节假日表里每个日期都不是工作日，调休补班表里每个日期都是", () => {
    // 通知：放假 3+9+3+5+3+3+7=33 天，调休上班 1+2+1+2=6 天，且补班的都是周末
    expect(HOLIDAYS_2026).toHaveLength(33);
    expect(MAKEUP_2026).toHaveLength(6);
    for (const date of MAKEUP_2026) expect([0, 6]).toContain(new Date(`${date}T00:00:00Z`).getUTCDay());
    for (const date of HOLIDAYS_2026) expect(isWorkday(date), `${date} 放假`).toBe(false);
    for (const date of MAKEUP_2026) expect(isWorkday(date), `${date} 补班`).toBe(true);
  });

  it("国庆：10/1 到 10/7 放假（含周一到周三），10/10 周六补班", () => {
    expect(isWorkday("2026-10-05")).toBe(false);
    expect(isWorkday("2026-10-07")).toBe(false);
    expect(isWorkday("2026-10-08")).toBe(true);
    expect(isWorkday("2026-10-10")).toBe(true);
  });

  it("monthDays 列出整月每一天并标出工作日", () => {
    const days = monthDays("2026-10");
    expect(days).toHaveLength(31);
    expect(days[0]).toEqual({ date: "2026-10-01", workday: false });
    expect(days[9]).toEqual({ date: "2026-10-10", workday: true });
    expect(days[21]).toEqual({ date: "2026-10-22", workday: true });
    expect(days[30]).toEqual({ date: "2026-10-31", workday: false });
    expect(monthDays("2026-02")).toHaveLength(28);
  });

  it("weekOf 取周一到周日，周日算上一个周一开始的那周", () => {
    expect(weekOf("2026-10-25")).toEqual({ weekStart: "2026-10-19", weekEnd: "2026-10-25" });
    expect(weekOf("2026-10-19")).toEqual({ weekStart: "2026-10-19", weekEnd: "2026-10-25" });
    expect(weekOf("2026-10-22")).toEqual({ weekStart: "2026-10-19", weekEnd: "2026-10-25" });
    expect(weekOf("2026-12-31")).toEqual({ weekStart: "2026-12-28", weekEnd: "2027-01-03" });
  });
});
