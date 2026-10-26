import { beforeEach, expect, it, vi } from "vitest";
import { getLocalTimeZone, today } from "@internationalized/date";

/** 每个组件一份 hook 存储：render 时指定用哪一份；setter 写回它自己那一份。effect 先收起来，测试要时再跑。 */
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as (() => unknown)[] }));
const actions = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn(), put: vi.fn(), get: vi.fn(), delete: vi.fn(), navigate: vi.fn(), ask: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => { const store = hooks.values, i = hooks.index++; if (!(i in store)) store[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [store[i], (next: unknown) => { store[i] = typeof next === "function" ? (next as (value: unknown) => unknown)(store[i]) : next; }]; },
    useRef: (initial: unknown) => { const store = hooks.values, i = hooks.index++; if (!(i in store)) store[i] = { current: initial }; return store[i]; },
    useMemo: (factory: () => unknown) => factory(),
    useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
  };
});
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ close: vi.fn(), navigate: actions.navigate, compose: vi.fn() }), useRegisterDetail: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => null }));
vi.mock("@/components/shell/DetailFrame", () => ({ DetailFrame: () => null }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => ({ ask: actions.ask, dialog: null }) }));
vi.mock("@/lib/api/client", () => ({ browserApi: { POST: actions.post, PATCH: actions.patch, PUT: actions.put, GET: actions.get, DELETE: actions.delete } }));
vi.mock("ts-design", () => ({ FormField: () => null, StatusBadge: () => null, ActionButton: () => null, TianshuPortalTheme: ({ children }: { children?: unknown }) => children }));
vi.mock("ts-design/primitives", () => ({ Button: () => null, Input: () => null, Label: () => null, TextField: () => null, TextArea: () => null,
  Select: Object.assign(() => null, { Trigger: () => null, Value: () => null, Indicator: () => null, Popover: () => null }),
  ListBox: Object.assign(() => null, { Item: () => null, ItemIndicator: () => null }),
  Popover: Object.assign(() => null, { Content: () => null, Dialog: () => null }),
  Tooltip: Object.assign(() => null, { Content: () => null }),
  Checkbox: Object.assign(() => null, { Control: () => null, Indicator: () => null, Content: () => null }),
}));
vi.mock("@heroui/react", () => { const Modal = Object.assign(() => null, { Backdrop: () => null, Container: () => null, Dialog: () => null, CloseTrigger: () => null, Header: () => null, Heading: () => null, Body: () => null, Footer: () => null }); return { Modal }; });

import { CreateTaskScreen } from "./CreateTaskScreen";
import { CollaboratorsDialog } from "./CollaboratorsDialog";
import { TaskScreen } from "./TaskScreen";
import { TaskEditForm } from "./TaskEditForm";
import { DatePicker } from "@/components/ui/DatePicker";
import { AcceptDialog } from "./AcceptDialog";
import a from "./accept-dialog.module.css";

type Node = { type?: unknown; key?: unknown; props?: Record<string, unknown> };
function find(node: unknown, match: (node: Node) => boolean): Node | undefined {
  if (Array.isArray(node)) return node.map((entry) => find(entry, match)).find(Boolean);
  if (!node || typeof node !== "object") return undefined;
  const element = node as Node;
  return match(element) ? element : find(element.props?.children, match);
}
function findAll(node: unknown, match: (node: Node) => boolean): Node[] {
  if (Array.isArray(node)) return node.flatMap((entry) => findAll(entry, match));
  if (!node || typeof node !== "object") return [];
  const element = node as Node;
  return [...(match(element) ? [element] : []), ...findAll(element.props?.children, match)];
}
const render = (component: () => unknown, store: unknown[] = main) => { hooks.values = store; hooks.index = 0; hooks.effects = []; return component(); };
let main: unknown[] = [];
beforeEach(() => { main = []; hooks.values = main; hooks.index = 0; hooks.effects = []; vi.clearAllMocks(); for (const action of Object.values(actions)) action.mockReset(); vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" }); vi.stubGlobal("window", { dispatchEvent: vi.fn() }); });

it("三步新建：回车逐步前进，最后一步才提交；失败保留草稿，重试复用 clientId，成功后进入详情", async () => {
  let tree = render(() => CreateTaskScreen());
  const submit = () => { tree = render(() => CreateTaskScreen()); (find(tree, (node) => node.type === "form")!.props!.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} }); };
  submit(); // 标题为空时停在第一步
  tree = render(() => CreateTaskScreen());
  expect(find(tree, (node) => node.props?.name === "title")).toBeDefined();
  (find(tree, (node) => node.props?.name === "title")!.props!.onChange as (event: { target: { value: string } }) => void)({ target: { value: "联系两家客户" } });
  submit(); // 第一步 → 第二步：挂不挂 Mission
  tree = render(() => CreateTaskScreen());
  expect(find(tree, (node) => node.props?.role === "switch")?.props?.["aria-checked"]).toBe(false);
  submit(); // 第二步 → 第三步：日期与完成标准
  tree = render(() => CreateTaskScreen());
  // 不选日期：开始默认今天，截止还没想好。
  expect(find(tree, (node) => node.props?.label === "开始")?.props?.value).toBe(today(getLocalTimeZone()).toString());
  expect(find(tree, (node) => node.props?.label === "截止")?.props?.value).toBe("");
  expect(find(tree, (node) => node.type === "textarea")).toBeDefined();
  expect(actions.post).not.toHaveBeenCalled();
  actions.post.mockResolvedValueOnce({ error: { message: "暂时失败" } }).mockResolvedValueOnce({ data: { id: "task-new" } });
  submit();
  await vi.waitFor(() => expect(actions.post).toHaveBeenCalledTimes(1));
  submit();
  await vi.waitFor(() => expect(actions.navigate).toHaveBeenCalledWith("/me/tasks/task-new"));
  expect(actions.post.mock.calls[0][1].body).toEqual({ clientId: "00000000-0000-4000-8000-000000000001", title: "联系两家客户", missionId: null, startDate: today(getLocalTimeZone()).toString() });
  expect(actions.post.mock.calls[1][1].body.clientId).toBe(actions.post.mock.calls[0][1].body.clientId);
});

/** 本人两个 Mission，只有 m1 下有 Task（首页计划读本体）。 */
const PLAN_TASKS = [{ taskId: "t1", missionId: "m1", name: "回流方案定稿", doneDefinition: null, criteria: [] }, { taskId: "t2", missionId: "m1", name: "真实会议跑通", doneDefinition: null, criteria: [] }];
const answerGets = (homePlan: unknown = { missions: [{ missionId: "m1" }, { missionId: "m2" }], tasks: PLAN_TASKS }) => actions.get.mockImplementation(async (path: string) => path === "/api/me/home-plan" ? { data: homePlan }
  : path === "/api/me/plan" ? { data: { editable: true, groups: [{ missionId: "m1", title: "上线", battlefieldName: "增长" }, { missionId: "m2", title: "验证", battlefieldName: "增长" }] } } : {});
/** 跑一遍收起来的 effect，等它们发出的 GET 都回来（编辑表单读首页计划和人员名册两次）。 */
const settle = async (count: number) => { hooks.effects.forEach((effect) => effect()); await vi.waitFor(() => expect(actions.get).toHaveBeenCalledTimes(count)); await new Promise((resolve) => setTimeout(resolve, 0)); };

it("新建时选了有 Task 的 Mission 才出「挂到 Task」，默认不挂；选了就带 planTaskId", async () => {
  answerGets();
  let tree = render(() => CreateTaskScreen());
  await settle(2);
  const taskGroup = () => find(tree, (node) => node.props?.role === "group" && node.props?.["aria-label"] === "挂到 Task");
  const chip = (title: string) => find(tree, (node) => node.type === "button" && node.props?.title === title)!;
  tree = render(() => CreateTaskScreen());
  (find(tree, (node) => node.props?.name === "title")!.props!.onChange as (event: { target: { value: string } }) => void)({ target: { value: "联系两家客户" } });
  tree = render(() => CreateTaskScreen());
  (find(tree, (node) => node.type === "form")!.props!.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
  tree = render(() => CreateTaskScreen());
  expect(taskGroup()).toBeUndefined(); // 还没挂 Mission
  (find(tree, (node) => node.props?.role === "switch")!.props!.onClick as () => void)();
  tree = render(() => CreateTaskScreen());
  expect(taskGroup()).toBeDefined();
  expect(chip("不挂").props!["aria-pressed"]).toBe(true);
  expect(chip("回流方案定稿")).toBeDefined(); expect(chip("真实会议跑通")).toBeDefined();
  (chip("回流方案定稿").props!.onClick as () => void)();
  // 换到没有 Task 的 Mission：整组不出，选过的 Task 作废。
  tree = render(() => CreateTaskScreen());
  (find(tree, (node) => node.type === "input" && node.props?.value === "m2")!.props!.onChange as () => void)();
  tree = render(() => CreateTaskScreen());
  expect(taskGroup()).toBeUndefined();
  (find(tree, (node) => node.type === "input" && node.props?.value === "m1")!.props!.onChange as () => void)();
  tree = render(() => CreateTaskScreen());
  expect(chip("不挂").props!["aria-pressed"]).toBe(true);
  (chip("真实会议跑通").props!.onClick as () => void)();
  actions.post.mockResolvedValue({ data: { id: "task-new" } });
  for (let step = 0; step < 2; step++) {
    tree = render(() => CreateTaskScreen());
    (find(tree, (node) => node.type === "form")!.props!.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} });
  }
  await vi.waitFor(() => expect(actions.post).toHaveBeenCalledOnce());
  expect(actions.post.mock.calls[0][1].body).toMatchObject({ missionId: "m1", planTaskId: "t2" });
});

it("编辑表单：所属 Mission 有 Task 时能改「挂到 Task」，换 Mission 清掉；没有 Task 的 Mission 不出", async () => {
  answerGets();
  const onSave = vi.fn();
  const form: unknown[] = [];
  const mission = { missionId: "m1", title: "上线", cardId: "card", period: "2026-10", battlefieldName: "增长", step: 1, steps: 1 };
  const opened = detailOf({ task: { ...task, mission, planTaskId: "t1" }, missionOptions: [
    { missionId: "m1", title: "上线", battlefieldName: "增长", period: "2026-10" }, { missionId: "m2", title: "验证", battlefieldName: "增长", period: "2026-10" }] }) as Parameters<typeof TaskEditForm>[0]["detail"];
  const props = { detail: opened, busy: false, onSave, onCancel: vi.fn() };
  let fields = render(() => TaskEditForm(props), form);
  await settle(2);
  const picker = () => find(fields, (node) => node.props?.["aria-label"] === "挂到 Task");
  const save = () => { fields = render(() => TaskEditForm(props), form); (find(fields, (node) => node.props?.children === "保存")!.props!.onPress as () => void)(); };
  fields = render(() => TaskEditForm(props), form);
  expect(picker()?.props?.selectedKey).toBe("t1");
  expect(findAll(picker(), (node) => node.props?.id !== undefined).map((node) => [node.props!.id, node.props!.textValue])).toEqual([["none", "不挂"], ["t1", "回流方案定稿"], ["t2", "真实会议跑通"]]);
  (picker()!.props!.onSelectionChange as (key: string) => void)("none");
  save();
  expect(onSave).toHaveBeenLastCalledWith({ planTaskId: null });
  (picker()!.props!.onSelectionChange as (key: string) => void)("t2");
  save();
  expect(onSave).toHaveBeenLastCalledWith({ planTaskId: "t2" });
  (find(fields, (node) => node.props?.["aria-label"] === "所属个人任务")!.props!.onSelectionChange as (key: string) => void)("m2");
  fields = render(() => TaskEditForm(props), form);
  expect(picker()).toBeUndefined();
  save();
  expect(onSave).toHaveBeenLastCalledWith({ missionId: "m2", planTaskId: null });
  // 换回打开时的 Mission：Task 回到打开时的，什么都不交。
  (find(fields, (node) => node.props?.["aria-label"] === "所属个人任务")!.props!.onSelectionChange as (key: string) => void)("m1");
  fields = render(() => TaskEditForm(props), form);
  expect(picker()?.props?.selectedKey).toBe("t1");
  save();
  expect(props.onCancel).toHaveBeenCalledOnce();
});

it("编辑表单：挂着的 Task 已不在本体里时单列「已不存在的 Task」，能改成不挂；没读到 Task 时不出、换回 Mission 也不交 planTaskId", async () => {
  const mission = { missionId: "m1", title: "上线", cardId: "card", period: "2026-10", battlefieldName: "增长", step: 1, steps: 1 };
  const missionOptions = [{ missionId: "m1", title: "上线", battlefieldName: "增长", period: "2026-10" }, { missionId: "m2", title: "验证", battlefieldName: "增长", period: "2026-10" }];
  const goneDetail = detailOf({ task: { ...task, mission, planTaskId: "t-gone" }, missionOptions }) as Parameters<typeof TaskEditForm>[0]["detail"];
  const onSave = vi.fn(), onCancel = vi.fn();
  answerGets();
  let form: unknown[] = [];
  let fields = render(() => TaskEditForm({ detail: goneDetail, busy: false, onSave, onCancel }), form);
  await settle(2);
  const picker = () => find(fields, (node) => node.props?.["aria-label"] === "挂到 Task");
  fields = render(() => TaskEditForm({ detail: goneDetail, busy: false, onSave, onCancel }), form);
  expect(picker()?.props?.selectedKey).toBe("t-gone");
  expect(findAll(picker(), (node) => node.props?.id !== undefined).map((node) => node.props!.textValue)).toEqual(["不挂", "已不存在的 Task", "回流方案定稿", "真实会议跑通"]);
  (picker()!.props!.onSelectionChange as (key: string) => void)("none");
  fields = render(() => TaskEditForm({ detail: goneDetail, busy: false, onSave, onCancel }), form);
  expect(picker()?.props?.selectedKey).toBe("none");
  (find(fields, (node) => node.props?.children === "保存")!.props!.onPress as () => void)();
  expect(onSave).toHaveBeenCalledWith({ planTaskId: null });

  // 首页计划没读到：不出下拉；换个 Mission 再换回来，不会悄悄交 planTaskId: null。
  actions.get.mockReset(); actions.get.mockResolvedValue({ error: { message: "暂时失败" } });
  const linked = detailOf({ task: { ...task, mission, planTaskId: "t1" }, missionOptions }) as Parameters<typeof TaskEditForm>[0]["detail"];
  form = [];
  fields = render(() => TaskEditForm({ detail: linked, busy: false, onSave, onCancel }), form);
  await settle(2);
  fields = render(() => TaskEditForm({ detail: linked, busy: false, onSave, onCancel }), form);
  expect(picker()).toBeUndefined();
  for (const key of ["m2", "m1"]) {
    (find(fields, (node) => node.props?.["aria-label"] === "所属个人任务")!.props!.onSelectionChange as (key: string) => void)(key);
    fields = render(() => TaskEditForm({ detail: linked, busy: false, onSave, onCancel }), form);
  }
  (find(fields, (node) => node.props?.children === "保存")!.props!.onPress as () => void)();
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onCancel).toHaveBeenCalledOnce();
});

it("邀请只提交选中的 collaboratorOptions 人员", async () => {
  const props = { taskId: "task-1", options: [{ personId: "bai", name: "白田田" }], isOpen: true, onClose: vi.fn(), onAdded: vi.fn() };
  let tree = render(() => CollaboratorsDialog(props));
  const checkbox = find(tree, (node) => node.type === "input" && node.props?.type === "checkbox")!;
  (checkbox.props!.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
  tree = render(() => CollaboratorsDialog(props));
  actions.post.mockResolvedValue({ data: { id: "task-1" } });
  (find(tree, (node) => node.props?.children === "加入协作与群聊")!.props!.onPress as () => void)();
  await vi.waitFor(() => expect(actions.post).toHaveBeenCalledWith("/api/me/tasks/{id}/collaborators", { params: { path: { id: "task-1" } }, body: { personIds: ["bai"] } }));
  await vi.waitFor(() => expect(props.onAdded).toHaveBeenCalledOnce());
});

const DOC = "11111111-1111-4111-8111-111111111111", LINK = "22222222-2222-4222-8222-222222222222";
const task = { id: "task-1", version: 2, title: "核对试点", source: "self", status: "in_progress", startDate: null, dueDate: null, doneDefinition: "两家客户都确认\n留下结论", mission: null, waitingOn: null, awaitingAcceptance: false, owner: { personId: "sun", name: "孙铭泽" }, collaborators: [{ personId: "lin", name: "林晓" }], latestProgress: null, returnReason: null, origin: null, createdAt: "2026-09-27T00:00:00Z", updatedAt: "2026-09-27T00:00:00Z" } as const;
const detailOf = (extra: Record<string, unknown> = {}) => ({ task, judgment: "原判断", judgmentAt: null, myNote: null, myNoteAt: null, role: "owner", missionOptions: [], collaboratorOptions: [], progress: [], standards: ["两家客户都确认", "留下结论"], submission: null, acceptance: null, ...extra }) as never;
const material = (id: string, fileName: string) => ({ id, objectType: "task", objectId: "task-1", fileName, format: "markdown", sizeBytes: 1, origin: "upload", owner: { personId: "sun", displayName: "孙铭泽" }, createdAt: "2026-10-05T06:00:00Z", updatedAt: "2026-10-05T06:00:00Z", version: 1, editable: true, canDelete: true, lastRevision: null, working: false }) as never;
const area = { materials: [], canUpload: true, uploading: false, open: vi.fn(), pickFile: vi.fn(), pasteLink: vi.fn() };
/** 页面交给材料区的正文（封面）和页头 ⋯ 里的几项。 */
const coverOf = (tree: unknown) => find((find(tree, (node) => typeof node.props?.children === "function")!.props!.children as (value: unknown) => unknown)(area), (node) => node.props?.editor !== undefined)!;
const moreItems = (tree: unknown) => find(find(tree, (node) => node.props?.actions !== undefined)!.props!.actions, (node) => Array.isArray(node.props?.items))!.props!.items as { id: string; run: () => void }[];

it("⋯ → 编辑：表单只把改过的字段交给保存；页面 PATCH 带着版本", async () => {
  const detail = detailOf();
  let tree = render(() => TaskScreen({ initialDetail: detail }));
  moreItems(tree).find((item) => item.id === "edit")!.run();
  tree = render(() => TaskScreen({ initialDetail: detail }));
  const editor = coverOf(tree).props!.editor as Node;
  expect(editor.type).toBe(TaskEditForm);
  // 表单自己的状态单独存一份。
  const form: unknown[] = [];
  const onSave = vi.fn();
  let fields = render(() => TaskEditForm({ ...(editor.props as Parameters<typeof TaskEditForm>[0]), onSave }), form);
  // 不再有「这件事的判断」；日期用全站的日期选择，不是原生日期框。
  expect(find(fields, (node) => typeof node.props?.label === "string" && (node.props.label as string).includes("判断"))).toBeUndefined();
  expect(find(fields, (node) => node.props?.type === "date")).toBeUndefined();
  (find(fields, (node) => node.type === DatePicker && node.props?.label === "截止日期")!.props!.onChange as (value: string) => void)("2026-10-20");
  fields = render(() => TaskEditForm({ ...(editor.props as Parameters<typeof TaskEditForm>[0]), onSave }), form);
  expect(find(fields, (node) => node.type === DatePicker && node.props?.label === "计划开始日期")!.props!.max).toBe("2026-10-20");
  (find(fields, (node) => node.props?.children === "保存")!.props!.onPress as () => void)();
  expect(onSave).toHaveBeenCalledWith({ dueDate: "2026-10-20" });
  actions.patch.mockResolvedValue({ data: { ...task, version: 3 } }); actions.get.mockResolvedValue({ data: detail });
  (editor.props!.onSave as (body: unknown) => void)({ dueDate: "2026-10-20" });
  await vi.waitFor(() => expect(actions.patch).toHaveBeenCalledWith("/api/me/tasks/{id}", { params: { path: { id: "task-1" } }, body: { version: 2, dueDate: "2026-10-20" } }));
  expect(actions.put).not.toHaveBeenCalled();
});

it("编辑表单只交人改过的字段：别处同时改了截止日期，保存完成标准时不把旧的截止日期盖回去", () => {
  const onSave = vi.fn();
  const form: unknown[] = [];
  const opened = detailOf({ task: { ...task, dueDate: "2026-10-12" } }) as Parameters<typeof TaskEditForm>[0]["detail"];
  let fields = render(() => TaskEditForm({ detail: opened, busy: false, onSave, onCancel: vi.fn() }), form);
  (find(fields, (node) => node.props?.label === "完成标准 · 可选")!.props!.onChange as (value: string) => void)("两家客户都确认");
  // 页面在表单开着时重读了一次：截止日期被别处改成了 10/20。
  const latest = detailOf({ task: { ...task, version: 3, dueDate: "2026-10-20" } }) as Parameters<typeof TaskEditForm>[0]["detail"];
  fields = render(() => TaskEditForm({ detail: latest, busy: false, onSave, onCancel: vi.fn() }), form);
  (find(fields, (node) => node.props?.children === "保存")!.props!.onPress as () => void)();
  expect(onSave).toHaveBeenCalledWith({ doneDefinition: "两家客户都确认" });
});

it("会后事项退回：⋯ → 退回，写原因、再确认，才调用原退回接口", async () => {
  const detail = detailOf({ task: { ...task, source: "meeting" }, judgment: null });
  let tree = render(() => TaskScreen({ initialDetail: detail }));
  moreItems(tree).find((item) => item.id === "return")!.run();
  tree = render(() => TaskScreen({ initialDetail: detail }));
  const dialog = find(tree, (node) => typeof node.props?.onSubmit === "function" && typeof node.props?.onClose === "function")!;
  actions.ask.mockResolvedValueOnce(false);
  expect(await (dialog.props!.onSubmit as (reason: string) => Promise<string | null>)("会议安排与当前职责冲突")).toBeNull();
  expect(actions.post).not.toHaveBeenCalled();
  actions.ask.mockResolvedValueOnce(true); actions.post.mockResolvedValue({ data: { ...task, status: "returned" } }); actions.get.mockResolvedValue({ data: detail });
  await (dialog.props!.onSubmit as (reason: string) => Promise<string | null>)("会议安排与当前职责冲突");
  expect(actions.post).toHaveBeenCalledWith("/api/me/tasks/{id}/return", { params: { path: { id: "task-1" } }, body: { version: 2, reason: "会议安排与当前职责冲突" } });
});

it("重新打开先确认（验收记录会清掉），再带版本调 reopen", async () => {
  const detail = detailOf({ task: { ...task, status: "done" } });
  const tree = render(() => TaskScreen({ initialDetail: detail }));
  expect(moreItems(tree).map((item) => item.id)).toEqual(["edit", "reopen"]);
  actions.ask.mockResolvedValueOnce(true); actions.post.mockResolvedValue({ data: { ...task, version: 3 } }); actions.get.mockResolvedValue({ data: detail });
  moreItems(tree).find((item) => item.id === "reopen")!.run();
  await vi.waitFor(() => expect(actions.post).toHaveBeenCalledWith("/api/me/tasks/{id}/reopen", { params: { path: { id: "task-1" } }, body: { version: 2 } }));
  expect(actions.ask.mock.calls[0][0]).toContain("验收记录会清掉");
});

const submission = { by: { personId: "sun", name: "孙铭泽" }, via: "codex", at: "2026-10-09T08:00:00Z", verdict: "两家都确认了",
  standards: [{ index: 0, met: true, evidence: "进展里写了两家的回复", materialId: null }, { index: 1, met: true, evidence: null, materialId: DOC }], deliverableMaterialIds: [DOC, "99999999-9999-4999-8999-999999999999"] };
const deliverableBoxes = (tree: unknown) => findAll(tree, (node) => node.props?.className === a.deliverable);
const button = (tree: unknown, label: string) => find(tree, (node) => Array.isArray(node.props?.children) ? (node.props!.children as unknown[]).includes(label) : node.props?.children === label);
/** 第 index 条（从 0 起）下面的「达到」「没达到」。 */
const decide = (tree: unknown, index: number, label: "达到" | "没达到") =>
  (find(find(tree, (node) => node.props?.["aria-label"] === `第 ${index + 1} 条`), (node) => node.props?.children === label)!.props!.onClick as () => void)();
const reason = (tree: unknown, index: number) => find(tree, (node) => node.props?.["aria-label"] === `第 ${index + 1} 条没达到的原因`);
const text = (tree: unknown): string => {
  if (tree === null || tree === undefined || typeof tree === "boolean") return "";
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join("");
  return text((tree as Node).props?.children);
};
const dialogProps = (detail: unknown, materials: unknown[] = [material(DOC, "结论.md")]) =>
  ({ detail: detail as never, materials: materials as never[], onClose: vi.fn(), onDone: vi.fn(async () => undefined), onStale: vi.fn(), onOpenMaterial: vi.fn(), onEditStandards: vi.fn() });

it("外部工具提交了：每条下面写工具的判断和依据，不请 Agent 起草；本人逐条确认前「验收完成」点不了；全部达到才提交，带上工具的依据、结论和现有的交付结果", async () => {
  const props = dialogProps(detailOf({ submission, task: { ...task, awaitingAcceptance: true } }));
  const store: unknown[] = [];
  let tree = render(() => AcceptDialog(props), store);
  hooks.effects.forEach((effect) => effect());
  expect(actions.post).not.toHaveBeenCalled();
  expect(text(tree)).toContain("Codex达到 · 进展里写了两家的回复");
  expect(text(tree)).toContain("0 / 2 已确认");
  expect(button(tree, "验收完成")!.props!.isDisabled).toBe(true);
  decide(tree, 0, "达到");
  tree = render(() => AcceptDialog(props), store);
  expect(button(tree, "验收完成")!.props!.isDisabled).toBe(true);
  decide(tree, 1, "达到");
  tree = render(() => AcceptDialog(props), store);
  expect(text(tree)).toContain("2 / 2 已确认");
  expect(deliverableBoxes(tree).map((node) => node.props!.isSelected)).toEqual([true]);
  expect(find(tree, (node) => node.props?.value === "两家都确认了")).toBeDefined();
  actions.post.mockResolvedValue({ data: { ...task, status: "done", version: 3 } });
  (button(tree, "验收完成")!.props!.onPress as () => void)();
  await vi.waitFor(() => expect(props.onDone).toHaveBeenCalledWith({ ...task, status: "done", version: 3 }, true));
  expect(actions.post).toHaveBeenCalledWith("/api/me/tasks/{id}/accept", { params: { path: { id: "task-1" } }, body: {
    version: 2, verdict: "两家都确认了", deliverableMaterialIds: [DOC],
    standards: [{ index: 0, met: true, evidence: "进展里写了两家的回复", materialId: null }, { index: 1, met: true, evidence: null, materialId: DOC }],
  } });
});

it("有一条没达到：要写原因才能点，按钮变成「退回」、不出结论；退回带上每条的判断和原因，接着做", async () => {
  const props = dialogProps(detailOf({ submission, task: { ...task, awaitingAcceptance: true } }));
  const store: unknown[] = [];
  let tree = render(() => AcceptDialog(props), store);
  decide(tree, 0, "达到");
  decide(tree, 1, "没达到");
  tree = render(() => AcceptDialog(props), store);
  expect(button(tree, "验收完成")).toBeUndefined();
  expect(button(tree, "退回")!.props!.isDisabled).toBe(true);
  expect(find(tree, (node) => node.props?.value === "两家都确认了")).toBeUndefined();
  (reason(tree, 1)!.props!.onChange as (value: string) => void)("第二家还没回复");
  tree = render(() => AcceptDialog(props), store);
  expect(button(tree, "退回")!.props!.isDisabled).toBe(false);
  actions.post.mockResolvedValue({ data: { ...task, version: 3 } });
  (button(tree, "退回")!.props!.onPress as () => void)();
  await vi.waitFor(() => expect(props.onDone).toHaveBeenCalledWith({ ...task, version: 3 }, false));
  expect(actions.post).toHaveBeenCalledWith("/api/me/tasks/{id}/acceptance-return", { params: { path: { id: "task-1" } }, body: {
    version: 2, standards: [{ index: 0, met: true, evidence: "进展里写了两家的回复", materialId: null }, { index: 1, met: false, evidence: "第二家还没回复", materialId: null }],
  } });
});

it("没有提交时请我的 Agent 起草：判断列在每条下面，但不替人确认；没写完成标准的不起草，只有「写完成标准」", async () => {
  const props = dialogProps(detailOf());
  const store: unknown[] = [];
  let tree = render(() => AcceptDialog(props), store);
  expect(find(tree, (node) => node.props?.role === "status")).toBeDefined();
  actions.post.mockResolvedValueOnce({ data: { verdict: "两家都回了", standards: [{ index: 0, met: true, evidence: "群里有回复", materialId: null }], deliverableMaterialIds: [] } });
  hooks.effects.forEach((effect) => effect());
  expect(actions.post).toHaveBeenCalledWith("/api/me/tasks/{id}/acceptance-draft", expect.objectContaining({ params: { path: { id: "task-1" } } }));
  await vi.waitFor(() => { tree = render(() => AcceptDialog(props), store); expect(find(tree, (node) => node.props?.role === "status")).toBeUndefined(); });
  expect(text(tree)).toContain("我的 Agent达到 · 群里有回复");
  expect(text(tree)).toContain("0 / 2 已确认");
  expect(button(tree, "验收完成")!.props!.isDisabled).toBe(true);

  vi.mocked(actions.post).mockClear();
  const bare = dialogProps(detailOf({ standards: [] }), []);
  tree = render(() => AcceptDialog(bare), []);
  hooks.effects.forEach((effect) => effect());
  expect(actions.post).not.toHaveBeenCalled();
  expect(button(tree, "验收完成")).toBeUndefined();
  (button(tree, "写完成标准")!.props!.onPress as () => void)();
  expect(bare.onClose).toHaveBeenCalled();
  expect(bare.onEditStandards).toHaveBeenCalled();
});

it("人先动了结论，Agent 的草稿晚到也不覆盖；关弹窗什么都不提交", async () => {
  const props = dialogProps(detailOf(), []);
  const store: unknown[] = [];
  let tree = render(() => AcceptDialog(props), store);
  let resolve: (value: unknown) => void = () => undefined;
  actions.post.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  hooks.effects.forEach((effect) => effect());
  decide(tree, 0, "达到");
  tree = render(() => AcceptDialog(props), store);
  (find(tree, (node) => node.props?.className === a.verdict)!.props!.onChange as (value: string) => void)("我自己的结论");
  resolve({ data: { verdict: "Agent 的结论", standards: [{ index: 0, met: true, evidence: null, materialId: null }], deliverableMaterialIds: [] } });
  await vi.waitFor(() => { tree = render(() => AcceptDialog(props), store); expect(find(tree, (node) => node.props?.role === "status")).toBeUndefined(); });
  expect(find(tree, (node) => node.props?.value === "我自己的结论")).toBeDefined();
  expect(find(tree, (node) => node.props?.value === "Agent 的结论")).toBeUndefined();
  vi.mocked(actions.post).mockClear();
  ((tree as Node).props!.onClose as () => void)();
  expect(props.onClose).toHaveBeenCalled();
  expect(actions.post).not.toHaveBeenCalled();
});

it("执行过程：会议原话置顶、不显示推进人的判断；点有链接的那一行展开全文、来源和证据链接，再点收起", () => {
  const entry = { id: "00000000-0000-4000-8000-000000000002", taskId: "task-1", author: { personId: "lin", name: "林晓" }, source: "claude", body: "完成测试\n\n两家都跑通了", links: [{ url: "https://example.com/pr", title: "证据" }], createdAt: "2026-10-05T06:20:00Z" };
  const detail = detailOf({ task: { ...task, source: "meeting", origin: { type: "meeting", meetingId: "m-1", meetingTitle: "周会", quote: "下周三前给我" } }, progress: [entry] });
  const cover = coverOf(render(() => TaskScreen({ initialDetail: detail })));
  const process = find((cover.type as (props: unknown) => unknown)(cover.props), (node) => typeof node.type === "function" && (node.type as { name: string }).name === "Process")!;
  const section = render(() => (process.type as (props: unknown) => unknown)(process.props), []);
  const text = JSON.stringify(section);
  expect(text).not.toContain("原判断");
  expect(text.indexOf("下周三前给我")).toBeGreaterThan(-1);
  expect(text.indexOf("下周三前给我")).toBeLessThan(text.indexOf('"type":"ol"'));
  const row = find(section, (node) => typeof node.type === "function" && (node.type as { name: string }).name === "ProgressRow")!;
  const store: unknown[] = [];
  let tree = render(() => (row.type as (props: unknown) => unknown)(row.props), store);
  const toggle = () => find(tree, (node) => node.props?.["aria-controls"] === `progress-${entry.id}`)!;
  expect(toggle().props!["aria-expanded"]).toBe(false);
  expect(JSON.stringify(tree)).not.toContain("https://example.com/pr");
  (toggle().props!.onClick as () => void)();
  tree = render(() => (row.type as (props: unknown) => unknown)(row.props), store);
  expect(toggle().props!["aria-expanded"]).toBe(true);
  const opened = JSON.stringify(tree);
  expect(opened).toContain("两家都跑通了"); expect(opened).toContain("Claude Code"); expect(opened).toContain("https://example.com/pr"); expect(opened).toContain("noopener noreferrer");
  (toggle().props!.onClick as () => void)();
  tree = render(() => (row.type as (props: unknown) => unknown)(row.props), store);
  expect(JSON.stringify(tree)).not.toContain("https://example.com/pr");
});
