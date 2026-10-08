import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { TMemberBattlefieldResponse } from "@warmap/contracts";
import { personalPayload } from "@/components/missionCards/personalMissionFixture";

const ui = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, effects: [] as (() => void | (() => void))[],
  callbacks: [] as (() => Promise<void>)[], buttons: new Map<string, (event: unknown) => unknown>(),
  get: vi.fn(), navigate: vi.fn(), register: vi.fn(), push: vi.fn(), now: 0,
  useState(initial: unknown): [unknown, (value: unknown) => void] {
    const index = ui.index++;
    if (!(index in ui.values)) ui.values[index] = initial;
    return [ui.values[index], (value: unknown) => { ui.values[index] = typeof value === "function" ? value(ui.values[index]) : value; }];
  },
}));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState: ui.useState,
  useRef: (value: unknown) => ui.useState({ current: value })[0],
  useEffect: (effect: () => void | (() => void)) => { ui.effects.push(effect); },
  useCallback: (callback: () => Promise<void>) => { ui.callbacks.push(callback); return callback; },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: ui.push }) }));
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: ui.get } }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ navigate: ui.navigate, close: vi.fn(), viewerId: "owner" }), useRegisterDetail: ui.register }));
vi.mock("@/components/shell/DetailFrame", () => ({ DetailFrame: ({ title, subtitle, children, actions }: { title: string; subtitle: string; children: ReactNode; actions: ReactNode }) => <main><h1>{title}</h1><p>{subtitle}</p>{actions}{children}</main> }));
vi.mock("@/components/missionCards/useRoundNow", () => ({ useRoundNow: (_at: string | null, now: string) => ui.now || Date.parse(now) }));
vi.mock("ts-design/primitives", () => ({ Button: ({ children, onPress, ...props }: { children: ReactNode; onPress?: (event: unknown) => unknown; "aria-label"?: string; "data-origin"?: string }) => {
  const label = props["aria-label"] ?? String(children);
  if (onPress) ui.buttons.set(label, onPress);
  return <button aria-label={label} data-origin={props["data-origin"]}>{children}</button>;
} }));
import { MemberBattlefieldScreen } from "./MemberBattlefieldScreen";

const fixture = (): TMemberBattlefieldResponse => ({
  id: "01", code: "01", name: "灯塔战场", ownerId: "decider", ownerName: "刘明华", isDri: false, period: "2026-10",
  sixMonthOutcome: "形成可复用的六个月交付方式", monthTarget: "跑通首次经营判断", monthTargetState: "confirmed", monthTargetText: "跑通首次经营判断",
  missionCards: [
    { cardId: "card", ownerId: "owner", ownerName: "白田田", roleLabel: "01-1 战役 DRI", missionCount: 1, status: "草稿 · 讨论中", feedbackCount: 3, canOpen: true, href: "/me/mission-cards/card" },
    { cardId: "other", ownerId: "other", ownerName: "孙铭泽", roleLabel: "参与 DRI", missionCount: 2, status: "草稿 · 讨论中", feedbackCount: 0, canOpen: false, href: null },
  ],
  myMissions: [personalPayload.card.missions[0]],
  round: { ...personalPayload.round, approver: false, counts: { ...personalPayload.round.counts, cards: 2 }, cards: [{ ...personalPayload.round.cards[0], line: "3 条意见" }] },
  confirmation: null, serverNow: "2026-10-01T00:00:00.000Z",
});

function render(data = fixture()) { ui.index = 0; ui.callbacks = []; ui.effects = []; ui.buttons.clear(); return renderToStaticMarkup(<MemberBattlefieldScreen initialData={data} />); }
function refresh() { return ui.callbacks[0](); }
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  ui.values = []; ui.now = 0; vi.clearAllMocks();
  ui.get.mockResolvedValue({ response: { ok: true, status: 200 }, data: fixture() });
});
afterEach(() => vi.unstubAllGlobals());

describe("成员战场阅读与任务卡入口", () => {
  it("保留概念版目标阅读层级，展示六个月与本月原文，不出现 CEO 决策或演示进度", () => {
    const html = render();
    expect(html).toContain("形成可复用的六个月交付方式");
    expect(html).toContain("跑通首次经营判断");
    expect(html).toContain("刘明华");
    expect(html).toContain("我在这里的 Mission");
    expect(html).not.toMatch(/待决策|甘特|完成率|健康判断|演示进度/);
    expect(ui.register).toHaveBeenCalledWith({ scope: "global", label: "灯塔战场", mark: null, cards: [] });
  });
  it("全部 Owner 可识别，普通人只得到 API 允许的任务卡入口", () => {
    const html = render();
    expect(html).toContain("孙铭泽");
    expect(html).toContain("白田田");
    expect(html).toContain("我的卡：1 项 · 3 条意见");
    expect(html).not.toContain('data-origin="/me/mission-cards/other"');
    const open = ui.buttons.get("打开白田田的本月卡");
    expect(open).toBeDefined();
    const source = {};
    open!({ target: source });
    expect(ui.navigate).toHaveBeenCalledWith("/me/mission-cards/card", source);
  });
  it("自己的 Mission 共用草稿和占位小标，打开服务端授权的所属卡", () => {
    const html = render();
    expect(html).toContain("完善方法闭环");
    expect(html).toContain("草稿 · 占位");
    ui.buttons.get("打开个人任务：完善方法闭环")!({ target: null });
    expect(ui.navigate).toHaveBeenCalledWith("/me/mission-cards/card", null);
  });
  it.each([
    ["none", "本月目标还没出来"], ["negotiating", "本月目标还在协商"], ["confirmed", "任务卡还没起草"],
  ] as const)("%s 无轮次照实写来源状态，不推断没有工作", (state, line) => {
    const data = fixture();
    data.round = null; data.missionCards = []; data.myMissions = []; data.monthTargetState = state;
    data.monthTarget = state === "confirmed" ? data.monthTarget : null;
    data.monthTargetText = state === "confirmed" ? data.monthTargetText : line;
    const html = render(data);
    expect(html).toContain(line);
    expect(html).toContain("这个月还没有你的卡");
    expect(html).toContain("没有登记");
    expect(html).not.toContain("没有工作");
  });
  it("当前拍板人看到全战场待处理数，并从服务端可见卡直达待处理意见", () => {
    const data = fixture();
    data.isDri = true;
    data.round = { ...data.round!, phase: "reviewing", approver: true, todo: "2 条待你处理", counts: { ...data.round!.counts, pending: 2 }, cards: [{ ...data.round!.cards[0], pending: 2, firstPendingFeedbackId: "feedback-1" }] };
    data.missionCards[1] = { ...data.missionCards[1], canOpen: true, href: "/me/mission-cards/other" };
    const html = render(data);
    expect(html).toContain("2 张卡 · 待处理 2");
    expect(html).toContain("你是这个战场的 DRI");
    expect(html).toContain("2 条待你处理");
    ui.buttons.get("查看 10 月任务卡")!({ target: null });
    expect(ui.navigate).toHaveBeenCalledWith("/me/mission-cards/card?feedback=feedback-1", null);
    expect(ui.buttons.has("打开孙铭泽的本月卡")).toBe(true);
  });
  it("已确定后，拍板人从这里直达第一条待处理的更正申请；月份过了只写已确定（GAP-04）", () => {
    const data = fixture();
    data.isDri = true;
    data.confirmation = { byName: "刘明华", at: "2026-10-04T10:00:00.000Z" };
    const rows = [{ ...data.round!.cards[0], pendingCorrections: 1, firstPendingCorrectionId: "correction-1" }];
    data.round = { ...data.round!, phase: "confirmed", approver: true, todo: "1 条更正申请待你处理", counts: { ...data.round!.counts, corrections: 1 }, cards: rows };
    expect(render(data)).toContain("1 条更正申请待你处理");
    ui.buttons.get("查看 10 月任务卡")!({ target: null });
    expect(ui.navigate).toHaveBeenCalledWith("/me/mission-cards/card?correction=correction-1", null);
    // 月份过后服务端不再给待办，只留计数：状态句不能再催。
    data.round = { ...data.round, todo: null };
    ui.buttons.clear();
    const closed = render(data);
    expect(closed).toContain("已确定 · 刘明华 10/4 18:00");
    expect(closed).not.toContain("待你处理");
    expect(ui.buttons.has("查看 10 月任务卡")).toBe(false);
  });
  it("确认后仍保留任务卡，显示确认人、上海时间和已确定占位标记", () => {
    const data = fixture();
    data.round = { ...data.round!, phase: "confirmed" };
    data.confirmation = { byName: "刘明华", at: "2026-10-04T10:00:00.000Z" };
    data.myMissions = [{ ...data.myMissions[0], personalCard: { ...data.myMissions[0].personalCard!, status: "confirmed" } }];
    const html = render(data);
    expect(html).toContain("已确定 · 刘明华 10/4 18:00");
    expect(html).toContain("已确定 · 占位");
    expect(ui.buttons.has("打开白田田的本月卡")).toBe(true);
  });
  it("与共享分钟时钟越过截止，立即换成本人确认时间已到，不残留讨论中", () => {
    ui.now = Date.parse("2026-10-03T00:00:00.000Z");
    const html = render();
    expect(html).toContain("本人确认时间已到");
    expect(html).not.toContain("草稿 · 讨论中");
  });
});

describe("详情刷新与权限撤销", () => {
  it("网络失败保留原文与入口，恢复后清除提示", async () => {
    render();
    ui.get.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await refresh();
    const html = render();
    expect(html).toContain("跑通首次经营判断");
    expect(html).toContain("已保留当前内容");
    expect(html).not.toContain("Failed to fetch");
    await refresh();
    expect(render()).not.toContain("已保留当前内容");
  });
  it.each([403, 404])("刷新 %s 立即去掉旧目标、Owner与卡数据", async (status) => {
    render(); ui.get.mockResolvedValue({ response: { ok: false, status } });
    await refresh();
    const html = render();
    expect(html).toContain("这个战场不存在或当前不可见");
    expect(html).not.toContain("灯塔战场");
    expect(html).not.toContain("跑通首次经营判断");
    expect(html).not.toContain("白田田");
    expect(ui.register.mock.calls.at(-1)?.[0].label).toBe("战场详情");
  });
  it("登录过期去锁屏，保留战场深链", async () => {
    render(); ui.get.mockResolvedValue({ response: { ok: false, status: 401 } });
    await refresh();
    expect(ui.push).toHaveBeenCalledWith("/access?next=%2Fme%2Fbattlefields%2F01");
    expect(render()).not.toContain("跑通首次经营判断");
  });
  it("20秒/焦点/拍板事件共用刷新；在途拍板通知排队再读最新事实，卸载清理", async () => {
    const events = new EventTarget();
    const timers = vi.fn(), clear = vi.fn(), remove = vi.fn();
    vi.stubGlobal("window", { addEventListener: events.addEventListener.bind(events), removeEventListener: remove, setInterval: timers, clearInterval: clear });
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
    render();
    const cleanup = ui.effects[0]();
    expect(timers).toHaveBeenCalledWith(expect.any(Function), 20_000);
    let finish!: (value: unknown) => void;
    ui.get.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    events.dispatchEvent(new Event("focus"));
    events.dispatchEvent(new Event("mission-round-changed"));
    expect(ui.get).toHaveBeenCalledOnce();
    finish({ response: { ok: true, status: 200 }, data: fixture() });
    await settle();
    expect(ui.get).toHaveBeenCalledTimes(2);
    cleanup?.();
    expect(clear).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith("mission-round-changed", expect.any(Function));
  });
});
