import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TFeishuMinuteInboxItem, TWorldAnchorOption } from "@warmap/contracts";
import { SidePanel } from "@/components/ui/SidePanel";

/* 把表单当函数调用：hooks 用按调用顺序存值的小仓库代替；useEffect 在依赖变了时同步跑一次（同 meetingWorldBar.behavior.test）。 */
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, deps: [] as (unknown[] | undefined)[], effectIndex: 0,
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[index]) : next;
    }];
  },
  useEffect(effect: () => void, deps?: unknown[]) {
    const index = hooks.effectIndex++;
    const previous = hooks.deps[index];
    if (previous && deps && deps.every((value, at) => Object.is(value, previous[at]))) return;
    hooks.deps[index] = deps;
    effect();
  },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()),
  useState: hooks.useState, useEffect: hooks.useEffect, useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: api.get, POST: api.post } }));
const workspace = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => workspace }));

import { MeetingBookingSheet } from "./MeetingBookingSheet";
import { WorldAnchorPicker } from "./WorldAnchorPicker";
import { DatePicker } from "@/components/ui/DatePicker";
import { Select } from "@/components/ui/Select";

type Node = { type?: unknown; props?: Record<string, unknown> };
const PARTS = new Set<unknown>([WorldAnchorPicker]);
function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (!value || typeof value !== "object") return value;
  const node = value as Node;
  if (typeof node.type === "function" && PARTS.has(node.type)) return expand((node.type as (props: unknown) => unknown)(node.props));
  return node.props ? { ...node, props: { ...node.props, children: expand(node.props.children) } } : value;
}
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

const MEMBER = { personId: "p-member", role: "member" as const, displayName: "林晓" };
const CEO = { personId: "p-ceo", role: "ceo" as const, displayName: "王总" };
const PEOPLE = [
  { personId: "p-member", displayName: "林晓", roles: ["dri"] },
  { personId: "p-ceo", displayName: "王总", roles: ["ceo", "dri"] },
  { personId: "p-third", displayName: "周舟", roles: ["dri"] },
];
const PO: TWorldAnchorOption = { kind: "po", id: "<po-oct>", title: "E&O 10 月目标", brief: "十月把预约跑通", lifecycle: "committed" };
const MISSION: TWorldAnchorOption = { kind: "mission", id: "m-draft", title: "草稿 Mission", brief: null, lifecycle: "draft" };

const render = (viewer: typeof MEMBER | typeof CEO) => {
  hooks.index = 0;
  hooks.effectIndex = 0;
  return nodes(expand(MeetingBookingSheet({ open: true, onClose: vi.fn(), viewer })));
};
const field = (tree: Node[], label: string) => tree.find((node) => node.props?.["aria-label"] === label || node.props?.label === label)!;
const change = (node: Node, value: unknown) => (node.props!.onChange as (next: unknown) => void)(value);
const button = (tree: Node[], label: string) => tree.find((node) => node.type === "button" && text(node) === label)!;

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  hooks.values = []; hooks.deps = [];
  api.get.mockReset(); api.post.mockReset(); workspace.navigate.mockReset();
  api.get.mockImplementation(async (path: string) => path === "/api/people"
    ? { data: { people: PEOPLE }, response: { ok: true, status: 200 } }
    : path === "/api/people/directory"
      ? { data: { people: PEOPLE.map(({ personId, displayName }) => ({ personId, displayName })) }, response: { ok: true, status: 200 } }
      : { data: { options: [PO, MISSION] }, response: { ok: true, status: 200 } });
});

/** 填名称、日期、起止（10:00–11:30），等挂点选项到。 */
async function fill(viewer: typeof MEMBER | typeof CEO) {
  change(field(render(viewer), "名称"), { target: { value: "预约周会" } });
  change(render(viewer).find((node) => node.type === DatePicker)!, "2026-10-22");
  change(render(viewer).find((node) => node.type === Select && node.props?.["aria-label"] === "开始")!, "10:00");
  change(render(viewer).find((node) => node.type === Select && node.props?.["aria-label"] === "结束")!, "11:30");
  await vi.waitFor(() => expect(render(viewer).some((node) => node.props?.["aria-pressed"] !== undefined)).toBe(true));
  expect(api.get).toHaveBeenCalledWith("/api/world-anchor-options", { params: { query: { period: "2026-10" } } });
}

describe("约会议", () => {
  it("没选挂点时约不了", async () => {
    await fill(MEMBER);
    expect(button(render(MEMBER), "约好").props!.disabled).toBe(true);
    (render(MEMBER).find((node) => node.props?.["aria-pressed"] === false)!.props!.onClick as () => void)();
    expect(button(render(MEMBER), "约好").props!.disabled).toBe(false);
    change(render(MEMBER).find((node) => node.type === Select && node.props?.["aria-label"] === "结束")!, "09:30");
    expect(button(render(MEMBER), "约好").props!.disabled).toBe(true);
  });

  it("开始、横线、结束在同一行", () => {
    const row = render(MEMBER).find((node) => Array.isArray(node.props?.children) && (node.props!.children as Node[]).some((child) => child?.props?.["aria-label"] === "开始"))!;
    expect(row.type).toBe("div");
    expect((row.props!.children as Node[]).map((child) => child.props?.["aria-label"] ?? text(child))).toEqual(["开始", "–", "结束"]);
  });

  it("成员只能约自己主持的会", async () => {
    const tree = render(MEMBER);
    // 成员：主持人就是登录的本人；参会人从人员名册选，不读带角色的人员目录。
    expect(api.get).toHaveBeenCalledWith("/api/people/directory");
    expect(api.get).not.toHaveBeenCalledWith("/api/people");
    expect(tree.some((node) => node.type === Select && node.props?.["aria-label"] === "主持人")).toBe(false);
    expect(field(tree, "主持人").type).toBe("output");
    expect(text(field(tree, "主持人"))).toBe("林晓");

    hooks.values = []; hooks.deps = [];
    await vi.waitFor(() => expect(render(CEO).some((node) => node.type === Select && node.props?.["aria-label"] === "主持人" && (node.props.options as unknown[]).length === 3)).toBe(true));
  });

  it("提交带上挂点", async () => {
    await fill(MEMBER);
    (render(MEMBER).find((node) => node.props?.["aria-pressed"] === false && nodes(node).some((child) => text(child) === PO.title))!.props!.onClick as () => void)();
    api.post.mockResolvedValue({ data: { card: { objectRef: { id: "m-new" }, navigation: [{ href: "/me/meetings/m-new", label: "会议" }] } }, response: { ok: true, status: 200 } });
    (button(render(MEMBER), "约好").props!.onClick as () => void)();
    await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
    const [path, { body }] = api.post.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe("/api/meetings");
    expect(body.anchors).toEqual([{ kind: "po", id: PO.id }]);
    expect(body.title).toBe("预约周会");
    expect(body.leadDriId).toBeUndefined();
    expect(Date.parse(body.endsAt as string)).toBeGreaterThan(Date.parse(body.scheduledAt as string));
    expect(new Date(body.scheduledAt as string).toISOString()).toBe("2026-10-22T02:00:00.000Z");
    await vi.waitFor(() => expect(workspace.navigate).toHaveBeenCalledWith("/me/meetings/m-new"));
  });

  it("换了月份：旧选项先收起，读不到时标出来，再读到就清掉", async () => {
    await fill(MEMBER);
    let fail = true;
    api.get.mockImplementation(async (path: string, init?: { params?: { query?: { period?: string } } }) => {
      if (path !== "/api/world-anchor-options") return { data: { people: [] }, response: { ok: true, status: 200 } };
      if (init?.params?.query?.period === "2026-11" && fail) return { data: undefined, response: { ok: false, status: 500 } };
      return { data: { options: [PO] }, response: { ok: true, status: 200 } };
    });
    change(render(MEMBER).find((node) => node.type === DatePicker)!, "2026-11-03");
    render(MEMBER); // 这一遍跑换月的 effect（收起旧选项），下一遍才看得到
    expect(render(MEMBER).some((node) => node.props?.["aria-pressed"] !== undefined)).toBe(false);
    await vi.waitFor(() => expect(render(MEMBER).some((node) => node.props?.role === "alert" && text(node) === "没有读到对象")).toBe(true));
    expect(button(render(MEMBER), "约好").props!.disabled).toBe(true);
    fail = false;
    change(render(MEMBER).find((node) => node.type === DatePicker)!, "2026-12-01");
    change(render(MEMBER).find((node) => node.type === DatePicker)!, "2026-11-04");
    await vi.waitFor(() => expect(render(MEMBER).some((node) => node.props?.["aria-pressed"] !== undefined)).toBe(true));
    expect(render(MEMBER).some((node) => node.props?.role === "alert")).toBe(false);
  });
});

describe("整理会议", () => {
  /** 10/23 14:00–15:10（上海）飞书里直接开的会；孙铭泽、刘人豪对得上，另有 1 人对不上。 */
  const MINUTE: TFeishuMinuteInboxItem = {
    minuteToken: "obcn-minute-1", title: "产品周会", startsAt: "2026-10-23T06:00:00.000Z", endsAt: "2026-10-23T07:10:00.000Z",
    attendees: [{ personId: "p-sun", displayName: "孙铭泽" }, { personId: "p-liu", displayName: "刘人豪" }], otherAttendees: 1, suggestion: null,
  };
  const onClose = vi.fn(), onOrganized = vi.fn();
  const renderOrganize = () => {
    hooks.index = 0;
    hooks.effectIndex = 0;
    return nodes(expand(MeetingBookingSheet({ open: true, onClose, organize: { minute: MINUTE, meetingBase: "/me/meetings", onOrganized } })));
  };
  const pickPo = async () => {
    await vi.waitFor(() => expect(renderOrganize().some((node) => node.props?.["aria-pressed"] !== undefined)).toBe(true));
    (renderOrganize().find((node) => node.props?.["aria-pressed"] === false && nodes(node).some((child) => text(child) === PO.title))!.props!.onClick as () => void)();
  };
  beforeEach(() => { onClose.mockReset(); onOrganized.mockReset(); });

  it("整理：会名预填，时间只读带「飞书」，没有主持人和添加参会人", () => {
    const tree = renderOrganize();
    expect(tree.find((node) => node.type === SidePanel)!.props!.label).toBe("整理会议");
    expect(field(tree, "名称").props!.value).toBe("产品周会");
    expect(text(field(tree, "时间"))).toBe("10 月 23 日 14:00–15:10飞书");
    expect(tree.some((node) => node.props?.["aria-label"] === "主持人" || node.props?.["aria-label"] === "添加参会人")).toBe(false);
    expect(api.get).not.toHaveBeenCalledWith("/api/people/directory");
    expect(api.get).not.toHaveBeenCalledWith("/api/people");
  });

  it("参会人只读，对不上的置灰", () => {
    const tree = renderOrganize();
    const items = tree.filter((node) => node.type === "li");
    expect(items.map(text)).toEqual(["孙铭泽", "刘人豪", "+1"]);
    expect(items.map((node) => Boolean(node.props!["data-off"]))).toEqual([false, false, true]);
    expect(tree.some((node) => node.type === "button" && String(node.props?.["aria-label"] ?? "").startsWith("去掉"))).toBe(false);
  });

  it("挂到按妙记那个月取；整理后跳到会议页", async () => {
    renderOrganize();
    expect(api.get).toHaveBeenCalledWith("/api/world-anchor-options", { params: { query: { period: "2026-10" } } });
    await vi.waitFor(() => expect(renderOrganize().some((node) => node.props?.["aria-pressed"] !== undefined)).toBe(true));
    expect(button(renderOrganize(), "整理").props!.disabled).toBe(true);
    await pickPo();
    api.post.mockResolvedValue({ data: { meetingId: "m-new" }, response: { ok: true, status: 200 } });
    (button(renderOrganize(), "整理").props!.onClick as () => void)();
    await vi.waitFor(() => expect(workspace.navigate).toHaveBeenCalledWith("/me/meetings/m-new"));
    const [path, init] = api.post.mock.calls[0] as [string, { params: { path: { token: string } }; body: unknown }];
    expect(path).toBe("/api/me/feishu-minutes/{token}/organize");
    expect(init.params.path.token).toBe(MINUTE.minuteToken);
    expect(init.body).toEqual({ title: "产品周会", anchors: [{ kind: "po", id: PO.id }] });
    expect(onOrganized).toHaveBeenCalledWith("m-new");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("整理失败写原因", async () => {
    await pickPo();
    api.post.mockResolvedValue({ data: undefined, error: { code: "MINUTE_TAKEN" }, response: { ok: false, status: 409 } });
    (button(renderOrganize(), "整理").props!.onClick as () => void)();
    await vi.waitFor(() => expect(renderOrganize().some((node) => node.props?.role === "alert" && text(node) === "已经记到别的会上了")).toBe(true));
    expect(onClose).not.toHaveBeenCalled();
    expect(onOrganized).not.toHaveBeenCalled();
    expect(workspace.navigate).not.toHaveBeenCalled();
  });
});
