import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AnswerInput, ColleagueAnswerAgent, PickInput } from "../src/colleagueAnswerAgent.js";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { askBuddy, replyTeamDelivery, retryTeamBuddy, TEAM_BUDDY_ANSWER_JOB } from "../src/teamDeliveries.js";
import { BOARD_NOW, boardFixture, THIRD } from "./boardFixture.js";
import { TEST_CEO, TEST_MEMBER } from "./helpers.js";

const base = "/api/me/team-deliveries";
const FOURTH = "person-fixture-004";
/** 和 T4 那组一样：丙是 DRI（被覆盖），丁是参与人。thirdRole 换成 participant 时丙不再被覆盖。 */
const seeds = new Map<string, Promise<string>>();
const peopleSeed = (thirdRole: "dri" | "participant" = "dri") => seeds.get(thirdRole) ?? seeds.set(thirdRole, (async () => {
  const path = join(await mkdtemp(join(tmpdir(), "buddy-follow-")), "people.json");
  await writeFile(path, JSON.stringify({ schemaVersion: "company-people.v1", people: [
    { personId: TEST_CEO.personId, displayName: "测试甲", roles: ["ceo"] },
    { personId: TEST_MEMBER.personId, displayName: "测试乙", roles: ["dri", "participant"] },
    { personId: THIRD.personId, displayName: "测试丙", roles: [thirdRole] },
    { personId: FOURTH, displayName: "测试丁", roles: ["participant"] },
  ] }));
  return path;
})()).get(thirdRole)!;

type Answer = Awaited<ReturnType<ColleagueAnswerAgent["answer"]>>;
type Pick = Awaited<ReturnType<ColleagueAnswerAgent["pick"]>>;
type Reply = { id: string; status: string; text: string; origin?: string; reviewedAt?: string; corrects?: string; correctionSeenAt?: string };
type Recipient = { personId: string; status: string; buddy?: { state: string; note: string | null; askedAt: string; handoffBy?: string }; replies: Reply[] };
type Delivery = { id: string; recipients: Recipient[] };

function fakeAgent() {
  const seen = { pick: [] as PickInput[], answer: [] as AnswerInput[] };
  const impl = {
    pick: async (_input: PickInput): Promise<Pick> => ({ itemIds: ["note"] }),
    answer: async (_input: AnswerInput): Promise<Answer> => ({ answer: "按拆分手册拆四件", handoff: false, reason: null, sources: ["note"] }),
  };
  const agent: ColleagueAnswerAgent = {
    pick: async (input) => { seen.pick.push(input); return impl.pick(input); },
    answer: async (input) => { seen.answer.push(input); return impl.answer(input); },
  };
  return { seen, impl, agent };
}

async function setup() {
  const fake = fakeAgent();
  const f = await boardFixture({ colleagueAnswerAgent: fake.agent }, { companyPeopleSeed: await peopleSeed() });
  const login = await f.call("POST", "/api/auth/login", { loginId: THIRD.loginId, passcode: THIRD.passcode });
  const third = String(login.headers["set-cookie"]).split(";")[0];
  expect((await f.call("PUT", "/api/me/colleague-materials/note", { note: "部署按拆分手册拆四件" }, third)).statusCode).toBe(200);
  const q = f.t.pool.query.bind(f.t.pool);
  /** 测试乙问丙。 */
  const ask = async (extra: object = {}, cookie = f.member) => {
    const res = await f.call("POST", base, { clientId: randomUUID(), kind: "question", recipientIds: [THIRD.personId], text: "部署怎么拆", ...extra }, cookie);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().delivery as Delivery;
  };
  const read = async (id: string, cookie = f.member) => (await f.call("GET", `${base}/${id}`, undefined, cookie)).json().delivery as Delivery;
  const run = (id: string, triggerId: string | null = null) =>
    f.t.app.teamBuddyAnswerJobs[TEAM_BUDDY_ANSWER_JOB]({ requestId: id, recipientId: THIRD.personId, triggerId }, {} as never);
  /** 问一句并让伙伴答完，回伙伴那条。 */
  const answered = async (extra: object = {}) => {
    const sent = await ask(extra);
    await run(sent.id);
    const reply = (await read(sent.id)).recipients[0].replies.find((item) => item.origin === "buddy")!;
    expect(reply).toBeDefined();
    return { id: sent.id, reply };
  };
  const followUp = (id: string, text: string, cookie = f.member, clientId = randomUUID()) =>
    f.call("POST", `${base}/${id}/replies`, { clientId, status: "follow_up", recipientId: THIRD.personId, text }, cookie);
  const lastId = (delivery: Delivery) => delivery.recipients[0].replies.at(-1)!.id;
  const review = (id: string, replyId: string, body: object, cookie = third) => f.call("POST", `${base}/${id}/replies/${replyId}/review`, body, cookie);
  const seen = (id: string, replyId: string, cookie = f.member) => f.call("POST", `${base}/${id}/replies/${replyId}/seen`, undefined, cookie);
  const jobKeys = async (id: string) => (await f.t.sql("SELECT dedupe_key FROM jobs WHERE dedupe_key LIKE $1 ORDER BY id", [`team.buddy-answer:${id}:%`]))
    .map((row) => row.dedupe_key as string);
  const waitingItems = async (cookie = third) => (await f.call("GET", "/api/me/work-home", undefined, cookie)).json().waiting as { id: string; title: string; source: string }[];
  const waiting = async (cookie = third) => (await waitingItems(cookie)).map((item) => item.id);
  const buddyRows = async (id: string) => f.t.sql("SELECT body FROM team_delivery_replies WHERE request_id=$1 AND origin='buddy' ORDER BY seq", [id]);
  const asks = async (id: string) => (await f.t.sql("SELECT count(*)::int AS n FROM team_buddy_asks WHERE request_id=$1", [id]))[0].n as number;
  const action = (id: string, name: "retry" | "ask-owner", cookie = f.member) => f.call("POST", `${base}/${id}/recipients/${THIRD.personId}/buddy/${name}`, {}, cookie);
  /** 补当天的名额（借一条征集挂着）。 */
  const used = (anchor: string, count: number, asker = TEST_CEO.personId, at = BOARD_NOW) => f.t.sql(`INSERT INTO team_buddy_asks(request_id,recipient_id,trigger_key,asker_id,asked_at)
    SELECT $1,$2,$5||g,$3,$4 FROM generate_series(1,$6::int) g`, [anchor, THIRD.personId, asker, at, randomUUID(), count]);
  return { f, fake, third, q, ask, read, run, answered, followUp, lastId, review, seen, jobKeys, waitingItems, waiting, buddyRows, asks, action, used };
}

describe("追问", { timeout: 60_000 }, () => {
  it("发起人追问：带着整段往来再答一次，占一个名额", async () => {
    const s = await setup();
    try {
      const { id, reply } = await s.answered();
      const res = await s.followUp(id, "那回滚怎么做");
      expect(res.statusCode, res.body).toBe(200);
      const after = res.json().delivery as Delivery;
      expect(after.recipients[0]).toMatchObject({ status: "pending", buddy: { state: "answering" } });
      const triggerId = s.lastId(after);
      expect(after.recipients[0].replies.at(-1)).toMatchObject({ status: "follow_up", text: "那回滚怎么做" });
      expect(after.recipients[0].replies.at(-1)).not.toHaveProperty("origin");
      expect(await s.jobKeys(id)).toContain(`team.buddy-answer:${id}:${THIRD.personId}:${triggerId}`);
      expect(await s.asks(id)).toBe(2);
      expect(await s.waiting()).not.toContain(`team-request:${id}`);

      await s.run(id, triggerId);
      const thread = s.fake.seen.answer.at(-1)!.thread.map(({ by, text }) => [by, text]);
      expect(thread).toEqual([["asker", "部署怎么拆"], ["buddy", reply.text], ["asker", "那回滚怎么做"]]);
      expect(s.fake.seen.pick.at(-1)!.thread).toHaveLength(3);
      const done = (await s.read(id)).recipients[0];
      // A8：伙伴答的不算本人回复，收件人仍是待回复。
      expect(done).toMatchObject({ status: "pending", buddy: { state: "answered" } });
      expect(done.replies.map((item) => item.status)).toEqual(["answered", "follow_up", "answered"]);
      expect(done.replies.map((item) => item.origin ?? null)).toEqual(["buddy", null, "buddy"]);
      // 同一条追问重放：200，不另落、不另占名额。
      const clientId = randomUUID();
      expect((await s.followUp(id, "再问一句", s.f.member, clientId)).statusCode).toBe(200);
      expect((await s.followUp(id, "再问一句", s.f.member, clientId)).statusCode).toBe(200);
      expect(await s.asks(id)).toBe(3);
      expect((await s.followUp(id, "换了内容", s.f.member, clientId)).statusCode).toBe(409);
    } finally { await s.f.close(); }
  });

  it("被问的人自己答过以后再追问：往来里他那条是 owner", async () => {
    const s = await setup();
    try {
      const { id } = await s.answered();
      expect((await s.f.call("POST", `${base}/${id}/replies`, { clientId: randomUUID(), status: "answered", text: "我补一句：先拆部署" }, s.third)).statusCode).toBe(200);
      expect((await s.read(id)).recipients[0].status).toBe("answered");
      const after = (await s.followUp(id, "那回滚呢")).json().delivery as Delivery;
      expect(after.recipients[0]).toMatchObject({ status: "pending", buddy: { state: "answering" } });
      expect(await s.f.t.sql("SELECT status,done_by,done_at FROM request_recipients WHERE request_id=$1", [id])).toEqual([{ status: "pending", done_by: null, done_at: null }]);
      await s.run(id, s.lastId(after));
      expect(s.fake.seen.answer.at(-1)!.thread.map(({ by }) => by)).toEqual(["asker", "buddy", "owner", "asker"]);
    } finally { await s.f.close(); }
  });

  it("只有发起人能追问；伙伴没答过的不能追问", async () => {
    const s = await setup();
    try {
      const { id } = await s.answered();
      const forbidden = await s.followUp(id, "我自己追问", s.third);
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json().code).toBe("FORBIDDEN");

      const due = await s.ask({ dueAt: "2026-11-10T10:00:00.000Z" });
      const none = await s.followUp(due.id, "那回滚怎么做");
      expect(none.statusCode).toBe(409);
      expect(none.json()).toMatchObject({ code: "FOLLOW_UP_NOT_AVAILABLE", message: "这位同事的伙伴还没答过这一条" });
      const pending = await s.ask();
      expect((await s.followUp(pending.id, "那回滚怎么做")).json().code).toBe("FOLLOW_UP_NOT_AVAILABLE");
      expect(await s.f.t.sql("SELECT count(*)::int AS n FROM team_delivery_replies WHERE request_id=ANY($1::uuid[])", [[due.id, pending.id]])).toEqual([{ n: 0 }]);
    } finally { await s.f.close(); }
  });

  it("连着追问两次，只答最后一次", async () => {
    const s = await setup();
    try {
      const { id } = await s.answered();
      const first = s.lastId((await s.followUp(id, "那回滚怎么做")).json().delivery);
      const second = s.lastId((await s.followUp(id, "回滚要停服吗")).json().delivery);
      expect(await s.jobKeys(id)).toEqual(expect.arrayContaining([`team.buddy-answer:${id}:${THIRD.personId}:${first}`, `team.buddy-answer:${id}:${THIRD.personId}:${second}`]));
      await s.run(id, first);
      expect(await s.buddyRows(id)).toHaveLength(1);
      expect((await s.read(id)).recipients[0].buddy?.state).toBe("answering");
      await s.run(id, second);
      expect(await s.buddyRows(id)).toHaveLength(2);
      const thread = s.fake.seen.answer.at(-1)!.thread;
      expect(thread.slice(-2).map(({ by, text }) => [by, text])).toEqual([["asker", "那回滚怎么做"], ["asker", "回滚要停服吗"]]);
      expect((await s.read(id)).recipients[0].buddy?.state).toBe("answered");
    } finally { await s.f.close(); }
  });

  it("追问超上限：不走模型、不进被问的人的等你，不能重试只能问本人", async () => {
    const s = await setup();
    try {
      const { id } = await s.answered();
      await s.used(id, 19);
      const limited = (await s.followUp(id, "那回滚怎么做")).json().delivery as Delivery;
      expect(limited.recipients[0]).toMatchObject({ status: "pending", buddy: { state: "limited", note: "今天伙伴代答已到 20 次" } });
      expect(await s.jobKeys(id)).toHaveLength(1);
      expect(await s.waiting()).not.toContain(`team-request:${id}`);
      expect((await s.action(id, "retry")).json().code).toBe("BUDDY_LIMIT");
      expect((await s.action(id, "ask-owner")).json().delivery.recipients[0]).toMatchObject({ buddy: { state: "handoff", handoffBy: "asker" } });
      expect(await s.waiting()).toContain(`team-request:${id}`);
    } finally { await s.f.close(); }
  });

  it("追问没答上来：不进被问的人的等你；重试答的还是这条追问，不另占名额", async () => {
    const s = await setup();
    try {
      const { id } = await s.answered();
      const trigger = s.lastId((await s.followUp(id, "那回滚怎么做")).json().delivery);
      s.fake.impl.pick = async () => { throw new Error("模型挂了"); };
      await s.run(id, trigger);
      expect((await s.read(id)).recipients[0]).toMatchObject({ status: "pending", buddy: { state: "failed", note: "伙伴没答上来" } });
      expect(await s.waiting()).not.toContain(`team-request:${id}`);
      expect((await s.action(id, "retry")).statusCode).toBe(200);
      expect(await s.asks(id)).toBe(2);
      s.fake.impl.pick = async () => ({ itemIds: ["note"] });
      await s.run(id, trigger);
      expect(s.fake.seen.answer.at(-1)!.thread.at(-1)).toMatchObject({ by: "asker", text: "那回滚怎么做" });
      expect((await s.read(id)).recipients[0].buddy?.state).toBe("answered");
    } finally { await s.f.close(); }
  });
});

describe("首问和追问共用的几处（T4 审查留下的）", { timeout: 60_000 }, () => {
  it("旧作业晚到：失败不盖掉问的人刚点的重试，答出来的也不落", async () => {
    const s = await setup();
    try {
      const sent = await s.ask();
      const late = () => s.f.t.sql("UPDATE request_recipients SET buddy_asked_at=$2::timestamptz - interval '3 minutes' WHERE request_id=$1", [sent.id, BOARD_NOW]);
      await late();
      // 旧作业还在跑时，问的人见超时点了重试；旧作业随后失败。
      s.fake.impl.pick = async () => { expect((await s.action(sent.id, "retry")).statusCode).toBe(200); throw new Error("旧作业晚到"); };
      await s.run(sent.id);
      expect((await s.read(sent.id)).recipients[0]).toMatchObject({ buddy: { state: "answering", note: null, askedAt: BOARD_NOW.toISOString() } });

      // 旧作业随后答出来：不落，留给新作业。
      await late();
      s.fake.impl.pick = async () => { expect((await s.action(sent.id, "retry")).statusCode).toBe(200); return { itemIds: ["note"] }; };
      await s.run(sent.id);
      expect(await s.buddyRows(sent.id)).toEqual([]);
      expect((await s.read(sent.id)).recipients[0].buddy?.state).toBe("answering");
      s.fake.impl.pick = async () => ({ itemIds: ["note"] });
      await s.run(sent.id);
      expect(await s.buddyRows(sent.id)).toHaveLength(1);
      expect((await s.read(sent.id)).recipients[0].buddy?.state).toBe("answered");
    } finally { await s.f.close(); }
  });

  it("同一个触发调两次 askBuddy：不重复占名额、不重置状态，名额刚满时不误标超上限", async () => {
    const s = await setup();
    try {
      const directory = loadPeopleDirectory({ companyPeopleSeed: await peopleSeed() });
      const sent = await s.ask();
      const trigger = { requestId: sent.id, recipientId: THIRD.personId, triggerId: null };
      await s.used(sent.id, 19);
      expect(await askBuddy(s.q, directory, TEST_MEMBER.personId, trigger, BOARD_NOW)).toBe(true);
      expect((await s.read(sent.id)).recipients[0].buddy?.state).toBe("answering");
      expect(await s.asks(sent.id)).toBe(20);

      await s.f.t.sql("DELETE FROM team_buddy_asks WHERE asker_id=$1", [TEST_CEO.personId]);
      await s.run(sent.id);
      expect(await askBuddy(s.q, directory, TEST_MEMBER.personId, trigger, BOARD_NOW)).toBe(true);
      expect((await s.read(sent.id)).recipients[0].buddy?.state).toBe("answered");
      expect(await s.jobKeys(sent.id)).toHaveLength(1);
      expect(await s.asks(sent.id)).toBe(1);
    } finally { await s.f.close(); }
  });

  it("重试时再问一遍能不能问：被问的人不再被覆盖就不重试", async () => {
    const s = await setup();
    try {
      s.fake.impl.pick = async () => { throw new Error("模型挂了"); };
      const sent = await s.ask();
      await s.run(sent.id);
      const deps = { q: s.q, pool: s.f.t.pool, storageDir: tmpdir(), now: () => BOARD_NOW, people: new Map<string, string>(),
        directory: loadPeopleDirectory({ companyPeopleSeed: await peopleSeed("participant") }) };
      await expect(retryTeamBuddy(deps, TEST_MEMBER.personId, sent.id, THIRD.personId)).rejects.toMatchObject({ status: 409, code: "BUDDY_UNAVAILABLE" });
      expect((await s.read(sent.id)).recipients[0].buddy?.state).toBe("failed");
      expect(await s.jobKeys(sent.id)).toHaveLength(1);
      expect((await s.action(sent.id, "ask-owner")).statusCode).toBe(200);
    } finally { await s.f.close(); }
  });

  it("追问时被问的人不再被覆盖：409 BUDDY_UNAVAILABLE，追问不落库", async () => {
    const s = await setup();
    try {
      const { id } = await s.answered();
      const deps = { q: s.q, pool: s.f.t.pool, storageDir: tmpdir(), now: () => BOARD_NOW, people: new Map<string, string>(),
        directory: loadPeopleDirectory({ companyPeopleSeed: await peopleSeed("participant") }) };
      await expect(replyTeamDelivery(deps, TEST_MEMBER.personId, id, { clientId: randomUUID(), status: "follow_up", recipientId: THIRD.personId, text: "那回滚怎么做" }))
        .rejects.toMatchObject({ status: 409, code: "BUDDY_UNAVAILABLE" });
      expect(await s.f.t.sql("SELECT count(*)::int AS n FROM team_delivery_replies WHERE request_id=$1 AND status='follow_up'", [id])).toEqual([{ n: 0 }]);
      expect((await s.read(id)).recipients[0]).toMatchObject({ status: "pending", buddy: { state: "answered" } });
      expect(await s.asks(id)).toBe(1);
    } finally { await s.f.close(); }
  });

  it("问本人以后：被问的人看到写给他的原因；分得出是模型转的还是问的人转的", async () => {
    const s = await setup();
    try {
      s.fake.impl.pick = async () => { throw new Error("模型挂了"); };
      const failed = await s.ask();
      await s.run(failed.id);
      expect((await s.action(failed.id, "ask-owner")).statusCode).toBe(200);
      expect((await s.read(failed.id)).recipients[0].buddy).toMatchObject({ state: "handoff", note: "伙伴没答上来", handoffBy: "asker" });
      expect((await s.read(failed.id, s.third)).recipients[0].buddy).toMatchObject({ state: "handoff", note: "同事请你本人回", handoffBy: "asker" });

      s.fake.impl.pick = async () => ({ itemIds: ["note"] });
      s.fake.impl.answer = async () => ({ answer: "手册里没写谁值守", handoff: true, reason: "值守安排要测试丙本人定", sources: [] });
      const judged = await s.ask();
      await s.run(judged.id);
      for (const cookie of [s.f.member, s.third])
        expect((await s.read(judged.id, cookie)).recipients[0].buddy).toMatchObject({ state: "handoff", note: "值守安排要测试丙本人定", handoffBy: "buddy" });
      // 转本人后再追问：重新交伙伴答，原来的「问的人转的」不留着。
      s.fake.impl.answer = async () => ({ answer: "按拆分手册拆四件", handoff: false, reason: null, sources: ["note"] });
      const asked = (await s.followUp(judged.id, "那先按手册做行吗")).json().delivery as Delivery;
      expect(asked.recipients[0].buddy).toMatchObject({ state: "answering" });
      expect(asked.recipients[0].buddy).not.toHaveProperty("handoffBy");
    } finally { await s.f.close(); }
  });
});

describe("被问的人看过和更正", { timeout: 60_000 }, () => {
  it("没问题：标看过；再点 409；别人点 404", async () => {
    const s = await setup();
    try {
      const { id, reply } = await s.answered();
      const ok = await s.review(id, reply.id, { verdict: "ok" });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((ok.json().delivery as Delivery).recipients[0].replies[0]).toMatchObject({ id: reply.id, reviewedAt: BOARD_NOW.toISOString() });
      const again = await s.review(id, reply.id, { verdict: "ok" });
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe("ALREADY_REVIEWED");

      expect((await s.review(id, reply.id, { verdict: "ok" }, s.f.member)).statusCode).toBe(404);
      expect((await s.review(id, reply.id, { verdict: "ok" }, await s.f.t.loginCookie())).statusCode).toBe(404);
      expect((await s.f.call("POST", `${base}/${id}/replies`, { clientId: randomUUID(), status: "answered", text: "我自己补一句" }, s.third)).statusCode).toBe(200);
      const own = s.lastId(await s.read(id, s.third));
      expect((await s.review(id, own, { verdict: "ok" })).statusCode).toBe(404);
      expect((await s.review(id, randomUUID(), { verdict: "ok" })).statusCode).toBe(404);
      expect((await s.review(randomUUID(), reply.id, { verdict: "ok" })).statusCode).toBe(404);
    } finally { await s.f.close(); }
  });

  it("改一下：落一条更正，发起人的等你多一条，点知道了消掉", async () => {
    const s = await setup();
    try {
      const { id, reply } = await s.answered();
      const clientId = randomUUID();
      const fixed = await s.review(id, reply.id, { clientId, verdict: "corrected", text: "要拆五件，漏了回滚" });
      expect(fixed.statusCode, fixed.body).toBe(200);
      const delivery = await s.read(id);
      const correction = delivery.recipients[0].replies.at(-1)!;
      expect(correction).toMatchObject({ status: "answered", text: "要拆五件，漏了回滚", corrects: reply.id });
      expect(correction).not.toHaveProperty("origin");
      expect(correction).not.toHaveProperty("correctionSeenAt");
      expect(delivery.recipients[0].replies[0]).toMatchObject({ id: reply.id, text: reply.text, reviewedAt: BOARD_NOW.toISOString() });
      expect(delivery.recipients[0].status).toBe("answered");
      expect(await s.waitingItems(s.f.member)).toContainEqual(expect.objectContaining({ id: `team-request:${id}`, title: "更正：部署怎么拆", source: "测试丙" }));

      // 按 clientId 幂等：一样的 200 不另落；不一样的 409。
      expect((await s.review(id, reply.id, { clientId, verdict: "corrected", text: "要拆五件，漏了回滚" })).statusCode).toBe(200);
      expect((await s.review(id, reply.id, { clientId, verdict: "corrected", text: "要拆六件" })).statusCode).toBe(409);
      expect((await s.read(id)).recipients[0].replies).toHaveLength(2);
      const twice = await s.review(id, reply.id, { clientId: randomUUID(), verdict: "corrected", text: "要拆六件" });
      expect(twice.statusCode).toBe(409);
      expect(twice.json().code).toBe("ALREADY_REVIEWED");
      expect((await s.review(id, reply.id, { verdict: "ok" })).statusCode).toBe(409);

      expect((await s.seen(id, correction.id, s.third)).statusCode).toBe(404);
      expect((await s.seen(id, reply.id)).statusCode).toBe(404);
      const seen = await s.seen(id, correction.id);
      expect(seen.statusCode, seen.body).toBe(200);
      expect((seen.json().delivery as Delivery).recipients[0].replies.at(-1)).toMatchObject({ id: correction.id, correctionSeenAt: BOARD_NOW.toISOString() });
      expect(await s.waiting(s.f.member)).not.toContain(`team-request:${id}`);
      expect((await s.seen(id, correction.id)).statusCode).toBe(200);
    } finally { await s.f.close(); }
  });

  it("点过没问题以后还能改一下：原话保留，更正另起一条，提醒问的人", async () => {
    const s = await setup();
    try {
      const { id, reply } = await s.answered();
      expect((await s.review(id, reply.id, { verdict: "ok" })).statusCode).toBe(200);
      const fixed = await s.review(id, reply.id, { clientId: randomUUID(), verdict: "corrected", text: "要拆五件，漏了回滚" });
      expect(fixed.statusCode, fixed.body).toBe(200);
      const replies = (await s.read(id)).recipients[0].replies;
      expect(replies).toHaveLength(2);
      expect(replies[0]).toMatchObject({ id: reply.id, text: reply.text, origin: "buddy", reviewedAt: BOARD_NOW.toISOString() });
      expect(replies[1]).toMatchObject({ corrects: reply.id, text: "要拆五件，漏了回滚" });
      expect(await s.waitingItems(s.f.member)).toContainEqual(expect.objectContaining({ id: `team-request:${id}`, title: "更正：部署怎么拆" }));
    } finally { await s.f.close(); }
  });

  it("转本人的那条，被问的人更正之后算已答，从他的等你里消掉", async () => {
    const s = await setup();
    try {
      s.fake.impl.answer = async () => ({ answer: "手册里没写谁值守", handoff: true, reason: "值守安排要测试丙本人定", sources: [] });
      const { id, reply } = await s.answered();
      expect(await s.waiting()).toContain(`team-request:${id}`);
      // 转本人就是要本人亲自回：「没问题」不适用，状态不动。
      const ok = await s.review(id, reply.id, { verdict: "ok" });
      expect(ok.statusCode).toBe(409);
      expect(ok.json().code).toBe("BUDDY_HANDOFF");
      const still = (await s.read(id)).recipients[0];
      expect(still).toMatchObject({ status: "pending", buddy: { state: "handoff", handoffBy: "buddy" } });
      expect(still.replies[0]).not.toHaveProperty("reviewedAt");
      expect(await s.waiting()).toContain(`team-request:${id}`);
      expect((await s.review(id, reply.id, { clientId: randomUUID(), verdict: "corrected", text: "我来值守" })).statusCode).toBe(200);
      expect((await s.read(id)).recipients[0].status).toBe("answered");
      expect(await s.waiting()).not.toContain(`team-request:${id}`);
    } finally { await s.f.close(); }
  });

  it("伙伴在答追问时被问的人改了上一条：追问照旧在，作业照常落答复，更正照常进问的人等你", async () => {
    const s = await setup();
    try {
      const { id, reply } = await s.answered();
      const trigger = s.lastId((await s.followUp(id, "那回滚怎么做")).json().delivery);
      expect((await s.review(id, reply.id, { clientId: randomUUID(), verdict: "corrected", text: "要拆五件，回滚在第五件" })).statusCode).toBe(200);
      expect((await s.read(id)).recipients[0]).toMatchObject({ status: "pending", buddy: { state: "answering" } });
      expect(await s.waitingItems(s.f.member)).toContainEqual(expect.objectContaining({ id: `team-request:${id}`, title: "更正：部署怎么拆" }));
      await s.run(id, trigger);
      expect(await s.buddyRows(id)).toHaveLength(2);
      expect(s.fake.seen.answer.at(-1)!.thread.map(({ by }) => by)).toEqual(["asker", "buddy", "asker", "owner"]);
      expect((await s.read(id)).recipients[0]).toMatchObject({ status: "pending", buddy: { state: "answered" } });
    } finally { await s.f.close(); }
  });

  it("追问没答上来时被问的人改了上一条：仍能重试，重试答的还是那条追问", async () => {
    const s = await setup();
    try {
      const { id, reply } = await s.answered();
      const trigger = s.lastId((await s.followUp(id, "那回滚怎么做")).json().delivery);
      s.fake.impl.pick = async () => { throw new Error("模型挂了"); };
      await s.run(id, trigger);
      expect((await s.review(id, reply.id, { clientId: randomUUID(), verdict: "corrected", text: "要拆五件" })).statusCode).toBe(200);
      expect((await s.read(id)).recipients[0]).toMatchObject({ status: "pending", buddy: { state: "failed", note: "伙伴没答上来" } });
      expect(await s.waiting()).not.toContain(`team-request:${id}`);
      expect(await s.waitingItems(s.f.member)).toContainEqual(expect.objectContaining({ id: `team-request:${id}`, title: "更正：部署怎么拆" }));
      expect((await s.action(id, "retry")).json().delivery.recipients[0].buddy.state).toBe("answering");
      s.fake.impl.pick = async () => ({ itemIds: ["note"] });
      await s.run(id, trigger);
      expect(await s.buddyRows(id)).toHaveLength(2);
      expect((await s.read(id)).recipients[0].buddy?.state).toBe("answered");
    } finally { await s.f.close(); }
  });

  it("追问被伙伴转本人后，被问的人改的是更早那条：追问仍在他的等你，问的人卡上不显示已答", async () => {
    const s = await setup();
    try {
      const { id, reply } = await s.answered();
      const trigger = s.lastId((await s.followUp(id, "谁来值守")).json().delivery);
      s.fake.impl.answer = async () => ({ answer: "手册里没写谁值守", handoff: true, reason: "值守安排要测试丙本人定", sources: [] });
      await s.run(id, trigger);
      expect(await s.waiting()).toContain(`team-request:${id}`);
      expect((await s.review(id, reply.id, { clientId: randomUUID(), verdict: "corrected", text: "要拆五件" })).statusCode).toBe(200);
      expect((await s.read(id)).recipients[0]).toMatchObject({ status: "pending", buddy: { state: "handoff", handoffBy: "buddy" } });
      expect(await s.f.t.sql("SELECT status,done_by FROM request_recipients WHERE request_id=$1", [id])).toEqual([{ status: "pending", done_by: null }]);
      expect(await s.waiting()).toContain(`team-request:${id}`);
      expect(await s.waitingItems(s.f.member)).toContainEqual(expect.objectContaining({ id: `team-request:${id}`, title: "更正：部署怎么拆" }));
    } finally { await s.f.close(); }
  });

  it("被问的人改的正是转本人的那条：算他亲自回了追问，已答，从他的等你里消掉", async () => {
    const s = await setup();
    try {
      const { id } = await s.answered();
      const trigger = s.lastId((await s.followUp(id, "谁来值守")).json().delivery);
      s.fake.impl.answer = async () => ({ answer: "手册里没写谁值守", handoff: true, reason: "值守安排要测试丙本人定", sources: [] });
      await s.run(id, trigger);
      const handoff = (await s.read(id)).recipients[0].replies.at(-1)!;
      expect(handoff).toMatchObject({ origin: "buddy", text: "手册里没写谁值守" });
      expect((await s.review(id, handoff.id, { clientId: randomUUID(), verdict: "corrected", text: "我来值守" })).statusCode).toBe(200);
      expect((await s.read(id)).recipients[0].status).toBe("answered");
      expect(await s.waiting()).not.toContain(`team-request:${id}`);
    } finally { await s.f.close(); }
  });

  it("问的人补充说明以后，被问的人改旧答复：不算答了这次补充说明", async () => {
    const s = await setup();
    try {
      const { id, reply } = await s.answered();
      const send = (body: object, cookie: string) => s.f.call("POST", `${base}/${id}/replies`, { clientId: randomUUID(), ...body }, cookie);
      expect((await send({ status: "needs_info", text: "要按哪个环境拆" }, s.third)).statusCode).toBe(200);
      expect((await send({ status: "clarification", recipientId: THIRD.personId, text: "按生产环境" }, s.f.member)).statusCode).toBe(200);
      expect((await s.review(id, reply.id, { clientId: randomUUID(), verdict: "corrected", text: "要拆五件" })).statusCode).toBe(200);
      expect((await s.read(id)).recipients[0].status).toBe("pending");
      expect(await s.f.t.sql("SELECT status,done_by FROM request_recipients WHERE request_id=$1", [id])).toEqual([{ status: "pending", done_by: null }]);
    } finally { await s.f.close(); }
  });

  it("伙伴答完后被问的人自己回需要补充，问的人补充说明：进被问的人的等你，伙伴那条仍标伙伴答的", async () => {
    const s = await setup();
    try {
      const { id, reply } = await s.answered();
      const send = (body: object, cookie: string) => s.f.call("POST", `${base}/${id}/replies`, { clientId: randomUUID(), ...body }, cookie);
      expect((await send({ status: "needs_info", text: "要按哪个环境拆" }, s.third)).statusCode).toBe(200);
      expect((await send({ status: "clarification", recipientId: THIRD.personId, text: "按生产环境" }, s.f.member)).statusCode).toBe(200);
      expect(await s.waiting()).toContain(`team-request:${id}`);
      const recipient = (await s.read(id)).recipients[0];
      expect(recipient.status).toBe("pending");
      // 本人接手后伙伴状态清掉；卡上每条的来源照旧按回复自己的 origin。
      expect(recipient).not.toHaveProperty("buddy");
      expect(recipient.replies[0]).toMatchObject({ id: reply.id, origin: "buddy" });
      for (const cookie of [s.f.member, s.third]) expect((await s.read(id, cookie)).recipients[0].replies.map((item) => item.origin ?? null)).toEqual(["buddy", null, null]);
    } finally { await s.f.close(); }
  });

  it("追问超上限时被问的人改了上一条：仍能问本人，进被问的人的等你", async () => {
    const s = await setup();
    try {
      const { id, reply } = await s.answered();
      await s.used(id, 19);
      await s.followUp(id, "那回滚怎么做");
      expect((await s.review(id, reply.id, { clientId: randomUUID(), verdict: "corrected", text: "要拆五件" })).statusCode).toBe(200);
      expect((await s.read(id)).recipients[0]).toMatchObject({ status: "pending", buddy: { state: "limited" } });
      const asked = await s.action(id, "ask-owner");
      expect(asked.statusCode, asked.body).toBe(200);
      expect(await s.waiting()).toContain(`team-request:${id}`);
      // 问的人转本人的那条：伙伴的答复上「没问题」也不适用。
      expect((await s.review(id, reply.id, { verdict: "ok" })).json().code).toBe("BUDDY_HANDOFF");
    } finally { await s.f.close(); }
  });
});
