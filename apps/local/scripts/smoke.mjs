// 冒烟测试命令：照网页的走法把一条完整链路走一遍——配对 → 选文件夹 → 开会话 → 看事件 → 批权限 → 插话 → 停下 → 强停。
// 用法：node scripts/smoke.mjs [--port 47610] [--origin https://tk.tokenkingos.com] [--model haiku]
// 本机程序要先跑起来；配对和选文件夹会在本机弹框（或者本机程序以 --headless 跑，并设
// TIANSHU_LOCAL_AUTO_APPROVE=1、TIANSHU_LOCAL_PICK_FOLDER=<目录>）。会真的调用 Claude：提示词很短，默认用 haiku。
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const port = Number(arg("--port", "47610"));
const origin = arg("--origin", "https://tk.tokenkingos.com");
const model = arg("--model", "haiku");
const base = `http://127.0.0.1:${port}`;
let token = "";
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

async function api(method, path, body) {
  if (body === undefined && method !== "GET" && method !== "DELETE") body = {}; // 只收 JSON：没内容也发 {}
  const res = await fetch(base + path, {
    method,
    headers: { origin, ...(token ? { "x-tianshu-local-token": token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error?.message ?? ""}`);
  return json;
}

const health = await api("GET", "/v1/health");
say("health", health);
const p = await api("POST", "/v1/pairings", { clientLabel: "冒烟测试" });
say(`配对确认码 ${p.code}：到本机弹框里点「是」`);
for (;;) {
  const s = await api("GET", `/v1/pairings/${p.pairingId}`);
  if (s.token) { token = s.token; break; }
  if (s.status !== "pending") throw new Error(`配对 ${s.status}`);
  await new Promise((r) => setTimeout(r, 500));
}
say("配对成功（口令不打印）");
const status = await api("GET", "/v1/status");
const claude = status.agents[0];
say(`Claude Code ${claude.version ?? "没装"} · ${claude.loggedIn ? `已登录（${claude.authMethod}）` : "未登录"} · 兼容 ${claude.compatible}`);
const picked = await api("POST", "/v1/folders/pick");
if (!picked.folder) throw new Error("没选文件夹");
say("文件夹", picked.folder.path);
await api("PUT", "/v1/models/smoke-sub", { label: `订阅 · ${model}`, source: "subscription", model });
const session = await api("POST", "/v1/sessions", {
  subject: { kind: "card", cardId: "smoke-card" }, title: "冒烟测试", cwd: picked.folder.path, modelProfileId: "smoke-sub",
  firstMessage: "在当前目录依次写 a.txt（内容 1）和 b.txt（内容 2），一次只写一个，每写之前先说一句。不要做别的。",
});
say("开工", session.id, session.status);

// 事件流：EventSource 不能带头，这里和网页一样用 fetch 读 SSE。
let lastSeq = 0;
let permissions = 0;
let interjected = false;
let phase = "run";
const seen = [];
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("超时")), 240_000);
  (async () => {
    const res = await fetch(`${base}/v1/sessions/${session.id}/events`, { headers: { origin, "x-tianshu-local-token": token } });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const e = JSON.parse(line.slice(6));
        lastSeq = e.seq;
        seen.push(e.type);
        if (e.type === "assistant_text") say("Claude：", e.text.slice(0, 120));
        else if (e.type === "tool_call") say("  ·", e.title);
        else if (e.type === "status") say("  状态", e.status, e.reason ?? "");
        else if (e.type === "notice") say("  提示", e.code, e.text.slice(0, 100));
        else if (e.type === "turn_end") say("  一轮结束", e.isError ? `出错(${e.errorKind})` : "成功", `花费 $${e.usage.costUsd}`);
        else if (e.type === "permission_request") {
          permissions += 1;
          if (phase === "third") {
            say("  ? 第三轮的权限请求先挂着，直接停下");
            await api("POST", `/v1/sessions/${session.id}/interrupt`);
            continue;
          }
          say("  ? 要权限：", e.request.title, "→ 允许");
          await api("POST", `/v1/sessions/${session.id}/permissions/${encodeURIComponent(e.request.requestId)}`, { decision: "allow" });
          if (!interjected) {
            interjected = true;
            const r = await api("POST", `/v1/sessions/${session.id}/messages`, { text: "补充：b.txt 的内容改成 22。" });
            say("  → 插话", r.delivery);
          }
        }
        if (e.type === "status" && e.status === "idle" && phase === "run") {
          phase = "third";
          const r = await api("POST", `/v1/sessions/${session.id}/messages`, { text: "再写 c.txt，内容 3。" });
          say("  → 第三轮", r.delivery);
        } else if (e.type === "status" && e.status === "idle" && phase === "third") {
          phase = "kill";
          await api("POST", `/v1/sessions/${session.id}/kill`);
        } else if (e.type === "status" && (e.status === "exited" || e.status === "failed") && phase === "kill") {
          clearTimeout(timer);
          resolve();
          reader.cancel();
          return;
        }
      }
    }
  })().catch(reject);
});
await done;
const fs = await import("node:fs");
const path = await import("node:path");
const files = Object.fromEntries(["a.txt", "b.txt", "c.txt"].map((f) => {
  const full = path.join(picked.folder.path, f);
  return [f, fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null];
}));
const final = await api("GET", `/v1/sessions/${session.id}`);
const cloud = await api("GET", "/v1/cloud");
say("文件", files);
say("结束状态", final.session.status, "事件数", lastSeq, "权限请求", permissions, "累计花费 $", final.session.usage.costUsd, "云端待发", cloud.outbox.pending);
say("事件类型", [...new Set(seen)].join(","));
await api("DELETE", "/v1/models/smoke-sub");
await api("DELETE", "/v1/pairing");
