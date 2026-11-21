// 排队真跑（V2 设计 20.6）：上限设 1，一批同时开 2 件，看第 2 件排队、第 1 件这一轮做完后自动开始。会真的调用 Claude（haiku，提示词极短）。
// 用法：先起本机程序（--headless，TIANSHU_LOCAL_AUTO_APPROVE=1、TIANSHU_LOCAL_PICK_FOLDER=<目录>），再
//   node K_queue-e2e.mjs --port 47662 --data-dir <本机程序数据目录> --out <结果.json>
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const port = Number(arg("--port", "47662"));
const dataDir = arg("--data-dir");
const out = arg("--out");
const origin = "https://tk.tokenkingos.com";
const base = `http://127.0.0.1:${port}`;
const { readFileSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
let token = "";
const t0 = Date.now();
const at = () => +((Date.now() - t0) / 1000).toFixed(1);
const log = [];
const say = (what, data) => { const e = { t: at(), what, ...(data ? { data } : {}) }; log.push(e); console.log(JSON.stringify(e)); };

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

const p = await api("POST", "/v1/pairings", { clientLabel: "排队真跑" });
for (;;) {
  const s = await api("GET", `/v1/pairings/${p.pairingId}`);
  if (s.token) { token = s.token; break; }
  await new Promise((r) => setTimeout(r, 300));
}
const picked = await api("POST", "/v1/folders/pick");
await api("PUT", "/v1/models/queue-haiku", { label: "订阅 · haiku", source: "subscription", model: "haiku" });
await api("PATCH", "/v1/settings", { maxConcurrent: 1 });
const item = (n) => ({ subject: { kind: "card", cardId: `queue-${n}` }, title: `排队真跑 ${n}`, cwd: picked.folder.path, modelProfileId: "queue-haiku", firstMessage: "只回一个字：好。不要用工具。" });
const batch = await api("POST", "/v1/sessions/batch", { items: [item(1), item(2)] });
const [s1, s2] = batch.results.map((r) => r.session);
say("一批开工的结果", batch.results.map((r) => ({ ok: r.ok, status: r.session?.status, queuePosition: r.session?.queuePosition })));
say("资源栏（health.slots）", (await api("GET", "/v1/health")).slots);

// 每 300 毫秒看一次两件的状态，记下每次变化，直到两件都做完这一轮（idle）
const last = {};
for (const deadline = Date.now() + 180_000; Date.now() < deadline;) {
  const { sessions } = await api("GET", "/v1/sessions");
  for (const [name, s] of [["第 1 件", s1], ["第 2 件", s2]]) {
    const cur = sessions.find((x) => x.id === s.id);
    const key = `${cur.status}/${cur.queuePosition}`;
    if (last[name] !== key) { last[name] = key; say(`${name} → ${cur.status}`, { queuePosition: cur.queuePosition, slots: (await api("GET", "/v1/health")).slots }); }
  }
  if (last["第 1 件"]?.startsWith("idle") && last["第 2 件"]?.startsWith("idle")) break;
  await new Promise((r) => setTimeout(r, 300));
}

// 两件的回答和花费
for (const [name, s] of [["第 1 件", s1], ["第 2 件", s2]]) {
  const res = await fetch(`${base}/v1/sessions/${s.id}/events`, { headers: { origin, "x-tianshu-local-token": token, "last-event-id": "0" } });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ""; const events = [];
  const stop = setTimeout(() => reader.cancel(), 1500);
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); } } catch { /* 读够了 */ }
  clearTimeout(stop);
  for (const chunk of buf.split("\n\n")) { const d = chunk.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join(""); if (d) events.push(JSON.parse(d)); }
  say(`${name} 的事件`, events.map((e) => e.type === "status" ? `status:${e.status}` : e.type === "assistant_text" ? `说：${e.text}` : e.type === "turn_end" ? `一轮结束 $${e.usage.costUsd}` : e.type));
}

// 发件箱里第 2 件报给云端的状态条目（没关联云端，都还排在发件箱里）
const items = JSON.parse(readFileSync(join(dataDir, "outbox.json"), "utf8")).entries.map((e) => e.item);
say("第 2 件报给云端的状态", items.filter((i) => i.sessionId === s2.id && i.type === "status").map((i) => i.data));
say("每一批带的 slots（现在）", (await api("GET", "/v1/status")).slots);
for (const s of [s1, s2]) await api("POST", `/v1/sessions/${s.id}/kill`);
if (out) writeFileSync(out, JSON.stringify(log, null, 2));
