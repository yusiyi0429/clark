import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AnswerInput, ColleagueAnswerAgent, PickInput } from "../src/colleagueAnswerAgent.js";
import { dbScopeSource, scopeReader, type OwnerRows, type ScopeSource } from "../src/colleagueScope.js";
import { createJobWorker } from "../src/jobs.js";
import { answerForColleague } from "../src/teamBuddyAnswers.js";
import { TEAM_BUDDY_ANSWER_JOB } from "../src/teamDeliveries.js";
import { BOARD_NOW, BOARD_TASKS, boardFixture, THIRD } from "./boardFixture.js";
import { TEST_CEO, TEST_MEMBER } from "./helpers.js";

const base = "/api/me/team-deliveries";
/** 这一组要两边都被覆盖（补充条款 A1）：丙改成 DRI；丁是参与人，用来测不被覆盖的。 */
const FOURTH = "person-fixture-004";
let seedPath: Promise<string> | undefined;
const peopleSeed = () => seedPath ??= (async () => {
  const path = join(await mkdtemp(join(tmpdir(), "buddy-people-")), "people.json");
  await writeFile(path, JSON.stringify({ schemaVersion: "company-people.v1", people: [
    { personId: TEST_CEO.personId, displayName: "测试甲", roles: ["ceo"] },
    { personId: TEST_MEMBER.personId, displayName: "测试乙", roles: ["dri", "participant"] },
    { personId: THIRD.personId, displayName: "测试丙", roles: ["dri"] },
    { personId: FOURTH, displayName: "测试丁", roles: ["participant"] },
  ] }));
  return path;
})();

type Answer = Awaited<ReturnType<ColleagueAnswerAgent["answer"]>>;
type Pick = Awaited<ReturnType<ColleagueAnswerAgent["pick"]>>;
type Reply = { status: string; text: string; origin?: string };
type Recipient = { personId: string; status: string; buddy?: { state: string; note: string | null; askedAt: string }; replies: Reply[] };
type Delivery = { id: string; recipients: Recipient[] };

/** 记下每次输入的假代答；返回值按用例改 impl。 */
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
  /** 问的人是测试乙，被问的是丙。 */
  const ask = async (extra: object = {}, cookie = f.member) => {
    const res = await f.call("POST", base, { clientId: randomUUID(), kind: "question", recipientIds: [THIRD.personId], text: "部署怎么拆", ...extra }, cookie);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().delivery as Delivery;
  };
  const read = async (id: string, cookie = f.member) => (await f.call("GET", `${base}/${id}`, undefined, cookie)).json().delivery as Delivery;
  const run = (id: string) => f.t.app.teamBuddyAnswerJobs[TEAM_BUDDY_ANSWER_JOB]({ requestId: id, recipientId: THIRD.personId, triggerId: null }, {} as never);
  const jobKeys = async (id: string) => (await f.t.sql("SELECT dedupe_key FROM jobs WHERE dedupe_key LIKE $1 ORDER BY id", [`team.buddy-answer:${id}:%`]))
    .map((row) => row.dedupe_key as string);
  const waiting = async (cookie = third) => ((await f.call("GET", "/api/me/work-home", undefined, cookie)).json().waiting as { id: string }[]).map((item) => item.id);
  const buddyRows = async (id: string) => f.t.sql("SELECT author_id,body FROM team_delivery_replies WHERE request_id=$1 AND origin='buddy'", [id]);
  const action = (id: string, name: "retry" | "ask-owner", cookie = f.member) => f.call("POST", `${base}/${id}/recipients/${THIRD.personId}/buddy/${name}`, {}, cookie);
  return { f, fake, third, ask, read, run, jobKeys, waiting, buddyRows, action };
}

describe("同事来问，伙伴先答", { timeout: 60_000 }, () => {
  it("问一句：建单时标伙伴在答并入队；跑完落一条伙伴答复，记成伙伴答的，不进被问的人的等你", async () => {
    const s = await setup();
    try {
      const sent = await s.ask();
      expect(sent.recipients[0]).toMatchObject({ status: "pending", buddy: { state: "answering", note: null, askedAt: BOARD_NOW.toISOString() } });
      expect(await s.jobKeys(sent.id)).toEqual([`team.buddy-answer:${sent.id}:${THIRD.personId}:q`]);
      expect(await s.waiting()).not.toContain(`team-request:${sent.id}`);
      await s.run(sent.id);
      const done = await s.read(sent.id);
      // A8：伙伴答了不算被问的人本人回复，收件人状态照旧是待回复，回复带来源。
      expect(done.recipients[0]).toMatchObject({ status: "pending", buddy: { state: "answered", note: null }, replies: [{ status: "answered", origin: "buddy" }] });
      expect(done.recipients[0].replies[0].text.startsWith("按拆分手册拆四件")).toBe(true);
      expect(done.recipients[0].replies[0].text).toContain("出处：说明（11/6）");
      expect(await s.f.t.sql("SELECT status,done_by FROM request_recipients WHERE request_id=$1", [sent.id])).toEqual([{ status: "pending", done_by: null }]);
      expect(await s.waiting()).not.toContain(`team-request:${sent.id}`);
      expect((await s.read(sent.id, s.third)).recipients[0]).toMatchObject({ buddy: { state: "answered" }, replies: [{ origin: "buddy" }] });
    } finally { await s.f.close(); }
  });

  it("入队就跑：首问、追问都不等轮询，发出时就把作业交给 runNow；作业照常排着兜底", async () => {
    const s = await setup();
    // 只用 runNow，不 start、不 tick：作业跑完就说明没等轮询。
    const worker = createJobWorker({ pool: s.f.t.pool, handlers: s.f.t.app.teamBuddyAnswerJobs });
    try {
      const started: Promise<unknown>[] = [];
      s.f.t.app.jobsNow.run = (jobId) => { const work = worker.runNow(jobId); started.push(work); return work; };
      const sent = await s.ask();
      expect(started).toHaveLength(1);
      expect(await started[0]).toBe(true);
      expect((await s.read(sent.id)).recipients[0]).toMatchObject({ buddy: { state: "answered" }, replies: [{ origin: "buddy" }] });
      expect(await s.f.t.sql("SELECT status FROM jobs WHERE dedupe_key=$1", [`team.buddy-answer:${sent.id}:${THIRD.personId}:q`])).toEqual([{ status: "done" }]);
      const followUp = await s.f.call("POST", `${base}/${sent.id}/replies`, { clientId: randomUUID(), status: "follow_up", recipientId: THIRD.personId, text: "那回滚怎么做" });
      expect(followUp.statusCode, followUp.body).toBe(200);
      expect(started).toHaveLength(2);
      expect(await started[1]).toBe(true);
      const replies = (await s.read(sent.id)).recipients[0].replies;
      expect(replies.map((reply) => reply.origin ?? reply.status)).toEqual(["buddy", "follow_up", "buddy"]);
    } finally { await worker.close(); await s.f.close(); }
  });

  it("给模型的只有范围里的材料和这次问答", async () => {
    const s = await setup();
    try {
      await s.f.t.sql(`INSERT INTO roles(id,owner_id,name,family,kind,duties_md) VALUES($1,$2,'内部技能','general','worker','CANARY-SKILL-41F7')`,
        [randomUUID(), THIRD.personId]);
      const sent = await s.ask();
      await s.run(sent.id);
      const reader = scopeReader(dbScopeSource({ q: s.f.t.pool.query.bind(s.f.t.pool), names: new Map([[THIRD.personId, "测试丙"]]), now: BOARD_NOW,
        planTasks: async (missions) => BOARD_TASKS.filter((task) => missions.some((mission) => mission.id === task.missionId)) }, THIRD.personId));
      const own = new Set((await reader.catalog()).entries.map((entry) => entry.itemId));
      const [pick] = s.fake.seen.pick;
      expect(pick.catalog.length).toBeGreaterThan(0);
      for (const entry of pick.catalog) expect(own.has(entry.itemId), entry.itemId).toBe(true);
      expect(pick).toMatchObject({ owner: "测试丙", asker: "测试乙", today: "2026-11-06", thread: [{ by: "asker", text: "部署怎么拆", at: expect.any(String) }] });
      expect(pick.thread).toHaveLength(1);
      expect(s.fake.seen.answer[0].materials.map((item) => item.itemId)).toEqual(["note"]);
      expect(JSON.stringify(pick)).not.toContain("CANARY-SKILL-41F7");
      expect(JSON.stringify(s.fake.seen.answer[0])).not.toContain("CANARY-SKILL-41F7");
    } finally { await s.f.close(); }
  });

  it("模型判要本人定：伙伴的话照落，转本人，进他的等你，卡上带原因", async () => {
    const s = await setup();
    try {
      s.fake.impl.answer = async () => ({ answer: "手册里没写谁值守", handoff: true, reason: "值守安排要测试丙本人定", sources: [] });
      const sent = await s.ask();
      await s.run(sent.id);
      const recipient = (await s.read(sent.id)).recipients[0];
      expect(recipient).toMatchObject({ status: "pending", buddy: { state: "handoff", note: "值守安排要测试丙本人定" }, replies: [{ origin: "buddy", text: "手册里没写谁值守" }] });
      expect(await s.waiting()).toContain(`team-request:${sent.id}`);
    } finally { await s.f.close(); }
  });

  it("没答上来不丢问题：模型出错、挑不出材料都不进被问的人的等你，问的人卡上有原因，能重试、能问本人", async () => {
    const s = await setup();
    try {
      s.fake.impl.pick = async () => { throw new Error("模型挂了"); };
      const broken = await s.ask();
      await s.run(broken.id);
      expect((await s.read(broken.id)).recipients[0]).toMatchObject({ status: "pending", buddy: { state: "failed", note: "伙伴没答上来" }, replies: [] });

      s.fake.impl.pick = async () => ({ itemIds: [] });
      const empty = await s.ask();
      await s.run(empty.id);
      expect((await s.read(empty.id)).recipients[0]).toMatchObject({ buddy: { state: "failed", note: "没有可读的资料" }, replies: [] });
      expect(s.fake.seen.answer).toHaveLength(0);
      expect(await s.waiting()).not.toContain(`team-request:${broken.id}`);
      expect(await s.waiting()).not.toContain(`team-request:${empty.id}`);

      // 只有问的人能点；重试重新入队，不重复占名额。
      expect((await s.action(broken.id, "retry", s.third)).statusCode).toBe(404);
      const retried = await s.action(broken.id, "retry");
      expect(retried.statusCode, retried.body).toBe(200);
      expect(retried.json().delivery.recipients[0]).toMatchObject({ buddy: { state: "answering", note: null } });
      expect(await s.jobKeys(broken.id)).toHaveLength(2);
      expect(await s.f.t.sql("SELECT count(*)::int AS n FROM team_buddy_asks WHERE recipient_id=$1", [THIRD.personId])).toEqual([{ n: 2 }]);
      expect((await s.action(broken.id, "retry")).statusCode).toBe(200);
      expect(await s.jobKeys(broken.id)).toHaveLength(2);
      s.fake.impl.pick = async () => ({ itemIds: ["note"] });
      await s.run(broken.id);
      expect((await s.read(broken.id)).recipients[0]).toMatchObject({ buddy: { state: "answered" }, replies: [{ origin: "buddy" }] });
      expect((await s.action(broken.id, "retry")).statusCode).toBe(409);

      // 问本人：变成普通征集，进被问的人的等你。
      const asked = await s.action(empty.id, "ask-owner");
      expect(asked.statusCode, asked.body).toBe(200);
      expect(asked.json().delivery.recipients[0]).toMatchObject({ status: "pending", buddy: { state: "handoff", note: "没有可读的资料" } });
      expect(await s.waiting()).toContain(`team-request:${empty.id}`);
      expect((await s.action(empty.id, "ask-owner")).statusCode).toBe(200);
      await s.run(empty.id);
      expect(await s.buddyRows(empty.id)).toEqual([]);
    } finally { await s.f.close(); }
  });

  it("超上限：发出时就不走模型，不进被问的人的等你；不能重试，只能问本人", async () => {
    const s = await setup();
    try {
      const anchor = (await s.f.call("POST", base, { clientId: randomUUID(), kind: "question", recipientIds: [THIRD.personId, TEST_CEO.personId], text: "别的征集" }))
        .json().delivery.id as string;
      const used = (count: number, asker: string, at: Date) => s.f.t.sql(`INSERT INTO team_buddy_asks(request_id,recipient_id,trigger_key,asker_id,asked_at)
        SELECT $1,$2,$5||g,$3,$4 FROM generate_series(1,$6::int) g`, [anchor, THIRD.personId, asker, at, randomUUID(), count]);
      // 公司时区的前一天（11/05 23:59）不算。
      await used(20, TEST_CEO.personId, new Date("2026-11-05T15:59:00.000Z"));
      expect((await s.ask()).recipients[0].buddy?.state).toBe("answering");
      await used(19, TEST_CEO.personId, new Date("2026-11-05T16:00:00.000Z"));

      const full = await s.ask();
      expect(full.recipients[0]).toMatchObject({ status: "pending", buddy: { state: "limited", note: "今天伙伴代答已到 20 次" } });
      expect(await s.jobKeys(full.id)).toEqual([]);
      expect(await s.waiting()).not.toContain(`team-request:${full.id}`);
      const retry = await s.action(full.id, "retry");
      expect(retry.statusCode).toBe(409);
      expect(retry.json().code).toBe("BUDDY_LIMIT");
      expect((await s.action(full.id, "ask-owner")).json().delivery.recipients[0]).toMatchObject({ buddy: { state: "handoff", note: "今天伙伴代答已到 20 次" } });
      expect(await s.waiting()).toContain(`team-request:${full.id}`);
      expect(s.fake.seen.pick).toHaveLength(0);

      // 同一个问的人对同一个被问的人每天 10 次：甲（CEO）问丙，乙已经问过 1 次，补到 10 次。
      await s.f.t.sql("DELETE FROM team_buddy_asks WHERE asker_id=$1", [TEST_CEO.personId]);
      const ceo = await s.f.t.loginCookie();
      await used(9, TEST_CEO.personId, BOARD_NOW);
      expect((await s.ask({}, ceo)).recipients[0].buddy?.state).toBe("answering");
      expect((await s.ask({}, ceo)).recipients[0]).toMatchObject({ buddy: { state: "limited", note: "今天问这位同事的伙伴已到 10 次" } });
      expect((await s.ask()).recipients[0].buddy?.state).toBe("answering");
    } finally { await s.f.close(); }
  });

  it("在答超过 2 分钟还没结果算没答上来：不进被问的人的等你，能重试、能问本人", async () => {
    const s = await setup();
    try {
      const sent = await s.ask();
      expect(await s.waiting()).not.toContain(`team-request:${sent.id}`);
      await s.f.t.sql("UPDATE request_recipients SET buddy_asked_at=$2::timestamptz - interval '3 minutes' WHERE request_id=$1", [sent.id, BOARD_NOW]);
      expect((await s.read(sent.id)).recipients[0]).toMatchObject({ buddy: { state: "failed", note: "伙伴没答上来" } });
      expect(await s.waiting()).not.toContain(`team-request:${sent.id}`);
      const asked = await s.action(sent.id, "ask-owner");
      expect(asked.json().delivery.recipients[0]).toMatchObject({ buddy: { state: "handoff", note: "伙伴没答上来" } });
      expect(await s.waiting()).toContain(`team-request:${sent.id}`);

      const other = await s.ask();
      expect((await s.action(other.id, "ask-owner")).statusCode).toBe(409);
      await s.f.t.sql("UPDATE request_recipients SET buddy_asked_at=$2::timestamptz - interval '3 minutes' WHERE request_id=$1", [other.id, BOARD_NOW]);
      expect((await s.action(other.id, "retry")).json().delivery.recipients[0]).toMatchObject({ buddy: { state: "answering", askedAt: BOARD_NOW.toISOString() } });
      expect(await s.jobKeys(other.id)).toHaveLength(2);
    } finally { await s.f.close(); }
  });

  it("同一个作业跑两遍只落一条；被问的人先自己回了，伙伴那条不落", async () => {
    const s = await setup();
    try {
      const sent = await s.ask();
      await s.run(sent.id);
      await s.run(sent.id);
      expect(await s.buddyRows(sent.id)).toEqual([{ author_id: THIRD.personId, body: expect.stringContaining("按拆分手册拆四件") }]);

      const other = await s.ask();
      const reply = await s.f.call("POST", `${base}/${other.id}/replies`, { clientId: randomUUID(), status: "answered", text: "我来答" }, s.third);
      expect(reply.statusCode, reply.body).toBe(200);
      await s.run(other.id);
      expect(await s.f.t.sql("SELECT origin,body FROM team_delivery_replies WHERE request_id=$1", [other.id])).toEqual([{ origin: "person", body: "我来答" }]);
      const recipient = (await s.read(other.id)).recipients[0];
      expect(recipient).toMatchObject({ status: "answered", replies: [{ text: "我来答" }] });
      expect(recipient).not.toHaveProperty("buddy");
      expect(recipient.replies[0]).not.toHaveProperty("origin");
    } finally { await s.f.close(); }
  });

  it("多个收件人、带附件、带截止、分享、问不被覆盖的人：都不经过伙伴，照旧进各人的等你", async () => {
    const s = await setup();
    try {
      await s.f.t.sql("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1,'ceshid','x',FALSE)", [FOURTH]);
      const many = await s.ask({ recipientIds: [THIRD.personId, TEST_CEO.personId] });
      const due = await s.ask({ dueAt: "2026-11-10T10:00:00.000Z" });
      const share = await s.ask({ kind: "share", text: "部署手册" });
      const outside = await s.ask({ recipientIds: [FOURTH] });
      const boundary = randomUUID();
      const payload = { clientId: randomUUID(), kind: "question", recipientIds: [THIRD.personId], text: "看下附件" };
      const body = "--" + boundary + '\r\nContent-Disposition: form-data; name="payload"\r\n\r\n' + JSON.stringify(payload) + "\r\n--" + boundary +
        '\r\nContent-Disposition: form-data; name="files"; filename="q.txt"\r\nContent-Type: application/octet-stream\r\n\r\n附件\r\n--' + boundary + "--\r\n";
      const attached = (await s.f.t.app.inject({ method: "POST", url: base, payload: Buffer.from(body),
        headers: { cookie: s.f.member, origin: s.f.t.publicOrigin, "content-type": "multipart/form-data; boundary=" + boundary } })).json().delivery as Delivery;
      for (const delivery of [many, due, share, outside, attached]) {
        for (const recipient of delivery.recipients) expect(recipient).not.toHaveProperty("buddy");
        expect(await s.jobKeys(delivery.id)).toEqual([]);
      }
      const waiting = await s.waiting();
      for (const delivery of [many, due, attached]) expect(waiting).toContain(`team-request:${delivery.id}`);
    } finally { await s.f.close(); }
  });

  it("收件人状态的算法对老数据不变：没回、要补充、发起人补充说明之后、本人答了", async () => {
    const s = await setup();
    try {
      const sent = await s.ask({ recipientIds: [THIRD.personId, TEST_CEO.personId] });
      const mine = async () => (await s.read(sent.id)).recipients.find((person) => person.personId === THIRD.personId)!.status;
      const reply = (input: object, cookie: string) => s.f.call("POST", `${base}/${sent.id}/replies`, { clientId: randomUUID(), ...input }, cookie);
      expect(await mine()).toBe("pending");
      expect((await reply({ status: "needs_info", text: "缺口径" }, s.third)).statusCode).toBe(200);
      expect(await mine()).toBe("needs_info");
      expect((await reply({ status: "clarification", recipientId: THIRD.personId, text: "按上月口径" }, s.f.member)).statusCode).toBe(200);
      expect(await mine()).toBe("pending");
      expect((await reply({ status: "answered", text: "好了" }, s.third)).statusCode).toBe(200);
      expect(await mine()).toBe("answered");
    } finally { await s.f.close(); }
  });
});

describe("一次代答（answerForColleague，不碰库）", () => {
  const rowsOf = (over: Partial<OwnerRows>): OwnerRows => ({ note: null, files: [], roles: [], tasks: [], deliverables: [], projects: [], sessions: [], outputs: [], ...over });
  const source = (rows: OwnerRows, bodies: Record<string, string | null>): ScopeSource => ({ owner: { personId: "p-owner", name: "晨星" },
    rows: async () => rows, body: async (entry) => bodies[entry.itemId] ?? null });
  const run = (agent: ColleagueAnswerAgent, src: ScopeSource) => answerForColleague({ agent, reader: scopeReader(src), asker: "测试乙", today: "2026-11-20",
    thread: [{ by: "asker", text: "部署怎么拆", at: "2026-11-20T02:00:00.000Z" }], ref: "r-1", signal: new AbortController().signal });
  const day = "2026-11-11T02:00:00.000Z";

  it("目录是空的、挑出来的不在目录里、挑出来的读不到正文：都是 empty，不调作答", async () => {
    const fake = fakeAgent();
    expect(await run(fake.agent, source(rowsOf({}), {}))).toEqual({ kind: "empty" });
    expect(fake.seen.pick).toHaveLength(0);
    fake.impl.pick = async () => ({ itemIds: ["file:nope"] });
    expect(await run(fake.agent, source(rowsOf({ note: { updatedAt: day } }), { note: "有说明" }))).toEqual({ kind: "empty" });
    fake.impl.pick = async () => ({ itemIds: ["note"] });
    expect(await run(fake.agent, source(rowsOf({ note: { updatedAt: day } }), { note: null }))).toEqual({ kind: "empty" });
    expect(fake.seen.answer).toHaveLength(0);
    expect(fake.seen.pick[1]).toMatchObject({ owner: "晨星", asker: "测试乙", catalog: [{ itemId: "note", kind: "note", title: "说明", updatedAt: day, under: null }] });
    expect(Object.keys(fake.seen.pick[1].catalog[0]).sort()).toEqual(["itemId", "kind", "title", "under", "updatedAt"]);
  });

  it("挑材料时目录带上一级：同名会话分得清在哪个项目", async () => {
    const fake = fakeAgent();
    const project = (id: string, name: string) => ({ id, name, scratch: false, archived: false, hidden: false, updatedAt: day });
    const session = (id: string, projectId: string) => ({ kind: "card" as const, id, title: "部署", projectId, trashed: false, archived: false, line: "停着" as const,
      updatedAt: day, author: null });
    await run(fake.agent, source(rowsOf({ note: { updatedAt: day }, projects: [project("pa", "天枢"), project("pb", "官网")],
      sessions: [session("sa", "pa"), session("sb", "pb")] }), { note: "说明" }));
    const sessions = fake.seen.pick[0].catalog.filter((entry) => entry.kind === "session");
    expect(sessions).toEqual([expect.objectContaining({ itemId: "session:card:sa", title: "部署", under: "project:pa" }),
      expect.objectContaining({ itemId: "session:card:sb", title: "部署", under: "project:pb" })]);
  });

  it("出处由天枢拼：只认材料里有的 itemId，写成「标题（月/日）」", async () => {
    const fake = fakeAgent();
    fake.impl.pick = async () => ({ itemIds: ["note", "file:f1"] });
    fake.impl.answer = async () => ({ answer: "按手册拆四件", handoff: false, reason: null, sources: ["note", "file:f1", "skill:编的"] });
    const rows = rowsOf({ note: { updatedAt: day }, files: [{ id: "f1", fileName: "拆分手册.md", createdAt: day }] });
    const result = await run(fake.agent, source(rows, { note: "说明正文", "file:f1": "手册正文" }));
    expect(result).toEqual({ kind: "answer", text: "按手册拆四件\n\n出处：说明（11/11）；拆分手册.md（11/11）", handoff: null, sources: ["note", "file:f1"] });
    fake.impl.answer = async () => ({ answer: "资料里没有", handoff: false, reason: null, sources: [] });
    expect(await run(fake.agent, source(rows, { note: "说明正文", "file:f1": "手册正文" }))).toEqual({ kind: "answer", text: "资料里没有", handoff: null, sources: [] });
  });

  it("给模型的材料每份最多 12000 字，合计最多 48000 字", async () => {
    const fake = fakeAgent();
    const files = Array.from({ length: 6 }, (_, index) => ({ id: `f${index}`, fileName: `文件${index}.md`, createdAt: day }));
    fake.impl.pick = async () => ({ itemIds: files.map((file) => `file:${file.id}`) });
    await run(fake.agent, source(rowsOf({ files }), Object.fromEntries(files.map((file) => [`file:${file.id}`, "字".repeat(20_000)]))));
    const { materials } = fake.seen.answer[0];
    expect(materials).toHaveLength(4);
    for (const item of materials) expect(item).toMatchObject({ text: "字".repeat(12_000), truncated: true });
  });

  it("转本人时带回模型给的原因", async () => {
    const fake = fakeAgent();
    fake.impl.answer = async () => ({ answer: "手册里没写谁值守", handoff: true, reason: "值守安排要本人定", sources: [] });
    const result = await run(fake.agent, source(rowsOf({ note: { updatedAt: day } }), { note: "说明" }));
    expect(result).toMatchObject({ kind: "answer", handoff: "值守安排要本人定" });
  });
});
