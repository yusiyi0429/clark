import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({ useCallback: (callback: unknown) => callback, useEffect: () => {},
  useRef: (current: unknown) => ({ current }), useState: (initial: unknown) => [initial, vi.fn()] }));
import { failureCopy, useConversation } from "./useConversation";

const dispatch = vi.fn();
/** 每一轮都有的「发出 / 结束」通知单独记，下面只看业务刷新事件。 */
const turns: { type: string; options: { detail: unknown } }[] = [];
beforeEach(() => {
  turns.length = 0;
  vi.stubGlobal("window", { dispatchEvent: (event: { type: string; options: { detail: unknown } }) => (/^conversation-turn-/.test(event.type) ? turns.push(event) : dispatch(event)), location: { assign: vi.fn() } });
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

describe("Anchor（页面聚焦的卡）随每一句发出", () => {
  it("请求体带 anchorSelection；ANCHOR_NOT_FOUND 在服务端接下之前失败，返回 false 让输入条保留原文", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ code: "ANCHOR_NOT_FOUND", message: "Anchor not found" }) })
      .mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    const anchor = { cardId: "mission-card:card-01", version: 3 };
    expect(await useConversation("mission-card:card-01", null, undefined, anchor).send("这张卡还差什么", [])).toBe(false);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(post[1].body)).toMatchObject({ message: "这张卡还差什么", references: [], anchorSelection: anchor });
    expect(failureCopy("ANCHOR_NOT_FOUND", "Anchor not found")).toBe("当前页面上的卡已不存在或看不到，请刷新后再发。");
  });
});

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

describe("材料修改后即时刷新", () => {
  it.each(["edit_material", "create_material", "propose_material_edit"])("%s 成功后重读当前对象材料", async (name) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(streamedTool(name))
      .mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) }));
    await useConversation("meeting:meeting-01").send("修改这份材料", []);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ type: "materials-changed", options: { detail: { scope: "meeting:meeting-01" } } });
  });

});

describe("每一轮的发出 / 结束通知（月度计划逐段意见据此重读）", () => {
  it("发出时带这句原文，结束时（成功或失败）各通知一次，都带本对话的 scope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(streamedTool("read_business_object"))
      .mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) }));
    await useConversation("monthly-plan:p1").send("现金流要写进去", []);
    expect(turns.map((event) => event.type)).toEqual(["conversation-turn-sent", "conversation-turn-settled"]);
    expect(turns[0].options.detail).toEqual({ scope: "monthly-plan:p1", content: "现金流要写进去" });
    expect(turns[1].options.detail).toEqual({ scope: "monthly-plan:p1" });
    turns.length = 0;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ code: "TURN_IN_PROGRESS" }) })
      .mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) }));
    expect(await useConversation("monthly-plan:p1").send("再说一句", [])).toBe(false);
    expect(turns.map((event) => event.type)).toEqual(["conversation-turn-sent", "conversation-turn-settled"]);
  });
});
