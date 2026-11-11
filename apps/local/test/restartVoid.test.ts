// 本机程序被直接停掉（重启、升级、强杀）时没处理的批准请求和提问：重新起来时补作废（11/11 本人定的第 1 种修法）。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { api, pair, startTestRunner, tempDir } from "./helpers.js";

async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("本机程序被强杀后重新起来", () => {
  it("没处理的两个批准、一个提问各补一条作废，pendingPermissions 为 0、没有 pendingQuestion、状态 exited；再重启一次不重复补", async () => {
    const work = tempDir("tl-hardkill-");
    let t = await startTestRunner({ pickFolder: work });
    const token = await pair(t.port);
    await api(t.port, token, "POST", "/v1/folders/pick", {});
    const s = await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c" }, title: "x", cwd: work, firstMessage: "hi", permissionMode: "default" });
    expect(s.status).toBe(200);
    const id = s.body.id as string;
    // 假 Claude Code 每轮要写文件的权限：等到在等批准
    const first = await until(async () => (await api(t.port, token, "GET", `/v1/sessions/${id}`)).body.pendingPermissions[0]);
    const eventsFile = join(t.dataDir, "sessions", id, "events.jsonl");
    const sessionFile = join(t.dataDir, "sessions", id, "session.json");
    const kept = readFileSync(eventsFile, "utf8").trim().split("\n");
    await t.runner.close();
    const rec = JSON.parse(readFileSync(sessionFile, "utf8")); // 关掉以后的（syncSeq 是最新的，和强杀留下的一样）

    // 强杀留下的样子：事件停在那一刻（没有正常退出补的那几条），记录里还写着在等批准；再多一个批准、一个提问没处理
    const lines = kept.map((l) => JSON.parse(l));
    const req = lines.find((e) => e.type === "permission_request");
    let seq = lines.at(-1).seq;
    const at = new Date().toISOString();
    lines.push({ ...req, seq: ++seq, at, request: { ...req.request, requestId: "perm-hardkill-2" } });
    lines.push({ seq: ++seq, at, sessionId: id, type: "question", request: { requestId: "q-hardkill", questions: [{ question: "用哪个？", header: "选", options: [{ label: "甲", description: "" }], multiSelect: false }], askedAt: at } });
    writeFileSync(eventsFile, lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(sessionFile, JSON.stringify({ ...rec, status: "waiting_permission" }));

    t = await startTestRunner({ dataDir: t.dataDir, pickFolder: work });
    try {
      const detail = (await api(t.port, token, "GET", `/v1/sessions/${id}`)).body;
      expect(detail.session.status).toBe("exited");
      expect(detail.session.pendingPermissions).toBe(0);
      expect(detail.pendingPermissions).toEqual([]);
      expect(detail.session.pendingQuestion).toBeUndefined();
      const events = () => readFileSync(eventsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const added = events().filter((e) => e.seq > seq);
      expect(added.filter((e) => e.type === "permission_resolved")).toEqual([
        expect.objectContaining({ requestId: first.requestId, decision: "deny", message: "本机程序重启，已作废", allowForSession: false, voided: true }),
        expect.objectContaining({ requestId: "perm-hardkill-2", decision: "deny", message: "本机程序重启，已作废", allowForSession: false, voided: true }),
      ]);
      expect(added.filter((e) => e.type === "question_resolved")).toEqual([expect.objectContaining({ requestId: "q-hardkill", choices: null, text: null })]);
      // 停了要有交代（主循环第 65 条）：状态那一条带 why，另报一条 stopped（本机程序重启）
      expect(added.filter((e) => e.type === "status" && e.status === "exited")).toEqual([expect.objectContaining({ why: "runner_restart" })]);
      // （测试里第一次是正常关掉的，那时已报过一条 killed；强杀不会有那一条）
      const outbox = () => JSON.parse(readFileSync(join(t.dataDir, "outbox.json"), "utf8")).entries.map((e: any) => e.item)
        .filter((i: any) => i.sessionId === id && i.type === "stopped" && i.data.why === "runner_restart");
      expect(outbox()).toHaveLength(1);

      // 再重启一次：都补过了，不再补
      const count = events().length;
      await t.runner.close();
      t = await startTestRunner({ dataDir: t.dataDir, pickFolder: work });
      expect(events().filter((e) => e.type === "permission_resolved" || e.type === "question_resolved")).toHaveLength(3);
      expect(events().length).toBe(count);
      expect(outbox()).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });

  it("一轮做完在等本人回复的（idle、没在问）：重启后照样停了，不补「本机程序重启」（那一轮已经报过做完一轮）", async () => {
    const work = tempDir("tl-hardkill-idle-");
    let t = await startTestRunner({ pickFolder: work });
    const token = await pair(t.port);
    await api(t.port, token, "POST", "/v1/folders/pick", {});
    const id = (await api(t.port, token, "POST", "/v1/sessions", { subject: { kind: "card", cardId: "c" }, title: "x", cwd: work, firstMessage: "hi" })).body.id as string;
    const p = await until(async () => (await api(t.port, token, "GET", `/v1/sessions/${id}`)).body.pendingPermissions[0]);
    await api(t.port, token, "POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(p.requestId)}`, { decision: "allow" });
    await until(async () => (await api(t.port, token, "GET", `/v1/sessions/${id}`)).body.session.status === "idle");
    const sessionFile = join(t.dataDir, "sessions", id, "session.json");
    await t.runner.close();
    const rec = JSON.parse(readFileSync(sessionFile, "utf8")); // 关掉以后的（syncSeq 是最新的，和强杀留下的一样）
    writeFileSync(sessionFile, JSON.stringify({ ...rec, status: "idle" })); // 强杀留下的样子
    t = await startTestRunner({ dataDir: t.dataDir, pickFolder: work });
    try {
      expect((await api(t.port, token, "GET", `/v1/sessions/${id}`)).body.session.status).toBe("exited");
      const stops = JSON.parse(readFileSync(join(t.dataDir, "outbox.json"), "utf8")).entries.map((e: any) => e.item).filter((i: any) => i.sessionId === id && i.type === "stopped");
      expect(stops.map((i: any) => i.data.why)).not.toContain("runner_restart");
      const last = readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "status").at(-1);
      expect(last).toMatchObject({ status: "exited" });
      expect(last.why).toBeUndefined();
    } finally {
      await t.cleanup();
    }
  });
});
