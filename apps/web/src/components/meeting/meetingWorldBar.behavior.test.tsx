import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TMeetingWorldView } from "@warmap/contracts";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0,
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[index]) : next;
    }];
  },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()),
  useState: hooks.useState, useEffect: () => undefined, useMemo: (fn: () => unknown) => fn() }));
const api = vi.hoisted(() => ({ put: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: { PUT: api.put, GET: api.get } }));

import { MeetingWorldBar } from "./MeetingWorldBar";
import { WorldAnchors } from "./WorldAnchors";

type Node = { type?: unknown; props?: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return node.props ? [node, ...nodes(node.props.children)] : [];
}
const text = (node: Node): string => {
  const children = node.props?.children;
  return (Array.isArray(children) ? children : [children]).map((child) => (typeof child === "string" ? child : child && typeof child === "object" ? text(child as Node) : "")).join("");
};

const MISSION = { kind: "mission" as const, id: "m-v2", title: "接口全量切到 v2" };
const world = (overrides: Partial<TMeetingWorldView> = {}): TMeetingWorldView => ({
  excluded: false, excludedBy: null, status: "committed", at: "2026-10-19T10:42:00.000Z", anchors: [MISSION], edited: false, canEdit: true, ...overrides,
});
const render = (view: TMeetingWorldView, onChange = vi.fn()) => {
  hooks.index = 0;
  return nodes(MeetingWorldBar({ meetingId: "m1", world: view, onChange }));
};

beforeEach(() => { hooks.values = []; api.put.mockReset(); api.get.mockReset(); });

describe("会议页：这场会挂到哪、写进本体没有、不写进本体", () => {
  it("主持人：挂点带已记的绿点，能改、能开关；开了以后调接口，挂点划掉、写明谁标的", async () => {
    const tree = render(world());
    const anchors = tree.find((node) => node.type === WorldAnchors)!;
    expect(anchors.props).toMatchObject({ anchors: [MISSION], tone: "ok" });
    expect(tree.some((node) => node.type === "button" && text(node) === "改")).toBe(true);
    expect(tree.some((node) => node.type === "span" && text(node) === "已记 · 10/19 18:42")).toBe(true);
    const toggle = tree.find((node) => node.props?.role === "switch")!;
    expect(toggle.props).toMatchObject({ "aria-checked": false });

    const excluded = world({ excluded: true, excludedBy: "林晓", status: "withdrawn" });
    api.put.mockResolvedValue({ data: { world: excluded, decisions: [] }, response: { ok: true, status: 200 } });
    const onChange = vi.fn();
    hooks.index = 0;
    (nodes(MeetingWorldBar({ meetingId: "m1", world: world(), onChange })).find((node) => node.props?.role === "switch")!.props!.onClick as () => void)();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith({ world: excluded, decisions: [] }));
    expect(api.put).toHaveBeenCalledWith("/api/meetings/{id}/world-excluded", { params: { path: { id: "m1" } }, body: { excluded: true } });

    const after = render(excluded);
    expect(after.find((node) => node.type === WorldAnchors)!.props).toMatchObject({ tone: "off" });
    expect(after.some((node) => node.type === "span" && text(node) === "林晓 · 已撤回")).toBe(true);
    expect(after.some((node) => node.type === "button" && text(node) === "改")).toBe(false);
  });

  it("参会人：只看挂点，没有状态、没有开关", () => {
    const tree = render(world({ status: null, at: null, canEdit: false }));
    expect(tree.find((node) => node.type === WorldAnchors)!.props).toMatchObject({ anchors: [MISSION], tone: undefined });
    expect(tree.some((node) => node.props?.role === "switch")).toBe(false);
    expect(tree.some((node) => node.type === "button" && text(node) === "改")).toBe(false);
  });

  it("改挂点：列本月 Mission 和单元，选了保存；改过的可以恢复自动", async () => {
    const unit = { kind: "unit" as const, id: "agents", title: "智能体" };
    api.get.mockResolvedValue({ data: { options: [MISSION, unit] }, response: { ok: true, status: 200 } });
    const view = world({ edited: true });
    (render(view).find((node) => node.type === "button" && text(node) === "改")!.props!.onClick as () => void)();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
    await vi.waitFor(() => expect(render(view).some((node) => node.props?.["aria-pressed"] !== undefined)).toBe(true));
    const picker = render(view);
    expect(picker.filter((node) => node.props?.["aria-pressed"] !== undefined).map((node) => node.props!["aria-pressed"])).toEqual([true, false]);
    (picker.find((node) => node.props?.["aria-pressed"] === false)!.props!.onClick as () => void)();
    expect(render(view).some((node) => node.type === "button" && text(node) === "恢复自动")).toBe(true);

    api.put.mockResolvedValue({ data: { world: world({ anchors: [MISSION, unit], edited: true }), decisions: [] }, response: { ok: true, status: 200 } });
    (render(view).find((node) => node.type === "button" && text(node) === "保存")!.props!.onClick as () => void)();
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/meetings/{id}/world-anchors",
      { params: { path: { id: "m1" } }, body: { anchors: [{ kind: "mission", id: "m-v2" }, { kind: "unit", id: "agents" }] } }));
  });
});
