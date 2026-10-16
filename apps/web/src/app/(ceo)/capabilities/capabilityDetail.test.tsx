import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { WorkspaceTestProvider } from "@/components/shell/testing";
import { CapabilityDetailScreen, capabilityDomains, supportLabels } from "./CapabilityDetailScreen";

function card(kind: string, id: string, title: string, payload: unknown): Card {
  return { schemaVersion: 1, id: `${kind}:${id}`, version: 1, kind, objectRef: { type: kind, id, version: 1 }, title, payload, actions: [] } as unknown as Card;
}

const capability = (id: string, code: string, name: string, sortOrder: number, supportRefs: unknown[] = []) =>
  card("capability", id, name, { capabilityId: id, code, sortOrder, name, group: "", sixMonthOutcome: `${name}的六个月目标`, supportRefs });

const battlefield = (id: string, name: string, missionAnchors: { code: string; title: string }[] = []) =>
  card("battlefield", id, name, { battlefieldId: id, name, missionAnchors });

const mission = (id: string, code: string, capabilityId: string, owner: string) =>
  card("mission", id, code, { missionId: id, code, title: `${code} 的标题`, capabilityId, ownerDisplayName: owner, battlefieldIds: [] });

const issue = (id: string, title: string, capabilityId: string) =>
  card("issue", id, title, {
    status: "pending",
    location: { level: "capability", capabilityId },
    urgency: { level: "gray" },
  });

const plan = (status: string, capabilities: { capabilityId: string; outcome: string }[]) => ({ period: "2026-09", status, capabilities });

const cards = [
  capability("agents", "04", "Agents", 40, [{ type: "mission-anchor", missionCode: "01-2" }]),
  capability("method", "03", "Method", 30, [{ type: "battlefield", battlefieldId: "lighthouse" }]),
  capability("finance", "09", "Finance", 90, [{ type: "all-battlefields" }]),
  battlefield("lighthouse", "灯塔项目", [{ code: "01-2", title: "CEO Agent 常态化使用" }]),
  mission("m1", "01-2", "agents", "刘人豪"),
  mission("m2", "01-3", "agents", "孙铭泽"),
  issue("i1", "是否开放写权限", "agents"),
];

const render = (planPayload: ReturnType<typeof plan> | null) =>
  renderToStaticMarkup(
    <WorkspaceTestProvider>
      <CapabilityDetailScreen cards={cards} plan={planPayload} />
    </WorkspaceTestProvider>,
  );

describe("公司能力详情", () => {
  it("支撑关系按资料解释：战役锚点写编号 + 标题，战场写名称，全战场照写", () => {
    const labels = (id: string) => supportLabels(cards.find((item) => item.objectRef.id === id)!, cards);
    expect(labels("agents")).toEqual([{ code: "01-2", name: "CEO Agent 常态化使用" }]);
    expect(labels("method")).toEqual([{ code: "战场", name: "灯塔项目" }]);
    expect(labels("finance")).toEqual([{ name: "全战场" }]);
  });

  it("能力域按排序列出，名下 Mission 与本月目标来自同一份资料", () => {
    const domains = capabilityDomains(cards, plan("confirmed", [{ capabilityId: "agents", outcome: "Agents 本月目标" }]));
    expect(domains.map((domain) => domain.name)).toEqual(["Method", "Agents", "Finance"]);
    const agents = domains.find((domain) => domain.id === "agents")!;
    expect(agents.missions.map((item) => item.code)).toEqual(["01-2", "01-3"]);
    expect(agents.monthly).toBe("Agents 本月目标");
  });

  it("先列议题再列能力域；六个月目标、本月目标、Mission 入口都在详情里", () => {
    const html = render(plan("confirmed", [{ capabilityId: "agents", outcome: "Agents 本月目标" }]));
    expect(html.indexOf("是否开放写权限")).toBeLessThan(html.indexOf("Agents的六个月目标"));
    expect(html).toContain("Agents 本月目标");
    expect(html).toContain("01-3 的标题");
    expect(html).toContain("孙铭泽");
    // 能力域没有登记 DRI：照实写，不编造。
    expect(html).toContain("负责人未登记");
    // 没写进本月计划的能力域照实说明。
    expect(html).toContain("本月计划没有写这个能力域");
  });

  it("月度计划未签发时标出状态；没有当月计划时写尚未制定", () => {
    expect(render(plan("negotiating", [{ capabilityId: "agents", outcome: "草案目标" }]))).toContain("本月目标 · 协商中");
    expect(render(null)).toContain("本月计划尚未制定");
  });
});
