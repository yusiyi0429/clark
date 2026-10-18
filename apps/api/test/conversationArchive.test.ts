import { describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";
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

describe("一条连续的对话：没有新建对话与历史对话列表", () => {
  it("新建、历史列表、回看、切回的接口都不在；同一页面的每一轮都进同一条对话", async () => {
    const runtime = recordingRuntime();
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      await send(t, cookie, "词元云集的长期目标是什么？");
      expect((await post(t, cookie, "/api/conversations/global/new")).statusCode).toBe(404);
      const [row] = await t.sql("SELECT id FROM conversations WHERE scope = 'global'");
      expect((await get(t, cookie, "/api/conversations/global/archived")).statusCode).toBe(404);
      expect((await get(t, cookie, `/api/conversations/global/archived/${row.id as string}/messages`)).statusCode).toBe(404);
      expect((await post(t, cookie, `/api/conversations/global/archived/${row.id as string}/restore`)).statusCode).toBe(404);
      await send(t, cookie, "那本月目标呢");
      expect(runtime.inputs.at(-1)?.runtimeEntries).toEqual([{ turn: "词元云集的长期目标是什么？" }]);
      const history = (await get(t, cookie, "/api/conversations/global/messages")).json();
      expect(history).not.toHaveProperty("archivedCount");
      expect(history.messages).toHaveLength(4);
      expect(await t.sql("SELECT count(*)::int AS n FROM conversations WHERE scope = 'global'")).toEqual([{ n: 1 }]);
    } finally {
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
