import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({ useCallback: (callback: unknown) => callback, useEffect: () => {},
  useRef: (current: unknown) => ({ current }), useState: (initial: unknown) => [initial, vi.fn()] }));
import { useConversation } from "./useConversation";

const dispatch = vi.fn();
beforeEach(() => {
  vi.stubGlobal("window", { dispatchEvent: dispatch, location: { assign: vi.fn() } });
  vi.stubGlobal("CustomEvent", class { constructor(public type: string, public options: { detail: unknown }) {} });
  dispatch.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

function streamedTool(name: string, phase = "completed", isError = false) {
  const text = [`data: ${JSON.stringify({ type: "tool", name, phase, isError })}\n\n`,
    'data: {"type":"done","status":"completed"}\n\n'].join("");
  let read = false;
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => {
    if (read) return { done: true, value: undefined };
    read = true; return { done: false, value: new TextEncoder().encode(text) };
  } }) } };
}

describe("任务卡私聊工具完成后同步正文与批注", () => {
  it.each(["edit_mission_card", "edit_my_mission_card", "ask_mission_card_question"])("%s 成功完成即发送当前卡的刷新事件", async (tool) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(streamedTool(tool))
      .mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await useConversation("mission-card:card-01").send("修改这段", [])).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0]).toMatchObject({ type: "mission-card-changed", options: { detail: { scope: "mission-card:card-01" } } });
  });

  it.each([
    ["edit_mission_card", "started", false], ["edit_mission_card", "completed", true],
    ["ask_mission_card_question", "completed", true], ["read_mission_card", "completed", false],
  ])("%s / %s / error=%s 不发送修改事件", async (name, phase, isError) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(streamedTool(name, phase, isError))
      .mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) }));
    await useConversation("mission-card:card-01").send("读这段", []);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
