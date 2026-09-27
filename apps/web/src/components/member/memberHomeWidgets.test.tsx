import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

const ui = vi.hoisted(() => ({ presses: new Map<string, (event: { target: HTMLElement }) => void>() }));
vi.mock("@/components/HeroButton", () => ({ HeroButton: ({ children, onPress, ...props }: { children?: ReactNode; onPress?: (event: { target: HTMLElement }) => void; "aria-label"?: string }) => {
  if (onPress && props["aria-label"]) ui.presses.set(props["aria-label"], onPress);
  return <button {...props}>{children}</button>;
} }));
vi.mock("@heroui/react", () => ({ Card: ({ children, ...props }: { children?: ReactNode }) => <article {...props}>{children}</article> }));

import { MemberHomeWidgets, type MemberWork } from "./MemberHomeWidgets";

export const homeWork: MemberWork = {
  period: "2026-10", planStatus: "confirmed",
  battlefields: [{ id: "growth", name: "灯塔客户", isDri: true, monthTarget: "完成首批客户验证。", monthTargetState: "confirmed", monthTargetText: "完成首批客户验证。" }],
  missions: [],
  missionCards: [{ cardId: "mine", roundId: "round-1", period: "2026-10", battlefieldId: "growth", battlefieldName: "灯塔客户", phase: "open", status: "讨论中 · 截止后汇总意见", closesAt: "2026-10-03T02:00:00.000Z", serverNow: "2026-10-01T02:00:00.000Z", missionCount: 2, placeholder: true, href: "/me/mission-cards/mine" }],
};

beforeEach(() => ui.presses.clear());
const render = (work: MemberWork | null = homeWork, radar?: ReactNode) => renderToStaticMarkup(<MemberHomeWidgets work={work} onNavigate={vi.fn()} onRefresh={vi.fn()} radar={radar} />);

describe("DRI 首页小组件", () => {
  it("战场只写本月原文，负责人有同形皇冠，个人卡显示服务端状态与上海截止时刻", () => {
    const html = render();
    expect(html).toContain("灯塔客户"); expect(html).toContain("完成首批客户验证。");
    expect(html).toContain("你是这个战场的 DRI");
    expect(html).toContain("我的本月卡"); expect(html).toContain(homeWork.missionCards[0].status);
    expect(html).toContain("10/3 10:00"); expect(html).toContain("48 小时 0 分");
    expect(html).not.toMatch(/六个月|甘特图|完成率|健康判断|发给你的信号/);
    expect(html).not.toContain("雷达");
  });
  it.each(["本月目标还没出来", "本月目标还在协商"])("缺目标沿用引导状态：%s，不展示候选原文", (text) => {
    const html = render({ ...homeWork, battlefields: [{ ...homeWork.battlefields[0], isDri: false, monthTarget: null, monthTargetState: text.includes("协商") ? "negotiating" : "none", monthTargetText: text }] });
    expect(html).toContain(text); expect(html).not.toContain("完成首批客户验证。"); expect(html).not.toContain("你是这个战场的 DRI");
  });
  it("已确定卡仍是长期入口，不随通知退出消失", () => {
    const html = render({ ...homeWork, missionCards: [{ ...homeWork.missionCards[0], phase: "confirmed", status: "已确定 · 作为本月工作依据" }] });
    expect(html).toContain("已确定 · 作为本月工作依据"); expect(html).toContain('data-origin="/me/mission-cards/mine"');
    expect(html).not.toContain("48 小时");
  });
  it("到达截止但新投影未返回时，与详情同一刻显示汇总中", () => {
    const html = render({ ...homeWork, missionCards: [{ ...homeWork.missionCards[0], serverNow: "2026-10-03T02:00:00.000Z" }] });
    expect(html).toContain("已截止 · 汇总中"); expect(html).not.toContain(homeWork.missionCards[0].status);
  });
  it("空态明确没有登记与没有本人卡，载入时不提前声称无卡", () => {
    const empty = render({ ...homeWork, battlefields: [], missionCards: [] });
    expect(empty).toContain("还没有登记你参与的战场"); expect(empty).toContain("这个月还没有你的卡");
    const loading = render(null); expect(loading).toContain("正在读取本月工作"); expect(loading).not.toContain("这个月还没有你的卡");
  });
  it("战场和本人卡通过现有展开区导航，保留来源节点", () => {
    const navigate = vi.fn(); const target = {} as HTMLElement;
    renderToStaticMarkup(<MemberHomeWidgets work={homeWork} onNavigate={navigate} onRefresh={vi.fn()} />);
    ui.presses.get("查看战场：灯塔客户")!({ target });
    expect(navigate).toHaveBeenLastCalledWith("/me/battlefields/growth", target);
    ui.presses.get("打开我的本月卡：灯塔客户")!({ target });
    expect(navigate).toHaveBeenLastCalledWith("/me/mission-cards/mine", target);
  });
  it("雷达小卡插槽只在提供组件时出现", () => {
    expect(render()).not.toContain('data-widget="radar"');
    const html = render(homeWork, <p>测试雷达内容</p>);
    expect(html).toContain('data-widget="radar"'); expect(html).toContain("测试雷达内容");
  });
});
