// 摸 Claude Code 2.1.318 的后台任务协议：用本机程序同样的参数起一个干净会话（订阅 haiku），让它开一条后台命令和一个子 agent，
// 本机这边对后台命令发 stop_task，把收到的每一行 stream-json 原样记下来。
// 用法：npx tsx N_background-probe.ts <空的临时目录> <记录.jsonl>
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { buildClaudeArgs, childEnv } from "../../../apps/local/src/agents/claudeEnv.ts";

const [cwd, out] = process.argv.slice(2);
writeFileSync(out!, "");
const log = (dir: string, o: unknown) => appendFileSync(out!, JSON.stringify({ t: Date.now(), dir, o }) + "\n");
const { args, env } = buildClaudeArgs({
  sessionId: randomUUID(), cwd: cwd!, resume: false, includePersonalConfig: false,
  model: { profileId: "probe", label: "订阅 · haiku", source: "subscription", model: "haiku", baseUrl: null, smallModel: null, apiKey: null, webSearch: true } as any,
  mcpConfigPath: null, mcpEnv: {}, allowedTools: [], disallowedTools: [], systemPromptPath: null, agentsPath: null, pluginDirs: [],
  allowedRoots: () => [cwd!], autoAllowRoot: null,
});
const child = spawn("C:/Users/10021/.local/bin/claude.exe", args, { cwd, env: childEnv(process.env, env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const send = (o: unknown) => { log("out", o); child.stdin.write(JSON.stringify(o) + "\n"); };
let buf = "";
let stopped = false;
let results = 0;
const done = (why: string) => { log("end", why); child.stdin.end(); setTimeout(() => process.exit(0), 3000); };
child.stdout.setEncoding("utf8").on("data", (d: string) => {
  buf += d;
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    log("in", ev);
    if (ev.type === "control_request" && ev.request?.subtype === "can_use_tool") {
      send({ type: "control_response", response: { subtype: "success", request_id: ev.request_id, response: { behavior: "allow", updatedInput: ev.request.input ?? {} } } });
    }
    // 后台命令一出现，过 2 秒由本机发 stop_task
    if (ev.type === "system" && ev.subtype === "task_started" && ev.task_type === "local_bash" && !stopped) {
      stopped = true;
      setTimeout(() => send({ type: "control_request", request_id: `h-stop-${randomUUID()}`, request: { subtype: "stop_task", task_id: ev.task_id } }), 2000);
    }
    if (ev.type === "result") {
      results += 1;
      // 第一轮结束后再等一会儿收后台任务的通知；它可能还会自己开一轮
      setTimeout(() => { if (results === 1) done("after first result + 20s"); }, 20_000);
      if (results >= 2) setTimeout(() => done("second result"), 5_000);
    }
  }
});
child.stderr.setEncoding("utf8").on("data", (d: string) => log("stderr", d));
child.on("exit", (code) => { log("exit", code); process.exit(0); });
setTimeout(() => done("timeout 180s"), 180_000);
send({ type: "control_request", request_id: "h-init", request: { subtype: "initialize" } });
send({
  type: "user", parent_tool_use_id: null, message: {
    role: "user",
    content: "两件事，做完就停：1）用 Bash 的 run_in_background 跑 `sleep 30`，不用等它；2）用 Agent 工具开一个子 agent，description 写「数文件」，让它列出当前目录有几个文件。子 agent 回来后告诉我数字就结束。",
  },
});
