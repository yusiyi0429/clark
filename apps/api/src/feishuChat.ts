import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { FeishuClient } from "./feishu/client.js";
import { feishuDeepLink } from "./feishu/messages.js";
import { withoutIssueSuggestBlocks } from "./issueDrafts.js";
import { currentSessionVersion, roleOf } from "./memberAccess.js";
import { logEvent } from "./observability.js";
import type { PeopleDirectory } from "./peopleDirectory.js";
import { SESSION_COOKIE, createSessionToken } from "./session.js";

/**
 * 飞书私聊天枢机器人 = 在本人首页的对话里说一句（「我的对话」，scope = global）：
 * 收到私聊（im.message.receive_v1，chat_type = p2p，要 im:message.p2p_msg:readonly）后，按飞书身份找到本人，
 * 以本人身份走同一个对话接口（同一条主对话、同一套权限和上下文），问与答都存进对话记录并标「飞书」，网页打开着会自己读到。
 * 回答前先回一张「正在查」的卡，每几秒换成当前在查什么、用了多久；写完原地换成回答（改不了卡时另发一条）。
 * 飞书里点不了天枢的卡和图表：回答里有这些时附「在天枢查看」。
 */
export const FEISHU_CHAT_EVENT = "im.message.receive_v1";
const SCOPE = "global";
const PROGRESS_EVERY_MS = 5_000;
const BUSY_RETRY_MS = 5_000;
const BUSY_GIVE_UP_MS = 10 * 60_000;
const MAX_ANSWER_CHARS = 3_500;
/** 网页里画成卡或图的块：飞书里不显示，改附「在天枢查看」。 */
const RICH_FENCE = /\n*```(?:options|metric-compare|timeline|roadmap)[ \t]*\n[\s\S]*?\n```[ \t]*/g;

type Card = object;

/** 回答转成飞书卡片里的 Markdown（1.0 卡片只认加粗、斜体、删除线、链接）：标题变加粗，列表用圆点，站内链接换成免登深链接，超长截断。 */
export function toFeishuMarkdown(text: string, publicOrigin: string): { content: string; richDropped: boolean; truncated: boolean } {
  let body = withoutIssueSuggestBlocks(text);
  const richDropped = RICH_FENCE.test(body);
  body = body.replace(RICH_FENCE, "")
    .replace(/\[([^\]]*)\]\(cite:[^)]*\)/g, (_match, label: string) => (label === "记忆" ? "" : label))
    .replace(/\]\((\/[^)\s]*)\)/g, (_match, path: string) => `](${feishuDeepLink(publicOrigin, path)})`)
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+(.*)$/, "**$1**").replace(/^(\s*)[-*+]\s+/, "$1• "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const truncated = body.length > MAX_ANSWER_CHARS;
  if (truncated) body = `${body.slice(0, MAX_ANSWER_CHARS).replace(/\n[^\n]*$/, "")}\n…`;
  return { content: body, richDropped, truncated };
}

function card(markdown: string, link?: { label: string; url: string }): Card {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    elements: [
      { tag: "markdown", content: markdown },
      ...(link ? [{ tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: link.label }, type: "default", url: link.url }] }] : []),
    ],
  };
}

const grey = (text: string) => `<font color='grey'>${text}</font>`;

/** 私聊消息的文字：文本消息取 text，富文本把各段文字拼起来；其他类型（图片、文件、语音）返回 null。 */
export function messageText(messageType: string | undefined, content: string | undefined): string | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (messageType === "text") return typeof parsed.text === "string" ? parsed.text.trim() || null : null;
    if (messageType === "post") {
      const post = (Array.isArray(parsed.content) ? parsed : Object.values(parsed).find((value) => value && typeof value === "object")) as { title?: unknown; content?: unknown } | undefined;
      const lines = Array.isArray(post?.content) ? post.content as { tag?: string; text?: string }[][] : [];
      const text = [typeof post?.title === "string" ? post.title : "", ...lines.map((line) => line.map((node) => (typeof node.text === "string" ? node.text : "")).join(""))]
        .filter(Boolean).join("\n").trim();
      return text || null;
    }
  } catch { /* 不是 JSON：当作不认识的消息 */ }
  return null;
}

type SseEvent = { type?: string; [key: string]: unknown };

/** 按 SSE 的空行分块读事件（心跳注释行跳过）。 */
async function* sseEvents(stream: AsyncIterable<Buffer | string>): AsyncGenerator<SseEvent> {
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

export type FeishuChat = ReturnType<typeof createFeishuChat>;

export function createFeishuChat(deps: {
  app: FastifyInstance;
  pool: Pool;
  client: Pick<FeishuClient, "sendMessage" | "updateCard">;
  env: { sessionSecret: string; publicOrigin: string };
  peopleDirectory: PeopleDirectory;
}) {
  const { app, pool, client, env } = deps;
  const q = pool.query.bind(pool);
  const running = new Set<Promise<void>>();

  /** 回一张卡；有 messageId 时先试着原地改，改不了（没开 im:message:update、超时）就另发一条。 */
  async function show(openId: string, existing: string | null, content: Card): Promise<string | null> {
    if (existing) {
      try { await client.updateCard(existing, content); return existing; } catch (error) {
        logEvent({ event: "feishu_chat.update_failed", error: (error as Error).message });
      }
    }
    try { return (await client.sendMessage("open_id", openId, "interactive", content)).messageId || null; } catch (error) {
      logEvent({ event: "feishu_chat.send_failed", error: (error as Error).message });
      return null;
    }
  }

  async function markVia(runId: string): Promise<void> {
    await q(`UPDATE conversation_messages SET meta = COALESCE(meta, '{}'::jsonb) || '{"via":"feishu"}'::jsonb WHERE run_id = $1`, [runId]).catch(() => undefined);
  }

  /** 以本人身份说这一句；上一轮还在写（网页或飞书里的）时等它写完再说。 */
  async function turn(person: { personId: string; role: "ceo" | "member" }, openId: string, text: string): Promise<void> {
    const version = await currentSessionVersion(q, person.personId);
    const home = person.role === "ceo" ? "/" : "/me";
    const open = { label: "在天枢查看", url: feishuDeepLink(env.publicOrigin, home) };
    if (version === null) {
      await show(openId, null, card("你的天枢账号还没开通，开通后就能在这里直接问我。"));
      return;
    }
    const cookie = `${SESSION_COOKIE}=${createSessionToken(env.sessionSecret, 15 * 60, { pid: person.personId, v: version, view: person.role })}`;
    const startedAt = Date.now();
    let messageId = await show(openId, null, card(grey("正在想…")));
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
          messageId = await show(openId, messageId, card(grey("上一个问题还在回答，答完马上接着答这个。")));
          await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
          continue;
        }
        logEvent({ event: "feishu_chat.turn_rejected", personId: person.personId, httpStatus: response.statusCode, code });
        await show(openId, messageId, card("这句没能交给天枢，稍后再发一次，或者到天枢里问。", open));
        return;
      }
      let runId: string | undefined;
      let step: string | null = null;
      let lastShown = Date.now();
      let failure: string | null = null;
      for await (const event of sseEvents(stream)) {
        if (!runId && typeof event.runId === "string") { runId = event.runId; await markVia(runId); }
        if (event.type === "step" && event.status === "active" && typeof event.label === "string") step = event.label;
        if (event.type === "error") failure = typeof event.message === "string" ? event.message : "这次回答没有完成。";
        if (Date.now() - lastShown >= PROGRESS_EVERY_MS) {
          lastShown = Date.now();
          const seconds = Math.round((Date.now() - startedAt) / 1000);
          messageId = await show(openId, messageId, card(grey(`${step ? `正在${step}` : "正在想"}… ${seconds} 秒`)));
        }
      }
      if (!runId) { await show(openId, messageId, card("这次回答没有完成，稍后再发一次。", open)); return; }
      await markVia(runId);
      const saved = (await q(
        `SELECT m.content, r.input_snapshot -> 'cards' AS cards FROM conversation_messages m LEFT JOIN agent_runs r ON r.id = m.run_id
          WHERE m.run_id = $1 AND m.role = 'assistant' ORDER BY m.sequence DESC LIMIT 1`, [runId])).rows[0] as { content: string; cards: unknown } | undefined;
      const answer = toFeishuMarkdown(saved?.content ?? failure ?? "这次回答没有完成。", env.publicOrigin);
      const needsWeb = answer.richDropped || answer.truncated || (Array.isArray(saved?.cards) && saved.cards.length > 0) || failure !== null;
      await show(openId, messageId, card(answer.content || "（没有文字回答）", needsWeb ? open : undefined));
      return;
    }
  }

  /**
   * 私聊消息：只认人发来的单聊；飞书身份没关联天枢的人回一句怎么关联。这一轮在后台跑（可能要一两分钟），
   * 不占事件任务（后台任务是一条一条跑的）；服务停机时这一轮按「服务更新」存档，飞书里收到对应说明。
   */
  async function onMessage(payload: Record<string, unknown>): Promise<void> {
    const message = payload.message as { chat_type?: string; message_type?: string; content?: string } | undefined;
    const sender = payload.sender as { sender_type?: string; sender_id?: { open_id?: string } } | undefined;
    if (message?.chat_type !== "p2p" || (sender?.sender_type && sender.sender_type !== "user")) return;
    const openId = sender?.sender_id?.open_id;
    if (!openId) return;
    const personId = (await q("SELECT person_id FROM feishu_identities WHERE open_id = $1", [openId])).rows[0]?.person_id as string | undefined;
    const person = personId ? deps.peopleDirectory.searchPeople(undefined).find((entry) => entry.personId === personId) : undefined;
    if (!person) {
      await show(openId, null, card("你的飞书还没和天枢账号关联。在飞书里打开天枢登录一次就关联好了，之后就能在这里直接问我。",
        { label: "打开天枢", url: feishuDeepLink(env.publicOrigin, "/") }));
      return;
    }
    const text = messageText(message.message_type, message.content);
    if (!text) {
      await show(openId, null, card("现在只看得懂文字消息，把问题打成字发给我就行。"));
      return;
    }
    const work = turn({ personId: person.personId, role: roleOf(person) }, openId, text.slice(0, 8_000))
      .catch((error) => logEvent({ event: "feishu_chat.turn_failed", personId: person.personId, error: (error as Error).message }));
    running.add(work);
    void work.finally(() => running.delete(work));
  }

  return {
    onMessage,
    events: { [FEISHU_CHAT_EVENT]: onMessage },
    /** 测试与停机：等后台这几轮都结束。 */
    async idle(): Promise<void> { await Promise.all([...running]); },
  };
}
