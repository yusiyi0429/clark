// 执行方问本人（Claude Code 的 AskUserQuestion）：不再当成权限请求，转成「等你回复」带问题和选项；网页按问题给选中的选项和一句话，本机交回给执行方。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { api, pair, raw, startTestRunner, tempDir, ORIGIN } from "./helpers.js";

async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

const ASK = [
  { question: "等前两张交回，还是先预跑？", header: "先后", multiSelect: false, options: [{ label: "等交回", description: "前两张合回后再跑" }, { label: "先预跑", description: "" }] },
  { question: "要跑哪些检查？", header: "检查", multiSelect: true, options: [{ label: "单测", description: "npm test" }, { label: "类型检查", description: "tsc" }] },
];

async function setup() {
  const work = tempDir("tl-ask-");
  writeFileSync(join(work, ".fake-claude.json"), JSON.stringify({ ask: ASK }));
  const t = await startTestRunner({ pickFolder: work });
  const token = await pair(t.port);
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  await call("POST", "/v1/folders/pick", {});
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body.session;
  const open = async (title: string) => (await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: title }, title, cwd: work, firstMessage: `做 ${title}` })).body;
  const events = (id: string) => readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const answers = () => readFileSync(join(work, ".fake-claude-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((l) => l.permissionResponse).map((l) => l.permissionResponse);
  const asked = (id: string) => until(async () => { const s = await session(id); return s.pendingQuestion ? s : null; });
  const answer = (id: string, requestId: string, body: unknown) => call("POST", `/v1/sessions/${id}/questions/${encodeURIComponent(requestId)}`, body);
  return { t, work, call, session, open, events, answers, asked, answer };
}

describe("执行方问本人", { timeout: 30_000 }, () => {
  it("等你回复带问题和选项（不是权限请求，不占位置）；按问题回答选中的选项和一句话；答过再答 409；回答不合格 400", async () => {
    const h = await setup();
    try {
      const a = await h.open("A");
      const s = await h.asked(a.id);
      expect(s.status).toBe("idle");
      expect(s.pendingPermissions).toBe(0);
      expect(s.pendingQuestion.questions).toEqual(ASK);
      expect((await raw(h.t.port, { path: "/v1/health", headers: { origin: ORIGIN } })).body.slots.running).toBe(0);
      expect(h.events(a.id).some((e) => e.type === "permission_request")).toBe(false);
      expect(h.events(a.id).find((e) => e.type === "question").request.requestId).toBe(s.pendingQuestion.requestId);
      const id = s.pendingQuestion.requestId as string;

      expect((await h.answer(a.id, id, { choices: [["等交回"]] })).status).toBe(400); // 条数不对
      expect((await h.answer(a.id, id, { choices: [["随便"], ["单测"]] })).status).toBe(400); // 没有这个选项
      expect((await h.answer(a.id, id, { choices: [["等交回", "先预跑"], ["单测"]] })).status).toBe(400); // 单选给了两个
      expect((await h.answer(a.id, id, { choices: [[], ["单测"]] })).status).toBe(400); // 第 1 个没回答
      expect((await h.answer(a.id, "not-this-one", { choices: [["等交回"], ["单测"]] })).status).toBe(409);

      const ok = await h.answer(a.id, id, { choices: [["等交回"], ["单测", "类型检查"]], text: "别的不用跑" });
      expect(ok.status).toBe(200);
      expect(ok.body.session.pendingQuestion).toBeUndefined();
      // 执行方收到的：每个问题一条「问题原文 → 回答」，多选用顿号连，补充的话接在最后一个问题后面；问题原样带回
      const r = await until(() => h.answers()[0]);
      expect(r.behavior).toBe("allow");
      expect(r.updatedInput.questions).toEqual(ASK);
      expect(r.updatedInput.answers).toEqual({ [ASK[0]!.question]: "等交回", [ASK[1]!.question]: "单测、类型检查；别的不用跑" });
      await until(async () => (await h.session(a.id)).status === "idle" && h.events(a.id).some((e) => e.type === "turn_end"));
      expect(h.events(a.id).find((e) => e.type === "question_resolved")).toMatchObject({ requestId: id, choices: [["等交回"], ["单测", "类型检查"]], text: "别的不用跑" });
      expect((await h.answer(a.id, id, { choices: [["等交回"], ["单测"]] })).status).toBe(409); // 答过了
    } finally {
      await h.t.cleanup();
    }
  });

  it("在等回答时说一句就是回答；停下时提问作废；只写一句话也行", async () => {
    const h = await setup();
    try {
      const a = await h.open("A");
      await h.asked(a.id);
      const said = await h.call("POST", `/v1/sessions/${a.id}/messages`, { text: "先预跑一遍" });
      expect(said.body.delivery).toBe("next_step");
      const r = await until(() => h.answers()[0]);
      expect(r.updatedInput.answers).toEqual({ [ASK[0]!.question]: "先预跑一遍", [ASK[1]!.question]: "先预跑一遍" });
      expect(h.events(a.id).find((e) => e.type === "question_resolved")).toMatchObject({ choices: [[], []], text: "先预跑一遍" });

      const b = await h.open("B");
      const s = await h.asked(b.id);
      await h.call("POST", `/v1/sessions/${b.id}/interrupt`, {});
      await until(() => h.events(b.id).find((e) => e.type === "question_resolved"));
      expect(h.events(b.id).find((e) => e.type === "question_resolved")).toMatchObject({ requestId: s.pendingQuestion.requestId, choices: null, text: null });
      expect((await h.session(b.id)).pendingQuestion).toBeUndefined();
      expect((await h.answer(b.id, s.pendingQuestion.requestId, { choices: [["等交回"], ["单测"]] })).status).toBe(409);
    } finally {
      await h.t.cleanup();
    }
  });
});
