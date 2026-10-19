import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { createPiConversationRuntime } from "../src/piConversationRuntime.js";
import { getPersonalMissionCard } from "../src/personalMissionCards.js";
import { migrate } from "../src/migrate.js";
import { createTestDb, testEnv } from "./helpers.js";

describe("Personal card context boundaries", () => {
  it("does not offer the unscoped Mission tool to a member's card Agent while preserving CEO access", async () => {
    const contexts: Context[] = [];
    const runtime = await createPiConversationRuntime({
      peopleDirectory: loadPeopleDirectory(testEnv), baseUrl: "https://provider.invalid/v1/responses", apiKey: "test-key", modelId: "fake-light",
      listMissions: async () => [{ id: 'invisible-other-owner' }],
      streamSimple: (_model, context) => {
        contexts.push(context);
        const events = createAssistantMessageEventStream();
        queueMicrotask(() => events.push({ type: 'done', reason: 'stop', message: {
          role: 'assistant', api: 'openai-responses', provider: 'warmap', model: 'fake-light', content: [{ type: 'text', text: '只讨论本卡' }],
          stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } }));
        return events;
      },
    });
    try {
      for (const role of ['member', 'ceo'] as const) await runtime.run({
        scope: `mission-card:${randomUUID()}`, viewer: { role, personId: role, displayName: role }, message: '列出其他人的卡',
        currentObject: null, referencesSnapshot: [], runtimeEntries: [], piSessionId: randomUUID(), signal: new AbortController().signal, emit: () => undefined,
      });
      expect(contexts[0].tools?.map((tool) => tool.name)).not.toContain('list_missions');
      expect(contexts[0].systemPrompt).not.toContain('`list_missions`');
      expect(contexts[1].tools?.map((tool) => tool.name)).toContain('list_missions');
    } finally { await runtime.close?.(); }
  });

  it("shows signed goals before opening without freezing them, then retains the opening snapshot", async () => {
    await createTestDb(async (t) => {
      await migrate(t.db);
      const plan = randomUUID(), round = randomUUID(), card = randomUUID();
      await t.db.query("UPDATE battlefield_config SET six_month_outcome='当前六个月目标' WHERE id='growth'");
      await t.db.query(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
        VALUES ($1,1,'2026-10','confirmed','公司目标','[{"battlefieldId":"growth","outcome":"已签发本月目标"}]','[]','{}','{}','2026-10-01T00:00:00Z')`, [plan]);
      await t.db.query(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,created_at,updated_at)
        VALUES ($1,1,'growth','2026-10',$2,'draft','placeholder','{}','2026-10-01','2026-10-01')`, [round, plan]);
      await t.db.query("INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,member_ids,created_at) VALUES ($1,$2,'member',0,'[\"member\"]','2026-10-01')", [card, round]);
      const read = () => getPersonalMissionCard(t.db.query.bind(t.db), [], 'test', { personId: 'member', role: 'member' }, card, new Date('2026-10-01T02:00:00Z'));
      const draft = (await read())!.payload as any;
      expect(draft.round.goals).toEqual({ sixMonthOutcome: '当前六个月目标', monthOutcome: '已签发本月目标', signedAt: '2026-10-01T00:00:00.000Z' });
      expect((await t.db.query('SELECT goal_snapshot FROM mission_rounds WHERE id=$1', [round])).rows[0].goal_snapshot).toBeNull();
      await t.db.query("UPDATE mission_rounds SET status='open',window_seq=1,first_opened_at='2026-10-01',opened_at='2026-10-01',closes_at='2026-10-03',goal_snapshot=$2 WHERE id=$1", [round, JSON.stringify(draft.round.goals)]);
      await t.db.query("UPDATE battlefield_config SET six_month_outcome='新长期配置' WHERE id='growth'");
      expect(((await read())!.payload as any).round.goals).toEqual(draft.round.goals);
    });
  });
});
