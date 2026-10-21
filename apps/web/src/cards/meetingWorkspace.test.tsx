import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import type { TTranscriptCandidateProjection } from "@warmap/contracts";
import { MeetingCard, confirmTranscriptInput, fromCompanyInput, meetingNow, offsetLabel, preflightErrorText, speakerMappingError, speakerMappingRows, toCompanyInput } from "./MeetingCard";
import { meetingCountdown, meetingDayWord, meetingSlot, meetingTimeline, meetingTimelineLabel } from "@/components/meeting/MeetingHeader";

// 会议页读取外壳的首页集合（关联议题的位置名）；单测里给一个空集合。
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ homeCards: [], closing: false }) }));

// useCardAction 需要 Next 路由上下文；这里只渲染静态标记。
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
// 会议记录用会议卡还是旧格式，由会议卡接口决定（静态渲染问不到）：这里的会议都是旧格式。
vi.mock("@/components/meeting/useMeetingCardProbe", () => ({ useMeetingCardProbe: () => ({ status: "legacy" }) }));

const participants = [
  { personId: "p1", displayName: "林晓", roles: ["dri"], sourceRef: "person:p1", updatedAt: "2025-09-01" },
  { personId: "p2", displayName: "陈珂", roles: ["ceo"], sourceRef: "person:p2", updatedAt: "2025-09-01" },
];

function entry(id: string, kind: string, title: string, body: string) {
  return { id, kind, title, body, sourceRefs: [`memory:${id}`] };
}

/** W4：leader_lens 已是 3–5 条陈述性追问，不再是带免责声明的单条点评。 */
const LEADER_QUESTIONS = ["决策时机必须选择渠道投入？", "如果只能保留一个战场，砍掉哪个？", "什么证据会推翻当前推荐？"];

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
  it("预审正文和一号位追问使用已保存的草稿改写，原条目仍作来源", () => {
    const original = meetingCard({});
    const draft = (original.payload as { draft: object }).draft;
    const html = render(meetingCard({ draft: { ...draft, editsByEntryId: {
      e1: "核心判断已根据新证据改写。", e2: "战略关系已改写。", e3: "一号位的新追问。",
    } } }));
    for (const text of ["核心判断已根据新证据改写。", "战略关系已改写。", "一号位的新追问。"]) expect(html).toContain(text);
    expect(html).not.toContain("但必须绑定 90 天时效复盘");
    expect(html).not.toContain(LEADER_QUESTIONS[0]);
    expect(html).toContain("memory:e1");
  });
  it("成员只读模式沿用计划时段和材料下拉钮，不出现 CEO 的会议操作", () => {
    const card = meetingCard({ purpose: "对齐预算", preflight: { status: "ready", brief: "预审摘要", readiness: "ready" },
      materials: [{ id: "m1", fileName: "预算.pdf", mimeType: "application/pdf", sizeBytes: 1024, receivedBy: "CEO", providedBy: null, uploadedAt: "2026-09-28" }] },
    [{ actionId: "edit", actionType: "meeting.edit_details", label: "编辑会议" },
      { actionId: "request", actionType: "meeting.request_supplement", label: "请求补充材料" }]);
    const payload = card.payload as Record<string, unknown>;
    for (const key of ["draft", "transcript", "transcriptCandidate", "recording"]) delete payload[key];
    const html = render(card, true);
    expect(html).toContain("data-header-lead");
    // 会前没有会议记录，页头不放会议记录入口，也不放「会前预审 ｜ 会议记录」切换。
    expect(html).not.toContain("data-header-switch");
    expect(html).toContain("data-header-tools");
    expect(html).toContain("预审摘要");
    expect(html).toContain("对齐预算");
    for (const label of ["开始会议", "编辑会议", "上传会议记录", "请求补充材料", "会前备注", "替换材料集", "标记已核对", "保存准备状态"]) {
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
    for (const label of ["Transcript", "逐字稿", "替换", "忽略", "录音", "上传会议记录"]) expect(html).not.toContain(label);
    expect(html).not.toMatch(/<button[^>]*>确认/);
  });

  it("页头：返回、计划时段、会名、材料下拉钮那一格；会前没有会议记录入口；这一版没有开始会议，也没有四段进度条", () => {
    const html = render(meetingCard({}));
    expect(html).toContain("返回总览");
    expect(html).toContain("data-header-lead");
    expect(html).toContain("22:00");
    expect(html).toContain("23:30");
    expect(html).toContain('id="meeting-title"');
    expect(html).toContain("data-header-tools");
    expect(html).not.toContain("data-header-switch");
    expect(html).not.toContain('role="radio"');
    expect(html).not.toContain("开始会议");
    expect(html).not.toContain("会议阶段");
    expect(html).not.toContain("Outcome 复核</span>");
  });

  it("材料上面一行灰字：谁主持、谁参会；预审结论句不再单独写（只在预审进行中写「会前预审中」）", () => {
    const html = render(meetingCard({}));
    expect(html).toContain("林晓主持 · 参会：林晓、陈珂");
    expect(html).not.toMatch(/预审：(材料|建议)/);
  });

  it("这一版页头不放开始会议／计时；开完了由状态行写会议已结束", () => {
    expect(render(meetingCard({ status: "cancelled" }))).not.toContain("开始会议");
    const ended = render(meetingCard({ endedAt: "2025-09-24T15:40:00.000Z" }));
    expect(ended).not.toContain("已开完");
    expect(ended).toContain("会议已结束");
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

  it("会议阶段一眼可辨：沿用 meetingPhase 的已结束，没结束的按开始时刻分即将开 / 进行中；已取消归已结束", () => {
    const at = Date.parse("2026-09-24T05:00:00.000Z");
    expect(meetingTimeline("idle", "2026-09-24T06:00:00.000Z", at)).toBe("upcoming");
    expect(meetingTimeline("idle", "2026-09-24T04:30:00.000Z", at)).toBe("live");
    expect(meetingTimeline("live", "2026-09-24T06:00:00.000Z", at)).toBe("live");
    expect(meetingTimeline("ended", "2026-09-24T06:00:00.000Z", at)).toBe("ended");
    expect(meetingTimeline("idle", "2026-09-24T06:00:00.000Z", at, true)).toBe("ended");
  });

  it("即将开写相对时间（公司时区）：今天写还有几小时 / 几分钟，再远写明天、后天、日期", () => {
    const at = new Date("2026-09-24T03:00:00.000Z"); // 北京 11:00
    expect(meetingCountdown("2026-09-24T06:00:00.000Z", at)).toBe("还有 3 小时");
    expect(meetingCountdown("2026-09-24T06:40:00.000Z", at)).toBe("还有 3 小时");
    expect(meetingCountdown("2026-09-24T03:20:00.000Z", at)).toBe("还有 20 分钟");
    expect(meetingCountdown("2026-09-24T03:00:20.000Z", at)).toBe("还有 1 分钟");
    expect(meetingCountdown("2026-09-25T01:00:00.000Z", at)).toBe("明天");
    expect(meetingCountdown("2026-09-30T06:00:00.000Z", at)).toBe("9 月 30 日");
  });

  it("已结束写「已结束 · 月/日」，已取消写「已取消 · 月/日」", () => {
    expect(meetingTimelineLabel("ended", "2026-10-08T08:00:00.000Z", new Date("2026-10-10T00:00:00Z"))).toBe("已结束 · 10/8");
    expect(meetingTimelineLabel("ended", "2026-10-08T08:00:00.000Z", new Date("2026-10-10T00:00:00Z"), true)).toBe("已取消 · 10/8");
    expect(meetingTimelineLabel("live", "2026-10-08T08:00:00.000Z", new Date())).toBe("会议中");
  });

  it("页头时间段与整页带着阶段：已结束是灰色对勾 + 已结束，未开是橙点 + 相对时间", () => {
    const ended = render(meetingCard({ hasEnded: true }));
    expect(ended).toMatch(/data-header-lead[^>]*data-timeline="ended"/);
    expect(ended).toContain("已结束 · 9/24");
    expect(ended).toMatch(/data-testid="meeting-workspace"[^>]*data-timeline="ended"|data-timeline="ended"[^>]*data-testid="meeting-workspace"/);
    const upcoming = render(meetingCard({ scheduledAt: "2099-09-24T14:00:00.000Z", endsAt: "2099-09-24T15:30:00.000Z" }));
    expect(upcoming).toMatch(/data-header-lead[^>]*data-timeline="upcoming"/);
    expect(upcoming).toContain("9 月 24 日");
    expect(upcoming).not.toContain("已结束");
    const cancelled = render(meetingCard({ status: "cancelled" }));
    expect(cancelled).toContain("已取消 · 9/24");
  });

  it("开完之后录音在转写：会议记录页只标进度，转写失败只报错、导入按钮就在下面", () => {
    const transcribing = render(meetingCard({ endedAt: "2025-09-24T15:40:00.000Z", recording: { id: "r1", status: "transcribing", error: null } }));
    expect(transcribing).toContain("会议录音");
    expect(transcribing).toContain("正在识别");
    expect(transcribing).not.toContain("一小时会议约需数分钟");
    const failed = render(meetingCard({ endedAt: "2025-09-24T15:40:00.000Z", minutesManualImport: true, recording: { id: "r1", status: "failed", error: "识别服务没有返回结果。" } }));
    expect(failed).toContain("识别服务没有返回结果。");
    expect(failed).not.toContain("可以改用下面的妙记导入");
    expect(failed).toContain("上传会议记录");
  });

  it("这一刻的一件事随会议状态走", () => {
    const payload = (overrides: Record<string, unknown>) => meetingCard(overrides).payload as never;
    // 和页头会后阶段同一套词：没失败就是等妙记，自动同步失败才是待交记录。
    expect(meetingNow(payload({}), true)).toBe("等妙记");
    expect(meetingNow(payload({ minutesManualImport: true }), true)).toBe("待交记录");
    expect(meetingNow(payload({ status: "held" }), true)).toBe("生成会议卡");
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

  it("关联议题成为议题块：块头保留已阅、带到会议、打开议题，预审判断收进议题块", () => {
    const html = render(meetingCard({ issueIds: ["issue:1"] }));
    expect(html).toContain('aria-label="关联议题"');
    expect(html).not.toContain('data-section="issues"');
    // 单议题会议：战略一致性等预审判断都属于这个议题，排在议题块里。
    expect(html.indexOf("关联议题")).toBeLessThan(html.indexOf("战略一致性判断"));
    expect(html).toContain("已阅");
    expect(html).toContain("带到会议");
    expect(html).toContain("打开议题");
    expect(html).not.toContain("打开 Issue");
  });

  it("scheduled 会议在标题右侧给出编辑会议铅笔，只有服务端下发了 opaque action 才渲染", () => {
    const withAction = render(meetingCard({}, [{ actionId: "a1", actionType: "meeting.edit_details", label: "编辑会议" }]));
    expect(withAction).toContain('aria-label="编辑会议"');
    expect(render(meetingCard({}))).not.toContain("编辑会议");
    // 编辑浮层默认收起：表单字段不在页上；非 scheduled 的会议不提供入口
    expect(withAction).not.toContain("会议标题");
    expect(render(meetingCard({ status: "held" }, [{ actionId: "a1", actionType: "meeting.edit_details", label: "编辑会议" }]))).not.toContain("编辑会议");
  });

  it("会议材料自己不再内嵌对话栏：对话由工作面右侧的对话列提供", () => {
    const html = render(meetingCard({}));
    expect(html).not.toContain('data-testid="meeting-chat-sidebar"');
    expect(html).not.toContain('data-testid="conversation-dock"');
  });

  it("预审失败：给 CEO 看中文原因与重试，不露出服务端内部原话", () => {
    const failed = (code: string, message: string) => {
      const base = meetingCard({}).payload as { preflight: Record<string, unknown> };
      return render(meetingCard({ preflight: { ...base.preflight, status: "failed", error: { code, message, at: "2025-09-23T00:00:00.000Z" } } },
        [{ actionId: "r1", actionType: "meeting.retry_preflight", label: "重试预审" }]));
    };
    const badRef = failed("invalid_source_ref", "Preflight sourceRef 不在允许来源内: memory:kd-company.md#s1#p2");
    expect(badRef).toContain("本次预审有依据与该会议资料不符，结果未保存。");
    expect(badRef).toContain("重试预审");
    expect(badRef).not.toContain("sourceRef 不在允许来源内");
    expect(failed("preflight_agent_failed", "Candidate agent did not call submit_candidate")).toContain("本次预审未完成。");
    // 已经是中文的原因照原样显示。
    expect(failed("preflight_interrupted", "预审在进程重启前未完成，请显式重试")).toContain("预审在进程重启前未完成，请显式重试");
    expect(preflightErrorText({ code: "invalid_preflight_candidate", message: "Preflight 出现翻案句：x" })).toBe("本次预审返回内容不完整，结果未保存。");
  });
});

describe("Meeting 编辑会议弹层 CSS 基线", () => {
  const source = readFileSync(new URL("../styles/meeting-workspace.module.css", import.meta.url), "utf8");

  it("320 宽弹层取设计色值", () => {
    expect(source).toContain("width:320px;padding:14px 16px;border:1px solid #e6e9ed;border-radius:14px");
    // 输入框的边、圆角、底色、聚焦走 globals.css 的统一输入框样式，弹层里只留宽高。
    expect(source).toContain(".editField input,.editField select{width:100%;height:36px;padding:0 14px}");
    expect(source).toContain(".editSave{background:#007aff");
  });
});

describe("Meeting Outcome 复核", () => {
  it("会议记录还在生成：只有短状态；第一次生成失败：生成失败和重试，不显示报错原文", () => {
    const outcome = (status: string) => ({ status, pendingSince: null, startedAt: null, runId: null, previousRunIds: [], summary: "", warnings: [], extractedAt: null, items: [],
      error: status === "failed" ? { code: "MODEL_TIMEOUT", message: "模型调用超时：upstream 504", at: "2025-09-25T00:00:00.000Z" } : null });
    for (const status of ["pending", "running"]) {
      const html = render(meetingCard({ status: "held", transcript: { turns: [{}] }, outcome: { ...outcome(status), pendingSince: "2025-09-25T00:00:00.000Z" } }));
      expect(html).toContain("会议记录生成中");
      // 带已用时（走字的 <time>）。
      expect(html).toMatch(/会议记录生成中[\s\S]*?<time/);
      expect(html).not.toContain("抽取尚未产出摘要");
    }
    const failed = render(meetingCard({ status: "held", transcript: { turns: [{}] }, outcome: outcome("failed") },
      [{ actionId: "r1", actionType: "meeting.retry_outcome", label: "重试会后抽取" }]));
    expect(failed).toContain("生成失败");
    expect(failed).toContain(">重试会后抽取</button>");
    expect(failed).not.toContain("upstream 504");
    expect(failed).not.toContain("抽取尚未产出摘要");
  });

  it("对不上人的说话人写飞书原名，不写内部编号", () => {
    const html = render(meetingCard({
      status: "held",
      transcript: { turns: [{ id: "turn-0001", speakerId: "speaker:3", text: "我来把预算表发给大家。" }], unmappedSpeakers: [{ id: "speaker:3", name: "Speaker 3" }] },
      outcome: { status: "ready", pendingSince: null, startedAt: null, runId: null, previousRunIds: [], error: null, summary: "预算", warnings: [], extractedAt: "2025-09-25T00:00:00.000Z",
        items: [{ id: "i1", kind: "open", text: "预算表待发", quote: "我来把预算表发给大家", speakerId: "speaker:3", review: null }] },
    }));
    expect(html).toContain("Speaker 3");
    expect(html).not.toContain("speaker:3");
  });

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
    expect(html).toContain("3 条发言已保存");
    // 会议记录页不出现英文内部名词。
    for (const term of ["Transcript", "warmap-transcript", "Action Item", "Outcome candidate", "confirmed effect"]) expect(html).not.toContain(term);
    // 会后只有会议卡一个入口：旧会议的条目只读，带着旧的逐条动作也不出确认 / 忽略 / 撤回按钮。
    expect(html).not.toContain(">撤回<");
    expect(html).not.toContain(">确认<");
    expect(html).not.toContain(">忽略<");
    expect(html).not.toContain(">推送<");
  });
});

describe("妙记 Markdown 候选预览", () => {
  it("自动同步失败才出「上传会议记录」：等妙记、刚开完时不出，失败后出", () => {
    const ended = { endedAt: "2025-09-24T15:40:00.000Z" };
    for (const waiting of [{}, { minutesStatus: "waiting", minutesWaitingSince: "2025-09-24T15:41:00.000Z" }, { minutesStatus: "failed", minutesFailure: "not_ready" }]) {
      const html = render(meetingCard({ ...ended, ...waiting, minutesManualImport: false }));
      expect(html).not.toContain(">上传会议记录<");
    }
    const manual = render(meetingCard({ ...ended, minutesStatus: "manual", minutesManualImport: true }));
    expect(manual).toContain(">上传会议记录<");
  });

  it("等妙记时没有大块导入，选文件仍在（页头「自己上传」用）", () => {
    const html = render(meetingCard({ endedAt: "2025-09-24T15:40:00.000Z", minutesStatus: "waiting", minutesWaitingSince: "2025-09-24T15:41:00.000Z", minutesManualImport: false }));
    expect(html).toContain('aria-label="选择会议记录文件"');
    expect(html).not.toContain(">上传会议记录<");
  });

  it("会开完了默认打开会议记录：入口接受 txt、md、pdf、docx、html 和 .json", () => {
    const html = render(meetingCard({ endedAt: "2025-09-24T15:40:00.000Z", minutesManualImport: true }));
    expect(html).toContain('accept=".md,.markdown,.txt,.pdf,.docx,.html,.htm,.json,');
    expect(html).toContain(">上传会议记录<");
    expect(html).not.toContain("上传会议逐字稿");
  });

  it("候选存在时自动打开预览：来源摘要、时间锚点、抽样发言与告警", () => {
    const html = render(meetingCard({ transcriptCandidate: candidateBase }));
    expect(html).toContain("确认会议记录");
    expect(html).toContain("本体建模 Part 2.md");
    expect(html).toContain("40 KB");
    expect(html).toContain("12 条发言 · 3 位说话人 · 时长 59:00");
    expect(html).toContain("首段 +00:01");
    expect(html).toContain("末段 +59:01");
    expect(html).toContain("先把结论说清楚。");
    expect(html).toContain("“外部顾问”未匹配到人员，请手动选择。");
    // 有候选时上传区切到重新上传。
    expect(html).toContain("重新上传会议记录");
  });

  it("未映射说话人时给出行内错误并禁用确认，全部唯一映射后放行", () => {
    const confirmAction = { actionId: "c1", actionType: "meeting.confirm_transcript_candidate", label: "确认会议记录" };
    const unresolved = render(meetingCard({ transcriptCandidate: candidateBase }, [confirmAction]));
    expect(unresolved).toContain("还有 1 位说话人未映射，确认不可用");
    expect(unresolved).toContain('data-status="unmapped"');
    expect(buttonMarkup(unresolved, "确认并写入逐字稿")).toContain("disabled");

    const resolved = { ...candidateBase, speakers: candidateBase.speakers.map((speaker) => ({ ...speaker, suggestedPersonId: speaker.suggestedPersonId ?? "p3" })) };
    const html = render(meetingCard({ transcriptCandidate: resolved }, [confirmAction]));
    expect(html).not.toContain("未映射，确认不可用");
    expect(html).not.toContain('data-status="unmapped"');
    expect(buttonMarkup(html, "确认并写入逐字稿")).not.toContain("disabled");

    const samePerson = { ...candidateBase, speakers: candidateBase.speakers.map((speaker) => ({ ...speaker, suggestedPersonId: speaker.suggestedPersonId ?? "p1" })) };
    const merged = render(meetingCard({ transcriptCandidate: samePerson }, [confirmAction]));
    expect(merged).not.toContain('role="alert"');
    expect(buttonMarkup(merged, "确认并写入逐字稿")).not.toContain("disabled");
  });

  it("清除与确认按钮只按服务端下发的 opaque action 渲染", () => {
    const withActions = render(
      meetingCard({ transcriptCandidate: candidateBase }, [
        { actionId: "c1", actionType: "meeting.confirm_transcript_candidate", label: "确认会议记录" },
        { actionId: "d1", actionType: "meeting.discard_transcript_candidate", label: "清除候选" },
      ]),
    );
    expect(withActions).toContain("确认并写入逐字稿");
    expect(withActions).toContain("清除候选");

    const withoutActions = render(meetingCard({ transcriptCandidate: candidateBase }));
    expect(withoutActions).not.toContain("确认并写入逐字稿");
    expect(withoutActions).not.toContain("清除候选");
  });

  it("行状态按已参与/待加入/未映射标注", () => {
    const rows = speakerMappingRows(candidateBase, ["p1"], {});
    expect(rows.map((row) => row.status)).toEqual(["existing", "add", "unmapped"]);
    expect(speakerMappingError(rows)).toContain("未映射");

    // 飞书会把同一个人拆成两个说话人：两行选同一人照常放行
    const samePerson = speakerMappingRows(candidateBase, ["p1"], { 外部顾问: "p1" });
    expect(samePerson.map((row) => [row.personId, row.status])).toEqual([["p1", "existing"], ["p2", "add"], ["p1", "existing"]]);
    expect(speakerMappingError(samePerson)).toBeNull();
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
