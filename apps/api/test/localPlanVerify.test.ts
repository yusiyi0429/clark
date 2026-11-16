import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CompanyReader, CompanyRequest, CompanyViewer } from "../src/company.js";
import { TEST_MEMBER } from "./helpers.js";
import { BOARD_NOW, boardFixture } from "./boardFixture.js";

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
        "中文 12 个字以内", "不重复项目名",
        // 本人 11/16（少开子会话）：默认 1 件，只有四种情况才多拆，最多 3 件，多拆的写是哪一条。
        "默认 1 件", "最多 3 件", "要在不同的文件夹或仓库里做", "本人明说要分开", "写是哪一条"])
        expect(body.markdown).toContain(text);
      expect(body.markdown).not.toContain("1 到 8 件");
      expect((await f.call("GET", "/api/plan-tasks/task-theirs/plan-brief")).statusCode).toBe(403);
    } finally { await f.close(); }
  });

  it("对话里说的模型要求（第 69 条）：登记拆卡带原话，登记读得到；规划员出的派活单每张草稿都原样带上；再登记一次换成新的；项目拆卡同样", async () => {
    const f = await localFixture();
    try {
      const words = "这几件用本机的 Opus 5.5，思考开高";
      const registered = await f.call("POST", "/api/plan-tasks/task-open/card-splits", { words: "拆成两件", modelWords: words });
      expect(registered.json()).toMatchObject({ modelWords: words });
      await f.sync({ kind: "plan", taskId: "task-open" }, [["card_plan", plan(1, [{ title: "跑一遍题库打分" }, { title: "录一段上手视频" }])]]);
      const drafts = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json().drafts as { modelWords: string | null }[];
      expect(drafts.map((draft) => draft.modelWords)).toEqual([words, words]);
      // 已有一条没开工的登记：再登记带新的就换。
      expect((await f.call("POST", "/api/plan-tasks/task-open/card-splits", { modelWords: "用 TokenHub" })).json()).toMatchObject({ modelWords: "用 TokenHub" });

      const projectId = (await f.call("POST", "/api/me/projects", { name: "品牌建设" })).json().projectId as string;
      expect((await f.call("POST", `/api/me/projects/${projectId}/card-splits`, { modelWords: "用 Codex" })).json()).toMatchObject({ modelWords: "用 Codex" });
      await f.sync({ kind: "plan", projectId }, [["card_plan", plan(1, [{ title: "列候选名", criterionIndex: null }])]]);
      expect((await f.call("GET", `/api/me/projects/${projectId}/board`)).json().drafts.map((draft: { modelWords: string | null }) => draft.modelWords)).toEqual(["用 Codex"]);
    } finally { await f.close(); }
  });

  it("派活单只有 1 件也能登记：变成一张草稿", async () => {
    const f = await localFixture();
    try {
      expect((await f.sync({ kind: "plan", taskId: "task-open" }, [["card_plan", plan(1, [{ title: "改个错字", criterionIndex: null }])]])).rejected).toEqual([]);
      expect((await f.call("GET", "/api/plan-tasks/task-open/cards")).json().drafts.map((draft: { title: string }) => draft.title)).toEqual(["改个错字"]);
    } finally { await f.close(); }
  });

  it("要本人补（主循环第 61 条）：交代带执行方标的 need；有一条要本人补就是等你补、不算没过、不写岗位修改、不自动送回，改法只拼执行方能补的；连续没过跳过它；就到这里算通过", async () => {
    const f = await localFixture();
    try {
      const keyOf = async (cardId: string) => (await f.t.sql("SELECT client_id FROM card_handbacks WHERE task_id=$1 ORDER BY attempt DESC LIMIT 1", [cardId]))[0].client_id as string;
      const handBack = (cardId: string, criteria: unknown[]) => f.sync({ kind: "card", cardId }, [["handback", { summary: "能做的做完了", criteria, outputKeys: [] }]]);
      const judge = async (cardId: string, criteria: { index: number; verdict: string; fix?: string; fixBy?: string }[]) =>
        (await f.sync({ kind: "verify", cardId, handbackKey: await keyOf(cardId) }, [["verdict", { passed: false, summary: "就差申请号，要你登录商标网查", beyondScope: [],
          modelLabel: "Opus 5.5", roleId: null, roleVersion: null,
          criteria: criteria.map(({ index, verdict, fix, fixBy }) => ({ index, verdict, reason: verdict === "met" ? "对得上" : "缺", evidence: null, fix: fix ?? null,
            ...(fixBy ? { fixBy } : {}) })) }]])).rejected;
      const card = async (title: string) => { const id = await f.card(title); await f.t.sql("UPDATE tasks SET executor='claude_code' WHERE id=$1", [id]); return id; };
      const view = async (cardId: string) => (await f.call("GET", `/api/me/cards/${cardId}`)).json().task.card;

      // 第一次验收就有要本人补的：直接等你补。
      const a = await card("候选名初查");
      await handBack(a, [{ index: 1, result: "met", evidence: "A1" }, { index: 2, result: "needs_person", evidence: "商标网拦自动访问", need: "登录商标网查这 3 个名字的申请号" }]);
      const brief = (await f.brief(await keyOf(a))).json().markdown as string;
      for (const text of ["第 2 条：要本人补。商标网拦自动访问", "要本人做：登录商标网查这 3 个名字的申请号", "确实只有本人能做的判 needs_person"]) expect(brief).toContain(text);
      expect(await judge(a, [{ index: 1, verdict: "met" }, { index: 2, verdict: "needs_person" }])).toEqual([]);
      expect((await f.t.sql("SELECT outcome,return_text FROM card_handbacks WHERE task_id=$1", [a]))[0]).toEqual({ outcome: "needs_person", return_text: null });
      expect(await view(a)).toMatchObject({ wait: "needs_person", handback: { outcome: "needs_person", headline: "就差申请号，要你登录商标网查", met: 1, total: 2,
        gaps: [{ index: 2, short: "有评审结论", verdict: "needs_person", fixBy: "person", fix: "登录商标网查这 3 个名字的申请号" }] } });
      expect(await f.t.sql("SELECT 1 FROM role_proposals WHERE task_id=$1", [a])).toEqual([]);
      // 首页「等你」一行，第二行是验收员那一句人话；项目动态里一条 card_needs_person 指过去。
      const project = (await f.call("POST", "/api/me/projects", { name: "品牌建设", taskId: "task-open" })).json().projectId as string;
      const home = (await f.call("GET", "/api/me/work-home")).json();
      expect(home.waiting.find((item: { kind: string }) => item.kind === "needs_person")).toMatchObject({ id: `needs_person:card:${a}`, title: "等你补",
        summary: "就差申请号，要你登录商标网查", open: { kind: "card", id: a }, answer: "open" });
      const feed = (await f.call("GET", `/api/me/projects/${project}/feed`)).json().items;
      expect(feed.find((item: { kind: string }) => item.kind === "card_needs_person")).toMatchObject({ cardId: a, fix: null,
        handback: { outcome: "needs_person", headline: "就差申请号，要你登录商标网查", gaps: [{ index: 2, fixBy: "person" }] } });
      // 就到这里：推翻成通过，卡完成。
      const handbackId = (await f.t.sql("SELECT id::text FROM card_handbacks WHERE task_id=$1", [a]))[0].id as string;
      expect((await f.call("POST", `/api/me/cards/${a}/handbacks/${handbackId}/overrule`, { reason: "申请号先不要了" })).statusCode).toBe(200);
      expect((await f.t.sql("SELECT status FROM tasks WHERE id=$1", [a]))[0].status).toBe("done");
      expect((await f.call("GET", `/api/me/projects/${project}/feed`)).json().items.find((item: { kind: string }) => item.kind === "card_passed"))
        .toMatchObject({ cardId: a, gap: "申请号先不要了" });

      // 执行方能补的和要本人补的都有：还是等你补，改法只拼执行方能补的。
      const b = await card("写说明");
      await handBack(b, [{ index: 1, result: "unmet", evidence: "" }, { index: 2, result: "unmet", evidence: "" }]);
      await judge(b, [{ index: 1, verdict: "unmet", fix: "补上文档", fixBy: "worker" }, { index: 2, verdict: "unmet", fix: "本人确认口径", fixBy: "person" }]);
      expect((await f.t.sql("SELECT outcome,return_text FROM card_handbacks WHERE task_id=$1", [b]))[0])
        .toEqual({ outcome: "needs_person", return_text: "你能补的：第 1 条「有方案文档」，缺；怎么补：补上文档。改完再交回。" });

      // 没过 → 等你补 → 再交回：连续没过只数 1 次（等你补的那次跳过）。
      const c = await card("出方案");
      await handBack(c, [{ index: 1, result: "met", evidence: "" }, { index: 2, result: "met", evidence: "" }]);
      await judge(c, [{ index: 1, verdict: "met" }, { index: 2, verdict: "unmet", fix: "补" }]);
      expect(await view(c)).toMatchObject({ wait: "review_failed", handback: { outcome: "fail" } });
      await handBack(c, [{ index: 1, result: "met", evidence: "" }, { index: 2, result: "needs_person", evidence: "", need: "本人拍板" }]);
      await judge(c, [{ index: 1, verdict: "met" }, { index: 2, verdict: "needs_person", fix: "本人拍板" }]);
      await handBack(c, [{ index: 1, result: "met", evidence: "" }, { index: 2, result: "met", evidence: "" }]);
      expect((await f.brief(await keyOf(c))).json().failStreak).toBe(1);
    } finally { await f.close(); }
  });

  it("手机上登记「我来补」「再改一轮」（主循环第 62 条）：等那台电脑认领送到，送到后不再等你补、不再受阻；就到这里记成有缺口通过", async () => {
    const f = await localFixture();
    try {
      const keyOf = async (cardId: string) => (await f.t.sql("SELECT client_id FROM card_handbacks WHERE task_id=$1 ORDER BY attempt DESC LIMIT 1", [cardId]))[0].client_id as string;
      const handBack = (cardId: string, criteria: unknown[]) => f.sync({ kind: "card", cardId }, [["handback", { summary: "交回", criteria, outputKeys: [] }]]);
      const judge = async (cardId: string, criteria: { index: number; verdict: string; fix?: string; fixBy?: string }[]) =>
        f.sync({ kind: "verify", cardId, handbackKey: await keyOf(cardId) }, [["verdict", { passed: false, summary: "就差申请号，要你查", beyondScope: [], modelLabel: "Opus 5.5",
          roleId: null, roleVersion: null, criteria: criteria.map(({ index, verdict, fix, fixBy }) => ({ index, verdict, reason: "缺", evidence: null, fix: fix ?? null,
            ...(fixBy ? { fixBy } : {}) })) }]]);
      const card = async (title: string) => { const id = await f.card(title); await f.t.sql("UPDATE tasks SET executor='claude_code' WHERE id=$1", [id]); return id; };
      const latest = async (cardId: string) => (await f.t.sql("SELECT id::text FROM card_handbacks WHERE task_id=$1 ORDER BY attempt DESC LIMIT 1", [cardId]))[0].id as string;
      const relay = async (cardId: string, body: unknown) => f.call("POST", `/api/me/cards/${cardId}/handbacks/${await latest(cardId)}/relay`, body);
      const claim = async () => (await f.call("POST", "/api/me/session-commands/claim", { deviceId: f.machine.device })).json().commands as
        { id: string; subSessionId: string; command: { text: string } }[];
      const done = (id: string) => f.call("POST", `/api/me/session-commands/${id}/done`, { deviceId: f.machine.device, result: "done" });

      // 我来补：先登记，框上「电脑在线后送到」；再登记一条 409；那台电脑认领送到后不再等你补。
      const a = await card("候选名初查");
      await handBack(a, [{ index: 1, result: "met", evidence: "" }, { index: 2, result: "needs_person", evidence: "", need: "查申请号" }]);
      await judge(a, [{ index: 1, verdict: "unmet", fix: "补上含义", fixBy: "worker" }, { index: 2, verdict: "needs_person", fix: "查申请号" }]);
      expect((await relay(a, { kind: "return" })).json()).toMatchObject({ code: "NOTHING_TO_RELAY" });
      const pending = await relay(a, { kind: "supply", text: "B 名 第 12345678 号" });
      expect(pending.statusCode).toBe(200);
      expect(pending.json().task.card).toMatchObject({ wait: "needs_person", handback: { relay: { kind: "supply", state: "pending", doneAt: null, message: null } } });
      expect((await relay(a, { kind: "supply", text: "再补一句" })).json()).toMatchObject({ code: "RELAY_PENDING" });
      const [supply] = await claim();
      expect(supply.command.text).toBe("本人补上了：\nB 名 第 12345678 号\n\n你能补的：第 1 条「有方案文档」，缺；怎么补：补上含义。改完再交回。\n\n接着做，做完再交回。");
      expect((await done(supply.id)).statusCode).toBe(204);
      const delivered = (await f.call("GET", `/api/me/cards/${a}`)).json().task.card;
      expect(delivered.wait).not.toBe("needs_person");
      expect(delivered.handback.relay).toMatchObject({ state: "delivered", doneAt: expect.any(String) });
      expect((await relay(a, { kind: "supply", text: "又一句" })).json()).toMatchObject({ code: "NOTHING_TO_RELAY" });

      // 再改一轮：连续两次没过受阻；手机上登记，送到后不再受阻。
      const b = await card("写说明");
      for (let i = 0; i < 2; i++) {
        await handBack(b, [{ index: 1, result: "met", evidence: "" }, { index: 2, result: "met", evidence: "" }]);
        await judge(b, [{ index: 1, verdict: "met" }, { index: 2, verdict: "unmet", fix: "补评审结论" }]);
      }
      expect((await f.call("GET", `/api/me/cards/${b}`)).json().task.card.wait).toBe("blocked");
      await relay(b, { kind: "return" });
      const [again] = await claim();
      expect(again.command.text).toContain("验收没过：第 2 条「有评审结论」");
      await done(again.id);
      expect((await f.call("GET", `/api/me/cards/${b}`)).json().task.card).toMatchObject({ handback: { returnedAt: expect.any(String) } });
      expect((await f.call("GET", `/api/me/cards/${b}`)).json().task.card.wait).not.toBe("blocked");

      // 批准说人话（主循环第 64 条）：「等你」那一行第二行是执行方写的那句，标题照旧是命令那一行。
      const d = await card("查商标");
      await f.sync({ kind: "card", cardId: d }, [["status", { status: "waiting_permission", title: "查商标", agent: "claude-code", modelLabel: "Opus 5.5",
        permission: { requestId: "p-1", toolName: "Bash", title: "运行 curl -A Mozilla …", outsidePaths: [], description: "查商标网上这 3 个名字", paths: ["notes/候选名.md"] } }]]);
      expect((await f.call("GET", "/api/me/work-home")).json().waiting.find((item: { id: string }) => item.id === `approval:card:${d}`))
        .toMatchObject({ title: "运行 curl -A Mozilla …", summary: "查商标网上这 3 个名字", permission: { description: "查商标网上这 3 个名字", paths: ["notes/候选名.md"] } });

      // 就到这里：有缺口通过，原因在卡上读得到。
      const c = await card("出方案");
      await handBack(c, [{ index: 1, result: "met", evidence: "" }, { index: 2, result: "met", evidence: "" }]);
      await judge(c, [{ index: 1, verdict: "met" }, { index: 2, verdict: "unmet", fix: "补" }]);
      const closed = await f.call("POST", `/api/me/cards/${c}/handbacks/${await latest(c)}/overrule`, { reason: "评审结论先不要" });
      expect(closed.json().task.card).toMatchObject({ stage: "done", handback: { passedWithGap: { reason: "评审结论先不要", at: expect.any(String) } } });
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
        afterSequence: null, modelWords: null,
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
  it("3700 小卡 U：约定后来改过，验收交代在本人原话后面列每次第几版、谁改的、原因；本人改过或确认过的跟一句以新约定为准，只有伙伴改的不跟", async () => {
    const f = await localFixture();
    try {
      const keyOf = async (id: string) => (await f.t.sql("SELECT client_id FROM card_handbacks WHERE id=$1", [id]))[0].client_id as string;
      const change = (card: string, revision: number, kind: string, reason: string) => f.t.sql(`INSERT INTO card_agreement_changes(id,card_id,owner_id,revision,by_kind,by_name,
        agreement_before,agreement_after,reason,at) VALUES(gen_random_uuid(),$1,$2,$3,$4,NULL,'{}'::jsonb,'{}'::jsonb,$5,now())`, [card, TEST_MEMBER.personId, revision, kind, reason]);
      const SENTENCE = "原话和本人改过或确认过的新约定冲突的地方，以新约定为准，不算原话没要的或漏了的。";

      const card = await f.card("生成文件清单", { doneDefinition: "新建 文件清单.md" });
      await f.t.sql(`UPDATE tasks SET source_words='["只新建 文件清单.md，别的文件都不要动"]' WHERE id=$1`, [card]);
      const version = (await f.call("GET", `/api/me/cards/${card}`)).json().task.version as number;
      expect((await f.call("PATCH", `/api/me/cards/${card}`, { version, standards: ["新建 文件清单.md", "新建 风险.md"], reason: "本人在子会话里加了 风险.md" }))
        .statusCode).toBe(200);
      await change(card, 3, "worker", "执行方说清单要带大小");
      await change(card, 4, "pipeline", "伙伴补了一句交代");
      const markdown = (await f.brief(await keyOf(await f.machine.handBack(card)))).json().markdown as string;
      const changes = ["## 约定后来改过", "", "- 第 2 版：本人直接改，原因：本人在子会话里加了 风险.md", "- 第 3 版：本人确认执行方的提议，原因：执行方说清单要带大小",
        "- 第 4 版：伙伴改的，原因：伙伴补了一句交代", "", SENTENCE].join("\n");
      expect(markdown).toContain(changes);
      expect(markdown.indexOf("## 本人原话")).toBeLessThan(markdown.indexOf("## 约定后来改过"));
      expect(markdown.indexOf("## 约定后来改过")).toBeLessThan(markdown.indexOf("## 完成标准"));

      // 只有伙伴改过：照列，不跟那句。没改过的卡不写这段。
      const buddyOnly = await f.card("只有伙伴改过", { doneDefinition: "新建 文件清单.md" });
      await change(buddyOnly, 2, "pipeline", "伙伴改的");
      const buddyBrief = (await f.brief(await keyOf(await f.machine.handBack(buddyOnly)))).json().markdown as string;
      expect(buddyBrief).toContain("- 第 2 版：伙伴改的，原因：伙伴改的");
      expect(buddyBrief).not.toContain(SENTENCE);
      const plain = await f.card("没改过", { doneDefinition: "新建 文件清单.md" });
      expect((await f.brief(await keyOf(await f.machine.handBack(plain)))).json().markdown).not.toContain("约定后来改过");
    } finally { await f.close(); }
  });
  it("17.2 第 29 条：拆卡那几块按序号插进项目对话——登记时记本人看到的最后一条（没带读对话最新的），派活单照登记的，开工时另记一个", async () => {
    // 这条测试先后登记两次，派活单照「最近一次登记」取序号（按登记时间）。夹具的时钟是定住的，两次登记时间一样时先后只能看随机的 id，
    // 所以这里让时钟每取一次往前走一秒，像真实情况那样分得出先后。
    let ticks = 0;
    const f = await localFixture({ monthlyNow: () => new Date(BOARD_NOW.getTime() + 1_000 * ticks++) });
    try {
      const project = (await f.call("POST", "/api/me/projects", { name: "天枢" })).json().projectId as string;
      const say = async (message: string) => expect((await f.call("POST", `/api/conversations/project:${project}/messages`, { message })).statusCode).toBe(200);
      const last = async () => ((await f.call("GET", `/api/conversations/project:${project}/messages`)).json().messages as { sequence: number }[]).at(-1)!.sequence;
      await say("先把首页拆一下");
      const seen = await last();
      expect(seen).toBeGreaterThan(1);
      // 没带：读项目对话现在最后一条。
      const registered = (await f.call("POST", `/api/me/projects/${project}/card-splits`, { words: "拆首页" })).json();
      expect(registered.afterSequence).toBe(seen);
      expect((await f.call("GET", "/api/me/card-splits")).json().requests[0].afterSequence).toBe(seen);
      // 网页认领了登记、规划员没开起来，登记回去（不带序号）：照登记的规则读对话现在最后一条。
      expect((await f.call("DELETE", `/api/me/card-splits/${registered.id}`)).statusCode).toBe(204);
      await say("顺便看看手机版");
      const given = await last();
      expect(given).toBeGreaterThan(seen);
      const back = (await f.call("POST", `/api/me/projects/${project}/card-splits`, { words: "拆首页" })).json();
      expect(back.afterSequence).toBe(given);
      // 再认领、开起来：派活单照登记记的，不是派活单报上来时对话的最后一条。
      expect((await f.call("DELETE", `/api/me/card-splits/${back.id}`)).statusCode).toBe(204);
      await say("拆的时候我先去开会");
      await f.sync({ kind: "plan", projectId: project }, [["card_plan", plan(1, [{ title: "画首页", criterionIndex: null }, { title: "接接口", criterionIndex: null }])]]);
      const seenPlan = given;
      const board = async () => (await f.call("GET", `/api/me/projects/${project}/board`)).json() as { drafts: { id: string }[];
        plan: { afterSequence: number | null; startedAfterSequence: number | null } };
      expect((await board()).plan).toMatchObject({ afterSequence: seenPlan, startedAfterSequence: null });
      // 开工：没带读对话最新的；第二次开工不改。
      await say("就按这个开始");
      const started = await last();
      const [first, second] = (await board()).drafts;
      expect((await f.call("POST", `/api/me/projects/${project}/card-drafts/accept`, { drafts: [{ id: first.id }] })).statusCode).toBe(200);
      expect((await board()).plan).toMatchObject({ afterSequence: seenPlan, startedAfterSequence: started });
      expect((await f.call("POST", `/api/me/projects/${project}/card-drafts/accept`, { drafts: [{ id: second.id }], afterSequence: 1 })).statusCode).toBe(200);
      expect((await board()).plan.startedAfterSequence).toBe(started);
      // 网页带了：用带的。没挂项目的 Task 没带时读不到，是 null。
      expect((await f.call("POST", "/api/plan-tasks/task-open/card-splits", { afterSequence: 3 })).json().afterSequence).toBe(3);
      await f.call("DELETE", `/api/me/card-splits/${(await f.call("GET", "/api/me/card-splits")).json().requests.find((item: { taskId: string | null }) => item.taskId).id}`);
      expect((await f.call("POST", "/api/plan-tasks/task-open/card-splits", {})).json().afterSequence).toBeNull();
    } finally { await f.close(); }
  });
  it("17.2 第 29 条：这台电脑连着本机时网页直接开规划员（不经过登记），派活单记云端建它那一下项目对话的最后一条；用过的登记不再算", async () => {
    const f = await localFixture();
    try {
      const project = (await f.call("POST", "/api/me/projects", { name: "天枢" })).json().projectId as string;
      const say = async (message: string) => expect((await f.call("POST", `/api/conversations/project:${project}/messages`, { message })).statusCode).toBe(200);
      const last = async () => ((await f.call("GET", `/api/conversations/project:${project}/messages`)).json().messages as { sequence: number }[]).at(-1)!.sequence;
      const planOf = async () => (await f.call("GET", `/api/me/projects/${project}/board`)).json().plan as { afterSequence: number | null };
      const report = (session?: string, revision = 1) => f.sync({ kind: "plan", projectId: project }, [["card_plan", plan(revision, [{ title: "画首页", criterionIndex: null }])]], session);
      // 从没登记过：建派活单那一下的最后一条。
      await say("拆一下首页");
      const direct = await last();
      const first = await report();
      expect((await planOf()).afterSequence).toBe(direct);
      // 同一个会话再出一次：不改。
      await say("第二件拆细一点");
      await report(first.session, 2);
      expect((await planOf()).afterSequence).toBe(direct);
      // 照登记开的一次用掉了那条登记；之后再直接开，不再拿那条登记的，用现在的最后一条。
      const registered = (await f.call("POST", `/api/me/projects/${project}/card-splits`, {})).json();
      expect((await f.call("DELETE", `/api/me/card-splits/${registered.id}`)).statusCode).toBe(204);
      await report();
      expect((await planOf()).afterSequence).toBe(registered.afterSequence);
      await say("再拆一遍");
      const again = await last();
      expect(again).toBeGreaterThan(registered.afterSequence);
      await report();
      expect((await planOf()).afterSequence).toBe(again);
    } finally { await f.close(); }
  });
  it("17.2 第 29 条：首页「等你」点「开始」（Task 的开工接口，不带序号）：startedAfterSequence 读这件 Task 挂的项目对话现在的最后一条", async () => {
    const f = await localFixture();
    try {
      const project = (await f.call("POST", "/api/me/projects", { name: "天枢" })).json().projectId as string;
      expect((await f.call("PUT", `/api/me/projects/${project}/goals/task-open`)).statusCode).toBe(200);
      const say = async (message: string) => expect((await f.call("POST", `/api/conversations/project:${project}/messages`, { message })).statusCode).toBe(200);
      const last = async () => ((await f.call("GET", `/api/conversations/project:${project}/messages`)).json().messages as { sequence: number }[]).at(-1)!.sequence;
      await say("拆一下对话质量");
      const split = await last();
      await f.sync({ kind: "plan", taskId: "task-open" }, [["card_plan", plan(1, [{ title: "跑题库" }])]]);
      const board = async () => (await f.call("GET", "/api/plan-tasks/task-open/cards")).json() as { drafts: { id: string }[];
        plan: { afterSequence: number | null; startedAfterSequence: number | null } };
      expect((await board()).plan).toMatchObject({ afterSequence: split, startedAfterSequence: null });
      await say("可以开始了");
      const started = await last();
      expect(started).toBeGreaterThan(split);
      const accepted = await f.call("POST", "/api/plan-tasks/task-open/card-drafts/accept", { drafts: (await board()).drafts.map(({ id }) => ({ id })), start: true });
      expect(accepted.statusCode).toBe(200);
      expect((await board()).plan).toMatchObject({ afterSequence: split, startedAfterSequence: started });
    } finally { await f.close(); }
  });
});
