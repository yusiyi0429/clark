import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { HomeBoard } from "./HomeBoard";

function card(kind: string, id: string, title: string, payload: unknown): Card {
  return { schemaVersion: 1, id: `${kind}:${id}`, version: 1, kind, objectRef: { type: kind, id, version: 1 }, title, payload, actions: [] } as unknown as Card;
}

const capability = (id: string, name: string, group: string, sortOrder: number) =>
  card("capability", id, name, { capabilityId: id, code: "", sortOrder, name, group, sixMonthOutcome: `${name}的六个月目标`, supportRefs: [] });

const issue = (id: string, title: string, capabilityId: string) =>
  card("issue", id, title, {
    origin: "ceo",
    originRef: null,
    status: "pending",
    location: { level: "capability", capabilityId },
    urgency: { level: "gray" },
    research: { status: "pending" },
    receipts: [],
    dismissedAt: null,
    dismissReason: null,
  });

const render = (cards: Card[]) => renderToStaticMarkup(<HomeBoard cards={cards} onCard={() => undefined} onNavigate={() => undefined} />);

const mission = (id: string, capabilityId: string) => card("mission", id, id, { missionId: id, capabilityId, battlefieldIds: [] });

/** SSOT CEO-01：「公司能力」首页卡与战场卡同样是普通卡片，只列有议题的能力域；能力域本身在点进去的详情里。 */
describe("首页公司能力卡", () => {
  it("标题点进公司能力详情；没有能力建设议题时只显示空态，不列能力域、Mission 入口或目标", () => {
    const html = render([capability("cap-delivery", "区域仓配服务", "交付", 20), mission("m1", "cap-delivery")]);
    expect(html).toContain("公司能力");
    expect(html).toContain('data-origin="/capabilities"');
    expect(html).not.toContain("区域仓配服务");
    expect(html).not.toContain("Missions · ");
    expect(html).not.toContain("区域仓配服务的六个月目标");
    // 两个空态：公司战略议题与公司能力。
    expect(html.match(/暂无待决策议题/g)).toHaveLength(2);
  });

  it("只列有议题的能力域并按排序；议题落在所属能力域下，未登记能力的议题归入末尾「其他」", () => {
    const html = render([
      capability("cap-delivery", "区域仓配服务", "交付", 20),
      capability("cap-agent", "Agent 安全基线", "技术", 10),
      capability("cap-quiet", "没有议题的能力域", "综合", 5),
      issue("i1", "是否自建渠道", "cap-delivery"),
      issue("i2", "是否开放写权限", "cap-agent"),
      issue("i3", "新能力域待登记", "cap-unknown"),
    ]);
    expect(html).not.toContain("没有议题的能力域");
    expect(html.indexOf('data-capability-category="cap-agent"')).toBeLessThan(html.indexOf('data-capability-category="cap-delivery"'));
    expect(html.indexOf('data-capability-category="cap-delivery"')).toBeLessThan(html.indexOf('data-capability-category="other"'));
    expect(html.indexOf("是否开放写权限")).toBeLessThan(html.indexOf("是否自建渠道"));
    expect(html).toContain("新能力域待登记");
    expect(html).not.toContain("Missions · ");
    // 能力卡有议题时不落空态。
    expect(html.match(/暂无待决策议题/g)).toHaveLength(1);
  });

  it("首页战场工具条不再放 Mission 入口（1 号位不从这里看 Mission；Mission 在战场卡与公司能力详情里）", () => {
    const html = render([mission("lhr-a", "cap-delivery")]);
    expect(html).not.toContain("个 Mission");
    expect(html).not.toContain('data-origin="/missions"');
  });
});
