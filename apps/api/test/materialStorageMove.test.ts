import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { moveStagedFile } from "../src/meetingMaterials.js";
import { createTestApp } from "./helpers.js";

// 容器部署里 TMPDIR（overlay）与材料卷（命名卷）分属不同文件系统，rename 必然 EXDEV。
// 这里把 rename 强制为 EXDEV / EACCES，走真实代码路径复现该部署形态。
const forced = vi.hoisted(() => ({ code: "EXDEV" as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (forced.code) throw Object.assign(new Error(`${forced.code}: injected for test`), { code: forced.code });
      return actual.rename(from, to);
    },
  };
});

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "warmap-move-"));
}

async function meetingFixture(): Promise<{ t: Awaited<ReturnType<typeof createTestApp>>; cookie: string; meetingId: string; storageDir: string }> {
  const storageDir = await scratchDir();
  const t = await createTestApp({ materialStorageDir: storageDir });
  const issue = await t.createIssue();
  const cookie = await t.loginCookie();
  const issueId = issue.objectRef.id as string;
  const card = (await t.app.inject({ method: "GET", url: `/api/cards/issues/${issueId}`, headers: { cookie } })).json().cards[0];
  const create = card.actions.find((action: { actionType: string }) => action.actionType === "issue.create_meeting");
  const created = await t.app.inject({
    method: "POST",
    url: "/api/actions/execute",
    headers: { cookie, origin: t.publicOrigin },
    payload: { actionId: create.actionId, input: { title: "跨设备落盘验证会", scheduledAt: "2026-06-01T10:00:00.000+08:00", leadDriId: "person-fixture-002", ceoParticipantId: "person-fixture-001", participants: ["person-fixture-002"], issueIds: [issueId] } },
  });
  expect(created.statusCode).toBe(200);
  return { t, cookie, meetingId: created.json().cards[0].objectRef.id as string, storageDir };
}

function primaryBody(boundary: string, filename: string, content: string): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: text/markdown\r\n\r\n`),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

it("EXDEV 下主材料替换仍成功：文件落到卷内且暂存源文件被清理", async () => {
  forced.code = "EXDEV";
  const { t, cookie, meetingId, storageDir } = await meetingFixture();
  // 私有 TMPDIR：解析暂存目录只属于本用例，可确定性断言“不留残留”
  const stagingDir = await mkdtemp(join(tmpdir(), "warmap-move-staging-"));
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = stagingDir;
  try {
    const boundary = "----exdev-primary";
    const res = await t.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/materials`,
      headers: { cookie, origin: t.publicOrigin, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: primaryBody(boundary, "跨设备.md", "跨设备正文"),
    });
    expect(res.statusCode).toBe(200);
    const material = (await t.sql("SELECT materials FROM meetings WHERE id = $1", [meetingId]))[0].materials[0];
    expect(await readFile(join(storageDir, material.storageKey), "utf8")).toBe("跨设备正文");
    // 源文件已被 copy+unlink 回退删除，解析暂存目录不留残留
    expect(await readdir(stagingDir)).toEqual([]);
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    await rm(storageDir, { recursive: true, force: true });
    await rm(stagingDir, { recursive: true, force: true });
    await t.close();
  }
});

it("EXDEV 下补充材料追加仍成功并保留请求绑定", async () => {
  forced.code = "EXDEV";
  const { t, cookie, meetingId, storageDir } = await meetingFixture();
  try {
    await t.sql("UPDATE meetings SET draft = jsonb_set(draft, '{supplementRequests}', $2::jsonb) WHERE id = $1", [
      meetingId,
      JSON.stringify([{ id: "req-exdev", entryId: null, targetDriId: "person-fixture-002", text: "补充", exportStatus: "recorded", exportRef: null, error: null, createdAt: "2026-09-20T00:00:00.000Z" }]),
    ]);
    const boundary = "----exdev-supplement";
    const res = await t.app.inject({
      method: "POST",
      url: `/api/meetings/${meetingId}/materials/supplement`,
      headers: { cookie, origin: t.publicOrigin, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\nreq-exdev\r\n`),
        primaryBody(boundary, "补充.md", "补充正文"),
      ]),
    });
    expect(res.statusCode).toBe(200);
    const material = (await t.sql("SELECT materials FROM meetings WHERE id = $1", [meetingId]))[0].materials[0];
    expect(material.kind).toBe("supplement");
    expect(material.supplementFor).toBe("req-exdev");
    expect(await readFile(join(storageDir, material.storageKey), "utf8")).toBe("补充正文");
  } finally {
    await rm(storageDir, { recursive: true, force: true });
    await t.close();
  }
});

it("非 EXDEV 错误照常抛出，不静默降级为复制", async () => {
  forced.code = "EACCES";
  const dir = await scratchDir();
  try {
    const source = join(dir, "source");
    const destination = join(dir, "dest");
    await writeFile(source, "内容");
    await expect(moveStagedFile(source, destination)).rejects.toMatchObject({ code: "EACCES" });
    expect(await readFile(source, "utf8")).toBe("内容");
    await expect(readFile(destination, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    forced.code = null;
    await rm(dir, { recursive: true, force: true });
  }
});

it("EXDEV 回退不覆盖已存在的目标文件", async () => {
  forced.code = "EXDEV";
  const dir = await scratchDir();
  try {
    const source = join(dir, "source");
    const destination = join(dir, "dest");
    await writeFile(source, "新内容");
    await writeFile(destination, "既有内容");
    await expect(moveStagedFile(source, destination)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(destination, "utf8")).toBe("既有内容");
    expect(await readFile(source, "utf8")).toBe("新内容");
  } finally {
    forced.code = null;
    await rm(dir, { recursive: true, force: true });
  }
});

it("EXDEV 回退复制后删除源文件", async () => {
  forced.code = "EXDEV";
  const dir = await scratchDir();
  try {
    const source = join(dir, "source");
    const destination = join(dir, "dest");
    await writeFile(source, "内容");
    await moveStagedFile(source, destination);
    expect(await readFile(destination, "utf8")).toBe("内容");
    await expect(readFile(source, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    forced.code = null;
    await rm(dir, { recursive: true, force: true });
  }
});
