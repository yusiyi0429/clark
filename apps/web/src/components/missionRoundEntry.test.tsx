import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Card } from "@/lib/api/client";

const ui = vi.hoisted(() => ({ buttons: new Map<string, (event: unknown) => Promise<void>>(), ask: vi.fn(), run: vi.fn(), reset: vi.fn(), refresh: vi.fn(), endpoint: "", refreshEffect: undefined as (() => void | (() => void)) | undefined }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
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
  payload: { period: "2026-10", battlefieldId: "01", battlefieldName: "灯塔项目", placeholder: true, todo: "可以整理个人卡草稿", serverNow: "2026-10-01T00:00:00.000Z" },
  actions: [{ actionId: "opaque-slot", actionType: "mission-round.draft", label: "整理个人卡草稿" }],
} as Card;
const round = { ...draft, id: "mission-round:actual", objectRef: { type: "mission-round", id: "actual", version: 1 }, payload: { ...(draft.payload as Record<string, unknown>), phase: "draft" }, actions: [] } as Card;
const event = { target: { closest: () => null } };

beforeEach(() => { vi.clearAllMocks(); ui.buttons.clear(); ui.refreshEffect = undefined; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("CEO 整理个人卡草稿交互", () => {
  function render(card: Card = draft) {
    const onCard = vi.fn();
    const onNavigate = vi.fn();
    renderToStaticMarkup(<NotificationRail cards={[card]} onCard={onCard} onNavigate={onNavigate} />);
    const press = [...ui.buttons.entries()].find(([label]) => label.startsWith("10 月 Mission Card"))![1];
    return { press: () => press(event), onCard, onNavigate };
  }

  it("先说明占位来源并确认；取消时不执行动作", async () => {
    ui.ask.mockResolvedValue(false);
    await render().press();
    expect(ui.ask).toHaveBeenCalledWith(expect.stringContaining("草稿是占位：Agent 起草未接入，由 9 月个人卡生成，待大家讨论修改"), "整理个人卡草稿");
    expect(ui.run).not.toHaveBeenCalled();
  });

  it("确认后走轮次端点，立即交回真实轮次并刷新首页", async () => {
    ui.ask.mockResolvedValue(true);
    ui.run.mockResolvedValue(round);
    const view = render();
    await view.press();
    await vi.waitFor(() => expect(view.onCard).toHaveBeenCalledExactlyOnceWith(round));
    expect(ui.endpoint).toBe("/api/mission-rounds/actions/execute");
    expect(ui.run).toHaveBeenCalledExactlyOnceWith(draft.actions[0]);
    expect(ui.refresh).toHaveBeenCalledOnce();
    expect(view.onNavigate).not.toHaveBeenCalled();
  });

  it("已建轮次的入口留在首页，不请求动作、不打开尚未上线的个人卡路由", async () => {
    const view = render(round);
    await view.press();
    expect(ui.ask).not.toHaveBeenCalled();
    expect(ui.run).not.toHaveBeenCalled();
    expect(view.onNavigate).not.toHaveBeenCalled();
  });

  it.each([["open", true], ["closed", true], ["reviewing", false]] as const)("%s 阶段按需继续分钟刷新，直到截止快照已写入", (phase, shouldRefresh) => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval });
    render({ ...round, payload: { ...(round.payload as Record<string, unknown>), phase, closesAt: "2026-10-03T00:00:00.000Z", counts: { pending: 0 } } });
    expect(ui.refreshEffect).toBeDefined();
    const cleanup = ui.refreshEffect!();
    vi.advanceTimersByTime(60_000);
    expect(ui.refresh).toHaveBeenCalledTimes(shouldRefresh ? 1 : 0);
    cleanup?.();
    vi.advanceTimersByTime(60_000);
    expect(ui.refresh).toHaveBeenCalledTimes(shouldRefresh ? 1 : 0);
  });
});
