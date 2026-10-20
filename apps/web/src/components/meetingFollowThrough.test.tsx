import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { MeetingCard, outcomeItemState } from "@/cards/MeetingCard";
import { meetingCard } from "@/cards/meetingWorkspace.test";
import { MemberTasks, tasksByDue, type MemberTask } from "./member/MemberTasks";
import { memberNoticeGroups } from "./member/memberNotices";

vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ homeCards: [], closing: false }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

const noop = () => undefined;

function item(id: string, kind: string, extra: Record<string, unknown> = {}) {
  return { id, kind, text: `${id} 的内容`, quote: `${id} 原话`, turnId: "t1", speakerId: "p1", ownerPersonId: null, review: { status: "pending" }, ...extra };
}

function heldMeeting(items: unknown[], actions: Card["actions"] = []): Card {
  return meetingCard(
    {
      status: "held",
      transcript: { schemaVersion: "warmap-transcript.v1", meetingId: "1", importedAt: "2025-09-24T16:00:00.000Z", turns: [{}, {}] },
      outcome: { status: "ready", pendingSince: null, startedAt: null, runId: null, previousRunIds: [], error: null, summary: "定了两期投入。", warnings: [], extractedAt: "2025-09-24T16:10:00.000Z", items },
    },
    actions,
  );
}

const STRATEGIC = item("s1", "strategic", { title: "东南亚改为主战场", brief: "把东南亚从试点升级为主战场，下季度预算向它倾斜。", judgmentKind: "company_direction" });

describe("旧格式会议的会后纪要（会议记录页，只读）", () => {
  it("分成会议纪要、会议共识、按负责人分组的待办事项、提给 CEO 的战略议题", () => {
    const html = renderToStaticMarkup(
      <MeetingCard
        card={heldMeeting([
          item("d1", "decision", { review: { status: "confirmed", effectRef: "issue:x:decision:d1" } }),
          item("a1", "todo", { ownerPersonId: "p1", review: { status: "confirmed", effectRef: "task:abc" } }),
          item("a2", "todo", { ownerPersonId: "p2" }),
          STRATEGIC,
        ])}
        collection={[]}
        onCard={noop}
        onNavigate={noop}
      />,
    );
    expect(html).toContain("会议纪要");
    expect(html).toContain("定了两期投入。");
    expect(html).toContain("会议共识");
    expect(html).toContain("待办事项");
    expect(html).not.toContain("Action Item");
    expect(html).toContain("已推给林晓");
    expect(html).toContain("一号位事项，仅记入纪要");
    expect(html).toContain("提给 CEO 的战略议题");
    expect(html).toContain("东南亚改为主战场");
    expect(html).toContain("未处理");
    expect(html).not.toContain("待 CEO 确认");
  });

  it("会议共识以主决定分组、子项缩进；待办收成一行「N 项待办已推给负责人」；旧的逐条动作即使带着也不出按钮", () => {
    const pushed = (id: string) => item(id, "todo", { ownerPersonId: "p1", review: { status: "confirmed", effectRef: `task:${id}` } });
    const sign = (actionType: string, itemId: string) => ({ actionId: `${actionType}:${itemId}`, actionType, label: actionType, itemId });
    const html = renderToStaticMarkup(
      <MeetingCard
        card={heldMeeting([
          item("m1", "decision", { parentItemId: null }), item("c1", "decision", { parentItemId: "m1" }), item("c2", "decision", { parentItemId: "m1" }),
          item("m2", "decision", { parentItemId: null }), pushed("a1"), pushed("a2"),
        ], [sign("meeting.confirm_item", "m1"), sign("meeting.dismiss_item", "m1"), sign("meeting.confirm_item", "m2"), sign("meeting.dismiss_item", "m2"),
          sign("meeting.revoke_effect", "a1"), sign("meeting.revoke_effect", "a2")] as Card["actions"])}
        collection={[]}
        onCard={noop}
        onNavigate={noop}
      />,
    );
    expect(html).toContain("会议共识");
    expect(html.match(/>2 条</g)).toHaveLength(1);
    expect(html).toContain("c1 的内容");
    expect((html.match(/aria-label="含 2 项"/g) ?? [])).toHaveLength(1);
    // 会后只有会议卡一个入口：没有逐条确认、忽略、撤回
    expect(html).not.toContain(">确认<");
    expect(html).not.toContain(">忽略<");
    expect(html).toContain("2 项待办已推给负责人");
    expect(html).not.toContain(">推送<");
    expect(html).not.toContain(">撤回<");
  });

  it("战略议题照当时的处理写：CEO 已确认、CEO 不同意、未处理", () => {
    const payload = heldMeeting([]).payload as never;
    const name = (id: string) => id;
    expect(outcomeItemState({ ...STRATEGIC, review: { status: "confirmed", effectRef: "ontology:1" } } as never, payload, name).label).toBe("CEO 已确认");
    expect(outcomeItemState({ ...STRATEGIC, review: { status: "dismissed" } } as never, payload, name).label).toBe("CEO 不同意");
    expect(outcomeItemState(STRATEGIC as never, payload, name).label).toBe("未处理");
  });
});

describe("成员首页的执行事项", () => {
  const task = (id: string, dueDate: string | null, extra: Partial<MemberTask> = {}): MemberTask => ({
    id,
    version: 1,
    title: `事项 ${id}`,
    status: "not_started",
    source: "meeting",
    startDate: null,
    dueDate,
    doneDefinition: null,
    mission: null,
    waitingOn: null,
    awaitingAcceptance: false,
    owner: { personId: "p1", name: "孙铭泽" },
    collaborators: [],
    latestProgress: null,
    returnReason: null,
    origin: { type: "meeting", meetingId: "m1", meetingTitle: "灯塔项目：产品交互对齐会议", quote: "下周三前给我" },
    createdAt: "2026-09-26T08:00:00.000Z",
    updatedAt: "2026-09-26T08:00:00.000Z",
    ...extra,
  });

  it("按截止排：截止近的在前，没有截止的放后面、保持原来的先后", () => {
    expect(tasksByDue([task("a", null), task("b", "2026-10-02"), task("c", "2026-09-30"), task("d", null)]).map((item) => item.id)).toEqual(["c", "b", "a", "d"]);
  });

  it("卡上写状态、会后来源；退回的写原因；卡上没有状态按钮（状态跟着推进人的动作走）", () => {
    const html = renderToStaticMarkup(
      <MemberTasks tasks={[task("a", "2026-09-30"), task("b", null, { status: "returned", returnReason: "不归我，归白田田" })]} />,
    );
    expect(html).toContain("未启动");
    expect(html).toContain("9 月 30 日前");
    expect(html).toContain("会后分派 · 灯塔项目：产品交互对齐会议");
    expect(html).toContain("已退回：不归我，归白田田");
    expect(html).not.toContain("进行中");
    expect(html).not.toContain("完成");
  });

  it("外部工具提交了验收的，状态写「等你验收」", () => {
    const html = renderToStaticMarkup(<MemberTasks tasks={[task("a", null, { status: "in_progress", awaitingAcceptance: true })]} />);
    expect(html).toContain("等你验收");
    expect(html).not.toContain("进行中");
  });

  it("通知栏分两组：新的执行事项能接下或退回，回复与结果只要知道了；看过的不再列", () => {
    const groups = memberNoticeGroups(
      [
        { id: "n1", kind: "meeting_action_assigned", text: "会议「X」给你分配了执行事项「Y」", objectType: "task", objectId: "t1", createdAt: "2026-09-26T08:00:00.000Z", readAt: null },
        { id: "n2", kind: "task_returned", text: "孙铭泽 退回了执行事项「Y」：不归我", objectType: "task", objectId: "t2", createdAt: "2026-09-26T08:00:00.000Z", readAt: null },
        { id: "n3", kind: "meeting_action_assigned", text: "旧的", objectType: "task", objectId: "t3", createdAt: "2026-09-25T08:00:00.000Z", readAt: "2026-09-25T09:00:00.000Z" },
      ],
      { markSeen: async () => ({ ok: true }), returnTask: async () => ({ ok: true }) },
    );
    expect(groups.assigned.map((notice) => notice.id)).toEqual(["n1"]);
    expect(groups.assigned[0].buttons.map((button) => button.label)).toEqual(["接下"]);
    expect(groups.assigned[0].reason?.label).toBe("退回");
    expect(groups.results.map((notice) => notice.id)).toEqual(["n2"]);
    expect(groups.results[0].buttons.map((button) => button.label)).toEqual(["知道了"]);
  });

  it("「等你验收」在回复与结果里：点开直接弹出验收；没有「知道了」，验收完或「还要继续做」才算处理", () => {
    const opened: string[] = [];
    const groups = memberNoticeGroups(
      [{ id: "n4", kind: "task_submitted", text: "「Y」等你验收", objectType: "task", objectId: "t4", createdAt: "2026-10-08T08:00:00.000Z", readAt: null }],
      { markSeen: async () => ({ ok: true }), returnTask: async () => ({ ok: true }), openTask: (id) => opened.push(`task:${id}`), openAcceptance: (id) => opened.push(`accept:${id}`) },
    );
    expect(groups.assigned).toEqual([]);
    expect(groups.results.map((notice) => [notice.id, notice.title])).toEqual([["n4", "「Y」等你验收"]]);
    expect(groups.results[0].buttons).toEqual([]);
    groups.results[0].onOpen?.(null);
    expect(opened).toEqual(["accept:t4"]);
  });
});
