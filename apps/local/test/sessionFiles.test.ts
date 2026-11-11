// 在右边预览文件（设计 17.2 第 41 条，契约 LocalSessionFileReadResponse、LocalSessionFilesResponse）：读一个文件、列本会话写过改过的文件。用假 claude，不调模型。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalSessionFileReadResponse, LocalSessionFilesResponse } from "@warmap/contracts";
import { registerFormats } from "../src/store.js";
import { api, gitRepo, pair, raw, startTestRunner, tempDir } from "./helpers.js";

registerFormats();
async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe("读文件给预览、列改过的文件", { timeout: 40_000 }, () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-files-");
  const outside = tempDir("tl-files-out-");
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  const idle = (id: string) => until(async () => { const s = (await call("GET", `/v1/sessions/${id}`)).body.session; return s.status === "idle" ? s : null; });
  const open = async (name: string, extra: Record<string, unknown> = {}) => {
    mkdirSync(join(work, name), { recursive: true });
    const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: name }, title: name, cwd: join(work, name), firstMessage: `做 ${name}`, permissionMode: "auto", ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.id as string;
  };
  const read = (id: string, path: string) => call("POST", `/v1/sessions/${id}/files/read`, { path });
  const files = async (id: string) => {
    const r = await call("GET", `/v1/sessions/${id}/files`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Value.Check(LocalSessionFilesResponse, r.body)).toBe(true);
    return r.body;
  };

  beforeAll(async () => {
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    t = await startTestRunner({ pickFolder: work, fetchImpl: offline });
    token = await pair(t.port);
    await call("POST", "/v1/folders/pick", {});
    writeFileSync(join(work, ".fake-claude.json"), "{}");
    writeFileSync(join(outside, "secret.txt"), "外面的文件");
  });
  afterAll(() => t.cleanup());

  it("读一个文件：Markdown、文本、图片回内容和类型，别的只回名字和大小；相对路径、绝对路径都行", async () => {
    const id = await open("A");
    await idle(id); // 假 claude 写了 hello.txt
    const dir = join(work, "A");
    writeFileSync(join(dir, "方案.md"), "# 方案\n\n| a | b |\n");
    writeFileSync(join(dir, "页面.html"), "<script>alert(1)</script>");
    writeFileSync(join(dir, "图.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    writeFileSync(join(dir, "报告.pdf"), "%PDF-1.7 没有 NUL 也不当文本");
    writeFileSync(join(dir, "数据.bin"), Buffer.from([1, 2, 0, 3]));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");

    const md = await read(id, "方案.md");
    expect(md.status, JSON.stringify(md.body)).toBe(200);
    expect(Value.Check(LocalSessionFileReadResponse, md.body)).toBe(true);
    expect(md.body).toMatchObject({ path: "方案.md", absolutePath: join(dir, "方案.md"), name: "方案.md", kind: "markdown", mimeType: "text/markdown", encoding: "utf8", content: "# 方案\n\n| a | b |\n", truncated: false });
    expect(md.body.size).toBe(Buffer.byteLength("# 方案\n\n| a | b |\n"));
    // 相对路径带子文件夹、反斜杠；绝对路径
    expect((await read(id, "src\\a.ts")).body).toMatchObject({ path: "src/a.ts", kind: "text", mimeType: "text/typescript", content: "export const a = 1;\n" });
    expect((await read(id, join(dir, "hello.txt"))).body).toMatchObject({ path: "hello.txt", kind: "text", mimeType: "text/plain", content: "你好" });
    // HTML 当文本，不执行
    expect((await read(id, "页面.html")).body).toMatchObject({ kind: "text", mimeType: "text/html", content: "<script>alert(1)</script>" });
    const png = (await read(id, "图.png")).body;
    expect(png).toMatchObject({ kind: "image", mimeType: "image/png", encoding: "base64", truncated: false });
    expect(Buffer.from(png.content, "base64")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    expect((await read(id, "报告.pdf")).body).toMatchObject({ kind: "other", mimeType: "application/pdf", content: null });
    expect((await read(id, "数据.bin")).body).toMatchObject({ kind: "other", mimeType: "application/octet-stream", content: null, size: 4 });
    await call("POST", `/v1/sessions/${id}/kill`, {});
    // 会话停了也能读
    expect((await read(id, "方案.md")).status).toBe(200);
  });

  it("只许读会话自己的文件夹：.. 穿越、别处的绝对路径、指到外面的链接都不行；不存在的、文件夹回 404；太大的截断", async () => {
    const id = await open("B");
    await idle(id);
    const dir = join(work, "B");
    for (const path of ["../A/方案.md", "..\\..\\secret.txt", join(outside, "secret.txt"), join(work, "A", "hello.txt"), "src/../../A/hello.txt"]) {
      const r = await read(id, path);
      expect([path, r.status, r.body.error?.code]).toEqual([path, 403, "folder_not_allowed"]);
    }
    // 别的主机上的共享路径：按字面就挡掉，不去连它（连了会卡住几十秒）
    const t0 = Date.now();
    for (const path of ["\\\\tianshu-test.invalid\\share\\a.md", "//tianshu-test.invalid/share/a.md", "\\\\?\\C:\\Windows\\win.ini"]) expect((await read(id, path)).status).toBe(403);
    expect(Date.now() - t0).toBeLessThan(3_000);
    // 会话里的一个目录链接指到外面：按真实路径判
    symlinkSync(outside, join(dir, "link"), "junction");
    expect((await read(id, "link/secret.txt")).status).toBe(403);
    rmSync(join(dir, "link")); // 只删链接本身
    expect((await read(id, "没有.txt")).status).toBe(404);
    mkdirSync(join(dir, "sub"));
    expect((await read(id, "sub")).status).toBe(404);
    expect((await read(id, "")).status).toBe(400);
    expect((await read(id, "a\u0000b.txt")).status).toBe(400);
    expect((await read("6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10", "hello.txt")).status).toBe(404);
    // 文本最多 1 MB，超了只给前 1 MB；图片超过 5 MB 不给内容
    writeFileSync(join(dir, "大.log"), "x".repeat(1024 * 1024 + 10));
    const big = (await read(id, "大.log")).body;
    expect([big.kind, big.truncated, big.content.length, big.size]).toEqual(["text", true, 1024 * 1024, 1024 * 1024 + 10]);
    writeFileSync(join(dir, "大.jpg"), Buffer.alloc(5 * 1024 * 1024 + 1, 1));
    expect((await read(id, "大.jpg")).body).toMatchObject({ kind: "image", content: null, truncated: true });
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });

  it("在本人文件夹里直接做的（不是卡的工作树）：就算是 git 仓库，也只列执行方用写文件工具动过的，本人自己没提交的改动不算进来", async () => {
    const dir = gitRepo(join(work, "T"));
    writeFileSync(join(dir, "本人改到一半.md"), "还没提交");
    const r0 = await call("POST", "/v1/sessions", { subject: { kind: "topic", topicId: "t-files" }, title: "T", cwd: dir, firstMessage: "做 T", permissionMode: "auto" });
    expect(r0.status, JSON.stringify(r0.body)).toBe(200);
    await idle(r0.body.id);
    const r = await files(r0.body.id);
    expect(r.files.map((f: any) => [f.path, f.sources])).toEqual([["hello.txt", ["tool"]]]);
    await call("POST", `/v1/sessions/${r0.body.id}/kill`, {});
  });

  it("列改过的文件：不是 git 仓库的文件夹里，执行方用工具动过的、这一轮快照前后变了的（11/11 留一份）；本人在两轮之间自己改的不算", async () => {
    const id = await open("C");
    await idle(id);
    // 空闲时一轮结束那份快照可能还没留完，那一两秒里本人改的会算成执行方这一轮改的（定下的样子，不修）；等这一轮记下 files_changed 再手改
    const events = () => readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    await until(() => events().some((e) => e.type === "files_changed"));
    writeFileSync(join(work, "C", "手改的.txt"), "不是执行方写的");
    const r = await files(id);
    expect(r.root).toBe(join(work, "C"));
    expect(r.files).toHaveLength(1);
    // 开工那份留好以前写的走「改前拷一份」（sources 只有 tool），留好以后写的快照也知道（tool + snapshot）：都能恢复
    expect(r.files[0]).toMatchObject({ path: "hello.txt", absolutePath: join(work, "C", "hello.txt"), exists: true, size: Buffer.byteLength("你好"), change: "added", restorable: true });
    expect(r.files[0].sources).toContain("tool");
    expect(r.truncated).toBe(false);
    // 被拒绝、没写成的不算
    const denied = await open("C2", { permissionMode: "default" });
    const p = await until(async () => (await call("GET", `/v1/sessions/${denied}`)).body.pendingPermissions[0] ?? null);
    await call("POST", `/v1/sessions/${denied}/permissions/${encodeURIComponent(p.requestId)}`, { decision: "deny" });
    await idle(denied);
    expect((await files(denied)).files).toEqual([]);
    await call("POST", `/v1/sessions/${id}/kill`, {});
    await call("POST", `/v1/sessions/${denied}/kill`, {});
  });

  it("卡在工作树里做：工具动过的和 git 看得到的取并集——已经提交的、没提交的新文件、删掉的都在，各写明是哪一路知道的", async () => {
    gitRepo(join(work, "W"));
    const id = await open("W");
    const s = await idle(id);
    const root = s.workspace.path as string;
    const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=测试", "-c", "user.email=test@example.com", ...args], { cwd: root, windowsHide: true, stdio: "pipe" });
    g("add", "hello.txt");
    g("commit", "-q", "-m", "写了 hello"); // 执行方写的，已经提交
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "新的.md"), "# 新的"); // 用命令生成的：只有 git 知道
    rmSync(join(root, "readme.md")); // 删掉了开工时就有的
    const r = await files(id);
    expect(r.root).toBe(root);
    const byPath = Object.fromEntries(r.files.map((f: any) => [f.path, [f.sources, f.exists]]));
    expect(byPath["hello.txt"]).toEqual([["tool", "git"], true]);
    expect(byPath["docs/新的.md"]).toEqual([["git"], true]);
    expect(byPath["readme.md"]).toEqual([["git"], false]);
    expect(r.files.find((f: any) => f.path === "readme.md")).toMatchObject({ size: null, absolutePath: join(root, "readme.md") });
    // 列表里的路径拿去读
    expect((await read(id, "docs/新的.md")).body).toMatchObject({ kind: "markdown", content: "# 新的" });
    expect((await read(id, r.files.find((f: any) => f.path === "hello.txt").absolutePath)).body.content).toBe("你好");
    // 工作树外面（本人的主文件夹）不让读
    expect((await read(id, join(work, "W", "readme.md"))).status).toBe(403);
    // 改名的只列新名字，名字里带空格的原样
    g("checkout", "-q", "--", "readme.md");
    g("mv", "readme.md", "说 明.md");
    const renamed = (await files(id)).files.map((f: any) => f.path);
    expect(renamed).toContain("说 明.md");
    expect(renamed.filter((p: string) => p.includes("readme")).length).toBeLessThanOrEqual(1); // 原来的名字不会被拼进新名字里
    expect((await read(id, "说 明.md")).body.content.trim()).toBe("项目"); // 换行照 git 签出来的样子
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });

  it("本人选的是仓库的子文件夹：执行方说的相对路径按它的工作目录找，没有再按工作树的根找；交出的产出带着在会话根里的路径", async () => {
    const repo = gitRepo(join(work, "M"));
    mkdirSync(join(repo, "apps", "web"), { recursive: true });
    writeFileSync(join(repo, "apps", "web", "page.tsx"), "export default 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo, windowsHide: true, stdio: "pipe" });
    execFileSync("git", ["-c", "user.name=测试", "-c", "user.email=test@example.com", "commit", "-q", "-m", "加 web"], { cwd: repo, windowsHide: true, stdio: "pipe" });
    const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "M" }, title: "M", cwd: join(repo, "apps", "web"), firstMessage: "做 M", permissionMode: "auto" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const id = r.body.id as string;
    const s = await idle(id);
    const root = s.workspace.path as string;
    expect(s.cwd).toBe(join(root, "apps", "web"));
    // 假 claude 在工作目录里写了 hello.txt：回答里写的就是「hello.txt」
    expect((await read(id, "hello.txt")).body).toMatchObject({ path: "apps/web/hello.txt", absolutePath: join(root, "apps", "web", "hello.txt"), content: "你好" });
    expect((await read(id, "page.tsx")).body.path).toBe("apps/web/page.tsx");
    expect((await read(id, "readme.md")).body.path).toBe("readme.md"); // 工作目录里没有，按工作树的根找
    expect((await read(id, "apps/web/hello.txt")).body.content).toBe("你好"); // 列表里的 path
    expect((await files(id)).files.find((f: any) => f.sources.includes("tool"))).toMatchObject({ path: "apps/web/hello.txt" });
    // 交一份产出：事件里带它在会话根里的路径，拿去就能读
    const secret = JSON.parse(readFileSync(join(t.dataDir, "sessions", id, "session.json"), "utf8")).mcpSecret;
    mkdirSync(join(root, "apps", "web", "docs"));
    writeFileSync(join(root, "apps", "web", "docs", "方案.md"), "# 方案");
    const added = await raw(t.port, {
      method: "POST", path: `/internal/sessions/${id}/mcp`, headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "add_artifact", arguments: { path: "docs/方案.md" } } }),
    });
    expect(added.body.result.isError).toBe(false);
    const artifact = readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "artifact");
    expect(artifact).toMatchObject({ fileName: "方案.md", path: "apps/web/docs/方案.md" });
    expect((await read(id, artifact.path)).body).toMatchObject({ kind: "markdown", content: "# 方案" });
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });

  it("本人把这个文件夹从允许的文件夹里移除以后：读文件、列文件都不行", async () => {
    const id = await open("Z");
    await idle(id);
    await call("POST", `/v1/sessions/${id}/kill`, {});
    expect((await read(id, "hello.txt")).status).toBe(200);
    const folder = (await call("GET", "/v1/folders")).body.folders[0];
    expect((await call("DELETE", `/v1/folders/${folder.id}`)).status).toBe(200);
    expect((await read(id, "hello.txt")).status).toBe(403);
    expect((await call("GET", `/v1/sessions/${id}/files`)).status).toBe(403);
  });
});
