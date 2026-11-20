import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TChatView, TWaitingItem } from "@warmap/contracts";
import { HANDOFF_CATEGORIES, type AnswerCategory, type AnswerInput, type ColleagueAnswerAgent, type PickInput } from "../src/colleagueAnswerAgent.js";
import { CHAT_ANSWER_JOB } from "../src/colleagueChats.js";
import { pushNotice } from "../src/homePush.js";
import { boardFixture, THIRD } from "./boardFixture.js";
import { TEST_CEO, TEST_MEMBER } from "./helpers.js";

/** 甲 CEO、乙问的人、丙被问的人（DRI）、丁参与人（不被覆盖）。 */
const 甲 = TEST_CEO.personId;
const 乙 = TEST_MEMBER.personId;
const 丙 = THIRD.personId;
const 丁 = "person-fixture-004";
const C = "/api/me/colleague-chats";
let seedPath: Promise<string> | undefined;
const peopleSeed = () => seedPath ??= (async () => {
  const path = join(await mkdtemp(join(tmpdir(), "colleague-chat-owner-")), "people.json");
  await writeFile(path, JSON.stringify({ schemaVersion: "company-people.v1", people: [
    { personId: 甲, displayName: "测试甲", roles: ["ceo"] },
    { personId: 乙, displayName: "测试乙", roles: ["dri", "participant"] },
    { personId: 丙, displayName: "测试丙", roles: ["dri"] },
    { personId: 丁, displayName: "测试丁", roles: ["participant"] },
  ] }));
  return path;
})();

type Answer = Awaited<ReturnType<ColleagueAnswerAgent["answer"]>>;
type Pick = Awaited<ReturnType<ColleagueAnswerAgent["pick"]>>;

async function setup() {
  const impl = {
    pick: async (_input: PickInput): Promise<Pick> => ({ itemIds: ["note"], smalltalk: false }),
    answer: async (_input: AnswerInput): Promise<Answer> => ({ answer: "按拆分手册拆四件", category: "none", handoff: false, reason: null, sources: ["note"] }),
  };
  const agent: ColleagueAnswerAgent = { pick: (input) => impl.pick(input), answer: (input) => impl.answer(input) };
  const f = await boardFixture({ colleagueAnswerAgent: agent }, { companyPeopleSeed: await peopleSeed() });
  const login = await f.call("POST", "/api/auth/login", { loginId: THIRD.loginId, passcode: THIRD.passcode });
  const third = String(login.headers["set-cookie"]).split(";")[0];
  expect((await f.call("PUT", "/api/me/colleague-materials/note", { note: "部署按拆分手册拆四件" }, third)).statusCode).toBe(200);
  const json = (method: "GET" | "POST" | "PUT") => async (url: string, body?: unknown, cookie = f.member) => (await f.call(method, url, body, cookie)).json();
  const get = json("GET"), post = json("POST"), put = json("PUT");
  let chatId = "";
  const O = () => C + "/" + chatId;
  /** 乙对丙的伙伴说一句。 */
  const say = async (text: string): Promise<TChatView> => {
    const chat = (await post(C + "/with/" + 丙 + "/messages", { clientId: randomUUID(), text })).chat as TChatView;
    chatId = chat.id!;
    return chat;
  };
  const ask = async (text: string) => (await say(text)).messages.filter((m) => m.author === "asker").at(-1)!.id;
  const run = (id: string) => f.t.app.colleagueChatAnswerJobs[CHAT_ANSWER_JOB]({ messageId: id }, {} as never);
  /** 乙问一句，伙伴按这个类别答完：问句和伙伴句的 id。 */
  const answered = async (text: string, category: AnswerCategory) => {
    const handoff = HANDOFF_CATEGORIES.has(category);
    impl.answer = async () => ({ answer: "按拆分手册拆四件", category, handoff, reason: handoff ? "要他定" : null, sources: ["note"] });
    const id = await ask(text);
    await run(id);
    const reply = (await f.t.sql("SELECT id FROM colleague_chat_messages WHERE reply_to=$1 AND author='buddy'", [id]))[0].id as string;
    return { ask: id, reply };
  };
  /** 丙首页等你里同事对话、加好友这两种。 */
  const waiting = async () => ((await get("/api/me/work-home", undefined, third)).waiting as TWaitingItem[])
    .filter((item) => item.kind === "colleague_chat" || item.kind === "friend_request");
  /** 丙在这段里说一句（回某一句）、改伙伴答的那句。 */
  const reply = (text: string, replyTo?: string) => post(O() + "/owner-messages", { clientId: randomUUID(), text, ...(replyTo ? { replyTo } : {}) }, third);
  const fix = (id: string, text: string) => post(O() + "/messages/" + id + "/correct", { clientId: randomUUID(), text }, third);
  return { f, third, get, post, put, O, ask, run, answered, waiting, reply, fix };
}

describe("主人那边", { timeout: 60_000 }, () => {
  it("改一句、收回：问的人看不到收回的正文，主人看得到原话", async () => {
    const s = await setup();
    try {
      const a = await s.answered("部署怎么拆", "none");
      expect((await s.fix(a.reply, "拆五件")).chat.messages[1]).toMatchObject({ text: "按拆分手册拆四件", correction: { text: "拆五件" } });
      expect((await s.fix(a.reply, "拆六件")).code).toBe("ALREADY_CORRECTED");
      expect((await s.post(s.O() + "/messages/" + a.reply + "/retract", {}, s.third)).chat.messages[1].retracted).toBe(true);
      expect((await s.post(s.O() + "/messages/" + a.reply + "/retract", {}, s.third)).chat.messages[1].retracted).toBe(true);
      expect((await s.get(C + "/with/" + 丙)).chat.messages[1]).toMatchObject({ retracted: true, text: "" });
      expect((await s.get(C + "/from/" + 乙, undefined, s.third)).chat.messages[1].text).toBe("按拆分手册拆四件");
    } finally { await s.f.close(); }
  });

  it("只认这段的主人；目标不是这段的伙伴句 404；正文遮密钥；同一 clientId 只落一条", async () => {
    const s = await setup();
    try {
      const a = await s.answered("部署怎么拆", "none");
      expect((await s.f.call("POST", s.O() + "/messages/" + a.reply + "/retract", {})).statusCode).toBe(404);
      expect((await s.f.call("POST", s.O() + "/messages/" + a.ask + "/correct", { clientId: randomUUID(), text: "拆五件" }, s.third)).statusCode).toBe(404);
      const clientId = randomUUID();
      const body = { clientId, text: "用 sk-abcdefghijklmnopqrstuvwx 登", replyTo: a.ask };
      await s.post(s.O() + "/owner-messages", body, s.third);
      const chat = (await s.post(s.O() + "/owner-messages", body, s.third)).chat as TChatView;
      expect(chat.messages.filter((m) => m.author === "owner").map((m) => [m.text, m.replyTo])).toEqual([["用 sk-abc•••• 登", a.ask]]);
    } finally { await s.f.close(); }
  });

  it("逐件结清：一段一行，回一件只消那一件", async () => {
    const s = await setup();
    try {
      await s.answered("报价能定吗", "money_external");
      const plan = await s.answered("排期谁来定", "commit");
      const chatId = s.O().slice(C.length + 1);
      expect(await s.waiting()).toMatchObject([{ id: "colleague-chat:" + chatId, title: "报价能定吗", source: "钱和对外", person: { personId: 乙 },
        open: { kind: "colleague_chat", id: 乙 } }]);
      await s.reply("报价周五定");
      expect(await s.waiting()).toMatchObject([{ title: "排期谁来定", source: "要承诺" }]);
      await s.reply("我定", plan.ask);
      expect(await s.waiting()).toEqual([]);
    } finally { await s.f.close(); }
  });

  it("飞书写要推的那个原因：先一句资料里没有、再一句要承诺，等你写资料里没有，飞书写要承诺", async () => {
    const s = await setup();
    try {
      await s.answered("报价单在哪", "no_basis");
      await s.answered("排期谁来定", "commit");
      const rows = await s.waiting();
      expect(rows).toMatchObject([{ title: "报价单在哪", source: "资料里没有", chat: { pushReason: "commit" } }]);
      expect(pushNotice(丙, rows)).toMatchObject({ title: "测试乙 · 要承诺", body: "测试乙 · 要承诺" });
    } finally { await s.f.close(); }
  });

  it("主人先回了这句，作业不落伙伴句", async () => {
    const s = await setup();
    try {
      const m = await s.ask("谁值守");
      await s.reply("我值守", m);
      await s.run(m);
      expect(await s.f.t.sql("SELECT 1 FROM colleague_chat_messages WHERE author='buddy'")).toEqual([]);
    } finally { await s.f.close(); }
  });

  it("好友申请进等你，开放后消掉", async () => {
    const s = await setup();
    try {
      await s.put("/api/me/friend-settings", { admission: "approve", defaults: { agentAsk: true } }, s.third);
      expect((await s.post("/api/me/friends/" + 丙 + "/request")).relation).toBe("pending_out");
      expect(await s.waiting()).toMatchObject([{ id: "friend-request:" + 乙, kind: "friend_request", title: "测试乙想加你好友",
        open: { kind: "friend_request", id: 乙 } }]);
      expect((await s.post("/api/me/friends/" + 乙 + "/accept", { agentAsk: true }, s.third)).relation).toBe("friends");
      expect(await s.waiting()).toEqual([]);
    } finally { await s.f.close(); }
  });
});
