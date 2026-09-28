import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { CeoGlance } from "./CeoGlance";

function card(kind: string, id: string, title: string, payload: unknown): Card {
  return { schemaVersion: 1, id: `${kind}:${id}`, version: 1, kind, objectRef: { type: kind, id, version: 1 }, title, payload, actions: [] } as unknown as Card;
}

const battlefield = (id: string, code: string, name: string, owner: string, pending: { id: string; urgency: string }[] = []) =>
  card("battlefield", id, name, { battlefieldId: id, code, name, ownerDisplayName: owner, pendingIssues: pending.map((issue) => ({ ...issue, title: issue.id, location: { level: "battlefield", battlefieldId: id } })) });

const issue = (id: string, title: string, location: unknown, urgency = "gray") =>
  card("issue", id, title, { origin: "ceo", originRef: null, status: "pending", location, urgency: { level: urgency }, research: { status: "pending" }, receipts: [], dismissedAt: null, dismissReason: null });

const radar = (unreadCount: number) => card("radar", "default", "Radar", { unreadCount, lastRun: null });
const capability = (id: string, name: string) => card("capability", id, name, { capabilityId: id, code: "03", sortOrder: 0, name, group: "", sixMonthOutcome: "", supportRefs: [] });

const render = (cards: Card[]) => renderToStaticMarkup(<CeoGlance cards={cards} onNavigate={() => undefined} />);

/** 手持首页的「公司全局」：每个战场一行、雷达一行；战略议题和能力议题有才出现，没有空卡。 */
describe("手持首页的公司全局", () => {
  it("每个战场一行：编号、名称、负责人，点进战场详情；有待决策时按最急的一档标出数量", () => {
    const html = render([
      battlefield("growth", "01", "灯塔项目", "林知行"),
      battlefield("product", "03", "产品战场", "王路遥", [{ id: "i1", urgency: "gray" }, { id: "i2", urgency: "red" }]),
      radar(0),
    ]);
    expect(html).toContain('data-origin="/battlefields/growth"');
    expect(html).toContain("灯塔项目");
    expect(html).toContain("负责人 · 林知行");
    expect(html).toContain('data-urgency="red">2 待决策');
    expect(html.match(/待决策/g)).toHaveLength(2); // 产品战场的角标 + 它的读屏名称，灯塔项目没有。
    expect(html).toContain('data-origin="/radar"');
    expect(html).toContain("看看外面的变化");
  });

  it("没有公司级战略议题、没有能力议题时不出现这两块（不放空卡）", () => {
    const html = render([battlefield("growth", "01", "灯塔项目", "林知行"), capability("cap-03", "Method"), radar(3)]);
    expect(html).not.toContain("公司战略议题");
    expect(html).not.toContain("公司能力");
    expect(html).toContain("3 条未读");
  });

  it("有公司级战略议题、能力议题时各自出现，能力行带议题数", () => {
    const html = render([
      issue("s1", "要不要进入新区域", { level: "company" }, "red"),
      capability("cap-03", "Method"),
      issue("c1", "交接方法要不要统一", { level: "capability", capabilityId: "cap-03" }, "yellow"),
      radar(0),
    ]);
    expect(html).toContain('data-origin="/issues/s1"');
    expect(html).toContain("要不要进入新区域");
    expect(html).toContain('data-origin="/capabilities"');
    expect(html).toContain('data-urgency="yellow">1 待决策');
  });
});
