import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { M2EntryNotice, inM2Window, m2EntryNotices, m2NotificationNotices, visibleM2Notifications } from "./M2EntryNotice";

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

  it("M2 通知：认得的四种照接口显示；环节卡完成又看过的不显示；出错、空、不是列表都当没有", () => {
    const body = { items: [
      { id: "stage:review", type: "stage", title: "10 月复盘已出", text: "", link: "?stage=review", status: "open", dueAt: "2026-10-30T10:00:00Z", unread: true },
      { id: "stage:plan", type: "stage", title: "计划已全部确认", link: "?stage=plan", status: "done", unread: false },
      { id: "todo:review", type: "todo", title: "10 月复盘：你有待办", text: "1 份待确认、2 个追问待回答", link: "?stage=review&todo=1&card=rv%3Abf01-m1", dueAt: "2026-10-30T10:00:00Z", unread: false },
      { id: "mention:bf01", type: "mention", title: "灯塔群：2 条消息与你有关", text: "Nexus：因为写回接口还没上线。", link: "?scope=bf01&message=m-nexus", unread: true },
      { id: "failure:round", type: "failure", title: "拆解生成失败", link: "?admin=1" },
      { id: "x", type: "other", title: "不认得", link: "?" },
    ], at: "2026-10-29T02:00:00Z" };
    expect(visibleM2Notifications(body).map((item) => item.id)).toEqual(["stage:review", "todo:review", "mention:bf01", "failure:round"]);
    expect(visibleM2Notifications({ items: [], error: "通知暂时取不到" })).toEqual([]);
    expect(visibleM2Notifications(null)).toEqual([]);
    expect(visibleM2Notifications("<html>404</html>")).toEqual([]);

    const go = vi.fn();
    const notices = m2NotificationNotices(visibleM2Notifications(body), go, new Date("2026-10-29T02:00:00Z"));
    expect(notices.map((notice) => [notice.title, notice.detail, notice.tone])).toEqual([
      ["10 月复盘已出", "截止 10/30 周五", "amber"],
      ["10 月复盘：你有待办", "1 份待确认、2 个追问待回答 · 截止 10/30 周五", "amber"],
      ["灯塔群：2 条消息与你有关", "Nexus：因为写回接口还没上线。", "amber"],
      ["拆解生成失败", "", "red"],
    ]);
    // 离截止不到一天标红。
    expect(m2NotificationNotices(visibleM2Notifications(body), go, new Date("2026-10-29T12:00:00Z"))[1].tone).toBe("red");
    notices[2].onOpen?.(null);
    expect(go).toHaveBeenCalledWith("/m2/?scope=bf01&message=m-nexus");
  });
});
