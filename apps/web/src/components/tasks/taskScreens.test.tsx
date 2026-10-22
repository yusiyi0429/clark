import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { components } from "@/lib/api/schema";
import type { TMaterialView } from "@warmap/contracts";
import { MemberTasks, lastExternalSync, tasksByDue } from "@/components/member/MemberTasks";
import { memberNoticeGroups } from "@/components/member/memberNotices";

const state = vi.hoisted(() => ({ ask: vi.fn(), delete: vi.fn(), register: vi.fn(), press: new Map<string, () => void>(), cardClick: new Map<string, (event: unknown) => void>(), area: {} as Record<string, unknown> }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ close: vi.fn(), navigate: vi.fn(), compose: vi.fn(), viewerId: "sun" }), useRegisterDetail: state.register }));
vi.mock("next/navigation", () => ({ useSearchParams: () => null }));
vi.mock("@/components/shell/DetailFrame", () => ({ DetailFrame: ({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) => <main><h1>{title}</h1><header>{actions}</header>{children}</main> }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => ({ ask: state.ask, dialog: null }) }));
vi.mock("@/lib/api/client", () => ({ browserApi: { DELETE: state.delete } }));
// 材料区换成一份固定的材料清单：封面只认材料区交给它的东西（清单和放材料的几个动作）。
vi.mock("@/components/materials/ObjectMaterialArea", async (importOriginal) => ({ ...await importOriginal<typeof import("@/components/materials/ObjectMaterialArea")>(),
  ObjectMaterialArea: ({ children }: { children: ReactNode | ((area: unknown) => ReactNode) }) => <section>{typeof children === "function" ? children(state.area) : children}</section> }));
vi.mock("ts-design/primitives", () => {
  const textOf = (node: unknown): string => typeof node === "string" || typeof node === "number" ? String(node)
    : Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" && "props" in node ? textOf((node as { props: { children?: unknown } }).props.children) : "";
  const wrap = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { Button: ({ children, onPress, ...props }: { children?: ReactNode; onPress?: () => void; [key: string]: unknown }) => {
    if (onPress) state.press.set(textOf(children), onPress);
    const { isDisabled: _disabled, isIconOnly: _icon, ...rest } = props;
    return <button {...rest} disabled={!!_disabled}>{children}</button>;
  }, Input: ({ ...props }: Record<string, unknown>) => <input {...props} />, Label: ({ children }: { children?: ReactNode }) => <label>{children}</label>, TextField: wrap, TextArea: (props: Record<string, unknown>) => <textarea {...props} />,
  Select: Object.assign(wrap, { Trigger: wrap, Value: () => null, Indicator: () => null, Popover: wrap }),
  ListBox: Object.assign(wrap, { Item: wrap, ItemIndicator: () => null }),
  // 下拉单在测试里直接展开，好看到里面有哪几项。
  Popover: Object.assign(wrap, { Content: wrap, Dialog: wrap }),
  Tooltip: Object.assign(({ children }: { children?: ReactNode }) => <>{children}</>, { Content: ({ children }: { children?: ReactNode }) => <span role="tooltip">{children}</span> }),
  Checkbox: Object.assign(wrap, { Control: wrap, Indicator: () => null, Content: wrap }) };
});
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
  id, version: 2, title: `事项 ${id}`, status: "not_started", source: "self", startDate: "2026-10-01", dueDate: "2026-10-12", doneDefinition: "留下结论\n附上依据", mission: { missionId: "mission-1", title: "上线验证", cardId: "card-1", period: "2026-10", battlefieldName: "灯塔客户", step: 2, steps: 4 }, waitingOn: { taskId: "task-0", title: "确认范围" }, awaitingAcceptance: false, planTaskId: null, owner: { personId: "sun", name: "孙铭泽" }, collaborators: [{ personId: "lin", name: "林晓" }], latestProgress: null, returnReason: null, origin: null, createdAt: "2026-09-27T00:00:00Z", updatedAt: "2026-09-27T00:00:00Z", ...extra,
});
const detail = (role: Detail["role"], extra: Partial<Detail> = {}): Detail => ({ task: task(), judgment: null, judgmentAt: null, myNote: null, myNoteAt: null, role, missionOptions: role === "owner" ? [{ missionId: "mission-2", title: "客户试点", battlefieldName: "灯塔客户", period: "2026-10" }] : [], collaboratorOptions: role === "owner" ? [{ personId: "bai", name: "白田田" }] : [], progress: [], standards: ["留下结论", "附上依据"], submission: null, acceptance: null, ...extra });
const material = (id: string, extra: Partial<TMaterialView> = {}): TMaterialView => ({ id, objectType: "task", objectId: "task-1", fileName: "版本规划.md", format: "markdown", sizeBytes: 40, origin: "upload",
  owner: { personId: "sun", displayName: "孙铭泽" }, createdAt: "2026-10-05T06:00:00Z", updatedAt: "2026-10-05T06:20:00Z", version: 1, editable: true, canEdit: true, pending: 0, canDelete: true, lastRevision: null, working: false, ...extra });
const DOC = "11111111-1111-4111-8111-111111111111", LINK = "22222222-2222-4222-8222-222222222222", AGENT = "33333333-3333-4333-8333-333333333333";
/** 页头状态那一段写的字（读屏也念它）。 */
const statusOf = (html: string) => visible(html.match(/<span data-task-status[^>]*>(.*?)<\/span><\/span>/)?.[1] ?? "");
/** 页面上看得到的字（去掉标签）。 */
const visible = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, "");
const screen = (value: Detail) => renderToStaticMarkup(<TaskScreen initialDetail={value} />);

beforeEach(() => {
  vi.clearAllMocks(); state.press.clear(); state.cardClick.clear();
  state.area = { materials: [], canUpload: true, uploading: false, open: vi.fn(), pickFile: vi.fn(), pasteLink: vi.fn(), draft: vi.fn() };
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
});

describe("成员首页执行事项", () => {
  it("最新进展仅在有记录时显示，并给悬停与读屏提供正文", () => {
    const html = renderToStaticMarkup(<MemberTasks tasks={[task("new", { latestProgress: { body: "完成接口核对", source: "codex", author: { personId: "sun", name: "孙铭泽" }, createdAt: "2026-10-05T06:20:00Z" } })]} />);
    expect(html).toContain("最新进展 · Codex");
    expect(html).toContain('title="完成接口核对"');
    expect(html).toContain('aria-label="最新进展：完成接口核对"');
  });
  it("执行事项区显示外部工具最近一次同步的时间和工具；网页里写的不算，没有就不显示", () => {
    const entry = (source: "web" | "codex" | "claude", createdAt: string) => ({ body: "进展", source, author: { personId: "sun", name: "孙铭泽" }, createdAt });
    const items = [task("a", { latestProgress: entry("codex", "2026-10-05T06:20:00Z") }), task("b", { latestProgress: entry("claude", "2026-10-06T02:18:00Z") }),
      task("c", { latestProgress: entry("web", "2026-10-07T02:00:00Z") })];
    expect(lastExternalSync(items)?.source).toBe("claude");
    expect(renderToStaticMarkup(<MemberTasks tasks={items} />)).toMatch(/最近同步 .+ · Claude Code/);
    expect(renderToStaticMarkup(<MemberTasks tasks={[task("c", { latestProgress: entry("web", "2026-10-07T02:00:00Z") })]} />)).not.toContain("最近同步");
  });
  it("按截止排并保留同截止顺序；卡上有归属、日期、协作者和新建入口，不写步骤、不写等上一步，也没有状态按钮", () => {
    const items = [task("a", { dueDate: null }), task("b", { dueDate: "2026-10-12" }), task("c", { dueDate: "2026-10-02" })];
    expect(tasksByDue(items).map((item) => item.id)).toEqual(["c", "b", "a"]);
    const html = renderToStaticMarkup(<MemberTasks tasks={items} />);
    expect(html).toContain("开启执行事项"); expect(html).toContain("上线验证"); expect(html).toContain("协作 · 林晓"); expect(html).toContain("计划开始 2026-10-01"); expect(html).toContain("未启动");
    for (const gone of ["第 2 步", "等上一步", "进行中", "完成"]) expect(html).not.toContain(gone);
  });
  it("完成的事项不占卡片，收进默认折叠的「已完成 N」", () => {
    const html = renderToStaticMarkup(<MemberTasks tasks={[task("open", { title: "还在推进" }), task("finished", { title: "已经收尾", status: "done" })]} />);
    expect(html).toContain("还在推进");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/已完成(<!-- -->)? ?1/);
    expect(html).not.toContain("已经收尾");
  });
  it("点击卡片空白处打开详情，卡上的按钮不触发卡片导航", () => {
    const navigate = vi.fn();
    renderToStaticMarkup(<MemberTasks tasks={[task()]} onNavigate={navigate} />);
    const card = {} as HTMLElement;
    state.cardClick.get("task-1")?.({ target: { closest: () => null }, currentTarget: card });
    expect(navigate).toHaveBeenCalledWith("/me/tasks/task-1", card);
    state.cardClick.get("task-1")?.({ target: { closest: () => ({ tagName: "BUTTON" }) }, currentTarget: card });
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

describe("执行事项封面", () => {
  it("新建后打开的封面：身份区、完成标准、三张入口卡和一行「写一条进展」；页头有状态、低调的验收和 ⋯；没接入的「让 Agent 推进」不出现", () => {
    const html = screen(detail("owner"));
    const text = visible(html);
    expect(text).toContain("上线验证"); expect(text).toContain("灯塔客户 · 你在推进"); expect(text).toContain("事项 task-1");
    expect(text).not.toContain("让 Agent 推进"); expect(text).not.toContain("Agent 执行接入后可用");
    expect(text).toContain("10 月 12 日前完成 · 计划 10 月 1 日开始 · 参与：孙铭泽、林晓"); expect(text).toContain("邀请协作");
    expect(text).toContain("完成标准"); expect(text).toContain("留下结论"); expect(text).toContain("附上依据");
    for (const entry of ["上传文件", "粘贴链接", "起草文档", "写一条进展"]) expect(text).toContain(entry);
    expect(text).not.toContain("文件也可以直接拖进这一页。");
    expect(statusOf(html)).toBe("未启动");
    expect(html).toMatch(/<button[^>]*variant="ghost"[^>]*>.*?验收<\/button>/);
    expect(html).toContain('aria-label="更多"');
    for (const gone of ["第 2 步", "等上一步", "报进度", "执行过程", "我的批注"]) expect(text).not.toContain(gone);
    expect(state.register).toHaveBeenCalledWith(expect.objectContaining({ scope: "task:task-1", group: expect.objectContaining({ kind: "task", taskId: "task-1", members: [{ personId: "sun", displayName: "孙铭泽" }, { personId: "lin", displayName: "林晓" }] }) }));
  });
  it("没写完成标准：推进人可以直接去写，协作者只看到还没写", () => {
    const empty = { standards: [], task: task("task-1", { doneDefinition: null }) };
    expect(visible(screen(detail("owner", empty)))).toContain("还没写完成标准。写完成标准");
    const collaborator = screen(detail("collaborator", empty));
    expect(visible(collaborator)).toContain("还没写完成标准。"); expect(collaborator).not.toMatch(/>写完成标准<\/button>/);
  });
  it("有材料时是卡片网格：格式标签、来源一行，Co-Agent 在改的那份换成蓝字；最后一张是「添加」", () => {
    state.area.materials = [material(DOC), material(LINK, { fileName: "交互稿 · Figma", format: "link", url: "https://www.figma.com/file/abc", owner: { personId: "lin", displayName: "林晓" }, editable: false, canEdit: false }),
      material(AGENT, { fileName: "访谈纪要.md", origin: "agent", working: true })];
    const html = screen(detail("owner", { task: task("task-1", { status: "in_progress" }) }));
    const text = visible(html);
    expect(text).toContain("正在推进3 份");
    expect(text).toContain("Markdown"); expect(text).toContain("孙铭泽 上传 · 10 月 5 日");
    expect(text).toContain("链接 · figma.com"); expect(text).toContain("林晓 放进来 · 10 月 5 日");
    expect(text).toContain("Co-Agent 正在按批注修改"); expect(html).toContain('aria-label="访谈纪要.md，Markdown，Co-Agent 正在按批注修改"');
    expect(text).toContain("添加"); expect(text).not.toContain("文件也可以直接拖进这一页。");
    expect(statusOf(html)).toBe("进行中");
  });
  it("执行过程默认折叠成一行：几条进展、最近一句；判断不再单独成块", () => {
    const entry = { id: "00000000-0000-4000-8000-000000000001", taskId: "task-1", author: { personId: "lin", name: "林晓" }, source: "claude" as const, body: "完成测试\n附了 PR", links: [{ url: "https://example.com/pr", title: "证据" }], createdAt: "2026-10-05T06:20:00Z" };
    const html = screen(detail("collaborator", { progress: [entry], judgment: "先验证两家", judgmentAt: "2026-10-03T02:05:00.000Z" }));
    expect(visible(html)).toContain("执行过程 · 1 条进展 · 最近：完成测试 附了 PR");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("先验证两家"); expect(html).not.toContain("https://example.com/pr");
  });
  it("外部工具提交了验收：推进人看到「等你验收」，验收变成实心主按钮；协作者看到「待验收」，没有验收、⋯ 和让 Agent 推进", () => {
    const submitted = { task: task("task-1", { status: "in_progress", awaitingAcceptance: true }) };
    const owner = screen(detail("owner", submitted));
    expect(statusOf(owner)).toBe("等你验收");
    expect(owner).toMatch(/<button[^>]*variant="primary"[^>]*>.*?验收<\/button>/);
    const collaborator = screen(detail("collaborator", submitted));
    expect(statusOf(collaborator)).toBe("待验收");
    expect(collaborator).not.toMatch(/>验收<\/button>/); expect(collaborator).not.toContain('aria-label="更多"');
    expect(collaborator).not.toContain("让 Agent 推进"); expect(collaborator).not.toContain("邀请协作");
    // 个人任务页协作者打不开：所属个人任务对协作者是纯文字。
    expect(visible(collaborator)).toContain("上线验证灯塔客户 · 孙铭泽在推进");
    expect(collaborator).not.toMatch(/<button[^>]*>上线验证/);
  });
  it("⋯：编辑、删除（未启动的自建事项）、退回（会后分派的才有）；手机上的验收也在这里", () => {
    const own = visible(screen(detail("owner")));
    for (const item of ["编辑", "删除"]) expect(own).toContain(item);
    expect(own).not.toContain("退回"); expect(own).not.toContain("重新打开");
    const meeting = task("meeting", { source: "meeting", origin: { type: "meeting", meetingId: "m-1", meetingTitle: "周会", quote: "核对试点" } });
    const owner = screen(detail("owner", { task: meeting }));
    expect(owner).toContain(">退回<"); expect(owner).not.toContain(">删除<");
    expect(visible(owner)).toContain("执行过程 · 会议原话");
    expect(screen(detail("collaborator", { task: meeting }))).not.toContain(">退回<");
  });
  it("完成后的封面：验收记录和结论、交付结果大卡、逐条打勾的完成标准；不再有验收，⋯ 里能重新打开", () => {
    state.area.materials = [material(DOC), material(LINK, { fileName: "交互稿 · Figma", format: "link", url: "https://www.figma.com/file/abc" })];
    const html = screen(detail("owner", { task: task("task-1", { status: "done" }), acceptance: {
      by: { personId: "sun", name: "孙铭泽" }, at: "2026-10-10T08:30:00Z", verdict: "两家都确认了方向",
      standards: [{ text: "留下结论", met: true, evidence: "进展 · 10 月 9 日", materialId: null }, { text: "附上依据", met: false, evidence: null, materialId: null }],
      deliverableMaterialIds: [DOC],
    } }));
    const text = visible(html);
    expect(text).toContain("已验收孙铭泽 · 10 月 10 日 16:30 · 比计划早 2 天"); expect(text).toContain("两家都确认了方向");
    expect(text).toContain("交付结果版本规划.mdMarkdown · 孙铭泽 · 10 月 5 日打开");
    expect(text).toContain("完成标准1 / 2"); expect(html).toContain('aria-label="达到"'); expect(html).toContain('aria-label="没达到"'); expect(text).toContain("进展 · 10 月 9 日");
    expect(statusOf(html)).toBe("完成"); expect(html).not.toMatch(/>验收<\/button>/);
    expect(text).toContain("重新打开"); expect(text).not.toContain("让 Agent 推进"); expect(text).not.toContain("邀请协作"); expect(text).not.toContain("正在推进");
  });
  it("10/8 之前就完成、没有验收记录的老事项：不出验收记录，完成标准照常列出、不打勾也不写 N / M", () => {
    state.area.materials = [material(DOC)];
    const html = screen(detail("owner", { task: task("task-1", { status: "done" }) }));
    const text = visible(html);
    expect(text).not.toContain("已验收"); expect(html).not.toContain('aria-label="达到"'); expect(text).not.toMatch(/\d+ \/ \d+/);
    expect(text).toContain("留下结论"); expect(text).toContain("材料1 份"); expect(text).not.toContain("交付结果");
  });
  it("删除先确认，取消时不发 DELETE；确认后带 version 删除", async () => {
    screen(detail("owner"));
    state.ask.mockResolvedValueOnce(false);
    await state.press.get("删除")?.();
    await vi.waitFor(() => expect(state.ask).toHaveBeenCalledTimes(1));
    expect(state.delete).not.toHaveBeenCalled();
    state.ask.mockResolvedValueOnce(true);
    state.delete.mockResolvedValue({ response: { status: 204 } });
    await state.press.get("删除")?.();
    await vi.waitFor(() => expect(state.delete).toHaveBeenCalledWith("/api/me/tasks/{id}", { params: { path: { id: "task-1" } , query: { version: 2 } } }));
  });
});

describe("执行事项新建与邀请", () => {
  it("新建页一步一问：先问做什么，步骤点列出后面的 Mission 与时间两步", () => {
    const html = renderToStaticMarkup(<CreateTaskScreen />);
    expect(html).toContain("这件事是什么？"); expect(html).toContain("执行事项标题");
    expect(html).toContain("推进哪个 Mission"); expect(html).toContain("时间与完成标准"); expect(html).toContain("下一步");
    expect(html).not.toContain("不挂个人任务"); expect(html).not.toContain("开启执行事项</button>");
  });
  it("邀请弹层只展示详情提供的可邀请同事，并说明加入群聊", () => {
    const html = renderToStaticMarkup(<CollaboratorsDialog taskId="task-1" options={detail("owner").collaboratorOptions} isOpen onClose={vi.fn()} onAdded={vi.fn()} />);
    expect(html).toContain("白田田"); expect(html).not.toContain("协作成员可查看任务资料"); expect(html).toContain("加入协作与群聊");
    expect(html).not.toContain("孙铭泽");
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
