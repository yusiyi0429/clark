import { describe, expect, it } from "vitest";
import type { CardAction } from "@/lib/api/client";
import { attributeEntries, decisionOptions, decisionRequest, defaultDecisionText, groupOutcomeByIssue, outcomeIssueId, speakerLabel, type OutcomeItem, type PreflightEntry } from "./meetingIssueModel";
import { emptySourceContext } from "./meetingSources";

const entry = (id: string, kind: string, sourceRefs: string[], extra: Partial<PreflightEntry> = {}) =>
  ({ id, kind, title: `${kind} ${id}`, body: "正文", sourceRefs, ...extra }) as PreflightEntry;
const item = (id: string, kind: string, issueId: string | null) =>
  ({ id, kind, text: id, quote: id, turnId: "t", speakerId: "p1", ownerPersonId: null, issueId, judgmentKind: null, parentItemId: null, review: { status: "pending" } }) as unknown as OutcomeItem;

describe("会后条目按议题分组", () => {
  it("显式 issueId 优先；决定类条目在只有一个关联议题时归它；普通待办、战略议题不硬归；指向会外议题的进「其他」", () => {
    expect(outcomeIssueId({ issueId: "a", kind: "todo" }, ["a", "b"])).toBe("a");
    expect(outcomeIssueId({ issueId: null, kind: "decision" }, ["a"])).toBe("a");
    expect(outcomeIssueId({ issueId: null, kind: "ceoJudgment" }, ["a"])).toBe("a");
    expect(outcomeIssueId({ issueId: null, kind: "todo" }, ["a"])).toBeNull();
    expect(outcomeIssueId({ issueId: null, kind: "strategic" }, ["a"])).toBeNull();
    expect(outcomeIssueId({ issueId: null, kind: "decision" }, ["a", "b"])).toBeNull();
    expect(outcomeIssueId({ issueId: "z", kind: "decision" }, ["a", "b"])).toBeNull();
    const groups = groupOutcomeByIssue([item("t1", "todo", "a"), item("d1", "decision", "a"), item("s1", "strategic", null), item("d2", "decision", "b")], ["a", "b"]);
    expect(groups.byIssue.get("a")?.map((value) => value.id)).toEqual(["d1", "t1"]);
    expect(groups.byIssue.get("b")?.map((value) => value.id)).toEqual(["d2"]);
    expect(groups.others.map((value) => value.id)).toEqual(["s1"]);
  });
});

describe("预审条目归到议题块", () => {
  it("单议题会议全部归它；多议题按依据只指向一个议题的才归进去，其余留在会议层面", () => {
    const context = emptySourceContext({ issueIds: ["a", "b"] });
    const entries = [entry("e1", "core_judgment", ["issue:a", "issue:b"]), entry("e2", "meeting_question", ["issue:b", "meeting:m"]), entry("e3", "risk_calibration", ["research:a"]), entry("e4", "next_step", ["memory:x"])];
    const split = attributeEntries(entries, ["a", "b"], context);
    expect(split.byIssue.get("a")?.map((value) => value.id)).toEqual(["e3"]);
    expect(split.byIssue.get("b")?.map((value) => value.id)).toEqual(["e2"]);
    expect(split.meeting.map((value) => value.id)).toEqual(["e1", "e4"]);
    const single = attributeEntries(entries, ["a"], emptySourceContext({ issueIds: ["a"] }));
    expect(single.byIssue.get("a")).toHaveLength(4);
    expect(single.meeting).toEqual([]);
  });
});

describe("议题块里的可选路径与「按此决定」", () => {
  const doc = { summary: "s", options: [{ id: "A", label: "先确定验收清单再签约", consequences: ["签约推迟两周"] }, { id: "B", label: "先签约，交付时逐单协商", consequences: ["交付争议增加"] }], evidence: [], unknowns: [], sources: [] };
  const question = entry("q1", "meeting_question", ["issue:a"], {
    title: "清单是否刚性前置",
    ceoDecision: { whyNow: "10/12 进入法务定稿", whyCeo: "改变已确认规则", options: [{ label: "先确定验收清单再签约", impact: "大单签约可能推迟" }, { label: "分级前置", impact: "例外条款逐条审批" }] },
  });

  it("预审问题里与预研同名的选项并进预研选项（可按 optionId 决定），其余作为问题选项列出", () => {
    const options = decisionOptions(doc, [question]);
    expect(options.map((option) => [option.key, option.optionId, option.label])).toEqual([
      ["research:A", "A", "先确定验收清单再签约"],
      ["research:B", "B", "先签约，交付时逐单协商"],
      ["question:q1:1", null, "分级前置"],
    ]);
    expect(options[0].consequences).toEqual(["签约推迟两周", "大单签约可能推迟"]);
    expect(defaultDecisionText(options[1])).toBe("按「先签约，交付时逐单协商」执行");
    expect(defaultDecisionText(options[2])).toBe("清单是否刚性前置：选择「分级前置」");
  });

  const decide = { actionId: "act-decide", actionType: "issue.decide", label: "直接决定" } as CardAction;
  const override = { actionId: "act-override", actionType: "issue.decide_override", label: "预研未完成时直接决定" } as CardAction;

  it("预研完成：issue.decide 带上预研选项 id；自己写的决定不带 optionId", () => {
    expect(decisionRequest({ decide }, { optionKey: "research:B", optionId: "B", text: " 按「B」执行 ", overrideConfirmed: false }))
      .toEqual({ action: decide, input: { decisionText: "按「B」执行", optionId: "B" } });
    expect(decisionRequest({ decide }, { optionKey: null, optionId: null, text: "两周后复议", overrideConfirmed: false }))
      .toEqual({ action: decide, input: { decisionText: "两周后复议" } });
    expect(decisionRequest({ decide }, { optionKey: null, optionId: null, text: "  ", overrideConfirmed: false })).toEqual({ error: "请写下决定内容" });
  });

  it("预研未完成：只能走 issue.decide_override，必须二次确认，且不带 optionId；都没有就不能决定", () => {
    expect(decisionRequest({ override }, { optionKey: "question:q1:1", optionId: null, text: "分级前置", overrideConfirmed: false }))
      .toEqual({ error: "预研尚未完成：请先勾选确认在预研未完成时作出决定" });
    expect(decisionRequest({ override }, { optionKey: "research:A", optionId: "A", text: "按 A", overrideConfirmed: true }))
      .toEqual({ action: override, input: { decisionText: "按 A", confirmOverride: true } });
    expect(decisionRequest({}, { optionKey: null, optionId: null, text: "x", overrideConfirmed: true })).toEqual({ error: "当前不能在这里决定" });
  });
});

describe("会后条目的说话人（复验：不露 minutes-record）", () => {
  const people = new Map([["liu-minghua", "刘明华"]]);
  it("参会人写名字，纪要账号写「会议纪要」，认不出的 id 不显示", () => {
    expect(speakerLabel("liu-minghua", people)).toBe("刘明华");
    expect(speakerLabel("minutes-record", people)).toBe("会议纪要");
    expect(speakerLabel("unknown-42", people)).toBeNull();
    expect(speakerLabel(undefined, people)).toBeNull();
  });
});
