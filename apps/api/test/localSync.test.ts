import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_WRITE_TOOLS } from "../src/mcpOAuth.js";
import { createTestApp, TEST_CEO, TEST_MEMBER } from "./helpers.js";

const rpc = (id: number, method: string) => ({ jsonrpc: "2.0", id, method });
type Entry = { content: string; status: "pending" | "in_progress" | "completed" };
/** 计划条目带上本机算的进度（和本机程序 plan.ts 同一个算法）。 */
const plan = (entries: Entry[]) => {
  const done = entries.filter((entry) => entry.status === "completed").length, current = entries.findIndex((entry) => entry.status === "in_progress");
  return { entries, progress: { done, total: entries.length, step: current >= 0 ? current + 1 : done, current: current >= 0 ? entries[current].content : null } };
};
const file = (name: string, text: string) => {
  const buffer = Buffer.from(text);
  return { title: name, fileName: name, mimeType: "text/markdown", size: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex"),
    contentBase64: buffer.toString("base64"), artifactId: `a-${randomUUID().slice(0, 8)}` };
};

async function fixture() {
  const storage = await mkdtemp(join(tmpdir(), "local-sync-"));
  // 交回会进 Agent 验收队列：这里只看上报，验收用一个不返回的桩，不调真模型。
  const t = await createTestApp({ materialStorageDir: storage }, undefined, { boardAgents: { acceptance: { accept: () => new Promise(() => undefined) } } });
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
    headers: { authorization: `Bearer ${token}` }, payload: { deviceId, runnerVersion: "0.1.0", slots: { max: 3, running: 1, queued: 0 }, items } });
  /** 一个本机会话里的条目：序号就是幂等键的最后一段，时间按序号往后排。 */
  const session = (deviceId: string, subject: Record<string, unknown>, sessionId = randomUUID()) => ({
    sessionId,
    item: (seq: number, type: string, data: unknown) => ({ key: `${deviceId}:${sessionId}:${seq}`, sessionId, subject,
      occurredAt: new Date(Date.UTC(2026, 10, 6, 2, 0, seq)).toISOString(), type, data }),
  });
  return { t, call, pair, task, sync, session, close: async () => { await t.close(); await rm(storage, { recursive: true, force: true }); } };
}

describe("本机程序：设备令牌和单向上报", { timeout: 30_000 }, () => {
  it("配对建设备令牌：不占 5 把的名额、不在设置页列；连 MCP 只读、不能当登录态；吊销、再配对后旧令牌立刻失效", async () => {
    const f = await fixture();
    try {
      const device = randomUUID();
      const first = await f.pair(device);
      expect(first.device).toMatchObject({ id: device, name: "我的电脑", os: "win32", appVersion: null, lastSyncAt: null });
      for (let i = 0; i < 5; i++) expect((await f.call("POST", "/api/me/tokens", { name: `工具${i}`, client: "codex", expiresInDays: null })).statusCode).toBe(200);
      expect((await f.call("GET", "/api/me/tokens")).json().tokens.map((token: { client: string }) => token.client)).not.toContain("local");
      expect((await f.call("GET", "/api/me/local-devices")).json().devices).toMatchObject([{ id: device, name: "我的电脑" }]);

      // 本机会话经本机程序转发连 /mcp/me：只列读的工具，调写的工具 403。
      const mcp = (id: number, method: string, params?: Record<string, unknown>, token = first.token) => f.t.app.inject({ method: "POST", url: "/mcp/me",
        headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" }, payload: { ...rpc(id, method), ...(params ? { params } : {}) } });
      expect((await mcp(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tianshu-local", version: "1" } })).statusCode).toBe(200);
      const tools = (await mcp(2, "tools/list")).json().result.tools.map((tool: { name: string }) => tool.name) as string[];
      expect(tools).toEqual(expect.arrayContaining(["list_my_items", "get_item", "get_task_agreement", "check_task"]));
      expect(tools.filter((name) => MCP_WRITE_TOOLS.has(name))).toEqual([]);
      expect((await mcp(3, "tools/call", { name: "list_my_items", arguments: {} })).json().result.isError).toBe(false);
      expect((await mcp(4, "tools/call", { name: "append_progress", arguments: { itemId: randomUUID(), body: "写不进去" } })).statusCode).toBe(403);
      expect((await f.t.app.inject({ method: "GET", url: "/api/me/home", headers: { authorization: `Bearer ${first.token}` } })).statusCode).toBe(401);
      expect((await f.sync(first.token, device, [f.session(device, { kind: "topic", topicId: randomUUID() }).item(1, "plan", plan([]))])).statusCode).toBe(200);

      const second = await f.pair(device, "改了名字");
      expect((await f.sync(first.token, device, [f.session(device, { kind: "topic", topicId: randomUUID() }).item(1, "plan", plan([]))])).statusCode).toBe(401);
      expect((await f.sync(second.token, randomUUID(), [f.session(device, { kind: "topic", topicId: randomUUID() }).item(1, "plan", plan([]))])).statusCode).toBe(403);
      expect((await f.call("GET", "/api/me/local-devices")).json().devices).toMatchObject([{ id: device, name: "改了名字", appVersion: "0.1.0" }]);
      expect((await f.call("DELETE", `/api/me/local-devices/${device}`)).statusCode).toBe(204);
      expect((await mcp(5, "tools/list", undefined, second.token)).statusCode).toBe(401);
      expect((await f.sync(second.token, device, [f.session(device, { kind: "topic", topicId: randomUUID() }).item(1, "plan", plan([]))])).statusCode).toBe(401);
      expect((await f.call("GET", "/api/me/local-devices")).json().devices).toEqual([]);
      expect((await f.call("DELETE", `/api/me/local-devices/${device}`)).statusCode).toBe(404);
    } finally { await f.close(); }
  });

  it("一次执行报上来：状态、计划、证据、产出、花费、交回都记下，交回只算点名的产出，卡变进行中；同一批再发一次只记一次；设备记下位置数", async () => {
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
        s.item(3, "plan", plan([{ content: "读材料", status: "completed" }, { content: "写方案", status: "in_progress" }, { content: "自查", status: "pending" }])),
        s.item(4, "evidence", { kind: "link", title: "PR #12", url: "https://github.com/x/y/pull/12" }),
        s.item(5, "artifact", doc),
        s.item(6, "cost", { modelLabel: "订阅 · Opus", usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 10, cacheWriteTokens: 0, costUsd: 0.12 } }),
        s.item(7, "evidence", { kind: "note", title: "草稿想法", text: "没点名的不算" }),
        s.item(8, "handback", { summary: "方案写好了", criteria: [{ index: 1, result: "met", evidence: "方案.md" }, { index: 2, result: "partial", evidence: "评审还没开" }],
          outputKeys: [`${device}:${s.sessionId}:4`, `${device}:${s.sessionId}:5`, `${device}:${s.sessionId}:99`] }),
      ];
      const res = await f.sync(token, device, items);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ accepted: items.map((item) => item.key), rejected: [] });
      const again = await f.sync(token, device, items);
      expect(again.json()).toEqual({ accepted: items.map((item) => item.key), rejected: [] });

      const [run] = await f.t.sql("SELECT * FROM local_runs WHERE id=$1", [s.sessionId]);
      expect(run).toMatchObject({ owner_id: TEST_MEMBER.personId, device_id: device, kind: "card", task_id: cardId, state: "running", model_label: "订阅 · Opus",
        tokens: { input: 1200, output: 300, cacheRead: 10, cacheWrite: 0 }, last_seq: "8", plan_progress: { done: 1, total: 3, step: 2, current: "写方案" } });
      expect((await f.t.sql("SELECT slots FROM local_devices WHERE id=$1", [device]))[0].slots).toEqual({ max: 3, running: 1, queued: 0 });
      expect(Number(run.cost_usd)).toBeCloseTo(0.12);
      expect((run.timeline as { text: string }[]).map((entry) => entry.text)).toEqual(["开工（订阅 · Opus）", "交出：方案.md", "交回，等验收"]);
      expect(run.running_at).not.toBeNull();
      const outputs = await f.t.sql("SELECT kind,evidence_kind,title,url,mime,extracted_text FROM local_outputs WHERE run_id=$1 ORDER BY created_at", [s.sessionId]);
      expect(outputs).toMatchObject([{ kind: "evidence", evidence_kind: "link", url: "https://github.com/x/y/pull/12" },
        { kind: "artifact", title: "方案.md", mime: "text/markdown", extracted_text: "# 方案\n\n有题库打分结果" }, { kind: "evidence", evidence_kind: "note" }]);
      const [handback] = await f.t.sql(`SELECT attempt,status,criteria,claims,summary,
        (SELECT array_agg(o.title ORDER BY o.created_at) FROM local_outputs o WHERE output_ids ? o.id::text) AS outputs FROM card_handbacks WHERE task_id=$1`, [cardId]);
      expect(handback).toMatchObject({ attempt: 1, status: expect.stringMatching(/^(queued|running)$/), criteria: ["有方案文档", "有评审结论"], summary: "方案写好了",
        outputs: ["PR #12", "方案.md"],
        claims: [{ index: 1, result: "met", evidence: "方案.md" }, { index: 2, result: "partial", evidence: "评审还没开" }] });
      expect((await f.t.sql("SELECT status,executor FROM tasks WHERE id=$1", [cardId]))[0]).toEqual({ status: "in_progress", executor: "claude_code" });
      const output = (await f.t.sql("SELECT id FROM local_outputs WHERE kind='artifact'"))[0].id as string;
      const opened = await f.call("GET", `/api/me/local-outputs/${output}`);
      expect(opened.statusCode).toBe(200);
      expect(opened.headers["content-security-policy"]).toBe("sandbox");
      expect(opened.body).toContain("有题库打分结果");
    } finally { await f.close(); }
  });

  it("晚到的旧状态和旧计划丢掉；不是本人的卡、对不上的文件、乱写的幂等键永久拒收；等空位的卡留在未开始；已完成的卡状态不被改回去", async () => {
    const f = await fixture();
    try {
      const device = randomUUID();
      const { token } = await f.pair(device);
      const cardId = await f.task("写方案");
      const s = f.session(device, { kind: "card", cardId });
      await f.sync(token, device, [s.item(4, "status", { status: "idle", title: "写方案", agent: "claude-code", modelLabel: "订阅" }),
        s.item(5, "plan", plan([{ content: "新计划", status: "in_progress" }]))]);
      await f.sync(token, device, [s.item(2, "status", { status: "running", title: "写方案", agent: "claude-code", modelLabel: "订阅" }),
        s.item(3, "plan", plan([{ content: "旧计划", status: "in_progress" }]))]);
      expect((await f.t.sql("SELECT state,plan FROM local_runs WHERE id=$1", [s.sessionId]))[0]).toEqual({ state: "idle", plan: [{ content: "新计划", status: "in_progress" }] });

      const theirs = randomUUID();
      await f.t.sql("INSERT INTO tasks(id,title,owner_id,created_by,status) VALUES($1,'别人的','" + TEST_CEO.personId + "','self','not_started')", [theirs]);
      const other = f.session(device, { kind: "card", cardId: theirs });
      const broken = { ...file("坏.md", "内容"), sha256: "0".repeat(64) };
      const res = await f.sync(token, device, [other.item(1, "plan", plan([])), s.item(6, "artifact", broken),
        { ...s.item(7, "plan", plan([])), key: `${device}:${randomUUID()}:7` }, s.item(8, "artifact", { ...file("表.xlsx", "x"), fileName: "表.xlsx" })]);
      expect(res.json().accepted).toEqual([]);
      expect(res.json().rejected.map((item: { code: string }) => item.code)).toEqual(["NOT_OWNER", "CHECKSUM_MISMATCH", "INVALID_KEY", "UNSUPPORTED_TYPE"]);
      expect(await f.t.sql("SELECT 1 FROM local_runs WHERE id=$1", [other.sessionId])).toEqual([]);
      expect(await f.t.sql("SELECT 1 FROM local_outputs")).toEqual([]);

      // 本机满了、这张卡在等空位：还没开工，卡留在未开始；轮到它开工时才变进行中。
      const waiting = await f.task("等空位的");
      const queued = f.session(device, { kind: "card", cardId: waiting });
      await f.sync(token, device, [queued.item(1, "status", { status: "queued", title: "等空位的", agent: "claude-code", modelLabel: "订阅" })]);
      expect((await f.t.sql("SELECT status FROM tasks WHERE id=$1", [waiting]))[0].status).toBe("not_started");
      expect((await f.t.sql("SELECT state,last_activity->>'text' AS text FROM local_runs WHERE id=$1", [queued.sessionId]))[0]).toEqual({ state: "queued", text: "等空位" });
      await f.sync(token, device, [queued.item(2, "status", { status: "starting", title: "等空位的", agent: "claude-code", modelLabel: "订阅" })]);
      expect((await f.t.sql("SELECT status FROM tasks WHERE id=$1", [waiting]))[0].status).toBe("in_progress");

      await f.t.sql("UPDATE tasks SET status='done' WHERE id=$1", [cardId]);
      const later = f.session(device, { kind: "card", cardId });
      await f.sync(token, device, [later.item(1, "status", { status: "running", title: "写方案", agent: "claude-code", modelLabel: "订阅" }),
        later.item(2, "handback", { summary: "又改了一点", criteria: [], outputKeys: [] })]);
      expect((await f.t.sql("SELECT status FROM tasks WHERE id=$1", [cardId]))[0].status).toBe("done");
      expect((await f.t.sql("SELECT state FROM local_runs WHERE id=$1", [later.sessionId]))[0].state).toBe("running");
      expect((await f.t.sql("SELECT status FROM card_handbacks WHERE task_id=$1", [cardId]))[0].status).toBe("done");
      // 卡已完成不排 Agent 验收：空交回也照旧记下来
      expect((await f.sync(token, device, [later.item(3, "handback", { summary: " ", criteria: [], outputKeys: [] })])).json().rejected).toEqual([]);
      expect(await f.t.sql("SELECT status,summary FROM card_handbacks WHERE task_id=$1 ORDER BY attempt", [cardId]))
        .toEqual([{ status: "done", summary: "又改了一点" }, { status: "done", summary: null }]);
    } finally { await f.close(); }
  });

  it("验收要带证据（云端照样把关）：空交回拒收、不记交回；只有一句话没有附件的照常排验收；判达到不写依据、没达到不写怎么补拒收，交回仍没结论", async () => {
    const f = await fixture();
    try {
      const device = randomUUID();
      const { token } = await f.pair(device);
      const cardId = await f.task("写方案");
      const s = f.session(device, { kind: "card", cardId });
      const empty = await f.sync(token, device, [s.item(1, "handback", { summary: "  ", criteria: [], outputKeys: [] })]);
      expect(empty.json().rejected).toEqual([{ key: s.item(1, "handback", null).key, code: "EMPTY_HANDBACK", message: "交回里什么都没有：写一句做了什么，或者点名产出" }]);
      expect(await f.t.sql("SELECT 1 FROM card_handbacks WHERE task_id=$1", [cardId])).toEqual([]);

      const text = s.item(2, "handback", { summary: "方案写在这句话里：先做题库打分", criteria: [{ index: 1, result: "met", evidence: "见 summary" }], outputKeys: [] });
      expect((await f.sync(token, device, [text])).json().rejected).toEqual([]);
      expect((await f.t.sql("SELECT status,output_ids FROM card_handbacks WHERE task_id=$1", [cardId]))[0])
        .toEqual({ status: expect.stringMatching(/^(queued|running)$/), output_ids: [] });

      const v = f.session(device, { kind: "verify", cardId, handbackKey: text.key });
      const verdict = (criteria: unknown[]) => ({ passed: false, summary: "逐条看过", beyondScope: [], modelLabel: "订阅 · Opus", roleId: null, roleVersion: null, criteria });
      const rejected = await f.sync(token, device, [
        v.item(1, "verdict", verdict([{ index: 1, verdict: "met", reason: "有", evidence: "  ", fix: null }, { index: 2, verdict: "met", reason: "有", evidence: "方案.md", fix: null }])),
        v.item(2, "verdict", verdict([{ index: 1, verdict: "met", reason: "有", evidence: "方案.md", fix: null }, { index: 2, verdict: "unmet", reason: "没评审", evidence: null, fix: null }])),
        v.item(3, "verdict", verdict([{ index: 1, verdict: "met", reason: "有", evidence: "方案.md", fix: null }, { index: 2, verdict: "needs_person", reason: "要本人", evidence: null, fix: " " }]))]);
      expect(rejected.json().rejected.map((item: { code: string; message: string }) => [item.code, item.message])).toEqual([
        ["INVALID_VERDICT", "第 1 条判达到，要写依据"], ["INVALID_VERDICT", "第 2 条判没达到，要写怎么补"], ["INVALID_VERDICT", "第 2 条判没达到，要写怎么补"]]);
      expect((await f.t.sql("SELECT outcome FROM card_handbacks WHERE task_id=$1", [cardId]))[0].outcome).toBeNull();

      // 本人自己做的卡不排 Agent 验收：空交回照旧记下来
      const mine = await f.task("自己做的");
      await f.t.sql("UPDATE tasks SET executor='self' WHERE id=$1", [mine]);
      const own = f.session(device, { kind: "card", cardId: mine });
      expect((await f.sync(token, device, [own.item(1, "handback", { summary: " ", criteria: [], outputKeys: [] })])).json().rejected).toEqual([]);
      expect(await f.t.sql("SELECT status,summary FROM card_handbacks WHERE task_id=$1", [mine])).toEqual([{ status: "done", summary: null }]);
    } finally { await f.close(); }
  });

  it("专题的版本照本机编的号存：没起名的叫提纲、第 N 版、评审；交出的文件不算版本；飞书地址对回那一版；号撞了排到最后不丢；同一条不重复记", async () => {
    const f = await fixture();
    try {
      const device = randomUUID();
      const { token } = await f.pair(device);
      const topicId = randomUUID();
      await f.t.sql("INSERT INTO research_topics(id,owner_id,title) VALUES($1,$2,'竞品调研')", [topicId, TEST_MEMBER.personId]);
      const version = (number: number, kind: string, body: string, label: string | null = null) => ({ number, kind, label, note: null, body });
      const s = f.session(device, { kind: "topic", topicId });
      const items = [s.item(1, "topic_version", version(1, "outline", "# 提纲\n- 一\n- 二")), s.item(2, "artifact", file("调研.md", "# 调研\n草稿")),
        s.item(3, "topic_version", version(2, "draft", "# 调研\n正文")), s.item(4, "topic_version", version(3, "review", "# 分歧和建议")),
        s.item(5, "topic_version", version(4, "draft", "# 调研\n改过", "定稿")), s.item(6, "topic_version_feishu", { number: 2, feishuUrl: "https://x.feishu.cn/docx/a" })];
      expect((await f.sync(token, device, items)).json().rejected).toEqual([]);
      await f.sync(token, device, items);
      const versions = () => f.t.sql("SELECT number,local_number,kind,label,body,feishu_url FROM topic_versions WHERE topic_id=$1 ORDER BY number", [topicId]);
      expect(await versions()).toEqual([
        { number: 1, local_number: 1, kind: "outline", label: "提纲", body: "# 提纲\n- 一\n- 二", feishu_url: null },
        { number: 2, local_number: 2, kind: "draft", label: "第 1 版", body: "# 调研\n正文", feishu_url: "https://x.feishu.cn/docx/a" },
        { number: 3, local_number: 3, kind: "review", label: "评审", body: "# 分歧和建议", feishu_url: null },
        { number: 4, local_number: 4, kind: "draft", label: "定稿", body: "# 调研\n改过", feishu_url: null }]);
      expect((await f.t.sql("SELECT last_version_at FROM research_topics WHERE id=$1", [topicId]))[0].last_version_at).not.toBeNull();

      // 另一个会话还以为最新是第 2 版（上一批没报上来时开的工）：它的第 3 版排到第 5 号，飞书地址跟着它走；以前的版本按号认。
      const other = f.session(device, { kind: "topic", topicId });
      expect((await f.sync(token, device, [other.item(1, "topic_version", version(3, "draft", "# 另一处写的")),
        other.item(2, "topic_version_feishu", { number: 3, feishuUrl: "https://x.feishu.cn/docx/c" }),
        other.item(3, "topic_version_feishu", { number: 1, feishuUrl: "https://x.feishu.cn/docx/b" })])).json().rejected).toEqual([]);
      const after = await versions();
      expect(after.map((row) => [row.number, row.local_number, row.label, row.feishu_url])).toEqual([[1, 1, "提纲", "https://x.feishu.cn/docx/b"],
        [2, 2, "第 1 版", "https://x.feishu.cn/docx/a"], [3, 3, "评审", null], [4, 4, "定稿", null], [5, 3, "第 3 版", "https://x.feishu.cn/docx/c"]]);

      const rejected = await f.sync(token, device, [s.item(7, "topic_version_feishu", { number: 9, feishuUrl: "https://x.feishu.cn/docx/z" }),
        s.item(8, "handback", { summary: "好了", criteria: [], outputKeys: [] })]);
      expect(rejected.json().rejected.map((item: { code: string }) => item.code)).toEqual(["VERSION_NOT_FOUND", "INVALID_SUBJECT"]);
      const card = f.session(device, { kind: "card", cardId: await f.task("写方案") });
      expect((await f.sync(token, device, [card.item(1, "topic_version", version(1, "draft", "x"))])).json().rejected).toMatchObject([{ code: "INVALID_SUBJECT" }]);
    } finally { await f.close(); }
  });
});
