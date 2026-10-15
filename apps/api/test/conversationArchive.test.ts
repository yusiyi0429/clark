import { describe, expect, it } from "vitest";
import { TEST_CEO, createTestApp, type TestApp } from "./helpers.js";
import type { ConversationRuntime } from "../src/conversations.js";
import { CONVERSATION_IDLE_RESTART_MS } from "../src/conversations.js";
import type { TurnRecoverySummary } from "../src/conversationRecovery.js";

function parseSse(body: string): Record<string, unknown>[] {
  return body.trim().split("\n\n").flatMap((block) => {
    const line = block.split("\n").find((candidate) => candidate.startsWith("data: "));
    return line ? [JSON.parse(line.slice(6)) as Record<string, unknown>] : [];
  });
}

type RunInput = Parameters<ConversationRuntime["run"]>[0];

/** 假 runtime：记下每一轮的输入；回答「答：<问题>」，模型历史每轮追加一条，便于看出有没有接着上一段。 */
function recordingRuntime(options: { summary?: TurnRecoverySummary } = {}): ConversationRuntime & { inputs: RunInput[] } {
  const inputs: RunInput[] = [];
  return {
    inputs,
    async run(input) {
      inputs.push(input);
      const answer = `答：${input.message}`;
      input.emit({ type: "message", delta: answer });
      return { assistantMessage: answer, runtimeEntries: [...input.runtimeEntries, { turn: input.message }],
        ...(options.summary ? { recoverySummary: options.summary } : {}) };
    },
  };
}

const send = (t: TestApp, cookie: string, message: string, scope = "global") => t.app.inject({
  method: "POST", url: `/api/conversations/${scope}/messages`,
  headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message },
});
const post = (t: TestApp, cookie: string, url: string) => t.app.inject({ method: "POST", url, headers: { cookie, origin: t.publicOrigin } });
const get = (t: TestApp, cookie: string, url: string) => t.app.inject({ method: "GET", url, headers: { cookie } });

describe("新建对话：当前对话归档，能回看、能切回去继续", () => {
  it("新建以后界面是一条空白对话；旧消息不删，进历史列表，首问与条数都在", async () => {
    const runtime = recordingRuntime();
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      await send(t, cookie, "词元云集的长期目标是什么？");
      await send(t, cookie, "那本月目标呢");
      const created = await post(t, cookie, "/api/conversations/global/new");
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({ archived: true, conversationId: expect.any(String) });

      const history = (await get(t, cookie, "/api/conversations/global/messages")).json();
      expect(history).toMatchObject({ messages: [], archivedCount: 1 });

      // 下一轮进新对话，模型历史从空开始（不带旧对话的会话记录）。
      await send(t, cookie, "新话题");
      expect(runtime.inputs.at(-1)?.runtimeEntries).toEqual([]);
      expect(runtime.inputs.at(-1)?.recentMessages).toEqual([]);
      const current = (await get(t, cookie, "/api/conversations/global/messages")).json();
      expect(current.messages.map((message: { content: string }) => message.content)).toEqual(["新话题", "答：新话题"]);

      const rows = await t.sql("SELECT id, archived_at, deleted_at FROM conversations WHERE scope = 'global' ORDER BY created_at, id");
      expect(rows).toHaveLength(2);
      expect(rows[0].archived_at).toBeInstanceOf(Date);
      expect(rows[0].deleted_at).toBeNull();
      expect(rows[1].archived_at).toBeNull();
      expect(await t.sql("SELECT count(*)::int AS n FROM conversation_messages WHERE conversation_id = $1", [rows[0].id])).toEqual([{ n: 4 }]);

      const list = (await get(t, cookie, "/api/conversations/global/archived")).json();
      expect(list.conversations).toEqual([expect.objectContaining({ id: rows[0].id, firstQuestion: "词元云集的长期目标是什么？", messageCount: 4 })]);
      const replay = await get(t, cookie, `/api/conversations/global/archived/${rows[0].id as string}/messages`);
      expect(replay.statusCode).toBe(200);
      expect(replay.json().messages.map((message: { content: string }) => message.content))
        .toEqual(["词元云集的长期目标是什么？", "答：词元云集的长期目标是什么？", "那本月目标呢", "答：那本月目标呢"]);
    } finally {
      await t.close();
    }
  });

  it("当前对话还是空的时新建什么都不做；不是自己的、不是归档的、id 不对都 404", async () => {
    const t = await createTestApp({}, recordingRuntime());
    try {
      const cookie = await t.loginCookie();
      expect((await post(t, cookie, "/api/conversations/global/new")).json()).toEqual({ conversationId: null, archived: false });
      await send(t, cookie, "第一问");
      await post(t, cookie, "/api/conversations/global/new");
      const again = (await post(t, cookie, "/api/conversations/global/new")).json();
      expect(again.archived).toBe(false);
      expect(await t.sql("SELECT count(*)::int AS n FROM conversations WHERE scope = 'global'")).toEqual([{ n: 2 }]);

      const [archived] = await t.sql("SELECT id FROM conversations WHERE scope = 'global' AND archived_at IS NOT NULL");
      const [active] = await t.sql("SELECT id FROM conversations WHERE scope = 'global' AND archived_at IS NULL");
      expect((await get(t, cookie, `/api/conversations/global/archived/${active.id as string}/messages`)).statusCode).toBe(404);
      expect((await get(t, cookie, "/api/conversations/global/archived/11111111-1111-4111-8111-111111111111/messages")).statusCode).toBe(404);
      expect((await get(t, cookie, "/api/conversations/global/archived/not-a-uuid/messages")).statusCode).toBe(400);
      const member = await t.memberCookie();
      expect((await get(t, member, `/api/conversations/global/archived/${archived.id as string}/messages`)).statusCode).toBe(404);
      expect((await post(t, member, `/api/conversations/global/archived/${archived.id as string}/restore`)).statusCode).toBe(404);
      expect((await get(t, member, "/api/conversations/global/archived")).json()).toEqual({ conversations: [] });
      expect((await t.app.inject({ method: "POST", url: "/api/conversations/global/new", headers: { origin: t.publicOrigin } })).statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it("切回一段历史对话：它成为当前对话、接着它的模型历史；刚才那段归档", async () => {
    const runtime = recordingRuntime();
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      await send(t, cookie, "旧话题");
      await post(t, cookie, "/api/conversations/global/new");
      await send(t, cookie, "新话题");
      const [old] = await t.sql("SELECT id FROM conversations WHERE scope = 'global' AND archived_at IS NOT NULL");
      const restored = await post(t, cookie, `/api/conversations/global/archived/${old.id as string}/restore`);
      expect(restored.json()).toEqual({ conversationId: old.id, archived: true });

      const history = (await get(t, cookie, "/api/conversations/global/messages")).json();
      expect(history.messages.map((message: { content: string }) => message.content)).toEqual(["旧话题", "答：旧话题"]);
      expect(history.archivedCount).toBe(1);
      await send(t, cookie, "接着旧话题");
      expect(runtime.inputs.at(-1)?.runtimeEntries).toEqual([{ turn: "旧话题" }]);
      expect((await get(t, cookie, "/api/conversations/global/archived")).json().conversations)
        .toEqual([expect.objectContaining({ firstQuestion: "新话题", messageCount: 2 })]);
    } finally {
      await t.close();
    }
  });

  it("一轮回答还没结束时不新建、不切换（409）", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const t = await createTestApp({}, {
      async run(input) {
        started();
        await gate;
        input.emit({ type: "message", delta: "好" });
        return { assistantMessage: "好", runtimeEntries: [] };
      },
    });
    try {
      const cookie = await t.loginCookie();
      const turn = send(t, cookie, "慢问题");
      await running;
      const busy = await post(t, cookie, "/api/conversations/global/new");
      expect(busy.statusCode).toBe(409);
      expect(busy.json()).toMatchObject({ code: "TURN_IN_PROGRESS" });
      release();
      await turn;
      expect((await post(t, cookie, "/api/conversations/global/new")).json()).toMatchObject({ archived: true });
    } finally {
      release();
      await t.close();
    }
  });
});

describe("闲置重开：闲置超过阈值的下一轮，模型侧只带摘要重新开始", () => {
  it("阈值内照常接着；超过阈值告诉运行时 idleRestart，并记进运行记录；重开之后紧接着的一轮照常接着", async () => {
    const runtime = recordingRuntime();
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      await send(t, cookie, "第一问");
      await send(t, cookie, "第二问");
      expect(runtime.inputs.at(-1)?.idleRestart).toBeUndefined();

      await t.sql("UPDATE conversation_messages SET created_at = created_at - make_interval(secs => $1)", [CONVERSATION_IDLE_RESTART_MS / 1000 + 60]);
      await send(t, cookie, "隔天再问");
      const input = runtime.inputs.at(-1)!;
      expect(input.idleRestart).toBe(true);
      // 界面上的历史不变；运行时仍拿到完整的旧记录，由它决定只带摘要。
      expect(input.runtimeEntries).toEqual([{ turn: "第一问" }, { turn: "第二问" }]);
      const history = (await get(t, cookie, "/api/conversations/global/messages")).json();
      expect(history.messages).toHaveLength(6);
      const runs = await t.sql("SELECT input_snapshot FROM agent_runs WHERE kind = 'conversation' ORDER BY started_at");
      expect((runs.at(-1)?.input_snapshot as { idleRestart?: boolean }).idleRestart).toBe(true);

      await send(t, cookie, "紧接着再问");
      expect(runtime.inputs.at(-1)?.idleRestart).toBeUndefined();
    } finally {
      await t.close();
    }
  });
});

describe("备用模型标注：这一轮走过恢复，回答末尾一行说明随消息存下", () => {
  it("用了备用模型：回答带说明（不写模型名），done 事件带同一行，运行记录记下原模型、备用模型、原因与次数", async () => {
    const summary: TurnRecoverySummary = { originalModel: "claude-sonnet-5-5", fallbackModel: "gpt-5.6-sol", reasons: ["network"],
      actions: { retry: 1, fallback: 1 }, retries: 2 };
    const t = await createTestApp({}, recordingRuntime({ summary }));
    try {
      const cookie = await t.loginCookie();
      const response = await send(t, cookie, "问一个");
      const done = parseSse(response.body).find((event) => event.type === "done");
      expect(done).toMatchObject({ status: "completed", recoveryNote: { text: "本轮因上游异常改由备用模型完成" } });
      const note = (done as { recoveryNote: { text: string; detail: string } }).recoveryNote;
      expect(note.detail).toContain("和模型服务的网络连接中断了");
      expect(`${note.text}${note.detail}`).not.toMatch(/claude|gpt|sonnet|[A-Za-z]{6,}/i);

      const history = (await get(t, cookie, "/api/conversations/global/messages")).json();
      expect(history.messages[1]).toMatchObject({ role: "assistant", recoveryNote: note });
      expect(history.messages[0].recoveryNote).toBeUndefined();

      const [run] = await t.sql("SELECT input_snapshot FROM agent_runs WHERE kind = 'conversation'");
      expect((run.input_snapshot as { route: Record<string, unknown> }).route.recovery).toEqual({
        originalModel: "claude-sonnet-5-5", fallbackModel: "gpt-5.6-sol", reasons: ["network"], actions: { retry: 1, fallback: 1 }, retries: 2,
      });
    } finally {
      await t.close();
    }
  });

  it("一路顺利的回答没有说明，运行记录也没有 recovery", async () => {
    const t = await createTestApp({}, recordingRuntime());
    try {
      const cookie = await t.loginCookie();
      const response = await send(t, cookie, "问一个");
      expect(parseSse(response.body).find((event) => event.type === "done")).not.toHaveProperty("recoveryNote");
      const history = (await get(t, cookie, "/api/conversations/global/messages")).json();
      expect(history.messages[1].recoveryNote).toBeUndefined();
      const [run] = await t.sql("SELECT input_snapshot FROM agent_runs WHERE kind = 'conversation'");
      expect((run.input_snapshot as { route: Record<string, unknown> }).route).not.toHaveProperty("recovery");
    } finally {
      await t.close();
    }
  });
});
