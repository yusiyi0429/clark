// 子会话的权限模式（契约 LocalPermissionMode）：每一档本机自己放行什么、硬规矩哪一档都问；开工带、中途换、先出计划批了转自动。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalSessionSummary, LocalSyncItem } from "@warmap/contracts";
import { modeAllows, type PathScope } from "../src/agents/pathGuard.js";
import { registerFormats } from "../src/store.js";
import { api, pair, startTestRunner, tempDir } from "./helpers.js";

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

describe("每一档本机自己放行什么", () => {
  const folder = tempDir("tl-pm-folder-");
  const outside = tempDir("tl-pm-outside-");
  const scope: PathScope = { cwd: folder, home: tempDir("tl-pm-home-"), allowedRoots: () => [folder] };
  const allows = (mode: Parameters<typeof modeAllows>[0], tool: string, input: Record<string, unknown>, worktree: string | null = null) =>
    modeAllows(mode, tool, input, scope, undefined, worktree);
  const write = { file_path: join(folder, "a.txt"), content: "x" };
  // 命令里的路径用正斜杠（Bash 里反斜杠是转义）
  const sh = (p: string) => p.replaceAll("\\", "/");

  it("每次都问、先出计划：一样也不自己放", () => {
    for (const mode of ["default", "plan"] as const) {
      expect(allows(mode, "Write", write)).toBe(false);
      expect(allows(mode, "Bash", { command: "ls" })).toBe(false);
      expect(allows(mode, "mcp__tianshu__get_item", {})).toBe(false);
    }
  });
  it("自动：允许的文件夹里改文件、安全的命令、天枢读的工具放行；删挪文件（不在工作树）、联网、子 agent 问", () => {
    expect(allows("auto", "Write", write)).toBe(true);
    expect(allows("auto", "Bash", { command: "ls" })).toBe(true);
    expect(allows("auto", "mcp__tianshu__list_my_items", {})).toBe(true);
    expect(allows("auto", "Bash", { command: `rm ${sh(join(folder, "a.txt"))}` })).toBe(false);
    // 同一条命令「全部放行」放：不是越界，是「自动」不在工作树时不删
    expect(allows("bypassPermissions", "Bash", { command: `rm ${sh(join(folder, "a.txt"))}` })).toBe(true);
    expect(allows("auto", "WebFetch", { url: "https://example.com" })).toBe(false);
    expect(allows("auto", "Agent", { prompt: "x" })).toBe(false);
  });
  it("自动、自动接受改文件：卡在工作树里时只在工作树里放行，工作树里可以删", () => {
    const tree = join(folder, "tree");
    mkdirSync(tree, { recursive: true });
    expect(allows("auto", "Bash", { command: `rm ${sh(join(tree, "a.txt"))}` }, tree)).toBe(true);
    expect(allows("auto", "Write", write, tree)).toBe(false); // 主文件夹不在工作树里
    expect(allows("acceptEdits", "Write", { file_path: join(tree, "b.txt"), content: "x" }, tree)).toBe(true);
    expect(allows("acceptEdits", "Write", write, tree)).toBe(false);
  });
  it("卡在工作树里、项目另外还绑着文件夹（17.2 第 46 条）：那里照「不在工作树里」的规矩——改文件的工具、读的命令放行，写删挪的命令问；别的允许的文件夹照样问", () => {
    const tree = join(folder, "tree");
    const docs = join(folder, "docs");
    const other = join(folder, "other"); // 本人允许着，但不是这个项目另外绑的
    for (const d of [tree, docs, other]) mkdirSync(d, { recursive: true });
    const withDocs: PathScope = { ...scope, extraDirs: () => [docs] };
    const ok = (mode: Parameters<typeof modeAllows>[0], tool: string, input: Record<string, unknown>, s: PathScope = withDocs) => modeAllows(mode, tool, input, s, undefined, tree);
    const inDocs = { file_path: join(docs, "a.md"), content: "x" };
    expect(ok("auto", "Write", inDocs)).toBe(true);
    expect(ok("acceptEdits", "Edit", { file_path: join(docs, "a.md"), old_string: "x", new_string: "y" })).toBe(true);
    expect(ok("auto", "Read", { file_path: join(docs, "a.md") })).toBe(true);
    expect(ok("auto", "Bash", { command: `cat ${sh(join(docs, "a.md"))}` })).toBe(true);
    // 那里没有工作树兜底：用命令写、删、挪的问；从工作树往那里拷也问
    expect(ok("auto", "Bash", { command: `rm ${sh(join(docs, "a.md"))}` })).toBe(false);
    expect(ok("auto", "Bash", { command: `echo x > ${sh(join(docs, "a.md"))}` })).toBe(false);
    expect(ok("auto", "Bash", { command: `cp ${sh(join(tree, "a.txt"))} ${sh(join(docs, "a.txt"))}` })).toBe(false);
    expect(ok("acceptEdits", "Bash", { command: `cat ${sh(join(docs, "a.md"))}` })).toBe(false);
    // WRITES 认不出、但一样会冲掉那里没提交的改动的：git、就地改文件的，也问
    for (const command of [`git -C ${sh(docs)} reset --hard`, `git -C ${sh(docs)} clean -fdx`, `cd ${sh(docs)} && git checkout -- .`, `sed -i s/a/b/ ${sh(join(docs, "a.md"))}`, `perl -pi -e s/a/b/ ${sh(join(docs, "a.md"))}`]) {
      expect(ok("auto", "Bash", { command }), command).toBe(false);
    }
    expect(ok("auto", "Bash", { command: "git status && git add -A" })).toBe(true); // 工作树里的 git 照旧不问
    // 工作树里照旧可以删；碰其余目录里的 .git 照样问；每次都问那一档照样问
    expect(ok("auto", "Bash", { command: `rm ${sh(join(tree, "a.txt"))}` })).toBe(true);
    expect(ok("auto", "Write", { file_path: join(docs, ".git", "config"), content: "x" })).toBe(false);
    expect(ok("default", "Write", inDocs)).toBe(false);
    // 不是这个项目另外绑的：主文件夹、别的允许的文件夹、允许范围以外，都照旧问
    expect(ok("auto", "Write", write)).toBe(false);
    expect(ok("auto", "Write", { file_path: join(other, "a.md"), content: "x" })).toBe(false);
    expect(ok("auto", "Write", { file_path: join(outside, "a.md"), content: "x" })).toBe(false);
    // 项目没另外绑文件夹（或者减掉了）：和原来一样
    expect(ok("auto", "Write", inDocs, scope)).toBe(false);
    expect(ok("auto", "Write", inDocs, { ...scope, extraDirs: () => [] })).toBe(false);
  });
  it("自动接受改文件：只放改文件的，命令照样问", () => {
    expect(allows("acceptEdits", "Edit", { file_path: join(folder, "a.txt"), old_string: "x", new_string: "y" })).toBe(true);
    expect(allows("acceptEdits", "Bash", { command: "ls" })).toBe(false);
  });
  it("全部放行：只问三类，别的都放（设计 17.2 第 33 条）", () => {
    expect(allows("bypassPermissions", "Bash", { command: `rm -rf ${sh(join(folder, "x"))}` })).toBe(true);
    expect(allows("bypassPermissions", "WebFetch", { url: "https://example.com" })).toBe(true);
    expect(allows("bypassPermissions", "Agent", { prompt: "x" })).toBe(true);
    // 截图里那条：curl 去几个网站查商标；装东西
    expect(allows("bypassPermissions", "Bash", { command: "curl -s 'https://tmsearch.example.com/?q=tianshu' && curl -s https://euipo.example.eu/search" })).toBe(true);
    expect(allows("bypassPermissions", "Bash", { command: "npm install left-pad" })).toBe(true);
    // 别的原来要问的也放：改系统设置、碰 .git .claude、允许范围以外、没装好的 npx、拉代码、gh 只读、飞书改文档、本人加的工具写的
    for (const [tool, input] of [
      ["Bash", { command: "setx FOO bar" }],
      ["Bash", { command: "git pull && git fetch origin" }],
      ["Bash", { command: "npx create-something" }],
      ["Bash", { command: "gh pr view 12 && gh pr list && gh api repos/o/r/pulls" }],
      ["Bash", { command: "lark-cli docs +update --doc x --text y" }],
      ["Write", { file_path: join(folder, ".git", "config"), content: "x" }],
      ["Write", { file_path: join(outside, "a.txt"), content: "x" }],
      ["mcp__tool-kd__save_voucher", {}],
    ] as [string, Record<string, unknown>][]) expect(allows("bypassPermissions", tool, input), `${tool} ${JSON.stringify(input)}`).toBe(true);
  });
  it("全部放行也问：没有兜底的地方，已有文件要被删、挪、覆盖（11/11 过渡规矩）；本机自己的目录、新建文件、读的照旧放", () => {
    const own = tempDir("tl-pm-own-"); // 当成本机自己的目录（工作树、专题、此电脑）
    const user = tempDir("tl-pm-user-"); // 本人的普通文件夹
    writeFileSync(join(user, "表.xlsx"), "x");
    writeFileSync(join(own, "稿.md"), "x");
    const covered = (p: string) => p.toLowerCase().startsWith(own.toLowerCase());
    const at = (cwd: string): PathScope => ({ cwd, home: scope.home, allowedRoots: () => [own, user], covered });
    const ok = (s: PathScope, tool: string, input: Record<string, unknown>) => modeAllows("bypassPermissions", tool, input, s, undefined, null);
    const inUser = at(user), inOwn = at(own);
    // 本人文件夹里：改已有文件、覆盖已有文件、删、挪、就地改、冲文件的 git 都问
    expect(ok(inUser, "Edit", { file_path: join(user, "表.xlsx"), old_string: "x", new_string: "y" })).toBe(false);
    expect(ok(inUser, "Write", { file_path: join(user, "表.xlsx"), content: "y" })).toBe(false);
    expect(ok(inUser, "Write", { file_path: "表.xlsx", content: "y" })).toBe(false); // 相对路径按工作目录
    for (const command of ["rm 表.xlsx", "del 表.xlsx", "Remove-Item -Recurse .", "mv 表.xlsx 旧.xlsx", "echo y > 表.xlsx", "Get-ChildItem | Remove-Item", "sed -i s/x/y/ 表.xlsx", "git checkout -- .", "Set-Content 表.xlsx y"]) {
      expect(ok(inUser, "Bash", { command }), command).toBe(false);
    }
    // 新建文件、读、扔掉输出的重定向不问
    expect(ok(inUser, "Write", { file_path: join(user, "新.md"), content: "y" })).toBe(true);
    for (const command of ["ls", "cat 表.xlsx", "python report.py > $null", "dir 2> nul", "git status 2>&1"]) expect(ok(inUser, "Bash", { command }), command).toBe(true);
    // 本机自己的目录里：照旧都放
    expect(ok(inOwn, "Edit", { file_path: join(own, "稿.md"), old_string: "x", new_string: "y" })).toBe(true);
    expect(ok(inOwn, "Bash", { command: "rm 稿.md" })).toBe(true);
    // 从本机目录去删、覆盖本人文件夹里的：问；认不出的变量路径：问
    expect(ok(inOwn, "Bash", { command: `rm ${sh(join(user, "表.xlsx"))}` })).toBe(false);
    expect(ok(inOwn, "Bash", { command: `cp 稿.md ${sh(join(user, "表.xlsx"))}` })).toBe(false);
    expect(ok(inOwn, "Bash", { command: "rm $TMPDIR/x" })).toBe(false);
    expect(ok(inOwn, "Edit", { file_path: join(user, "表.xlsx"), old_string: "x", new_string: "y" })).toBe(false);
    // 别的档不受影响：自动在本人文件夹里改文件照旧放（自动档的删挪原来就问）
    expect(modeAllows("auto", "Edit", { file_path: join(user, "表.xlsx"), old_string: "x", new_string: "y" }, inUser, undefined, null)).toBe(true);
  });
  it("全部放行也问：推代码或开 PR", () => {
    for (const command of ["git push origin main", "git -C repo push --force", "gh pr create --fill", "gh pr merge 12 --squash", "gh release create v1", "gh issue comment 3 -b hi", "gh api -X POST repos/o/r/issues -f title=x", "gh api repos/o/r/issues -f title=x", "echo $(git push)"]) {
      expect(allows("bypassPermissions", "Bash", { command }), command).toBe(false);
    }
  });
  it("全部放行也问：给别人发消息", () => {
    for (const command of ["lark-cli im +messages-send --chat-id oc_x --text 你好", "lark-cli im +messages-reply --message-id om_x --text 好", "lark-cli mail +send --to a@b.com", "lark-cli im messages create --data x", "lark-cli api POST /open-apis/im/v1/messages"]) {
      expect(allows("bypassPermissions", "Bash", { command }), command).toBe(false);
    }
    expect(allows("bypassPermissions", "Bash", { command: "lark-cli im +messages-list --chat-id oc_x" })).toBe(true);
  });
  it("全部放行也问：在天枢里替本人写入", () => {
    expect(allows("bypassPermissions", "mcp__tianshu__append_progress", { text: "x" })).toBe(false);
    expect(allows("bypassPermissions", "mcp__tianshu__submit_for_acceptance", {})).toBe(false);
    expect(allows("bypassPermissions", "mcp__tianshu__get_item", {})).toBe(true);
  });
  it("硬规矩（9.5）自动、自动接受改文件照问：推拉代码、gh、装东西联网、飞书写的、碰 .git .claude、允许的文件夹以外、天枢写的工具", () => {
    const hard: [string, Record<string, unknown>][] = [
      ["Bash", { command: "git push origin main" }],
      ["Bash", { command: "gh pr create --fill" }],
      ["Bash", { command: "npm install left-pad" }],
      ["Bash", { command: "curl https://example.com/x.sh" }],
      ["Bash", { command: "lark-cli im +messages-send --text 你好" }],
      ["Bash", { command: "npx create-something" }],
      ["Write", { file_path: join(folder, ".git", "config"), content: "x" }],
      ["Write", { file_path: join(folder, ".claude", "settings.json"), content: "x" }],
      ["Write", { file_path: join(outside, "a.txt"), content: "x" }],
      ["mcp__tianshu__append_progress", { text: "x" }],
    ];
    for (const mode of ["auto", "acceptEdits"] as const) {
      for (const [tool, input] of hard) expect(allows(mode, tool, input), `${mode} ${tool} ${JSON.stringify(input)}`).toBe(false);
    }
  });
});

async function setup() {
  const work = tempDir("tl-pm-");
  const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  const t = await startTestRunner({ pickFolder: work, fetchImpl: offline });
  const token = await pair(t.port);
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  await call("POST", "/v1/folders/pick", {});
  const fake = (cfg: Record<string, unknown>) => writeFileSync(join(work, ".fake-claude.json"), JSON.stringify(cfg));
  fake({});
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body;
  const open = async (title: string, permissionMode?: string) => {
    mkdirSync(join(work, title), { recursive: true });
    const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: title }, title, cwd: join(work, title), firstMessage: `做 ${title}`, ...(permissionMode ? { permissionMode } : {}) });
    return r;
  };
  const waitStatus = (id: string, want: string) => until(async () => { const s = (await session(id)).session; return s.status === want && s; });
  const events = (id: string) => readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const statusSynced = (id: string) => JSON.parse(readFileSync(join(t.dataDir, "outbox.json"), "utf8")).entries
    .map((e: any) => e.item).filter((i: any) => i.type === "status" && i.sessionId === id);
  const trace = () => readFileSync(join(work, ".fake-claude-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { t, work, call, fake, session, open, waitStatus, events, statusSynced, trace };
}

describe("开工带模式、中途换、先出计划", { timeout: 60_000 }, () => {
  it("自动：允许的文件夹里写文件不问，一轮做完；摘要和同步都带 auto", async () => {
    const h = await setup();
    try {
      const a = (await h.open("A", "auto")).body;
      expect(a.permissionMode).toBe("auto");
      const done = await h.waitStatus(a.id, "idle");
      expect(Value.Check(LocalSessionSummary, done)).toBe(true);
      expect(existsSync(join(h.work, "A", "hello.txt"))).toBe(true);
      expect(h.events(a.id).some((e) => e.type === "permission_request")).toBe(false);
      // 起的时候是「每次都问」，请求都先到本机
      expect(h.trace()[0].argv).toEqual(expect.arrayContaining(["--permission-mode", "manual"]));
      expect(h.statusSynced(a.id).every((i: any) => i.data.permissionMode === "auto")).toBe(true);
    } finally {
      await h.t.cleanup();
    }
  });

  it("每次都问 → 等批准；中途换成「自动接受改文件」：等着的写文件按新档放行，记事件、重报状态；不用告诉执行方", async () => {
    const h = await setup();
    try {
      const a = (await h.open("B", "default")).body;
      await h.waitStatus(a.id, "waiting_permission");
      const r = await h.call("PUT", `/v1/sessions/${a.id}/permission-mode`, { mode: "acceptEdits" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.session.permissionMode).toBe("acceptEdits");
      await h.waitStatus(a.id, "idle");
      expect(existsSync(join(h.work, "B", "hello.txt"))).toBe(true);
      const ev = h.events(a.id);
      expect(ev.find((e) => e.type === "permission_resolved")).toMatchObject({ decision: "allow", message: "换了权限模式，按新的模式放行" });
      expect(ev.find((e) => e.type === "permission_mode")).toMatchObject({ mode: "acceptEdits", by: "web" });
      const last = h.statusSynced(a.id).at(-1);
      expect(Value.Check(LocalSyncItem, last)).toBe(true);
      expect(last.data.permissionMode).toBe("acceptEdits");
      expect(h.trace().some((l) => l.setPermissionMode)).toBe(false);
      // 换成先出计划：要告诉执行方
      expect((await h.call("PUT", `/v1/sessions/${a.id}/permission-mode`, { mode: "plan" })).status).toBe(200);
      await until(() => h.trace().some((l) => l.setPermissionMode === "plan"));
      // 没有的档、不认的值
      expect((await h.call("PUT", `/v1/sessions/${a.id}/permission-mode`, { mode: "dontAsk" })).status).toBe(400);
      expect((await h.open("C", "manual")).status).toBe(400);
    } finally {
      await h.t.cleanup();
    }
  });

  it("先出计划：以 plan 起，出完计划等本人批（ExitPlanMode）；批了转自动，接着写文件不再问", async () => {
    const h = await setup();
    try {
      const a = (await h.open("D", "plan")).body;
      expect(h.trace()[0].argv).toEqual(expect.arrayContaining(["--permission-mode", "plan"]));
      await h.waitStatus(a.id, "waiting_permission");
      const pending = (await h.session(a.id)).pendingPermissions[0];
      expect(pending.toolName).toBe("ExitPlanMode");
      expect((await h.call("POST", `/v1/sessions/${a.id}/permissions/${encodeURIComponent(pending.requestId)}`, { decision: "allow" })).status).toBe(200);
      const done = await h.waitStatus(a.id, "idle");
      expect(done.permissionMode).toBe("auto");
      expect(existsSync(join(h.work, "D", "hello.txt"))).toBe(true);
      expect(h.events(a.id).find((e) => e.type === "permission_mode")).toMatchObject({ mode: "auto", by: "plan_approved" });
      expect(h.trace().some((l) => l.setPermissionMode === "default")).toBe(true);
      expect(h.statusSynced(a.id).at(-1).data.permissionMode).toBe("auto");
    } finally {
      await h.t.cleanup();
    }
  });

  it("全部放行：写到允许的文件夹以外也不问，这一轮直接做完（第 33 条）", async () => {
    const h = await setup();
    try {
      const outsideFile = join(tempDir("tl-pm-out-"), "x.txt");
      h.fake({ writePath: outsideFile });
      const a = (await h.open("E", "bypassPermissions")).body;
      await h.waitStatus(a.id, "idle");
      expect(readFileSync(join(h.t.dataDir, "sessions", a.id, "events.jsonl"), "utf8")).not.toContain("\"permission_request\"");
    } finally {
      await h.t.cleanup();
    }
  });

  it("全部放行：本人文件夹里覆盖已有文件照样问（11/11 过渡规矩，没有兜底）", async () => {
    const h = await setup();
    try {
      mkdirSync(join(h.work, "F"), { recursive: true });
      const existing = join(h.work, "F", "表.md");
      writeFileSync(existing, "本人的原文");
      h.fake({ writePath: existing });
      const a = (await h.open("F", "bypassPermissions")).body;
      await h.waitStatus(a.id, "waiting_permission");
      expect((await h.session(a.id)).pendingPermissions[0].toolName).toBe("Write");
      expect(readFileSync(existing, "utf8")).toBe("本人的原文");
    } finally {
      await h.t.cleanup();
    }
  });
});
