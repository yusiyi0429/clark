import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 约定与对表的请求：React 换成按调用顺序记账的版本（同 useTaskDeliverable.test），fetch 换成桩。 */
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, effects: [] as (() => void | (() => void))[],
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[index]) : next; }];
  },
  useRef(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useCallback(callback: unknown) { return callback; },
  useEffect(effect: () => void | (() => void)) { hooks.effects.push(effect); },
}));
vi.mock("react", () => hooks);

import { useTaskAgreement } from "./useTaskAgreement";

const agreement = (patch: Record<string, unknown> = {}) => ({ taskId: "task 1", taskName: "对话质量达标", missionId: "m1", basis: "acceptance", source: "none",
  criteria: [{ index: 1, text: "一", proof: null, acceptor: null }], exclusions: [], complete: false, basisChanged: false, canEdit: true, updatedBy: null, updatedAt: null, ...patch });
const check = { taskId: "task 1", verdict: "not_ready", conclusion: "还不能交：差第 1 条。", notices: [], source: "none", criteria: [], version: null, beyondScope: [], canNotify: true };
const json = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body });
const fetchMock = vi.fn();
function render() { hooks.index = 0; hooks.effects = []; return useTaskAgreement("task 1"); }
/** 打开面板：跑一遍挂载时的 effect，等约定读到。 */
async function open(body = agreement()) {
  fetchMock.mockResolvedValueOnce(json(200, body));
  render();
  hooks.effects.forEach((effect) => effect());
  await vi.waitFor(() => expect(render().agreement).not.toBeNull());
}
const call = (n: number) => fetchMock.mock.calls[n] as [string, RequestInit | undefined];

beforeEach(() => {
  hooks.values = []; fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { location: { assign: vi.fn(), pathname: "/me", search: "" } });
});
afterEach(() => vi.unstubAllGlobals());

describe("一个 Task 的约定与对表", () => {
  it("打开就读约定；对表点了才取；对表开着时存好约定再对一次（PUT 整份）", async () => {
    await open();
    expect(call(0)[0]).toBe("/api/plan-tasks/task%201/agreement");
    expect(render().check).toBeNull();

    fetchMock.mockResolvedValueOnce(json(200, check));
    await render().runCheck();
    expect(call(1)[0]).toBe("/api/plan-tasks/task%201/check");
    expect(render().check?.conclusion).toBe("还不能交：差第 1 条。");

    const saved = agreement({ source: "tianshu", criteria: [{ index: 1, text: "一", proof: "上线记录", acceptor: null }], complete: true });
    fetchMock.mockResolvedValueOnce(json(200, saved)).mockResolvedValueOnce(json(200, { ...check, verdict: "ready" }));
    expect(await render().save({ criteria: [{ index: 1, proof: "上线记录", acceptorId: null }], exclusions: [] })).toBeNull();
    expect(call(2)[0]).toBe("/api/plan-tasks/task%201/agreement");
    expect(call(2)[1]).toMatchObject({ method: "PUT", body: JSON.stringify({ criteria: [{ index: 1, proof: "上线记录", acceptorId: null }], exclusions: [] }) });
    expect(render().agreement?.source).toBe("tianshu");
    await vi.waitFor(() => expect(render().check?.verdict).toBe("ready"));
    expect(call(3)[0]).toBe("/api/plan-tasks/task%201/check");
  });

  it("约定其实来自本体（409 AGREEMENT_FROM_WORLD）：给服务端那句话，并重读约定", async () => {
    await open();
    fetchMock.mockResolvedValueOnce(json(409, { code: "AGREEMENT_FROM_WORLD", message: "这个 Task 的约定在本体里，这里不能改" }))
      .mockResolvedValueOnce(json(200, agreement({ source: "world", canEdit: false })));
    expect(await render().save({ criteria: [], exclusions: [] })).toBe("这个 Task 的约定在本体里，这里不能改");
    await vi.waitFor(() => expect(render().agreement?.canEdit).toBe(false));
    expect(call(2)[0]).toBe("/api/plan-tasks/task%201/agreement");
  });

  it("请 X 看：推了或今天已推过都记成请过；飞书没接时置灰、不报错；这一条已经不是要确认时给那句话并重新对表", async () => {
    await open();
    fetchMock.mockResolvedValueOnce(json(200, { status: "already_sent" }));
    expect(await render().notify(2, "yang")).toBeNull();
    expect(call(1)).toEqual(["/api/plan-tasks/task%201/check/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ index: 2, personId: "yang" }) }]);
    expect(render().asked).toEqual([2]);

    fetchMock.mockResolvedValueOnce(json(503, { code: "FEISHU_NOT_CONFIGURED", message: "飞书没接" }));
    expect(await render().notify(1, "yang")).toBeNull();
    expect(render().feishuOff).toBe(true);
    expect(render().asked).toEqual([2]);

    fetchMock.mockResolvedValueOnce(json(409, { code: "NOT_AWAITING_ACCEPTOR", message: "这一条现在不用确认" })).mockResolvedValueOnce(json(200, check));
    expect(await render().notify(1, "yang")).toBe("这一条现在不用确认");
    await vi.waitFor(() => expect(render().check).not.toBeNull());
  });

  it("对表没成：留着服务端那句话，不画结果", async () => {
    await open();
    fetchMock.mockResolvedValueOnce(json(403, { code: "FORBIDDEN", message: "看不到这个 Task" }));
    await render().runCheck();
    expect(render().check).toBeNull();
    expect(render().checkError).toBe("看不到这个 Task");
    expect(render().checking).toBe(false);
  });
});
