import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

const ui = vi.hoisted(() => ({ presses: new Map<string, (event: { target: HTMLElement }) => void>() }));
vi.mock("@/components/HeroButton", () => ({ HeroButton: ({ children, onPress, isDisabled, isIconOnly: _icon, variant: _variant, size: _size, ...props }: { children?: ReactNode; onPress?: (event: { target: HTMLElement }) => void; isDisabled?: boolean; isIconOnly?: boolean; variant?: string; size?: string; "aria-label"?: string }) => {
  if (onPress && props["aria-label"]) ui.presses.set(props["aria-label"], onPress);
  return <button {...props} disabled={isDisabled}>{children}</button>;
} }));
const home = vi.hoisted(() => ({ radar: null as unknown }));
vi.mock("./useMemberHome", () => ({
  useMemberHome: () => ({ tasks: [], notifications: [], rounds: [], work: { period: "2026-10", planStatus: "confirmed", battlefields: [], missions: [], missionCards: [] }, radar: home.radar, homeError: null, refresh: vi.fn(), busyId: null, taskError: null, setStatus: vi.fn(), returnTask: vi.fn(), markSeen: vi.fn(), settle: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/me", useSearchParams: () => null, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { MemberRadarWidget } from "./MemberRadarWidget";
import { MemberWorkspace } from "./MemberWorkspace";
import type { MemberRadarBrief, PersonalSignalBrief } from "@/components/radar/personalRadar";

const NOW = new Date("2026-09-27T04:00:00.000Z");
function signal(index: number, patch: Partial<PersonalSignalBrief> = {}): PersonalSignalBrief {
  return {
    id: `0f0f0f0f-0000-4000-8000-00000000000${index}`,
    source: { type: "web", label: index === 1 ? "36kr.com" : "金融时报", title: `第 ${index} 条标题`, url: `https://example.com/${index}`, publishedAt: new Date(NOW.getTime() - index * 3_600_000).toISOString(), listedOn: null, listing: null },
    direction: { id: "d_1", text: "Agent 的定价方式" },
    summary: `第 ${index} 条总结`,
    reason: `第 ${index} 条的理由`,
    relevance: 5,
    state: { read: index === 3, saved: false, dismissed: false },
    collectedAt: NOW.toISOString(),
    ...patch,
  };
}
const completed = { trigger: "scheduled" as const, status: "completed" as const, completedAt: new Date(NOW.getTime() - 12 * 60_000).toISOString(), createdSignals: 3, warnings: [] };
const brief = (patch: Partial<MemberRadarBrief> = {}): MemberRadarBrief => ({ lastRun: completed, unreadCount: 2, highlights: [signal(1), signal(2), signal(3)], ...patch });
const render = (radar: MemberRadarBrief, navigate = vi.fn()) => renderToStaticMarkup(<MemberRadarWidget radar={radar} onNavigate={navigate} onRefresh={vi.fn()} />);

beforeEach(() => {
  ui.presses.clear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("首页的雷达小组件", () => {
  it("标题「雷达」旁写最近一次扫描（相对时间）；最多 3 条，写标题、来源、时间和一句理由；「全部」进我的雷达", () => {
    const navigate = vi.fn();
    const html = render(brief(), navigate);
    expect(html).toContain(">雷达<");
    expect(html).toContain("最近扫描 · 12 分钟前 · 2 条未读");
    for (const index of [1, 2, 3]) {
      expect(html).toContain(`第 ${index} 条标题`);
      expect(html).toContain(`第 ${index} 条的理由`);
      expect(html).toContain(`data-origin="/me/radar/signals/0f0f0f0f-0000-4000-8000-00000000000${index}"`);
    }
    expect(html).toContain("36kr.com · 1 小时前");
    expect(html).toContain("金融时报 · 2 小时前");
    const target = {} as HTMLElement;
    ui.presses.get("查看全部雷达信号")!({ target });
    expect(navigate).toHaveBeenLastCalledWith("/me/radar", target);
    ui.presses.get("阅读：第 1 条标题（未读）")!({ target });
    expect(navigate).toHaveBeenLastCalledWith("/me/radar/signals/0f0f0f0f-0000-4000-8000-000000000001", target);
    expect(ui.presses.has("阅读：第 3 条标题")).toBe(true);
  });

  it("扫描失败、第一次还没扫完、扫完没有结果，三种情况分开写", () => {
    const failed = render(brief({ lastRun: { ...completed, status: "failed", warnings: ["检索服务暂时不可用"] }, highlights: [] }));
    expect(failed).toContain("扫描失败 · 12 分钟前");
    expect(failed).toContain("检索服务暂时不可用");
    expect(failed).toContain('aria-label="重试雷达扫描"');
    expect(failed).not.toContain("第一次扫描还没完成");
    expect(failed).not.toContain("这段时间没有和你方向相关的新内容");

    const first = render(brief({ lastRun: null, unreadCount: 0, highlights: [] }));
    expect(first).toContain("还没扫描过");
    expect(first).toContain("第一次扫描还没完成，稍等片刻");
    expect(first).not.toContain("重试");
    const queued = render(brief({ lastRun: { trigger: "manual", status: "queued", queuedAt: NOW.toISOString(), createdSignals: 0, warnings: [] }, unreadCount: 0, highlights: [] }));
    expect(queued).toContain("正在排队扫描");
    expect(queued).toContain("第一次扫描还没完成，稍等片刻");

    const empty = render(brief({ unreadCount: 0, highlights: [] }));
    expect(empty).toContain("这段时间没有和你方向相关的新内容");
    expect(empty).not.toContain("第一次扫描还没完成");
    expect(empty).not.toContain("重试");
  });

  it("雷达关着（首页响应里 radar 为 null）时整块不出现；开着时放进整行宽的插槽", () => {
    home.radar = null;
    expect(renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽" />)).not.toContain('data-widget="radar"');
    home.radar = brief();
    const html = renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽" />);
    expect(html).toContain('data-widget="radar"');
    expect(html).toContain("第 1 条标题");
    home.radar = null;
  });
});

describe("榜单条目（02b）", () => {
  it("时间写「上榜于 月/日」，不按收集时间写几分钟前", () => {
    const listedSignal = signal(4, { source: { type: "list" as const, label: "GitHub Trending", title: "owner/agent", url: "https://github.com/owner/agent", publishedAt: null, listedOn: "2026-10-08", listing: { language: "Rust", starsInPeriod: 321, since: "weekly" as const } } });
    const html = render(brief({ highlights: [listedSignal] }));
    expect(html).toContain("GitHub Trending · 上榜于 10/8");
  });
});
