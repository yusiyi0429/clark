// 项目转交（新首页设计 16.7）：交接检查只看 git；接手后 clone、切到交接分支、绑到项目；原负责人那边只解绑、不动文件。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalHandoverCheck, LocalProjectCloneResponse } from "@warmap/contracts";
import { cloneRepo, handoverCheck, repoName, stripCredentials } from "../src/handover.js";
import { registerFormats } from "../src/store.js";
import { api, pair, startTestRunner, tempDir } from "./helpers.js";

registerFormats();
const conforms = (schema: Parameters<typeof Value.Check>[0], value: unknown) => {
  expect([...Value.Errors(schema, value)].map((e) => `${e.path} ${e.message}`)).toEqual([]);
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=测试", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();

/** 一个「远端」（本地的 bare 仓库，有 main 和 handover/chat 两个分支）和从它 clone 的工作副本。 */
function remoteAndClone() {
  const root = tempDir("tl-ho-");
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "readme.md"), "原来的\n");
  writeFileSync(join(seed, "old.md"), "要改名的\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "branch", "handover/chat");
  const bare = join(root, "Chat_Service.git");
  git(root, "clone", "-q", "--bare", seed, bare);
  const work = join(root, "work");
  git(root, "clone", "-q", bare, work);
  return { root, bare, work };
}

describe("交接检查（只看 git）", () => {
  it("当前分支、远端（去掉账号口令）、没提交的文件、没推完的本地分支；不是仓库时列最近改过的文件；没绑为空", async () => {
    expect(stripCredentials("https://sean:ghp_x@github.com/a/b.git")).toBe("https://github.com/a/b.git");
    expect(stripCredentials("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");
    expect(repoName("https://github.com/TokenkingOS/Chat_Service.git")).toBe("Chat_Service");
    expect(repoName("git@github.com:TokenkingOS/Chat_Service.git")).toBe("Chat_Service");

    const { work } = remoteAndClone();
    git(work, "remote", "add", "mirror", "https://sean:ghp_secret123@github.com/a/b.git");
    writeFileSync(join(work, "readme.md"), "改了\n");
    git(work, "commit", "-q", "-am", "本地多一个提交");
    writeFileSync(join(work, "新 文件.md"), "没提交\n");
    writeFileSync(join(work, "readme.md"), "又改了\n");
    git(work, "branch", "tianshu/abc12345-card");
    git(work, "mv", "old.md", "renamed.md"); // 改名：一个文件，不是两个
    const at = new Date("2026-11-07T10:00:00Z");
    const r = await handoverCheck("11111111-1111-4111-8111-111111111111", { path: work, label: "work" }, at);
    conforms(LocalHandoverCheck, r);
    expect(r.git).toEqual({
      branch: "main",
      remotes: [{ name: "mirror", url: "https://github.com/a/b.git" }, { name: "origin", url: expect.any(String) }],
      uncommitted: expect.arrayContaining(["readme.md", "新 文件.md", "renamed.md"]), uncommittedCount: 3,
      unpushed: [{ branch: "main", upstream: "origin/main", ahead: 1 }, { branch: "tianshu/abc12345-card", upstream: null, ahead: null }],
    });
    expect(JSON.stringify(r)).not.toContain("ghp_secret123");
    expect(r.recentFiles).toBeNull();

    // 不是 git 仓库：最近改过的文件，新的在前，跳过 node_modules
    const plain = tempDir("tl-ho-plain-");
    writeFileSync(join(plain, "a-旧.md"), "x"); // 名字排在前面，但改得早：要排在后面
    utimesSync(join(plain, "a-旧.md"), new Date("2026-11-01T00:00:00Z"), new Date("2026-11-01T00:00:00Z"));
    mkdirSync(join(plain, "sub"));
    writeFileSync(join(plain, "sub", "新.md"), "x");
    mkdirSync(join(plain, "node_modules"));
    writeFileSync(join(plain, "node_modules", "x.js"), "x");
    const p = await handoverCheck("22222222-2222-4222-8222-222222222222", { path: plain, label: "plain" }, at);
    conforms(LocalHandoverCheck, p);
    expect(p.git).toBeNull();
    expect(p.recentFiles!.map((f) => f.path)).toEqual(["sub/新.md", "a-旧.md"]);
    // 没绑
    expect(await handoverCheck("66666666-6666-4666-8666-666666666666", null, at)).toEqual({ projectId: "66666666-6666-4666-8666-666666666666", checkedAt: at.toISOString(), folder: null, git: null, recentFiles: null });
  });

  it("clone：切到交接分支；远端没有就留在默认分支；拉不下来抛 git 的报错", async () => {
    const { root, bare } = remoteAndClone();
    expect(await cloneRepo(bare, join(root, "a"), "handover/chat")).toEqual({ branch: "handover/chat", fellBack: false });
    expect(await cloneRepo(bare, join(root, "b"), "handover/none")).toEqual({ branch: "main", fellBack: true });
    expect(await cloneRepo(bare, join(root, "c"), undefined)).toEqual({ branch: "main", fellBack: false });
    await expect(cloneRepo(join(root, "nope.git"), join(root, "d"), undefined)).rejects.toThrow(/fatal:/);
  });
});

describe("接手和交出（本机接口）", { timeout: 40_000 }, () => {
  it("接手：选放在哪 → clone、切交接分支、加进允许的文件夹、绑到项目；取消、重名、拉不下来、地址不对；交接检查走项目绑的文件夹；原负责人解绑不动文件", async () => {
    const { root, bare } = remoteAndClone();
    const parent = join(root, "projects-here");
    mkdirSync(parent);
    let pick: string | null = parent;
    // 测试里把 GitHub 地址换成本地的 bare 仓库；「坏地址」照真的 git 报错
    const urls: Record<string, string> = { "https://github.com/TokenkingOS/Chat_Service.git": bare, "https://github.com/TokenkingOS/Gone.git": join(root, "gone.git") };
    const t = await startTestRunner({ pickFolder: () => pick, cloneRepo: (url, dest, branch) => cloneRepo(urls[url] ?? url, dest, branch) });
    try {
      const token = await pair(t.port);
      const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
      const url = "https://github.com/TokenkingOS/Chat_Service.git";
      const got = await call("POST", "/v1/projects/33333333-3333-4333-8333-333333333333/clone", { repoUrl: url, branch: "handover/chat" });
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      conforms(LocalProjectCloneResponse, got.body);
      const dest = join(parent, "Chat_Service");
      expect(got.body).toMatchObject({ branch: "handover/chat", fellBack: false, project: { projectId: "33333333-3333-4333-8333-333333333333", folder: { path: dest, label: "Chat_Service" } } });
      expect(existsSync(join(dest, "readme.md"))).toBe(true);
      expect((await call("GET", "/v1/folders")).body.folders).toEqual([expect.objectContaining({ path: dest, projects: [{ projectId: "33333333-3333-4333-8333-333333333333", name: null }] })]);

      // 交接检查：走项目绑的文件夹
      const check = (await call("POST", "/v1/projects/33333333-3333-4333-8333-333333333333/handover-check", {})).body;
      conforms(LocalHandoverCheck, check);
      expect(check).toMatchObject({ projectId: "33333333-3333-4333-8333-333333333333", folder: { path: dest }, git: { branch: "handover/chat", uncommittedCount: 0 } });
      expect((await call("POST", "/v1/projects/44444444-4444-4444-8444-444444444444/handover-check", {})).body).toMatchObject({ folder: null, git: null, recentFiles: null });

      // 那里已经有了：400；地址不对：400；拉不下来：409，原因写明；取消：project 为 null
      const again = await call("POST", "/v1/projects/33333333-3333-4333-8333-333333333333/clone", { repoUrl: url });
      expect([again.status, again.body.error.message]).toEqual([400, `${parent} 里已经有「Chat_Service」了，换个地方，或者直接选那个文件夹绑上`]);
      expect((await call("POST", "/v1/projects/33333333-3333-4333-8333-333333333333/clone", { repoUrl: "file:///C:/x" })).status).toBe(400);
      const gone = await call("POST", "/v1/projects/55555555-5555-4555-8555-555555555555/clone", { repoUrl: "https://github.com/TokenkingOS/Gone.git" });
      expect(gone.status).toBe(409);
      expect(gone.body.error.message).toMatch(/^没拉下来：/);
      expect(existsSync(join(parent, "Gone"))).toBe(false);
      pick = null;
      expect((await call("POST", "/v1/projects/33333333-3333-4333-8333-333333333333/clone", { repoUrl: url, name: "另一份" })).body).toEqual({ project: null, branch: null, fellBack: false });

      // 原负责人那边：解绑，不动文件，文件夹也还在允许的列表里
      expect((await call("PUT", "/v1/projects/33333333-3333-4333-8333-333333333333/folder", { folderId: null })).body.folder).toBeNull();
      expect(existsSync(join(dest, "readme.md"))).toBe(true);
      expect((await call("GET", "/v1/folders")).body.folders).toEqual([expect.objectContaining({ path: dest, projects: [] })]);
    } finally {
      await t.cleanup();
    }
  });
});
