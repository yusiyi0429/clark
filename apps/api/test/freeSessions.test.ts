import { describe, expect, it } from "vitest";
import { boardFixture } from "./boardFixture.js";

/** 第 68 条：项目下的「+」开自由子会话（带 free 的专题），和卡同在一个普通文件夹时排队写清在等谁。 */
describe("自由子会话", { timeout: 60_000 }, () => {
  const status = (value: string, title: string, extra: Record<string, unknown> = {}) =>
    ["status", { status: value, title, agent: "claude-code", modelLabel: "Opus 5.5", ...extra }] as [string, unknown];

  it("建：标题取第一句话第一行截 12 字加「…」，登记开工；交代是项目名加第一句话；首页带 free 和字母；参数不对 400", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const projectId = (await f.call("POST", "/api/me/projects", { name: "品牌建设" })).json().projectId as string;
      const first = "把首页的配色改成深色系，按钮也一起改\n别的不动";
      const created = await f.call("POST", "/api/me/topics", { free: true, projectId, firstMessage: first });
      expect(created.statusCode).toBe(201);
      const topic = created.json();
      expect(topic).toMatchObject({ title: "把首页的配色改成深色系，…", free: true, planTaskId: null, role: null });
      expect((await f.call("GET", `/api/me/topics/${topic.id}/brief`)).json()).toEqual({ markdown: first, title: "把首页的配色改成深色系，…",
        latestVersion: null, role: null, critics: [] });
      const home = (await f.call("GET", "/api/me/work-home")).json();
      const sub = home.projects.find((entry: { projectId: string }) => entry.projectId === projectId).subSessions[0];
      expect(sub).toMatchObject({ kind: "topic", id: topic.id, free: true, letter: "A", autoStart: true, state: "queued" });
      // 短的不截。
      expect((await f.call("POST", "/api/me/topics", { free: true, projectId, firstMessage: "  \n改个错字" })).json().title).toBe("改个错字");

      for (const body of [{ free: true, projectId, firstMessage: "x", title: "带了标题" }, { free: true, firstMessage: "x" }, { free: true, projectId },
        { free: true, projectId, firstMessage: "x", planTaskId: "task-open" }])
        expect((await f.call("POST", "/api/me/topics", body)).statusCode).toBe(400);
      expect((await f.call("POST", "/api/me/topics", { free: true, projectId: "00000000-0000-4000-8000-000000000000", firstMessage: "x" })).statusCode).toBe(404);
      expect((await f.call("POST", "/api/me/topics", {})).json()).toMatchObject({ code: "TITLE_REQUIRED" });
      expect((await f.call("POST", "/api/me/topics", { title: "普通专题" })).statusCode).toBe(201);
    } finally { await f.close(); }
  });

  it("同一个普通文件夹：卡排着等自由子会话这一轮做完，首页和右栏 worker 列表都写清在等谁（首页带字母）；自由子会话等批准进「等你」，一轮做完没在问的不进", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const projectId = (await f.call("POST", "/api/me/projects", { name: "品牌建设", taskId: "task-open" })).json().projectId as string;
      const topic = (await f.call("POST", "/api/me/topics", { free: true, projectId, firstMessage: "改首页配色" })).json();
      const card = await f.card("写说明");
      const dev = (await f.call("POST", "/api/me/roles", { name: "开发", family: "dev", kind: "worker" })).json();
      await f.call("PATCH", `/api/me/cards/${card}`, { version: 1, roleId: dev.id, executor: "claude_code" });
      const machine = await f.local();
      await machine.send({ kind: "topic", topicId: topic.id }, [status("waiting_permission", topic.title, { permission: { requestId: "p-1", toolName: "Bash",
        title: "运行 npm run build", outsidePaths: [], description: "构建一遍看配色" } })]);
      await machine.send({ kind: "card", cardId: card }, [status("queued", "写说明", { heldBy: { kind: "topic", id: topic.id, title: topic.title } })]);

      const home = (await f.call("GET", "/api/me/work-home")).json();
      const subs = home.projects.find((entry: { projectId: string }) => entry.projectId === projectId).subSessions as { id: string }[];
      const cardSub = subs.find((entry) => entry.id === card);
      const topicSub = subs.find((entry) => entry.id === topic.id) as { letter: string };
      expect(cardSub).toMatchObject({ state: "queued", queueReason: "folder_busy", heldBy: { kind: "topic", id: topic.id, letter: topicSub.letter, title: "改首页配色" } });
      // 右栏 worker 列表：同一张卡也写在等文件夹、等的是谁，不再只写排队。
      const queued = (await f.call("GET", "/api/me/workers")).json().queued as { key: string }[];
      expect(queued.find((item) => item.key === `card:${card}`)).toMatchObject({ queueReason: "folder_busy", queuePosition: null,
        heldBy: { kind: "topic", id: topic.id, title: "改首页配色" } });
      expect(home.waiting.find((item: { id: string }) => item.id === `approval:topic:${topic.id}`)).toMatchObject({ kind: "approval", summary: "构建一遍看配色" });

      // 一轮做完、没在问：已停下，不进「等你」。
      await f.t.sql("UPDATE local_runs SET state='idle',ask=NULL WHERE topic_id=$1", [topic.id]);
      expect((await f.call("GET", "/api/me/work-home")).json().waiting.filter((item: { id: string }) => item.id.endsWith(topic.id))).toEqual([]);
    } finally { await f.close(); }
  });
});
