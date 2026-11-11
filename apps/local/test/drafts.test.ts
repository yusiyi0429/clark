// 子会话「正在写」的草稿（契约 LocalSessionDraft）：只推给带 ?drafts=1 在看的网页，合并、不写盘、不占编号。
import http from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalSessionDraft, type TLocalSessionDraft } from "@warmap/contracts";
import { Drafts } from "../src/drafts.js";
import { registerFormats } from "../src/store.js";
import { codexProfileId } from "../src/codexCatalog.js";
import { api, pair, startTestRunner, tempDir, ORIGIN } from "./helpers.js";

registerFormats();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await sleep(25);
  }
}

describe("草稿合并", () => {
  it("第一条马上发，之后每 80 毫秒至多一条，最后一条一定发出去；写完了（done）还没发的不发；空串只在发过草稿后才发", async () => {
    const d = new Drafts(80);
    const got: { text: string; at: number }[] = [];
    const t0 = Date.now();
    d.subscribe("s", (x) => got.push({ text: x.text, at: Date.now() - t0 }));
    d.set("s", "一");
    expect(got.map((g) => g.text)).toEqual(["一"]);
    for (const s of ["一二", "一二三", "一二三四"]) d.set("s", s);
    expect(got).toHaveLength(1);
    await sleep(120);
    expect(got.map((g) => g.text)).toEqual(["一", "一二三四"]);
    expect(got[1]!.at).toBeGreaterThanOrEqual(70);
    // 写完了：还没发的不再发
    await sleep(100);
    d.set("s", "一二三四五");
    d.set("s", "一二三四五六");
    d.done("s");
    await sleep(120);
    expect(got.map((g) => g.text)).toEqual(["一", "一二三四", "一二三四五"]);
    // 这一段写完以后没写新的：空串不发
    d.set("s", "");
    await sleep(100);
    expect(got).toHaveLength(3);
    // 写了一半不写了：发空串清掉
    d.done("s");
    d.set("s", "新的一段");
    await sleep(100);
    d.set("s", "");
    await sleep(100);
    expect(got.slice(3).map((g) => g.text)).toEqual(["新的一段", ""]);
  });
});

interface Frame { event: string | null; id: string | null; data: any }
const lastDraftAt = (frames: Frame[]) => frames.map((f) => f.event === "draft").lastIndexOf(true);

/** 读事件流（原始 SSE 帧），until 满足就断开。 */
function readFrames(port: number, token: string, path: string, until: (frames: Frame[]) => boolean, ms = 15_000): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    let buf = "";
    let done = false;
    const req = http.request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, origin: ORIGIN, "x-tianshu-local-token": token } }, (res) => {
      res.setEncoding("utf8").on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(":")) continue;
          const f: Frame = { event: null, id: null, data: null };
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) f.event = line.slice(7);
            else if (line.startsWith("id: ")) f.id = line.slice(4);
            else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
          }
          frames.push(f);
        }
        // 满足以后再多读 200 毫秒：晚到的草稿（不该有）也看得到
        if (!done && until(frames)) { done = true; clearTimeout(timer); setTimeout(() => { req.destroy(); resolve(frames); }, 200); }
      });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`等待超时：${JSON.stringify(frames.map((f) => f.data?.type))}`)); }, ms);
    req.on("error", (e) => { if (!req.destroyed) reject(e); });
    req.end();
  });
}

describe("子会话的草稿", { timeout: 60_000 }, () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const work = tempDir("tl-draft-");
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body.session;
  const events = (id: string) => readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const idle = (id: string) => until(async () => (await session(id)).status === "idle");
  const open = async (name: string, extra: Record<string, unknown> = {}) => {
    mkdirSync(join(work, name), { recursive: true });
    const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: name }, title: name, cwd: join(work, name), firstMessage: "hi", permissionMode: "auto", ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await idle(r.body.id);
    return r.body.id as string;
  };
  const fake = (name: string, cfg: object) => writeFileSync(join(work, name, ".fake-claude.json"), JSON.stringify(cfg));
  /** 开着事件流（带不带草稿）说一句，读到这一轮结束。 */
  const sayAndRead = async (id: string, text: string, drafts: boolean) => {
    const after = events(id).at(-1).seq;
    const reading = readFrames(t.port, token, `/v1/sessions/${id}/events?after=${after}${drafts ? "&drafts=1" : ""}`, (f) => f.some((x) => x.data?.type === "turn_end"));
    await sleep(50);
    expect((await call("POST", `/v1/sessions/${id}/messages`, { text })).status).toBe(200);
    return reading;
  };
  const draftsOf = (frames: Frame[]) => frames.filter((f) => f.event === "draft").map((f) => f.data as TLocalSessionDraft);

  beforeAll(async () => {
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    t = await startTestRunner({ pickFolder: work, fetchImpl: offline, fakeCodex: true });
    token = await pair(t.port);
    await call("POST", "/v1/folders/pick", {});
  });
  afterAll(() => t.cleanup());

  it("Claude Code：开着逐字输出；只报正文的字（思考、子 agent、工具参数不报），合并着推，帧没有编号，不进事件文件；写完的那段以 assistant_text 为准", async () => {
    const id = await open("C1");
    const argv = (readFileSync(join(work, "C1", ".fake-claude-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l: any) => l.argv).at(-1).argv) as string[];
    expect(argv).toContain("--include-partial-messages");
    fake("C1", { stream: { ms: 5 } });
    const text = "把这一段话一个字一个字地写出来，看看网页上是不是边写边出现，而不是一整段突然冒出来";
    const full = `正在写：${text}`;
    const frames = await sayAndRead(id, text, true);
    const drafts = draftsOf(frames);
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    expect(drafts.length).toBeLessThan([...full].length / 2); // 合并过：远少于字数
    for (const d of drafts) {
      expect(Value.Check(LocalSessionDraft, d)).toBe(true);
      expect(d.sessionId).toBe(id);
      expect(full.startsWith(d.text)).toBe(true);
    }
    expect(drafts.map((d) => d.text.length)).toEqual([...drafts.map((d) => d.text.length)].sort((a, b) => a - b));
    expect(frames.filter((f) => f.event === "draft").every((f) => f.id === null)).toBe(true);
    // 写完的那段：assistant_text 在最后一条草稿之后，之后不再有草稿
    const textAt = frames.findIndex((f) => f.data?.type === "assistant_text" && f.data.text === full);
    expect(textAt).toBeGreaterThan(lastDraftAt(frames));
    // 事件文件里没有草稿，编号连着
    const ev = events(id);
    expect(ev.some((e) => e.type === "draft")).toBe(false);
    expect(ev.map((e) => e.seq)).toEqual(ev.map((_, i) => i + 1));
    const texts = new Set(ev.map((e) => e.text));
    expect(drafts.filter((d) => d.text !== full).some((d) => texts.has(d.text))).toBe(false); // 半截的字一条都没写盘
    // 不带 drafts=1：照旧只推事件
    expect(draftsOf(await sayAndRead(id, "再写一段", false))).toEqual([]);
  });

  it("Claude Code：写到一半这一轮出错了，草稿以空串清掉", async () => {
    const id = await open("C2");
    fake("C2", { stream: { ms: 5, cut: true } });
    const frames = await sayAndRead(id, "这一段写不完就断了，草稿要清掉，不能一直挂在页面上", true);
    const drafts = draftsOf(frames);
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    expect(drafts.at(-1)!.text).toBe("");
    expect(frames.some((f) => f.data?.type === "assistant_text" && String(f.data.text).startsWith("正在写："))).toBe(false);
  });

  it("Codex：item/agentMessage/delta 当草稿推；写完以 assistant_text 为准；写到一半出错清掉", async () => {
    await call("POST", "/v1/agents/codex/login", {});
    const SOL = codexProfileId("gpt-6.1-sol");
    await until(async () => (await call("GET", "/v1/models")).body.profiles.some((p: any) => p.id === SOL));
    const id = await open("X1", { modelProfileId: SOL });
    const text = "stream 一个字一个字写出来的这一段话，在网页上应该边写边出现，而不是一整段突然冒出来";
    const frames = await sayAndRead(id, text, true);
    const drafts = draftsOf(frames);
    expect(drafts.length).toBeGreaterThanOrEqual(2);
    expect(drafts.length).toBeLessThan([...text].length / 2);
    for (const d of drafts) expect(text.startsWith(d.text)).toBe(true);
    expect(frames.findIndex((f) => f.data?.type === "assistant_text" && f.data.text === text)).toBeGreaterThan(lastDraftAt(frames));
    expect(events(id).some((e) => e.type === "draft")).toBe(false);

    const cut = draftsOf(await sayAndRead(id, "streamcut 这一段写到一半就断了，草稿要清掉，不能一直挂在页面上", true));
    expect(cut.length).toBeGreaterThanOrEqual(1);
    expect(cut.at(-1)!.text).toBe("");
  });
});
