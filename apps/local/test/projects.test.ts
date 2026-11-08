// 项目在这台电脑上的文件夹（新首页设计 16.6）：按项目记住文件夹；卡和专题在项目的文件夹里跑；上报带 projectId。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalFolderListResponse, LocalProjectListResponse } from "@warmap/contracts";
import { registerFormats } from "../src/store.js";
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
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("项目的文件夹", { timeout: 40_000 }, () => {
  it("按项目记住文件夹、连接页看得到挂在哪；卡、专题、只带项目的规划员不指定目录就在项目的文件夹里做，没绑的卡用项目专用目录；subject 带 projectId 上报，验收员跟着卡；删文件夹解绑", async () => {
    const repo = tempDir("tl-proj-repo-");
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "测试");
    git(repo, "config", "user.email", "test@example.com");
    writeFileSync(join(repo, ".gitignore"), ".fake-claude-trace.jsonl\n.fake-claude-turns.jsonl\n");
    writeFileSync(join(repo, ".fake-claude.json"), "{}");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    const plain = tempDir("tl-proj-plain-");
    const picks = [repo, plain];
    const t = await startTestRunner({ pickFolder: () => picks.shift() ?? null });
    try {
      const token = await pair(t.port);
      const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
      const a = (await call("POST", "/v1/folders/pick", {})).body.folder;
      const b = (await call("POST", "/v1/folders/pick", {})).body.folder;

      // 绑：项目 p1 → 仓库，p3 → 普通文件夹；不在允许列表里的文件夹 404
      const bound = await call("PUT", "/v1/projects/77777777-7777-4777-8777-777777777771/folder", { folderId: a.id, name: "天枢本机程序" });
      expect(bound.status).toBe(200);
      expect(bound.body).toMatchObject({ projectId: "77777777-7777-4777-8777-777777777771", name: "天枢本机程序", folder: { id: a.id, path: a.path, label: a.label } });
      expect((await call("PUT", "/v1/projects/77777777-7777-4777-8777-777777777773/folder", { folderId: b.id })).body).toMatchObject({ projectId: "77777777-7777-4777-8777-777777777773", name: null, folder: { id: b.id } });
      expect((await call("PUT", "/v1/projects/77777777-7777-4777-8777-777777777779/folder", { folderId: "000000000000" })).status).toBe(404);
      expect((await call("PUT", "/v1/projects/77777777-7777-4777-8777-777777777779/folder", { path: repo })).status).toBe(400); // 网页不能直接写路径
      expect((await call("PUT", "/v1/projects/not-a-uuid/folder", { folderId: a.id })).status).toBe(400); // 项目 id 是天枢的 uuid
      const projects = (await call("GET", "/v1/projects")).body;
      conforms(LocalProjectListResponse, projects);
      expect(projects.projects.map((p: any) => [p.projectId, p.folder?.id ?? null])).toEqual([["77777777-7777-4777-8777-777777777771", a.id], ["77777777-7777-4777-8777-777777777773", b.id]]);
      // 改名不丢文件夹以外的东西：只改名字时带同一个 folderId
      expect((await call("PUT", "/v1/projects/77777777-7777-4777-8777-777777777771/folder", { folderId: a.id })).body.name).toBe("天枢本机程序");
      const folders = (await call("GET", "/v1/folders")).body;
      conforms(LocalFolderListResponse, folders);
      expect(folders.folders.map((f: any) => [f.id, f.projects])).toEqual([[a.id, [{ projectId: "77777777-7777-4777-8777-777777777771", name: "天枢本机程序" }]], [b.id, [{ projectId: "77777777-7777-4777-8777-777777777773", name: null }]]]);

      // 卡不指定目录：在项目绑的仓库里开自己的工作树
      const card = (await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "card-p1", projectId: "77777777-7777-4777-8777-777777777771" }, title: "改页面", firstMessage: "做", permissionMode: "auto" })).body;
      expect(card.subject).toEqual({ kind: "card", cardId: "card-p1", projectId: "77777777-7777-4777-8777-777777777771" });
      expect(card.workspace).toMatchObject({ kind: "worktree", folder: a.path });
      // 专题不指定目录：就在项目的文件夹里
      const topic = (await call("POST", "/v1/sessions", { subject: { kind: "topic", topicId: "tp-1", projectId: "77777777-7777-4777-8777-777777777773" }, title: "调研", firstMessage: "调研" })).body;
      expect(topic.cwd.toLowerCase()).toBe(plain.toLowerCase());
      // 项目没绑文件夹：卡在项目专用目录里做（文件夹模式）
      const loose = (await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "card-p2", projectId: "77777777-7777-4777-8777-777777777772" }, title: "没绑的项目", firstMessage: "做" })).body;
      expect(loose.cwd).toBe(join(t.dataDir, "projects", "77777777-7777-4777-8777-777777777772"));
      expect(loose.workspace).toEqual({ kind: "folder", folder: join(t.dataDir, "projects", "77777777-7777-4777-8777-777777777772") });
      // 不带项目也不指定目录的卡照旧不行
      expect((await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "card-x" }, title: "x", firstMessage: "做" })).status).toBe(400);
      // 拆没挂 Task 的项目（16.3）：规划员只带 projectId，在项目的文件夹里跑；没绑文件夹时用按项目建的规划目录；Task、项目都不带不行
      const planner = (await call("POST", "/v1/sessions", { subject: { kind: "plan", projectId: "77777777-7777-4777-8777-777777777771" }, title: "拆卡：天枢本机程序", firstMessage: "拆" })).body;
      expect(planner.cwd.toLowerCase()).toBe(repo.toLowerCase());
      const loosePlanner = (await call("POST", "/v1/sessions", { subject: { kind: "plan", projectId: "77777777-7777-4777-8777-777777777772" }, title: "拆卡", firstMessage: "拆" })).body;
      expect(loosePlanner.cwd).toBe(join(t.dataDir, "plans", "77777777-7777-4777-8777-777777777772"));
      expect((await call("POST", "/v1/sessions", { subject: { kind: "plan" }, title: "x", firstMessage: "拆" })).status).toBe(400);
      // 派活单照旧经 card_plan 报上去，subject 只带 projectId
      const plannerSecret = JSON.parse(readFileSync(join(t.dataDir, "sessions", planner.id, "session.json"), "utf8")).mcpSecret;
      await raw(t.port, {
        method: "POST", path: `/internal/sessions/${planner.id}/mcp`, headers: { "x-tianshu-session-secret": plannerSecret, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "propose_plan", arguments: { summary: "拆一件", cards: [{ title: "改页面", brief: "改", doneDefinition: "页面能打开", modelTier: "normal" }] } } }),
      });
      const planItem = await until(() => JSON.parse(readFileSync(join(t.dataDir, "outbox.json"), "utf8")).entries.map((e: any) => e.item).find((i: any) => i.type === "card_plan"));
      expect(planItem.subject).toEqual({ kind: "plan", projectId: "77777777-7777-4777-8777-777777777771" });

      // 上报：subject 带 projectId
      await until(async () => (await call("GET", `/v1/sessions/${card.id}`)).body.session.status === "idle");
      const items = JSON.parse(readFileSync(join(t.dataDir, "outbox.json"), "utf8")).entries.map((e: any) => e.item).filter((i: any) => i.sessionId === card.id);
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i: any) => i.subject.projectId === "77777777-7777-4777-8777-777777777771")).toBe(true);
      // 交回以后本机起的验收员跟着卡带上 projectId
      const secret = JSON.parse(readFileSync(join(t.dataDir, "sessions", card.id, "session.json"), "utf8")).mcpSecret;
      await raw(t.port, {
        method: "POST", path: `/internal/sessions/${card.id}/mcp`, headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hand_back", arguments: { summary: "做完了", criteria: [{ index: 1, result: "met", evidence: "x" }] } } }),
      });
      const verifier = await until(async () => (await call("GET", "/v1/sessions")).body.sessions.find((s: any) => s.subject.kind === "verify"));
      expect(verifier.subject).toMatchObject({ kind: "verify", cardId: "card-p1", projectId: "77777777-7777-4777-8777-777777777771" });

      // 删掉允许的文件夹：绑着它的项目解绑
      expect((await call("DELETE", `/v1/folders/${b.id}`)).status).toBe(200);
      expect((await call("GET", "/v1/projects")).body.projects.find((p: any) => p.projectId === "77777777-7777-4777-8777-777777777773")).toMatchObject({ folder: null, name: null });
      // 解绑
      expect((await call("PUT", "/v1/projects/77777777-7777-4777-8777-777777777771/folder", { folderId: null })).body.folder).toBeNull();
      expect((await call("GET", "/v1/folders")).body.folders[0].projects).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });
});
