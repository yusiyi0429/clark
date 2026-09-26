import { describe, expect, it } from "vitest";
import { TEST_CEO, TEST_MEMBER, createTestApp, type TestApp } from "./helpers.js";

const THREAD = "/api/threads/issue/thread-obj-1";

/** 2a 没有加人接口：测试直接写入群成员。 */
async function addMember(t: TestApp, personId: string, leftAt: string | null = null): Promise<void> {
  await t.sql(
    "INSERT INTO thread_members (object_type, object_id, person_id, added_by, left_at) VALUES ('issue', 'thread-obj-1', $1, $2, $3)",
    [personId, TEST_CEO.personId, leftAt],
  );
}

describe("通用群组存取与接口", () => {
  it("非成员（含已退出的人）一律 404 THREAD_NOT_FOUND", async () => {
    const t = await createTestApp();
    try {
      await addMember(t, TEST_CEO.personId);
      await addMember(t, TEST_MEMBER.personId, new Date().toISOString());
      const member = await t.memberCookie();
      const attempts = [
        await t.app.inject({ method: "GET", url: THREAD, headers: { cookie: member } }),
        await t.app.inject({ method: "GET", url: `${THREAD}/messages?after=0`, headers: { cookie: member } }),
        await t.app.inject({ method: "POST", url: `${THREAD}/messages`, headers: { cookie: member, origin: t.publicOrigin }, payload: { content: "我能说话吗" } }),
        await t.app.inject({ method: "POST", url: `${THREAD}/read`, headers: { cookie: member, origin: t.publicOrigin }, payload: { lastReadId: 1 } }),
      ];
      for (const attempt of attempts) {
        expect(attempt.statusCode).toBe(404);
        expect(attempt.json()).toMatchObject({ code: "THREAD_NOT_FOUND" });
      }
      // CEO 不是某个群的成员时同样 404
      const other = await t.app.inject({ method: "GET", url: "/api/threads/issue/thread-obj-2", headers: { cookie: await t.loginCookie() } });
      expect(other.statusCode).toBe(404);
      expect((await t.app.inject({ method: "GET", url: THREAD })).statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it("成员能读能发；after 增量正确；read 只增不减；未读不计自己发的", async () => {
    const t = await createTestApp();
    try {
      await addMember(t, TEST_CEO.personId);
      await addMember(t, TEST_MEMBER.personId);
      const ceo = await t.loginCookie();
      const member = await t.memberCookie();
      const post = (cookie: string, payload: unknown) => t.app.inject({
        method: "POST", url: `${THREAD}/messages`, headers: { cookie, origin: t.publicOrigin }, payload,
      });
      const view = async (cookie: string) => (await t.app.inject({ method: "GET", url: THREAD, headers: { cookie } })).json();

      const first = await post(ceo, { content: "请看渠道数据", quote: { text: "东南亚渠道预算追加 15%" } });
      expect(first.statusCode).toBe(201);
      const firstId = first.json().id as number;
      expect(first.json()).toMatchObject({
        kind: "member", authorId: TEST_CEO.personId, authorName: "测试甲",
        content: "请看渠道数据", quote: { text: "东南亚渠道预算追加 15%" },
      });

      const memberView = await view(member);
      expect(memberView).toMatchObject({ lastReadId: 0, unread: 1 });
      expect(memberView.members).toEqual([
        { personId: TEST_CEO.personId, displayName: "测试甲", title: "CEO" },
        { personId: TEST_MEMBER.personId, displayName: "测试乙", title: "DRI" },
      ]);
      expect(memberView.messages.map((message: { id: number }) => message.id)).toEqual([firstId]);

      const second = await post(member, { content: "收到" });
      expect(second.statusCode).toBe(201);
      const secondId = second.json().id as number;
      expect(second.json()).toMatchObject({ kind: "member", authorId: TEST_MEMBER.personId, quote: null });
      // 自己发的不算未读
      expect((await view(member)).unread).toBe(1);
      expect((await view(ceo)).unread).toBe(1);

      const after = async (id: number) => (await t.app.inject({
        method: "GET", url: `${THREAD}/messages?after=${id}`, headers: { cookie: member },
      })).json().messages.map((message: { content: string }) => message.content);
      expect(await after(0)).toEqual(["请看渠道数据", "收到"]);
      expect(await after(firstId)).toEqual(["收到"]);
      expect(await after(secondId)).toEqual([]);

      const read = (lastReadId: number) => t.app.inject({
        method: "POST", url: `${THREAD}/read`, headers: { cookie: member, origin: t.publicOrigin }, payload: { lastReadId },
      });
      const marked = await read(firstId);
      expect(marked.statusCode).toBe(200);
      expect(marked.json()).toEqual({ lastReadId: firstId, unread: 0 });
      // 只增不减
      expect((await read(0)).json()).toEqual({ lastReadId: firstId, unread: 0 });
      // 不超过群里已有的最后一条，之后的新消息仍算未读
      expect((await read(secondId + 1000)).json()).toEqual({ lastReadId: secondId, unread: 0 });
      await post(ceo, { content: "第三条" });
      expect((await view(member))).toMatchObject({ lastReadId: secondId, unread: 1 });
    } finally {
      await t.close();
    }
  });

  it("消息纯文字 1–4000 字，客户端冒充不了 Co-Agent", async () => {
    const t = await createTestApp();
    try {
      await addMember(t, TEST_CEO.personId);
      const ceo = await t.loginCookie();
      const post = (payload: unknown) => t.app.inject({
        method: "POST", url: `${THREAD}/messages`, headers: { cookie: ceo, origin: t.publicOrigin }, payload,
      });
      expect((await post({ content: "" })).statusCode).toBe(400);
      expect((await post({ content: "字".repeat(4001) })).statusCode).toBe(400);
      expect((await post({ content: "字".repeat(4000) })).statusCode).toBe(201);
      // 多余字段按 Fastify 默认被剥掉：消息仍以本人名义、成员身份写入
      const forged = await post({ content: "冒充", kind: "co-agent", authorId: null });
      expect(forged.statusCode).toBe(201);
      expect(forged.json()).toMatchObject({ kind: "member", authorId: TEST_CEO.personId });
    } finally {
      await t.close();
    }
  });
});
