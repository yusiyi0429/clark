// 真跑一次岗位 + 评审会：本机程序（源码，tsx）+ 真 Claude Code（订阅 haiku）。提示词极短。
// 用法：node review.mjs <apps/local 目录> <输出目录>
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [appDir, out] = process.argv.slice(2);
const ORIGIN = "https://tk.tokenkingos.com";
const PORT = 47665;
const R = `http://127.0.0.1:${PORT}`;
const data = join(out, "data");
mkdirSync(data, { recursive: true });
const t0 = Date.now();
const log = (m, x) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`, x === undefined ? "" : JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const s = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - s > ms) throw new Error("等不到：" + what); await sleep(500); } }

const runner = spawn(process.execPath, [join(appDir, "node_modules", "tsx", "dist", "cli.mjs"), join(appDir, "src", "main.ts"), "run", "--headless", "--port", String(PORT), "--data-dir", data], {
  env: { ...process.env, TIANSHU_LOCAL_AUTO_APPROVE: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
let rlog = ""; runner.stdout.on("data", (d) => (rlog += d)); runner.stderr.on("data", (d) => (rlog += d));
let token = "";
async function local(method, path, body) {
  const r = await fetch(R + path, { method, headers: { origin: ORIGIN, ...(token ? { "x-tianshu-local-token": token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`本机 ${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const events = (id) => existsSync(join(data, "sessions", id, "events.jsonl")) ? readFileSync(join(data, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
async function drive(id, done, ms = 240_000) {
  return until(async () => {
    const s = await local("GET", `/v1/sessions/${id}`);
    for (const p of s.pendingPermissions) { log(`批准：${p.title}`, { outside: p.outsidePaths }); await local("POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(p.requestId)}`, { decision: "allow" }); }
    return done(s, events(id));
  }, ms, "会话推进");
}
const role = (name, duties, practice, tools = []) => ({ name, dutiesMd: duties, practiceMd: practice, acceptanceMd: "", tools });

let result = { ok: false };
try {
  await until(async () => (await fetch(`${R}/v1/health`, { headers: { origin: ORIGIN } }).catch(() => null))?.ok, 30_000, "启动");
  const p = await local("POST", "/v1/pairings", { clientLabel: "评审会实测" });
  token = await until(async () => (await local("GET", `/v1/pairings/${p.pairingId}`)).token, 10_000, "配对");
  await local("PUT", "/v1/models/sub-haiku", { label: "订阅 haiku", source: "subscription", model: "haiku" });
  const s = await local("POST", "/v1/sessions", {
    subject: { kind: "topic", topicId: "review-test" }, title: "周报改双周报", modelProfileId: "sub-haiku", versionBase: 0,
    role: role("调研员", "把问题想清楚，给出结论。", "提纲最多 3 条，每条一句话。正文 150 字以内。"),
    critics: [role("反方", "专找论证漏洞。", "只说最重要的一条，30 字以内。"), role("读者视角", "看忙碌的读者能不能一眼看懂。", "只说最重要的一条，30 字以内。")],
    firstMessage: "专题：团队周报要不要改成双周报。先出提纲。",
  });
  const id = s.id;
  log("开工", { id, cwd: s.cwd });
  await drive(id, (st, ev) => st.session.status === "idle" && ev.some((e) => e.type === "version"));
  log("提纲", events(id).filter((e) => e.type === "version"));
  await local("POST", `/v1/sessions/${id}/messages`, { text: "按提纲写正文。" });
  await drive(id, (st, ev) => st.session.status === "idle" && ev.filter((e) => e.type === "version").length >= 2);
  log("正文", events(id).filter((e) => e.type === "version").at(-1));
  const before = events(id).length;
  await local("POST", `/v1/sessions/${id}/messages`, { kind: "review" });
  await drive(id, (st, ev) => st.session.status === "idle" && ev.some((e) => e.type === "version" && e.kind === "review"), 300_000);
  const rev = events(id).slice(before);
  const calls = rev.filter((e) => e.type === "tool_call" && /^(Agent|Task)$/.test(e.name));
  const firstResult = rev.findIndex((e) => e.type === "tool_result" && calls.some((c) => c.toolUseId === e.toolUseId));
  const callIdx = calls.map((c) => rev.indexOf(c));
  result = {
    ok: true, id,
    versions: events(id).filter((e) => e.type === "version").map(({ number, kind, label, note }) => ({ number, kind, label, note })),
    criticCalls: calls.map((c) => ({ subagent: c.input.subagent_type, title: c.title })),
    parallel: callIdx.length >= 2 && callIdx.every((i) => i < firstResult),
    reviewFile: (() => { const v = rev.filter((e) => e.type === "tool_call" && e.name === "mcp__tianshu-session__save_version").at(-1); return v?.input?.path ?? null; })(),
    cost: (await local("GET", `/v1/sessions/${id}`)).session.usage.costUsd,
    cwd: s.cwd,
  };
  if (result.reviewFile) result.reviewBody = readFileSync(join(s.cwd, result.reviewFile), "utf8").slice(0, 1500);
  await local("POST", `/v1/sessions/${id}/kill`, {});
} catch (e) {
  result.error = String(e?.stack ?? e);
} finally {
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 1));
  writeFileSync(join(out, "runner.log"), rlog);
  console.log(JSON.stringify(result, null, 1));
  runner.kill();
  await sleep(500);
  process.exit(result.ok ? 0 : 1);
}
