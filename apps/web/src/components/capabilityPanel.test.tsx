import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { HomeBoard } from "./HomeBoard";

function card(kind: string, id: string, title: string, payload: unknown): Card {
  return { schemaVersion: 1, id: `${kind}:${id}`, version: 1, kind, objectRef: { type: kind, id, version: 1 }, title, payload, actions: [] } as unknown as Card;
}

const capability = card("capability", "cap-delivery", "区域仓配服务", {
  capabilityId: "cap-delivery",
  code: "02",
  sortOrder: 20,
  name: "区域仓配服务",
  group: "交付组织",
  sixMonthOutcome: "覆盖三国本地仓的仓配与退货能力，形成可复制的交付节奏",
  supportRefs: [],
});

const earlyCapability = card("capability", "cap-agent", "Agent 安全基线", {
  capabilityId: "cap-agent",
  code: "01",
  sortOrder: 10,
  name: "Agent 安全基线",
  group: "平台能力",
  sixMonthOutcome: "权限限制、审批留痕与紧急停机全部可验证",
  supportRefs: [],
});

const derivedIssue = card("issue", "issue-1", "是否自建渠道", {
  origin: "ceo",
  originRef: null,
  status: "pending",
  location: { level: "capability", capabilityId: "cap-delivery" },
  urgency: { level: "gray" },
  research: { status: "pending" },
  receipts: [],
  dismissedAt: null,
  dismissReason: null,
});

/** W5：注册能力（按 sortOrder）∪ Issue 派生分组，同名分组合并。 */
describe("首页公司能力面板", () => {
  it("注册能力即使还没有 Issue 也出现在面板里，并展示编号/分组/六个月目标", () => {
    const html = renderToStaticMarkup(<HomeBoard cards={[capability]} onCard={() => undefined} onNavigate={() => undefined} />);
    expect(html).toContain('data-capability-category="cap-delivery"');
    expect(html).toContain("02");
    expect(html).toContain("区域仓配服务");
    expect(html).toContain("交付组织");
    expect(html).toContain("覆盖三国本地仓的仓配与退货能力，形成可复制的交付节奏");
    expect(html).toContain("暂无待决策议题");
  });

  it("按 sortOrder 排列，Issue 落在对应能力组内", () => {
    const html = renderToStaticMarkup(<HomeBoard cards={[capability, earlyCapability, derivedIssue]} onCard={() => undefined} onNavigate={() => undefined} />);
    expect(html.indexOf("Agent 安全基线")).toBeLessThan(html.indexOf("区域仓配服务"));
    expect(html.match(/data-capability-category="cap-delivery"/g)).toHaveLength(1);
    expect(html).toContain("是否自建渠道");
    // 只有没有 Issue 的 cap-agent 落到空态，Issue 确实落在 cap-delivery 组内
    expect(html.match(/暂无待决策议题/g)).toHaveLength(1);
  });
});
