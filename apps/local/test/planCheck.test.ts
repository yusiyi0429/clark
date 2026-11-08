// 规划员开拆前先把现实问清楚（设计 18.11）：没绑文件夹、文件夹是空的、不是 git 仓库，都不出派活单，改成用「问用户」问本人；
// 问题经 status 条目报给云端（项目对话出选项框，18.10），本人答了才收派活单。检查只读，不改文件夹。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planFolderFacts } from "../src/planCheck.js";
import { api, gitRepo, pair, raw, startTestRunner, tempDir } from "./helpers.js";

async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

const PLAN = { summary: "拆一件", cards: [{ title: "改登录页", brief: "按约定第 1 条改", doneDefinition: "能登录", modelTier: "normal" }] };
const ASK = [{ question: "这件在哪个文件夹做？", header: "文件夹", multiSelect: false, options: [{ label: "新建一个 git 仓库（推荐）", description: "" }, { label: "用现有的文件夹", description: "" }] }];
const PROJECT = "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10";

describe("开拆前的检查", { timeout: 30_000 }, () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-plancheck-");
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  const items = (id: string, type: string) => (JSON.parse(readFileSync(join(t.dataDir, "outbox.json"), "utf8")).entries as { item: any }[])
    .map((e) => e.item).filter((i) => i.sessionId === id && i.type === type);
  const prompt = (id: string) => readFileSync(join(t.dataDir, "sessions", id, "system.md"), "utf8");
  const propose = async (id: string) => {
    const secret = JSON.parse(readFileSync(join(t.dataDir, "sessions", id, "session.json"), "utf8")).mcpSecret;
    const r = await raw(t.port, {
      method: "POST", path: `/internal/sessions/${id}/mcp`, headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "propose_plan", arguments: PLAN } }),
    });
    return r.body.result as { isError: boolean; content: { text: string }[] };
  };
  const open = async (cwd?: string) => (await call("POST", "/v1/sessions", { subject: { kind: "plan", taskId: "T1", projectId: PROJECT }, title: "拆卡：T1", ...(cwd ? { cwd } : {}), firstMessage: "拆卡交代" })).body;

  beforeAll(async () => {
    t = await startTestRunner({ pickFolder: work });
    token = await pair(t.port);
    await call("POST", "/v1/folders/pick", {});
    // 假规划员每一轮都去交派活单；被退回就用「问用户」问
    writeFileSync(join(work, ".fake-claude.json"), JSON.stringify({ plan: PLAN, askOnReject: ASK }));
  });
  afterAll(() => t.cleanup());

  for (const [name, make, said] of [
    ["空文件夹", () => { const d = join(work, "empty"); mkdirSync(d, { recursive: true }); return d; }, "绑的文件夹是空的"],
    ["不是 git 仓库", () => { const d = join(work, "plain"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "notes.md"), "笔记"); return d; }, "绑的文件夹不是 git 仓库"],
  ] as const) {
    it(`${name}：不出派活单，改成问本人；问题报给云端，答了才收`, async () => {
      const dir = make();
      const before = readdirSync(dir);
      const p = await open(dir);
      // 派活单被退回，接着问本人：status 条目带问题（云端在项目对话里出选项框）
      const ask = await until(() => items(p.id, "status").find((i) => i.data.question));
      expect(ask.subject).toMatchObject({ kind: "plan", taskId: "T1", projectId: PROJECT });
      expect(ask.data.question.questions[0].question).toBe("这件在哪个文件夹做？");
      expect(items(p.id, "card_plan")).toEqual([]);
      expect(prompt(p.id)).toContain(`要先问清楚：${said}`);
      const turn = readFileSync(join(work, ".fake-claude-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.readOnlyTurn === p.id).at(-1);
      expect(turn.result.isError).toBe(true);
      expect(turn.result.content[0].text).toContain(`先不交派活单：${said}`);

      // 项目对话那边答了：交给规划员；再交派活单就收
      const q = ask.data.question;
      expect((await call("POST", `/v1/sessions/${p.id}/questions/${encodeURIComponent(q.requestId)}`, { choices: [["新建一个 git 仓库（推荐）"]] })).status).toBe(200);
      expect((await propose(p.id)).isError).toBe(false);
      await until(() => items(p.id, "card_plan").length === 1);
      // 只看，没动文件夹
      expect(readdirSync(dir)).toEqual(before);
    });
  }

  it("没绑文件夹：不出派活单，要先问；本人在项目对话里说了一句以后才收", async () => {
    const p = await open();
    expect(p.cwd).toBe(join(t.dataDir, "plans", "T1"));
    await until(async () => (await call("GET", `/v1/sessions/${p.id}`)).body.session.status === "idle"); // 专用目录里没有假 claude 的配置
    expect(prompt(p.id)).toContain("文件夹：没绑");
    const rejected = await propose(p.id);
    expect([rejected.isError, rejected.content[0]!.text]).toEqual([true, expect.stringContaining("先不交派活单：这个项目在这台电脑上还没绑文件夹")]);
    expect(items(p.id, "card_plan")).toEqual([]);
    expect((await call("POST", `/v1/sessions/${p.id}/messages`, { text: "先在这里拆，文件夹我等下绑" })).status).toBe(200);
    expect((await propose(p.id)).isError).toBe(false);
  });

  it("像样的仓库：不拦，规划员看到分支和远端", async () => {
    const dir = gitRepo(join(work, "repo"));
    const p = await open(dir);
    await until(() => items(p.id, "card_plan").length === 1);
    expect(prompt(p.id)).toContain("是 git 仓库，当前分支 main；远端 origin https://github.com/example/project.git");
    expect(prompt(p.id)).not.toContain("要先问清楚");
  });

  it("远端里的口令不进提示词", async () => {
    const dir = gitRepo(join(work, "secret-remote"));
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["remote", "set-url", "origin", "https://user:ghp_token123@github.com/example/x.git"], { cwd: dir });
    const facts = await planFolderFacts(dir);
    expect(facts.remotes).toEqual([{ name: "origin", url: "https://github.com/example/x.git" }]);
    expect(facts.flags).toEqual([]);
  });
});
