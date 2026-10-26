import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { TMeetingWorldView, TWorldAnchorOption } from "@warmap/contracts";

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
const api = vi.hoisted(() => ({ put: vi.fn(), get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: { PUT: api.put, GET: api.get, POST: api.post } }));

import { MeetingWorldBar } from "./MeetingWorldBar";
import { MinutesRecovery } from "./MeetingProgress";
import { WorldAnchorPicker } from "./WorldAnchorPicker";
import { WorldAnchors } from "./WorldAnchors";

type Node = { type?: unknown; props?: Record<string, unknown> };
/** 展开自己的子组件（挑挂点），库组件不展开。 */
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

const MISSION = { kind: "mission" as const, id: "m-v2", title: "接口全量切到 v2" };
const RECORD = { status: "committed" as const, version: 1, eventId: "ev-1", confirmedAt: "2026-10-19T10:40:00.000Z" };
const world = (overrides: Partial<TMeetingWorldView> = {}): TMeetingWorldView => ({
  excluded: false, excludedBy: null, record: RECORD, at: "2026-10-19T10:42:00.000Z", anchors: [MISSION], edited: false, canEdit: true, ...overrides,
});
const render = (view: TMeetingWorldView, progress?: unknown, onChange = vi.fn()) => {
  hooks.index = 0;
  return nodes(expand(MeetingWorldBar({ meetingId: "m1", world: view, onChange, progress: progress as never })));
};
const option = (anchor: { kind: TWorldAnchorOption["kind"]; id: string; title: string }, brief: string | null = null, lifecycle: string | null = null): TWorldAnchorOption =>
  ({ ...anchor, brief, lifecycle, ownerId: null, parentId: null });

beforeEach(() => { hooks.values = []; api.put.mockReset(); api.get.mockReset(); api.post.mockReset(); });

describe("会议页页头：这场会挂到哪", () => {
  it("挂到一行：挂点（类型 + 名称）后面紧跟「改」；不再有记录状态、写入小点；选了不写入时不能改", () => {
    const tree = render(world());
    const line = tree.find((node) => node.type === "div" && nodes(node.props?.children).some((child) => child.type === WorldAnchors))!;
    const parts = nodes(line.props!.children).filter((node) => node.type === "span" || node.type === WorldAnchors || node.type === "button");
    expect(parts.map((node) => node.type === WorldAnchors ? "anchors" : text(node))).toEqual(["挂到", "anchors", "改"]);
    expect(tree.find((node) => node.type === WorldAnchors)!.props).toEqual({ anchors: [MISSION] });
    expect(tree.some((node) => text(node).startsWith("记录 ·"))).toBe(false);
    expect(tree.some((node) => node.props?.["data-tone"] !== undefined)).toBe(false);

    hooks.values = [];
    const after = render(world({ excluded: true, excludedBy: "林晓", record: { ...RECORD, status: "excluded" } }));
    expect(after.some((node) => text(node).startsWith("记录 ·"))).toBe(false);
    expect(after.some((node) => node.type === "button" && text(node) === "改")).toBe(false);
  });

  it("挂到一行整行靠左：不再有推到右边的那一段；「改」是安静的文字链接", () => {
    const css = readFileSync(new URL("./meeting-decisions.module.css", import.meta.url), "utf8");
    expect(css).not.toContain(".worldEnd");
    expect(css).not.toContain("margin-left: auto");
    expect(css).toMatch(/\.anchorEdit \{[^}]*border: 0;[^}]*background: none;/);
  });

  it("参会人：只看挂点，不能改", () => {
    const tree = render(world({ record: null, at: null, canEdit: false }));
    expect(tree.find((node) => node.type === WorldAnchors)!.props).toEqual({ anchors: [MISSION] });
    expect(tree.some((node) => node.type === "button" && text(node) === "改")).toBe(false);
  });

  it("进度线排在挂到那一行下面", () => {
    const progress = <ol aria-label="进度"><li>等妙记</li></ol>;
    const tree = render(world(), progress);
    const order = tree.filter((node) => node.type === WorldAnchors || node.props?.["aria-label"] === "进度").map((node) => node.type === WorldAnchors ? "anchors" : "progress");
    expect(order).toEqual(["anchors", "progress"]);
  });

  it("会前也能看到挂点条", () => {
    const tree = render(world({ record: { ...RECORD, status: "pending", eventId: null, confirmedAt: null }, at: null }));
    expect(tree.some((node) => node.type === "span" && text(node) === "挂到")).toBe(true);
    expect(tree.find((node) => node.type === WorldAnchors)!.props).toEqual({ anchors: [MISSION] });
    expect(tree.some((node) => node.type === "button" && text(node) === "改")).toBe(true);
  });

  it("挂点标签：类型和名称一样时只写一次（公司）", () => {
    const anchors = nodes(WorldAnchors({ anchors: [{ kind: "company", id: "company", title: "公司" }, MISSION] }));
    const items = anchors.filter((node) => node.type === "li");
    expect(nodes(items[0]).filter((node) => node.type === "span").map(text)).toEqual(["公司"]);
    expect(nodes(items[1]).filter((node) => node.type === "span").map(text)).toEqual(["Mission", "接口全量切到 v2"]);
  });

  it("改挂点：挑一个（点别的就是换），能搜；改过的可以恢复自动", async () => {
    const unit = { kind: "unit" as const, id: "agents", title: "智能体" };
    const po = { kind: "po" as const, id: "<po>", title: "十月目标" };
    api.get.mockResolvedValue({ data: { options: [option(po, "十月跑通预约", "committed"), option(MISSION, null, "draft"), option(unit, "智能体")] }, response: { ok: true, status: 200 } });
    const view = world({ edited: true });
    (render(view).find((node) => node.type === "button" && text(node) === "改")!.props!.onClick as () => void)();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/meetings/{id}/world-anchor-options", { params: { path: { id: "m1" } } }));
    await vi.waitFor(() => expect(render(view).some((node) => node.props?.["aria-label"] === "搜对象")).toBe(true));
    // 没有自己的 Mission：只有「别人的 Mission」「PO」两行，单元不列。
    const picker = render(view);
    expect(picker.filter((node) => node.props?.["data-level"] !== undefined).map((node) => node.props!["data-level"])).toEqual(["others", "po"]);
    expect(picker.some((node) => text(node) === "智能体")).toBe(false);

    (picker.find((node) => node.props?.["aria-label"] === "搜对象")!.props!.onChange as (event: unknown) => void)({ target: { value: "十月" } });
    const searched = render(view);
    expect(searched.filter((node) => node.props?.["aria-pressed"] !== undefined)).toHaveLength(1);
    (searched.find((node) => node.props?.["aria-pressed"] === false)!.props!.onClick as () => void)();
    expect(render(view).some((node) => node.type === "button" && text(node) === "恢复自动")).toBe(true);

    api.put.mockResolvedValue({ data: { world: world({ anchors: [{ ...po }], edited: true }), decisions: [] }, response: { ok: true, status: 200 } });
    (render(view).find((node) => node.type === "button" && text(node) === "保存")!.props!.onClick as () => void)();
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/meetings/{id}/world-anchors",
      { params: { path: { id: "m1" } }, body: { anchors: [{ kind: "po", id: "<po>" }] } }));
  });
});

describe("进度线：自动取妙记失败后的入口", () => {
  const recovery = (props: Partial<Parameters<typeof MinutesRecovery>[0]> = {}) => {
    hooks.index = 0;
    return nodes(MinutesRecovery({ meetingId: "m1", status: "failed", failure: "fetch_failed", canFetch: true, ...props }));
  };
  const buttons = (tree: Node[]) => tree.filter((node) => node.type === "button").map(text);

  it("读取失败：先是贴妙记链接读取，其次再读一次，最后上传会议记录；再读成功后重取会议卡", async () => {
    const onUpload = vi.fn();
    const onFetched = vi.fn();
    const tree = recovery({ onUpload, onFetched });
    expect(tree.some((node) => node.props?.["aria-label"] === "妙记链接")).toBe(true);
    expect(buttons(tree)).toEqual(["读取", "再读一次", "上传会议记录"]);
    (tree.find((node) => node.type === "button" && text(node) === "上传会议记录")!.props!.onClick as () => void)();
    expect(onUpload).toHaveBeenCalled();
    api.post.mockResolvedValue({ data: { minutesStatus: "waiting", minutesFailure: null }, response: { ok: true, status: 200 } });
    (tree.find((node) => node.type === "button" && text(node) === "再读一次")!.props!.onClick as () => void)();
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/meetings/{id}/minutes/refetch", { params: { path: { id: "m1" } } }));
    await vi.waitFor(() => expect(onFetched).toHaveBeenCalled());
  });

  it("参会人什么都没有；只能上传的人只有上传", () => {
    expect(buttons(recovery({ canFetch: false }))).toEqual([]);
    expect(recovery({ canFetch: false }).some((node) => node.props?.["aria-label"] === "妙记链接")).toBe(false);
    hooks.values = [];
    expect(buttons(recovery({ canFetch: false, onUpload: vi.fn() }))).toEqual(["上传会议记录"]);
  });

  it("其实已经读完了（会议卡旧了）：重取会议卡，不报错", async () => {
    const onFetched = vi.fn();
    api.post.mockResolvedValue({ data: undefined, error: { code: "MINUTES_READY" }, response: { ok: false, status: 409 } });
    (recovery({ onFetched }).find((node) => node.type === "button" && text(node) === "再读一次")!.props!.onClick as () => void)();
    await vi.waitFor(() => expect(onFetched).toHaveBeenCalled());
    expect(recovery({ onFetched }).some((node) => node.props?.role === "alert")).toBe(false);
  });

  it("贴妙记链接：输入框直接在，没填时读取不能点，读取后重取会议卡", async () => {
    const onFetched = vi.fn();
    const opened = recovery({ status: "manual", failure: null, onFetched });
    expect(opened.find((node) => node.type === "button" && text(node) === "读取")!.props!.disabled).toBe(true);
    (opened.find((node) => node.props?.["aria-label"] === "妙记链接")!.props!.onChange as (event: unknown) => void)({ target: { value: "https://x.feishu.cn/minutes/obcn1" } });
    api.post.mockResolvedValue({ data: { minutesStatus: "ready", minutesFailure: null }, response: { ok: true, status: 200 } });
    (recovery({ status: "manual", failure: null, onFetched }).find((node) => node.type === "form")!.props!.onSubmit as (event: unknown) => void)({ preventDefault() {} });
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/meetings/{id}/minutes",
      { params: { path: { id: "m1" } }, body: { url: "https://x.feishu.cn/minutes/obcn1" } }));
    await vi.waitFor(() => expect(onFetched).toHaveBeenCalled());
  });

  it("主持人、建会的人自己没连好飞书：没授权退回手动、读的时候没权限时是「连接飞书」，授权完回到这一页；连好了、别的失败、参会人都不出", () => {
    vi.stubGlobal("window", { location: { pathname: "/meetings/m1", search: "" } });
    // 本人飞书连接状态是这个组件里最后一个 state（读到之前是 null）。
    const withConnection = (props: Partial<Parameters<typeof MinutesRecovery>[0]>, connection: { enabled: boolean; connected: boolean }) => {
      hooks.values = [];
      recovery(props);
      hooks.values[hooks.values.lastIndexOf(null)] = connection;
      return recovery(props);
    };
    try {
      for (const props of [{ status: "manual" as const, failure: null }, { failure: "no_permission" as const }]) {
        const tree = withConnection(props, { enabled: true, connected: false });
        expect(tree.find((node) => node.type === "a" && text(node) === "连接飞书")!.props!.href).toBe("/api/auth/feishu/start?connect=1&next=%2Fmeetings%2Fm1");
        expect(tree.some((node) => node.type === "button" && text(node) === "再读一次")).toBe(false);
      }
      expect(withConnection({ status: "manual", failure: null }, { enabled: true, connected: true }).some((node) => text(node) === "连接飞书")).toBe(false);
      expect(withConnection({ status: "manual", failure: null }, { enabled: false, connected: false }).some((node) => text(node) === "连接飞书")).toBe(false);
      expect(withConnection({}, { enabled: true, connected: false }).some((node) => text(node) === "连接飞书")).toBe(false);
      expect(withConnection({ status: "manual", failure: null, canFetch: false }, { enabled: true, connected: false }).some((node) => text(node) === "连接飞书")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
