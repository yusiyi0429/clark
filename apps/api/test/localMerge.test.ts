import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { boardFixture } from "./boardFixture.js";

/** 本机报合回结果（同步条目 merge，本机契约 b735df52）和交完收工（会话状态 done）。 */
describe("合回结果和交完收工", { timeout: 30_000 }, () => {
  it("合回结果记在验的那次交回上，同一次交回以本机序号最大的为准；云端没有的交回拒收；规划员交完收工记成 done 并记结束时间", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const cardId = await f.card("greet");
      const laptop = await f.local();
      const handbackId = await laptop.handBack(cardId);
      const handbackKey = (await f.t.sql("SELECT client_id FROM card_handbacks WHERE id=$1", [handbackId]))[0].client_id as string;
      const merge = (merged: boolean, extra: Record<string, unknown> = {}) => ["merge", { handbackKey, merged, commit: merged ? "a".repeat(40) : null, baseBranch: "main",
        reason: merged ? null : "dirty", message: merged ? null : "主文件夹有没提交的改动", auto: true, ...extra }] as [string, unknown];
      // 同一批里先没合成、紧接着本人点合并合成了：取序号大的那条（合成了）。
      await laptop.send({ kind: "card", cardId }, [merge(false), merge(true, { auto: false })]);
      const stored = async () => (await f.t.sql("SELECT merge FROM card_handbacks WHERE id=$1", [handbackId]))[0].merge;
      expect(await stored()).toMatchObject({ merged: true, commit: "a".repeat(40), baseBranch: "main", reason: null, auto: false, seq: 2 });
      // 序号更小的晚到了，不改。
      await laptop.send({ kind: "card", cardId }, [merge(false, { reason: "not_ready", message: "卡还在跑" })]);
      expect(await stored()).toMatchObject({ merged: true, seq: 2 });

      const session = randomUUID();
      const sync = (items: { type: string; data: unknown; subject: unknown }[]) => f.t.app.inject({ method: "POST", url: "/api/local-runner/sync",
        headers: { authorization: `Bearer ${laptop.token}` }, payload: { deviceId: laptop.device, runnerVersion: "0.1.0", slots: { max: 3, running: 0, queued: 0 },
          items: items.map((item, index) => ({ key: `${laptop.device}:${session}:${index + 1}`, sessionId: session, occurredAt: "2026-11-06T04:00:00.000Z", ...item })) } });
      const missing = await sync([{ type: "merge", subject: { kind: "card", cardId }, data: { ...(merge(true)[1] as object), handbackKey: `${laptop.device}:${randomUUID()}:9` } }]);
      expect(missing.json().rejected).toEqual([expect.objectContaining({ code: "HANDBACK_NOT_FOUND" })]);

      const planner = randomUUID();
      const done = await f.t.app.inject({ method: "POST", url: "/api/local-runner/sync", headers: { authorization: `Bearer ${laptop.token}` },
        payload: { deviceId: laptop.device, runnerVersion: "0.1.0", slots: { max: 3, running: 0, queued: 0 }, items: [
          { key: `${laptop.device}:${planner}:1`, sessionId: planner, subject: { kind: "plan", taskId: "task-open" }, occurredAt: "2026-11-06T04:10:00.000Z",
            type: "status", data: { status: "done", title: "拆卡：对话质量达标", agent: "claude-code", modelLabel: "订阅 · Sonnet" } }] } });
      expect(done.json()).toMatchObject({ rejected: [] });
      expect((await f.t.sql("SELECT state,ended_at FROM local_runs WHERE id=$1", [planner]))[0]).toEqual({ state: "done", ended_at: new Date("2026-11-06T04:10:00.000Z") });
    } finally { await f.close(); }
  });
});
