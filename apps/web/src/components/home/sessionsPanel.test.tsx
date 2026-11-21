import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { TArchivedSubSession } from "@warmap/contracts";

/**
 * 右边「会话」面板（设计 4.3）。没有 jsdom：
 * - 带 data-testid 的原生元素的 props 从 JSX 运行时截下来，直接调它们的处理器（同 leftColumn.test）；
 * - 面板自己第一个 useState（「已归档 N」开没开）换成测试里记着的值，点了以后再画一遍就是开着的；
 * - 行尾「…」菜单换成桩，记下每行的菜单项，直接跑「恢复」；
 * - 弹出菜单（Dropdown）换成直接画出来的桩，记下菜单的 onAction，直接选一项。
 */
const tap = vi.hoisted(() => ({ props: new Map<string, Record<string, unknown>>(), menus: new Map<string, { id: string; run: () => unknown }[]>(),
  actions: new Map<string, (key: string) => void>(), first: 0, open: false }));
const capture = vi.hoisted(() => <T,>(fn: T) => ((type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
  if (typeof type === "string" && typeof props?.["data-testid"] === "string") tap.props.set(props["data-testid"] as string, props);
  return (fn as unknown as (...args: unknown[]) => unknown)(type, props, ...rest);
}) as unknown as T);
vi.mock("react/jsx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-runtime")>();
  return { ...actual, jsx: capture(actual.jsx), jsxs: capture(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-dev-runtime")>();
  return { ...actual, jsxDEV: capture(actual.jsxDEV) };
});
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (tap.first++ === 0) return [tap.open, (next: unknown) => { tap.open = typeof next === "function" ? (next as (value: boolean) => boolean)(tap.open) : next as boolean; }];
      return actual.useState(initial);
    },
  };
});
vi.mock("./RowMenu", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./RowMenu")>();
  return { ...actual, RowMenu: ({ label, items }: { label: string; items: { id: string; run: () => unknown }[] }) => { tap.menus.set(label, items); return null; } };
});
vi.mock("@heroui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@heroui/react")>();
  const { createElement, Fragment } = await import("react");
  type Props = { children?: unknown; [key: string]: unknown };
  const Dropdown = Object.assign(({ children }: Props) => createElement(Fragment, null, children as never), {
    Trigger: ({ children, ...rest }: Props) => createElement("button", { type: "button", ...rest }, children as never),
    Popover: ({ children }: Props) => createElement(Fragment, null, children as never),
    Menu: ({ children, onAction, "aria-label": label }: Props) => { tap.actions.set(label as string, onAction as (key: string) => void); return createElement("ul", { "aria-label": label }, children as never); },
    Item: ({ children, id }: Props) => createElement("li", { "data-key": id }, children as never),
  });
  return { ...actual, Dropdown };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import type { Project } from "@/lib/home/projects";
import type { BackgroundItem, SubSession } from "@/lib/home/types";
import type { Resources } from "@/lib/work/useWork";
import { LocalContext, type LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import { ProjectInfo } from "./ProjectInfo";
import { SessionsButton, SessionsPanel } from "./SessionsPanel";
import type { RowActions } from "./SubRows";
import type { View } from "./view";

const sub = (id: string, title: string, extra: Partial<SubSession> = {}) => ({
  id, kind: "topic", letter: null, title, state: "queued", unseen: false, waiting: null, queueReason: null, holdUntil: null, role: null,
  sessionId: null, deviceId: null, autoStart: false, updatedAt: "2026-11-17T01:00:00.000Z", merge: null, ...extra,
}) as unknown as SubSession;
const project = (id: string, name: string, subSessions: SubSession[], extra: Partial<Project> = {}) => ({
  id, name, folder: null, archived: false, goals: [], current: [], subSessions, items: [], scope: `project:${id}`, waiting: 0, lastActivity: null, budget: null, unseen: false, transfer: null, ...extra,
}) as Project;
const archivedSub = (id: string, title: string, projectId: string | null, projectName: string | null) =>
  ({ kind: "topic", id, title, letter: null, projectId, projectName, archivedAt: "2026-11-16T02:00:00.000Z" }) as unknown as TArchivedSubSession;

const P1 = project("p1", "首页改版", [sub("t2", "改登录页", { updatedAt: "2026-11-17T03:00:00.000Z" }), sub("t1", "调研", { updatedAt: "2026-11-17T02:00:00.000Z" })]);
const P2 = project("p2", "胸牌固件", [sub("t3", "待机屏", { state: "running" })]);
const P3 = project("p3", "空项目", []);
const OTHER = [sub("t9", "以前的会话")];
const ARCHIVED = [archivedSub("a1", "旧选型", "p1", "首页改版"), archivedSub("a2", "旧固件", "p2", "胸牌固件")];

const resources: Resources = { local: { online: true, name: null, used: 1, cap: 3 }, models: [], todayUsd: null, quota: [] };
const item = { id: "plan:1", title: "拆卡", kind: "plan", state: "running", startedAt: new Date().toISOString(), finishedAt: null, stoppable: true,
  sessionId: null, itemId: null, deviceId: null, taskId: "t1", cardId: null, topicId: null, holdUntil: null } as BackgroundItem;
const localState = (extra: Partial<LocalRunnerState> = {}) => ({
  runner: createMockRunner(), phase: "ready", version: null, status: { settings: { paused: false }, quota: [], tools: [] }, models: [], folders: [], sessions: [],
  pairing: null, error: null, refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn(), ...extra,
}) as unknown as LocalRunnerState;
const actions = (): RowActions => ({ renameProject: vi.fn(), archiveProject: vi.fn(), deleteProject: vi.fn(), renameSub: vi.fn(), archiveSub: vi.fn(), deleteSub: vi.fn() });

type Props = Parameters<typeof SessionsPanel>[0];
const render = (extra: Partial<Props> = {}, local: LocalRunnerState = localState()) => {
  tap.first = 0;
  const props: Props = { view: { kind: "buddy" }, projects: [P1, P2, P3], other: OTHER, archivedSubs: ARCHIVED, actions: actions(), go: vi.fn(),
    items: [item], onStop: async () => undefined, resources, ...extra };
  const wrap = (node: ReactNode) => <LocalContext.Provider value={local}>{node}</LocalContext.Provider>;
  return renderToStaticMarkup(wrap(<SessionsPanel {...props} />)).replace(/<!-- -->/g, "");
};
const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

describe("右边「会话」面板（设计 4.3）", () => {
  it("项目里只列这个项目的子会话", () => {
    for (const view of [{ kind: "project", id: "p1" }, { kind: "topic", id: "t1" }] as View[]) {
      const html = render({ view });
      // 只这个项目的，按 planOrder（专题按最近动静，早的在前）；不写组名、不列「其他」。
      expect(text(html)).toMatch(/\|调研\|改登录页\|/);
      expect(html).not.toContain("待机屏");
      expect(html).not.toContain("以前的会话");
      expect(text(html)).not.toContain("|首页改版|");
      expect(text(html)).not.toContain("|其他|");
    }
    // 点行：给了 onOpenSub 就交给它，不给就去那个子会话。
    const onOpenSub = vi.fn();
    render({ view: { kind: "project", id: "p2" }, onOpenSub });
    (tap.props.get("tree-sub")?.onClick as () => void)();
    expect(onOpenSub).toHaveBeenCalledWith(expect.objectContaining({ id: "t3" }));
    const go = vi.fn();
    render({ view: { kind: "project", id: "p2" }, go });
    (tap.props.get("tree-sub")?.onClick as () => void)();
    expect(go).toHaveBeenCalledWith("/me/work/topics/t3");
  });

  it("卡按派活先后排，会话跑起来（updatedAt 变新）行不挪", () => {
    const cardAt = new Map([["c1", "2026-11-17T01:00:00.000Z"], ["c2", "2026-11-17T02:00:00.000Z"]]);
    const cards = (first: string) => project("p8", "排序", [
      sub("c1", "先派的", { kind: "card", updatedAt: first }),
      sub("c2", "后派的", { kind: "card", updatedAt: "2026-11-17T03:00:00.000Z" }),
    ] as SubSession[]);
    for (const updatedAt of ["2026-11-17T01:00:00.000Z", "2026-11-17T05:00:00.000Z"]) {
      expect(text(render({ view: { kind: "project", id: "p8" }, projects: [cards(updatedAt)], cardAt }))).toMatch(/\|先派的\|后派的\|/);
    }
  });

  it("主线里按项目分组列全部，没挂项目的在「其他」", () => {
    const html = render({ view: { kind: "buddy" } });
    expect(text(html)).toMatch(/\|首页改版\|调研\|改登录页\|胸牌固件\|待机屏\|在跑\|其他\|以前的会话\|/);
    // 没有子会话的项目不列；没有不挂项目的就没有「其他」。
    expect(html).not.toContain('<section aria-label="空项目"');
    expect(text(render({ view: { kind: "home" }, other: [] }))).not.toContain("|其他|");
  });

  it("项目里点「新会话」直接去新建页", () => {
    const go = vi.fn();
    const html = render({ view: { kind: "project", id: "p1" }, go });
    expect(html).toMatch(/data-testid="panel-new-sub"[^>]*>.*新会话/);
    (tap.props.get("panel-new-sub")?.onClick as () => void)();
    expect(go).toHaveBeenCalledWith("/me/work/projects/p1/new");
    // 同原来行上「+」的规矩：没有菜单动作、项目归档了、这台电脑的本机程序太旧（protocol < 4）时不出；本机没连上照出。
    expect(render({ view: { kind: "project", id: "p1" }, actions: null })).not.toContain("panel-new-sub");
    expect(render({ view: { kind: "project", id: "p4" }, projects: [project("p4", "旧项目", [], { archived: true })] })).not.toContain("panel-new-sub");
    expect(render({ view: { kind: "project", id: "p1" } }, localState({ runner: { freeSessions: false } as never }))).not.toContain("panel-new-sub");
    expect(render({ view: { kind: "project", id: "p1" } }, localState({ phase: "offline", runner: {} as never }))).toContain("panel-new-sub");
  });

  it("主线里点「新会话」先选项目", () => {
    const go = vi.fn();
    const archived = project("p4", "旧项目", [], { archived: true });
    const html = render({ view: { kind: "buddy" }, projects: [P1, P2, P3, archived], go });
    // 菜单里是能加的项目（没子会话的也算），归档了的不列；选一个去它的新建页。
    expect(html).toMatch(/data-testid="panel-new-sub"[^>]*>.*新会话/);
    expect(text(html)).toMatch(/\|新会话\|首页改版\|胸牌固件\|空项目\|/);
    expect(html).not.toContain('data-key="p4"');
    tap.actions.get("新会话")?.("p2");
    expect(go).toHaveBeenCalledWith("/me/work/projects/p2/new");
  });

  it("随手的会话归进「其他」，不写「随手」；「新会话」菜单不列它；归档了的随手会话不带项目名", () => {
    tap.open = false;
    const scratch = project("s1", "随手", [sub("t8", "比对合同", { updatedAt: "2026-11-17T04:00:00.000Z" })], { scratch: true });
    const html = render({ view: { kind: "buddy" }, projects: [P1, scratch], archivedSubs: [archivedSub("a3", "旧比对", "s1", "随手")] });
    expect(text(html)).toMatch(/\|首页改版\|调研\|改登录页\|其他\|以前的会话\|比对合同\|/);
    expect(html).not.toContain("随手");
    expect(html).not.toContain('data-key="s1"');
    // 没有别的不挂项目的会话：照样一组「其他」。
    expect(text(render({ view: { kind: "buddy" }, projects: [scratch], other: [], archivedSubs: [] }))).toMatch(/\|其他\|比对合同\|/);
    (tap.props.get("panel-archived")?.onClick as () => void)();
    const opened = render({ view: { kind: "buddy" }, projects: [P1, scratch], archivedSubs: [archivedSub("a3", "旧比对", "s1", "随手")] });
    expect(opened).toContain("旧比对");
    expect(opened).not.toContain("随手");
    tap.open = false;
  });

  it("没有能加的项目时不出", () => {
    expect(render({ view: { kind: "buddy" }, projects: [project("p4", "旧项目", [], { archived: true })] })).not.toContain("panel-new-sub");
    expect(render({ view: { kind: "buddy" }, actions: null })).not.toContain("panel-new-sub");
    expect(render({ view: { kind: "buddy" } }, localState({ runner: { freeSessions: false } as never }))).not.toContain("panel-new-sub");
    expect(render({ view: { kind: "buddy" }, projects: [] })).not.toContain("panel-new-sub");
  });

  it("每行带一个短状态：在跑 / 等你 / 已交回 / 失败，别的不写", () => {
    const subs = [
      sub("s1", "甲", { state: "running", updatedAt: "2026-11-17T01:00:00.000Z" }),
      sub("s2", "乙", { state: "waiting", waiting: "question", updatedAt: "2026-11-17T01:01:00.000Z" }),
      sub("s3", "丙", { state: "done", updatedAt: "2026-11-17T01:02:00.000Z" }),
      sub("s4", "丁", { state: "waiting", waiting: null, stopWhy: "error", updatedAt: "2026-11-17T01:03:00.000Z" }),
      sub("s5", "戊", { state: "waiting", waiting: null, stopWhy: "turn_done", updatedAt: "2026-11-17T01:04:00.000Z" }),
      sub("s6", "己", { state: "queued", updatedAt: "2026-11-17T01:05:00.000Z" }),
      // 第一次验收没过、还在改（契约 failed）：点画在跑（5.4.2），字也写「在跑」。
      sub("s7", "庚", { state: "failed", updatedAt: "2026-11-17T01:06:00.000Z" }),
    ];
    const html = render({ view: { kind: "project", id: "p9" }, projects: [project("p9", "试", subs)] });
    expect(text(html)).toMatch(/\|甲\|在跑\|乙\|等你\|丙\|已交回\|丁\|失败\|戊\|己\|庚\|在跑\|/);
    expect(html.match(/data-testid="sub-status"/g)).toHaveLength(5);
  });

  it("「已归档 N」点开能恢复", () => {
    tap.open = false;
    expect(text(render({ view: { kind: "project", id: "p1" } }))).toContain("|已归档 1|");
    expect(text(render({ view: { kind: "buddy" } }))).toContain("|已归档 2|");
    expect(render({ archivedSubs: [] })).not.toContain("panel-archived");
    expect(render({ view: { kind: "project", id: "p3" } })).not.toContain("panel-archived");
    // 收着时不列；点开就地列出这个范围里的。
    const given = actions();
    expect(render({ view: { kind: "project", id: "p1" }, actions: given })).not.toContain("tree-archived-sub");
    (tap.props.get("panel-archived")?.onClick as () => void)();
    const html = render({ view: { kind: "project", id: "p1" }, actions: given });
    expect(html).toContain("tree-archived-sub");
    expect(html).toContain("旧选型");
    expect(html).not.toContain("旧固件");
    void tap.menus.get("旧选型")?.find((entry) => entry.id === "restore")?.run();
    expect(given.archiveSub).toHaveBeenCalledWith("topic", "a1", false);
    tap.open = false;
  });

  it("这台电脑那一块和后台任务都在", () => {
    const html = render({ view: { kind: "buddy" } });
    expect(html).toMatch(/以前的会话.*data-testid="resources".*这台电脑.*data-testid="bg-row".*拆卡/);
    // 手机的抽屉：先是会话列表，再是原来的 BackgroundPanel。
    const phone = render({ view: { kind: "buddy" }, handheld: true });
    expect(phone).toMatch(/以前的会话.*data-testid="background-panel".*data-testid="resources".*data-testid="bg-row"/);
  });

  it("页头按钮叫「会话」，有在跑的转一圈", () => {
    const button = (running: boolean, handheld = false) => { tap.first = 1; return renderToStaticMarkup(<SessionsButton running={running} open={false} handheld={handheld} alert={null} onPress={() => undefined} />); };
    expect(button(false)).toMatch(/<button[^>]*aria-label="会话"[^>]*title="会话"[^>]*data-testid="sessions-button"/);
    expect(button(false)).toContain("lucide-laptop-minimal");
    expect(button(false)).not.toContain("data-running");
    expect(button(true)).toContain("data-running");
    expect(button(true, true)).toContain('data-testid="phone-sessions"');
  });

  it("项目详情里不再列子会话", () => {
    tap.first = 1;
    const html = renderToStaticMarkup(<LocalContext.Provider value={localState()}>
      <ProjectInfo project={P1} period="2026-11" go={vi.fn()} actions={{ rename: vi.fn(), archive: vi.fn(), setFolders: vi.fn(), setDue: vi.fn(), transfer: vi.fn(), withdraw: vi.fn() }}
        doneDefinitionOf={() => null} me={{ personId: "me", name: "我" }} />
    </LocalContext.Provider>);
    expect(html).not.toContain('aria-label="子会话"');
    expect(html).not.toContain("改登录页");
  });
});
