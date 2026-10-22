import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * 成员左栏的空通知提示要算上请求那一组：只有一条请求时不能再写「暂时没有新通知」。
 * 没有 jsdom：useState 换成按调用顺序记账的版本，请求那一组（桩）渲染时报出条数，再渲染一次看结果（同 missionPlanCard.test）。
 */
const h = vi.hoisted(() => ({ states: [] as unknown[], index: 0, counts: null as { items: number; waitingReplies: number } | null }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = h.index++;
      if (!(index in h.states)) h.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [h.states[index], (next: unknown) => { h.states[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(h.states[index]) : next; }];
    },
  };
});
vi.mock("next/navigation", () => ({ usePathname: () => "/me", useSearchParams: () => null, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("./useMemberHome", () => ({
  useMemberHome: () => ({ tasks: [], notifications: [], meetings: [], unreadThreads: [], unreadMissionGroups: [], rounds: [], radar: null, weeklySync: null, homeError: null,
    refresh: vi.fn(), returnTask: vi.fn(), markSeen: vi.fn(), readRadarNotice: vi.fn(), settle: vi.fn() }),
}));
vi.mock("@/components/requests/RequestNotices", () => ({
  RequestNotices: ({ onCounts }: { onCounts?: (counts: { items: number; waitingReplies: number }) => void }) => {
    if (h.counts) onCounts?.(h.counts);
    return h.counts?.items ? <section>请求 填一下备案表</section> : null;
  },
}));

import { MemberWorkspace } from "./MemberWorkspace";

const render = () => { h.index = 0; return renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽" viewerId="sun" />); };

describe("成员左栏的空通知提示", () => {
  it("只有一条请求时不写「暂时没有新通知」；首页「等回复」跟着同一次报数", () => {
    h.states = [];
    h.counts = null;
    expect(render()).toContain("暂时没有新通知");
    h.counts = { items: 1, waitingReplies: 3 };
    render();
    const html = render();
    expect(html).toContain("请求 填一下备案表");
    expect(html).not.toContain("暂时没有新通知");
    expect(html.replace(/<!--.*?-->/g, "")).toMatch(/等回复<span[^>]*>3<\/span>/);
  });
});
