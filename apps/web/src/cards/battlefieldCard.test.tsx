import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { BattlefieldCard } from "./BattlefieldCard";
import { BattlefieldDisplayProvider } from "./battlefieldDisplay";

function battlefieldCard(overrides: Record<string, unknown> = {}): Card {
  return {
    schemaVersion: 1,
    id: "battlefield:growth",
    version: 1,
    kind: "battlefield",
    objectRef: { type: "battlefield", id: "growth", version: 1 },
    title: "增长战场",
    payload: {
      battlefieldId: "growth",
      code: "01",
      sortOrder: 10,
      name: "增长战场",
      ownerId: "",
      ownerDisplayName: "",
      sixMonthOutcome: "真正跑通，从目标组织范式设计进入真实经营。",
      missionAnchors: [{ code: "01-1", title: "未来组织范式设计与确认" }],
      period: null,
      target: null,
      pendingIssues: [{ id: "i1", title: "是否追加东南亚渠道预算 40%", urgency: "red", location: { level: "battlefield", battlefieldId: "growth" } }],
      todos: [],
      latestFeedback: null,
      ...overrides,
    },
    actions: [],
  } as unknown as Card;
}

const render = (card: Card) =>
  renderToStaticMarkup(
    <BattlefieldDisplayProvider>
      <BattlefieldCard card={card} collection={[]} onCard={() => undefined} onNavigate={() => undefined} />
    </BattlefieldDisplayProvider>,
  );

/** W4：正面新增战略上下文（负责人 + 两行六个月目标），背面不受影响。 */
describe("战场卡正面战略上下文", () => {
  it("空负责人显示待指派，六个月目标与待决策 Issue 同在正面", () => {
    const html = render(battlefieldCard());
    expect(html).toContain('data-testid="zone-growth"');
    expect(html).toContain('data-mode="decisions"');
    expect(html).toContain("负责人 · 待指派");
    expect(html).toContain("六个月目标 · 真正跑通，从目标组织范式设计进入真实经营。");
    expect(html).toContain("是否追加东南亚渠道预算 40%");
  });

  it("有负责人时显示投影出的 displayName，不显示 personId", () => {
    const html = render(battlefieldCard({ ownerId: "person-fixture-002", ownerDisplayName: "测试乙" }));
    expect(html).toContain("负责人 · 测试乙");
    expect(html).not.toContain("person-fixture-002");
  });

  it("六个月目标为空时不渲染目标行", () => {
    const html = render(battlefieldCard({ sixMonthOutcome: "" }));
    expect(html).not.toContain("六个月目标");
  });

  it("展开 Mission 后渲染逐条详情入口", () => {
    const linked = (id: string, code: string) =>
      ({ schemaVersion: 1, id: `mission:${id}`, version: 1, kind: "mission", objectRef: { type: "mission", id, version: 1 }, title: id, payload: { missionId: id, code, title: "测试 Mission", battlefieldIds: ["growth"] }, actions: [] }) as unknown as Card;
    const html = renderToStaticMarkup(
      <BattlefieldDisplayProvider>
        <BattlefieldCard card={battlefieldCard()} collection={[linked("m1", "01-1")]} onCard={() => undefined} onNavigate={() => undefined} />
      </BattlefieldDisplayProvider>,
    );
    expect(html).toContain('aria-controls="missions-growth"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("Mission 数来自同一集合里关联该战场的 Mission Card，不写汇总", () => {
    const linked = (id: string, battlefieldIds: string[]) =>
      ({ schemaVersion: 1, id: `mission:${id}`, version: 1, kind: "mission", objectRef: { type: "mission", id, version: 1 }, title: id, payload: { missionId: id, battlefieldIds }, actions: [] }) as unknown as Card;
    const html = renderToStaticMarkup(
      <BattlefieldDisplayProvider>
        <BattlefieldCard
          card={battlefieldCard()}
          collection={[linked("m1", ["growth"]), linked("m2", ["growth", "other"]), linked("m3", ["other"]), battlefieldCard()]}
          onCard={() => undefined}
          onNavigate={() => undefined}
        />
      </BattlefieldDisplayProvider>,
    );
    expect(html).toContain("Missions · 2");
    expect(render(battlefieldCard())).toContain("Missions · 0");
  });
});
