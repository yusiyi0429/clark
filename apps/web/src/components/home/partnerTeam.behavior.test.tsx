import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TTeamDelivery } from "@warmap/contracts";

// Drive the production hook with the same synchronous hook runner used by the meeting form tests.
const hooks = vi.hoisted(() => ({
  position: 0, values: [] as unknown[],
  useState(initial: unknown) {
    const key = hooks.position++;
    if (!(key in hooks.values)) hooks.values[key] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[key], (next: unknown) => { hooks.values[key] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[key]) : next; }];
  },
  useRef(initial: unknown) {
    const key = hooks.position++;
    if (!(key in hooks.values)) hooks.values[key] = { current: initial };
    return hooks.values[key];
  },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()),
  useState: hooks.useState, useRef: hooks.useRef, useCallback: (f: unknown) => f, useMemo: (f: () => unknown) => f(), useEffect: () => undefined,
}));
const api = vi.hoisted(() => ({ people: vi.fn(), send: vi.fn(), chat: vi.fn() }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ viewerId: "me" }) }));
vi.mock("@/lib/home/teamDelivery", async (original) => ({ ...(await original<typeof import("@/lib/home/teamDelivery")>()),
  listTeamPeople: api.people, sendTeamDelivery: api.send,
}));
vi.mock("@/lib/home/colleagueChats", async (original) => ({ ...(await original<typeof import("@/lib/home/colleagueChats")>()),
  sendChatMessage: api.chat,
}));
import { usePartnerTeam } from "./PartnerTeam";
import { TeamCompose } from "./PartnerTeamCompose";

const recipient = { personId: "lin", displayName: "小林", status: "delivered" as const, replies: [], error: null };
const one: TTeamDelivery = { id: "00000000-0000-4000-8000-000000000001", kind: "share", text: "", createdAt: "2026-11-13T04:00:00Z",
  dueAt: null, sourceUrl: null, sender: { personId: "me", displayName: "甲" }, attachments: [], recipients: [recipient] };
const file = new File(["hello"], "反馈.txt", { type: "text/plain" });
const render = () => { hooks.position = 0; return usePartnerTeam(() => undefined); };
const compose = (surface: ReturnType<typeof render>) => {
  expect(surface.composer?.type).toBe(TeamCompose);
  return surface.composer!.props as Parameters<typeof TeamCompose>[0];
};

beforeEach(() => {
  hooks.position = 0; hooks.values = [];
  vi.resetAllMocks();
  api.people.mockResolvedValue([{ personId: "lin", displayName: "小林" }, { personId: "tang-1", displayName: "小唐" }, { personId: "tang-2", displayName: "小唐" }]);
  api.send.mockResolvedValue(one);
  api.chat.mockResolvedValue({});
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe("伙伴输入和同事草稿", () => {
  it("唯一点名直接投递一次；有服务端回执才绘制已发记录，附件不经过模型", async () => {
    const team = render();
    expect(await team.intercept("总结这个文件", [file])).toBe(false);
    expect(api.send).not.toHaveBeenCalled();
    expect(await team.intercept("发给小林的伙伴", [file])).toBe(true);
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.send.mock.calls[0][0]).toMatchObject({ kind: "share", recipientIds: ["lin"] });
    expect(api.send.mock.calls[0][1]).toEqual([file]);
    const next = render();
    expect(next.composer).toBeNull();
    expect(next.blocks.map((block) => block.key)).toEqual(["team-request:" + one.id]);
  });

  it("重名先核对；发送失败保留正文、文件与操作 ID，只有成功后关闭", async () => {
    await render().intercept("发给小唐的伙伴", [file]);
    let form = compose(render());
    expect(form.draft.unresolved).toEqual(["小唐"]);
    expect(form.draft.recipientIds).toEqual([]);
    expect(api.send).not.toHaveBeenCalled();
    form.onChange({ recipientIds: ["tang-2"], text: "只给这一版" });
    form = compose(render());
    api.send.mockRejectedValueOnce(new Error("请重试"));
    form.onSend();
    await vi.waitFor(() => expect(compose(render()).draft.error).toBe("请重试"));
    const failed = compose(render());
    expect(failed.draft.files).toEqual([file]);
    expect(failed.draft.text).toBe("只给这一版");
    failed.onSend();
    await vi.waitFor(() => expect(render().composer).toBeNull());
    expect(api.send.mock.calls[0][0].clientId).toBe(api.send.mock.calls[1][0].clientId);
    expect(api.send.mock.calls[1][0].recipientIds).toEqual(["tang-2"]);
  });

  it("裸文件和一句临时征集保留待选名单、原话和截止；普通对话不消费", async () => {
    const team = render();
    await team.intercept("", [file]);
    let form = compose(render());
    expect(form.draft.files[0]).toBe(file);
    form.onClose();
    await render().intercept("请小林和销售各给我两条客户反馈，周四前回", []);
    form = compose(render());
    expect(form.draft.kind).toBe("question"); expect(form.draft.recipientIds).toEqual(["lin"]);
    expect(form.draft.unresolved).toEqual(["销售"]);
    expect(form.draft.dueAt).toContain("T23:59");
    expect(api.send).not.toHaveBeenCalled();
  });

  it("只点一个人、没附件、没截止的问句发进对话；点两个人照旧征集；对方不在覆盖里退回征集", async () => {
    api.people.mockResolvedValue([{ personId: "lin", displayName: "小林" }, { personId: "zhou", displayName: "小周" }]);
    const team = render();
    await team.intercept("问 小林：部署怎么拆", []);
    expect(api.chat).toHaveBeenCalledWith("lin", expect.objectContaining({ text: "部署怎么拆", via: "main" }));
    expect(api.send).not.toHaveBeenCalled();
    expect(render().composer).toBeNull();
    await render().intercept("问 小林、小周：部署怎么拆", []);
    expect(api.send).toHaveBeenCalledTimes(1);
    api.chat.mockRejectedValueOnce(Object.assign(new Error("x"), { code: "PERSON_NOT_FOUND" }));
    await render().intercept("问 小林：值守是谁", []);
    expect(api.send).toHaveBeenCalledTimes(2);
  });
});
