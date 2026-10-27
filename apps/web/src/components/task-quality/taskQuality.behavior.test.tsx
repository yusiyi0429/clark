import { beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, mounted: false,
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[index]) : next; }];
  },
}));
vi.mock("react", async original => ({ ...(await original<typeof import("react")>()), useState: hooks.useState, useRef: (initial: unknown) => hooks.useState({ current: initial })[0],
  useEffect: (effect: () => void) => { if (!hooks.mounted) { hooks.mounted = true; effect(); } } }));
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: api.get, POST: api.post } }));
import { TaskQualityWorkbench } from "./TaskQualityWorkbench";

type Node = { type?: unknown; props?: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return node.props ? [node, ...nodes(node.props.children)] : [];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  return value && typeof value === "object" ? text((value as Node).props?.children) : "";
}
const click = (tree: unknown, label: string) => {
  const node = nodes(tree).find(item => item.type === "button" && text(item) === label);
  expect(node, label).toBeDefined(); (node!.props!.onClick as () => void)();
};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const TASK = "10000000-0000-4000-8000-000000000001", ID = "10000000-0000-4000-8000-000000000002";
const ok = (data: unknown) => ({ data, response: { ok: true, status: 200 } });
const report = { taskId: TASK, title: "接口 Task", checkedAt: "2026-10-27T01:00:00Z", report: { quality: {
  policy: { max_age_hours: null }, meaning: "待核对项不等于完成", findings: [],
  fields: [{ key: "new:definition/outcome", label: "工作结果", kind: "text", value: null }],
} } };
const proposal = { id: ID, taskId: null, taskTitle: null, fieldKey: null, fieldLabel: null, state: "needs_input", classification: "decision",
  before: null, after: "可读的接口回执", message: "任务未定位", source: { kind: "meeting", meetingId: "meeting-1", meetingRevision: 1,
    quote: "要有可读的接口回执。", title: "合成会议", occurredAt: "2026-10-20T08:00:00Z" }, sourceReceiptId: null, receiptId: null, writebackStatus: null,
  updatedAt: "2026-10-27T01:00:00Z" };
beforeEach(() => { hooks.values = []; hooks.index = 0; hooks.mounted = false; api.get.mockReset(); api.post.mockReset(); });

it("未定位候选选择任务后仍修订原候选，不会变成另一条未关联的新建", async () => {
  api.get.mockImplementation(async path => path.endsWith("/catalog") ? ok({ items: [{ taskId: TASK, title: "接口 Task", status: "in_progress" }], nextCursor: null })
    : path.endsWith("/proposals") ? ok({ proposals: [proposal] }) : ok({ reviews: [] }));
  api.post.mockImplementation(async path => path.endsWith("/check") ? ok(report) : ok({ ...proposal, taskId: TASK, state: "needs_source" }));
  const render = () => { hooks.index = 0; return TaskQualityWorkbench({ viewerRole: "ceo", meetingId: "meeting-1" }); };
  render(); await flush();
  click(render(), "补充定位或待决信息");
  const select = nodes(render()).find(item => item.type === "select" && text(item).includes("接口 Task"))!;
  (select.props!.onChange as (event: unknown) => void)({ target: { value: TASK } });
  click(render(), "现在核对"); await flush();
  const form = nodes(render()).find(item => item.type === "form")!;
  expect(text(form)).toContain("补充这项草稿");
  (form.props!.onSubmit as (event: unknown) => void)({ preventDefault() {} }); await flush();
  expect(api.post).toHaveBeenCalledWith("/api/task-quality/proposals/{proposalId}/revise", expect.objectContaining({
    params: { path: { proposalId: ID } }, body: { taskId: TASK, input: expect.objectContaining({ fieldKey: "new:definition/outcome", quote: proposal.source.quote }) },
  }));
  expect(api.post.mock.calls.some(([path]) => path.endsWith("/proposals"))).toBe(false);
  expect(text(render())).toContain("已保存本人补齐草稿，尚未写入 world");
});

it("交给个人 Agent 前读取最新条件，复制指令不会发送字段写入请求", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const ready = { ...proposal, taskId: TASK, state: "needs_source" };
  api.get.mockImplementation(async path => path.endsWith("/catalog") ? ok({ items: [], nextCursor: null })
    : path.endsWith("/proposals") ? ok({ proposals: [ready] }) : path.endsWith("/handoff") ? ok({ proposal: ready, stage: "source", instruction: "核对来源", request: { action_type: "world_record_event" } }) : ok({ reviews: [] }));
  const render = () => { hooks.index = 0; return TaskQualityWorkbench({ viewerRole: "member" }); };
  render(); await flush(); click(render(), "复制给个人 Agent"); await flush();
  expect(api.get).toHaveBeenCalledWith("/api/task-quality/proposals/{proposalId}/handoff", { params: { path: { proposalId: ID } } });
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`proposalId=${ID}、viewerRole=member`));
  expect(api.post).not.toHaveBeenCalled();
  expect(text(render())).toContain("尚未执行 world 操作");
  vi.unstubAllGlobals();
});

it("补充已知时间的草稿时保留精确时间，响应丢失后的重试沿用同一请求键", async () => {
  const original = { ...proposal, taskId: TASK, fieldKey: "new:definition/outcome", state: "pending_decision", classification: "suggestion",
    source: { ...proposal.source, kind: "statement", meetingId: null, meetingRevision: null, occurredAt: "2026-10-20T08:12:34.567Z" } };
  api.get.mockImplementation(async path => path.endsWith("/catalog") ? ok({ items: [{ taskId: TASK, title: "接口 Task", status: "in_progress" }], nextCursor: null })
    : path.endsWith("/proposals") ? ok({ proposals: [original] }) : ok({ reviews: [report] }));
  api.post.mockRejectedValueOnce(new Error("响应未收到，请重试")).mockResolvedValue(ok({ ...original, state: "needs_source" }));
  const render = () => { hooks.index = 0; return TaskQualityWorkbench({ viewerRole: "ceo" }); };
  render(); await flush(); click(render(), "补充定位或待决信息");
  const classification = nodes(render()).find(item => item.type === "select" && text(item).includes("已作决定"))!;
  (classification.props!.onChange as (event: unknown) => void)({ target: { value: "decision" } });
  const submit = () => (nodes(render()).find(item => item.type === "form")!.props!.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  submit(); await flush(); submit(); await flush();
  const [first, second] = api.post.mock.calls.map(([, options]) => options.body.input);
  expect(first.clientRequestId).toBe(second.clientRequestId);
  expect(second.occurredAt).toBe("2026-10-20T08:12:34.567Z");
  expect(second.classification).toBe("decision");
});
