import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TWorldAnchor, TWorldAnchorOption } from "@warmap/contracts";

/* 把弹层当函数调用：hooks 用按调用顺序存值的小仓库代替；useEffect 在依赖变了时同步跑一次（同 meetingBooking.behavior.test）。 */
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, deps: [] as (unknown[] | undefined)[], effectIndex: 0,
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[index]) : next;
    }];
  },
  useRef(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
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
  useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect, useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: api.get, POST: api.post } }));
vi.mock("@/lib/home/partnerMeetingFeed", () => ({ usePartnerMeetings: () => ({ items: [], error: "", loaded: true, reload: vi.fn() }) }));

import { HeroButton } from "@/components/HeroButton";
import { SegmentedSwitch } from "@/components/SegmentedSwitch";
import { Select } from "@/components/ui/Select";
import { instantMeetingPayload } from "@/components/meeting/instantMeeting";
import { WorldAnchorPicker } from "@/components/meeting/WorldAnchorPicker";
import { StartForm, type HomeMeeting } from "./MeetingControl";

type Node = { type?: unknown; props?: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return node.props ? [node, ...nodes(node.props.children)] : [];
}
const text = (node: Node): string => {
  const children = node.props?.children;
  return [children].flat(Infinity).map((child) => (typeof child === "string" ? child : child && typeof child === "object" ? text(child as Node) : "")).join("");
};

const MISSION: TWorldAnchorOption = { kind: "mission", id: "m-mine", title: "天枢 11 月：V1 11/18 上线，V2 月底", brief: null, lifecycle: "confirmed", ownerId: "p-member", parentId: null };
const PEOPLE = [{ personId: "p-member", displayName: "林晓" }, { personId: "p-third", displayName: "周舟" }];

let calendar = false;
const meeting = {
  account: { personId: "p-member", role: "member", displayName: "林晓" },
  phase: { kind: "idle" },
  start: vi.fn(async () => null),
  navigate: vi.fn(),
} as unknown as HomeMeeting & { start: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> };
const onStarted = vi.fn();
const onBook = vi.fn();
const render = () => {
  hooks.index = 0; hooks.effectIndex = 0;
  return nodes(StartForm({ meeting, onStarted, onBook }));
};
const primary = (tree: Node[]) => tree.find((node) => node.type === HeroButton && node.props?.variant === "primary")!;
const press = (node: Node) => (node.props!.onPress as () => void)();
const modes = (tree: Node[]) => tree.find((node) => node.type === SegmentedSwitch)!;
const toRemote = () => (modes(render()).props!.onSelect as (id: string) => void)("remote");
const field = (tree: Node[], label: string) => tree.find((node) => node.props?.role === "group" && node.props?.["aria-label"] === label);
const labelled = (tree: Node[], label: string) => tree.find((node) => node.props?.["aria-label"] === label);
const click = (node: Node | undefined) => (node!.props!.onClick as () => void)();

beforeEach(() => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { pathname: "/me/work" } }));
  vi.stubGlobal("document", { activeElement: null });
  hooks.values = []; hooks.deps = [];
  calendar = false;
  api.get.mockReset(); api.post.mockReset(); meeting.start.mockClear(); meeting.navigate.mockReset(); onStarted.mockReset(); onBook.mockReset();
  api.get.mockImplementation(async (path: string) => path === "/api/me/feishu"
    ? { data: { enabled: true, calendar }, response: { ok: true, status: 200 } }
    : path === "/api/people/directory"
      ? { data: { people: PEOPLE }, response: { ok: true, status: 200 } }
      : { data: { options: [MISSION] }, response: { ok: true, status: 200 } });
});

describe("instantMeetingPayload", () => {
  it("开始就是现在、开一小时；挂点只带 kind 和 id；没有参会人不带这一项", () => {
    const at = Date.parse("2026-11-16T03:46:00.000Z");
    const anchors: TWorldAnchor[] = [{ kind: "mission", id: "m-mine", title: "天枢 11 月" }];
    expect(instantMeetingPayload({ title: "周会", at, participants: [], anchors, draftId: "d-1" })).toEqual({
      draftId: "d-1", title: "周会", scheduledAt: "2026-11-16T03:46:00.000Z", endsAt: "2026-11-16T04:46:00.000Z", anchors: [{ kind: "mission", id: "m-mine" }],
    });
    expect(instantMeetingPayload({ title: "周会", at, participants: ["p-third"], anchors, draftId: "d-1", leadDriId: "p-ceo" }))
      .toMatchObject({ participants: ["p-third"], leadDriId: "p-ceo" });
  });
});

describe("开会弹层：新的一场", () => {
  it("现场 | 远程二选一，默认现场：主按钮「开始录音」，左下「预约会议」去约以后的会", async () => {
    await vi.waitFor(() => expect(primary(render()).props!.isDisabled).toBe(false));
    const tree = render();
    const segments = modes(tree).props!.segments as { id: string; label: string }[];
    expect(segments.map((segment) => segment.label)).toEqual(["现场", "远程"]);
    expect(modes(tree).props!.selected).toBe("local");
    expect(text(primary(tree))).toBe("开始录音");
    expect(field(tree, "参会")).toBeUndefined();
    const book = tree.find((node) => node.type === HeroButton && text(node) === "预约会议")!;
    press(book);
    expect(onBook).toHaveBeenCalled();
    press(primary(render()));
    await vi.waitFor(() => expect(meeting.start).toHaveBeenCalledWith({ book: expect.objectContaining({ anchors: [] }) }));
    expect((meeting.start.mock.calls[0][0] as { book: Record<string, unknown> }).book.participants).toBeUndefined();
  });

  it("远程：多一行「参会」，主按钮「发起会议」；飞书日历没连写「飞书日历未连接」和「去连接」，不能发起", async () => {
    toRemote();
    await vi.waitFor(() => expect(text(field(render(), "参会")!)).toContain("飞书日历未连接"));
    const tree = render();
    expect(text(primary(tree))).toBe("发起会议");
    expect(primary(tree).props!.isDisabled).toBe(true);
    const connect = nodes(field(tree, "参会")).find((node) => node.type === "a")!;
    expect(text(connect)).toBe("去连接");
    expect(connect.props!.href).toContain("/api/auth/feishu/start");
  });

  it("远程就地选人：连好飞书回来能选同事、发起；没约成再按沿用同一预约，约成去会议页、关弹层", async () => {
    toRemote();
    await vi.waitFor(() => expect(field(render(), "参会")).toBeDefined());
    calendar = true;
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(nodes(field(render(), "参会")).some((node) => node.type === Select)).toBe(true));
    const picker = nodes(field(render(), "参会")).find((node) => node.type === Select)!;
    expect((picker.props!.options as { value: string }[]).map((option) => option.value)).toEqual(["p-third"]);
    expect(primary(render()).props!.isDisabled).toBe(true);
    (picker.props!.onChange as (value: string) => void)("p-third");
    expect(text(field(render(), "参会")!)).toContain("周舟");
    expect(primary(render()).props!.isDisabled).toBe(false);

    api.post.mockRejectedValueOnce(new Error("网络中断")).mockResolvedValueOnce({
      data: { card: { objectRef: { id: "m-now" }, navigation: [{ href: "/me/work/meetings/m-now" }] } }, response: { ok: true, status: 200 },
    });
    const changed = vi.fn();
    window.addEventListener("meeting-changed", changed);
    const started = Date.now();
    press(primary(render()));
    await vi.waitFor(() => expect(render().some((node) => node.props?.role === "alert" && text(node).includes("没有约成"))).toBe(true));
    press(primary(render()));
    await vi.waitFor(() => expect(meeting.navigate).toHaveBeenCalledWith("/me/work/meetings/m-now"));
    expect(onStarted).toHaveBeenCalled();
    expect(meeting.start).not.toHaveBeenCalled();
    // 约成后照现场那条路通知会议卡、通知栏和对话里的草稿卡重取（它们只听 meeting-changed）。
    expect(changed).toHaveBeenCalledTimes(1);
    const [first, retry] = api.post.mock.calls.map((call) => call[1].body);
    expect(first).toMatchObject({ draftId: expect.any(String), participants: ["p-third"], anchors: [] });
    expect(retry.draftId).toBe(first.draftId);
    expect(Date.parse(first.scheduledAt)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(first.endsAt) - Date.parse(first.scheduledAt)).toBe(3_600_000);
  });
});

describe("开会弹层：名称和关于（本人 11/16）", () => {
  it("名称直接写成字，右边一个改的按钮，点了才出输入框；回车收起，清空了回到默认名称", () => {
    const tree = render();
    expect(labelled(tree, "标题")).toBeUndefined();
    const name = text(tree.find((node) => node.props?.["data-testid"] === "meeting-name")!);
    expect(name).toMatch(/的会$/);
    click(labelled(tree, "改名称"));
    const input = labelled(render(), "标题")!;
    expect(input.type).toBe("input");
    expect(input.props!.autoFocus).toBe(true);
    (input.props!.onChange as (event: unknown) => void)({ currentTarget: { value: "" } });
    (labelled(render(), "标题")!.props!.onKeyDown as (event: unknown) => void)({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault() {} });
    expect(labelled(render(), "标题")).toBeUndefined();
    expect(text(render().find((node) => node.props?.["data-testid"] === "meeting-name")!)).toBe(name);
  });

  it("关于默认不挂，能直接开；点小图标挑一个挂上，× 去掉又回到不挂", async () => {
    await vi.waitFor(() => expect(primary(render()).props!.isDisabled).toBe(false));
    expect(text(field(render(), "关于")!)).toContain("不挂");
    expect(render().some((node) => node.type === WorldAnchorPicker)).toBe(false);
    click(labelled(render(), "改关于"));
    await vi.waitFor(() => expect(render().some((node) => node.type === WorldAnchorPicker)).toBe(true));
    const picker = render().find((node) => node.type === WorldAnchorPicker)!;
    (picker.props!.onChange as (next: unknown) => void)([{ kind: "mission", id: "m-mine", title: MISSION.title }]);
    expect(text(field(render(), "关于")!)).toContain(MISSION.title);
    expect(render().some((node) => node.type === WorldAnchorPicker)).toBe(false);
    click(labelled(render(), "不挂"));
    expect(text(field(render(), "关于")!)).toContain("不挂");
  });
});
