// 11/06 独立评审发现的问题的回归测试：每条对应一个评审编号。
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TLocalSyncItem } from "@warmap/contracts";
import { Outbox } from "../src/outbox.js";
import { EventLog } from "../src/eventLog.js";
import { registerFormats } from "../src/store.js";
import { api, pair, raw, startTestRunner, tempDir, ORIGIN } from "./helpers.js";

registerFormats();
const trace = (dir: string) => readFileSync(join(dir, ".fake-claude-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn: () => Promise<boolean> | boolean, ms = 5_000) {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe("本机程序加固", () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-work-");
  const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  beforeAll(async () => { t = await startTestRunner({ pickFolder: work, fetchImpl: offline }); token = await pair(t.port); await api(t.port, token, "POST", "/v1/folders/pick", {}); });
  afterAll(async () => { await t.cleanup(); });

  const status = async (id: string) => (await api(t.port, token, "GET", `/v1/sessions/${id}`)).body.session.status as string;
  const open = async () => {
    const s = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c" }, title: "x", cwd: work, firstMessage: "hi" });
    expect(s.status).toBe(200);
    return s.body.id as string;
  };
  const stop = async (id: string) => {
    await api(t.port, token, "POST", `/v1/sessions/${id}/kill`, {});
    await until(async () => (await status(id)) === "exited");
  };

  it("#1 怪路径（//、不以 / 开头）回 400，进程不挂", async () => {
    expect((await raw(t.port, { path: "//", headers: { origin: ORIGIN } })).status).toBe(400);
    expect((await raw(t.port, { path: "//evil.example/v1/health" })).status).toBe(400);
    expect((await raw(t.port, { path: "/v1/health", headers: { origin: ORIGIN } })).status).toBe(200);
  });

  it("#8 已退出的会话同时来两句话：只起一个进程，两句都送到", async () => {
    const id = await open();
    await stop(id);
    const before = trace(work).length;
    const [a, b] = await Promise.all([
      api(t.port, token, "POST", `/v1/sessions/${id}/messages`, { text: "一" }),
      api(t.port, token, "POST", `/v1/sessions/${id}/messages`, { text: "二" }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.delivery, b.body.delivery].filter((d) => d === "resumed")).toHaveLength(1);
    expect(trace(work).length).toBe(before + 1);
    await stop(id);
  });

  it("#8 续接握手途中强停：启动一完成就杀掉，不留孤儿进程", async () => {
    const id = await open();
    await stop(id);
    writeFileSync(join(work, ".fake-claude.json"), JSON.stringify({ initDelayMs: 1200 }));
    try {
      const msg = api(t.port, token, "POST", `/v1/sessions/${id}/messages`, { text: "接着" });
      await new Promise((r) => setTimeout(r, 300));
      await api(t.port, token, "POST", `/v1/sessions/${id}/kill`, {});
      expect((await msg).status).toBe(409);
      const pid = trace(work).at(-1).pid as number;
      await until(() => !alive(pid));
    } finally {
      writeFileSync(join(work, ".fake-claude.json"), "{}");
    }
  });

  it("#3 允许的文件夹被移除后，旧会话不能续接", async () => {
    const id = await open();
    await stop(id);
    const folder = (await api(t.port, token, "GET", "/v1/folders")).body.folders[0];
    await api(t.port, token, "DELETE", `/v1/folders/${folder.id}`);
    try {
      const r = await api(t.port, token, "POST", `/v1/sessions/${id}/messages`, { text: "接着" });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("folder_not_allowed");
    } finally {
      await api(t.port, token, "POST", "/v1/folders/pick", {});
    }
  });

  it("#3 暂停后不开新会话、不续接；网页能暂停但不能替本人恢复", async () => {
    const id = await open();
    await stop(id);
    expect((await api(t.port, token, "PATCH", "/v1/settings", { paused: true })).body.paused).toBe(true);
    expect((await api(t.port, token, "POST", `/v1/sessions/${id}/messages`, { text: "接着" })).status).toBe(409);
    expect((await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c" }, title: "x", cwd: work, firstMessage: "hi" })).status).toBe(409);
    expect((await api(t.port, token, "PATCH", "/v1/settings", { paused: false })).status).toBe(409);
    // 托盘里恢复（本机这一侧）。
    writeFileSync(join(t.dataDir, "settings.json"), JSON.stringify({ includePersonalConfigByDefault: false, paused: false }));
  });
});

describe("发件箱加固", () => {
  const deviceId = "0d2f9a1e-7c44-4b5e-8f3a-2a9e6c1d7b55";
  const sessionId = "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10";
  const meta = { deviceId, runnerVersion: "0.1.0" };
  const base = (n: number) => ({ key: `${deviceId}:${sessionId}:${n}`, sessionId, subject: { kind: "card" as const, cardId: "c" }, occurredAt: new Date().toISOString() });
  const evidence = (n: number, title: string): TLocalSyncItem => ({ ...base(n), type: "evidence", data: { kind: "note", title } });
  const target = async () => ({ apiBaseUrl: "https://tk.tokenkingos.com", token: "t" });

  it("#9 不合契约的条目不进队，只记错", async () => {
    const box = new Outbox(tempDir(), target, meta, offlineFetch());
    box.enqueue(evidence(1, ""));
    box.enqueue(evidence(2, "x".repeat(201)));
    box.stop();
    expect(box.status().pending).toBe(0);
    expect(box.status().lastError).toContain("不合格");
  });

  it("#9 云端整批 400：拆开逐条发，坏的丢掉，好的送达，不卡住", async () => {
    const seen: string[][] = [];
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const keys = JSON.parse(String(init?.body)).items.map((i: TLocalSyncItem) => i.key) as string[];
      seen.push(keys);
      if (keys.includes(base(2).key)) return new Response("bad item", { status: 400 });
      return new Response(JSON.stringify({ accepted: keys, rejected: [] }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const box = new Outbox(tempDir(), target, meta, fetchImpl);
    for (const n of [1, 2, 3]) box.enqueue(evidence(n, `证据 ${n}`));
    for (let i = 0; i < 6 && box.status().pending; i++) await box.flush();
    box.stop();
    expect(box.status().pending).toBe(0);
    expect(seen[0]).toHaveLength(3);
    expect(seen.slice(1).every((b) => b.length === 1)).toBe(true);
    expect(box.status().lastError ?? "").not.toContain("整批");
  });

  it("#10 取云端令牌时出错（如 DPAPI 解不开）：flush 不抛，记下错误", async () => {
    const box = new Outbox(tempDir(), async () => { throw new Error("本机钥匙解密失败（DPAPI）"); }, meta, offlineFetch());
    box.enqueue(evidence(1, "x"));
    await expect(box.flush()).resolves.toBeUndefined();
    box.stop();
    expect(box.status().lastError).toContain("DPAPI");
  });

  it("产出物原文另存文件，队列文件里不放 base64；发送时带上原文", async () => {
    const dir = tempDir();
    let sent = "";
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      sent = body.items[0].data.contentBase64;
      return new Response(JSON.stringify({ accepted: body.items.map((i: TLocalSyncItem) => i.key), rejected: [] }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const content = Buffer.from("# 方案").toString("base64");
    const box = new Outbox(dir, async () => null, meta, fetchImpl);
    box.enqueue({ ...base(1), type: "artifact", data: { artifactId: "a1", title: "方案", fileName: "a.md", mimeType: "text/markdown", size: 8, sha256: "0".repeat(64), contentBase64: content } });
    box.stop();
    expect(readFileSync(join(dir, "outbox.json"), "utf8")).not.toContain(content);
    const again = new Outbox(dir, target, meta, fetchImpl);
    await again.flush();
    again.stop();
    expect(sent).toBe(content);
    expect(again.status().pending).toBe(0);
  });
});

describe("事件日志加固", () => {
  it("#11 断电留下没有换行的半行：下一条事件不会拼在它后面，序号不重复", () => {
    const dir = tempDir();
    const id = "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10";
    const a = new EventLog(dir);
    a.append(id, { type: "assistant_text", text: "一" });
    a.append(id, { type: "assistant_text", text: "二" });
    appendFileSync(join(dir, id, "events.jsonl"), '{"seq":3,"at":"2026-11-06T00:00:00.000Z","sessionId":"' + id + '","type":"assis');
    const b = new EventLog(dir);
    expect(b.lastSeq(id)).toBe(2);
    b.append(id, { type: "assistant_text", text: "三" });
    const c = new EventLog(dir);
    expect(c.after(id, 0).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(c.after(id, 2)).toMatchObject([{ type: "assistant_text", text: "三" }]);
  });
});

function offlineFetch() {
  return (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
}
