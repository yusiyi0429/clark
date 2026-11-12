// 卡在自己的 git 工作树里做（ADR 0038）：用真的临时 git 仓库测两张卡同时做、交回提交、验收员只看这张卡的改动、合回、不是仓库时排队、清理。
// 假 claude 的配置（.fake-claude.json）提交在仓库里，工作树里也有；它的两个记录文件在 .gitignore 里，不进提交。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { api, pair, raw, startTestRunner, tempDir, ORIGIN } from "./helpers.js";
import { EDIT_SCOPE_RULE } from "../src/rolePrompt.js";

async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8" }).trim();
const PASSING = { summary: "都达到了", criteria: [{ index: 1, verdict: "met", reason: "做了" }] };

/**
 * 临时仓库：main 上一个提交（说明文件、假 claude 的配置、忽略它的记录文件）。
 * 假 claude 每轮写一个文件：默认 hello.txt（在工作树里，不用问就放行）；busy 时要写主文件夹里的文件
 * （主文件夹是本人允许的文件夹，不算越界，但在工作树外面，照样问，卡停在等你批准）。
 */
const MAIN_FILE = "main-folder.txt";
function repo(busy = false): string {
  const dir = tempDir("tl-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "测试");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, ".gitignore"), ".fake-claude-trace.jsonl\n.fake-claude-turns.jsonl\n");
  writeFileSync(join(dir, ".fake-claude.json"), JSON.stringify({ verdict: PASSING, ...(busy ? { writePath: join(dir, MAIN_FILE) } : {}) }));
  writeFileSync(join(dir, "readme.md"), "原来的\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** 假天枢：收同步（全部收下），收到交回以后给验收交代。 */
function fakeCloud() {
  const items: any[] = [];
  const impl = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/local-runner/sync") {
      const body = JSON.parse(init.body);
      items.push(...body.items);
      return json({ accepted: body.items.map((i: any) => i.key), rejected: [] });
    }
    if (url.pathname === "/api/local-runner/verify-brief") {
      const key = url.searchParams.get("handbackKey")!;
      if (!items.some((i) => i.type === "handback" && i.key === key)) return json({}, 404);
      return json({ markdown: "# 验收交代", criteria: ["做了"], role: null, failStreak: 0 });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { impl, items };
}

async function setup(folder: string, max = 3, dataDir?: string, token0?: string, autoMerge = false) {
  const cloud = fakeCloud();
  const t = await startTestRunner({ pickFolder: folder, fetchImpl: cloud.impl, dataDir });
  const token = token0 ?? await pair(t.port);
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  if (!dataDir) {
    await call("POST", "/v1/folders/pick", {});
    await call("PATCH", "/v1/settings", { maxConcurrent: max, autoMerge }); // 这些用例测本人点合并；自动合回另测
    expect((await call("PUT", "/v1/cloud", { apiBaseUrl: ORIGIN, token: "cloud-token-0123456789abcdef" })).status).toBe(200);
  }
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body;
  const status = async (id: string) => (await session(id)).session.status as string;
  const waitStatus = (id: string, want: string) => until(async () => (await status(id)) === want);
  // git 仓库里按「自动」开（工作树里安全的步骤自己放行）；不是 git 仓库的按「每次都问」（这些用例靠写文件时停下等批准）
  const open = async (title: string, cwd = folder, after?: string[]) => (await call("POST", "/v1/sessions", {
    subject: { kind: "card", cardId: title }, title, cwd, firstMessage: `做 ${title}`, permissionMode: existsSync(join(folder, ".git")) ? "auto" : "default", ...(after ? { after } : {}),
  })).body;
  const allow = async (id: string) => {
    const s = await until(async () => { const b = await session(id); return b.pendingPermissions[0] ? b : null; });
    return call("POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(s.pendingPermissions[0].requestId)}`, { decision: "allow" });
  };
  const events = (id: string) => readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  /** 以执行方的身份交回（本会话 MCP）。 */
  const handBack = async (id: string) => {
    const secret = JSON.parse(readFileSync(join(t.dataDir, "sessions", id, "session.json"), "utf8")).mcpSecret;
    const r = await raw(t.port, {
      method: "POST", path: `/internal/sessions/${id}/mcp`, headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hand_back", arguments: { summary: "做完了", criteria: [{ index: 1, result: "met", evidence: "见改动" }] } } }),
    });
    return r.body.result as { isError: boolean; content: { text: string }[] };
  };
  const verifierOf = async (cardId: string, n = 0) =>
    until(async () => ((await call("GET", "/v1/sessions")).body.sessions as any[])
      .filter((s) => s.subject.kind === "verify" && s.subject.cardId === cardId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[n]);
  const merge = (id: string) => call("POST", `/v1/sessions/${id}/merge`, {});
  /** 项目下的「+」开的自由子会话（第 68 条，带 free 的专题）：按「每次都问」开，假 claude 写文件时停下等批准。 */
  const openFree = async (title: string, extra: Record<string, unknown> = {}) => (await call("POST", "/v1/sessions", {
    subject: { kind: "topic", topicId: title }, title, cwd: folder, firstMessage: `做 ${title}`, permissionMode: "default", free: true, ...extra,
  })).body;
  return { t, token, cloud, call, session, status, waitStatus, open, openFree, allow, events, handBack, verifierOf, merge };
}

// 每条要拉起几个假 claude 进程，全套并行跑时最长的一条要 30 秒上下：显式给 60 秒，不靠 vitest 默认的 5 秒或 package.json 里的参数
describe("卡在自己的工作树里做", { timeout: 60_000 }, () => {
  it("同一个仓库两张卡同时做，各在自己的工作树；交回提交到卡的分支；验收员只看这张卡的改动；合回：有改动、不在基线分支、成了、冲突", async () => {
    const main = repo();
    const base = git(main, "rev-parse", "HEAD");
    writeFileSync(join(main, "readme.md"), "主文件夹里没提交的改动\n");
    const h = await setup(main);
    try {
      const a = await h.open("Card-A login");
      const b = await h.open("Card-B");
      // 两张同时开工，各在自己的工作树和分支里
      expect([a.status, b.status]).toEqual(["running", "running"]);
      const wa = a.workspace;
      const wb = b.workspace;
      expect(wa).toMatchObject({ kind: "worktree", branch: "tianshu/cardalog-card-a-login", baseBranch: "main", baseCommit: base, mergedCommit: null });
      expect(wb).toMatchObject({ kind: "worktree", branch: "tianshu/cardb-card-b", baseBranch: "main", baseCommit: base });
      expect(wa.path).toBe(join(h.t.dataDir, "worktrees", "Card-A_login"));
      expect(a.cwd).toBe(wa.path);
      expect(wa.path).not.toBe(wb.path);
      // 主文件夹里没提交的改动没带进工作树，开工时说了
      expect(readFileSync(join(wa.path, "readme.md"), "utf8")).toBe("原来的\n");
      expect(h.events(a.id).find((e) => e.type === "notice" && e.code === "workspace").text)
        .toBe(`在工作树里做：分支 ${wa.branch}，从 main 的最新提交 ${base.slice(0, 7)} 开始；主文件夹里没提交的改动没带进来`);
      // 交代里告诉执行方工作树是新的、要装依赖自己装
      const systemPrompt = readFileSync(join(h.t.dataDir, "sessions", a.id, "system.md"), "utf8");
      expect(systemPrompt).toContain(`分支 ${wa.branch}`);
      expect(systemPrompt).toContain("要装依赖就自己装");

      // 工作树里写文件不用问（自动放行），一轮做完
      await h.waitStatus(a.id, "idle");
      await h.waitStatus(b.id, "idle");
      expect(existsSync(join(wa.path, "hello.txt")) && existsSync(join(wb.path, "hello.txt"))).toBe(true);
      expect([...h.events(a.id), ...h.events(b.id)].some((e) => e.type === "permission_request")).toBe(false);
      expect(existsSync(join(main, "hello.txt"))).toBe(false);
      writeFileSync(join(wa.path, "a.txt"), "A 的改动\n");
      writeFileSync(join(wb.path, "b.txt"), "B 的改动\n");
      writeFileSync(join(wb.path, "hello.txt"), "B 的版本\n"); // 和 A 的 hello.txt 不一样，合回 B 时冲突

      // 交回：没提交的改动提交到卡的分支，交回带提交
      const r = await h.handBack(a.id);
      expect(r.isError).toBe(false);
      const head = git(main, "rev-parse", wa.branch);
      expect(r.content[0]!.text).toContain(`提交 ${head.slice(0, 7)}`);
      expect(git(main, "diff", "--name-only", base, head).split("\n").sort()).toEqual(["a.txt", "hello.txt"]);
      expect(git(main, "log", "-1", "--format=%s", head)).toBe("交回：Card-A login");
      expect(git(wa.path, "status", "--porcelain")).toBe("");
      expect(h.events(a.id).find((e) => e.type === "handback").commit).toBe(head);
      const item = await until(() => h.cloud.items.find((i) => i.type === "handback"));
      expect(item.data.git).toEqual({ branch: wa.branch, baseBranch: "main", baseCommit: base, commit: head });

      // 验收员在 A 的工作树里，交代后面接着开工以来的改动：只有 A 的，没有 B 的
      const v = await h.verifierOf("Card-A login");
      expect(v.cwd).toBe(wa.path);
      await h.waitStatus(v.id, "done");
      const brief = h.events(v.id).find((e) => e.type === "user_message").text as string;
      expect(brief).toContain("# 验收交代");
      expect(brief).toContain(`分支 ${wa.branch} 的提交 ${head.slice(0, 7)}`);
      expect(brief).toContain("a.txt");
      expect(brief).toContain("hello.txt");
      expect(brief).not.toContain("b.txt");
      const verdict = await until(() => h.cloud.items.find((i) => i.type === "verdict"));
      expect(verdict.data.commit).toBe(head);

      // 合回：主文件夹有没提交的改动 → 不合，原样不动
      const dirty = await h.merge(a.id);
      expect(dirty.status).toBe(200);
      expect(dirty.body).toMatchObject({ merged: false, reason: "dirty", files: ["readme.md"] });
      expect(readFileSync(join(main, "readme.md"), "utf8")).toBe("主文件夹里没提交的改动\n");
      // 主文件夹不在 main 上 → 不合
      git(main, "checkout", "-q", "--", "readme.md");
      git(main, "switch", "-q", "-c", "other");
      expect((await h.merge(a.id)).body).toMatchObject({ merged: false, reason: "base_not_checked_out", files: [] });
      git(main, "switch", "-q", "main");
      // 成了：合进 main，工作树清掉，分支留着；再合回 409
      const ok = await h.merge(a.id);
      expect(ok.body.merged).toBe(true);
      expect(ok.body.commit).toBe(git(main, "rev-parse", "HEAD"));
      expect(ok.body.session.workspace.mergedCommit).toBe(ok.body.commit);
      expect(readFileSync(join(main, "a.txt"), "utf8")).toBe("A 的改动\n");
      expect(git(main, "log", "-1", "--format=%s")).toBe(`合回天枢卡「Card-A login」（${wa.branch}）`);
      expect(existsSync(wa.path)).toBe(false);
      expect(git(main, "rev-parse", wa.branch)).toBe(head);
      expect(await h.status(a.id)).toBe("exited"); // 一轮做完还开着的进程先退出了，工作树才删得掉
      expect(h.events(a.id).some((e) => e.type === "notice" && e.code === "merged")).toBe(true);
      expect((await h.merge(a.id)).status).toBe(409);
      // 合完再说一句：工作树已经清理，续不上
      expect((await h.call("POST", `/v1/sessions/${a.id}/messages`, { text: "再改改" })).status).toBe(409);

      // B 交回、验收，合回时和 A 的 hello.txt 冲突 → 放弃这次合并，主文件夹原样
      expect((await h.handBack(b.id)).isError).toBe(false);
      const vb = await h.verifierOf("Card-B");
      await h.waitStatus(vb.id, "done");
      expect(h.events(vb.id).find((e) => e.type === "user_message").text).not.toContain("a.txt");
      const before = git(main, "rev-parse", "HEAD");
      const conflict = await h.merge(b.id);
      expect(conflict.body).toMatchObject({ merged: false, reason: "conflict", files: ["hello.txt"] });
      expect(git(main, "rev-parse", "HEAD")).toBe(before);
      expect(git(main, "status", "--porcelain")).toBe("");
      expect(existsSync(join(main, ".git", "MERGE_HEAD"))).toBe(false);
      expect(existsSync(wb.path)).toBe(true); // 没合成，工作树留着
    } finally {
      await h.t.cleanup();
    }
  });

  it("卡还在跑、工作树里有交回以后的改动、不在工作树里做时，合回回 409；碰工作树外面照样要批准", async () => {
    const main = repo(true);
    const plain = tempDir("tl-plain-");
    const h = await setup(main);
    try {
      const a = await h.open("A");
      await h.waitStatus(a.id, "waiting_permission"); // 要写工作树外面：照样问
      const perm = (await h.session(a.id)).pendingPermissions[0];
      expect([perm.input.file_path, perm.outsidePaths]).toEqual([join(main, MAIN_FILE), []]); // 写主文件夹：不算越界，但不在工作树里
      expect((await h.merge(a.id)).status).toBe(409); // 还在跑
      await h.allow(a.id);
      await h.waitStatus(a.id, "idle");
      writeFileSync(join(a.workspace.path, "extra.txt"), "交回以后又改的\n");
      expect((await h.merge(a.id)).body.error.message).toContain("没提交的改动");
      expect(existsSync(a.workspace.path)).toBe(true);
    } finally {
      await h.t.cleanup();
    }
    const p = await setup(plain);
    try {
      const c = await p.open("C");
      expect(c.workspace).toEqual({ kind: "folder", folder: c.cwd });
      expect((await p.merge(c.id)).status).toBe(409);
    } finally {
      await p.t.cleanup();
    }
  });

  it("自由子会话（第 68 条）：git 仓库的主文件夹也按普通文件夹算，两个自由子会话排队、写清等谁；卡照常在工作树里开；规矩和工具另一套", async () => {
    const main = repo();
    const h = await setup(main);
    try {
      expect((await h.call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "X" }, title: "X", cwd: main, firstMessage: "x", free: true })).status).toBe(400); // 只给专题
      const f1 = await h.openFree("改周报");
      await h.waitStatus(f1.id, "waiting_permission");
      const s1 = (await h.session(f1.id)).session;
      expect(s1.workspace).toEqual({ kind: "folder", folder: realpathSync.native(main) }); // 有 .git 也按普通文件夹（第 71 条照卡一样留一份）
      expect(s1.free).toBeUndefined(); // 只记在本机，不进摘要
      expect(JSON.parse(readFileSync(join(h.t.dataDir, "sessions", f1.id, "session.json"), "utf8")).free).toBe(true); // 记在会话记录里，重启后还是它

      // 同一个仓库里再开一个自由子会话：排队，写清在等前一个
      const f2 = await h.openFree("整理目录");
      expect(f2.status).toBe("queued");
      expect((await h.session(f2.id)).session.heldBy).toEqual({ kind: "topic", id: "改周报", title: "改周报" });
      expect(h.events(f2.id).find((e) => e.type === "status" && e.status === "queued").reason).toBe("这个文件夹同一时间只让一个会话改，等「改周报」这一轮做完");
      const synced = await until(() => h.cloud.items.find((i) => i.sessionId === f2.id && i.type === "status" && i.data.status === "queued"));
      expect(synced.data.heldBy).toEqual({ kind: "topic", id: "改周报", title: "改周报" });
      // 同一个仓库里的卡在自己的工作树里，不排队
      const a = await h.open("A");
      expect(a.status).toBe("running");
      expect((await h.session(a.id)).session.workspace.kind).toBe("worktree");

      // 规矩：不提纲、不交回；本人要的文件就写在文件夹里，只是不留没要的；只改让改的那一处。工具只有交产出物和翻更早的轮次
      const prompt = readFileSync(join(h.t.dataDir, "sessions", f1.id, "system.md"), "utf8");
      expect(prompt).toContain("本人要的文件（文档、表格、代码等）就写在当前工作目录里");
      expect(prompt).toContain(EDIT_SCOPE_RULE);
      for (const no of ["不要在仓库里留报告或输出文件", "save_version", "hand_back", "提纲", "propose_agreement_change"]) expect(prompt.replace("没有提纲、交回和验收", "")).not.toContain(no);
      const secret = JSON.parse(readFileSync(join(h.t.dataDir, "sessions", f1.id, "session.json"), "utf8")).mcpSecret;
      const list = await raw(h.t.port, { method: "POST", path: `/internal/sessions/${f1.id}/mcp`, headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      expect(list.body.result.tools.map((x: any) => x.name)).toEqual(["add_artifact", "read_earlier_turns"]);

      // 前一个这一轮做完让出文件夹：后一个接上，不再写在等谁
      await h.allow(f1.id);
      await h.waitStatus(f2.id, "waiting_permission");
      expect((await h.session(f2.id)).session.heldBy).toBeUndefined();
    } finally {
      await h.t.cleanup();
    }
  });

  it("不是 git 仓库的文件夹同时只做一张卡，别的排队；别的文件夹不受影响；交回不提交", async () => {
    const plain = tempDir("tl-plain-");
    mkdirSync(join(plain, "other"));
    const h = await setup(plain);
    try {
      const a = await h.open("A");
      await h.waitStatus(a.id, "waiting_permission");
      const b = await h.open("B");
      expect(b.status).toBe("queued");
      expect(h.events(b.id).find((e) => e.type === "status" && e.status === "queued").reason).toBe("这个文件夹同一时间只让一个会话改，等「A」这一轮做完");
      expect((await h.session(b.id)).session.heldBy).toEqual({ kind: "card", id: "A", title: "A" }); // 第 68 条：写清在等谁
      // 自由子会话（第 68 条）也算占用：排在 B 后面，先等 A
      const f = await h.openFree("F");
      expect(f.status).toBe("queued");
      expect((await h.session(f.id)).session.heldBy).toEqual({ kind: "card", id: "A", title: "A" });
      const c = await h.open("C", join(plain, "other"));
      expect(c.status).toBe("running"); // 别的文件夹照常开
      await h.allow(a.id); // A 这一轮做完让出文件夹，B 接上
      await h.waitStatus(b.id, "waiting_permission");
      // F 还在排，占着的换成了 B：本机重报一条，云端看到的也换了
      expect((await h.session(f.id)).session.heldBy).toEqual({ kind: "card", id: "B", title: "B" });
      expect(await until(() => h.cloud.items.filter((i) => i.sessionId === f.id && i.type === "status").at(-1)?.data.heldBy?.id === "B")).toBe(true);
      expect(await h.status(a.id)).toBe("idle");
      const r = await h.handBack(a.id);
      expect(r.content[0]!.text).not.toContain("提交");
      const item = await until(() => h.cloud.items.find((i) => i.type === "handback"));
      expect(item.data.git).toBeUndefined();
      expect(h.events(a.id).find((e) => e.type === "handback").commit).toBeUndefined();
    } finally {
      await h.t.cleanup();
    }
  });

  it("清理：排队时取消的卡清掉工作树、分支留着；同一张卡再开工新开一个分支；本机程序启动时清掉已不在的工作树的登记", async () => {
    const main = repo(true);
    const h = await setup(main, 1);
    let restarted: Awaited<ReturnType<typeof setup>> | null = null;
    try {
      const a = await h.open("A");
      await h.waitStatus(a.id, "waiting_permission");
      const q = await h.open("Q");
      expect(q.status).toBe("queued");
      expect(existsSync(q.workspace.path)).toBe(true); // 开工时就开好了工作树
      expect(h.events(q.id).some((e) => e.type === "notice" && e.code === "workspace")).toBe(true);
      await h.call("POST", `/v1/sessions/${q.id}/interrupt`, {});
      await until(() => !existsSync(q.workspace.path));
      expect(git(main, "rev-parse", "--verify", q.workspace.branch)).toBe(git(main, "rev-parse", "main"));
      // 同一张卡再开工：上一个的工作树已清，分支名被占了就加 -2
      await h.call("POST", `/v1/sessions/${a.id}/kill`, {});
      await h.waitStatus(a.id, "exited");
      const q2 = await h.open("Q");
      expect(q2.workspace.branch).toBe(`${q.workspace.branch}-2`);
      // 同一张卡已有会话在做时不再开
      expect((await h.open("Q")).error.code).toBe("conflict");
      await h.call("POST", `/v1/sessions/${q2.id}/kill`, {});
      await h.waitStatus(q2.id, "exited");

      // A 的工作树目录被人删了：重启后登记清掉
      const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
      const listed = () => norm(git(main, "worktree", "list", "--porcelain")).includes(norm(a.workspace.path));
      rmSync(a.workspace.path, { recursive: true, force: true });
      expect(listed()).toBe(true);
      const { dataDir } = h.t;
      await h.t.runner.close();
      restarted = await setup(main, 1, dataDir, h.token);
      await until(() => !listed());
      expect(git(main, "rev-parse", "--verify", a.workspace.branch)).toBeTruthy();
    } finally {
      await (restarted ?? h).t.cleanup();
    }
  });

  it("卡的先后：等的卡没合回时排着、没有工作树；合回一张少一张；都合回后从最新的 main 开工作树自己开始；重启后照样等", async () => {
    const main = repo();
    const h = await setup(main);
    let r: Awaited<ReturnType<typeof setup>> | null = null;
    try {
      const a = await h.open("A");
      const b = await h.open("B");
      const c = await h.open("C", main, ["A", "B"]);
      expect(c.status).toBe("queued");
      expect(c.waitingFor).toEqual(["A", "B"]);
      expect(c.workspace).toBeUndefined();
      expect(h.events(c.id).find((e) => e.type === "status" && e.status === "queued").reason).toBe("等前面的卡合回");
      expect((await until(() => h.cloud.items.find((i) => i.sessionId === c.id && i.type === "status"))).data).toMatchObject({ status: "queued", waitingFor: ["A", "B"] });

      await h.waitStatus(a.id, "idle");
      await h.waitStatus(b.id, "idle");
      writeFileSync(join(a.workspace.path, "a.txt"), "A\n");
      writeFileSync(join(b.workspace.path, "b.txt"), "B\n");
      rmSync(join(b.workspace.path, "hello.txt")); // 只让 A 带 hello.txt，两张合回不冲突
      await h.handBack(a.id);
      await h.handBack(b.id);
      await h.waitStatus((await h.verifierOf("A")).id, "done");
      await h.waitStatus((await h.verifierOf("B")).id, "done");
      expect((await h.status(c.id))).toBe("queued"); // 交回、验收过了也不算，要合回

      // 合回 A：C 少等一张，同步上去
      expect((await h.merge(a.id)).body.merged).toBe(true);
      await until(async () => JSON.stringify((await h.session(c.id)).session.waitingFor) === JSON.stringify(["B"]));
      await until(() => h.cloud.items.some((i) => i.sessionId === c.id && i.type === "status" && JSON.stringify(i.data.waitingFor) === JSON.stringify(["B"])));

      // 本机程序重启：照样等
      const { dataDir } = h.t;
      await h.t.runner.close();
      r = await setup(main, 3, dataDir, h.token);
      expect((await r.session(c.id)).session).toMatchObject({ status: "queued", waitingFor: ["B"] });

      // 合回 B：C 从最新的 main 开工作树，自己开始
      expect((await r.merge(b.id)).body.merged).toBe(true);
      const head = git(main, "rev-parse", "HEAD");
      const started = await until(async () => { const s = (await r!.session(c.id)).session; return s.workspace ? s : null; });
      expect(started.workspace.baseCommit).toBe(head);
      expect(started.waitingFor).toBeUndefined();
      expect(existsSync(join(started.workspace.path, "a.txt")) && existsSync(join(started.workspace.path, "b.txt"))).toBe(true);
      await r.waitStatus(c.id, "idle"); // 自己开始、做完一轮
      expect(r.events(c.id).some((e) => e.type === "notice" && e.code === "workspace")).toBe(true);
    } finally {
      await (r ?? h).t.cleanup();
    }
  });

  it("排着的卡被停掉（等空位的、等前面的卡的）：撤出队列，前面的卡合回也不开工；说「接着做」重新排上：工作树重新开、照常开工", async () => {
    const main = repo(true);
    const h = await setup(main, 1);
    const deny = async (id: string) => {
      const s = await until(async () => { const b = await h.session(id); return b.pendingPermissions[0] ? b : null; });
      return h.call("POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(s.pendingPermissions[0].requestId)}`, { decision: "deny", message: "先不写" });
    };
    try {
      const a = await h.open("A");
      await h.waitStatus(a.id, "waiting_permission");
      const b = await h.open("B");
      const c = await h.open("C", main, ["A"]);
      expect([b.status, c.status]).toEqual(["queued", "queued"]);
      expect(existsSync(b.workspace.path)).toBe(true);
      await h.call("POST", `/v1/sessions/${b.id}/kill`, {});
      await h.call("POST", `/v1/sessions/${c.id}/kill`, {});
      expect([await h.status(b.id), await h.status(c.id)]).toEqual(["exited", "exited"]);
      await until(() => !existsSync(b.workspace.path));
      const stops = await until(() => { const s = h.cloud.items.filter((i) => [b.id, c.id].includes(i.sessionId) && i.type === "stopped"); return s.length === 2 ? s : null; });
      expect(stops.map((i) => i.data.why)).toEqual(["interrupted", "interrupted"]);

      // A 做完、交回、验收过、合回：B、C 都不自己开始
      await deny(a.id);
      await h.waitStatus(a.id, "idle");
      writeFileSync(join(a.workspace.path, "a.txt"), "A\n");
      await h.handBack(a.id);
      await h.waitStatus((await h.verifierOf("A")).id, "done");
      expect((await h.merge(a.id)).body.merged).toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      expect((await h.session(c.id)).session).toMatchObject({ status: "exited" });
      expect((await h.session(c.id)).session.workspace).toBeUndefined();
      expect(await h.status(b.id)).toBe("exited");

      // B 说「接着做」：工作树从最新的 main 重新开（原分支名被占，加 -2），开工时先送交代、再送这句
      const head = git(main, "rev-parse", "HEAD");
      expect((await h.call("POST", `/v1/sessions/${b.id}/messages`, { text: "接着做" })).status).toBe(200);
      await h.waitStatus(b.id, "waiting_permission");
      const nb = (await h.session(b.id)).session;
      expect(nb.workspace).toMatchObject({ branch: `${b.workspace.branch}-2`, baseCommit: head });
      expect(existsSync(nb.workspace.path)).toBe(true);
      expect(h.events(b.id).filter((e) => e.type === "user_message").map((e) => e.text)).toEqual(["接着做", "做 B"]);

      // C 说「接着做」：前面的 A 已经合回，开工作树，排着等 B 让出位置后开始
      expect((await h.call("POST", `/v1/sessions/${c.id}/messages`, { text: "接着做" })).status).toBe(200);
      const queued = await until(async () => { const s = (await h.session(c.id)).session; return s.workspace ? s : null; });
      expect(queued).toMatchObject({ status: "queued", workspace: { baseCommit: head } });
      await deny(b.id);
      await h.waitStatus(c.id, "waiting_permission");
      expect(existsSync(join(queued.workspace.path, "a.txt"))).toBe(true);
    } finally {
      await h.t.cleanup();
    }
  });

  it("卡的先后：不是 git 仓库（没有合回）时，等的卡验收过了就算做完", async () => {
    const plain = tempDir("tl-plain-");
    writeFileSync(join(plain, ".fake-claude.json"), JSON.stringify({ verdict: PASSING }));
    const h = await setup(plain);
    try {
      const a = await h.open("A");
      await h.waitStatus(a.id, "waiting_permission");
      const c = await h.open("C", plain, ["A"]);
      expect(c).toMatchObject({ status: "queued", waitingFor: ["A"] });
      await h.allow(a.id);
      await h.waitStatus(a.id, "idle");
      expect(await h.status(c.id)).toBe("queued"); // A 一轮做完了，但还没验收
      await h.handBack(a.id);
      await h.waitStatus((await h.verifierOf("A")).id, "done");
      await h.waitStatus(c.id, "waiting_permission"); // 验收过了：C 自己开始（在文件夹里做，照样问）
      expect((await h.session(c.id)).session.workspace).toEqual({ kind: "folder", folder: (await h.session(a.id)).session.workspace.folder });
    } finally {
      await h.t.cleanup();
    }
  });

  it("验收过就合回（默认开）：主文件夹在原分支上、干净、没冲突时自己合回，报 merge；等它的卡接着自己开始，不用点", async () => {
    const main = repo();
    const h = await setup(main, 3, undefined, undefined, true);
    try {
      expect((await h.call("GET", "/v1/settings")).body.autoMerge).toBe(true);
      const a = await h.open("A");
      const c = await h.open("C", main, ["A"]);
      expect(c.status).toBe("queued");
      await h.waitStatus(a.id, "idle");
      await h.handBack(a.id);
      const handbackKey = (await until(() => h.cloud.items.find((i) => i.sessionId === a.id && i.type === "handback"))).key;
      await h.waitStatus((await h.verifierOf("A")).id, "done");
      const merged = await until(async () => { const s = (await h.session(a.id)).session; return s.workspace.mergedCommit ? s : null; });
      expect(git(main, "rev-parse", "HEAD")).toBe(merged.workspace.mergedCommit);
      expect(existsSync(join(main, "hello.txt"))).toBe(true);
      expect(merged.workspace.needsMerge).toBeUndefined();
      const item = await until(() => h.cloud.items.find((i) => i.sessionId === a.id && i.type === "merge"));
      expect(item.data).toEqual({ handbackKey, merged: true, commit: merged.workspace.mergedCommit, baseBranch: "main", reason: null, message: null, auto: true });
      expect(h.events(a.id).some((e) => e.type === "notice" && e.code === "merged")).toBe(true);
      // C 等的 A 合回了：从最新的 main 开工作树，自己开始
      const started = await until(async () => { const s = (await h.session(c.id)).session; return s.workspace ? s : null; });
      expect(started.workspace.baseCommit).toBe(merged.workspace.mergedCommit);
      await h.waitStatus(c.id, "idle");
    } finally {
      await h.t.cleanup();
    }
  });

  it("验收过了但不自动合：主文件夹有改动（dirty）、关了自动合回（auto_merge_off）、交回以后卡又改过（not_ready）时记 needsMerge 等本人合，都报 merge；本人点了合并再报一条", async () => {
    const main = repo();
    const h = await setup(main, 3, undefined, undefined, true);
    try {
      const pass = async (title: string, before?: (a: any) => void) => {
        const a = await h.open(title);
        await h.waitStatus(a.id, "idle");
        await h.handBack(a.id);
        before?.(a);
        await h.waitStatus((await h.verifierOf(title)).id, "done");
        const s = await until(async () => { const x = (await h.session(a.id)).session; return x.workspace.needsMerge ? x : null; });
        const item = await until(() => h.cloud.items.find((i) => i.sessionId === a.id && i.type === "merge"));
        return { a, s, item };
      };
      // 主文件夹有没提交的改动
      writeFileSync(join(main, "notes.txt"), "本人在主文件夹里写着的\n");
      const d = await pass("D");
      expect(d.s.workspace).toMatchObject({ mergedCommit: null, needsMerge: { reason: "dirty" } });
      expect(d.item.data).toMatchObject({ merged: false, commit: null, reason: "dirty", auto: true, baseBranch: "main" });
      expect(h.events(d.a.id).find((e) => e.type === "notice" && e.code === "merge_needed").text).toContain("验收过了，没自动合回");
      // 主文件夹还没收拾就点合并：没合成，也报一条（auto false）
      expect((await h.merge(d.a.id)).body).toMatchObject({ merged: false, reason: "dirty" });
      expect((await until(() => h.cloud.items.find((i) => i.sessionId === d.a.id && i.type === "merge" && !i.data.auto))).data).toMatchObject({ merged: false, reason: "dirty" });
      // 本人收拾好主文件夹，点合并：合回，needsMerge 没了，再报一条 auto false
      rmSync(join(main, "notes.txt"));
      const m = await h.merge(d.a.id);
      expect(m.body.merged).toBe(true);
      expect(m.body.session.workspace.needsMerge).toBeUndefined();
      const manual = await until(() => h.cloud.items.find((i) => i.sessionId === d.a.id && i.type === "merge" && i.data.merged));
      expect(manual.data).toMatchObject({ handbackKey: d.item.data.handbackKey, merged: true, commit: m.body.commit, reason: null, auto: false });

      // 关了「验收过就合回」
      expect((await h.call("PATCH", "/v1/settings", { autoMerge: false })).body.autoMerge).toBe(false);
      const off = await pass("E");
      expect(off.s.workspace.needsMerge).toEqual({ reason: "auto_merge_off", message: "没开「验收过就合回」，等你合" });
      expect(off.item.data).toMatchObject({ merged: false, reason: "auto_merge_off", auto: true });
      await h.call("PATCH", "/v1/settings", { autoMerge: true });
      // 又交回：上一次的「要你合」作废，等这次验收；这次验收过了（开关已开）自己合回
      await h.handBack(off.a.id);
      expect((await h.session(off.a.id)).session.workspace.needsMerge).toBeUndefined();
      await h.waitStatus((await h.verifierOf("E", 1)).id, "done");
      await until(async () => (await h.session(off.a.id)).session.workspace.mergedCommit);

      // 交回以后卡又提交过：只合验过的那个提交，不合
      const changed = await pass("F", (a) => {
        writeFileSync(join(a.workspace.path, "later.txt"), "交回以后又加的\n");
        git(a.workspace.path, "add", "-A");
        git(a.workspace.path, "-c", "user.name=测试", "-c", "user.email=test@example.com", "commit", "-q", "-m", "later");
      });
      expect(changed.s.workspace.needsMerge).toMatchObject({ reason: "not_ready", message: "交回以后卡又改过，等它再交回、验收过了再合" });
      expect(git(main, "log", "--oneline").split("\n").some((l) => l.includes("天枢卡「F」"))).toBe(false);
    } finally {
      await h.t.cleanup();
    }
  });
});
