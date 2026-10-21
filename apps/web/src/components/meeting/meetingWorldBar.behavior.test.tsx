import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { CARD_EXPECTED_MS, MINUTES_EXPECTED_MS, MeetingTranscriptStatus, PhaseLive, PhaseTimer, phaseElapsedLabel } from "./MeetingHeader";
import { WorldAnchorPicker } from "./WorldAnchorPicker";
import { WorldAnchors } from "./WorldAnchors";

type Node = { type?: unknown; props?: Record<string, unknown> };
/** 展开自己的子组件（挑挂点、逐字稿状态），库组件不展开。 */
const PARTS = new Set<unknown>([WorldAnchorPicker, MeetingTranscriptStatus, PhaseLive]);
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
const render = (view: TMeetingWorldView, ended = true, onChange = vi.fn()) => {
  hooks.index = 0;
  return nodes(expand(MeetingWorldBar({ meetingId: "m1", world: view, ended, onChange })));
};
const option = (anchor: { kind: TWorldAnchorOption["kind"]; id: string; title: string }, brief: string | null = null, lifecycle: string | null = null): TWorldAnchorOption =>
  ({ ...anchor, brief, lifecycle });

beforeEach(() => { hooks.values = []; api.put.mockReset(); api.get.mockReset(); api.post.mockReset(); });

describe("会议页页头：这场会挂到哪、会议记录写进本体没有", () => {
  it("主持人：挂点带已写入的绿点，能改；选了不写入时挂点划掉，不能改", () => {
    const tree = render(world());
    const anchors = tree.find((node) => node.type === WorldAnchors)!;
    expect(anchors.props).toMatchObject({ anchors: [MISSION], tone: "ok" });
    expect(tree.some((node) => node.type === "button" && text(node) === "改")).toBe(true);
    expect(tree.some((node) => node.type === "span" && text(node) === "记录 · 已写入")).toBe(true);

    hooks.values = [];
    const after = render(world({ excluded: true, excludedBy: "林晓", record: { ...RECORD, status: "excluded" } }));
    expect(after.find((node) => node.type === WorldAnchors)!.props).toMatchObject({ tone: "off" });
    expect(after.some((node) => node.type === "span" && text(node) === "记录 · 不写入")).toBe(true);
    expect(after.some((node) => node.type === "button" && text(node) === "改")).toBe(false);
  });

  it("参会人：只看挂点，没有状态", () => {
    const tree = render(world({ record: null, at: null, canEdit: false }));
    expect(tree.find((node) => node.type === WorldAnchors)!.props).toMatchObject({ anchors: [MISSION], tone: undefined });
    expect(tree.some((node) => node.type === "span" && node.props?.["data-tone"] !== undefined)).toBe(false);
    expect(tree.some((node) => node.type === "button" && text(node) === "改")).toBe(false);
  });

  it("会前也能看到挂点条", () => {
    const tree = render(world({ record: { ...RECORD, status: "pending", eventId: null, confirmedAt: null }, at: null }), false);
    expect(tree.some((node) => node.type === "span" && text(node) === "挂到")).toBe(true);
    expect(tree.find((node) => node.type === WorldAnchors)!.props).toMatchObject({ anchors: [MISSION], tone: undefined });
    expect(tree.some((node) => text(node).startsWith("记录 ·"))).toBe(false);
    expect(tree.some((node) => node.type === "button" && text(node) === "改")).toBe(true);
  });

  it("显示会议记录状态", () => {
    const labels: [NonNullable<TMeetingWorldView["record"]>["status"], string][] = [
      ["pending", "记录 · 待确认"], ["writing", "记录 · 写入中"], ["committed", "记录 · 已写入"], ["excluded", "记录 · 不写入"], ["edit_pending", "记录 · 修改待确认"], ["failed", "记录 · 写入失败"],
    ];
    for (const [status, label] of labels) {
      hooks.values = [];
      const tree = render(world({ record: { ...RECORD, status }, excluded: status === "excluded" }));
      expect(tree.filter((node) => node.type === "span" && node.props?.["data-tone"] !== undefined).map(text)).toEqual([label]);
    }
  });

  it("挂点标签：类型和名称一样时只写一次（公司）", () => {
    const anchors = nodes(WorldAnchors({ anchors: [{ kind: "company", id: "company", title: "公司" }, MISSION] }));
    const items = anchors.filter((node) => node.type === "li");
    expect(nodes(items[0]).filter((node) => node.type === "span").map(text)).toEqual(["公司"]);
    expect(nodes(items[1]).filter((node) => node.type === "span").map(text)).toEqual(["Mission", "接口全量切到 v2"]);
  });

  it("改挂点：按类型分组可搜，选了保存；改过的可以恢复自动", async () => {
    const unit = { kind: "unit" as const, id: "agents", title: "智能体" };
    const po = { kind: "po" as const, id: "<po>", title: "十月目标" };
    api.get.mockResolvedValue({ data: { options: [option(po, "十月跑通预约", "committed"), option(MISSION, null, "draft"), option(unit, "智能体")] }, response: { ok: true, status: 200 } });
    const view = world({ edited: true });
    (render(view).find((node) => node.type === "button" && text(node) === "改")!.props!.onClick as () => void)();
    await vi.waitFor(() => expect(api.get).toHaveBeenCalledWith("/api/meetings/{id}/world-anchor-options", { params: { path: { id: "m1" } } }));
    await vi.waitFor(() => expect(render(view).some((node) => node.props?.["aria-pressed"] !== undefined)).toBe(true));
    const picker = render(view);
    expect(picker.filter((node) => node.type === "h4").map(text)).toEqual(["PO", "Mission", "单元"]);
    expect(picker.filter((node) => node.props?.["aria-pressed"] !== undefined).map((node) => node.props!["aria-pressed"])).toEqual([false, true, false]);
    const missionRow = picker.find((node) => node.props?.["aria-pressed"] === true)!;
    expect(nodes(missionRow).some((node) => text(node) === "草稿")).toBe(true);
    const poRow = picker.find((node) => node.props?.["aria-pressed"] === false)!;
    expect(nodes(poRow).some((node) => text(node) === "十月跑通预约")).toBe(true);

    (picker.find((node) => node.props?.["aria-label"] === "搜对象")!.props!.onChange as (event: unknown) => void)({ target: { value: "智能" } });
    const searched = render(view);
    expect(searched.filter((node) => node.props?.["aria-pressed"] !== undefined)).toHaveLength(1);
    (searched.find((node) => node.props?.["aria-pressed"] === false)!.props!.onClick as () => void)();
    expect(render(view).some((node) => node.type === "button" && text(node) === "恢复自动")).toBe(true);

    api.put.mockResolvedValue({ data: { world: world({ anchors: [MISSION, unit], edited: true }), decisions: [] }, response: { ok: true, status: 200 } });
    (render(view).find((node) => node.type === "button" && text(node) === "保存")!.props!.onClick as () => void)();
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledWith("/api/meetings/{id}/world-anchors",
      { params: { path: { id: "m1" } }, body: { anchors: [{ kind: "mission", id: "m-v2" }, { kind: "unit", id: "agents" }] } }));
  });
});

describe("会议页页头：逐字稿", () => {
  const transcript = (props: Partial<Parameters<typeof MeetingTranscriptStatus>[0]> = {}) => {
    hooks.index = 0;
    return nodes(expand(MeetingTranscriptStatus({ meetingId: "m1", status: "failed", failure: "fetch_failed", confirmed: false, canFetch: true, ...props })));
  };

  it("读取失败可以再读", async () => {
    const tree = transcript();
    expect(tree.some((node) => node.type === "span" && text(node) === "逐字稿 · 读取失败")).toBe(true);
    api.post.mockResolvedValue({ data: { minutesStatus: "waiting", minutesFailure: null }, response: { ok: true, status: 200 } });
    (tree.find((node) => node.type === "button" && text(node) === "再读一次")!.props!.onClick as () => void)();
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/meetings/{id}/minutes/refetch", { params: { path: { id: "m1" } } }));
    await vi.waitFor(() => expect(transcript().some((node) => node.type === "span" && text(node) === "等妙记")).toBe(true));
  });

  it("原因写成短标签；只在逐字稿确认存下后才是已读完", () => {
    hooks.values = [];
    expect(transcript({ failure: "no_permission" }).some((node) => text(node) === "逐字稿 · 读取失败 · 无权限")).toBe(true);
    hooks.values = [];
    expect(transcript({ failure: "not_ready" }).some((node) => text(node) === "逐字稿 · 未就绪")).toBe(true);
    hooks.values = [];
    expect(transcript({ status: "ready", failure: null, candidate: true }).some((node) => text(node) === "待确认说话人")).toBe(true);
    hooks.values = [];
    expect(transcript({ status: "ready", failure: null, candidate: true }).some((node) => text(node).includes("读取中"))).toBe(false);
    hooks.values = [];
    const done = transcript({ status: "ready", failure: null, confirmed: true });
    expect(done.some((node) => text(node) === "逐字稿 · 已读完")).toBe(true);
    expect(done.some((node) => node.type === "button")).toBe(false);
    hooks.values = [];
    expect(transcript({ canFetch: false }).some((node) => node.type === "button")).toBe(false);
  });

  it("其实已经读完了（会议卡旧了）：重取会议卡，不报错", async () => {
    const onFetched = vi.fn();
    api.post.mockResolvedValue({ data: undefined, error: { code: "MINUTES_READY" }, response: { ok: false, status: 409 } });
    (transcript({ onFetched }).find((node) => node.type === "button" && text(node) === "再读一次")!.props!.onClick as () => void)();
    await vi.waitFor(() => expect(onFetched).toHaveBeenCalled());
    expect(transcript({ onFetched }).some((node) => node.props?.role === "alert")).toBe(false);
  });

  it("没有妙记：主持人、创建人贴链接读", async () => {
    const tree = transcript({ status: "manual", failure: null });
    const input = tree.find((node) => node.props?.["aria-label"] === "妙记链接")!;
    (input.props!.onChange as (event: unknown) => void)({ target: { value: "https://x.feishu.cn/minutes/obcn1" } });
    api.post.mockResolvedValue({ data: { minutesStatus: "ready", minutesFailure: null }, response: { ok: true, status: 200 } });
    (transcript({ status: "manual", failure: null }).find((node) => node.type === "button" && text(node) === "读取")!.props!.onClick as () => void)();
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/meetings/{id}/minutes",
      { params: { path: { id: "m1" } }, body: { url: "https://x.feishu.cn/minutes/obcn1" } }));
    hooks.values = [];
    expect(transcript({ status: "manual", failure: null, canFetch: false }).some((node) => node.props?.["aria-label"] === "妙记链接")).toBe(false);
  });

  it("主持人、建会的人自己没连好飞书：「未找到」「无权限」旁边是「连接飞书」，授权完回到这一页；连好了、别的失败、参会人都不出", () => {
    vi.stubGlobal("window", { location: { pathname: "/meetings/m1", search: "" } });
    // 本人飞书连接状态是这个组件里最后一个 state（读到之前是 null）。
    const withConnection = (props: Partial<Parameters<typeof MeetingTranscriptStatus>[0]>, connection: { enabled: boolean; connected: boolean }) => {
      hooks.values = [];
      transcript(props);
      hooks.values[hooks.values.lastIndexOf(null)] = connection;
      return transcript(props);
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

describe("会议页页头：阶段与用时", () => {
  const transcript = (props: Partial<Parameters<typeof MeetingTranscriptStatus>[0]> = {}) => {
    hooks.index = 0;
    return nodes(expand(MeetingTranscriptStatus({ meetingId: "m1", status: "waiting", failure: null, confirmed: false, canFetch: true, ...props })));
  };
  const timer = (tree: Node[]) => tree.find((node) => node.type === PhaseTimer)?.props;

  it("已用时 / 约多少；超过预计只写已用时，不出负数", () => {
    const since = "2026-10-21T10:00:00.000Z";
    const at = (seconds: number) => Date.parse(since) + seconds * 1000;
    expect(phaseElapsedLabel(since, at(-30), CARD_EXPECTED_MS)).toBe("0 秒 / 约 1 分钟");
    expect(phaseElapsedLabel(since, at(42), CARD_EXPECTED_MS)).toBe("42 秒 / 约 1 分钟");
    expect(phaseElapsedLabel(since, at(75), CARD_EXPECTED_MS)).toBe("1 分钟");
    expect(phaseElapsedLabel(since, at(3 * 60 + 5), MINUTES_EXPECTED_MS)).toBe("3 分钟 / 约 15 分钟");
    expect(phaseElapsedLabel(since, at(16 * 60), MINUTES_EXPECTED_MS)).toBe("16 分钟");
    expect(phaseElapsedLabel(since, at(95 * 60), MINUTES_EXPECTED_MS)).toBe("1 小时 35 分钟");
    expect(MINUTES_EXPECTED_MS).toBe(15 * 60_000);
    expect(CARD_EXPECTED_MS).toBe(60_000);
  });

  it("等妙记：从开始等的时刻走字；旁边一个「自己上传」，点开才有上传和贴链接", () => {
    hooks.values = [];
    const onUpload = vi.fn();
    const tree = transcript({ waitingSince: "2026-10-21T10:00:00.000Z", onUpload });
    expect(tree.some((node) => text(node) === "等妙记")).toBe(true);
    expect(timer(tree)).toMatchObject({ since: "2026-10-21T10:00:00.000Z", expectedMs: MINUTES_EXPECTED_MS });
    expect(tree.some((node) => node.props?.["aria-label"] === "妙记链接")).toBe(false);
    const open = tree.find((node) => node.type === "button" && text(node) === "自己上传")!;
    expect(open.props?.["aria-expanded"]).toBe(false);
    (open.props!.onClick as () => void)();
    const opened = transcript({ waitingSince: "2026-10-21T10:00:00.000Z", onUpload });
    expect(opened.some((node) => node.props?.["aria-label"] === "妙记链接")).toBe(true);
    (opened.find((node) => node.type === "button" && text(node) === "上传文件")!.props!.onClick as () => void)();
    expect(onUpload).toHaveBeenCalled();
  });

  it("生成会议卡：已用时 / 约 1 分钟，没有按钮", () => {
    hooks.values = [];
    const tree = transcript({ status: "ready", confirmed: true, generatingSince: "2026-10-21T10:00:00.000Z" });
    expect(tree.some((node) => text(node) === "生成会议卡")).toBe(true);
    expect(timer(tree)).toMatchObject({ since: "2026-10-21T10:00:00.000Z", expectedMs: CARD_EXPECTED_MS });
    expect(tree.some((node) => node.type === "button")).toBe(false);
  });

  it("用户自己上传了：跟着上传这条路走，不再显示等妙记", () => {
    hooks.values = [];
    const tree = transcript({ status: "ready", candidate: true, waitingSince: "2026-10-21T10:00:00.000Z", onUpload: vi.fn() });
    expect(tree.some((node) => text(node) === "待确认说话人")).toBe(true);
    expect(tree.some((node) => text(node) === "等妙记")).toBe(false);
    expect(tree.some((node) => node.type === "button" && text(node) === "自己上传")).toBe(false);
  });
});
