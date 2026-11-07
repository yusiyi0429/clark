import { describe, expect, it } from "vitest";
import type { CardAcceptanceAgent, TAcceptanceCandidate } from "../src/cardAcceptanceAgent.js";
import { TEST_MEMBER } from "./helpers.js";
import { boardFixture } from "./boardFixture.js";

/** 合回后推翻（新首页第 4.5 节）：已合回的卡验收被推翻，原卡不退回，另开一张返工卡并登记自动开工。 */
const passAll: TAcceptanceCandidate = { headline: "都达到了", beyondScope: [], criteria: [1, 2].map((index) => ({ index, verdict: "met" as const, reason: "产出里有",
  evidence: "方案.md", fix: null })) };

async function reworkFixture() {
  const acceptance: CardAcceptanceAgent = { async accept() { return passAll; } };
  const f = await boardFixture({ boardAgents: { acceptance } });
  const local = await f.local();
  const worker = (await f.call("POST", "/api/me/roles", { name: "开发", family: "dev", kind: "worker", practiceMd: "先写测试", acceptanceMd: "测试都过" })).json();
  /** 一张交给 Claude Code 的卡，交回、Agent 验收通过，这次交回的合回结果直接往 card_handbacks.merge 写库造。 */
  const passedCard = async (title: string, merge: object | null) => {
    const id = await f.card(title);
    expect((await f.call("PATCH", `/api/me/cards/${id}`, { version: 1, executor: "claude_code", criterionIndex: 2, roleId: worker.id, brief: "照设计稿做登录页" }))
      .statusCode).toBe(200);
    const handback = await local.handBack(id);
    await f.t.app.cardAcceptance.idle();
    await f.t.sql("UPDATE card_handbacks SET merge=$2::jsonb WHERE id=$1", [handback, merge === null ? null : JSON.stringify(merge)]);
    return { id, handback };
  };
  return { ...f, worker, passedCard };
}

describe("合回后推翻 → 返工卡", { timeout: 30_000 }, () => {
  it("已合回的推翻：原卡还是完成、交回记了推翻没有改法、从准备中拿掉；同一件 Task 下多一张返工卡，交给 Claude Code，要开工", async () => {
    const f = await reworkFixture();
    try {
      const { id, handback } = await f.passedCard("做登录页", { merged: true, commit: "a".repeat(40), baseBranch: "main", reason: null, message: null, auto: true,
        at: "2026-11-06T03:10:00.000Z" });
      expect((await f.call("GET", "/api/plan-tasks/task-open/cards")).json().pending).toMatchObject([{ cardId: id }]);

      const res = await f.call("POST", `/api/me/cards/${id}/handbacks/${handback}/overrule`, { reason: "登录失败没有提示" });
      expect(res.statusCode).toBe(200);
      // 回的是原卡的详情：照旧完成，验收记录还在，这次交回记了推翻、没有要送回的改法。
      expect(res.json().task).toMatchObject({ id, status: "done", card: { stage: "done", wait: null, deliverable: null,
        handback: { id: handback, outcome: "pass", overruled: true, returnText: null } } });
      expect(res.json().handbacks[0].overrule).toMatchObject({ by: { personId: TEST_MEMBER.personId }, reason: "登录失败没有提示" });
      const [original] = await f.t.sql("SELECT status,acceptance FROM tasks WHERE id=$1", [id]);
      expect(original.status).toBe("done");
      expect(original.acceptance).toMatchObject({ agentHandbackId: handback });
      const [row] = await f.t.sql("SELECT return_text,returned_at,overruled_at FROM card_handbacks WHERE id=$1", [handback]);
      expect(row).toMatchObject({ return_text: null, returned_at: null });
      expect(row.overruled_at).not.toBeNull();
      expect((await f.call("GET", "/api/plan-tasks/task-open/cards")).json().pending).toEqual([]);

      const rework = await f.t.sql(`SELECT id::text,title,mission_id,plan_task_id,owner_id,executor,brief,done_definition,role_id::text,criterion_index,criterion_text,
        rework_of_card_id::text,after_card_ids,status FROM tasks WHERE rework_of_card_id=$1`, [id]);
      expect(rework).toHaveLength(1);
      expect(rework[0]).toMatchObject({ title: "返工：做登录页", mission_id: "mine", plan_task_id: "task-open", owner_id: TEST_MEMBER.personId, executor: "claude_code",
        brief: "照设计稿做登录页\n\n上一张已合回，验收被推翻：登录失败没有提示。在现有代码上改，不要回退已合进去的改动。", done_definition: "有方案文档\n有评审结论",
        role_id: f.worker.id, criterion_index: 2, criterion_text: "有新人上手录屏", rework_of_card_id: id, after_card_ids: [], status: "not_started" });
      // 看板上能看到它（没开工），岗位和对的标准照原卡。
      const card = (await f.call("GET", `/api/me/cards/${rework[0].id}`)).json().task;
      expect(card).toMatchObject({ title: "返工：做登录页", card: { stage: "todo", executor: "claude_code", role: { id: f.worker.id, name: "开发" } } });
      expect(await f.t.sql("SELECT kind,plan_task_id,origin,closed_at FROM session_starts WHERE card_id=$1", [rework[0].id]))
        .toEqual([{ kind: "card", plan_task_id: "task-open", origin: "web", closed_at: null }]);

      expect((await f.t.sql("SELECT content FROM thread_messages WHERE object_type='task' AND object_id=$1 ORDER BY id DESC LIMIT 1", [id]))[0].content)
        .toMatch(/推翻了 Agent 验收，已合回的不撤回，开了一张返工卡：登录失败没有提示$/);
      expect(await f.t.sql("SELECT source_kind,source_id::text FROM role_proposals WHERE task_id=$1", [id])).toEqual([{ source_kind: "overrule", source_id: handback }]);
      expect((await f.call("POST", `/api/me/cards/${id}/handbacks/${handback}/overrule`, { reason: "再来" })).json()).toMatchObject({ code: "ALREADY_OVERRULED" });
      expect(await f.t.sql("SELECT 1 FROM tasks WHERE rework_of_card_id=$1", [id])).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("没合回（合不了、没报）的推翻照旧：卡回进行中、推翻的原因等着送回，不开返工卡", async () => {
    const f = await reworkFixture();
    try {
      const blocked = await f.passedCard("合不了的", { merged: false, commit: null, baseBranch: "main", reason: "dirty", message: "主文件夹有没提交的改动", auto: true,
        at: "2026-11-06T03:10:00.000Z" });
      const unreported = await f.passedCard("没报合回的", null);
      for (const { id, handback } of [blocked, unreported]) {
        const res = await f.call("POST", `/api/me/cards/${id}/handbacks/${handback}/overrule`, { reason: "录屏不是新人" });
        expect(res.json().task).toMatchObject({ status: "in_progress", card: { stage: "doing", wait: "review_failed",
          handback: { overruled: true, returnText: "验收被推翻：录屏不是新人。改完再交回。" } } });
      }
      expect(await f.t.sql("SELECT 1 FROM tasks WHERE rework_of_card_id IS NOT NULL")).toEqual([]);
    } finally { await f.close(); }
  });
});
