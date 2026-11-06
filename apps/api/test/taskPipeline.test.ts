import { afterEach, describe, expect, it } from "vitest";
import { boardFixture, type BoardFixture } from "./boardFixture.js";
import { TEST_MEMBER } from "./helpers.js";

/** 界面收到的事件（只取 data 行）。 */
const events = (payload: string) => payload.split("\n\n").flatMap((block) => {
  const line = block.split("\n").find((candidate) => candidate.startsWith("data:"));
  return line ? [JSON.parse(line.slice(5)) as Record<string, unknown>] : [];
});

describe("Task 管线（没接 Chat：天枢自己的对话）", () => {
  let f: BoardFixture;
  afterEach(async () => { await f?.close(); });
  const scope = encodeURIComponent("plan-task:task-open");
  const say = (url: string, message: string) => f.t.app.inject({ method: "POST", url, headers: { cookie: f.member, origin: f.t.publicOrigin, accept: "text/event-stream" },
    payload: { message } });

  it("第一次打开建对话（201），再打开还是这条（200）；不是负责人 403、找不到 404；CEO 视角 403", async () => {
    f = await boardFixture({}, { boardCloudAgents: false });
    const first = await f.call("POST", "/api/me/tasks/task-open/pipeline");
    expect(first.statusCode).toBe(201);
    const [row] = await f.t.sql("SELECT id, owner_id, scope FROM conversations WHERE scope = 'plan-task:task-open'");
    expect(first.json()).toEqual({ taskId: "task-open", conversationId: row.id, scope: "plan-task:task-open" });
    expect(row.owner_id).toBe(TEST_MEMBER.personId);
    const again = await f.call("POST", "/api/me/tasks/task-open/pipeline");
    expect([again.statusCode, again.json()]).toEqual([200, first.json()]);
    // 没接 Chat 不往 task_pipelines 写。
    expect(await f.t.sql("SELECT * FROM task_pipelines")).toEqual([]);

    expect((await f.call("POST", "/api/me/tasks/task-theirs/pipeline")).statusCode).toBe(403);
    expect((await f.call("POST", "/api/me/tasks/task-nope/pipeline")).statusCode).toBe(404);
    expect((await f.call("POST", "/api/me/tasks/task-open/pipeline", undefined, await f.t.loginCookie())).statusCode).toBe(403);
  }, 30_000);

  it("plan-task 能发一句、读历史，和总管线的历史分开；伙伴看到的页面对象是这件 Task", async () => {
    f = await boardFixture({}, { boardCloudAgents: false });
    const sent = await say(`/api/conversations/${scope}/messages`, "这件怎么拆");
    expect(sent.statusCode).toBe(200);
    const received = events(sent.payload);
    expect(received.find((event) => event.type === "message")).toMatchObject({ delta: "test reply" });
    expect(received.every((event) => event.scope === "plan-task:task-open")).toBe(true);

    const history = (await f.call("GET", `/api/conversations/${scope}/messages`)).json();
    expect(history.scope).toBe("plan-task:task-open");
    expect(history.messages.map((item: { role: string; content: string }) => [item.role, item.content])).toEqual([["user", "这件怎么拆"], ["assistant", "test reply"]]);
    expect((await f.call("GET", "/api/conversations/global/messages")).json().messages).toEqual([]);

    // 这一轮交给伙伴的页面对象：这件 Task 的名字、完成定义、标准和约定。
    const [run] = await f.t.sql("SELECT input_snapshot FROM agent_runs WHERE kind = 'conversation'");
    expect(run.input_snapshot.currentObject).toMatchObject({ cardId: "plan-task:task-open", kind: "plan-task", title: "Task：对话质量达标",
      objectRef: { type: "plan-task", id: "task-open", version: 1 },
      payload: { task: { name: "对话质量达标", doneDefinition: "对话质量过 75 分", criteria: ["有题库打分结果", "有新人上手录屏"] },
        agreement: { criteria: [{ index: 1, text: "有题库打分结果" }, { index: 2, text: "有新人上手录屏" }], exclusions: [] } } });

    // POST pipeline 拿到的就是这条对话。
    const pipeline = await f.call("POST", "/api/me/tasks/task-open/pipeline");
    expect(pipeline.statusCode).toBe(200);
    expect(pipeline.json().conversationId).toBe((await f.t.sql("SELECT conversation_id FROM conversation_messages LIMIT 1"))[0].conversation_id);
  }, 30_000);

  it("不是负责人：读历史、发一句 403；找不到 404", async () => {
    f = await boardFixture({}, { boardCloudAgents: false });
    expect((await f.call("GET", `/api/conversations/${encodeURIComponent("plan-task:task-theirs")}/messages`)).statusCode).toBe(403);
    expect((await say(`/api/conversations/${encodeURIComponent("plan-task:task-theirs")}/messages`, "进展？")).statusCode).toBe(403);
    expect((await f.call("GET", `/api/conversations/${encodeURIComponent("plan-task:task-nope")}/messages`)).statusCode).toBe(404);
    expect(await f.t.sql("SELECT id FROM conversations")).toEqual([]);
  }, 30_000);
});
