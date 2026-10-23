import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** 请求列表先打开哪一段：成员页认 ?box=sent（首页「等回复」进来），其余都是「收到的」；CEO 的列表不变。 */
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ close: vi.fn(), navigate: vi.fn() }), useRegisterDetail: vi.fn() }));
vi.mock("@/components/shell/DetailFrame", () => ({ DetailFrame: ({ title, children }: { title: string; children?: ReactNode }) => <main><h1>{title}</h1>{children}</main> }));
vi.mock("@/lib/api/server", () => ({ requireMember: vi.fn(async () => ({ cookie: "", session: {} })) }));

import { RequestListPanel, RequestListScreen } from "./RequestListScreen";
import MyRequestsPage from "@/app/(member)/me/requests/page";

/** 选中的那一段的字。 */
const selected = (html: string) => html.match(/<button[^>]*aria-checked="true"[^>]*>(.*?)<\/button>/)?.[1];
const page = async (box?: string | string[]) => renderToStaticMarkup(await MyRequestsPage({ searchParams: Promise.resolve({ box }) }));

describe("请求列表先打开哪一段", () => {
  it("不给时是「收到的」（CEO 列表照旧），给 sent 时是「发出的」", () => {
    expect(selected(renderToStaticMarkup(<RequestListScreen base="/requests" />))).toBe("收到的");
    expect(selected(renderToStaticMarkup(<RequestListScreen base="/me/requests" initialBox="sent" />))).toBe("发出的");
  });

  it("成员页：?box=sent 先开「发出的」；没有参数或别的值都开「收到的」", async () => {
    expect(selected(await page("sent"))).toBe("发出的");
    expect(selected(await page())).toBe("收到的");
    expect(selected(await page("other"))).toBe("收到的");
    expect(selected(await page(["sent", "inbox"]))).toBe("收到的");
  });
});

describe("首页「等回复」的请求面板", () => {
  /** 面板里那张列表的 props（函数调用展开到 DetailFrame 里的列表）。 */
  type Node = { type?: unknown; props: { children?: Node; initialBox?: string; onNavigate?: (href: string) => void } };
  const list = (onClose: () => void, onNavigate: (href: string) => void) =>
    ((RequestListPanel({ open: true, onClose, base: "/me/requests", onNavigate }) as unknown as Node).props.children!.props.children!.props.children!).props;

  it("先开「发出的」；点一行（或新请求）先收起面板，再进详情", () => {
    const calls: string[] = [];
    const props = list(() => calls.push("close"), (href) => calls.push(href));
    expect(props.initialBox).toBe("sent");
    props.onNavigate!("/me/requests/r-1");
    expect(calls).toEqual(["close", "/me/requests/r-1"]);
  });
});
