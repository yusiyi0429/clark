// 压缩上下文（本人 11/18 选的「圆环点开能压缩」，契约 POST /v1/sessions/:id/compact）：假 claude、假 codex，不调模型。
// 压缩不算一轮：不记成本人说的一句、不报做完一轮（没有 turn_end、没有 stopped 同步条目），压完报新的用量。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalSessionEvent, LocalSessionSummary } from "@warmap/contracts";
import { registerFormats } from "../src/store.js";
import { codexProfileId } from "../src/codexCatalog.js";
import { api, pair, startTestRunner, tempDir } from "./helpers.js";

registerFormats();
async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

const SOL = codexProfileId("gpt-6.1-sol");

describe("压缩上下文", { timeout: 60_000 }, () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-compact-");
  const dataDir = tempDir("tl-compact-data-");
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body;
  const events = (id: string) => readFileSync(join(dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  /** 发件箱里这个会话的同步条目（没关联云端，都还排着）。 */
  const synced = (id: string) => (JSON.parse(readFileSync(join(dataDir, "outbox.json"), "utf8")).entries as { item: any }[]).map((e) => e.item).filter((i) => i.sessionId === id);
  const turnsFile = join(work, ".fake-claude-turns.jsonl");
  const fakeTurns = () => (existsSync(turnsFile) ? readFileSync(turnsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const codexTrace = () => readFileSync(join(dataDir, "codex", "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const fake = (cfg: Record<string, unknown>) => writeFileSync(join(work, ".fake-claude.json"), JSON.stringify(cfg));
  const open = async (name: string, firstMessage: string, extra: Record<string, unknown> = {}) => {
    mkdirSync(join(work, name), { recursive: true });
    const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: name }, title: name, cwd: join(work, name), firstMessage, permissionMode: "auto", ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.id as string;
  };
  const idle = (id: string) => until(async () => { const s = (await session(id)).session; return s.status === "idle" && s.context ? s : null; });
  /** 压缩前后比一比：压缩没留下一轮的痕迹，也没报给云端做完一轮。 */
  const noTurn = (id: string, before: { events: number; synced: number }) => {
    const after = events(id).slice(before.events);
    expect(after.every((e) => Value.Check(LocalSessionEvent, e))).toBe(true);
    expect(after.filter((e) => ["user_message", "agent_info", "turn_end", "status"].includes(e.type))).toEqual([]);
    expect(synced(id).slice(before.synced).filter((i) => i.type === "stopped" || i.type === "user_message" || i.type === "status")).toEqual([]);
    return after;
  };
  const mark = (id: string) => ({ events: events(id).length, synced: synced(id).length });

  beforeAll(async () => {
    mkdirSync(join(dataDir, "codex"), { recursive: true });
    writeFileSync(join(dataDir, "codex", "auth.json"), "{}");
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    t = await startTestRunner({ dataDir, pickFolder: work, fetchImpl: offline, fakeCodex: true });
    token = await pair(t.port);
    await call("POST", "/v1/folders/pick", {});
    fake({});
    await until(async () => (await call("GET", "/v1/models")).body.profiles.some((p: any) => p.id === SOL));
  });
  afterAll(() => t.cleanup());

  it("压缩：Claude Code 发 /compact，不记成本人一句、不报做完一轮", async () => {
    fake({ context: { totalTokens: 500_000, maxTokens: 1_000_000 }, compactTo: { totalTokens: 30_000, maxTokens: 1_000_000 } });
    const id = await open("A", "做 A");
    expect((await idle(id)).context).toMatchObject({ usedTokens: 500_000, maxTokens: 1_000_000 });
    const before = mark(id);
    const r = await call("POST", `/v1/sessions/${id}/compact`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Value.Check(LocalSessionSummary, r.body.session)).toBe(true);
    // 压完回来时已经是新的用量，状态还是等你回复
    expect(r.body.session).toMatchObject({ status: "idle", context: { usedTokens: 30_000, maxTokens: 1_000_000 } });
    expect(fakeTurns().filter((x) => x.compact)).toHaveLength(1);
    const after = noTurn(id, before);
    expect(after.filter((e) => e.type === "notice" && e.code === "context_compacted")).toHaveLength(1);
    expect(after.filter((e) => e.type === "context_usage").at(-1)).toMatchObject({ usedTokens: 30_000, maxTokens: 1_000_000 });
    // 压缩花的照记进用量、报给云端（cost 条目，只是累计）
    expect(synced(id).slice(before.synced).filter((i) => i.type === "cost")).toHaveLength(1);
    // 之后说一句照常是新的一轮
    const said = await call("POST", `/v1/sessions/${id}/messages`, { text: "接着" });
    expect(said.body.delivery).toBe("new_turn");
    await until(() => events(id).filter((e) => e.type === "turn_end").length === 2);
    // 进程不在了（强停、本机程序重启）：先续接上再压，压完是等你回复
    await call("POST", `/v1/sessions/${id}/kill`, {});
    await until(async () => (await session(id)).session.status === "exited");
    const again = await call("POST", `/v1/sessions/${id}/compact`, {});
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.session.status).toBe("idle");
    expect(fakeTurns().filter((x) => x.compact)).toHaveLength(2);
    await call("POST", `/v1/sessions/${id}/kill`, {});
    fake({});
  });

  it("压缩：Codex 调 thread/compact/start", async () => {
    const id = await open("B", "ctx 150000", { modelProfileId: SOL });
    expect((await idle(id)).context).toMatchObject({ usedTokens: 150_000, maxTokens: 200_000 });
    const before = mark(id);
    const r = await call("POST", `/v1/sessions/${id}/compact`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.session).toMatchObject({ status: "idle", context: { usedTokens: 20_000, maxTokens: 200_000 } });
    expect(codexTrace().filter((l) => l.method === "thread/compact/start")).toHaveLength(1);
    expect(codexTrace().filter((l) => l.method === "turn/start")).toHaveLength(1); // 没另开一轮
    const after = noTurn(id, before);
    expect(after.filter((e) => e.type === "notice" && e.code === "context_compacted")).toHaveLength(1);
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });

  it("会话在跑一轮时拒绝压缩", async () => {
    fake({ work: { ms: 3_000 } });
    const id = await open("C", "做 C");
    await until(async () => (await session(id)).session.status === "running");
    const before = fakeTurns().filter((x) => x.compact).length;
    const r = await call("POST", `/v1/sessions/${id}/compact`, {});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("conflict");
    expect(fakeTurns().filter((x) => x.compact)).toHaveLength(before);
    // 压缩途中：再点不收（说一句等压完再送，见「压缩期间转来的话不丢」）
    fake({ compactMs: 500 });
    await call("POST", `/v1/sessions/${id}/interrupt`, {});
    await until(async () => (await session(id)).session.status === "idle");
    const compacting = call("POST", `/v1/sessions/${id}/compact`, {});
    await until(() => fakeTurns().filter((x) => x.compact).length > before);
    expect((await call("POST", `/v1/sessions/${id}/compact`, {})).status).toBe(409);
    expect((await compacting).status).toBe(200);
    await call("POST", `/v1/sessions/${id}/kill`, {});
    fake({});
  });

  it("手打 /compact 和点压缩一样处理", async () => {
    fake({ context: { totalTokens: 500_000, maxTokens: 1_000_000 }, compactTo: { totalTokens: 30_000, maxTokens: 1_000_000 } });
    const id = await open("D", "做 D");
    await idle(id);
    const before = mark(id);
    const compacts = fakeTurns().filter((x) => x.compact).length;
    const r = await call("POST", `/v1/sessions/${id}/messages`, { text: " /compact ", messageId: "11111111-1111-4111-8111-111111111111" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ delivery: "compact", messageId: "11111111-1111-4111-8111-111111111111" });
    await until(async () => (await session(id)).session.context?.usedTokens === 30_000);
    expect(fakeTurns().filter((x) => x.compact)).toHaveLength(compacts + 1);
    const after = noTurn(id, before);
    expect(after.filter((e) => e.type === "notice" && e.code === "context_compacted")).toHaveLength(1);
    // 在跑一轮时手打的也拒
    fake({ work: { ms: 3_000 } });
    await call("POST", `/v1/sessions/${id}/messages`, { text: "做点事" });
    await until(async () => (await session(id)).session.status === "running");
    expect((await call("POST", `/v1/sessions/${id}/messages`, { text: "/compact" })).status).toBe(409);
    // 别的斜杠开头的照旧原样送
    await call("POST", `/v1/sessions/${id}/interrupt`, {});
    await until(async () => (await session(id)).session.status === "idle");
    fake({});
    await call("POST", `/v1/sessions/${id}/messages`, { text: "/review" });
    await until(() => fakeTurns().some((x) => x.turnText === "/review"));
    await call("POST", `/v1/sessions/${id}/kill`, {});
  });

  it("/compact 带参数、大小写不同也按压缩处理", async () => {
    const id = await open("E", "做 E");
    await idle(id);
    const before = mark(id);
    // Claude Code：带着参数送进去（命令词写成小写）
    const r = await call("POST", `/v1/sessions/${id}/messages`, { text: "  /COMPACT 只留结论和没做完的  " });
    expect(r.body.delivery).toBe("compact");
    await until(() => fakeTurns().some((x) => x.compact && x.text === "/compact 只留结论和没做完的"));
    await until(() => events(id).some((e) => e.type === "notice" && e.code === "context_compacted"));
    noTurn(id, before);
    // 只是开头像的不算
    await until(async () => !(await session(id)).session.compacting && (await session(id)).session.status === "idle");
    expect((await call("POST", `/v1/sessions/${id}/messages`, { text: "/compactx" })).body.delivery).toBe("new_turn");
    await until(() => fakeTurns().some((x) => x.turnText === "/compactx"));
    await call("POST", `/v1/sessions/${id}/kill`, {});
    // Codex：不管参数，照样调 thread/compact/start
    const cx = await open("F", "ctx 150000", { modelProfileId: SOL });
    await idle(cx);
    const starts = codexTrace().filter((l) => l.method === "thread/compact/start").length;
    const turns = codexTrace().filter((l) => l.method === "turn/start").length;
    expect((await call("POST", `/v1/sessions/${cx}/messages`, { text: "/Compact keep it short" })).body.delivery).toBe("compact");
    await until(() => codexTrace().filter((l) => l.method === "thread/compact/start").length === starts + 1);
    await until(() => events(cx).some((e) => e.type === "notice" && e.code === "context_compacted"));
    expect(codexTrace().filter((l) => l.method === "turn/start")).toHaveLength(turns);
    await call("POST", `/v1/sessions/${cx}/kill`, {});
  });

  it("压缩中能停", async () => {
    fake({ compactMs: 5_000 });
    const id = await open("G", "做 G");
    await idle(id);
    const compacts = fakeTurns().filter((x) => x.compact).length;
    const compacting = call("POST", `/v1/sessions/${id}/compact`, {});
    await until(() => fakeTurns().filter((x) => x.compact).length > compacts);
    // 压缩中：摘要和事件流里都报着（网页据此当成在忙、出停止按钮）
    expect((await session(id)).session.compacting).toBe(true);
    expect(events(id).filter((e) => e.type === "compacting").map((e) => e.on)).toEqual([true]);
    const t0 = Date.now();
    const stopped = await call("POST", `/v1/sessions/${id}/interrupt`, {});
    expect(stopped.status).toBe(200);
    const r = await compacting;
    expect(Date.now() - t0).toBeLessThan(4_000); // 没等到压完
    expect(r.status).toBe(409);
    const s = (await session(id)).session;
    expect(s.compacting).toBeUndefined();
    expect(s.status).toBe("idle");
    expect(events(id).filter((e) => e.type === "compacting").map((e) => e.on)).toEqual([true, false]);
    expect(events(id).some((e) => e.type === "turn_end" && e.errorKind === "interrupted")).toBe(false);
    await call("POST", `/v1/sessions/${id}/kill`, {});
    fake({});
  });

  it("压缩期间转来的话不丢，压完照常送到", async () => {
    fake({ compactMs: 800 });
    const id = await open("H", "做 H");
    await idle(id);
    const compacts = fakeTurns().filter((x) => x.compact).length;
    const compacting = call("POST", `/v1/sessions/${id}/compact`, {});
    await until(() => fakeTurns().filter((x) => x.compact).length > compacts);
    // 主管线转来的话（网页调 POST messages）：不回 409，压完再送
    const said = await call("POST", `/v1/sessions/${id}/messages`, { text: "转来的话" });
    expect(said.status, JSON.stringify(said.body)).toBe(200);
    expect(said.body.delivery).toBe("new_turn");
    expect((await compacting).status).toBe(200);
    await until(() => fakeTurns().some((x) => x.turnText === "转来的话"));
    const ev = events(id);
    // 先压完，再记这一句、开这一轮
    expect(ev.findIndex((e) => e.type === "compacting" && !e.on)).toBeLessThan(ev.findIndex((e) => e.type === "user_message" && e.text === "转来的话"));
    await call("POST", `/v1/sessions/${id}/kill`, {});
    fake({});
  });

  it("同一条转话命令被认领两次，本机只送一次", async () => {
    // 压缩时转话挂着等；租期过了另一个标签页又认领，带着同一个编号（命令编号）再送一次：本机只记一句、只送一次
    fake({ compactMs: 800 });
    const id = await open("K", "做 K");
    await idle(id);
    const compacts = fakeTurns().filter((x) => x.compact).length;
    const compacting = call("POST", `/v1/sessions/${id}/compact`, {});
    await until(() => fakeTurns().filter((x) => x.compact).length > compacts);
    const messageId = "22222222-2222-4222-8222-222222222222";
    const [a, b] = await Promise.all([1, 2].map(() => call("POST", `/v1/sessions/${id}/messages`, { text: "转来的一句", messageId })));
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body).toEqual(a.body);
    await compacting;
    await until(() => fakeTurns().some((x) => x.turnText === "转来的一句"));
    await new Promise((r) => setTimeout(r, 300));
    expect(events(id).filter((e) => e.type === "user_message" && e.text === "转来的一句")).toHaveLength(1);
    expect(fakeTurns().filter((x) => x.turnText === "转来的一句" || x.interjection === "转来的一句")).toHaveLength(1);
    // 送到以后再认领一次也不再送
    expect((await call("POST", `/v1/sessions/${id}/messages`, { text: "转来的一句", messageId })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(events(id).filter((e) => e.type === "user_message" && e.text === "转来的一句")).toHaveLength(1);
    await call("POST", `/v1/sessions/${id}/kill`, {});
    fake({});
  });

  it("有后台任务在跑时拒绝压缩", async () => {
    fake({ background: true, agentMs: 60_000 });
    const id = await open("I", "做 I");
    await until(async () => { const s = (await session(id)).session; return s.status === "idle" && s.background?.some((b: any) => b.state === "running"); });
    const compacts = fakeTurns().filter((x) => x.compact).length;
    const r = await call("POST", `/v1/sessions/${id}/compact`, {});
    expect([r.status, r.body.error?.code]).toEqual([409, "conflict"]);
    expect((await call("POST", `/v1/sessions/${id}/messages`, { text: "/compact" })).status).toBe(409);
    expect(fakeTurns().filter((x) => x.compact)).toHaveLength(compacts);
    await call("POST", `/v1/sessions/${id}/kill`, {});
    // 停着等额度的也不压（额度恢复时本机会往会话里送「接着做」，不和压缩撞在一起）
    fake({ usageLimit: { resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
    const held = await open("J", "做 J");
    await until(async () => (await session(held)).session.hold);
    expect((await call("POST", `/v1/sessions/${held}/compact`, {})).status).toBe(409);
    expect(fakeTurns().filter((x) => x.compact)).toHaveLength(compacts);
    await call("POST", `/v1/sessions/${held}/kill`, {});
    fake({});
  });
});
