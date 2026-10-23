import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TRequestListItem } from "@warmap/contracts";

/**
 * 通知栏里的请求一组：成员左栏不要「请求」页头和 ＋，只列通知条目；列出的条数和发出的请求里还在等回复的条数报出去
 * （成员左栏的空通知提示、首页操作区「等回复 N」用）。
 * 没有 jsdom：useState/useEffect 换成按调用顺序记账的版本，读完再渲染一次（同 useMemberHome.test）。
 */
const h = vi.hoisted(() => ({ states: [] as unknown[], index: 0, effects: [] as (() => unknown)[], api: { GET: vi.fn() } }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = h.index++;
      if (!(index in h.states)) h.states[index] = initial;
      return [h.states[index], (next: unknown) => { h.states[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(h.states[index]) : next; }];
    },
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => unknown) => void h.effects.push(effect),
  };
});
vi.mock("@heroui/react", () => ({
  Card: Object.assign(({ children, render: _render, ...props }: { children?: ReactNode; render?: unknown }) => <section {...props}>{children}</section>,
    { Header: ({ children, render: _render, ...props }: { children?: ReactNode; render?: unknown }) => <header {...props}>{children}</header> }),
}));
vi.mock("@/lib/api/client", () => ({ browserApi: h.api }));

import { RequestNotices } from "./RequestNotices";

const item = (id: string, extra: Partial<TRequestListItem> = {}): TRequestListItem => ({
  id, kind: "relay", title: `请求 ${id}`, status: "open", initiatorName: "林晓", createdAt: "2026-10-20T02:00:00.000Z", sentAt: "2026-10-20T02:00:00.000Z",
  myStatus: null, recipientNames: ["人豪"], recipientsDone: 0, openQuestions: 0, unread: false, ...extra,
});
const inbox = [item("收到待办", { myStatus: "pending" })];
const sent = [item("有问题", { openQuestions: 1 }), item("等人回"), item("都回了", { recipientsDone: 1, unread: true })];

/** 渲染一次、跑完这次登记的 effect、等读取落定，再渲染出读完的样子。 */
async function rendered(props: Partial<Parameters<typeof RequestNotices>[0]> = {}) {
  const view = () => { h.index = 0; h.effects = []; return renderToStaticMarkup(<RequestNotices base="/me/requests" onNavigate={vi.fn()} {...props} />); };
  view();
  h.effects.forEach((effect) => effect());
  await vi.waitFor(() => expect(h.api.GET).toHaveBeenCalledTimes(4));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const html = view();
  h.effects.forEach((effect) => effect());
  return html;
}

beforeEach(() => {
  h.states = [];
  vi.clearAllMocks();
  h.api.GET.mockImplementation(async (_path: string, init: { params: { query: { box: string } } }) => ({ data: { items: init.params.query.box === "inbox" ? inbox : sent } }));
  vi.stubGlobal("window", { setInterval: vi.fn(), clearInterval: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { visibilityState: "visible" });
});
afterEach(() => vi.unstubAllGlobals());

describe("通知栏里的请求", () => {
  it("CEO 照旧：页头「请求」可进列表，右上角 ＋ 发起新请求", async () => {
    const html = await rendered();
    expect(html).toContain('aria-label="打开请求列表"');
    expect(html).toContain('aria-label="新请求"');
    expect(html).toContain("请求 收到待办");
  });

  it("成员左栏：没有「请求」页头和 ＋，收到的待办、有问题的、有人完成没看的照样列出", async () => {
    const html = await rendered({ header: false });
    expect(html).not.toContain("<header");
    expect(html).not.toContain('aria-label="打开请求列表"');
    expect(html).not.toContain('aria-label="新请求"');
    for (const title of ["请求 收到待办", "请求 有问题", "请求 都回了"]) expect(html).toContain(title);
    expect(html).not.toContain("请求 等人回");
  });

  it("成员左栏没有要看的请求时整组不出现", async () => {
    h.api.GET.mockImplementation(async () => ({ data: { items: [] } }));
    expect(await rendered({ header: false })).toBe("");
  });

  it("读完报出列出的条数（请求加影响）和还在等回复的条数（开着、还有人没完成的）", async () => {
    h.api.GET.mockImplementation(async (_path: string, init: { params: { query: { box: string } } }) => ({ data: { items: init.params.query.box === "inbox"
      ? [...inbox, item("会后影响", { kind: "impact", myStatus: "pending" })] : sent } }));
    const report = vi.fn();
    const html = await rendered({ header: false, onCounts: report });
    expect(html).toContain("请求 会后影响");
    expect(report).toHaveBeenLastCalledWith({ items: 4, waitingReplies: 2 });
  });
});
