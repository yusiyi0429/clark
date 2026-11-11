// Codex 接成子会话的执行方（设计 17.2 第 38 条，契约 LocalModelProfile.catalog、LOCAL_AGENT_PERMISSION_MODES）：
// 用假的 codex app-server（fixtures/fake-codex.mjs），不起本人电脑上真装的 Codex、不调模型。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalModelListResponse, LocalStatusResponse } from "@warmap/contracts";
import { registerFormats } from "../src/store.js";
import { catalogFrom, codexProfileId } from "../src/codexCatalog.js";
import { mcpArgs } from "../src/agents/codex.js";
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

const SOL = codexProfileId("gpt-6.1-sol");
const G55 = codexProfileId("gpt-5.5");

describe("模型目录", () => {
  it("model/list → 模型：不列 hidden 的，思考程度只留契约里有的档，id 只用字母数字和 _ -", () => {
    const got = catalogFrom({ data: [
      { model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", supportedReasoningEfforts: ["low", "ultra", "minimal"].map((e) => ({ reasoningEffort: e })), defaultReasoningEffort: "low" },
      { model: "x", hidden: true, supportedReasoningEfforts: [] },
      { model: "gpt-5.5", displayName: "GPT-5.5", supportedReasoningEfforts: [{ reasoningEffort: "medium" }], defaultReasoningEffort: "minimal" },
    ] });
    expect(got).toEqual([
      { model: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: ["low", "ultra"], defaultEffort: "low" },
      { model: "gpt-5.5", label: "GPT-5.5", efforts: ["medium"], defaultEffort: null },
    ]);
    expect(SOL).toBe("codex-gpt-6_1-sol");
  });

  it("会话的 MCP 改成 Codex 的 -c mcp_servers：${变量} 的请求头走 env_http_headers，钥匙不进命令行", () => {
    const dir = tempDir("tl-cxmcp-");
    const path = join(dir, "mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { "tianshu-session": { type: "http", url: "http://127.0.0.1:1/internal/sessions/s/mcp", headers: { "x-tianshu-session-secret": "${TIANSHU_SESSION_SECRET}" } }, "bad name": { url: "http://x" } } }));
    expect(mcpArgs(path)).toEqual([
      "-c", 'mcp_servers.tianshu-session.url="http://127.0.0.1:1/internal/sessions/s/mcp"',
      "-c", 'mcp_servers.tianshu-session.env_http_headers={"x-tianshu-session-secret"="TIANSHU_SESSION_SECRET"}',
    ]);
  });
});

describe("Codex 子会话", { timeout: 60_000 }, () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const opened: string[] = [];
  const work = tempDir("tl-codex-");
  const codexHome = () => join(t.dataDir, "codex");
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  const trace = () => (existsSync(join(codexHome(), "trace.jsonl")) ? readFileSync(join(codexHome(), "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body;
  const events = (id: string) => readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const idle = (id: string) => until(async () => { const s = (await session(id)).session; return s.status === "idle" ? s : null; });
  const open = async (name: string, firstMessage: string, extra: Record<string, unknown> = {}) => {
    mkdirSync(join(work, name), { recursive: true });
    const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: name }, title: name, cwd: join(work, name), firstMessage, modelProfileId: SOL, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.id as string;
  };
  const say = (id: string, text: string) => call("POST", `/v1/sessions/${id}/messages`, { text });

  beforeAll(async () => {
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    t = await startTestRunner({ pickFolder: work, fetchImpl: offline, fakeCodex: true, openUrl: (u) => opened.push(u) });
    token = await pair(t.port);
    await call("POST", "/v1/folders/pick", {});
  });
  afterAll(() => t.cleanup());

  it("没登录：模型里没有 Codex 一组，连接页写未登录；点登录替本人打开浏览器，登上以后列出它能用的模型", async () => {
    const st0 = (await call("GET", "/v1/status")).body;
    expect(Value.Check(LocalStatusResponse, st0)).toBe(true);
    expect(st0.agents.find((a: any) => a.kind === "codex")).toMatchObject({ installed: true, loggedIn: false, version: "0.159.2", compatible: true });
    expect(st0.tools.find((x: any) => x.kind === "codex")).toMatchObject({ state: "not_logged_in" });
    expect((await call("GET", "/v1/models")).body.profiles.some((p: any) => p.agent === "codex")).toBe(false);
    expect((await call("POST", "/v1/agents/codex/login/code", { code: "123456" })).status).toBe(400);
    expect((await call("POST", "/v1/agents/codex/install", {})).status).toBe(501);
    expect((await call("POST", "/v1/agents/codex/login", {})).status).toBe(200);
    await until(() => opened.length > 0);
    expect(opened[0]).toMatch(/^https:\/\/auth\.openai\.com\//);
    // 登上了：状态、模型目录跟着变
    const codex = await until(async () => { const a = (await call("GET", "/v1/status")).body.agents.find((x: any) => x.kind === "codex"); return a.setup.phase === "succeeded" ? a : null; });
    expect(codex.setup.loginUrl).toMatch(/^https:\/\/auth\.openai\.com\//);
    const profiles = await until(async () => { const r = (await call("GET", "/v1/models")).body; return r.profiles.some((p: any) => p.agent === "codex") ? r.profiles : null; });
    expect(Value.Check(LocalModelListResponse, { profiles })).toBe(true);
    expect(profiles.filter((p: any) => p.agent === "codex")).toEqual([
      expect.objectContaining({ id: SOL, label: "GPT-6.1-Sol", source: "subscription", model: "gpt-6.1-sol", catalog: true, isDefault: false, efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low", origin: { provider: "codex", label: "Codex 订阅", via: null } }),
      expect.objectContaining({ id: G55, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" }),
    ]);
    expect(profiles.find((p: any) => p.id === "subscription")).toMatchObject({ catalog: false, origin: { provider: "claude-subscription" } });
    // 只读：不能改、不能删，也不能自己配 Codex 的
    expect((await call("PUT", `/v1/models/${SOL}`, { label: "x", source: "subscription", model: "gpt-6.1-sol" })).status).toBe(400);
    expect((await call("DELETE", `/v1/models/${SOL}`)).status).toBe(400);
    expect((await call("PUT", "/v1/models/mine", { label: "x", source: "subscription", agent: "codex", model: "gpt-6.1-sol" })).status).toBe(400);
  });

  it("用 Codex 起：天枢专用的配置目录、批准一律先到本机、工作规矩走 developerInstructions，命令批了才执行，过程行和用量照常", async () => {
    const id = await open("A", "run git status", { permissionMode: "default" });
    const s = await until(async () => { const x = await session(id); return x.pendingPermissions[0] ? x : null; });
    expect(s.session).toMatchObject({ agent: "codex", modelProfileId: SOL, run: { harness: "codex", model: "gpt-6.1-sol", effort: "low", multiAgent: false, origin: { provider: "codex" } } });
    expect(s.pendingPermissions[0]).toMatchObject({ toolName: process.platform === "win32" ? "PowerShell" : "Bash", title: "运行 git status" });
    const start = trace().find((l) => l.method === "thread/start");
    expect(start.params).toMatchObject({ approvalPolicy: "untrusted", sandbox: "workspace-write", model: "gpt-6.1-sol", cwd: join(work, "A") });
    expect(start.params.developerInstructions).toMatch(/字$/);
    const launch = trace().filter((l) => l.argv).at(-1);
    expect(launch.argv).toContain("app-server");
    expect(launch.argv.join(" ")).toContain("mcp_servers.tianshu-session.env_http_headers");
    expect(launch.env).toEqual({ TIANSHU_SESSION_SECRET: true, OPENAI_API_KEY: null });
    expect(trace().find((l) => l.method === "turn/start").params).toMatchObject({ model: "gpt-6.1-sol", effort: "low" });
    await call("POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(s.pendingPermissions[0].requestId)}`, { decision: "allow" });
    const done = await idle(id);
    expect(trace().find((l) => l.command === "git status")?.decision).toBe("accept");
    const ev = events(id);
    expect(ev.some((e) => e.type === "tool_call" && e.title === "运行 git status")).toBe(true);
    expect(ev.some((e) => e.type === "tool_result" && e.preview === "ok" && !e.isError)).toBe(true);
    expect(ev.some((e) => e.type === "assistant_text" && e.text === "done")).toBe(true);
    expect(ev.find((e) => e.type === "turn_end")).toMatchObject({ isError: false, text: "done", usage: { inputTokens: 6, cacheReadTokens: 4, outputTokens: 5, costUsd: null } });
    expect(ev.some((e) => e.type === "receipt" && e.state === "read")).toBe(true);
    expect(done.usage.outputTokens).toBe(5);
    // 跑着时报的额度记进 Codex 那枚
    const quota = (await call("GET", "/v1/status")).body.quota.find((q: any) => q.id === "codex");
    expect(quota.windows.find((w: any) => w.kind === "session").usedPercent).toBe(12);
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });

  it("权限模式：自动放行目录里的、改文件在「自动接受改文件」放行；推代码哪一档都问（全部放行也问），MCP 写的工具问、本会话的工具不问", async () => {
    const id = await open("B", "run Get-Content notes.txt", { permissionMode: "auto" });
    await idle(id);
    expect(trace().find((l) => l.command === "Get-Content notes.txt")?.decision).toBe("accept");
    expect(events(id).some((e) => e.type === "permission_request")).toBe(false);
    await call("PUT", `/v1/sessions/${id}/permission-mode`, { mode: "bypassPermissions" });
    await say(id, "run git push origin main");
    const p = await until(async () => (await session(id)).pendingPermissions[0] ?? null);
    expect(p.title).toContain("git push");
    await call("POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(p.requestId)}`, { decision: "deny", message: "先别推" });
    await until(() => trace().find((l) => l.command === "git push origin main")?.decision === "decline");
    // 拒绝的理由先作为插话送进去（Codex 的决定里不能带理由）
    expect(trace().some((l) => l.method === "turn/steer" && JSON.stringify(l.params.input).includes("先别推"))).toBe(true);
    await idle(id);
    await call("PUT", `/v1/sessions/${id}/permission-mode`, { mode: "acceptEdits" });
    await say(id, "patch made.txt");
    await idle(id);
    expect(readFileSync(join(work, "B", "made.txt"), "utf8")).toBe("hello\n");
    await say(id, "mcp tianshu-session add_artifact");
    await idle(id);
    expect(trace().find((l) => l.tool === "add_artifact")?.elicitation).toBe("accept");
    await say(id, "mcp tianshu create_item");
    const q = await until(async () => (await session(id)).pendingPermissions[0] ?? null);
    expect(q).toMatchObject({ toolName: "mcp__tianshu__create_item", canAllowForSession: false });
    await call("POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(q.requestId)}`, { decision: "deny" });
    await until(() => trace().find((l) => l.tool === "create_item")?.elicitation === "decline");
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });

  it("改前拷一份（11/11）：Codex 改工作目录外面本人的已有文件，放行前先拷一份；恢复回到原文", async () => {
    const elsewhere = tempDir("tl-codex-else-");
    const target = join(elsewhere, "表.md");
    writeFileSync(target, "本人的原文");
    const id = await open("U", `patch ${target}`, { permissionMode: "bypassPermissions" });
    await idle(id);
    expect(readFileSync(target, "utf8")).toBe("hello\n");
    expect(events(id).some((e) => e.type === "permission_request")).toBe(false);
    const r = await call("POST", `/v1/sessions/${id}/files/restore`, { paths: [target] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.failed).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("本人的原文");
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });

  it("全部放行也问（11/11 过渡规矩）：Codex 用命令删工作目录外面本人的已有文件（不是文档，没有兜底；文档会先拷一份）→ 停在等批准、原文没动", async () => {
    const elsewhere = tempDir("tl-codex-del-");
    const target = join(elsewhere, "照片.jpg");
    writeFileSync(target, "本人的原文");
    const id = await open("D", `run Remove-Item ${target.replaceAll("\\", "/")}`, { permissionMode: "bypassPermissions" });
    const p = await until(async () => (await session(id)).pendingPermissions[0] ?? null);
    expect(p.title).toContain("Remove-Item");
    expect(readFileSync(target, "utf8")).toBe("本人的原文");
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });

  it("Codex 没有「先出计划」，规划员只能用 Claude Code；思考程度只收这个模型有的档", async () => {
    mkdirSync(join(work, "P"), { recursive: true });
    const plan = await call("POST", "/v1/sessions", { subject: { kind: "plan", projectId: "11111111-1111-4111-8111-111111111111" }, title: "拆", cwd: join(work, "P"), firstMessage: "拆", modelProfileId: SOL });
    expect(plan.status).toBe(400);
    expect((await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "x" }, title: "x", cwd: join(work, "P"), firstMessage: "x", modelProfileId: SOL, permissionMode: "plan" })).status).toBe(400);
    expect((await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "x" }, title: "x", cwd: join(work, "P"), firstMessage: "x", modelProfileId: G55, effort: "ultra" })).status).toBe(400);
    expect((await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "x" }, title: "x", cwd: join(work, "P"), firstMessage: "x", modelProfileId: SOL, agent: "claude-code" })).status).toBe(400);
    const preview = (await call("POST", "/v1/runs/preview", { modelProfileId: SOL, effort: "ultra" })).body;
    expect(preview).toMatchObject({ harness: "codex", effort: "ultra", modelName: "gpt-6.1-sol" });
  });

  it("换模型、换思考程度：没在跑一轮当场换，在跑就这一轮做完换，都不重开进程；下一轮带新的", async () => {
    const id = await open("C", "hi", { effort: "ultra" });
    await idle(id);
    expect(trace().filter((l) => l.method === "turn/start").at(-1).params).toMatchObject({ model: "gpt-6.1-sol", effort: "ultra" });
    const launches = () => trace().filter((l) => l.argv).length;
    const before = launches();
    // 空着：当场换（ultra 新模型没有，回到它的默认档）
    const now = (await call("PUT", `/v1/sessions/${id}/model`, { modelProfileId: G55 })).body;
    expect(now).toMatchObject({ applied: "now", session: { modelProfileId: G55, run: { model: "gpt-5.5", effort: "medium" } } });
    await say(id, "slow");
    await until(async () => (await session(id)).session.status === "running");
    await until(() => trace().filter((l) => l.method === "turn/start").at(-1)?.params.model === "gpt-5.5");
    // 跑着：这一轮做完再换
    const later = (await call("PUT", `/v1/sessions/${id}/model`, { modelProfileId: SOL, effort: "max" })).body;
    expect(later).toMatchObject({ applied: "after_turn", session: { modelProfileId: G55, pendingModel: { modelProfileId: SOL, effort: "max" } } });
    // 插话：同一轮里读到
    await say(id, "换个说法");
    const s = await until(async () => { const x = (await session(id)).session; return x.status === "idle" && x.modelProfileId === SOL ? x : null; });
    expect(s.pendingModel).toBeUndefined();
    expect(s.run).toMatchObject({ model: "gpt-6.1-sol", effort: "max" });
    expect(events(id).some((e) => e.type === "assistant_text" && e.text === "heard: 换个说法")).toBe(true);
    expect(events(id).some((e) => e.type === "plan" && e.progress.total === 2)).toBe(true);
    await say(id, "again");
    await idle(id);
    expect(trace().filter((l) => l.method === "turn/start").at(-1).params).toMatchObject({ model: "gpt-6.1-sol", effort: "max" });
    expect(launches()).toBe(before);
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });

  it("停下：这一轮停了，会话还在、还能接着说", async () => {
    const id = await open("D", "slow");
    await until(async () => (await session(id)).session.status === "running");
    await until(() => trace().some((l) => l.method === "turn/start" && JSON.stringify(l.params.input).includes("slow")));
    expect((await call("POST", `/v1/sessions/${id}/interrupt`, {})).status).toBe(200);
    await idle(id);
    expect(events(id).find((e) => e.type === "turn_end")).toMatchObject({ isError: true, errorKind: "interrupted" });
    await say(id, "还在吗");
    await until(() => events(id).some((e) => e.type === "assistant_text" && e.text === "echo: 还在吗"));
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });

  it("额度用完：Codex 的卡停着等额度，Codex 那枚记成用完", async () => {
    const id = await open("E", "limit");
    const s = await until(async () => { const x = (await session(id)).session; return x.hold ? x : null; });
    expect(s.hold.reason).toBe("usage_limit");
    const quota = (await call("GET", "/v1/status")).body.quota.find((q: any) => q.id === "codex");
    expect(quota.windows.find((w: any) => w.kind === "session")).toMatchObject({ usedPercent: 100, state: "blocked" });
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });

  it("干净会话不带本人自己的技能：Codex 列出来的本人技能逐个关掉（只对这一个进程），技能要飞书的留着 lark-*；开了「带上个人配置」的照留", async () => {
    // 另起一个本机程序：它的 Codex 配置目录里，假 codex 的 skills/list 回两个本人的技能、一个它自带的
    const dataDir = tempDir("tl-codex-skills-");
    const dir = tempDir("tl-codex-skills-work-");
    mkdirSync(join(dataDir, "codex"), { recursive: true });
    writeFileSync(join(dataDir, "codex", "auth.json"), "{}");
    writeFileSync(join(dataDir, "codex", "fake-skills.json"), JSON.stringify([
      { name: "lark-doc", path: "C:/Users/me/.agents/skills/lark-doc/SKILL.md", scope: "user", enabled: true },
      { name: "my-notes", path: "C:/Users/me/.agents/skills/my notes/SKILL.md", scope: "user", enabled: true },
      { name: "imagegen", path: join(dataDir, "codex", "skills", ".system", "imagegen", "SKILL.md"), scope: "system", enabled: true },
    ]));
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const other = await startTestRunner({ dataDir, pickFolder: dir, fetchImpl: offline, fakeCodex: true });
    try {
      const tk = await pair(other.port);
      const req = (method: string, path: string, body?: unknown) => api(other.port, tk, method, path, body);
      await req("POST", "/v1/folders/pick", {});
      await until(async () => (await req("GET", "/v1/models")).body.profiles.some((p: any) => p.id === SOL));
      const lines = () => readFileSync(join(dataDir, "codex", "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const skillsArg = async (name: string, extra: Record<string, unknown>) => {
        mkdirSync(join(dir, name), { recursive: true });
        const r = await req("POST", "/v1/sessions", { subject: { kind: "card", cardId: name }, title: name, cwd: join(dir, name), firstMessage: "hi", modelProfileId: SOL, ...extra });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        await until(async () => (await req("GET", `/v1/sessions/${r.body.id}`)).body.session.status === "idle");
        const argv = lines().filter((l) => l.argv && l.cwd === join(dir, name)).at(-1).argv as string[];
        await req("POST", `/v1/sessions/${r.body.id}/kill`, {});
        return argv.find((a) => a.startsWith("skills.config=")) ?? null;
      };
      const off = (path: string) => `{path=${JSON.stringify(path)},enabled=false}`;
      expect(await skillsArg("S1", {})).toBe(`skills.config=[${off("C:/Users/me/.agents/skills/lark-doc/SKILL.md")},${off("C:/Users/me/.agents/skills/my notes/SKILL.md")}]`);
      const role = { id: "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e12", name: "助理", kind: "worker", modelTier: "normal", version: 1, tools: ["feishu"], dutiesMd: "管飞书文档", practiceMd: "先看再改", acceptanceMd: "有链接" };
      expect(await skillsArg("S2", { role })).toBe(`skills.config=[${off("C:/Users/me/.agents/skills/my notes/SKILL.md")}]`);
      expect(await skillsArg("S3", { includePersonalConfig: true })).toBeNull();
      // 本人的技能 5 分钟内只列一次（另起一个 app-server 列的），不是每开一个会话都列
      expect(lines().filter((l) => l.method === "skills/list")).toHaveLength(1);
    } finally {
      await other.cleanup();
    }
  });
});
