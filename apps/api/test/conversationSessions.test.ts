import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers.js";
import type { ConversationRuntime } from "../src/conversations.js";

const ATTACHMENT_DIR = "/tmp/warmap-conversation-attachments";

function parseSse(body: string): unknown[] {
  return body
    .trim()
    .split("\n\n")
    .map((block) => JSON.parse(block.split("\n").find((line) => line.startsWith("data: "))!.slice(6)));
}

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

describe("Conversation sessions API", () => {
  it("requires CEO auth on new session routes", async () => {
    const t = await createTestApp();
    try {
      expect((await t.app.inject({ method: "GET", url: "/api/conversations/global/sessions" })).statusCode).toBe(401);
      expect((await t.app.inject({
        method: "POST", url: "/api/conversations/global/sessions", payload: {},
      })).statusCode).toBe(401);
    } finally {
      await t.close();
    }
  });

  it("rejects session operations for a nonexistent object scope", async () => {
    const t = await createTestApp();
    try {
      const cookie = await t.loginCookie();
      const scope = "issue:11111111-1111-4111-8111-111111111111";
      expect((await t.app.inject({ method: "GET", url: `/api/conversations/${scope}/sessions`, headers: { cookie } })).statusCode).toBe(404);
      expect((await t.app.inject({ method: "POST", url: `/api/conversations/${scope}/sessions`, headers: { cookie, origin: t.publicOrigin }, payload: {} })).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });

  it("resolves signal:<id> scope: messages/sessions 200 for a real signal, 404 otherwise", async () => {
    const t = await createTestApp();
    try {
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

      const sessions = await t.app.inject({ method: "GET", url: `/api/conversations/${scope}/sessions`, headers: { cookie } });
      expect(sessions.statusCode).toBe(200);
      expect(sessions.json()).toMatchObject({ scope, sessions: [] });

      const created = await t.app.inject({
        method: "POST", url: `/api/conversations/${scope}/sessions`,
        headers: { cookie, origin: t.publicOrigin }, payload: {},
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ scope, isDefault: true });

      // 不存在的 signal（含非 UUID id）仍是 404，不能是 pg 类型错误 500。
      const missing = await t.app.inject({ method: "GET", url: "/api/conversations/signal:33333333-3333-4333-8333-333333333333/messages", headers: { cookie } });
      expect(missing.statusCode).toBe(404);
      const malformed = await t.app.inject({ method: "GET", url: "/api/conversations/signal:not-a-uuid/sessions", headers: { cookie } });
      expect(malformed.statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });

  it("keeps legacy default-session semantics and lists it as the default session", async () => {
    const t = await createTestApp();
    try {
      const cookie = await t.loginCookie();
      const post = await t.app.inject({
        method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "legacy one" },
      });
      expect(post.statusCode).toBe(200);

      const list = await t.app.inject({ method: "GET", url: "/api/conversations/global/sessions", headers: { cookie } });
      expect(list.statusCode).toBe(200);
      expect(list.json().sessions).toHaveLength(1);
      expect(list.json().sessions[0]).toMatchObject({ scope: "global", isDefault: true, messageCount: 2, title: null });

      const legacyHistory = await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie } });
      expect(legacyHistory.json().messages).toHaveLength(2);
      expect(legacyHistory.json().messages.every((message: { attachments: unknown[] }) => message.attachments)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("creates extra sessions isolated from the legacy default session", async () => {
    const seen: string[] = [];
    const runtime: ConversationRuntime = {
      async run(input) {
        seen.push(`${input.scope}:${input.message}`);
        input.emit({ type: "message", delta: "ok" });
        return { assistantMessage: "ok", runtimeEntries: [] };
      },
    };
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      // 先用 legacy 路由建立默认会话，再新建额外会话。
      await t.app.inject({
        method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "legacy one" },
      });
      const created = await t.app.inject({
        method: "POST", url: "/api/conversations/global/sessions",
        headers: { cookie, origin: t.publicOrigin }, payload: { title: "东南亚渠道" },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ scope: "global", title: "东南亚渠道", isDefault: false, messageCount: 0 });
      const sessionId = created.json().id as string;

      const emptyHistory = await t.app.inject({
        method: "GET", url: `/api/conversations/global/sessions/${sessionId}/messages`, headers: { cookie },
      });
      expect(emptyHistory.statusCode).toBe(200);
      expect(emptyHistory.json().messages).toEqual([]);

      const sent = await t.app.inject({
        method: "POST", url: `/api/conversations/global/sessions/${sessionId}/messages`,
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "session one" },
      });
      expect(sent.statusCode).toBe(200);
      expect(parseSse(sent.body)).toContainEqual(expect.objectContaining({ type: "done", status: "completed" }));

      // 会话消息不泄漏进 legacy 默认会话，反向同理。
      const legacyHistory = await t.app.inject({ method: "GET", url: "/api/conversations/global/messages", headers: { cookie } });
      expect(legacyHistory.json().messages.map((message: { content: string }) => message.content)).toEqual(["legacy one", "ok"]);
      const sessionHistory = await t.app.inject({
        method: "GET", url: `/api/conversations/global/sessions/${sessionId}/messages`, headers: { cookie },
      });
      expect(sessionHistory.json().messages.map((message: { content: string }) => message.content)).toEqual(["session one", "ok"]);

      const list = await t.app.inject({ method: "GET", url: "/api/conversations/global/sessions", headers: { cookie } });
      expect(list.json().sessions.map((session: { id: string; isDefault: boolean }) => [session.id === sessionId, session.isDefault]))
        .toEqual([[false, true], [true, false]]);

      // 未知/跨 scope 会话 → 404
      expect((await t.app.inject({
        method: "GET", url: "/api/conversations/global/sessions/11111111-1111-4111-8111-111111111111/messages", headers: { cookie },
      })).statusCode).toBe(404);
      expect((await t.app.inject({
        method: "POST", url: "/api/conversations/global/sessions/11111111-1111-4111-8111-111111111111/messages",
        headers: { cookie, origin: t.publicOrigin }, payload: { message: "x" },
      })).statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });

  it("stores attachments as bounded extracted text and embeds metadata into the user message", async () => {
    const runtimeMessages: string[] = [];
    const runtime: ConversationRuntime = {
      async run(input) {
        runtimeMessages.push(input.message);
        return { assistantMessage: "已读附件", runtimeEntries: [] };
      },
    };
    const t = await createTestApp({}, runtime);
    try {
      const cookie = await t.loginCookie();
      const created = await t.app.inject({
        method: "POST", url: "/api/conversations/global/sessions", headers: { cookie, origin: t.publicOrigin }, payload: {},
      });
      const sessionId = created.json().id as string;

      const upload = multipart("note.md", "# 渠道备忘\n\n东南亚渠道预算追加 15%。");
      const uploaded = await t.app.inject({
        method: "POST", url: `/api/conversations/global/sessions/${sessionId}/attachments`,
        headers: { cookie, origin: t.publicOrigin, ...upload.headers }, payload: upload.payload,
      });
      expect(uploaded.statusCode).toBe(200);
      const info = uploaded.json().attachments[0] as { id: string; fileName: string; mimeType: string; sizeBytes: number };
      expect(info).toMatchObject({ fileName: "note.md", mimeType: "text/markdown" });
      expect("extractedText" in uploaded.json().attachments[0]).toBe(false);

      // 原件 + sidecar 已在 API 卷内。
      const stored = await readdir(join(ATTACHMENT_DIR, sessionId));
      expect(stored.some((name) => name === `${info.id}`)).toBe(true);
      expect(stored.some((name) => name === `${info.id}.json`)).toBe(true);

      const sent = await t.app.inject({
        method: "POST", url: `/api/conversations/global/sessions/${sessionId}/messages`,
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "看附件", attachments: [{ id: info.id }] },
      });
      expect(sent.statusCode).toBe(200);
      // Runtime 只收到有界抽取文本拼接，收不到原件路径。
      expect(runtimeMessages[0]).toContain("看附件");
      expect(runtimeMessages[0]).toContain("[附件 note.md]");
      expect(runtimeMessages[0]).toContain("东南亚渠道预算追加 15%。");
      expect(runtimeMessages[0]).not.toContain(sessionId);

      const history = await t.app.inject({
        method: "GET", url: `/api/conversations/global/sessions/${sessionId}/messages`, headers: { cookie },
      });
      const userMessage = history.json().messages[0] as {
        content: string;
        attachments: { id: string; fileName: string; extractedText?: string; sha256?: string; storageKey?: string }[];
      };
      expect(userMessage.content).toBe("看附件");
      expect(userMessage.attachments).toHaveLength(1);
      expect(userMessage.attachments[0]).toMatchObject({ id: info.id, fileName: "note.md" });
      expect(userMessage.attachments[0].extractedText).toBeUndefined();
      expect(userMessage.attachments[0].sha256).toBeUndefined();
      expect(userMessage.attachments[0].storageKey).toBeUndefined();

      // 未上传过的附件 id 一律拒绝，客户端不能伪造元数据。
      const forged = await t.app.inject({
        method: "POST", url: `/api/conversations/global/sessions/${sessionId}/messages`,
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "伪造", attachments: [{ id: "22222222-2222-4222-8222-222222222222" }] },
      });
      expect(forged.statusCode).toBe(400);
      expect(forged.json()).toMatchObject({ code: "ATTACHMENT_NOT_FOUND" });
    } finally {
      await t.close();
    }
  });

  it("deletes a session with its messages and attachment files; legacy default can be recreated", async () => {
    const t = await createTestApp();
    try {
      const cookie = await t.loginCookie();
      const created = await t.app.inject({
        method: "POST", url: "/api/conversations/global/sessions", headers: { cookie, origin: t.publicOrigin }, payload: {},
      });
      const sessionId = created.json().id as string;
      const upload = multipart("brief.md", "正文内容");
      const uploaded = await t.app.inject({
        method: "POST", url: `/api/conversations/global/sessions/${sessionId}/attachments`,
        headers: { cookie, origin: t.publicOrigin, ...upload.headers }, payload: upload.payload,
      });
      const attachmentId = uploaded.json().attachments[0].id as string;
      await t.app.inject({
        method: "POST", url: `/api/conversations/global/sessions/${sessionId}/messages`,
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "带附件", attachments: [{ id: attachmentId }] },
      });

      const removed = await t.app.inject({
        method: "DELETE", url: `/api/conversations/global/sessions/${sessionId}`,
        headers: { cookie, origin: t.publicOrigin },
      });
      expect(removed.statusCode).toBe(204);
      expect((await t.app.inject({
        method: "GET", url: `/api/conversations/global/sessions/${sessionId}/messages`, headers: { cookie },
      })).statusCode).toBe(404);
      const list = await t.app.inject({ method: "GET", url: "/api/conversations/global/sessions", headers: { cookie } });
      expect(list.json().sessions).toHaveLength(0);
      await expect(readFile(join(ATTACHMENT_DIR, sessionId, attachmentId))).rejects.toThrow();

      expect((await t.app.inject({
        method: "DELETE", url: `/api/conversations/global/sessions/${sessionId}`,
        headers: { cookie, origin: t.publicOrigin },
      })).statusCode).toBe(404);

      // 删除后 legacy 路由回到空默认会话，可重新惰性创建。
      const legacy = await t.app.inject({
        method: "POST", url: "/api/conversations/global/messages",
        headers: { cookie, origin: t.publicOrigin, accept: "text/event-stream" },
        payload: { message: "重新开始" },
      });
      expect(legacy.statusCode).toBe(200);
      const relist = await t.app.inject({ method: "GET", url: "/api/conversations/global/sessions", headers: { cookie } });
      expect(relist.json().sessions).toHaveLength(1);
      expect(relist.json().sessions[0].isDefault).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("rejects uploads to unknown sessions and empty multipart bodies", async () => {
    const t = await createTestApp();
    try {
      const cookie = await t.loginCookie();
      expect((await t.app.inject({
        method: "POST", url: "/api/conversations/global/sessions/11111111-1111-4111-8111-111111111111/attachments",
        headers: { cookie, origin: t.publicOrigin, "content-type": "multipart/form-data; boundary=x" }, payload: "",
      })).statusCode).toBe(404);

      const created = await t.app.inject({
        method: "POST", url: "/api/conversations/global/sessions", headers: { cookie, origin: t.publicOrigin }, payload: {},
      });
      const sessionId = created.json().id as string;
      const noFiles = multipart("note.md", "");
      const boundary = "----empty";
      const empty = await t.app.inject({
        method: "POST", url: `/api/conversations/global/sessions/${sessionId}/attachments`,
        headers: { cookie, origin: t.publicOrigin, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.from(`--${boundary}--\r\n`),
      });
      expect(empty.statusCode).toBe(400);
      expect(empty.json().code).toBe("INVALID_ATTACHMENT");
      void noFiles;
    } finally {
      await t.close();
    }
  });
});
