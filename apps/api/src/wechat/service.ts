import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { TWechatConnection } from "@warmap/contracts";
import { decryptTokenSecret, encryptTokenSecret } from "../feishu/crypto.js";
import { toFeishuMarkdown } from "../feishuChat.js";
import { homeTurn } from "../homeTurn.js";
import { roleOf } from "../memberAccess.js";
import { listMyNotifications } from "../notifications.js";
import { logEvent } from "../observability.js";
import type { PeopleDirectory } from "../peopleDirectory.js";
import { ILINK_BASE_URL, IlinkError, LONG_POLL_MS, STALE_TOKEN, messageText, type Ilink, type IlinkBot, type IlinkMessage } from "./ilink.js";

/**
 * 微信 ClawBot = 本人的天枢在微信里：本人在天枢里扫码绑定，之后在微信里问天枢（以本人身份走首页对话，和飞书私聊一样），
 * 天枢的新通知合并成一条推到微信。本人开口之前 bot 发的消息微信照收不误、却不会送到（10/27 真机实测），所以连上后不主动发：
 * 弹窗请本人在微信里说声你好，第一次开口时先发自我介绍和天枢头像（请本人在 ClawBot 设置里把名字和头像换掉）再回答，通知也从那以后才推。
 * 每个绑定一条收消息的长轮询（同一个 bot 同一时间只能有一个在收）；推送每 30 秒扫一次通知。
 * 主动推送有条数上限（社区实测每个窗口约 10 条）：本人上次说话后最多推 PROACTIVE_LIMIT 次，推不出去也算到顶，本人一开口清零。
 */
const QR_REFRESH_LIMIT = 3;
const PROACTIVE_LIMIT = 9;
const SWEEP_EVERY_MS = 30_000;
const RETRY_MS = 5_000;
const TYPING_EVERY_MS = 5_000;
const MAX_INPUT_CHARS = 8_000;

/** 第一次连上时的招呼：称呼取名（三个字的名字去掉姓，和飞书一样），说清这里能做什么，最后告诉本人可以换名字和头像（头像图紧跟着发）。 */
function welcomeText(displayName: string | undefined): string {
  const name = displayName ? (displayName.length === 3 ? displayName.slice(1) : displayName) : "";
  return [
    `${name ? `${name}，` : ""}你好，我是你的天枢智能体。`,
    "",
    "· 想了解什么，直接在这里问，这里的我与天枢同步。",
    "· 公司的新通知，我会发到这里。",
    "",
    "可以点右上角的设置，把我的名字改成「天枢」，头像换成下面这张。",
  ].join("\n");
}

type Pending = { qrcode: string; qrcodeUrl: string; base: string; state: "waiting" | "scanned" | "expired" };
type Binding = {
  person_id: string; bot_id: string; wechat_user_id: string; base_url: string; key_version: number; ciphertext: string;
  updates_cursor: string; context_token: string | null; last_inbound_at: Date | null; proactive_count: number; notified_until: Date; status: "active" | "stale"; welcomed_at: Date | null;
};

export type WechatService = ReturnType<typeof createWechatService>;

export function createWechatService(deps: {
  app: FastifyInstance;
  pool: Pool;
  ilink: Ilink;
  env: { sessionSecret: string; publicOrigin: string; tokenKey: Buffer; tokenKeyVersion: number };
  peopleDirectory: PeopleDirectory;
  /** 自我介绍里发的头像图；默认读网页的应用图标。 */
  avatar?: () => Promise<Buffer>;
}) {
  const { app, pool, ilink, env, peopleDirectory } = deps;
  const q = pool.query.bind(pool);
  const pending = new Map<string, Pending>();
  const loops = new Map<string, AbortController>();
  const running = new Set<Promise<unknown>>();
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const track = <T>(work: Promise<T>) => {
    running.add(work);
    void work.finally(() => running.delete(work)).catch(() => undefined);
    return work;
  };
  const avatar = deps.avatar ?? (async () => {
    const response = await fetch(`${env.publicOrigin}/icons/icon-512.png`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`头像图 HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  });

  const load = async (personId: string) =>
    (await q("SELECT * FROM wechat_bindings WHERE person_id = $1", [personId])).rows[0] as Binding | undefined;
  const botOf = (row: Binding): IlinkBot => ({ baseUrl: row.base_url, token: decryptTokenSecret(env.tokenKey, row.person_id, row.ciphertext).accessToken });
  const personOf = (personId: string) => peopleDirectory.searchPeople(undefined).find((entry) => entry.personId === personId);
  const homePath = (personId: string) => (personOf(personId) && roleOf(personOf(personId)!) === "ceo" ? "/" : "/me");

  /** 本人第一次开口时的自我介绍：一段话加天枢头像。发出去才记 welcomed_at；头像发不出去不影响。 */
  async function welcome(row: Binding, bot: IlinkBot): Promise<boolean> {
    try {
      await ilink.sendText(bot, row.wechat_user_id, row.context_token, welcomeText(personOf(row.person_id)?.displayName));
    } catch (error) {
      logEvent({ event: "wechat.welcome_failed", personId: row.person_id, error: (error as Error).message });
      return false;
    }
    try { await ilink.sendImage(bot, row.wechat_user_id, row.context_token, await avatar()); } catch (error) {
      logEvent({ event: "wechat.avatar_failed", personId: row.person_id, error: (error as Error).message });
    }
    await q("UPDATE wechat_bindings SET welcomed_at = now(), updated_at = now() WHERE person_id = $1", [row.person_id]);
    return true;
  }

  /** 扫码确认：存绑定（同一个人重新扫码就换成新的 bot），停掉旧的收消息，开新的。 */
  async function confirmed(personId: string, status: { bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string; baseurl?: string }, base: string): Promise<void> {
    if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) throw new Error("扫码确认的回包缺字段");
    loops.get(personId)?.abort();
    const ciphertext = encryptTokenSecret(env.tokenKey, personId, { accessToken: status.bot_token });
    await q(
      `INSERT INTO wechat_bindings (person_id, bot_id, wechat_user_id, base_url, key_version, ciphertext)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (person_id) DO UPDATE SET bot_id = EXCLUDED.bot_id, wechat_user_id = EXCLUDED.wechat_user_id, base_url = EXCLUDED.base_url,
         key_version = EXCLUDED.key_version, ciphertext = EXCLUDED.ciphertext, updates_cursor = '', context_token = NULL, last_inbound_at = NULL,
         proactive_count = 0, notified_until = now(), status = 'active', welcomed_at = NULL, created_at = now(), updated_at = now()`,
      [personId, status.ilink_bot_id, status.ilink_user_id, status.baseurl || base, env.tokenKeyVersion, ciphertext],
    );
    const row = (await load(personId))!;
    const bot = botOf(row);
    await ilink.notifyStart(bot).catch((error: Error) => logEvent({ event: "wechat.notify_start_failed", personId, error: error.message }));
    logEvent({ event: "wechat.connected", personId, botId: row.bot_id });
    startLoop(personId);
    pending.delete(personId);
  }

  /** 后台盯着扫码状态：过期自动换一张（最多换 QR_REFRESH_LIMIT 次），确认后存绑定。 */
  async function watch(personId: string, entry: Pending): Promise<void> {
    let refreshes = 0;
    while (!closed && pending.get(personId) === entry) {
      const status = await ilink.qrStatus(entry.base, entry.qrcode).catch((error: Error) => {
        logEvent({ event: "wechat.qr_status_failed", personId, error: error.message });
        return { status: "wait" } as const;
      });
      if (pending.get(personId) !== entry) return;
      if (status.status === "scaned") entry.state = "scanned";
      if (status.status === "scaned_but_redirect" && status.redirect_host) entry.base = `https://${status.redirect_host}`;
      if (status.status === "confirmed") { await confirmed(personId, status, entry.base); return; }
      if (status.status === "expired" || status.status === "need_verifycode") {
        if (refreshes >= QR_REFRESH_LIMIT) { entry.state = "expired"; return; }
        refreshes += 1;
        const next = await ilink.qrcode();
        Object.assign(entry, { qrcode: next.qrcode, qrcodeUrl: next.qrcodeUrl, base: ILINK_BASE_URL, state: "waiting" });
      }
      if (status.status === "wait" || status.status === "scaned") await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  /** 推送：本人没读、上次推送之后才有的通知合并成一条。本人还没开过口、到顶或推不出去就不推，等本人开口。 */
  async function push(personId: string): Promise<void> {
    const row = await load(personId);
    if (!row || row.status !== "active" || !row.last_inbound_at || row.proactive_count >= PROACTIVE_LIMIT) return;
    const fresh = (await listMyNotifications(q, peopleDirectory, personId))
      .filter((note) => !note.readAt && new Date(note.createdAt).getTime() > row.notified_until.getTime());
    if (!fresh.length) return;
    const last = row.proactive_count + 1 >= PROACTIVE_LIMIT;
    const text = `天枢有 ${fresh.length} 条新通知：\n${fresh.map((note) => `· ${note.text}`).join("\n")}\n${env.publicOrigin}${homePath(personId)}`
      + (last ? "\n\n再有新通知，要等你回我一句才能发过来。" : "");
    const until = new Date(Math.max(...fresh.map((note) => new Date(note.createdAt).getTime())));
    try {
      await ilink.sendText(botOf(row), row.wechat_user_id, row.context_token, text);
      await q("UPDATE wechat_bindings SET proactive_count = proactive_count + 1, notified_until = $2, updated_at = now() WHERE person_id = $1", [personId, until]);
    } catch (error) {
      logEvent({ event: "wechat.push_failed", personId, error: (error as Error).message });
      if (error instanceof IlinkError && error.ret !== undefined) await q("UPDATE wechat_bindings SET proactive_count = $2, updated_at = now() WHERE person_id = $1", [personId, PROACTIVE_LIMIT]);
    }
  }

  /** 本人发来的一句：记下会话凭证（推送计数清零）→ 没打过招呼先补上 → 以本人身份在首页对话里问 → 回答发回去 → 补推攒着的通知。 */
  async function handle(personId: string, message: IlinkMessage): Promise<void> {
    let row = await load(personId);
    if (!row || message.message_type !== 1 || message.from_user_id !== row.wechat_user_id) return;
    await q("UPDATE wechat_bindings SET context_token = COALESCE($2, context_token), last_inbound_at = now(), proactive_count = 0, updated_at = now() WHERE person_id = $1",
      [personId, message.context_token ?? null]);
    row = (await load(personId))!;
    const bot = botOf(row);
    if (!row.welcomed_at) await welcome(row, bot);
    const person = personOf(personId);
    const reply = (text: string) => ilink.sendText(bot, row!.wechat_user_id, row!.context_token, text);
    if (!person) { await reply("你的天枢账号还没开通，开通后就能在这里直接问我。"); return; }
    const text = messageText(message);
    if (!text) { await reply("现在只看得懂文字和语音。"); return; }

    const ticket = await ilink.typingTicket(bot, row.wechat_user_id, row.context_token);
    const keepTyping = ticket ? setInterval(() => void ilink.typing(bot, row!.wechat_user_id, ticket, true), TYPING_EVERY_MS) : undefined;
    if (ticket) await ilink.typing(bot, row.wechat_user_id, ticket, true);
    let answer: string;
    try {
      const result = await homeTurn({ app, q, env }, { personId, role: roleOf(person) }, text.slice(0, MAX_INPUT_CHARS), { via: "wechat" });
      const open = `${env.publicOrigin}${homePath(personId)}`;
      if (result.kind === "inactive") answer = "你的天枢账号还没开通，开通后就能在这里直接问我。";
      else if (result.kind === "rejected") {
        logEvent({ event: "wechat.turn_rejected", personId, httpStatus: result.httpStatus, code: result.code });
        answer = `这句没能交给天枢，稍后再发一次，或者到天枢里问：${open}`;
      } else if (!result.runId) answer = "这次回答没有完成，稍后再发一次。";
      else {
        const body = toFeishuMarkdown(result.content ?? result.failure ?? "这次回答没有完成。", env.publicOrigin, (path) => `${env.publicOrigin}${path}`);
        const needsWeb = body.richDropped || body.truncated || (Array.isArray(result.cards) && result.cards.length > 0) || result.failure !== null;
        answer = `${body.content || "（没有文字回答）"}${needsWeb ? `\n\n在天枢查看：${open}` : ""}`;
      }
    } finally {
      if (keepTyping) clearInterval(keepTyping);
      if (ticket) await ilink.typing(bot, row.wechat_user_id, ticket, false);
    }
    await reply(answer);
    await push(personId);
  }

  /** 一个绑定的收消息循环：绑定失效（-14）标 stale 停下，等本人重新扫码。 */
  function startLoop(personId: string): void {
    if (closed) return;
    const controller = new AbortController();
    loops.set(personId, controller);
    track((async () => {
      let timeoutMs = LONG_POLL_MS;
      while (!controller.signal.aborted && !closed) {
        const row = await load(personId);
        if (!row || row.status !== "active") break;
        try {
          const resp = await ilink.updates(botOf(row), row.updates_cursor, timeoutMs, controller.signal);
          if (controller.signal.aborted) break;
          if (resp.ret === STALE_TOKEN || resp.errcode === STALE_TOKEN) {
            await q("UPDATE wechat_bindings SET status = 'stale', updated_at = now() WHERE person_id = $1", [personId]);
            logEvent({ event: "wechat.stale", personId });
            break;
          }
          if ((resp.ret ?? 0) !== 0 || (resp.errcode ?? 0) !== 0) throw new Error(`getupdates ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg ?? ""}`);
          if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) timeoutMs = resp.longpolling_timeout_ms;
          if (resp.get_updates_buf && resp.get_updates_buf !== row.updates_cursor) {
            await q("UPDATE wechat_bindings SET updates_cursor = $2, updated_at = now() WHERE person_id = $1", [personId, resp.get_updates_buf]);
          }
          for (const message of resp.msgs ?? []) {
            await handle(personId, message).catch((error: Error) => logEvent({ event: "wechat.handle_failed", personId, error: error.message }));
          }
        } catch (error) {
          logEvent({ event: "wechat.poll_failed", personId, error: (error as Error).message });
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        }
      }
      if (loops.get(personId) === controller) loops.delete(personId);
    })());
  }

  return {
    async status(personId: string): Promise<TWechatConnection> {
      const entry = pending.get(personId);
      if (entry) return { state: entry.state, qrcodeUrl: entry.qrcodeUrl };
      const row = await load(personId);
      if (!row) return { state: "none" };
      if (row.status === "stale") return { state: "stale" };
      return { state: "connected", welcomed: row.welcomed_at !== null, paused: row.proactive_count >= PROACTIVE_LIMIT };
    },

    /** 开始连接：要一张二维码，后台盯着扫码状态。正在等扫码时再点就沿用这一张。 */
    async connect(personId: string): Promise<TWechatConnection> {
      const current = pending.get(personId);
      if (current && current.state !== "expired") return { state: current.state, qrcodeUrl: current.qrcodeUrl };
      const qr = await ilink.qrcode();
      const entry: Pending = { qrcode: qr.qrcode, qrcodeUrl: qr.qrcodeUrl, base: ILINK_BASE_URL, state: "waiting" };
      pending.set(personId, entry);
      // 不计入 running：停机时清掉 pending，这个循环在当前这次长轮询返回后自己退出。
      void watch(personId, entry).catch((error: Error) => {
        logEvent({ event: "wechat.connect_failed", personId, error: error.message });
        if (pending.get(personId) === entry) entry.state = "expired";
      });
      return { state: "waiting", qrcodeUrl: qr.qrcodeUrl };
    },

    /** 断开：停收消息、告诉微信这个 bot 不用了、删绑定。 */
    async disconnect(personId: string): Promise<void> {
      pending.delete(personId);
      loops.get(personId)?.abort();
      const row = await load(personId);
      if (!row) return;
      if (row.status === "active") await ilink.notifyStop(botOf(row)).catch(() => undefined);
      await q("DELETE FROM wechat_bindings WHERE person_id = $1", [personId]);
      logEvent({ event: "wechat.disconnected", personId });
    },

    /** server.ts 启动后调：所有在用的绑定开始收消息，定时推送。 */
    async start(): Promise<void> {
      const rows = (await q("SELECT person_id FROM wechat_bindings WHERE status = 'active' AND key_version = $1", [env.tokenKeyVersion])).rows as { person_id: string }[];
      for (const row of rows) startLoop(row.person_id);
      sweepTimer = setInterval(() => {
        for (const personId of loops.keys()) track(push(personId).catch((error: Error) => logEvent({ event: "wechat.push_failed", personId, error: error.message })));
      }, SWEEP_EVERY_MS);
    },

    async close(): Promise<void> {
      closed = true;
      if (sweepTimer) clearInterval(sweepTimer);
      for (const controller of loops.values()) controller.abort();
      pending.clear();
      await Promise.allSettled([...running]);
    },

    /** 测试用：处理一条消息、推一次通知。 */
    handle, push,
  };
}
