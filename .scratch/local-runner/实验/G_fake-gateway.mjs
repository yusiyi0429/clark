// 假网关 + 直接驱动真 claude（stream-json）。不调真模型。
// 用法：node run.mjs <配置 JSON 文件>
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = cfg.out;
mkdirSync(out, { recursive: true });
const log = [];
const L = (o) => { log.push({ t: Date.now() - t0, ...o }); };
const t0 = Date.now();
let reqN = 0;

function sse(res, blocks, stop) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const w = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  w("message_start", { type: "message_start", message: { id: `msg_${reqN}`, type: "message", role: "assistant", model: "fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  blocks.forEach((b, i) => {
    if (b.type === "text") {
      w("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      w("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text } });
    } else {
      w("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      w("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    w("content_block_stop", { type: "content_block_stop", index: i });
  });
  w("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  w("message_stop", { type: "message_stop" });
  res.end();
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    reqN++;
    const n = reqN;
    let j = {};
    try { j = JSON.parse(body); } catch {}
    writeFileSync(join(out, `req-${n}.json`), body);
    L({ ev: "gw_request", n, url: req.url, model: j.model, msgs: j.messages?.length });
    if (cfg.mode === "fail") { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "fake down" } })); return; }
    if (cfg.mode === "hang") return; // 不回
    if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 1 })); return; }
    if (j.model !== "fake-main") return sse(res, [{ type: "text", text: "ok" }], "end_turn");
    if (cfg.mode === "slow" || cfg.mode === "stall") {
      // 立刻回头和 message_start；slow：每 3 秒一段字，共 45 秒；stall：之后不再发任何东西。
      res.writeHead(200, { "content-type": "text/event-stream" });
      const w = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
      w("message_start", { type: "message_start", message: { id: `msg_${n}`, type: "message", role: "assistant", model: "fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
      w("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      if (cfg.mode === "stall") return;
      let k = 0;
      const iv = setInterval(() => {
        w("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `p${k} ` } });
        if (++k >= 15) {
          clearInterval(iv);
          w("content_block_stop", { type: "content_block_stop", index: 0 });
          w("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
          w("message_stop", { type: "message_stop" });
          res.end();
        }
      }, 3000);
      return;
    }
    const assistantCount = (j.messages ?? []).filter((m) => m.role === "assistant").length;
    const step = (cfg.script ?? [])[assistantCount];
    if (!step) return sse(res, [{ type: "text", text: "done" }], "end_turn");
    sse(res, [{ type: "tool_use", id: `toolu_${assistantCount}`, name: step.name, input: step.input }], "tool_use");
  });
});

server.listen(cfg.port ?? 0, "127.0.0.1", () => {
  const port = cfg.mode === "refused" ? 9 : server.address().port;
  const settings = { skipWebFetchPreflight: true, env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_MODEL: "fake-main", ANTHROPIC_DEFAULT_HAIKU_MODEL: "fake-small" }, ...(cfg.settings ?? {}) };
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--permission-mode", "manual", "--permission-prompts", "host", "--permission-prompt-tool", "stdio",
    "--session-id", crypto.randomUUID(), ...(cfg.personal ? [] : ["--setting-sources", "project,local", "--strict-mcp-config"]),
    "--settings", JSON.stringify(settings), ...(cfg.extraArgs ?? [])];
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE|MCP_|OTEL_)/i.test(k)));
  const env = { ...base, ...(cfg.env ?? {}), ANTHROPIC_AUTH_TOKEN: "fake", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
  const child = spawn(cfg.claude, args, { cwd: cfg.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  let buf = "";
  child.stdout.setEncoding("utf8").on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "control_request" && ev.request?.subtype === "can_use_tool") {
        L({ ev: "can_use_tool", tool: ev.request.tool_name, input: ev.request.input, suggestions: ev.request.permission_suggestions, tool_use_id: ev.request.tool_use_id, keys: Object.keys(ev.request), reason: ev.request.decision_reason, rtype: ev.request.decision_reason_type, blocked: ev.request.blocked_path, desc: ev.request.description, display: ev.request.display_name });
        const allow = (cfg.allow ?? []).includes(ev.request.tool_name);
        send({ type: "control_response", response: { subtype: "success", request_id: ev.request_id, response: allow ? { behavior: "allow", updatedInput: ev.request.input } : { behavior: "deny", message: "test deny" } } });
      } else if (ev.type === "control_request" && ev.request?.subtype === "hook_callback") {
        L({ ev: "hook_callback", id: ev.request.callback_id, tool: ev.request.input?.tool_name, input: ev.request.input?.tool_input, tool_use_id: ev.request.tool_use_id, keys: Object.keys(ev.request), reason: ev.request.decision_reason, rtype: ev.request.decision_reason_type, blocked: ev.request.blocked_path, desc: ev.request.description, display: ev.request.display_name });
        const r = cfg.hookResponse ? cfg.hookResponse : {};
        send({ type: "control_response", response: { subtype: "success", request_id: ev.request_id, response: r } });
      } else if (ev.type === "control_request") {
        L({ ev: "control_request_other", sub: ev.request?.subtype });
        send({ type: "control_response", response: { subtype: "error", request_id: ev.request_id, error: "unsupported" } });
      } else if (ev.type === "control_response") {
        L({ ev: "control_response", sub: ev.response?.subtype, err: ev.response?.error });
      } else if (ev.type === "system") {
        L({ ev: "system", sub: ev.subtype, ...(ev.subtype === "api_retry" ? { attempt: ev.attempt, max: ev.max_retries, delay: ev.retry_delay_ms, status: ev.error_status, error: ev.error, no_response: ev.no_response } : {}), ...(ev.subtype === "init" ? { tools: ev.tools } : {}) });
      } else if (ev.type === "user") {
        for (const c of ev.message?.content ?? []) if (c.type === "tool_result") L({ ev: "tool_result", id: c.tool_use_id, err: c.is_error, text: JSON.stringify(c.content).slice(0, 160) });
      } else if (ev.type === "result") {
        L({ ev: "result", sub: ev.subtype, is_error: ev.is_error, result: String(ev.result ?? "").slice(0, 300), api_error_status: ev.api_error_status });
        setTimeout(() => child.kill(), 300);
      } else if (ev.type === "assistant") {
        for (const c of ev.message?.content ?? []) L({ ev: "assistant", kind: c.type, name: c.name, text: c.text?.slice(0, 200), error: ev.error });
      }
    }
  });
  let err = "";
  child.stderr.setEncoding("utf8").on("data", (d) => (err += d));
  const init = { subtype: "initialize", ...(cfg.hooks ? { hooks: cfg.hooks } : {}) };
  send({ type: "control_request", request_id: "init-1", request: init });
  send({ type: "user", message: { role: "user", content: cfg.prompt ?? "go" }, parent_tool_use_id: null, session_id: "x" });
  const killer = setTimeout(() => { L({ ev: "timeout_kill" }); child.kill(); }, cfg.maxMs ?? 120000);
  child.on("exit", (code) => {
    clearTimeout(killer);
    L({ ev: "exit", code, stderr: err.slice(-800) });
    writeFileSync(join(out, "log.json"), JSON.stringify(log, null, 1));
    server.close();
    process.exit(0);
  });
});
