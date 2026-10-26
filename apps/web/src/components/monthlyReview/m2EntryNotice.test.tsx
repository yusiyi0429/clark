import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { M2EntryNotice, inM2Window, m2EntryNotices } from "./M2EntryNotice";

const render = (available: boolean, now = new Date("2026-10-29T02:00:00Z")) => renderToStaticMarkup(<M2EntryNotice available={available} now={now} />);

describe("通知栏里去 M2 的入口卡", () => {
  it("M2 可用：一张「目标拆解与协作」卡，一行「复盘与拆解」，不出条数角标", () => {
    const html = render(true);
    expect(html).toContain('data-notice="m2-entry"');
    expect(html).toContain("目标拆解与协作");
    expect(html).toContain("复盘与拆解");
    expect(html).not.toContain("项待处理");
  });

  it("M2 不可用（没登录 M2、或没装 M2）：不出卡", () => {
    expect(render(false)).toBe("");
  });

  it("只在月末倒数第 3 天到次月 7 日出（公司时区）", () => {
    expect(render(true, new Date("2026-10-26T02:00:00Z"))).toBe("");
    expect(inM2Window(new Date("2026-10-28T15:59:00Z"))).toBe(false);
    expect(inM2Window(new Date("2026-10-28T16:00:00Z"))).toBe(true);
    expect(inM2Window(new Date("2026-11-07T15:59:00Z"))).toBe(true);
    expect(inM2Window(new Date("2026-11-07T16:00:00Z"))).toBe(false);
    expect(inM2Window(new Date("2027-02-26T02:00:00Z"))).toBe(true);
    expect(inM2Window(new Date("2027-02-25T02:00:00Z"))).toBe(false);
  });

  it("点那一行整页去 /m2/", () => {
    const go = vi.fn();
    m2EntryNotices(go)[0].onOpen?.(null);
    expect(go).toHaveBeenCalledWith("/m2/");
  });
});
