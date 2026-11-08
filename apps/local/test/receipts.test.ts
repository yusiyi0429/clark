// 子会话消息回执（新首页 17.4）：每句话带编号；执行方收下是 delivered、读到是 read（Claude Code 的 command_lifecycle queued / started）；
// 进程没了还没读到的是 failed。本人在网页上说的话和回执同步给云端（手机端），开工那句不同步。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { api, pair, startTestRunner, tempDir } from "./helpers.js";

async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe("子会话消息回执", { timeout: 60_000 }, () => {
  it("开工那句、空闲时说的、进行中插的都依次 delivered → read；这一轮读不到的强停后是 failed；本人说的和回执进同步、开工那句不进；重启时没读到的算 failed", async () => {
    const work = tempDir("tl-receipt-");
    const fake = (cfg: unknown) => writeFileSync(join(work, ".fake-claude.json"), JSON.stringify(cfg));
    fake({});
    let t = await startTestRunner({ pickFolder: work });
    const dataDir = t.dataDir;
    try {
      const token = await pair(t.port);
      const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
      await call("POST", "/v1/folders/pick", {});
      const events = (id: string) => readFileSync(join(dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const receipts = (id: string, messageId: string) => events(id).filter((e) => e.type === "receipt" && e.messageId === messageId).map((e) => e.state);
      const synced = () => JSON.parse(readFileSync(join(dataDir, "outbox.json"), "utf8")).entries.map((e: any) => e.item);
      const status = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body.session.status as string;
      const allow = async (id: string) => {
        const s = await until(async () => { const b = (await call("GET", `/v1/sessions/${id}`)).body; return b.pendingPermissions[0] ? b : null; });
        return call("POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(s.pendingPermissions[0].requestId)}`, { decision: "allow" });
      };

      // 开工那句：带编号，收下、读到；不同步
      const s = (await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "c-receipt" }, title: "回执", cwd: work, firstMessage: "做" })).body;
      await allow(s.id);
      await until(async () => (await status(s.id)) === "idle");
      const first = events(s.id).find((e) => e.type === "user_message");
      expect(first).toMatchObject({ source: "initial", text: "做", messageId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      expect(receipts(s.id, first.messageId)).toEqual(["delivered", "read"]);
      expect(synced().some((i: any) => i.type === "user_message" || i.type === "receipt")).toBe(false);

      // 空闲时说一句：回包和事件带同一个编号，delivered → read，话和两条回执都同步
      const idle = (await call("POST", `/v1/sessions/${s.id}/messages`, { text: "再改一处" })).body;
      await until(() => receipts(s.id, idle.messageId).length === 2);
      expect(receipts(s.id, idle.messageId)).toEqual(["delivered", "read"]);
      expect(events(s.id).find((e) => e.type === "user_message" && e.messageId === idle.messageId)).toMatchObject({ text: "再改一处", source: "web" });
      expect(synced().filter((i: any) => i.data?.messageId === idle.messageId).map((i: any) => i.type === "receipt" ? i.data.state : i.data.text))
        .toEqual(["再改一处", "delivered", "read"]);
      // 进行中插一句（在等批准这一步时）：马上读到
      const mid = (await call("POST", `/v1/sessions/${s.id}/messages`, { text: "插一句" })).body;
      expect(mid.delivery).toBe("next_step");
      await until(() => receipts(s.id, mid.messageId).length === 2);
      await allow(s.id);
      await until(async () => (await status(s.id)) === "idle");

      // 这一轮读不到的（只在出字时插的话，要等这一轮结束）：只到 delivered；强停后是 failed，也同步
      fake({ holdInterjections: true });
      await call("POST", `/v1/sessions/${s.id}/messages`, { text: "又一轮" });
      await until(async () => (await status(s.id)) === "waiting_permission");
      const lost = (await call("POST", `/v1/sessions/${s.id}/messages`, { text: "这句读不到" })).body;
      await until(() => receipts(s.id, lost.messageId).length === 1);
      expect(receipts(s.id, lost.messageId)).toEqual(["delivered"]);
      await call("POST", `/v1/sessions/${s.id}/kill`, {});
      await until(async () => (await status(s.id)) === "exited");
      expect(receipts(s.id, lost.messageId)).toEqual(["delivered", "failed"]);
      expect(synced().filter((i: any) => i.type === "receipt" && i.data.messageId === lost.messageId).map((i: any) => i.data.state)).toEqual(["delivered", "failed"]);

      // 本机程序没正常退出、留着没读到的：重启时算 failed
      await t.runner.close();
      const file = join(dataDir, "sessions", s.id, "session.json");
      const rec = JSON.parse(readFileSync(file, "utf8"));
      rec.unread = [{ id: "7b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", web: true }];
      writeFileSync(file, JSON.stringify(rec));
      t = await startTestRunner({ dataDir, pickFolder: work });
      expect(receipts(s.id, "7b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")).toEqual(["failed"]);
      expect(JSON.parse(readFileSync(file, "utf8")).unread).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });
});
