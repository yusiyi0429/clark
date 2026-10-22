import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

const ui = vi.hoisted(() => ({ presses: new Map<string, (event: { target: HTMLElement }) => void>() }));
vi.mock("@/components/HeroButton", () => ({ HeroButton: ({ children, onPress, isDisabled, isIconOnly: _icon, variant: _variant, size: _size, ...props }: { children?: ReactNode; onPress?: (event: { target: HTMLElement }) => void; isDisabled?: boolean; isIconOnly?: boolean; variant?: string; size?: string; "aria-label"?: string }) => {
  if (onPress && props["aria-label"]) ui.presses.set(props["aria-label"], onPress);
  return <button {...props} disabled={isDisabled}>{children}</button>;
} }));
const home = vi.hoisted(() => ({ radar: null as unknown }));
vi.mock("./useMemberHome", () => ({
  useMemberHome: () => ({ tasks: [], notifications: [], meetings: [], unreadThreads: [], unreadMissionGroups: [], rounds: [], radar: home.radar, homeError: null, refresh: vi.fn(), busyId: null, setStatus: vi.fn(), returnTask: vi.fn(), markSeen: vi.fn(), readRadarNotice: vi.fn().mockResolvedValue(true), settle: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/me", useSearchParams: () => null, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { MemberRadarNotices, noteworthySignals } from "./MemberRadarNotices";
import { MemberWorkspace } from "./MemberWorkspace";
import type { MemberRadarBrief, PersonalSignalBrief } from "@/components/radar/personalRadar";

function signal(index: number, patch: Partial<PersonalSignalBrief> = {}): PersonalSignalBrief {
  return {
    id: `0f0f0f0f-0000-4000-8000-00000000000${index}`,
    source: { type: "web", label: index === 1 ? "36kr.com" : "金融时报", title: `第 ${index} 条标题`, url: `https://example.com/${index}`, publishedAt: "2026-09-27T03:00:00.000Z", listedOn: null, listing: null },
    direction: { id: "d_1", text: "Agent 的定价方式" },
    summary: `第 ${index} 条总结`, reason: `第 ${index} 条的理由`, relevance: 5,
    state: { read: false, saved: false, dismissed: false }, collectedAt: "2026-09-27T04:00:00.000Z",
    ...patch,
  };
}
const completed = { trigger: "scheduled" as const, status: "completed" as const, completedAt: "2026-09-27T03:48:00.000Z", createdSignals: 3, warnings: [] };
const brief = (patch: Partial<MemberRadarBrief> = {}): MemberRadarBrief => ({ lastRun: completed, unreadCount: 2, highlights: [signal(1), signal(2)], ...patch });

beforeEach(() => { ui.presses.clear(); home.radar = null; });

describe("成员首页不放雷达小卡", () => {
  it("雷达开着也只在左栏出值得注意的信号，首页主区没有雷达卡", () => {
    home.radar = brief({ highlights: [signal(1)] });
    const html = renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽" />);
    expect(html).not.toContain("雷达信号");
    expect(html).not.toContain('data-origin="/me/radar"');
    expect(html).toContain("雷达 · 值得注意");
  });
});

describe("雷达值得注意的通知", () => {
  it("只选未读且相关度 5 的个人信号；空时不显示通知组", () => {
    const radar = brief({ highlights: [signal(1), signal(2, { relevance: 4 }), signal(3, { state: { read: true, saved: false, dismissed: false } })] });
    expect(noteworthySignals(radar).map((item) => item.id)).toEqual([signal(1).id]);
    expect(noteworthySignals(null)).toEqual([]);
    expect(renderToStaticMarkup(<MemberRadarNotices signals={[]} onNavigate={vi.fn()} onRead={vi.fn()} />)).toBe("");
  });

  it("每条写标题与来源，标记已读后从通知直达阅读页", async () => {
    const navigate = vi.fn();
    const onRead = vi.fn().mockResolvedValue(true);
    const html = renderToStaticMarkup(<MemberRadarNotices signals={[signal(1)]} onNavigate={navigate} onRead={onRead} />);
    expect(html).toContain("雷达 · 值得注意");
    expect(html).toContain("第 1 条标题");
    expect(html).toContain("36kr.com");
    expect(html).toContain('data-origin="/me/radar/signals/0f0f0f0f-0000-4000-8000-000000000001"');
    const origin = {} as HTMLElement;
    const target = { closest: vi.fn(() => origin) } as unknown as HTMLElement;
    ui.presses.get("阅读：第 1 条标题")!({ target });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(onRead).toHaveBeenCalledWith(signal(1).id);
    expect(navigate).toHaveBeenCalledWith("/me/radar/signals/0f0f0f0f-0000-4000-8000-000000000001", origin);
  });

  it("有值得注意的信号时不显示空通知提示，读过后恢复提示", () => {
    home.radar = brief({ highlights: [signal(1)] });
    const active = renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽" />);
    expect(active).toContain("雷达 · 值得注意");
    expect(active).not.toContain("暂时没有新通知");
    home.radar = brief({ highlights: [signal(1, { state: { read: true, saved: false, dismissed: false } })] });
    const read = renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽" />);
    expect(read).not.toContain("雷达 · 值得注意");
    expect(read).toContain("暂时没有新通知");
  });
});
