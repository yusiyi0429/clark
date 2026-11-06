import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestApp, TEST_CEO, TEST_MEMBER } from "./helpers.js";

const rpc = (id: number, method: string) => ({ jsonrpc: "2.0", id, method });
const file = (name: string, text: string) => {
  const buffer = Buffer.from(text);
  return { title: name, fileName: name, mimeType: "text/markdown", size: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex"),
    contentBase64: buffer.toString("base64"), artifactId: `a-${randomUUID().slice(0, 8)}` };
};

async function fixture() {
  const storage = await mkdtemp(join(tmpdir(), "local-sync-"));
  const t = await createTestApp({ materialStorageDir: storage });
  const member = await t.memberCookie();
  const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: Record<string, unknown>) =>
    t.app.inject({ method, url, headers: { cookie: member, origin: t.publicOrigin }, ...(payload ? { payload } : {}) });
  const pair = async (deviceId: string, name = "我的电脑") => {
    const res = await call("POST", "/api/me/local-devices", { deviceId, name, os: "win32" });
    expect(res.statusCode).toBe(201);
    return res.json() as { device: { id: string; name: string }; token: string };
  };
  const task = async (title: string) => {
    const res = await call("POST", "/api/me/tasks", { clientId: randomUUID(), title, missionId: null, doneDefinition: "有方案文档\n有评审结论" });
    expect(res.statusCode).toBe(200);
    return res.json().id as string;
  };
  const sync = (token: string, deviceId: string, items: unknown[]) => t.app.inject({ method: "POST", url: "/api/local-runner/sync",
    headers: { authorization: `Bearer ${token}` }, payload: { deviceId, runnerVersion: "0.1.0", items } });
  /** 一个本机会话里的条目：序号就是幂等键的最后一段，时间按序号往后排。 */
  const session = (deviceId: string, subject: Record<string, unknown>, sessionId = randomUUID()) => ({
    sessionId,
    item: (seq: number, type: string, data: unknown) => ({ key: `${deviceId}:${sessionId}:${seq}`, sessionId, subject,
      occurredAt: new Date(Date.UTC(2026, 10, 6, 2, 0, seq)).toISOString(), type, data }),
  });
  return { t, call, pair, task, sync, session, close: async () => { await t.close(); await rm(storage, { recursive: true, force: true }); } };
}

describe("本机程序：设备令牌和单向上报", () => {
  it("配对建设备令牌：不占 5 把的名额、不在设置页列；不能连 MCP、不能当登录态；吊销、再配对后旧令牌立刻失效", async () => {
    const f = await fixture();
    try {
      const device = randomUUID();
      const first = await f.pair(device);
      expect(first.device).toMatchObject({ id: device, name: "我的电脑", os: "win32", appVersion: null, lastSyncAt: null });
      for (let i = 0; i < 5; i++) expect((await f.call("POST", "/api/me/tokens", { name: `工具${i}`, client: "codex", expiresInDays: null })).statusCode).toBe(200);
      expect((await f.call("GET", "/api/me/tokens")).json().tokens.map((token: { client: string }) => token.client)).not.toContain("local");
      expect((await f.call("GET", "/api/me/local-devices")).json().devices).toMatchObject([{ id: device, name: "我的电脑" }]);

      const mcp = await f.t.app.inject({ method: "POST", url: "/mcp/me", headers: { authorization: `Bearer ${first.token}`, accept: "application/json, text/event-stream" },
        payload: rpc(1, "tools/list") });
      expect(mcp.statusCode).toBe(401);
      expect((await f.t.app.inject({ method: "GET", url: "/api/me/home", headers: { authorization: `Bearer ${first.token}` } })).statusCode).toBe(401);
      expect((await f.sync(first.token, device, [f.session(device, { kind: "topic", topicId: randomUUID() }).item(1, "plan", { entries: [] })])).statusCode).toBe(200);

      const second = await f.pair(device, "改了名字");
      expect((await f.sync(first.token, device, [f.session(device, { kind: "topic", topicId: randomUUID() }).item(1, "plan", { entries: [] })])).statusCode).toBe(401);
      expect((await f.sync(second.token, randomUUID(), [f.session(device, { kind: "topic", topicId: randomUUID() }).item(1, "plan", { entries: [] })])).statusCode).toBe(403);
      expect((await f.call("GET", "/api/me/local-devices")).json().devices).toMatchObject([{ id: device, name: "改了名字", appVersion: "0.1.0" }]);
      expect((await f.call("DELETE", `/api/me/local-devices/${device}`)).statusCode).toBe(204);
      expect((await f.sync(second.token, device, [f.session(device, { kind: "topic", topicId: randomUUID() }).item(1, "plan", { entries: [] })])).statusCode).toBe(401);
      expect((await f.call("GET", "/api/me/local-devices")).json().devices).toEqual([]);
      expect((await f.call("DELETE", `/api/me/local-devices/${device}`)).statusCode).toBe(404);
    } finally { await f.close(); }
  });

  it("一次执行报上来：状态、计划、证据、产出、花费、交回都记下，卡变进行中；同一批再发一次只记一次", async () => {
    const f = await fixture();
    try {
      const device = randomUUID();
      const { token } = await f.pair(device);
      const cardId = await f.task("写方案");
      const s = f.session(device, { kind: "card", cardId });
      const doc = file("方案.md", "# 方案\n\n有题库打分结果");
      const items = [
        s.item(1, "status", { status: "starting", title: "写方案", agent: "claude-code", modelLabel: "订阅 · Opus" }),
        s.item(2, "status", { status: "running", title: "写方案", agent: "claude-code", modelLabel: "订阅 · Opus" }),
        s.item(3, "plan", { entries: [{ content: "读材料", status: "completed" }, { content: "写方案", status: "in_progress" }, { content: "自查", status: "pending" }] }),
        s.item(4, "evidence", { kind: "link", title: "PR #12", url: "https://github.com/x/y/pull/12" }),
        s.item(5, "artifact", doc),
        s.item(6, "cost", { modelLabel: "订阅 · Opus", usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 10, cacheWriteTokens: 0, costUsd: 0.12 } }),
        s.item(7, "handback", { summary: "方案写好了", criteria: [{ index: 1, result: "met", evidence: "方案.md" }, { index: 2, result: "partial", evidence: "评审还没开" }] }),
      ];
      const res = await f.sync(token, device, items);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ accepted: items.map((item) => item.key), rejected: [] });
      const again = await f.sync(token, device, items);
      expect(again.json()).toEqual({ accepted: items.map((item) => item.key), rejected: [] });

      const [run] = await f.t.sql("SELECT * FROM local_runs WHERE id=$1", [s.sessionId]);
      expect(run).toMatchObject({ owner_id: TEST_MEMBER.personId, device_id: device, kind: "card", task_id: cardId, state: "running", model_label: "订阅 · Opus",
        tokens: { input: 1200, output: 300, cacheRead: 10, cacheWrite: 0 }, last_seq: "7" });
      expect(Number(run.cost_usd)).toBeCloseTo(0.12);
      expect((run.timeline as { text: string }[]).map((entry) => entry.text)).toEqual(["开工（订阅 · Opus）", "交出：方案.md", "交回，等验收"]);
      expect(run.running_at).not.toBeNull();
      const outputs = await f.t.sql("SELECT kind,evidence_kind,title,url,mime,extracted_text FROM local_outputs WHERE run_id=$1 ORDER BY created_at", [s.sessionId]);
      expect(outputs).toMatchObject([{ kind: "evidence", evidence_kind: "link", url: "https://github.com/x/y/pull/12" },
        { kind: "artifact", title: "方案.md", mime: "text/markdown", extracted_text: "# 方案\n\n有题库打分结果" }]);
      const [handback] = await f.t.sql("SELECT attempt,status,criteria,claims,summary,jsonb_array_length(output_ids) AS outputs FROM card_handbacks WHERE task_id=$1", [cardId]);
      expect(handback).toMatchObject({ attempt: 1, status: "queued", criteria: ["有方案文档", "有评审结论"], summary: "方案写好了", outputs: 2,
        claims: [{ index: 1, result: "met", evidence: "方案.md" }, { index: 2, result: "partial", evidence: "评审还没开" }] });
      expect((await f.t.sql("SELECT status,executor FROM tasks WHERE id=$1", [cardId]))[0]).toEqual({ status: "in_progress", executor: "claude_code" });
      const output = (await f.t.sql("SELECT id FROM local_outputs WHERE kind='artifact'"))[0].id as string;
      const opened = await f.call("GET", `/api/me/local-outputs/${output}`);
      expect(opened.statusCode).toBe(200);
      expect(opened.headers["content-security-policy"]).toBe("sandbox");
      expect(opened.body).toContain("有题库打分结果");
    } finally { await f.close(); }
  });

  it("晚到的旧状态和旧计划丢掉；不是本人的卡、对不上的文件、乱写的幂等键永久拒收；已完成的卡状态不被改回去", async () => {
    const f = await fixture();
    try {
      const device = randomUUID();
      const { token } = await f.pair(device);
      const cardId = await f.task("写方案");
      const s = f.session(device, { kind: "card", cardId });
      await f.sync(token, device, [s.item(4, "status", { status: "idle", title: "写方案", agent: "claude-code", modelLabel: "订阅" }),
        s.item(5, "plan", { entries: [{ content: "新计划", status: "in_progress" }] })]);
      await f.sync(token, device, [s.item(2, "status", { status: "running", title: "写方案", agent: "claude-code", modelLabel: "订阅" }),
        s.item(3, "plan", { entries: [{ content: "旧计划", status: "in_progress" }] })]);
      expect((await f.t.sql("SELECT state,plan FROM local_runs WHERE id=$1", [s.sessionId]))[0]).toEqual({ state: "idle", plan: [{ content: "新计划", status: "in_progress" }] });

      const theirs = randomUUID();
      await f.t.sql("INSERT INTO tasks(id,title,owner_id,created_by,status) VALUES($1,'别人的','" + TEST_CEO.personId + "','self','not_started')", [theirs]);
      const other = f.session(device, { kind: "card", cardId: theirs });
      const broken = { ...file("坏.md", "内容"), sha256: "0".repeat(64) };
      const res = await f.sync(token, device, [other.item(1, "plan", { entries: [] }), s.item(6, "artifact", broken),
        { ...s.item(7, "plan", { entries: [] }), key: `${device}:${randomUUID()}:7` }, s.item(8, "artifact", { ...file("表.xlsx", "x"), fileName: "表.xlsx" })]);
      expect(res.json().accepted).toEqual([]);
      expect(res.json().rejected.map((item: { code: string }) => item.code)).toEqual(["NOT_OWNER", "CHECKSUM_MISMATCH", "INVALID_KEY", "UNSUPPORTED_TYPE"]);
      expect(await f.t.sql("SELECT 1 FROM local_runs WHERE id=$1", [other.sessionId])).toEqual([]);
      expect(await f.t.sql("SELECT 1 FROM local_outputs")).toEqual([]);

      await f.t.sql("UPDATE tasks SET status='done' WHERE id=$1", [cardId]);
      const later = f.session(device, { kind: "card", cardId });
      await f.sync(token, device, [later.item(1, "status", { status: "running", title: "写方案", agent: "claude-code", modelLabel: "订阅" }),
        later.item(2, "handback", { summary: "又改了一点", criteria: [] })]);
      expect((await f.t.sql("SELECT status FROM tasks WHERE id=$1", [cardId]))[0].status).toBe("done");
      expect((await f.t.sql("SELECT state FROM local_runs WHERE id=$1", [later.sessionId]))[0].state).toBe("running");
      expect((await f.t.sql("SELECT status FROM card_handbacks WHERE task_id=$1", [cardId]))[0].status).toBe("done");
    } finally { await f.close(); }
  });

  it("专题交出的 Markdown 先当作新的一版（本机程序还没有专题版本条目时的临时做法）：提纲、第 1 版，号连续，同一条不重复记", async () => {
    const f = await fixture();
    try {
      const device = randomUUID();
      const { token } = await f.pair(device);
      const topicId = randomUUID();
      await f.t.sql("INSERT INTO research_topics(id,owner_id,title) VALUES($1,$2,'竞品调研')", [topicId, TEST_MEMBER.personId]);
      const s = f.session(device, { kind: "topic", topicId });
      const items = [s.item(1, "artifact", file("提纲.md", "# 提纲\n- 一\n- 二")), s.item(2, "artifact", file("调研.md", "# 调研\n正文"))];
      await f.sync(token, device, items);
      await f.sync(token, device, items);
      expect(await f.t.sql("SELECT number,kind,label,body FROM topic_versions WHERE topic_id=$1 ORDER BY number", [topicId])).toEqual([
        { number: 1, kind: "outline", label: "提纲", body: "# 提纲\n- 一\n- 二" }, { number: 2, kind: "draft", label: "第 1 版", body: "# 调研\n正文" }]);
      expect((await f.t.sql("SELECT last_version_at FROM research_topics WHERE id=$1", [topicId]))[0].last_version_at).not.toBeNull();
      const handback = await f.sync(token, device, [s.item(3, "handback", { summary: "好了", criteria: [] })]);
      expect(handback.json().rejected).toMatchObject([{ code: "INVALID_SUBJECT" }]);
    } finally { await f.close(); }
  });
});
