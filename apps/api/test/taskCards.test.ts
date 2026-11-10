import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TEST_MEMBER } from "./helpers.js";
import { boardFixture, THIRD, type BoardFixture } from "./boardFixture.js";

const DEVICE = randomUUID();
const at = (minute: number) => new Date(Date.UTC(2026, 10, 6, 3, minute)).toISOString();
const run = (f: BoardFixture, taskId: string, state: string, minute: number) => f.t.sql(`INSERT INTO local_runs(id,owner_id,device_id,kind,task_id,state,started_at,
  plan,plan_progress,last_activity) VALUES($1,$2,$3,'card',$4,$5,$6,'[{"content":"读","status":"completed"},{"content":"写","status":"in_progress"}]'::jsonb,
  '{"done":1,"total":2,"step":2,"current":"写"}'::jsonb,$7::jsonb)`,
[randomUUID(), TEST_MEMBER.personId, DEVICE, taskId, state, at(minute), JSON.stringify({ at: at(minute), text: "在做" })]);
const result = (verdicts: string[]) => JSON.stringify({ headline: "结论", beyondScope: [],
  criteria: verdicts.map((verdict, index) => ({ index: index + 1, verdict, reason: "理由", evidence: verdict === "met" ? "证据" : null, fix: verdict === "met" ? null : "补上" })) });
const handback = (f: BoardFixture, taskId: string, attempt: number, fields: { status?: string; outcome?: string; verdicts?: string[]; returned?: boolean; overruled?: boolean } = {}) =>
  f.t.sql(`INSERT INTO card_handbacks(id,task_id,owner_id,client_id,attempt,criteria,status,outcome,result,return_text,returned_at,overruled_at,overruled_by,overrule_reason)
    VALUES($1,$2,$3,$4,$5,'["有方案文档","有评审结论"]'::jsonb,$6,$7,$8::jsonb,$9,$10,$11,$12,$13) RETURNING id`,
  [randomUUID(), taskId, TEST_MEMBER.personId, `k${attempt}-${randomUUID()}`, attempt, fields.status ?? "done", fields.outcome ?? null,
    fields.verdicts ? result(fields.verdicts) : null, fields.outcome === "fail" ? "验收没过：第 2 条" : null, fields.returned ? at(30) : null,
    fields.overruled ? at(31) : null, fields.overruled ? TEST_MEMBER.personId : null, fields.overruled ? "我看过了" : null]);
const status = (f: BoardFixture, taskId: string, value: string) => f.t.sql("UPDATE tasks SET status=$2 WHERE id=$1", [taskId, value]);

describe("执行看板：卡的投影和看板接口", { timeout: 30_000 }, () => {
  it("看板只给 Task 负责人；没有卡时只有标准和下一版的号", async () => {
    const f = await boardFixture();
    try {
      const empty = await f.call("GET", "/api/plan-tasks/task-open/cards");
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toEqual({ taskId: "task-open", criteria: [{ index: 1, text: "有题库打分结果" }, { index: 2, text: "有新人上手录屏" }],
        cards: [], drafts: [], plan: null, pending: [], nextVersion: 1 });
      expect((await f.call("GET", "/api/plan-tasks/task-theirs/cards")).statusCode).toBe(403);
      expect((await f.call("GET", "/api/plan-tasks/task-other/cards")).statusCode).toBe(404);
    } finally { await f.close(); }
  });

  it("四列加标记照第 3 节算：待处理和受阻留在进行中；老事项也有 card；退回的不上看板", async () => {
    const f = await boardFixture();
    try {
      const ids: Record<string, string> = {};
      for (const name of ["todo", "approval", "reply", "paused", "review", "failedOnce", "failedReturned", "blocked", "crashed", "crashedOnce", "held", "done", "returned", "otherTask"])
        ids[name] = await f.card(name, name === "otherTask" ? { planTaskId: "task-theirs" } : {});
      for (const name of Object.keys(ids).filter((key) => !["todo", "done", "returned", "otherTask"].includes(key))) await status(f, ids[name], "in_progress");
      await status(f, ids.done, "done");
      await status(f, ids.returned, "returned");
      await run(f, ids.approval, "waiting_permission", 1);
      await run(f, ids.reply, "idle", 1);
      // 执行方在问本人（本机 idle 带 question）才是等你回复；不带的 idle 是一轮做完停下（已暂停，见新首页的测试）。
      await f.t.sql("UPDATE local_runs SET ask=$2::jsonb WHERE task_id=$1", [ids.reply, JSON.stringify({ kind: "question", request: { requestId: "q-1",
        questions: [{ question: "先做哪一页？", header: "顺序", options: [], multiSelect: false }], askedAt: "2026-11-06T01:00:00.000Z" } })]);
      await run(f, ids.paused, "exited", 1);
      await handback(f, ids.review, 1, { status: "queued" });
      await handback(f, ids.failedOnce, 1, { outcome: "fail", verdicts: ["met", "partial"] });
      await run(f, ids.failedReturned, "running", 1);
      await handback(f, ids.failedReturned, 1, { outcome: "fail", verdicts: ["met", "unmet"], returned: true });
      await handback(f, ids.blocked, 1, { outcome: "fail", verdicts: ["unmet", "unmet"], returned: true });
      await handback(f, ids.blocked, 2, { outcome: "fail", verdicts: ["met", "unmet"], returned: true });
      await run(f, ids.crashed, "failed", 1);
      await run(f, ids.crashed, "failed", 2);
      // 异常退出一次：已暂停（连续两次才受阻）。停着等额度恢复（本机报了 hold）：不是等你回复。
      await run(f, ids.crashedOnce, "failed", 1);
      await run(f, ids.held, "idle", 1);
      await f.t.sql(`UPDATE local_runs SET hold='{"reason":"usage_limit","until":"2026-11-06T05:00:00.000Z"}'::jsonb WHERE task_id=$1`, [ids.held]);
      const body = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json();
      const card = (name: string) => body.cards.find((item: { id: string }) => item.id === ids[name])?.card;
      const shown = ["todo", "approval", "reply", "paused", "review", "failedOnce", "failedReturned", "blocked", "crashed", "crashedOnce", "held", "done"];
      expect(body.cards.map((item: { title: string }) => item.title)).toEqual(shown);
      expect(Object.fromEntries(shown.map((name) => [name, [card(name).stage, card(name).wait]]))).toEqual({
        todo: ["todo", null], approval: ["doing", "approval"], reply: ["doing", "reply"], paused: ["doing", "paused"], review: ["review", null],
        failedOnce: ["doing", "review_failed"], failedReturned: ["doing", null], blocked: ["doing", "blocked"], crashed: ["doing", "blocked"],
        crashedOnce: ["doing", "paused"], held: ["doing", null], done: ["done", null] });
      expect(card("todo")).toEqual({ stage: "todo", wait: null, role: null, executor: null, model: null, criterion: null, run: null, handback: null, deliverable: null, after: [], sourceWords: [] });
      expect(card("approval").run).toMatchObject({ deviceId: DEVICE, deviceName: "本机", state: "waiting_permission", plan: { done: 1, total: 2, step: 2, current: "写" },
        lastActivity: { text: "在做" }, cost: { inputTokens: 0, outputTokens: 0, costUsd: null }, endedAt: null });
      expect(card("failedOnce").handback).toMatchObject({ attempt: 1, status: "done", outcome: "fail", met: 1, total: 2, headline: "结论",
        returnText: "验收没过：第 2 条", returnedAt: null, overruled: false });
      // 别的地方读到的执行事项（TaskView）也带着同一张卡：事项详情、本人的事项列表。
      expect((await f.call("GET", `/api/me/tasks/${ids.blocked}`)).json().task.card).toEqual(card("blocked"));
      const home = (await f.call("GET", "/api/me/home")).json();
      expect(home.myTasks.find((item: { id: string }) => item.id === ids.approval).card).toEqual(card("approval"));
    } finally { await f.close(); }
  });

  it("推翻过的验收按本人的判断算；进了准备中的卡写下一版的号，进了某一版的写那一版", async () => {
    const f = await boardFixture();
    try {
      const overruledFail = await f.card("没过但本人算通过");
      const overruledPass = await f.card("通过但本人推翻");
      const pending = await f.card("准备中");
      const included = await f.card("已纳入");
      await status(f, overruledFail, "done");
      await handback(f, overruledFail, 1, { outcome: "fail", verdicts: ["unmet", "met"], overruled: true });
      await status(f, overruledPass, "in_progress");
      await handback(f, overruledPass, 1, { outcome: "pass", verdicts: ["met", "met"], overruled: true });
      await status(f, pending, "done");
      const [pendingHandback] = await handback(f, pending, 1, { outcome: "pass", verdicts: ["met", "met"] });
      await f.t.sql("INSERT INTO deliverable_pending_items(id,plan_task_id,handback_id,added_by) VALUES($1,'task-open',$2,$3)", [randomUUID(), pendingHandback.id, TEST_MEMBER.personId]);
      await status(f, included, "done");
      const [includedHandback] = await handback(f, included, 1, { outcome: "pass", verdicts: ["met", "met"] });
      const version = randomUUID();
      await f.t.sql(`INSERT INTO deliverable_versions(id,task_id,mission_id,author_id,number,task_name,basis,criteria) VALUES($1,'task-open','mine',$2,1,'对话质量达标','acceptance','[]')`,
        [version, TEST_MEMBER.personId]);
      await f.t.sql("INSERT INTO deliverable_pending_items(id,plan_task_id,handback_id,added_by,version_id) VALUES($1,'task-open',$2,$3,$4)",
        [randomUUID(), includedHandback.id, TEST_MEMBER.personId, version]);
      const body = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json();
      const card = (id: string) => body.cards.find((item: { id: string }) => item.id === id).card;
      expect(card(overruledFail)).toMatchObject({ stage: "done", wait: null, handback: { outcome: "fail", overruled: true } });
      expect(card(overruledPass)).toMatchObject({ stage: "doing", wait: "review_failed" });
      expect(card(pending).deliverable).toEqual({ state: "pending", versionNumber: 2 });
      expect(card(included).deliverable).toEqual({ state: "included", versionNumber: 1 });
      expect(body.nextVersion).toBe(2);
      expect(body.pending).toMatchObject([{ kind: "card", title: "准备中", cardId: pending, topicId: null, topicVersionId: null }]);
    } finally { await f.close(); }
  });

  it("推进人改执行方、模型、交代、对哪条标准；版本不对 409；卡的详情和开工交代只给推进人", async () => {
    const f = await boardFixture();
    try {
      const id = await f.card("写方案");
      const patch = (payload: Record<string, unknown>) => f.call("PATCH", `/api/me/cards/${id}`, payload);
      const changed = await patch({ version: 1, executor: "claude_code", model: { id: "opus", label: "订阅 · Opus", kind: "subscription" }, brief: "先读题库", criterionIndex: 2 });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toMatchObject({ id, version: 2, card: { executor: "claude_code", model: { id: "opus", label: "订阅 · Opus", kind: "subscription" },
        criterion: { index: 2, text: "有新人上手录屏" } } });
      expect((await patch({ version: 2, criterionIndex: 3 })).json()).toMatchObject({ code: "CRITERION_OUT_OF_RANGE" });
      const stale = await patch({ version: 1, brief: "改" });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT", latestTask: { id, version: 2 } });
      expect((await patch({ version: 2 })).statusCode).toBe(400);
      expect((await patch({ version: 2, criterionIndex: null, model: null })).json().card).toMatchObject({ criterion: null, model: null, executor: "claude_code" });

      await f.t.sql(`INSERT INTO deliverable_versions(id,task_id,mission_id,author_id,number,task_name,basis,criteria,review_status,review)
        VALUES($1,'task-open','mine',$2,1,'对话质量达标','acceptance','[]','done',$3::jsonb)`, [randomUUID(), TEST_MEMBER.personId,
        JSON.stringify({ headline: "差一条", summary: "", gain: null, criteria: [{ index: 1, verdict: "met", reason: "", evidence: "x", fix: null, dissent: null },
          { index: 2, verdict: "unmet", reason: "", evidence: null, fix: "补一段新人上手录屏", dissent: null }] })]);
      await patch({ version: 3, criterionIndex: 2 });
      await handback(f, id, 1, { outcome: "fail", verdicts: ["met", "unmet"] });
      const brief = await f.call("GET", `/api/me/cards/${id}/brief`);
      expect(brief.statusCode).toBe(200);
      expect(brief.json()).toMatchObject({ mission: { missionId: "mine", title: "内部版上线" }, task: { taskId: "task-open", name: "对话质量达标" },
        criterion: { index: 2, text: "有新人上手录屏", proof: null }, exclusions: [], reviewGap: "补一段新人上手录屏", lastReturn: "验收没过：第 2 条" });
      for (const text of ["# 执行事项：写方案", "Mission：内部版上线", "Task：对话质量达标", "第 2 条标准：有新人上手录屏", "先读题库", "1. 有方案文档", "2. 有评审结论",
        "补一段新人上手录屏", "验收没过：第 2 条"]) expect(brief.json().markdown).toContain(text);

      await run(f, id, "running", 1);
      const detail = (await f.call("GET", `/api/me/cards/${id}`)).json();
      expect(detail).toMatchObject({ task: { id, card: { stage: "todo" } }, brief: "先读题库", standards: ["有方案文档", "有评审结论"], outputs: [] });
      expect(detail.runs).toMatchObject([{ state: "running", planEntries: [{ content: "读" }, { content: "写" }], timeline: [] }]);
      expect(detail.handbacks).toMatchObject([{ attempt: 1, outcome: "fail", criteria: ["有方案文档", "有评审结论"],
        result: { criteria: [{ index: 1, text: "有方案文档", verdict: "met" }, { index: 2, text: "有评审结论", verdict: "unmet", fix: "补上" }], beyondScope: [] } }]);
      const third = await f.t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: f.t.publicOrigin }, payload: { loginId: THIRD.loginId, passcode: THIRD.passcode } });
      const cookie = (third.headers["set-cookie"] as string).split(";")[0];
      expect((await f.call("GET", `/api/me/cards/${id}`, undefined, cookie)).statusCode).toBe(404);
      expect((await f.call("GET", `/api/me/cards/${id}/brief`, undefined, cookie)).statusCode).toBe(404);
    } finally { await f.close(); }
  });
});
