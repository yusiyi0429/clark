import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, test } from "vitest";
import type { TChatView } from "@warmap/contracts";
import type { AnswerInput, ColleagueAnswerAgent, PickInput } from "../src/colleagueAnswerAgent.js";
import { CHAT_ANSWER_JOB, sendChatMessage, type ChatDeps } from "../src/colleagueChats.js";
import type { Query } from "../src/meetingStore.js";
import { isRealPerson } from "../src/people.js";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { BOARD_NOW, boardFixture, THIRD } from "./boardFixture.js";
import { TEST_CEO, TEST_MEMBER } from "./helpers.js";

/** 甲 CEO、乙问的人、丙被问的人（DRI）、丁参与人（不被覆盖）。 */
const 甲 = TEST_CEO.personId;
const 乙 = TEST_MEMBER.personId;
const 丙 = THIRD.personId;
const 丁 = "person-fixture-004";
const C = "/api/me/colleague-chats";
let seedPath: Promise<string> | undefined;
const peopleSeed = () => seedPath ??= (async () => {
  const path = join(await mkdtemp(join(tmpdir(), "colleague-chat-answers-")), "people.json");
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

/** 记下每次输入的假代答；返回值按用例改 impl。 */
function fakeAgent() {
  const seen = { pick: [] as PickInput[], answer: [] as AnswerInput[] };
  const impl = {
    pick: async (_input: PickInput): Promise<Pick> => ({ itemIds: ["note"], smalltalk: false }),
    answer: async (_input: AnswerInput): Promise<Answer> => ({ answer: "按拆分手册拆四件", category: "none", handoff: false, reason: null, sources: ["note"] }),
  };
  const agent: ColleagueAnswerAgent = {
    pick: async (input) => { seen.pick.push(input); return impl.pick(input); },
    answer: async (input) => { seen.answer.push(input); return impl.answer(input); },
  };
  return { seen, impl, agent };
}

const commit: Answer = { answer: "要他定", category: "commit", handoff: true, reason: "要他定", sources: [] };

async function setup() {
  const fake = fakeAgent();
  const companyPeopleSeed = await peopleSeed();
  const f = await boardFixture({ colleagueAnswerAgent: fake.agent }, { companyPeopleSeed });
  const login = await f.call("POST", "/api/auth/login", { loginId: THIRD.loginId, passcode: THIRD.passcode });
  const third = String(login.headers["set-cookie"]).split(";")[0];
  expect((await f.call("PUT", "/api/me/colleague-materials/note", { note: "部署按拆分手册拆四件" }, third)).statusCode).toBe(200);
  const json = (method: "GET" | "POST") => async (url: string, body?: unknown, cookie = f.member) => (await f.call(method, url, body, cookie)).json();
  const get = json("GET"), post = json("POST");
  const q: Query = (sql, params) => f.t.pool.query(sql, params);
  const directory = loadPeopleDirectory({ companyPeopleSeed });
  const people = new Map(directory.searchPeople(undefined).filter(isRealPerson).map((person) => [person.personId, person.displayName]));
  const deps: ChatDeps = { q, pool: f.t.pool, now: () => BOARD_NOW, directory, people };
  /** 乙对丙的伙伴说一句。 */
  const say = async (text: string): Promise<TChatView> => (await post(C + "/with/" + 丙 + "/messages", { clientId: randomUUID(), text })).chat;
  const ask = async (text: string) => (await say(text)).messages.filter((m) => m.author === "asker").at(-1)!.id;
  /** 乙的伙伴替乙问丙的伙伴一句。 */
  const viaBuddy = async (text: string) => (await sendChatMessage(deps, 乙, 丙, { clientId: randomUUID(), text, author: "asker_buddy" })).messageId;
  const run = (id: string) => f.t.app.colleagueChatAnswerJobs[CHAT_ANSWER_JOB]({ messageId: id }, {} as never);
  const row = async (id: string) => (await f.t.sql("SELECT * FROM colleague_chat_messages WHERE id=$1", [id]))[0];
  const reply = async (id: string) => (await f.t.sql("SELECT * FROM colleague_chat_messages WHERE reply_to=$1 AND author='buddy'", [id]))[0];
  const friends = async () => expect((await f.call("POST", "/api/me/friends/" + 丙 + "/request", {}, f.member)).statusCode).toBe(200);
  return { f, fake, third, get, post, say, ask, viaBuddy, run, row, reply, friends };
}

describe("伙伴答一句", { timeout: 60_000 }, () => {
  it("答一句：落伙伴句和出处，记读取；作业跑两遍只落一条", async () => {
    const s = await setup();
    try {
      const m = await s.ask("部署怎么拆");
      await s.run(m);
      await s.run(m);
      expect((await s.get(C + "/with/" + 丙)).chat.messages.map((x: TChatView["messages"][number]) => [x.author, x.text, x.answer, x.sources, x.replyTo])).toEqual([
        ["asker", "部署怎么拆", "answered", [], null], ["buddy", "按拆分手册拆四件", null, ["说明（11/6）"], m]]);
      expect(await s.f.t.sql("SELECT item_id FROM colleague_reads WHERE reader_id=$1 AND owner_id=$2", [乙, 丙])).toEqual([{ item_id: "note" }]);
    } finally { await s.f.close(); }
  });

  it("收起的、收回的、改过的不再进模型", async () => {
    const s = await setup();
    try {
      const chatId = randomUUID();
      await s.f.t.sql("INSERT INTO colleague_chats (id,asker_id,owner_id,created_at,last_message_at) VALUES ($1,$2,$3,$4,$4)", [chatId, 乙, 丙, BOARD_NOW]);
      const put = async (author: string, body: string, extra: { replyTo?: string; sources?: object[]; retracted?: boolean; corrects?: string } = {}) => {
        const id = randomUUID();
        const asked = author === "asker";
        await s.f.t.sql(`INSERT INTO colleague_chat_messages (id,chat_id,author,body,client_id,created_at,reply_to,sources,retracted_at,corrects,answer_state,answer_started_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, chatId, author, body, randomUUID(), BOARD_NOW, extra.replyTo ?? null, JSON.stringify(extra.sources ?? []),
          extra.retracted ? BOARD_NOW : null, extra.corrects ?? null, asked ? "answered" : null, asked ? BOARD_NOW : null]);
        return id;
      };
      const q1 = await put("asker", "第一问");
      await put("buddy", "答一", { replyTo: q1, sources: [{ itemId: "file:gone", label: "旧文件（11/1）" }] });
      const q2 = await put("asker", "第二问");
      await put("buddy", "答二", { replyTo: q2, retracted: true });
      const q3 = await put("asker", "第三问");
      const a3 = await put("buddy", "答三", { replyTo: q3 });
      await put("owner", "以这句为准", { corrects: a3 });
      const m = await s.ask("第四问 sk-abcdefghijklmnopqrstuvwx");
      await s.run(m);
      expect(s.fake.seen.answer.at(-1)!.thread.map((t) => [t.by, t.text])).toEqual([
        ["asker", "第一问"], ["asker", "第二问"], ["asker", "第三问"], ["owner", "以这句为准"], ["asker", "第四问 sk-abc••••"]]);
    } finally { await s.f.close(); }
  });

  it("作答中途授权没了：不落伙伴句，问句没答上来", async () => {
    const s = await setup();
    try {
      await s.friends();
      const id = await s.viaBuddy("几点开始");
      const answer = s.fake.impl.answer;
      s.fake.impl.answer = async (input) => { await s.f.t.sql("DELETE FROM colleague_friend_grants"); return answer(input); };
      await s.run(id);
      expect(await s.f.t.sql("SELECT 1 FROM colleague_chat_messages WHERE author='buddy'")).toEqual([]);
      expect((await s.row(id)).answer_state).toBe("failed");
    } finally { await s.f.close(); }
  });

  it("换了一轮的旧作业不写", async () => {
    const s = await setup();
    try {
      const n = await s.ask("部署怎么拆");
      const answer = s.fake.impl.answer;
      s.fake.impl.answer = async (input) => {
        await s.f.t.sql("UPDATE colleague_chat_messages SET answer_started_at=answer_started_at + interval '1 second' WHERE id=$1", [n]);
        return answer(input);
      };
      await s.run(n);
      expect((await s.row(n)).answer_state).toBe("answering");
      expect(await s.f.t.sql("SELECT 1 FROM colleague_chat_messages WHERE author='buddy'")).toEqual([]);
    } finally { await s.f.close(); }
  });

  it("作答时问的人点了问本人：不落伙伴句，不改回答了", async () => {
    const s = await setup();
    try {
      const chat = await s.say("谁值守");
      const id = chat.messages[0].id;
      const answer = s.fake.impl.answer;
      s.fake.impl.answer = async (input) => {
        expect((await s.post(C + "/" + chat.id + "/messages/" + id + "/ask-owner")).chat.messages[0].answer).toBe("asked_owner");
        return answer(input);
      };
      await s.run(id);
      expect(await s.row(id)).toMatchObject({ answer_state: "asked_owner", wait_reason: "asked_owner" });
      expect(await s.f.t.sql("SELECT 1 FROM colleague_chat_messages WHERE author='buddy'")).toEqual([]);
    } finally { await s.f.close(); }
  });

  test.each([
    ["寒暄", { pick: { itemIds: [], smalltalk: true }, answer: { answer: "不客气", category: "smalltalk", handoff: false, reason: null, sources: [] } }, ["answered", "不客气", null]],
    ["出错", { answer: new Error("boom") }, ["failed", undefined, null]],
    ["资料里没有", { pick: { itemIds: [], smalltalk: false } }, ["answered", "他放出来的资料里没有能答的", "no_basis"]],
    ["要承诺", { answer: { ...commit, answer: "手册没写谁值守", sources: ["note"] } }, ["answered", "手册没写谁值守", "commit"]],
    ["敏感", { answer: { answer: "他月薪两万", category: "sensitive", handoff: false, reason: null, sources: ["note"] } }, ["answered", "这件事我说不了", null]],
  ] as [string, { pick?: Pick; answer?: Answer | Error }, unknown[]][])("去向：%s", async (_name, use, expected) => {
    const s = await setup();
    try {
      if (use.pick) { const pick = use.pick; s.fake.impl.pick = async () => pick; }
      if (use.answer) {
        const answer = use.answer;
        s.fake.impl.answer = async () => { if (answer instanceof Error) throw answer; return answer; };
      }
      const id = await s.ask("部署怎么拆");
      await s.run(id);
      const question = await s.row(id);
      expect([question.answer_state, (await s.reply(id))?.body, question.wait_reason]).toEqual(expected);
    } finally { await s.f.close(); }
  });

  it("替主人来问的：要承诺也不叫人；已转本人的问句带给模型", async () => {
    const s = await setup();
    try {
      await s.friends();
      s.fake.impl.answer = async () => commit;
      const first = await s.ask("谁值守");
      await s.run(first);
      const second = await s.viaBuddy("几点开始");
      await s.run(second);
      expect((await s.row(first)).wait_reason).toBe("commit");
      expect((await s.row(second)).wait_reason).toBeNull();
      expect(s.fake.seen.answer.at(-1)!.pending).toEqual(["谁值守"]);
    } finally { await s.f.close(); }
  });
});
