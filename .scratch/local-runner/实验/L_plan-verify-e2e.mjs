// 拆卡和验收在本机真跑（V2 设计第 21 节）：规划员拆出 2 件 → 开工 → 执行方交回 → 本机自己起验收员 → 结论同步上去。会真的调用 Claude（haiku，提示词极短）。
// 本脚本自带一个假天枢（收同步、给验收交代、给 /mcp/me 的 get_task_context），本机程序的数据目录 config.json 里要有 extraOrigins: ["http://127.0.0.1:<--cloud-port>"]。
// 用法：先起本机程序（--headless，TIANSHU_LOCAL_AUTO_APPROVE=1、TIANSHU_LOCAL_PICK_FOLDER=<目录>），再
//   node L_plan-verify-e2e.mjs --port 47672 --cloud-port 47691 --out <结果.json>
import http from "node:http";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const port = Number(arg("--port", "47672"));
const cloudPort = Number(arg("--cloud-port", "47691"));
const out = arg("--out");
const origin = "https://tk.tokenkingos.com";
const cloudOrigin = `http://127.0.0.1:${cloudPort}`;
const base = `http://127.0.0.1:${port}`;
const t0 = Date.now();
const at = () => +((Date.now() - t0) / 1000).toFixed(1);
const log = [];
const say = (what, data) => { const e = { t: at(), what, ...(data ? { data } : {}) }; log.push(e); console.log(JSON.stringify(e)); };

const PLANNER = { id: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b", name: "规划员", kind: "worker", dutiesMd: "把 Task 拆成派活单", practiceMd: "", acceptanceMd: "", tools: ["tianshu"], modelTier: "light", version: 1 };
const WRITER = { id: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d", name: "写作员", kind: "worker", dutiesMd: "写文件", practiceMd: "", acceptanceMd: "文件要在", tools: ["tianshu"], modelTier: "light", version: 1 };
const REVIEWER = { id: "8a6f0f0e-1b2c-4d3e-9f40-5a6b7c8d9e0f", name: "验收员", kind: "reviewer", dutiesMd: "逐条判", practiceMd: "", acceptanceMd: "打开文件看内容", tools: ["tianshu"], modelTier: "light", version: 1 };

// ───────── 假天枢 ─────────
const items = [];
const briefs = [];
const mcpCalls = [];
const cards = new Map(); // cardId → 派活单里的那一件
const cloud = http.createServer(async (req, res) => {
  const url = new URL(req.url, cloudOrigin);
  let body = "";
  for await (const c of req) body += c;
  const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method === "POST" && url.pathname === "/api/local-runner/sync") {
    const b = JSON.parse(body);
    for (const i of b.items) items.push(i.type === "artifact" ? { ...i, data: { ...i.data, contentBase64: undefined, content: Buffer.from(i.data.contentBase64, "base64").toString("utf8").slice(0, 200) } } : i);
    say("天枢收到同步", { slots: b.slots, items: b.items.map((i) => `${i.subject.kind}:${i.type}${i.type === "status" ? `=${i.data.status}` : ""}`) });
    return json(200, { accepted: b.items.map((i) => i.key), rejected: [] });
  }
  if (req.method === "GET" && url.pathname === "/api/local-runner/verify-brief") {
    const key = url.searchParams.get("handbackKey");
    const hb = items.find((i) => i.key === key && i.type === "handback");
    const card = hb && cards.get(hb.subject.cardId);
    if (!hb || !card) return json(404, { error: "没有这次交回" });
    const criteria = card.doneDefinition.split("\n").map((s) => s.trim()).filter(Boolean);
    const outputs = hb.data.outputKeys.map((k) => items.find((i) => i.key === k)).filter(Boolean)
      .map((o) => (o.type === "artifact" ? `文件 ${o.data.fileName}` : `证据「${o.data.title}」`));
    const markdown = [
      `验收「${card.title}」。完成标准：`, ...criteria.map((c, i) => `${i + 1}. ${c}`),
      `交回：${hb.data.summary}；产出：${outputs.join("、") || "无"}（在当前目录）。`,
      "先试着在当前目录写 probe.txt，写不了就算了。",
    ].join("\n");
    briefs.push({ key, cardId: hb.subject.cardId, criteria });
    say("天枢给了验收交代", { cardId: hb.subject.cardId, criteria });
    return json(200, { markdown, criteria, role: REVIEWER, failStreak: 0 });
  }
  if (url.pathname === "/mcp/me") {
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    const msg = JSON.parse(body || "{}");
    if (msg.id === undefined || msg.id === null) { res.writeHead(202); return res.end(); }
    mcpCalls.push(`${msg.method}${msg.params?.name ? `:${msg.params.name}` : ""}`);
    const ok = (result) => json(200, { jsonrpc: "2.0", id: msg.id, result });
    if (msg.method === "initialize") return ok({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tianshu", version: "e2e" } });
    if (msg.method === "tools/list") return ok({ tools: [{ name: "get_task_context", description: "读 Task 的上下文（约定、Mission、近期的事）", inputSchema: { type: "object", properties: { taskId: { type: "string" } } }, annotations: { readOnlyHint: true } }] });
    if (msg.method === "tools/call") return ok({ content: [{ type: "text", text: "Task「问候文件」（cite:world:task-e2e@1）：约定 1 hello.md 含「你好」；约定 2 bye.md 含「再见」。" }], isError: false });
    return ok({});
  }
  json(404, {});
});
await new Promise((r) => cloud.listen(cloudPort, "127.0.0.1", r));

// ───────── 网页那一侧（本人在这台电脑上点） ─────────
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
async function events(id) {
  const res = await fetch(`${base}/v1/sessions/${id}/events`, { headers: { origin, "x-tianshu-local-token": token, "last-event-id": "0" } });
  const reader = res.body.getReader();
  let text = "";
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise((ok) => setTimeout(() => ok({ timeout: true }), 300))]);
    if (r.timeout || r.done) break;
    text += new TextDecoder().decode(r.value);
  }
  reader.cancel().catch(() => {});
  return text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
}

const p = await api("POST", "/v1/pairings", { clientLabel: "拆卡验收真跑" });
for (;;) {
  const s = await api("GET", `/v1/pairings/${p.pairingId}`);
  if (s.token) { token = s.token; break; }
  await new Promise((r) => setTimeout(r, 300));
}
const work = (await api("POST", "/v1/folders/pick")).folder.path;
await api("PUT", "/v1/models/e2e-haiku", { label: "订阅 · haiku", source: "subscription", model: "haiku", isDefault: true });
await api("PATCH", "/v1/settings", { maxConcurrent: 3 });
await api("PUT", "/v1/cloud", { apiBaseUrl: cloudOrigin, token: "e2e-cloud-token-0123456789", personName: "真跑" });

// 1. 规划员
const plan = await api("POST", "/v1/sessions", {
  subject: { kind: "plan", taskId: "task-e2e" }, title: "拆卡：问候文件", cwd: work, role: PLANNER,
  firstMessage: "拆成 2 件用 propose_plan 交。Task：写问候文件。约定：1. hello.md 含「你好」；2. bye.md 含「再见」。岗位：写作员。档位 light。",
});
say("开了规划员", { id: plan.id, status: plan.status });

const seen = {};
const perms = [];
const watch = async () => {
  const { sessions } = await api("GET", "/v1/sessions");
  for (const s of sessions) {
    const k = `${s.status}/${s.queuePosition}/${s.modelLabel}`;
    if (seen[s.id] !== k) { seen[s.id] = k; say(`${s.subject.kind} 「${s.title}」→ ${s.status}`, { queuePosition: s.queuePosition, model: s.modelLabel }); }
    if (s.pendingPermissions) {
      const d = await api("GET", `/v1/sessions/${s.id}`);
      for (const r of d.pendingPermissions) {
        // 本人在网页上批：执行的卡允许；规划员、验收员本不该来要，来了就拒绝并记下
        const allow = s.subject.kind === "card";
        perms.push({ kind: s.subject.kind, tool: r.toolName, title: r.title, decision: allow ? "allow" : "deny" });
        await api("POST", `/v1/sessions/${s.id}/permissions/${encodeURIComponent(r.requestId)}`, { decision: allow ? "allow" : "deny", ...(allow ? {} : { message: "只读" }) });
      }
    }
  }
  return sessions;
};
const until = async (fn, what, ms = 240_000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    await watch();
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`等不到：${what}`);
};

const cardPlan = await until(() => items.findLast((i) => i.type === "card_plan"), "规划员交计划");
say("天枢收到派活单", cardPlan.data);

// 2. 开工：本人把派活单放进看板点「开工」（云端建好卡，网页把卡的交代交给本机）
const batch = await api("POST", "/v1/sessions/batch", {
  items: cardPlan.data.cards.map((c, i) => {
    const cardId = `e2e-card-${i + 1}`;
    cards.set(cardId, c);
    return { subject: { kind: "card", cardId }, title: c.title, cwd: work, role: WRITER, firstMessage: `卡：${c.title}\n交代：${c.brief}\n完成标准：\n${c.doneDefinition}` };
  }),
});
say("开工", batch.results.map((r) => ({ ok: r.ok, status: r.session?.status })));

// 3–5. 执行、交回、本机自己起验收员、结论同步上去
await until(() => items.filter((i) => i.type === "verdict").length >= cardPlan.data.cards.length, "两份验收结论");
const sessions = await until(async () => {
  const list = (await api("GET", "/v1/sessions")).sessions;
  return list.filter((s) => s.subject.kind === "verify").every((s) => s.status === "exited") ? list : null;
}, "验收员收工", 60_000).catch(async () => (await api("GET", "/v1/sessions")).sessions);

const byKind = (k) => sessions.filter((s) => s.subject.kind === k);
const verdictEvents = [];
for (const s of byKind("card")) for (const e of await events(s.id)) if (e.type === "verdict") verdictEvents.push({ card: s.title, passed: e.passed, failStreak: e.failStreak, blocked: e.blocked, returnText: e.returnText });
const toolCalls = {};
for (const s of [...byKind("plan"), ...byKind("verify")]) toolCalls[`${s.subject.kind}:${s.title}`] = (await events(s.id)).filter((e) => e.type === "tool_call").map((e) => e.name);
const cost = items.filter((i) => i.type === "cost").reduce((sum, i) => sum + (i.data.usage.costUsd ?? 0), 0);
const result = {
  ok: items.filter((i) => i.type === "verdict").length === cardPlan.data.cards.length && !perms.some((p) => p.kind !== "card") && !existsSync(join(work, "probe.txt")),
  seconds: at(),
  plan: { revision: cardPlan.data.revision, cards: cardPlan.data.cards.map((c) => ({ title: c.title, criterionIndex: c.criterionIndex, role: c.role, modelTier: c.modelTier })), roleId: cardPlan.data.roleId, modelLabel: cardPlan.data.modelLabel },
  handbacks: items.filter((i) => i.type === "handback").map((i) => ({ cardId: i.subject.cardId, summary: i.data.summary, outputKeys: i.data.outputKeys.length })),
  briefs,
  verdicts: items.filter((i) => i.type === "verdict").map((i) => ({ cardId: i.subject.cardId, handbackKey: i.subject.handbackKey, passed: i.data.passed, criteria: i.data.criteria.map((c) => `${c.index}:${c.verdict}`), summary: i.data.summary, modelLabel: i.data.modelLabel, roleId: i.data.roleId })),
  verdictEventsInCardSessions: verdictEvents,
  permissionRequests: perms,
  probeWritten: existsSync(join(work, "probe.txt")),
  filesInWork: readdirSync(work).filter((f) => !f.startsWith(".")),
  toolCallsOfPlanAndVerify: toolCalls,
  cloudMcpCalls: mcpCalls,
  sessions: sessions.map((s) => ({ kind: s.subject.kind, title: s.title, status: s.status, model: s.modelLabel })),
  statusKindsSynced: [...new Set(items.filter((i) => i.type === "status").map((i) => i.subject.kind))],
  costUsd: +cost.toFixed(4),
  log,
};
console.log(JSON.stringify({ ok: result.ok, seconds: result.seconds, costUsd: result.costUsd, verdicts: result.verdicts, permissionRequests: perms, probeWritten: result.probeWritten }, null, 1));
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
cloud.close();
process.exit(0);
