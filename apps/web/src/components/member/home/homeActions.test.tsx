import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TRequestListItem } from "@warmap/contracts";

/**
 * 成员首页左上的操作区。没有 jsdom：Button 换成原生按钮，按下的处理器按按钮上的字记下来，直接调。
 */
const h = vi.hoisted(() => ({ presses: new Map<string, (event: { target: unknown }) => void>() }));
vi.mock("ts-design/primitives", async () => {
  const { Children, isValidElement } = await vi.importActual<typeof import("react")>("react");
  const text = (node: ReactNode): string => Children.toArray(node).map((child) =>
    typeof child === "string" || typeof child === "number" ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? text(child.props.children) : "").join("");
  const Button = ({ children, onPress, isDisabled, variant, size: _size, ...props }: {
    children: ReactNode; onPress?: (event: { target: unknown }) => void; isDisabled?: boolean; variant?: string; size?: string;
  }) => {
    if (onPress) h.presses.set(text(children), onPress);
    return <button type="button" disabled={isDisabled} data-variant={variant} {...props}>{children}</button>;
  };
  return { Button };
});

import { HomeActions, reviewWindow } from "./HomeActions";
import { waitingReplyCount } from "@/components/requests/RequestNotices";

const sentItem = (id: string, extra: Partial<TRequestListItem> = {}): TRequestListItem => ({
  id, kind: "relay", title: `请求 ${id}`, status: "open", initiatorName: "孙铭泽", createdAt: "2026-10-20T02:00:00.000Z", sentAt: "2026-10-20T02:00:00.000Z",
  myStatus: null, recipientNames: ["林晓", "人豪"], recipientsDone: 0, openQuestions: 0, unread: false, ...extra,
});

const render = (props: Partial<Parameters<typeof HomeActions>[0]> = {}) => renderToStaticMarkup(
  <HomeActions waitingReplies={0} radarUnread={null} today="2026-10-22" m2Available onBookMeeting={vi.fn()} onNavigate={vi.fn()} {...props} />,
);
/** 页面上看得到的字（去掉标签和 React 的文本分隔注释）。 */
const visible = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** 字里含 label 的那个按钮的整段 HTML。 */
const button = (html: string, label: string) => html.match(/<button[^>]*>.*?<\/button>/g)?.find((part) => visible(part).includes(label)) ?? "";

beforeEach(() => h.presses.clear());

describe("等回复", () => {
  it("3 条已发出、1 条全回了：显示「等回复 2」，点进请求列表的「发出的」", () => {
    const sent = [sentItem("a"), sentItem("b", { recipientsDone: 1 }), sentItem("c", { recipientsDone: 2 })];
    expect(waitingReplyCount(sent)).toBe(2);
    const navigate = vi.fn();
    const html = render({ waitingReplies: waitingReplyCount(sent), onNavigate: navigate });
    expect(visible(html)).toContain("等回复 2");
    const target = {};
    h.presses.get("等回复2")!({ target });
    expect(navigate).toHaveBeenCalledWith("/me/requests?box=sent", target);
    // 来源只记路径：关闭列表时外壳按路径找回这颗按钮。
    expect(button(html, "等回复")).toContain('data-origin="/me/requests"');
  });

  it("草稿、已结束的不算；N 为 0 时只写「等回复」，没有角标", () => {
    expect(waitingReplyCount([sentItem("draft", { status: "draft" }), sentItem("done", { status: "done" })])).toBe(0);
    const html = render({ waitingReplies: 0 });
    expect(visible(html)).toContain("等回复");
    expect(visible(html)).not.toMatch(/等回复 \d/);
  });
});

describe("约会议与战场进展", () => {
  it("「＋ 约会议」是主按钮，排第一，按下打开建会抽屉", () => {
    const book = vi.fn();
    const html = render({ onBookMeeting: book });
    expect(visible(html).startsWith("约会议")).toBe(true);
    expect(button(html, "约会议")).toContain('data-variant="primary"');
    expect(button(html, "等回复")).not.toContain('data-variant="primary"');
    h.presses.get("约会议")!({ target: {} });
    expect(book).toHaveBeenCalledOnce();
  });

  it("战场进展一直在，进原来那张战场进展页", () => {
    const navigate = vi.fn();
    const html = render({ onNavigate: navigate });
    expect(button(html, "战场进展")).toContain('data-origin="/me/progress"');
    const target = {};
    h.presses.get("战场进展")!({ target });
    expect(navigate).toHaveBeenCalledWith("/me/progress", target);
  });

  it("按钮的顺序：约会议、等回复、战场进展、（雷达）、复盘", () => {
    expect(visible(render({ waitingReplies: 1 }))).toBe("约会议 等回复 1 战场进展 10 月复盘 10/29 开");
    expect(visible(render({ waitingReplies: 1, radarUnread: 0 }))).toBe("约会议 等回复 1 战场进展 雷达 10 月复盘 10/29 开");
  });
});

describe("雷达", () => {
  it("本人雷达没开（radarUnread 为 null）：不出雷达", () => {
    expect(visible(render({ radarUnread: null }))).not.toContain("雷达");
    expect(h.presses.has("雷达")).toBe(false);
  });

  it("开着、没有未读：只写「雷达」，没有红点；点进我的雷达页", () => {
    const navigate = vi.fn();
    const html = render({ radarUnread: 0, onNavigate: navigate });
    const radar = button(html, "雷达");
    expect(radar).toContain('data-origin="/me/radar"');
    expect(radar).not.toContain('role="img"');
    const target = {};
    h.presses.get("雷达")!({ target });
    expect(navigate).toHaveBeenCalledWith("/me/radar", target);
  });

  it("有未读信号：「雷达」后面一个红点（读屏读条数），不写数字", () => {
    const radar = button(render({ radarUnread: 3 }), "雷达");
    expect(radar).toMatch(/雷达<span class="[^"]*_unread_[^"]*" role="img" aria-label="3 条未读"><\/span>/);
    expect(visible(radar)).toBe("雷达");
  });
});

describe("操作区的样式", () => {
  it("上、左各留 4px：胶囊不贴着主区的圆角（主区圆角会裁掉溢出）", () => {
    const css = readFileSync(new URL("../../../styles/home-actions.module.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.actions \{[^}]*padding: 4px 0 0 4px;/);
    expect(css).toMatch(/\.unread \{[^}]*background: var\(--counter\);/);
  });
});

describe("M 月复盘", () => {
  it("10/22 是置灰的按钮，写「10/29 开」；10/29 是去 M2 的链接，样子同旁边的胶囊", () => {
    const closedHtml = render({ today: "2026-10-22" });
    const closed = button(closedHtml, "复盘");
    expect(closed).toContain('disabled=""');
    expect(visible(closed)).toBe("10 月复盘 10/29 开");
    expect(closedHtml).not.toContain("<a ");
    const openHtml = render({ today: "2026-10-29" });
    expect(button(openHtml, "复盘")).toBe("");
    const link = openHtml.match(/<a [^>]*>.*?<\/a>/)?.[0] ?? "";
    expect(link).toContain('href="/m2/"');
    expect(link).toMatch(/class="button button--sm button--tertiary [^"]*pill/);
    expect(visible(link)).toBe("10 月复盘");
  });

  it("窗口：本月倒数第 3 天到月底复盘本月，下月 1–7 日复盘上个月，其余时间写下次开的日子", () => {
    expect(reviewWindow("2026-10-22")).toEqual({ month: 10, opensOn: "10/29" });
    expect(reviewWindow("2026-10-28")).toEqual({ month: 10, opensOn: "10/29" });
    expect(reviewWindow("2026-10-29")).toEqual({ month: 10, opensOn: null });
    expect(reviewWindow("2026-10-31")).toEqual({ month: 10, opensOn: null });
    expect(reviewWindow("2026-11-01")).toEqual({ month: 10, opensOn: null });
    expect(reviewWindow("2026-11-07")).toEqual({ month: 10, opensOn: null });
    expect(reviewWindow("2026-11-08")).toEqual({ month: 11, opensOn: "11/28" });
    expect(reviewWindow("2027-01-03")).toEqual({ month: 12, opensOn: null });
    expect(reviewWindow("2027-02-10")).toEqual({ month: 2, opensOn: "2/26" });
    expect(reviewWindow("2028-02-26")).toEqual({ month: 2, opensOn: "2/27" });
    expect(reviewWindow("2028-02-27")).toEqual({ month: 2, opensOn: null });
  });

  it("M2 不可用、或计划还没读到今天，不显示复盘", () => {
    expect(visible(render({ m2Available: false }))).not.toContain("复盘");
    expect(visible(render({ today: null }))).not.toContain("复盘");
  });
});
