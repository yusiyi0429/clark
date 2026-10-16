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
  it("sends an explicit Anchor selection separately and keeps failed input retryable", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 409,
      json: async () => ({ code: "ANCHOR_VERSION_CONFLICT" }) }).mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    const selection = { cardId: "issue:selected", version: 3, selectedText: "第二项" };
    const accepted = await useConversation("issue:selected", null, selection).send("请解释", []);
    expect(accepted).toBe(false);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ message: "请解释", anchorSelection: selection, references: [] });
  });

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

it("reuses a UUID7 logical turn after failure and allocates a new one after completion", async () => {
  const requests: { logicalTurnId: string }[] = [];
  let posts = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method !== "POST") return { ok: true, json: async () => ({ messages: [] }) };
    requests.push(JSON.parse(String(options.body)));
    if (++posts === 1) return { ok: false, status: 503, json: async () => ({ code: "UNAVAILABLE" }) };
    return streamedTool("read_anchor");
  }));
  const conversation = useConversation("global");
  expect(await conversation.send("hello", [])).toBe(false);
  expect(await conversation.send("hello", [])).toBe(true);
  expect(await conversation.send("hello", [])).toBe(true);
  expect(requests[0].logicalTurnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/);
  expect(requests[1].logicalTurnId).toBe(requests[0].logicalTurnId);
  expect(requests[2].logicalTurnId).not.toBe(requests[1].logicalTurnId);
});
