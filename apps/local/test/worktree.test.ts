// 卡在自己的 git 工作树里做（ADR 0038）：用真的临时 git 仓库测两张卡同时做、交回提交、验收员只看这张卡的改动、合回、不是仓库时排队、清理。
// 假 claude 的配置（.fake-claude.json）提交在仓库里，工作树里也有；它的记录文件在 .gitignore 里，不进提交。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { api, pair, raw, startTestRunner, tempDir, ORIGIN } from "./helpers.js";

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

/** 临时仓库：main 上一个提交（说明文件、假 claude 的配置、忽略它的记录文件）。 */
function repo(): string {
  const dir = tempDir("tl-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "测试");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, ".gitignore"), ".fake-claude-trace.jsonl\n");
  writeFileSync(join(dir, ".fake-claude.json"), JSON.stringify({ verdict: PASSING }));
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

async function setup(folder: string, max = 3, dataDir?: string, token0?: string) {
  const cloud = fakeCloud();
  const t = await startTestRunner({ pickFolder: folder, fetchImpl: cloud.impl, dataDir });
  const token = token0 ?? await pair(t.port);
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  if (!dataDir) {
    await call("POST", "/v1/folders/pick", {});
    await call("PATCH", "/v1/settings", { maxConcurrent: max });
    expect((await call("PUT", "/v1/cloud", { apiBaseUrl: ORIGIN, token: "cloud-token-0123456789abcdef" })).status).toBe(200);
  }
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body;
  const status = async (id: string) => (await session(id)).session.status as string;
  const waitStatus = (id: string, want: string) => until(async () => (await status(id)) === want);
  const open = async (title: string, cwd = folder) => (await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: title }, title, cwd, firstMessage: `做 ${title}` })).body;
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
  return { t, token, cloud, call, session, status, waitStatus, open, allow, events, handBack, verifierOf, merge };
}

describe("卡在自己的工作树里做", () => {
  it("同一个仓库两张卡同时做，各在自己的工作树；交回提交到卡的分支；验收员只看这张卡的改动；合回：有改动、不在基线分支、成了、冲突", async () => {
    const main = repo();
    const base = git(main, "rev-parse", "HEAD");
    writeFileSync(join(main, "readme.md"), "主文件夹里没提交的改动\n");
    const h = await setup(main);
    try {
      const a = await h.open("Card-A login");
      const b = await h.open("Card-B");
      // 两张同时在跑（都停在要写文件的权限上），各在自己的工作树和分支里
      await h.waitStatus(a.id, "waiting_permission");
      await h.waitStatus(b.id, "waiting_permission");
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

      await h.allow(a.id);
      await h.allow(b.id);
      await h.waitStatus(a.id, "idle");
      await h.waitStatus(b.id, "idle");
      expect(existsSync(join(wa.path, "hello.txt")) && existsSync(join(wb.path, "hello.txt"))).toBe(true);
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
      await h.waitStatus(v.id, "exited");
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
      await h.waitStatus(vb.id, "exited");
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

  it("卡还在跑、工作树里有交回以后的改动、不在工作树里做时，合回回 409", async () => {
    const main = repo();
    const plain = tempDir("tl-plain-");
    const h = await setup(main);
    try {
      const a = await h.open("A");
      await h.waitStatus(a.id, "waiting_permission");
      expect((await h.merge(a.id)).status).toBe(409); // 还在跑
      await h.allow(a.id);
      await h.waitStatus(a.id, "idle");
      expect((await h.merge(a.id)).body.error.message).toContain("没提交的改动"); // hello.txt 还没交回
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

  it("不是 git 仓库的文件夹同时只做一张卡，别的排队；别的文件夹不受影响；交回不提交", async () => {
    const plain = tempDir("tl-plain-");
    mkdirSync(join(plain, "other"));
    const h = await setup(plain);
    try {
      const a = await h.open("A");
      await h.waitStatus(a.id, "waiting_permission");
      const b = await h.open("B");
      expect(b.status).toBe("queued");
      expect(h.events(b.id).find((e) => e.type === "status" && e.status === "queued").reason).toBe("这个文件夹不是 git 仓库，同时只做一张卡，等另一张这一轮做完");
      const c = await h.open("C", join(plain, "other"));
      expect(c.status).toBe("running"); // 别的文件夹照常开
      await h.allow(a.id); // A 这一轮做完让出文件夹，B 接上
      await h.waitStatus(b.id, "waiting_permission");
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
    const main = repo();
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
});
