// 改、删前留一份（11/11 本人定，ADR 0039，契约 LocalUndo、LocalSessionRestoreRequest）：真的临时文件夹、真的 git，不调模型。
// 前半段直接用 UndoStore（命令、脚本、子 agent 改文件都只是「这一轮里文件变了」，这里直接改文件代替）；后半段经本机 API 和假 Claude Code。
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalSessionFilesResponse, LocalSessionRestoreResponse, LocalSessionSummary } from "@warmap/contracts";
import { UNDO_LIMITS, UndoStore, isSyncFolder, type SessionUndo } from "../src/undo/index.js";
import { modeAllows, type PathScope } from "../src/agents/pathGuard.js";
import { registerFormats } from "../src/store.js";
import { api, pair, startTestRunner, tempDir } from "./helpers.js";

registerFormats();
const WIN = process.platform === "win32";
const sha = (p: string) => createHash("sha1").update(readFileSync(p)).digest("hex");
async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 20_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** 一个本人的普通文件夹：Markdown、仿 Word / Excel、中文子目录。 */
function folder(): string {
  const dir = tempDir("tl-undo-folder-");
  writeFileSync(join(dir, "笔记.md"), "# 原文\n");
  writeFileSync(join(dir, "报销单.xlsx"), Buffer.from([1, 2, 3, 4, 5]));
  mkdirSync(join(dir, "人事 文档"));
  writeFileSync(join(dir, "人事 文档", "合同.docx"), "合同原文");
  return dir;
}

function store(opts: { own?: string; free?: number } = {}) {
  const notices: { id: string; level: string; text: string }[] = [];
  const dir = tempDir("tl-undo-data-");
  const s = new UndoStore(dir, {
    isOwn: (p) => Boolean(opts.own) && p.toLowerCase().startsWith(opts.own!.toLowerCase()),
    changed: () => {}, notice: (id, level, text) => notices.push({ id, level, text }),
    ...(opts.free !== undefined ? { free: () => opts.free! } : {}),
  });
  return { s, dir, notices };
}

/** 开工并等开工那份留好（或降级）。 */
async function opened(u: SessionUndo): Promise<SessionUndo> {
  u.open();
  await until(() => u.view().state !== "preparing");
  return u;
}
/** 一轮：开始前留一份 → 执行方干活（fn）→ 结束后留一份。 */
async function turn(u: SessionUndo, fn: () => void) {
  u.onEvent("agent_info");
  await u.beforeWrite("Bash", { command: "x" }, ".");
  fn();
  u.onEvent("turn_end");
  await u.files();
}

const saved = { ...UNDO_LIMITS };
afterEach(() => Object.assign(UNDO_LIMITS, saved));

describe("留一份：整份快照（普通文件夹）", { timeout: 60_000 }, () => {
  it("命令、脚本、子 agent 改的、删的、新建的都列得出来；单个恢复、全部恢复逐字节回到开工前；恢复前现在的样子也留了一份", async () => {
    const dir = folder();
    const before = { md: sha(join(dir, "笔记.md")), xlsx: sha(join(dir, "报销单.xlsx")), docx: sha(join(dir, "人事 文档", "合同.docx")) };
    const { s, dir: data } = store();
    const u = await opened(s.for("s1", dir));
    expect(u.view()).toEqual({ state: "ready" });
    await turn(u, () => {
      writeFileSync(join(dir, "笔记.md"), "被命令改了");          // 命令改的
      rmSync(join(dir, "报销单.xlsx"));                            // 命令删的
      writeFileSync(join(dir, "人事 文档", "合同.docx"), "子 agent 改的");
      writeFileSync(join(dir, "新建的.md"), "执行方新建");          // 新建的
    });
    const files = Object.fromEntries((await u.files()).map((f) => [f.path, f]));
    expect(files["笔记.md"]).toMatchObject({ source: "snapshot", change: "modified", restorable: true });
    expect(files["报销单.xlsx"]).toMatchObject({ change: "deleted" });
    expect(files["人事 文档/合同.docx"]).toMatchObject({ change: "modified" });
    expect(files["新建的.md"]).toMatchObject({ change: "added" });
    // 单个恢复：改了的
    const one = await u.restore(["笔记.md"]);
    expect(Value.Check(LocalSessionRestoreResponse, one)).toBe(true);
    expect(one).toEqual({ restored: ["笔记.md"], failed: [] });
    expect(sha(join(dir, "笔记.md"))).toBe(before.md);
    expect((await u.files()).find((f) => f.path === "笔记.md")?.restoredAt).toBeTruthy();
    // 绝对路径也认；不是这个会话动的回 no_copy
    const odd = await u.restore([join(dir, "报销单.xlsx"), "别的.md"]);
    expect(odd.restored).toEqual(["报销单.xlsx"]);
    expect(odd.failed).toEqual([{ path: "别的.md", reason: "no_copy", message: expect.any(String) }]);
    expect(sha(join(dir, "报销单.xlsx"))).toBe(before.xlsx);
    // 全部恢复：剩下的改回去、新建的删掉
    const all = await u.restore();
    expect(all.failed).toEqual([]);
    expect(sha(join(dir, "人事 文档", "合同.docx"))).toBe(before.docx);
    expect(existsSync(join(dir, "新建的.md"))).toBe(false);
    // 恢复前留的那份：影子仓库里有 restore- 开头的提交
    const repo = readdirSync(join(data, "repos"))[0]!;
    const refs = execFileSync("git", ["--git-dir", join(data, "repos", repo), "for-each-ref", "--format=%(refname)", "refs/tianshu/s1/"], { encoding: "utf8" });
    expect(refs).toMatch(/restore-/);
  });

  it("本人在两轮之间自己改的：不算会话改的；恢复回到会话动它之前（本人的版本），不冲掉本人的改动", async () => {
    const dir = folder();
    const { s } = store();
    const u = await opened(s.for("s2", dir));
    await turn(u, () => writeFileSync(join(dir, "笔记.md"), "第一轮执行方改的"));
    writeFileSync(join(dir, "人事 文档", "合同.docx"), "本人自己改的"); // 两轮之间，本人改的
    await turn(u, () => writeFileSync(join(dir, "人事 文档", "合同.docx"), "第二轮执行方又改了"));
    writeFileSync(join(dir, "本人新建.md"), "本人的"); // 会话结束以后本人建的
    const paths = (await u.files()).map((f) => f.path).sort();
    expect(paths).toEqual(["人事 文档/合同.docx", "笔记.md"]);
    await u.restore();
    expect(readFileSync(join(dir, "人事 文档", "合同.docx"), "utf8")).toBe("本人自己改的");
    expect(readFileSync(join(dir, "笔记.md"), "utf8")).toBe("# 原文\n");
    expect(readFileSync(join(dir, "本人新建.md"), "utf8")).toBe("本人的");
  });

  it("恢复以后又被会话改了：restoredAt 去掉；再恢复照样回到会话第一次动它之前", async () => {
    const dir = folder();
    const { s } = store();
    const u = await opened(s.for("s3", dir));
    await turn(u, () => writeFileSync(join(dir, "笔记.md"), "一改"));
    await u.restore(["笔记.md"]);
    await turn(u, () => writeFileSync(join(dir, "笔记.md"), "二改"));
    expect((await u.files()).find((f) => f.path === "笔记.md")?.restoredAt).toBeUndefined();
    await u.restore(["笔记.md"]);
    expect(readFileSync(join(dir, "笔记.md"), "utf8")).toBe("# 原文\n");
  });

  it("不进快照的：目录联接（不跟到外面）、node_modules、套着的 git 仓库、大文件；文件夹自己的 .gitignore 里的照样留；路径超长照样留", async () => {
    const dir = folder();
    const outside = tempDir("tl-undo-outside-");
    writeFileSync(join(outside, "外面的.md"), "外面原文");
    if (WIN) execFileSync("cmd", ["/c", "mklink", "/J", join(dir, "联接"), outside], { stdio: "ignore" });
    mkdirSync(join(dir, "tool", "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "tool", "node_modules", "x", "a.js"), "x");
    mkdirSync(join(dir, "子仓库"));
    writeFileSync(join(dir, "子仓库", "里面.md"), "子仓库原文");
    execFileSync("git", ["init", "-q"], { cwd: join(dir, "子仓库") });
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    writeFileSync(join(dir, "运行记录.log"), "日志原文");
    UNDO_LIMITS.bigFile = 1024;
    writeFileSync(join(dir, "大视频.mp4"), Buffer.alloc(4096, 7));
    let deep = dir;
    for (let i = 0; i < 10; i++) deep = join(deep, `很长的中文目录名字第${i}层_abcdefghij`);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "长路径.md"), "长路径原文");
    const { s } = store();
    const u = await opened(s.for("s4", dir));
    expect(u.view().state).toBe("ready");
    // 兜底范围：快照管得住的才算
    expect(u.covers(join(dir, "运行记录.log"))).toBe(true);
    expect(u.covers(join(deep, "长路径.md"))).toBe(true);
    expect(u.covers(join(dir, "大视频.mp4"))).toBe(false);
    expect(u.covers(join(dir, "子仓库", "里面.md"))).toBe(false);
    expect(u.covers(join(dir, "tool", "node_modules", "x", "a.js"))).toBe(false);
    if (WIN) expect(u.covers(join(dir, "联接", "外面的.md"))).toBe(false);
    await turn(u, () => {
      writeFileSync(join(dir, "运行记录.log"), "被改了");
      writeFileSync(join(deep, "长路径.md"), "被改了");
      if (WIN) writeFileSync(join(outside, "外面的.md"), "从联接改了");
    });
    const paths = (await u.files()).map((f) => f.path);
    expect(paths.some((p) => p.startsWith("联接"))).toBe(false); // 没跟到外面
    await u.restore();
    expect(readFileSync(join(dir, "运行记录.log"), "utf8")).toBe("日志原文");
    expect(readFileSync(join(deep, "长路径.md"), "utf8")).toBe("长路径原文");
    if (WIN) expect(readFileSync(join(outside, "外面的.md"), "utf8")).toBe("从联接改了"); // 恢复也不写到外面
    // 大文件：改文件工具要改它时拷一份，能恢复
    await u.beforeWrite("Edit", { file_path: join(dir, "大视频.mp4") }, dir);
    expect(u.covers(join(dir, "大视频.mp4"))).toBe(true);
    writeFileSync(join(dir, "大视频.mp4"), "改坏了");
    expect((await u.restore([join(dir, "大视频.mp4")])).failed).toEqual([]);
    expect(readFileSync(join(dir, "大视频.mp4"))).toEqual(Buffer.alloc(4096, 7));
  });
});

describe("留一份：只改前拷一份（太大、同步盘、盘不够、没留成、本机自己的目录）", { timeout: 60_000 }, () => {
  it("太大：降级成 touched_only、出一行提示；改文件工具改的照样拷一份能恢复，命令改的不在兜底里", async () => {
    UNDO_LIMITS.files = 2;
    const dir = folder();
    const { s, notices } = store();
    const u = await opened(s.for("t1", dir));
    expect(u.view()).toMatchObject({ state: "touched_only", reason: "too_large" });
    expect(notices.some((n) => n.level === "warn" && n.text.includes("太大"))).toBe(true);
    expect(u.covers(join(dir, "笔记.md"))).toBe(false);
    await u.beforeWrite("Edit", { file_path: "笔记.md" }, dir);
    expect(u.covers(join(dir, "笔记.md"))).toBe(true);
    writeFileSync(join(dir, "笔记.md"), "执行方改了");
    const f = (await u.files()).find((x) => x.path === "笔记.md");
    expect(f).toMatchObject({ source: "copy", change: "modified", restorable: true });
    await u.restore(["笔记.md"]);
    expect(readFileSync(join(dir, "笔记.md"), "utf8")).toBe("# 原文\n");
  });

  it("同步盘里的文件夹、盘不够、影子仓库建不起来：都降级，原因写对", async () => {
    const parent = tempDir("tl-undo-onedrive-");
    const synced = join(parent, "工作");
    mkdirSync(synced);
    expect(isSyncFolder(synced, { OneDrive: parent })).toBe(true);
    expect(isSyncFolder(join(tempDir("tl-undo-x-"), "OneDrive - 公司", "a"), {})).toBe(true);
    expect(isSyncFolder(tempDir("tl-undo-plain-"), {})).toBe(false);
    const full = store({ free: 0 });
    expect((await opened(full.s.for("t2", folder()))).view()).toMatchObject({ state: "touched_only", reason: "disk_full" });
    const broken = store();
    writeFileSync(join(broken.dir, "repos"), "不是目录"); // 影子仓库建不起来（像没权限）
    expect((await opened(broken.s.for("t3", folder()))).view()).toMatchObject({ state: "touched_only", reason: "failed" });
  });

  it("本机自己的目录（专题、此电脑）：不整份留；那里面的不用拷，外面本人的文件改前拷一份", async () => {
    const own = tempDir("tl-undo-own-");
    const mine = join(tempDir("tl-undo-desk-"), "桌面上的.md");
    writeFileSync(mine, "本人的");
    writeFileSync(join(own, "稿.md"), "草稿");
    const { s } = store({ own });
    const u = await opened(s.for("t4", null));
    expect(u.view()).toEqual({ state: "touched_only" });
    expect(u.covers(join(own, "稿.md"))).toBe(true);
    expect(u.covers(mine)).toBe(false);
    await u.beforeWrite("Write", { file_path: join(own, "稿.md") }, own);
    await u.beforeWrite("Write", { file_path: mine }, own);
    await u.beforeWrite("Write", { file_path: join(own, "新的.md") }, own);
    expect(u.covers(mine)).toBe(true);
    writeFileSync(mine, "执行方覆盖了");
    expect((await u.files()).map((f) => f.absolutePath)).toEqual([mine]);
    await u.restore();
    expect(readFileSync(mine, "utf8")).toBe("本人的");
  });
});

describe("留一份：时机和清理", { timeout: 60_000 }, () => {
  it("开工不等；开工那份没留好时，命令等它（改文件工具不等，先拷一份）；留好以后才算兜底", async () => {
    const dir = folder();
    const { s } = store();
    const u = s.for("w1", dir);
    u.open(); // 不 await
    expect(u.view().state).toBe("preparing");
    expect(u.covers(join(dir, "笔记.md"))).toBe(false);
    await u.beforeWrite("Edit", { file_path: join(dir, "笔记.md") }, dir); // 先拷一份
    expect(u.covers(join(dir, "笔记.md"))).toBe(true);
    await u.beforeWrite("PowerShell", { command: "Remove-Item 报销单.xlsx" }, dir); // 等开工那份
    expect(u.view().state).toBe("ready");
    expect(u.covers(join(dir, "报销单.xlsx"))).toBe(true);
  });

  it("清理：最后一次活动 14 天以前的清掉（影子仓库没人用了一起删）；在跑的不清", async () => {
    const dir = folder();
    const { s, dir: data } = store();
    await opened(s.for("old", dir));
    await opened(s.for("live", folder()));
    const later = Date.now() + 15 * 86_400_000;
    const dropped = await s.cleanup(new Set(["live"]), later);
    expect(dropped).toEqual(["old"]);
    expect(existsSync(join(data, "sessions", "old"))).toBe(false);
    expect(existsSync(join(data, "sessions", "live"))).toBe(true);
    expect(readdirSync(join(data, "repos"))).toHaveLength(1);
  });

  it.runIf(WIN)("恢复时文件被别的程序打开着（像 Excel）：报 in_use，其余照样恢复", async () => {
    const dir = folder();
    const { s } = store();
    const u = await opened(s.for("x1", dir));
    await turn(u, () => {
      writeFileSync(join(dir, "报销单.xlsx"), "改了");
      writeFileSync(join(dir, "笔记.md"), "改了");
    });
    const file = join(dir, "报销单.xlsx");
    const hold = spawn("powershell", ["-NoProfile", "-Command", `$f=[System.IO.File]::Open('${file}','Open','ReadWrite','Read'); Start-Sleep 30`], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 2500));
      const r = await u.restore();
      expect(r.restored).toEqual(["笔记.md"]);
      expect(r.failed).toMatchObject([{ path: "报销单.xlsx", reason: "in_use" }]);
    } finally {
      hold.kill();
    }
  });
});

describe("「自动」在有兜底的文件夹里放行删、挪命令（11/11）", () => {
  it("碰的地方都有兜底才放；工作目录或某个路径没兜底照样问", () => {
    const dir = tempDir("tl-undo-auto-");
    const other = tempDir("tl-undo-auto-other-");
    const base: PathScope = { cwd: dir, home: tempDir("tl-undo-home-"), allowedRoots: () => [dir] };
    const covered: PathScope = { ...base, covered: (p) => p.toLowerCase().startsWith(dir.toLowerCase()) };
    const ok = (s: PathScope, command: string) => modeAllows("auto", "PowerShell", { command }, s, undefined, null);
    expect(ok(covered, "Remove-Item 旧表.xlsx")).toBe(true);
    expect(ok(covered, "Move-Item a.md b.md")).toBe(true);
    expect(ok(base, "Remove-Item 旧表.xlsx")).toBe(false); // 没兜底：照旧问
    expect(ok({ ...base, covered: () => false }, "Remove-Item 旧表.xlsx")).toBe(false);
    expect(ok(covered, `Remove-Item ${join(other, "x.md")}`)).toBe(false); // 允许范围外：硬规矩照问
    expect(ok(covered, "git push")).toBe(false); // 对外的照问
  });
});

describe("经本机 API：摘要带 undo、改动的文件、恢复接口", { timeout: 60_000 }, () => {
  it("普通文件夹里的卡：留好了 ready；执行方写的和改的列得出来，带 change、restorable；恢复了记 files_restored；在跑时 409", async () => {
    const work = tempDir("tl-undo-api-");
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const t = await startTestRunner({ pickFolder: work, fetchImpl: offline });
    try {
      const token = await pair(t.port);
      const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
      await call("POST", "/v1/folders/pick", {});
      const dir = join(work, "U");
      mkdirSync(dir);
      writeFileSync(join(dir, "表.md"), "本人的原文");
      writeFileSync(join(work, ".fake-claude.json"), JSON.stringify({ initDelayMs: 1500 }));
      const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "U" }, title: "U", cwd: dir, firstMessage: "做", permissionMode: "auto" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const id = r.body.id;
      const s = await until(async () => { const x = (await call("GET", `/v1/sessions/${id}`)).body.session; return x.status === "idle" && x.undo?.state === "ready" ? x : null; });
      expect(Value.Check(LocalSessionSummary, s)).toBe(true);
      // 执行方写了 hello.txt
      const files = (await call("GET", `/v1/sessions/${id}/files`)).body;
      expect(Value.Check(LocalSessionFilesResponse, files)).toBe(true);
      const byPath = Object.fromEntries(files.files.map((f: any) => [f.path, f]));
      expect(byPath["hello.txt"]).toMatchObject({ change: "added", restorable: true, sources: ["tool", "snapshot"] });
      expect(byPath["表.md"]).toBeUndefined();
      const restore = (body: unknown) => call("POST", `/v1/sessions/${id}/files/restore`, body);
      const res = await restore({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(Value.Check(LocalSessionRestoreResponse, res.body)).toBe(true);
      expect(res.body.restored).toContain("hello.txt");
      expect(existsSync(join(dir, "hello.txt"))).toBe(false);
      const ev = readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(ev.find((e) => e.type === "files_restored")).toMatchObject({ all: true });
      expect((await restore({ paths: [] })).status).toBe(400);
      expect((await call("POST", "/v1/sessions/nope/files/restore", {})).status).toBe(404);
      // 在做一轮（等批准）时不让恢复
      const busyDir = join(work, "V");
      mkdirSync(busyDir);
      const b = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "V" }, title: "V", cwd: busyDir, firstMessage: "做", permissionMode: "default" });
      await until(async () => (await call("GET", `/v1/sessions/${b.body.id}`)).body.session.status === "waiting_permission");
      expect((await call("POST", `/v1/sessions/${b.body.id}/files/restore`, {})).status).toBe(409);
    } finally {
      await t.cleanup();
    }
  });
});
