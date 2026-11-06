import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TEST_CEO, TEST_MEMBER } from "./helpers.js";
import { BOARD_NOW, boardFixture, THIRD, type BoardFixture } from "./boardFixture.js";

/** 新首页（契约 workHome.ts）：左栏的树、等你、右栏的后台任务。本机那条路（云端拆卡、验收关着）。 */

const status = (state: string, title: string) => ["status", { status: state, title, agent: "claude-code", modelLabel: "订阅 · Sonnet" }] as [string, unknown];
type Sub = { id: string; kind: string; title: string; state: string; waiting: string | null; queueReason: string | null; autoStart: boolean; sessionId: string | null;
  deviceId: string | null; role: { id: string } | null };

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
      const find = (b: typeof body, id: string): Sub => [...b.missions.flatMap((m: { tasks: { subSessions: Sub[] }[] }) => m.tasks.flatMap((t) => t.subSessions)),
        ...b.other.subSessions].find((sub: Sub) => sub.id === id);
      expect(find(body, ids["自动开工"])).toMatchObject({ state: "queued", queueReason: "device_offline", autoStart: true });
      expect(find(body, ids["等开工"])).toMatchObject({ state: "queued", queueReason: "not_dispatched", autoStart: false });

      const laptop = await f.local("我的电脑", { max: 2, running: 2, queued: 2 });
      const queuedSession = await laptop.send({ kind: "card", cardId: ids["等空位"] }, [status("queued", "等空位")]);
      await laptop.send({ kind: "card", cardId: ids["等前面的卡"] }, [["status", { status: "queued", title: "等前面的卡", agent: "claude-code", modelLabel: "订阅 · Sonnet",
        waitingFor: [ids["等空位"]] }]]);
      const approval = await laptop.send({ kind: "card", cardId: ids["等批准"] }, [status("waiting_permission", "等批准")]);
      await laptop.send({ kind: "card", cardId: ids["等回复"] }, [status("idle", "等回复")]);
      await laptop.send({ kind: "card", cardId: ids["跑着"] }, [status("running", "跑着")]);
      for (let i = 0; i < 2; i++) await laptop.send({ kind: "card", cardId: ids["受阻"] }, [status("failed", "受阻")]);
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
      expect(body.missions.map((m: { missionId: string; title: string; tasks: { taskId: string }[] }) => [m.missionId, m.title, m.tasks.map((t) => t.taskId)]))
        .toEqual([["mine", "内部版上线", ["task-open"]]]);
      const task = body.missions[0].tasks[0];
      expect(task).toMatchObject({ taskId: "task-open", missionId: "mine", name: "对话质量达标", subtitle: "对话质量过 75 分",
        pipeline: { conversationId: null, scope: "plan-task:task-open" }, planning: false });
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
      expect(task.subSessions.map((sub: Sub) => sub.id).sort()).toEqual([...Object.entries(ids).filter(([title]) => title !== "上月完成").map(([, id]) => id), noRole, onTask].sort());
      expect(task.summary).toEqual({ running: 2, waiting: 4, queued: 7, done: 1 });
      // 其他：挂在别人负责的 Task 上的卡、不挂 Task 的专题。上个月完成的、本人自己做的不列。
      expect(body.other.subSessions.map((sub: Sub) => [sub.title, sub.state]).sort()).toEqual([["挂在别人负责的 Task 上", "queued"], ["行业报告", "running"]]);

      // 拆卡登记了：这件 Task 在拆。Task 管线的对话（没接 Chat 时是天枢自己 scope 为 plan-task:<id> 的对话）。
      expect((await f.call("POST", "/api/plan-tasks/task-open/card-splits")).statusCode).toBe(201);
      const conversation = randomUUID();
      await f.t.sql("INSERT INTO conversations (id, owner_id, scope, pi_session_id) VALUES ($1, $2, 'plan-task:task-open', $3)", [conversation, TEST_MEMBER.personId, randomUUID()]);
      body = await home(f);
      expect(body.missions[0].tasks[0]).toMatchObject({ planning: true, pipeline: { conversationId: conversation, scope: "plan-task:task-open" } });
    } finally { await f.close(); }
  });

  it("等你：子会话、规划员、验收员在等批准或回复，受阻的卡，会议要确认的，Mission Card 要本人确认的，岗位修改建议；新的在前", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const { dev, ids } = await withRoleCards(f, ["等批准", "受阻", "在验的卡"]);
      const laptop = await f.local();
      const approval = await laptop.send({ kind: "card", cardId: ids["等批准"] }, [status("waiting_permission", "等批准")]);
      for (let i = 0; i < 2; i++) await laptop.send({ kind: "card", cardId: ids["受阻"] }, [status("failed", "受阻")]);
      const planner = await laptop.send({ kind: "plan", taskId: "task-open" } as never, [status("idle", "拆卡")]);
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
      await f.t.sql(`INSERT INTO mission_rounds (id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,opened_at,created_at,updated_at)
        VALUES ($1,1,'growth','2026-11',$2,'open','placeholder','{}','2026-11-01T02:00:00Z',$3,$3)`, [round, plan, BOARD_NOW]);
      await f.t.sql(`INSERT INTO personal_mission_cards (id,round_id,owner_id,sort_order,role_label,member_ids,created_at) VALUES ($1,$2,$3,1,'01-3 战役','[]'::jsonb,$4)`,
        [mine, round, TEST_MEMBER.personId, BOARD_NOW]);
      const battlefield = (await f.t.sql("SELECT name FROM battlefield_config WHERE id='growth'"))[0].name as string;

      const body = await home(f);
      const byId = new Map(body.waiting.map((item: { id: string }) => [item.id, item]));
      expect(byId.get(`approval:card:${ids["等批准"]}`)).toEqual({ id: `approval:card:${ids["等批准"]}`, kind: "approval", title: "等你批准", source: "等批准 · 对话质量达标",
        at: "2026-11-06T01:10:00.000Z", open: { kind: "card", id: ids["等批准"] }, taskId: "task-open", sessionId: approval, deviceId: laptop.device });
      expect(byId.get(`question:plan:${planner}`)).toEqual({ id: `question:plan:${planner}`, kind: "question", title: "等你回复", source: "拆卡 · 对话质量达标",
        at: "2026-11-06T01:20:00.000Z", open: { kind: "task", id: "task-open" }, taskId: "task-open", sessionId: planner, deviceId: laptop.device });
      expect(byId.get(`approval:verify:${verifier}`)).toMatchObject({ kind: "approval", source: "验收 · 在验的卡", open: { kind: "card", id: ids["在验的卡"] },
        taskId: "task-open", sessionId: verifier });
      expect(byId.get(`verdict:card:${ids["受阻"]}`)).toMatchObject({ kind: "verdict", title: "验收两次没过", open: { kind: "card", id: ids["受阻"] }, taskId: "task-open" });
      expect(byId.get(`role:${proposal}`)).toMatchObject({ kind: "role", title: "开发：建议改做法", source: "受阻", at: "2026-11-06T01:40:00.000Z",
        open: { kind: "role", id: proposal } });
      expect(byId.get(`meeting:${meeting}`)).toMatchObject({ kind: "meeting", title: "周会", source: "2 条待你确认", open: { kind: "meeting", id: meeting } });
      expect(byId.get(`mission_card:${mine}`)).toMatchObject({ kind: "mission_card", title: "确认我的任务", source: `${battlefield} · 11 月 Mission Card`,
        open: { kind: "mission_card", id: mine } });
      expect(body.waiting).toHaveLength(7);
      // 新的在前，没有时间的排后面。
      const ats = body.waiting.map((item: { at: string | null }) => item.at);
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

      // 别人的卡、找不到的专题 404；scope 写错 400。
      const third = await f.t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: f.t.publicOrigin }, payload: { loginId: THIRD.loginId, passcode: THIRD.passcode } });
      const thirdCookie = (third.headers["set-cookie"] as string).split(";")[0];
      const othersCard = await f.call("POST", "/api/me/tasks", { clientId: randomUUID(), title: "别人的卡", missionId: "other", planTaskId: "task-other",
        doneDefinition: "有方案" }, thirdCookie);
      expect(othersCard.statusCode).toBe(200);
      expect((await f.call("GET", `/api/me/background?scope=card:${othersCard.json().id}`)).statusCode).toBe(404);
      expect((await f.call("GET", `/api/me/background?scope=topic:${randomUUID()}`)).statusCode).toBe(404);
      expect((await f.call("GET", "/api/me/background?scope=everything")).statusCode).toBe(400);
    } finally { await f.close(); }
  });

  it("「自动」发给谁：按本人负责的 Task 分；CEO 视角 403，没登录 401", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      expect((await f.call("POST", "/api/me/route", { text: "对话质量达标这件怎么样" })).json()).toEqual({ target: { taskId: "task-open" } });
      expect((await f.call("POST", "/api/me/route", { text: "题库打分出来了吗" })).json()).toEqual({ target: { taskId: "task-open" } });
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
