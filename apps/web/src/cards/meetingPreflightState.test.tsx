import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { MeetingCard } from "./MeetingCard";

vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ homeCards: [], closing: false }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

const entry = (id: string, kind: string, title: string, body: string, extra: Record<string, unknown> = {}) =>
  ({ id, kind, title, body, sourceRefs: ["meeting:1"], ...extra });

function card(preflight: Record<string, unknown>): Card {
  return {
    schemaVersion: 1, id: "meeting:1", version: 1, kind: "meeting", objectRef: { type: "meeting", id: "1", version: 1 }, title: "交付周会",
    payload: {
      status: "scheduled", scheduledAt: "2026-10-10T02:00:00.000Z", endsAt: "2026-10-10T02:45:00.000Z", endedAt: null, recording: null,
      leadDriId: "p1", ceoParticipantId: "p2",
      participants: [
        { personId: "p1", displayName: "陈砚", roles: ["dri"], sourceRef: "person:p1", updatedAt: "2026-10-01" },
        { personId: "p2", displayName: "林岚", roles: ["ceo"], sourceRef: "person:p2", updatedAt: "2026-10-01" },
      ],
      issueIds: [], originRef: null,
      preflight: {
        status: "ready", pendingSince: null, runId: "run-1", basis: "读取了群材料 v2", brief: "本周交付按计划推进", error: null,
        generatedAt: "2026-10-09T08:00:00.000Z", readiness: "ready",
        summary: { criticalIssue: "无", priorityAction: "周五同步上线结果" },
        taskDefinition: { materialPurpose: "同步进度", reviewPurpose: "确认是否需要 CEO 判断", primaryRole: "owner_status", secondaryRole: null,
          maturity: "implementation", readerAction: "知悉", nonGoal: "不做决策" },
        inputCoverage: { background: "available", purpose: "derived", sourceMaterial: "available", relatedMeeting: "missing",
          groupMaterials: "available", discussions: "available", decisionHistory: "missing" },
        entries: [entry("entry-1", "core_judgment", "核心判断", "本周交付按计划推进"), entry("entry-2", "next_step", "下一步", "周五同步上线结果")],
        ...preflight,
      },
      draft: { readIssueIds: [], carriedIssueIds: [], checkedEntryIds: [], editsByEntryId: {}, supplementRequests: [], note: "" },
      transcript: null, transcriptCandidate: null, outcome: null, materials: [],
    },
    actions: [],
  } as unknown as Card;
}

const render = (value: Card) => renderToStaticMarkup(
  <MeetingCard card={value} collection={[value]} onCard={() => undefined} onNavigate={() => undefined} readOnly={false} />,
);

describe("预审：问题不设下限、CEO 问题说明、资料过期提示", () => {
  it("普通同步会没有会议问题时给出明确空状态，不出现一号位追问盒", () => {
    const html = render(card({}));
    expect(html).toContain("本次会议无需当场决策的问题。");
    expect(html).not.toContain("一号位追问");
    expect(html).toContain("群材料 <b>已具备</b>");
    expect(html).toContain("历史决定 <b>待补</b>");
  });

  it("不再单列「预审结论」；还有待决定议题时不说「没有需当场决策的问题」", () => {
    const withIssue = (readiness: string) => {
      const value = card({ readiness });
      (value.payload as { issueIds: string[] }).issueIds = ["issue-1"];
      return render(value);
    };
    const blocked = withIssue("blocked");
    for (const verdict of ["预审结论", "材料不足，建议补充后上会", "建议补充后上会", "材料齐备，可以上会"]) expect(blocked).not.toContain(verdict);
    expect(blocked).not.toContain("暂不提交");
    expect(blocked).not.toContain("当场拍板");
  });

  it("CEO 级问题展示决策时机、需一号位决定的原因、可选路径与影响", () => {
    const html = render(card({
      entries: [
        entry("entry-1", "core_judgment", "核心判断", "需要决定验收清单是否前置"),
        entry("entry-2", "meeting_question", "清单是否刚性前置", "是否自 10/15 起所有新签合同必须附清单？", {
          ceoDecision: { whyNow: "10/12 起 4 份合同进入法务定稿", whyCeo: "改变 9/25 已确认的审批规则", delayCost: "4 份合同按旧条款签出",
            options: [{ label: "方案A 刚性前置", impact: "大单签约可能推迟" }, { label: "方案B 分级前置", impact: "例外条款需逐条审批" }] },
        }),
      ],
    }));
    expect(html).not.toContain("本次会议没有需当场决策的问题");
    for (const text of ["决策时机", "10/12 起 4 份合同进入法务定稿", "需一号位决定的原因", "改变 9/25 已确认的审批规则",
      "可选：方案A 刚性前置", "大单签约可能推迟", "可选：方案B 分级前置", "延迟代价"]) expect(html).toContain(text);
  });

  it("报告之后材料升版或有新讨论时提示预审基于旧版本，可重新预审", () => {
    const html = render(card({
      staleInputs: {
        materials: [{ id: "m1", fileName: "交付周报.md", objectType: "meeting", objectId: "1", usedVersion: 1, currentVersion: 2, change: "updated" },
          { id: "m2", fileName: "客户反馈.md", objectType: "meeting", objectId: "1", usedVersion: null, currentVersion: 1, change: "added" }],
        newDiscussionCount: 2,
      },
    }));
    expect(html).toContain("资料已更新：《交付周报.md》预审基于 v1，当前已是 v2；新增《客户反馈.md》未进入本次预审；群里新增 2 条讨论。可重新预审。");
  });

  it("生成期间资料变化也不冒充最新报告", () => {
    expect(render(card({ inputsChangedDuringRun: true }))).toContain("预审生成期间资料有更新：本报告未基于最新资料。可重新预审。");
    // 真实场景：生成中材料 v4→v5，投影同时给出版本差异，仍要写明是生成期间变的。
    const during = render(card({ inputsChangedDuringRun: true, staleInputs: {
      materials: [{ id: "m1", fileName: "标准验收清单与签约前置方案.md", objectType: "meeting", objectId: "1", usedVersion: 4, currentVersion: 5, change: "updated" }], newDiscussionCount: 0 } }));
    expect(during).toContain("预审生成期间资料有更新：《标准验收清单与签约前置方案.md》预审基于 v4，当前已是 v5。可重新预审。");
    expect(render(card({}))).not.toContain("可重新预审");
  });
});

describe("预审条目都归到议题下时，整场判断那一句仍在会议概况里", () => {
  const issueCard = (status = "ready") => {
    const value = card({ status, brief: "本次会只需确定底层延伸的边界", entries: [entry("entry-1", "core_judgment", "维持合作优先", "近期以多上游合作获得真实负载")] });
    (value.payload as { issueIds: string[] }).issueIds = ["issue-1"];
    return value;
  };
  it("单议题会：会议概况写出整场判断（预审 brief），核心判断留在议题下", () => {
    const html = render(issueCard());
    expect(html).toContain("<small>整场判断</small>本次会只需确定底层延伸的边界");
  });
  it("预审进行中不写旧的整场判断", () => {
    expect(render(issueCard("running"))).not.toContain("本次会只需确定底层延伸的边界");
  });
  it("没有议题的会仍用整场判断块，不重复写这一句", () => {
    const html = render(card({ brief: "本周交付按计划推进" }));
    expect(html.match(/本周交付按计划推进/g)?.length).toBe(1);
  });
});
