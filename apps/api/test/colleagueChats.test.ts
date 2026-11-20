import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TChatListResponse, TChatView } from "@warmap/contracts";
import { readChat, sendChatMessage, type ChatDeps } from "../src/colleagueChats.js";
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
const everyone = [
  { personId: 甲, displayName: "测试甲", roles: ["ceo"] },
  { personId: 乙, displayName: "测试乙", roles: ["dri", "participant"] },
  { personId: 丙, displayName: "测试丙", roles: ["dri"] },
  { personId: 丁, displayName: "测试丁", roles: ["participant"] },
];
const seeds = new Map<string, Promise<string>>();
const peopleSeed = (people = everyone) => {
  const key = people.map((person) => person.personId).join(",");
  if (!seeds.has(key)) seeds.set(key, (async () => {
    const path = join(await mkdtemp(join(tmpdir(), "colleague-chats-")), "people.json");
    await writeFile(path, JSON.stringify({ schemaVersion: "company-people.v1", people }));
    return path;
  })());
  return seeds.get(key)!;
};

async function setup() {
  const companyPeopleSeed = await peopleSeed();
  const f = await boardFixture({}, { companyPeopleSeed });
  const login = await f.call("POST", "/api/auth/login", { loginId: THIRD.loginId, passcode: THIRD.passcode });
  const third = String(login.headers["set-cookie"]).split(";")[0];
  const json = (method: "GET" | "POST" | "PUT" | "DELETE") => async (url: string, body?: unknown, cookie = f.member) => (await f.call(method, url, body, cookie)).json();
  const get = json("GET"), post = json("POST");
  const q: Query = (sql, params) => f.t.pool.query(sql, params);
  const directory = loadPeopleDirectory({ companyPeopleSeed });
  const people = new Map(directory.searchPeople(undefined).filter(isRealPerson).map((person) => [person.personId, person.displayName]));
  const deps: ChatDeps = { q, pool: f.t.pool, now: () => BOARD_NOW, directory, people };
  /** 乙对丙的伙伴说一句。 */
  const say = async (text: string): Promise<TChatView> => (await post(C + "/with/" + 丙 + "/messages", { clientId: randomUUID(), text })).chat;
  const ask = async (text: string) => (await say(text)).messages.filter((m) => m.author === "asker" && m.text === text).at(-1)!.id;
  const row = async (id: string) => (await f.t.sql("SELECT * FROM colleague_chat_messages WHERE id=$1", [id]))[0];
  const keys = async () => (await f.t.sql("SELECT dedupe_key FROM jobs WHERE kind='colleague.chat-answer' ORDER BY id")).map((r) => r.dedupe_key as string);
  const list = async (cookie = f.member): Promise<TChatListResponse> => get(C, undefined, cookie);
  return { f, third, get, post, q, directory, deps, say, ask, row, keys, list };
}
type S = Awaited<ReturnType<typeof setup>>;
const M = (chat: { id: string | null }, id: string) => C + "/" + chat.id + "/messages/" + id;
/** 伙伴答这句（作业是 Task 4 的，这里直接落库）。 */
const buddyReply = (s: S, chatId: string, replyTo: string, text = "按拆分手册拆四件") =>
  s.f.t.sql(`INSERT INTO colleague_chat_messages (id,chat_id,author,body,client_id,created_at,reply_to)
    VALUES ($1,$2,'buddy',$3,$4,$5,$6) RETURNING id`, [randomUUID(), chatId, text, randomUUID(), BOARD_NOW, replyTo]).then((rows) => rows[0].id as string);

describe("同事对话核心", { timeout: 60_000 }, () => {
  it("发一句：在答、入队；同一 clientId 不多一条；同一对只有一段", async () => {
    const s = await setup();
    try {
      const body = { clientId: randomUUID(), text: "  部署怎么拆  " };
      await s.post(C + "/with/" + 丙 + "/messages", body);
      const a: TChatView = (await s.post(C + "/with/" + 丙 + "/messages", body)).chat;
      expect(a.messages.map((m) => [m.author, m.text])).toEqual([["asker", "部署怎么拆"]]);
      const b = await s.say("回滚怎么做");
      expect(b.id).toBe(a.id); expect(b.messages.map((m) => m.answer)).toEqual(["answering", "answering"]);
      expect(await s.keys()).toEqual(b.messages.map((m) => "colleague.chat-answer:" + m.id));
      expect(b).toMatchObject({ side: "with", peer: { personId: 丙, displayName: "测试丙", left: false }, relation: "none", firstWaiting: null });
      expect(await s.get(C + "/with/" + 甲)).toMatchObject({ chat: { id: null, messages: [] } });
      expect((await s.get(C + "/from/" + 甲)).code).toBe("NOT_FOUND");
      expect((await s.post(C + "/not-a-uuid/read", {})).code).toBe("INVALID_INPUT");
    } finally { await s.f.close(); }
  });

  it("密钥：落库前遮掉，列表预览也是遮过的", async () => {
    const s = await setup();
    try {
      await s.say("用 sk-abcdefghijklmnopqrstuvwx 连不上");
      expect((await s.f.t.sql("SELECT body FROM colleague_chat_messages"))[0].body).toBe("用 sk-abc•••• 连不上");
      expect((await s.list()).mine[0].last.text).toBe("用 sk-abc•••• 连不上");
    } finally { await s.f.close(); }
  });

  it("问满：同一对每天 10 句，第 11 句不入队；问满的不能重试，没答上来的重试不重扣", async () => {
    const s = await setup();
    try {
      let chat!: TChatView;
      for (let i = 1; i <= 11; i++) chat = await s.say("第 " + i + " 句");
      const [tenth, last] = chat.messages.slice(-2);
      expect(last.answer).toBe("limited"); expect(await s.keys()).toHaveLength(10);
      expect((await s.post(M(chat, last.id) + "/retry")).code).toBe("CHAT_LIMIT");
      expect((await s.post(M(chat, tenth.id) + "/retry")).code).toBe("NOT_STUCK");
      await s.f.t.sql("UPDATE colleague_chat_messages SET answer_state='failed' WHERE id=$1", [tenth.id]);
      expect((await s.post(M(chat, tenth.id) + "/retry")).chat.messages.at(-2).answer).toBe("answering");
      expect(await s.keys()).toHaveLength(11);
    } finally { await s.f.close(); }
  });

  it("问满：被问的人当天合计 20 句，别人问的也算，昨天的不算", async () => {
    const s = await setup();
    try {
      const other = randomUUID();
      await s.f.t.sql("INSERT INTO colleague_chats (id,asker_id,owner_id,created_at,last_message_at) VALUES ($1,$2,$3,$4,$4)", [other, 甲, 丙, BOARD_NOW]);
      const fill = (n: number, at: Date) => s.f.t.sql(`INSERT INTO colleague_chat_messages (id,chat_id,author,body,client_id,created_at,answer_state,answer_started_at)
        SELECT gen_random_uuid(),$1,'asker','问',gen_random_uuid(),$2,'answered',$2 FROM generate_series(1,$3)`, [other, at, n]);
      await fill(19, BOARD_NOW);
      await fill(5, new Date(BOARD_NOW.getTime() - 24 * 3600_000));
      expect((await s.say("第一句")).messages[0].answer).toBe("answering");
      expect((await s.say("在吗")).messages[1].answer).toBe("limited");
    } finally { await s.f.close(); }
  });

  it("问满那句点了问本人也不占名额：别人还能照常问", async () => {
    const s = await setup();
    try {
      let chat!: TChatView;
      for (let i = 1; i <= 11; i++) chat = await s.say("第 " + i + " 句");
      const limited = chat.messages.at(-1)!;
      expect((await s.post(M(chat, limited.id) + "/ask-owner")).chat.messages.at(-1).answer).toBe("asked_owner");
      const other = randomUUID();
      await s.f.t.sql("INSERT INTO colleague_chats (id,asker_id,owner_id,created_at,last_message_at) VALUES ($1,$2,$3,$4,$4)", [other, 甲, 丙, BOARD_NOW]);
      await s.f.t.sql(`INSERT INTO colleague_chat_messages (id,chat_id,author,body,client_id,created_at,answer_state,answer_started_at)
        SELECT gen_random_uuid(),$1,'asker','问',gen_random_uuid(),$2,'answered',$2 FROM generate_series(1,9)`, [other, BOARD_NOW]);
      expect((await sendChatMessage(s.deps, 甲, 丙, { clientId: randomUUID(), text: "第二十句" })).state).toBe("answering");
      expect((await sendChatMessage(s.deps, 甲, 丙, { clientId: randomUUID(), text: "第二十一句" })).state).toBe("limited");
    } finally { await s.f.close(); }
  });

  it("未读和看过：伙伴答了我这边亮，读过就灭；主人读过，问的人看到他看过", async () => {
    const s = await setup();
    try {
      const chat = await s.say("部署怎么拆");
      await buddyReply(s, chat.id!, chat.messages[0].id);
      const read = async (cookie = s.f.member) => expect((await s.f.call("POST", C + "/" + chat.id + "/read", {}, cookie)).statusCode).toBe(204);
      expect((await s.list()).mine[0]).toMatchObject({ unread: true, last: { author: "buddy", text: "按拆分手册拆四件" } });
      expect((await s.list(s.third)).inbound[0]).toMatchObject({ peer: { personId: 乙 }, unread: false, waiting: 0 });
      await read(); expect((await s.list()).mine[0].unread).toBe(false);
      expect((await s.get(C + "/with/" + 丙)).chat.messages[1].seen).toBe(false);
      await read(s.third); expect((await s.get(C + "/with/" + 丙)).chat.messages[1].seen).toBe(true);
    } finally { await s.f.close(); }
  });

  it("离开的人：看的人走了读不到，对方走了标 left，发不出去", async () => {
    const s = await setup();
    try {
      await s.say("部署怎么拆");
      const gone: ChatDeps = { ...s.deps, directory: loadPeopleDirectory({ companyPeopleSeed: await peopleSeed(everyone.filter((p) => p.personId !== 丙)) }) };
      await expect(readChat(gone, 丙, "from", 乙)).rejects.toMatchObject({ status: 404 });
      expect((await readChat(gone, 乙, "with", 丙)).peer.left).toBe(true);
      await expect(sendChatMessage(gone, 乙, 丙, { clientId: randomUUID(), text: "在吗" })).rejects.toMatchObject({ status: 404 });
      await expect(sendChatMessage(s.deps, 乙, 丙, { clientId: randomUUID(), text: "在吗", author: "asker_buddy" }))
        .rejects.toMatchObject({ status: 409, code: "NOT_OPENED" });
      expect(await s.f.t.sql("SELECT count(*)::int AS n FROM colleague_chat_messages")).toEqual([{ n: 1 }]);
    } finally { await s.f.close(); }
  });

  it("问本人：挂在原问句上，点两次还是一条；本人回过了不能再点", async () => {
    const s = await setup();
    try {
      const first = await s.say("部署怎么拆");
      const reply = await buddyReply(s, first.id!, first.messages[0].id);
      await s.post(M(first, reply) + "/ask-owner");
      const chat: TChatView = (await s.post(M(first, reply) + "/ask-owner")).chat;
      expect(chat.messages[0]).toMatchObject({ answer: "asked_owner", wait: { reason: "asked_owner", closed: false } });
      expect(await s.f.t.sql("SELECT count(*)::int AS n FROM colleague_chat_messages WHERE wait_reason IS NOT NULL")).toEqual([{ n: 1 }]);
      expect((await s.get(C + "/from/" + 乙, undefined, s.third)).chat.firstWaiting).toBe(first.messages[0].id);
      expect((await s.list(s.third)).inbound[0].waiting).toBe(1);
      expect((await s.post(M(first, reply) + "/ask-owner", {}, s.third)).code).toBe("NOT_FOUND");
      await s.f.t.sql("UPDATE colleague_chat_messages SET wait_closed_at=$2 WHERE id=$1", [first.messages[0].id, BOARD_NOW]);
      expect((await s.post(M(first, reply) + "/ask-owner")).code).toBe("ALREADY_ANSWERED");
    } finally { await s.f.close(); }
  });
});
