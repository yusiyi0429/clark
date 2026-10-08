import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { PersonalReviewPayload, PersonalReviewBoard, MonthlyCycle, type TMonthlyReviewSelfReview } from "@warmap/contracts";
import { signActionId } from "../src/actionToken.js";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { ensureMainConversation, storeConversationAttachments } from "../src/conversations.js";
import { ensurePersonalReviews, PERSONAL_REVIEW_FIELDS, type PersonalReviewDraftInput } from "../src/personalReviews.js";
import type { MonthlyReviewAgents, MonthlyReviewDraftInput } from "../src/monthlyReviewService.js";
import { executeDraftMissionRound } from "../src/missionRounds.js";
import type { MissionCardDraftInput } from "../src/missionCardDraftAgent.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, testEnv, type TestApp } from "./helpers.js";

const START = new Date("2026-09-30T02:00:00Z");
const selfReview = (text = "已按证据完成，待补充判断"): TMonthlyReviewSelfReview => ({
  overall: { text, sources: ["mission-member"] }, judgments: { text: "原因与证据", sources: [] },
  nextFocus: { text: "下周期重点输入", sources: [] }, escalations: { text: "无", sources: [] },
});
const fields = PERSONAL_REVIEW_FIELDS.map((field) => ({ field, text: selfReview()[field].text }));
async function fixture(owners = [TEST_MEMBER.personId, TEST_CEO.personId] as string[]) {
  const dir = await mkdtemp(join(tmpdir(), "personal-review-test-"));
  let now = START;
  const draftCalls: MonthlyReviewDraftInput[] = [], personalCalls: PersonalReviewDraftInput[] = [];
  let generate: (input: PersonalReviewDraftInput) => Promise<unknown> = async () => selfReview();
  const agents: MonthlyReviewAgents = {
    draft: { async generate(input) { draftCalls.push(input); return { candidate: selfReview("单元原稿") }; } },
    assess: { async generate() { return { candidate: { overall: "符合证据", deviations: [], questions: [] } }; } },
    summarize: { async generate() { return { candidate: {} }; } },
    personal: { async generate(input) { personalCalls.push(input); return { candidate: await generate(input) }; } },
  };
  const t = await createTestApp({ conversationAttachmentStorageDir: dir }, undefined,
    { monthlyReviewAgents: agents, monthlyReviewRetryDelayMs: 0, monthlyNow: () => now });
  await t.sql("UPDATE battlefield_config SET owner_id=$1 WHERE id='growth'", [TEST_MEMBER.personId]);
  await t.sql("INSERT INTO capability_config(id,version,code,name,six_month_outcome) VALUES ('cap-personal',1,'01','能力','能力目标')");
  for (const owner of owners) await seedMission(t, owner);
  const ceo = await t.loginCookie(), member = await t.memberCookie();
  const call = (cookie: string, method: "GET" | "POST", url: string, payload?: object) => t.app.inject({ method, url,
    headers: { cookie, origin: t.publicOrigin }, ...(payload ? { payload } : {}) });
  const board = async (cookie = member) => (await call(cookie, "GET", "/api/personal-reviews/board")).json().board;
  const read = async (id: string, cookie = member) => (await call(cookie, "GET", `/api/personal-reviews/${id}`)).json().review;
  const act = async (id: string, type: string, input?: object, cookie = member, version?: number) => {
    const row = (await t.sql("SELECT version FROM personal_reviews WHERE id=$1", [id]))[0];
    return call(cookie, "POST", "/api/personal-reviews/actions/execute", {
      actionId: signActionId(testEnv.sessionSecret, { actionType: `personal-review.${type}`, objectType: "personal-review", objectId: id, objectVersion: version ?? row.version as number }),
      ...(input ? { input } : {}),
    });
  };
  const open = async () => { const result = await t.monthlyReviews!.open("2026-09"); await t.monthlyReviews!.idle(); return result.reviewId; };
  const close = async () => {
    await t.monthlyReviews!.idle(); await t.close();
    if (!resolve(dir).startsWith(join(resolve(tmpdir()), "personal-review-test-"))) throw new Error("Unexpected fixture directory");
    await rm(dir, { recursive: true, force: true });
  };
  return { t, dir, ceo, member, call, board, read, act, open, close, draftCalls, personalCalls,
    now: (at: Date) => { now = at; }, generate: (fn: typeof generate) => { generate = fn; } };
}
async function seedMission(t: TestApp, owner: string) {
  await t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,why,success_evidence,milestones,boundaries,
    source_ref,source_document_id,source_revision,source_title) VALUES ($1,1,$1,'2026-09','本人承诺',$2,'cap-personal','["growth"]','承诺结果','原因','["验收证据"]','["里程碑"]','边界','test','test',1,'test')`,
  [`mission-${owner}`, owner]);
}

describe("个人复盘创建、投影和权限", () => {
  it("新建时立即异步起草，无上传材料也生成；Agent 失败可见", async () => {
    const f = await fixture([TEST_MEMBER.personId]);
    try {
      f.generate(async () => { throw new Error("自动起草失败"); });
      await f.open();
      const id = (await f.board()).rows[0].personalReviewId;
      expect(await f.read(id)).toMatchObject({ status: "draft_failed", materialCount: 0, draftError: { message: "自动起草失败" } });
      expect(f.personalCalls[0]).toMatchObject({ missions: [{ outcome: "承诺结果" }], attachments: [], messages: [] });
      expect(f.personalCalls).toHaveLength(3);
      expect((await f.read(id)).actions.some((entry: any) => entry.actionType === "personal-review.draft_with_co_agent")).toBe(false);
    } finally { await f.close(); }
  });

  it("幂等创建、月初补建、只取名单内 owner，计时从首次补建开始且不重置", async () => {
    const f = await fixture([]);
    try {
      expect(await f.board()).toBeNull();
      const id = await f.open();
      expect((await f.call(f.member, "GET", "/api/monthly-cycle")).json().cycle).toBeNull();
      await seedMission(f.t, TEST_MEMBER.personId); await seedMission(f.t, "not-in-people");
      const later = new Date("2026-10-01T03:00:00Z"); f.now(later);
      expect((await f.t.monthlyReviews!.runScheduled()).status).toBe("not_due");
      await f.t.monthlyReviews!.runScheduled();
      await f.t.monthlyReviews!.idle();
      const board = await f.board(); expect(board.counts.total).toBe(1);
      expect(board.rows[0]).toMatchObject({ status: "draft", draftSource: "co_agent" });
      expect(f.personalCalls).toHaveLength(1);
      expect(f.personalCalls[0]).toMatchObject({ missions: [{ outcome: "承诺结果" }], attachments: [], messages: [] });
      expect(await ensurePersonalReviews(f.t.pool, id, loadCompanyMemory(testEnv).searchPeople(undefined), later)).toEqual([]);
      expect((await f.call(f.ceo, "GET", "/api/monthly-cycle")).json().cycle).toMatchObject({ startedAt: later.toISOString(), deadlineAt: "2026-10-04T03:00:00.000Z", stage: "personal_reviews" });
      await f.t.sql("UPDATE monthly_reviews SET status='summarizing' WHERE id=$1", [id]);
      await seedMission(f.t, TEST_CEO.personId);
      expect(await ensurePersonalReviews(f.t.pool, id, loadCompanyMemory(testEnv).searchPeople(undefined), later)).toEqual([]);
      expect(await f.board()).toBeNull();
    } finally { await f.close(); }
  });

  it("个人项自动起草、战场项等交齐；全员看状态，正文和对话按本人隔离", async () => {
    const f = await fixture();
    try {
      await f.open(); await f.open();
      expect(f.draftCalls).toHaveLength(0);
      expect(f.personalCalls).toHaveLength(2);
      const board = await f.board(); expect(Value.Check(PersonalReviewBoard, board)).toBe(true);
      expect(board.counts).toEqual({ total: 2, submitted: 0, skipped: 0 });
      const mine = board.rows.find((row: any) => row.isSelf), other = board.rows.find((row: any) => !row.isSelf);
      expect(mine.href).toBe(`/me/reviews/personal/${mine.personalReviewId}`); expect(other.href).toBeNull();
      expect(board.rows.every((row: any) => row.actions.length === 0 && !('selfReview' in row))).toBe(true);
      expect((await f.call(f.member, "GET", `/api/personal-reviews/${other.personalReviewId}`)).statusCode).toBe(404);
      expect((await f.call(f.member, "GET", "/api/personal-reviews/not-a-uuid")).statusCode).toBe(404);
      const view = await f.read(mine.personalReviewId); expect(Value.Check(PersonalReviewPayload, view)).toBe(true);
      expect(view).toMatchObject({ status: "draft", draftSource: "co_agent", materialCount: 0, toolConnected: false, missions: [{ outcome: "承诺结果" }] });
      expect((await f.board(f.ceo)).rows.every((row: any) => row.href.startsWith('/reviews/personal/') && row.actions[0].actionType === 'personal-review.skip')).toBe(true);
      for (const cookie of [f.ceo]) expect((await f.call(cookie, "GET", `/api/conversations/personal-review:${mine.personalReviewId}/messages`)).statusCode).toBe(404);
      expect((await f.call(f.ceo, "POST", `/api/conversations/personal-review:${mine.personalReviewId}/messages`, { message: "不允许代本人发言" })).statusCode).toBe(404);
      expect((await f.call(f.ceo, "POST", `/api/conversations/personal-review:${mine.personalReviewId}/attachments`, {})).statusCode).toBe(404);
      expect((await f.call(f.member, "GET", `/api/conversations/personal-review:${mine.personalReviewId}/messages`)).statusCode).toBe(200);
      const notices = (await f.call(f.member, "GET", "/api/me/monthly-reviews")).json().notices;
      expect(notices).toContainEqual(expect.objectContaining({ kind: "personal_todo", href: mine.href, text: "9 月复盘 · 草稿待你确认提交" }));
      expect(notices.some((notice: any) => notice.text.includes("等大家交个人复盘"))).toBe(true);
      await f.act(other.personalReviewId, "skip", undefined, f.ceo);
      expect((await f.board()).rows.map((row: any) => row.status)).toEqual(["draft", "skipped"]);
    } finally { await f.close(); }
  });
});

describe("个人复盘 Action 和 Co-Agent", () => {
  it("校验权限、必填三栏、版本，保留 sources，提交与跳过幂等；交齐后才起草", async () => {
    const f = await fixture();
    try {
      await f.open(); const rows = (await f.board()).rows;
      const mine = rows.find((row: any) => row.isSelf).personalReviewId, other = rows.find((row: any) => !row.isSelf).personalReviewId;
      expect((await f.act(mine, "update", { fields }, f.ceo)).statusCode).toBe(403);
      expect((await f.act(mine, "submit", undefined, f.ceo)).statusCode).toBe(403);
      expect((await f.act(other, "skip")).statusCode).toBe(403);
      expect((await f.act(mine, "update", { fields: fields.map((field) => ({ ...field, text: "" })) })).statusCode).toBe(200);
      expect((await f.act(mine, "submit")).statusCode).toBe(400);
      expect((await f.act(mine, "update", { fields: [{ ...fields[0], sources: ["证据"] }, { ...fields[0] }] })).statusCode).toBe(400);
      const first = await f.act(mine, "update", { fields: [{ ...fields[0], sources: ["证据"] }] }); expect(first.statusCode).toBe(200);
      expect((await f.act(mine, "submit")).statusCode).toBe(400);
      expect((await f.act(mine, "update", { fields }, f.member, 1)).statusCode).toBe(409);
      const saved = await f.act(mine, "update", { fields: fields.map((field) => field.field === "escalations" ? { ...field, text: "" } : field) });
      expect(saved.json().review.draftSource).toBe("co_agent");
      expect(saved.json().review.selfReview.escalations.text).toBe("");
      expect(saved.json().review.selfReview.overall.sources).toEqual(["证据"]);
      const version = saved.json().review.version;
      expect((await f.act(mine, "submit", undefined, f.member, version)).json().board.complete).toBe(false);
      expect((await f.act(mine, "submit", undefined, f.member, version)).statusCode).toBe(200);
      expect((await f.act(mine, "update", { fields })).statusCode).toBe(409);
      const skippedVersion = (await f.read(other, f.ceo)).version;
      const skipped = await f.act(other, "skip", undefined, f.ceo, skippedVersion); expect(skipped.json().board.complete).toBe(true);
      await f.t.monthlyReviews!.idle(); expect(f.draftCalls).toHaveLength(1);
      expect(f.draftCalls[0].personalReviews).toEqual(expect.arrayContaining([
        expect.objectContaining({ personId: TEST_MEMBER.personId, status: "submitted", selfReview: expect.any(Object) }),
        expect.objectContaining({ personId: TEST_CEO.personId, status: "skipped", selfReview: null, note: "未提交" }),
      ]));
      expect((await f.act(other, "skip", undefined, f.ceo, skippedVersion)).statusCode).toBe(200);
      await f.t.monthlyReviews!.idle(); expect(f.draftCalls).toHaveLength(1);
      expect((await f.call(f.member, "GET", "/api/me/monthly-reviews")).json().notices.every((notice: any) => notice.kind !== "personal_todo")).toBe(true);
    } finally { await f.close(); }
  });

  it("无材料拒绝，未发送附件和用户消息计数；严格 Agent 校验、失败重试与超时恢复", async () => {
    const f = await fixture([TEST_MEMBER.personId]);
    try {
      await f.open(); const id = (await f.board()).rows[0].personalReviewId;
      expect((await f.act(id, "draft_with_co_agent")).statusCode).toBe(400);
      const scope = `personal-review:${id}` as const;
      const conversationId = await ensureMainConversation(f.t.pool, TEST_MEMBER.personId, scope);
      const tempPath = join(f.dir, 'material.txt'); await writeFile(tempPath, '附件实际结果');
      await storeConversationAttachments(f.dir, conversationId, [{ tempPath, fileName: "review.txt", mimeType: "text/plain", sizeBytes: 18, sha256: "test", extractedText: "附件实际结果" }]);
      await f.t.sql(`INSERT INTO conversation_messages(conversation_id,sequence,role,content,references_snapshot,attachments,run_id)
        VALUES ($1,1,'user','粘贴的个人草稿','[]','[]',$2),($1,2,'assistant','不能计作材料','[]','[]',$2)`, [conversationId, randomUUID()]);
      expect((await f.read(id)).materialCount).toBe(2);
      expect((await f.read(id)).actions).toContainEqual(expect.objectContaining({ actionType: "personal-review.draft_with_co_agent", label: "按材料重新起草" }));
      let release!: (value: unknown) => void;
      f.generate(() => new Promise((resolve) => { release = resolve; }));
      expect((await f.act(id, "draft_with_co_agent")).statusCode).toBe(200);
      while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
      expect((await f.read(id)).status).toBe("drafting");
      expect((await f.act(id, "skip", undefined, f.ceo)).statusCode).toBe(409);
      expect((await f.act(id, "update", { fields })).statusCode).toBe(409);
      release(selfReview("按材料重写")); await f.t.monthlyReviews!.idle();
      expect(await f.read(id)).toMatchObject({ status: "draft", draftSource: "co_agent", materialCount: 2,
        selfReview: { overall: { text: "按材料重写" } } });
      expect(f.personalCalls.at(-1)).toMatchObject({ attachments: [{ extractedText: "附件实际结果" }], messages: [{ content: "粘贴的个人草稿" }],
        missions: [{ outcome: "承诺结果", why: "原因", successEvidence: ["验收证据"], milestones: ["里程碑"], boundaries: "边界" }] });
      f.generate(async () => ({ invented: true })); await f.act(id, "draft_with_co_agent"); await f.t.monthlyReviews!.idle();
      expect(await f.read(id)).toMatchObject({ status: "draft_failed", draftError: { code: "invalid_monthly_review_candidate" } });
      f.generate(async () => { throw new Error("生成失败"); }); await f.act(id, "draft_with_co_agent"); await f.t.monthlyReviews!.idle();
      expect(await f.read(id)).toMatchObject({ status: "draft_failed", draftError: { message: "生成失败" } });
      await f.act(id, "update", { fields }); expect((await f.read(id)).status).toBe("draft");
      await f.t.sql("UPDATE personal_reviews SET status='drafting',updated_at=$2 WHERE id=$1", [id, new Date(START.getTime() - 11 * 60_000)]);
      expect(await f.t.monthlyReviews!.recoverInterrupted()).toBe(1);
      expect(await f.read(id)).toMatchObject({ status: "draft_failed", draftError: { code: "personal_review_interrupted" } });
      let releaseStale!: (value: unknown) => void;
      f.generate(() => new Promise((resolve) => { releaseStale = resolve; }));
      await f.act(id, "draft_with_co_agent");
      while (!releaseStale) await new Promise((resolve) => setTimeout(resolve, 5));
      f.now(new Date(START.getTime() + 11 * 60_000));
      expect(await f.t.monthlyReviews!.recoverInterrupted()).toBe(1);
      releaseStale(selfReview("过期 run 不应覆盖")); await f.t.monthlyReviews!.idle();
      expect((await f.read(id)).status).toBe("draft_failed");
    } finally { await f.close(); }
  });

  it("并发交齐只衔接一次；已有 draft / returned 正文不覆盖，只生成四栏建议", async () => {
    const f = await fixture();
    try {
      await f.open();
      await f.t.sql("UPDATE monthly_review_items SET status='draft',self_review=$1", [JSON.stringify(selfReview("保留原文"))]);
      const rows = (await f.board(f.ceo)).rows;
      const results = await Promise.all(rows.map((row: any) => f.act(row.personalReviewId, "skip", undefined, f.ceo)));
      expect(results.map((response) => response.statusCode)).toEqual([200, 200]);
      await f.t.monthlyReviews!.idle(); expect(f.draftCalls).toHaveLength(1);
      const items = await f.t.sql("SELECT status,self_review,suggestions FROM monthly_review_items");
      for (const item of items) { expect(item.self_review).toEqual(selfReview("保留原文")); expect(item.suggestions).toHaveLength(4); }
    } finally { await f.close(); }
  });
});

describe("个人复盘 MCP", () => {
  it("读取本人材料、发现待办、保存可重放草稿并返回 PUBLIC_ORIGIN 链接，拒绝提交和锁定状态", async () => {
    const f = await fixture([TEST_MEMBER.personId]);
    vi.stubEnv("PUBLIC_ORIGIN", testEnv.publicOrigin);
    try {
      const token = (await f.call(f.member, "POST", "/api/me/tokens", { name: "review-test", client: "codex", expiresInDays: null })).json().token;
      let requestId = 0;
      const invoke = async (name: string, args = {}) => {
        const response = await f.t.app.inject({ method: "POST", url: "/mcp/me", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
          payload: { jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } } });
        return JSON.parse(response.json().result.content[0].text);
      };
      expect(await invoke("get_my_review")).toMatchObject({ review: null });
      await f.open(); const id = (await f.board()).rows[0].personalReviewId;
      expect((await f.read(id)).toolConnected).toBe(true);
      const task = randomUUID(), foreignTask = randomUUID();
      for (const [taskId, owner] of [[task, TEST_MEMBER.personId], [foreignTask, TEST_CEO.personId]]) {
        await f.t.sql("INSERT INTO tasks(id,title,status,owner_id,created_by,mission_id,step_order) VALUES($1,'进展任务','in_progress',$2,$2,$3,1)", [taskId, owner, `mission-${TEST_MEMBER.personId}`]);
        await f.t.sql("INSERT INTO task_progress(id,task_id,author_id,source,body,created_at) VALUES($1,$2,$3,'web',$4,$5)", [randomUUID(), taskId, owner, owner === TEST_MEMBER.personId ? "本人的进展" : "他人的进展", START]);
      }
      expect((await invoke("list_pending")).items).toContainEqual(expect.objectContaining({ id, kind: "personal-review" }));
      expect(await invoke("get_my_review")).toMatchObject({ id, version: 2, status: "draft", missions: [{ outcome: "承诺结果" }], weeklyProgress: [{ body: "本人的进展" }], writingRequirements: expect.stringContaining("Formation Input") });
      expect((await invoke("get_my_review")).weeklyProgress).toHaveLength(1);
      const standalone = randomUUID();
      await f.t.sql("INSERT INTO tasks(id,title,status,owner_id,created_by) VALUES($1,'独立事项','in_progress',$2,$2)", [standalone, TEST_MEMBER.personId]);
      await f.t.sql("INSERT INTO task_progress(id,task_id,author_id,source,body,created_at) VALUES($1,$2,$3,'web','独立事项进展',$4)", [randomUUID(), standalone, TEST_MEMBER.personId, START]);
      expect((await invoke("get_my_review")).weeklyProgress).toHaveLength(2);
      const saved = await invoke("save_review_draft", { version: 2, fields });
      expect(saved).toMatchObject({ status: "draft", version: 3, message: "请到天枢确认后提交", href: `${testEnv.publicOrigin}/me/reviews/personal/${id}` });
      expect(await invoke("save_review_draft", { version: 2, fields })).toEqual(saved);
      expect((await f.read(id)).draftSource).toBe("agent_tool");
      expect(await invoke("save_review_draft", { version: 2, fields: [{ ...fields[0], text: "过期" }] })).toMatchObject({ code: "VERSION_CONFLICT" });
      expect(await invoke("save_review_draft", { version: 3, fields, submit: true })).toMatchObject({ code: "INVALID_INPUT" });
      for (const status of ["drafting", "submitted", "skipped"]) {
        await f.t.sql("UPDATE personal_reviews SET status=$2 WHERE id=$1", [id, status]);
        expect(await invoke("save_review_draft", { version: 3, fields })).toMatchObject({ code: "PERSONAL_REVIEW_STATE" });
      }
      await f.t.sql("UPDATE personal_reviews SET status='draft_failed' WHERE id=$1", [id]);
      expect(await invoke("save_review_draft", { version: 3, fields })).toMatchObject({ status: "draft", version: 4 });
    } finally { vi.unstubAllEnvs(); await f.close(); }
  });
});

describe("72 小时月度经营周期", () => {
  it("按现状推进各阶段，全部战场确认才完成，保留七天且跨年月份正确", async () => {
    const f = await fixture([TEST_MEMBER.personId]);
    try {
      const reviewId = await f.open(); const id = (await f.board()).rows[0].personalReviewId;
      const cycle = async () => (await f.call(f.member, "GET", "/api/monthly-cycle")).json().cycle;
      expect(Value.Check(MonthlyCycle, await cycle())).toBe(true);
      await f.act(id, "skip", undefined, f.ceo); await f.t.monthlyReviews!.idle();
      expect((await cycle()).stage).toBe("unit_reviews");
      for (const [status, stage] of [["summarizing", "company_summary"], ["ltco_pending", "lto_decision"]]) {
        await f.t.sql("UPDATE monthly_reviews SET status=$2 WHERE id=$1", [reviewId, status]); expect((await cycle()).stage).toBe(stage);
      }
      await f.t.sql("UPDATE monthly_reviews SET status='closed',ltco_decision='{}' WHERE id=$1", [reviewId]);
      expect((await cycle()).stage).toBe("period_plan");
      const plan = randomUUID();
      await f.t.sql("INSERT INTO monthly_plans(id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at) VALUES($1,1,'2026-10','confirmed','结果','[]','[]','{}','{}',$2)", [plan, START]);
      expect((await cycle()).stage).toBe("mission_cards");
      await f.t.sql("INSERT INTO battlefield_config(id,version,code,name,six_month_outcome) VALUES('second',1,'02','第二战场','长期目标')");
      const completed = new Date("2026-10-02T02:00:00Z");
      for (const field of ["growth", "second"]) {
        await f.t.sql(`INSERT INTO mission_rounds(id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,
          opened_at,first_opened_at,closes_at,confirmed_at,confirmed_by,created_at,updated_at) VALUES($1,1,$2,'2026-10',$3,'confirmed','agent','{}',$4,$4,$5,$5,$6,$4,$5)`,
        [randomUUID(), field, plan, START, completed, TEST_CEO.personId]);
        if (field === "growth") expect((await cycle()).completedAt).toBeNull();
      }
      f.now(completed); expect(await cycle()).toMatchObject({ stage: "done", completedAt: completed.toISOString(), startedAt: START.toISOString(), deadlineAt: "2026-10-03T02:00:00.000Z" });
      f.now(new Date(completed.getTime() + 7 * 86_400_000)); expect(await cycle()).not.toBeNull();
      f.now(new Date(completed.getTime() + 7 * 86_400_000 + 1)); expect(await cycle()).toBeNull();
      await f.t.sql("UPDATE monthly_reviews SET period='2026-12' WHERE id=$1", [reviewId]);
      expect((await cycle()).nextPeriod).toBe("2027-01");
    } finally { await f.close(); }
  });
});

describe("跨月工作台与任务卡起草", () => {
  it("无当月 Mission 或 confirmed 卡时回落目标与 Mission；当前草稿卡保留，引导与战场详情一致", async () => {
    const f = await fixture([TEST_MEMBER.personId]);
    try {
      f.now(new Date("2026-10-01T02:00:00Z"));
      const plans: string[] = [];
      for (const period of ["2026-09", "2026-10"]) {
        const id = randomUUID(); plans.push(id);
        await f.t.sql(`INSERT INTO monthly_plans(id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
          VALUES($1,1,$2,'confirmed','目标',$3,'[]','{}','{}',$4)`, [id, period, JSON.stringify([{ battlefieldId: "growth", outcome: `${period} 目标` }]), START]);
      }
      const round = randomUUID(), card = randomUUID();
      await f.t.sql(`INSERT INTO mission_rounds(id,version,battlefield_id,period,monthly_plan_id,status,draft_origin,draft_source,created_at,updated_at)
        VALUES($1,1,'growth','2026-10',$2,'draft','agent','{}',$3,$3)`, [round, plans[1], START]);
      await f.t.sql("INSERT INTO personal_mission_cards(id,round_id,owner_id,sort_order,member_ids,created_at) VALUES($1,$2,$3,1,$4,$5)",
        [card, round, TEST_MEMBER.personId, JSON.stringify([TEST_MEMBER.personId, TEST_CEO.personId]), START]);
      const home = async () => (await f.call(f.member, "GET", "/api/me/home")).json().work;
      expect(await home()).toMatchObject({ period: "2026-09", missions: [{ id: `mission-${TEST_MEMBER.personId}` }],
        battlefields: [{ id: "growth", monthTarget: "2026-09 目标" }], missionCards: [{ period: "2026-10", cardId: card }] });
      expect((await f.call(f.member, "GET", "/api/me/battlefields/growth")).json()).toMatchObject({ period: "2026-09", monthTarget: "2026-09 目标" });
      expect((await f.call(f.member, "GET", "/api/me/onboarding")).json().work.period).toBe("2026-09");
      await f.t.sql("UPDATE mission_rounds SET status='confirmed',opened_at=$2,first_opened_at=$2,confirmed_at=$2,confirmed_by=$3 WHERE id=$1", [round, START, TEST_CEO.personId]);
      expect((await home()).period).toBe("2026-10");
      await f.t.sql("UPDATE mission_rounds SET status='draft',opened_at=NULL,first_opened_at=NULL,confirmed_at=NULL,confirmed_by=NULL WHERE id=$1", [round]);
      await f.t.sql("UPDATE missions SET period='2026-10' WHERE owner_id=$1", [TEST_MEMBER.personId]);
      expect((await home()).period).toBe("2026-10");
    } finally { await f.close(); }
  });

  it("十月起草包含上月独立 Mission 的在册 owner，并带本人已提交复盘；CEO 不拿卡", async () => {
    const f = await fixture();
    try {
      await seedMission(f.t, "unknown-owner"); await f.open();
      await f.t.sql("UPDATE personal_reviews SET status='submitted',self_review=$2,submitted_at=$3 WHERE person_id=$1", [TEST_MEMBER.personId, JSON.stringify(selfReview()), START]);
      const plan = randomUUID();
      await f.t.sql(`INSERT INTO monthly_plans(id,version,period,status,company_outcome,battlefields,todos,negotiation,generation,confirmed_at)
        VALUES($1,1,'2026-10','confirmed','十月公司 PO','[{"battlefieldId":"growth","outcome":"十月战场 PO"}]','[]','{}','{}',$2)`, [plan, START]);
      const seen: MissionCardDraftInput[] = [];
      const candidate = { missions: [1, 2].map((n) => ({ capabilityCode: "01", title: `任务${n}`, why: "原因", outcome: "结果", timeBoundary: "10月完成验收", tradeoffs: "优先当前结果", successEvidence: ["证据"], boundaries: "边界", keyPath: "路径",
        milestones: ["10/12 验收"], resources: "资源", dependencies: "依赖", humanAgentSplit: "分工", risk: "风险", retrospect: "待复盘", basis: "上月独立 Mission 和个人复盘" })) };
      const forbidden = await executeDraftMissionRound(f.t.pool, loadCompanyMemory(testEnv).searchPeople(undefined), testEnv.sessionSecret,
        { personId: TEST_CEO.personId, role: "ceo" }, { actionType: "mission-round.draft", objectType: "mission-round-slot", objectId: "growth:2026-10", objectVersion: 1 },
        "test-ceo-cannot-draft", () => START, undefined, { async generate(input) { seen.push(input); return { candidate }; } });
      expect(forbidden).toMatchObject({ error: { status: 403 } });
      expect(seen).toEqual([]);
      const result = await executeDraftMissionRound(f.t.pool, loadCompanyMemory(testEnv).searchPeople(undefined), testEnv.sessionSecret,
        { personId: TEST_MEMBER.personId, role: "member" }, { actionType: "mission-round.draft", objectType: "mission-round-slot", objectId: "growth:2026-10", objectVersion: 1 },
        "test-carryover", () => START, undefined, { async generate(input) { seen.push(input); return { candidate }; } });
      expect(result).toHaveProperty("card");
      await vi.waitFor(async () => expect((await f.t.sql("SELECT status FROM mission_rounds WHERE period='2026-10'"))[0].status).toBe("open"), { timeout: 5000 });
      expect(seen.map((input) => input.owner.personId)).toEqual([TEST_MEMBER.personId]);
      const member = seen.find((input) => input.owner.personId === TEST_MEMBER.personId)!;
      expect(member.previousCard?.missions).toMatchObject([{ title: "本人承诺", outcome: "承诺结果", success_evidence: ["验收证据"] }]);
      expect(member.previousReview).toEqual(selfReview());
      expect(await f.t.sql("SELECT count(*)::int AS n FROM missions WHERE period='2026-10'")).toEqual([{ n: 2 }]);
    } finally { await f.close(); }
  });
});
