// 同时跑的上限和先来先跑的队列（V2 设计 20.6）：假 claude 每一轮先要一次写文件的权限，所以开起来的会话停在「等你批准」（占位置），
// 批准后这一轮做完变 idle（让位）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { api, pair, raw, startTestRunner, tempDir, ORIGIN } from "./helpers.js";

const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 8_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** 假 claude 每次拉起记一行 argv：按先后取出新开（--session-id）的会话。 */
const started = (work: string) => existsSync(join(work, ".fake-claude-trace.jsonl"))
  ? readFileSync(join(work, ".fake-claude-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((l) => l.argv?.includes("--session-id")).map((l) => l.argv[l.argv.indexOf("--session-id") + 1] as string)
  : [];
const statusItems = (dataDir: string, id: string) => JSON.parse(readFileSync(join(dataDir, "outbox.json"), "utf8")).entries
  .map((e: any) => e.item).filter((i: any) => i.sessionId === id && i.type === "status").map((i: any) => i.data);

const sub = (work: string, name: string) => { mkdirSync(join(work, name), { recursive: true }); return join(work, name); };

async function setup(max: number, reuse?: { dataDir: string; work: string; token: string }) {
  const work = reuse?.work ?? tempDir("tl-work-");
  const t = await startTestRunner({ pickFolder: work, fetchImpl: offline, dataDir: reuse?.dataDir });
  const token = reuse?.token ?? await pair(t.port);
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  if (!reuse) {
    await call("POST", "/v1/folders/pick", {});
    expect((await call("PATCH", "/v1/settings", { maxConcurrent: max })).body.maxConcurrent).toBe(max);
    writeFileSync(join(work, ".fake-claude.json"), "{}"); // 各卡的子文件夹共用这份配置，记录也写在这儿
  }
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body;
  const status = async (id: string) => (await session(id)).session.status as string;
  // 每张卡一个子文件夹：不是 git 仓库的同一个文件夹同时只做一张卡（ADR 0038），这里测的是位置和队列
  const item = (title: string) => ({ subject: { kind: "card", cardId: title }, title, cwd: sub(work, title), firstMessage: `做 ${title}` });
  const open = async (title: string) => (await call("POST", "/v1/sessions", item(title))).body;
  const slots = async () => (await raw(t.port, { path: "/v1/health", headers: { origin: ORIGIN } })).body.slots;
  const waitStatus = (id: string, want: string) => until(async () => (await status(id)) === want);
  const allow = async (id: string) => {
    const s = await until(async () => { const b = await session(id); return b.pendingPermissions[0] ? b : null; });
    return call("POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(s.pendingPermissions[0].requestId)}`, { decision: "allow" });
  };
  return { t, token, work, call, session, status, item, open, slots, waitStatus, allow };
}

// 每条要拉起几个假 claude 进程，机器忙时单条要好几秒：显式给 30 秒，不靠 vitest 默认的 5 秒或 package.json 里的参数
describe("同时跑的上限和队列", { timeout: 30_000 }, () => {
  it("上限 2、一批 4 件（夹一件开不了的）：前 2 件马上开，后 2 件排队；强停、一轮做完都让位，先来先跑", async () => {
    const h = await setup(2);
    try {
      const bad = { ...h.item("X"), cwd: tempDir("tl-other-") };
      const r = await h.call("POST", "/v1/sessions/batch", { items: [h.item("A"), h.item("B"), bad, h.item("C"), h.item("D")] });
      expect(r.status).toBe(200);
      const res = r.body.results;
      expect(res.map((x: any) => x.ok)).toEqual([true, true, false, true, true]);
      expect(res[2].error.code).toBe("folder_not_allowed"); // 开不了的那件不留记录，也不占队里的位置
      const [a, b, c, d] = [res[0], res[1], res[3], res[4]].map((x: any) => x.session);
      expect([a.status, b.status]).toEqual(["running", "running"]);
      expect([c.status, c.queuePosition, d.status, d.queuePosition]).toEqual(["queued", 1, "queued", 2]);
      await h.waitStatus(a.id, "waiting_permission");
      await h.waitStatus(b.id, "waiting_permission"); // 等你批准也占位置
      expect(await h.slots()).toEqual({ max: 2, running: 2, queued: 2 });
      expect((await h.call("GET", "/v1/status")).body.slots).toEqual({ max: 2, running: 2, queued: 2 });

      // 强停 A：C 接上，D 变成排第 1
      await h.call("POST", `/v1/sessions/${a.id}/kill`, {});
      await h.waitStatus(c.id, "waiting_permission");
      expect((await h.session(d.id)).session).toMatchObject({ status: "queued", queuePosition: 1 });

      // B 这一轮做完（idle，等你回复，不占位置）：D 接上
      await h.allow(b.id);
      await h.waitStatus(d.id, "waiting_permission");
      expect(await h.status(b.id)).toBe("idle");
      expect(await h.slots()).toEqual({ max: 2, running: 2, queued: 0 });

      // 先来先跑：拉起的先后就是开工的先后；排着的第一句话在真开始时才送出
      expect(started(h.work)).toEqual([a.id, b.id, c.id, d.id]);
      const ev = await h.call("GET", `/v1/sessions/${d.id}`);
      expect(ev.body.session.queuePosition).toBeNull();

      // 上报云端：排着时带排第几，前面的走了就重报新位置
      const dItems = statusItems(h.t.dataDir, d.id);
      expect(dItems.filter((x: any) => x.status === "queued").map((x: any) => x.queuePosition)).toEqual([2, 1]);
      expect(dItems.map((x: any) => x.status)).toEqual(["queued", "queued", "starting", "running", "waiting_permission"]);
      expect(statusItems(h.t.dataDir, c.id).filter((x: any) => x.status !== "queued").every((x: any) => x.queuePosition === undefined)).toBe(true);
    } finally {
      await h.t.cleanup();
    }
  });

  it("排着的：不能说话；停下、强停都是取消（出队、后面的往前挪），取消后也不能续", async () => {
    const h = await setup(1);
    try {
      const a = await h.open("A");
      const b = await h.open("B");
      const c = await h.open("C");
      expect([b.status, b.queuePosition, c.queuePosition]).toEqual(["queued", 1, 2]);
      const say = await h.call("POST", `/v1/sessions/${b.id}/messages`, { text: "插一句" });
      expect([say.status, say.body.error.code]).toEqual([409, "conflict"]);

      await h.call("POST", `/v1/sessions/${b.id}/interrupt`, {});
      expect(await h.status(b.id)).toBe("exited");
      expect((await h.session(c.id)).session.queuePosition).toBe(1);
      await h.call("POST", `/v1/sessions/${c.id}/kill`, {});
      expect(await h.status(c.id)).toBe("exited");
      expect((await h.call("POST", `/v1/sessions/${b.id}/messages`, { text: "接着" })).status).toBe(409);
      expect(await h.slots()).toEqual({ max: 1, running: 1, queued: 0 });

      // A 结束后没有排着的，不再拉起别的
      await h.call("POST", `/v1/sessions/${a.id}/kill`, {});
      await h.waitStatus(a.id, "exited");
      await new Promise((r) => setTimeout(r, 200));
      expect(started(h.work)).toEqual([a.id]);
    } finally {
      await h.t.cleanup();
    }
  });

  it("调大上限立刻接上；调小不打断在跑的；暂停时不接、也不收新开工", async () => {
    const h = await setup(1);
    try {
      const a = await h.open("A");
      const b = await h.open("B");
      expect(b.status).toBe("queued");
      await h.call("PATCH", "/v1/settings", { maxConcurrent: 2 });
      await h.waitStatus(b.id, "waiting_permission");
      await h.call("PATCH", "/v1/settings", { maxConcurrent: 1 });
      expect([await h.status(a.id), await h.status(b.id)]).toEqual(["waiting_permission", "waiting_permission"]);
      const c = await h.open("C");
      expect(c.status).toBe("queued");

      // 暂停：在跑的停下（这一轮结束，变 idle，让出位置），但排着的不接
      await h.call("PATCH", "/v1/settings", { paused: true });
      await h.waitStatus(a.id, "idle");
      await h.waitStatus(b.id, "idle");
      await new Promise((r) => setTimeout(r, 200));
      expect(await h.status(c.id)).toBe("queued");
      expect((await h.call("POST", "/v1/sessions", h.item("D"))).status).toBe(409);
    } finally {
      await h.t.cleanup();
    }
  });

  it("本机程序重启：排着的照原样排着（刚拉起没开始的放回原位），有空位就接上，用新开不用续接", async () => {
    const first = await setup(1);
    const { dataDir } = first.t;
    const a = await first.open("A");
    const r = await first.call("POST", "/v1/sessions/batch", { items: ["B", "C", "D"].map((x) => first.item(x)) });
    const [b, c, d] = r.body.results.map((x: any) => x.session);
    expect([b, c, d].map((x: any) => x.queuePosition)).toEqual([1, 2, 3]);
    await first.waitStatus(a.id, "waiting_permission");
    await first.t.runner.close(); // 关机：A 被杀，但排着的不接
    expect(JSON.parse(readFileSync(join(dataDir, "sessions", b.id, "session.json"), "utf8")).status).toBe("queued");
    expect(started(first.work)).toEqual([a.id]);
    // 模拟上次刚从队里拉起 C、还没开始就断电
    const cFile = join(dataDir, "sessions", c.id, "session.json");
    writeFileSync(cFile, JSON.stringify({ ...JSON.parse(readFileSync(cFile, "utf8")), status: "starting" }));

    const h = await setup(1, { dataDir, work: first.work, token: first.token });
    try {
      expect(await h.status(a.id)).toBe("exited");
      await h.waitStatus(b.id, "waiting_permission");
      expect((await h.session(c.id)).session).toMatchObject({ status: "queued", queuePosition: 1 });
      expect((await h.session(d.id)).session).toMatchObject({ status: "queued", queuePosition: 2 });
      expect(await h.slots()).toEqual({ max: 1, running: 1, queued: 2 });
      await h.call("POST", `/v1/sessions/${b.id}/kill`, {});
      await h.waitStatus(c.id, "waiting_permission");
      expect(started(h.work)).toEqual([a.id, b.id, c.id]); // 都是新开（--session-id），不是 --resume
    } finally {
      await h.t.cleanup();
    }
  });
});
