import { beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
const actions = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn(), put: vi.fn(), get: vi.fn(), navigate: vi.fn(), ask: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => { const i = hooks.index++; if (!(i in hooks.values)) hooks.values[i] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [hooks.values[i], (next: unknown) => { hooks.values[i] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[i]) : next; }]; },
    useRef: (initial: unknown) => { const i = hooks.index++; if (!(i in hooks.values)) hooks.values[i] = { current: initial }; return hooks.values[i]; },
    useMemo: (factory: () => unknown) => factory(),
    useEffect: () => undefined,
  };
});
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ close: vi.fn(), navigate: actions.navigate }), useRegisterDetail: vi.fn() }));
vi.mock("@/components/shell/DetailFrame", () => ({ DetailFrame: () => null }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => ({ ask: actions.ask, dialog: null }) }));
vi.mock("@/lib/api/client", () => ({ browserApi: { POST: actions.post, PATCH: actions.patch, PUT: actions.put, GET: actions.get } }));
vi.mock("ts-design", () => ({ FormField: () => null, StatusBadge: () => null, ActionButton: () => null, TianshuPortalTheme: ({ children }: { children?: unknown }) => children }));
vi.mock("ts-design/primitives", () => ({ Button: () => null, Input: () => null, Label: () => null, TextField: () => null,
  Select: Object.assign(() => null, { Trigger: () => null, Value: () => null, Indicator: () => null, Popover: () => null }),
  ListBox: Object.assign(() => null, { Item: () => null, ItemIndicator: () => null }),
  ToggleButton: () => null, ToggleButtonGroup: () => null,
}));
vi.mock("@heroui/react", () => { const Modal = Object.assign(() => null, { Backdrop: () => null, Container: () => null, Dialog: () => null, CloseTrigger: () => null, Header: () => null, Heading: () => null, Body: () => null, Footer: () => null }); return { Modal }; });

import { CreateTaskScreen } from "./CreateTaskScreen";
import { CollaboratorsDialog } from "./CollaboratorsDialog";
import { TaskScreen } from "./TaskScreen";

type Node = { type?: unknown; props?: Record<string, unknown> };
function find(node: unknown, match: (node: Node) => boolean): Node | undefined {
  if (Array.isArray(node)) return node.map((entry) => find(entry, match)).find(Boolean);
  if (!node || typeof node !== "object") return undefined;
  const element = node as Node;
  return match(element) ? element : find(element.props?.children, match);
}
const render = (component: () => unknown) => { hooks.index = 0; return component(); };
beforeEach(() => { hooks.values = []; hooks.index = 0; vi.clearAllMocks(); vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" }); vi.stubGlobal("window", { dispatchEvent: vi.fn() }); });

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
  submit(); // 第二步 → 第三步：日期与完成定义
  tree = render(() => CreateTaskScreen());
  expect(find(tree, (node) => node.type === "input" && node.props?.type === "date")).toBeDefined();
  expect(find(tree, (node) => node.type === "textarea")).toBeDefined();
  expect(actions.post).not.toHaveBeenCalled();
  actions.post.mockResolvedValueOnce({ error: { message: "暂时失败" } }).mockResolvedValueOnce({ data: { id: "task-new" } });
  submit();
  await vi.waitFor(() => expect(actions.post).toHaveBeenCalledTimes(1));
  submit();
  await vi.waitFor(() => expect(actions.navigate).toHaveBeenCalledWith("/me/tasks/task-new"));
  expect(actions.post.mock.calls[0][1].body).toEqual({ clientId: "00000000-0000-4000-8000-000000000001", title: "联系两家客户", missionId: null });
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

const task = { id: "task-1", version: 2, title: "核对试点", source: "self", status: "in_progress", startDate: null, dueDate: null, doneDefinition: null, mission: null, waitingOn: null, owner: { personId: "sun", name: "孙铭泽" }, collaborators: [{ personId: "lin", name: "林晓" }], latestProgress: null, returnReason: null, origin: null, createdAt: "2026-09-27T00:00:00Z", updatedAt: "2026-09-27T00:00:00Z" } as const;

it("推进人直接在判断块保存，PATCH 只写判断", async () => {
  const detail = { task, judgment: "原判断", myNote: null, role: "owner", missionOptions: [], collaboratorOptions: [], progress: [] } as never;
  let tree = render(() => TaskScreen({ initialDetail: detail }));
  (find(tree, (node) => node.props?.label === "写下这件事的判断")!.props!.onChange as (value: string) => void)("更新判断");
  tree = render(() => TaskScreen({ initialDetail: detail }));
  actions.patch.mockResolvedValue({ data: { ...task, version: 3 } }); actions.get.mockResolvedValue({ data: detail });
  (find(tree, (node) => node.props?.children === "保存")!.props!.onPress as () => void)();
  await vi.waitFor(() => expect(actions.patch).toHaveBeenCalledWith("/api/me/tasks/{id}", { params: { path: { id: "task-1" } }, body: { version: 2, judgment: "更新判断" } }));
  expect(actions.put).not.toHaveBeenCalled();
});

it("协作者直接在批注块保存，PUT 不覆盖推进人判断", async () => {
  const detail = { task, judgment: "推进人判断", myNote: "旧批注", role: "collaborator", missionOptions: [], collaboratorOptions: [], progress: [] } as never;
  let tree = render(() => TaskScreen({ initialDetail: detail }));
  (find(tree, (node) => node.props?.label === "我的批注（只属于你，不覆盖这件事的判断）")!.props!.onChange as (value: string) => void)("我的新批注");
  tree = render(() => TaskScreen({ initialDetail: detail }));
  actions.put.mockResolvedValue({ data: { myNote: "我的新批注" } });
  (find(tree, (node) => node.props?.children === "保存")!.props!.onPress as () => void)();
  await vi.waitFor(() => expect(actions.put).toHaveBeenCalledWith("/api/me/tasks/{id}/note", { params: { path: { id: "task-1" } }, body: { note: "我的新批注" } }));
  expect(actions.patch).not.toHaveBeenCalled();
});

it("会后事项退回先填写原因并确认，再调用原退回接口", async () => {
  const detail = { task: { ...task, source: "meeting" }, judgment: null, myNote: null, role: "owner", missionOptions: [], collaboratorOptions: [], progress: [] } as never;
  let tree = render(() => TaskScreen({ initialDetail: detail }));
  (find(tree, (node) => node.props?.children === "退回")!.props!.onPress as () => void)();
  tree = render(() => TaskScreen({ initialDetail: detail }));
  (find(tree, (node) => node.props?.label === "退回原因")!.props!.onChange as (value: string) => void)("会议安排与当前职责冲突");
  tree = render(() => TaskScreen({ initialDetail: detail }));
  actions.ask.mockResolvedValue(true); actions.post.mockResolvedValue({ data: { ...task, status: "returned" } }); actions.get.mockResolvedValue({ data: detail });
  (find(tree, (node) => node.props?.children === "确认退回")!.props!.onPress as () => void)();
  await vi.waitFor(() => expect(actions.ask).toHaveBeenCalled());
  await vi.waitFor(() => expect(actions.post).toHaveBeenCalledWith("/api/me/tasks/{id}/return", { params: { path: { id: "task-1" } }, body: { version: 2, reason: "会议安排与当前职责冲突" } }));
});
