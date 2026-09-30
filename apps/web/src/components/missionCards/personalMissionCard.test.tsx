import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { TMonthPlanResponse, TPersonalMissionCardPayload } from "@warmap/contracts";
vi.mock("ts-design/primitives", () => ({ Button: ({ children, isDisabled, onPress: _onPress, isIconOnly: _icon, ...props }: { children?: ReactNode; isDisabled?: boolean; onPress?: unknown; isIconOnly?: boolean }) => <button disabled={isDisabled} {...props}>{children}</button> }));
import { CardDocument, FeedbackNote, missionFieldText, selectedFieldQuote } from "./CardDocument";
import { RoundClock, roundClockText } from "./RoundClock";

import { personalPayload } from "./personalMissionFixture";
const controls = { onQuote: vi.fn(), onPropose: vi.fn(), onSelect: vi.fn() };
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("任务卡正文的阶段与追溯", () => {
  it("他人的历史待改批注只保留记录，不冒充本人当前正在进行的修改", () => {
    const note = { id: "legacy-note", cardId: "card", missionId: "mission", field: "outcome" as const, sourceVersion: 1,
      sourceText: "形成可核验结果", quote: "核验", prefix: "形成可", suffix: "结果", startOffset: 3, body: "他人的历史意见",
      authorId: "peer", authorName: "历史成员", status: "queued" as const, intent: "edit" as const, question: null, options: [], answer: null,
      note: null, appliedVersion: null, canAnswer: false, canRetry: false, canResolve: false, clarifications: [], stale: false, createdAt: "2026-10-01T00:00:00Z" };
    const annotations = { notes: [note], revisions: [], onSave: vi.fn(), onAnswer: vi.fn(), onRetry: vi.fn() };
    const html = renderToStaticMarkup(<CardDocument payload={personalPayload} controls={{ ...controls, annotations }} viewerId="owner" />);
    expect(html).toContain("批注与记录"); expect(html).toContain("查看此处批注与修改记录");
    expect(html).not.toContain("Co-Agent 正在审阅这条批注"); expect(html).not.toContain("保留备注，暂不修改");
    const own = renderToStaticMarkup(<CardDocument payload={personalPayload} controls={{ ...controls, annotations: { ...annotations, notes: [{ ...note, authorId: "owner" }] } }} viewerId="owner" />);
    expect(own).toContain("Co-Agent 正在审阅这条批注");
  });
  it("正文移除视图页签，任务细节仍可打开已有执行事项", () => {
    const linked = { id: "task-1", title: "完成核对", status: "in_progress", dueDate: "2026-10-12", owner: { personId: "owner", name: "白田田" }, collaborators: [{ personId: "peer", name: "同事" }], mission: { missionId: "mission", title: "完善方法闭环", step: 1, steps: 1 } };
    const plan = { groups: [{ missionId: "mission", items: [linked] }] } as TMonthPlanResponse;
    const ownerPlan = { selected: false, onSelect: vi.fn(), plan, content: <p>计划网格</p>, loading: false, error: "" };
    const html = renderToStaticMarkup(<CardDocument payload={personalPayload} controls={controls} ownerPlan={ownerPlan} />);
    expect(html).toContain("任务细节");
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain("执行拆分");
    expect(html).not.toContain("本月计划");
    expect(html).toContain("/me/tasks/task-1");
    expect(html).toContain("完成核对");
    expect(html).toContain("10/12 前");
    expect(html).toContain("白田田、同事");
    expect(renderToStaticMarkup(<CardDocument payload={personalPayload} controls={controls} />)).not.toContain("本月计划");
  });
  it.each(["drafting", "draft", "open", "closed", "reviewing", "confirmed"] as const)("%s 阶段不提供给他人修改本人任务的公开建议入口", (phase) => {
    const html = renderToStaticMarkup(<CardDocument payload={{ ...personalPayload, round: { ...personalPayload.round, phase } }} controls={controls} />);
    expect(html).not.toContain(">建议修改<");
    expect(html).not.toContain("引用并评论");
    expect(html).not.toContain("引用到群组");
    expect(html).toContain("唯一责任人");
    expect(html).toContain("占位");
    expect(html).not.toContain("飞书 r9");
    expect(html).not.toContain("下载原件");
    expect(html).not.toContain("未报告");
  });
  it("正式字段依次解释时间、结果与验收，再展示路径和取舍", () => {
    const html = renderToStaticMarkup(<CardDocument payload={personalPayload} controls={controls} />);
    const labels = ["时间边界", "战役结果", "贡献 / 存在必要性", "成功 / 验收标准", "责任边界", "核心路径", "关键取舍", "关键约束与依赖", "里程碑", "资源与权限", "人-Agent 分工", "风险与升级", "复盘沉淀"];
    const positions = labels.map((label) => html.indexOf(`aria-label="${label}"`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(html).toContain("10 月内完成团队核验");
    expect(html).toContain("本月优先验证方法闭环");
  });
  it("本人审核通过Agent修改，避免自己给自己提交公开建议；完成后冻结所有建议入口", () => {
    const mine = renderToStaticMarkup(<CardDocument payload={personalPayload} controls={controls} viewerId="owner" />);
    expect(mine).not.toContain(">建议修改<");
    expect(mine).toContain("形成可核验结果");
    const frozen = { ...personalPayload, card: { ...personalPayload.card, ownerConfirmedAt: "2026-10-01T02:00:00Z" }, annotationAccess: { canCreate: false, canApply: false, closedReason: "已完成审核，取消确认后可继续修改。" } };
    const html = renderToStaticMarkup(<CardDocument payload={frozen} controls={controls} viewerId="other" />);
    expect(html).not.toContain(">建议修改<");
    expect(html).toContain("取消确认后可继续修改");
    expect(html).toContain("形成可核验结果");
  });
  it("修改后的正文不堆叠修改标签，空补充项仍然保留并显示待明确", () => {
    const mission = { ...personalPayload.card.missions[0], resources: "", selfEditedFields: ["outcome", "resources"] as const };
    const html = renderToStaticMarkup(<CardDocument payload={{ ...personalPayload, card: { ...personalPayload.card, missions: [{ ...mission, selfEditedFields: [...mission.selfEditedFields] }] } }} controls={controls} />);
    expect(html).not.toContain(">本人已修改<");
    expect(html).toContain('aria-label="资源与权限"');
    expect(html).toContain("待明确");
  });
  it("列表按原文连接，历史缺失核心字段标注待明确，空补充项省略", () => {
    expect(missionFieldText(personalPayload.card.missions[0], "successEvidence")).toBe("证据一\n证据二");
    // 旧卡在新契约出现前没有 timeBoundary；这里故意使用旧响应形状验证阅读兼容。
    const mission = { ...personalPayload.card.missions[0], timeBoundary: undefined, tradeoffs: "", successEvidence: [], resources: "", humanAgentSplit: "", risk: "", retrospect: "" } as unknown as typeof personalPayload.card.missions[number];
    expect(missionFieldText(mission, "timeBoundary")).toBe("");
    const html = renderToStaticMarkup(<CardDocument payload={{ ...personalPayload, card: { ...personalPayload.card, missions: [mission] } }} controls={controls} />);
    expect((html.match(/>待明确</g) ?? []).length).toBe(3);
    expect(html).toContain('aria-label="时间边界"');
    expect(html).toContain('aria-label="关键取舍"');
    expect(html).not.toContain('aria-label="资源与权限"');
    expect(html).not.toContain('aria-label="人-Agent 分工"');
    expect(html).not.toContain('aria-label="风险与升级"');
    expect(html).not.toContain('aria-label="复盘沉淀"');
    expect(html).not.toContain("10 月内完成团队核验");
  });
  it("历史意见收进记录入口，展开后的历史仍保留原文/版本/作者与服务端判定", () => {
    const feedback = { id: "feedback", seq: 1, missionId: "mission", field: "outcome", kind: "suggestion", authorId: "owner", authorName: "白田田", body: "建议修改「预期结果」", quote: null, proposed: "新的结果", original: "提交那一刻的原文", sourceVersion: 1, basis: "draft", late: false, round: 1, createdAt: "2026-10-01T02:00:00.000Z", verdict: { text: "待拍板人处理", tone: "wait" }, decision: null, acceptBlockedReason: null, actions: [] } as TPersonalMissionCardPayload["feedback"][number];
    const html = renderToStaticMarkup(<CardDocument payload={{ ...personalPayload, feedback: [feedback, { ...feedback, id: "loose", kind: "comment", missionId: null, field: null, proposed: null, original: null }] }} controls={controls} />);
    expect(html).toContain("批注与记录");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("提交那一刻的原文");
    expect(html).not.toContain("整张卡上的意见");
    const history = renderToStaticMarkup(<FeedbackNote item={feedback} location="历史意见" />);
    expect(history).toContain("提交那一刻的原文");
    expect(history).toContain("草稿 v1");
    expect(history).toContain("白田田");
    expect(history).toContain("待拍板人处理");
    expect(history).not.toContain("<del");
    expect(history).not.toContain("<ins");
  });
  it("空补充字段已有意见时保留字段和追溯原文", () => {
    const feedback = { id: "resource-note", seq: 1, missionId: "mission", field: "resources", kind: "suggestion", authorId: "owner", authorName: "白田田", body: "补充评审资源", quote: null, proposed: "一小时评审", original: "原有资源安排", sourceVersion: 1, basis: "draft", late: false, round: 1, createdAt: "2026-10-01T02:00:00.000Z", verdict: { text: "待拍板人处理", tone: "wait" }, decision: null, acceptBlockedReason: null, actions: [] } as TPersonalMissionCardPayload["feedback"][number];
    const mission = { ...personalPayload.card.missions[0], resources: "" };
    const html = renderToStaticMarkup(<CardDocument payload={{ ...personalPayload, feedback: [feedback], card: { ...personalPayload.card, missions: [mission] } }} controls={controls} />);
    expect(html).toContain('aria-label="资源与权限"');
    expect(html).toContain("批注与记录");
    expect(html).not.toContain("原有资源安排");
    expect(html).not.toContain("补充评审资源");
    const history = renderToStaticMarkup(<FeedbackNote item={feedback} />);
    expect(history).toContain("原有资源安排");
    expect(history).toContain("补充评审资源");
    const changedMission = { ...mission, changedFields: ["resources" as const] };
    const changed = renderToStaticMarkup(<CardDocument payload={{ ...personalPayload, card: { ...personalPayload.card, missions: [changedMission] } }} controls={controls} />);
    expect(changed).toContain('aria-label="资源与权限"');
    expect(changed).not.toContain("已采纳修改");
  });
  it("划词必须完整位于同一字段，不带走跨字段选择", () => {
    const inside = {} as Node, outside = {} as Node;
    const node = { contains: (candidate: Node) => candidate === inside } as HTMLElement;
    expect(selectedFieldQuote(node, { anchorNode: inside, focusNode: inside, toString: () => "  一句引用  " })).toBe("一句引用");
    expect(selectedFieldQuote(node, { anchorNode: inside, focusNode: outside, toString: () => "跨字段" })).toBeNull();
  });
});

describe("任务起草来源与本人确认倒计时", () => {
  it("Agent 来源逐任务展示起草依据，失败卡显式标占位", () => {
    const mission = { ...personalPayload.card.missions[0], sourceRef: "mission-card-agent://round/owner", sourceTitle: "起草依据：签发的本月计划", placeholder: false };
    const payload = { ...personalPayload, round: { ...personalPayload.round, draftOrigin: "agent" as const, placeholder: false, cards: [{ ...personalPayload.round.cards[0], placeholder: false }] },
      card: { ...personalPayload.card, missions: [mission] } };
    const html = renderToStaticMarkup(<CardDocument payload={payload} controls={controls} />);
    expect(html).not.toContain("Co-Agent 起草 · 待大家讨论修改");
    expect(html).not.toContain("起草依据：签发的本月计划");
    expect(html).not.toContain("打开来源");
    const fallback = renderToStaticMarkup(<CardDocument payload={{ ...payload, round: { ...payload.round, cards: [{ ...payload.round.cards[0], placeholder: true }] } }} controls={controls} />);
    expect(fallback).not.toContain("打开来源");
  });
  it.each([[48 * 60, "48 小时 0 分"], [31 * 60 + 24, "31 小时 24 分"], [42, "42 分"], [0.5, "不到 1 分"], [0, "本人确认时间已到"], [-1, "本人确认时间已到"]])("剩余 %s 分钟写作 %s", (minutes, text) => {
    const now = Date.parse(personalPayload.round.closesAt!) - Number(minutes) * 60_000;
    expect(roundClockText(personalPayload.round, now)).toBe(text);
  });
  it("未下发显示准备状态，提前进入组合核对不误示时间已到", () => {
    expect(roundClockText({ ...personalPayload.round, phase: "draft" }, 0)).toBe("待下发本人确认");
    expect(roundClockText({ ...personalPayload.round, phase: "confirmed" }, 0)).toBe("已确定");
    expect(roundClockText({ ...personalPayload.round, phase: "reviewing", closesAt: "2026-10-03T00:00:00Z" }, Date.parse("2026-10-01T00:00:00Z"))).toBe("任务组合核对");
    const html = renderToStaticMarkup(<RoundClock round={{ ...personalPayload.round, round: 2 }} now={Date.parse(personalPayload.round.serverNow)} />);
    expect(html).not.toContain("第 2 轮");
    expect(html).toContain("截止于");
  });
});
