import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { listMissionRows } from "../src/missions.js";
import { createTestApp } from "./helpers.js";

/** 已定设计 5a 第 3 条：Mission 卡（目标、计划）全员可读；本人确认前的准备期仍只有本人看得到。 */
it("every member reads a Mission card once it is confirmed; during preparation only its owner does", async () => {
  const t = await createTestApp();
  try {
    const q = (text: string, params?: unknown[]) => t.pool.query(text, params);
    const owner = { personId: "person-owner", role: "member" as const };
    const otherMember = { personId: "person-other-battlefield", role: "member" as const };
    const ceo = { personId: "person-fixture-001", role: "ceo" as const };
    const plan = randomUUID(), round = randomUUID(), card = randomUUID();
    await t.sql("UPDATE battlefield_config SET owner_id='person-battlefield-owner' WHERE id='growth'");
    await t.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
      VALUES ($1,1,'2026-10','confirmed','公司目标','[{"battlefieldId":"growth","outcome":"本月目标"}]','[]','{}','{}',now())`, [plan]);
    await t.sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,created_at,updated_at)
      VALUES ($1,1,'growth','2026-10',$2,'draft','agent','{}',now(),now())`, [round, plan]);
    await t.sql(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,member_ids,created_at) VALUES ($1,$2,$3,0,'[]'::jsonb,now())`, [card, round, owner.personId]);
    await t.sql(`INSERT INTO missions (id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,success_evidence,personal_mission_card_id,source_ref,source_document_id,source_revision,source_title)
      VALUES ($1::text,1,$1::text,'2026-10','县城样板',$2,'method','["growth"]','三个县城跑通','["签约"]',$1::uuid,'fixture://source','fixture',1,'测试来源')`, [card, owner.personId]);
    const titles = async (person: { personId: string; role: "ceo" | "member" }) => (await listMissionRows(q, "2026-10", person)).map((row) => row.title);

    expect(await titles(owner)).toEqual(["县城样板"]);
    expect(await titles(otherMember)).toEqual([]);
    expect(await titles(ceo)).toEqual([]);

    await t.sql("UPDATE personal_mission_cards SET owner_confirmed_at = now() WHERE id = $1", [card]);
    expect(await titles(otherMember)).toEqual(["县城样板"]);
    expect(await titles(ceo)).toEqual(["县城样板"]);
    expect((await listMissionRows(q, "2026-10", otherMember))[0]).toMatchObject({ outcome: "三个县城跑通", success_evidence: ["签约"] });
  } finally {
    await t.close();
  }
});
