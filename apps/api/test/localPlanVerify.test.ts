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
type PlanCard = { title?: string; brief?: string; doneDefinition?: string; criterionIndex?: number | null; role?: string | null; modelTier?: string; why?: string | null };

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
      for (const text of ["# 拆卡：对话质量达标", "propose_plan", "get_task_context", "1. 有题库打分结果", "卡：已有的一张", "- 开发（轻档）：写代码", "- 执行员（预设 executor，"])
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
});
