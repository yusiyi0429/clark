import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import type { MonthlyPlanPayload } from "./payloads";
import { WorkspaceTestProvider } from "@/components/shell/testing";
import { MonthlyPlanCard, SignRecipients, monthlyDraftPatch, type MonthlyDraftState } from "./MonthlyPlanCard";

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
      capabilities: [],
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

/** 首页注册表：月度页用它把战场 / 能力的 id 写成名称。 */
const registry = [
  { kind: "battlefield", id: "battlefield:growth", title: "增长战场", payload: { battlefieldId: "growth" } },
  { kind: "capability", id: "capability:rearc", title: "Re-architecture", payload: { capabilityId: "re-architecture" } },
] as unknown as Card[];

function render(card: Card): string {
  return renderToStaticMarkup(
    <WorkspaceTestProvider api={{ homeCards: registry }}>
      <MonthlyPlanCard card={card} collection={[card]} onCard={() => undefined} onNavigate={() => undefined} />
    </WorkspaceTestProvider>,
  );
}

describe("月度计划 · 已签发", () => {
  it("页头：月度标记、月份与签发状态，关闭写明关闭月度计划；签发回执为卡，且不出现签发/保存按钮", () => {
    const html = render(planCard({}));
    expect(html).toContain("月度协商 · 2026 年 9 月 · 已签发 · 2026-09-16");
    expect(html).toContain('data-context-mark="monthly"');
    expect(html).toContain('aria-label="关闭月度计划"');
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

describe("月度计划 · 重新生成草案", () => {
  const action = [{ actionId: "regenerate", actionType: "monthly-plan.retry_draft", label: "重新生成草案" }];

  it("未签发且草案就绪时显示入口，签发后不显示", () => {
    expect(render(planCard({ status: "draft", confirmedAt: null }, action))).toContain("重新生成草案");
    expect(render(planCard({}, []))).not.toContain("重新生成草案");
  });

  it("失败时保留草案内容，只显示错误消息和重新生成入口", () => {
    const html = render(planCard({ status: "draft", confirmedAt: null, generation: { status: "failed", error: { code: "DRAFT_FAILED", message: "生成失败，请稍后再试" } } }, action));
    expect(html).toContain("守住毛利，东南亚渠道跑通首单");
    expect(html).toContain("生成失败，请稍后再试");
    expect(html).not.toContain("DRAFT_FAILED：");
    expect(html).toContain("重新生成草案");
  });

  it("草案早于复盘的 LTO 决定时提示一行并给出重新生成；签发后不提示", () => {
    const stale = { status: "negotiating", confirmedAt: null, generation: { status: "ready", error: null, beforeReview: true } };
    const html = render(planCard(stale, action));
    expect(html).toContain("草案生成于复盘之前");
    expect(html).toMatch(/role="note"><span>草案生成于复盘之前<\/span><button[^>]*>重新生成<\/button>/);
    expect(render(planCard({ ...stale, generation: { status: "ready", error: null } }, action))).not.toContain("草案生成于复盘之前");
    expect(render(planCard({ generation: { status: "ready", error: null, beforeReview: true } }))).not.toContain("草案生成于复盘之前");
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
    // 战场写名称，不打印原始 id；时间按公司时区。
    expect(html).toContain("增长战场");
    expect(html).not.toContain(">growth<");
    expect(html).toContain(">负责人<");
    // 反馈写待办标题，不打印待办 id。
    expect(html).toContain("待办 跑通首单");
    expect(html).not.toContain("待办 t1");
    expect(html).toContain("可选截止");
    expect(html).toContain("来源：issue:9");
    expect(html).toContain("首单口径需要先对齐");
    expect(html).toContain("9/12 11:20");
    expect(html).toContain("九月不再开新战场");
    // 只有服务端下发的 Action 才渲染按钮。
    expect(html).toContain("保存计划");
    expect(html).not.toContain("签发计划");
  });

  it("能力 PO 与公司/战场结果同构：按 capabilityId 渲染编辑区与核对项", () => {
    const html = render(
      planCard(
        {
          status: "negotiating",
          confirmedAt: null,
          capabilities: [{ capabilityId: "re-architecture", outcome: "九月跑通第一个客户交付" }],
          negotiation: { edits: [], checkedItemIds: [], note: "", feedback: [] },
        },
        [{ actionId: "a1", actionType: "monthly-plan.update_draft", label: "保存计划" }],
      ),
    );
    expect(html).toContain("Re-architecture · 能力 PO");
    expect(html).toContain("九月跑通第一个客户交付");
    expect(html).toContain("已核对 Re-architecture 能力 PO");
    expect(html).toContain("能力结果");
  });
});

describe("月度计划 · 保存只提交真正改动的字段", () => {
  function planPayload(): MonthlyPlanPayload {
    return planCard({
      status: "negotiating",
      confirmedAt: null,
      companyOutcome: "守住毛利",
      battlefields: [{ battlefieldId: "growth", outcome: "跑通首单" }],
      capabilities: [{ capabilityId: "Re-architecture", outcome: "第一个客户交付" }],
      todos: [{ id: "t1", title: "复核合同", ownerId: "p1", sourceRef: "issue:9" }],
      negotiation: {
        edits: [],
        checkedItemIds: ["company", "battlefield:growth", "capability:Re-architecture", "todo:t1"],
        note: "九月不再开新战场",
        feedback: [],
      },
    }).payload as MonthlyPlanPayload;
  }

  function draftOf(payload: MonthlyPlanPayload): MonthlyDraftState {
    return {
      companyOutcome: payload.companyOutcome,
      battlefields: payload.battlefields,
      capabilities: payload.capabilities,
      todos: payload.todos,
      note: payload.negotiation.note,
    };
  }

  it("内容未改动时补丁为空：已核对的四项不会被无关保存清空", () => {
    const payload = planPayload();
    expect(monthlyDraftPatch(payload, draftOf(payload))).toEqual({});
  });

  it("只改一个能力 PO 时只提交 capabilities，核对项仍由 checkbox Action 单独提交", () => {
    const payload = planPayload();
    const patch = monthlyDraftPatch(payload, {
      ...draftOf(payload),
      capabilities: [{ capabilityId: "Re-architecture", outcome: "改成第二个客户交付" }],
    });
    expect(Object.keys(patch)).toEqual(["capabilities"]);
    expect(patch).not.toHaveProperty("checkedItemIds");
  });

  it("备注改动也只提交 note", () => {
    const payload = planPayload();
    expect(Object.keys(monthlyDraftPatch(payload, { ...draftOf(payload), note: "新增一句" }))).toEqual(["note"]);
  });
});

describe("月度计划 · 签发确认名单", () => {
  it("按战场一行列出会拿到任务卡的人，月份取计划月份；名单为空的战场标出来，每行都能改参与者", () => {
    const html = renderToStaticMarkup(<SignRecipients month={10} onEdit={() => undefined} rows={[
      { battlefieldId: "01", name: "灯塔项目", people: ["白田田", "于斯一"] },
      { battlefieldId: "03", name: "002 客户", people: [] },
    ]} />);
    expect(html).toContain("签发后为这些人起草 10 月任务卡并直接发给本人");
    expect(html).toContain("灯塔项目");
    expect(html).toContain("白田田、于斯一");
    expect(html).toContain('data-empty="true">名单为空');
    expect(html.match(/改参与者/g)).toHaveLength(2);
  });

  it("读取中与读取失败照实说明，不拦签发", () => {
    expect(renderToStaticMarkup(<SignRecipients month={11} rows="loading" onEdit={() => undefined} />)).toContain("正在读取名单…");
    expect(renderToStaticMarkup(<SignRecipients month={11} rows="error" onEdit={() => undefined} />)).toContain("名单暂时读取失败");
  });
});
