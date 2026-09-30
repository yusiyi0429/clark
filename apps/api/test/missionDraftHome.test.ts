import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { signActionId } from "../src/actionToken.js";
import { closeDueRounds, importMissionCardDrafts } from "../src/missionRounds.js";
import { createTestApp, type TestApp } from "./helpers.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const filename = "2026-10-mission-cards.battlefield-01.json";

describe("CEO Mission draft entry and October rehearsal", () => {
  it("signs targets, explicitly imports an isolated 5-card fixture, snapshots discussion and reopens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warmap-mission-home-"));
    let t: TestApp | undefined;
    let pool: Pool | undefined;
    try {
      const fileContent = await readFile(join(root, "seed/placeholders", filename), "utf8");
      const draft = JSON.parse(fileContent);
      const people = JSON.parse(await readFile(join(root, "apps/api/test/fixtures/company-people.json"), "utf8"));
      people.people.push(...draft.cards.map((card: { ownerId: string }) => ({ personId: card.ownerId, displayName: card.ownerId, roles: ["dri"] })));
      const peopleFile = join(dir, "people.json");
      await writeFile(peopleFile, JSON.stringify(people));
      let current = new Date("2026-10-01T02:00:00.000Z");
      t = await createTestApp({ companyPeopleSeed: peopleFile, missionCardDraftsDir: dir }, undefined, { monthlyNow: () => current });
      const instance = t;
      const cookie = await t.loginCookie();
      const headers = { cookie, origin: t.publicOrigin };
      const home = async () => (await instance.app.inject({ method: "GET", url: "/api/cards/home", headers })).json().cards.filter((card: { kind: string }) => card.kind === "mission-round");
      const execute = (actionId: string) => instance.app.inject({ method: "POST", url: "/api/mission-rounds/actions/execute", headers, payload: { actionId, input: {} } });
      await t.sql("UPDATE battlefield_config SET code='01',owner_id='person-fixture-001',six_month_outcome='六个月结果' WHERE id='growth'");
      for (const code of ["03", "04", "05"]) await t.sql("INSERT INTO capability_config (id,version,code,name,six_month_outcome) VALUES ($1,1,$2,$1,'能力结果')", [`cap-${code}`, code]);
      expect(await home()).toHaveLength(0);
      const slotToken = signActionId(t.env.sessionSecret, { actionType: "mission-round.draft", objectType: "mission-round-slot", objectId: "growth:2026-10", objectVersion: 1 });
      await writeFile(join(dir, filename), fileContent);
      const unsigned = await execute(slotToken);
      expect(unsigned.statusCode).toBe(409);
      expect(unsigned.json().message).toContain("先签发再整理草稿");
      const planId = randomUUID();
      await t.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation)
        VALUES ($1,1,'2026-10','negotiating','公司结果','[{"battlefieldId":"growth","outcome":"战场结果"}]','[]',
        '{"edits":[],"checkedItemIds":["company","battlefield:growth"],"feedback":[],"note":"已核对目标"}',
        '{"status":"ready","pendingSince":null,"runId":null,"previousRunIds":[],"error":null,"generatedAt":"2026-10-01T00:00:00.000Z"}')`, [planId]);
      expect(await home()).toHaveLength(0);
      const plan = (await t.app.inject({ method: "GET", url: `/api/cards/monthly-plans/${planId}`, headers })).json().cards[0];
      const signed = await t.app.inject({ method: "POST", url: "/api/actions/execute", headers, payload: { actionId: plan.actions.find((a: {actionType: string}) => a.actionType === "monthly-plan.sign").actionId, input: {} } });
      expect(signed.statusCode).toBe(200);
      const entry = (await home())[0];
      expect(entry).toMatchObject({ objectRef: { type: "mission-round-slot", id: "growth:2026-10" }, payload: { placeholder: false } });
      const member = await t.memberCookie();
      expect((await t.app.inject({ method: "POST", url: "/api/mission-rounds/actions/execute", headers: { cookie: member, origin: t.publicOrigin }, payload: { actionId: entry.actions[0].actionId } })).statusCode).toBe(403);
      const [one, two] = await Promise.all([execute(entry.actions[0].actionId), execute(entry.actions[0].actionId)]);
      expect([one.statusCode, two.statusCode]).toEqual([409, 409]);
      expect(one.json().code).toBe("NO_DRAFT_OWNERS");
      expect(await t.sql("SELECT count(*)::int AS count FROM mission_rounds")).toEqual([{ count: 0 }]);
      // Only an explicit human file import can load this rehearsal fixture.
      await importMissionCardDrafts(t.pool, people.people, join(dir, filename), current);
      const round = (await home())[0];
      expect(await t.sql("SELECT count(*)::int AS count FROM mission_rounds")).toEqual([{ count: 1 }]);
      expect(await t.sql("SELECT count(*)::int AS count FROM personal_mission_cards")).toEqual([{ count: 5 }]);
      const missions = await t.sql("SELECT id,code,version,placeholder,source_title,milestones,battlefield_ids FROM missions ORDER BY code");
      expect(missions).toHaveLength(12);
      for (const mission of missions) {
        expect(mission).toMatchObject({ version: 1, placeholder: true, source_title: draft.placeholderNote, battlefield_ids: ["growth"] });
        expect(mission.id).toBe(mission.code);
        expect((mission.milestones as string[]).every((line) => line.startsWith("待定 · "))).toBe(true);
      }
      expect((await home())[0].payload).toMatchObject({ phase: "draft", todo: "任务卡草稿已就绪，可以统一开放讨论" });
      const before = await t.sql("SELECT row_to_json(r) AS row FROM mission_rounds r");
      expect((await execute(entry.actions[0].actionId)).statusCode).toBe(200);
      expect(await t.sql("SELECT row_to_json(r) AS row FROM mission_rounds r")).toEqual(before);
      const opened = await execute(round.actions.find((a: {actionType: string}) => a.actionType === "mission-round.open").actionId);
      expect(opened.statusCode).toBe(200);
      expect(opened.json().cards[0].payload.closesAt).toBeNull();
      const closes = new Date(current.getTime() + 72 * 60 * 60 * 1000).toISOString();
      const firstCard = round.payload.cards[0].cardId;
      const included = randomUUID(), excluded = randomUUID();
      for (const [id, time, late] of [[included, new Date(Date.parse(closes) - 1), false], [excluded, new Date(closes), true]] as const) {
        await t.sql(`INSERT INTO mission_card_feedback (id,round_id,card_id,kind,author_id,client_id,body,basis,window_seq,late,created_at)
          VALUES ($1,$2,$3,'comment','person-fixture-001',$4,'演练公开意见','draft',1,$5,$6)`, [id, round.objectRef.id, firstCard, randomUUID(), late, time]);
      }
      const [{ database }] = await t.sql("SELECT current_database() AS database");
      pool = new Pool({ connectionString: (process.env.TEST_PG_URL ?? "postgres://postgres:postgres@localhost:54329/postgres").replace(/\/postgres$/, `/${database}`), max: 2 });
      current = new Date(closes);
      expect(await closeDueRounds(pool, () => current)).toBe(0);
      const finish = await execute(opened.json().cards[0].actions.find((a: {actionType: string}) => a.actionType === "mission-round.close").actionId);
      expect(finish.statusCode).toBe(200);
      expect((await t.sql("SELECT feedback_ids,mission_versions FROM mission_round_reviews"))[0]).toMatchObject({ feedback_ids: [included] });
      expect(Object.keys((await t.sql("SELECT mission_versions FROM mission_round_reviews"))[0].mission_versions as object)).toHaveLength(12);
      const reviewed = (await home())[0];
      const reopened = await execute(reviewed.actions.find((a: {actionType: string}) => a.actionType === "mission-round.reopen").actionId);
      expect(reopened.statusCode).toBe(200);
      expect(reopened.json().cards[0].payload).toMatchObject({ phase: "open", round: 2 });
      expect((await t.sql("SELECT reopens FROM mission_rounds"))[0].reopens).toEqual([{ by: "person-fixture-001", at: current.toISOString(), closedAt: closes }]);
      await writeFile(join(dir, filename), `${fileContent}\n`);
      await expect(importMissionCardDrafts(t.pool, people.people, join(dir, filename), current)).rejects.toMatchObject({ code: "MISSION_DRAFT_SOURCE_CHANGED" });
      expect((await execute(entry.actions[0].actionId)).statusCode).toBe(200);
      expect(await t.sql("SELECT count(*)::int AS count FROM missions")).toEqual([{ count: 12 }]);
    } finally {
      await pool?.end();
      await t?.close();
      if (!resolve(dir).startsWith(join(resolve(tmpdir()), "warmap-mission-home-"))) throw new Error("Unexpected fixture directory");
      await rm(dir, { recursive: true, force: true });
    }
  });
});
