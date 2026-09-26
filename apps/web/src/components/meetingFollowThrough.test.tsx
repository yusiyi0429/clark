import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { MeetingCard, outcomeItemState } from "@/cards/MeetingCard";
import { meetingCard } from "@/cards/meetingWorkspace.test";
import { StrategicConfirmCard, pendingStrategicItems } from "./StrategicConfirmCard";
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

describe("会后纪要（会议记录页）", () => {
  it("分成会议纪要、会议共识、按负责人分组的 Action Item、提给 CEO 的战略议题", () => {
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
    expect(html).toContain("Action Item");
    expect(html).toContain("已推送给林晓");
    expect(html).toContain("CEO 的事，只留在纪要");
    expect(html).toContain("提给 CEO 的战略议题");
    expect(html).toContain("东南亚改为主战场");
    expect(html).toContain("等 CEO 确认");
  });

  it("战略议题确认后写明交给 Co-Agent 更新本体；不同意写明", () => {
    const payload = heldMeeting([]).payload as never;
    const name = (id: string) => id;
    expect(outcomeItemState({ ...STRATEGIC, review: { status: "confirmed", effectRef: "ontology:1" } } as never, payload, name).label).toBe("CEO 已确认 · 本体待 Co-Agent 更新");
    expect(outcomeItemState({ ...STRATEGIC, review: { status: "dismissed" } } as never, payload, name).label).toBe("CEO 不同意");
  });
});

describe("CEO 通知栏「需要你确认」", () => {
  const actions = [
    { actionId: "c1", actionType: "meeting.confirm_item", label: "确认", itemId: "s1" },
    { actionId: "d1", actionType: "meeting.dismiss_item", label: "不同意", itemId: "s1" },
  ] as Card["actions"];

  it("只收还没表态的战略议题，带上两颗动作", () => {
    const found = pendingStrategicItems([heldMeeting([STRATEGIC, item("a1", "todo")], actions), heldMeeting([{ ...STRATEGIC, id: "s2", review: { status: "confirmed" } }])]);
    expect(found).toHaveLength(1);
    expect(found[0].confirm?.actionId).toBe("c1");
    expect(found[0].dismiss?.actionId).toBe("d1");
  });

  it("标题加一两句话把事情说全，卡上直接确认或不同意", () => {
    const html = renderToStaticMarkup(<StrategicConfirmCard cards={[heldMeeting([STRATEGIC], actions)]} onCard={noop} onNavigate={noop} />);
    expect(html).toContain("需要你确认");
    expect(html).toContain("东南亚改为主战场");
    expect(html).toContain("把东南亚从试点升级为主战场");
    expect(html).toContain(">确认<");
    expect(html).toContain(">不同意<");
  });

  it("没有要确认的就不出现", () => {
    expect(renderToStaticMarkup(<StrategicConfirmCard cards={[heldMeeting([item("a1", "todo")])]} onCard={noop} onNavigate={noop} />)).toBe("");
  });
});

describe("成员首页的执行事项", () => {
  const task = (id: string, dueDate: string | null, extra: Partial<MemberTask> = {}): MemberTask => ({
    id,
    version: 1,
    title: `事项 ${id}`,
    status: "not_started",
    dueDate,
    returnReason: null,
    origin: { type: "meeting", meetingId: "m1", meetingTitle: "灯塔项目：产品交互对齐会议", quote: "下周三前给我" },
    createdAt: "2026-09-26T08:00:00.000Z",
    updatedAt: "2026-09-26T08:00:00.000Z",
    ...extra,
  });

  it("按截止排：截止近的在前，没有截止的放后面、保持原来的先后", () => {
    expect(tasksByDue([task("a", null), task("b", "2026-10-02"), task("c", "2026-09-30"), task("d", null)]).map((item) => item.id)).toEqual(["c", "b", "a", "d"]);
  });

  it("卡上写状态、来处、会上原话；退回的写原因、不给推进钮", () => {
    const html = renderToStaticMarkup(
      <MemberTasks tasks={[task("a", "2026-09-30"), task("b", null, { status: "returned", returnReason: "不归我，归白田田" })]} onStatus={noop} />,
    );
    expect(html).toContain("未开始");
    expect(html).toContain("9 月 30 日前");
    expect(html).toContain("来自会议「灯塔项目：产品交互对齐会议」");
    expect(html).toContain("下周三前给我");
    expect(html).toContain("开始推进");
    expect(html).toContain("已退回：不归我，归白田田");
    expect(html.split("标记完成")).toHaveLength(2);
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
});
