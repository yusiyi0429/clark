import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Card } from "@/lib/api/client";
import { personalPayload } from "./missionCards/personalMissionFixture";

const ui = vi.hoisted(() => ({ buttons: new Map<string, (event: unknown) => Promise<void>>(), ask: vi.fn(), run: vi.fn(), reset: vi.fn(), refresh: vi.fn(), endpoint: "", effects: [] as (() => void | (() => void))[], refreshEffect: undefined as (() => void | (() => void)) | undefined }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    ui.effects.push(effect);
    if (deps?.length === 2 && typeof deps[0] === "boolean" && (deps[1] as { refresh?: unknown })?.refresh === ui.refresh) ui.refreshEffect = effect;
    return actual.useEffect(effect, deps);
  } };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: ui.refresh }) }));
vi.mock("./ConfirmDialog", () => ({ useConfirm: () => ({ ask: ui.ask, dialog: null }) }));
vi.mock("./HeroButton", () => ({ HeroButton: (props: { "aria-label"?: string; onPress?: (event: unknown) => Promise<void>; children?: ReactNode }) => {
  if (props["aria-label"] && props.onPress) ui.buttons.set(props["aria-label"], props.onPress);
  return <button>{props.children}</button>;
} }));
vi.mock("@/lib/useCardAction", () => ({
  useCardAction: (onCard: (card: Card) => void, endpoint: string) => {
    ui.endpoint = endpoint;
    return { state: { status: "idle" }, reset: ui.reset, pending: false, retry: vi.fn(), run: async (action: unknown) => {
      const card = await ui.run(action);
      if (card) onCard(card);
      return card;
    } };
  },
  ActionFeedback: () => null,
}));

import { NotificationRail } from "./NotificationRail";

const draft = {
  schemaVersion: 1, id: "mission-round-slot:01:2026-10", version: 1, kind: "mission-round", title: "10 月 Mission Card · 灯塔项目",
  objectRef: { type: "mission-round-slot", id: "01:2026-10", version: 1 },
  payload: { period: "2026-10", battlefieldId: "01", battlefieldName: "灯塔项目", placeholder: true, todo: "可以整理任务卡草稿", serverNow: "2026-10-01T00:00:00.000Z" },
  actions: [{ actionId: "opaque-slot", actionType: "mission-round.draft", label: "整理任务卡草稿" }],
} as Card;
const round = { ...draft, id: "mission-round:actual", objectRef: { type: "mission-round", id: "actual", version: 1 }, payload: { ...personalPayload.round, phase: "draft", cards: [{ ...personalPayload.round.cards[0], cardId: "first-personal-card" }] }, actions: [] } as Card;
const event = { target: { closest: () => null } };

beforeEach(() => { vi.clearAllMocks(); ui.buttons.clear(); ui.effects = []; ui.refreshEffect = undefined; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("CEO 整理任务卡草稿交互", () => {
  function render(card: Card = draft) {
    const onCard = vi.fn();
    const onNavigate = vi.fn();
    renderToStaticMarkup(<NotificationRail cards={[card]} onCard={onCard} onNavigate={onNavigate} />);
    const press = [...ui.buttons.entries()].find(([label]) => label.startsWith("10 月 Mission Card") || label.startsWith("白田田"))?.[1];
    return { press: () => press!(event), onCard, onNavigate };
  }

  it("先说明占位来源并确认；取消时不执行动作", async () => {
    ui.ask.mockResolvedValue(false);
    await render().press();
    expect(ui.ask).toHaveBeenCalledWith(expect.stringContaining("这个战场还没有可以起草的人，先用占位文件整理草稿"), "整理任务卡草稿");
    expect(ui.run).not.toHaveBeenCalled();
  });

  it("确认后走轮次端点，交回真实轮次、刷新首页并打开第一张任务卡", async () => {
    ui.ask.mockResolvedValue(true);
    ui.run.mockResolvedValue(round);
    const view = render();
    await view.press();
    await vi.waitFor(() => expect(view.onCard).toHaveBeenCalledExactlyOnceWith(round));
    expect(ui.endpoint).toBe("/api/mission-rounds/actions/execute");
    expect(ui.run).toHaveBeenCalledExactlyOnceWith(draft.actions[0]);
    expect(ui.refresh).toHaveBeenCalledOnce();
    expect(view.onNavigate).toHaveBeenCalledExactlyOnceWith("/mission-cards/first-personal-card", null);
  });

  it("已建轮次直接打开第一张任务卡，不重复整理", async () => {
    const view = render(round);
    await view.press();
    expect(ui.ask).not.toHaveBeenCalled();
    expect(ui.run).not.toHaveBeenCalled();
    expect(view.onNavigate).toHaveBeenCalledExactlyOnceWith("/mission-cards/first-personal-card", null);
  });

  it.each([["open", true], ["closed", true], ["reviewing", true], ["confirmed", false]] as const)("%s 阶段持续同步其他拍板人的变更，确认后停止刷新", (phase, shouldRefresh) => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
    render({ ...round, payload: { ...(round.payload as Record<string, unknown>), phase, closesAt: "2026-10-03T00:00:00.000Z", counts: { pending: 0 } } });
    expect(ui.refreshEffect).toBeDefined();
    const cleanup = ui.refreshEffect!();
    vi.advanceTimersByTime(20_000);
    expect(ui.refresh).toHaveBeenCalledTimes(shouldRefresh ? 1 : 0);
    cleanup?.();
    vi.advanceTimersByTime(20_000);
    expect(ui.refresh).toHaveBeenCalledTimes(shouldRefresh ? 1 : 0);
  });

  it("引导的整理深链只打开对应轮次的确认弹窗，不自动执行", async () => {
    vi.stubGlobal("window", { location: { search: "?missionRoundDraft=01%3A2026-10" }, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
    ui.ask.mockResolvedValue(false);
    render();
    const cleanups = ui.effects.map((effect) => effect());
    await vi.waitFor(() => expect(ui.ask).toHaveBeenCalledOnce());
    expect(ui.run).not.toHaveBeenCalled();
    cleanups.forEach((cleanup) => cleanup?.());
  });
});
