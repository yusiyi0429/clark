import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalSyncBatchRequest, type TLocalSyncItem } from "@warmap/contracts";
import { Outbox } from "../src/outbox.js";
import { registerFormats } from "../src/store.js";
import { tempDir } from "./helpers.js";

registerFormats();
const deviceId = "0d2f9a1e-7c44-4b5e-8f3a-2a9e6c1d7b55";
const sessionId = "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10";
const item = (n: number): TLocalSyncItem => ({
  key: `${deviceId}:${sessionId}:${n}`, sessionId, subject: { kind: "card", cardId: "card-1" }, occurredAt: new Date().toISOString(),
  type: "status", data: { status: "running", title: "t", agent: "claude-code", modelLabel: "订阅" },
});
const meta = { deviceId, runnerVersion: "0.1.0" };
const target = async () => ({ apiBaseUrl: "https://tk.tokenkingos.com", token: "cloud-token" });

/** 假云端：按脚本回复，记下收到的请求。 */
function fakeCloud(reply: (keys: string[]) => Response | Promise<Response>) {
  const calls: { url: string; auth: string | null; body: any }[] = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body });
    return reply(body.items.map((i: TLocalSyncItem) => i.key));
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

describe("发件箱", () => {
  it("每批（心跳也是）带读到过的额度：只有窗口、恢复时间、读到的时间；没读到过不带", async () => {
    const cloud = fakeCloud((keys) => json({ accepted: keys, rejected: [] }));
    const box = new Outbox(tempDir(), target, meta, cloud.fetchImpl);
    await box.heartbeat(true);
    expect(cloud.calls[0]!.body).not.toHaveProperty("quota");
    const quota = [{ source: "claude_subscription" as const, windows: [{ kind: "session" as const, model: null, usedPercent: 100, state: "blocked" as const, resetsAt: "2026-11-07T09:00:00.000Z" }], blockedUntil: "2026-11-07T09:00:00.000Z", updatedAt: "2026-11-07T08:00:00.000Z" }];
    box.quota = () => quota;
    box.enqueue(item(1));
    await box.flush();
    box.stop();
    expect(cloud.calls[1]!.body.quota).toEqual(quota);
    expect(cloud.calls[1]!.body).not.toHaveProperty("spend");
    expect(Value.Check(LocalSyncBatchRequest, cloud.calls[1]!.body)).toBe(true);
  });

  it("每批带读到过的 TokenHub 花费：只有今天、本月、读到的时间（没有主机、账户名）", async () => {
    const cloud = fakeCloud((keys) => json({ accepted: keys, rejected: [] }));
    const box = new Outbox(tempDir(), target, meta, cloud.fetchImpl);
    const spend = [{ source: "tokenhub" as const, today: [{ amount: 12.4, currency: "CNY", estimated: false }], month: [{ amount: 230, currency: "CNY", estimated: false }], updatedAt: "2026-11-07T08:00:00.000Z" }];
    box.spend = () => spend;
    await box.heartbeat(true);
    box.stop();
    expect(cloud.calls[0]!.body.spend).toEqual(spend);
    expect(Value.Check(LocalSyncBatchRequest, cloud.calls[0]!.body)).toBe(true);
  });

  it("没关联云端时只排队，落盘，重启后还在；同一幂等键只排一次", async () => {
    const dir = tempDir();
    const a = new Outbox(dir, async () => null, meta, fakeCloud(() => json({})).fetchImpl);
    a.enqueue(item(1));
    a.enqueue(item(1));
    a.enqueue(item(2));
    await a.flush();
    a.stop();
    expect(a.status().pending).toBe(2);
    const b = new Outbox(dir, async () => null, meta);
    expect(b.status().pending).toBe(2);
    b.stop();
  });

  it("断网（请求失败）时退避保留，联网后补发；请求合契约、带令牌", async () => {
    const dir = tempDir();
    let online = false;
    const cloud = fakeCloud((keys) => { if (!online) throw new Error("ECONNREFUSED"); return json({ accepted: keys, rejected: [] }); });
    let now = 1_000_000;
    const box = new Outbox(dir, target, meta, cloud.fetchImpl, () => now);
    box.enqueue(item(1));
    box.enqueue(item(2));
    await box.flush();
    expect(box.status()).toMatchObject({ pending: 2, lastError: "ECONNREFUSED" });
    online = true;
    await box.flush(); // 还在退避期内：不发
    expect(cloud.calls.length).toBe(1);
    now += 10_000;
    await box.flush();
    box.stop();
    expect(box.status()).toMatchObject({ pending: 0, lastError: null });
    const last = cloud.calls.at(-1)!;
    expect(last.url).toBe("https://tk.tokenkingos.com/api/local-runner/sync");
    expect(last.auth).toBe("Bearer cloud-token");
    expect(Value.Check(LocalSyncBatchRequest, last.body)).toBe(true);
  });

  it("云端拒收的出队不再重试；回执里没提到的留着重试；5xx 留着", async () => {
    const dir = tempDir();
    let mode: "partial" | "500" = "partial";
    const cloud = fakeCloud((keys) => mode === "500"
      ? json({ error: "x" }, 500)
      : json({ accepted: [keys[0]], rejected: [{ key: keys[1], code: "not_owner", message: "卡不属于本人" }] }));
    let now = 0;
    const box = new Outbox(dir, target, meta, cloud.fetchImpl, () => now);
    box.enqueue(item(1));
    box.enqueue(item(2));
    box.enqueue(item(3));
    await box.flush();
    expect(box.status().pending).toBe(1);
    expect(box.status().lastError).toContain("卡不属于本人");
    mode = "500";
    now += 60_000;
    await box.flush();
    box.stop();
    expect(box.status()).toMatchObject({ pending: 1, lastError: "云端返回 500" });
  });

  it("心跳：5 分钟里没同步过就发一批空的（合契约、带位置数），刚同步过不发，没关联云端不发；每分钟看一次，停下就不再发", async () => {
    let now = 1_000_000;
    const cloud = fakeCloud((keys) => json({ accepted: keys, rejected: [] }));
    const box = new Outbox(tempDir(), target, meta, cloud.fetchImpl, () => now);
    box.slots = () => ({ max: 3, running: 0, queued: 0 });
    await box.heartbeat(); // 开机后还没同步过：发
    expect(cloud.calls.map((c) => c.body.items)).toEqual([[]]);
    expect(Value.Check(LocalSyncBatchRequest, cloud.calls[0]!.body)).toBe(true);
    expect(cloud.calls[0]!.body.slots).toEqual({ max: 3, running: 0, queued: 0 });
    expect(box.status().lastSyncedAt).not.toBeNull();
    now += 4 * 60_000;
    await box.heartbeat(); // 4 分钟前发过：不发
    expect(cloud.calls.length).toBe(1);
    box.enqueue(item(1));
    await box.flush(); // 有东西要报：照常发
    now += 4 * 60_000; // 离上次心跳 8 分钟，离上次同步 4 分钟：不发
    await box.heartbeat();
    expect(cloud.calls.length).toBe(2);
    now += 60_000; // 离上次同步满 5 分钟：发
    await box.heartbeat();
    expect(cloud.calls.map((c) => c.body.items.length)).toEqual([0, 1, 0]);
    box.stop();

    const unlinked = new Outbox(tempDir(), async () => null, meta, cloud.fetchImpl, () => now);
    await unlinked.heartbeat();
    unlinked.stop();
    expect(cloud.calls.length).toBe(3);

    vi.useFakeTimers();
    try {
      const timed = new Outbox(tempDir(), target, meta, cloud.fetchImpl, () => now);
      timed.startHeartbeat();
      await vi.advanceTimersByTimeAsync(59_000);
      expect(cloud.calls.length).toBe(3);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(cloud.calls.length).toBe(4);
      timed.stop();
      now += 10 * 60_000;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(cloud.calls.length).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
