// 11/11 定（修法 B）：没有活着的进程时，本人说的一句先进事件流，再拉起执行方；拉起失败这句记没送达。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, pair, startTestRunner, tempDir, waitFor } from "./helpers.js";

describe("发话：先记下再拉起", () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-work-");
  const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  beforeAll(async () => { t = await startTestRunner({ pickFolder: work, fetchImpl: offline }); token = await pair(t.port); await api(t.port, token, "POST", "/v1/folders/pick", {}); });
  afterAll(async () => { await t.cleanup(); });

  const events = (id: string) => readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const status = async (id: string) => (await api(t.port, token, "GET", `/v1/sessions/${id}`)).body.session.status as string;
  const exited = async () => {
    const s = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c" }, title: "x", cwd: work, firstMessage: "hi" });
    expect(s.status).toBe(200);
    const id = s.body.id as string;
    await api(t.port, token, "POST", `/v1/sessions/${id}/kill`, {});
    for (let i = 0; i < 250 && (await status(id)) !== "exited"; i++) await new Promise((r) => setTimeout(r, 20));
    return id;
  };
  /** 换掉 Claude Code 适配器的拉起（测完换回）。 */
  const withStart = async (start: (orig: (o: unknown) => Promise<unknown>, o: unknown) => Promise<unknown>, body: () => Promise<void>) => {
    const adapter = (t.runner.sessions as any).d.adapters["claude-code"];
    const orig = adapter.start;
    adapter.start = (o: unknown) => start((x) => orig.call(adapter, x), o);
    try { await body(); } finally { adapter.start = orig; }
  };

  it("拉起慢：user_message 在拉起完成前就进了事件流，拉起后照常送到", async () => {
    const id = await exited();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = false;
    await withStart(async (orig, o) => { await gate; const run = await orig(o); started = true; return run; }, async () => {
      const msg = api(t.port, token, "POST", `/v1/sessions/${id}/messages`, { text: "接着做" });
      const said = await waitFor(() => events(id).find((e) => e.type === "user_message" && e.text === "接着做"));
      expect(started).toBe(false);
      // 拉起期间是「启动中」
      expect(await status(id)).toBe("starting");
      release();
      const r = await msg;
      expect(r.body).toEqual({ delivery: "resumed", messageId: said.messageId });
      expect(said.source).toBe("web");
      // 这句 → 启动中 → 送出去以后进行中
      const after = events(id).filter((e) => e.seq > said.seq && e.type === "status").map((e) => e.status);
      expect(after.slice(0, 2)).toEqual(["starting", "running"]);
      await waitFor(() => events(id).some((e) => e.type === "assistant_text" && String(e.text).includes("接着做")));
      expect(events(id).some((e) => e.type === "receipt" && e.messageId === said.messageId && e.state === "failed")).toBe(false);
    });
    await api(t.port, token, "POST", `/v1/sessions/${id}/kill`, {}); // 让出空位，下一条不排队
  });

  it("拉起失败：这句已经显示了，记一条 receipt failed，错误照样回给网页", async () => {
    const id = await exited();
    await withStart(async () => { throw new Error("拉不起来"); }, async () => {
      const r = await api(t.port, token, "POST", `/v1/sessions/${id}/messages`, { text: "再试一次" });
      expect(r.body.error).toEqual({ code: "internal", message: "拉不起来" });
      const ev = events(id);
      const said = ev.find((e) => e.type === "user_message" && e.text === "再试一次");
      expect(said).toBeTruthy();
      const failed = ev.filter((e) => e.type === "receipt" && e.messageId === said.messageId);
      expect(failed).toEqual([expect.objectContaining({ state: "failed" })]);
      expect(failed[0].seq).toBeGreaterThan(said.seq);
      // 启动中退回停了，写明原因
      expect(ev.filter((e) => e.type === "status").at(-1)).toMatchObject({ status: "exited", reason: "没接上：拉不起来；再发一句话会接着做" });
    });
  });

  it("网页带编号：重发同一个编号不再送一遍，回原来的结果；原来回的错误照样回；没记下就被拒的可以同号再发", async () => {
    const id = await exited();
    const send = (body: object) => api(t.port, token, "POST", `/v1/sessions/${id}/messages`, body);
    const said = (mid: string) => events(id).filter((e) => e.type === "user_message" && e.messageId === mid);

    // 拉起失败过的：同号重发回同一个错误，不再记、不再拉起
    const bad = "11111111-1111-4111-8111-111111111111";
    let starts = 0;
    await withStart(async () => { starts++; throw new Error("拉不起来"); }, async () => {
      expect((await send({ text: "一", messageId: bad })).body.error.message).toBe("拉不起来");
      expect((await send({ text: "一", messageId: bad })).body.error.message).toBe("拉不起来");
    });
    expect(starts).toBe(1);
    expect(said(bad)).toHaveLength(1);

    // 没记下就被拒（不是专题却要评审会）：不算记过，同号能再发
    const mid = "22222222-2222-4222-8222-222222222222";
    expect((await send({ kind: "review", messageId: mid })).status).toBe(400);
    expect(said(mid)).toHaveLength(0);
    // 同时来两次（网页超时重发）：只记一次、只送一次，两次回的一样
    const [a, b] = await Promise.all([send({ text: "二", messageId: mid }), send({ text: "二", messageId: mid })]);
    expect(a.body).toEqual({ delivery: "resumed", messageId: mid });
    expect(b.body).toEqual(a.body);
    // 过一会儿再重发：还是原来的结果
    expect((await send({ text: "二", messageId: mid })).body).toEqual(a.body);
    await waitFor(() => events(id).some((e) => e.type === "assistant_text" && String(e.text).includes("：二")));
    expect(said(mid)).toHaveLength(1);
    expect(events(id).filter((e) => e.type === "assistant_text" && String(e.text).includes("：二"))).toHaveLength(1);
    await api(t.port, token, "POST", `/v1/sessions/${id}/kill`, {});
  });
});
