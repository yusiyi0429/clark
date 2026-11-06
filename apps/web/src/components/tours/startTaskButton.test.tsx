import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ui = vi.hoisted(() => ({ press: null as ((event: { target: unknown }) => void) | null }));
// 看过演示：点了直接去新建页（没看过时先放演示，看完走同一个地址）。
vi.mock("@/lib/useSeenMarks", () => ({ useSeenMarks: () => ({ seen: new Set(["execution-items-tour"]), mark: vi.fn() }) }));
vi.mock("./ExecutionItemsTour", () => ({ EXECUTION_TOUR_KEY: "execution-items-tour", ExecutionItemsTour: () => null }));
vi.mock("ts-design/primitives", () => ({ Button: ({ children, onPress }: { children?: ReactNode; onPress: (event: { target: unknown }) => void }) => {
  ui.press = onPress;
  return <button>{children}</button>;
} }));

const { StartTaskButton } = await import("./StartTaskButton");

beforeEach(() => { ui.press = null; });

describe("开启执行事项去哪儿", () => {
  it("从某个 Task 里点：新建页地址带上这个 Mission 和 Task；别处点：只是新建页", () => {
    const onNavigate = vi.fn();
    const target = {};
    renderToStaticMarkup(<StartTaskButton onNavigate={onNavigate} missionId="m1" taskId="t 2" />);
    ui.press!({ target });
    expect(onNavigate).toHaveBeenLastCalledWith("/me/tasks/new?missionId=m1&taskId=t+2", target);
    renderToStaticMarkup(<StartTaskButton onNavigate={onNavigate} />);
    ui.press!({ target });
    expect(onNavigate).toHaveBeenLastCalledWith("/me/tasks/new", target);
  });
});
