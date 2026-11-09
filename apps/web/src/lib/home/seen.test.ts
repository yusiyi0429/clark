import { describe, expect, it } from "vitest";
import { seenKey, showUnseen, withSeen } from "./seen";

describe("蓝点「点了就藏」（25 条）", () => {
  const at = "2026-11-09T03:00:00Z";
  it("点了立刻不画：记成刚看过、停下时间没变，云端还说 unseen 也不画", () => {
    const marks = withSeen(new Map(), "sub", "c1", at);
    expect(marks.get(seenKey("sub", "c1"))).toBe(at);
    expect(showUnseen(true, marks, "sub", "c1", at)).toBe(false);
  });
  it("之后来了更新的停下又画；别的对象不受影响；云端说看过了就不画", () => {
    const marks = withSeen(new Map(), "sub", "c1", at);
    expect(showUnseen(true, marks, "sub", "c1", "2026-11-09T03:05:00Z")).toBe(true);
    expect(showUnseen(true, marks, "sub", "c2", at)).toBe(true);
    expect(showUnseen(true, marks, "project", "c1", at)).toBe(true);
    expect(showUnseen(false, new Map(), "sub", "c1", at)).toBe(false);
  });
  it("项目没有时间的记空串：之后任何有时间的新回复都算更新的", () => {
    const marks = withSeen(new Map(), "project", "p1", null);
    expect(showUnseen(true, marks, "project", "p1", null)).toBe(false);
    expect(showUnseen(true, marks, "project", "p1", at)).toBe(true);
  });
  it("刷新以后（这一页的记录没了）以云端的 unseen 为准", () => {
    expect(showUnseen(true, undefined, "sub", "c1", at)).toBe(true);
    expect(showUnseen(true, new Map(), "project", "p1", at)).toBe(true);
  });
});
