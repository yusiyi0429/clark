import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { boardFixture } from "./boardFixture.js";
import { TEST_MEMBER } from "./helpers.js";

/** 新首页 14.5：子会话的附件存在云端，本人看，本人配对的电脑按 id 取回。 */
const form = (files: [string, Buffer][]) => {
  const boundary = "b-attach";
  const parts = files.map(([name, data]) => Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\n`
    + "Content-Type: application/octet-stream\r\n\r\n"), data, Buffer.from("\r\n")]));
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]) };
};

describe("子会话的附件（新首页 14.5）", { timeout: 30_000 }, () => {
  it("本人的卡、专题能存；认不得的类型、别人的子会话不收；本人和本人配对的电脑能取回原样，别的电脑不行", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const card = await f.card("做登录页");
      const topic = randomUUID();
      await f.t.sql("INSERT INTO research_topics(id,owner_id,title) VALUES($1,$2,'竞品调研')", [topic, TEST_MEMBER.personId]);
      const upload = (path: string, files: [string, Buffer][]) => {
        const body = form(files);
        return f.t.app.inject({ method: "POST", url: path, headers: { cookie: f.member, origin: f.t.publicOrigin, ...body.headers }, payload: body.payload });
      };
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const saved = await upload(`/api/me/sub-sessions/card/${card}/attachments`, [["截图.png", png], ["报错.log", Buffer.from("TypeError: x")]]);
      expect(saved.statusCode).toBe(200);
      const [image, log] = saved.json().attachments;
      expect(image).toMatchObject({ subject: { kind: "card", id: card }, fileName: "截图.png", mimeType: "image/png", size: png.length, kind: "image",
        sha256: createHash("sha256").update(png).digest("hex") });
      expect(log).toMatchObject({ fileName: "报错.log", mimeType: "text/plain", kind: "code" });
      expect((await upload(`/api/me/sub-sessions/topic/${topic}/attachments`, [["需求.xlsx", Buffer.from("PK")]])).json().attachments[0])
        .toMatchObject({ subject: { kind: "topic", id: topic }, kind: "document" });

      const bad = await upload(`/api/me/sub-sessions/card/${card}/attachments`, [["说明.md", Buffer.from("ok")], ["tool.exe", Buffer.from("MZ")]]);
      expect([bad.statusCode, bad.json().code, bad.json().message]).toEqual([400, "UNSUPPORTED_ATTACHMENT", "tool.exe：格式不支持"]);
      expect((await upload(`/api/me/sub-sessions/card/${randomUUID()}/attachments`, [["a.md", Buffer.from("x")]])).statusCode).toBe(404);
      // 有一个不行整批不存。
      expect(await f.t.sql("SELECT file_name FROM session_attachments ORDER BY created_at,file_name")).toHaveLength(3);

      const mine = await f.call("GET", `/api/me/session-attachments/${image.id}`);
      expect([mine.statusCode, mine.headers["content-type"], mine.rawPayload.equals(png)]).toEqual([200, "image/png", true]);
      const laptop = await f.local();
      const fetched = await f.t.app.inject({ method: "GET", url: `/api/local-runner/attachments/${log.id}`, headers: { authorization: `Bearer ${laptop.token}` } });
      expect([fetched.statusCode, fetched.headers["x-sha256"], fetched.payload]).toEqual([200, log.sha256, "TypeError: x"]);
      expect(fetched.headers["content-disposition"]).toContain("attachment;");
      expect((await f.t.app.inject({ method: "GET", url: `/api/local-runner/attachments/${log.id}` })).statusCode).toBe(401);
      expect((await f.call("GET", `/api/me/session-attachments/${randomUUID()}`)).statusCode).toBe(404);
    } finally { await f.close(); }
  });
});
