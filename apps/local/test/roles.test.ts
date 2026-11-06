// 岗位进会话、挑刺岗位、评审会、工具名单决定挂什么（V2 设计 19.5，ADR 0033）。
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, pair, startTestRunner, tempDir } from "./helpers.js";

const trace = (dir: string) => readFileSync(join(dir, ".fake-claude-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.argv);
const after = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
async function until<T>(fn: () => Promise<T | undefined | false>, ms = 5_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

const role = (name: string, tools: string[] = []) => ({
  id: "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e1" + name.length, name, kind: "worker", modelTier: "normal", version: 3, tools,
  dutiesMd: `${name}的职责：把事做对`, practiceMd: `${name}的做法：先列计划`, acceptanceMd: `${name}的验收口径：有证据`,
});

describe("岗位", () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-work-");
  const skills = tempDir("tl-skills-");
  mkdirSync(join(skills, "lark-doc"));
  writeFileSync(join(skills, "lark-doc", "SKILL.md"), "---\nname: lark-doc\n---\n飞书文档");
  mkdirSync(join(skills, "other-skill"));
  writeFileSync(join(skills, "other-skill", "SKILL.md"), "x");
  beforeAll(async () => {
    t = await startTestRunner({ pickFolder: work, skillsDir: skills, fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    token = await pair(t.port);
    await api(t.port, token, "POST", "/v1/folders/pick", {});
  });
  afterAll(async () => { await t.cleanup(); });
  const kill = (id: string) => api(t.port, token, "POST", `/v1/sessions/${id}/kill`, {});

  it("卡带岗位：职责、做法、验收口径和工作规矩进追加的系统提示词；工具名单里没有的不给；本人的仓库里不多文件", async () => {
    const before = readdirSync(work).filter((f) => !f.startsWith(".fake-claude"));
    const s = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c1" }, title: "x", cwd: work, firstMessage: "hi", role: role("开发", ["github"]) });
    expect(s.status).toBe(200);
    const argv: string[] = trace(work).at(-1).argv;
    const promptFile = after(argv, "--append-system-prompt-file")!;
    expect(realpathSync(promptFile)).toBe(realpathSync(join(t.dataDir, "sessions", s.body.id, "system.md")));
    const prompt = readFileSync(promptFile, "utf8");
    for (const text of ["## 你的岗位：开发", "开发的职责：把事做对", "开发的做法：先列计划", "开发的验收口径：有证据", "hand_back", "GitHub：用 gh 命令行"]) expect(prompt).toContain(text);
    expect(argv).not.toContain("--agents");
    expect(argv).not.toContain("--plugin-dir");
    expect(after(argv, "--disallowedTools")!.split(",")).toEqual(expect.arrayContaining(["WebSearch", "mcp__tianshu__web_search"]));
    expect(readdirSync(work).filter((f) => !f.startsWith(".fake-claude"))).toEqual(before);
    await kill(s.body.id);
  });

  it("执行方启动途中（握手回复之前）连本会话 MCP 也连得上：专题看到存版本的工具", async () => {
    const dir = (await api(t.port, token, "GET", "/v1/folders")).body.folders[0].path as string;
    writeFileSync(join(dir, ".fake-claude.json"), JSON.stringify({ connectMcpOnInit: true }));
    const s = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "topic", topicId: "t-early" }, title: "x", cwd: dir, firstMessage: "hi" });
    expect(s.status).toBe(200);
    const checked = readFileSync(join(dir, ".fake-claude-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.mcpOnInit).at(-1);
    expect(checked.mcpOnInit).toEqual({ status: 200, tools: ["add_artifact", "add_evidence", "save_version", "set_feishu_url"] });
    writeFileSync(join(dir, ".fake-claude.json"), "{}");
    await kill(s.body.id);
  });

  it("不带岗位：只有工作规矩，工具照旧全给", async () => {
    const s = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c2" }, title: "x", cwd: work, firstMessage: "hi" });
    const argv: string[] = trace(work).at(-1).argv;
    const prompt = readFileSync(after(argv, "--append-system-prompt-file")!, "utf8");
    expect(prompt).toContain("hand_back");
    expect(prompt).not.toContain("你的岗位");
    expect(argv).not.toContain("--disallowedTools"); // 订阅模型、没有岗位：自带搜索也给
    await kill(s.body.id);
  });

  it("岗位要飞书：挂一个只在本会话生效的插件，里面是指向本人飞书技能的链接；没装飞书技能就在提示词里说明", async () => {
    const s = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c3" }, title: "x", cwd: work, firstMessage: "hi", role: role("写稿人", ["feishu", "web_search"]) });
    const argv: string[] = trace(work).at(-1).argv;
    const plugin = after(argv, "--plugin-dir")!;
    expect(realpathSync(plugin)).toBe(realpathSync(join(t.dataDir, "plugins", "tianshu-feishu")));
    expect(readdirSync(join(plugin, "skills"))).toEqual(["lark-doc"]);
    expect(realpathSync(join(plugin, "skills", "lark-doc"))).toBe(realpathSync(join(skills, "lark-doc")));
    expect(argv).not.toContain("--disallowedTools"); // 名单里有联网搜索
    await kill(s.body.id);

    const t2 = await startTestRunner({ pickFolder: work, skillsDir: tempDir("tl-empty-") });
    const token2 = await pair(t2.port);
    await api(t2.port, token2, "POST", "/v1/folders/pick", {});
    const s2 = await api(t2.port, token2, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c4" }, title: "x", cwd: work, firstMessage: "hi", role: role("写稿人", ["feishu"]) });
    const argv2: string[] = trace(work).at(-1).argv;
    expect(argv2).not.toContain("--plugin-dir");
    expect(readFileSync(after(argv2, "--append-system-prompt-file")!, "utf8")).toContain("没找到飞书技能");
    await api(t2.port, token2, "POST", `/v1/sessions/${s2.body.id}/kill`, {});
    await t2.cleanup();
  });

  it("专题带挑刺岗位：每个挑刺岗位是一个只读子 agent；评审会那句话点名它们和最近一版；卡不收挑刺岗位、不能开评审会", async () => {
    const critics = [role("反方", ["web_search"]), role("读者视角")];
    const s = await api(t.port, token, "POST", "/v1/sessions", {
      subject: { kind: "topic", topicId: "t-review" }, title: "调研", firstMessage: "先出提纲", role: role("调研员", ["web_search"]), critics, versionBase: 1,
    });
    expect(s.status).toBe(200);
    const id = s.body.id as string;
    const argv: string[] = trace(s.body.cwd).at(-1).argv;
    const agents = JSON.parse(readFileSync(after(argv, "--agents")!, "utf8"));
    expect(Object.keys(agents)).toEqual(["critic-1", "critic-2"]);
    expect(agents["critic-1"].description).toContain("反方");
    expect(agents["critic-1"].prompt).toContain("反方的验收口径：有证据");
    expect(agents["critic-1"].tools).toEqual(["Read", "Grep", "Glob"]); // 没关联云端：没有天枢的搜索可给
    expect(readFileSync(after(argv, "--append-system-prompt-file")!, "utf8")).toContain("critic-2：读者视角");

    // 存一版，再开评审会：本机替本人说的那句话点名挑刺子 agent 和这一版
    const secret = JSON.parse(readFileSync(join(t.dataDir, "sessions", id, "session.json"), "utf8")).mcpSecret;
    writeFileSync(join(s.body.cwd, "初稿.md"), "# 初稿");
    const rpc = await fetch(`http://127.0.0.1:${t.port}/internal/sessions/${id}/mcp`, {
      method: "POST", headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "save_version", arguments: { path: "初稿.md", kind: "draft" } } }),
    });
    expect((await rpc.json()).result.content[0].text).toBe("已存第 2 版");
    await until(async () => (await api(t.port, token, "GET", `/v1/sessions/${id}`)).body.session.status !== "starting");
    expect((await api(t.port, token, "POST", `/v1/sessions/${id}/messages`, { kind: "review", text: "重点看数据来源" })).status).toBe(200);
    const events = readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const said = events.filter((e) => e.type === "user_message").at(-1).text as string;
    for (const text of ["critic-1（反方）", "critic-2（读者视角）", "第 2 版（文件 初稿.md）", "save_version（kind=review）", "本人补充：重点看数据来源"]) expect(said).toContain(text);
    await kill(id);

    const card = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c5" }, title: "x", cwd: work, firstMessage: "hi", critics });
    expect(card.status).toBe(400);
    const plain = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c6" }, title: "x", cwd: work, firstMessage: "hi" });
    expect((await api(t.port, token, "POST", `/v1/sessions/${plain.body.id}/messages`, { kind: "review" })).status).toBe(400);
    expect((await api(t.port, token, "POST", `/v1/sessions/${plain.body.id}/messages`, {})).status).toBe(400);
    await kill(plain.body.id);
  });
});
