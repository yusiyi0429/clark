import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { TMissionRoundSummary } from "@warmap/contracts";
import { personalPayload } from "./personalMissionFixture";

const ui = vi.hoisted(() => ({ presses: new Map<string, (event: unknown) => void>(), disabled: new Map<string, boolean | undefined>(), progress: [] as unknown[] }));
vi.mock("@/components/HeroButton", () => ({ HeroButton: ({ children, onPress, isDisabled, ...props }: { children?: ReactNode; onPress?: (event: unknown) => void; isDisabled?: boolean; "aria-label"?: string }) => {
  if (onPress && props["aria-label"]) ui.presses.set(props["aria-label"], onPress);
  if (props["aria-label"]) ui.disabled.set(props["aria-label"], isDisabled);
  return <button disabled={isDisabled} {...props}>{children}</button>;
} }));
vi.mock("./MissionRoundProgress", () => ({ MissionRoundProgress: (props: { round: TMissionRoundSummary }) => { ui.progress.push(props); return <button aria-label="查看任务准备进度">本人确认进度</button>; } }));

import { MissionCardNoticeGroup } from "./MissionCardNoticeGroup";

const rows: TMissionRoundSummary["cards"] = [
  { cardId: "first", ownerId: "bai", ownerName: "白田田", roleLabel: "01-1 战役 DRI", missionCount: 4, ownerConfirmedAt: null, line: "已处理", pending: 0, firstPendingFeedbackId: null, pendingCorrections: 0, firstPendingCorrectionId: null, mine: false, placeholder: false },
  { cardId: "mine", ownerId: "sun", ownerName: "孙铭泽", roleLabel: "01-3 战役 DRI", missionCount: 2, ownerConfirmedAt: null, line: "待处理 2", pending: 2, firstPendingFeedbackId: "feedback-2", pendingCorrections: 0, firstPendingCorrectionId: null, mine: true, placeholder: false },
];
const summary = (overrides: Partial<TMissionRoundSummary> = {}): TMissionRoundSummary => ({ ...personalPayload.round, phase: "reviewing", approver: true, todo: "2 条意见待你处理", cards: rows, ...overrides });
beforeEach(() => { ui.presses.clear(); ui.disabled.clear(); ui.progress = []; });

describe("本月 Mission Card 通知分组", () => {
  it("拍板人看到服务端顺序的全部行、一次草稿与一个共享倒计时，并突出待处理", () => {
    const html = renderToStaticMarkup(<MissionCardNoticeGroup round={summary()} entry="ceo" onNavigate={vi.fn()} onRefresh={vi.fn()} />);
    expect(html.indexOf("白田田")).toBeLessThan(html.indexOf("孙铭泽"));
    expect(html).toContain("01-3 战役"); expect(html).toContain("待处理 2");
    expect(html).toContain('data-waiting="true"'); expect(html).toContain("2 条意见待你处理");
    expect(html.match(/>占位</g)).toHaveLength(1); expect(html.match(/<time /g)).toHaveLength(1);
  });

  it("成员只有自己的行，没有拍板人的待办", () => {
    const html = renderToStaticMarkup(<MissionCardNoticeGroup round={summary({ approver: false, cards: [rows[1]], todo: null })} entry="member" onNavigate={vi.fn()} onRefresh={vi.fn()} />);
    expect(html).toContain("孙铭泽"); expect(html).toContain(">你<"); expect(html).not.toContain("白田田");
    expect(html).not.toContain('data-waiting="true"'); expect(html).not.toContain("2 条意见待你处理");
  });

  it.each(["drafting", "draft", "open", "closed", "reviewing"] as const)("%s 阶段保留通知，确认后退掉整组", (phase) => {
    const render = (phase: TMissionRoundSummary["phase"]) => renderToStaticMarkup(<MissionCardNoticeGroup round={summary({ phase })} entry="member" onNavigate={vi.fn()} onRefresh={vi.fn()} />);
    expect(render(phase)).toContain("Mission Card"); expect(render("confirmed")).toBe("");
  });
  it("起草期间用工作中状态，完成后逐卡显示占位", () => {
    const drafting = renderToStaticMarkup(<MissionCardNoticeGroup round={summary({ phase: "drafting", draftOrigin: null, todo: "Co-Agent 正在起草", cards: rows.map((row) => ({ ...row, line: "Co-Agent 正在起草" })) })} entry="ceo" onNavigate={vi.fn()} onRefresh={vi.fn()} />);
    expect(drafting).toContain("工作中");
    expect(drafting).toContain("Co-Agent 正在起草");
    const ready = renderToStaticMarkup(<MissionCardNoticeGroup round={summary({ phase: "draft", draftOrigin: "agent", cards: [{ ...rows[0], placeholder: true }, rows[1]] })} entry="ceo" onNavigate={vi.fn()} onRefresh={vi.fn()} />);
    expect(ready).toContain("Co-Agent 起草");
    expect(ready.match(/>占位</g)).toHaveLength(1);
  });

  it("行进入对应任务卡，待处理提示直接定位第一条未处理意见", () => {
    const onNavigate = vi.fn();
    renderToStaticMarkup(<MissionCardNoticeGroup round={summary()} entry="ceo" onNavigate={onNavigate} onRefresh={vi.fn()} />);
    const event = { target: { closest: () => null } };
    ui.presses.get("2 条意见待你处理")!(event);
    expect(onNavigate).toHaveBeenLastCalledWith("/mission-cards/mine?feedback=feedback-2", null);
    [...ui.presses.entries()].find(([label]) => label.startsWith("白田田 ·"))![1](event);
    expect(onNavigate).toHaveBeenLastCalledWith("/mission-cards/first", null);
  });

  it.each([["ceo", "/mission-cards/mine?correction=fix-1"], ["member", "/me/mission-cards/mine?correction=fix-1"]] as const)("已确定但有更正申请时拍板人重新看到这一轮，待办直达第一条：%s", (entry, href) => {
    const round = summary({ phase: "confirmed", todo: "1 条更正申请待你处理", counts: { ...personalPayload.round.counts, corrections: 1 },
      cards: [{ ...rows[0], line: "已确定" }, { ...rows[1], pending: 0, firstPendingFeedbackId: null, line: "1 条更正申请", pendingCorrections: 1, firstPendingCorrectionId: "fix-1" }] });
    const onNavigate = vi.fn();
    const html = renderToStaticMarkup(<MissionCardNoticeGroup round={round} entry={entry} onNavigate={onNavigate} onRefresh={vi.fn()} />);
    expect(html).toContain("1 条更正申请待你处理"); expect(html).toContain(">1 条更正申请<");
    expect(html.match(/data-waiting="true"/g)).toHaveLength(1);
    expect(html).not.toContain(">草稿<");
    ui.presses.get("1 条更正申请待你处理")!({ target: { closest: () => null } });
    expect(onNavigate).toHaveBeenLastCalledWith(href, null);
  });

  it("不是拍板人或没有待处理的更正申请时，已确定的轮次整组退出", () => {
    const render = (overrides: Partial<TMissionRoundSummary>) => renderToStaticMarkup(<MissionCardNoticeGroup round={summary({ phase: "confirmed", ...overrides })} entry="member" onNavigate={vi.fn()} onRefresh={vi.fn()} />);
    expect(render({ approver: false, todo: null, counts: { ...personalPayload.round.counts, corrections: 1 } })).toBe("");
    expect(render({ todo: null })).toBe("");
  });

  it("草稿待办通过父级进度操作，不能借待办直接打开未确认的第一张私人卡", () => {
    const onNavigate = vi.fn();
    const html = renderToStaticMarkup(<MissionCardNoticeGroup round={summary({ phase: "draft", todo: "任务卡草稿已就绪，可以下发本人确认", cards: rows.map((row) => ({ ...row, contentVisible: false })) })} entry="member" onNavigate={onNavigate} onRefresh={vi.fn()} />);
    expect(html).toContain("本人确认进度");
    expect(ui.presses.has("任务卡草稿已就绪，可以下发本人确认")).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled(); expect(ui.progress).toHaveLength(1);
  });
  it("上级看到本人确认进度，但未确认的他人卡不能打开且不会误指向旧意见", () => {
    const onNavigate = vi.fn();
    const unreadable = rows.map((row) => ({ ...row, mine: false, contentVisible: false }));
    renderToStaticMarkup(<MissionCardNoticeGroup round={summary({ phase: "open", cards: unreadable, todo: "尚有 2 人待本人确认" })} entry="ceo" onNavigate={onNavigate} onRefresh={vi.fn()} />);
    expect(ui.progress).toHaveLength(1);
    const labels = [...ui.presses.keys()].filter((label) => label.includes("查看详情"));
    expect(labels).toHaveLength(2);
    for (const label of labels) { expect(ui.disabled.get(label)).toBe(true); ui.presses.get(label)!({ target: { closest: () => null } }); }
    expect(onNavigate).not.toHaveBeenCalled(); expect(ui.presses.has("尚有 2 人待本人确认")).toBe(false);
  });
});
