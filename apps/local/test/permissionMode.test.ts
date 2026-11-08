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
  it("自动接受改文件：只放改文件的，命令照样问", () => {
    expect(allows("acceptEdits", "Edit", { file_path: join(folder, "a.txt"), old_string: "x", new_string: "y" })).toBe(true);
    expect(allows("acceptEdits", "Bash", { command: "ls" })).toBe(false);
  });
  it("全部放行：除了硬规矩都放", () => {
    expect(allows("bypassPermissions", "Bash", { command: `rm -rf ${sh(join(folder, "x"))}` })).toBe(true);
    expect(allows("bypassPermissions", "WebFetch", { url: "https://example.com" })).toBe(true);
    expect(allows("bypassPermissions", "Agent", { prompt: "x" })).toBe(true);
  });
  it("硬规矩（9.5）哪一档都问：推拉代码、gh、装东西联网、飞书写的、碰 .git .claude、允许的文件夹以外、天枢写的工具", () => {
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
    for (const mode of ["auto", "acceptEdits", "bypassPermissions"] as const) {
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

  it("全部放行也挡不住硬规矩：写到允许的文件夹以外照样等本人批", async () => {
    const h = await setup();
    try {
      h.fake({ writePath: join(tempDir("tl-pm-out-"), "x.txt") });
      const a = (await h.open("E", "bypassPermissions")).body;
      await h.waitStatus(a.id, "waiting_permission");
      expect((await h.session(a.id)).pendingPermissions[0].outsidePaths.length).toBe(1);
    } finally {
      await h.t.cleanup();
    }
  });
});
