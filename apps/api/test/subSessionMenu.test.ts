import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BOARD_NOW, boardFixture } from "./boardFixture.js";
import { TEST_MEMBER } from "./helpers.js";

/** 17.2 第 35 条：项目和子会话那一行的「…」菜单——子会话改名、归档、删进回收站，项目删除。 */
async function fixture() {
  const f = await boardFixture({}, { boardCloudAgents: false });
  const project = async (name: string) => (await f.call("POST", "/api/me/projects", { name })).json().projectId as string;
  /** 挂在项目上、交给 Claude Code 的卡（子会话）。 */
  const agentCard = async (title: string, projectId: string) => {
    const id = await f.card(title);
    await f.t.sql("UPDATE tasks SET executor='claude_code',project_id=$2,plan_task_id=NULL WHERE id=$1", [id, projectId]);
    return id;
  };
  const topic = async (title: string, projectId: string) => {
    const id = (await f.call("POST", "/api/me/topics", { title })).json().id as string;
    await f.t.sql("UPDATE research_topics SET project_id=$2 WHERE id=$1", [id, projectId]);
    return id;
  };
  /** 本机一次执行：state 是 running 时算在跑。 */
  const run = async (column: "task_id" | "topic_id", id: string, state: string, kind: "card" | "topic" | "plan" = column === "task_id" ? "card" : "topic") => {
    const runId = randomUUID();
    await f.t.sql(`INSERT INTO local_runs(id,owner_id,device_id,kind,${column},started_at,state) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [runId, TEST_MEMBER.personId, randomUUID(), kind, id, BOARD_NOW, state]);
    return runId;
  };
  const subs = async () => ((await f.call("GET", "/api/me/work-home")).json().projects as { projectId: string; subSessions: { id: string; title: string }[] }[])
    .flatMap((entry) => entry.subSessions);
  return { ...f, project, agentCard, topic, run, subs };
}

describe("行尾「…」菜单（17.2 第 35 条）", { timeout: 60_000 }, () => {
  it("子会话：改名（专题最长 60 字）、在跑时不能归档和删、归档后从首页收起进归档列表（带项目和字母）、恢复回来；删除进回收站能恢复；在回收站里的、没有的 404", async () => {
    const f = await fixture();
    try {
      const project = await f.project("天枢");
      const card = await f.agentCard("跑题库打分", project);
      const topic = await f.topic("竞品调研", project);
      const patch = (kind: string, id: string, body: unknown) => f.call("PATCH", `/api/me/sub-sessions/${kind}/${id}`, body);

      expect((await patch("card", card, { title: "  跑题库打分（第二轮）  " })).statusCode).toBe(204);
      expect((await patch("topic", topic, { title: "对手".repeat(31) })).json().code).toBe("TITLE_TOO_LONG");
      expect((await patch("topic", topic, { title: "  " })).json().code).toBe("INVALID_TITLE");
      expect((await patch("topic", topic, { title: "竞品对比" })).statusCode).toBe(204);
      expect((await f.subs()).map((sub) => sub.title).sort()).toEqual(["竞品对比", "跑题库打分（第二轮）"]);

      // 在跑时能改名，不能归档、不能删。
      const live = await f.run("task_id", card, "running");
      expect((await patch("card", card, { title: "跑题库" })).statusCode).toBe(204);
      expect((await patch("card", card, { archived: true })).json().code).toBe("SUB_SESSION_RUNNING");
      expect((await f.call("DELETE", `/api/me/sub-sessions/card/${card}`)).json().code).toBe("SUB_SESSION_RUNNING");
      await f.t.sql("UPDATE local_runs SET state='exited' WHERE id=$1", [live]);

      // 归档：首页收起，归档列表里带原来的项目和字母；恢复回来。
      expect((await patch("card", card, { archived: true })).statusCode).toBe(204);
      expect((await patch("topic", topic, { archived: true })).statusCode).toBe(204);
      expect(await f.subs()).toEqual([]);
      const archived = (await f.call("GET", "/api/me/sub-sessions/archived")).json().items;
      expect(archived.map((item: { kind: string }) => item.kind).sort()).toEqual(["card", "topic"]);
      expect(archived.find((item: { id: string }) => item.id === card)).toMatchObject({ title: "跑题库", projectId: project, projectName: "天枢",
        letter: expect.stringMatching(/^[A-Z]$/), archivedAt: expect.any(String) });
      expect((await patch("card", card, { archived: false })).statusCode).toBe(204);
      expect((await patch("topic", topic, { archived: false })).statusCode).toBe(204);
      expect((await f.subs()).map((sub) => sub.id).sort()).toEqual([card, topic].sort());
      expect((await f.call("GET", "/api/me/sub-sessions/archived")).json().items).toEqual([]);

      // 删除进回收站：首页没了，回收站里有，能恢复；在回收站里的再改、再删 404。
      expect((await f.call("DELETE", `/api/me/sub-sessions/topic/${topic}`)).statusCode).toBe(204);
      expect((await f.subs()).map((sub) => sub.id)).toEqual([card]);
      expect((await f.call("GET", "/api/me/trash")).json().items.map((item: { id: string }) => item.id)).toEqual([topic]);
      expect((await patch("topic", topic, { title: "又改" })).statusCode).toBe(404);
      expect((await f.call("DELETE", `/api/me/sub-sessions/topic/${topic}`)).statusCode).toBe(404);
      expect((await f.call("POST", `/api/me/trash/topic/${topic}/restore`)).statusCode).toBe(204);
      expect((await f.subs()).map((sub) => sub.id).sort()).toEqual([card, topic].sort());

      // 自己做的事项不是子会话；没有的、kind 不对的。
      const mine = await f.card("自己写周报");
      expect((await patch("card", mine, { title: "改" })).statusCode).toBe(404);
      expect((await patch("card", randomUUID(), { title: "改" })).statusCode).toBe(404);
      expect((await patch("card", card, {})).statusCode).toBe(400);
      expect((await f.call("PATCH", `/api/me/sub-sessions/item/${card}`, { title: "改" })).statusCode).toBe(400);
    } finally { await f.close(); }
  });

  it("项目删除：有在跑的子会话或规划员 409 PROJECT_BUSY（写明字母 · 标题）、正在转交 409；删掉后项目和对话没了，子会话进回收站，挂着的 Task 取下来不再自动挂回，自己做的事项留下", async () => {
    const f = await fixture();
    try {
      // 先读一次首页：做完上线迁移（按 Mission 建的「内部版上线」，task-open 先挂在它上面），再挂到要删的项目。
      const bootstrapped = (await f.call("GET", "/api/me/work-home")).json().projects.map((entry: { projectId: string }) => entry.projectId);
      const project = await f.project("天枢");
      expect((await f.call("PUT", `/api/me/projects/${project}/goals/task-open`)).statusCode).toBe(200);
      const card = await f.agentCard("跑题库打分", project);
      const topic = await f.topic("竞品调研", project);
      const mine = await f.card("自己写周报");
      await f.t.sql("UPDATE tasks SET project_id=$2,plan_task_id=NULL WHERE id=$1", [mine, project]);
      expect((await f.call("POST", `/api/conversations/project:${project}/messages`, { message: "先拆一下" })).statusCode).toBe(200);
      expect((await f.call("POST", "/api/me/work-seen", { kind: "project", id: project })).statusCode).toBe(204);

      const live = await f.run("task_id", card, "idle");
      const busy = await f.call("DELETE", `/api/me/projects/${project}`);
      expect(busy.statusCode).toBe(409);
      expect(busy.json()).toMatchObject({ code: "PROJECT_BUSY", message: expect.stringMatching(/[A-Z] · 跑题库打分/) });
      await f.t.sql("UPDATE local_runs SET state='exited' WHERE id=$1", [live]);
      const planner = randomUUID();
      await f.t.sql(`INSERT INTO local_runs(id,owner_id,device_id,kind,project_id,started_at,state) VALUES($1,$2,$3,'plan',$4,$5,'running')`,
        [planner, TEST_MEMBER.personId, randomUUID(), project, BOARD_NOW]);
      expect((await f.call("DELETE", `/api/me/projects/${project}`)).json()).toMatchObject({ code: "PROJECT_BUSY", message: expect.stringContaining("规划员") });
      await f.t.sql("UPDATE local_runs SET state='exited' WHERE id=$1", [planner]);
      const transfer = randomUUID();
      await f.t.sql("INSERT INTO project_transfers(id,project_id,from_id,to_id,status,started_at) VALUES($1,$2,$3,'someone','sent',$4)",
        [transfer, project, TEST_MEMBER.personId, BOARD_NOW]);
      expect((await f.call("DELETE", `/api/me/projects/${project}`)).json().code).toBe("PROJECT_TRANSFERRING");
      await f.t.sql("UPDATE project_transfers SET status='withdrawn' WHERE id=$1", [transfer]);
      // 都没删。
      expect((await f.call("GET", `/api/me/projects/${project}`)).statusCode).toBe(200);

      expect((await f.call("DELETE", `/api/me/projects/${project}`)).statusCode).toBe(204);
      expect((await f.call("GET", `/api/me/projects/${project}`)).statusCode).toBe(404);
      expect((await f.call("DELETE", `/api/me/projects/${project}`)).statusCode).toBe(404);
      expect((await f.call("GET", "/api/me/projects")).json().projects.map((entry: { projectId: string }) => entry.projectId)).toEqual(bootstrapped);
      expect((await f.call("GET", "/api/me/trash")).json().items.map((item: { id: string }) => item.id).sort()).toEqual([card, topic].sort());
      expect((await f.t.sql("SELECT project_id FROM tasks WHERE id=$1", [mine]))[0].project_id).toBeNull();
      expect((await f.t.sql("SELECT project_id,source FROM project_goals WHERE task_id='task-open'"))).toEqual([{ project_id: null, source: "owner" }]);
      expect((await f.t.sql("SELECT count(*)::int AS n FROM conversations WHERE scope=$1 AND deleted_at IS NULL", [`project:${project}`]))[0].n).toBe(0);
      expect((await f.t.sql("SELECT count(*)::int AS n FROM work_seen WHERE object_id=$1", [project]))[0].n).toBe(0);
      // 首页：删掉的项目没了，Task 回到「本月」里没挂的状态（不会自动挂回迁移建的项目）；恢复的子会话在「其他」里。
      const home = (await f.call("GET", "/api/me/work-home")).json();
      expect(home.projects.map((entry: { projectId: string }) => entry.projectId)).toEqual(bootstrapped);
      expect(home.month.missions.flatMap((mission: { tasks: { taskId: string; project: unknown }[] }) => mission.tasks)
        .find((task: { taskId: string }) => task.taskId === "task-open").project).toBeNull();
      expect((await f.call("POST", `/api/me/trash/card/${card}/restore`)).statusCode).toBe(204);
      expect((await f.call("GET", "/api/me/work-home")).json().other.subSessions.map((sub: { id: string }) => sub.id)).toEqual([card]);
    } finally { await f.close(); }
  });
});
