import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import type { TTranscriptCandidateProjection } from "@warmap/contracts";
import { MeetingCard, confirmTranscriptInput, offsetLabel, speakerMappingError, speakerMappingRows } from "./MeetingCard";

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

/** 取按钮自身标记，用于检查 disabled 等属性而不依赖 CSS Module 类名。 */
function buttonMarkup(html: string, label: string): string {
  const index = html.indexOf(label);
  return html.slice(html.lastIndexOf("<button", index), index);
}

const candidateBase: TTranscriptCandidateProjection = {
  source: {
    format: "miaoji_markdown",
    fileName: "本体建模 Part 2.md",
    sizeBytes: 40960,
    sha256: "a".repeat(64),
    parserVersion: "miaoji-markdown.v1",
    timeAnchor: "2025-09-24T14:00:00.000Z",
  },
  createdAt: "2025-09-24T15:00:00.000Z",
  turnCount: 12,
  speakerCount: 3,
  durationSeconds: 3540,
  firstOffsetSeconds: 1,
  lastOffsetSeconds: 3541,
  speakers: [
    { speakerName: "林晓", turnCount: 5, suggestedPersonId: "p1", suggestedDisplayName: "林晓" },
    { speakerName: "陈珂", turnCount: 4, suggestedPersonId: "p2", suggestedDisplayName: "陈珂" },
    { speakerName: "外部顾问", turnCount: 3, suggestedPersonId: null, suggestedDisplayName: null },
  ],
  sampleTurns: [
    { speakerName: "林晓", offsetSeconds: 1, text: "先把结论说清楚。" },
    { speakerName: "陈珂", offsetSeconds: 12, text: "预算分两期投入。" },
  ],
  warnings: ["“外部顾问”未匹配到人员，请手动选择。"],
};

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

describe("妙记 Markdown 候选预览", () => {
  it("Header 入口同时接受 .md 与 .json，文案改为导入会议记录", () => {
    const html = render(meetingCard({}));
    expect(html).toContain('accept=".md,.json,application/json,text/markdown"');
    expect(html).toContain("导入会议记录");
    expect(html).not.toContain("上传会议逐字稿");
  });

  it("候选存在时自动打开预览：来源摘要、时间锚点、抽样发言与告警", () => {
    const html = render(meetingCard({ transcriptCandidate: candidateBase }));
    expect(html).toContain("确认妙记会议记录");
    expect(html).toContain("本体建模 Part 2.md");
    expect(html).toContain("40 KB");
    expect(html).toContain("12 条发言 · 3 位说话人 · 时长 59:00");
    expect(html).toContain("首段 +00:01");
    expect(html).toContain("末段 +59:01");
    expect(html).toContain("先把结论说清楚。");
    expect(html).toContain("“外部顾问”未匹配到人员，请手动选择。");
    // 有候选时 Header 切到重新导入文案。
    expect(html).toContain("重新导入会议记录");
  });

  it("未映射说话人时给出行内错误并禁用确认，全部唯一映射后放行", () => {
    const confirmAction = { actionId: "c1", actionType: "meeting.confirm_transcript_candidate", label: "确认会议记录" };
    const unresolved = render(meetingCard({ transcriptCandidate: candidateBase }, [confirmAction]));
    expect(unresolved).toContain("还有 1 位说话人未映射，确认不可用");
    expect(unresolved).toContain('data-status="unmapped"');
    expect(buttonMarkup(unresolved, "确认并写入 Transcript")).toContain("disabled");

    const resolved = { ...candidateBase, speakers: candidateBase.speakers.map((speaker) => ({ ...speaker, suggestedPersonId: speaker.suggestedPersonId ?? "p3" })) };
    const html = render(meetingCard({ transcriptCandidate: resolved }, [confirmAction]));
    expect(html).not.toContain("未映射，确认不可用");
    expect(html).not.toContain('data-status="unmapped"');
    expect(buttonMarkup(html, "确认并写入 Transcript")).not.toContain("disabled");
  });

  it("清除与确认按钮只按服务端下发的 opaque action 渲染", () => {
    const withActions = render(
      meetingCard({ transcriptCandidate: candidateBase }, [
        { actionId: "c1", actionType: "meeting.confirm_transcript_candidate", label: "确认会议记录" },
        { actionId: "d1", actionType: "meeting.discard_transcript_candidate", label: "清除候选" },
      ]),
    );
    expect(withActions).toContain("确认并写入 Transcript");
    expect(withActions).toContain("清除候选");

    const withoutActions = render(meetingCard({ transcriptCandidate: candidateBase }));
    expect(withoutActions).not.toContain("确认并写入 Transcript");
    expect(withoutActions).not.toContain("清除候选");
  });

  it("行状态按已参与/待加入/未映射标注", () => {
    const rows = speakerMappingRows(candidateBase, ["p1"], {});
    expect(rows.map((row) => row.status)).toEqual(["existing", "add", "unmapped"]);
    expect(speakerMappingError(rows)).toContain("未映射");

    const duplicated = speakerMappingRows(candidateBase, ["p1"], { 外部顾问: "p1" });
    expect(speakerMappingError(duplicated)).toBe("同一个人不能映射多个说话人");
    expect(speakerMappingRows({ ...candidateBase, speakers: candidateBase.speakers.slice(0, 2) }, ["p1", "p2"], {})).toHaveLength(2);
  });

  it("offsetLabel 覆盖分与小时跨度", () => {
    expect(offsetLabel(0)).toBe("00:00");
    expect(offsetLabel(65)).toBe("01:05");
    expect(offsetLabel(4591)).toBe("1:16:31");
  });

  it("确认 Action input 只带 speakerMappings 与显式标记，不回传全量 turns", () => {
    const input = confirmTranscriptInput(candidateBase, { 林晓: "p1", 陈珂: "p2", 外部顾问: "p3" });
    expect(input).toEqual({
      speakerMappings: [
        { speakerName: "林晓", personId: "p1" },
        { speakerName: "陈珂", personId: "p2" },
        { speakerName: "外部顾问", personId: "p3" },
      ],
      confirmAddParticipants: true,
    });
    expect(JSON.stringify(input)).not.toContain("turns");
  });
});
