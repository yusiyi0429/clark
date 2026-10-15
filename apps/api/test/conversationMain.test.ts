import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_CEO, createTestApp, type TestApp } from "./helpers.js";
import type { ConversationRuntime } from "../src/conversations.js";

/** 手工构造单文件 multipart body；与浏览器表单字节一致。 */
function multipart(filename: string, content: string): { headers: Record<string, string>; payload: Buffer } {
  const boundary = `----vitest-${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: text/markdown\r\n\r\n`),
    Buffer.from(content, "utf8"),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body };
}

/** 假 runtime：记下每一轮收到的消息（含拼接的附件抽取文本）。 */
function recordingRuntime(): ConversationRuntime & { messages: string[]; references: unknown[][] } {
  const messages: string[] = [];
  const references: unknown[][] = [];
  return {
    messages, references,
    async run(input) {
      messages.push(input.message);
      references.push(input.references ?? []);
      input.emit({ type: "message", delta: "收到" });
      return { assistantMessage: "收到", runtimeEntries: [] };
    },
  };
}

async function withApp(runtime: ConversationRuntime, fn: (t: TestApp, attachmentDir: string) => Promise<void>): Promise<void> {
  const attachmentDir = await mkdtemp(join(tmpdir(), "warmap-conversation-main-"));
  const t = await createTestApp({ conversationAttachmentStorageDir: attachmentDir }, runtime);
  try {
    await fn(t, attachmentDir);
  } finally {
    await t.close();
    await rm(attachmentDir, { recursive: true, force: true });
  }
}

const send = (t: TestApp, cookie: string, payload: Record<string, unknown>) => t.app.inject({
  method: "POST", url: "/api/conversations/global/messages",
  headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" }, payload,
});

const upload = (t: TestApp, cookie: string, file: { headers: Record<string, string>; payload: Buffer }) => t.app.inject({
  method: "POST", url: "/api/conversations/global/attachments",
  headers: { cookie, origin: t.publicOrigin, ...file.headers }, payload: file.payload,
});

type HistoryMessage = {
  sequence: number;
  role: string;
  content: string;
  attachments: { id: string; fileName: string; extractedText?: string; sha256?: string; storageKey?: string }[];
};

const history = async (t: TestApp, cookie: string): Promise<HistoryMessage[]> =>
  (await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie } })).json().messages;

const liveConversations = (t: TestApp) =>
  t.sql("SELECT id, owner_id FROM conversations WHERE scope = 'global' AND deleted_at IS NULL ORDER BY created_at, id");

describe("每人每页一条主对话", () => {
  it("附件上传要求登录；scope 不存在 404；空 multipart 400 且不建对话", async () => {
    await withApp(recordingRuntime(), async (t) => {
      const empty = { "content-type": "multipart/form-data; boundary=----empty" };
      expect((await t.app.inject({
        method: "POST", url: "/api/conversations/global/attachments",
        headers: { origin: t.publicOrigin, ...empty }, payload: Buffer.from("------empty--\r\n"),
      })).statusCode).toBe(401);

      const cookie = await t.loginCookie();
      const missingScope = await t.app.inject({
        method: "POST", url: "/api/conversations/issue:11111111-1111-4111-8111-111111111111/attachments",
        headers: { cookie, origin: t.publicOrigin, ...empty }, payload: Buffer.from("------empty--\r\n"),
      });
      expect(missingScope.statusCode).toBe(404);
      expect(missingScope.json()).toMatchObject({ code: "CONVERSATION_SCOPE_NOT_FOUND" });

      const noFiles = await t.app.inject({
        method: "POST", url: "/api/conversations/global/attachments",
        headers: { cookie, origin: t.publicOrigin, ...empty }, payload: Buffer.from("------empty--\r\n"),
      });
      expect(noFiles.statusCode).toBe(400);
      expect(noFiles.json()).toMatchObject({ code: "INVALID_ATTACHMENT" });
      expect(await liveConversations(t)).toEqual([]);
    });
  });

  it("resolves signal:<id> scope: 200 for a real signal, 404 otherwise", async () => {
    await withApp(recordingRuntime(), async (t) => {
      const cookie = await t.loginCookie();
      const id = "22222222-2222-4222-8222-222222222222";
      await t.sql(
        `INSERT INTO signals
           (id, version, source_type, source_fingerprint, source_title, source_url, published_at, excerpt,
            source_ref, anchor_id, location, summary, strategic_impact, evidence_quote, unknowns, score)
         VALUES ($1, 1, 'web', $2, '公告', 'https://example.com/news', now(), '连续原文引文',
                 $3::jsonb, 'anchor-market', $4::jsonb, '信号摘要', '战略影响', '连续原文', '[]'::jsonb, $5::jsonb)`,
        [
          id,
          "c".repeat(64),
          JSON.stringify({ type: "web-search", provider: "recorded-web", query: "公告" }),
          JSON.stringify({ type: "company" }),
          JSON.stringify({ relevance: 4, impact: 3, urgency: 2 }),
        ],
      );

      const scope = `signal:${id}`;
      const messages = await t.app.inject({ method: "GET", url: `/api/conversations/${scope}/messages`, headers: { cookie } });
      expect(messages.statusCode).toBe(200);
      expect(messages.json()).toMatchObject({ scope, messages: [] });

      // 不存在的 signal（含非 UUID id）仍是 404，不能是 pg 类型错误 500。
      const missing = await t.app.inject({ method: "GET", url: "/api/conversations/signal:33333333-3333-4333-8333-333333333333/messages", headers: { cookie } });
      expect(missing.statusCode).toBe(404);
      const malformed = await t.app.inject({ method: "GET", url: "/api/conversations/signal:not-a-uuid/messages", headers: { cookie } });
      expect(malformed.statusCode).toBe(404);
    });
  });

  it("历史是一条连续列表：多轮对话都进同一条主对话，序号连续", async () => {
    await withApp(recordingRuntime(), async (t) => {
      const cookie = await t.loginCookie();
      expect((await send(t, cookie, { message: "第一问" })).statusCode).toBe(200);
      expect((await send(t, cookie, { message: "第二问" })).statusCode).toBe(200);

      const messages = await history(t, cookie);
      expect(messages.map((message) => [message.sequence, message.role, message.content])).toEqual([
        [1, "user", "第一问"],
        [2, "assistant", "收到"],
        [3, "user", "第二问"],
        [4, "assistant", "收到"],
      ]);
      expect(messages.every((message) => Array.isArray(message.attachments))).toBe(true);
      expect(await liveConversations(t)).toHaveLength(1);
    });
  });

  it("expands attachment References in bounded pages and rejects another turn's cursor", async () => {
    const body = "渠道事实。".repeat(1800);
    let previousCursor: string | undefined;
    let checks = 0;
    const runtime: ConversationRuntime = { async run(input) {
      expect(input.message).toBe("看长材料");
      expect(input.references?.[0].text.length).toBeLessThan(body.length);
      if (previousCursor) expect(await input.readReference!({ handle: "R1", cursor: previousCursor })).toMatchObject({ unavailable: true });
      let cursor: string | undefined;
      let collected = "";
      do {
        const page = await input.readReference!({ handle: "R1", cursor }) as { text: string; cursor?: string };
        expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(6000);
        collected += page.text;
        cursor = page.cursor;
        if (cursor && !previousCursor) previousCursor = cursor;
      } while (cursor);
      expect(collected).toBe(body);
      checks++;
      return { assistantMessage: "已读完", runtimeEntries: [] };
    } };
    await withApp(runtime, async t => {
      const cookie = await t.loginCookie();
      const uploaded = await upload(t, cookie, multipart("long.md", body));
      const id = uploaded.json().attachments[0].id;
      for (let turn = 0; turn < 2; turn++) expect((await send(t, cookie, { message: "看长材料", attachments: [{ id }] })).statusCode).toBe(200);
      expect(checks).toBe(2);
    });
  });

  it("没有对话时上传会建主对话；带附件 id 发消息能读到抽取文本；历史只留元数据", async () => {
    const runtime = recordingRuntime();
    await withApp(runtime, async (t, attachmentDir) => {
      const cookie = await t.loginCookie();
      const uploaded = await upload(t, cookie, multipart("note.md", "# 渠道备忘\n\n东南亚渠道预算追加 15%。"));
      expect(uploaded.statusCode).toBe(200);
      const info = uploaded.json().attachments[0] as { id: string };
      expect(info).toMatchObject({ fileName: "note.md", mimeType: "text/markdown" });
      expect("extractedText" in uploaded.json().attachments[0]).toBe(false);

      // 上传时建出的就是这个人的主对话，原件 + sidecar 落在它的目录下。
      const [main] = await liveConversations(t);
      expect(main).toMatchObject({ owner_id: TEST_CEO.personId });
      const stored = await readdir(join(attachmentDir, main.id as string));
      expect(stored.sort()).toEqual([info.id, `${info.id}.json`].sort());

      const sent = await send(t, cookie, { message: "看附件", attachments: [{ id: info.id }] });
      expect(sent.statusCode).toBe(200);
      // Runtime receives raw Query and bounded attachment References separately.
      expect(runtime.messages[0]).toContain("看附件");
      expect(runtime.messages[0]).toBe("看附件");
      expect(runtime.references[0]).toMatchObject([{ kind: "attachment", title: "note.md", text: expect.stringContaining("东南亚渠道预算追加 15%。") }]);
      expect(runtime.messages[0]).not.toContain(main.id as string);
      // 发消息用的是同一条主对话，没有另建。
      expect(await liveConversations(t)).toEqual([main]);

      const [userMessage] = await history(t, cookie);
      expect(userMessage.content).toBe("看附件");
      expect(userMessage.attachments).toHaveLength(1);
      expect(userMessage.attachments[0]).toMatchObject({ id: info.id, fileName: "note.md" });
      expect(userMessage.attachments[0].extractedText).toBeUndefined();
      expect(userMessage.attachments[0].sha256).toBeUndefined();
      expect(userMessage.attachments[0].storageKey).toBeUndefined();

      // 未上传过的附件 id 一律拒绝，客户端不能伪造元数据。
      const forged = await send(t, cookie, { message: "伪造", attachments: [{ id: "22222222-2222-4222-8222-222222222222" }] });
      expect(forged.statusCode).toBe(400);
      expect(forged.json()).toMatchObject({ code: "ATTACHMENT_NOT_FOUND" });
    });
  });

  it("已有主对话时上传沿用它；别人拿同一个附件 id 发消息 400", async () => {
    const runtime = recordingRuntime();
    await withApp(runtime, async (t, attachmentDir) => {
      const ceo = await t.loginCookie();
      const member = await t.memberCookie();
      expect((await send(t, ceo, { message: "先聊一句" })).statusCode).toBe(200);
      const [main] = await liveConversations(t);

      const uploaded = await upload(t, ceo, multipart("brief.md", "正文内容"));
      expect(uploaded.statusCode).toBe(200);
      const attachmentId = uploaded.json().attachments[0].id as string;
      expect(await liveConversations(t)).toEqual([main]);
      expect(await readdir(join(attachmentDir, main.id as string))).toContain(`${attachmentId}.json`);

      const stolen = await send(t, member, { message: "偷看", attachments: [{ id: attachmentId }] });
      expect(stolen.statusCode).toBe(400);
      expect(stolen.json()).toMatchObject({ code: "ATTACHMENT_NOT_FOUND" });
      expect(runtime.messages).toEqual(["先聊一句"]);
      expect(await history(t, member)).toEqual([]);

      expect((await send(t, ceo, { message: "看附件", attachments: [{ id: attachmentId }] })).statusCode).toBe(200);
      expect((await history(t, ceo)).map((message) => [message.sequence, message.content])).toEqual([
        [1, "先聊一句"],
        [2, "收到"],
        [3, "看附件"],
        [4, "收到"],
      ]);
    });
  });
});
