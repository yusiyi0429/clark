// 本机程序 × 云端接收端联调：真本机程序（exe）+ 时间机器起的天枢 api + 中间一个可开关的代理（模拟断网）。
// 用法：node e2e.mjs <本机程序 exe> <api 地址，如 http://127.0.0.1:4590> <网页来源，登录用> <输出目录>
// 调真 Claude（haiku，提示词很短）。只往一次性测试库写。
import http from "node:http";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const [exe, api, webOrigin, out] = process.argv.slice(2);
const ORIGIN = "https://tk.tokenkingos.com";
const PROXY_PORT = 4599;
const RUNNER_PORT = 47662;
const R = `http://127.0.0.1:${RUNNER_PORT}`;
const data = join(out, "data");
const work = join(out, "work");
rmSync(out, { recursive: true, force: true });
mkdirSync(data, { recursive: true });
mkdirSync(work, { recursive: true });
const t0 = Date.now();
const steps = [];
const log = (msg, extra) => { const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`; console.log(line, extra === undefined ? "" : JSON.stringify(extra)); steps.push({ msg, extra }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const start = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - start > ms) throw new Error(`等不到：${what}`); await sleep(500); }
}

// ── 代理：本机程序 → 代理 → api；down() 模拟断网（拒连）
let proxy = null;
function up() {
  return new Promise((resolve) => {
    proxy = http.createServer((req, res) => {
      const u = new URL(api);
      const p = http.request({ host: u.hostname, port: u.port, method: req.method, path: req.url, headers: { ...req.headers, host: u.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      p.on("error", () => { res.writeHead(502); res.end(); });
      req.pipe(p);
    });
    proxy.listen(PROXY_PORT, "127.0.0.1", resolve);
  });
}
function down() { return new Promise((resolve) => { proxy.closeAllConnections?.(); proxy.close(() => resolve()); }); }

// ── 本机程序
writeFileSync(join(data, "config.json"), JSON.stringify({ extraOrigins: [`http://127.0.0.1:${PROXY_PORT}`] }));
const runner = spawn(exe, ["run", "--headless", "--port", String(RUNNER_PORT), "--data-dir", data], {
  env: { ...process.env, TIANSHU_LOCAL_AUTO_APPROVE: "1", TIANSHU_LOCAL_PICK_FOLDER: work }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
let runnerLog = "";
runner.stdout.on("data", (d) => (runnerLog += d));
runner.stderr.on("data", (d) => (runnerLog += d));
let token = "";
async function local(method, path, body) {
  const r = await fetch(R + path, { method, headers: { origin: ORIGIN, ...(token ? { "x-tianshu-local-token": token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`本机 ${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}
let cookie = "";
async function cloud(method, path, body, headers = {}) {
  const r = await fetch(api + path, { method, headers: { origin: webOrigin, ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j, headers: r.headers };
}
const events = (id) => existsSync(join(data, "sessions", id, "events.jsonl")) ? readFileSync(join(data, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
async function drive(id, untilFn, ms = 180_000) {
  // 批准所有权限请求（只会是在工作目录里写文件），直到 untilFn 成立
  return until(async () => {
    const s = await local("GET", `/v1/sessions/${id}`);
    for (const p of s.pendingPermissions) {
      log(`批准：${p.title}`, { outsidePaths: p.outsidePaths });
      await local("POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(p.requestId)}`, { decision: "allow" });
    }
    return untilFn(s, events(id));
  }, ms, "会话推进");
}

const result = {};
try {
  await up();
  await until(async () => (await fetch(`${R}/v1/health`, { headers: { origin: ORIGIN } }).catch(() => null))?.ok, 30_000, "本机程序启动");
  // 1 配对（无托盘模式自动通过）
  const p = await local("POST", "/v1/pairings", { clientLabel: "联调" });
  token = (await until(async () => (await local("GET", `/v1/pairings/${p.pairingId}`)).token, 10_000, "配对口令"));
  await local("POST", "/v1/folders/pick", {});
  const status = await local("GET", "/v1/status");
  log("配对完成", { deviceId: status.deviceId, claude: status.agents[0].version, loggedIn: status.agents[0].loggedIn });

  // 2 天枢：登录、建一个执行事项、配对建设备令牌
  const login = await cloud("POST", "/api/auth/login", { loginId: "browsermember", passcode: "8742" });
  if (login.status !== 200) throw new Error(`登录失败 ${login.status} ${JSON.stringify(login.body)}`);
  cookie = login.headers.get("set-cookie").split(";")[0];
  const task = await cloud("POST", "/api/me/tasks", { clientId: randomUUID(), title: "verify-e2e 本机交回", missionId: null, doneDefinition: "有 note.md" });
  if (task.status !== 200) throw new Error(`建事项失败 ${task.status} ${JSON.stringify(task.body)}`);
  const taskId = task.body.id;
  const dev = await cloud("POST", "/api/me/local-devices", { deviceId: status.deviceId, name: "联调电脑", os: "win32" });
  if (dev.status !== 201) throw new Error(`建设备令牌失败 ${dev.status} ${JSON.stringify(dev.body)}`);
  log("天枢：已登录、建事项、建设备令牌", { taskId });
  result.taskId = taskId;

  // 3 关联云端（经代理）
  const link = await local("PUT", "/v1/cloud", { apiBaseUrl: `http://127.0.0.1:${PROXY_PORT}`, token: dev.body.token });
  log("关联云端", { linked: link.linked, apiBaseUrl: link.apiBaseUrl });

  // 4 开一张卡：写文件、交产出物、交回
  await local("PUT", "/v1/models/sub-haiku", { label: "订阅 haiku", source: "subscription", model: "haiku" });
  const s = await local("POST", "/v1/sessions", {
    subject: { kind: "card", cardId: taskId }, title: "verify-e2e 本机交回", cwd: work, modelProfileId: "sub-haiku",
    firstMessage: "在当前目录写 note.md，内容一行：hello。然后调用 add_artifact 交 note.md，再调用 submit_handback 交回：summary 写「写好了 note.md」，criteria 一条：criterion「有 note.md」、status met、evidence「note.md」。不要做别的。",
  });
  const id = s.id;
  log("开工", { sessionId: id });
  await drive(id, (st, ev) => st.session.status === "idle" && ev.some((e) => e.type === "handback"));
  log("第一轮完成：有交回", { types: [...new Set(events(id).map((e) => e.type))] });
  const c1 = await until(async () => { const c = await local("GET", "/v1/cloud"); return c.outbox.pending === 0 && c; }, 60_000, "发件箱发空");
  log("发件箱已发空", c1.outbox);
  const after1 = await cloud("GET", `/api/me/tasks/${taskId}`);
  result.taskAfterFirst = { status: after1.status, state: after1.body?.status ?? after1.body?.state };

  // 5 断网：再做一轮，条目留在发件箱
  await down();
  log("代理已关（断网）");
  await local("POST", `/v1/sessions/${id}/messages`, { text: "再写 note2.md，内容一行：world，然后调用 add_artifact 交 note2.md。不要做别的。" });
  await drive(id, (st, ev) => st.session.status === "idle" && ev.filter((e) => e.type === "artifact").length >= 2);
  const c2 = await until(async () => { const c = await local("GET", "/v1/cloud"); return c.outbox.lastError && c.outbox.pending > 0 && c; }, 60_000, "发件箱报错");
  log("断网时发件箱", c2.outbox);
  const snap = join(out, "outbox-snapshot");
  cpSync(join(data, "outbox.json"), join(snap, "outbox.json"));
  if (existsSync(join(data, "outbox-blobs"))) cpSync(join(data, "outbox-blobs"), join(snap, "outbox-blobs"), { recursive: true });

  // 6 恢复网络：等补发
  await up();
  log("代理已开（恢复）");
  const c3 = await until(async () => { const c = await local("GET", "/v1/cloud"); return c.outbox.pending === 0 && c; }, 360_000, "补发完成");
  log("补发完成", c3.outbox);

  // 7 去重：把断网时留在发件箱的那批原样再发一次
  const st = JSON.parse(readFileSync(join(snap, "outbox.json"), "utf8"));
  const items = st.entries.map((e) => e.blob ? { ...e.item, data: { ...e.item.data, contentBase64: readFileSync(join(snap, "outbox-blobs", e.blob), "utf8") } } : e.item);
  const again = await fetch(`${api}/api/local-runner/sync`, { method: "POST", headers: { authorization: `Bearer ${dev.body.token}`, "content-type": "application/json" }, body: JSON.stringify({ deviceId: status.deviceId, runnerVersion: "0.1.0", items }) });
  const againBody = await again.json();
  log("原样重发断网那批", { status: again.status, items: items.length, accepted: againBody.accepted?.length, rejected: againBody.rejected });
  result.resend = { status: again.status, items: items.length, accepted: againBody.accepted?.length ?? null, rejected: againBody.rejected ?? null, types: items.map((i) => i.type) };

  await local("POST", `/v1/sessions/${id}/kill`, {});
  result.sessionId = id;
  result.deviceId = status.deviceId;
  result.cost = (await local("GET", `/v1/sessions/${id}`)).session.usage.costUsd;
  result.ok = true;
} catch (e) {
  result.ok = false;
  result.error = String(e?.stack ?? e);
  console.error(e);
} finally {
  result.steps = steps;
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 1));
  writeFileSync(join(out, "runner.log"), runnerLog);
  runner.kill();
  await sleep(500);
  try { await down(); } catch {}
  process.exit(result.ok ? 0 : 1);
}
