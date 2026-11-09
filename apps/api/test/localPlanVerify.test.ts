import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CompanyReader, CompanyRequest, CompanyViewer } from "../src/company.js";
import { TEST_MEMBER } from "./helpers.js";
import { boardFixture } from "./boardFixture.js";

/**
 * V2 第 21 节：拆卡和验收在本人电脑上做。云端拆卡、云端验收的开关关着（BOARD_CLOUD_AGENTS 缺省），
 * 规划员经同步条目 card_plan 报派活单，验收员先取验收交代、再经 verdict 报结论；伙伴和 Task 页只「登记拆卡」。
 */

type Subject = Record<string, string>;
type PlanCard = { title?: string; brief?: string; doneDefinition?: string; criterionIndex?: number | null; role?: string | null; modelTier?: string; why?: string | null;
  after?: number[]; sourceWords?: string[] };

const plan = (revision: number, cards: PlanCard[]) => ({ revision, summary: "先打分再录屏", steps: [{ title: "跑题库", detail: null }, { title: "录屏", detail: "约一位新人" }],
  risks: ["题库不全"], modelLabel: "claude-opus-5.5", roleId: null, roleVersion: null,
  cards: cards.map((card, index) => ({ title: `第 ${index + 1} 件`, brief: "照交代做", doneDefinition: "有结果", criterionIndex: 1, role: null, modelTier: "normal", why: null, ...card })) });

async function localFixture(runtime: Parameters<typeof boardFixture>[0] = {}) {
  const cloud = { accept: 0, plan: 0 };
  const f = await boardFixture({ boardAgents: {
    acceptance: { async accept() { cloud.accept++; throw new Error("云端验收关着，不该调"); } },
    plan: { async plan() { cloud.plan++; throw new Error("云端拆卡关着，不该调"); } },
    proposal: { async propose() { throw new Error("测试里不写岗位修改"); } },
  }, ...runtime }, { boardCloudAgents: false, internalChatToken: "chat-token" });
  const machine = await f.local();
  let seq = 0;
  /** 本机在一个会话里报几条，返回会话 id 和 accepted / rejected。 */
  const sync = async (subject: Subject, items: [string, unknown][], session: string = randomUUID()) => {
    const res = await f.t.app.inject({ method: "POST", url: "/api/local-runner/sync", headers: { authorization: `Bearer ${machine.token}` }, payload: {
      deviceId: machine.device, runnerVersion: "0.1.0", slots: { max: 3, running: 1, queued: 0 },
      items: items.map(([type, data]) => ({ key: `${machine.device}:${session}:${++seq}`, sessionId: session, subject,
        occurredAt: new Date(Date.UTC(2026, 10, 6, 4, 0, seq)).toISOString(), type, data })) } });
    expect(res.statusCode).toBe(200);
    return { session, ...res.json() as { accepted: string[]; rejected: { key: string; code: string }[] } };
  };
  const brief = (handbackKey: string, token = machine.token) => f.t.app.inject({ method: "GET",
    url: `/api/local-runner/verify-brief?handbackKey=${encodeURIComponent(handbackKey)}`, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { ...f, machine, sync, brief, cloud };
}

describe("拆卡和验收在本机（第 21 节）", { timeout: 30_000 }, () => {
  it("规划员的派活单变成草稿：岗位按名字对上本人的或预设，越界的条号当没对上；同一会话再出一次换掉没处理的草稿，晚到的旧一次不收；放进看板时没岗位的卡兜底挂上预设，worker 列表里都有", async () => {
    const f = await localFixture();
    try {
      const dev = (await f.call("POST", "/api/me/roles", { name: "开发", family: "dev", kind: "worker", dutiesMd: "写代码", modelTier: "light" })).json().id as string;
      const first = await f.sync({ kind: "plan", taskId: "task-open" }, [["card_plan", plan(1, [
        { title: "跑一遍题库打分", role: "开发", criterionIndex: 1, modelTier: "strong", why: "第 1 条要打分结果" },
        { title: "写复盘", role: "调研员", criterionIndex: 9 },
        { title: "随手", doneDefinition: "  有一行\n\n有两行 " },
      ])]]);
      expect(first.rejected).toEqual([]);
      let board = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json();
      expect(board.plan).toMatchObject({ status: "done", source: "local", revision: 1, summary: "先打分再录屏", risks: ["题库不全"],
        steps: [{ title: "跑题库", detail: null }, { title: "录屏", detail: "约一位新人" }] });
      expect(board.drafts).toMatchObject([
        { title: "跑一遍题库打分", role: { id: dev, name: "开发" }, suggestPresetKey: null, criterionIndex: 1, executor: "claude_code", modelTier: "strong", why: "第 1 条要打分结果" },
        { title: "写复盘", role: null, suggestPresetKey: "researcher", criterionIndex: null },
        { title: "随手", role: null, suggestPresetKey: null, doneDefinition: "有一行\n有两行" },
      ]);
      expect(await f.t.sql("SELECT source,model_label,run_id::text FROM card_plans")).toEqual([{ source: "local", model_label: "claude-opus-5.5", run_id: first.session }]);

      // 本人让它改，同一会话出第 2 次：上一次没处理的草稿收起来，换成这一次的。
      expect((await f.sync({ kind: "plan", taskId: "task-open" }, [["card_plan", plan(2, [{ title: "跑题库", role: null }, { title: "调研对手", role: "researcher" }])]], first.session)).rejected).toEqual([]);
      // 第 1 次晚到（重排的旧条目）：收下但不动草稿。
      expect((await f.sync({ kind: "plan", taskId: "task-open" }, [["card_plan", plan(1, [{ title: "晚到的" }])]], first.session)).rejected).toEqual([]);
      board = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json();
      expect(board.plan).toMatchObject({ revision: 2 });
      expect(board.drafts.map((draft: { title: string }) => draft.title)).toEqual(["跑题库", "调研对手"]);

      // 不是负责人的 Task、看不到的 Task、挂错会话的都拒收。
      const theirs = await f.sync({ kind: "plan", taskId: "task-theirs" }, [["card_plan", plan(1, [{}])]]);
      const hidden = await f.sync({ kind: "plan", taskId: "task-other" }, [["card_plan", plan(1, [{}])]]);
      const onCard = await f.sync({ kind: "card", cardId: await f.card("一张卡") }, [["card_plan", plan(1, [{}])]]);
      expect([theirs, hidden, onCard].map((res) => res.rejected.map((item) => item.code))).toEqual([["NOT_OWNER"], ["NOT_FOUND"], ["INVALID_SUBJECT"]]);

      // 放进看板：没岗位的照「执行员」预设给本人加上，建议了预设的照那个预设加上。
      const accepted = await f.call("POST", "/api/plan-tasks/task-open/card-drafts/accept", { drafts: board.drafts.map((draft: { id: string }) => ({ id: draft.id })) });
      expect(accepted.statusCode).toBe(200);
      const roles = await f.t.sql("SELECT id::text,preset_key FROM roles WHERE owner_id=$1 AND preset_key IS NOT NULL ORDER BY preset_key", [TEST_MEMBER.personId]);
      expect(roles.map((role) => role.preset_key)).toEqual(["executor", "researcher"]);
      expect(accepted.json().cards.map((card: { card: { role: { id: string } | null } }) => card.card.role?.id))
        .toEqual([roles[0].id, roles[1].id]);
      // 派活单没写先后：卡不用等。
      expect(accepted.json().cards.map((card: { card: { after: string[] } }) => card.card.after)).toEqual([[], []]);
      const workers = (await f.call("GET", "/api/me/workers")).json();
      const listed = JSON.stringify(workers);
      for (const card of accepted.json().cards as { id: string }[]) expect(listed).toContain(card.id);
      expect(f.cloud).toEqual({ accept: 0, plan: 0 });
    } finally { await f.close(); }
  });

  it("登记拆卡只记一笔不起作业：Task 页和伙伴都能登记，同一个 Task 只有一条没开工的；网页读、去掉；规划员交代带 Task、约定、能派的岗位和规划员；云端拆卡关着时 409", async () => {
    const f = await localFixture();
    try {
      await f.card("已有的一张");
      expect((await f.call("POST", "/api/plan-tasks/task-open/card-plans", {})).json()).toMatchObject({ code: "CLOUD_AGENTS_OFF" });
      const web = await f.call("POST", "/api/plan-tasks/task-open/card-splits");
      expect(web.statusCode).toBe(201);
      expect(web.json()).toMatchObject({ taskId: "task-open", taskName: "对话质量达标", missionId: "mine", origin: "web" });
      const again = await f.call("POST", "/api/plan-tasks/task-open/card-splits");
      expect([again.statusCode, again.json().id]).toEqual([200, web.json().id]);
      expect((await f.call("GET", "/api/me/card-splits")).json()).toEqual({ requests: [web.json()] });
      expect((await f.call("DELETE", `/api/me/card-splits/${web.json().id}`)).statusCode).toBe(204);
      expect((await f.call("DELETE", `/api/me/card-splits/${web.json().id}`)).statusCode).toBe(404);

      const internal = (headers: Record<string, string>, taskId = "task-open") => f.t.app.inject({ method: "POST", url: `/internal/plan-tasks/${taskId}/card-splits`, headers });
      const buddy = await internal({ authorization: "Bearer chat-token", "x-owner-id": TEST_MEMBER.personId });
      expect([buddy.statusCode, buddy.json().origin]).toEqual([201, "buddy"]);
      expect((await f.call("GET", "/api/me/card-splits")).json().requests.map((item: { id: string }) => item.id)).toEqual([buddy.json().id]);
      expect((await internal({ authorization: "Bearer chat-token", "x-owner-id": TEST_MEMBER.personId }, "task-theirs")).statusCode).toBe(403);
      expect((await internal({ authorization: "Bearer chat-token", "x-owner-id": "nobody" })).statusCode).toBe(404);
      expect((await internal({ authorization: "Bearer wrong", "x-owner-id": TEST_MEMBER.personId })).statusCode).toBe(401);
      expect((await f.call("POST", "/api/plan-tasks/task-theirs/card-splits")).statusCode).toBe(403);
      expect(await f.t.sql("SELECT count(*)::int AS n FROM card_plans")).toEqual([{ n: 0 }]);

      await f.call("POST", "/api/me/roles", { name: "开发", family: "dev", kind: "worker", dutiesMd: "写代码\n\n第二段不进摘要", modelTier: "light" });
      const brief = await f.call("GET", "/api/plan-tasks/task-open/plan-brief");
      expect(brief.statusCode).toBe(200);
      const body = brief.json();
      expect(body).toMatchObject({ role: { name: "规划员", kind: "worker", modelTier: "strong" }, task: { taskId: "task-open", name: "对话质量达标", missionId: "mine" },
        criteria: [{ index: 1, text: "有题库打分结果", proof: null }, { index: 2, text: "有新人上手录屏", proof: null }], exclusions: [] });
      expect(body.roles).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "开发", presetKey: null, dutiesSummary: "写代码", modelTier: "light" }),
        expect.objectContaining({ name: "执行员", id: null, presetKey: "executor" }),
        expect.objectContaining({ name: "调研员", id: null, presetKey: "researcher" })]));
      expect(body.roles.map((role: { name: string }) => role.name)).not.toContain("规划员");
      expect(body.roles.map((role: { kind: string }) => role.kind)).not.toContain("reviewer");
      for (const text of ["# 拆卡：对话质量达标", "propose_plan", "get_task_context", "1. 有题库打分结果", "卡：已有的一张", "- 开发（轻档）：写代码", "- 执行员（预设 executor，",
        // 标题的规矩（短的动宾短语，细节进交代和完成标准）照样交代给本机规划员。
        "中文 12 个字以内", "不重复项目名"])
        expect(body.markdown).toContain(text);
      expect((await f.call("GET", "/api/plan-tasks/task-theirs/plan-brief")).statusCode).toBe(403);
    } finally { await f.close(); }
  });

  it("本机验收员：交回不排云端验收；验收交代带标准、自评、点名的产出和证据；没过写改法、第二次没过记岗位修改，交代里带上一次没过的地方；过了进准备中；已经有结论的再报拒收", async () => {
    const f = await localFixture();
    try {
      const card = await f.card("出方案");
      // 卡挂一个本人的岗位：验收交代带它的验收口径，第二次没过时给它提修改。
      const role = (await f.call("POST", "/api/me/roles", { name: "写方案", family: "dev", kind: "worker", acceptanceMd: "方案要有取舍", modelTier: "normal" })).json().id as string;
      await f.t.sql("UPDATE tasks SET role_id=$2 WHERE id=$1", [card, role]);
      const first = await f.machine.handBack(card);
      await f.t.app.cardAcceptance.idle();
      expect((await f.t.sql("SELECT status,outcome FROM card_handbacks WHERE id=$1", [first]))[0]).toEqual({ status: "queued", outcome: null });
      const keyOf = async (id: string) => (await f.t.sql("SELECT client_id FROM card_handbacks WHERE id=$1", [id]))[0].client_id as string;
      const key = await keyOf(first);

      const brief = await f.brief(key);
      expect(brief.statusCode).toBe(200);
      expect(brief.json()).toMatchObject({ criteria: ["有方案文档", "有评审结论"], role: { name: "验收员", kind: "reviewer", modelTier: "strong" }, failStreak: 0 });
      for (const text of ["# 验收：出方案", "1. 有方案文档", "submit_verdict", "## 写方案的验收口径", "方案要有取舍", "第 1 条：达到。方案.md", "产出「方案.md」", "https://example.com/review"])
        expect(brief.json().markdown).toContain(text);
      expect((await f.brief(key, "")).statusCode).toBe(401);
      expect((await f.brief("not-a-handback-key")).statusCode).toBe(404);

      const verify = { kind: "verify", cardId: card, handbackKey: key };
      const verdict = (criteria: { index: number; verdict: string; fix?: string }[]) => ({ passed: criteria.every((item) => item.verdict === "met"), summary: "逐条看过",
        criteria: criteria.map(({ index, verdict, fix }) => ({ index, verdict, reason: verdict === "met" ? "对得上" : "缺评审结论", evidence: null, fix: fix ?? null })),
        beyondScope: [], modelLabel: "claude-sonnet-5", roleId: null, roleVersion: 1 });
      expect((await f.sync(verify, [["verdict", verdict([{ index: 1, verdict: "met" }])]])).rejected.map((item) => item.code)).toEqual(["INVALID_VERDICT"]);
      const failed = await f.sync(verify, [["verdict", verdict([{ index: 1, verdict: "met" }, { index: 2, verdict: "partial", fix: "补上评审会的结论" }])]]);
      expect(failed.rejected).toEqual([]);
      expect((await f.t.sql(`SELECT outcome,return_text,returned_at,verifier_source,verifier_model,verifier_role_version,verify_run_id::text FROM card_handbacks WHERE id=$1`, [first]))[0])
        .toEqual({ outcome: "fail", return_text: "验收没过：第 2 条「有评审结论」，缺评审结论；怎么补：补上评审会的结论。改完再交回。", returned_at: null,
          verifier_source: "local", verifier_model: "claude-sonnet-5", verifier_role_version: 1, verify_run_id: failed.session });
      expect((await f.call("GET", `/api/me/cards/${card}`)).json().handbacks[0]).toMatchObject({ outcome: "fail",
        verifier: { source: "local", modelLabel: "claude-sonnet-5", roleVersion: 1 } });
      // 已经有结论：再报拒收，交代 409；云端重试关着。
      expect((await f.sync(verify, [["verdict", verdict([{ index: 1, verdict: "met" }, { index: 2, verdict: "met" }])]])).rejected.map((item) => item.code)).toEqual(["ALREADY_JUDGED"]);
      expect((await f.brief(key)).statusCode).toBe(409);
      expect((await f.call("POST", `/api/me/cards/${card}/handbacks/${first}/retry`)).json()).toMatchObject({ code: "CLOUD_AGENTS_OFF" });
      // 验收员的会话不算卡的执行。
      expect((await f.call("GET", `/api/me/cards/${card}`)).json().runs.map((run: { id: string }) => run.id)).not.toContain(failed.session);

      const second = await f.machine.handBack(card);
      const secondKey = await keyOf(second);
      const secondBrief = (await f.brief(secondKey)).json();
      expect(secondBrief.failStreak).toBe(1);
      expect(secondBrief.markdown).toContain("## 上一次没过的地方");
      expect(secondBrief.markdown).toContain("怎么补：补上评审会的结论");
      await f.sync({ kind: "verify", cardId: card, handbackKey: secondKey }, [["verdict", verdict([{ index: 1, verdict: "met" }, { index: 2, verdict: "unmet", fix: "开评审会" }])]]);
      expect(await f.t.sql("SELECT source_kind,source_id::text FROM role_proposals WHERE task_id=$1", [card])).toEqual([{ source_kind: "second_fail", source_id: second }]);
      expect((await f.call("GET", `/api/me/cards/${card}`)).json().task.card.wait).toBe("blocked");

      const other = await f.card("出评审");
      const handback = await f.machine.handBack(other);
      const passed = await f.sync({ kind: "verify", cardId: other, handbackKey: await keyOf(handback) },
        [["verdict", verdict([{ index: 1, verdict: "met" }, { index: 2, verdict: "met" }])]]);
      expect(passed.rejected).toEqual([]);
      expect((await f.t.sql("SELECT status,acceptance->>'verdict' AS verdict FROM tasks WHERE id=$1", [other]))[0]).toEqual({ status: "done", verdict: "本机验收员验收通过（2/2）" });
      expect(await f.t.sql("SELECT handback_id::text FROM deliverable_pending_items WHERE plan_task_id='task-open'")).toEqual([{ handback_id: handback }]);
      expect((await f.t.sql("SELECT content FROM thread_messages WHERE object_type='task' AND object_id=$1 ORDER BY id DESC LIMIT 1", [other]))[0].content)
        .toBe("本机验收员验收通过（2/2）。");
      expect(f.cloud).toEqual({ accept: 0, plan: 0 });
    } finally { await f.close(); }
  });

  it("卡的先后只算 Agent 做的卡：要等的卡是本人自己做的就不等（只等它的卡可以直接开始）；看板、卡的详情一样；执行方后来改了跟着变", async () => {
    const f = await localFixture();
    try {
      await f.sync({ kind: "plan", taskId: "task-open" }, [["card_plan", plan(1, [{ title: "Agent 做" }, { title: "本人约人" }, { title: "总验收", after: [1, 2] },
        { title: "只等本人的", after: [2] }])]]);
      const drafts = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json().drafts as { id: string; title: string }[];
      const id = (title: string) => drafts.find((item) => item.title === title)!.id;
      const cards = (await f.call("POST", "/api/plan-tasks/task-open/card-drafts/accept", { drafts: [{ id: id("Agent 做") },
        { id: id("本人约人"), executor: "self" }, { id: id("总验收") }, { id: id("只等本人的") }] })).json().cards as
        { id: string; version: number; title: string; card: { after: string[]; executor: string } }[];
      const [agent, self, total, onlySelf] = cards;
      expect(self.card.executor).toBe("self");
      expect([total.card.after, onlySelf.card.after]).toEqual([[agent.id], []]);
      const after = async (card: string) => (await f.call("GET", `/api/me/cards/${card}`)).json().task.card.after;
      const onBoard = async (card: string) => (await f.call("GET", "/api/plan-tasks/task-open/cards")).json().cards.find((item: { id: string }) => item.id === card).card.after;
      expect([await after(total.id), await onBoard(total.id), await after(onlySelf.id), await onBoard(onlySelf.id)]).toEqual([[agent.id], [agent.id], [], []]);
      // 「本人约人」改成交给 Claude Code：两张卡都要等它了。
      expect((await f.call("PATCH", `/api/me/cards/${self.id}`, { version: self.version, executor: "claude_code" })).statusCode).toBe(200);
      expect([await after(total.id), await after(onlySelf.id)]).toEqual([[agent.id, self.id], [self.id]]);
    } finally { await f.close(); }
  });

  it("卡的先后：派活单写要等前面哪几件，放进看板以后换成那几张卡的 id（先放后放都对得上）；本机报在等前面的卡，worker 行写等哪几张；不写先后的照旧", async () => {
    const f = await localFixture();
    try {
      // 只能等排在前面的：第 1 件等第 1 件不收。
      expect((await f.sync({ kind: "plan", taskId: "task-open" }, [["card_plan", plan(1, [{ title: "自己等自己", after: [1] }])]])).rejected
        .map((item) => item.code)).toEqual(["INVALID_PLAN"]);
      await f.sync({ kind: "plan", taskId: "task-open" }, [["card_plan", plan(1, [{ title: "做 A" }, { title: "做 B" }, { title: "总验收", after: [1, 2] }, { title: "不相干" }])]]);
      const drafts = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json().drafts as { id: string; title: string }[];
      const draft = (title: string) => drafts.find((item) => item.title === title)!.id;
      const accept = async (titles: string[]) => (await f.call("POST", "/api/plan-tasks/task-open/card-drafts/accept",
        { drafts: titles.map((title) => ({ id: draft(title) })) })).json().cards as { id: string; title: string; card: { after: string[] } }[];
      // 先放「总验收」：要等的两张还没放进看板，先空着；再放 A、B，「总验收」就等它们。
      const [total] = await accept(["总验收"]);
      expect(total.card.after).toEqual([]);
      const [a, b, other] = await accept(["做 A", "做 B", "不相干"]);
      expect([a, b, other].map((card) => card.card.after)).toEqual([[], [], []]);
      expect((await f.call("GET", `/api/me/cards/${total.id}`)).json().task.card.after).toEqual([a.id, b.id]);
      const board = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json();
      expect(board.cards.find((card: { id: string }) => card.id === total.id).card.after).toEqual([a.id, b.id]);

      // 本机开工：「总验收」排着等 A、B；「不相干」等空位。
      const status = (state: string, waitingFor?: string[]) => ["status", { status: state, title: "卡", agent: "claude-code", modelLabel: "订阅 · Opus",
        ...(waitingFor ? { waitingFor } : {}) }] as [string, unknown];
      const waiting = await f.sync({ kind: "card", cardId: total.id }, [status("queued", [a.id, b.id])]);
      await f.sync({ kind: "card", cardId: other.id }, [status("queued")]);
      const row = async (card: string) => { const body = (await f.call("GET", "/api/me/workers")).json();
        return [...body.running, ...body.queued].find((item: { key: string }) => item.key === `card:${card}`); };
      expect(await row(total.id)).toMatchObject({ queueReason: "prior_cards", queuePosition: null, stage: "todo",
        waitingFor: [{ cardId: a.id, title: "做 A" }, { cardId: b.id, title: "做 B" }] });
      // 在等前面的卡的不占等空位的号：「不相干」排第 1。
      expect(await row(other.id)).toMatchObject({ queueReason: "slot", queuePosition: 1, waitingFor: [] });
      // A 合回了：只等 B；开始做了：不在已排队里。
      await f.sync({ kind: "card", cardId: total.id }, [status("queued", [b.id])], waiting.session);
      expect((await row(total.id)).waitingFor).toEqual([{ cardId: b.id, title: "做 B" }]);
      await f.sync({ kind: "card", cardId: total.id }, [status("running")], waiting.session);
      expect(await row(total.id)).toMatchObject({ queueReason: null, waitingFor: [] });
      expect(await f.t.sql("SELECT waiting_for FROM local_runs WHERE id=$1", [waiting.session])).toEqual([{ waiting_for: null }]);
    } finally { await f.close(); }
  });

  it("卡在自己的工作树里做（ADR 0038）：交回记分支和提交、结论记验的提交；卡的详情、看板上的卡、worker 行、准备中都看得到；在文件夹里做的为空", async () => {
    const f = await localFixture();
    try {
      const dev = (await f.call("POST", "/api/me/roles", { name: "开发", family: "dev", kind: "worker" })).json().id as string;
      const withRole = async (title: string) => {
        const id = await f.card(title);
        await f.call("PATCH", `/api/me/cards/${id}`, { version: 1, roleId: dev, executor: "claude_code" });
        return id;
      };
      const [inTree, inFolder] = [await withRole("改登录页"), await withRole("写说明")];
      const git = { branch: "tianshu/1a2b3c4d-login", baseBranch: "main", baseCommit: "a".repeat(40), commit: "b".repeat(40) };
      const claims = [{ index: 1, result: "met", evidence: "页面改好了" }, { index: 2, result: "met", evidence: "评审过了" }];
      const handedBack = await f.sync({ kind: "card", cardId: inTree }, [["handback", { summary: "做完了", criteria: claims, outputKeys: [], git }]]);
      expect(handedBack.rejected).toEqual([]);
      await f.sync({ kind: "card", cardId: inFolder }, [["handback", { summary: "做完了", criteria: claims, outputKeys: [] }]]);
      const handback = (await f.t.sql("SELECT id::text,client_id FROM card_handbacks WHERE task_id=$1", [inTree]))[0] as { id: string; client_id: string };

      const before = { ...git, verifiedCommit: null };
      const detail = async (card: string) => (await f.call("GET", `/api/me/cards/${card}`)).json();
      expect((await detail(inTree)).handbacks[0].git).toEqual(before);
      expect((await detail(inTree)).task.card.handback.git).toEqual(before);
      expect((await detail(inFolder)).handbacks[0].git).toBeNull();
      const board = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json();
      expect(board.cards.find((card: { id: string }) => card.id === inTree).card.handback.git).toEqual(before);
      const workers = async () => { const body = (await f.call("GET", "/api/me/workers")).json(); return [...body.running, ...body.queued, ...body.done]; };
      expect((await workers()).find((item: { key: string }) => item.key === `verify:${inTree}`).git).toEqual(before);
      expect((await workers()).find((item: { key: string }) => item.key === `verify:${inFolder}`).git).toBeNull();

      // 验收员验的是交回的那个提交：过了以后卡进准备中，验的提交跟着出来。
      const verdict = { passed: true, summary: "改动对得上", beyondScope: [], modelLabel: "订阅 · Opus", roleId: null, roleVersion: null, commit: "b".repeat(40),
        criteria: [1, 2].map((index) => ({ index, verdict: "met", reason: "对得上", evidence: null, fix: null })) };
      expect((await f.sync({ kind: "verify", cardId: inTree, handbackKey: handback.client_id }, [["verdict", verdict]])).rejected).toEqual([]);
      const after = { ...git, verifiedCommit: "b".repeat(40) };
      expect((await detail(inTree)).handbacks[0]).toMatchObject({ outcome: "pass", git: after });
      expect((await f.call("GET", "/api/plan-tasks/task-open/cards")).json().pending).toMatchObject([{ kind: "card", cardId: inTree, git: after }]);
      expect((await workers()).find((item: { key: string }) => item.key === `card:${inTree}`)).toMatchObject({ stage: "done", git: after });
      expect(await f.t.sql("SELECT verified_commit FROM card_handbacks WHERE id=$1", [handback.id])).toEqual([{ verified_commit: "b".repeat(40) }]);
    } finally { await f.close(); }
  });

  it("get_task_context：本人看得到的 Task 才读，本体按本人授权读、每条事实带 cite:world:<id>@<版本>；带 Mission、约定、上一版交付物和评审；个人令牌和本机设备令牌都能调", async () => {
    const reads: { viewer: CompanyViewer; request: CompanyRequest }[] = [];
    const companyReader: CompanyReader = { async read(viewer, request) {
      reads.push({ viewer, request });
      return { status: "ready", entries: request.query?.startsWith("本月目标")
        ? [{ handle: "goal", ref: "goal-11@3", type: "PeriodGoal", title: "11 月目标", text: "## 11 月目标\n\n内部版上线" }]
        : [{ handle: "task", ref: "task-open@4", type: "Task", title: "对话质量达标", text: "## 对话质量达标\n\n状态：进行中" }] };
    } };
    const f = await localFixture({ companyReader });
    try {
      const personal = (await f.call("POST", "/api/me/tokens", { name: "Claude Code", client: "claude", expiresInDays: null })).json().token as string;
      const mcp = (token: string, id: number, method: string, params?: Record<string, unknown>) => f.t.app.inject({ method: "POST", url: "/mcp/me",
        headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" }, payload: { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) } });
      const context = async (token: string, taskId: string) => (await mcp(token, 2, "tools/call", { name: "get_task_context", arguments: { taskId } })).json().result;
      for (const token of [personal, f.machine.token])
        expect((await mcp(token, 1, "tools/list")).json().result.tools.map((tool: { name: string }) => tool.name)).toContain("get_task_context");

      const version = (await mcp(personal, 3, "tools/call", { name: "add_deliverable_version", arguments: { taskId: "task-open", links: ["https://example.com/v1"] } })).json().result;
      expect(version.isError).toBe(false);
      await f.t.app.deliverables.idle();

      const read = await context(f.machine.token, "task-open");
      expect(read.isError).toBe(false);
      const value = JSON.parse(read.content[0].text);
      expect(value).toMatchObject({
        task: { taskId: "task-open", name: "对话质量达标", missionId: "mine", canEdit: true, exclusions: [],
          criteria: [{ index: 1, text: "有题库打分结果", proof: null, acceptor: null }, { index: 2, text: "有新人上手录屏", proof: null, acceptor: null }] },
        mission: { id: "mine", title: "内部版上线" },
        world: { status: "ready", facts: [
          { cite: "cite:world:task-open@4", type: "Task", title: "对话质量达标" },
          { cite: "cite:world:goal-11@3", type: "PeriodGoal", title: "11 月目标" }] },
        deliverable: { versions: [{ number: 1, items: [{ kind: "link", url: "https://example.com/v1" }], review: { status: "done", headline: "评过了" } }] },
      });
      expect(value.citeRule).toContain("cite:world:");
      expect(reads.map(({ viewer, request }) => [viewer.personId, request.locate, request.query])).toEqual([
        [TEST_MEMBER.personId, true, "对话质量达标 内部版上线"], [TEST_MEMBER.personId, true, expect.stringMatching(/^本月目标/)]]);

      // 看不到的 Task：当找不到，也不去读本体。
      const hidden = await context(personal, "task-other");
      expect([hidden.isError, JSON.parse(hidden.content[0].text).code]).toEqual([true, "NOT_FOUND"]);
      expect(reads).toHaveLength(2);
      expect((await context(personal, "task-theirs")).isError).toBe(false);
    } finally { await f.close(); }
  });

  it("没挂 Task 的项目也能拆卡（16.3）：登记、交代、本机规划员只带 projectId 报派活单、项目看板、放进看板（卡挂项目不挂 Task）；首页规划中、等你开工、后台任务按项目算", async () => {
    const f = await localFixture();
    try {
      await f.t.sql("INSERT INTO project_bootstraps(person_id,done_at,report) VALUES($1,now(),'{}')", [TEST_MEMBER.personId]);
      const project = (await f.call("POST", "/api/me/projects", { name: "天枢新首页" })).json().projectId as string;
      const base = `/api/me/projects/${project}`;

      // 登记：一个项目同时一条没开工的；和拆 Task 的登记互不相干；伙伴也能登记（已有就回那一条）。
      const web = await f.call("POST", `${base}/card-splits`);
      expect(web.statusCode).toBe(201);
      expect(web.json()).toEqual({ id: web.json().id, taskId: null, taskName: null, missionId: null, projectId: project, projectName: "天枢新首页", origin: "web", sourceWords: [],
        afterSequence: null,
        createdAt: web.json().createdAt });
      expect([(await f.call("POST", `${base}/card-splits`)).statusCode, (await f.call("POST", "/api/plan-tasks/task-open/card-splits")).statusCode]).toEqual([200, 201]);
      const buddy = await f.t.app.inject({ method: "POST", url: `/internal/me/projects/${project}/card-splits`,
        headers: { authorization: "Bearer chat-token", "x-owner-id": TEST_MEMBER.personId } });
      expect([buddy.statusCode, buddy.json().id]).toEqual([200, web.json().id]);
      expect((await f.call("POST", `/api/me/projects/${randomUUID()}/card-splits`)).statusCode).toBe(404);
      // 两条同一时刻登记的（测试里时钟不走），不比先后。
      expect((await f.call("GET", "/api/me/card-splits")).json().requests.map((item: { projectId: string | null; taskId: string | null }) => [item.projectId, item.taskId]))
        .toEqual(expect.arrayContaining([[project, null], [null, "task-open"]]));
      expect((await f.call("GET", "/api/me/work-home")).json().projects.find((item: { projectId: string }) => item.projectId === project).planning).toBe(true);

      // 交代：没有 Task 和约定，写项目名，要求每件自带完成标准。
      const brief = (await f.call("GET", `${base}/plan-brief`)).json();
      expect(brief).toMatchObject({ task: null, project: { projectId: project, name: "天枢新首页" }, criteria: [], exclusions: [], role: { name: "规划员" } });
      for (const text of ["# 拆卡：天枢新首页", "propose_plan", "没有 Task 的验收标准", "这个项目还没挂过 Task。", "对约定第几条一律写 null", "中文 12 个字以内"]) expect(brief.markdown).toContain(text);

      // 本机规划员只带 projectId：派活单进项目的草稿，条号一律不存。
      const running = ["status", { status: "running", title: "拆卡", agent: "claude-code", modelLabel: "订阅 · Opus" }] as [string, unknown];
      const planned = await f.sync({ kind: "plan", projectId: project }, [running, ["card_plan", plan(1, [{ title: "画首页", criterionIndex: 1 }, { title: "接接口", after: [1] }])]]);
      expect(planned.rejected).toEqual([]);
      expect(await f.t.sql("SELECT plan_task_id,project_id::text FROM local_runs WHERE id=$1", [planned.session])).toEqual([{ plan_task_id: null, project_id: project }]);
      let board = (await f.call("GET", `${base}/board`)).json();
      expect(board).toMatchObject({ projectId: project, cards: [], plan: { status: "done", source: "local", revision: 1 } });
      expect(board.drafts.map((draft: { title: string; criterionIndex: number | null }) => [draft.title, draft.criterionIndex])).toEqual([["画首页", null], ["接接口", null]]);
      expect((await f.call("GET", "/api/plan-tasks/task-open/cards")).json().drafts).toEqual([]);
      const background = (await f.call("GET", `/api/me/background?scope=project:${project}`)).json().items;
      expect(background.map((item: { title: string; kind: string; state: string }) => [item.title, item.kind, item.state])).toEqual([["拆卡：天枢新首页", "plan", "running"]]);
      let waiting = (await f.call("GET", "/api/me/work-home")).json().waiting.filter((item: { kind: string }) => item.kind === "plan_start");
      expect(waiting).toMatchObject([{ title: "天枢新首页：计划等你开工", source: "2 件等你开工", open: { kind: "project", id: project }, projectId: project, taskId: null }]);

      // 别人的项目（当找不到，同项目接口）、什么都不带的规划员会话拒收。
      const other = await f.t.sql("INSERT INTO projects(id,owner_id,name,created_at,updated_at) VALUES($1,'person-someone','别人的',now(),now()) RETURNING id::text", [randomUUID()]);
      expect([(await f.sync({ kind: "plan", projectId: other[0].id }, [["card_plan", plan(1, [{}])]])).rejected.map((item) => item.code),
        (await f.sync({ kind: "plan" }, [["card_plan", plan(1, [{}])]])).rejected.map((item) => item.code)]).toEqual([["NOT_FOUND"], ["INVALID_SUBJECT"]]);

      // 放进看板带 start：卡挂项目、不挂 Task 和 Mission，登记要开工；另一张不要了。
      const accepted = await f.call("POST", `${base}/card-drafts/accept`, { drafts: [{ id: board.drafts[0].id }], start: true });
      expect(accepted.statusCode, accepted.body).toBe(200);
      const card = accepted.json().cards[0].id as string;
      expect(await f.t.sql("SELECT plan_task_id,mission_id,project_id::text,criterion_index FROM tasks WHERE id=$1", [card]))
        .toEqual([{ plan_task_id: null, mission_id: null, project_id: project, criterion_index: null }]);
      expect(await f.t.sql("SELECT plan_task_id FROM session_starts WHERE card_id=$1", [card])).toEqual([{ plan_task_id: null }]);
      expect((await f.call("POST", `/api/card-drafts/${board.drafts[1].id}/dismiss`)).statusCode).toBe(204);
      board = (await f.call("GET", `${base}/board`)).json();
      expect([board.cards.map((item: { id: string }) => item.id), board.drafts]).toEqual([[card], []]);
      waiting = (await f.call("GET", "/api/me/work-home")).json().waiting.filter((item: { kind: string }) => item.kind === "plan_start");
      expect(waiting).toEqual([]);

      // 归档的项目不能再登记、放进看板。
      await f.call("PATCH", base, { archived: true });
      expect((await f.call("POST", `${base}/card-splits`)).json()).toMatchObject({ code: "PROJECT_ARCHIVED" });
      expect((await f.call("POST", `${base}/card-drafts/accept`, { drafts: [{ id: randomUUID() }] })).statusCode).toBe(409);
    } finally { await f.close(); }
  });

  it("派活单带上本人原话（16.8）：伙伴登记取项目对话里本人说的话、网页带上来的换掉它；交代里给规划员；改写过的片段丢掉、整件改用整条原话；卡和开工交代带原话", async () => {
    const f = await localFixture();
    try {
      await f.t.sql("INSERT INTO project_bootstraps(person_id,done_at,report) VALUES($1,now(),'{}')", [TEST_MEMBER.personId]);
      const project = (await f.call("POST", "/api/me/projects", { name: "对话质量", taskId: "task-open" })).json().projectId as string;
      const scope = encodeURIComponent(`project:${project}`);
      const say = (message: string) => f.t.app.inject({ method: "POST", url: `/api/conversations/${scope}/messages`,
        headers: { cookie: f.member, origin: f.t.publicOrigin, accept: "text/event-stream" }, payload: { message } });
      expect((await say("题库要覆盖新人最常问的 50 个问题")).statusCode).toBe(200);
      expect((await say("录屏这次先不做")).statusCode).toBe(200);

      // 伙伴登记：取本人在这件 Task 所在项目对话里说的话，旧的在前。
      const buddy = await f.t.app.inject({ method: "POST", url: "/internal/plan-tasks/task-open/card-splits",
        headers: { authorization: "Bearer chat-token", "x-owner-id": TEST_MEMBER.personId } });
      expect(buddy.json().sourceWords).toEqual(["题库要覆盖新人最常问的 50 个问题", "录屏这次先不做"]);
      // 网页按钮带上输入框里的话：已有一条没开工的，原话换成这次的；不带请求体照旧能登记，原话不动。
      const words = "先把题库打分跑一遍，录屏这次先不做，题库要覆盖新人最常问的 50 个问题";
      const web = await f.call("POST", "/api/plan-tasks/task-open/card-splits", { words: `  ${words}  ` });
      expect([web.statusCode, web.json().id, web.json().sourceWords]).toEqual([200, buddy.json().id, [words]]);
      expect((await f.t.app.inject({ method: "POST", url: "/api/plan-tasks/task-open/card-splits", headers: { cookie: f.member, origin: f.t.publicOrigin } }))
        .json().sourceWords).toEqual([words]);

      // 交代：带原话，要求原样摘。
      const brief = (await f.call("GET", "/api/plan-tasks/task-open/plan-brief")).json();
      expect(brief.sourceWords).toEqual([words]);
      for (const text of ["## 本人原话", `> ${words}`, "只能原样摘", "每件带 sourceWords"]) expect(brief.markdown).toContain(text);

      // 规划员交卷：原文片段留着；改写过的那件整件改用整条原话；没摘的也用整条原话。
      const planned = await f.sync({ kind: "plan", taskId: "task-open" }, [["card_plan", plan(1, [
        { title: "跑题库打分", sourceWords: ["  先把题库打分跑一遍 ", "题库要覆盖新人最常问的 50 个问题"] },
        { title: "补录屏", sourceWords: ["先把题库打分跑一遍", "录屏也一起做了"] },
        { title: "没摘的" },
      ])]]);
      expect(planned.rejected).toEqual([]);
      const board = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json();
      expect(board.drafts.map((draft: { title: string; sourceWords: string[] }) => [draft.title, draft.sourceWords])).toEqual([
        ["跑题库打分", ["先把题库打分跑一遍", "题库要覆盖新人最常问的 50 个问题"]],
        ["补录屏", [words]],
        ["没摘的", [words]],
      ]);

      // 放进看板：卡带原话；开工交代最前面是原话。
      const accepted = await f.call("POST", "/api/plan-tasks/task-open/card-drafts/accept", { drafts: [{ id: board.drafts[0].id }] });
      const card = accepted.json().cards[0];
      expect(card.card.sourceWords).toEqual(["先把题库打分跑一遍", "题库要覆盖新人最常问的 50 个问题"]);
      const cardBrief = (await f.call("GET", `/api/me/cards/${card.id}/brief`)).json();
      expect(cardBrief.sourceWords).toEqual(card.card.sourceWords);
      expect(cardBrief.markdown.indexOf("## 本人原话")).toBeGreaterThan(0);
      expect(cardBrief.markdown.indexOf("## 本人原话")).toBeLessThan(cardBrief.markdown.indexOf("## 完成标准"));
      // 不是从派活单建的卡：原话为空，交代里没有这一段。
      const plain = await f.card("自己建的卡");
      expect((await f.call("GET", `/api/me/cards/${plain}`)).json().task.card.sourceWords).toEqual([]);
      expect((await f.call("GET", `/api/me/cards/${plain}/brief`)).json().markdown).not.toContain("本人原话");
    } finally { await f.close(); }
  });

  it("验收和本人原话对不上（16.8）：标准全达到也算没过，改法带上是哪句原话；交回摘要和卡详情列出这几处；第二次没过时项目动态的受阻行也列", async () => {
    const f = await localFixture();
    try {
      await f.t.sql("INSERT INTO project_bootstraps(person_id,done_at,report) VALUES($1,now(),'{}')", [TEST_MEMBER.personId]);
      const project = (await f.call("POST", "/api/me/projects", { name: "对话质量", taskId: "task-open" })).json().projectId as string;
      const card = await f.card("跑题库打分");
      await f.t.sql(`UPDATE tasks SET source_words='["录屏这次先不做"]' WHERE id=$1`, [card]);
      const keyOf = async (id: string) => (await f.t.sql("SELECT client_id FROM card_handbacks WHERE id=$1", [id]))[0].client_id as string;
      const issue = { quote: "录屏这次先不做", kind: "extra", reason: "交回里多做了一份录屏" };
      const verdict = { passed: false, summary: "标准都达到，但做了原话里不要的", beyondScope: [], modelLabel: "claude-sonnet-5", roleId: null, roleVersion: null,
        criteria: [1, 2].map((index) => ({ index, verdict: "met", reason: "对得上", evidence: null, fix: null })), sourceWordIssues: [issue] };

      const first = await f.machine.handBack(card);
      expect((await f.brief(await keyOf(first))).json().sourceWords).toEqual(["录屏这次先不做"]);
      expect((await f.sync({ kind: "verify", cardId: card, handbackKey: await keyOf(first) }, [["verdict", verdict]])).rejected).toEqual([]);
      expect((await f.t.sql("SELECT outcome,return_text FROM card_handbacks WHERE id=$1", [first]))[0]).toEqual({ outcome: "fail",
        return_text: "验收没过：本人原话「录屏这次先不做」没要的做了，交回里多做了一份录屏。改完再交回。" });
      const detail = (await f.call("GET", `/api/me/cards/${card}`)).json();
      expect(detail.task.card.handback).toMatchObject({ outcome: "fail", met: 2, total: 2, sourceWordIssues: [issue] });
      expect(detail.handbacks[0].sourceWordIssues).toEqual([issue]);

      // 第二次还对不上：受阻，项目动态的受阻行列出这几处。
      const second = await f.machine.handBack(card);
      await f.sync({ kind: "verify", cardId: card, handbackKey: await keyOf(second) }, [["verdict", verdict]]);
      const blocked = (await f.call("GET", `/api/me/projects/${project}/feed`)).json().items.find((item: { kind: string }) => item.kind === "card_blocked");
      expect(blocked).toMatchObject({ cardId: card, handbackId: second, sourceWordIssues: [issue] });
      expect(blocked.fix).toContain("本人原话「录屏这次先不做」");
    } finally { await f.close(); }
  });
  it("17.2 第 29 条：拆卡那几块按序号插进项目对话——登记时记本人看到的最后一条（没带读对话最新的），派活单照登记的，开工时另记一个", async () => {
    const f = await localFixture();
    try {
      const project = (await f.call("POST", "/api/me/projects", { name: "天枢" })).json().projectId as string;
      const say = async (message: string) => expect((await f.call("POST", `/api/conversations/project:${project}/messages`, { message })).statusCode).toBe(200);
      const last = async () => ((await f.call("GET", `/api/conversations/project:${project}/messages`)).json().messages as { sequence: number }[]).at(-1)!.sequence;
      await say("先把首页拆一下");
      const seen = await last();
      expect(seen).toBeGreaterThan(1);
      // 没带：读项目对话现在最后一条；派活单照登记记的。
      const registered = (await f.call("POST", `/api/me/projects/${project}/card-splits`, { words: "拆首页" })).json();
      expect(registered.afterSequence).toBe(seen);
      expect((await f.call("GET", "/api/me/card-splits")).json().requests[0].afterSequence).toBe(seen);
      await f.sync({ kind: "plan", projectId: project }, [["card_plan", plan(1, [{ title: "画首页", criterionIndex: null }, { title: "接接口", criterionIndex: null }])]]);
      const board = async () => (await f.call("GET", `/api/me/projects/${project}/board`)).json() as { drafts: { id: string }[];
        plan: { afterSequence: number | null; startedAfterSequence: number | null } };
      expect((await board()).plan).toMatchObject({ afterSequence: seen, startedAfterSequence: null });
      // 开工：没带读对话最新的；第二次开工不改。
      await say("就按这个开始");
      const started = await last();
      const [first, second] = (await board()).drafts;
      expect((await f.call("POST", `/api/me/projects/${project}/card-drafts/accept`, { drafts: [{ id: first.id }] })).statusCode).toBe(200);
      expect((await board()).plan).toMatchObject({ afterSequence: seen, startedAfterSequence: started });
      expect((await f.call("POST", `/api/me/projects/${project}/card-drafts/accept`, { drafts: [{ id: second.id }], afterSequence: 1 })).statusCode).toBe(200);
      expect((await board()).plan.startedAfterSequence).toBe(started);
      // 网页带了：用带的。没挂项目的 Task 没带时读不到，是 null。
      expect((await f.call("POST", "/api/plan-tasks/task-open/card-splits", { afterSequence: 3 })).json().afterSequence).toBe(3);
      await f.call("DELETE", `/api/me/card-splits/${(await f.call("GET", "/api/me/card-splits")).json().requests.find((item: { taskId: string | null }) => item.taskId).id}`);
      expect((await f.call("POST", "/api/plan-tasks/task-open/card-splits", {})).json().afterSequence).toBeNull();
    } finally { await f.close(); }
  });
});
