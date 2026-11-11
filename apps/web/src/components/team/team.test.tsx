import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TRoleProposalView, TRoleView, TTaskCard, TTaskView } from "@warmap/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/me/team" }));

import { boardCards, isAgentCard, type CardItem } from "@/lib/board/cards";
import { cardRole, modelForTier } from "@/lib/team/roles";
import { KanbanCard } from "@/components/board/KanbanCard";
import { ReviewDoc, isReview, reviewText, splitSections } from "@/components/topics/Review";
import { Diff, Proposals, changedFields } from "@/components/home/pages/RolesPage";

const base: Omit<TTaskView, "card"> = {
  id: "c1", version: 1, title: "把看板接上", status: "not_started", source: "self", startDate: null, dueDate: null, doneDefinition: "做完", mission: null, waitingOn: null,
  owner: { personId: "p1", name: "孙铭泽" }, collaborators: [], latestProgress: null, returnReason: null, origin: null, awaitingAcceptance: false, planTaskId: "t1", blocker: null,
  createdAt: "2026-11-06T01:00:00Z", updatedAt: "2026-11-06T01:00:00Z",
};
const facet: TTaskCard = { stage: "todo", wait: null, executor: "claude_code", role: null, model: null, criterion: null, run: null, handback: null, deliverable: null, after: [], sourceWords: [] };
const RID = "00000000-0000-4000-8000-000000000001";

describe("技能页", () => {
  const proposal: TRoleProposalView = {
    id: "00000000-0000-4000-8000-000000000002", role: { id: RID, name: "开发", kind: "worker" }, baseVersion: 3, sourceKind: "overrule",
    handbackId: "00000000-0000-4000-8000-000000000003", card: { id: "c9", title: "接本机" }, field: "practiceMd",
    currentText: "- 先读代码\n- 写完跑测试", proposedText: "- 先读代码\n- 写完跑测试\n- 交回前列出每条标准的证据", why: "验收被推翻：没有能核对的证据",
    status: "open", createdAt: "2026-11-06T01:00:00Z", decidedAt: null,
  };

  it("待你确认：每条有采纳、不要，写明哪个技能、哪一段、为什么、因为哪张卡", () => {
    const html = renderToStaticMarkup(<Proposals proposals={[proposal]} go={vi.fn()} onDecided={vi.fn()} />);
    for (const text of ["待你确认", "开发", "做法", "验收被推翻：没有能核对的证据", "接本机", "采纳", "不要", "看改动"]) expect(html).toContain(text);
  });

  it("改前改后：删掉的行标红、加的行标绿", () => {
    const html = renderToStaticMarkup(<Diff before={"一\n二"} after={"一\n三"} />);
    expect(html).toContain('<span data-change="del">二</span>');
    expect(html).toContain('<span data-change="add">三</span>');
    expect(html).toContain("<span>一</span>");
  });

  it("保存只带改了的字段", () => {
    const role: TRoleView = { id: RID, presetKey: null, presetVersion: null, name: "开发", family: "dev", kind: "worker", dutiesMd: "a", practiceMd: "b", acceptanceMd: "c",
      tools: ["github"], modelTier: "strong", version: 3, updatedAt: "2026-11-06T01:00:00Z", updatedBy: null };
    expect(changedFields(role, { name: "开发", dutiesMd: "a", practiceMd: "b", acceptanceMd: "c", tools: ["github"], modelTier: "strong" })).toBeNull();
    expect(changedFields(role, { name: " 开发 ", dutiesMd: "a", practiceMd: "b2", acceptanceMd: "c", tools: ["github", "tianshu"], modelTier: "normal" }))
      .toEqual({ version: 3, practiceMd: "b2", tools: ["tianshu", "github"], modelTier: "normal" });
  });
});

describe("卡上写技能名", () => {
  /** 看得见的字（去掉图标的读屏标签）。 */
  const text = (markup: string) => markup.replace(/aria-label="[^"]*"/g, "");
  it("配了技能的卡写技能名，不写执行方；没配技能不写", () => {
    const withRole: CardItem = { ...base, card: { ...facet, role: { id: RID, name: "调研员", kind: "worker" } } };
    const html = text(renderToStaticMarkup(<KanbanCard card={boardCards([withRole])[0]!} canStart={false} elsewhere={null} onStart={vi.fn()} now={0} />));
    expect(cardRole(withRole)).toEqual({ id: RID, name: "调研员", kind: "worker" });
    expect(html).toContain("调研员");
    expect(html).not.toContain("Claude Code");
    expect(html).not.toContain("我自己");
    const self: CardItem = { ...base, id: "c2", card: { ...facet, executor: "self" } };
    expect(isAgentCard(self)).toBe(false);
    expect(text(renderToStaticMarkup(<KanbanCard card={boardCards([self])[0]!} canStart={false} elsewhere={null} onStart={vi.fn()} now={0} />))).not.toContain("我自己");
  });

  const SUB = { provider: "claude-subscription", label: "Claude 订阅", via: null };
  const TH = { provider: "tokenhub", label: "TokenHub", via: null };
  const profile = (id: string, model: string | null, origin: typeof SUB, isDefault = false, extra: { sourceId?: string } = {}) =>
    ({ id, model, label: id, isDefault, agent: "claude-code" as const, source: origin === SUB ? ("subscription" as const) : ("gateway" as const), origin, ...extra });

  it("开始时的模型默认按技能档位：强 Opus、中 Sonnet、轻 Haiku（在默认那个来源里），认不出用默认", () => {
    const models = [profile("subscription", null, SUB, true), profile("o", "opus", SUB), profile("s", "sonnet", SUB), profile("h", "haiku", SUB)];
    expect(modelForTier(models, "strong")?.id).toBe("o");
    expect(modelForTier(models, "normal")?.id).toBe("s");
    expect(modelForTier(models, "light")?.id).toBe("h");
    expect(modelForTier(models.slice(0, 1), "strong")?.id).toBe("subscription");
  });

  it("「自动」只在默认来源里挑（11/11 定 A）：连了 TokenHub、默认是订阅时不挑 TokenHub 的；默认设成 TokenHub 的就在它那几条里挑", () => {
    const th = [profile("th-opus", "wangsu/claude-opus-5-5", TH), profile("th-sonnet", "wangsu/claude-sonnet-5-5", TH), profile("th-flash", "wangsu/deepseek-v4.1-flash", TH)];
    const subDefault = [profile("subscription", null, SUB, true), ...th];
    expect(modelForTier(subDefault, "strong")?.id).toBe("subscription");
    expect(modelForTier(subDefault, "light")?.id).toBe("subscription");
    const thDefault = [profile("subscription", null, SUB), ...th.map((m) => (m.id === "th-sonnet" ? { ...m, isDefault: true } : m))];
    expect(modelForTier(thDefault, "strong")?.id).toBe("th-opus");
    expect(modelForTier(thDefault, "light")?.id).toBe("th-flash");
    expect(modelForTier(thDefault.filter((m) => m.id !== "th-flash"), "light")?.id).toBe("th-sonnet"); // 认不出轻档：默认那条
    // 添加来源建的（带 sourceId）按来源分：同一家的两个来源不混
    const kimi = { provider: "kimi", label: "Kimi API", via: null };
    const two = [profile("a", "kimi-k3.1-pro", kimi as typeof SUB, true, { sourceId: "kimi-api-cn" }), profile("b", "kimi-k3.1-opus", kimi as typeof SUB, false, { sourceId: "kimi-coding_plan-cn" })];
    expect(modelForTier(two, "strong")?.id).toBe("a");
  });
});

describe("专题的评审会", () => {
  it("「评审」那一版按分歧和建议排版", () => {
    const body = "## 分歧\n- 反方：样本太少\n\n## 建议\n1. 补两家对标";
    expect(isReview({ kind: "review" })).toBe(true);
    expect(isReview({ kind: "draft" })).toBe(false);
    expect(splitSections(body)).toEqual([{ title: "分歧", text: "- 反方：样本太少" }, { title: "建议", text: "1. 补两家对标" }]);
    const html = renderToStaticMarkup(<ReviewDoc body={body} />);
    expect(html).toContain("分歧和建议");
    expect(html).toContain('data-kind="split"');
    expect(html).toContain('data-kind="advice"');
    expect(html).toContain("样本太少");
  });
  it("评审会写明这次请的挑刺技能", () => {
    expect(reviewText(["反方", "读者视角"])).toContain("「反方」、「读者视角」");
  });
});
