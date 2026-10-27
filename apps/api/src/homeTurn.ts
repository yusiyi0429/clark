import type { FastifyInstance } from "fastify";
import { currentSessionVersion } from "./memberAccess.js";
import type { Query } from "./meetingStore.js";
import { SESSION_COOKIE, createSessionToken } from "./session.js";

/**
 * 从天枢以外的地方（飞书私聊、微信 ClawBot）以本人身份在首页对话里说一句（scope = global）：
 * 走同一个对话接口（同一条主对话、同一套权限和上下文），问与答存进对话记录并标上来源（via），网页打开着会自己读到。
 * 上一轮还在写（网页或别处问的）时隔几秒再试，最多等 10 分钟。
 */
const SCOPE = "global";
const BUSY_RETRY_MS = 5_000;
const BUSY_GIVE_UP_MS = 10 * 60_000;

export type HomeTurnVia = "feishu" | "wechat";
export type SseEvent = { type?: string; [key: string]: unknown };
export type HomeTurnResult =
  | { kind: "inactive" }
  | { kind: "rejected"; httpStatus: number; code?: string }
  | { kind: "done"; runId: string | null; content: string | null; cards: unknown; failure: string | null };

/** 按 SSE 的空行分块读事件（心跳注释行跳过）。 */
export async function* sseEvents(stream: AsyncIterable<Buffer | string>): AsyncGenerator<SseEvent> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      try { yield JSON.parse(data) as SseEvent; } catch { /* 坏块跳过 */ }
    }
  }
}

export async function homeTurn(
  deps: { app: FastifyInstance; q: Query; env: { sessionSecret: string; publicOrigin: string } },
  person: { personId: string; role: "ceo" | "member" },
  text: string,
  options: { via: HomeTurnVia; onStart?: () => Promise<void>; onBusy?: () => Promise<void>; onEvent?: (event: SseEvent) => Promise<void> },
): Promise<HomeTurnResult> {
  const { app, q, env } = deps;
  const version = await currentSessionVersion(q, person.personId);
  if (version === null) return { kind: "inactive" };
  const cookie = `${SESSION_COOKIE}=${createSessionToken(env.sessionSecret, 15 * 60, { pid: person.personId, v: version, view: person.role })}`;
  const markVia = (runId: string) => q(`UPDATE conversation_messages SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('via', $2::text) WHERE run_id = $1`,
    [runId, options.via]).catch(() => undefined);
  await options.onStart?.();
  const startedAt = Date.now();
  for (;;) {
    const response = await app.inject({
      method: "POST", url: `/api/conversations/${SCOPE}/messages`, payloadAsStream: true,
      headers: { cookie, origin: env.publicOrigin, accept: "text/event-stream", "content-type": "application/json" },
      payload: JSON.stringify({ message: text }),
    });
    const stream = response.stream();
    if (response.statusCode !== 200) {
      let body = "";
      for await (const chunk of stream) body += chunk.toString();
      const code = (() => { try { return (JSON.parse(body) as { code?: string }).code; } catch { return undefined; } })();
      if (code === "TURN_IN_PROGRESS" && Date.now() - startedAt < BUSY_GIVE_UP_MS) {
        await options.onBusy?.();
        await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
        continue;
      }
      return { kind: "rejected", httpStatus: response.statusCode, code };
    }
    let runId: string | null = null;
    let failure: string | null = null;
    for await (const event of sseEvents(stream)) {
      if (!runId && typeof event.runId === "string") { runId = event.runId; await markVia(runId); }
      if (event.type === "error") failure = typeof event.message === "string" ? event.message : "这次回答没有完成。";
      await options.onEvent?.(event);
    }
    if (!runId) return { kind: "done", runId: null, content: null, cards: null, failure };
    await markVia(runId);
    const saved = (await q(
      `SELECT m.content, r.input_snapshot -> 'cards' AS cards FROM conversation_messages m LEFT JOIN agent_runs r ON r.id = m.run_id
        WHERE m.run_id = $1 AND m.role = 'assistant' ORDER BY m.sequence DESC LIMIT 1`, [runId])).rows[0] as { content: string; cards: unknown } | undefined;
    return { kind: "done", runId, content: saved?.content ?? null, cards: saved?.cards ?? null, failure };
  }
}
