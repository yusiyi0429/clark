import { describe, expect, it } from "vitest";
import type { TCard } from "@warmap/contracts";
import { mergeMissionRoundCards } from "../src/routes/cards.js";

function notice(id: string, battlefieldId: string, period: string, slot: boolean): TCard {
  return {
    schemaVersion: 1, id, version: 1, kind: "mission-round", title: "本月 Mission Card",
    objectRef: { type: slot ? "mission-round-slot" : "mission-round", id, version: 1 },
    payload: { battlefieldId, period, ...(slot ? {} : { roundId: id, phase: "draft" }) }, actions: [],
  };
}

describe("CEO Mission round notice merge", () => {
  it("prefers the persisted round when concurrent home reads also return its earlier draft slot", () => {
    // slot 查询先看到空位，round 查询在整理草稿提交后看到了对象；两者的 Card id 本来就不同。
    const current = notice("round-uuid", "growth", "2026-10", false);
    const staleSlot = notice("growth:2026-10", "growth", "2026-10", true);
    const anotherBattlefield = notice("delivery:2026-10", "delivery", "2026-10", true);
    const anotherMonth = notice("growth:2026-11", "growth", "2026-11", true);
    const slots = [staleSlot, anotherBattlefield, anotherMonth];
    expect(mergeMissionRoundCards([current], slots)).toEqual([current, anotherBattlefield, anotherMonth]);
    expect(mergeMissionRoundCards([], slots)).toEqual(slots);
    expect(slots).toEqual([staleSlot, anotherBattlefield, anotherMonth]);
  });
});
