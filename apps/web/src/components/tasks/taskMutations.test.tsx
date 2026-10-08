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
beforeEach(() => { main = []; hooks.values = main; hooks.index = 0; hooks.effects = []; vi.clearAllMocks(); vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" }); vi.stubGlobal("window", { dispatchEvent: vi.fn() }); });

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
  (find(fields, (node) => node.props?.label === "这件事的判断 · 可选")!.props!.onChange as (value: string) => void)("更新判断");
  fields = render(() => TaskEditForm({ ...(editor.props as Parameters<typeof TaskEditForm>[0]), onSave }), form);
  (find(fields, (node) => node.props?.children === "保存")!.props!.onPress as () => void)();
  expect(onSave).toHaveBeenCalledWith({ judgment: "更新判断" });
  actions.patch.mockResolvedValue({ data: { ...task, version: 3 } }); actions.get.mockResolvedValue({ data: detail });
  (editor.props!.onSave as (body: unknown) => void)({ judgment: "更新判断" });
  await vi.waitFor(() => expect(actions.patch).toHaveBeenCalledWith("/api/me/tasks/{id}", { params: { path: { id: "task-1" } }, body: { version: 2, judgment: "更新判断" } }));
  expect(actions.put).not.toHaveBeenCalled();
});

it("编辑表单只交人改过的字段：别处同时改了截止日期，保存判断时不把旧的截止日期盖回去", () => {
  const onSave = vi.fn();
  const form: unknown[] = [];
  const opened = detailOf({ task: { ...task, dueDate: "2026-10-12" } }) as Parameters<typeof TaskEditForm>[0]["detail"];
  let fields = render(() => TaskEditForm({ detail: opened, busy: false, onSave, onCancel: vi.fn() }), form);
  (find(fields, (node) => node.props?.label === "这件事的判断 · 可选")!.props!.onChange as (value: string) => void)("更新判断");
  // 页面在表单开着时重读了一次：截止日期被别处改成了 10/20。
  const latest = detailOf({ task: { ...task, version: 3, dueDate: "2026-10-20" } }) as Parameters<typeof TaskEditForm>[0]["detail"];
  fields = render(() => TaskEditForm({ detail: latest, busy: false, onSave, onCancel: vi.fn() }), form);
  (find(fields, (node) => node.props?.children === "保存")!.props!.onPress as () => void)();
  expect(onSave).toHaveBeenCalledWith({ judgment: "更新判断" });
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
const standardBoxes = (tree: unknown) => findAll(tree, (node) => node.props?.className === a.checkbox);
const deliverableBoxes = (tree: unknown) => findAll(tree, (node) => node.props?.className === a.deliverable);
const button = (tree: unknown, label: string) => find(tree, (node) => Array.isArray(node.props?.children) ? (node.props!.children as unknown[]).includes(label) : node.props?.children === label);

it("外部工具带了草稿：一打开就预填（不再请 Agent 起草）；人改过之后点「验收完成」，提交勾选、依据、结论和现有的交付结果", async () => {
  const props = { detail: detailOf({ submission, task: { ...task, awaitingAcceptance: true } }), materials: [material(DOC, "结论.md"), material(LINK, "依据.md")], onClose: vi.fn(), onDone: vi.fn(async () => undefined), onStale: vi.fn(), onOpenMaterial: vi.fn() };
  let tree = render(() => AcceptDialog(props));
  hooks.effects.forEach((effect) => effect());
  expect(actions.post).not.toHaveBeenCalled();
  expect(standardBoxes(tree).map((node) => node.props!.isSelected)).toEqual([true, true]);
  expect(deliverableBoxes(tree).map((node) => node.props!.isSelected)).toEqual([true, false]);
  expect(find(tree, (node) => node.props?.value === "两家都确认了")).toBeDefined();
  expect(button(tree, "还要继续做")).toBeDefined();
  // 第二条其实没达到，再把「依据.md」也算进交付结果。
  (standardBoxes(tree)[1].props!.onChange as (selected: boolean) => void)(false);
  (deliverableBoxes(tree)[1].props!.onChange as (selected: boolean) => void)(true);
  tree = render(() => AcceptDialog(props));
  actions.post.mockResolvedValue({ data: { ...task, status: "done", version: 3 } });
  (button(tree, "验收完成")!.props!.onPress as () => void)();
  await vi.waitFor(() => expect(props.onDone).toHaveBeenCalledWith({ ...task, status: "done", version: 3 }, true));
  expect(actions.post).toHaveBeenCalledWith("/api/me/tasks/{id}/accept", { params: { path: { id: "task-1" } }, body: {
    version: 2, verdict: "两家都确认了", deliverableMaterialIds: [DOC, LINK],
    standards: [{ index: 0, met: true, evidence: "进展里写了两家的回复", materialId: null }, { index: 1, met: false, evidence: null, materialId: DOC }],
  } });
});

it("没有提交时请我的 Agent 起草；没起草出来也能手填验收，没勾全照样提交、如实记录；没有「还要继续做」", async () => {
  const props = { detail: detailOf(), materials: [material(DOC, "结论.md")], onClose: vi.fn(), onDone: vi.fn(async () => undefined), onStale: vi.fn(), onOpenMaterial: vi.fn() };
  const store: unknown[] = [];
  let tree = render(() => AcceptDialog(props), store);
  expect(find(tree, (node) => node.props?.role === "status")).toBeDefined();
  expect(button(tree, "还要继续做")).toBeUndefined();
  actions.post.mockResolvedValueOnce({ response: { status: 503 }, error: { code: "ACCEPTANCE_DRAFT_UNAVAILABLE" } });
  hooks.effects.forEach((effect) => effect());
  expect(actions.post).toHaveBeenCalledWith("/api/me/tasks/{id}/acceptance-draft", expect.objectContaining({ params: { path: { id: "task-1" } } }));
  await vi.waitFor(() => { tree = render(() => AcceptDialog(props), store); expect(find(tree, (node) => node.props?.role === "status")).toBeUndefined(); });
  expect(standardBoxes(tree).map((node) => node.props!.isSelected)).toEqual([false, false]);
  (standardBoxes(tree)[0].props!.onChange as (selected: boolean) => void)(true);
  tree = render(() => AcceptDialog(props), store);
  actions.post.mockResolvedValue({ data: { ...task, status: "done", version: 3 } });
  (button(tree, "验收完成")!.props!.onPress as () => void)();
  await vi.waitFor(() => expect(props.onDone).toHaveBeenCalled());
  expect(actions.post).toHaveBeenLastCalledWith("/api/me/tasks/{id}/accept", { params: { path: { id: "task-1" } }, body: { version: 2, verdict: null, deliverableMaterialIds: [], standards: [{ index: 0, met: true, evidence: null, materialId: null }] } });
});

it("人先动了手，Agent 的草稿晚到也不覆盖", async () => {
  const props = { detail: detailOf(), materials: [], onClose: vi.fn(), onDone: vi.fn(async () => undefined), onStale: vi.fn(), onOpenMaterial: vi.fn() };
  const store: unknown[] = [];
  let tree = render(() => AcceptDialog(props), store);
  let resolve: (value: unknown) => void = () => undefined;
  actions.post.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  hooks.effects.forEach((effect) => effect());
  (standardBoxes(tree)[1].props!.onChange as (selected: boolean) => void)(true);
  resolve({ data: { verdict: "Agent 的结论", standards: [{ index: 0, met: true, evidence: null, materialId: null }], deliverableMaterialIds: [] } });
  await vi.waitFor(() => { tree = render(() => AcceptDialog(props), store); expect(find(tree, (node) => node.props?.role === "status")).toBeUndefined(); });
  expect(standardBoxes(tree).map((node) => node.props!.isSelected)).toEqual([false, true]);
  expect(find(tree, (node) => node.props?.value === "Agent 的结论")).toBeUndefined();
});

it("「还要继续做」清掉这次提交（DELETE 带版本）；关弹窗不清任何东西", async () => {
  const props = { detail: detailOf({ submission, task: { ...task, awaitingAcceptance: true } }), materials: [material(DOC, "结论.md")], onClose: vi.fn(), onDone: vi.fn(async () => undefined), onStale: vi.fn(), onOpenMaterial: vi.fn() };
  const tree = render(() => AcceptDialog(props));
  ((tree as Node).props!.onClose as () => void)();
  expect(props.onClose).toHaveBeenCalled(); expect(actions.delete).not.toHaveBeenCalled();
  actions.delete.mockResolvedValue({ data: { ...task, version: 3 } });
  (button(tree, "还要继续做")!.props!.onPress as () => void)();
  await vi.waitFor(() => expect(props.onDone).toHaveBeenCalledWith({ ...task, version: 3 }, false));
  expect(actions.delete).toHaveBeenCalledWith("/api/me/tasks/{id}/submission", { params: { path: { id: "task-1" }, query: { version: 2 } } });
});

it("执行过程展开后：会议原话和推进人的判断置顶，进展写明来源和证据链接", () => {
  const entry = { id: "00000000-0000-4000-8000-000000000002", taskId: "task-1", author: { personId: "lin", name: "林晓" }, source: "claude", body: "完成测试", links: [{ url: "https://example.com/pr", title: "证据" }], createdAt: "2026-10-05T06:20:00Z" };
  const detail = detailOf({ task: { ...task, source: "meeting", origin: { type: "meeting", meetingId: "m-1", meetingTitle: "周会", quote: "下周三前给我" } }, progress: [entry] });
  const cover = coverOf(render(() => TaskScreen({ initialDetail: detail })));
  const process = find((cover.type as (props: unknown) => unknown)(cover.props), (node) => typeof node.type === "function" && (node.type as { name: string }).name === "Process")!;
  const store: unknown[] = [];
  let tree = render(() => (process.type as (props: unknown) => unknown)(process.props), store);
  const toggle = find(tree, (node) => node.props?.["aria-controls"] === "task-process")!;
  expect(toggle.props!["aria-expanded"]).toBe(false);
  (toggle.props!.onClick as () => void)();
  tree = render(() => (process.type as (props: unknown) => unknown)(process.props), store);
  const section = find(tree, (node) => node.props?.id === "task-process")!;
  const text = JSON.stringify(section.props!.children);
  expect(text.indexOf("下周三前给我")).toBeLessThan(text.indexOf("原判断"));
  expect(text.indexOf("原判断")).toBeLessThan(text.indexOf("完成测试"));
  expect(text).toContain("Claude Code"); expect(text).toContain("https://example.com/pr"); expect(text).toContain("noopener noreferrer");
});
