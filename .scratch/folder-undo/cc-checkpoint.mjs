// 做法 3 的实测：真的 Claude Code + 假的模型服务器（本机 127.0.0.1，不花 token、不连外网）。
// 剧本：主会话 读 A → 改 A → 用命令删 B → 开子 agent（读 C → 改 C）→ 说完成。本机在每个 can_use_tool 时先把要改的文件拷一份（做法 2）。
// 然后发 rewind_files，看 Claude Code 自带的检查点能恢复哪几个。用法：node cc-checkpoint.mjs <临时目录>
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const root = process.argv[2];
if (!root?.toLowerCase().includes("\\temp\\")) throw new Error("只在临时目录");
rmSync(root, { recursive: true, force: true });
const work = join(root, "文件夹"), cfg = join(root, "claude-config"), backup = join(root, "拷一份");
for (const d of [work, cfg, backup]) mkdirSync(d, { recursive: true });
const A = join(work, "A.md"), B = join(work, "B.md"), C = join(work, "C.md");
writeFileSync(A, "原文A\n"); writeFileSync(B, "原文B\n"); writeFileSync(C, "原文C\n");
const fwd = (p) => p.replace(/\\/g, "/");

// ---- 假模型 ----
const log = [];
function textOf(m) { return typeof m.content === "string" ? m.content : (m.content ?? []).map((b) => b.text ?? "").join(""); }
function plan(body) {
  const msgs = body.messages ?? [];
  const first = textOf(msgs.find((m) => m.role === "user") ?? {});
  const step = msgs.filter((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result")).length;
  const names = (body.tools ?? []).map((t) => t.name);
  const agentTool = names.includes("Agent") ? "Agent" : names.includes("Task") ? "Task" : null;
  if (first.includes("SUBMARK")) {
    return [["Read", { file_path: C }], ["Edit", { file_path: C, old_string: "原文C", new_string: "子agent改过C" }], null][step];
  }
  if (first.includes("MAINMARK")) {
    return [
      ["Read", { file_path: A }],
      ["Edit", { file_path: A, old_string: "原文A", new_string: "改过A" }],
      ["Bash", { command: `rm "${fwd(B)}"`, description: "删 B" }],
      agentTool ? [agentTool, { description: "改 C", prompt: "SUBMARK 改 C", subagent_type: "general-purpose" }] : null,
      null,
    ][step];
  }
  return null;
}
const sse = (res, events) => { res.writeHead(200, { "content-type": "text/event-stream" }); for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); res.end(); };
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 10, data: [] })); return; }
    const act = plan(body);
    log.push({ url: req.url, step: act?.[0] ?? "text", stream: body.stream });
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const block = act ? { type: "tool_use", id: `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`, name: act[0], input: act[1] } : { type: "text", text: "完成" };
    const msg = { id: `msg_${randomUUID().slice(0, 8)}`, type: "message", role: "assistant", model: body.model ?? "fake", content: [block], stop_reason: act ? "tool_use" : "end_turn", stop_sequence: null, usage };
    if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(msg)); return; }
    sse(res, [
      { type: "message_start", message: { ...msg, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: act ? { ...block, input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: act ? { type: "input_json_delta", partial_json: JSON.stringify(act[1]) } : { type: "text_delta", text: "完成" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// ---- 拉起 Claude Code（和本机程序一样：manual + stdio 批准） ----
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC)/i.test(k)) delete env[k];
Object.assign(env, {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "sk-ant-fake-local", CLAUDE_CONFIG_DIR: cfg,
  CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: process.env.NO_CP ? "" : "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
});
const sessionId = randomUUID();
const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "manual", "--permission-prompts", "host",
  "--permission-prompt-tool", "stdio", "--session-id", sessionId, "--setting-sources", "project,local", "--strict-mcp-config", "--replay-user-messages", "--model", "claude-sonnet-4-5"];
const child = spawn("C:\\Users\\10021\\.local\\bin\\claude.exe", args, { cwd: work, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const waiters = new Map();
let onResult = null;
const userUuids = [];
const asked = [];
let stderr = "";
child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
let buf = "";
child.stdout.setEncoding("utf8").on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "control_response") waiters.get(ev.response?.request_id)?.(ev.response);
    else if (ev.type === "control_request" && ev.request?.subtype === "can_use_tool") {
      const r = ev.request;
      const file = r.input?.file_path;
      // 做法 2：放行前把要改的已有文件拷一份
      let copied = null;
      if (file && ["Write", "Edit", "MultiEdit"].includes(r.tool_name) && existsSync(file)) {
        const t = performance.now(); copyFileSync(file, join(backup, `${asked.length}-${file.split(/[\\/]/).pop()}`)); copied = Math.round((performance.now() - t) * 10) / 10;
      }
      asked.push({ tool: r.tool_name, file: file ?? r.input?.command ?? r.input?.prompt, agentId: r.agent_id ?? r.parent_tool_use_id ?? null, copiedMs: copied });
      send({ type: "control_response", response: { subtype: "success", request_id: ev.request_id, response: { behavior: "allow", updatedInput: r.input } } });
    } else if (ev.type === "user" && ev.uuid && !ev.parent_tool_use_id && typeof ev.message?.content === "string") userUuids.push(ev.uuid);
    else if (ev.type === "result") onResult?.(ev);
  }
});
let n = 0;
const control = (request, ms = 60_000) => new Promise((res) => { const id = `h${++n}`; waiters.set(id, res); send({ type: "control_request", request_id: id, request }); setTimeout(() => res({ subtype: "timeout" }), ms); });

const out = { port };
const init = await control({ subtype: "initialize" });
out.version = init.response?.claude_code_version;
const myUuid = randomUUID();
const done = new Promise((r) => (onResult = r));
send({ type: "user", message: { role: "user", content: "MAINMARK 请按剧本做" }, uuid: myUuid, parent_tool_use_id: null, session_id: sessionId });
const result = await Promise.race([done, new Promise((r) => setTimeout(() => r({ subtype: "timeout" }), 120_000))]);
out.result = { subtype: result.subtype, is_error: result.is_error, text: String(result.result ?? "").slice(0, 200) };
// 子 agent 在后台跑：等它把 C 改掉（最多 60 秒），再等那一轮收尾
for (let i = 0; i < 120 && readFileSync(C, "utf8").includes("原文C"); i++) await new Promise((r) => setTimeout(r, 500));
out.cChangedBySubagent = !readFileSync(C, "utf8").includes("原文C");
await new Promise((r) => setTimeout(r, 4000));
out.asked = asked;
out.afterTurn = { A: existsSync(A) && readFileSync(A, "utf8").trim(), B: existsSync(B) ? readFileSync(B, "utf8").trim() : "（被删了）", C: existsSync(C) && readFileSync(C, "utf8").trim() };
out.userUuids = userUuids; out.sentUuid = myUuid;
const target = userUuids[0] ?? myUuid;
out.dryRun = await control({ subtype: "rewind_files", user_message_id: target, dry_run: true });
out.rewind = await control({ subtype: "rewind_files", user_message_id: target });
out.afterRewind = { A: existsSync(A) && readFileSync(A, "utf8").trim(), B: existsSync(B) ? readFileSync(B, "utf8").trim() : "（还是没有）", C: existsSync(C) && readFileSync(C, "utf8").trim() };
out.modelCalls = log;
out.stderr = stderr.slice(0, 500);
child.stdin.end(); setTimeout(() => child.kill(), 2000);
server.close();
console.log(JSON.stringify(out, null, 1));
setTimeout(() => process.exit(0), 2500);
