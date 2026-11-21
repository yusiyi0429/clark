import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AnswerInput, ColleagueAnswerAgent, PickInput } from "../src/colleagueAnswerAgent.js";
import type { ChatService } from "../src/chatService.js";
import { CHAT_ANSWER_JOB } from "../src/colleagueChats.js";
import { turnWordsReader } from "../src/sourceWords.js";
import { boardFixture, THIRD } from "./boardFixture.js";
import { TEST_CEO, TEST_MEMBER } from "./helpers.js";

/**
 * Miles 替你问（ask_colleague_buddy，设计稿第 2 节、合议本人拍板 #2）：只带本人这一轮的原话、遮密钥、主线留痕带原文；
 * 要好友且对方开了「他的伙伴替他来问」；同一轮对同一位最多 3 句；要对方本人定的带回原因词，不进对方的等你。
 */

const TOKEN = "chat-token";
const 甲 = TEST_CEO.personId;
const 乙 = TEST_MEMBER.personId;
const 丙 = THIRD.personId;
const 丁 = "person-fixture-004";
const C = "/api/me/colleague-chats";
const WORDS = "帮我问问丙的伙伴：切换那天几点开始，库是 postgres://app:hunter2@db/x";
let seedPath: Promise<string> | undefined;
const peopleSeed = () => seedPath ??= (async () => {
  const path = join(await mkdtemp(join(tmpdir(), "buddy-colleague-ask-")), "people.json");
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

function fakeAgent() {
  const impl = {
    pick: async (_input: PickInput): Promise<Pick> => ({ itemIds: ["note"], smalltalk: false }),
    answer: async (_input: AnswerInput): Promise<Answer> => ({ answer: "按拆分手册拆四件", category: "none", handoff: false, reason: null, sources: ["note"] }),
  };
  const agent: ColleagueAnswerAgent = { pick: (input) => impl.pick(input), answer: (input) => impl.answer(input) };
  return { impl, agent };
}

async function setup() {
  const fake = fakeAgent();
  const f = await boardFixture({ colleagueAnswerAgent: fake.agent, turnWords: async () => [WORDS] },
    { boardCloudAgents: false, internalChatToken: TOKEN, companyPeopleSeed: await peopleSeed() });
  const login = await f.call("POST", "/api/auth/login", { loginId: THIRD.loginId, passcode: THIRD.passcode });
  const third = String(login.headers["set-cookie"]).split(";")[0];
  expect((await f.call("PUT", "/api/me/colleague-materials/note", { note: "部署按拆分手册拆四件" }, third)).statusCode).toBe(200);
  expect((await f.call("PUT", "/api/me/buddy-authority", { authority: "full" })).statusCode).toBe(200);
  const runId = randomUUID();
  const get = async (url: string, cookie = f.member) => (await f.call("GET", url, undefined, cookie)).json();
  const act = (name: string, args: unknown) => f.t.app.inject({ method: "POST", url: `/internal/me/buddy-actions/${name}`,
    headers: { authorization: `Bearer ${TOKEN}`, "x-owner-id": 乙 }, payload: { args, runId } });
  const failed = async (name: string, args: unknown) => {
    const res = await act(name, args);
    return [res.statusCode, res.json().code, res.json().message] as [number, string, string];
  };
  const bad = (text: string) => failed("ask_colleague_buddy", { personId: 丙, text });
  const buddyAsks = async () => (await f.t.sql("SELECT id FROM colleague_chat_messages WHERE author='asker_buddy' ORDER BY seq")).map((row) => row.id as string);
  /** 发动作、等库里有这句、跑它的作业（beforeRun 先在作业前做点什么），回动作的 result 加 summary、作业跑完到动作回来花的毫秒。 */
  const asked = async (text: string, beforeRun?: (messageId: string) => Promise<void>) => {
    const before = (await buddyAsks()).length;
    const pending = act("ask_colleague_buddy", { personId: 丙, text });
    let ids = await buddyAsks();
    for (let tries = 0; ids.length === before && tries < 200; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      ids = await buddyAsks();
    }
    await beforeRun?.(ids.at(-1)!);
    await f.t.app.colleagueChatAnswerJobs[CHAT_ANSWER_JOB]({ messageId: ids.at(-1)! }, {} as never);
    const ran = Date.now();
    const res = await pending;
    if (res.statusCode !== 200) throw new Error(res.body);
    return { ...res.json().result, summary: res.json().summary, waited: Date.now() - ran } as { chatId: string; sent: string; answer?: string; sources?: string[];
      needsOwner?: string | null; pending?: true; failed?: true; ownerReply?: string; summary: string; waited: number };
  };
  const friends = async () => expect((await f.call("POST", "/api/me/friends/" + 丙 + "/request", {})).statusCode).toBe(200);
  return { f, fake, get, bad, asked, friends, third, runId };
}

const sent = "切换那天几点开始，库是 postgres://app:••••@db/x";

describe("Miles 替你问", { timeout: 120_000 }, () => {
  it("对方没开放：403，一句都不落", async () => {
    const s = await setup();
    try {
      expect(await s.bad("切换那天几点开始")).toEqual([403, "NOT_OPENED", "他没开放这一项"]);
      expect(await s.f.t.sql("SELECT 1 FROM colleague_chat_messages")).toEqual([]);
    } finally { await s.f.close(); }
  });

  it("原话：不是本人这一轮的原话 400；是原话的发出去、遮密钥，主线留痕带原文", async () => {
    const s = await setup();
    try {
      await s.friends();
      expect((await s.bad("他上周还说预算超了，切换几点开始"))[1]).toBe("NOT_OWNER_WORDS");
      expect(await s.asked("切换那天几点开始，库是 postgres://app:hunter2@db/x")).toMatchObject({ sent, answer: "按拆分手册拆四件", needsOwner: null });
      expect(await s.f.t.sql("SELECT author,via,body FROM colleague_chat_messages ORDER BY seq LIMIT 1")).toEqual([{ author: "asker_buddy", via: "main", body: sent }]);
      expect((await s.get(C + "/main-lines")).items).toMatchObject([{ author: "asker_buddy", text: sent, runId: s.runId }]);
      // 本人从主线直接发的那句不是哪一轮里伙伴替他问的，不带 runId，主线照时间排。
      expect((await s.f.call("POST", `${C}/with/${丙}/messages`, { clientId: randomUUID(), text: "演练记录交到哪？", via: "main" })).statusCode).toBe(200);
      expect((await s.get(C + "/main-lines")).items.map((line: { author: string; runId: unknown }) => [line.author, line.runId]))
        .toEqual([["asker_buddy", s.runId], ["asker", null]]);
      const audit = await s.f.t.sql("SELECT args FROM buddy_actions WHERE action='ask_colleague_buddy'");
      expect(audit).toEqual([{ args: { personId: 丙, text: "切换那天几点开始，库是 postgres://app:••••@db/x" } }]);
      expect(JSON.stringify(audit)).not.toContain("hunter2");
    } finally { await s.f.close(); }
  });

  it("第 4 句 409；对方伙伴说要本人定时带回原因词，对方等你里没有", async () => {
    const s = await setup();
    try {
      await s.friends();
      s.fake.impl.answer = async () => ({ answer: "要他定", category: "commit", handoff: true, reason: "要他定", sources: [] });
      await s.asked("切换那天几点开始");
      await s.asked("几点开始");
      expect((await s.asked("切换那天")).needsOwner).toBe("要承诺");
      expect((await s.bad("切换"))[1]).toBe("ROUND_LIMIT");
      expect(await s.f.t.sql("SELECT 1 FROM colleague_chat_messages WHERE wait_reason IS NOT NULL")).toEqual([]);
    } finally { await s.f.close(); }
  });

  it("对方伙伴没答上来：马上回、说没答上来，不等满", async () => {
    const s = await setup();
    try {
      await s.friends();
      s.fake.impl.answer = async () => { throw new Error("模型出错"); };
      const result = await s.asked("切换那天几点开始");
      expect(result).toMatchObject({ failed: true, summary: "测试丙的伙伴没答上来" });
      expect(result).not.toHaveProperty("pending");
      expect(result.waited).toBeLessThan(5_000);
    } finally { await s.f.close(); }
  });

  it("对方本人先回了：马上回、带回他本人的话", async () => {
    const s = await setup();
    try {
      await s.friends();
      const result = await s.asked("切换那天几点开始", async (messageId) => {
        const chatId = (await s.f.t.sql("SELECT chat_id FROM colleague_chat_messages WHERE id=$1", [messageId]))[0].chat_id as string;
        expect((await s.f.call("POST", C + "/" + chatId + "/owner-messages", { clientId: randomUUID(), text: "九点开始", replyTo: messageId }, s.third)).statusCode).toBe(200);
      });
      expect(result).toMatchObject({ ownerReply: "九点开始", summary: "测试丙本人回了" });
      expect(result.waited).toBeLessThan(5_000);
    } finally { await s.f.close(); }
  });

  it("本人这一轮说的话只认这一轮：别的轮还标着在跑的不算", async () => {
    const message = (runId: string, content: string, extra: object = {}) => ({ sequence: 1, role: "user", content, referencesSnapshot: [], attachments: [], runId,
      createdAt: "2026-11-06T02:00:00.000Z", ...extra });
    const chat = { history: async () => ({ scope: "global", messages: [message("old-run", "以前那轮卡住的话", { running: true }), message("this-run", "帮我问问丙的伙伴")] }) };
    const words = turnWordsReader({ q: (async () => ({ rows: [] })) as never, chat: chat as unknown as ChatService, conversationTurnTimeoutMs: 60_000 });
    expect(await words(乙, "this-run")).toEqual(["帮我问问丙的伙伴"]);
  });
});
