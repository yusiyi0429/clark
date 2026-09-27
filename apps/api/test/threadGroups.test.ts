import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/migrate.js";
import { postThreadIntro, type ThreadIntroAgent } from "../src/threadIntro.js";
import { call, executionFixture, newTask } from "./executionFixture.js";
import { createTestApp, TEST_CEO, TEST_MEMBER } from "./helpers.js";

const waitFor = async (check: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("background introduction did not arrive");
};

describe("议题与会议群", () => {
  it("执行事项在群成员入口拉人时仍发送协作邀请通知", async () => {
    const f = await executionFixture();
    try {
      const task = (await call(f, f.member, "POST", "/api/me/tasks", newTask(null))).json();
      const id = task.id as string;
      expect((await call(f, f.member, "POST", `/api/threads/task/${id}/members`, { personIds: ["person-fixture-003"] })).statusCode).toBe(200);
      expect((await call(f, f.third, "GET", "/api/me/notifications")).json().notifications[0]).toMatchObject({
        kind: "task_collaborator_added", objectType: "task", objectId: id,
      });
      await waitFor(async () => (await f.t.sql("SELECT 1 FROM thread_messages WHERE object_type='task' AND object_id=$1", [id])).length === 1);
      expect((await call(f, f.member, "GET", `/api/me/tasks/${id}`)).json().task.version).toBe(task.version + 1);
      expect((await call(f, f.third, "POST", `/api/threads/task/${id}/leave`)).statusCode).toBe(204);
      expect((await call(f, f.member, "GET", `/api/me/tasks/${id}`)).json().task.version).toBe(task.version + 2);
      expect((await call(f, f.third, "GET", `/api/threads/task/${id}`)).statusCode).toBe(404);
    } finally { await f.t.close(); }
  });

  it("039 为已有会议补建主持人与参会人的群成员", async () => {
    const t = await createTestApp();
    const id = "11111111-1111-4111-8111-111111111111";
    try {
      await t.sql(`INSERT INTO meetings
        (id, version, title, status, scheduled_at, ends_at, lead_dri_id, ceo_participant_id,
         participants, issue_ids, preflight, draft, origin_ref)
        VALUES ($1, 1, '旧会议', 'scheduled', now(), now() + interval '1 hour', $2, $3,
          $4::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
      [id, TEST_MEMBER.personId, TEST_CEO.personId, JSON.stringify([{ personId: TEST_MEMBER.personId }, { personId: TEST_CEO.personId }])]);
      await t.sql("DELETE FROM schema_migrations WHERE id=39");
      const client = await t.pool.connect();
      try { await migrate(client); } finally { client.release(); }
      const members = await t.sql("SELECT person_id FROM thread_members WHERE object_type='meeting' AND object_id=$1 ORDER BY person_id", [id]);
      expect(members.map((row) => row.person_id)).toEqual([TEST_CEO.personId, TEST_MEMBER.personId]);
    } finally { await t.close(); }
  });

  it("CEO 首次拉人成群、成员只读访问、通知、介绍未读与退出后再拉", async () => {
    const seen: string[][] = [];
    let agentObject: Record<string, unknown> | null = null;
    const agent: ThreadIntroAgent = { async generate(input) { seen.push(input.newcomers); return { message: `欢迎${input.newcomers.join("、")}，请先看议题进展。` }; } };
    const t = await createTestApp({}, { async run(input) { agentObject = input.currentObject as Record<string, unknown>;
      return { assistantMessage: "已看到议题", runtimeEntries: input.runtimeEntries }; } }, { threadIntroAgent: agent });
    try {
      const issue = await t.createIssue();
      const id = issue.objectRef.id;
      const url = `/api/threads/issue/${id}`;
      const ceo = await t.loginCookie(), member = await t.memberCookie();
      const get = (path: string, cookie: string) => t.app.inject({ method: "GET", url: path, headers: { cookie } });
      const post = (path: string, cookie: string, payload?: unknown) => t.app.inject({ method: "POST", url: path,
        headers: { cookie, origin: t.publicOrigin }, ...(payload ? { payload } : {}) });
      expect((await get(`/api/me/cards/issues/${id}`, member)).statusCode).toBe(404);
      expect((await get(url, ceo)).statusCode).toBe(404);
      const candidates = (await get(`${url}/candidates`, ceo)).json().people;
      expect(candidates).toContainEqual({ personId: TEST_MEMBER.personId, displayName: "测试乙" });
      expect(candidates).not.toContainEqual(expect.objectContaining({ personId: TEST_CEO.personId }));
      expect((await post(`${url}/members`, ceo, { personIds: [TEST_CEO.personId] })).statusCode).toBe(400);
      expect((await get(url, ceo)).statusCode).toBe(404);
      const joined = await post(`${url}/members`, ceo, { personIds: [TEST_MEMBER.personId], note: "请一起判断渠道窗口" });
      expect(joined.statusCode).toBe(200);
      expect(joined.json().members.map((item: { personId: string }) => item.personId)).toEqual([TEST_CEO.personId, TEST_MEMBER.personId]);
      await waitFor(async () => (await t.sql("SELECT 1 FROM thread_messages WHERE object_type='issue' AND object_id=$1", [id])).length === 1);
      expect(seen).toEqual([["测试乙"]]);
      expect((await get(url, member)).json()).toMatchObject({ unread: 1 });
      expect((await get(url, ceo)).json()).toMatchObject({ unread: 0 });
      const card = (await get(`/api/me/cards/issues/${id}`, member)).json();
      expect(card.actions).toEqual([]);
      expect(card.payload.whyNow).toBe("渠道窗口将在六月关闭");
      expect(card.payload).not.toHaveProperty("originRef");
      const agentTurn = await t.app.inject({ method: "POST", url: `/api/conversations/issue:${id}/messages`,
        headers: { cookie: member, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "说说这个议题" } });
      expect(agentTurn.statusCode).toBe(200);
      expect(agentObject?.payload).toMatchObject({ whyNow: "渠道窗口将在六月关闭" });
      expect(agentObject?.payload).not.toHaveProperty("originRef");
      const notice = (await get("/api/me/notifications", member)).json().notifications;
      expect(notice[0]).toMatchObject({ kind: "thread_member_added", objectType: "issue", objectId: id });
      expect(notice[0].text).toContain("拉你进议题");
      expect((await get("/api/me/threads/unread", member)).json().threads[0]).toMatchObject({ objectType: "issue", objectId: id, unread: 1, href: `/me/issues/${id}` });
      expect((await post(`${url}/leave`, ceo)).statusCode).toBe(409);
      expect((await post(`${url}/leave`, member)).statusCode).toBe(204);
      expect((await get(`/api/me/cards/issues/${id}`, member)).statusCode).toBe(404);
      expect((await post(`${url}/members`, ceo, { personIds: [TEST_MEMBER.personId] })).statusCode).toBe(200);
      expect((await get(`/api/me/cards/issues/${id}`, member)).statusCode).toBe(200);
    } finally { await t.close(); }
  });

  it("会议创建时建群，成员能看会议安排与只读卡片", async () => {
    let agentObject: Record<string, unknown> | null = null;
    const t = await createTestApp({}, { async run(input) { agentObject = input.currentObject as Record<string, unknown>;
      return { assistantMessage: "已看到会议", runtimeEntries: input.runtimeEntries }; } },
    { preflightAgent: { async generate() { return { candidate: {} }; } } });
    try {
      const issue = await t.createIssue();
      const member = await t.memberCookie(), ceo = await t.loginCookie();
      const created = await t.app.inject({ method: "POST", url: "/api/dri/meetings",
        headers: { authorization: `Bearer ${t.env.driServiceToken}` }, payload: {
          externalId: "thread-meeting-1", title: "渠道会议", scheduledAt: "2027-01-01T10:00:00.000+08:00", leadDriId: TEST_MEMBER.personId,
          ceoParticipantId: TEST_CEO.personId, participants: [TEST_MEMBER.personId], issueIds: [issue.objectRef.id],
        } });
      expect(created.statusCode).toBe(201);
      const id = created.json().cards[0].objectRef.id as string;
      const members = (await t.app.inject({ method: "GET", url: `/api/threads/meeting/${id}`, headers: { cookie: member } })).json().members;
      expect(members.map((item: { personId: string }) => item.personId).sort()).toEqual([TEST_CEO.personId, TEST_MEMBER.personId].sort());
      await waitFor(async () => (await t.sql("SELECT 1 FROM thread_messages WHERE object_type='meeting' AND object_id=$1", [id])).length === 1);
      expect((await t.app.inject({ method: "GET", url: `/api/threads/meeting/${id}`, headers: { cookie: member } })).json().unread).toBe(0);
      expect((await t.app.inject({ method: "GET", url: `/api/threads/meeting/${id}`, headers: { cookie: ceo } })).json().unread).toBe(1);
      const card = (await t.app.inject({ method: "GET", url: `/api/me/cards/meetings/${id}`, headers: { cookie: member } })).json();
      expect(card.actions).toEqual([]);
      expect(card.payload).not.toHaveProperty("transcriptCandidate");
      expect(card.payload).not.toHaveProperty("recording");
      const agentTurn = await t.app.inject({ method: "POST", url: `/api/conversations/meeting:${id}/messages`,
        headers: { cookie: member, origin: t.publicOrigin, accept: "text/event-stream" }, payload: { message: "说说会议安排" } });
      expect(agentTurn.statusCode).toBe(200);
      expect(agentObject?.payload).toMatchObject({ purpose: "渠道会议" });
      expect(agentObject?.payload).not.toHaveProperty("draft");
      expect(agentObject?.payload).not.toHaveProperty("recording");
      expect((await t.app.inject({ method: "GET", url: "/api/me/meetings", headers: { cookie: member } })).json().meetings[0]).toMatchObject({ meetingId: id, href: `/me/meetings/${id}` });
      expect((await t.app.inject({ method: "POST", url: `/api/threads/meeting/${id}/leave`, headers: { cookie: member, origin: t.publicOrigin } })).statusCode).toBe(409);
      expect((await t.app.inject({ method: "POST", url: `/api/threads/meeting/${id}/leave`, headers: { cookie: ceo, origin: t.publicOrigin } })).statusCode).toBe(204);
      expect((await t.app.inject({ method: "GET", url: `/api/threads/meeting/${id}`, headers: { cookie: ceo } })).statusCode).toBe(404);
      expect((await t.app.inject({ method: "POST", url: `/api/threads/meeting/${id}/members`, headers: { cookie: member, origin: t.publicOrigin },
        payload: { personIds: [TEST_CEO.personId] } })).statusCode).toBe(200);
      expect((await t.app.inject({ method: "GET", url: `/api/threads/meeting/${id}`, headers: { cookie: ceo } })).statusCode).toBe(200);
    } finally { await t.close(); }
  }, 15_000);

  it("会议更换主持人时把新主持人同步进群", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket08-people-"));
    const people = join(dir, "company-people.json");
    await writeFile(people, JSON.stringify({ schemaVersion: "company-people.v1", people: [
      { personId: TEST_CEO.personId, displayName: "测试甲", roles: ["ceo"] },
      { personId: TEST_MEMBER.personId, displayName: "测试乙", roles: ["dri", "participant"] },
      { personId: "person-fixture-003", displayName: "测试丙", roles: ["dri", "participant"] },
    ] }));
    const t = await createTestApp({ companyPeopleSeed: people }, undefined,
      { preflightAgent: { async generate() { return { candidate: {} }; } } });
    try {
      const issue = await t.createIssue();
      const created = await t.app.inject({ method: "POST", url: "/api/dri/meetings",
        headers: { authorization: `Bearer ${t.env.driServiceToken}` }, payload: {
          externalId: "thread-edit-host", title: "换主持会议", scheduledAt: "2027-01-01T10:00:00.000+08:00",
          leadDriId: TEST_MEMBER.personId, ceoParticipantId: TEST_CEO.personId,
          participants: [TEST_MEMBER.personId], issueIds: [issue.objectRef.id],
        } });
      expect(created.statusCode).toBe(201);
      const card = created.json().cards[0];
      const action = card.actions.find((item: { actionType: string }) => item.actionType === "meeting.edit_details");
      const ceo = await t.loginCookie();
      const edited = await t.app.inject({ method: "POST", url: "/api/actions/execute",
        headers: { cookie: ceo, origin: t.publicOrigin }, payload: { actionId: action.actionId,
          input: { leadDriId: "person-fixture-003" } } });
      expect(edited.statusCode).toBe(200);
      const members = await t.sql("SELECT person_id FROM thread_members WHERE object_type='meeting' AND object_id=$1 AND left_at IS NULL ORDER BY person_id", [card.objectRef.id]);
      expect(members.map((row) => row.person_id)).toEqual([TEST_CEO.personId, TEST_MEMBER.personId, "person-fixture-003"]);
      await waitFor(async () => (await t.sql("SELECT 1 FROM thread_messages WHERE object_type='meeting' AND object_id=$1", [card.objectRef.id])).length >= 2);
    } finally { await t.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("模型失败和超时都用兜底说明，新人未读而拉人者已读", async () => {
    const t = await createTestApp();
    try {
      const issue = await t.createIssue();
      const id = issue.objectRef.id;
      await t.sql("INSERT INTO thread_members(object_type,object_id,person_id,added_by) VALUES('issue',$1,$2,$2),('issue',$1,$3,$2)", [id, TEST_CEO.personId, TEST_MEMBER.personId]);
      const input = { objectType: "issue" as const, objectId: id, title: "渠道议题", description: "窗口即将关闭", inviter: "测试甲", newcomers: ["测试乙"], note: "一起看", history: [] };
      await postThreadIntro(t.pool, { async generate() { throw new Error("model failed"); } }, input, [TEST_CEO.personId], 30);
      await postThreadIntro(t.pool, { generate() { return new Promise(() => undefined); } }, input, [TEST_CEO.personId], 30);
      const messages = await t.sql("SELECT content FROM thread_messages WHERE object_type='issue' AND object_id=$1 ORDER BY id", [id]);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toContain("测试甲说：「一起看」");
      expect(messages[1].content).toContain("窗口即将关闭");
      const member = await t.memberCookie(), ceo = await t.loginCookie();
      expect((await t.app.inject({ method: "GET", url: `/api/threads/issue/${id}`, headers: { cookie: member } })).json().unread).toBe(2);
      expect((await t.app.inject({ method: "GET", url: `/api/threads/issue/${id}`, headers: { cookie: ceo } })).json().unread).toBe(0);
    } finally { await t.close(); }
  });
});
