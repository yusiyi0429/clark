import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { Card } from "@/lib/api/client";
import { personalPayload } from "./missionCards/personalMissionFixture";

const ui = vi.hoisted(() => ({ buttons: new Map<string, (event: unknown) => Promise<void>>(), refresh: vi.fn(), refreshEffect: undefined as (() => void | (() => void)) | undefined }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    if (deps?.length === 2 && (typeof deps[0] === "number" || deps[0] === null) && (deps[1] as { refresh?: unknown })?.refresh === ui.refresh) ui.refreshEffect = effect;
    return actual.useEffect(effect, deps);
  } };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: ui.refresh }) }));
vi.mock("./missionCards/MissionRoundProgress", () => ({ MissionRoundProgress: () => <button>查看本人确认进度</button> }));
vi.mock("./HeroButton", () => ({ HeroButton: (props: { "aria-label"?: string; onPress?: (event: unknown) => Promise<void>; children?: ReactNode }) => {
  if (props["aria-label"] && props.onPress) ui.buttons.set(props["aria-label"], props.onPress);
  return <button>{props.children}</button>;
} }));

import { NotificationRail } from "./NotificationRail";

const round = {
  schemaVersion: 1, id: "mission-round:actual", version: 1, kind: "mission-round", title: "10 月 Mission Card · 灯塔项目",
  objectRef: { type: "mission-round", id: "actual", version: 1 },
  payload: { ...personalPayload.round, phase: "draft", cards: [{ ...personalPayload.round.cards[0], cardId: "first-personal-card" }] }, actions: [],
} as Card;
const event = { target: { closest: () => null } };

beforeEach(() => { vi.clearAllMocks(); ui.buttons.clear(); ui.refreshEffect = undefined; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("CEO 通知栏里的任务卡轮次", () => {
  function render(card: Card) {
    const onNavigate = vi.fn();
    renderToStaticMarkup(<NotificationRail cards={[card]} onNavigate={onNavigate} />);
    const press = [...ui.buttons.entries()].find(([label]) => label.startsWith("10 月 Mission Card") || label.startsWith("白田田"))?.[1];
    return { press: () => press!(event), onNavigate };
  }

  it("轮次直接打开第一张任务卡", async () => {
    const view = render(round);
    await view.press();
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
});
