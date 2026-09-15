/**
 * 纲领 payload 的形状校验。蛇形转驼峰只在这里发生一次（同 `inbox.ts`）。
 *
 * 这一层**只做形状**：域存不存在、有没有撞上已经交出去的回传，那些要读对象库，
 * 归 `commitmentsIntake`。
 */
import { describe, expect, it } from "vitest";

import { parseOmIntake } from "./om-intake";

const ok = () => ({
  period: {
    id: "PRD-2026-09",
    label: "2026 年 9 月",
    starts_on: "2026-09-01",
    ends_on: "2026-09-30",
  },
  company_outcome: { statement: "9 月底完成第一批灯塔交付", due_on: "2026-09-30" },
  domains: [
    {
      domain_id: "D-04",
      north_star: "首批 Agents 进入两个真实场景的日常使用",
      items: [
        { proposed: "A4 深研上线", tier: "acceptance" },
        { proposed: "A5 判断生成", tier: "required" },
      ],
    },
  ],
});

describe("parseOmIntake", () => {
  it("正常一份，转成驼峰", () => {
    const got = parseOmIntake(ok());
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.payload.period.startsOn).toBe("2026-09-01");
    expect(got.payload.companyOutcome.dueOn).toBe("2026-09-30");
    expect(got.payload.domains[0].items[1]).toEqual({ proposed: "A5 判断生成", tier: "required" });
  });

  it("tier 不写默认 acceptance —— 复盘 A2 说被裁时才补分层已经晚了，所以默认是「要验收的」", () => {
    const raw = ok();
    delete (raw.domains[0].items[0] as { tier?: string }).tier;
    const got = parseOmIntake(raw);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.payload.domains[0].items[0].tier).toBe("acceptance");
  });

  it.each([
    [null, "请求体不是一个对象。"],
    [{}, "period"],
    [{ ...ok(), domains: [] }, "一个域都没有"],
  ])("拒 %#", (raw, fragment) => {
    const got = parseOmIntake(raw);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain(fragment as string);
  });

  it("周期的起止日期反了要拒 —— 这个错会一路错到「还剩几天」", () => {
    const raw = ok();
    raw.period.ends_on = "2026-08-01";
    const got = parseOmIntake(raw);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("结束");
  });

  it("一个域一条 Mission 都没有要拒 —— 那不是纲领，是漏了", () => {
    const raw = ok();
    raw.domains[0].items = [];
    const got = parseOmIntake(raw);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("D-04");
  });

  it("north_star 空要拒：卡的第一节不能是空的（复盘 A1）", () => {
    const raw = ok();
    raw.domains[0].north_star = "  ";
    const got = parseOmIntake(raw);
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error).toContain("north_star");
  });
});
