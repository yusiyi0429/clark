import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueryResult } from "pg";
import { describe, expect, it } from "vitest";
import { readTeamFileText, type TeamDeliveryDeps } from "../src/teamDeliveries.js";
import { boardFixture, THIRD, type BoardFixture } from "./boardFixture.js";
import { TEST_CEO, TEST_MEMBER } from "./helpers.js";

const base = "/api/me/team-deliveries";
function upload(f: BoardFixture, url: string, cookie: string, input: object, name: string, data: Buffer) {
  const boundary = randomUUID();
  const head = "--" + boundary + '\r\nContent-Disposition: form-data; name="payload"\r\n\r\n' + JSON.stringify(input) +
    "\r\n--" + boundary + '\r\nContent-Disposition: form-data; name="files"; filename="' + name + '"\r\nContent-Type: application/octet-stream\r\n\r\n';
  return f.t.app.inject({ method: "POST", url, headers: { cookie, origin: f.t.publicOrigin, "content-type": "multipart/form-data; boundary=" + boundary },
    payload: Buffer.concat([Buffer.from(head), data, Buffer.from("\r\n--" + boundary + "--\r\n")]) });
}

describe("团队伙伴在原请求中收发", { timeout: 45_000 }, () => {
  it("并发重放一份文件和一次回复；其他人及旧传话入口都无法读该私有回复", async () => {
    const f = await boardFixture();
    try {
      const sender = await f.t.loginCookie();
      const thirdLogin = await f.call("POST", "/api/auth/login", { loginId: THIRD.loginId, passcode: THIRD.passcode });
      const third = String(thirdLogin.headers["set-cookie"]).split(";")[0];
      const payload = { clientId: randomUUID(), kind: "question", recipientIds: [TEST_MEMBER.personId, THIRD.personId], text: "请报两条反馈" };
      const file = Buffer.from("逐人征集", "utf8");
      const send = () => upload(f, base, sender, payload, "question.txt", file);
      const [first, replay] = await Promise.all([send(), send()]);
      expect(first.statusCode, first.body).toBe(200);
      expect(replay.json().delivery.id).toBe(first.json().delivery.id);
      const { id, attachments } = first.json().delivery;
      expect((await f.call("GET", attachments[0].href, undefined, await f.t.memberCookie())).rawPayload).toEqual(file);
      expect((await f.call("GET", "/api/requests/" + id)).statusCode).toBe(404);
      expect((await f.call("GET", "/api/me/requests?box=inbox")).json().items.some((item: { id: string }) => item.id === id)).toBe(false);
      expect((await f.call("POST", base, { ...payload, text: "不同问题" }, sender)).statusCode).toBe(409);

      const data = Buffer.from("本人核实的两条反馈", "utf8");
      const response = { clientId: randomUUID(), status: "answered", text: "见附件" };
      const replyPath = base + "/" + id + "/replies";
      const answer = () => upload(f, replyPath, f.member, response, "answer.txt", data);
      const [one, two] = await Promise.all([answer(), answer()]);
      expect([one.statusCode, two.statusCode]).toEqual([200, 200]);
      const item = (await f.call("GET", base + "/" + id, undefined, sender)).json().delivery;
      expect(item.recipients).toMatchObject([
        { personId: TEST_MEMBER.personId, status: "answered", replies: [{ text: "见附件" }] },
        { personId: THIRD.personId, status: "pending", replies: [] },
      ]);
      const href = item.recipients[0].replies[0].attachments[0].href;
      expect((await f.call("GET", href, undefined, sender)).rawPayload).toEqual(data);
      expect((await f.call("GET", href + "/text", undefined, sender)).json()).toEqual({ text: data.toString(), fileName: "answer.txt", truncated: false });
      expect((await f.call("GET", href, undefined, third)).statusCode).toBe(404);
      expect((await f.call("GET", href + "/text", undefined, third)).statusCode).toBe(404);
      expect((await f.call("GET", base + "/" + id, undefined, third)).json().delivery.recipients).toHaveLength(1);
      expect((await f.t.sql("SELECT * FROM team_delivery_attachments WHERE request_id=$1", [id]))).toHaveLength(2);
    } finally { await f.close(); }
  });

  it("写附件失败会回滚本次请求、收件人和已写字节，同一个发送标识可重试", async () => {
    const f = await boardFixture();
    try {
      const input = { clientId: randomUUID(), kind: "share", recipientIds: [TEST_CEO.personId] };
      await f.t.sql("ALTER TABLE team_delivery_attachments ADD CONSTRAINT test_write_failure CHECK (file_name<>'retry.txt')");
      const attempt = () => upload(f, base, f.member, input, "retry.txt", Buffer.from("ok"));
      expect((await attempt()).statusCode).toBe(500);
      expect(await f.t.sql("SELECT id FROM requests WHERE team_client_id=$1", [input.clientId])).toEqual([]);
      expect(await readdir(join(f.storage, "team-deliveries"))).toEqual([]);
      await f.t.sql("ALTER TABLE team_delivery_attachments DROP CONSTRAINT test_write_failure");
      expect((await attempt()).json().delivery).toMatchObject({ text: "", recipients: [{ status: "delivered" }] });
    } finally { await f.close(); }
  });
});

describe("已授权版本的文件正文", () => {
  it("按已核对的字节截取 UTF-8；拒绝损坏的版本、没有投递记录的成员与改名的二进制", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "team-text-test-"));
    const fileId = randomUUID(), requestId = randomUUID();
    const path = join(storageDir, "team-deliveries", fileId);
    const data = Buffer.from("反馈".repeat(13_000));
    const row = { id: fileId, file_name: "answer.txt", mime_type: "text/plain", size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    const deps = { storageDir, q: async (_sql: string, values?: unknown[]) =>
      ({ rows: values?.[1] === "recipient" ? [row] : [] }) as QueryResult } as TeamDeliveryDeps;
    try {
      await mkdir(join(storageDir, "team-deliveries"));
      await writeFile(path, data);
      expect(await readTeamFileText(deps, "recipient", requestId, fileId)).toEqual({ text: data.toString().slice(0, 24_000), fileName: row.file_name, truncated: true });
      await expect(readTeamFileText(deps, "stranger", requestId, fileId)).rejects.toMatchObject({ status: 404 });
      await writeFile(path, Buffer.from([0, 255]));
      await expect(readTeamFileText(deps, "recipient", requestId, fileId)).rejects.toMatchObject({ status: 409 });
      row.sha256 = createHash("sha256").update(Buffer.from([0, 255])).digest("hex");
      row.size = 2;
      await expect(readTeamFileText(deps, "recipient", requestId, fileId)).rejects.toMatchObject({ status: 422 });
    } finally { await rm(storageDir, { recursive: true, force: true }); }
  });
});
