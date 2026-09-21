import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { MeetingCard } from "./MeetingCard";

// useCardAction 需要 Next 路由上下文；这里只渲染静态标记。
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

const participants = [
  { personId: "p1", displayName: "林晓", roles: ["dri"], sourceRef: "person:p1", updatedAt: "2025-09-01" },
  { personId: "p2", displayName: "陈珂", roles: ["ceo"], sourceRef: "person:p2", updatedAt: "2025-09-01" },
];

function entry(id: string, kind: string, title: string, body: string) {
  return { id, kind, title, body, sourceRefs: [`memory:${id}`] };
}

export function meetingCard(payloadOverrides: Record<string, unknown>, actions: Card["actions"] = []): Card {
  return {
    schemaVersion: 1,
    id: "meeting:1",
    version: 1,
    kind: "meeting",
    objectRef: { type: "meeting", id: "1", version: 1 },
    title: "东南亚渠道预算决策会",
    payload: {
      status: "scheduled",
      scheduledAt: "2025-09-24T14:00:00.000Z",
      leadDriId: "p1",
      ceoParticipantId: "p2",
      participants,
      issueIds: [],
      originRef: "meeting:1",
      preflight: {
        status: "ready",
        pendingSince: null,
        runId: null,
        entries: [
          entry("e1", "core_judgment", "预算可以批", "但必须绑定 90 天时效复盘"),
          entry("e2", "strategic_alignment", "与双主线一致", "东南亚渠道是关键落子"),
          entry("e3", "leader_lens", "先问是否增强战略证明", "视角预判，非权威发言"),
        ],
        basis: "证据边界",
        brief: "简报",
        error: null,
        generatedAt: "2025-09-23T00:00:00.000Z",
        readiness: "ready",
        summary: { criticalIssue: "最关键问题", priorityAction: "最优先动作" },
        taskDefinition: {
          materialPurpose: "材料目的",
          reviewPurpose: "评审目的",
          primaryRole: "project_plan",
          secondaryRole: null,
          maturity: "internal_alignment",
          readerAction: "读者动作",
          nonGoal: "非目标",
        },
        inputCoverage: { background: "available", purpose: "derived", sourceMaterial: "missing", relatedMeeting: "available" },
      },
      draft: {
        readIssueIds: [],
        carriedIssueIds: [],
        checkedEntryIds: [],
        editsByEntryId: {},
        supplementRequests: [],
        note: "",
      },
      transcript: null,
      outcome: null,
      materials: [],
      ...payloadOverrides,
    },
    actions,
  } as unknown as Card;
}

function render(card: Card): string {
  return renderToStaticMarkup(
    <MeetingCard card={card} collection={[card]} onCard={() => undefined} onNavigate={() => undefined} />,
  );
}

describe("Meeting 会前预审", () => {
  it("一号位点评进左侧参考盒，正文目录不再重复列出", () => {
    const html = render(meetingCard({}));
    expect(html).toContain("一号位点评要点参考");
    expect(html).toContain("先问是否增强战略证明");
    expect(html).toContain("视角预判，非权威发言");
    // 同一条目只出现一次：目录里不再有 leader_lens 章节。
    expect(html.split("先问是否增强战略证明")).toHaveLength(2);
    expect(html).toContain("战略一致性判断");
  });

  it("对话栏默认展开为 pen 的浅色 400px 列，仍可折叠", () => {
    const html = render(meetingCard({}));
    expect(html).toContain('data-testid="meeting-chat-sidebar"');
    expect(html).toContain('data-open="true"');
    expect(html).toContain('data-tone="light"');
    expect(html).toContain("会前对话 · 本场会议");
    expect(html).toContain("问点什么…");
    expect(html).toContain('aria-label="折叠会前对话 · 本场会议"');
  });
});

describe("Meeting Outcome 复核", () => {
  it("逐项处理按 kind 与真实状态渲染徽标、状态色与操作", () => {
    const html = render(
      meetingCard(
        {
          status: "held",
        transcript: { turns: [{}, {}, {}] },
        outcome: {
          status: "ready",
          pendingSince: null,
          startedAt: null,
          runId: null,
          previousRunIds: [],
          error: null,
          summary: "预算可以批，但必须绑定 90 天时效复盘",
          warnings: [],
          extractedAt: "2025-09-25T00:00:00.000Z",
          items: [
            { id: "i1", kind: "decision", text: "按两期投入推进", quote: "那就按两期走", speakerId: "p2", review: { status: "confirmed" } },
            { id: "i2", kind: "todo", text: "输出阈值草案", quote: "下周三前给我", speakerId: "p1", review: { status: "open" } },
            { id: "i3", kind: "open", text: "责任归属未定", quote: "下次单独拉会", speakerId: "p1", review: null },
          ],
        },
      },
      [
          { actionId: "a1", actionType: "meeting.revoke_effect", label: "撤回", itemId: "i1" },
          { actionId: "a2", actionType: "meeting.confirm_item", label: "确认", itemId: "i2" },
          { actionId: "a3", actionType: "meeting.dismiss_item", label: "忽略", itemId: "i2" },
        ],
      ),
    );
    expect(html).toContain('data-kind="decision"');
    expect(html).toContain('data-kind="todo"');
    expect(html).toContain('data-kind="open"');
    expect(html).toContain('data-state="confirmed"');
    expect(html).toContain('data-state="pending"');
    expect(html).toContain('data-state="open"');
    expect(html).toContain("仅展示，不产生效果");
    expect(html).toContain("3 条发言已保存 · warmap-transcript.v1");
    // 每条只渲染服务端下发的真实 Action。
    expect(html).toContain("撤回");
    expect(html).toContain("确认");
    expect(html).toContain("忽略");
    expect(html).toContain("会议材料对话");
  });
});
