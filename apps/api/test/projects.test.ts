import { randomUUID } from "node:crypto";
import type { THomePlanTask } from "@warmap/contracts";
import { describe, expect, it } from "vitest";
import { TEST_MEMBER } from "./helpers.js";
import { BOARD_NOW, BOARD_TASKS, boardFixture, THIRD, type BoardFixture } from "./boardFixture.js";

/** 项目常驻，每月目标挂在项目上（契约 projects.ts，设计《新首页》第 16 节）：项目、挂接、详情、项目对话、项目动态、自动挂接、上线迁移。 */

const NOW = BOARD_NOW.toISOString();
const create = async (f: BoardFixture, body: Record<string, unknown>) => {
  const res = await f.call("POST", "/api/me/projects", body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { projectId: string; name: string; archivedAt: string | null };
};
const home = async (f: BoardFixture) => {
  const res = await f.call("GET", "/api/me/work-home");
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
/** 跳过上线迁移（当作已经做过），只看自动挂接和本人手动的。 */
const skipBootstrap = (f: BoardFixture) => f.t.sql("INSERT INTO project_bootstraps(person_id,done_at,report) VALUES($1,$2,'{}')", [TEST_MEMBER.personId, BOARD_NOW]);
const goalRow = async (f: BoardFixture, taskId: string) =>
  (await f.t.sql("SELECT project_id::text,source,period FROM project_goals WHERE task_id=$1", [taskId]))[0] as { project_id: string | null; source: string; period: string } | undefined;
/** 界面收到的事件（只取 data 行）。 */
const events = (payload: string) => payload.split("\n\n").flatMap((block) => {
  const line = block.split("\n").find((candidate) => candidate.startsWith("data:"));
  return line ? [JSON.parse(line.slice(5)) as Record<string, unknown>] : [];
});

describe("项目", { timeout: 60_000 }, () => {
  it("建、改名、归档、恢复；挂接（移到别的项目、取下来）；详情的目标历史和判定；别人的项目 404；CEO 视角 403", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      await skipBootstrap(f);
      const card = await f.card("挂上之前就有的卡");
      const a = await create(f, { name: "  天枢新首页 " });
      expect(a).toEqual({ projectId: a.projectId, name: "天枢新首页", archivedAt: null, createdAt: NOW, lastActivityAt: null });
      // 带 Task 建：要是本人负责的；不是的不建。
      expect((await f.call("POST", "/api/me/projects", { name: "别人的", taskId: "task-theirs" })).statusCode).toBe(403);
      expect((await f.call("POST", "/api/me/projects", { name: "找不到", taskId: "task-nope" })).statusCode).toBe(404);
      expect((await f.call("POST", "/api/me/projects", { name: "" })).statusCode).toBe(400);
      expect(await f.t.sql("SELECT name FROM projects")).toEqual([{ name: "天枢新首页" }]);

      // 挂上：快照 Task 名、Mission、月份；卡跟着进项目。
      const linked = await f.call("PUT", `/api/me/projects/${a.projectId}/goals/task-open`);
      expect(linked.statusCode).toBe(200);
      expect(linked.json()).toEqual({ taskId: "task-open", taskName: "对话质量达标", missionId: "mine", missionTitle: "内部版上线", period: "2026-11",
        verdict: "open", source: "owner", linkedAt: NOW });
      expect(await f.t.sql("SELECT project_id::text FROM tasks WHERE id=$1", [card])).toEqual([{ project_id: a.projectId }]);
      expect((await f.call("PUT", `/api/me/projects/${a.projectId}/goals/task-theirs`)).statusCode).toBe(403);

      // 一件 Task 只挂一个项目：建 B 时带上它，就从 A 移过来。
      const b = await create(f, { name: "第二个项目", taskId: "task-open" });
      expect((await f.call("GET", `/api/me/projects/${a.projectId}`)).json().goals).toEqual([]);
      expect((await f.call("GET", `/api/me/projects/${b.projectId}`)).json()).toMatchObject({ project: { name: "第二个项目" }, period: "2026-11",
        goals: [{ taskId: "task-open", verdict: "open" }] });
      expect(await f.t.sql("SELECT project_id::text FROM tasks WHERE id=$1", [card])).toEqual([{ project_id: b.projectId }]);

      // 判定：交付了是 completed。
      await f.t.sql(`INSERT INTO deliverable_versions(id,task_id,mission_id,author_id,number,task_name,basis,criteria,delivered_at)
        VALUES($1,'task-open','mine',$2,1,'x','acceptance','[]',$3)`, [randomUUID(), TEST_MEMBER.personId, BOARD_NOW]);
      expect((await f.call("GET", `/api/me/projects/${b.projectId}`)).json().goals[0].verdict).toBe("completed");

      // 取下来：留给本人在「本月」里选，不再自动挂；再取一次 404。
      expect((await f.call("DELETE", `/api/me/projects/${b.projectId}/goals/task-open`)).statusCode).toBe(204);
      expect((await f.call("DELETE", `/api/me/projects/${b.projectId}/goals/task-open`)).statusCode).toBe(404);
      let body = await home(f);
      expect(body.month.missions[0].tasks).toEqual([{ taskId: "task-open", name: "对话质量达标", completedAt: NOW, project: null }]);
      expect(await goalRow(f, "task-open")).toEqual({ project_id: null, source: "owner", period: "2026-11" });

      // 改名、归档：归档的不在左栏、不能挂，「已归档 N」；恢复。
      expect((await f.call("PATCH", `/api/me/projects/${a.projectId}`, { name: "改了名" })).json()).toMatchObject({ name: "改了名", archivedAt: null });
      expect((await f.call("PATCH", `/api/me/projects/${a.projectId}`, {})).statusCode).toBe(400);
      expect((await f.call("PATCH", `/api/me/projects/${a.projectId}`, { archived: true })).json()).toMatchObject({ archivedAt: NOW });
      expect((await f.call("PUT", `/api/me/projects/${a.projectId}/goals/task-open`)).statusCode).toBe(409);
      body = await home(f);
      expect([body.projects.map((project: { name: string }) => project.name), body.archivedCount]).toEqual([["第二个项目"], 1]);
      expect((await f.call("GET", "/api/me/projects")).json().projects.map((project: { name: string }) => project.name)).toEqual(["第二个项目", "改了名"]);
      expect((await f.call("PATCH", `/api/me/projects/${a.projectId}`, { archived: false })).json()).toMatchObject({ archivedAt: null });

      // 别人的项目、找不到的、不是 uuid 的都 404；CEO 视角 403。
      const theirs = randomUUID();
      await f.t.sql("INSERT INTO projects(id,owner_id,name,created_at,updated_at) VALUES($1,$2,'别人的项目',$3,$3)", [theirs, THIRD.personId, BOARD_NOW]);
      for (const id of [theirs, randomUUID(), "not-a-uuid"]) {
        expect((await f.call("GET", `/api/me/projects/${id}`)).statusCode).toBe(404);
        expect((await f.call("PATCH", `/api/me/projects/${id}`, { name: "x" })).statusCode).toBe(404);
        expect((await f.call("PUT", `/api/me/projects/${id}/goals/task-open`)).statusCode).toBe(404);
        expect((await f.call("POST", `/api/me/projects/${id}/pipeline`)).statusCode).toBe(404);
        expect((await f.call("GET", `/api/me/projects/${id}/feed`)).statusCode).toBe(404);
      }
      const ceo = await f.t.loginCookie();
      expect((await f.call("GET", "/api/me/projects", undefined, ceo)).statusCode).toBe(403);
      expect((await f.call("POST", "/api/me/projects", { name: "x" }, ceo)).statusCode).toBe(403);
    } finally { await f.close(); }
  });

  it("项目对话（没接 Chat）：第一次打开建（201），再打开同一条（200）；发一句、读历史，和总管线分开；伙伴看到的页面对象是项目和挂着的 Task", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      await skipBootstrap(f);
      const { projectId } = await create(f, { name: "天枢新首页", taskId: "task-open" });
      const scope = `project:${projectId}`;
      const first = await f.call("POST", `/api/me/projects/${projectId}/pipeline`);
      expect(first.statusCode).toBe(201);
      const [row] = await f.t.sql("SELECT id::text,owner_id FROM conversations WHERE scope=$1", [scope]);
      expect(first.json()).toEqual({ projectId, conversationId: row.id, scope });
      expect(row.owner_id).toBe(TEST_MEMBER.personId);
      const again = await f.call("POST", `/api/me/projects/${projectId}/pipeline`);
      expect([again.statusCode, again.json()]).toEqual([200, first.json()]);
      expect(await f.t.sql("SELECT * FROM project_pipelines")).toEqual([]);

      const sent = await f.t.app.inject({ method: "POST", url: `/api/conversations/${encodeURIComponent(scope)}/messages`,
        headers: { cookie: f.member, origin: f.t.publicOrigin, accept: "text/event-stream" }, payload: { message: "这个项目怎么拆" } });
      expect(sent.statusCode).toBe(200);
      expect(events(sent.payload).every((event) => event.scope === scope)).toBe(true);
      const history = (await f.call("GET", `/api/conversations/${encodeURIComponent(scope)}/messages`)).json();
      expect(history.messages.map((item: { role: string; content: string }) => [item.role, item.content])).toEqual([["user", "这个项目怎么拆"], ["assistant", "test reply"]]);
      expect((await f.call("GET", "/api/conversations/global/messages")).json().messages).toEqual([]);
      const [run] = await f.t.sql("SELECT input_snapshot FROM agent_runs WHERE kind = 'conversation'");
      expect(run.input_snapshot.currentObject).toMatchObject({ cardId: scope, kind: "project", title: "项目：天枢新首页", objectRef: { type: "project", id: projectId, version: 1 },
        payload: { project: { name: "天枢新首页" }, goals: [{ task: { name: "对话质量达标", doneDefinition: "对话质量过 75 分", criteria: ["有题库打分结果", "有新人上手录屏"] },
          agreement: { criteria: [{ index: 1, text: "有题库打分结果" }, { index: 2, text: "有新人上手录屏" }], exclusions: [] } }] } });
      // 首页的项目行带上这条对话。
      expect((await home(f)).projects.find((project: { projectId: string }) => project.projectId === projectId).pipeline).toEqual({ conversationId: row.id, scope });

      // 别人的项目：读历史、发一句都 404，不建对话。
      const theirs = randomUUID();
      await f.t.sql("INSERT INTO projects(id,owner_id,name,created_at,updated_at) VALUES($1,$2,'别人的项目',$3,$3)", [theirs, THIRD.personId, BOARD_NOW]);
      expect((await f.call("GET", `/api/conversations/${encodeURIComponent(`project:${theirs}`)}/messages`)).statusCode).toBe(404);
      expect(await f.t.sql("SELECT id FROM conversations WHERE scope=$1", [`project:${theirs}`])).toEqual([]);
    } finally { await f.close(); }
  });

  it("项目动态：挂上目标的分隔线，项目里的卡（挂着的 Task 下的、直接放在项目里的）验收过、受阻、约定都达到、返工；别人的卡和不在项目里的卡不出现", async () => {
    const f = await boardFixture();
    try {
      await skipBootstrap(f);
      const at = (minute: number) => new Date(Date.UTC(2026, 10, 6, 3, minute)).toISOString();
      const handback = async (cardId: string, attempt: number, outcome: "pass" | "fail", minute: number, verdicts: string[], extra: { returnText?: string; owner?: string } = {}) =>
        (await f.t.sql(`INSERT INTO card_handbacks(id,task_id,owner_id,client_id,attempt,criteria,status,finished_at,result,outcome,return_text)
          VALUES($1,$2,$3,$4,$5,'["甲","乙"]'::jsonb,'done',$6,$7::jsonb,$8,$9) RETURNING id`, [randomUUID(), cardId, extra.owner ?? TEST_MEMBER.personId, `k${attempt}`,
          attempt, at(minute), JSON.stringify({ headline: "结论", beyondScope: [], criteria: verdicts.map((verdict, index) => ({ index: index + 1, verdict, reason: "理由",
            evidence: null, fix: null })) }), outcome, extra.returnText ?? null]))[0].id as string;
      const { projectId } = await create(f, { name: "天枢新首页", taskId: "task-open" });
      const [score, video, stuck, loose] = [await f.card("打分"), await f.card("录屏"), await f.card("卡住的"), await f.card("直接放在项目里的")];
      await f.t.sql("UPDATE tasks SET criterion_index=1,criterion_text='有题库打分结果' WHERE id=$1", [score]);
      await f.t.sql("UPDATE tasks SET criterion_index=2,criterion_text='有新人上手录屏' WHERE id=$1", [video]);
      await f.t.sql("UPDATE tasks SET plan_task_id=NULL,project_id=$2 WHERE id=$1", [loose, projectId]);
      const scorePass = await handback(score, 1, "pass", 5, ["met", "met"]);
      const videoPass = await handback(video, 1, "pass", 8, ["met", "met"]);
      await handback(stuck, 1, "fail", 2, ["not_met", "met"], { returnText: "第一次" });
      const blocked = await handback(stuck, 2, "fail", 3, ["not_met", "met"], { returnText: "第二次" });
      const loosePass = await handback(loose, 1, "pass", 9, ["met"]);
      // 别人在这件 Task 下的卡、本人在别的 Task 下的卡：不出现。
      const theirs = randomUUID();
      await f.t.sql(`INSERT INTO tasks(id,title,owner_id,created_by,status,mission_id,step_order,plan_task_id) VALUES($1,'别人的卡',$2,'self','done','other',1,'task-open')`,
        [theirs, THIRD.personId]);
      await handback(theirs, 1, "pass", 4, ["met", "met"], { owner: THIRD.personId });
      await handback(await f.card("别的 Task 的卡", { planTaskId: "task-theirs" }), 1, "pass", 4, ["met", "met"]);

      const res = await f.call("GET", `/api/me/projects/${projectId}/feed`);
      expect(res.statusCode).toBe(200);
      expect(res.json().items.map((item: { kind: string; id: string; at: string }) => [item.kind, item.id, item.at])).toEqual([
        ["goal_linked", "goal:task-open", NOW],
        ["card_blocked", `blocked:${blocked}`, at(3)],
        ["card_passed", `passed:${scorePass}`, at(5)],
        // 同一时刻按 id：criteria: 在 passed: 前面。
        ["criteria_met", "criteria:task-open:2", at(8)],
        ["card_passed", `passed:${videoPass}`, at(8)],
        ["card_passed", `passed:${loosePass}`, at(9)],
      ]);
      expect(res.json().items[0]).toEqual({ kind: "goal_linked", id: "goal:task-open", at: NOW, period: "2026-11", taskId: "task-open", taskName: "对话质量达标" });
      expect(res.json().items.find((item: { kind: string }) => item.kind === "criteria_met")).toMatchObject({ taskId: "task-open", met: 2, total: 2 });
      // 首页的项目行：标准 2/2。
      const project = (await home(f)).projects.find((item: { projectId: string }) => item.projectId === projectId);
      expect(project.goals[0]).toMatchObject({ criteriaMet: 2, criteriaTotal: 2, criteria: ["有题库打分结果", "有新人上手录屏"] });
    } finally { await f.close(); }
  });

  it("上线迁移：第一次读首页按看得见的 Mission 建同名项目、挂上本人负责的 Task，旧的 Task 管线对话按时间并进项目对话；只做一次", async () => {
    const tasks: THomePlanTask[] = [...BOARD_TASKS, { taskId: "task-two", missionId: "mine", name: "第二件", doneDefinition: null, criteria: [] }];
    const f = await boardFixture({ planTasks: async (missions) => tasks.filter((task) => missions.some((mission) => mission.id === task.missionId)) },
      { boardCloudAgents: false });
    try {
      // 两件 Task 各有一条旧管线，消息时间交错。
      const message = (conversation: string, sequence: number, content: string, minute: number) => f.t.sql(`INSERT INTO conversation_messages
        (conversation_id,sequence,role,content,run_id,created_at) VALUES($1,$2,'user',$3,$4,$5)`, [conversation, sequence, content, randomUUID(),
        new Date(Date.UTC(2026, 10, 2, 1, minute))]);
      const [one, two] = [randomUUID(), randomUUID()];
      await f.t.sql("INSERT INTO conversations (id,owner_id,scope,pi_session_id,created_at) VALUES ($1,$3,'plan-task:task-open',$4,'2026-11-02T01:00:00Z'),($2,$3,'plan-task:task-two',$5,'2026-11-02T01:01:00Z')",
        [one, two, TEST_MEMBER.personId, randomUUID(), randomUUID()]);
      await message(one, 1, "第一句", 1);
      await message(two, 1, "第二件的第一句", 2);
      await message(one, 2, "第三句", 3);

      const body = await home(f);
      expect(body.projects.map((project: { name: string; goals: { taskId: string }[] }) => [project.name, project.goals.map((goal) => goal.taskId).sort()]))
        .toEqual([["内部版上线", ["task-open", "task-two"]]]);
      const projectId = body.projects[0].projectId as string;
      expect(await f.t.sql("SELECT task_id,source,linked_at FROM project_goals ORDER BY task_id")).toEqual([
        // 挂接时间是月初（公司时区 11/1 0 点），旧管线没有更早的话。
        { task_id: "task-open", source: "migration", linked_at: new Date("2026-10-31T16:00:00.000Z") },
        { task_id: "task-two", source: "migration", linked_at: new Date("2026-10-31T16:00:00.000Z") },
      ]);
      // 最早那条改成项目的 scope，另一条的消息挪过来、按时间重新编号，挪空的软删。
      expect(await f.t.sql("SELECT id::text,scope,deleted_at IS NOT NULL AS deleted FROM conversations ORDER BY created_at")).toEqual([
        { id: one, scope: `project:${projectId}`, deleted: false }, { id: two, scope: "plan-task:task-two", deleted: true }]);
      expect(await f.t.sql("SELECT sequence,content FROM conversation_messages WHERE conversation_id=$1 ORDER BY sequence", [one])).toEqual([
        { sequence: 1, content: "第一句" }, { sequence: 2, content: "第二件的第一句" }, { sequence: 3, content: "第三句" }]);
      expect(body.projects[0].pipeline).toEqual({ conversationId: one, scope: `project:${projectId}` });
      const [report] = await f.t.sql("SELECT report FROM project_bootstraps WHERE person_id=$1", [TEST_MEMBER.personId]);
      expect(report.report.projects).toEqual([{ projectId, name: "内部版上线", missions: ["mine"], tasks: ["task-open", "task-two"], conversations: 2, chatPipelines: 0,
        unmergedChat: [] }]);

      // 再读不重做；本人改名、另建的照旧。
      await f.call("PATCH", `/api/me/projects/${projectId}`, { name: "改了名" });
      await home(f);
      expect(await f.t.sql("SELECT name FROM projects")).toEqual([{ name: "改了名" }]);
    } finally { await f.close(); }
  });

  it("自动挂接：延续关系里上一件的项目 → 之前月份同名、同 Mission 名的那件的项目 → 迁移时按它的 Mission 建的项目；只挂本人没归档的项目；挂接时间是挂上的那一刻", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      await skipBootstrap(f);
      const mine = async (name: string, origin: string | null = null, owner: string = TEST_MEMBER.personId) => {
        const id = randomUUID();
        await f.t.sql("INSERT INTO projects(id,owner_id,name,origin_mission_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)", [id, owner, name, origin, BOARD_NOW]);
        return id;
      };
      const oldGoal = (taskId: string, projectId: string, name = "对话质量达标") => f.t.sql(`INSERT INTO project_goals(task_id,project_id,owner_id,period,mission_id,mission_title,
        task_name,source,linked_at) VALUES($1,$2,$3,'2026-10','oct','内部版上线',$4,'owner','2026-10-01T00:00:00Z')`, [taskId, projectId, TEST_MEMBER.personId, name]);
      const relink = async () => {
        await f.t.sql("DELETE FROM project_goals WHERE task_id='task-open'");
        await home(f);
        return goalRow(f, "task-open");
      };

      // 什么都对不上：不挂，留在「本月」里等本人选。
      expect(await relink()).toBeUndefined();
      // 迁移时按 mine 建的项目。
      const byMission = await mine("内部版上线", "mine");
      expect(await relink()).toEqual({ project_id: byMission, source: "auto", period: "2026-11" });
      // 上个月同名、同 Mission 名的那件挂的项目优先。
      const byName = await mine("对话质量");
      await oldGoal("oct-quality", byName);
      expect((await relink())?.project_id).toBe(byName);
      // 延续关系最优先；别人的项目、归档的项目都不算。
      const continued = await mine("延续过来的");
      await oldGoal("oct-continued", continued, "上个月叫别的名字");
      await f.t.sql(`INSERT INTO task_continuations(from_task_id,to_task_id,source,decided_at,from_mission_id,from_task_name,to_mission_id,to_task_name)
        VALUES('oct-continued','task-open','coagent',$1,'oct','上个月叫别的名字','mine','对话质量达标')`, [BOARD_NOW]);
      expect((await relink())?.project_id).toBe(continued);
      await f.t.sql("UPDATE projects SET archived_at=$2 WHERE id=$1", [continued, BOARD_NOW]);
      expect((await relink())?.project_id).toBe(byName);
      await f.t.sql("UPDATE projects SET owner_id=$2 WHERE id=ANY($1::uuid[])", [[byName, byMission], THIRD.personId]);
      expect(await relink()).toBeUndefined();

      // 挂上的那一刻就是分隔线的位置；首页「本月」带上项目名。
      const fresh = await mine("新项目", "mine");
      expect(await relink()).toEqual({ project_id: fresh, source: "auto", period: "2026-11" });
      const feed = (await f.call("GET", `/api/me/projects/${fresh}/feed`)).json().items;
      expect(feed).toEqual([{ kind: "goal_linked", id: "goal:task-open", at: NOW, period: "2026-11", taskId: "task-open", taskName: "对话质量达标" }]);
      expect((await home(f)).month.missions[0].tasks[0].project).toEqual({ projectId: fresh, name: "新项目" });
    } finally { await f.close(); }
  });
});
