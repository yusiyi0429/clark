import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { MonthlyPlanCard } from "./MonthlyPlanCard";

// useCardAction 需要 Next 路由上下文；这里只渲染静态标记。
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

function planCard(payloadOverrides: Record<string, unknown>, actions: Card["actions"] = []): Card {
  return {
    schemaVersion: 1,
    id: "monthly-plan:2026-09",
    version: 1,
    kind: "monthly-plan",
    objectRef: { type: "monthly-plan", id: "2026-09", version: 1 },
    title: "2026-09 月度计划",
    payload: {
      period: "2026-09",
      status: "confirmed",
      companyOutcome: "守住毛利，东南亚渠道跑通首单",
      battlefields: [],
      todos: [],
      exports: [],
      negotiation: { edits: [], checkedItemIds: ["company"], note: "", feedback: [] },
      generation: { status: "ready", error: null },
      confirmedAt: "2026-09-16T07:47:27.000Z",
      ...payloadOverrides,
    },
    actions,
  } as unknown as Card;
}

function render(card: Card): string {
  return renderToStaticMarkup(
    <MonthlyPlanCard card={card} collection={[card]} onCard={() => undefined} onNavigate={() => undefined} />,
  );
}

describe("月度计划 · 已签发", () => {
  it("Header 只两段眉标，签发回执为卡，且不出现签发/保存按钮", () => {
    const html = render(planCard({}));
    expect(html).toContain("已签发 · 2026-09-16");
    expect(html).not.toContain("草案已就绪");
    expect(html).toContain("本计划已签发，是当月目标的唯一来源。");
    expect(html).toContain("签发于 2026-09-16");
    // 已签发是只读终态：服务端不下发 update_draft/sign 时不得渲染任何提交入口。
    expect(html).not.toContain("保存计划");
    expect(html).not.toContain("签发计划");
  });

  it("协商中眉标回落到草案生成状态，不伪装成已签发", () => {
    const html = render(planCard({ status: "negotiating", confirmedAt: null, generation: { status: "ready", error: null } }));
    expect(html).toContain("协商中 · 草案已就绪");
    expect(html).not.toContain("已签发");
  });
});

describe("月度计划 · 正文两列", () => {
  it("公司结果与待办反馈各自成卡，待办渲染序号、战场徽标与三字段", () => {
    const html = render(
      planCard(
        {
          status: "negotiating",
          confirmedAt: null,
          todos: [{ id: "t1", battlefieldId: "growth", title: "跑通首单", ownerId: "p1", dueAt: "2026-09-30", sourceRef: "issue:9" }],
          negotiation: {
            edits: [],
            checkedItemIds: [],
            note: "九月不再开新战场",
            feedback: [{ id: "f1", battlefieldId: "growth", todoId: "t1", text: "首单口径需要先对齐", observedAt: "2026-09-12T03:20:00.000Z" }],
          },
        },
        [{ actionId: "a1", actionType: "monthly-plan.update_draft", label: "保存计划" }],
      ),
    );
    for (const title of ["公司结果", "普通待办", "DRI 反馈", "备注"]) expect(html).toContain(title);
    expect(html).toContain("01");
    expect(html).toContain("growth");
    expect(html).toContain("负责人（personId）");
    expect(html).toContain("可选截止");
    expect(html).toContain("来源：issue:9");
    expect(html).toContain("首单口径需要先对齐");
    expect(html).toContain("2026-09-12 03:20");
    expect(html).toContain("九月不再开新战场");
    // 只有服务端下发的 Action 才渲染按钮。
    expect(html).toContain("保存计划");
    expect(html).not.toContain("签发计划");
  });
});
