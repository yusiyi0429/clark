import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { Card, ResearchDoc, type TResearchDoc } from "@warmap/contracts";
import { buildApp } from "../src/app.js";
import { signActionId } from "../src/actionToken.js";
import { revokeIssueReceipt } from "../src/effects.js";
import { recoverInterruptedResearch } from "../src/issues.js";
import { createResearchService, type ResearchRunner } from "../src/research.js";
import { createRadarService } from "../src/radar.js";
import { migrate } from "../src/migrate.js";
import { createTestDb, seedTestAccess, testEnv, TEST_LOGIN } from "./helpers.js";
import type { ConversationRuntime } from "../src/conversations.js";
import type { AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createResearchAgentRunner } from "../src/researchAgent.js";
import { createCompanyContext } from "../src/companyContext.js";

const RESEARCH_DOC: TResearchDoc = {
  summary: "渠道政策调整需要 CEO 决定投入节奏",
  options: [
    { id: "adjust", label: "调整渠道投入", consequences: ["短期成本上升", "保住申报窗口"] },
    { id: "hold", label: "维持现有投入", consequences: ["放弃本轮申报"] },
  ],
  evidence: [{ quote: "渠道政策将在六月一日调整", sourceTitle: "渠道政策公告", sourceUrl: "https://example.com/channel" }],
  unknowns: ["调整后的实际成本"],
  sources: [{ title: "渠道政策公告", url: "https://example.com/channel" }],
};

const RESEARCH_DOC_V2: TResearchDoc = { ...RESEARCH_DOC, summary: "第二次预研：政策细节已澄清" };

const DRI_ISSUE = {
  externalId: "ticket08-issue-001",
  submitterPersonId: "person-fixture-002",
  title: "是否调整渠道投入",
  whyNow: "渠道窗口在六月关闭",
  sourceRef: "dri://planning/growth-08",
  location: { level: "battlefield", battlefieldId: "growth" },
};

const fakeRuntime: ConversationRuntime = {
  async run(input) {
    input.emit({ type: "message", delta: "ok" });
    return { assistantMessage: "ok", runtimeEntries: input.runtimeEntries };
  },
};

/** 顺序返回预设候选：值时成功，Error 时抛出，用于确定性覆盖 ready/failed。 */
function queueRunner(items: (unknown | Error)[]): { runner: ResearchRunner; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    runner: async (input) => {
      calls.push(input);
      const next = items.shift();
      if (next === undefined) throw new Error("no queued research candidate");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/** 可外部放行的 runner：用于观察 running 状态。 */
function deferredRunner(): { runner: ResearchRunner; calls: unknown[]; release: (value: unknown) => void } {
  const calls: unknown[] = [];
  let release: (value: unknown) => void = () => undefined;
  const runner: ResearchRunner = async (input) => {
    calls.push(input);
    return new Promise((resolve) => { release = resolve; });
  };
  return { runner, calls, release: (value) => release(value) };
}

async function until<T>(check: () => Promise<T | undefined>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, db: { query: (text: string, params?: unknown[]) => Promise<unknown> }): Promise<string> {
  await seedTestAccess(db);
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: testEnv.publicOrigin },
    payload: TEST_LOGIN,
  });
  return (response.headers["set-cookie"] as string).split(";")[0];
}

function postDri(app: Awaited<ReturnType<typeof buildApp>>, payload: unknown) {
  return app.inject({
    method: "POST",
    url: "/api/dri/issues",
    headers: { authorization: `Bearer ${testEnv.driServiceToken}` },
    payload: payload as Record<string, unknown>,
  });
}

async function issueCard(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, id: string) {
  const response = await app.inject({ method: "GET", url: `/api/cards/issues/${id}`, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json().cards[0] as {
    id: string;
    version: number;
    actions: { actionId: string; actionType: string; itemId?: string }[];
    payload: {
      status: string;
      research: { status: string; doc?: unknown; error?: { code: string } | null; runId?: string; previousRunIds: string[] };
      receipts: {
        id: string; decisionText: string; optionId?: string; override: boolean;
        researchStatusAtDecision: string; researchRunId?: string; revokedAt?: string; effectRef: string;
      }[];
      dismissedAt: string | null;
      dismissReason: string | null;
      restoredAt?: string | null;
    };
  };
}

async function execute(
  app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  actionId: string,
  input?: unknown,
) {
  return app.inject({
    method: "POST",
    url: "/api/actions/execute",
    headers: { origin: testEnv.publicOrigin, cookie },
    payload: { actionId, input: input ?? {} },
  });
}

function action(card: Awaited<ReturnType<typeof issueCard>>, actionType: string) {
  const found = card.actions.find((candidate) => candidate.actionType === actionType);
  if (!found) throw new Error(`missing action ${actionType} in ${card.actions.map((a) => a.actionType).join(",")}`);
  return found;
}

async function setupWithResearch(
  pool: Parameters<typeof createResearchService>[0]["pool"],
  runner: ResearchRunner,
  research = createResearchService({ pool, runner }),
) {
  const app = await buildApp({ pool, env: testEnv, researchService: research, conversationRuntime: fakeRuntime });
  return { app, research };
}

describe("Issue research lifecycle", () => {
  it("observes pending -> running -> ready with a strictly validated ResearchDoc", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const deferred = deferredRunner();
      const { app, research } = await setupWithResearch(pool, deferred.runner);
      try {
        const created = await postDri(app, { ...DRI_ISSUE, externalId: "ticket08-ready" });
        expect(created.statusCode).toBe(201);
        const id = created.json().cards[0].objectRef.id as string;
        expect(created.json().cards[0].payload.research).toMatchObject({ status: "pending" });

        const cookie = await login(app, db);
        const running = await until(async () => {
          const card = await issueCard(app, cookie, id);
          return card.payload.research.status === "running" ? card : undefined;
        });
        expect(running.payload.research.runId).toBeTruthy();

        deferred.release(structuredClone(RESEARCH_DOC));
        await research.idle();
        const ready = await issueCard(app, cookie, id);
        expect(ready.payload.research).toMatchObject({ status: "ready", error: null });
        expect(ready.payload.research.doc).toEqual(RESEARCH_DOC);
        expect(Value.Check(Card, ready)).toBe(true);
        // ready 后只暴露直接决定，不再暴露 override
        expect(ready.actions.map((a) => a.actionType)).toEqual(
          expect.arrayContaining(["issue.decide", "issue.dismiss"]),
        );
        expect(ready.actions.map((a) => a.actionType)).not.toContain("issue.decide_override");
      } finally {
        await app.close();
      }
    });
  });

  it("surfaces a failed run in place without auto retrying", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const queue = queueRunner([new Error("模型端点超时")]);
      const { app, research } = await setupWithResearch(pool, queue.runner);
      try {
        const created = await postDri(app, { ...DRI_ISSUE, externalId: "ticket08-failed" });
        const id = created.json().cards[0].objectRef.id as string;
        await research.idle();
        const cookie = await login(app, db);
        const card = await issueCard(app, cookie, id);
        expect(card.payload.research).toMatchObject({ status: "failed", error: { code: "research_failed" } });
        expect(card.actions.map((a) => a.actionType)).toEqual(
          expect.arrayContaining(["issue.decide_override", "issue.retry_research"]),
        );
        expect(queue.calls).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  });

  it("rejects a candidate that violates the strict ResearchDoc schema", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const queue = queueRunner([{ summary: "缺少 options", evidence: [], unknowns: [], sources: [] }]);
      expect(Value.Check(ResearchDoc, { summary: "缺少 options" })).toBe(false);
      const { app, research } = await setupWithResearch(pool, queue.runner);
      try {
        const created = await postDri(app, { ...DRI_ISSUE, externalId: "ticket08-invalid" });
        const id = created.json().cards[0].objectRef.id as string;
        await research.idle();
        const cookie = await login(app, db);
        const card = await issueCard(app, cookie, id);
        expect(card.payload.research).toMatchObject({ status: "failed", error: { code: "invalid_research_doc" } });
        expect(card.payload.research.doc).toBeUndefined();
      } finally {
        await app.close();
      }
    });
  });

  it("rejects a ResearchDoc whose visible prose uses a turn phrase", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const forbidden = { ...structuredClone(RESEARCH_DOC), summary: "问题不是投入多少，而是何时投入" };
      expect(Value.Check(ResearchDoc, forbidden)).toBe(true);
      const queue = queueRunner([forbidden]);
      const { app, research } = await setupWithResearch(pool, queue.runner);
      try {
        const created = await postDri(app, { ...DRI_ISSUE, externalId: "ticket24-turn-phrase" });
        const id = created.json().cards[0].objectRef.id as string;
        await research.idle();
        const cookie = await login(app, db);
        const card = await issueCard(app, cookie, id);
        expect(card.payload.research).toMatchObject({ status: "failed", error: { code: "invalid_research_doc" } });
        expect(card.payload.research.doc).toBeUndefined();
      } finally {
        await app.close();
      }
    });
  });
});

describe("explicit whole-document re-research", () => {
  it("replaces the whole doc, keeps the previous run, and only allows pending Issues", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const queue = queueRunner([structuredClone(RESEARCH_DOC), structuredClone(RESEARCH_DOC_V2)]);
      const { app, research } = await setupWithResearch(pool, queue.runner);
      try {
        const created = await postDri(app, { ...DRI_ISSUE, externalId: "ticket08-retry" });
        const id = created.json().cards[0].objectRef.id as string;
        await research.idle();
        const cookie = await login(app, db);
        const ready = await issueCard(app, cookie, id);
        const firstRunId = ready.payload.research.runId as string;

        const retried = await execute(app, cookie, action(ready, "issue.retry_research").actionId, {});
        expect(retried.statusCode).toBe(200);
        const running = retried.json().cards[0];
        expect(running.payload.research.status).toBe("running");
        // 重跑整份替换：旧 doc 不留在 Issue 上；内部 fingerprint 也不进 payload
        expect(running.payload.research.doc).toBeUndefined();
        expect("retryFingerprint" in (running.payload.research as Record<string, unknown>)).toBe(false);
        expect(running.payload.research.previousRunIds).toContain(firstRunId);

        await research.idle();
        const after = await issueCard(app, cookie, id);
        expect(after.payload.research.status).toBe("ready");
        expect(after.payload.research.doc).toEqual(RESEARCH_DOC_V2);
        expect(after.payload.research.previousRunIds).toContain(firstRunId);

        // 重放相同重跑 Action：不产生第三个 run
        const replay = await execute(app, cookie, action({ ...ready, version: ready.version }, "issue.retry_research").actionId, {});
        expect(replay.statusCode).toBe(200);

        const decided = await execute(app, cookie, action(after, "issue.decide").actionId, {
          decisionText: "按新预研决定",
          optionId: "adjust",
        });
        expect(decided.statusCode).toBe(200);
        const staleRetry = signActionId(testEnv.sessionSecret, {
          actionType: "issue.retry_research",
          objectType: "issue",
          objectId: id,
          objectVersion: decided.json().cards[0].version,
        });
        const rejected = await execute(app, cookie, staleRetry, {});
        expect(rejected.statusCode).toBe(409);
        expect(rejected.json()).toMatchObject({ code: "ISSUE_NOT_PENDING" });
      } finally {
        await app.close();
      }
    });
  });

  it("refuses to re-run while the current run is still running", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const deferred = deferredRunner();
      const { app, research } = await setupWithResearch(pool, deferred.runner);
      try {
        const created = await postDri(app, { ...DRI_ISSUE, externalId: "ticket08-running-retry" });
        const id = created.json().cards[0].objectRef.id as string;
        const cookie = await login(app, db);
        const cookieForRetry = cookie;
        const running = await until(async () => {
          const card = await issueCard(app, cookieForRetry, id);
          return card.payload.research.status === "running" ? card : undefined;
        });
        // 运行中 Card 不暴露重跑，服务端仍拒绝伪造/过期的重跑 Action
        expect(running.actions.map((a) => a.actionType)).not.toContain("issue.retry_research");
        const retryId = signActionId(testEnv.sessionSecret, {
          actionType: "issue.retry_research",
          objectType: "issue",
          objectId: id,
          objectVersion: running.version,
        });
        const rejected = await execute(app, cookie, retryId, {});
        expect(rejected.statusCode).toBe(409);
        expect(rejected.json()).toMatchObject({ code: "RESEARCH_RUNNING" });
        // 放行挂起的 run，让 onClose 的 idle() 能结束
        deferred.release(structuredClone(RESEARCH_DOC));
        await research.idle();
      } finally {
        await app.close();
      }
    });
  });

  it("recovers from failed with an explicit whole-document rerun", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const queue = queueRunner([new Error("第一次运行失败"), structuredClone(RESEARCH_DOC)]);
      const { app, research } = await setupWithResearch(pool, queue.runner);
      try {
        const created = await postDri(app, { ...DRI_ISSUE, externalId: "ticket08-failed-retry" });
        const id = created.json().cards[0].objectRef.id as string;
        await research.idle();
        const cookie = await login(app, db);
        const failed = await issueCard(app, cookie, id);
        expect(failed.payload.research.status).toBe("failed");
        const failedRunId = failed.payload.research.runId as string;

        const retried = await execute(app, cookie, action(failed, "issue.retry_research").actionId, {});
        expect(retried.statusCode).toBe(200);
        await research.idle();
        const ready = await issueCard(app, cookie, id);
        expect(ready.payload.research.status).toBe("ready");
        expect(ready.payload.research.doc).toEqual(RESEARCH_DOC);
        expect(ready.payload.research.previousRunIds).toContain(failedRunId);
        expect(queue.calls).toHaveLength(2);
      } finally {
        await app.close();
      }
    });
  });

  it("never lets a Conversation turn change the ResearchDoc", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const queue = queueRunner([structuredClone(RESEARCH_DOC)]);
      const { app, research } = await setupWithResearch(pool, queue.runner);
      try {
        const created = await postDri(app, { ...DRI_ISSUE, externalId: "ticket08-conversation" });
        const id = created.json().cards[0].objectRef.id as string;
        await research.idle();
        const cookie = await login(app, db);
        const before = await issueCard(app, cookie, id);

        const turn = await app.inject({
          method: "POST",
          url: `/api/conversations/issue:${id}/messages`,
          headers: { origin: testEnv.publicOrigin, cookie },
          payload: { message: "把这部分改成另一个结论" },
        });
        expect(turn.statusCode).toBe(200);

        const after = await issueCard(app, cookie, id);
        expect(after.payload.research.doc).toEqual(before.payload.research.doc);
        expect(after.payload.receipts).toEqual([]);
      } finally {
        await app.close();
      }
    });
  });
});

describe("CEO direct decision", () => {
  it("decides from ready research, stores the final text and research state, and is replay-safe", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const queue = queueRunner([structuredClone(RESEARCH_DOC)]);
      const { app, research } = await setupWithResearch(pool, queue.runner);
      try {
        const created = await postDri(app, { ...DRI_ISSUE, externalId: "ticket08-decide" });
        const id = created.json().cards[0].objectRef.id as string;
        await research.idle();
        const cookie = await login(app, db);
        const ready = await issueCard(app, cookie, id);
        const runId = ready.payload.research.runId as string;

        const decide = action(ready, "issue.decide");
        const input = { decisionText: "CEO 最终决定：先调整渠道投入", optionId: "adjust" };
        const decided = await execute(app, cookie, decide.actionId, input);
        expect(decided.statusCode).toBe(200);
        const card = decided.json().cards[0];
        expect(card.payload).toMatchObject({
          status: "decided",
          receipts: [{
            decisionText: input.decisionText,
            optionId: "adjust",
            researchStatusAtDecision: "ready",
            researchRunId: runId,
            override: false,
          }],
        });
        expect(card.payload.receipts[0].revokedAt).toBeUndefined();
        expect(card.actions.map((a: { actionType: string }) => a.actionType)).toEqual(["issue.revoke_receipt"]);

        const replay = await execute(app, cookie, decide.actionId, input);
        expect(replay.statusCode).toBe(200);
        expect(replay.json().cards[0].payload.receipts).toHaveLength(1);
        expect(await db.query("SELECT jsonb_array_length(receipts) AS count FROM issues WHERE id = $1", [id]))
          .toMatchObject({ rows: [{ count: 1 }] });

        // 旧 version 的新 fingerprint → 冲突并返回最新 Card
        const stale = await execute(app, cookie, decide.actionId, { decisionText: "另一个决定", optionId: "hold" });
        expect(stale.statusCode).toBe(409);
        expect(stale.json()).toMatchObject({ code: "VERSION_CONFLICT" });
        expect(stale.json().latestCard.payload.status).toBe("decided");
        expect(stale.json().latestCard.payload.receipts).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  });

  it("rejects an option that is not in the current ResearchDoc", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const queue = queueRunner([structuredClone(RESEARCH_DOC)]);
      const { app, research } = await setupWithResearch(pool, queue.runner);
      try {
        const created = await postDri(app, { ...DRI_ISSUE, externalId: "ticket08-bad-option" });
        const id = created.json().cards[0].objectRef.id as string;
        await research.idle();
        const cookie = await login(app, db);
        const ready = await issueCard(app, cookie, id);
        const rejected = await execute(app, cookie, action(ready, "issue.decide").actionId, {
          decisionText: "决定",
          optionId: "not-an-option",
        });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json()).toMatchObject({ code: "INVALID_INPUT" });
      } finally {
        await app.close();
      }
    });
  });
});

describe("Research Override", () => {
  it("requires second confirmation and records override with the research status at decision", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const queue = queueRunner([new Error("模型端点超时")]);
      const { app, research } = await setupWithResearch(pool, queue.runner);
      try {
        const created = await postDri(app, { ...DRI_ISSUE, externalId: "ticket08-override" });
        const id = created.json().cards[0].objectRef.id as string;
        await research.idle();
        const cookie = await login(app, db);
        const failed = await issueCard(app, cookie, id);
        const override = action(failed, "issue.decide_override");

        const noConfirm = await execute(app, cookie, override.actionId, { decisionText: "直接决定" });
        expect(noConfirm.statusCode).toBe(400);
        expect(noConfirm.json()).toMatchObject({ code: "INVALID_INPUT" });

        const decided = await execute(app, cookie, override.actionId, {
          decisionText: "CEO 覆盖：不等预研",
          confirmOverride: true,
        });
        expect(decided.statusCode).toBe(200);
        expect(decided.json().cards[0].payload).toMatchObject({
          status: "decided",
          receipts: [{
            decisionText: "CEO 覆盖：不等预研",
            override: true,
            researchStatusAtDecision: "failed",
          }],
        });
      } finally {
        await app.close();
      }
    });
  });

  it("allows override only while research is pending or failed", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const reachedModels = queueRunner([structuredClone(RESEARCH_DOC)]);
      const { app, research } = await setupWithResearch(pool, reachedModels.runner);
      try {
        const ready = await postDri(app, { ...DRI_ISSUE, externalId: "ticket08-override-ready" });
        const readyId = ready.json().cards[0].objectRef.id as string;
        await research.idle();
        const cookie = await login(app, db);
        const readyCard = await issueCard(app, cookie, readyId);
        // ready 时没有 override Action；伪造一个当前 version 的 override 也会被拒
        const forged = signActionId(testEnv.sessionSecret, {
          actionType: "issue.decide_override",
          objectType: "issue",
          objectId: readyId,
          objectVersion: readyCard.version,
        });
        const rejected = await execute(app, cookie, forged, { decisionText: "x", confirmOverride: true });
        expect(rejected.statusCode).toBe(409);
        expect(rejected.json()).toMatchObject({ code: "RESEARCH_READY" });
      } finally {
        await app.close();
      }
    });

    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      // 未注入 researchService 时 App 默认不启动预研：Issue 保持 pending，override 可用且记录 pending
      const app = await buildApp({ pool, env: testEnv, conversationRuntime: fakeRuntime });
      try {
        const created = await postDri(app, { ...DRI_ISSUE, externalId: "ticket08-override-pending" });
        const id = created.json().cards[0].objectRef.id as string;
        const cookie = await login(app, db);
        const pending = await issueCard(app, cookie, id);
        expect(pending.payload.research.status).toBe("pending");
        const decided = await execute(app, cookie, action(pending, "issue.decide_override").actionId, {
          decisionText: "预研尚未开始时决定",
          confirmOverride: true,
        });
        expect(decided.statusCode).toBe(200);
        expect(decided.json().cards[0].payload.receipts[0]).toMatchObject({
          override: true,
          researchStatusAtDecision: "pending",
        });
      } finally {
        await app.close();
      }
    });
  });
});

describe("dismissed Issue", () => {
  it("keeps origin and promotion fingerprint without deleting the Issue", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const app = await buildApp({ pool, env: testEnv, conversationRuntime: fakeRuntime });
      try {
        const created = await postDri(app, { ...DRI_ISSUE, externalId: "ticket08-dismiss" });
        const id = created.json().cards[0].objectRef.id as string;
        const originRef = created.json().cards[0].payload.originRef;
        const cookie = await login(app, db);
        const pending = await issueCard(app, cookie, id);

        const noReason = await execute(app, cookie, action(pending, "issue.dismiss").actionId, {});
        expect(noReason.statusCode).toBe(400);

        const dismissed = await execute(app, cookie, action(pending, "issue.dismiss").actionId, { reason: "误升级" });
        expect(dismissed.statusCode).toBe(200);
        expect(dismissed.json().cards[0].payload).toMatchObject({
          status: "dismissed",
          dismissReason: "误升级",
          originRef,
        });
        const row = await db.query<{ status: string; origin_ref: unknown; promotion_fingerprint: string | null }>(
          "SELECT status, origin_ref, promotion_fingerprint FROM issues WHERE id = $1",
          [id],
        );
        expect(row.rows[0].status).toBe("dismissed");
        expect(row.rows[0].origin_ref).toEqual(originRef);
        expect(row.rows[0].promotion_fingerprint).toBeNull(); // DRI 没有 promotion 指纹，但行未被删除

        const replay = await execute(app, cookie, action(pending, "issue.dismiss").actionId, { reason: "误升级" });
        expect(replay.statusCode).toBe(200);
        expect((await db.query("SELECT id FROM issues")).rows).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  });

  it("restores a dismissed Issue to pending and preserves the dismissal audit record", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const app = await buildApp({ pool, env: testEnv, conversationRuntime: fakeRuntime });
      try {
        const created = await postDri(app, { ...DRI_ISSUE, externalId: "issue-restore" });
        const id = created.json().cards[0].objectRef.id as string;
        const originRef = created.json().cards[0].payload.originRef;
        const cookie = await login(app, db);
        const pending = await issueCard(app, cookie, id);
        const researchBefore = pending.payload.research.status;
        const dismissed = await execute(app, cookie, action(pending, "issue.dismiss").actionId, { reason: "误升级" });
        expect(dismissed.statusCode).toBe(200);
        const dismissedCard = await issueCard(app, cookie, id);
        expect(dismissedCard.actions.map((candidate) => candidate.actionType)).toEqual(["issue.restore"]);

        const restored = await execute(app, cookie, action(dismissedCard, "issue.restore").actionId, {});
        expect(restored.statusCode).toBe(200);
        const card = restored.json().cards[0];
        expect(card.version).toBe(dismissedCard.version + 1);
        expect(card.payload).toMatchObject({
          status: "pending",
          originRef,
          research: { status: researchBefore },
          dismissedAt: dismissedCard.payload.dismissedAt,
          dismissReason: "误升级",
        });
        expect(typeof card.payload.restoredAt).toBe("string");
        // 待处理动作恢复可用
        expect(card.actions.map((candidate) => candidate.actionType)).toEqual(
          expect.arrayContaining(["issue.dismiss", "issue.decide_override"]),
        );

        const row = await db.query<{ status: string; restored_at: Date | null; restore_fingerprint: string | null; dismiss_reason: string | null; dismissed_at: Date | null }>(
          "SELECT status, restored_at, restore_fingerprint, dismiss_reason, dismissed_at FROM issues WHERE id = $1",
          [id],
        );
        expect(row.rows[0].status).toBe("pending");
        expect(row.rows[0].restored_at).not.toBeNull();
        expect(row.rows[0].restore_fingerprint).not.toBeNull();
        // 移出审计不删除
        expect(row.rows[0].dismiss_reason).toBe("误升级");
        expect(row.rows[0].dismissed_at).not.toBeNull();

        // 重复提交同一 restore actionId：幂等重放返回 200 且版本不再变
        const duplicate = await execute(app, cookie, action(dismissedCard, "issue.restore").actionId, {});
        expect(duplicate.statusCode).toBe(200);
        expect(duplicate.json().cards[0].version).toBe(card.version);
      } finally {
        await app.close();
      }
    });
  });

  it("allows restore only for dismissed Issues and enforces version on non-replay", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const app = await buildApp({ pool, env: testEnv, conversationRuntime: fakeRuntime });
      try {
        const created = await postDri(app, { ...DRI_ISSUE, externalId: "issue-restore-guards" });
        const id = created.json().cards[0].objectRef.id as string;
        const cookie = await login(app, db);
        const pending = await issueCard(app, cookie, id);

        const forgedPending = signActionId(testEnv.sessionSecret, {
          actionType: "issue.restore",
          objectType: "issue",
          objectId: id,
          objectVersion: pending.version,
        });
        const notDismissed = await execute(app, cookie, forgedPending, {});
        expect(notDismissed.statusCode).toBe(409);
        expect(notDismissed.json()).toMatchObject({ code: "ISSUE_NOT_DISMISSED" });

        const dismiss = await execute(app, cookie, action(pending, "issue.dismiss").actionId, { reason: "误升级" });
        expect(dismiss.statusCode).toBe(200);

        // 陈旧版本的 restore（version 已前进）：非重放路径必须 VERSION_CONFLICT
        const stale = signActionId(testEnv.sessionSecret, {
          actionType: "issue.restore",
          objectType: "issue",
          objectId: id,
          objectVersion: pending.version,
        });
        const conflict = await execute(app, cookie, stale, {});
        expect(conflict.statusCode).toBe(409);
        expect(conflict.json()).toMatchObject({ code: "VERSION_CONFLICT" });

        // decided 后 restore 同样拒绝（仅 dismissed 可恢复）：decide 需要 pending，另建一个 Issue
        const second = await postDri(app, { ...DRI_ISSUE, externalId: "issue-restore-decided" });
        const secondId = second.json().cards[0].objectRef.id as string;
        const secondPending = await issueCard(app, cookie, secondId);
        const decided = await execute(app, cookie, action(secondPending, "issue.decide_override").actionId, { decisionText: "x", confirmOverride: true });
        expect(decided.statusCode).toBe(200);
        const afterDecided = await issueCard(app, cookie, secondId);
        const forgedDecided = signActionId(testEnv.sessionSecret, {
          actionType: "issue.restore",
          objectType: "issue",
          objectId: secondId,
          objectVersion: afterDecided.version,
        });
        const rejected = await execute(app, cookie, forgedDecided, {});
        expect(rejected.statusCode).toBe(409);
        expect(rejected.json()).toMatchObject({ code: "ISSUE_NOT_DISMISSED" });
      } finally {
        await app.close();
      }
    });
  });

  it("is not available once the Issue is decided", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const queue = queueRunner([structuredClone(RESEARCH_DOC)]);
      const { app, research } = await setupWithResearch(pool, queue.runner);
      try {
        const created = await postDri(app, { ...DRI_ISSUE, externalId: "ticket08-dismiss-decided" });
        const id = created.json().cards[0].objectRef.id as string;
        await research.idle();
        const cookie = await login(app, db);
        const ready = await issueCard(app, cookie, id);
        const decided = await execute(app, cookie, action(ready, "issue.decide").actionId, { decisionText: "决定" });
        const version = decided.json().cards[0].version;
        const forged = signActionId(testEnv.sessionSecret, {
          actionType: "issue.dismiss",
          objectType: "issue",
          objectId: id,
          objectVersion: version,
        });
        const rejected = await execute(app, cookie, forged, { reason: "反悔" });
        expect(rejected.statusCode).toBe(409);
        expect(rejected.json()).toMatchObject({ code: "ISSUE_NOT_PENDING" });
      } finally {
        await app.close();
      }
    });
  });
});

describe("unified effect revoker", () => {
  it("revokes exactly one Receipt, restores the Issue state, and never claims to restore unsupported effects", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const queue = queueRunner([structuredClone(RESEARCH_DOC), structuredClone(RESEARCH_DOC_V2)]);
      const { app, research } = await setupWithResearch(pool, queue.runner);
      try {
        const created = await postDri(app, { ...DRI_ISSUE, externalId: "ticket08-revoke" });
        const id = created.json().cards[0].objectRef.id as string;
        await research.idle();
        const cookie = await login(app, db);
        let card = await issueCard(app, cookie, id);

        const firstDecide = await execute(app, cookie, action(card, "issue.decide").actionId, { decisionText: "决定 A" });
        expect(firstDecide.statusCode).toBe(200);
        card = firstDecide.json().cards[0] as typeof card;

        const revokeA = action(card, "issue.revoke_receipt");
        const revoked = await execute(app, cookie, revokeA.actionId, { reason: "撤回 A" });
        expect(revoked.statusCode).toBe(200);
        expect(revoked.json().cards[0].payload).toMatchObject({
          status: "pending",
          receipts: [{ id: revokeA.itemId, revokedAt: expect.any(String), revokeReason: "撤回 A" }],
        });

        // 撤回后 Issue 回到 pending，可以重新决定，产生第二个 Receipt
        card = revoked.json().cards[0] as typeof card;
        const secondDecide = await execute(app, cookie, action(card, "issue.decide").actionId, { decisionText: "决定 B" });
        expect(secondDecide.statusCode).toBe(200);
        card = secondDecide.json().cards[0] as typeof card;
        expect(card.payload.receipts).toHaveLength(2);

        // 重放已撤回的 Receipt：幂等，且不影响决定 B
        const replayA = await execute(app, cookie, revokeA.actionId, { reason: "撤回 A" });
        expect(replayA.statusCode).toBe(200);
        expect(replayA.json().cards[0].payload.status).toBe("decided");
        expect(replayA.json().cards[0].payload.receipts).toHaveLength(2);

        const revokeB = card.actions.find((candidate) => candidate.actionType === "issue.revoke_receipt");
        const revokedB = await execute(app, cookie, revokeB!.actionId, {});
        expect(revokedB.statusCode).toBe(200);
        expect(revokedB.json().cards[0].payload.status).toBe("pending");

        // meeting item 的撤回由 Ticket 11 的统一 meeting revoker 处理，Issue Receipt 纯函数不代为恢复
        const row = await db.query("SELECT * FROM issues WHERE id = $1", [id]);
        const meeting = revokeIssueReceipt(
          { ...row.rows[0], id, receipts: revokedB.json().cards[0].payload.receipts.map((r: Record<string, unknown>) => ({
            ...r, actionFingerprint: "x",
          })) } as never,
          `meeting:${randomUUID()}:decision:item-1`,
          "fp",
        );
        expect(meeting).toMatchObject({ ok: false, code: "UNKNOWN_EFFECT" });
      } finally {
        await app.close();
      }
    });
  });
});

describe("notification projection", () => {
  it("projects pending red Issues from the same persistent object as the Issue Card", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const app = await buildApp({ pool, env: testEnv, conversationRuntime: fakeRuntime });
      try {
        const red = await postDri(app, {
          ...DRI_ISSUE,
          externalId: "ticket08-notice-red",
          urgency: { level: "red", decisionBy: "2026-06-01T00:00:00.000+08:00", reason: "申报窗口关闭" },
        });
        const redId = red.json().cards[0].objectRef.id as string;
        const cookie = await login(app, db);

        const home = await app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie } });
        expect(home.statusCode).toBe(200);
        const notice = home.json().cards.find((card: { id: string }) => card.id === `issue:${redId}`);
        const detail = await issueCard(app, cookie, redId);
        expect(notice).toMatchObject({
          id: detail.id,
          version: detail.version,
          objectRef: detail.objectRef,
          urgency: "red",
        });

        const dismissed = await execute(app, cookie, action(detail, "issue.dismiss").actionId, { reason: "误升级" });
        expect(dismissed.statusCode).toBe(200);
        const after = await app.inject({ method: "GET", url: "/api/cards/home", headers: { cookie } });
        expect(after.json().cards.find((card: { id: string }) => card.id === `issue:${redId}`)).toBeUndefined();
      } finally {
        await app.close();
      }
    });
  });
});

/** Radar 升级夹具：固定来源与合格候选，onIssuePromoted 驱动同一 research service。 */
async function radarFixture(pool: Parameters<typeof createRadarService>[0]["pool"], runner: ResearchRunner) {
  const research = createResearchService({ pool, runner });
  const promoted: string[] = [];
  // 第二次扫描可换新来源 URL：同 promotion fingerprint、不同 source fingerprint
  const source = { url: "https://example.com/channel" };
  const radar = createRadarService({
    pool,
    web: {
      configured: true,
      async search() {
        return [{
          sourceType: "web",
          title: "渠道政策公告",
          url: source.url,
          publishedAt: "2026-05-01T08:00:00.000Z",
          excerpt: "公告确认渠道政策将在六月一日调整，并给出申报截止时间。",
          sourceRef: { type: "web-search", provider: "recorded-web", query: "竞争对手 最新定价" },
        }];
      },
    },
    assessor: {
      async assess({ sources }) {
        return {
          candidates: [{
            sourceFingerprint: sources[0].sourceFingerprint,
            anchorId: "anchor-market",
            summary: "渠道政策即将调整",
            strategicImpact: "需要 CEO 判断渠道投入节奏",
            evidenceQuote: "渠道政策将在六月一日调整",
            unknowns: [],
            score: { relevance: 5, impact: 4, urgency: 5 },
            promotion: {
              decisionKind: "resource_allocation",
              decisionQuestion: "是否在六月一日前调整渠道投入？",
              options: ["调整渠道投入", "维持现有投入"],
              location: { level: "battlefield", battlefieldId: "growth" },
              urgency: {
                level: "red",
                reason: "申报窗口在六月一日关闭",
                decisionBy: "2026-06-01T00:00:00.000+08:00",
                decisionByEvidence: { quote: "六月一日调整" },
              },
            },
          }],
        };
      },
    },
    onIssuePromoted: (issueId) => {
      promoted.push(issueId);
      void research.start(issueId);
    },
    now: () => new Date("2026-05-02T03:00:00.000Z"),
  });
  const app = await buildApp({ pool, env: testEnv, radarService: radar, researchService: research, conversationRuntime: fakeRuntime });
  return { radar, app, research, promoted, source };
}

async function configureRadarSources(db: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) {
  await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
    JSON.stringify([{
      id: "anchor-market", title: "市场定价", query: "竞争对手 最新定价",
      location: { type: "battlefield", id: "growth" },
    }]),
    JSON.stringify({ sites: [{ id: "site-web", name: "公开 Web", enabled: true, domains: ["example.com"] }], wechatAccounts: [] }),
  ]);
}

describe("radar promotion triggers research", () => {
  it("starts the same single-depth research for an auto-promoted pending Issue", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await configureRadarSources(db);
      const calls: unknown[] = [];
      const runner: ResearchRunner = async (input) => {
        calls.push(input);
        return structuredClone(RESEARCH_DOC);
      };
      const { radar, app, research, promoted } = await radarFixture(pool, runner);
      try {
        expect(await radar.runManual()).toMatchObject({ status: "completed", createdSignals: 1 });
        expect(promoted).toHaveLength(1);
        await research.idle();
        const cookie = await login(app, db);
        const card = await issueCard(app, cookie, promoted[0]);
        expect(card.payload).toMatchObject({ status: "pending", research: { status: "ready" } });
        expect(card.payload.research.doc).toEqual(RESEARCH_DOC);
        expect(calls[0]).toMatchObject({ issue: { id: promoted[0], origin: "radar" } });
      } finally {
        await app.close();
      }
    });
  });

  it("keeps the promotion fingerprint after a real dismiss Action and still blocks re-promotion", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      await configureRadarSources(db);
      const { radar, app, research, promoted, source } = await radarFixture(pool, queueRunner([]).runner);
      try {
        expect(await radar.runManual()).toMatchObject({ status: "completed", createdSignals: 1 });
        await research.idle();
        const cookie = await login(app, db);
        const pending = await issueCard(app, cookie, promoted[0]);

        const dismissed = await execute(app, cookie, action(pending, "issue.dismiss").actionId, { reason: "误升级" });
        expect(dismissed.statusCode).toBe(200);
        const row = await db.query<{ promotion_fingerprint: string; origin_ref: unknown }>(
          "SELECT promotion_fingerprint, origin_ref FROM issues WHERE id = $1",
          [promoted[0]],
        );
        expect(row.rows[0].promotion_fingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(row.rows[0].origin_ref).toBeTruthy();

        // 新来源 URL、同 promotion fingerprint 再次扫描：不新建，也不复占 pending
        source.url = "https://example.com/channel-b";
        expect(await radar.runManual()).toMatchObject({ status: "completed", createdSignals: 1 });
        const issues = await db.query("SELECT id, status FROM issues");
        expect(issues.rows).toHaveLength(1);
        expect(issues.rows[0]).toMatchObject({ id: promoted[0], status: "dismissed" });
      } finally {
        await app.close();
      }
    });
  });
});

describe("openapi surface", () => {
  it("publishes the research and decision contracts", async () => {
    const { buildOpenApiDocument } = await import("@warmap/contracts/openapi");
    const doc = buildOpenApiDocument();
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(["ResearchDoc", "IssueReceipt", "IssueDecideInput", "IssueDecideOverrideInput"]),
    );
  });
});

describe("strict ResearchDoc candidate tool", () => {
  const usage = {
    input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  function stream(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]) {
    const final: AssistantMessage = {
      role: "assistant", api: "openai-responses", provider: "warmap", model: "fake-heavy",
      content, usage, stopReason, timestamp: Date.now(),
    };
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => {
      events.push({ type: "start", partial: { ...final, content: [] } });
      const block = final.content[0];
      if (block.type === "toolCall") {
        events.push({ type: "toolcall_start", contentIndex: 0, partial: final });
        events.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: final });
        events.push({ type: "done", reason: "toolUse", message: final });
      } else {
        events.push({ type: "text_start", contentIndex: 0, partial: final });
        events.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: final });
        events.push({ type: "text_end", contentIndex: 0, content: block.text, partial: final });
        events.push({ type: "done", reason: "stop", message: final });
      }
    });
    return events;
  }

  function researchAgentRunner(
    db: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    streamSimple: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream,
  ) {
    const contexts: Context[] = [];
    const runner = createResearchAgentRunner({
      query: db.query.bind(db),
      companyMemory: createCompanyContext(testEnv),
      baseUrl: "https://provider.invalid/v1/responses",
      apiKey: "test-key",
      modelId: "fake-heavy",
      streamSimple: (model, context, options) => {
        contexts.push(context);
        return streamSimple(model, context, options);
      },
    });
    return { runner, contexts };
  }

  it("submits the doc through the strict submit_candidate tool and records the heavy AgentRun", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const { runner, contexts } = researchAgentRunner(db, () => stream([{
        type: "toolCall",
        id: "submit-1",
        name: "submit_candidate",
        arguments: structuredClone(RESEARCH_DOC),
      }], "toolUse"));
      const doc = await runner({ issue: { id: "fixture-08", title: "测试战略", origin: "dri", originRef: {}, location: {}, urgency: {} } }, new AbortController().signal);
      expect(doc).toEqual(RESEARCH_DOC);
      expect(contexts[0].tools?.map((tool) => tool.name)).toEqual(["submit_candidate", "query_company"]);
      const run = await db.query("SELECT kind, model_slot, status, candidate_output, input_snapshot FROM agent_runs");
      expect(run.rows).toHaveLength(1);
      expect(run.rows[0]).toMatchObject({ kind: "issue-research", model_slot: "heavy", status: "succeeded" });
      expect(run.rows[0].candidate_output).toEqual(RESEARCH_DOC);
      // No authorized World configuration in this fixture: no legacy Markdown fallback.
      expect(run.rows[0].input_snapshot).toMatchObject({ company: { status: "coverage_unavailable", entries: [] } });
      expect(JSON.stringify(run.rows[0].input_snapshot)).not.toContain("companyMemoryPassages");
    });
  });

  it("fails when the model never submits a valid ResearchDoc", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      let calls = 0;
      const { runner } = researchAgentRunner(db, () => {
        calls += 1;
        if (calls === 1) {
          // 第一提交缺 options：严格 schema 在 Tool 内拒绝
          return stream([{
            type: "toolCall",
            id: "submit-2",
            name: "submit_candidate",
            arguments: { summary: "只有摘要，不是完整 ResearchDoc" },
          }], "toolUse");
        }
        return stream([{ type: "text", text: "放弃" }], "stop");
      });
      await expect(runner(
        { issue: { id: "fixture-08", title: "t", origin: "dri", originRef: {}, location: {}, urgency: {} } },
        new AbortController().signal,
      )).rejects.toThrow("did not call submit_candidate");
      expect(calls).toBe(2);
      const run = await db.query("SELECT status, error, candidate_output FROM agent_runs");
      expect(run.rows[0]).toMatchObject({ status: "failed", candidate_output: null });
    });
  });
});

describe("startup recovery of an interrupted research run", () => {
  it("marks a stale running research as failed and the explicit retry then succeeds", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      // 直接造一条 running 且 startedAt 超阈值的行：等价于进程在 run 中途崩溃
      const issueId = randomUUID();
      await db.query(
        `INSERT INTO issues (id, version, origin, origin_ref, title, location, urgency, status, research)
         VALUES ($1, 1, 'dri', '{}'::jsonb, '重启中断的议题',
                 '{"level":"battlefield","battlefieldId":"growth"}'::jsonb,
                 '{"level":"gray"}'::jsonb, 'pending', $2::jsonb)`,
        [issueId, JSON.stringify({
          status: "running", runId: "stale-run", startedAt: "2026-05-02T01:00:00.000Z",
          previousRunIds: [], error: null,
        })],
      );

      const recovered = await recoverInterruptedResearch(db.query.bind(db), { now: () => new Date("2026-05-02T03:00:00.000Z") });
      expect(recovered).toBe(1);

      const queue = queueRunner([structuredClone(RESEARCH_DOC)]);
      const { app, research } = await setupWithResearch(pool, queue.runner);
      try {
        const cookie = await login(app, db);
        const card = await issueCard(app, cookie, issueId);
        expect(card.payload.research).toMatchObject({ status: "failed", error: { code: "research_interrupted" } });

        // 补偿不会自动重试；显式重跑后不再被补偿打回
        await expect(recoverInterruptedResearch(db.query.bind(db), { now: () => new Date("2026-05-02T03:00:00.000Z") })).resolves.toBe(0);
        const retried = await execute(app, cookie, action(card, "issue.retry_research").actionId, {});
        expect(retried.statusCode).toBe(200);
        await research.idle();
        const ready = await issueCard(app, cookie, issueId);
        expect(ready.payload.research.status).toBe("ready");
        expect(ready.payload.research.doc).toEqual(RESEARCH_DOC);
        expect(ready.payload.research.previousRunIds).toContain("stale-run");
      } finally {
        await app.close();
      }
    });
  });
});
