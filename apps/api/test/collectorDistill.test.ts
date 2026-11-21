import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCollectorRawPurgeScheduler } from "../src/collectorDistill.js";
import { executionFixture, type Fixture } from "./executionFixture.js";

const MEMBER = "person-fixture-002";

async function seedItem(f: Fixture, personId: string, summary: string, receivedAt: Date) {
  const token = randomUUID(), id = randomUUID();
  await f.t.sql("INSERT INTO personal_tokens(id,person_id,name,client,secret_hash,created_at) VALUES($1,$2,'collector','collector',$3,$4)", [token, personId, randomUUID(), receivedAt]);
  await f.t.sql(`INSERT INTO collector_items(id,person_id,device_id,token_id,report_kind,client_event_id,source,started_at,ended_at,summary,links,task_hint,received_at)
    VALUES($1,$2,'device-test-01',$3,'digest',$4,'codex',$5,$6,$7,'[]','Tianshu-MVP',$6)`,
  [id, personId, token, randomUUID(), new Date(receivedAt.getTime() - 3_600_000), receivedAt, summary]);
  return id;
}

describe("采集器原文的收尾", () => {
  it("后台任务只清理：收到满 14 天的原文清空、整理那次运行存下的输入一并清空；不再整理，没整理的原文照样留到 14 天，已整理的结果不动", async () => {
    const f = await executionFixture();
    try {
      await f.t.sql("INSERT INTO collector_consents (person_id, granted, updated_at) VALUES ($1, true, now())", [MEMBER]);
      const old = await seedItem(f, MEMBER, "两周前的原文", new Date("2026-09-25T02:00:00Z"));
      const fresh = await seedItem(f, MEMBER, "昨天的原文", new Date("2026-10-09T02:00:00Z"));
      await f.t.sql(`INSERT INTO collector_progress(id,person_id,source,started_at,ended_at,text,placement,confidence,item_ids,created_at)
        VALUES($1,$2,'codex',now(),now(),'整理好的进展','pending_replan',0.1,ARRAY[$3::uuid],now())`, [randomUUID(), MEMBER, old]);
      await f.t.sql(`INSERT INTO agent_runs(id,kind,status,model_slot,prompt_hash,input_snapshot,started_at) VALUES
        ($1,'collector-distill','succeeded','heavy','h','{"items":[{"text":"两周前的原文"}]}','2026-09-25T03:00:00Z'),
        ($2,'collector-distill','succeeded','heavy','h','{"items":[{"text":"昨天的原文"}]}','2026-10-09T03:00:00Z')`, [randomUUID(), randomUUID()]);

      await createCollectorRawPurgeScheduler(f.t.pool, () => new Date("2026-10-10T02:00:00Z")).tick();

      expect(await f.t.sql("SELECT id,summary,raw_purged_at IS NOT NULL AS purged,distill_status FROM collector_items ORDER BY received_at")).toEqual([
        { id: old, summary: null, purged: true, distill_status: "pending" }, { id: fresh, summary: "昨天的原文", purged: false, distill_status: "pending" }]);
      expect((await f.t.sql("SELECT input_snapshot FROM agent_runs ORDER BY started_at")).map((row) => row.input_snapshot))
        .toEqual([{ reason: "collector raw retention", purged: true }, { items: [{ text: "昨天的原文" }] }]);
      expect(await f.t.sql("SELECT text FROM collector_progress")).toEqual([{ text: "整理好的进展" }]);
      expect(await f.t.sql("SELECT count(*)::int AS n FROM task_progress")).toEqual([{ n: 0 }]);
    } finally { await f.t.close(); }
  });
});
