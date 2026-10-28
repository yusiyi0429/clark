import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { FeishuClient } from "./feishu/client.js";
import { feishuDeepLink } from "./feishu/messages.js";
import { withoutIssueSuggestBlocks } from "./issueDrafts.js";
import { homeTurn } from "./homeTurn.js";
import { roleOf } from "./memberAccess.js";
import { logEvent } from "./observability.js";
import type { PeopleDirectory } from "./peopleDirectory.js";

/**
 * 飞书私聊天枢机器人 = 在本人首页的对话里说一句（「我的对话」，scope = global）：
 * 收到私聊（im.message.receive_v1，chat_type = p2p，要 im:message.p2p_msg:readonly）后，按飞书身份找到本人，
 * 以本人身份走同一个对话接口（同一条主对话、同一套权限和上下文），问与答都存进对话记录并标「飞书」，网页打开着会自己读到。
 * 回答前先回一张「正在想」的小卡，每几秒换成当前在查什么、用了多久；写完小卡缩成「用时 N 秒」，回答另发一条普通消息（富文本，飞书默认字号）。
 * 飞书里点不了天枢的卡和图表：回答里有这些时末尾附「在天枢查看」链接。
 */
export const FEISHU_CHAT_EVENT = "im.message.receive_v1";
const PROGRESS_EVERY_MS = 5_000;
const MAX_ANSWER_CHARS = 3_500;
/** 网页里画成卡或图的块：飞书里不显示，改附「在天枢查看」。 */
const RICH_FENCE = /\n*```(?:options|metric-compare|timeline|roadmap)[ \t]*\n[\s\S]*?\n```[ \t]*/g;

type Card = object;

/**
 * 回答转成飞书富文本 md 段落（认加粗、斜体、链接、列表、引用，不认标题）：标题变加粗，站内链接换成免登深链接（微信里换成普通网址），超长截断。
 * 出处标记（网页里画成小标签）去掉，只留书名号的资料名；个人记忆标记也去掉。
 */
export function toFeishuMarkdown(text: string, publicOrigin: string, linkFor: (path: string) => string = (path) => feishuDeepLink(publicOrigin, path)):
  { content: string; richDropped: boolean; truncated: boolean } {
  let body = withoutIssueSuggestBlocks(text);
  const richDropped = RICH_FENCE.test(body);
  body = body.replace(RICH_FENCE, "")
    .replace(/([ \t]*)\[([^\]]*)\]\(cite:[^)]*\)/g, (_match, space: string, label: string) => (label.startsWith("《") ? `${space}${label}` : ""))
    .replace(/\]\((\/[^)\s]*)\)/g, (_match, path: string) => `](${linkFor(path)})`)
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+(.*)$/, "**$1**").replace(/[ 	]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const truncated = body.length > MAX_ANSWER_CHARS;
  if (truncated) body = `${body.slice(0, MAX_ANSWER_CHARS).replace(/\n[^\n]*$/, "")}\n…`;
  return { content: body, richDropped, truncated };
}

/** 进度小卡：一行灰字，能原地改。 */
function card(markdown: string): Card {
  return { config: { wide_screen_mode: true, update_multi: true }, elements: [{ tag: "markdown", content: markdown }] };
}

const grey = (text: string) => `<font color='grey'>${text}</font>`;

/** 普通富文本消息（飞书默认字号）：一段 md。 */
const post = (markdown: string) => ({ zh_cn: { content: [[{ tag: "md", text: markdown }]] } });

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

  async function send(openId: string, msgType: "interactive" | "post", content: object): Promise<string | null> {
    try { return (await client.sendMessage("open_id", openId, msgType, content)).messageId || null; } catch (error) {
      logEvent({ event: "feishu_chat.send_failed", error: (error as Error).message });
      return null;
    }
  }

  /** 改进度小卡；改不了（没开 im:message:update、超时）就不改，不另发。 */
  async function update(messageId: string | null, content: Card): Promise<void> {
    if (!messageId) return;
    await client.updateCard(messageId, content).catch((error: Error) => logEvent({ event: "feishu_chat.update_failed", error: error.message }));
  }

  /** 收尾：进度小卡缩成一行小字，回答（或没答成的说明）另发一条普通消息。 */
  async function finish(openId: string, progress: string | null, startedAt: number, markdown: string, link?: { label: string; url: string }): Promise<void> {
    await update(progress, card(grey(`用时 ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))} 秒`)));
    await send(openId, "post", post(link ? `${markdown}

[${link.label}](${link.url})` : markdown));
  }

  /** 以本人身份说这一句；上一轮还在写（网页或飞书里的）时等它写完再说。 */
  async function turn(person: { personId: string; role: "ceo" | "member" }, openId: string, text: string): Promise<void> {
    const home = person.role === "ceo" ? "/" : "/me";
    const open = { label: "在天枢查看", url: feishuDeepLink(env.publicOrigin, home) };
    const startedAt = Date.now();
    let progress: string | null = null;
    let step: string | null = null;
    let lastShown = Date.now();
    const result = await homeTurn({ app, q, env }, person, text, {
      via: "feishu",
      onStart: async () => { progress = await send(openId, "interactive", card(grey("正在想…"))); },
      onBusy: () => update(progress, card(grey("上一个问题还在回答，答完马上接着答这个。"))),
      onEvent: async (event) => {
        if (event.type === "step" && event.status === "active" && typeof event.label === "string") step = event.label;
        if (Date.now() - lastShown >= PROGRESS_EVERY_MS) {
          lastShown = Date.now();
          const seconds = Math.round((Date.now() - startedAt) / 1000);
          await update(progress, card(grey(`${step ? `正在${step}` : "正在想"}… ${seconds} 秒`)));
        }
      },
    });
    if (result.kind === "inactive") {
      await send(openId, "post", post("你的天枢账号还没开通，开通后就能在这里直接问我。"));
      return;
    }
    if (result.kind === "rejected") {
      logEvent({ event: "feishu_chat.turn_rejected", personId: person.personId, httpStatus: result.httpStatus, code: result.code });
      await finish(openId, progress, startedAt, "这句没能交给天枢，稍后再发一次，或者到天枢里问。", open);
      return;
    }
    if (!result.runId) { await finish(openId, progress, startedAt, "这次回答没有完成，稍后再发一次。", open); return; }
    const answer = toFeishuMarkdown(result.content ?? result.failure ?? "这次回答没有完成。", env.publicOrigin);
    const needsWeb = answer.richDropped || answer.truncated || (Array.isArray(result.cards) && result.cards.length > 0) || result.failure !== null;
    await finish(openId, progress, startedAt, answer.content || "（没有文字回答）", needsWeb ? open : undefined);
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
      await send(openId, "post", post(`你的飞书还没和天枢账号关联。在飞书里打开天枢登录一次就关联好了，之后就能在这里直接问我。

[打开天枢](${feishuDeepLink(env.publicOrigin, "/")})`));
      return;
    }
    const text = messageText(message.message_type, message.content);
    if (!text) {
      await send(openId, "post", post("现在只看得懂文字消息，把问题打成字发给我就行。"));
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
