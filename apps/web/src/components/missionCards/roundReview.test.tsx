import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { TMissionRoundSummary, TPersonalMissionCardPayload } from "@warmap/contracts";
import { personalPayload } from "./personalMissionFixture";

const ui = vi.hoisted(() => ({ cursor: 0, mode: "document" as "document" | "progress", records: false,
  buttons: new Map<string, { onPress?: () => void; isDisabled?: boolean }>() }));
vi.mock("react", async (importOriginal) => ({ ...await importOriginal<typeof import("react")>(), useEffect: () => {},
  useState: (initial: unknown) => { const index = ui.cursor++; return [ui.mode === "document" && index === 1 ? ui.records : ui.mode === "progress" && index === 0 ? true : initial, vi.fn()]; } }));
vi.mock("ts-design", () => ({ TianshuPortalTheme: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("ts-design/primitives", () => {
  const part = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return { Popover: Object.assign(part, { Content: part, Dialog: part }), Button: ({ children, onPress, isDisabled, variant: _variant, ...props }: { children?: ReactNode; onPress?: () => void; isDisabled?: boolean; variant?: string; "aria-label"?: string }) => {
    ui.buttons.set(props["aria-label"] ?? String(children), { onPress, isDisabled }); return <button disabled={isDisabled} {...props}>{children}</button>;
  } };
});
import { CardDocument } from "./CardDocument";
import { MissionRoundProgress } from "./MissionRoundProgress";

const feedback = { id: "feedback-1", seq: 1, missionId: "mission", field: "outcome", kind: "suggestion", authorId: "legacy-member", authorName: "历史成员", body: "让结果可核验", quote: null, proposed: "与团队完成共同核验", original: "形成可核验结果", sourceVersion: 1, basis: "draft", late: false, round: 1, createdAt: "2026-10-02T02:00:00.000Z", verdict: { text: "历史修改建议", tone: "wait" }, decision: null,
  actions: [{ actionId: "obsolete-decide", actionType: "mission-round.decide", label: "处理意见" }], acceptBlockedReason: null } as unknown as TPersonalMissionCardPayload["feedback"][number];
const payload = { ...personalPayload, round: { ...personalPayload.round, phase: "reviewing" }, feedback: [feedback] } as TPersonalMissionCardPayload;
const controls = { onQuote: vi.fn(), onPropose: vi.fn(), onSelect: vi.fn(), onDecide: vi.fn() };
beforeEach(() => { ui.cursor = 0; ui.mode = "document"; ui.records = false; ui.buttons.clear(); vi.clearAllMocks(); });

function document(data = payload, records = false) {
  ui.cursor = 0; ui.mode = "document"; ui.records = records;
  return renderToStaticMarkup(<CardDocument payload={data} controls={controls} />);
}
function progress(round: TMissionRoundSummary) {
  ui.cursor = 0; ui.mode = "progress";
  return renderToStaticMarkup(<MissionRoundProgress round={round} entry="ceo" onNavigate={vi.fn()} onRefresh={vi.fn()} />);
}

describe("历史意见保留阅读，正文保持清洁", () => {
  it("正常阅读只显示最新版正文与记录入口，历史建议不常驻字段下方", () => {
    const html = document();
    expect(html).toContain("形成可核验结果"); expect(html).toContain("批注与记录");
    expect(html).not.toContain("与团队完成共同核验"); expect(html).not.toContain("历史成员");
    expect(html).not.toContain("<del>"); expect(html).not.toContain("<ins>");
  });
  it("展开后保留原文、建议、作者、版本与字段出处，旧action也不恢复采纳控件", () => {
    const html = document(payload, true);
    expect(html).toContain("历史意见 · 1"); expect(html).toContain("历史成员");
    expect(html).toContain("白田田的卡 · 战役结果"); expect(html).toContain("对照草稿 v1");
    expect(html).toContain("形成可核验结果"); expect(html).toContain("与团队完成共同核验");
    expect(html).toContain('id="feedback-feedback-1"'); expect(html).toContain("让结果可核验");
    expect(html).not.toContain(">采纳修改</button>"); expect(html).not.toContain(">不采纳</button>");
    expect(html).not.toContain("<del>"); expect(html).not.toContain("<ins>");
  });
  it.each([false, true])("历史已处理结论保留，参与者/上级均不能在历史记录中再次改判：上级=%s", (approver) => {
    const html = document({ ...payload, round: { ...payload.round, approver }, feedback: [{ ...feedback, decision: "decline", verdict: { text: "原意见未采纳", tone: "wait" } }] }, true);
    expect(html).toContain("原意见未采纳"); expect(html).toContain("与团队完成共同核验");
    expect(ui.buttons.has("已纳入核对")).toBe(false); expect(ui.buttons.has("采纳修改")).toBe(false);
    expect(ui.buttons.has("不采纳")).toBe(false); expect(controls.onDecide).not.toHaveBeenCalled();
  });
});

describe("Co-Agent 统一核对报告", () => {
  const report = { status: "completed" as const, summary: "两张任务共同覆盖本月目标，交付依赖仍需核对。", completedAt: "2026-10-02T02:00:00Z", error: null, retryAction: null,
    findings: [{ kind: "question" as const, title: "两人的交付时间是否一致", body: "请战场 DRI 确认交付接口与时间。", sources: [{ cardId: "card", missionId: "mission", field: "outcome" as const, version: 3, quote: "形成可核验结果" }] }] };
  it("报告展示真实语义结论及可展开的具体依据，避免用规则计数冒充核对", () => {
    const html = progress({ ...personalPayload.round, phase: "reviewing", coAgentReview: report });
    expect(html).toContain("Co-Agent 核对报告"); expect(html).toContain(report.summary);
    expect(html).toContain("两人的交付时间是否一致"); expect(html).toContain("请战场 DRI 确认交付接口与时间。");
    expect(html).toContain("查看依据"); expect(html).toContain("白田田 · 战役结果 · v3"); expect(html).toContain("形成可核验结果");
    expect(html).not.toContain("规则汇总 · 未做语义判断"); expect(html).not.toContain("从第一条开始");
    expect(html).not.toContain("开始汇总"); expect(html).not.toContain("重新开放讨论");
  });
  it.each(["queued", "running"] as const)("%s 清楚标示统一核对尚在执行，不给出假完成结论", (status) => {
    const html = progress({ ...personalPayload.round, phase: "reviewing", coAgentReview: { ...report, status, summary: "", findings: [] } });
    expect(html).toContain("Co-Agent 正在统一核对"); expect(html).not.toContain("完成后交战场 DRI 确认");
    expect(html).not.toContain(report.summary); expect(html).not.toContain("确认任务组合</button>");
  });
  it("失败保留真实错误和可授权重试，未完成前不会出现组合确认", () => {
    const html = progress({ ...personalPayload.round, phase: "reviewing", coAgentReview: { ...report, status: "failed", summary: "", findings: [], error: "核对依据缺失，请补齐后重试", retryAction: { actionId: "retry", actionType: "mission-round.review-retry", label: "重试核对" } } });
    expect(html).toContain("Co-Agent 核对未完成"); expect(html).toContain("核对依据缺失，请补齐后重试");
    expect(ui.buttons.has("重试 Co-Agent 核对")).toBe(true); expect(ui.buttons.has("确认任务组合")).toBe(false);
  });
});
