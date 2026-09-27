import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { TMonthPlanResponse, TTaskView } from "@warmap/contracts";
import { dateFromPointer, draftFromPlan, planChanges, saveBody } from "./planDraft";

const ui = vi.hoisted(() => ({ state: [] as unknown[], cursor: 0, ask: vi.fn(), get: vi.fn(), put: vi.fn(), del: vi.fn(), saved: vi.fn(), dirty: vi.fn() }));
vi.mock("react", async importOriginal => {
  const real = await importOriginal<typeof import("react")>();
  return { ...real, useEffect: () => undefined, useRef: (value: unknown) => ({ current: value }), useState: (initial: unknown) => {
    const index = ui.cursor++;
    if (!(index in ui.state)) ui.state[index] = typeof initial === "function" ? initial() : initial;
    return [ui.state[index], (value: unknown) => { ui.state[index] = typeof value === "function" ? (value as (current: unknown) => unknown)(ui.state[index]) : value; }];
  } };
});
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => ({ ask: ui.ask, dialog: null }) }));
vi.mock("@/components/shell/WorkspaceContext", async importOriginal => ({ ...await importOriginal<typeof import("@/components/shell/WorkspaceContext")>(), useWorkspace: () => ({ navigate: vi.fn() }) }));
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: ui.get, PUT: ui.put, DELETE: ui.del } }));
vi.mock("ts-design/primitives", () => ({ Button: ({ children, onPress, isDisabled }: { children: unknown; onPress?: () => void; isDisabled?: boolean }) => <button onClick={onPress} disabled={isDisabled}>{children as string}</button> }));
import { MonthPlan } from "./MonthPlan";

const task: TTaskView = { id: "task-1", version: 3, title: "准备材料", status: "not_started", source: "plan", startDate: "2026-10-05", dueDate: "2026-10-08", doneDefinition: null, waitingOn: null, returnReason: null, origin: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", owner: { personId: "owner", name: "白田田" }, collaborators: [], mission: { missionId: "mission", title: "完善方法闭环", cardId: "card", period: "2026-10", battlefieldName: "灯塔项目", step: 1, steps: 1 } };
const plan = { period: "2026-10", firstDay: "2026-10-01", lastDay: "2026-10-31", today: "2026-10-06", editable: true, closedReason: null, groups: [
  { missionId: "mission", title: "完善方法闭环", battlefieldName: "灯塔项目", cardId: "card", milestones: [{ date: "2026-10-10", text: "10/10 核对" }], items: [task] },
  { missionId: null, title: "独立事项", battlefieldName: null, cardId: null, milestones: [], items: [] },
] } as TMonthPlanResponse;
type Node = ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function render(value = plan) { ui.cursor = 0; return nodes(MonthPlan({ plan: value, onSaved: ui.saved, onDirtyChange: ui.dirty })); }
function named(all: Node[], label: string) { return all.find(node => (Array.isArray(node.props.children) ? node.props.children.join("") : node.props.children) === label || node.props["aria-label"] === label)!; }
function saveButton(all: Node[]) { return all.find(node => typeof node.props.children === "string" && (node.props.children as string).startsWith("保存计划 ·"))!; }
beforeEach(() => { ui.state = []; ui.cursor = 0; vi.clearAllMocks(); ui.ask.mockResolvedValue(true); vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" }); });

describe("本月计划", () => {
  it("只读时说明原因且没有编辑控件", () => {
    const all = render({ ...plan, editable: false, closedReason: "个人卡确定之后才能拆成执行事项" });
    expect(all.some(node => node.props.children === "个人卡确定之后才能拆成执行事项")).toBe(true);
    expect(all.some(node => node.props.children === "保存计划" || node.props.children === "＋ 加一步" || node.props.type === "date")).toBe(false);
  });
  it("新步骤无日期可直接保存，只提交变动组和已有事项的变动字段", async () => {
    let all = render();
    (named(all, "＋ 加一步").props.onClick as () => void)();
    all = render();
    const title = all.find(node => node.props.placeholder === "步骤标题")!;
    (title.props.onChange as (event: unknown) => void)({ target: { value: "完成评审" } });
    all = render();
    (all.find(node => node.props.placeholder === "步骤标题")!.props.onKeyDown as (event: unknown) => void)({ key: "Enter" });
    all = render();
    ui.put.mockResolvedValue({ response: { ok: true }, data: plan });
    (saveButton(all).props.onPress as () => void)();
    await vi.waitFor(() => expect(ui.put).toHaveBeenCalled());
    expect(ui.ask).not.toHaveBeenCalled();
    expect(ui.put.mock.calls[0][1].body).toEqual({ period: "2026-10", groups: [
      { missionId: "mission", items: [
        { taskId: "task-1" },
        { clientId: "11111111-1111-4111-8111-111111111111", title: "完成评审" },
      ] },
    ] });
  });
  it("日期指针换算限制在月内，调整顺序计入改动", () => {
    expect(dateFromPointer(-20, 0, 620, "2026-10")).toBe("2026-10-01");
    expect(dateFromPointer(620, 0, 620, "2026-10")).toBe("2026-10-31");
    expect(dateFromPointer(200, 0, 620, "2026-10")).toBe("2026-10-11");
    const base = draftFromPlan(plan), draft = draftFromPlan(plan);
    draft[0].items[0].dueDate = "2026-10-09";
    expect(planChanges(base, draft)).toEqual({ added: 0, adjusted: 1 });
    expect(saveBody(plan.period, base, draft).groups).toEqual([{missionId:"mission",items:[{taskId:"task-1",dueDate:"2026-10-09"}]}]);
    const ordered = draftFromPlan(plan);
    ordered[0].items.push({ ...ordered[0].items[0], taskId: "task-2", version: 1 });
    const reversed = structuredClone(ordered);
    reversed[0].items.reverse();
    expect(planChanges(ordered, reversed).adjusted).toBe(2);
    expect(saveBody(plan.period, ordered, reversed).groups[0].items.map(item => item.taskId)).toEqual(["task-2", "task-1"]);
  });
  it("在空行拖画日期，拖动整条可平移；单侧日期显示标记", () => {
    const empty = { ...task, startDate: null, dueDate: null };
    const value = { ...plan, groups: [{ ...plan.groups[0], items: [empty] }, plan.groups[1]] };
    let all = render(value);
    const track = all.find(node => String(node.props["aria-label"]).startsWith("准备材料："))!;
    const currentTarget = { getBoundingClientRect: () => ({ left: 0, width: 620 }), setPointerCapture: vi.fn() };
    (track.props.onPointerDown as (event: unknown) => void)({ button: 0, target: { closest: () => null }, currentTarget, pointerId: 1, clientX: 200 });
    (track.props.onPointerMove as (event: unknown) => void)({ currentTarget, clientX: 260 });
    all = render(value);
    expect(all.some(node => String(node.props["aria-label"]).includes("2026-10-11 至 2026-10-14"))).toBe(true);
    const filled = all.find(node => String(node.props["aria-label"]).startsWith("准备材料："))!;
    (filled.props.onPointerDown as (event: unknown) => void)({ button: 0, target: { closest: (selector: string) => selector.includes("bar") ? {} : null }, currentTarget, pointerId: 2, clientX: 200 });
    (filled.props.onPointerMove as (event: unknown) => void)({ currentTarget, clientX: 220 });
    expect(render(value).some(node => String(node.props["aria-label"]).includes("2026-10-12 至 2026-10-15"))).toBe(true);
    ui.state = [];
    const mark = render({ ...plan, groups: [{ ...plan.groups[0], items: [{ ...task, startDate: null }] }, plan.groups[1]] });
    expect(mark.some(node => String(node.props.className).includes("dateMark"))).toBe(true);
  });
  it("独立事项不显示步骤号，也没有调先后控件", () => {
    const independent: TTaskView = { ...task, id: "solo", mission: null };
    let all = render({ ...plan, groups: [plan.groups[0], { ...plan.groups[1], items: [independent] }] });
    expect(named(all, "准备材料")).toBeTruthy();
    expect(named(all, "第 1 步 · 准备材料")).toBeTruthy();
    (named(all, "准备材料").props.onClick as () => void)();
    all = render({ ...plan, groups: [plan.groups[0], { ...plan.groups[1], items: [independent] }] });
    expect(all.filter(node => node.props.children === "上移")).toHaveLength(0);
  });
  it("409 提示刷新并保留本地编辑", async () => {
    let all = render();
    (named(all, "第 1 步 · 准备材料").props.onClick as () => void)();
    all = render();
    (all.filter(node => node.props.type === "date")[1].props.onChange as (event: unknown) => void)({ target: { value: "2026-10-09" } });
    all = render();
    ui.put.mockResolvedValue({ response: { ok: false, status: 409 }, error: { code: "PLAN_STALE" } });
    (saveButton(all).props.onPress as () => void)();
    await vi.waitFor(() => expect(ui.put).toHaveBeenCalled());
    await vi.waitFor(() => expect(render().some(node => String(node.props.children).includes("当前草稿已保留"))).toBe(true));
    all = render();
    expect(all.some(node => String(node.props.children).includes("当前草稿已保留"))).toBe(true);
    expect(all.filter(node => node.props.type === "date")[1].props.value).toBe("2026-10-09");
    ui.ask.mockResolvedValueOnce(false);
    (named(all, "刷新计划").props.onPress as () => void)();
    await vi.waitFor(() => expect(ui.ask).toHaveBeenCalledTimes(1));
    expect(ui.get).not.toHaveBeenCalled();
    ui.get.mockResolvedValue({ response: { ok: true }, data: plan });
    (named(render(), "刷新计划").props.onPress as () => void)();
    await vi.waitFor(() => expect(ui.get).toHaveBeenCalledWith("/api/me/plan", { params: { query: { period: "2026-10" } } }));
    await vi.waitFor(() => expect(render().filter(node => node.props.type === "date")[1].props.value).toBe("2026-10-08"));
  });
  it("删除已有步骤先确认，通过 DELETE 携带版本", async () => {
    let all = render();
    (named(all, "第 1 步 · 准备材料").props.onClick as () => void)();
    all = render();
    ui.del.mockResolvedValue({ response: { ok: true, status: 204 } });
    (named(all, "删除").props.onClick as () => void)();
    await vi.waitFor(() => expect(ui.del).toHaveBeenCalled());
    await vi.waitFor(() => expect(render().some(node => node.props.children === "已删除一步")).toBe(true));
    expect(ui.ask).toHaveBeenCalledWith(expect.stringContaining("准备材料"), "删除一步");
    expect(ui.del).toHaveBeenCalledWith("/api/me/tasks/{id}", { params: { path: { id: "task-1" }, query: { version: 3 } } });
    all = render();
    expect(all.some(node => node.props.children === "已删除一步")).toBe(true);
    expect(ui.saved.mock.calls.at(-1)?.[0].groups[0].items).toHaveLength(0);
  });
});
