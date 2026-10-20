import { describe, expect, it } from "vitest";
import type { TIssueDecisionHistory } from "@warmap/contracts";
import {
  buildHistoryIndex,
  emptySourceContext,
  historyAnchorId,
  issueAnchorId,
  outcomeAnchorId,
  parseSourceRef,
  refIssueId,
  sectionAnchorId,
  sourceLabel,
  sourceTarget,
  transcriptTurnAnchorId,
  type SourceContext,
} from "./meetingSources";

const MATERIAL = "11111111-1111-4111-8111-111111111111";
const ISSUE = "22222222-2222-4222-8222-222222222222";
const OTHER_ISSUE = "33333333-3333-4333-8333-333333333333";
const MEETING = "44444444-4444-4444-8444-444444444444";
const OLD_MEETING = "55555555-5555-4555-8555-555555555555";

const history: TIssueDecisionHistory = {
  issueId: ISSUE,
  issueTitle: "是否把验收清单前置到签约前",
  issueStatus: "pending",
  effective: [{
    ref: "decision:r-1", issueId: ISSUE, kind: "decision", text: "9 月起新签合同必须附验收清单", decidedAt: "2026-09-25T02:00:00.000Z",
    decidedBy: { personId: "p-ceo", displayName: "林岚" }, confirmedVia: "meeting.confirm_item", option: null, status: "effective",
    statusAt: null, statusReason: null, supersededBy: null, revokedBy: null,
    source: { kind: "meeting-item", meetingId: OLD_MEETING, meetingTitle: "九月经营会", quote: "就这么定" }, sourceRefs: ["decision:r-1", `meeting:${OLD_MEETING}`],
  }],
  inactive: [{
    ref: "decision:h-0", issueId: ISSUE, kind: "decision", text: "先签约后补清单", decidedAt: "2026-08-10T02:00:00.000Z", decidedBy: null,
    confirmedVia: "imported", option: null, status: "superseded", statusAt: "2026-09-25T02:00:00.000Z", statusReason: null,
    supersededBy: "decision:r-1", revokedBy: null, source: { kind: "imported", importedRef: "8 月经营会纪要 第 3 条" }, sourceRefs: ["decision:h-0"],
  }],
  changes: [
    { ref: "discussion:88", kind: "discussion", at: "2026-10-02T03:00:00.000Z", text: "两家大客户不接受清单前置", author: { personId: "p-1", displayName: "陈砚" },
      sourceRef: "议题群讨论 · 验收清单", stance: "意见", relatedDecisionRefs: ["decision:r-1"] },
    { ref: `material:${MATERIAL}@v2`, kind: "material_revision", at: "2026-10-03T03:00:00.000Z", text: "《交付周报.md》更新到 v2：补充客户反馈",
      author: null, sourceRef: "议题群材料 · 验收清单" },
    { ref: "fact:f-1", kind: "execution_fact", at: "2026-10-04T03:00:00.000Z", text: "华东两单延期签约", author: null, sourceRef: "销售周报 10/4" },
  ],
  changesSince: "2026-09-25T02:00:00.000Z",
  changesNote: null,
  pending: [{ ref: `outcome:${OLD_MEETING}#d-9`, kind: "outcome_candidate", text: "清单改为分级前置", at: "2026-09-25T02:00:00.000Z", options: [],
    source: { kind: "meeting-item", meetingId: OLD_MEETING, meetingTitle: "九月经营会" }, note: "会后候选尚未经 CEO 确认，不是决定。" }],
  relatedMeetings: [{ id: OLD_MEETING, title: "九月经营会", status: "held", scheduledAt: "2026-09-25T02:00:00.000Z" }],
};

function context(overrides: Partial<SourceContext> = {}): SourceContext {
  return emptySourceContext({
    meetingId: MEETING,
    issueIds: [ISSUE, OTHER_ISSUE],
    issueTitle: (id) => (id === ISSUE ? "是否把验收清单前置到签约前" : id === OTHER_ISSUE ? "华东渠道补贴" : undefined),
    materials: new Map([[MATERIAL, { objectType: "issue" as const, objectId: ISSUE, fileName: "交付周报.md", format: "markdown", version: 2 }]]),
    currentVersions: new Map([[MATERIAL, 3]]),
    legacyMaterials: new Map([["legacy-1", { id: "legacy-1", fileName: "预算申请.pdf", mimeType: "application/pdf", sizeBytes: 2048, uploadedAt: "2026-09-20" }]]),
    history: buildHistoryIndex([history]),
    meetings: new Map([[OLD_MEETING, "九月经营会"]]),
    ...overrides,
  });
}

describe("依据 ref 解析", () => {
  it("群材料版本带段落、旧会前材料、群讨论、决定、会后条目、企业知识都能认出来", () => {
    expect(parseSourceRef(`material:${MATERIAL}@v2#p3`)).toMatchObject({ kind: "material", id: MATERIAL, version: 2, paragraph: 3 });
    expect(parseSourceRef(`material:${MATERIAL}@v2`)).toMatchObject({ kind: "material", version: 2, paragraph: null });
    expect(parseSourceRef("material:legacy-1")).toMatchObject({ kind: "legacy-material", id: "legacy-1" });
    expect(parseSourceRef("discussion:88")).toMatchObject({ kind: "discussion", messageId: 88 });
    expect(parseSourceRef("discussion:abc")).toMatchObject({ kind: "unknown" });
    expect(parseSourceRef("decision:r-1")).toMatchObject({ kind: "decision", id: "r-1" });
    expect(parseSourceRef(`outcome:${MEETING}#i-2`)).toMatchObject({ kind: "outcome", meetingId: MEETING, itemId: "i-2" });
    expect(parseSourceRef(`outcome:${OLD_MEETING}`)).toMatchObject({ kind: "outcome", meetingId: OLD_MEETING, itemId: null });
    expect(parseSourceRef("memory:经营原则.md#s2")).toMatchObject({ kind: "memory", file: "经营原则.md", section: 2 });
    expect(parseSourceRef("chat:7d1c0f7e-3c1b-4f4e-9b1e-1c2d3e4f5a6b#12")).toEqual({ kind: "chat", ref: "chat:7d1c0f7e-3c1b-4f4e-9b1e-1c2d3e4f5a6b#12", conversationId: "7d1c0f7e-3c1b-4f4e-9b1e-1c2d3e4f5a6b", sequence: 12 });
    expect(parseSourceRef("chat:7d1c0f7e")).toMatchObject({ kind: "unknown" });
    expect(parseSourceRef("pmem:5f0e8c1a-2b3c")).toEqual({ kind: "pmem", ref: "pmem:5f0e8c1a-2b3c", id: "5f0e8c1a-2b3c" });
    expect(parseSourceRef("pmem:a b")).toMatchObject({ kind: "unknown" });
    expect(parseSourceRef("signal:s-1")).toMatchObject({ kind: "signal", id: "s-1" });
    expect(parseSourceRef("whatever")).toMatchObject({ kind: "unknown" });
  });
});

describe("依据点下去打开什么（feedback 14）", () => {
  const ctx = context();

  it("群材料打开引用的那一版和那一段，知道材料属于哪个议题；名字写文件名、版本、段落，已有新版也写出来", () => {
    expect(sourceTarget(`material:${MATERIAL}@v2#p3`, ctx, ISSUE)).toEqual({
      type: "material", ref: `material:${MATERIAL}@v2#p3`, materialId: MATERIAL, version: 2, paragraph: 3,
      material: { objectType: "issue", objectId: ISSUE, fileName: "交付周报.md", format: "markdown", version: 2 },
    });
    expect(sourceLabel(`material:${MATERIAL}@v2#p3`, ctx, ISSUE)).toBe("《交付周报.md》 · 第 2 版 · 第 3 段 · 已有新版");
    // 快照里没有的材料：仍按版本打开，由抽屉去相关对象里找。
    const unknown = "99999999-9999-4999-8999-999999999999";
    expect(sourceTarget(`material:${unknown}@v1`, ctx)).toMatchObject({ type: "material", version: 1, material: null });
  });

  it("依据名只写材料原始标题：资料包文字层抽取件的内部后缀「（PDF 文字版）.md」不显示", () => {
    const ctx2 = context({ materials: new Map([[MATERIAL, { objectType: "issue" as const, objectId: ISSUE, fileName: "FireworksAI_国内对标分析_V2（PDF 文字版）.md", format: "markdown", version: 1 }]]),
      legacyMaterials: new Map([["legacy-1", { id: "legacy-1", fileName: "对比研究（Word 文字版）.md", mimeType: "text/markdown", sizeBytes: 10, uploadedAt: "2026-09-20" }]]) });
    expect(sourceLabel(`material:${MATERIAL}@v1`, ctx2, ISSUE)).toBe("《FireworksAI_国内对标分析_V2》 · 第 1 版 · 已有新版");
    expect(sourceLabel("material:legacy-1", ctx2)).toBe("《对比研究》");
  });

  it("旧会前材料按会议材料预览打开；没有这份材料就不是可打开的东西", () => {
    expect(sourceTarget("material:legacy-1", ctx)).toMatchObject({ type: "legacy-material", materialId: "legacy-1", material: { fileName: "预算申请.pdf" } });
    expect(sourceLabel("material:legacy-1", ctx)).toBe("《预算申请.pdf》");
    expect(sourceTarget("material:gone", ctx)).toEqual({ type: "none" });
  });

  it("群讨论：历史里有原话就直接带上作者和时间；没有就在抽屉里去群里找", () => {
    expect(sourceTarget("discussion:88", ctx, ISSUE)).toMatchObject({ type: "discussion", messageId: 88, change: { author: { displayName: "陈砚" } } });
    expect(sourceLabel("discussion:88", ctx, ISSUE)).toBe("群讨论 · 陈砚 · 10/2");
    expect(sourceTarget("discussion:7", ctx)).toMatchObject({ type: "discussion", messageId: 7, change: null });
    expect(sourceLabel("discussion:7", ctx)).toBe("群讨论发言");
  });

  it("历史决定定位到本页对应议题的历史条目；不在本页时退回到抽屉详情；已替代的写明", () => {
    expect(sourceTarget("decision:r-1", ctx, ISSUE)).toMatchObject({ type: "anchor", anchorId: historyAnchorId(ISSUE, "decision:r-1"), fallback: { type: "detail" } });
    // 依据按钮只放一小段原文（14 字），完整原文在历史条目里。
    expect(sourceLabel("decision:r-1", ctx, ISSUE)).toBe("9/25 会后确认「9 月起新签合同必须附验收清…」");
    expect(sourceLabel("decision:h-0", ctx, ISSUE)).toBe("已被替代的决定「先签约后补清单」");
    expect(sourceTarget("decision:nope", ctx)).toMatchObject({ type: "detail", hit: null });
    expect(sourceTarget("fact:f-1", ctx, ISSUE)).toMatchObject({ type: "anchor", anchorId: historyAnchorId(ISSUE, "fact:f-1") });
  });

  it("外部信号、别的会议、别的议题跳页；本场会议本身不可打开；本场会议记录切到会议记录", () => {
    expect(sourceTarget("signal:s-1", ctx)).toEqual({ type: "route", href: "/radar/signals/s-1" });
    expect(sourceTarget(`meeting:${OLD_MEETING}`, ctx)).toEqual({ type: "route", href: `/meetings/${OLD_MEETING}` });
    expect(sourceLabel(`meeting:${OLD_MEETING}`, ctx)).toBe("会议「九月经营会」");
    expect(sourceTarget(`meeting:${MEETING}`, ctx)).toEqual({ type: "none" });
    expect(sourceLabel(`meeting:${MEETING}`, ctx)).toBe("当前会议");
    expect(sourceTarget(`transcript:${MEETING}`, ctx)).toEqual({ type: "record" });
    expect(sourceTarget(`transcript:${OLD_MEETING}`, ctx)).toEqual({ type: "route", href: `/meetings/${OLD_MEETING}?meetingAction=transcript` });
    expect(sourceTarget(`issue:${ISSUE}`, ctx)).toMatchObject({ type: "anchor", anchorId: issueAnchorId(ISSUE) });
    expect(sourceTarget("issue:elsewhere", ctx)).toEqual({ type: "route", href: "/issues/elsewhere" });
    expect(sourceTarget(`research:${ISSUE}`, ctx)).toMatchObject({ type: "anchor", anchorId: sectionAnchorId(ISSUE, "evidence") });
  });

  it("出处带发言段", () => {
    expect(parseSourceRef("transcript:m1#t42")).toEqual({ kind: "transcript", ref: "transcript:m1#t42", meetingId: "m1", turnId: "t42" });
    expect(parseSourceRef("transcript:m1")).toMatchObject({ meetingId: "m1", turnId: null });
    expect(transcriptTurnAnchorId("t42")).toBe("turn-t42");
    // 同一场会：滚到那一段；那一段还没在页面上时切到会议记录再定位。
    expect(sourceTarget(`transcript:${MEETING}#t42`, ctx)).toMatchObject({ type: "anchor", anchorId: "turn-t42", fallback: { type: "record", turnId: "t42" } });
    const other = sourceTarget(`transcript:${OLD_MEETING}#t42`, ctx);
    expect(other.type).toBe("route");
    expect(other.type === "route" && other.href).toBe(`/meetings/${OLD_MEETING}?meetingAction=transcript&turn=t42`);
    expect(sourceLabel(`transcript:${OLD_MEETING}#t42`, ctx)).toBe(sourceLabel(`transcript:${OLD_MEETING}`, ctx));
  });

  it("会后条目：本场的定位到条目，别场的定位到历史里的候选或打开那场会", () => {
    expect(sourceTarget(`outcome:${MEETING}#i-2`, ctx)).toMatchObject({ type: "anchor", anchorId: outcomeAnchorId("i-2") });
    expect(sourceTarget(`outcome:${OLD_MEETING}#d-9`, ctx, ISSUE)).toMatchObject({ type: "anchor", anchorId: historyAnchorId(ISSUE, `outcome:${OLD_MEETING}#d-9`) });
    expect(sourceTarget(`outcome:${OLD_MEETING}`, ctx)).toEqual({ type: "route", href: `/meetings/${OLD_MEETING}` });
  });

  it("企业知识在抽屉里说明出处；认不出的来源只写「其他来源」，不把内部 ref 摆给 CEO", () => {
    expect(sourceTarget("memory:经营原则.md#s2", ctx)).toMatchObject({ type: "detail", parsed: { kind: "memory" } });
    expect(sourceLabel("memory:经营原则.md#s2", ctx)).toBe("《经营原则》第 2 节");
    expect(sourceLabel("memory:kd-demo-materials#s1", ctx)).toBe("《资料说明》第 1 节");
    expect(sourceLabel("memory:kd-goals#s1", ctx)).not.toContain("kd-");
    expect(sourceLabel("odd:thing", ctx)).toBe("其他来源");
    expect(sourceTarget("odd:thing", ctx)).toEqual({ type: "none" });
  });

  it("依据指向哪个议题：议题、议题预研、议题群材料、只出现在一个议题历史里的决定与变化", () => {
    expect(refIssueId(`issue:${OTHER_ISSUE}`, ctx)).toBe(OTHER_ISSUE);
    expect(refIssueId(`research:${ISSUE}`, ctx)).toBe(ISSUE);
    expect(refIssueId(`material:${MATERIAL}@v2#p1`, ctx)).toBe(ISSUE);
    expect(refIssueId("decision:r-1", ctx)).toBe(ISSUE);
    expect(refIssueId("discussion:88", ctx)).toBe(ISSUE);
    expect(refIssueId(`meeting:${MEETING}`, ctx)).toBeNull();
    expect(refIssueId("issue:elsewhere", ctx)).toBeNull();
  });
});
