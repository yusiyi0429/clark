import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* 直接调用 hook：useState 用按调用顺序存值的小仓库代替，其余 hook 原样透传。 */
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
  useState: hooks.useState, useEffect: () => undefined, useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useRef: (initial: unknown) => ({ current: initial }) }));

import type { TIssueDecisionHistory } from "@warmap/contracts";
import { buildHistoryIndex, emptySourceContext } from "@/cards/meetingSources";
import { useSourceNavigator } from "./SourceViewer";

type Node = { type?: unknown; props?: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return node.props ? [node, ...nodes(node.props.children)] : [];
}

const MATERIAL = "11111111-1111-4111-8111-111111111111";
const ISSUE = "22222222-2222-4222-8222-222222222222";
const history = {
  issueId: ISSUE, issueTitle: "验收清单", issueStatus: "pending",
  effective: [{ ref: "decision:r-1", issueId: ISSUE, kind: "decision", text: "9 月起附清单", decidedAt: "2026-09-25T02:00:00.000Z", decidedBy: null,
    confirmedVia: "imported", option: null, status: "effective", statusAt: null, statusReason: null, supersededBy: null, revokedBy: null,
    source: { kind: "imported", importedRef: "纪要" }, sourceRefs: ["decision:r-1"] }],
  inactive: [], changes: [], changesSince: null, changesNote: null, pending: [], relatedMeetings: [],
} as unknown as TIssueDecisionHistory;
const context = emptySourceContext({
  meetingId: "m-1", issueIds: [ISSUE],
  materials: new Map([[MATERIAL, { objectType: "issue" as const, objectId: ISSUE, fileName: "交付周报.md" }]]),
  history: buildHistoryIndex([history]),
});

const scroller = { scrollTop: 640, getBoundingClientRect: () => ({ top: 0 }), querySelector: () => null, scrollTo: vi.fn() };
const entry = { tagName: "LI", parentElement: null, dataset: {} as Record<string, string>, getBoundingClientRect: () => ({ top: 1200 }), closest: () => scroller };
const root = { querySelector: vi.fn((selector: string) => (selector === `#history-${ISSUE}-decision-r-1` ? entry : null)) };
const onNavigate = vi.fn();
const beforeLeave = vi.fn();
const run = () => {
  hooks.index = 0;
  return useSourceNavigator({ context, rootRef: { current: root as unknown as HTMLElement }, onNavigate, objects: [], meetingId: "m-1", beforeLeave });
};

beforeEach(() => {
  hooks.values = [];
  vi.clearAllMocks();
  scroller.scrollTop = 640;
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("window", { setTimeout: () => 0, matchMedia: () => ({ matches: true }), getComputedStyle: () => ({ display: "none" }) });
});
afterEach(() => vi.unstubAllGlobals());

describe("点依据去哪（feedback 14）", () => {
  it("群材料在「依据」抽屉里按引用的版本和段落打开，正文不动；关上回到原处", () => {
    const trigger = { isConnected: true, focus: vi.fn() };
    run().api.open(`material:${MATERIAL}@v2#p3`, { issueId: ISSUE, trigger: trigger as unknown as HTMLElement });
    const drawer = nodes(run().overlay).find((node) => node.props && "state" in node.props);
    expect(drawer?.props?.state).toMatchObject({ ref: `material:${MATERIAL}@v2#p3`, issueId: ISSUE,
      target: { type: "material", materialId: MATERIAL, version: 2, paragraph: 3, material: { objectType: "issue", objectId: ISSUE } } });
    expect(scroller.scrollTo).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    (drawer!.props!.onClose as () => void)();
    expect(nodes(run().overlay).some((node) => node.props && "state" in node.props)).toBe(false);
    expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("同一页里的历史决定：滚到那一条（让出页头）并闪一下，出现「回到刚才的位置」，点它回到原来的滚动位置", () => {
    run().api.open("decision:r-1", { issueId: ISSUE });
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 1200 + 640 - (48 + 14), behavior: "auto" });
    expect(entry.dataset.flash).toBe("true");
    const back = nodes(run().overlay).find((node) => node.type === "button" && node.props?.onClick && !node.props["aria-label"]);
    expect(back).toBeTruthy();
    (back!.props!.onClick as () => void)();
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 640 });
  });

  it("外部信号跳到信号页，跳之前记下读到的位置；当前会议本身不做任何事", () => {
    run().api.open("signal:s-9");
    expect(beforeLeave).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("/radar/signals/s-9", null);
    onNavigate.mockClear();
    run().api.open("meeting:m-1");
    expect(onNavigate).not.toHaveBeenCalled();
    expect(nodes(run().overlay).some((node) => node.props && ("state" in node.props || node.props.role === "group"))).toBe(false);
  });

  it("群讨论、企业知识在抽屉里打开；本页找不到的历史决定也退回抽屉说明", () => {
    run().api.open("discussion:88");
    expect(nodes(run().overlay).find((node) => node.props && "state" in node.props)?.props?.state).toMatchObject({ target: { type: "discussion", messageId: 88 } });
    hooks.values = [];
    run().api.open("memory:经营原则.md#s2");
    expect(nodes(run().overlay).find((node) => node.props && "state" in node.props)?.props?.state).toMatchObject({ target: { type: "detail", parsed: { kind: "memory" } } });
    hooks.values = [];
    root.querySelector.mockReturnValueOnce(null);
    run().api.open("decision:r-1", { issueId: ISSUE });
    expect(nodes(run().overlay).find((node) => node.props && "state" in node.props)?.props?.state).toMatchObject({ target: { type: "detail" } });
  });
});
