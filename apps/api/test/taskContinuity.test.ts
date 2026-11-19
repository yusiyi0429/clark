import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { THomePlanTask } from "@warmap/contracts";
import type { PlanTaskSource } from "../src/planTasks.js";
import { settlementsOf } from "../src/taskContinuity.js";
import { BOARD_NOW, BOARD_TASKS, boardFixture, THIRD, type BoardFixture } from "./boardFixture.js";
import { TEST_MEMBER } from "./helpers.js";

/**
 * 跨月延续与月份（设计《新首页》第 10 节）：Task 按 id 找不按月份找、延续、到此为止、月份页（复盘在 monthReview.test.ts）。
 * 本人在 11 月有 Mission「mine」（本体对象 w-mine），12 月有「mine-dec」（w-dec），下面两件 12 月的 Task。
 */
const MEMBER = TEST_MEMBER.personId;
const DEC_NOW = new Date("2026-12-03T02:00:00.000Z");
const NEXT: THomePlanTask = { taskId: "task-next", missionId: "mine-dec", name: "12 月接着做", doneDefinition: null, criteria: ["有新人上手录屏", "有复盘"] };
const NEXT2: THomePlanTask = { taskId: "task-next2", missionId: "mine-dec", name: "12 月另一件", doneDefinition: null, criteria: ["有方案"] };
const ALL = [...BOARD_TASKS, NEXT, NEXT2];
const OBJECT_OF: Record<string, string> = { mine: "w-mine", other: "w-other", "mine-dec": "w-dec" };

/** 只会按 Mission 列 Task 的假来源（没有按 id 读）。 */
const listOnly = async (missions: { id: string }[]) => ALL.filter((task) => missions.some((mission) => mission.id === task.missionId));
/** 本体来源的样子：按 Mission 列，也能按 id 读一件（父引用是它所在 Mission 的本体对象）。 */
const withById: PlanTaskSource = Object.assign((missions: { id: string }[]) => listOnly(missions), {
  byId: async (taskId: string) => {
    const found = ALL.find((task) => task.taskId === taskId);
    if (!found) return null;
    const { missionId, ...task } = found;
    return { parents: [OBJECT_OF[missionId]], task };
  },
});

async function fixture(options: { now?: Date; planTasks?: PlanTaskSource } = {}) {
  const f = await boardFixture({ monthlyNow: () => options.now ?? BOARD_NOW, planTasks: options.planTasks ?? withById }, { boardCloudAgents: false });
  const fromWorld = (id: string) => f.t.sql(`UPDATE missions SET world_object_id=$2,world_scope_id='scope-x',world_domain_id='d-1',world_status='进行中',world_read_at=now()
    WHERE id=$1`, [id, OBJECT_OF[id]]);
  await f.t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,source_ref,source_document_id,source_revision,source_title)
    VALUES('mine-dec',1,'mine-dec','2026-12','12 月的 Mission',$1,'method','["growth"]','目标','[]','fixture://b','fixture',1,'fixture')`, [MEMBER]);
  for (const id of ["mine", "other", "mine-dec"]) await fromWorld(id);
  const login = await f.t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: f.t.publicOrigin }, payload: { loginId: THIRD.loginId, passcode: THIRD.passcode } });
  const third = (login.headers["set-cookie"] as string).split(";")[0];
  return { ...f, third, q: f.t.pool.query.bind(f.t.pool) };
}

describe("跨月延续与月份", () => {
  let f: Awaited<ReturnType<typeof fixture>> | BoardFixture | undefined;
  afterEach(async () => { await f?.close(); f = undefined; });

  it("Task 按 id 找：换到 12 月后 11 月的 Task 照样能打开约定、挂到项目上开项目对话；别人照样打不开；只按 Mission 列的来源找不到", async () => {
    const g = f = await fixture({ now: DEC_NOW });
    const agreement = await g.call("GET", "/api/plan-tasks/task-open/agreement");
    expect([agreement.statusCode, agreement.json().missionId]).toEqual([200, "mine"]);
    const project = await g.call("POST", "/api/me/projects", { name: "对话质量", taskId: "task-open" });
    expect(project.statusCode).toBe(201);
    expect((await g.call("POST", `/api/me/projects/${project.json().projectId}/pipeline`)).statusCode).toBe(201);
    // 找到时记下 Task 在哪个 Mission（看得见的 Mission 用）。
    expect(await g.t.sql("SELECT task_id,mission_id FROM plan_task_missions ORDER BY task_id")).toEqual([{ task_id: "task-open", mission_id: "mine" }]);
    // 别人（不是负责人、Mission 负责人、战场负责人、CEO、认可人）打不开；本人打不开别人 Mission 下的。
    expect((await g.call("GET", "/api/plan-tasks/task-open/agreement", undefined, g.third)).statusCode).toBe(404);
    expect((await g.call("GET", "/api/plan-tasks/task-other/agreement")).statusCode).toBe(404);
    expect((await g.call("GET", "/api/plan-tasks/task-other/agreement", undefined, g.third)).statusCode).toBe(200);
    await g.close();

    // 没有按 id 读（换月以前的找法）：11 月的 Task 404。
    const h = f = await fixture({ now: DEC_NOW, planTasks: listOnly });
    expect((await h.call("GET", "/api/plan-tasks/task-open/agreement")).statusCode).toBe(404);
  }, 120_000);

  it("延续：没做完的卡、专题、待交付、拆卡登记、规划员和派活单挂到新 Task，新 Task 挂到旧 Task 的项目（项目对话接着用），约定复制成草稿；做完的卡和交付版本留下；可以重复调", async () => {
    const g = f = await fixture();
    const machine = await g.local();
    let seq = 0;
    const planSync = async (session: string, revision: number, titles: string[]) => (await g.t.app.inject({ method: "POST", url: "/api/local-runner/sync",
      headers: { authorization: `Bearer ${machine.token}` }, payload: { deviceId: machine.device, runnerVersion: "0.1.0", slots: { max: 3, running: 1, queued: 0 },
        items: [{ key: `${machine.device}:${session}:${++seq}`, sessionId: session, subject: { kind: "plan", taskId: "task-open" },
          occurredAt: new Date(Date.UTC(2026, 10, 6, 4, 0, seq)).toISOString(), type: "card_plan",
          data: { revision, summary: "先录屏", steps: [{ title: "录屏", detail: null }], risks: ["约不到人"], modelLabel: "claude", roleId: null, roleVersion: null,
            cards: titles.map((title) => ({ title, brief: "照做", doneDefinition: "有结果", criterionIndex: 2, role: null, modelTier: "normal", why: null })) } }] } })).json();

    // 11 月 task-open 上的东西。
    const done = await g.card("做完的卡");
    const onRecording = await g.card("录屏那张");
    const onScoring = await g.card("打分那张");
    await g.t.sql("UPDATE tasks SET status='done' WHERE id=$1", [done]);
    await g.t.sql("UPDATE tasks SET executor='claude_code',criterion_index=2,criterion_text='有新人上手录屏' WHERE id=$1", [onRecording]);
    await g.t.sql("UPDATE tasks SET executor='claude_code',criterion_index=1,criterion_text='有题库打分结果' WHERE id=$1", [onScoring]);
    const topic = randomUUID(), topicVersion = randomUUID();
    await g.t.sql("INSERT INTO research_topics(id,owner_id,title,plan_task_id,mission_id) VALUES($1,$2,'对手怎么做','task-open','mine')", [topic, MEMBER]);
    await g.t.sql("INSERT INTO topic_versions(id,topic_id,number,kind,label,body,client_id) VALUES($1,$2,1,'draft','初稿','正文','c-1')", [topicVersion, topic]);
    await g.t.sql("INSERT INTO deliverable_pending_items(id,plan_task_id,topic_version_id,added_by) VALUES($1,'task-open',$2,$3)", [randomUUID(), topicVersion, MEMBER]);
    await g.t.sql(`INSERT INTO card_split_requests(id,owner_id,plan_task_id,mission_id,task_name,origin,created_at) VALUES($1,$2,'task-open','mine','对话质量达标','web',now())`,
      [randomUUID(), MEMBER]);
    const planner = randomUUID();
    expect((await planSync(planner, 1, ["约一位新人"])).rejected).toEqual([]);
    await g.t.sql(`INSERT INTO deliverable_versions(id,task_id,mission_id,author_id,number,task_name,basis) VALUES($1,'task-open','mine',$2,1,'对话质量达标','acceptance')`,
      [randomUUID(), MEMBER]);
    expect((await g.call("PUT", "/api/plan-tasks/task-open/agreement", { criteria: [{ index: 2, proof: "录屏链接", acceptorId: null }], exclusions: ["不含线上"] })).statusCode)
      .toBe(200);
    const project = (await g.call("POST", "/api/me/projects", { name: "对话质量", taskId: "task-open" })).json().projectId as string;
    const pipeline = (await g.call("POST", `/api/me/projects/${project}/pipeline`)).json().conversationId as string;
    expect((await g.call("POST", "/api/me/tasks/task-open/stop", { note: "先停一下" })).statusCode).toBe(200);

    const continued = await g.call("POST", "/api/me/tasks/task-open/continuation", { toTaskId: "task-next" });
    expect(continued.statusCode).toBe(200);
    expect(continued.json()).toMatchObject({ taskId: "task-open",
      settlement: { kind: "continued", by: MEMBER, to: { taskId: "task-next", name: "12 月接着做", missionId: "mine-dec", period: "2026-12" } },
      moved: { cards: 2, topics: 1, pending: 1, splits: 1, planners: 1, drafts: 1, pipeline: true, agreement: true } });

    // 卡：没做完的挂过去，对的那条按原文在新 Task 里重新找序号（录屏是新 Task 第 1 条，打分在新 Task 里没有，算「其他」）；做完的留下。
    expect(await g.t.sql("SELECT id::text,plan_task_id,mission_id,criterion_index,criterion_text FROM tasks WHERE id=ANY($1::uuid[]) ORDER BY title",
      [[done, onRecording, onScoring]])).toEqual(expect.arrayContaining([
      { id: done, plan_task_id: "task-open", mission_id: "mine", criterion_index: null, criterion_text: null },
      { id: onRecording, plan_task_id: "task-next", mission_id: "mine-dec", criterion_index: 1, criterion_text: "有新人上手录屏" },
      { id: onScoring, plan_task_id: "task-next", mission_id: "mine-dec", criterion_index: null, criterion_text: null },
    ]));
    expect(await g.t.sql("SELECT plan_task_id,mission_id FROM research_topics")).toEqual([{ plan_task_id: "task-next", mission_id: "mine-dec" }]);
    expect(await g.t.sql("SELECT plan_task_id FROM deliverable_pending_items")).toEqual([{ plan_task_id: "task-next" }]);
    expect(await g.t.sql("SELECT plan_task_id,mission_id,task_name FROM card_split_requests")).toEqual([{ plan_task_id: "task-next", mission_id: "mine-dec", task_name: "12 月接着做" }]);
    expect(await g.t.sql("SELECT plan_task_id FROM local_runs WHERE kind='plan'")).toEqual([{ plan_task_id: "task-next" }]);
    expect(await g.t.sql("SELECT plan_task_id FROM card_drafts WHERE status='open'")).toEqual([{ plan_task_id: "task-next" }]);
    expect(await g.t.sql("SELECT plan_task_id,mission_id FROM card_plans")).toEqual([{ plan_task_id: "task-next", mission_id: "mine-dec" }]);
    expect(await g.t.sql("SELECT task_id FROM deliverable_versions")).toEqual([{ task_id: "task-open" }]);
    // 新 Task 挂到旧 Task 的项目上，旧 Task 照样挂着（那是 11 月的目标）。
    expect(await g.t.sql("SELECT task_id,project_id::text,period FROM project_goals ORDER BY task_id")).toEqual([
      { task_id: "task-next", project_id: project, period: "2026-12" }, { task_id: "task-open", project_id: project, period: "2026-11" }]);
    expect(await g.t.sql("SELECT * FROM task_stops")).toEqual([]);
    // 项目对话还是原来那段，没有另开。
    const reopened = await g.call("POST", `/api/me/projects/${project}/pipeline`);
    expect([reopened.statusCode, reopened.json().conversationId]).toEqual([200, pipeline]);

    // 约定：复制成新 Task 的草稿，按原文对回新标准；本人存一次就成了正式的。
    const draft = (await g.call("GET", "/api/plan-tasks/task-next/agreement")).json();
    expect(draft).toMatchObject({ source: "tianshu", draftFrom: "task-open", exclusions: ["不含线上"], criteria: [{ index: 1, text: "有新人上手录屏", proof: "录屏链接" },
      { index: 2, text: "有复盘", proof: null }] });
    expect((await g.call("GET", "/api/plan-tasks/task-open/agreement")).json().draftFrom).toBeNull();

    // 规划员还按旧 Task 报下一版派活单：接到新 Task 上。
    expect((await planSync(planner, 2, ["约两位新人", "整理录屏"])).rejected).toEqual([]);
    expect(await g.t.sql("SELECT plan_task_id,title FROM card_drafts WHERE status='open' ORDER BY position")).toEqual([
      { plan_task_id: "task-next", title: "约两位新人" }, { plan_task_id: "task-next", title: "整理录屏" }]);

    // 再调一次什么都不挪；接着做成别的 Task 409；接的那件已经延续出去 409；已经延续出去的不能再定到此为止。
    expect((await g.call("POST", "/api/me/tasks/task-open/continuation", { toTaskId: "task-next" })).json().moved)
      .toEqual({ cards: 0, topics: 0, pending: 0, splits: 0, planners: 0, drafts: 0, pipeline: false, agreement: false });
    const other = await g.call("POST", "/api/me/tasks/task-open/continuation", { toTaskId: "task-next2" });
    expect([other.statusCode, other.json().code]).toEqual([409, "ALREADY_CONTINUED"]);
    const back = await g.call("POST", "/api/me/tasks/task-next2/continuation", { toTaskId: "task-open" });
    expect([back.statusCode, back.json().code]).toEqual([409, "TARGET_CONTINUED"]);
    const stop = await g.call("POST", "/api/me/tasks/task-open/stop", {});
    expect([stop.statusCode, stop.json().code]).toEqual([409, "TASK_CONTINUED"]);

    await g.call("PUT", "/api/plan-tasks/task-next/agreement", { criteria: [{ index: 1, proof: "录屏链接", acceptorId: null }], exclusions: [] });
    expect((await g.call("GET", "/api/plan-tasks/task-next/agreement")).json().draftFrom).toBeNull();
  }, 120_000);

  it("只有负责人能延续、到此为止、撤销；延续到的也要是本人负责的", async () => {
    const g = f = await fixture();
    // task-theirs 本人是 Mission 负责人、能看，负责人是别人：403；别人的 Mission 下的：404。
    expect((await g.call("POST", "/api/me/tasks/task-theirs/continuation", { toTaskId: "task-next" })).statusCode).toBe(403);
    expect((await g.call("POST", "/api/me/tasks/task-open/continuation", { toTaskId: "task-theirs" })).statusCode).toBe(403);
    expect((await g.call("POST", "/api/me/tasks/task-open/continuation", { toTaskId: "task-other" })).statusCode).toBe(404);
    expect((await g.call("POST", "/api/me/tasks/task-open/stop", {}, g.third)).statusCode).toBe(404);
    expect((await g.call("DELETE", "/api/me/tasks/task-open/stop", undefined, g.third)).statusCode).toBe(404);
    expect(await g.t.sql("SELECT * FROM task_continuations")).toEqual([]);
  }, 120_000);

  it("了结：到此为止和撤销；确认完成（之后开了返工不算）；延续优先", async () => {
    const g = f = await fixture();
    const stopped = await g.call("POST", "/api/me/tasks/task-open/stop", { note: "方向变了" });
    expect(stopped.json()).toMatchObject({ taskId: "task-open", settlement: { kind: "stopped", by: MEMBER, note: "方向变了", to: null } });
    expect((await settlementsOf(g.q, ["task-open"])).get("task-open")).toMatchObject({ kind: "stopped", note: "方向变了" });
    expect((await g.call("DELETE", "/api/me/tasks/task-open/stop")).statusCode).toBe(204);
    expect((await g.call("DELETE", "/api/me/tasks/task-open/stop")).statusCode).toBe(204);
    expect((await settlementsOf(g.q, ["task-open"])).size).toBe(0);

    await g.t.sql(`INSERT INTO deliverable_versions(id,task_id,mission_id,author_id,number,task_name,basis,delivered_at)
      VALUES($1,'task-open','mine',$2,1,'对话质量达标','acceptance','2026-11-05T00:00:00Z')`, [randomUUID(), MEMBER]);
    expect((await settlementsOf(g.q, ["task-open"])).get("task-open")).toMatchObject({ kind: "completed", at: "2026-11-05T00:00:00.000Z", by: MEMBER });
    const rework = await g.card("返工");
    await g.t.sql("UPDATE tasks SET rework_of_card_id=$1 WHERE id=$1", [rework]);
    expect((await settlementsOf(g.q, ["task-open"])).size).toBe(0);
    await g.call("POST", "/api/me/tasks/task-open/stop", {});
    await g.t.sql(`INSERT INTO task_continuations(from_task_id,to_task_id,source,decided_by,decided_at,from_mission_id,from_task_name,to_mission_id,to_task_name)
      VALUES('task-open','task-next','coagent',NULL,now(),'mine','对话质量达标','mine-dec','12 月接着做')`);
    expect((await settlementsOf(g.q, ["task-open"])).get("task-open")).toMatchObject({ kind: "continued", by: null, to: { taskId: "task-next", period: "2026-12" } });
  }, 120_000);

  it("月份页：这个月本人的 Task、约定几条达到、交付第几版、还在跑和受阻的子会话；旧的复盘答案接口没了", async () => {
    const g = f = await fixture();
    const machine = await g.local();
    const passed = await g.card("打分");
    const running = await g.card("录屏");
    const stuck = await g.card("卡住的");
    await g.t.sql("UPDATE tasks SET executor='claude_code',criterion_index=1,criterion_text='有题库打分结果' WHERE id=$1", [passed]);
    await g.t.sql("UPDATE tasks SET executor='claude_code',criterion_index=2,criterion_text='有新人上手录屏' WHERE id=$1", [running]);
    const handback = (card: string, attempt: number, outcome: string) => g.t.sql(`INSERT INTO card_handbacks(id,task_id,owner_id,client_id,attempt,status,outcome,finished_at)
      VALUES($1,$2,$3,$4,$5,'done',$6,now())`, [randomUUID(), card, MEMBER, `h-${card}-${attempt}`, attempt, outcome]);
    await handback(passed, 1, "pass");
    await handback(stuck, 1, "fail");
    await handback(stuck, 2, "fail");
    await g.t.sql("INSERT INTO local_runs(id,owner_id,device_id,kind,task_id,state,started_at) VALUES($1,$2,$3,'card',$4,'running',now())",
      [randomUUID(), MEMBER, machine.device, running]);
    await g.t.sql(`INSERT INTO deliverable_versions(id,task_id,mission_id,author_id,number,task_name,basis) VALUES($1,'task-open','mine',$2,1,'对话质量达标','acceptance')`,
      [randomUUID(), MEMBER]);

    await g.t.sql(`UPDATE missions SET outcome='内部 20 人每天用',milestones='["11/18 V1 上线","11/30 V2 上线"]' WHERE id='mine'`);

    const month = await g.call("GET", "/api/me/months/2026-11");
    expect(month.statusCode).toBe(200);
    // 每件带上 Mission 的成果、完成标准原文和哪几条达到、去向、验收时间点（没单独存的按 Mission 今天以后最近的节点）。
    expect(month.json()).toEqual({ period: "2026-11", draft: null, tasks: [{ taskId: "task-open", missionId: "mine", missionTitle: "内部版上线", missionOutcome: "内部 20 人每天用",
      name: "对话质量达标", criteria: [{ text: "有题库打分结果", met: true, changed: false, original: null }, { text: "有新人上手录屏", met: false, changed: false, original: null }],
      edited: null, added: false, dueDate: "2026-11-18", missionDueDate: "2026-11-18",
      disposition: "current", deferredTo: null, version: 1, running: 1, blocked: 1, done: false, settlement: null, continuedFrom: null }] });
    // 单独存过的验收时间点照存的写。
    const project = (await g.call("POST", "/api/me/projects", { name: "对话质量", taskId: "task-open" })).json().projectId as string;
    expect((await g.call("PUT", `/api/me/projects/${project}/goals/task-open/due-date`, { dueDate: "2026-11-25" })).statusCode).toBe(200);
    expect((await g.call("GET", "/api/me/months/2026-11")).json().tasks[0].dueDate).toBe("2026-11-25");
    // 第一版复盘答案的接口去掉了（复盘第三版，本人 11/11 定）。
    expect((await g.call("PUT", "/api/me/months/2026-11/tasks/task-open/decision", { choice: "continue", note: null })).statusCode).toBe(404);
    expect((await g.call("GET", "/api/me/months/2026-13")).statusCode).toBe(400);

    // 延续以后：11 月这件写延续去了哪，12 月那件写延续自哪。
    expect((await g.call("POST", "/api/me/tasks/task-open/continuation", { toTaskId: "task-next" })).statusCode).toBe(200);
    expect((await g.call("GET", "/api/me/months/2026-11")).json().tasks[0].settlement).toMatchObject({ kind: "continued", to: { taskId: "task-next", period: "2026-12" } });
    const december = (await g.call("GET", "/api/me/months/2026-12")).json();
    expect(december.tasks.map((task: { taskId: string; continuedFrom: unknown }) => [task.taskId, task.continuedFrom]).sort()).toEqual([
      ["task-next", { taskId: "task-open", name: "对话质量达标", missionId: "mine", period: "2026-11" }], ["task-next2", null]]);
  }, 120_000);
});
