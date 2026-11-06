// 假的 `claude`：按 Claude Code 2.1.318 的 stream-json 双向协议说话（形态取自 11/05 实测日志），用来测适配器。
// 每一轮：说一句 → 要写文件的权限 → 允许就写、拒绝就说被拒 → result。收到 interrupt 立即以 error_during_execution 结束这一轮。
// 子进程环境走白名单，测试变量传不进来，所以配置读工作目录里的 .fake-claude.json，argv 和环境变量名记进 .fake-claude-trace.jsonl。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const sid = argv[argv.indexOf("--session-id") + 1] ?? argv[argv.indexOf("--resume") + 1];
const cfg = existsSync(".fake-claude.json") ? JSON.parse(readFileSync(".fake-claude.json", "utf8")) : {};
appendFileSync(".fake-claude-trace.jsonl", JSON.stringify({ pid: process.pid, argv, envKeys: Object.keys(process.env), authToken: process.env.ANTHROPIC_AUTH_TOKEN ?? null, sessionSecret: process.env.TIANSHU_SESSION_SECRET ?? null, cloudToken: process.env.TIANSHU_CLOUD_TOKEN ?? null, maxRetries: process.env.CLAUDE_CODE_MAX_RETRIES ?? null, apiTimeout: process.env.API_TIMEOUT_MS ?? null }) + "\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const mode = cfg.mode ?? "normal";

let turn = null; // { permId, timer }
let turns = 0;

function startTurn(text) {
  turns += 1;
  if (mode === "auth") {
    out({ type: "system", subtype: "init", session_id: sid, model: "claude-haiku-5-5", permissionMode: "default", claude_code_version: "2.1.318" });
    out({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] } });
    out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", duration_ms: 5, usage: {} });
    return;
  }
  out({ type: "system", subtype: "init", session_id: sid, model: "claude-haiku-5-5", permissionMode: "default", claude_code_version: "2.1.318" });
  if (mode === "gateway_down") {
    // 11/06 假网关实测：每次重试一条 api_retry，最后 result 是 success + is_error，拒连时没有 api_error_status。
    for (let a = 1; a <= 2; a++) out({ type: "system", subtype: "api_retry", attempt: a, max_retries: 2, retry_delay_ms: 500 * a, error_status: null, error: "unknown" });
    out({ type: "result", subtype: "success", is_error: true, result: "API Error: Connection refused (ECONNREFUSED)", api_error_status: null, duration_ms: 3200, usage: {} });
    return;
  }
  out({ type: "assistant", message: { content: [{ type: "text", text: `收到：${text}` }] }, parent_tool_use_id: null });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: `toolu_todo${turns}`, name: "TodoWrite", input: { todos: [{ content: "写文件", status: "in_progress" }] } }] }, parent_tool_use_id: null });
  const file = cfg.writePath ?? "hello.txt";
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: `toolu_w${turns}`, name: "Write", input: { file_path: file, content: "你好" } }] }, parent_tool_use_id: null });
  const permId = `perm-${turns}`;
  turn = { permId };
  const suggestions = cfg.suggestions ?? [{ type: "setMode", mode: "acceptEdits", destination: "session" }];
  out({ type: "control_request", request_id: permId, request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: file, content: "你好" }, permission_suggestions: suggestions, tool_use_id: `toolu_w${turns}` } });
}

function finish(ok, text) {
  out({ type: "result", subtype: ok ? "success" : "error_during_execution", is_error: !ok, result: text, duration_ms: 12, total_cost_usd: 0.01 * turns,
    usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 11 },
    model_usage_since_last_result: { "claude-haiku-5-5": { costUSD: 0.01 } } });
  turn = null;
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
      .then((res) => { appendFileSync(".fake-claude-trace.jsonl", JSON.stringify({ mcpOnInit: res }) + "\n"); rl.emit("line", JSON.stringify({ ...msg, mcpChecked: true })); });
    return;
  }
  if (msg.type === "control_request" && msg.request.subtype === "initialize") {
    if (cfg.initDelayMs) { setTimeout(() => out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { claude_code_version: cfg.version ?? "2.1.318", pid: process.pid } } }), cfg.initDelayMs); return; }
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { claude_code_version: cfg.version ?? "2.1.318", pid: process.pid } } });
  } else if (msg.type === "control_request" && msg.request.subtype === "interrupt") {
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { still_queued: [] } } });
    if (turn) {
      out({ type: "control_cancel_request", request_id: turn.permId });
      finish(false, "");
    }
  } else if (msg.type === "control_response") {
    const r = msg.response.response;
    if (!turn || msg.response.request_id !== turn.permId) return;
    appendFileSync(".fake-claude-trace.jsonl", JSON.stringify({ permissionResponse: r }) + "\n");
    if (r.behavior === "allow") {
      if (!cfg.writePath) writeFileSync("hello.txt", "你好");
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `toolu_w${turns}`, content: "File created successfully" }] }, parent_tool_use_id: null });
      out({ type: "assistant", message: { content: [{ type: "text", text: r.updatedPermissions ? "写好了（本会话都允许）" : "写好了" }] }, parent_tool_use_id: null });
      finish(true, "写好了");
    } else {
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `toolu_w${turns}`, content: r.message, is_error: true }] }, parent_tool_use_id: null });
      out({ type: "assistant", message: { content: [{ type: "text", text: `被拒了：${r.message}` }] }, parent_tool_use_id: null });
      finish(true, "被拒了");
    }
  } else if (msg.type === "user") {
    if (turn) {
      // 进行中插话：下一个工具步骤之前读到。
      out({ type: "assistant", message: { content: [{ type: "text", text: `插话收到：${msg.message.content}` }] }, parent_tool_use_id: null });
    } else {
      startTurn(msg.message.content);
    }
  }
});
rl.on("close", () => process.exit(0));
