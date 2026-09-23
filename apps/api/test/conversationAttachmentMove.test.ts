import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestApp } from "./helpers.js";

// 容器部署里 TMPDIR（overlay）与附件卷（命名卷）分属不同文件系统，rename 必然 EXDEV。
// 这里把 rename 强制为 EXDEV / EACCES，走真实上传路由复现该部署形态。
const forced = vi.hoisted(() => ({ code: null as string | null, failOnCall: 0, calls: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (forced.code) {
        forced.calls += 1;
        if (forced.failOnCall === 0 || forced.calls === forced.failOnCall) {
          throw Object.assign(new Error(`${forced.code}: injected for test`), { code: forced.code });
        }
      }
      return actual.rename(from, to);
    },
  };
});

function multipart(files: { name: string; content: string }[]): { headers: Record<string, string>; payload: Buffer } {
  const boundary = `----vitest-exdev-${Date.now()}`;
  const parts = files.flatMap((file) => [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: text/markdown\r\n\r\n`),
    Buffer.from(file.content, "utf8"),
    Buffer.from("\r\n"),
  ]);
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]) };
}

async function sessionFixture(): Promise<{ t: Awaited<ReturnType<typeof createTestApp>>; cookie: string; sessionId: string; attachmentDir: string; stagingDir: string; restoreTmp: () => void }> {
  const attachmentDir = await mkdtemp(join(tmpdir(), "warmap-attachment-"));
  const stagingDir = await mkdtemp(join(tmpdir(), "warmap-attachment-staging-"));
  const t = await createTestApp({ conversationAttachmentStorageDir: attachmentDir });
  const cookie = await t.loginCookie();
  const created = await t.app.inject({ method: "POST", url: "/api/conversations/global/sessions", headers: { cookie, origin: t.publicOrigin }, payload: {} });
  expect(created.statusCode).toBe(201);
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = stagingDir;
  return {
    t,
    cookie,
    sessionId: created.json().id as string,
    attachmentDir,
    stagingDir,
    restoreTmp: () => {
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
    },
  };
}

async function upload(t: Awaited<ReturnType<typeof createTestApp>>, cookie: string, sessionId: string, body: { headers: Record<string, string>; payload: Buffer }) {
  return t.app.inject({
    method: "POST",
    url: `/api/conversations/global/sessions/${sessionId}/attachments`,
    headers: { cookie, origin: t.publicOrigin, ...body.headers },
    payload: body.payload,
  });
}

it("EXDEV 下附件上传仍成功：原件与 sidecar 落盘、元数据正确、暂存源文件被清理", async () => {
  forced.code = "EXDEV";
  forced.failOnCall = 0;
  forced.calls = 0;
  const { t, cookie, sessionId, attachmentDir, stagingDir, restoreTmp } = await sessionFixture();
  const content = "# 渠道备忘\n\n东南亚渠道预算追加 15%。";
  try {
    const res = await upload(t, cookie, sessionId, multipart([{ name: "note.md", content }]));
    expect(res.statusCode).toBe(200);
    const info = res.json().attachments[0] as { id: string; fileName: string; sha256?: string };
    expect(info.fileName).toBe("note.md");
    expect("extractedText" in res.json().attachments[0]).toBe(false);

    // 原件字节与 sidecar 元数据都在卷内，sha256 与内容一致
    expect(await readFile(join(attachmentDir, sessionId, info.id), "utf8")).toBe(content);
    const sidecar = JSON.parse(await readFile(join(attachmentDir, sessionId, `${info.id}.json`), "utf8"));
    expect(sidecar).toMatchObject({
      id: info.id,
      fileName: "note.md",
      storageKey: `${sessionId}/${info.id}`,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    expect(sidecar.extractedText).toContain("东南亚渠道预算追加 15%");
    // copy+unlink 回退已删除暂存源文件，私有暂存目录不留残留
    expect(await readdir(stagingDir)).toEqual([]);
  } finally {
    restoreTmp();
    forced.code = null;
    await rm(attachmentDir, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
    await t.close();
  }
});

it("EXDEV 下多附件批量上传逐件走回退", async () => {
  forced.code = "EXDEV";
  forced.failOnCall = 0;
  forced.calls = 0;
  const { t, cookie, sessionId, attachmentDir, stagingDir, restoreTmp } = await sessionFixture();
  try {
    const res = await upload(t, cookie, sessionId, multipart([{ name: "a.md", content: "甲" }, { name: "b.md", content: "乙" }]));
    expect(res.statusCode).toBe(200);
    const infos = res.json().attachments as { id: string; fileName: string }[];
    expect(infos.map((info) => info.fileName)).toEqual(["a.md", "b.md"]);
    for (const [index, info] of infos.entries()) {
      expect(await readFile(join(attachmentDir, sessionId, info.id), "utf8")).toBe(index === 0 ? "甲" : "乙");
      expect(JSON.parse(await readFile(join(attachmentDir, sessionId, `${info.id}.json`), "utf8")).sha256).toBe(createHash("sha256").update(index === 0 ? "甲" : "乙").digest("hex"));
    }
    expect(await readdir(stagingDir)).toEqual([]);
  } finally {
    restoreTmp();
    forced.code = null;
    await rm(attachmentDir, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
    await t.close();
  }
});

it("非 EXDEV 错误不被降级为复制：整批回滚，不留下原件或 sidecar", async () => {
  forced.code = "EACCES";
  forced.failOnCall = 2; // 第一件成功、第二件失败 → 必须回滚第一件
  forced.calls = 0;
  const { t, cookie, sessionId, attachmentDir, stagingDir, restoreTmp } = await sessionFixture();
  try {
    const res = await upload(t, cookie, sessionId, multipart([{ name: "a.md", content: "甲" }, { name: "b.md", content: "乙" }]));
    expect(res.statusCode).toBe(500);
    expect(forced.calls).toBe(2);
    expect(await readdir(join(attachmentDir, sessionId))).toEqual([]);
  } finally {
    restoreTmp();
    forced.code = null;
    await rm(attachmentDir, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
    await t.close();
  }
});
