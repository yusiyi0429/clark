// 假的 codex app-server（形状照 codex-cli 0.159.2 的协议和 11/10 实测的消息顺序）：不调模型。
// 登录状态看 CODEX_HOME/auth.json；收到的命令行参数和请求记在 CODEX_HOME/trace.jsonl。
// 一轮里做什么看本人这一句话：
//   run <命令>        先报一条命令、来要批准，批了就「执行」
//   patch <文件>      新建一个文件（相对工作目录），来要批准
//   mcp <服务器> <工具> [ro]  调 MCP 工具；不是 ro 的来要批准（mcpServer/elicitation/request）
//   limit             额度用完（usageLimitExceeded），报额度 100%
//   slow              一直跑，等停下或插话（插话后回一句 heard: …）
//   compact           先压缩一次上下文（contextCompaction），再回一句
//   ctx <n>           这一次请求用了 n 个 token（上下文用了多少），再回一句
//   （thread/compact/start：单独压缩一次，压完这一次请求用了 2 万）
//   stream <话>       一个字一个字写出这句（item/agentMessage/delta）；streamcut 写到一半出错
//   别的              回一句 echo: <话>
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const home = process.env.CODEX_HOME ?? ".";
const trace = (o) => appendFileSync(join(home, "trace.jsonl"), `${JSON.stringify(o)}\n`);
trace({ argv: process.argv.slice(2), cwd: process.cwd(), env: { TIANSHU_SESSION_SECRET: Boolean(process.env.TIANSHU_SESSION_SECRET), OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null } });

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const note = (method, params) => out({ method, params });
let serverId = 0;
const waiting = new Map(); // 我们发出去的请求（批准）：id → 回调
const ask = (method, params) => new Promise((r) => { const id = serverId++; waiting.set(id, r); out({ id, method, params }); });

let thread = null;
let turn = null; // { id, cwd, done, steer: [] }
let n = 0;
let total = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
const soon = (h) => Math.floor(Date.now() / 1000) + h * 3600;
const loggedIn = () => existsSync(join(home, "auth.json"));
const item = (type, extra) => ({ type, id: `i${++n}`, ...extra });

async function runTurn(t, text, input, clientId) {
  note("turn/started", { threadId: thread, turn: { id: t.id, status: "inProgress" } });
  note("item/started", { item: item("userMessage", { clientId: clientId ?? null, content: input }) });
  const words = text.trim().split(/\s+/);
  const msg = async (s) => { const m = item("agentMessage", { text: "" }); note("item/started", { item: m }); note("item/agentMessage/delta", { itemId: m.id, delta: s }); note("item/completed", { item: { ...m, text: s } }); };
  // last 是最近一次请求的用量（本机拿它当上下文用了多少）：默认同累计的，ctx <n> 时是 n
  const usage = (lastTokens) => {
    total = { ...total, totalTokens: total.totalTokens + 15, inputTokens: total.inputTokens + 10, cachedInputTokens: total.cachedInputTokens + 4, outputTokens: total.outputTokens + 5 };
    note("thread/tokenUsage/updated", { threadId: thread, turnId: t.id, tokenUsage: { total, last: lastTokens ? { ...total, totalTokens: lastTokens } : total, modelContextWindow: 200000 } });
    note("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: soon(1) }, secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: soon(24) }, planType: "plus" } });
  };
  const finish = (status = "completed", error = null) => {
    if (t.done) return;
    t.done = true;
    turn = null;
    note("turn/completed", { threadId: thread, turn: { id: t.id, status, error, durationMs: 120 } });
  };
  if (words[0] === "run") {
    const command = text.trim().slice(4);
    const c = item("commandExecution", { command: `"pwsh.exe" -Command '${command}'`, cwd: t.cwd, status: "inProgress", commandActions: [{ type: "unknown", command }] });
    note("item/started", { item: c, threadId: thread, turnId: t.id });
    const r = await ask("item/commandExecution/requestApproval", { kind: "command", threadId: thread, turnId: t.id, itemId: c.id, reason: "要跑一下这条命令", command: c.command, cwd: t.cwd, commandActions: c.commandActions, availableDecisions: ["accept", "cancel"] });
    if (t.done) return;
    trace({ decision: r.decision, command });
    note("serverRequest/resolved", { threadId: thread, requestId: serverId - 1 });
    const ok = r.decision === "accept";
    note("item/completed", { item: { ...c, status: ok ? "completed" : "declined", exitCode: ok ? 0 : null, aggregatedOutput: ok ? "ok" : null }, threadId: thread, turnId: t.id });
    usage();
    await msg(ok ? "done" : "被拒了");
    return finish();
  }
  if (words[0] === "patch") {
    const path = resolve(t.cwd, words[1]);
    const f = item("fileChange", { changes: [{ path, kind: { type: "add" }, diff: "hello\n" }], status: "inProgress" });
    note("item/started", { item: f, threadId: thread, turnId: t.id });
    const r = await ask("item/fileChange/requestApproval", { threadId: thread, turnId: t.id, itemId: f.id, reason: null, grantRoot: null });
    if (t.done) return;
    trace({ decision: r.decision, path });
    const ok = r.decision === "accept" || r.decision === "acceptForSession";
    if (ok) writeFileSync(path, "hello\n");
    note("item/completed", { item: { ...f, status: ok ? "completed" : "declined" } });
    await msg(ok ? "patched" : "被拒了");
    return finish();
  }
  if (words[0] === "mcp") {
    const [, server, tool, ro] = words;
    const m = item("mcpToolCall", { server, tool, status: "inProgress", arguments: { q: 1 }, readOnlyHint: ro === "ro" });
    note("item/started", { item: m, threadId: thread, turnId: t.id });
    let ok = true;
    if (ro !== "ro") {
      const r = await ask("mcpServer/elicitation/request", { threadId: thread, turnId: t.id, serverName: server, mode: "form", _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_params: { q: 1 } }, message: `Allow the ${server} MCP server to run tool "${tool}"?`, requestedSchema: { type: "object", properties: {} } });
      if (t.done) return;
      trace({ elicitation: r.action, tool });
      ok = r.action === "accept";
    }
    note("item/completed", { item: { ...m, status: ok ? "completed" : "failed", result: ok ? { content: [{ type: "text", text: `did ${tool}` }] } : null, error: ok ? null : { message: "user rejected MCP tool call" } } });
    await msg(ok ? `called ${tool}` : "被拒了");
    return finish();
  }
  if (words[0] === "limit") {
    note("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: soon(1) }, planType: "plus" } });
    return finish("failed", { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded", additionalDetails: null });
  }
  if (words[0] === "slow") {
    note("turn/plan/updated", { threadId: thread, turnId: t.id, explanation: null, plan: [{ step: "看一看", status: "completed" }, { step: "慢慢做", status: "inProgress" }] });
    await new Promise((r) => { t.wake = r; setTimeout(r, 3_000); });
    if (t.done) return;
    for (const s of t.steer) {
      note("item/started", { item: item("userMessage", { clientId: s.id ?? null, content: [{ type: "text", text: s.text }] }) });
      await msg(`heard: ${s.text}`);
    }
    usage();
    return finish();
  }
  if (words[0] === "stream" || words[0] === "streamcut") {
    // 一个字一个字写（每 5 毫秒一个）；streamcut 写到一半这一轮出错结束，没有完整的那段
    const m = item("agentMessage", { text: "" });
    note("item/started", { item: m, threadId: thread, turnId: t.id });
    const chars = [...text.trim()];
    for (let i = 0; i < chars.length; i++) {
      if (words[0] === "streamcut" && i >= chars.length / 2) return finish("failed", { message: "写到一半出错了" });
      note("item/agentMessage/delta", { threadId: thread, turnId: t.id, itemId: m.id, delta: chars[i] });
      await new Promise((r) => setTimeout(r, 5));
    }
    note("item/completed", { item: { ...m, text: text.trim() }, threadId: thread, turnId: t.id });
    usage();
    return finish();
  }
  if (words[0] === "compact") {
    const c = item("contextCompaction", {});
    note("item/started", { item: c, threadId: thread, turnId: t.id });
    note("item/completed", { item: c, threadId: thread, turnId: t.id });
  }
  usage(words[0] === "ctx" ? Number(words[1]) : undefined);
  await msg(`echo: ${text}`);
  finish();
}

let buf = "";
process.stdin.setEncoding("utf8").on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === undefined) { waiting.get(m.id)?.(m.result ?? {}); waiting.delete(m.id); continue; }
    const p = m.params ?? {};
    const reply = (result) => out({ id: m.id, result });
    const fail = (message) => out({ id: m.id, error: { code: -32600, message } });
    if (m.id === undefined) continue; // 通知（initialized）
    trace({ method: m.method, params: m.method === "thread/start" || m.method === "thread/resume" ? { ...p, developerInstructions: p.developerInstructions ? `${p.developerInstructions.length} 字` : null } : p });
    switch (m.method) {
      case "initialize": reply({ userAgent: "tianshu_local/0.159.2 (fake)", codexHome: home }); break;
      case "account/read": reply(loggedIn() ? { account: { type: "chatgpt", email: "x@example.com", planType: "plus" }, requiresOpenaiAuth: true } : { account: null, requiresOpenaiAuth: true }); break;
      case "account/login/start":
        reply({ type: "chatgpt", loginId: "L1", authUrl: "https://auth.openai.com/oauth/authorize?fake=1" });
        setTimeout(() => { writeFileSync(join(home, "auth.json"), "{}"); note("account/login/completed", { loginId: "L1", success: true, error: null }); }, 50);
        break;
      case "account/login/cancel": reply({ status: "canceled" }); break;
      case "account/rateLimits/read": reply({ rateLimits: { limitId: "codex", primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: soon(1) }, secondary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: soon(24) }, planType: "plus" } }); break;
      case "model/list":
        reply({ data: [
          { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", hidden: false, isDefault: true, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((e) => ({ reasoningEffort: e, description: "" })), defaultReasoningEffort: "low" },
          { id: "gpt-5.5", model: "gpt-5.5", displayName: "GPT-5.5", hidden: false, isDefault: false, supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"].map((e) => ({ reasoningEffort: e, description: "" })), defaultReasoningEffort: "medium" },
          { id: "secret", model: "secret", displayName: "Hidden", hidden: true, isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: "low" },
        ], nextCursor: null });
        break;
      // 本人的技能：读 CODEX_HOME/fake-skills.json（[{ name, path, scope }]），没有就是空的
      case "skills/list": reply({ data: [{ cwd: (p.cwds ?? [])[0] ?? "", skills: existsSync(join(home, "fake-skills.json")) ? JSON.parse(readFileSync(join(home, "fake-skills.json"), "utf8")) : [], errors: [] }] }); break;
      case "thread/start": thread = `t-${Date.now()}`; reply({ thread: { id: thread }, model: p.model, modelProvider: "openai" }); break;
      case "thread/resume": thread = p.threadId; reply({ thread: { id: thread }, model: p.model, modelProvider: "openai" }); break;
      case "turn/start": {
        if (turn) { reply({ turn: { id: turn.id, status: "inProgress" } }); break; }
        const text = (p.input ?? []).map((x) => x.text ?? "").join("");
        turn = { id: `turn-${++n}`, cwd: process.cwd(), done: false, steer: [] };
        reply({ turn: { id: turn.id, status: "inProgress" } });
        void runTurn(turn, text, p.input, p.clientUserMessageId);
        break;
      }
      // 压缩上下文（0.170.0 的 thread/compact/start，回 {}）：照一轮的样子报 turn/started、contextCompaction、用量、turn/completed（不能插话）
      case "thread/compact/start": {
        if (turn) { fail("turn in progress"); break; }
        const t = { id: `turn-${++n}`, cwd: process.cwd(), done: false, steer: [] };
        turn = t;
        reply({});
        setTimeout(() => {
          note("turn/started", { threadId: thread, turn: { id: t.id, status: "inProgress" } });
          const c = item("contextCompaction", {});
          note("item/started", { item: c, threadId: thread, turnId: t.id });
          note("item/completed", { item: c, threadId: thread, turnId: t.id });
          total = { ...total, totalTokens: total.totalTokens + 15, inputTokens: total.inputTokens + 10, outputTokens: total.outputTokens + 5 };
          note("thread/tokenUsage/updated", { threadId: thread, turnId: t.id, tokenUsage: { total, last: { ...total, totalTokens: 20000 }, modelContextWindow: 200000 } });
          t.done = true;
          turn = null;
          note("turn/completed", { threadId: thread, turn: { id: t.id, status: "completed", error: null, durationMs: 80 } });
        }, 20);
        break;
      }
      case "turn/steer":
        if (!turn) { fail("no active turn to steer"); break; }
        if (p.expectedTurnId !== turn.id) { fail(`expected active turn id \`${p.expectedTurnId}\` but found \`${turn.id}\``); break; }
        turn.steer.push({ id: p.clientUserMessageId, text: (p.input ?? []).map((x) => x.text ?? "").join("") });
        reply({ turnId: turn.id });
        turn.wake?.();
        break;
      case "turn/interrupt": {
        reply({});
        const t = turn;
        if (!t) break;
        for (const id of waiting.keys()) note("serverRequest/resolved", { threadId: thread, requestId: id });
        waiting.clear();
        t.done = true;
        turn = null;
        note("turn/completed", { threadId: thread, turn: { id: t.id, status: "interrupted", error: null, durationMs: 50 } });
        t.wake?.();
        break;
      }
      default: fail(`unknown method ${m.method}`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
