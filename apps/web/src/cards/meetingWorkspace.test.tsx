import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
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

/** W4：leader_lens 已是 3–5 条陈述性追问，不再是带免责声明的单条点评。 */
const LEADER_QUESTIONS = ["为什么现在必须选择渠道投入？", "如果只能保留一个战场，砍掉哪个？", "什么证据会推翻当前推荐？"];

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
          entry("e3", "leader_lens", "一号位追问一", LEADER_QUESTIONS[0]),
          entry("e4", "leader_lens", "一号位追问二", LEADER_QUESTIONS[1]),
          entry("e5", "leader_lens", "一号位追问三", LEADER_QUESTIONS[2]),
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
      transcriptCandidate: null,
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
  it("一号位追问进左侧参考盒，按陈述列表编号，正文目录不再重复列出", () => {
    const html = render(meetingCard({}));
    expect(html).toContain("一号位追问");
    for (const question of LEADER_QUESTIONS) expect(html.split(question)).toHaveLength(2);
    expect(html).toContain("<ol>");
    expect(html).not.toContain("视角预判");
    expect(html).not.toContain("一号位追问一");
    expect(html).toContain("战略一致性判断");
  });

  it("关联议题移到左侧预审状态之后，保留三个 chips", () => {
    const html = render(meetingCard({ issueIds: ["issue:1"] }));
    expect(html).toContain('aria-label="关联议题"');
    expect(html).not.toContain('data-section="issues"');
    // 左栏在正文之前：关联议题必须排在正文的「战略一致性判断」之前。
    expect(html.indexOf("关联议题")).toBeLessThan(html.indexOf("战略一致性判断"));
    expect(html).toContain("已阅");
    expect(html).toContain("带到会议");
    expect(html).toContain("打开 Issue");
  });

  it("scheduled 会议在 Header 给出编辑会议入口，只有服务端下发了 opaque action 才渲染", () => {
    const withAction = render(meetingCard({}, [{ actionId: "a1", actionType: "meeting.edit_details", label: "编辑会议" }]));
    expect(withAction).toContain("编辑会议");
    expect(render(meetingCard({}))).not.toContain("编辑会议");
    // 编辑弹层默认收起；非 scheduled 的会议不提供入口
    expect(withAction).not.toContain('aria-label="编辑会议"');
    expect(render(meetingCard({ status: "held" }, [{ actionId: "a1", actionType: "meeting.edit_details", label: "编辑会议" }]))).not.toContain("编辑会议");
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

describe("Meeting 编辑会议弹层 CSS 基线", () => {
  const source = readFileSync(new URL("../styles/meeting-workspace.module.css", import.meta.url), "utf8");

  it("Header 白底铅笔按钮与 320 宽弹层取设计色值", () => {
    expect(source).toContain(".editAction{display:flex;align-items:center;gap:6px;padding:9px 13px;border:1px solid #d9dde5;border-radius:10px;background:#fff");
    expect(source).toContain("width:320px;padding:14px 16px;border:1px solid #e6e9ed;border-radius:14px");
    expect(source).toContain("height:36px;border:1px solid #d9dde5;border-radius:9px;background:#f7f8fa");
    expect(source).toContain(".editSave{background:#007aff");
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
