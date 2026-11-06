import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AcceptanceInput, CardAcceptanceAgent, TAcceptanceCandidate } from "../src/cardAcceptance.js";
import { returnText } from "../src/cardAcceptance.js";
import { TEST_MEMBER } from "./helpers.js";
import { boardFixture } from "./boardFixture.js";

type Verdict = "met" | "partial" | "unmet";
const candidate = (verdicts: Verdict[]): TAcceptanceCandidate => ({ headline: verdicts.every((v) => v === "met") ? `${verdicts.length} 条都达到了` : "还差几条",
  beyondScope: ["可以顺手补一页说明"], criteria: verdicts.map((verdict, index) => ({ index: index + 1, verdict, reason: verdict === "met" ? "产出里有" : "只写了说法",
    evidence: verdict === "met" ? "方案.md 第 1 段" : null, fix: verdict === "met" ? null : `补上第 ${index + 1} 条的材料` })) });

async function acceptanceFixture() {
  const calls: { input: AcceptanceInput; images: number }[] = [];
  const plan: Verdict[][] = [];
  let gate: Promise<void> | null = null;
  const acceptance: CardAcceptanceAgent = { async accept(input, { images }) {
    calls.push({ input, images: images.length });
    if (gate) await gate;
    const next = plan.shift();
    if (!next) throw new Error("模型出错了");
    return candidate(next);
  } };
  const f = await boardFixture({ boardAgents: { acceptance }, deliverableFetcher: async (url) => ({ text: `网页正文 ${url}`, images: [] }) });
  const local = await f.local();
  /** 本机做完一轮交回来：一份产出、一个链接证据、一次交回。 */
  const handBack = (cardId: string, text = "# 方案\n有方案文档") => local.handBack(cardId, { files: [["方案.md", text]] });
  const card = async () => {
    const id = await f.card("写方案");
    expect((await f.call("PATCH", `/api/me/cards/${id}`, { version: 1, executor: "claude_code", criterionIndex: 1 })).statusCode).toBe(200);
    return id;
  };
  const view = async (id: string) => (await f.call("GET", `/api/me/cards/${id}`)).json();
  const settle = () => f.t.app.cardAcceptance.idle();
  return { ...f, calls, plan, handBack, card, view, settle, hold: () => { let open = () => undefined as void; gate = new Promise((resolve) => { open = resolve; }); return () => { gate = null; open(); }; } };
}

describe("Agent 验收：队列、推翻、退回记录", () => {
  it("都达到 → 已完成，准备中多一行，事项群里记一句；Agent 拿到卡、标准、执行方的说法、产出和链接正文", async () => {
    const f = await acceptanceFixture();
    try {
      const id = await f.card();
      f.plan.push(["met", "met"]);
      const open = f.hold();
      const handback = await f.handBack(id);
      expect((await f.view(id)).task.card).toMatchObject({ stage: "review", wait: null, handback: { id: handback, status: "running" } });
      open();
      await f.settle();
      const detail = await f.view(id);
      expect(detail.task).toMatchObject({ status: "done", card: { stage: "done", wait: null, deliverable: { state: "pending", versionNumber: 1 },
        handback: { status: "done", outcome: "pass", met: 2, total: 2, headline: "2 条都达到了", returnText: null } } });
      expect(detail.handbacks[0].result).toEqual({ beyondScope: ["可以顺手补一页说明"], criteria: [
        { index: 1, text: "有方案文档", verdict: "met", reason: "产出里有", evidence: "方案.md 第 1 段", fix: null },
        { index: 2, text: "有评审结论", verdict: "met", reason: "产出里有", evidence: "方案.md 第 1 段", fix: null }] });
      expect(f.calls[0].input).toMatchObject({ card: { title: "写方案", criteria: [{ index: 1, text: "有方案文档" }, { index: 2, text: "有评审结论" }] },
        taskCriterion: { index: 1, text: "有题库打分结果" }, summary: "做完了", unreadable: [],
        outputs: [{ name: "方案.md", kind: "artifact", text: "# 方案\n有方案文档", url: null },
          { name: "评审记录", kind: "evidence", text: "网页正文 https://example.com/review", url: "https://example.com/review" }] });
      expect(f.calls[0].input.previous).toBeUndefined();
      const [task] = await f.t.sql("SELECT acceptance FROM tasks WHERE id=$1", [id]);
      expect(task.acceptance).toMatchObject({ by: TEST_MEMBER.personId, verdict: "Agent 验收通过（2/2）", agentHandbackId: handback,
        standards: [{ text: "有方案文档", met: true, evidence: "方案.md 第 1 段" }, { text: "有评审结论", met: true }] });
      expect((await f.call("GET", "/api/plan-tasks/task-open/cards")).json().pending).toMatchObject([{ kind: "card", cardId: id, title: "写方案" }]);
      expect((await f.t.sql("SELECT content FROM thread_messages WHERE object_type='task' AND object_id=$1 ORDER BY id DESC LIMIT 1", [id]))[0].content)
        .toBe("Agent 验收通过（2/2）。");
    } finally { await f.close(); }
  });

  it("一条部分达到 → 验收未过、改法是固定格式；送到以后记一笔；第二次还没过 → 受阻；第二次 Agent 拿到上一次的结果", async () => {
    const f = await acceptanceFixture();
    try {
      const id = await f.card();
      f.plan.push(["met", "partial"], ["unmet", "met"]);
      const first = await f.handBack(id);
      await f.settle();
      const failed = (await f.view(id)).task.card;
      const text = "验收没过：第 2 条「有评审结论」，只写了说法；怎么补：补上第 2 条的材料。改完再交回。";
      expect(failed).toMatchObject({ stage: "doing", wait: "review_failed", handback: { outcome: "fail", met: 1, total: 2, returnText: text, returnedAt: null } });
      expect(returnText(["甲", "乙"], { headline: "", beyondScope: [], criteria: [{ index: 2, verdict: "unmet", reason: "没有", evidence: null, fix: null },
        { index: 1, verdict: "partial", reason: "一半", evidence: null, fix: "补" }] })).toBe("验收没过：第 1 条「甲」，一半；怎么补：补。第 2 条「乙」，没有；怎么补：补上能核对的证据。改完再交回。");
      const returned = await f.call("POST", `/api/me/cards/${id}/handbacks/${first}/returned`);
      expect(returned.statusCode).toBe(200);
      expect(returned.json().task.card).toMatchObject({ stage: "doing", wait: null });
      expect((await f.call("POST", `/api/me/cards/${id}/handbacks/${first}/returned`)).statusCode).toBe(200);
      await f.handBack(id, "# 方案\n补了评审");
      await f.settle();
      expect(f.calls[1].input.previous).toMatchObject([{ index: 1, verdict: "met" }, { index: 2, verdict: "partial", fix: "补上第 2 条的材料" }]);
      expect((await f.view(id)).task.card).toMatchObject({ stage: "doing", wait: "blocked", handback: { attempt: 2, outcome: "fail" } });
      expect((await f.view(id)).task.status).toBe("in_progress");
    } finally { await f.close(); }
  });

  it("推翻通过的 → 进行中、准备中那行没了、推翻的原因等着送回；推翻没过的 → 已完成、验收记录写本人；进了某一版的不能推翻", async () => {
    const f = await acceptanceFixture();
    try {
      const passed = await f.card();
      const failed = await f.card();
      f.plan.push(["met", "met"]);
      const pass = await f.handBack(passed);
      await f.settle();
      f.plan.push(["met", "unmet"]);
      const fail = await f.handBack(failed);
      await f.settle();

      const overruled = await f.call("POST", `/api/me/cards/${passed}/handbacks/${pass}/overrule`, { reason: "录屏不是新人" });
      expect(overruled.statusCode).toBe(200);
      expect(overruled.json().task).toMatchObject({ status: "in_progress", card: { stage: "doing", wait: "review_failed", deliverable: null,
        handback: { outcome: "pass", overruled: true, returnText: "验收被推翻：录屏不是新人。改完再交回。" } } });
      expect(overruled.json().handbacks[0].overrule).toMatchObject({ by: { personId: TEST_MEMBER.personId }, reason: "录屏不是新人" });
      expect((await f.t.sql("SELECT acceptance FROM tasks WHERE id=$1", [passed]))[0].acceptance).toBeNull();
      expect((await f.call("POST", `/api/me/cards/${passed}/handbacks/${pass}/overrule`, { reason: "再来" })).json()).toMatchObject({ code: "ALREADY_OVERRULED" });

      const stillPass = await f.call("POST", `/api/me/cards/${failed}/handbacks/${fail}/overrule`, { reason: "评审结论在群里" });
      expect(stillPass.json().task).toMatchObject({ status: "done", card: { stage: "done", deliverable: { state: "pending" } } });
      expect((await f.t.sql("SELECT acceptance FROM tasks WHERE id=$1", [failed]))[0].acceptance).toMatchObject({ by: TEST_MEMBER.personId,
        verdict: "推翻 Agent 验收：评审结论在群里", agentHandbackId: fail });
      const pending = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json().pending;
      expect(pending.map((item: { cardId: string }) => item.cardId)).toEqual([failed]);

      const version = randomUUID();
      await f.t.sql(`INSERT INTO deliverable_versions(id,task_id,mission_id,author_id,number,task_name,basis,criteria) VALUES($1,'task-open','mine',$2,1,'x','acceptance','[]')`,
        [version, TEST_MEMBER.personId]);
      await f.t.sql("UPDATE deliverable_pending_items SET version_id=$1", [version]);
      f.plan.push(["met", "met"]);
      const again = await f.handBack(passed);
      await f.settle();
      await f.t.sql("UPDATE deliverable_pending_items SET version_id=$1", [version]);
      expect((await f.call("POST", `/api/me/cards/${passed}/handbacks/${again}/overrule`, { reason: "不对" })).json()).toMatchObject({ code: "ALREADY_INCLUDED" });
    } finally { await f.close(); }
  });

  it("验收出错能重试；重启以后排队中的接着验；旧的一次验完不改新交回的卡", async () => {
    const f = await acceptanceFixture();
    try {
      const id = await f.card();
      const first = await f.handBack(id);
      await f.settle();
      expect((await f.view(id)).handbacks[0]).toMatchObject({ status: "failed", error: "验收没做完，可以重试" });
      expect((await f.view(id)).task.card).toMatchObject({ stage: "doing", wait: null });
      f.plan.push(["met", "met"]);
      const retried = await f.call("POST", `/api/me/cards/${id}/handbacks/${first}/retry`);
      expect(retried.statusCode).toBe(200);
      await f.settle();
      expect((await f.view(id)).task.status).toBe("done");
      expect((await f.call("POST", `/api/me/cards/${id}/handbacks/${first}/retry`)).json()).toMatchObject({ code: "NOT_FAILED" });

      const other = await f.card();
      await f.t.sql("UPDATE tasks SET status='in_progress' WHERE id=$1", [other]);
      const queued = randomUUID();
      await f.t.sql(`INSERT INTO card_handbacks(id,task_id,owner_id,client_id,attempt,criteria,status) VALUES($1,$2,$3,'restart',1,'["有方案文档"]'::jsonb,'queued')`,
        [queued, other, TEST_MEMBER.personId]);
      f.plan.push(["met"]);
      await f.t.app.cardAcceptance.recover();
      await f.settle();
      expect((await f.view(other)).task.status).toBe("done");

      const third = await f.card();
      const open = f.hold();
      f.plan.push(["met", "met"]);
      await f.handBack(third);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await f.t.sql(`INSERT INTO card_handbacks(id,task_id,owner_id,client_id,attempt,criteria,status) VALUES($1,$2,$3,'newer',2,'["有方案文档"]'::jsonb,'done')`,
        [randomUUID(), third, TEST_MEMBER.personId]);
      open();
      await f.settle();
      const detail = await f.view(third);
      expect(detail.handbacks.map((item: { attempt: number; outcome: string | null }) => [item.attempt, item.outcome])).toEqual([[2, null], [1, "pass"]]);
      expect(detail.task.status).toBe("in_progress");
    } finally { await f.close(); }
  });
});
