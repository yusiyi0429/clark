// 假的 `claude`：按 Claude Code 2.1.318 的 stream-json 双向协议说话（形态取自 11/05 实测日志），用来测适配器。
// 每一轮：说一句 → 要写文件的权限 → 允许就写、拒绝就说被拒 → result。收到 interrupt 立即以 error_during_execution 结束这一轮。
// 子进程环境走白名单，测试变量传不进来，所以配置读工作目录里的 .fake-claude.json，argv 和环境变量名记进 .fake-claude-trace.jsonl。
// 工作目录里没有时往上找最近的一份（几张卡各用一个子文件夹时共用），记录也写在那儿。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const sid = argv.includes("--session-id") ? argv[argv.indexOf("--session-id") + 1] : argv[argv.indexOf("--resume") + 1];
let home = process.cwd();
while (!existsSync(join(home, ".fake-claude.json")) && dirname(home) !== home) home = dirname(home);
if (!existsSync(join(home, ".fake-claude.json"))) home = process.cwd();
// 测试中途会改写这份配置：正好读到写了一半的（空的、不完整的）就用上一次读到的
let lastCfg = {};
const readCfg = () => {
  if (!existsSync(join(home, ".fake-claude.json"))) return {};
  try { lastCfg = JSON.parse(readFileSync(join(home, ".fake-claude.json"), "utf8")); } catch { /* 写了一半 */ }
  return lastCfg;
};
const cfg = readCfg();
const TRACE = join(home, ".fake-claude-trace.jsonl");
/** 每一轮收到的话另记一份（不混进 trace：别的测试拿 trace 的最后一行当最近一次拉起）。 */
const TURNS = join(home, ".fake-claude-turns.jsonl");
appendFileSync(TRACE, JSON.stringify({ pid: process.pid, argv, envKeys: Object.keys(process.env), authToken: process.env.ANTHROPIC_AUTH_TOKEN ?? null, sessionSecret: process.env.TIANSHU_SESSION_SECRET ?? null, cloudToken: process.env.TIANSHU_CLOUD_TOKEN ?? null, maxRetries: process.env.CLAUDE_CODE_MAX_RETRIES ?? null, apiTimeout: process.env.API_TIMEOUT_MS ?? null }) + "\n");
// 每条助手消息带 id（一次请求一个，本机按它数这一轮发了几次请求）；碰壁、出错时补的那条没有
let msgSeq = 0;
const out = (o) => {
  if (o.type === "assistant" && o.message && !o.error && !o.message.id) o.message = { id: `msg_${process.pid}_${++msgSeq}`, model: "claude-haiku-5-5", ...o.message };
  // 配置 messageUsage：每条助手消息带这次请求的用量（真机每条都带；本机拿它估这一轮中间上下文用了多少）
  if (o.type === "assistant" && o.message && !o.error && readCfg().messageUsage) o.message.usage = readCfg().messageUsage;
  process.stdout.write(JSON.stringify(o) + "\n");
};
/** 碰壁：rate_limit_event rejected → 助手补一条 rate_limit / usage_limit_reached → 429 的 result（照社区复现和程序里的字符串）。plain429：只有 rate_limit 的别的 429。 */
function limitHit(limit) {
  const resetsAt = limit.resetsAt;
  if (!limit.plain429) out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour", utilization: 1, isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 1, resetsAt, status: "rejected" } } } });
  out({ type: "assistant", error: "rate_limit", ...(limit.plain429 ? {} : { api_error: "usage_limit_reached" }), message: { content: [{ type: "text", text: "You've hit your limit · resets 3pm" }] }, parent_tool_use_id: null });
  if (limit.exit) process.exit(1);
  out({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 3pm", api_error_status: 429, duration_ms: 5, usage: {}, model_usage_since_last_result: {} });
  turn = null;
}
const mode = cfg.mode ?? "normal";
/** 现在的权限模式：起的时候看 --permission-mode，跑着时 set_permission_mode 改。 */
let permMode = argv.includes("--permission-mode") ? argv[argv.indexOf("--permission-mode") + 1] : "default";
/**
 * system/init 报的模型：真的 Claude Code 报它实际用的那个。这里照 --model 的别名报那一版（opus → claude-opus-5-5），
 * 网关报 ANTHROPIC_MODEL 原样；配置 initModel 可以硬改（测「请求的和实际的对不上」），每轮现读。
 */
/** 跑着时 set_model 换上的（11/09 实测 2.1.318：别名回成完整的名字，之后每轮开头报它）。 */
let setModelTo = null;
const FULL_MODEL = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };
function initModel() {
  const live = readCfg();
  if (setModelTo) return setModelTo;
  if (live.initModel) return live.initModel;
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  const m = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : null;
  return m && /^(opus|sonnet|haiku)$/.test(m) ? `claude-${m}-5-5` : m ?? "claude-haiku-5-5";
}

let turn = null; // { permId, timer }
let turns = 0;

function startTurn(text) {
  turns += 1;
  if (mode === "auth") {
    out({ type: "system", subtype: "init", session_id: sid, model: initModel(), permissionMode: "default", claude_code_version: "2.1.318" });
    out({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] } });
    out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", duration_ms: 5, usage: {} });
    return;
  }
  out({ type: "system", subtype: "init", session_id: sid, model: initModel(), permissionMode: "default", claude_code_version: "2.1.318" });
  // 额度：每轮现读配置（测试中途改）。usageLimit 在时这一轮碰壁：rate_limit_event rejected → 助手报 rate_limit → 429 的 result（exit 时直接退出）；
  // 这一串照社区复现和 Claude Code 程序里的字符串，没真机复现过
  const live = readCfg();
  appendFileSync(TURNS, JSON.stringify({ turnText: text, sid }) + "\n");
  if (live.usageLimit) { limitHit(live.usageLimit); return; }
  if (live.rateInfo) out({ type: "rate_limit_event", rate_limit_info: live.rateInfo });
  if (live.balance) {
    // 网关余额不足：TokenHub 回 402（tokavi-tokenhub f31dd05），Claude Code 记成 billing_error
    out({ type: "assistant", error: "billing_error", message: { content: [{ type: "text", text: "API Error: 402 Insufficient wallet balance!" }] }, parent_tool_use_id: null });
    out({ type: "result", subtype: "success", is_error: true, result: 'API Error: 402 {"msg":"Insufficient wallet balance! balance must be higher than stop line."}', api_error_status: 402, duration_ms: 5, usage: {}, model_usage_since_last_result: {} });
    return;
  }
  if (live.work) {
    // 干活的一轮：不要权限，work.ms 后做完；中途收到「预算用完了…就停下」就提前收尾（ignoreStop 时不理，等本机打断）
    out({ type: "assistant", message: { content: [{ type: "text", text: `开始做：${text}` }] }, parent_tool_use_id: null });
    turn = { permId: null, work: true, timer: setTimeout(() => { out({ type: "assistant", message: { content: [{ type: "text", text: "做完了" }] }, parent_tool_use_id: null }); finish(true, "做完了"); }, live.work.ms ?? 200) };
    return;
  }
  if (live.stream && argv.includes("--include-partial-messages")) { streamTurn(text, live.stream); return; }
  if (mode === "gateway_down") {
    // 11/06 假网关实测：每次重试一条 api_retry，最后 result 是 success + is_error，拒连时没有 api_error_status。
    for (let a = 1; a <= 2; a++) out({ type: "system", subtype: "api_retry", attempt: a, max_retries: 2, retry_delay_ms: 500 * a, error_status: null, error: "unknown" });
    out({ type: "result", subtype: "success", is_error: true, result: "API Error: Connection refused (ECONNREFUSED)", api_error_status: null, duration_ms: 3200, usage: {} });
    return;
  }
  // 配置 compact：这一轮开头先压缩一次上下文（照 Claude Code 的 compact_boundary）
  if (live.compact) out({ type: "system", subtype: "compact_boundary", session_id: sid, compact_metadata: { trigger: "auto", pre_tokens: 190000 } });
  out({ type: "assistant", message: { content: [{ type: "text", text: `收到：${text}` }] }, parent_tool_use_id: null });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: `toolu_todo${turns}`, name: "TodoWrite", input: { todos: [{ content: "写文件", status: "in_progress" }] } }] }, parent_tool_use_id: null });
  if (readOnly) { void readOnlyTurn(); return; }
  // 配置里有 background：第一轮照 Claude Code 2.1.318 的样子开后台任务（11/07 真机抓的形状），这一轮马上结束，后台的接着跑
  if (cfg.background && turns === 1) { backgroundTurn(); return; }
  // 配置里有 ask：第一轮先用「问用户」（AskUserQuestion）问本人，收到回答就结束这一轮
  if (cfg.ask && turns === 1) {
    const input = { questions: cfg.ask };
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: `toolu_ask${turns}`, name: "AskUserQuestion", input }] }, parent_tool_use_id: null });
    turn = { permId: `ask-${turns}`, ask: true };
    out({ type: "control_request", request_id: turn.permId, request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input, tool_use_id: `toolu_ask${turns}` } });
    return;
  }
  // plan 模式（--permission-mode plan，或跑着时换成 plan）：先出计划、要 ExitPlanMode 的批准，批了才去写文件
  if (permMode === "plan") {
    const input = { plan: "1. 写 hello.txt" };
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: `toolu_plan${turns}`, name: "ExitPlanMode", input }] }, parent_tool_use_id: null });
    turn = { permId: `plan-${turns}`, plan: true };
    out({ type: "control_request", request_id: turn.permId, request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input, tool_use_id: `toolu_plan${turns}` } });
    return;
  }
  askWrite();
}
function askWrite() {
  // readPath：要读这个文件（测只读的步骤按哪个范围算）
  const file = cfg.readPath ?? cfg.writePath ?? "hello.txt";
  const tool = cfg.readPath ? "Read" : "Write";
  const input = cfg.readPath ? { file_path: file } : { file_path: file, content: "你好" };
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: `toolu_w${turns}`, name: tool, input }] }, parent_tool_use_id: null });
  const permId = `perm-${turns}`;
  turn = { permId };
  const suggestions = cfg.suggestions ?? [{ type: "setMode", mode: "acceptEdits", destination: "session" }];
  // cfg.bash（{ command, description }）：要的是跑一条命令的权限，入参带执行方写的那句 description（批准说人话，主循环第 64 条）
  const [askTool, askInput] = cfg.bash ? ["Bash", cfg.bash] : [tool, input];
  out({ type: "control_request", request_id: permId, request: { subtype: "can_use_tool", tool_name: askTool, input: askInput, permission_suggestions: suggestions, tool_use_id: `toolu_w${turns}` } });
}

// 只读会话（规划员、验收员）：和真 Claude Code 一样，--disallowedTools 里的 Write 根本不在工具里，不会来要写文件的权限。
// 这时假 claude 照会话 MCP 给的工具交东西：有 submit_verdict 就交 .fake-claude.json 的 verdict（verdictOnTurn 指定第几轮才交），有 propose_plan 就交 plan。
const disallowed = argv.includes("--disallowedTools") ? argv[argv.indexOf("--disallowedTools") + 1].split(",") : [];
const readOnly = disallowed.includes("Write");
async function sessionMcp(method, params) {
  const mcp = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")).mcpServers["tianshu-session"];
  const headers = { "content-type": "application/json", "x-tianshu-session-secret": process.env.TIANSHU_SESSION_SECRET ?? "" };
  const r = await fetch(mcp.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: turns, method, params }) });
  return (await r.json()).result;
}
async function readOnlyTurn() {
  turn = { permId: "read-only" };
  const tools = (await sessionMcp("tools/list")).tools.map((t) => t.name);
  const name = tools.includes("submit_verdict") ? "submit_verdict" : tools.includes("propose_plan") ? "propose_plan" : null;
  const args = name === "submit_verdict" ? cfg.verdict : name === "propose_plan" ? cfg.plan : null;
  const onTurn = name === "submit_verdict" ? cfg.verdictOnTurn ?? 1 : 1;
  let result = null;
  if (name && args && turns >= onTurn) {
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: `toolu_m${turns}`, name: `mcp__tianshu-session__${name}`, input: args }] }, parent_tool_use_id: null });
    result = await sessionMcp("tools/call", { name, arguments: args });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `toolu_m${turns}`, content: result.content, is_error: result.isError }] }, parent_tool_use_id: null });
  }
  appendFileSync(TRACE, JSON.stringify({ readOnlyTurn: sid, turn: turns, tools, called: result ? name : null, result }) + "\n");
  if (!turn) return; // 途中被停下，这一轮已经结束
  // 规划员的派活单被退回、要它先问本人（开拆前的检查，设计 18.11）：照 askOnReject 用「问用户」问，收到回答就结束这一轮
  if (result?.isError && cfg.askOnReject) {
    const input = { questions: cfg.askOnReject };
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: `toolu_ask${turns}`, name: "AskUserQuestion", input }] }, parent_tool_use_id: null });
    turn = { permId: `ask-${turns}`, ask: true };
    out({ type: "control_request", request_id: turn.permId, request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input, tool_use_id: `toolu_ask${turns}` } });
    return;
  }
  // 交完以后这一轮接下来的请求碰壁（现读配置）
  const after = readCfg().usageLimitAfterSubmit;
  if (result && after) { limitHit(after); return; }
  out({ type: "assistant", message: { content: [{ type: "text", text: result ? "交好了" : "看完了" }] }, parent_tool_use_id: null });
  finish(true, result ? "交好了" : "看完了");
}

// 后台任务：一条后台命令（不停就一直跑）、一个子 agent（cfg.agentMs 后跑完，跑完 Claude Code 自己再开一轮）；
// 再加一条前台跑完的命令和一个内部任务（ambient），这两个本机不该报。
const tasks = new Map();
const sys = (o) => out({ type: "system", ...o, uuid: `u-${Math.random()}`, session_id: sid });
function backgroundTurn() {
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_bg", name: "Bash", input: { command: "sleep 30", description: "后台等一会儿", run_in_background: true } }] }, parent_tool_use_id: null });
  sys({ subtype: "task_started", task_id: "bgtask1", tool_use_id: "toolu_bg", description: "后台等一会儿", is_backgrounded: true, task_type: "local_bash" });
  tasks.set("bgtask1", "toolu_bg");
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bg", content: "Command running in background with ID: bgtask1." }] }, parent_tool_use_id: null });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_ag", name: "Agent", input: { description: "数文件", prompt: "数一下", subagent_type: "Explore" } }] }, parent_tool_use_id: null });
  sys({ subtype: "task_started", task_id: "agent1", tool_use_id: "toolu_ag", description: "数文件", subagent_type: "Explore", is_backgrounded: true, spawn_depth: 1, task_type: "local_agent" });
  tasks.set("agent1", "toolu_ag");
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_ag", content: "Async agent launched successfully." }] }, parent_tool_use_id: null });
  // 前台跑完的普通命令、内部任务：不算后台任务
  sys({ subtype: "task_started", task_id: "fg1", tool_use_id: "toolu_fg", description: "前台命令", is_backgrounded: false, task_type: "local_bash" });
  sys({ subtype: "task_updated", task_id: "fg1", patch: { status: "completed", end_time: Date.now() } });
  sys({ subtype: "task_started", task_id: "amb1", description: "内部", task_type: "dream", ambient: true });
  if (cfg.moreTasks) {
    // 先在前台跑、后来移到后台的命令（从那时起算后台任务），后来失败了。
    // 真机结束时 task_updated 和 task_notification 都发；这里 fg2 只发前一种、fg3 只发后一种，两条路各自测到。
    sys({ subtype: "task_started", task_id: "fg2", tool_use_id: "toolu_fg2", description: "", is_backgrounded: false, task_type: "local_bash" });
    sys({ subtype: "task_updated", task_id: "fg2", patch: { is_backgrounded: true } });
    sys({ subtype: "task_updated", task_id: "fg2", patch: { status: "failed", end_time: Date.now(), error: "exit 1" } });
    sys({ subtype: "task_started", task_id: "fg3", tool_use_id: "toolu_fg3", description: "跑测试", is_backgrounded: true, task_type: "local_bash" });
    sys({ subtype: "task_notification", task_id: "fg3", status: "completed", output_file: "", summary: "" });
  }
  // 后台子 agent 来要权限（agent_id 就是它的 task_id），批了它才跑完。subagentAsks 定它什么时候来：
  // after 主轮结束后几十毫秒（11/07 真机抓到的顺序）；before 主轮结束前；question 主轮结束前，之后主轮又问本人。
  const agentAsks = () => out({ type: "control_request", request_id: "perm-agent1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, agent_id: "agent1", tool_use_id: "toolu_ag_ls" } });
  if (cfg.subagentAsks === "question") {
    agentAsks();
    const input = { questions: [{ question: "接着做吗？", header: "接着", multiSelect: false, options: [{ label: "做", description: "" }, { label: "不做", description: "" }] }] };
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_askbg", name: "AskUserQuestion", input }] }, parent_tool_use_id: null });
    turn = { permId: "ask-bg", ask: true };
    out({ type: "control_request", request_id: "ask-bg", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input, tool_use_id: "toolu_askbg" } });
    return;
  }
  if (cfg.subagentAsks === "before") agentAsks();
  out({ type: "assistant", message: { content: [{ type: "text", text: "两件都开了，在后台跑" }] }, parent_tool_use_id: null });
  finish(true, "两件都开了");
  if (cfg.subagentAsks === "after") setTimeout(agentAsks, 30);
  if (!cfg.subagentAsks) setTimeout(agentDone, cfg.agentMs ?? 300);
}
function agentDone() {
  {
    if (!tasks.has("agent1")) return;
    tasks.delete("agent1");
    sys({ subtype: "task_progress", task_id: "agent1", tool_use_id: "toolu_ag", description: "Running ls", usage: { total_tokens: 10, tool_uses: 1, duration_ms: 50 }, last_tool_name: "Bash" });
    sys({ subtype: "task_updated", task_id: "agent1", patch: { status: "completed", end_time: Date.now() } });
    sys({ subtype: "task_notification", task_id: "agent1", tool_use_id: "toolu_ag", status: "completed", output_file: "", summary: "2" });
    // 子 agent 跑完，Claude Code 自己开一轮
    turns += 1;
    out({ type: "system", subtype: "init", session_id: sid, model: initModel(), permissionMode: "default", claude_code_version: "2.1.318" });
    out({ type: "assistant", message: { content: [{ type: "text", text: "子 agent 回来了：2 个文件" }] }, parent_tool_use_id: null });
    finish(true, "子 agent 回来了");
  }
}

/** 带 uuid 的话的生命周期（照 Claude Code 2.1.318，11/08 实测）：queued 收下、started 放进对话。 */
const lifecycle = (id, state) => { if (id) out({ type: "command_lifecycle", command_uuid: id, state, uuid: `l-${Math.random()}`, session_id: sid }); };
/** holdInterjections：进行中插的话这一轮读不到，等这一轮结束自己成为新的一轮（真机里模型只在出字、中间没有工具时就是这样）。 */
const held = [];

/**
 * 逐字写的一轮（照 --include-partial-messages 的 stream_event）：先来思考的片段、子 agent 的片段（本机都不该报），
 * 再一个字一个字写正文（每 ms 毫秒一个字），写完来工具参数的片段，最后整段 assistant 和 result。
 * cut：正文写到一半就以出错结束，没有整段 assistant。
 */
function streamTurn(text, opt) {
  const ev = (event, parent = null) => out({ type: "stream_event", event, parent_tool_use_id: parent, session_id: sid });
  ev({ type: "message_start", message: { id: `msg_s${turns}`, role: "assistant", content: [] } });
  ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
  ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先想想" } });
  ev({ type: "content_block_stop", index: 0 });
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "toolu_sub");
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "子 agent 的字" } }, "toolu_sub");
  ev({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
  const full = `正在写：${text}`;
  const chars = [...full];
  let i = 0;
  const tick = () => {
    if (i < chars.length && !(opt.cut && i >= chars.length / 2)) {
      ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: chars[i++] } });
      turn = { permId: null, work: true, timer: setTimeout(tick, opt.ms ?? 5) };
      return;
    }
    if (opt.cut) { finish(false, "写到一半出错了"); return; }
    ev({ type: "content_block_stop", index: 1 });
    ev({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: `toolu_s${turns}`, name: "Write", input: {} } });
    ev({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"file_path":"a.txt"' } });
    ev({ type: "content_block_stop", index: 2 });
    out({ type: "assistant", message: { content: [{ type: "text", text: full }] }, parent_tool_use_id: null });
    finish(true, full);
  };
  tick();
}

function finish(ok, text) {
  out({ type: "result", subtype: ok ? "success" : "error_during_execution", is_error: !ok, result: text, duration_ms: 12, total_cost_usd: 0.01 * turns,
    usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 11, iterations: [] },
    model_usage_since_last_result: cfg.modelUsage ?? { "claude-haiku-5-5": { costUSD: 0.01 } } });
  turn = null;
  const next = held.shift();
  if (next) { lifecycle(next.id, "started"); startTurn(next.text); }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === "control_request" && msg.request.subtype === "initialize" && cfg.connectMcpOnInit && !msg.mcpChecked) {
    // 真 Claude Code 在启动时（握手回复之前）就连 MCP：照着连一次本会话 MCP，把结果记进 trace。
    const mcp = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")).mcpServers["tianshu-session"];
    const headers = { "content-type": "application/json", "x-tianshu-session-secret": process.env.TIANSHU_SESSION_SECRET ?? "" };
    fetch(mcp.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })
      .then(async (r) => ({ status: r.status, tools: r.ok ? (await r.json()).result.tools.map((t) => t.name) : null }), (e) => ({ status: String(e) }))
      .then((res) => { appendFileSync(TRACE, JSON.stringify({ mcpOnInit: res }) + "\n"); rl.emit("line", JSON.stringify({ ...msg, mcpChecked: true })); });
    return;
  }
  if (msg.type === "control_request" && msg.request.subtype === "initialize") {
    // 握手的回执：版本；配置里有 models 时带上模型列表（真机 2.1.318 每次都带，11/10 实测）
    const init = { type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { claude_code_version: cfg.version ?? "2.1.318", pid: process.pid, ...(cfg.models ? { models: cfg.models } : {}) } } };
    if (cfg.initDelayMs) { setTimeout(() => out(init), cfg.initDelayMs); return; }
    out(init);
  } else if (msg.type === "control_request" && msg.request.subtype === "get_usage") {
    // 读额度（11/07 实测 2.1.318 的形状，只留本机用到的字段）
    appendFileSync(TRACE, JSON.stringify({ getUsage: msg.request }) + "\n");
    const usage = cfg.usage ?? { subscription_type: "max", rate_limits: { limits: [
      { kind: "session", group: "session", percent: 12, severity: "normal", resets_at: "2026-11-07T10:00:00Z", scope: null, is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 40, severity: "normal", resets_at: "2026-11-12T00:00:00Z", scope: null, is_active: true },
      { kind: "weekly_scoped", group: "weekly", percent: 81, severity: "warning", resets_at: "2026-11-12T00:00:00Z", scope: { model: { display_name: "Opus" } }, is_active: true },
    ], extra_usage: { is_enabled: false } }, account: { email: "someone@example.com", organization: "Org" } };
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: usage } });
  } else if (msg.type === "control_request" && msg.request.subtype === "get_context_usage") {
    // 上下文用了多少（11/10 实测 2.1.318 的形状，只留本机用到的字段）：配置 context 可改（false 是老版本、不认这个请求），默认每轮涨一点
    const c = readCfg().context;
    if (c === false) { out({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "Unsupported control request subtype: get_context_usage" } }); return; }
    const usage = c ?? { totalTokens: 18000 + 1000 * turns, maxTokens: 200000 };
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { ...usage, percentage: Math.round((usage.totalTokens / usage.maxTokens) * 100), model: initModel() } } });
  } else if (msg.type === "control_request" && msg.request.subtype === "stop_task") {
    const id = msg.request.task_id;
    appendFileSync(TRACE, JSON.stringify({ stopTask: id }) + "\n");
    if (!tasks.has(id)) {
      out({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: `no task ${id}` } });
      return;
    }
    tasks.delete(id);
    sys({ subtype: "task_updated", task_id: id, patch: { status: "killed", end_time: Date.now() } });
    sys({ subtype: "task_notification", task_id: id, status: "stopped", output_file: "", summary: "" });
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } });
  } else if (msg.type === "control_request" && msg.request.subtype === "set_model") {
    setModelTo = FULL_MODEL[msg.request.model] ?? msg.request.model;
    appendFileSync(TRACE, JSON.stringify({ setModel: msg.request.model, pid: process.pid }) + "\n");
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { model: setModelTo } } });
  } else if (msg.type === "control_request" && msg.request.subtype === "set_permission_mode") {
    // 跑着时换权限模式（11/08 实测 2.1.318 收 auto、default、acceptEdits、plan、dontAsk）：记进 trace
    permMode = msg.request.mode;
    appendFileSync(TRACE, JSON.stringify({ setPermissionMode: msg.request.mode, sid }) + "\n");
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { mode: msg.request.mode } } });
  } else if (msg.type === "control_request" && msg.request.subtype === "apply_flag_settings") {
    // 跑着时改设置（多 agent 开关）：记进 trace
    appendFileSync(TRACE, JSON.stringify({ applyFlags: msg.request.settings, sid }) + "\n");
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
  } else if (msg.type === "control_request" && msg.request.subtype === "interrupt") {
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { still_queued: [] } } });
    if (turn?.timer) clearTimeout(turn.timer);
    if (turn) {
      out({ type: "control_cancel_request", request_id: turn.permId });
      finish(false, "");
    }
  } else if (msg.type === "control_response" && msg.response.request_id === "perm-agent1") {
    appendFileSync(TRACE, JSON.stringify({ subagentPermission: msg.response.response }) + "\n");
    if (msg.response.response?.behavior === "allow" && cfg.subagentAsks !== "question") agentDone();
  } else if (msg.type === "control_response") {
    const r = msg.response.response;
    if (!turn || msg.response.request_id !== turn.permId) return;
    appendFileSync(TRACE, JSON.stringify({ permissionResponse: r }) + "\n");
    if (turn.plan) {
      // 计划批了：出 plan 接着做（要写文件）；拒了：这一轮停下，等本人说怎么改
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `toolu_plan${turns}`, content: r.behavior === "allow" ? "User has approved your plan" : r.message, is_error: r.behavior !== "allow" }] }, parent_tool_use_id: null });
      if (r.behavior === "allow") { permMode = "default"; askWrite(); } else finish(true, "等你说怎么改计划");
      return;
    }
    if (turn.ask) {
      const answers = r.updatedInput?.answers ?? null;
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `toolu_ask${turns}`, content: `User has answered your questions: ${JSON.stringify(answers)}` }] }, parent_tool_use_id: null });
      out({ type: "assistant", message: { content: [{ type: "text", text: `收到回答：${JSON.stringify(answers)}` }] }, parent_tool_use_id: null });
      finish(true, "收到回答");
      return;
    }
    if (r.behavior === "allow") {
      // 批了以后这一轮里才报额度变化（跑着的卡途中碰到）：现读配置
      const late = readCfg().rateInfoOnAllow;
      if (late) out({ type: "rate_limit_event", rate_limit_info: late });
      if (!cfg.writePath && !cfg.readPath) writeFileSync("hello.txt", "你好");
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `toolu_w${turns}`, content: "File created successfully" }] }, parent_tool_use_id: null });
      out({ type: "assistant", message: { content: [{ type: "text", text: r.updatedPermissions ? "写好了（本会话都允许）" : "写好了" }] }, parent_tool_use_id: null });
      finish(true, "写好了");
    } else {
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `toolu_w${turns}`, content: r.message, is_error: true }] }, parent_tool_use_id: null });
      out({ type: "assistant", message: { content: [{ type: "text", text: `被拒了：${r.message}` }] }, parent_tool_use_id: null });
      finish(true, "被拒了");
    }
  } else if (msg.type === "user") {
    lifecycle(msg.uuid, "queued");
    if (turn && readCfg().holdInterjections) { held.push({ id: msg.uuid, text: msg.message.content }); return; }
    lifecycle(msg.uuid, "started");
    if (turn) {
      // 进行中插话：下一个工具步骤之前读到。
      appendFileSync(TURNS, JSON.stringify({ interjection: msg.message.content, sid }) + "\n");
      out({ type: "assistant", message: { content: [{ type: "text", text: `插话收到：${msg.message.content}` }] }, parent_tool_use_id: null });
      if (turn.work && /预算用完了/.test(msg.message.content) && !readCfg().ignoreStop) {
        clearTimeout(turn.timer);
        turn.timer = setTimeout(() => { out({ type: "assistant", message: { content: [{ type: "text", text: "停下了，没做完的：收尾" }] }, parent_tool_use_id: null }); finish(true, "停下了"); }, 30);
      }
    } else if (readCfg().turnDelayMs) {
      // 收下了、过一会儿才开始这一轮（真机上收下一句话到报 system/init 之间有一小段）
      setTimeout(() => startTurn(msg.message.content), readCfg().turnDelayMs);
    } else {
      startTurn(msg.message.content);
    }
  }
});
rl.on("close", () => process.exit(0));
