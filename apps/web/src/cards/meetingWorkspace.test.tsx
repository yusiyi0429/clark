import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import type { TTranscriptCandidateProjection } from "@warmap/contracts";
import { MeetingCard, confirmTranscriptInput, fromCompanyInput, meetingNow, offsetLabel, speakerMappingError, speakerMappingRows, toCompanyInput } from "./MeetingCard";
import { meetingDayWord, meetingSlot } from "@/components/meeting/MeetingHeader";

// 会议页读取外壳的首页集合（关联议题的位置名）；单测里给一个空集合。
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ homeCards: [], closing: false }) }));

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
      endsAt: "2025-09-24T15:30:00.000Z",
      endedAt: null,
      recording: null,
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

function render(card: Card, readOnly = false): string {
  return renderToStaticMarkup(
    <MeetingCard card={card} collection={[card]} onCard={() => undefined} onNavigate={() => undefined} readOnly={readOnly} />,
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

describe("Meeting 页头（clark 会议页，C-08）", () => {
  it("成员只读模式沿用计划时段和材料页签，不出现 CEO 的会议操作", () => {
    const card = meetingCard({ purpose: "对齐预算", preflight: { status: "ready", brief: "预审摘要", readiness: "ready" },
      materials: [{ id: "m1", fileName: "预算.pdf", mimeType: "application/pdf", sizeBytes: 1024, receivedBy: "CEO", providedBy: null, uploadedAt: "2026-09-28" }] },
    [{ actionId: "edit", actionType: "meeting.edit_details", label: "编辑会议" },
      { actionId: "request", actionType: "meeting.request_supplement", label: "请求补充材料" }]);
    const payload = card.payload as Record<string, unknown>;
    for (const key of ["draft", "transcript", "transcriptCandidate", "recording"]) delete payload[key];
    const html = render(card, true);
    expect(html).toContain("data-header-lead");
    expect(html).toContain("会议记录");
    expect(html).toContain("预算.pdf");
    expect(html).toContain("预审摘要");
    expect(html).toContain("对齐预算");
    for (const label of ["开始会议", "编辑会议", "导入会议记录", "请求补充材料", "会前备注", "替换材料集", "标记已核对", "保存准备状态"]) {
      expect(html).not.toContain(label);
    }
  });

  it("成员会议记录只列已确认结论和待办负责人，不显示逐字稿与确认操作", () => {
    const card = meetingCard({ status: "held", outcome: { items: [
      { id: "d1", kind: "decision", text: "批准预算", ownerPersonId: null },
      { id: "t1", kind: "todo", text: "提交排期", ownerPersonId: "p1" },
    ] } });
    const html = render(card, true);
    expect(html).toContain("会议共识");
    expect(html).toContain("会后结论已确认");
    expect(html).toContain("批准预算");
    expect(html).toContain("提交排期");
    expect(html).toContain("林晓");
    for (const label of ["Transcript", "逐字稿", "替换", "忽略", "录音", "导入会议记录"]) expect(html).not.toContain(label);
    expect(html).not.toMatch(/<button[^>]*>确认/);
  });

  it("页头胶囊：返回、计划时段、会名、会议记录入口，右边一颗开始会议；没有四段进度条", () => {
    const html = render(meetingCard({}));
    expect(html).toContain("返回总览");
    expect(html).toContain("data-header-lead");
    expect(html).toContain("22:00");
    expect(html).toContain("23:30");
    expect(html).toContain('id="meeting-title"');
    expect(html).toContain("data-header-whole");
    expect(html).toContain("会议记录");
    expect(html).toContain("开始会议");
    expect(html).not.toContain("会议阶段");
    expect(html).not.toContain("Outcome 复核</span>");
  });

  it("材料上面一行灰字：谁主持、谁参会、这一刻的一件事", () => {
    const html = render(meetingCard({}));
    expect(html).toContain("林晓主持 · 参会：林晓、陈珂 · 会前预审 · 可提交");
  });

  it("已取消的会没有开始会议那颗；开完了写已开完", () => {
    expect(render(meetingCard({ status: "cancelled" }))).not.toContain("开始会议");
    const ended = render(meetingCard({ endedAt: "2025-09-24T15:40:00.000Z" }));
    expect(ended).toContain("已开完");
    expect(ended).toContain("这场会开完了");
    expect(ended).not.toContain("开始会议");
  });

  it("计划时段按公司时区写 HH:mm；日子写今天、明天、后天、昨天，再远写日期", () => {
    expect(meetingSlot("2026-09-24T06:00:00.000Z", "2026-09-24T07:30:00.000Z")).toEqual({ startsAt: "14:00", endsAt: "15:30" });
    const now = new Date("2026-09-24T01:00:00.000Z");
    expect(meetingDayWord("2026-09-24T06:00:00.000Z", now)).toBe("今天");
    expect(meetingDayWord("2026-09-25T06:00:00.000Z", now)).toBe("明天");
    expect(meetingDayWord("2026-09-26T06:00:00.000Z", now)).toBe("后天");
    expect(meetingDayWord("2026-09-23T06:00:00.000Z", now)).toBe("昨天");
    expect(meetingDayWord("2026-09-30T06:00:00.000Z", now)).toBe("9 月 30 日");
  });

  it("开完之后录音在转写：会议记录页写明进度，转写失败提示改用妙记", () => {
    const transcribing = render(meetingCard({ endedAt: "2025-09-24T15:40:00.000Z", recording: { id: "r1", status: "transcribing", error: null } }));
    expect(transcribing).toContain("会议录音");
    expect(transcribing).toContain("正在识别");
    expect(transcribing).toContain("录音转写中");
    const failed = render(meetingCard({ endedAt: "2025-09-24T15:40:00.000Z", recording: { id: "r1", status: "failed", error: "识别服务没有返回结果。" } }));
    expect(failed).toContain("识别服务没有返回结果。可以改用下面的妙记导入。");
  });

  it("这一刻的一件事随会议状态走", () => {
    const payload = (overrides: Record<string, unknown>) => meetingCard(overrides).payload as never;
    expect(meetingNow(payload({}), true)).toBe("待导入会议记录");
    expect(meetingNow(payload({ status: "held" }), true)).toBe("正在整理纪要");
    expect(meetingNow(payload({ status: "cancelled" }), false)).toBe("已取消");
  });

  it("编辑会议的时间按公司时区回填与提交", () => {
    expect(toCompanyInput("2026-09-24T07:00:00.000Z")).toBe("2026-09-24T15:00");
    expect(fromCompanyInput("2026-09-24T15:00")).toBe("2026-09-24T15:00:00+08:00");
  });
});
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

  it("会议材料自己不再内嵌对话栏：对话由工作面右侧的对话列提供", () => {
    const html = render(meetingCard({}));
    expect(html).not.toContain('data-testid="meeting-chat-sidebar"');
    expect(html).not.toContain('data-testid="conversation-dock"');
  });
});

describe("Meeting 编辑会议弹层 CSS 基线", () => {
  const source = readFileSync(new URL("../styles/meeting-workspace.module.css", import.meta.url), "utf8");

  it("320 宽弹层取设计色值", () => {
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
  });
});

describe("妙记 Markdown 候选预览", () => {
  it("会开完了默认打开会议记录：入口同时接受 .md 与 .json", () => {
    const html = render(meetingCard({ endedAt: "2025-09-24T15:40:00.000Z" }));
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
