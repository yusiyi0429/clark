import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationRuntime } from "../src/conversations.js";
import { IlinkError, type Ilink, type IlinkMessage, type QrStatus } from "../src/wechat/ilink.js";
import { createTestApp, TEST_CEO, type TestApp } from "./helpers.js";

type Sent = { to: string; context: string | null; text?: string; image?: number };

/** iLink 替身：扫码状态按 statuses 依次给出；发出去的文字与图片记在 sent；failSend 时发送报 ret=-2。 */
function fakeIlink(statuses: QrStatus[]) {
  const sent: Sent[] = [];
  const state = { failSend: false, qrcodes: 0 };
  const ilink: Ilink = {
    async qrcode() { state.qrcodes += 1; return { qrcode: `qr${state.qrcodes}`, qrcodeUrl: `https://liteapp.weixin.qq.com/q/${state.qrcodes}` }; },
    async qrStatus() { return statuses.shift() ?? { status: "wait" }; },
    async notifyStart() {},
    async notifyStop() {},
    async updates(_bot, cursor, _timeout, signal) {
      await new Promise((resolve) => { const timer = setTimeout(resolve, 50); signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(undefined); }); });
      return { ret: 0, msgs: [], get_updates_buf: cursor };
    },
    async typingTicket() { return null; },
    async typing() {},
    async sendText(_bot, to, context, text) {
      if (state.failSend) throw new IlinkError("sendmessage ret=-2", -2);
      sent.push({ to, context, text });
    },
    async sendImage(_bot, to, context, image) { sent.push({ to, context, image: image.length }); },
  };
  return { ilink, sent, state };
}

const answering = (answer: string): ConversationRuntime => ({
  async run(input) {
    input.emit({ type: "message", delta: answer });
    return { assistantMessage: answer, runtimeEntries: [] };
  },
});

const fromOwner = (text: string, extra: Partial<IlinkMessage> = {}): IlinkMessage =>
  ({ message_type: 1, from_user_id: "wx_owner@im.wechat", context_token: "ctx-1", item_list: [{ type: 1, text_item: { text } }], ...extra });

let t: TestApp | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

const CONFIRMED: QrStatus = { status: "confirmed", bot_token: "bot-secret", ilink_bot_id: "b1@im.bot", ilink_user_id: "wx_owner@im.wechat", baseurl: "https://ilink.example" };

async function start(statuses: QrStatus[], runtime: ConversationRuntime = answering("好的")) {
  const fake = fakeIlink(statuses);
  t = await createTestApp({ feishu: { appId: "cli_test", appSecret: "test-secret", tokenKey: randomBytes(32), tokenKeyVersion: 1 }, wechatEnabled: true }, runtime, { wechatIlink: fake.ilink, wechatAvatar: async () => Buffer.from("png") });
  const cookie = await t.loginCookie();
  return { ...fake, cookie };
}

async function connect(cookie: string) {
  const origin = t!.publicOrigin;
  const started = await t!.app.inject({ method: "POST", url: "/api/me/wechat/connect", headers: { cookie, origin } });
  expect(started.json()).toEqual({ state: "waiting", qrcodeUrl: "https://liteapp.weixin.qq.com/q/1" });
  for (let i = 0; i < 100; i += 1) {
    const status = (await t!.app.inject({ method: "GET", url: "/api/me/wechat", headers: { cookie } })).json();
    if (status.state === "connected") return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("没连上");
}

describe("微信 ClawBot", () => {
  it("扫码确认后存加密的绑定、开始收消息；本人开口前不主动发，第一次开口时先发自我介绍和天枢头像再回答", async () => {
    const { sent, cookie } = await start([{ status: "scaned" }, CONFIRMED], answering("好的"));
    expect(await connect(cookie)).toEqual({ state: "connected", welcomed: false, paused: false });
    const [row] = await t!.sql("SELECT bot_id, wechat_user_id, base_url, ciphertext FROM wechat_bindings WHERE person_id = $1", [TEST_CEO.personId]);
    expect(row).toMatchObject({ bot_id: "b1@im.bot", wechat_user_id: "wx_owner@im.wechat", base_url: "https://ilink.example" });
    expect(row.ciphertext).not.toContain("bot-secret");
    expect(sent).toEqual([]);

    await t!.app.wechat!.handle(TEST_CEO.personId, fromOwner("你好"));
    expect(sent[0]).toMatchObject({ to: "wx_owner@im.wechat", context: "ctx-1" });
    expect(sent[0].text).toMatch(/^试甲，你好，我是你的天枢智能体。\n\n· 想了解什么/);
    expect(sent[0].text).toContain("头像换成下面这张");
    expect(sent[1].image).toBeGreaterThan(0);
    expect(sent[2].text).toBe("好的");
    await t!.app.wechat!.handle(TEST_CEO.personId, fromOwner("再问一句"));
    expect(sent.slice(3).map((item) => item.text)).toEqual(["好的"]);
    expect((await t!.app.inject({ method: "GET", url: "/api/me/wechat", headers: { cookie } })).json()).toEqual({ state: "connected", welcomed: true, paused: false });
  });

  it("本人在微信里问：以本人身份走首页对话，回答发回微信，问答标微信；别人发来的不理", async () => {
    const { sent, cookie } = await start([CONFIRMED], answering("## 本周\n见[会议](/meetings/m1)"));
    await connect(cookie);
    await t!.app.wechat!.handle(TEST_CEO.personId, fromOwner("这周怎么样"));
    sent.splice(0, 2);
    await t!.app.wechat!.handle(TEST_CEO.personId, fromOwner("我是别人", { from_user_id: "wx_stranger@im.wechat" }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "wx_owner@im.wechat", context: "ctx-1" });
    expect(sent[0].text).toBe(`**本周**\n见[会议](${t!.publicOrigin}/meetings/m1)`);
    const history = (await t!.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie } })).json().messages as { role: string; via?: string }[];
    expect(history.map((message) => [message.role, message.via])).toEqual([["user", "wechat"], ["assistant", "wechat"]]);
  });

  it("本人开口前不推；之后新通知合并成一条推送；推不出去就停，等本人开口后补推", async () => {
    const { sent, state, cookie } = await start([CONFIRMED]);
    await connect(cookie);
    const note = () => t!.sql("INSERT INTO notifications (id, person_id, kind, object_type, object_id) VALUES ($1, $2, 'task_returned', 'task', $3)",
      [randomUUID(), TEST_CEO.personId, randomUUID()]);
    await note();
    await t!.app.wechat!.push(TEST_CEO.personId);
    expect(sent).toEqual([]);
    await t!.app.wechat!.handle(TEST_CEO.personId, fromOwner("开始吧"));
    expect(sent.at(-1)?.text).toContain("天枢有 1 条新通知");
    sent.length = 0;
    await note();
    await note();
    await t!.app.wechat!.push(TEST_CEO.personId);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("天枢有 2 条新通知");
    await t!.app.wechat!.push(TEST_CEO.personId);
    expect(sent).toHaveLength(1);

    state.failSend = true;
    await note();
    await t!.app.wechat!.push(TEST_CEO.personId);
    expect((await t!.app.inject({ method: "GET", url: "/api/me/wechat", headers: { cookie } })).json()).toMatchObject({ paused: true });

    state.failSend = false;
    await t!.app.wechat!.handle(TEST_CEO.personId, fromOwner("在吗"));
    expect(sent.map((item) => item.text)).toEqual([expect.stringContaining("2 条新通知"), "好的", expect.stringContaining("天枢有 1 条新通知")]);
  });

  it("断开：删掉绑定，状态回到没连", async () => {
    const { cookie } = await start([CONFIRMED]);
    await connect(cookie);
    const removed = await t!.app.inject({ method: "DELETE", url: "/api/me/wechat", headers: { cookie, origin: t!.publicOrigin } });
    expect(removed.statusCode).toBe(204);
    expect((await t!.app.inject({ method: "GET", url: "/api/me/wechat", headers: { cookie } })).json()).toEqual({ state: "none" });
  });
});
