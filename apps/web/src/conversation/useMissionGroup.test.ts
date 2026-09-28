import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[], states: [] as unknown[] }));
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => {
    const index = hooks.states.length;
    hooks.states.push(initial);
    return [initial, (next: unknown) => { hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next; }];
  },
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
}));
import { useMissionGroup } from "./useMissionGroup";
import type { MissionGroupView, PersonalMissionGroup } from "./missionCardGroup";

const cleanups: (() => void)[] = [];
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const empty: MissionGroupView = { entries: [], members: [], lastReadSeq: 0, unread: 0, roundVersion: 1 };
let fetchMock = vi.fn();
beforeEach(() => {
  hooks.states = []; hooks.effects = [];
  vi.useFakeTimers();
  fetchMock = vi.fn().mockResolvedValue(response(empty));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.useRealTimers(); vi.unstubAllGlobals(); });
function start(visible = false) {
  const group: PersonalMissionGroup = { cardId: "card", viewerId: "member", phase: "open", round: 1, members: [], onRefresh: vi.fn(), onRemoveReference: vi.fn() };
  const hook = useMissionGroup(group, visible);
  hooks.effects.forEach((effect) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); });
  return { hook, group };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("任务卡群组的请求与重试", () => {
  it("没有新 seq 的逐条处理也刷新正文并重新取得已有意见的处理结果", async () => {
    const message = { type: "message", feedback: { id: "f", seq: 7, createdAt: "2026-10-01T00:00:00Z", verdict: { text: "待拍板人处理", tone: "wait" } } };
    fetchMock.mockResolvedValueOnce(response({ ...empty, entries: [message] }));
    const { group } = start(); await flush();
    vi.mocked(group.onRefresh).mockClear();
    fetchMock.mockResolvedValueOnce(response({ ...empty, roundVersion: 2 }));
    fetchMock.mockResolvedValueOnce(response({ ...empty, roundVersion: 2, entries: [{ ...message, feedback: { ...message.feedback, verdict: { text: "已采纳 · 拍板前可能变化", tone: "accept" } } }] }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain("after=0");
    expect(group.onRefresh).toHaveBeenCalledOnce();
    expect(JSON.stringify(hooks.states[0])).toContain("已采纳 · 拍板前可能变化");
    fetchMock.mockResolvedValue(response({ ...empty, roundVersion: 2 }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain("after=7");
    expect(group.onRefresh).toHaveBeenCalledOnce();
  });
  it("每三秒增量读取，新的公开意见触发整页刷新", async () => {
    const { group } = start(); await flush();
    vi.mocked(group.onRefresh).mockClear();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(response({ ...empty, unread: 1, entries: [{ type: "message", feedback: { id: "f", seq: 7, createdAt: "2026-10-01T00:00:00Z" } }] }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(group.onRefresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain("after=7");
  });
  it("没有新意见，别人开放讨论或重新开启也刷新阶段", async () => {
    const { group } = start(); await flush();
    vi.mocked(group.onRefresh).mockClear();
    const opened = { ...empty, entries: [{ type: "opening", at: "2026-10-01T00:00:00Z", text: "统一开放" }] };
    fetchMock.mockResolvedValue(response(opened));
    await vi.advanceTimersByTimeAsync(3000);
    expect(group.onRefresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000);
    expect(group.onRefresh).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValue(response({ ...opened, entries: [...opened.entries, { type: "divider", at: "2026-10-03T00:00:00Z", text: "重新开启" }] }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(group.onRefresh).toHaveBeenCalledTimes(2);
  });
  it("轮询恢复后清除连接失败提示", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    start(); await flush();
    expect(hooks.states[1]).toContain("连接成功");
    await vi.advanceTimersByTimeAsync(3000);
    expect(hooks.states[1]).toBeNull();
  });
  it.each([false, true])("只在实际可见时登记已读：%s", async (visible) => {
    fetchMock.mockResolvedValue(response({ ...empty, entries: [{ type: "message", feedback: { id: "f", seq: 7, createdAt: "2026-10-01T00:00:00Z" } }] }));
    start(visible); await flush();
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/group/read"))).toBe(visible);
  });
  it("网络失败后重发相同内容沿用 clientId；改写内容会换幂等键", async () => {
    const { hook } = start(); await flush();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await hook.send("原输入", null)).toBe(false);
    const first = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await hook.send("原输入", null)).toBe(false);
    const retry = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
    expect(retry.clientId).toBe(first.clientId);
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await hook.send("修改输入", null);
    const changed = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
    expect(changed.clientId).not.toBe(first.clientId);
    expect(hooks.states[1]).toBe("offline");
  });
  it("引用发送保持锚点和原版本；409 返回失败并刷新事实", async () => {
    const { hook, group } = start(); await flush();
    vi.mocked(group.onRefresh).mockClear();
    fetchMock.mockResolvedValueOnce(response({ message: "引用内容已经变化，请重新划选" }, 409));
    const quote = { missionId: "m", field: "why" as const, quote: "这段话", sourceVersion: 2, nonce: 1 };
    expect(await hook.send("讨论这段", quote)).toBe(false);
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({ kind: "quote", missionId: "m", field: "why", quote: "这段话", sourceVersion: 2, round: 1 });
    expect(group.onRefresh).toHaveBeenCalledOnce();
  });
});
