import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { HomeBoard } from "./HomeBoard";

function card(kind: string, id: string, title: string, payload: unknown): Card {
  return { schemaVersion: 1, id: `${kind}:${id}`, version: 1, kind, objectRef: { type: kind, id, version: 1 }, title, payload, actions: [] } as unknown as Card;
}

const capability = card("capability", "供应链能力", "供应链能力", {
  capabilityId: "供应链能力",
  name: "供应链能力",
  group: "交付组织",
  description: "把关键器件从寻源到交付串成一条线",
});

const derivedIssue = card("issue", "issue-1", "是否自建渠道", {
  origin: "ceo",
  originRef: null,
  status: "pending",
  location: { level: "capability", capabilityId: "供应链能力" },
  urgency: { level: "gray" },
  research: { status: "pending" },
  receipts: [],
  dismissedAt: null,
  dismissReason: null,
});

/** W5：注册能力分组 ∪ Issue 派生分组，同名分组合并。 */
describe("首页公司能力面板", () => {
  it("注册能力即使还没有 Issue 也出现在面板里", () => {
    const html = renderToStaticMarkup(<HomeBoard cards={[capability]} onCard={() => undefined} onNavigate={() => undefined} />);
    expect(html).toContain('data-capability-category="供应链能力"');
    expect(html).toContain("交付组织");
    expect(html).toContain("暂无待决策议题");
  });

  it("同名注册分组与 Issue 派生分组合并成一组，Issue 落在该组内", () => {
    const html = renderToStaticMarkup(<HomeBoard cards={[capability, derivedIssue]} onCard={() => undefined} onNavigate={() => undefined} />);
    expect(html.match(/data-capability-category="供应链能力"/g)).toHaveLength(1);
    expect(html).toContain("是否自建渠道");
    expect(html).not.toContain("暂无待决策议题");
  });
});
