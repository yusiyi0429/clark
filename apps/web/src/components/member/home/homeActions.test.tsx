import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  <HomeActions battlefieldHref="/me/battlefields/growth" waitingReplies={0} today="2026-10-22" m2Available onBookMeeting={vi.fn()} onNavigate={vi.fn()} {...props} />,
);
/** 页面上看得到的字（去掉标签和 React 的文本分隔注释）。 */
const visible = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** 字里含 label 的那个按钮的整段 HTML。 */
const button = (html: string, label: string) => html.match(/<button[^>]*>.*?<\/button>/g)?.find((part) => visible(part).includes(label)) ?? "";

beforeEach(() => h.presses.clear());
afterEach(() => vi.unstubAllGlobals());

describe("等回复", () => {
  it("3 条已发出、1 条全回了：显示「等回复 2」，点进请求列表", () => {
    const sent = [sentItem("a"), sentItem("b", { recipientsDone: 1 }), sentItem("c", { recipientsDone: 2 })];
    expect(waitingReplyCount(sent)).toBe(2);
    const navigate = vi.fn();
    const html = render({ waitingReplies: waitingReplyCount(sent), onNavigate: navigate });
    expect(visible(html)).toContain("等回复 2");
    const target = {};
    h.presses.get("等回复2")!({ target });
    expect(navigate).toHaveBeenCalledWith("/me/requests", target);
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

  it("战场进展进第一个战场；没有战场就不显示", () => {
    const navigate = vi.fn();
    render({ onNavigate: navigate });
    const target = {};
    h.presses.get("战场进展")!({ target });
    expect(navigate).toHaveBeenCalledWith("/me/battlefields/growth", target);
    expect(visible(render({ battlefieldHref: null }))).not.toContain("战场进展");
  });

  it("四个按钮的顺序：约会议、等回复、战场进展、复盘", () => {
    expect(visible(render({ waitingReplies: 1 }))).toBe("约会议 等回复 1 战场进展 10 月复盘 10/29 开");
  });
});

describe("M 月复盘", () => {
  it("10/22 置灰，写「10/29 开」；10/29 可以点，进 M2", () => {
    const closed = button(render({ today: "2026-10-22" }), "复盘");
    expect(closed).toContain('disabled=""');
    expect(visible(closed)).toBe("10 月复盘 10/29 开");
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    const open = button(render({ today: "2026-10-29" }), "复盘");
    expect(visible(open)).toBe("10 月复盘");
    expect(open).not.toContain("disabled");
    h.presses.get("10 月复盘")!({ target: {} });
    expect(assign).toHaveBeenCalledWith("/m2/");
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
