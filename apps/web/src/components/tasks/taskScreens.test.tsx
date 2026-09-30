import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { components } from "@/lib/api/schema";
import { MemberTasks, tasksByDue } from "@/components/member/MemberTasks";
import { memberNoticeGroups } from "@/components/member/memberNotices";

const state = vi.hoisted(() => ({ ask: vi.fn(), delete: vi.fn(), register: vi.fn(), press: new Map<string, () => void>(), cardClick: new Map<string, (event: unknown) => void>() }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ close: vi.fn(), navigate: vi.fn(), viewerId: "sun" }), useRegisterDetail: state.register }));
vi.mock("@/components/shell/DetailFrame", () => ({ DetailFrame: ({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) => <main><h1>{title}</h1>{actions}{children}</main> }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => ({ ask: state.ask, dialog: null }) }));
vi.mock("@/lib/api/client", () => ({ browserApi: { DELETE: state.delete } }));
vi.mock("ts-design/primitives", () => ({ Button: ({ children, onPress, ...props }: { children?: ReactNode; onPress?: () => void; [key: string]: unknown }) => {
  const label = typeof children === "string" ? children : Array.isArray(children) ? children.filter((item): item is string => typeof item === "string").join("") : "";
  if (onPress) state.press.set(label, onPress);
  const { isDisabled: _disabled, ...rest } = props;
  return <button {...rest} disabled={!!_disabled}>{children}</button>;
}, Input: ({ ...props }: Record<string, unknown>) => <input {...props} />, Label: ({ children }: { children?: ReactNode }) => <label>{children}</label>, TextField: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Select: Object.assign(({ children }: { children?: ReactNode }) => <div>{children}</div>, { Trigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>, Value: () => null, Indicator: () => null, Popover: ({ children }: { children?: ReactNode }) => <div>{children}</div> }),
  ListBox: Object.assign(({ children }: { children?: ReactNode }) => <div>{children}</div>, { Item: ({ children }: { children?: ReactNode }) => <div>{children}</div>, ItemIndicator: () => null }),
  ToggleButtonGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>, ToggleButton: ({ children }: { children?: ReactNode }) => <button>{children}</button> }));
vi.mock("ts-design", () => ({ FormField: ({ label }: { label: string }) => <label>{label}<input /></label>, StatusBadge: ({ children }: { children?: ReactNode }) => <span>{children}</span>, ActionButton: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => <button onClick={onPress}>{children}</button>, TianshuPortalTheme: ({ children }: { children?: ReactNode }) => <>{children}</> }));
vi.mock("@heroui/react", () => {
  const wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Modal = Object.assign(({ isOpen, children }: { isOpen: boolean; children?: ReactNode }) => isOpen ? <div>{children}</div> : null, { Backdrop: wrap, Container: wrap, Dialog: wrap, CloseTrigger: () => null, Header: wrap, Heading: wrap, Body: wrap, Footer: wrap });
  return { Card: ({ children, onClick, ...props }: { children?: ReactNode; onClick?: (event: unknown) => void; "data-task"?: string }) => { if (onClick && props["data-task"]) state.cardClick.set(props["data-task"], onClick); return <article {...props}>{children}</article>; }, Modal };
});

import { CreateTaskScreen } from "./CreateTaskScreen";
import { TaskScreen } from "./TaskScreen";
import { CollaboratorsDialog } from "./CollaboratorsDialog";

type Task = components["schemas"]["TaskView"];
type Detail = components["schemas"]["TaskDetailResponse"];
const task = (id = "task-1", extra: Partial<Task> = {}): Task => ({
  id, version: 2, title: `事项 ${id}`, status: "not_started", source: "self", startDate: "2026-10-01", dueDate: "2026-10-12", doneDefinition: "留下结论", mission: { missionId: "mission-1", title: "上线验证", cardId: "card-1", period: "2026-10", battlefieldName: "灯塔客户", step: 2, steps: 4 }, waitingOn: { taskId: "task-0", title: "确认范围" }, owner: { personId: "sun", name: "孙铭泽" }, collaborators: [{ personId: "lin", name: "林晓" }], latestProgress: null, returnReason: null, origin: null, createdAt: "2026-09-27T00:00:00Z", updatedAt: "2026-09-27T00:00:00Z", ...extra,
});
const detail = (role: Detail["role"]): Detail => ({ task: task(), judgment: "先验证两家", judgmentAt: "2026-10-03T02:05:00.000Z", myNote: role === "owner" ? null : "我看到依赖风险", myNoteAt: role === "owner" ? null : "2026-10-04T06:30:00.000Z", role, missionOptions: role === "owner" ? [{ missionId: "mission-2", title: "客户试点", battlefieldName: "灯塔客户", period: "2026-10" }] : [], collaboratorOptions: role === "owner" ? [{ personId: "bai", name: "白田田" }] : [], progress: [] });

beforeEach(() => { vi.clearAllMocks(); state.press.clear(); state.cardClick.clear(); vi.stubGlobal("window", { dispatchEvent: vi.fn() }); });

describe("成员首页执行事项", () => {
  it("最新进展仅在有记录时显示，并给悬停与读屏提供正文", () => {
    const html = renderToStaticMarkup(<MemberTasks tasks={[task("new", { latestProgress: { body: "完成接口核对", source: "codex", author: { personId: "sun", name: "孙铭泽" }, createdAt: "2026-10-05T06:20:00Z" } })]} onStatus={vi.fn()} />);
    expect(html).toContain("最新进展 · Codex");
    expect(html).toContain('title="完成接口核对"');
    expect(html).toContain('aria-label="最新进展：完成接口核对"');
  });
  it("按截止排并保留同截止顺序；卡上有归属、步骤、等待、日期、协作者和新建入口", () => {
    const items = [task("a", { dueDate: null }), task("b", { dueDate: "2026-10-12" }), task("c", { dueDate: "2026-10-02" })];
    expect(tasksByDue(items).map((item) => item.id)).toEqual(["c", "b", "a"]);
    const html = renderToStaticMarkup(<MemberTasks tasks={items} onStatus={vi.fn()} />);
    expect(html).toContain("开启执行事项"); expect(html).toContain("上线验证"); expect(html).toContain("第 2 步，共 4 步");
    expect(html).toContain("等上一步：确认范围"); expect(html).toContain("协作 · 林晓"); expect(html).toContain("计划开始 2026-10-01");
    expect(html).toContain("未启动"); expect(html).toContain("进行中"); expect(html).toContain("完成");
  });
  it("完成的事项不占卡片，收进默认折叠的「已完成 N」", () => {
    const html = renderToStaticMarkup(<MemberTasks tasks={[task("open", { title: "还在推进" }), task("finished", { title: "已经收尾", status: "done" })]} onStatus={vi.fn()} />);
    expect(html).toContain("还在推进");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/已完成(<!-- -->)? ?1/);
    expect(html).not.toContain("已经收尾");
  });
  it("点击卡片空白处打开详情，状态按钮不触发卡片导航", () => {
    const navigate = vi.fn();
    renderToStaticMarkup(<MemberTasks tasks={[task()]} onStatus={vi.fn()} onNavigate={navigate} />);
    const card = {} as HTMLElement;
    state.cardClick.get("task-1")?.({ target: { closest: () => null }, currentTarget: card });
    expect(navigate).toHaveBeenCalledWith("/me/tasks/task-1", card);
    state.cardClick.get("task-1")?.({ target: { closest: () => ({ tagName: "BUTTON" }) }, currentTarget: card });
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

describe("执行事项新建与详情", () => {
  it("详情列出进展来源、正文和链接，并允许成员写一条", () => {
    const entry = { id: "00000000-0000-4000-8000-000000000001", taskId: "task-1", author: { personId: "lin", name: "林晓" }, source: "claude" as const, body: "完成测试", links: [{ url: "https://example.com/pr", title: "证据" }], createdAt: "2026-10-05T06:20:00Z" };
    const html = renderToStaticMarkup(<TaskScreen initialDetail={{ ...detail("collaborator"), progress: [entry] }} />);
    expect(html).toContain("Claude Code"); expect(html).toContain("完成测试"); expect(html).toContain("https://example.com/pr"); expect(html).toContain("写一条进展");
  });
  it("新建页一步一问：先问做什么，步骤点列出后面的 Mission 与时间两步", () => {
    const html = renderToStaticMarkup(<CreateTaskScreen />);
    expect(html).toContain("这件事是什么？"); expect(html).toContain("执行事项标题");
    expect(html).toContain("推进哪个 Mission"); expect(html).toContain("时间与完成标准"); expect(html).toContain("下一步");
    expect(html).not.toContain("不挂个人任务"); expect(html).not.toContain("开启执行事项</button>");
  });
  it("推进人可编辑、邀请、报进度、删除未启动的自建事项", () => {
    const html = renderToStaticMarkup(<TaskScreen initialDetail={detail("owner")} />);
    expect(html).toContain("编辑"); expect(html).toContain("邀请协作"); expect(html).toContain("报进度"); expect(html).toContain("删除执行事项"); expect(html).toContain("写下这件事的判断"); expect(html).toContain("先验证两家"); expect(html).toContain("你写于 10/3 10:05");
    expect(html).not.toContain("事项群组");
    expect(html).not.toContain(">退回<");
    expect(state.register).toHaveBeenCalledWith(expect.objectContaining({ scope: "task:task-1", group: expect.objectContaining({ kind: "task", taskId: "task-1", members: [{ personId: "sun", displayName: "孙铭泽" }, { personId: "lin", displayName: "林晓" }] }) }));
  });
  it("协作者看到推进人判断，只能写私人批注，不能编辑或删除", () => {
    const html = renderToStaticMarkup(<TaskScreen initialDetail={detail("collaborator")} />);
    expect(html).toContain("我的批注"); expect(html).toContain("只属于你"); expect(html).toContain("先验证两家"); expect(html).toContain("由孙铭泽推进"); expect(html).toContain("孙铭泽写于 10/3 10:05"); expect(html).toContain("上次写于 10/4 14:30");
    expect(html).not.toContain("邀请协作"); expect(html).not.toContain("删除执行事项"); expect(html).not.toContain(">编辑<");
  });
  it("会后分派的推进人有退回入口，协作者没有", () => {
    const meeting = task("meeting", { source: "meeting", origin: { type: "meeting", meetingId: "m-1", meetingTitle: "周会", quote: "核对试点" } });
    const owner = renderToStaticMarkup(<TaskScreen initialDetail={{ ...detail("owner"), task: meeting }} />);
    const collaborator = renderToStaticMarkup(<TaskScreen initialDetail={{ ...detail("collaborator"), task: meeting }} />);
    expect(owner).toContain(">退回<"); expect(owner).toContain("会议来源"); expect(owner).toContain("核对试点");
    expect(collaborator).not.toContain(">退回<");
  });
  it("邀请弹层只展示详情提供的可邀请同事，并说明加入群聊", () => {
    const html = renderToStaticMarkup(<CollaboratorsDialog taskId="task-1" options={detail("owner").collaboratorOptions} isOpen onClose={vi.fn()} onAdded={vi.fn()} />);
    expect(html).toContain("白田田"); expect(html).toContain("协作成员可查看任务资料"); expect(html).toContain("加入协作与群聊");
    expect(html).not.toContain("孙铭泽");
  });
  it("删除先确认，取消时不发 DELETE；确认后带 version 删除", async () => {
    renderToStaticMarkup(<TaskScreen initialDetail={detail("owner")} />);
    state.ask.mockResolvedValueOnce(false);
    await state.press.get("删除执行事项")?.();
    expect(state.delete).not.toHaveBeenCalled();
    state.ask.mockResolvedValueOnce(true);
    state.delete.mockResolvedValue({ response: { status: 204 } });
    await state.press.get("删除执行事项")?.();
    await vi.waitFor(() => expect(state.delete).toHaveBeenCalledWith("/api/me/tasks/{id}", { params: { path: { id: "task-1" }, query: { version: 2 } } }));
  });
});

it("协作邀请放在新的执行事项组，点标题进详情，没有退回动作", () => {
  const openTask = vi.fn();
  const groups = memberNoticeGroups([{ id: "n1", kind: "task_collaborator_added", text: "孙铭泽 邀请你协作「上线验证」", objectType: "task", objectId: "task-1", createdAt: "2026-09-27T00:00:00Z", readAt: null }], { markSeen: async () => ({ ok: true }), returnTask: async () => ({ ok: true }), openTask });
  expect(groups.assigned).toHaveLength(1); expect(groups.results).toHaveLength(0);
  expect(groups.assigned[0].title).toContain("邀请你协作"); expect(groups.assigned[0].reason).toBeUndefined();
  groups.assigned[0].onOpen?.(null);
  expect(openTask).toHaveBeenCalledWith("task-1", null);
});
