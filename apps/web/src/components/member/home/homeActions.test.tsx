import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TRequestListItem } from "@warmap/contracts";

/**
 * 成员首页的快捷卡。没有 jsdom：Button 换成原生按钮，按下的处理器按按钮上的字记下来，直接调。
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

import { HomeActions } from "./HomeActions";
import { waitingReplyCount } from "@/components/requests/RequestNotices";

const sentItem = (id: string, extra: Partial<TRequestListItem> = {}): TRequestListItem => ({
  id, kind: "relay", title: `请求 ${id}`, status: "open", initiatorName: "孙铭泽", createdAt: "2026-10-20T02:00:00.000Z", sentAt: "2026-10-20T02:00:00.000Z",
  myStatus: null, recipientNames: ["林晓", "人豪"], recipientsDone: 0, openQuestions: 0, unread: false, ...extra,
});

const render = (props: Partial<Parameters<typeof HomeActions>[0]> = {}) => renderToStaticMarkup(
  <HomeActions waitingReplies={0} radarUnread={null} onBookMeeting={vi.fn()} onOpenRequests={vi.fn()} onNavigate={vi.fn()} {...props} />,
);
/** 页面上看得到的字（去掉标签和 React 的文本分隔注释）。 */
const visible = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** 字里含 label 的那个按钮的整段 HTML。 */
const button = (html: string, label: string) => html.match(/<button[^>]*>.*?<\/button>/g)?.find((part) => visible(part).includes(label)) ?? "";

beforeEach(() => h.presses.clear());

describe("等回复", () => {
  it("3 条已发出、1 条全回了：显示「等回复 2」，按下在右侧打开请求面板（带上这颗键），不跳二级页", () => {
    const sent = [sentItem("a"), sentItem("b", { recipientsDone: 1 }), sentItem("c", { recipientsDone: 2 })];
    expect(waitingReplyCount(sent)).toBe(2);
    const navigate = vi.fn();
    const openRequests = vi.fn();
    const html = render({ waitingReplies: waitingReplyCount(sent), onNavigate: navigate, onOpenRequests: openRequests });
    expect(visible(html)).toContain("等回复 2");
    const target = {};
    h.presses.get("等回复2")!({ target });
    expect(openRequests).toHaveBeenCalledWith(target);
    expect(navigate).not.toHaveBeenCalled();
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

  it("方块的顺序：约会议、等回复、战场进展、（雷达）；没有复盘格（M2 入口在通知栏）", () => {
    expect(visible(render({ waitingReplies: 1 }))).toBe("约会议 等回复 1 战场进展");
    expect(visible(render({ waitingReplies: 1, radarUnread: 0 }))).toBe("约会议 等回复 1 战场进展 雷达");
  });

  it("每格都是同一种方块，没有去 M2 的链接", () => {
    const html = render({ radarUnread: 0 });
    for (const label of ["约会议", "等回复", "战场进展", "雷达"]) expect(button(html, label)).toMatch(/class="[^"]*_tile_/);
    expect(html.match(/_tile_/g)).toHaveLength(4);
    expect(html).not.toContain("/m2/");
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
