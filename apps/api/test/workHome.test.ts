import { randomUUID } from "node:crypto";
import type { THomePlanTask } from "@warmap/contracts";
import { describe, expect, it } from "vitest";
import { TEST_CEO, TEST_MEMBER } from "./helpers.js";
import { BOARD_NOW, BOARD_TASKS, boardFixture, THIRD, type BoardFixture } from "./boardFixture.js";

/** 新首页（契约 workHome.ts）：左栏的树、等你、右栏的后台任务。本机那条路（云端拆卡、验收关着）。 */

const status = (state: string, title: string) => ["status", { status: state, title, agent: "claude-code", modelLabel: "订阅 · Sonnet" }] as [string, unknown];
/** 执行方在问本人（本机 idle 带 question）、在等批准（waiting_permission 带 permission）；不带提问的 idle 是一轮做完停下了（新首页 9.6）。 */
const QUESTION = { requestId: "q-1", questions: [{ question: "先做哪一页？", header: "顺序", options: [{ label: "登录页", description: "" }, { label: "首页", description: "" }],
  multiSelect: false }], askedAt: "2026-11-06T01:00:00.000Z" };
const PERMISSION = { requestId: "p-1", toolName: "Bash", title: "运行 pnpm test", outsidePaths: [] };
const asking = (title: string) => ["status", { status: "idle", title, agent: "claude-code", modelLabel: "订阅 · Sonnet", question: QUESTION }] as [string, unknown];
const approving = (title: string) => ["status", { status: "waiting_permission", title, agent: "claude-code", modelLabel: "订阅 · Sonnet", permission: PERMISSION }] as
  [string, unknown];
type Sub = { id: string; kind: string; title: string; state: string; waiting: string | null; queueReason: string | null; autoStart: boolean; sessionId: string | null;
  deviceId: string | null; role: { id: string } | null };
type Goal = { taskId: string; missionId: string; name: string; period: string; completedAt: string | null };
type Proj = { projectId: string; name: string; goals: Goal[]; subSessions: Sub[]; summary: Record<string, number>; planning: boolean;
  pipeline: { conversationId: string | null; scope: string }; items: { title: string }[] };
/** 上线迁移按 Mission 建的同名项目（fixture 本人这个月的 Mission 叫「内部版上线」）。 */
const projectOf = (body: { projects: Proj[] }, name = "内部版上线"): Proj => body.projects.find((project) => project.name === name)!;
/** 所有子会话：各项目里的和「其他」里的。 */
const allSubs = (body: { projects: Proj[]; other: { subSessions: Sub[] } }) => [...body.projects.flatMap((project) => project.subSessions), ...body.other.subSessions];

async function withRoleCards(f: BoardFixture, titles: string[]) {
  const dev = (await f.call("POST", "/api/me/roles", { name: "开发", family: "dev", kind: "worker" })).json();
  const ids: Record<string, string> = {};
  for (const title of titles) {
    ids[title] = await f.card(title);
    await f.call("PATCH", `/api/me/cards/${ids[title]}`, { version: 1, roleId: dev.id, executor: "claude_code" });
  }
  return { dev, ids };
}
const home = async (f: BoardFixture) => {
  const res = await f.call("GET", "/api/me/work-home");
  expect(res.statusCode).toBe(200);
  return res.json();
};
/** 卡在做、连续两次验收没过（受阻）：两次交回都验完、没过；第一次的改法送回了，第二次的还没（送回就是本人选了「再改一轮」，不再受阻）。 */
async function failedTwice(f: BoardFixture, cardId: string) {
  await f.t.sql("UPDATE tasks SET status='in_progress' WHERE id=$1", [cardId]);
  for (const attempt of [1, 2]) await f.t.sql(`INSERT INTO card_handbacks(id,task_id,owner_id,client_id,attempt,criteria,status,outcome,returned_at)
    VALUES($1,$2,$3,$4,$5,'["有方案文档","有评审结论"]'::jsonb,'done','fail',$6)`, [randomUUID(), cardId, TEST_MEMBER.personId, `k${attempt}-${randomUUID()}`, attempt,
    attempt === 1 ? BOARD_NOW : null]);
}

describe("新首页", { timeout: 30_000 }, () => {
  it("树：本人 Mission 下本人负责的 Task，下面是卡和专题，状态照本机报的和卡的标记对；不归树上 Task 的进「其他」；登记了开工的标出来；拆卡登记了算在拆", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const { dev, ids } = await withRoleCards(f, ["等开工", "自动开工", "等空位", "等前面的卡", "那台电脑关了", "等批准", "等回复", "跑着", "受阻", "没过", "已完成", "上月完成", "验收中"]);
      // 交给 Claude Code、没配岗位的也是子会话；本人自己做的不是。
      const noRole = await f.card("没配岗位");
      await f.call("PATCH", `/api/me/cards/${noRole}`, { version: 1, executor: "claude_code" });
      await f.card("人自己的活");
      const theirsTask = await f.card("挂在别人负责的 Task 上", { planTaskId: "task-theirs" });
      await f.call("PATCH", `/api/me/cards/${theirsTask}`, { version: 1, roleId: dev.id, executor: "claude_code" });
      const researcher = (await f.call("POST", "/api/me/roles", { presetKey: "researcher" })).json();
      const [onTask, loose] = [randomUUID(), randomUUID()];
      await f.t.sql(`INSERT INTO research_topics(id,owner_id,title,role_id,plan_task_id,mission_id) VALUES($1,$3,'竞品调研',$4,'task-open','mine'),($2,$3,'行业报告',NULL,NULL,NULL)`,
        [onTask, loose, TEST_MEMBER.personId, researcher.id]);
      await f.t.sql("INSERT INTO session_starts(id,owner_id,kind,card_id,plan_task_id,origin,requested_at) VALUES($1,$2,'card',$3,'task-open','web',$4)",
        [randomUUID(), TEST_MEMBER.personId, ids["自动开工"], BOARD_NOW]);

      // 还没有在线的电脑：登记了要开工的是等本机上线。
      let body = await home(f);
      const find = (b: typeof body, id: string): Sub => allSubs(b).find((sub: Sub) => sub.id === id)!;
      expect(find(body, ids["自动开工"])).toMatchObject({ state: "queued", queueReason: "device_offline", autoStart: true });
      expect(find(body, ids["等开工"])).toMatchObject({ state: "queued", queueReason: "not_dispatched", autoStart: false });

      const laptop = await f.local("我的电脑", { max: 2, running: 2, queued: 2 });
      const queuedSession = await laptop.send({ kind: "card", cardId: ids["等空位"] }, [status("queued", "等空位")]);
      await laptop.send({ kind: "card", cardId: ids["等前面的卡"] }, [["status", { status: "queued", title: "等前面的卡", agent: "claude-code", modelLabel: "订阅 · Sonnet",
        waitingFor: [ids["等空位"]] }]]);
      const approval = await laptop.send({ kind: "card", cardId: ids["等批准"] }, [status("waiting_permission", "等批准")]);
      await laptop.send({ kind: "card", cardId: ids["等回复"] }, [asking("等回复")]);
      await laptop.send({ kind: "card", cardId: ids["跑着"] }, [status("running", "跑着")]);
      await failedTwice(f, ids["受阻"]);
      await laptop.handBack(ids["没过"]);
      await f.t.sql("UPDATE card_handbacks SET status='done',outcome='fail' WHERE task_id=$1", [ids["没过"]]);
      await laptop.handBack(ids["验收中"]);
      await f.t.sql("UPDATE tasks SET status='done',acceptance=jsonb_build_object('at',$2::text) WHERE id=$1", [ids["已完成"], "2026-11-02T02:00:00.000Z"]);
      await f.t.sql("UPDATE tasks SET status='done',acceptance=jsonb_build_object('at',$2::text) WHERE id=$1", [ids["上月完成"], "2026-10-30T02:00:00.000Z"]);
      const desktop = await f.local("另一台");
      await desktop.send({ kind: "card", cardId: ids["那台电脑关了"] }, [status("running", "那台电脑关了")]);
      await f.t.sql("UPDATE local_devices SET last_sync_at=$2 WHERE id=$1", [desktop.device, new Date(BOARD_NOW.getTime() - 60 * 60_000)]);
      await laptop.send({ kind: "topic", topicId: loose }, [status("running", "行业报告")]);

      body = await home(f);
      expect(body.period).toBe("2026-11");
      // 本月：本人这个月的 Mission 下本人负责的 Task，挂在上线迁移按 Mission 建的同名项目上。
      const task = projectOf(body);
      expect(body.month.missions).toEqual([{ missionId: "mine", title: "内部版上线", period: "2026-11", tasks: [{ taskId: "task-open", name: "对话质量达标",
        completedAt: null, project: { projectId: task.projectId, name: "内部版上线" } }] }]);
      expect(body.projects.map((project: Proj) => project.name)).toEqual(["内部版上线"]);
      expect(task).toMatchObject({ goals: [{ taskId: "task-open", missionId: "mine", name: "对话质量达标", period: "2026-11", dueDate: "2026-11-30",
        criteriaTotal: 2, criteriaMet: 0, completedAt: null }], budget: null,
        pipeline: { conversationId: null, scope: `project:${task.projectId}` }, planning: false });
      // 截止取 Mission 的验收时间点（同「本月」）：今天（11/6）以后最近的那个；都过了取最后一个；没写取月底（上面那次）。
      const due = async () => projectOf(await home(f)).goals[0].dueDate;
      await f.t.sql(`UPDATE missions SET milestones='["11/28 复核","11/12 验收：题库打分"]' WHERE id='mine'`);
      expect(await due()).toBe("2026-11-12");
      await f.t.sql(`UPDATE missions SET milestones='["11/2 启动","11/5 中检"]' WHERE id='mine'`);
      expect(await due()).toBe("2026-11-05");
      await f.t.sql(`UPDATE missions SET milestones='[]' WHERE id='mine'`);
      const state = (id: string) => { const sub = find(body, id); return [sub.state, sub.waiting, sub.queueReason]; };
      expect(state(ids["等开工"])).toEqual(["queued", null, "not_dispatched"]);
      // 有在线的电脑了：登记了要开工的等网页认领（等开工），还标着 autoStart。
      expect(find(body, ids["自动开工"])).toMatchObject({ state: "queued", queueReason: "not_dispatched", autoStart: true });
      expect(find(body, ids["等空位"])).toMatchObject({ state: "queued", queueReason: "slot", sessionId: queuedSession, deviceId: laptop.device });
      expect(state(ids["等前面的卡"])).toEqual(["queued", null, "prior_cards"]);
      expect(state(ids["那台电脑关了"])).toEqual(["queued", null, "device_offline"]);
      expect(find(body, ids["等批准"])).toMatchObject({ state: "waiting", waiting: "approval", sessionId: approval, deviceId: laptop.device, role: { id: dev.id } });
      expect(state(ids["等回复"])).toEqual(["waiting", "question", null]);
      expect(state(ids["跑着"])).toEqual(["running", null, null]);
      expect(state(ids["受阻"])).toEqual(["waiting", "verdict", null]);
      expect(state(ids["没过"])).toEqual(["failed", null, null]);
      expect(state(ids["验收中"])).toEqual(["running", null, null]);
      expect(state(ids["已完成"])).toEqual(["done", null, null]);
      expect(find(body, noRole)).toMatchObject({ kind: "card", role: null, state: "queued" });
      expect(find(body, onTask)).toMatchObject({ kind: "topic", title: "竞品调研", state: "queued", queueReason: "not_dispatched", role: { id: researcher.id }, sessionId: null });
      // 格子里的先后：等你、没过、进行中、已排队、已完成。
      const order = ["waiting", "failed", "running", "queued", "done"];
      const states = task.subSessions.map((sub: Sub) => order.indexOf(sub.state));
      expect(states).toEqual([...states].sort((a: number, b: number) => a - b));
      // 子会话不看月份：上个月完成的也在 Task 下面。
      expect(task.subSessions.map((sub: Sub) => sub.id).sort()).toEqual([...Object.values(ids), noRole, onTask].sort());
      // 等你里归这件 Task 的：等批准、等回复、受阻。今天没有验收通过的。
      expect(task.summary).toEqual({ running: 2, waiting: 4, queued: 7, done: 2, doneToday: 0, needsYou: 3 });
      // 其他：挂在别人负责的 Task 上的卡、不挂 Task 的专题。本人自己做的不是子会话。
      expect(body.other.subSessions.map((sub: Sub) => [sub.title, sub.state]).sort()).toEqual([["挂在别人负责的 Task 上", "queued"], ["行业报告", "running"]]);

      // 拆卡登记了：挂着的这件 Task 在拆，项目算在规划。项目对话（没接 Chat 时是天枢自己 scope 为 project:<id> 的对话）。
      expect((await f.call("POST", "/api/plan-tasks/task-open/card-splits")).statusCode).toBe(201);
      const conversation = randomUUID();
      await f.t.sql("INSERT INTO conversations (id, owner_id, scope, pi_session_id) VALUES ($1, $2, $3, $4)",
        [conversation, TEST_MEMBER.personId, `project:${task.projectId}`, randomUUID()]);
      body = await home(f);
      expect(projectOf(body)).toMatchObject({ planning: true, pipeline: { conversationId: conversation, scope: `project:${task.projectId}` } });
    } finally { await f.close(); }
  });

  it("等你：子会话、规划员、验收员在等批准或回复，受阻的卡，会议要确认的，Mission Card 要本人确认的，岗位修改建议；卡住在跑的活的在前，再是有截止的，其余新的在前", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const { dev, ids } = await withRoleCards(f, ["等批准", "受阻", "在验的卡"]);
      const laptop = await f.local();
      const approval = await laptop.send({ kind: "card", cardId: ids["等批准"] }, [status("waiting_permission", "等批准")]);
      await failedTwice(f, ids["受阻"]);
      const planner = await laptop.send({ kind: "plan", taskId: "task-open" } as never, [asking("拆卡")]);
      await laptop.handBack(ids["在验的卡"]);
      const handbackKey = (await f.t.sql("SELECT client_id FROM card_handbacks WHERE task_id=$1", [ids["在验的卡"]]))[0].client_id as string;
      const verifier = await laptop.send({ kind: "verify", cardId: ids["在验的卡"], handbackKey } as never, [status("waiting_permission", "验收：在验的卡")]);
      const times: [string, string][] = [[approval, "2026-11-06T01:10:00Z"], [planner, "2026-11-06T01:20:00Z"], [verifier, "2026-11-06T01:30:00Z"]];
      for (const [run, at] of times) await f.t.sql("UPDATE local_runs SET updated_at=$2 WHERE id=$1", [run, at]);

      // 岗位修改建议（直接落库）。
      const proposal = randomUUID();
      await f.t.sql(`INSERT INTO role_proposals(id,role_id,owner_id,task_id,source_kind,source_id,base_version,field,proposed_text,why,status,created_at)
        VALUES($1,$2,$3,$4,'second_fail',$5,1,'practice_md','先跑题库再写','两次都没跑题库','open','2026-11-06T01:40:00Z')`,
      [proposal, dev.id, TEST_MEMBER.personId, ids["受阻"], randomUUID()]);
      // 会议：本人负责的行动项待确认。
      const meeting = randomUUID();
      await f.t.sql(`INSERT INTO meetings (id, version, title, status, scheduled_at, ends_at, ended_at, lead_dri_id, ceo_participant_id, participants, issue_ids, preflight, draft, origin_ref)
        VALUES ($1, 1, '周会', 'scheduled', '2026-11-05T01:00:00Z', '2026-11-05T02:00:00Z', '2026-11-05T02:00:00Z', $2, $3, '[]', '[]', '{}', '{}', '{}')`,
      [meeting, TEST_CEO.personId, TEST_CEO.personId]);
      await f.t.sql("INSERT INTO meeting_cards (meeting_id, draft_status, action_items) VALUES ($1, 'draft_ready', $2::jsonb)", [meeting, JSON.stringify([
        { id: "act-1", text: "补题库", ownerPersonId: TEST_MEMBER.personId, dueDate: null, review: { status: "pending" } },
        { id: "act-2", text: "约新人", ownerPersonId: TEST_MEMBER.personId, dueDate: null, review: { status: "pending" } }])]);
      // Mission Card：本月的轮次在本人确认阶段，本人那张还没确认。
      const [plan, round, mine] = [randomUUID(), randomUUID(), randomUUID()];
      await f.t.sql(`INSERT INTO monthly_plans (id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
        VALUES ($1,1,'2026-11','confirmed','公司目标','[{"battlefieldId":"growth","outcome":"本月目标"}]','[]','{"edits":[],"checkedItemIds":[],"feedback":[],"note":""}',
        '{"status":"ready","pendingSince":null,"runId":null,"previousRunIds":[],"error":null,"generatedAt":null}',$2)`, [plan, BOARD_NOW]);
      await f.t.sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,opened_at,closes_at,created_at,updated_at)
        VALUES ($1,1,'growth','2026-11',$2,'open','placeholder','{}','2026-11-01T02:00:00Z','2026-11-08T10:00:00Z',$3,$3)`, [round, plan, BOARD_NOW]);
      await f.t.sql(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,role_label,member_ids,created_at) VALUES ($1,$2,$3,1,'01-3 战役','[]'::jsonb,$4)`,
        [mine, round, TEST_MEMBER.personId, BOARD_NOW]);
      const battlefield = (await f.t.sql("SELECT name FROM battlefield_config WHERE id='growth'"))[0].name as string;

      const body = await home(f);
      const projectId = projectOf(body).projectId;
      const byId = new Map(body.waiting.map((item: { id: string }) => [item.id, item]));
      // 本机那几种（批准、回复）在那台电脑上就地答，带设备名；没截止、不是别人请你、不是月份。
      const local = { answer: "inline_local", deviceName: "我的电脑", letter: null, dueAt: null, person: null, month: null, question: null, permission: null };
      // 子会话的提问和批准由项目对话转达（14.3）：落在项目对话里那个框上（focus），来源只写项目名。
      expect(byId.get(`approval:card:${ids["等批准"]}`)).toEqual({ id: `approval:card:${ids["等批准"]}`, kind: "approval", title: "等你批准", source: "内部版上线",
        at: "2026-11-06T01:10:00.000Z", open: { kind: "project", id: projectId, focus: { sessionId: approval, requestId: null } }, taskId: "task-open", projectId,
        sessionId: approval, deviceId: laptop.device, ...local, letter: "A", summary: null });
      // 在问本人：标题是第一个问题的原话，带原样的提问（就地答）。规划员在它拆的 Task 挂的项目里。
      expect(byId.get(`question:plan:${planner}`)).toEqual({ id: `question:plan:${planner}`, kind: "question", title: "先做哪一页？", source: "内部版上线",
        at: "2026-11-06T01:20:00.000Z", open: { kind: "project", id: projectId, focus: { sessionId: planner, requestId: "q-1" } }, taskId: "task-open", projectId,
        sessionId: planner, deviceId: laptop.device, ...local, question: QUESTION, summary: "先做哪一页？" });
      expect(byId.get(`approval:verify:${verifier}`)).toMatchObject({ kind: "approval", source: "内部版上线", open: { kind: "project", id: projectId, focus: { sessionId: verifier } },
        taskId: "task-open", projectId, sessionId: verifier, answer: "inline_local" });
      expect(byId.get(`verdict:card:${ids["受阻"]}`)).toMatchObject({ kind: "verdict", title: "验收两次没过", open: { kind: "card", id: ids["受阻"] }, taskId: "task-open",
        projectId, answer: "open", deviceName: null, dueAt: null });
      // 不归项目的：会议、Mission Card 没有项目。项目的「N 件等你」：批准、回答、验收员、受阻，加按卡所在的 Task 归进来的岗位建议。
      expect(byId.get(`meeting:${meeting}`)).toMatchObject({ projectId: null });
      expect(byId.get(`role:${proposal}`)).toMatchObject({ projectId });
      expect(projectOf(body).summary.needsYou).toBe(5);
      // 岗位修改建议就地采纳或不要；别的点开去答。
      expect(byId.get(`role:${proposal}`)).toMatchObject({ kind: "role", title: "开发：建议改做法", source: "受阻", at: "2026-11-06T01:40:00.000Z",
        open: { kind: "role", id: proposal }, answer: "inline" });
      expect(byId.get(`meeting:${meeting}`)).toMatchObject({ kind: "meeting", title: "周会", source: "2 条待你确认", open: { kind: "meeting", id: meeting }, answer: "open",
        dueAt: null });
      // Mission Card 的截止是本人确认关闭的时间。
      expect(byId.get(`mission_card:${mine}`)).toMatchObject({ kind: "mission_card", title: "确认我的任务", source: `${battlefield} · 11 月 Mission Card`,
        open: { kind: "mission_card", id: mine }, answer: "open", dueAt: "2026-11-08T10:00:00.000Z" });
      // BOARD_NOW（11/06）在 10 月的复盘窗口里，但本人 10 月没有 Task，没什么要复盘的，不出「复盘 10 月」（monthReview.monthReviewWaiting）。
      expect(byId.has("month:review:2026-10")).toBe(false);
      expect(body.waiting).toHaveLength(7);
      // 先是卡住正在跑的活的（批准、回答，新的在前），再是有截止的（早的在前），其余新的在前，没有时间的排后面。
      expect(body.waiting.slice(0, 4).map((item: { id: string }) => item.id)).toEqual([`approval:verify:${verifier}`, `question:plan:${planner}`,
        `approval:card:${ids["等批准"]}`, `mission_card:${mine}`]);
      const ats = body.waiting.slice(4).map((item: { at: string | null }) => item.at);
      expect(ats.filter(Boolean)).toEqual([...ats.filter(Boolean)].sort().reverse());
      expect(ats.slice(ats.findIndex((at: string | null) => at === null)).every((at: string | null) => at === null)).toBe(true);
      // 同一件事每次的 id 一样。
      expect((await home(f)).waiting.map((item: { id: string }) => item.id)).toEqual(body.waiting.map((item: { id: string }) => item.id));

      // 拍板人那一侧：本人当战场 DRI 时，轮次的待办也进来。
      await f.t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_MEMBER.personId]);
      const todo = (await f.call("GET", "/api/me/mission-cards")).json().rounds[0].todo as string;
      expect(todo).toBeTruthy();
      expect((await home(f)).waiting.find((item: { id: string }) => item.id === `mission_round:${round}`))
        .toMatchObject({ kind: "mission_card", title: todo, open: { kind: "mission_card", id: round, round: true } });
    } finally { await f.close(); }
  });

  it("后台任务：规划员、验收员、子 agent 和后台命令，按 scope 过滤；只列还在跑的和今天结束的；别人的卡 404", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const { ids } = await withRoleCards(f, ["做方案", "交回了"]);
      const elsewhereCard = await f.card("别处的卡", { planTaskId: "task-theirs" });
      const topic = randomUUID();
      await f.t.sql("INSERT INTO research_topics(id,owner_id,title,plan_task_id,mission_id) VALUES($1,$2,'竞品调研','task-open','mine')", [topic, TEST_MEMBER.personId]);
      const laptop = await f.local();
      const planning = await laptop.send({ kind: "plan", taskId: "task-open" } as never, [status("running", "拆卡")]);
      const stoppedPlan = await laptop.send({ kind: "plan", taskId: "task-open" } as never, [status("exited", "拆卡")]);
      const yesterdayPlan = await laptop.send({ kind: "plan", taskId: "task-open" } as never, [status("exited", "拆卡")]);
      await f.t.sql("UPDATE local_runs SET ended_at='2026-11-05T02:00:00Z' WHERE id=$1", [yesterdayPlan]);
      await laptop.handBack(ids["交回了"]);
      const handbackKey = (await f.t.sql("SELECT client_id FROM card_handbacks WHERE task_id=$1", [ids["交回了"]]))[0].client_id as string;
      const judged = await laptop.send({ kind: "verify", cardId: ids["交回了"], handbackKey } as never, [status("exited", "验收：交回了")]);
      await f.t.sql("UPDATE card_handbacks SET verify_run_id=$1 WHERE task_id=$2", [judged, ids["交回了"]]);
      const cardRun = await laptop.send({ kind: "card", cardId: ids["做方案"] }, [status("running", "做方案")]);
      const topicRun = await laptop.send({ kind: "topic", topicId: topic }, [status("running", "竞品调研")]);
      const elsewhere = await laptop.send({ kind: "card", cardId: elsewhereCard }, [status("running", "别处的卡")]);
      const bg = (run: string, item: string, kind: string, title: string, state: string, started: string, finished: string | null, stoppable = true) =>
        f.t.sql(`INSERT INTO local_background_items(run_id,item_id,owner_id,kind,title,state,started_at,finished_at,stoppable,seq) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1)`,
          [run, item, TEST_MEMBER.personId, kind, title, state, started, finished, stoppable]);
      await bg(cardRun, "t1", "subagent", "查资料", "running", "2026-11-06T01:30:00Z", null);
      await bg(cardRun, "t2", "command", "跑测试", "done", "2026-11-06T01:10:00Z", "2026-11-06T01:20:00Z");
      await bg(cardRun, "t3", "command", "昨天的", "done", "2026-11-05T01:10:00Z", "2026-11-05T01:20:00Z");
      await bg(topicRun, "t4", "subagent", "搜竞品", "running", "2026-11-06T01:40:00Z", null, false);
      await bg(elsewhere, "t5", "command", "别处的命令", "running", "2026-11-06T01:50:00Z", null);

      const background = async (scope: string) => {
        const res = await f.call("GET", `/api/me/background?scope=${encodeURIComponent(scope)}`);
        expect(res.statusCode).toBe(200);
        return res.json();
      };
      const main = await background("main");
      const byId = new Map(main.items.map((item: { id: string }) => [item.id, item]));
      expect(byId.get(`plan:${planning}`)).toMatchObject({ kind: "plan", title: "拆卡：对话质量达标", state: "running", stoppable: true, sessionId: planning, itemId: null,
        deviceId: laptop.device, taskId: "task-open", cardId: null, topicId: null, finishedAt: null });
      expect(byId.get(`plan:${stoppedPlan}`)).toMatchObject({ state: "stopped", stoppable: false, finishedAt: expect.any(String) });
      expect(byId.get(`verify:${judged}`)).toMatchObject({ kind: "verify", title: "验收：交回了", state: "done", stoppable: false, cardId: ids["交回了"], taskId: "task-open" });
      expect(byId.get(`bg:${cardRun}:t1`)).toMatchObject({ kind: "subagent", title: "查资料", state: "running", stoppable: true, sessionId: cardRun, itemId: "t1",
        deviceId: laptop.device, taskId: "task-open", cardId: ids["做方案"], topicId: null });
      expect(byId.get(`bg:${cardRun}:t2`)).toMatchObject({ kind: "command", state: "done", stoppable: false, finishedAt: "2026-11-06T01:20:00.000Z" });
      expect(byId.get(`bg:${topicRun}:t4`)).toMatchObject({ stoppable: false, topicId: topic, taskId: "task-open" });
      // 昨天结束的不列。
      expect(byId.has(`plan:${yesterdayPlan}`)).toBe(false);
      expect(byId.has(`bg:${cardRun}:t3`)).toBe(false);
      // 进行中的按开始时间在前，然后是结束的（新的在前）。
      const open = main.items.filter((item: { state: string }) => item.state === "running" || item.state === "queued");
      expect(main.items.slice(0, open.length)).toEqual(open);
      expect(open.map((item: { startedAt: string }) => item.startedAt)).toEqual(open.map((item: { startedAt: string }) => item.startedAt).sort());
      const ended = main.items.slice(open.length).map((item: { finishedAt: string }) => item.finishedAt);
      expect(ended).toEqual([...ended].sort().reverse());
      expect(main.resources).toMatchObject({ devices: [{ id: laptop.device, online: true }] });

      const ids_ = async (scope: string) => (await background(scope)).items.map((item: { id: string }) => item.id).sort();
      expect(await ids_("task:task-open")).toEqual([`plan:${planning}`, `plan:${stoppedPlan}`, `verify:${judged}`, `bg:${cardRun}:t1`, `bg:${cardRun}:t2`, `bg:${topicRun}:t4`].sort());
      expect(await ids_(`card:${ids["做方案"]}`)).toEqual([`bg:${cardRun}:t1`, `bg:${cardRun}:t2`].sort());
      expect(await ids_(`card:${ids["交回了"]}`)).toEqual([`verify:${judged}`]);
      expect(await ids_(`topic:${topic}`)).toEqual([`bg:${topicRun}:t4`]);
      expect(main.items.map((item: { id: string }) => item.id)).toContain(`bg:${elsewhere}:t5`);
      // 项目：挂着的 Task 的规划员，加项目里的卡（含验收员）和专题会话里的；挂在别人负责的 Task 上的卡不在项目里。别人的、找不到的项目 404。
      const projectId = projectOf(await home(f)).projectId;
      expect(await ids_(`project:${projectId}`)).toEqual(await ids_("task:task-open"));
      expect((await f.call("GET", `/api/me/background?scope=project:${randomUUID()}`)).statusCode).toBe(404);

      // 别人的卡、找不到的专题 404；scope 写错 400。
      const third = await f.t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: f.t.publicOrigin }, payload: { loginId: THIRD.loginId, passcode: THIRD.passcode } });
      const thirdCookie = (third.headers["set-cookie"] as string).split(";")[0];
      const othersCard = await f.call("POST", "/api/me/tasks", { clientId: randomUUID(), title: "别人的卡", missionId: "other", planTaskId: "task-other",
        doneDefinition: "有方案" }, thirdCookie);
      expect(othersCard.statusCode).toBe(200);
      expect((await f.call("GET", `/api/me/background?scope=card:${othersCard.json().id}`)).statusCode).toBe(404);
      expect((await f.call("GET", `/api/me/background?scope=topic:${randomUUID()}`)).statusCode).toBe(404);
      // 字符和长度对、却不是 UUID 的也是找不到（不是 500）。
      expect((await f.call("GET", `/api/me/background?scope=card:${"-".repeat(36)}`)).statusCode).toBe(404);
      expect((await f.call("GET", "/api/me/background?scope=topic:0123456789abcdef0123456789abcdef----")).statusCode).toBe(404);
      expect((await f.call("GET", "/api/me/background?scope=everything")).statusCode).toBe(400);
    } finally { await f.close(); }
  });

  it("跨月：本月的 Task 都在（交付了打勾，交付后开了返工回到没完成）；之前月份动过、没了结、本人负责的挂在按它的 Mission 建的项目上；不在树上的 Task 下完成的子会话不进其他", async () => {
    const october: THomePlanTask[] = [
      { taskId: "oct-card", missionId: "oct", name: "上月挂着卡的", doneDefinition: null, criteria: [] },
      { taskId: "oct-talk", missionId: "oct", name: "上月聊过的", doneDefinition: null, criteria: [] },
      { taskId: "oct-idle", missionId: "oct", name: "上月没动过的", doneDefinition: null, criteria: [] },
      { taskId: "oct-delivered", missionId: "oct", name: "上月交付了的", doneDefinition: null, criteria: [] },
      { taskId: "oct-theirs", missionId: "oct", name: "上月别人负责的", doneDefinition: null, criteria: [], responsibleId: THIRD.personId },
    ];
    const f = await boardFixture({ planTasks: async (missions) => [...BOARD_TASKS, ...october].filter((task) => missions.some((mission) => mission.id === task.missionId)) },
      { boardCloudAgents: false });
    try {
      await f.t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,source_ref,source_document_id,source_revision,source_title)
        VALUES('oct',1,'oct','2026-10','十月的 Mission',$1,'method','["growth"]','目标','[]','fixture://b','fixture',1,'fixture')`, [TEST_MEMBER.personId]);
      const { ids } = await withRoleCards(f, ["上月的卡", "交付了·完成", "交付了·没完成", "别人负责的", "本月的卡"]);
      const moveTo = (title: string, taskId: string) => f.t.sql("UPDATE tasks SET mission_id='oct',plan_task_id=$2 WHERE id=$1", [ids[title], taskId]);
      await moveTo("上月的卡", "oct-card");
      await moveTo("交付了·完成", "oct-delivered");
      await moveTo("交付了·没完成", "oct-delivered");
      await moveTo("别人负责的", "oct-theirs");
      await f.t.sql("UPDATE tasks SET status='done',acceptance=jsonb_build_object('at','2026-10-29T02:00:00.000Z') WHERE id=$1", [ids["交付了·完成"]]);
      // 只开过 Task 管线（上线前的数据，没接 Chat 时是天枢自己的对话）：在本人最近几个月的 Mission 里找到；上线迁移时并进项目对话。
      const talk = randomUUID();
      await f.t.sql("INSERT INTO conversations (id, owner_id, scope, pi_session_id) VALUES ($1, $2, 'plan-task:oct-talk', $3)", [talk, TEST_MEMBER.personId, randomUUID()]);
      // 开管线时找过这件 Task（locatePlanTask），记下了它在哪个 Mission。
      await f.t.sql("INSERT INTO plan_task_missions(task_id,mission_id,seen_at) VALUES('oct-talk','oct',now())");
      const deliver = (taskId: string, missionId: string, at: string) => f.t.sql(`INSERT INTO deliverable_versions(id,task_id,mission_id,author_id,number,task_name,basis,criteria,delivered_at)
        VALUES($1,$2,$3,$4,1,'x','acceptance','[]',$5)`, [randomUUID(), taskId, missionId, TEST_MEMBER.personId, at]);
      await deliver("oct-delivered", "oct", "2026-10-30T00:00:00.000Z");
      await deliver("task-open", "mine", "2026-11-05T00:00:00.000Z");

      let body = await home(f);
      expect(body.period).toBe("2026-11");
      // 本月只列这个月的 Mission；上个月的只留动过、没了结、本人负责的，挂在按十月的 Mission 建的项目上。
      expect(body.month.missions.map((m: { missionId: string; tasks: { taskId: string }[] }) => [m.missionId, m.tasks.map((t) => t.taskId)])).toEqual([["mine", ["task-open"]]]);
      const october = projectOf(body, "十月的 Mission");
      expect(body.projects.map((project: Proj) => [project.name, project.goals.map((goal) => [goal.taskId, goal.period])]).sort())
        .toEqual([["十月的 Mission", [["oct-card", "2026-10"], ["oct-talk", "2026-10"]]], ["内部版上线", [["task-open", "2026-11"]]]].sort());
      // 本月交付了的照列、打勾。
      expect(projectOf(body).goals[0].completedAt).toBe("2026-11-05T00:00:00.000Z");
      expect(october).toMatchObject({ goals: [{ taskId: "oct-card", completedAt: null, dueDate: "2026-10-31" }, { taskId: "oct-talk", completedAt: null }],
        subSessions: [{ id: ids["上月的卡"], state: "queued" }] });
      // 上个月那件只开过的 Task 管线并进了项目对话；挂接时间是那个月的月初（项目对话里的分隔线落在它前面）。
      expect(await f.t.sql("SELECT scope FROM conversations WHERE id=$1", [talk])).toEqual([{ scope: `project:${october.projectId}` }]);
      expect(october.pipeline.conversationId).toBe(talk);
      expect((await f.t.sql("SELECT linked_at FROM project_goals WHERE task_id='oct-talk'"))[0].linked_at.toISOString()).toBe("2026-09-30T16:00:00.000Z");
      // 不在树上的 Task 下：没完成的进其他，完成的不列。
      expect(body.other.subSessions.map((sub: Sub) => sub.title).sort()).toEqual(["交付了·没完成", "别人负责的"].sort());
      // 「自动」发给谁：项目名和挂着的 Task 名都算；「上月」只有十月那个项目有。
      expect((await f.call("POST", "/api/me/route", { text: "上月聊过的那件怎么样了" })).json()).toEqual({ target: { projectId: october.projectId } });
      expect((await f.call("POST", "/api/me/route", { text: "内部版上线这边怎么样" })).json()).toEqual({ target: { projectId: projectOf(body).projectId } });
      expect((await f.call("POST", "/api/me/route", { text: "今天天气" })).json()).toEqual({ target: "main" });

      // 交付以后在这件 Task 下开了返工卡：回到没完成。
      await f.t.sql("UPDATE tasks SET rework_of_card_id=$2,created_at='2026-11-05T05:00:00Z' WHERE id=$1", [ids["本月的卡"], ids["上月的卡"]]);
      body = await home(f);
      expect(projectOf(body).goals[0].completedAt).toBeNull();
    } finally { await f.close(); }
  });

  it("合回：合进去了是完成，没能自动合回是等你合（等你里一条，在交回那台电脑上就地合），本机没报是完成；今天验收通过的数、等你的数；自己做的事项挂在 Task 下，待归位的在其他", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const { ids } = await withRoleCards(f, ["合进去了", "没合回", "没报合回", "昨天过的"]);
      const laptop = await f.local();
      const merges: Record<string, unknown> = {
        "合进去了": { merged: true, commit: "abc123", baseBranch: "main", reason: null, message: null, auto: true, at: "2026-11-06T01:40:00.000Z", seq: 3 },
        "没合回": { merged: false, commit: null, baseBranch: "main", reason: "dirty", message: "主文件夹有没提交的改动", auto: true, at: "2026-11-06T01:45:00.000Z", seq: 4 },
        "没报合回": null,
        "昨天过的": null,
      };
      const runs: Record<string, string> = {};
      for (const [title, merge] of Object.entries(merges)) {
        const handback = await laptop.handBack(ids[title]);
        await f.t.sql("UPDATE card_handbacks SET status='done',outcome='pass',merge=$2::jsonb WHERE id=$1", [handback, merge === null ? null : JSON.stringify(merge)]);
        runs[title] = (await f.t.sql("SELECT run_id::text FROM card_handbacks WHERE id=$1", [handback]))[0].run_id as string;
        await f.t.sql("UPDATE tasks SET status='done',acceptance=jsonb_build_object('at',$2::text) WHERE id=$1",
          [ids[title], title === "昨天过的" ? "2026-11-05T01:00:00.000Z" : "2026-11-06T01:30:00.000Z"]);
      }
      // 自己做的事项：没完成的、完成了的挂在 Task 下，退回的不列；待归位的（外部 Agent 建的、没挂 Mission）和本人自己建的独立事项在其他（新的在前），做完的独立事项不列。
      const own = await f.card("自己做的");
      const ownDone = await f.card("自己做完的");
      await f.t.sql("UPDATE tasks SET status='done' WHERE id=$1", [ownDone]);
      await f.t.sql("UPDATE tasks SET status='returned',return_reason='不做了' WHERE id=$1", [await f.card("退回的")]);
      const unplaced = await f.card("待归位的");
      await f.t.sql("UPDATE tasks SET mission_id=NULL,step_order=NULL,plan_task_id=NULL,created_by='agent' WHERE id=$1", [unplaced]);
      const [standalone, standaloneDone] = [await f.card("自己建的独立事项"), await f.card("做完的独立事项")];
      await f.t.sql("UPDATE tasks SET mission_id=NULL,step_order=NULL,plan_task_id=NULL,created_at=now()+interval '1 minute' WHERE id=ANY($1::uuid[])", [[standalone, standaloneDone]]);
      await f.t.sql("UPDATE tasks SET status='done' WHERE id=$1", [standaloneDone]);

      const body = await home(f);
      const task = projectOf(body);
      const sub = (title: string) => task.subSessions.find((item: Sub) => item.id === ids[title]);
      expect(sub("合进去了")).toMatchObject({ state: "done", waiting: null,
        merge: { state: "merged", commit: "abc123", baseBranch: "main", reason: null, message: null, at: "2026-11-06T01:40:00.000Z" } });
      expect(sub("没合回")).toMatchObject({ state: "waiting", waiting: "merge",
        merge: { state: "needs_merge", commit: null, baseBranch: "main", reason: "dirty", message: "主文件夹有没提交的改动", at: "2026-11-06T01:45:00.000Z" } });
      expect(sub("没报合回")).toMatchObject({ state: "done", waiting: null, merge: null });
      expect(body.waiting.find((item: { id: string }) => item.id === `merge:card:${ids["没合回"]}`)).toEqual({ id: `merge:card:${ids["没合回"]}`, kind: "merge",
        title: "没能自动合回", source: "没合回 · 对话质量达标", at: "2026-11-06T01:45:00.000Z", open: { kind: "card", id: ids["没合回"] }, taskId: "task-open",
        projectId: projectOf(body).projectId, sessionId: runs["没合回"], deviceId: laptop.device, deviceName: "我的电脑", letter: "B", dueAt: null, answer: "inline_local", person: null, month: null, question: null, permission: null });
      expect(body.waiting.filter((item: { kind: string }) => item.kind === "merge")).toHaveLength(1);
      // 今天验收通过的 3 件（等你合的也算验收过了），昨天的不算；等你里归这个项目的 1 条。
      expect(task.summary).toMatchObject({ done: 3, waiting: 1, doneToday: 3, needsYou: 1 });

      expect(task.items.map((item: { id: string; title: string; status: string; awaitingAcceptance: boolean }) => [item.id, item.title, item.status, item.awaitingAcceptance]))
        .toEqual([[own, "自己做的", "not_started", false], [ownDone, "自己做完的", "done", false]]);
      expect(body.other.items.map((item: { id: string; title: string }) => [item.id, item.title])).toEqual([[standalone, "自己建的独立事项"], [unplaced, "待归位的"]]);
    } finally { await f.close(); }
  });

  it("没能自动合回的卡不看月份、不看 Task 在不在树上：所挂 Task 了结了、不挂 Task 跨了月，照样等你合（进其他）；合进去了的照旧不列", async () => {
    const october: THomePlanTask[] = [{ taskId: "oct-delivered", missionId: "oct", name: "上月交付了的", doneDefinition: null, criteria: [] }];
    const f = await boardFixture({ planTasks: async (missions) => [...BOARD_TASKS, ...october].filter((task) => missions.some((mission) => mission.id === task.missionId)) },
      { boardCloudAgents: false });
    try {
      await f.t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,source_ref,source_document_id,source_revision,source_title)
        VALUES('oct',1,'oct','2026-10','十月的 Mission',$1,'method','["growth"]','目标','[]','fixture://b','fixture',1,'fixture')`, [TEST_MEMBER.personId]);
      const titles = ["了结的 Task·没合回", "了结的 Task·合回了", "不挂 Task·没合回", "不挂 Task·合回了"];
      const { ids } = await withRoleCards(f, titles);
      const laptop = await f.local();
      for (const title of titles) {
        const merged = title.endsWith("合回了");
        const handback = await laptop.handBack(ids[title]);
        await f.t.sql("UPDATE card_handbacks SET status='done',outcome='pass',merge=$2::jsonb WHERE id=$1", [handback, JSON.stringify({ merged,
          commit: merged ? "abc123" : null, baseBranch: "main", reason: merged ? null : "dirty", message: merged ? null : "主文件夹有没提交的改动", auto: true,
          at: "2026-10-31T15:05:00.000Z", seq: 1 })]);
        // 10/31 23:00（公司时区）验收通过：已经是上个月。
        await f.t.sql("UPDATE tasks SET status='done',acceptance=jsonb_build_object('at','2026-10-31T15:00:00.000Z') WHERE id=$1", [ids[title]]);
        if (title.startsWith("了结")) await f.t.sql("UPDATE tasks SET mission_id='oct',plan_task_id='oct-delivered' WHERE id=$1", [ids[title]]);
        else await f.t.sql("UPDATE tasks SET mission_id=NULL,step_order=NULL,plan_task_id=NULL WHERE id=$1", [ids[title]]);
      }
      // 上个月的 Task 交付了（了结），不在树上。
      await f.t.sql(`INSERT INTO deliverable_versions(id,task_id,mission_id,author_id,number,task_name,basis,criteria,delivered_at)
        VALUES($1,'oct-delivered','oct',$2,1,'x','acceptance','[]','2026-11-02T00:00:00.000Z')`, [randomUUID(), TEST_MEMBER.personId]);

      const body = await home(f);
      expect(body.projects.flatMap((project: Proj) => project.goals.map((goal) => goal.taskId))).toEqual(["task-open"]);
      expect(body.other.subSessions.map((sub: Sub) => [sub.title, sub.state, sub.waiting]).sort())
        .toEqual([["不挂 Task·没合回", "waiting", "merge"], ["了结的 Task·没合回", "waiting", "merge"]]);
      const merges = body.waiting.filter((item: { kind: string }) => item.kind === "merge");
      expect(merges.map((item: { id: string; taskId: string | null; deviceId: string }) => [item.id, item.taskId, item.deviceId]).sort())
        .toEqual([[`merge:card:${ids["不挂 Task·没合回"]}`, null, laptop.device], [`merge:card:${ids["了结的 Task·没合回"]}`, null, laptop.device]].sort());
    } finally { await f.close(); }
  });

  it("一轮做完停下（idle 不带提问）：卡和专题都是已停下（waiting / null），不进等你；真在问、在等批准才进，标题用原话，带提问、要批准的那一步", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const { ids } = await withRoleCards(f, ["做完一轮", "在问", "要批准"]);
      const laptop = await f.local();
      await laptop.send({ kind: "card", cardId: ids["做完一轮"] }, [status("running", "做完一轮"), status("idle", "做完一轮")]);
      const asked = await laptop.send({ kind: "card", cardId: ids["在问"] }, [asking("在问")]);
      await laptop.send({ kind: "card", cardId: ids["要批准"] }, [approving("要批准")]);
      const topic = randomUUID();
      await f.t.sql("INSERT INTO research_topics(id,owner_id,title,plan_task_id,mission_id) VALUES($1,$2,'做完一轮的专题','task-open','mine')", [topic, TEST_MEMBER.personId]);
      await laptop.send({ kind: "topic", topicId: topic }, [status("idle", "做完一轮的专题")]);
      // 答完了（本机报的下一条 idle 不带提问）：那一行收走。
      const body = await home(f);
      const sub = (id: string) => projectOf(body).subSessions.find((item: Sub) => item.id === id);
      for (const id of [ids["做完一轮"], topic]) expect(sub(id)).toMatchObject({ state: "waiting", waiting: null });
      expect(sub(ids["在问"])).toMatchObject({ state: "waiting", waiting: "question" });
      expect(sub(ids["要批准"])).toMatchObject({ state: "waiting", waiting: "approval" });
      expect(body.waiting.map((item: { kind: string; title: string; question: unknown; permission: unknown }) => [item.kind, item.title, item.question, item.permission]))
        .toEqual([["approval", "运行 pnpm test", null, PERMISSION], ["question", "先做哪一页？", QUESTION, null]]);
      expect(projectOf(body).summary).toMatchObject({ needsYou: 2 });
      // 卡的标记（看板、卡详情）也一样：做完一轮是已暂停，在问是等你回复。
      const cards = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json().cards as { id: string; card: { wait: string | null } }[];
      expect([ids["做完一轮"], ids["在问"]].map((id) => cards.find((item) => item.id === id)!.card.wait)).toEqual(["paused", "reply"]);
      // 答完：本机在同一个会话里报下一条不带提问的 idle，那一行收走。
      const answered = await f.t.app.inject({ method: "POST", url: "/api/local-runner/sync", headers: { authorization: `Bearer ${laptop.token}` }, payload: {
        deviceId: laptop.device, runnerVersion: "0.1.0", slots: { max: 3, running: 1, queued: 0 }, items: [{ key: `${laptop.device}:${asked}:2`, sessionId: asked,
          subject: { kind: "card", cardId: ids["在问"] }, occurredAt: "2026-11-06T01:05:00.000Z", type: "status", data: status("idle", "在问")[1] }] } });
      expect(answered.json().rejected).toEqual([]);
      expect((await home(f)).waiting.map((item: { kind: string }) => item.kind)).toEqual(["approval"]);
    } finally { await f.close(); }
  });

  it("执行异常退出一次、连续两次都是已暂停（不算在跑、不进等你）；只有连续两次验收没过是受阻、等你拿主意。专题停了、异常退出都是已暂停，没有完成", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const { ids } = await withRoleCards(f, ["退出一次", "退出两次", "两次没过", "两次没过·电脑关了"]);
      const laptop = await f.local();
      await laptop.send({ kind: "card", cardId: ids["退出一次"] }, [status("running", "退出一次"), status("failed", "退出一次")]);
      for (let i = 0; i < 2; i++) await laptop.send({ kind: "card", cardId: ids["退出两次"] }, [status("failed", "退出两次")]);
      await failedTwice(f, ids["两次没过"]);
      // 两次没过、会话还开着的那台电脑关了：照样等你拿主意（不用等电脑），不算等本机上线。
      const desktop = await f.local("另一台");
      await desktop.send({ kind: "card", cardId: ids["两次没过·电脑关了"] }, [status("idle", "两次没过·电脑关了")]);
      await failedTwice(f, ids["两次没过·电脑关了"]);
      await f.t.sql("UPDATE local_devices SET last_sync_at=$2 WHERE id=$1", [desktop.device, new Date(BOARD_NOW.getTime() - 60 * 60_000)]);
      const [stopped, crashed, offTree] = [randomUUID(), randomUUID(), randomUUID()];
      await f.t.sql(`INSERT INTO research_topics(id,owner_id,title,plan_task_id,mission_id) VALUES($1,$4,'停了的专题','task-open','mine'),($2,$4,'崩了的专题','task-open','mine'),
        ($3,$4,'挂在别人 Task 下停了的','task-theirs','mine')`, [stopped, crashed, offTree, TEST_MEMBER.personId]);
      await laptop.send({ kind: "topic", topicId: stopped }, [status("running", "停了的专题"), status("exited", "停了的专题")]);
      await laptop.send({ kind: "topic", topicId: crashed }, [status("failed", "崩了的专题")]);
      await laptop.send({ kind: "topic", topicId: offTree }, [status("exited", "挂在别人 Task 下停了的")]);

      const body = await home(f);
      const task = projectOf(body);
      const sub = (id: string) => task.subSessions.find((item: Sub) => item.id === id);
      for (const id of [ids["退出一次"], ids["退出两次"], stopped, crashed]) expect(sub(id)).toMatchObject({ state: "waiting", waiting: null, queueReason: null });
      for (const id of [ids["两次没过"], ids["两次没过·电脑关了"]]) expect(sub(id)).toMatchObject({ state: "waiting", waiting: "verdict", queueReason: null });
      expect(task.summary).toMatchObject({ running: 0, waiting: 6, done: 0, needsYou: 2 });
      expect(body.waiting.filter((item: { kind: string }) => item.kind === "verdict").map((item: { id: string; title: string }) => [item.id, item.title]).sort())
        .toEqual([[`verdict:card:${ids["两次没过"]}`, "验收两次没过"], [`verdict:card:${ids["两次没过·电脑关了"]}`, "验收两次没过"]].sort());
      expect(body.other.subSessions.map((item: Sub) => [item.title, item.state, item.waiting])).toEqual([["挂在别人 Task 下停了的", "waiting", null]]);
    } finally { await f.close(); }
  });

  it("autoStart：认领了 5 分钟以内的不算（已经有电脑接下了），认领超过 5 分钟没了结的又算", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const { ids } = await withRoleCards(f, ["刚认领", "认领过期", "没认领"]);
      const laptop = await f.local();
      const claimed = { "刚认领": new Date(BOARD_NOW.getTime() - 60_000), "认领过期": new Date(BOARD_NOW.getTime() - 6 * 60_000), "没认领": null };
      for (const [title, at] of Object.entries(claimed))
        await f.t.sql("INSERT INTO session_starts(id,owner_id,kind,card_id,plan_task_id,origin,requested_at,claimed_at,claimed_device) VALUES($1,$2,'card',$3,'task-open','web',$4,$5,$6)",
          [randomUUID(), TEST_MEMBER.personId, ids[title], BOARD_NOW, at, at ? laptop.device : null]);
      const subs = projectOf(await home(f)).subSessions as Sub[];
      expect(Object.fromEntries(Object.keys(claimed).map((title) => [title, subs.find((sub) => sub.id === ids[title])!.autoStart])))
        .toEqual({ "刚认领": false, "认领过期": true, "没认领": true });
    } finally { await f.close(); }
  });

  it("交完收工的规划员在后台任务里是完成、不算等你；停着等额度恢复的规划员和卡在排队（带恢复时间）；右栏只要资源块；伙伴读同一份首页", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false, internalChatToken: "chat-token" });
    try {
      const { ids } = await withRoleCards(f, ["等额度"]);
      const laptop = await f.local();
      const hold = { reason: "usage_limit", until: "2026-11-06T05:00:00.000Z" };
      const donePlan = await laptop.send({ kind: "plan", taskId: "task-open" } as never, [status("running", "拆卡"), status("done", "拆卡")]);
      const heldPlan = await laptop.send({ kind: "plan", taskId: "task-open" } as never, [["status", { status: "idle", title: "拆卡", agent: "claude-code",
        modelLabel: "订阅 · Sonnet", hold }]]);
      const heldCard = await laptop.send({ kind: "card", cardId: ids["等额度"] }, [["status", { status: "idle", title: "等额度", agent: "claude-code",
        modelLabel: "订阅 · Sonnet", hold }]]);

      const background = (await f.call("GET", "/api/me/background?scope=main")).json();
      const byId = new Map(background.items.map((item: { id: string }) => [item.id, item]));
      expect(byId.get(`plan:${donePlan}`)).toMatchObject({ state: "done", stoppable: false, finishedAt: expect.any(String), holdUntil: null });
      expect(byId.get(`plan:${heldPlan}`)).toMatchObject({ state: "queued", finishedAt: null, holdUntil: "2026-11-06T05:00:00.000Z" });

      const body = await home(f);
      expect(projectOf(body).subSessions.find((sub: Sub) => sub.id === ids["等额度"]))
        .toMatchObject({ state: "queued", waiting: null, queueReason: "quota", holdUntil: "2026-11-06T05:00:00.000Z", sessionId: heldCard });
      // 停着等额度的不算等你回复，交完收工的也不算。
      expect(body.waiting.filter((item: { sessionId: string | null }) => [donePlan, heldPlan, heldCard].includes(item.sessionId as string))).toEqual([]);

      const resources = await f.call("GET", "/api/me/background?scope=resources");
      expect(resources.statusCode).toBe(200);
      expect(resources.json()).toMatchObject({ items: [], resources: { devices: [{ id: laptop.device, online: true }] } });

      const internal = (headers: Record<string, string>) => f.t.app.inject({ method: "GET", url: "/internal/me/work-home", headers });
      expect((await internal({ authorization: "Bearer wrong", "x-owner-id": TEST_MEMBER.personId })).statusCode).toBe(401);
      expect((await internal({ authorization: "Bearer chat-token", "x-owner-id": "nobody" })).statusCode).toBe(404);
      const viaChat = await internal({ authorization: "Bearer chat-token", "x-owner-id": TEST_MEMBER.personId });
      expect(viaChat.statusCode).toBe(200);
      expect(viaChat.json()).toEqual(body);
    } finally { await f.close(); }
  });

  it("「自动」发给谁：按本人的项目分（项目名、挂着的 Task 名和标准）；CEO 视角 403，没登录 401", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      // 还没建过项目：都发给伙伴。第一次读首页时按 Mission 建了项目，Task 挂上去。
      expect((await f.call("POST", "/api/me/route", { text: "对话质量达标这件怎么样" })).json()).toEqual({ target: "main" });
      const projectId = projectOf(await home(f)).projectId;
      expect((await f.call("POST", "/api/me/route", { text: "对话质量达标这件怎么样" })).json()).toEqual({ target: { projectId } });
      expect((await f.call("POST", "/api/me/route", { text: "题库打分出来了吗" })).json()).toEqual({ target: { projectId } });
      // 归档了的项目不算。
      expect((await f.call("PATCH", `/api/me/projects/${projectId}`, { archived: true })).statusCode).toBe(200);
      expect((await f.call("POST", "/api/me/route", { text: "题库打分出来了吗" })).json()).toEqual({ target: "main" });
      // 别人负责的 Task 不算。
      expect((await f.call("POST", "/api/me/route", { text: "别人负责的那件" })).json()).toEqual({ target: "main" });
      expect((await f.call("POST", "/api/me/route", { text: "今天天气" })).json()).toEqual({ target: "main" });

      const ceo = await f.t.loginCookie();
      for (const [method, url, payload] of [["GET", "/api/me/work-home"], ["GET", "/api/me/background?scope=main"], ["POST", "/api/me/route", { text: "你好" }]] as const) {
        expect((await f.call(method, url, payload, ceo)).statusCode).toBe(403);
        expect((await f.t.app.inject({ method, url, headers: { origin: f.t.publicOrigin }, ...(payload ? { payload } : {}) })).statusCode).toBe(401);
      }
    } finally { await f.close(); }
  });
});
