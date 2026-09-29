import { afterEach, beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[] }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => [initial, vi.fn()],
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
}));
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: api.get, POST: api.post } }));

import { catchUpMessage, useTaskGroup, useThreadGroup } from "./useTaskGroup";

const message = { id: 2, kind: "member", authorId: "sun", authorName: "孙铭泽", content: "先核对试点", quote: null, createdAt: "2026-09-27T00:00:00Z" };
const view = { members: [{ personId: "sun", displayName: "孙铭泽", title: null }], messages: [{ ...message, id: 0, kind: "co-agent" }, message], lastReadId: 0, unread: 1 };
const cleanups: (() => void)[] = [];
beforeEach(() => {
  hooks.effects = []; vi.useFakeTimers();
  api.get.mockReset().mockResolvedValue({ data: view, response: { status: 200 } });
  api.post.mockReset().mockResolvedValue({ data: { lastReadId: 2, unread: 0 } });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("window", { setInterval, clearInterval });
});
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.useRealTimers(); vi.unstubAllGlobals(); });

function start(visible: boolean) {
  const result = useTaskGroup("task-1", visible);
  hooks.effects.forEach((effect) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); });
  return result;
}

it("详情每三秒读事项线程，群组可见时把最新消息标已读", async () => {
  start(true); await vi.advanceTimersByTimeAsync(0);
  expect(api.get).toHaveBeenCalledWith("/api/threads/{objectType}/{objectId}", { params: { path: { objectType: "task", objectId: "task-1" } } });
  expect(api.post).toHaveBeenCalledWith("/api/threads/{objectType}/{objectId}/read", { params: { path: { objectType: "task", objectId: "task-1" } }, body: { lastReadId: 2 } });
  await vi.advanceTimersByTimeAsync(3000);
  expect(api.get).toHaveBeenCalledTimes(2);
});

it("群组未展开时保留未读，发送走事项线程", async () => {
  const group = start(false); await vi.advanceTimersByTimeAsync(0);
  expect(api.post).not.toHaveBeenCalled();
  expect(await group.send("请一起核对")).toBe(true);
  expect(api.post).toHaveBeenCalledWith("/api/threads/{objectType}/{objectId}/messages", { params: { path: { objectType: "task", objectId: "task-1" } }, body: { content: "请一起核对" } });
});

it("会议群复用轮询、已读与发送路径", async () => {
  const group = useThreadGroup("meeting", "meeting-1", true);
  hooks.effects.forEach((effect) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); });
  await vi.advanceTimersByTimeAsync(0);
  expect(api.get).toHaveBeenCalledWith("/api/threads/{objectType}/{objectId}", { params: { path: { objectType: "meeting", objectId: "meeting-1" } } });
  expect(api.post).toHaveBeenCalledWith("/api/threads/{objectType}/{objectId}/read", { params: { path: { objectType: "meeting", objectId: "meeting-1" } }, body: { lastReadId: 2 } });
  expect(await group.send("会前看材料")).toBe(true);
  expect(api.post).toHaveBeenCalledWith("/api/threads/{objectType}/{objectId}/messages", { params: { path: { objectType: "meeting", objectId: "meeting-1" } }, body: { content: "会前看材料" } });
});

it("只有第一次进群时，Co-Agent 讲的最后一段才算来龙去脉", () => {
  const intro = { ...message, id: 5, kind: "co-agent" as const, authorId: null, authorName: null, content: "孙铭泽把你拉进了这个群……" };
  const messages = [{ ...message, id: 1, kind: "co-agent" as const }, message, intro, { ...message, id: 6 }];
  expect(catchUpMessage(messages as never, true)).toBe(5);
  expect(catchUpMessage(messages as never, false)).toBeNull();
  expect(catchUpMessage([message] as never, true)).toBeNull();
});
