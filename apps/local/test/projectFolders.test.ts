// 一个项目在一台电脑上绑多个文件夹（设计 17.2 第 46 条，契约 LocalProjectFolder.folders、LocalProjectFolderRequest.folderIds）：
// 第一个是工作目录，其余是会话另外能读写的目录。用假 claude、假 codex，不调模型。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalFolderListResponse, LocalProjectFolder, LocalProjectListResponse, LocalSessionFileReadResponse, LocalSessionFilesResponse } from "@warmap/contracts";
import { registerFormats } from "../src/store.js";
import { codexProfileId } from "../src/codexCatalog.js";
import { api, pair, raw, startTestRunner, tempDir } from "./helpers.js";

registerFormats();
const conforms = (schema: Parameters<typeof Value.Check>[0], value: unknown) => {
  expect([...Value.Errors(schema, value)].map((e) => `${e.path} ${e.message}`)).toEqual([]);
};
async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const posix = (p: string) => p.replaceAll("\\", "/");
const same = (a: string, b: string) => posix(a).toLowerCase() === posix(b).toLowerCase();
const SOL = codexProfileId("gpt-6.1-sol");
const P1 = "88888888-8888-4888-8888-888888888881";
const P2 = "88888888-8888-4888-8888-888888888882";
const P3 = "88888888-8888-4888-8888-888888888883";
const P4 = "88888888-8888-4888-8888-888888888884";

describe("一个项目绑多个文件夹", { timeout: 60_000 }, () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const dataDir = tempDir("tl-mf-data-");
  const repo = tempDir("tl-mf-repo-");
  const docs = tempDir("tl-mf-docs-");
  const third = tempDir("tl-mf-third-");
  const sub = join(repo, "sub");
  const web = join(repo, "web");
  const gone = tempDir("tl-mf-gone-");
  const picked = tempDir("tl-mf-picked-");
  let a: any, b: any, c: any, s: any; // 允许的文件夹：仓库、docs、third、仓库里的 sub
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  const put = (projectId: string, body: unknown) => call("PUT", `/v1/projects/${projectId}/folder`, body);
  const project = async (projectId: string) => (await call("GET", "/v1/projects")).body.projects.find((p: any) => p.projectId === projectId);
  const ids = (p: any) => p.folders.map((f: any) => f.id);
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body.session;
  const status = (id: string, want: string) => until(async () => { const x = await session(id); return x.status === want ? x : null; });
  const events = (id: string) => lines(join(dataDir, "sessions", id, "events.jsonl"));
  const asked = (id: string) => events(id).filter((e) => e.type === "permission_request").length;
  const say = async (id: string, text: string) => { expect((await call("POST", `/v1/sessions/${id}/messages`, { text })).status).toBe(200); };
  const kill = (id: string) => call("POST", `/v1/sessions/${id}/kill`, {});
  const read = (id: string, path: string) => call("POST", `/v1/sessions/${id}/files/read`, { path });
  /** 假 claude 的配置跟着仓库走：卡的工作树从最新的提交开，所以每张卡开工前提交一份。 */
  const commitFake = (cfg: Record<string, unknown>) => {
    writeFileSync(join(repo, ".fake-claude.json"), JSON.stringify(cfg));
    git(repo, "-c", "user.name=测试", "-c", "user.email=test@example.com", "commit", "-q", "-am", "配置");
  };
  const card = async (cardId: string, projectId: string, extra: Record<string, unknown> = {}) => {
    const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId, projectId }, title: cardId, firstMessage: "做", permissionMode: "auto", ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.workspace).toMatchObject({ kind: "worktree", folder: a.path });
    return r.body;
  };
  /** 假 claude 这次拉起收到的 --add-dir。 */
  const addDirs = (traceDir: string, sessionId: string) => {
    const argv = lines(join(traceDir, ".fake-claude-trace.jsonl")).filter((l) => l.argv?.includes(sessionId)).at(-1)!.argv as string[];
    return argv.flatMap((x, i) => (x === "--add-dir" ? [argv[i + 1]!] : []));
  };

  beforeAll(async () => {
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, ".gitignore"), ".fake-claude-trace.jsonl\n.fake-claude-turns.jsonl\n");
    writeFileSync(join(repo, ".fake-claude.json"), "{}");
    mkdirSync(sub);
    writeFileSync(join(sub, "说明.md"), "子文件夹\n");
    mkdirSync(web);
    writeFileSync(join(web, "页面.md"), "另一个子文件夹\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=测试", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init");
    writeFileSync(join(docs, "记录.md"), "# 记录\n");
    writeFileSync(join(third, "别的.md"), "不在项目里\n");
    mkdirSync(join(dataDir, "codex"), { recursive: true });
    writeFileSync(join(dataDir, "codex", "auth.json"), "{}"); // Codex 已经登录着（假 codex 看这个）
    const picks = [repo, docs, third, sub, gone, picked, web];
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    t = await startTestRunner({ dataDir, pickFolder: () => picks.shift() ?? null, fetchImpl: offline, fakeCodex: true });
    token = await pair(t.port);
    [a, b, c, s] = [(await call("POST", "/v1/folders/pick", {})).body.folder, (await call("POST", "/v1/folders/pick", {})).body.folder,
      (await call("POST", "/v1/folders/pick", {})).body.folder, (await call("POST", "/v1/folders/pick", {})).body.folder];
  });
  afterAll(() => t.cleanup());

  it("绑定：整份列表换掉、调顺序、全部解绑；老网页只发 folderId 照旧（只换第一个）；老格式的记录照读；删文件夹后面的顶上", async () => {
    // 整份列表：第一个是工作目录，folder 就是它
    const two = await put(P4, { folderIds: [a.id, b.id], name: "多文件夹" });
    expect(two.status).toBe(200);
    conforms(LocalProjectFolder, two.body);
    expect(two.body).toMatchObject({ name: "多文件夹", folder: { id: a.id, path: a.path, label: a.label }, folders: [{ id: a.id }, { id: b.id, path: b.path, label: b.label }] });
    // 记录里也写着 folderId（等于第一个）：换回老的本机程序还认得工作目录
    expect(JSON.parse(readFileSync(join(dataDir, "projects.json"), "utf8"))[P4]).toMatchObject({ folderId: a.id, folderIds: [a.id, b.id] });
    // 两个都给、都不给、有重复的：400；有一个不在允许的列表里：404，一个都不改
    expect((await put(P4, { folderId: a.id, folderIds: [a.id] })).status).toBe(400);
    expect((await put(P4, { name: "只改名" })).status).toBe(400);
    expect((await put(P4, { folderIds: [a.id, a.id] })).status).toBe(400);
    expect((await put(P4, { folderIds: [c.id, "000000000000"] })).status).toBe(404);
    expect(ids(await project(P4))).toEqual([a.id, b.id]);
    // 调顺序就是换工作目录
    expect((await put(P4, { folderIds: [b.id, a.id] })).body).toMatchObject({ folder: { id: b.id }, name: "多文件夹" });
    // 连接页：两个文件夹都挂着这个项目
    const folders = (await call("GET", "/v1/folders")).body;
    conforms(LocalFolderListResponse, folders);
    expect(folders.folders.filter((f: any) => f.projects.some((p: any) => p.projectId === P4)).map((f: any) => f.id)).toEqual([a.id, b.id]);

    // 老网页：只发 folderId，换掉第一个，其余不动
    expect(ids((await put(P4, { folderId: c.id })).body)).toEqual([c.id, a.id]);
    // 它本来就在其余的里面：挪到第一个（原来的第一个换掉了）
    expect(ids((await put(P4, { folderId: a.id })).body)).toEqual([a.id]);
    // 老网页的 null：全部解绑
    await put(P4, { folderIds: [a.id, b.id, c.id] });
    const none = (await put(P4, { folderId: null })).body;
    expect([none.folder, none.folders]).toEqual([null, []]);
    // 空列表也是全部解绑
    await put(P4, { folderIds: [a.id, b.id] });
    expect((await put(P4, { folderIds: [] })).body).toMatchObject({ folder: null, folders: [] });

    // 选文件夹时带着项目（老网页绑文件夹的写法）：换掉第一个，其余不动
    await put(P4, { folderIds: [b.id, c.id] });
    const g = (await call("POST", "/v1/folders/pick", { projectId: P4 })).body;
    expect(ids(g.project)).toEqual([g.folder.id, c.id]);
    // 删掉一个允许的文件夹：它从项目里拿掉；拿掉的是第一个，剩下的第一个成了工作目录
    expect((await call("DELETE", `/v1/folders/${g.folder.id}`)).status).toBe(200);
    const promoted = await project(P4);
    expect([promoted.folder.id, ids(promoted)]).toEqual([c.id, [c.id]]);
    // 给项目再加一个：先选（不带项目），再交整份
    const again = (await call("POST", "/v1/folders/pick", {})).body;
    const more = again.folder;
    expect(again.project).toBeUndefined();
    expect(ids((await put(P4, { folderIds: [c.id, more.id] })).body)).toEqual([c.id, more.id]);

    // 11/10 以前的记录只有一个 folderId：照读
    const file = join(dataDir, "projects.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...saved, [P4]: { folderId: b.id, name: "老记录", updatedAt: "2026-11-08T00:00:00.000Z" } }));
    const old = await project(P4);
    expect([old.folder.id, ids(old), old.name]).toEqual([b.id, [b.id], "老记录"]);
    conforms(LocalProjectListResponse, (await call("GET", "/v1/projects")).body);
  });

  it("Claude Code 的卡在工作树里做：其余目录交给它（--add-dir、工作规矩里写明），在里面改文件不问；不在项目里的文件夹照样问；读文件、改动的文件认其余目录", async () => {
    // 仓库里的 sub 和工作目录套着，不算其余目录
    expect((await put(P1, { folderIds: [a.id, b.id, s.id], name: "甲" })).status).toBe(200);
    const note = join(docs, "记录.md");
    commitFake({ writePath: note });
    const c1 = await card("mf-c1", P1);
    await status(c1.id, "idle");
    const dirs = addDirs(c1.workspace.path, c1.id);
    expect(dirs).toHaveLength(1);
    expect(same(dirs[0]!, b.path)).toBe(true);
    const rules = readFileSync(join(dataDir, "sessions", c1.id, "system.md"), "utf8");
    expect(rules).toContain("## 项目另外的文件夹");
    expect(rules).toContain(`- ${b.path}`);
    expect(rules).not.toContain(`- ${s.path}`);
    // 「自动」档：写其余目录里的文件没来问本人
    expect(events(c1.id).some((e) => e.type === "tool_call" && e.name === "Write")).toBe(true);
    expect(asked(c1.id)).toBe(0);

    // 改动的文件：其余目录里工具动过的也列，path 是绝对路径
    const files = (await call("GET", `/v1/sessions/${c1.id}/files`)).body;
    conforms(LocalSessionFilesResponse, files);
    const listed = files.files.find((f: any) => same(f.absolutePath, note));
    expect(listed).toMatchObject({ sources: ["tool"], exists: true });
    expect(same(listed.path, note)).toBe(true);
    // 读文件：其余目录里的给绝对路径能读；相对路径不去其余目录里猜；不在项目里的文件夹（本人允许着也）不行
    const got = await read(c1.id, note);
    expect(got.status).toBe(200);
    conforms(LocalSessionFileReadResponse, got.body);
    expect(got.body).toMatchObject({ kind: "markdown", content: "# 记录\n", name: "记录.md" });
    expect(same(got.body.path, note)).toBe(true);
    expect((await read(c1.id, listed.path)).status).toBe(200); // 列表给的 path 原样拿来问
    expect((await read(c1.id, "记录.md")).status).toBe(404);
    expect((await read(c1.id, join(third, "别的.md"))).status).toBe(403);
    expect((await read(c1.id, join(docs, "..", "x.md"))).status).toBe(403);

    // 验收员跟着卡：其余目录一样认，卡的主文件夹不算（它在工作树里看）
    const secret = JSON.parse(readFileSync(join(dataDir, "sessions", c1.id, "session.json"), "utf8")).mcpSecret;
    await raw(t.port, {
      method: "POST", path: `/internal/sessions/${c1.id}/mcp`, headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hand_back", arguments: { summary: "做完了", criteria: [{ index: 1, result: "met", evidence: "x" }] } } }),
    });
    const verifier = await until(async () => (await call("GET", "/v1/sessions")).body.sessions.find((x: any) => x.subject.kind === "verify" && x.subject.cardId === "mf-c1"));
    expect((await read(verifier.id, note)).status).toBe(200);
    expect((await read(verifier.id, join(a.path, ".gitignore"))).status).toBe(403);

    // 不在这个项目里的文件夹：本人允许着，卡在工作树里照样问
    commitFake({ writePath: join(third, "x.md") });
    const c2 = await card("mf-c2", P1);
    await status(c2.id, "waiting_permission");
    expect(asked(c2.id)).toBe(1);
    await kill(c2.id);

    // 中途把 docs 从项目里减掉：放行的范围马上跟着变（再写就问），读文件也不认了
    expect(ids((await put(P1, { folderIds: [a.id] })).body)).toEqual([a.id]);
    await say(c1.id, "再写一次");
    await status(c1.id, "waiting_permission");
    expect(asked(c1.id)).toBe(1);
    expect((await read(c1.id, note)).status).toBe(403);
    await kill(c1.id);
  });

  it("Codex 的卡在工作树里做：其余目录交给它（可写目录、工作规矩里写明），在里面改文件、读文件不问，用命令删的照样问", async () => {
    expect((await put(P2, { folderIds: [a.id, b.id] })).status).toBe(200);
    const x = await card("mf-x1", P2, { modelProfileId: SOL, firstMessage: "hi" });
    await status(x.id, "idle");
    const launch = lines(join(dataDir, "codex", "trace.jsonl")).filter((l) => l.argv && same(l.cwd, x.workspace.path)).at(-1)!.argv as string[];
    expect(launch).toContain(`sandbox_workspace_write.writable_roots=[${JSON.stringify(b.path)}]`);
    expect(readFileSync(join(dataDir, "sessions", x.id, "system.md"), "utf8")).toContain(`- ${b.path}`);

    const file = join(docs, "codex.txt");
    await say(x.id, `patch ${posix(file)}`);
    await until(() => existsSync(file));
    await status(x.id, "idle");
    await say(x.id, `run cat ${posix(file)}`);
    await until(() => lines(join(dataDir, "codex", "trace.jsonl")).some((l) => l.decision === "accept" && String(l.command).includes("cat ")));
    await status(x.id, "idle");
    expect(asked(x.id)).toBe(0);
    const files = (await call("GET", `/v1/sessions/${x.id}/files`)).body;
    expect(files.files.some((f: any) => same(f.absolutePath, file) && f.sources.join() === "tool")).toBe(true);
    // 用命令删其余目录里的文件：那里没有工作树兜底，问本人
    await say(x.id, `run rm ${posix(file)}`);
    await status(x.id, "waiting_permission");
    expect(asked(x.id)).toBe(1);
    await kill(x.id);
  });

  it("绑的是同一个仓库里的两个子文件夹：卡的工作树里已经有整个仓库，另一个子文件夹不算其余目录（不然卡绕过工作树改主文件夹）", async () => {
    const w = (await call("POST", "/v1/folders/pick", {})).body.folder;
    expect(same(w.path, web)).toBe(true);
    expect(ids((await put(P4, { folderIds: [s.id, w.id, b.id] })).body)).toEqual([s.id, w.id, b.id]);
    commitFake({ writePath: join(web, "页面.md") });
    const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "mf-sib", projectId: P4 }, title: "子文件夹", firstMessage: "做", permissionMode: "auto" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.workspace).toMatchObject({ kind: "worktree", folder: s.path });
    expect(same(r.body.cwd, join(r.body.workspace.path, "sub"))).toBe(true);
    // 写主文件夹里的另一个子文件夹：照样问本人；交给执行方的其余目录只有仓库外面的 docs
    await status(r.body.id, "waiting_permission");
    const dirs = addDirs(r.body.workspace.path, r.body.id);
    expect(dirs.map((d) => posix(d).toLowerCase())).toEqual([posix(b.path).toLowerCase()]);
    expect((await read(r.body.id, join(web, "页面.md"))).status).toBe(403);
    await kill(r.body.id);
  });

  it("不在工作树里做的会话（专题）：没指定目录就在第一个文件夹里，其余目录一样交给它", async () => {
    expect((await put(P3, { folderIds: [b.id, c.id] })).status).toBe(200);
    const r = await call("POST", "/v1/sessions", { subject: { kind: "topic", topicId: "mf-tp", projectId: P3 }, title: "调研", firstMessage: "调研" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(same(r.body.cwd, docs)).toBe(true);
    const dirs = await until(() => { try { return addDirs(docs, r.body.id); } catch { return null; } });
    expect(dirs.map((d) => posix(d).toLowerCase())).toEqual([posix(c.path).toLowerCase()]);
    await kill(r.body.id);
    // 没挂项目的会话不带
    mkdirSync(join(third, "散"), { recursive: true });
    const loose = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "mf-loose" }, title: "散卡", cwd: join(third, "散"), firstMessage: "做" });
    expect(loose.status, JSON.stringify(loose.body)).toBe(200);
    const none = await until(() => { try { return addDirs(join(third, "散"), loose.body.id); } catch { return null; } });
    expect(none).toEqual([]);
    await kill(loose.body.id);
  });

  it("允许的范围只有工作目录和项目绑的文件夹（11/11）：本人允许过、但这个项目没绑的文件夹算工作区外，「自动」照样问；绑上了就不问", async () => {
    const target = join(third, "别的文件夹里的表.md");
    writeFileSync(join(docs, ".fake-claude.json"), JSON.stringify({ writePath: target }));
    const start = async (topicId: string) => {
      const r = await call("POST", "/v1/sessions", { subject: { kind: "topic", topicId, projectId: P4 }, title: "调研", firstMessage: "调研", permissionMode: "auto" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body;
    };
    // 只绑 docs：third 本人允许过，但不是这个项目的
    expect((await put(P4, { folderIds: [b.id] })).status).toBe(200);
    const x = await start("mf-scope-1");
    await status(x.id, "waiting_permission");
    const perm = (await call("GET", `/v1/sessions/${x.id}`)).body.pendingPermissions[0];
    expect(perm.outsidePaths.map((p: string) => posix(p).toLowerCase())).toEqual([posix(target).toLowerCase()]);
    expect(existsSync(target)).toBe(false);
    await kill(x.id);
    // 绑上 third：在范围内，「自动」直接写
    expect((await put(P4, { folderIds: [b.id, c.id] })).status).toBe(200);
    const y = await start("mf-scope-2");
    await status(y.id, "idle");
    expect(asked(y.id)).toBe(0); // 假 claude 给了 writePath 时只要权限、不真写
    writeFileSync(join(docs, ".fake-claude.json"), "{}");
  });
});
