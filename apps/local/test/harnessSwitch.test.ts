// 子会话 Claude Code ↔ Codex 双向换（设计 17.2 第 38 条下面，契约 LocalSessionModelRequest「换执行方」）：
// 假 claude（fixtures/fake-claude.mjs）和假 codex（fixtures/fake-codex.mjs），不起本人电脑上真装的、不调模型。
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalSessionEvent, LocalSessionModelResponse } from "@warmap/contracts";
import { registerFormats } from "../src/store.js";
import { codexProfileId } from "../src/codexCatalog.js";
import { earlierTurns, handoffText, turnsOf } from "../src/handoff.js";
import { api, gitRepo, pair, raw, startTestRunner, tempDir } from "./helpers.js";

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
const CLAUDE = "subscription";
const READ_TOOL = "tianshu-session 的 read_earlier_turns";

describe("轮次整理成字（不调模型）", () => {
  const at = "2026-11-10T00:00:00.000Z";
  const sessionId = "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10";
  let seq = 0;
  const ev = (body: Record<string, unknown>) => ({ seq: ++seq, at, sessionId, ...body }) as any;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  const turn = (i: number, agent = "claude-code") => [
    ev({ type: "user_message", text: `第 ${i} 句`, source: "web", messageId: sessionId }),
    ev({ type: "agent_info", agent, version: "1", model: null, permissionMode: null }),
    ev({ type: "tool_call", toolUseId: `t${i}`, name: "Bash", title: "运行 git status", input: {} }),
    ev({ type: "tool_result", toolUseId: `t${i}`, isError: i === 2, preview: i === 2 ? "fatal: not a git repository\n第二行" : "clean" }),
    ev({ type: "assistant_text", text: `答 ${i}` }),
    ev({ type: "turn_end", isError: false, text: `答 ${i}`, durationMs: 1, usage }),
  ];
  const events = [...Array.from({ length: 11 }, (_, i) => turn(i + 1)).flat(), ...turn(12, "codex")];

  it("一轮到 turn_end 为止：本人说的、执行方回的原样，工具调用一行一个（成了写 ok，出错带第一行）", () => {
    expect(events.every((e) => Value.Check(LocalSessionEvent, e))).toBe(true);
    const turns = turnsOf(events);
    expect(turns).toHaveLength(12);
    expect(turns[0]).toMatchObject({ n: 1, firstSeq: 1, agent: "claude-code", lines: ["本人：第 1 句", "· 运行 git status → ok", "Claude Code：答 1"] });
    expect(turns[1]!.lines[1]).toBe("· 运行 git status → 出错：fatal: not a git repository");
    expect(turns[11]).toMatchObject({ agent: "codex", lines: ["本人：第 12 句", "· 运行 git status → ok", "Codex：答 12"] });
  });

  it("接着做的交代：只带没看到的轮次里最近 8 轮，更早的指给 read_earlier_turns；附改动的文件；都看过就没有交代", () => {
    const all = handoffText(events, 0, ["a.ts", "b.ts"], READ_TOOL)!;
    expect(all).toContain("之前是 Claude Code、Codex 在做");
    expect(all).toContain("最近 8 轮");
    expect(all).toContain(`更早的用 ${READ_TOOL}（before=5）翻`);
    expect(all).not.toContain("— 第 4 轮");
    expect(all).toContain("— 第 5 轮（Claude Code） —\n本人：第 5 句\n· 运行 git status → ok\nClaude Code：答 5");
    expect(all).toContain("工作目录里有改动的文件（git）：a.ts、b.ts");
    // Claude Code 自己的对话到第 11 轮为止：换回来时只补 Codex 做的第 12 轮
    const back = handoffText(events, events.filter((e) => e.type === "turn_end" && e.seq < seq - 5).at(-1)!.seq, [], READ_TOOL)!;
    expect(back).toContain("之前是 Codex 在做");
    expect(back).toContain("最近 1 轮");
    expect(back).toContain("— 第 12 轮（Codex） —");
    expect(back).not.toContain("— 第 11 轮");
    expect(back).not.toContain("工作目录里有改动的文件");
    expect(back).not.toContain("read_earlier_turns"); // 没看到的都带上了
    expect(handoffText(events, seq, [], READ_TOOL)).toBeNull();
  });

  it("问答、交回、验收结论、没做完的原因各记一行；本人的话原样带（附件接上路径），执行方的一段话太长才截，一轮里工具调用太多只留最后 40 步", () => {
    const special = [
      ev({ type: "user_message", text: "长".repeat(5000), source: "web", messageId: sessionId }),
      ev({ type: "user_message", text: "", source: "web", messageId: sessionId, attachments: [{ name: "图.png", path: "C:/w/.tianshu/attachments/图.png", size: 10 }] }),
      ev({ type: "agent_info", agent: "claude-code", version: "1", model: null, permissionMode: null }),
      ev({ type: "assistant_text", text: "答".repeat(25_000) }),
      ...Array.from({ length: 45 }, (_, i) => ev({ type: "tool_call", toolUseId: `x${i}`, name: "Read", title: `读文件 f${i}`, input: {} })),
      ev({ type: "question", request: { requestId: "q1", questions: [{ question: "用哪个库？", header: "库", options: [{ label: "A", description: "" }, { label: "B", description: "" }], multiSelect: false }], askedAt: at } }),
      ev({ type: "question_resolved", requestId: "q1", choices: [["A"]], text: "要快" }),
      ev({ type: "handback", summary: "做完了", criteria: [], outputKeys: [] }),
      ev({ type: "verdict", handbackKey: "device:session:1", passed: false, summary: "第 2 条没证据", criteria: [], beyondScope: [], failStreak: 1, blocked: false, returnText: "验收没过" }),
      ev({ type: "turn_end", isError: true, text: null, durationMs: 1, usage, errorKind: "interrupted" }),
    ];
    expect(special.every((e) => Value.Check(LocalSessionEvent, e))).toBe(true);
    const [t] = turnsOf(special);
    expect(t!.lines.slice(0, 2)).toEqual([`本人：${"长".repeat(5000)}`, "本人：（附件：C:/w/.tianshu/attachments/图.png）"]);
    expect(t!.lines[2]).toBe(`Claude Code：${"答".repeat(20_000)}…（共 25000 字）`);
    expect(t!.lines.slice(3, 5)).toEqual(["（这里还有 5 步工具调用没列）", "· 读文件 f5"]);
    expect(t!.lines.filter((l) => l.startsWith("· "))).toHaveLength(40);
    expect(t!.lines.slice(-5)).toEqual(["Claude Code：（问本人）用哪个库？", "本人：（回答）A；要快", "（交回了：做完了）", "（验收没过：第 2 条没证据）", "（这一轮没做完：本人停下了）"]);
  });

  it("原来那家没做完就停了（强停、额度用完直接退出，没有 turn_end）：换执行方的地方断开，各算各的一轮，换回来时新的那家做的一轮不少", () => {
    const cut = [
      ev({ type: "user_message", text: "做到一半", source: "web", messageId: sessionId }),
      ev({ type: "agent_info", agent: "claude-code", version: "1", model: null, permissionMode: null }),
      ev({ type: "assistant_text", text: "开始做" }),
      ev({ type: "status", status: "exited", reason: "已强停" }),
    ];
    const seenByClaude = cut.at(-1)!.seq; // 换的那一刻 Claude Code 自己的对话看到这里
    const rest = [
      ev({ type: "notice", level: "info", code: "harness_changed", text: "换成 Codex · GPT-6.1-Sol" }),
      ev({ type: "user_message", text: "接着做", source: "web", messageId: sessionId }),
      ev({ type: "agent_info", agent: "codex", version: "1", model: null, permissionMode: null }),
      ev({ type: "assistant_text", text: "做完了" }),
      ev({ type: "turn_end", isError: false, text: "做完了", durationMs: 1, usage }),
    ];
    expect([...cut, ...rest].every((e) => Value.Check(LocalSessionEvent, e))).toBe(true);
    expect(turnsOf([...cut, ...rest]).map((t) => [t.n, t.agent, t.lines])).toEqual([
      [1, "claude-code", ["本人：做到一半", "Claude Code：开始做", "（这一轮没做完就停了）"]],
      [2, "codex", ["本人：接着做", "Codex：做完了"]],
    ]);
    const back = handoffText([...cut, ...rest], seenByClaude, [], READ_TOOL)!;
    expect(back).toContain("下面是你没看到的最近 1 轮");
    expect(back).toContain("— 第 2 轮（Codex） —\n本人：接着做\nCodex：做完了");
    expect(back).not.toContain("做到一半");
  });

  it("一次带的总字数有上限（约 4 万字）：装不下的留给 read_earlier_turns，最新那一轮再长也带", () => {
    const big = [1, 2, 3].flatMap((i) => [
      ev({ type: "user_message", text: `${i}`.repeat(15_000), source: "web", messageId: sessionId }),
      ev({ type: "turn_end", isError: false, text: null, durationMs: 1, usage }),
    ]);
    const brief = handoffText(big, 0, [], READ_TOOL)!;
    expect(brief).toContain("下面是你没看到的最近 2 轮");
    expect(brief).toContain(`更早的用 ${READ_TOOL}（before=2）翻`);
    expect(brief).toContain(`本人：${"3".repeat(15_000)}`);
    expect(earlierTurns(big, undefined, 8)).toContain("一共 3 轮，下面是第 2–3 轮。更早的带 before=2 再翻。");
    expect(earlierTurns(big, 2, 8)).toContain(`本人：${"1".repeat(15_000)}`);
    const huge = [ev({ type: "user_message", text: "大".repeat(20_000), source: "web", messageId: sessionId }), ev({ type: "assistant_text", text: "回".repeat(20_000) }), ev({ type: "assistant_text", text: "再回".repeat(10_000) })];
    expect(handoffText(huge, 0, [], READ_TOOL)).toContain(`再回再回`);
  });

  it("read_earlier_turns：从最近的往前翻，before 接着上一页，翻到头说没有了", () => {
    const first = earlierTurns(events, 5, 3);
    expect(first).toContain("一共 12 轮，下面是第 2–4 轮。更早的带 before=2 再翻。");
    expect(first).toContain("— 第 4 轮（Claude Code） —");
    expect(first).not.toContain("— 第 5 轮");
    expect(earlierTurns(events, 2, 3)).toContain("下面是第 1–1 轮。这就是最早的了。");
    expect(earlierTurns(events, 1, 3)).toBe("没有更早的轮次了。");
    expect(earlierTurns(events, undefined, undefined)).toContain("下面是第 5–12 轮");
  });
});

describe("子会话 Claude Code ↔ Codex 双向换", { timeout: 60_000 }, () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-hs-");
  const skills = tempDir("tl-hs-skills-");
  const dataDir = tempDir("tl-hs-data-");
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  /** 假 claude 的每次拉起（argv）和每一轮收到的话；假 codex 收到的请求。 */
  const claudeLaunches = (id: string) => lines(join(work, ".fake-claude-trace.jsonl")).filter((l) => l.argv?.includes(id));
  const claudeTurns = (id: string) => lines(join(work, ".fake-claude-turns.jsonl")).filter((l) => l.sid === id && l.turnText !== undefined).map((l) => l.turnText as string);
  const codexTrace = () => lines(join(dataDir, "codex", "trace.jsonl"));
  const codexTurns = (dir: string) => {
    // 假 codex 不记会话号：按工作目录认是哪个会话的进程，只看它最近一次拉起以后收到的 turn/start
    let out: string[] = [];
    let mine = false;
    for (const l of codexTrace()) {
      if (l.argv) { mine = l.cwd === dir; if (mine) out = []; }
      else if (mine && l.method === "turn/start") out.push((l.params.input as { text: string }[]).map((x) => x.text).join(""));
    }
    return out;
  };
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body;
  const events = (id: string) => lines(join(dataDir, "sessions", id, "events.jsonl"));
  const record = (id: string) => JSON.parse(readFileSync(join(dataDir, "sessions", id, "session.json"), "utf8"));
  const idle = (id: string) => until(async () => { const s = (await session(id)).session; return s.status === "idle" ? s : null; });
  const open = async (name: string, firstMessage: string, extra: Record<string, unknown> = {}) => {
    mkdirSync(join(work, name), { recursive: true });
    const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: name }, title: name, cwd: join(work, name), firstMessage, permissionMode: "auto", ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.id as string;
  };
  const say = async (id: string, text: string) => { expect((await call("POST", `/v1/sessions/${id}/messages`, { text })).status).toBe(200); };
  const setModel = async (id: string, modelProfileId: string) => {
    const r = await call("PUT", `/v1/sessions/${id}/model`, { modelProfileId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Value.Check(LocalSessionModelResponse, r.body)).toBe(true);
    return r.body;
  };
  const kill = (id: string) => call("POST", `/v1/sessions/${id}/kill`, {});
  const fake = (cfg: Record<string, unknown>) => writeFileSync(join(work, ".fake-claude.json"), JSON.stringify(cfg));

  beforeAll(async () => {
    // Codex 已经登录着（假 codex 看配置目录里的 auth.json）；本人装了一个飞书技能
    mkdirSync(join(dataDir, "codex"), { recursive: true });
    writeFileSync(join(dataDir, "codex", "auth.json"), "{}");
    mkdirSync(join(skills, "lark-doc"));
    writeFileSync(join(skills, "lark-doc", "SKILL.md"), "---\nname: lark-doc\n---\n飞书文档");
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    t = await startTestRunner({ dataDir, pickFolder: work, fetchImpl: offline, fakeCodex: true, skillsDir: skills });
    token = await pair(t.port);
    await call("POST", "/v1/folders/pick", {});
    fake({});
    await until(async () => (await call("GET", "/v1/models")).body.profiles.some((p: any) => p.id === SOL));
  });
  afterAll(() => t.cleanup());

  it("空着时 Claude Code 换成 Codex：当场生效，还是同一个会话和事件流；Codex 第一句前面带上最近几轮和改动的文件，两边挂的 MCP、工作规矩一样", async () => {
    // 专题、文件夹是 git 仓库（卡在仓库里会另开工作树）：两轮，各有一次改计划、一次写文件
    const dir = gitRepo(join(work, "T1"));
    const id = await open("T1", "记住数字 7", { subject: { kind: "topic", topicId: "t1" } });
    await idle(id);
    await say(id, "再写一遍");
    await until(() => claudeTurns(id).length === 2);
    await idle(id);
    const rulesBefore = readFileSync(join(dataDir, "sessions", id, "system.md"), "utf8");
    const seqBefore = (await session(id)).session.lastSeq as number;

    const r = await setModel(id, SOL);
    expect(r.applied).toBe("now");
    expect(r.session).toMatchObject({ id, agent: "codex", modelProfileId: SOL, modelLabel: "GPT-6.1-Sol", status: "idle", run: { harness: "codex", model: "gpt-6.1-sol", origin: { provider: "codex" } } });
    expect(r.session.pendingModel).toBeUndefined();
    // 本机记的「谁看到哪了」不进摘要
    expect(r.session.seen).toBeUndefined();
    expect(r.session.handoff).toBeUndefined();
    const notice = events(id).find((e) => e.type === "notice" && e.code === "harness_changed");
    expect(notice.text).toBe("换成 Codex · GPT-6.1-Sol · 思考 low");
    expect(notice.seq).toBeGreaterThan(seqBefore);
    expect(events(id).some((e) => e.type === "notice" && e.code === "model_changed")).toBe(false);
    // 重开不算停了：重开期间是启动中，起来了回到等你回复；云端的 status 带新的执行方和跑法
    expect(events(id).filter((e) => e.seq > seqBefore && e.type === "status").map((e) => e.status)).toEqual(["starting", "idle"]);
    const sent = (JSON.parse(readFileSync(join(dataDir, "outbox.json"), "utf8")).entries as { item: any }[]).map((e) => e.item).filter((i) => i.sessionId === id);
    expect(sent.filter((i) => i.type === "status").at(-1).data).toMatchObject({ status: "idle", agent: "codex", modelLabel: "GPT-6.1-Sol", run: { harness: "codex" } });
    expect(sent.some((i) => i.type === "status" && ["exited", "failed"].includes(i.data.status))).toBe(false);

    // Codex 起来了：新开它自己的线程；挂的是同一份 MCP，工作规矩是同一份文字
    const launch = await until(() => codexTrace().filter((l) => l.argv && l.cwd === dir).at(-1));
    const mcp = JSON.parse(readFileSync(join(dataDir, "sessions", id, "mcp.json"), "utf8")).mcpServers;
    expect(Object.keys(mcp)).toEqual(["tianshu-session"]);
    expect(launch.argv.join(" ")).toContain(`mcp_servers.tianshu-session.url="${mcp["tianshu-session"].url}"`);
    expect((claudeLaunches(id)[0].argv as string[]).some((a) => a.endsWith(join("sessions", id, "mcp.json")))).toBe(true);
    const started = await until(() => codexTrace().filter((l) => l.method === "thread/start" && l.params.cwd === dir).at(-1));
    expect(readFileSync(join(dataDir, "sessions", id, "system.md"), "utf8")).toBe(rulesBefore);
    expect(started.params.developerInstructions).toBe(`${rulesBefore.length} 字`);

    // 说一句：事件里是原话；给 Codex 的那句前面接着它没看到的两轮和改动的文件
    await say(id, "刚才让你记的数字是几");
    await until(() => codexTurns(dir).length === 1);
    await idle(id);
    const got = codexTurns(dir)[0]!;
    expect(got.endsWith("［以上是之前的经过。下面是现在要你做的］\n\n刚才让你记的数字是几")).toBe(true);
    expect(got).toContain("之前是 Claude Code 在做，现在换你接着做。下面是你没看到的最近 2 轮");
    expect(got).toContain("— 第 1 轮（Claude Code） —\n本人：记住数字 7\nClaude Code：收到：记住数字 7\n· 更新计划\n· 写文件 hello.txt → ok\nClaude Code：写好了");
    expect(got).toContain("— 第 2 轮（Claude Code） —\n本人：再写一遍");
    expect(got).toContain("工作目录里有改动的文件（git）：hello.txt");
    expect(got).not.toContain("read_earlier_turns"); // 两轮都带上了，没有更早的
    const ev = events(id);
    expect(ev.filter((e) => e.type === "user_message").map((e) => e.text)).toEqual(["记住数字 7", "再写一遍", "刚才让你记的数字是几"]);
    expect(ev.map((e) => e.seq)).toEqual(ev.map((_, i) => i + 1)); // 一条事件流，序号连着
    expect(ev.filter((e) => e.type === "agent_info").map((e) => e.agent)).toEqual(["claude-code", "claude-code", "codex"]);
    expect(ev.every((e) => e.sessionId === id)).toBe(true);
    await kill(id);
  });

  it("换回 Claude Code：用 --resume 续上它自己的会话，只补 Codex 做的那几轮；再换到 Codex 续上它自己的线程，只补之后的", async () => {
    const id = await open("B", "先做 B");
    await idle(id);
    await setModel(id, SOL);
    await say(id, "接着做");
    await until(() => codexTurns(join(work, "B")).length === 1);
    await idle(id);
    await say(id, "run Get-Content notes.txt"); // Codex 的第二句不带交代：假 codex 认得出是命令（读文件，自动档放行）
    await until(() => codexTurns(join(work, "B")).length === 2);
    await idle(id);
    expect(codexTurns(join(work, "B"))[1]).toBe("run Get-Content notes.txt");

    const back = await setModel(id, CLAUDE);
    expect(back.applied).toBe("now");
    expect(back.session).toMatchObject({ agent: "claude-code", modelProfileId: CLAUDE, run: { harness: "claude-code" } });
    expect(events(id).filter((e) => e.type === "notice" && e.code === "harness_changed").at(-1).text).toMatch(/^换成 Claude Code · /);
    await until(() => claudeLaunches(id).length === 2);
    const argv = claudeLaunches(id)[1].argv as string[];
    expect(argv[argv.indexOf("--resume") + 1]).toBe(id);
    expect(argv).not.toContain("--session-id");
    await say(id, "Codex 刚才回了什么");
    await until(() => claudeTurns(id).length === 2);
    await idle(id);
    const got = claudeTurns(id)[1]!;
    expect(got.endsWith("\n\nCodex 刚才回了什么")).toBe(true);
    // 它自己做的第 1 轮不再带：从 Codex 做的第 2 轮起
    expect(got).toMatch(/^［接着做］这件事之前是 Codex 在做，现在换你接着做。下面是你没看到的最近 2 轮[^\n]*\n\n— 第 2 轮（Codex） —\n本人：接着做\nCodex：echo: /);
    expect(got).toContain("— 第 3 轮（Codex） —\n本人：run Get-Content notes.txt\n· 运行 Get-Content notes.txt → ok\nCodex：done");

    // 再换到 Codex：续上原来的线程（thread/resume），只补 Claude Code 刚做的那一轮
    const thread = JSON.parse(readFileSync(join(dataDir, "codex-threads.json"), "utf8"))[id];
    await setModel(id, SOL);
    const resumed = await until(() => codexTrace().filter((l) => l.method === "thread/resume" && l.params.cwd === join(work, "B")).at(-1));
    expect(resumed.params.threadId).toBe(thread);
    await say(id, "接着");
    await until(() => codexTurns(join(work, "B")).length === 1);
    const again = codexTurns(join(work, "B"))[0]!;
    expect(again).toMatch(/下面是你没看到的最近 1 轮[^\n]*\n\n— 第 4 轮（Claude Code） —\n本人：Codex 刚才回了什么\n/);
    await idle(id);
    await kill(id);
  });

  it("正在跑一轮时换：回「这一轮做完后生效」，做完才停掉原来那家、拉起新的；两个方向都一样", async () => {
    const id = await open("C", "做 C", { permissionMode: "default" });
    const p = await until(async () => (await session(id)).pendingPermissions[0] ?? null); // 在等批准：这一轮还没完
    const later = await setModel(id, SOL);
    expect(later.applied).toBe("after_turn");
    expect(later.session).toMatchObject({ agent: "claude-code", modelProfileId: CLAUDE, pendingModel: { modelProfileId: SOL, modelLabel: "GPT-6.1-Sol" } });
    expect(codexTrace().some((l) => l.argv && l.cwd === join(work, "C"))).toBe(false);
    await call("POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(p.requestId)}`, { decision: "allow" });
    const s = await until(async () => { const x = (await session(id)).session; return x.agent === "codex" && x.status === "idle" ? x : null; });
    expect(s.pendingModel).toBeUndefined();
    await until(() => codexTrace().some((l) => l.method === "thread/start" && l.params.cwd === join(work, "C")));
    // Codex 跑着时换回去：也是等这一轮做完
    await say(id, "接着做");
    await idle(id);
    await say(id, "slow");
    await until(() => codexTurns(join(work, "C")).length === 2);
    await until(async () => (await session(id)).session.status === "running");
    const backLater = await setModel(id, CLAUDE);
    expect(backLater.applied).toBe("after_turn");
    expect(backLater.session).toMatchObject({ agent: "codex", pendingModel: { modelProfileId: CLAUDE } });
    expect(claudeLaunches(id)).toHaveLength(1);
    await call("POST", `/v1/sessions/${id}/interrupt`, {});
    await until(async () => { const x = (await session(id)).session; return x.agent === "claude-code" && x.status === "idle"; });
    await until(() => claudeLaunches(id).length === 2);
    expect(claudeLaunches(id)[1].argv).toContain("--resume");
    await kill(id);
  });

  it("Codex 起的会话换到 Claude Code：Claude Code 没有自己的会话，新开（--session-id）、带上 Codex 做的那几轮", async () => {
    const id = await open("D", "hi", { modelProfileId: SOL });
    await idle(id);
    expect((await setModel(id, CLAUDE)).applied).toBe("now");
    await until(() => claudeLaunches(id).length === 1);
    const argv = claudeLaunches(id)[0].argv as string[];
    expect(argv[argv.indexOf("--session-id") + 1]).toBe(id);
    expect(argv).not.toContain("--resume");
    await say(id, "接着");
    await until(() => claudeTurns(id).length === 1);
    expect(claudeTurns(id)[0]).toContain("— 第 1 轮（Codex） —\n本人：hi\nCodex：echo: hi");
    await idle(id);
    // 强停以后再说话：Claude Code 现在有自己的会话了，续上，不再带交代
    await kill(id);
    await until(async () => (await session(id)).session.status === "exited");
    await say(id, "还在吗");
    await until(() => claudeLaunches(id).length === 2);
    expect(claudeLaunches(id)[1].argv).toContain("--resume");
    await until(() => claudeTurns(id).length === 2);
    expect(claudeTurns(id)[1]).toBe("还在吗");
    await kill(id);
  });

  it("进程不在时换：当场生效，下次开起来就是新的那家；「先出计划」换到 Codex 改成「每次都问」；规划员不能换到 Codex", async () => {
    const id = await open("E", "做 E", { permissionMode: "plan" });
    await until(async () => (await session(id)).pendingPermissions[0] ?? null); // 计划在等批准
    await kill(id);
    await until(async () => (await session(id)).session.status === "exited");
    const r = await setModel(id, SOL);
    expect(r.applied).toBe("now");
    expect(r.session).toMatchObject({ agent: "codex", permissionMode: "default", status: "exited" });
    const ev = events(id);
    expect(ev.filter((e) => e.type === "permission_mode").at(-1)).toMatchObject({ mode: "default", by: "harness_changed" });
    expect(ev.every((e) => Value.Check(LocalSessionEvent, e))).toBe(true);
    await say(id, "接着做");
    const started = await until(() => codexTrace().filter((l) => l.method === "thread/start" && l.params.cwd === join(work, "E")).at(-1));
    expect(started.params.model).toBe("gpt-6.1-sol");
    await until(() => codexTurns(join(work, "E")).length === 1);
    // 强停的那一轮没有做完的记录：交代里自成一轮，写明没做完
    expect(codexTurns(join(work, "E"))[0]).toMatch(/— 第 1 轮（Claude Code） —\n本人：做 E\n[^]*\n（这一轮没做完就停了）\n\n［以上是之前的经过/);
    // 这句先记进事件流、再拉起：交代里不把它算成没看到的一轮（它就接在交代后面）
    expect(codexTurns(join(work, "E"))[0]).not.toContain("本人：接着做");
    await idle(id);
    // Codex 没有「先出计划」这一档，换回 Claude Code 也不会自己变回去
    expect((await call("PUT", `/v1/sessions/${id}/permission-mode`, { mode: "plan" })).status).toBe(400);
    // 换回 Claude Code：Codex 做的那一轮不和强停的那一轮混在一起，照样补给它
    expect((await setModel(id, CLAUDE)).session).toMatchObject({ agent: "claude-code", permissionMode: "default" });
    await say(id, "看看 Codex 做了什么");
    await until(() => claudeTurns(id).length === 2);
    expect(claudeTurns(id)[1]).toMatch(/下面是你没看到的最近 1 轮[^\n]*\n\n— 第 2 轮（Codex） —\n本人：接着做\n/);
    await kill(id);

    mkdirSync(join(work, "P"), { recursive: true });
    const plan = await call("POST", "/v1/sessions", { subject: { kind: "plan", projectId: "11111111-1111-4111-8111-111111111111" }, title: "拆", cwd: join(work, "P"), firstMessage: "拆" });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    const bad = await call("PUT", `/v1/sessions/${plan.body.id}/model`, { modelProfileId: SOL });
    expect([bad.status, bad.body.error.message]).toEqual([400, "规划员、验收员只能用 Claude Code"]);
    expect((await session(plan.body.id)).session.agent).toBe("claude-code");
    await kill(plan.body.id);
  });

  it("连着换两次、中间没说话：还没交代过的那家，它没看到的轮次一轮不少", async () => {
    const dir = join(work, "I");
    const id = await open("I", "先做 I"); // 第 1 轮 Claude Code
    await idle(id);
    await setModel(id, SOL);
    await say(id, "x1"); // 第 2 轮 Codex
    await until(() => codexTurns(dir).length === 1);
    await idle(id);
    await setModel(id, CLAUDE); // 换回去，没说话
    await setModel(id, SOL); // 又换到 Codex：它什么都没错过，续上自己的线程，不带交代
    await until(() => codexTrace().some((l) => l.method === "thread/resume" && l.params.cwd === dir));
    await say(id, "x2"); // 第 3 轮 Codex
    await until(() => codexTurns(dir).length === 1);
    expect(codexTurns(dir)[0]).toBe("x2");
    await idle(id);
    await setModel(id, CLAUDE);
    await say(id, "x3");
    await until(() => claudeTurns(id).length === 2);
    const got = claudeTurns(id)[1]!;
    expect(got).toMatch(/下面是你没看到的最近 2 轮[^\n]*\n\n— 第 2 轮（Codex） —\n本人：x1\n/);
    expect(got).toContain("— 第 3 轮（Codex） —\n本人：x2\nCodex：echo: x2");
    await idle(id);
    await kill(id);
  });

  it("刚说了一句、执行方还没报这一轮开始时换：不算两轮之间，这句话照常做完再换", async () => {
    const id = await open("H", "做 H");
    await idle(id);
    fake({ turnDelayMs: 500 });
    await say(id, "这句不能丢");
    const r = await setModel(id, SOL);
    expect(r.applied).toBe("after_turn");
    await until(() => claudeTurns(id).includes("这句不能丢"));
    fake({});
    await until(async () => { const x = (await session(id)).session; return x.agent === "codex" && x.status === "idle"; });
    expect(events(id).some((e) => e.type === "assistant_text" && e.text === "收到：这句不能丢")).toBe(true);
    await kill(id);
  });

  it("这一轮里插了一句、执行方收下了还没读，这一轮就做完了：等它读到的那一轮做完再换，这句不丢", async () => {
    const id = await open("J", "做 J", { permissionMode: "default" });
    const p1 = await until(async () => (await session(id)).pendingPermissions[0] ?? null);
    expect((await setModel(id, SOL)).applied).toBe("after_turn");
    fake({ holdInterjections: true }); // 插的话这一轮读不到，这一轮做完它自己成新的一轮
    await say(id, "插一句别丢");
    await until(() => events(id).some((e) => e.type === "receipt" && e.state === "delivered"));
    await call("POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(p1.requestId)}`, { decision: "allow" });
    // 第一轮做完了没有换：Claude Code 接着读到插的那句，开了第二轮
    const p2 = await until(async () => { const x = await session(id); const p = x.pendingPermissions[0]; return p && p.requestId !== p1.requestId ? p : null; });
    expect(claudeTurns(id)).toEqual(["做 J", "插一句别丢"]);
    expect((await session(id)).session).toMatchObject({ agent: "claude-code", pendingModel: { modelProfileId: SOL } });
    fake({});
    await call("POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(p2.requestId)}`, { decision: "allow" });
    await until(async () => { const x = (await session(id)).session; return x.agent === "codex" && x.status === "idle"; });
    await kill(id);
  });

  it("连着点两次（上一次换还没起来又换）：等上一次起来再换，最后停在后点的那个上，两次都当场生效", async () => {
    const id = await open("K", "做 K");
    await idle(id);
    const first = setModel(id, SOL);
    await new Promise((r) => setTimeout(r, 60)); // 第一次正在停原来那家、拉起 Codex
    const second = await setModel(id, CLAUDE);
    expect((await first).applied).toBe("now");
    expect(second.applied).toBe("now");
    expect(second.session).toMatchObject({ agent: "claude-code", modelProfileId: CLAUDE, status: "idle" });
    expect(second.session.pendingModel).toBeUndefined();
    expect(events(id).filter((e) => e.type === "notice" && e.code === "harness_changed").map((e) => (e.text as string).slice(0, 9))).toEqual(["换成 Codex ", "换成 Claude"]);
    await until(() => claudeLaunches(id).length === 2);
    await kill(id);
  });

  it("卡在工作树里做：交代里的改动文件算上开工以来已经提交的", async () => {
    gitRepo(join(work, "W"));
    const id = await open("W", "做 W");
    const s = await idle(id);
    expect(s.workspace).toMatchObject({ kind: "worktree" });
    const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=测试", "-c", "user.email=test@example.com", ...args], { cwd: s.workspace.path, windowsHide: true, stdio: "pipe" });
    g("add", "hello.txt");
    g("commit", "-q", "-m", "写了 hello");
    await setModel(id, SOL);
    await say(id, "接着");
    await until(() => codexTurns(s.cwd).length === 1);
    expect(codexTurns(s.cwd)[0]).toContain("工作目录里有改动的文件（git）：hello.txt");
    await idle(id);
    await kill(id);
  });

  it("本会话 MCP 的 read_earlier_turns：卡和专题有，预先放行；从事件记录里一页一页往前翻", async () => {
    const id = await open("G", "第一句");
    await idle(id);
    for (const text of ["第二句", "第三句"]) {
      const n = claudeTurns(id).length;
      await say(id, text);
      await until(() => claudeTurns(id).length === n + 1);
      await idle(id);
    }
    const secret = record(id).mcpSecret;
    let n = 0;
    const rpc = async (method: string, params?: unknown) => (await raw(t.port, {
      method: "POST", path: `/internal/sessions/${id}/mcp`, headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
    })).body;
    expect((await rpc("tools/list")).result.tools.map((x: any) => x.name)).toContain("read_earlier_turns");
    expect(claudeLaunches(id)[0].argv[claudeLaunches(id)[0].argv.indexOf("--allowedTools") + 1]).toContain("mcp__tianshu-session__read_earlier_turns");
    const read = async (args: unknown) => (await rpc("tools/call", { name: "read_earlier_turns", arguments: args })).result as { isError: boolean; content: { text: string }[] };
    const last = await read({ limit: 1 });
    expect(last.isError).toBe(false);
    expect(last.content[0]!.text).toContain("一共 3 轮，下面是第 3–3 轮。更早的带 before=3 再翻。");
    expect(last.content[0]!.text).toContain("本人：第三句");
    const earlier = (await read({ before: 3, limit: 5 })).content[0]!.text;
    expect(earlier).toContain("下面是第 1–2 轮。这就是最早的了。");
    expect(earlier).toContain("本人：第一句\nClaude Code：收到：第一句\n· 更新计划\n· 写文件 hello.txt → ok\nClaude Code：写好了");
    expect((await read({ before: 1 })).content[0]!.text).toBe("没有更早的轮次了。");
    await kill(id);
  });

  it("两边规矩一致：仓库里只有 CLAUDE.md 时它的内容也给 Codex，只有 AGENTS.md 时给 Claude Code，两份都有各读各的；本机不往仓库里写", async () => {
    const prompt = (id: string) => readFileSync(join(dataDir, "sessions", id, "system.md"), "utf8");
    mkdirSync(join(work, "R1"), { recursive: true });
    writeFileSync(join(work, "R1", "CLAUDE.md"), "仓库规矩：提交信息写中文 R1-RULE");
    const codex = await open("R1", "hi", { modelProfileId: SOL });
    await idle(codex);
    expect(prompt(codex)).toContain(`这个仓库的规矩写在 CLAUDE.md 里，照着做：\n\n仓库规矩：提交信息写中文 R1-RULE`);
    const started = codexTrace().filter((l) => l.method === "thread/start" && l.params.cwd === join(work, "R1")).at(-1);
    expect(started.params.developerInstructions).toBe(`${prompt(codex).length} 字`);
    expect(existsSync(join(work, "R1", "AGENTS.md"))).toBe(false);
    // 换成 Claude Code：它自己读 CLAUDE.md，不再重复给
    await setModel(codex, CLAUDE);
    await until(() => claudeLaunches(codex).length === 1);
    expect(prompt(codex)).not.toContain("R1-RULE");
    await kill(codex);

    mkdirSync(join(work, "R2"), { recursive: true });
    writeFileSync(join(work, "R2", "AGENTS.md"), "仓库规矩：先跑测试 R2-RULE");
    const claude = await open("R2", "hi");
    expect(prompt(claude)).toContain(`这个仓库的规矩写在 AGENTS.md 里，照着做：\n\n仓库规矩：先跑测试 R2-RULE`);
    writeFileSync(join(work, "R2", "CLAUDE.md"), "也有 CLAUDE.md");
    await idle(claude);
    await kill(claude);
    await until(async () => (await session(claude)).session.status === "exited");
    await say(claude, "接着");
    await until(() => claudeLaunches(claude).length === 2);
    expect(prompt(claude)).not.toContain("R2-RULE");
    await kill(claude);

    // 工作目录是仓库里的子文件夹、CLAUDE.md 在仓库根：Claude Code 自己往上读得到，Codex 的也给上
    gitRepo(join(work, "R3"));
    writeFileSync(join(work, "R3", "CLAUDE.md"), "仓库规矩：R3-ROOT-RULE");
    mkdirSync(join(work, "R3", "apps", "web"), { recursive: true });
    const sub = await call("POST", "/v1/sessions", { subject: { kind: "topic", topicId: "r3" }, title: "R3", cwd: join(work, "R3", "apps", "web"), firstMessage: "hi", modelProfileId: SOL, permissionMode: "auto" });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(prompt(sub.body.id)).toContain("仓库规矩：R3-ROOT-RULE");
    await idle(sub.body.id);
    await kill(sub.body.id);
  });

  it("技能要飞书：Codex 那边把本人的飞书技能链接进天枢专用的配置目录，提示词里说用 lark-* 技能", async () => {
    const role = { id: "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e12", name: "助理", kind: "worker", modelTier: "normal", version: 1, tools: ["feishu"], dutiesMd: "管飞书文档", practiceMd: "先看再改", acceptanceMd: "有链接" };
    const id = await open("S", "hi", { modelProfileId: SOL, role });
    await idle(id);
    expect(lstatSync(join(dataDir, "codex", "skills", "lark-doc")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dataDir, "codex", "skills", "lark-doc", "SKILL.md"), "utf8")).toContain("飞书文档");
    expect(readFileSync(join(dataDir, "sessions", id, "system.md"), "utf8")).toContain("飞书：用 lark-cli 命令行和飞书技能，以本人的飞书登录操作（用本人自己装的 lark-* 技能）");
    expect(existsSync(join(dataDir, "plugins", "tianshu-feishu"))).toBe(false); // Claude Code 的会话插件是另一条路，Codex 的会话不建
    await kill(id);
  });

  // 放在最后：这一条会把 Claude 的额度记成用完，之后再开的 Claude 会话都排着等
  it("停着等 Claude 额度时换成 Codex：不再等原来那家的额度，换完本机替本人说一句、自动接着做（进程在不在都一样），Codex 知道上一轮是额度用完停的", async () => {
    const id = await open("F", "做 F");
    const gone = await open("F2", "做 F2");
    await idle(id);
    await idle(gone);
    // F2 碰壁就退出（进程不在了），F 碰壁后进程还在
    fake({ usageLimit: { resetsAt: Math.floor(Date.now() / 1000) + 3600, exit: true } });
    await say(gone, "接着做 F2");
    await until(async () => { const s = (await session(gone)).session; return s.status === "exited" && s.hold; });
    fake({ usageLimit: { resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
    await say(id, "接着做 F");
    const held = await until(async () => { const s = (await session(id)).session; return s.hold ? s : null; });
    expect(held.hold.reason).toBe("usage_limit");
    fake({});
    const r = await setModel(id, SOL);
    expect(r.session.agent).toBe("codex");
    expect(r.session.hold).toBeUndefined();
    expect(events(id).filter((e) => e.type === "status" && e.hold).at(-1).seq).toBeLessThan(events(id).filter((e) => e.type === "notice" && e.code === "harness_changed").at(-1).seq);
    // 不用本人再说话：换完本机替本人说一句，前面带着交代
    await until(() => codexTurns(join(work, "F")).length === 1);
    const got = codexTurns(join(work, "F"))[0]!;
    expect(got).toContain("本人：接着做 F\nClaude Code：You've hit your limit · resets 3pm\n（这一轮没做完：额度用完了）");
    expect(got.endsWith("［以上是之前的经过。下面是现在要你做的］\n\n换了来源，接着把刚才没做完的做完。")).toBe(true);
    expect(events(id).filter((e) => e.type === "notice" && e.code === "usage_resumed").map((e) => e.text)).toEqual(["换了来源，接着做"]);
    expect(events(id).filter((e) => e.type === "user_message").map((e) => e.text)).toEqual(["做 F", "接着做 F"]); // 本机替本人说的不记成本人的话
    await idle(id);
    await kill(id);
    // 进程不在的那个：换完先拉起 Codex，再说那一句
    expect((await setModel(gone, SOL)).applied).toBe("now");
    await until(() => codexTurns(join(work, "F2")).length === 1);
    expect(codexTurns(join(work, "F2"))[0]!.endsWith("换了来源，接着把刚才没做完的做完。")).toBe(true);
    const s2 = await idle(gone);
    expect([s2.agent, s2.hold]).toEqual(["codex", undefined]);
    await kill(gone);
  });

  it("Claude 额度用完、排着等的新卡换成 Codex：不再等，直接用 Codex 开始", async () => {
    // 接着上一条：Claude 的额度还记着用完，新开的 Claude 卡排着等
    const id = await open("Q", "做 Q");
    expect((await session(id)).session).toMatchObject({ status: "queued", hold: { reason: "usage_limit" } });
    expect((await setModel(id, SOL)).applied).toBe("now");
    await until(() => codexTurns(join(work, "Q")).length === 1);
    expect(codexTurns(join(work, "Q"))[0]).toBe("做 Q"); // 之前没有做过的轮次，不带交代
    const s = await idle(id);
    expect(s.agent).toBe("codex");
    expect(s.hold).toBeUndefined();
    expect(claudeLaunches(id)).toHaveLength(0);
    await kill(id);
  });

  it("换到的那家额度也用完了：不接着做，照它的恢复时间接着等", async () => {
    const cx = await open("X", "limit", { modelProfileId: SOL }); // Codex 也碰壁：Codex 那枚记成用完
    await until(async () => (await session(cx)).session.hold);
    const id = await open("Q2", "做 Q2"); // Claude 的额度还记着用完：排着等
    expect((await session(id)).session).toMatchObject({ status: "queued", hold: { reason: "usage_limit" } });
    const r = await setModel(id, SOL);
    expect(r.session).toMatchObject({ agent: "codex", status: "queued", hold: { reason: "usage_limit" } });
    await new Promise((res) => setTimeout(res, 300));
    expect(codexTrace().some((l) => l.argv && l.cwd === join(work, "Q2"))).toBe(false);
    await kill(id);
    await kill(cx);
  });
});

describe("停着等预算时换了执行方", { timeout: 60_000 }, () => {
  it("等预算的换了来源不会自己接着做（预算是这件 Task 的，换来源不会变多）；加了预算才接着做，本机替本人说的那一句前面也带上交代", async () => {
    const work = tempDir("tl-hs-bud-");
    const dataDir = tempDir("tl-hs-bud-data-");
    mkdirSync(join(dataDir, "codex"), { recursive: true });
    writeFileSync(join(dataDir, "codex", "auth.json"), "{}");
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const t = await startTestRunner({ dataDir, pickFolder: work, fetchImpl: offline, fakeCodex: true, holdTiming: { resumeAfterMs: 200, pollMs: 60_000, budgetGraceMs: 300, budgetTickMs: 100 } });
    try {
      const token = await pair(t.port);
      const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
      await call("POST", "/v1/folders/pick", {});
      await until(async () => (await call("GET", "/v1/models")).body.profiles.some((p: any) => p.id === SOL));
      // 一轮要做很久、不理「做完这一步就停」：时长到了预算（0.0004 小时约 1.4 秒）被打断，停着等加预算
      writeFileSync(join(work, ".fake-claude.json"), JSON.stringify({ work: { ms: 10_000 }, ignoreStop: true }));
      mkdirSync(join(work, "A"));
      const budget = (hours: number) => ({ mode: "set", hours, weeklyPercent: null, money: null });
      const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "A" }, title: "A", cwd: join(work, "A"), firstMessage: "做 A", permissionMode: "auto", taskBudget: { taskId: "T-1", budget: budget(0.0004) } });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const id = r.body.id as string;
      await until(async () => { const s = (await call("GET", `/v1/sessions/${id}`)).body.session; return s.hold?.reason === "budget" && s.status === "idle"; });
      const swapped = await call("PUT", `/v1/sessions/${id}/model`, { modelProfileId: SOL });
      expect(swapped.body).toMatchObject({ applied: "now", session: { agent: "codex", status: "idle", hold: { reason: "budget" } } });
      await new Promise((res) => setTimeout(res, 400));
      expect(existsSync(join(dataDir, "codex", "trace.jsonl")) && readFileSync(join(dataDir, "codex", "trace.jsonl"), "utf8").includes('"turn/start"')).toBe(false);
      await call("PUT", "/v1/budgets", { taskId: "T-1", budget: budget(1) });
      const trace = () => readFileSync(join(dataDir, "codex", "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const turn = await until(() => trace().find((l) => l.method === "turn/start"));
      const text = (turn.params.input as { text: string }[]).map((x) => x.text).join("");
      expect(text).toContain("— 第 1 轮（Claude Code） —\n本人：做 A\nClaude Code：开始做：做 A");
      expect(text).toContain("（这一轮没做完：本人停下了）");
      expect(text.endsWith("［以上是之前的经过。下面是现在要你做的］\n\n预算加了，接着把刚才没做完的做完。")).toBe(true);
      await call("POST", `/v1/sessions/${id}/kill`, {});
    } finally {
      await t.cleanup();
    }
  });
});
