import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CardAcceptanceAgent } from "../src/cardAcceptance.js";
import { TEST_MEMBER } from "./helpers.js";
import { boardFixture } from "./boardFixture.js";

/** 验收一律都达到。 */
const acceptance: CardAcceptanceAgent = { async accept(input) {
  return { headline: "都达到了", beyondScope: [], criteria: input.card.criteria.map(({ index }) => ({ index, verdict: "met" as const, reason: "有", evidence: "产出", fix: null })) };
} };

async function passedCard(f: Awaited<ReturnType<typeof boardFixture>>, local: Awaited<ReturnType<Awaited<ReturnType<typeof boardFixture>>["local"]>>,
  title: string, options: Parameters<typeof local.handBack>[1]) {
  const id = await f.card(title);
  await f.call("PATCH", `/api/me/cards/${id}`, { version: 1, executor: "claude_code" });
  await local.handBack(id, options);
  await f.t.app.cardAcceptance.idle();
  return id;
}

describe("准备中的交付物和出下一版", () => {
  it("专题的一版点了才进准备中，能拿出来；出下一版沿用上一版全部材料、加上准备中的各样，回写 version_id，评审自动开始", async () => {
    const f = await boardFixture({ boardAgents: { acceptance } });
    try {
      const local = await f.local();
      const card = await passedCard(f, local, "写方案", { files: [["方案.md", "# 方案"], ["记录.txt", "过程记录"]], links: ["https://example.com/pr/1"] });
      const topic = randomUUID(), version = randomUUID(), elsewhere = randomUUID();
      await f.t.sql("INSERT INTO research_topics(id,owner_id,title,plan_task_id,mission_id) VALUES($1,$2,'竞品调研','task-open','mine'),($3,$2,'别的','task-theirs','mine')",
        [topic, TEST_MEMBER.personId, elsewhere]);
      await f.t.sql(`INSERT INTO topic_versions(id,topic_id,number,kind,label,body,client_id) VALUES($1,$2,1,'draft','第 1 版','# 竞品\\n三家','c1'),($3,$4,1,'draft','第 1 版','x','c2')`,
        [version, topic, randomUUID(), elsewhere]);
      const elsewhereVersion = (await f.t.sql("SELECT id FROM topic_versions WHERE topic_id=$1", [elsewhere]))[0].id;
      const added = await f.call("POST", "/api/plan-tasks/task-open/deliverable/pending", { topicVersionId: version });
      expect(added.statusCode).toBe(201);
      expect(added.json()).toMatchObject({ kind: "topic", title: "竞品调研 · 第 1 版", topicId: topic, topicVersionId: version, cardId: null });
      expect((await f.call("POST", "/api/plan-tasks/task-open/deliverable/pending", { topicVersionId: version })).json()).toMatchObject({ code: "ALREADY_PENDING" });
      expect((await f.call("POST", "/api/plan-tasks/task-open/deliverable/pending", { topicVersionId: elsewhereVersion })).json()).toMatchObject({ code: "TOPIC_NOT_ON_TASK" });
      expect((await f.call("DELETE", `/api/plan-tasks/task-open/deliverable/pending/${added.json().id}`)).statusCode).toBe(204);
      expect((await f.call("DELETE", `/api/plan-tasks/task-open/deliverable/pending/${added.json().id}`)).statusCode).toBe(404);
      await f.call("POST", "/api/plan-tasks/task-open/deliverable/pending", { topicVersionId: version });
      expect((await f.call("GET", "/api/plan-tasks/task-open/cards")).json().pending.map((item: { title: string }) => item.title)).toEqual(["写方案", "竞品调研 · 第 1 版"]);

      const v1 = randomUUID();
      await f.t.sql(`INSERT INTO deliverable_versions(id,task_id,mission_id,author_id,number,task_name,basis,criteria,review_status) VALUES($1,'task-open','mine',$2,1,'对话质量达标','acceptance','[]','done')`,
        [v1, TEST_MEMBER.personId]);
      await f.t.sql(`INSERT INTO deliverable_items(id,version_id,position,kind,name,url,read) VALUES($1,$2,0,'link','https://example.com/old','https://example.com/old','read'),
        ($3,$2,1,'link','https://example.com/pr/1','https://example.com/pr/1','read')`, [randomUUID(), v1, randomUUID()]);
      const created = await f.call("POST", "/api/plan-tasks/task-open/deliverable/versions/from-pending", {});
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ number: 2, statement: "这一版纳入：写方案、竞品调研 · 第 1 版" });
      expect(created.json().items.map((item: { kind: string; name: string }) => [item.kind, item.name])).toEqual([
        ["link", "https://example.com/old"], ["link", "https://example.com/pr/1"], ["file", "方案.md"], ["file", "记录.txt.md"], ["file", "竞品调研 · 第 1 版.md"]]);
      await f.t.app.deliverables.idle();
      const deliverable = (await f.call("GET", "/api/plan-tasks/task-open/deliverable")).json();
      expect(deliverable.versions[0]).toMatchObject({ number: 2, review: { status: "done" } });
      const board = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json();
      expect(board).toMatchObject({ pending: [], nextVersion: 3 });
      expect(board.cards.find((item: { id: string }) => item.id === card).card.deliverable).toEqual({ state: "included", versionNumber: 2 });
      expect((await f.t.sql("SELECT count(*)::int AS n FROM deliverable_pending_items WHERE version_id=$1", [created.json().id]))[0].n).toBe(2);
      expect((await f.call("POST", "/api/plan-tasks/task-open/deliverable/versions/from-pending", {})).json()).toMatchObject({ code: "NOTHING_PENDING" });
    } finally { await f.close(); }
  });

  it("放不进一版（超过 10 份文件）时报错，什么都不写", async () => {
    const f = await boardFixture({ boardAgents: { acceptance } });
    try {
      const local = await f.local();
      await passedCard(f, local, "一大堆产出", { files: Array.from({ length: 11 }, (_, index) => [`第${index + 1}份.md`, `# ${index}`] as [string, string]), links: [] });
      const res = await f.call("POST", "/api/plan-tasks/task-open/deliverable/versions/from-pending", { statement: "试试" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "DELIVERABLE_LIMIT" });
      expect(await f.t.sql("SELECT 1 FROM deliverable_versions")).toEqual([]);
      expect((await f.call("GET", "/api/plan-tasks/task-open/cards")).json().pending).toHaveLength(1);
    } finally { await f.close(); }
  });
});
