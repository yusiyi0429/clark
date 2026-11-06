import { describe, expect, it } from "vitest";
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
});
