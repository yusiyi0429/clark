import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { useTaskDeliverable } from "./useTaskDeliverable";

const version = (id: string, number: number) => ({ id, number, statement: null, createdAt: "2026-10-29T10:00:00.000Z", items: [], deliveredAt: null, note: null,
  review: { status: "queued", phase: null, startedAt: null, finishedAt: null, expectedSeconds: 120, basis: "acceptance", headline: null, summary: null, gain: null,
    score: null, met: 0, total: 0, ready: false, criteria: [], error: null } });
const json = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body });
const fetchMock = vi.fn();
const events: string[] = [];
function render() { hooks.index = 0; hooks.effects = []; return useTaskDeliverable("task 1"); }

beforeEach(() => {
  hooks.values = []; events.length = 0; fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { dispatchEvent: (event: Event) => { events.push(event.type); return true; }, location: { assign: vi.fn() },
    setInterval, clearInterval });
});
afterEach(() => vi.unstubAllGlobals());

describe("一个 Task 的交付物", () => {
  it("传新版本：文件、链接、现状、沿用哪几样一起放进一个表单；成功后新版本放最前面，并让首页计划重取", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { taskId: "task 1", responsibleId: null, responsibleName: null, canEdit: true, basis: "acceptance", criteria: ["一"], versions: [version("v1", 1)] }));
    const first = render();
    hooks.effects.forEach((effect) => effect());
    await vi.waitFor(() => expect(render().data?.versions).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/plan-tasks/task%201/deliverable");

    fetchMock.mockResolvedValueOnce(json(201, version("v2", 2)));
    const file = new File(["# 报告"], "报告.md");
    const result = await render().createVersion({ files: [file], links: ["https://example.com/a"], statement: "做完了", keep: ["i1"] });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/plan-tasks/task%201/deliverable/versions");
    const form = init.body as FormData;
    expect(form.getAll("files")).toHaveLength(1);
    expect(form.get("links")).toBe('["https://example.com/a"]');
    expect(form.get("statement")).toBe("做完了");
    expect(form.get("keep")).toBe('["i1"]');
    expect(render().data?.versions.map((item) => item.id)).toEqual(["v2", "v1"]);
    expect(events).toContain("home-plan-changed");
    expect(first.itemHref("x")).toBe("/api/plan-tasks/task%201/deliverable/items/x");
  });

  it("交付没成：返回服务端的那句话，不动已有的数据", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { taskId: "task 1", responsibleId: null, responsibleName: null, canEdit: true, basis: "acceptance", criteria: ["一"], versions: [version("v1", 1)] }));
    render();
    hooks.effects.forEach((effect) => effect());
    await vi.waitFor(() => expect(render().data?.versions).toHaveLength(1));
    fetchMock.mockResolvedValueOnce(json(409, { message: "参考评审还在跑，稍等几秒" }));
    expect(await render().deliver("v1")).toEqual({ ok: false, message: "参考评审还在跑，稍等几秒" });
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[0]).toBe("/api/plan-tasks/task%201/deliverable/versions/v1/deliver");
    expect(render().data?.versions.map((item) => item.id)).toEqual(["v1"]);
    expect(events).not.toContain("home-plan-changed");
  });
});
