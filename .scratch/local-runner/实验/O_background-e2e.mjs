// 真 Claude Code（订阅 haiku）在卡的工作树里开一条后台命令和一个子 agent：本机报成后台任务，网页「停」后台命令，子 agent 跑完 Claude Code 自己再开一轮。
// 自带一个假天枢收同步（看 background 条目），本机程序数据目录 config.json 里要有 extraOrigins: ["http://127.0.0.1:<--cloud-port>"]。
// 用法：先起本机程序（--headless，TIANSHU_LOCAL_AUTO_APPROVE=1、TIANSHU_LOCAL_PICK_FOLDER=<一个 git 仓库>），再
//   node O_background-e2e.mjs --port 47674 --cloud-port 47692 --data-dir <本机程序数据目录> --out <结果.json>
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const port = Number(arg("--port", "47674"));
const cloudPort = Number(arg("--cloud-port", "47692"));
const out = arg("--out");
const origin = "https://tk.tokenkingos.com";
const base = `http://127.0.0.1:${port}`;
const t0 = Date.now();
const at = () => +((Date.now() - t0) / 1000).toFixed(1);
const log = [];
const say = (what, data) => { const e = { t: at(), what, ...(data ? { data } : {}) }; log.push(e); console.log(JSON.stringify(e)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const items = [];
const cloud = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  if (req.method === "POST" && req.url === "/api/local-runner/sync") {
    const b = JSON.parse(body);
    items.push(...b.items);
    for (const i of b.items.filter((x) => x.type === "background")) say("天枢收到后台任务", i.data);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ accepted: b.items.map((i) => i.key), rejected: [] }));
  }
  res.writeHead(404);
  res.end("{}");
});
await new Promise((r) => cloud.listen(cloudPort, "127.0.0.1", r));

let token = "";
async function api(method, path, body) {
  if (body === undefined && method !== "GET" && method !== "DELETE") body = {};
  const res = await fetch(base + path, {
    method,
    headers: { origin, ...(token ? { "x-tianshu-local-token": token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error?.message ?? ""}`);
  return json;
}

const p = await api("POST", "/v1/pairings", { clientLabel: "后台任务真跑" });
for (;;) {
  const s = await api("GET", `/v1/pairings/${p.pairingId}`);
  if (s.token) { token = s.token; break; }
  await sleep(300);
}
const work = (await api("POST", "/v1/folders/pick")).folder.path;
await api("PUT", "/v1/models/e2e-haiku", { label: "订阅 · haiku", source: "subscription", model: "haiku", isDefault: true });
await api("PUT", "/v1/cloud", { apiBaseUrl: `http://127.0.0.1:${cloudPort}`, token: "e2e-cloud-token-0123456789" });

const card = await api("POST", "/v1/sessions", {
  subject: { kind: "card", cardId: "bg-e2e" }, title: "后台任务真跑", cwd: work,
  firstMessage: "两件事：1）用 Bash 的 run_in_background 跑 `sleep 60`，不用等它；2）用 Agent 工具开一个子 agent，description 写「数文件」，数当前目录有几个文件。子 agent 回来后告诉我数字就结束，不用交回。",
});
say("开工", { status: card.status });

let stopped = null;
let final = null;
const perms = [];
for (const deadline = Date.now() + 240_000; Date.now() < deadline;) {
  const { session, pendingPermissions } = await api("GET", `/v1/sessions/${card.id}`);
  for (const r of pendingPermissions) {
    perms.push(r.title);
    await api("POST", `/v1/sessions/${card.id}/permissions/${encodeURIComponent(r.requestId)}`, { decision: "allow" });
  }
  const bash = (session.background ?? []).find((b) => b.kind === "command" && b.state === "running");
  if (bash && !stopped) {
    await sleep(1000);
    stopped = await api("POST", `/v1/sessions/${card.id}/background/${encodeURIComponent(bash.id)}/stop`, {});
    say("网页上点了停", stopped.session.background);
  }
  const agentDone = (session.background ?? []).some((b) => b.kind === "subagent" && b.state !== "running");
  if (stopped && agentDone && session.status === "idle") { final = session; break; }
  await sleep(1000);
}
await sleep(1500); // 等发件箱把最后几条送到

const evs = readFileSync(join(arg("--data-dir"), "sessions", card.id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const result = {
  run: "11/07，源码起的本机程序 + 真 Claude Code（订阅 haiku），临时 git 仓库，假天枢收同步",
  background: final?.background ?? null,
  backgroundEvents: evs.filter((e) => e.type === "background").map((e) => `${e.item.kind}:${e.item.title}:${e.item.state}`),
  syncedBackground: items.filter((i) => i.type === "background").map((i) => `${i.data.kind}:${i.data.title}:${i.data.state}`),
  statuses: evs.filter((e) => e.type === "status").map((e) => e.status),
  assistantText: evs.filter((e) => e.type === "assistant_text").map((e) => e.text.slice(0, 160)),
  toolCalls: evs.filter((e) => e.type === "tool_call").map((e) => e.name),
  permissionRequests: perms,
  finalStatus: final?.status ?? null,
  costUsd: final?.usage?.costUsd ?? null,
  log,
};
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, log: undefined }, null, 1));
process.exit(0);
