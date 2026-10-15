import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { Card, RadarCandidateSubmission, type TRadarCandidateSubmission, type TRadarSourceItem } from "@warmap/contracts";
import { buildApp } from "../src/app.js";
import { recoverInterruptedResearch } from "../src/issues.js";
import { createRadarService, type RadarAssessor } from "../src/radar.js";
import { migrate } from "../src/migrate.js";
import { createTestDb, seedTestAccess, testEnv, TEST_LOGIN } from "./helpers.js";

const NOW = new Date("2026-05-02T03:00:00.000Z");
const ANCHORS = [{
  id: "anchor-market",
  title: "市场定价",
  query: "竞争对手 最新定价",
  location: { type: "battlefield", id: "growth" },
}];
const SOURCES = {
  sites: [{ id: "site-web", name: "公开 Web", enabled: true, domains: ["example.com"] }],
  wechatAccounts: [],
};

const EXCERPT = "公告确认渠道政策将在六月一日调整，并给出申报截止时间。";

function webItem(query: string, url: string): TRadarSourceItem {
  return {
    sourceType: "web",
    title: "渠道政策公告",
    url,
    publishedAt: "2026-05-01T08:00:00.000Z",
    excerpt: EXCERPT,
    sourceRef: { type: "web-search", provider: "recorded-web", query },
  };
}

/** 合法升级候选：5 类 CEO decision kind、两个不同选择、连续引文、合法归属、red 有可解析窗口。 */
function promotionCandidate(sources: { sourceFingerprint: string }[]): TRadarCandidateSubmission {
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
}

function assessor(submission: (sources: { sourceFingerprint: string }[]) => TRadarCandidateSubmission): RadarAssessor {
  return { async assess({ sources }) { return submission(sources); } };
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

async function setup(
  submission: (sources: { sourceFingerprint: string }[]) => TRadarCandidateSubmission,
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  pool: Parameters<typeof createRadarService>[0]["pool"],
  items: TRadarSourceItem[] = [webItem("竞争对手 最新定价", "https://example.com/channel")],
) {
  await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
    JSON.stringify(ANCHORS), JSON.stringify(SOURCES),
  ]);
  const radar = createRadarService({
    pool,
    web: { configured: true, async search(input) { return items.map((item) => ({ ...item, sourceRef: { ...item.sourceRef, query: input.query } })); } },
    assessor: assessor(submission),
    now: () => NOW,
  });
  const app = await buildApp({
    pool,
    env: testEnv,
    radarService: radar,
    conversationRuntime: { async run(input) { return { assistantMessage: "test", runtimeEntries: input.runtimeEntries }; } },
  });
  return { radar, app };
}

describe("Signal promotion creates one pending Issue", () => {
  it("Radar 升级候选的 decisionQuestion 上限为 25 字，超限被契约拒绝", () => {
    const sources = [{ sourceFingerprint: "a".repeat(64) }];
    expect(Value.Check(RadarCandidateSubmission, promotionCandidate(sources))).toBe(true);
    const tooLong = promotionCandidate(sources);
    tooLong.candidates[0].promotion!.decisionQuestion = "是否将身份授权、Skill 准入与运行期控制纳入首期产品核？";
    expect(Array.from(tooLong.candidates[0].promotion!.decisionQuestion).length).toBeGreaterThan(25);
    expect(Value.Check(RadarCandidateSubmission, tooLong)).toBe(false);
  });
  it("atomically links the Signal and exposes an immediately queryable pending Issue Card", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const { radar, app } = await setup(promotionCandidate, db, pool);
      try {
        expect(await radar.runManual()).toMatchObject({ status: "completed", createdSignals: 1 });

        const signals = await db.query(
          "SELECT id, promoted_issue_id, promotion_fingerprint FROM signals",
        );
        expect(signals.rows).toHaveLength(1);
        const promotedIssueId = signals.rows[0].promoted_issue_id as string;
        expect(promotedIssueId).toBeTruthy();
        expect(String(signals.rows[0].promotion_fingerprint)).toMatch(/^[a-f0-9]{64}$/);

        const issues = await db.query(
          "SELECT id, version, origin, status, location, urgency, research FROM issues",
        );
        expect(issues.rows).toHaveLength(1);
        expect(issues.rows[0]).toMatchObject({
          id: promotedIssueId,
          version: 1,
          origin: "radar",
          status: "pending",
          location: { level: "battlefield", battlefieldId: "growth" },
          urgency: {
            level: "red",
            reason: "申报窗口在六月一日关闭",
            decisionBy: "2026-06-01T00:00:00.000+08:00",
            decisionByEvidence: { quote: "六月一日调整", window: "2026-06-01" },
          },
        });
        expect(issues.rows[0].research).toMatchObject({ status: "pending" });
        expect((issues.rows[0].research as { pendingSince: string }).pendingSince).toBeTruthy();
        expect(await db.query("SELECT id FROM agent_runs")).toMatchObject({ rows: [] });

        const cookie = await login(app, db);
        const card = await app.inject({ method: "GET", url: `/api/cards/issues/${promotedIssueId}`, headers: { cookie } });
        expect(card.statusCode).toBe(200);
        expect(Value.Check(Card, card.json().cards[0])).toBe(true);
        expect(card.json().cards[0]).toMatchObject({
          kind: "issue",
          id: `issue:${promotedIssueId}`,
          title: "是否在六月一日前调整渠道投入？",
          objectRef: { type: "issue", id: promotedIssueId, version: 1 },
          urgency: "red",
          conversation: { scope: `issue:${promotedIssueId}` },
          payload: {
            origin: "radar",
            status: "pending",
            location: { level: "battlefield", battlefieldId: "growth" },
            research: { status: "pending" },
          },
        });
        // GET 不触发模型或写入
        expect(await db.query("SELECT id FROM agent_runs")).toMatchObject({ rows: [] });
      } finally {
        await app.close();
      }
    });
  });
});

const DRI_IMPORT = {
  externalId: "dri-growth-001",
  submitterPersonId: "person-fixture-002",
  title: "是否在六月前调整渠道投入",
  whyNow: "渠道窗口在六月关闭",
  sourceRef: "dri://planning/growth-001",
  location: { level: "battlefield", battlefieldId: "growth" },
  urgency: { level: "red", decisionBy: "2026-06-01T00:00:00.000+08:00", reason: "申报窗口在六月一日关闭" },
};

function postDri(app: Awaited<ReturnType<typeof buildApp>>, payload: unknown, token = testEnv.driServiceToken) {
  return app.inject({
    method: "POST",
    url: "/api/dri/issues",
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>,
  });
}

describe("DRI service Issue import", () => {
  it("rejects anonymous, wrong-token and CEO-session callers", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const app = await buildApp({ pool, env: testEnv, conversationRuntime: { async run(i) { return { assistantMessage: "x", runtimeEntries: i.runtimeEntries }; } } });
      try {
        expect((await app.inject({ method: "POST", url: "/api/dri/issues", payload: DRI_IMPORT })).statusCode).toBe(401);
        expect((await postDri(app, DRI_IMPORT, "wrong-token")).statusCode).toBe(401);
        expect((await postDri(app, DRI_IMPORT, "retired-company-token")).statusCode).toBe(401);
        const cookie = await login(app, db);
        const ceoSession = await app.inject({ method: "POST", url: "/api/dri/issues", headers: { cookie }, payload: DRI_IMPORT });
        expect(ceoSession.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  });

  it("creates an immediately queryable pending Issue for a stable Person and returns the same object on replay", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const app = await buildApp({ pool, env: testEnv, conversationRuntime: { async run(i) { return { assistantMessage: "x", runtimeEntries: i.runtimeEntries }; } } });
      try {
        const first = await postDri(app, DRI_IMPORT);
        expect(first.statusCode).toBe(201);
        const card = first.json().cards[0];
        expect(Value.Check(Card, card)).toBe(true);
        expect(card).toMatchObject({
          kind: "issue",
          urgency: "red",
          payload: {
            origin: "dri",
            status: "pending",
            location: { level: "battlefield", battlefieldId: "growth" },
            urgency: { level: "red", decisionBy: DRI_IMPORT.urgency.decisionBy, reason: DRI_IMPORT.urgency.reason },
            research: { status: "pending" },
          },
        });
        expect(await db.query("SELECT status FROM issues")).toMatchObject({ rows: [{ status: "pending" }] });
        expect(await db.query("SELECT id FROM agent_runs")).toMatchObject({ rows: [] });

        const cookie = await login(app, db);
        const queried = await app.inject({ method: "GET", url: `/api/cards/issues/${card.objectRef.id}`, headers: { cookie } });
        expect(queried.statusCode).toBe(200);
        expect(queried.json().cards[0].id).toBe(card.id);

        const replay = await postDri(app, DRI_IMPORT);
        expect(replay.statusCode).toBe(200);
        expect(replay.json().cards[0].id).toBe(card.id);
        expect((await db.query("SELECT id FROM issues")).rows).toHaveLength(1);

        const conflict = await postDri(app, { ...DRI_IMPORT, title: "改了标题" });
        expect(conflict.statusCode).toBe(409);
        expect(conflict.json().code).toBe("DRI_EXTERNAL_ID_CONFLICT");
        expect((await db.query("SELECT id FROM issues")).rows).toHaveLength(1);
      } finally {
        await app.close();
      }
    });
  });

  it.each([
    ["不完整的必填字段", { externalId: "dri-1", title: "x" }],
    ["未知 submitterPersonId", { ...DRI_IMPORT, externalId: "dri-2", submitterPersonId: "person-lookup-from-name" }],
    ["不合法归属", { ...DRI_IMPORT, externalId: "dri-3", location: { level: "battlefield" } }],
    ["company 归属只命名一个战场", { ...DRI_IMPORT, externalId: "dri-7", location: { level: "company", relatedBattlefieldIds: ["growth"] } }],
    ["red 缺少 reason", { ...DRI_IMPORT, externalId: "dri-4", urgency: { level: "red", decisionBy: "2026-06-01T00:00:00.000+08:00" } }],
    ["red 缺少 decisionBy", { ...DRI_IMPORT, externalId: "dri-5", urgency: { level: "red", reason: "窗口关闭" } }],
    ["red 的 decisionBy 不可解析", { ...DRI_IMPORT, externalId: "dri-6", urgency: { level: "red", reason: "窗口关闭", decisionBy: "六月一日" } }],
  ])("rejects %s before creating an Issue", async (_label, payload) => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const app = await buildApp({ pool, env: testEnv, conversationRuntime: { async run(i) { return { assistantMessage: "x", runtimeEntries: i.runtimeEntries }; } } });
      try {
        const response = await postDri(app, payload);
        expect(response.statusCode).toBe(400);
        expect((await db.query("SELECT id FROM issues")).rows).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  });
});

describe("startup recovery of a never-started pre-research", () => {
  it("marks a stale pending research as failed:trigger_not_started and waits for an explicit retry", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const app = await buildApp({ pool, env: testEnv, conversationRuntime: { async run(i) { return { assistantMessage: "x", runtimeEntries: i.runtimeEntries }; } } });
      try {
        const created = await postDri(app, DRI_IMPORT);
        const issueId = created.json().cards[0].objectRef.id as string;
        // 预研从未启动，pendingSince 已超过启动恢复阈值
        await db.query("UPDATE issues SET research = $2::jsonb WHERE id = $1", [
          issueId,
          JSON.stringify({ status: "pending", pendingSince: "2026-05-02T01:00:00.000Z", runId: null, previousRunIds: [], error: null }),
        ]);
        const recovered = await recoverInterruptedResearch(db.query.bind(db), { now: () => new Date("2026-05-02T03:00:00.000Z"), staleAfterMs: 15 * 60 * 1000 });
        expect(recovered).toBe(1);

        const cookie = await login(app, db);
        const card = await app.inject({ method: "GET", url: `/api/cards/issues/${issueId}`, headers: { cookie } });
        expect(card.json().cards[0].payload).toMatchObject({
          status: "pending",
          research: { status: "failed", error: { code: "trigger_not_started" } },
        });
        // 不自动重试：没有 Research 运行记录，且再次恢复不会重复改动
        expect(await db.query("SELECT id FROM agent_runs")).toMatchObject({ rows: [] });
        await expect(recoverInterruptedResearch(db.query.bind(db), { now: () => new Date("2026-05-02T03:00:00.000Z") })).resolves.toBe(0);
      } finally {
        await app.close();
      }
    });
  });
});

describe("promotion fingerprint dedupe and strategic location", () => {
  it("collapses normalized duplicates into one Issue and keeps blocking after dismissal", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const first = webItem("竞争对手 最新定价", "https://example.com/channel-a");
      const second = webItem("竞争对手 最新定价", "https://example.com/channel-b");
      const { radar, app } = await setup((sources) => ({
        candidates: sources.map((source, index) => ({
          ...promotionCandidate(sources).candidates[0],
          sourceFingerprint: source.sourceFingerprint,
          promotion: {
            ...promotionCandidate(sources).candidates[0].promotion!,
            // 仅空白与句末标点不同：规范化后是同一个问题
            decisionQuestion: index === 0 ? "是否在六月一日前调整渠道投入？" : " 是否在六月一日前调整渠道投入。 ",
          },
        })),
      }), db, pool, [first, second]);
      try {
        expect(await radar.runManual()).toMatchObject({ status: "completed", createdSignals: 2 });
        const issues = await db.query("SELECT id, promotion_fingerprint FROM issues");
        expect(issues.rows).toHaveLength(1);
        const signals = await db.query("SELECT promoted_issue_id FROM signals ORDER BY source_url");
        expect(signals.rows.map((row) => row.promoted_issue_id)).toEqual([issues.rows[0].id, issues.rows[0].id]);

        // dismissed 保留去重指纹：新的来源、等价问题仍然不得再次升级
        await db.query("UPDATE issues SET status = 'dismissed' WHERE id = $1", [issues.rows[0].id]);
        const third = webItem("竞争对手 最新定价", "https://example.com/channel-c");
        third.excerpt = EXCERPT;
        const resent = await setup((sources) => promotionCandidate(sources), db, pool, [third]);
        try {
          expect(await resent.radar.runManual()).toMatchObject({ status: "completed", createdSignals: 1 });
        } finally {
          await resent.app.close();
        }
        const after = await db.query("SELECT id, status FROM issues");
        expect(after.rows).toHaveLength(1);
        expect(after.rows[0].status).toBe("dismissed");
        expect((await db.query("SELECT count(*) AS count FROM signals")).rows[0].count).toBe("3");
      } finally {
        await app.close();
      }
    });
  });

  it("turns a multi-battlefield issue into one Strategic company Issue without copying it to each battlefield", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const { radar, app } = await setup((sources) => {
        const submission = promotionCandidate(sources);
        submission.candidates[0].promotion!.location = {
          level: "company",
          relatedBattlefieldIds: ["product", "growth"],
        };
        return submission;
      }, db, pool);
      try {
        expect(await radar.runManual()).toMatchObject({ status: "completed", createdSignals: 1 });
        const issues = await db.query("SELECT location FROM issues");
        expect(issues.rows).toHaveLength(1);
        expect(issues.rows[0].location).toEqual({ level: "company", relatedBattlefieldIds: ["growth", "product"] });

        const cookie = await login(app, db);
        const card = await app.inject({ method: "GET", url: `/api/cards/issues/${(await db.query("SELECT id FROM issues")).rows[0].id}`, headers: { cookie } });
        expect(card.json().cards[0].payload.location).toEqual({ level: "company", relatedBattlefieldIds: ["growth", "product"] });
      } finally {
        await app.close();
      }
    });
  });

  it("rejects a company location that names fewer than two battlefields", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const { radar, app } = await setup((sources) => {
        const submission = promotionCandidate(sources);
        submission.candidates[0].promotion!.location = { level: "company", relatedBattlefieldIds: ["growth"] };
        return submission;
      }, db, pool);
      try {
        expect(await radar.runManual()).toMatchObject({ status: "completed", createdSignals: 1 });
        expect((await db.query("SELECT id FROM issues")).rows).toHaveLength(0);
        expect((await db.query("SELECT promoted_issue_id FROM signals")).rows[0].promoted_issue_id).toBeNull();
      } finally {
        await app.close();
      }
    });
  });
});

describe("promotion gates reject unqualified candidates in code", () => {
  it("keeps the Signal but does not promote when options are duplicated", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const { radar, app } = await setup((sources) => {
        const submission = promotionCandidate(sources);
        submission.candidates[0].promotion!.options = ["调整渠道投入", "调整渠道投入"];
        return submission;
      }, db, pool);
      try {
        expect(await radar.runManual()).toMatchObject({ status: "completed", createdSignals: 1 });
        expect(await db.query("SELECT count(*) AS count FROM issues")).toMatchObject({ rows: [{ count: "0" }] });
        expect(await db.query("SELECT promoted_issue_id FROM signals")).toMatchObject({ rows: [{ promoted_issue_id: null }] });
      } finally {
        await app.close();
      }
    });
  });

  it("does not promote a red candidate whose decisionByEvidence is not contiguous in the source excerpt", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const { radar, app } = await setup((sources) => {
        const submission = promotionCandidate(sources);
        submission.candidates[0].promotion!.urgency.decisionByEvidence = { quote: "九月一日截止申报" };
        return submission;
      }, db, pool);
      try {
        expect(await radar.runManual()).toMatchObject({ status: "completed", createdSignals: 1 });
        expect(await db.query("SELECT count(*) AS count FROM issues")).toMatchObject({ rows: [{ count: "0" }] });
      } finally {
        await app.close();
      }
    });
  });

  it("does not promote a red candidate whose evidence quote carries no parseable time window", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const { radar, app } = await setup((sources) => {
        const submission = promotionCandidate(sources);
        submission.candidates[0].promotion!.urgency.decisionByEvidence = { quote: "并给出申报截止时间" };
        return submission;
      }, db, pool);
      try {
        expect(await radar.runManual()).toMatchObject({ status: "completed", createdSignals: 1 });
        expect((await db.query("SELECT id FROM issues")).rows).toHaveLength(0);
      } finally {
        await app.close();
      }
    });
  });

  it("uses the year written in the evidence quote instead of the decisionBy year", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const item = webItem("竞争对手 最新定价", "https://example.com/dated");
      item.excerpt = "公告确认渠道政策将在2027年6月1日调整。";
      const { radar, app } = await setup((sources) => {
        const submission = promotionCandidate(sources);
        submission.candidates[0].evidenceQuote = "渠道政策将在2027年6月1日调整";
        submission.candidates[0].promotion!.urgency.decisionByEvidence = { quote: "2027年6月1日调整" };
        return submission;
      }, db, pool, [item]);
      try {
        expect(await radar.runManual()).toMatchObject({ status: "completed", createdSignals: 1 });
        expect((await db.query("SELECT urgency FROM issues")).rows[0].urgency).toMatchObject({
          decisionByEvidence: { quote: "2027年6月1日调整", window: "2027-06-01" },
        });
      } finally {
        await app.close();
      }
    });
  });

  it("resolves a year-less window in the Company Day timezone across the new year boundary", async () => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const item = webItem("竞争对手 最新定价", "https://example.com/new-year");
      item.excerpt = "公告确认渠道政策将在一月五日调整。";
      const { radar, app } = await setup((sources) => {
        const submission = promotionCandidate(sources);
        submission.candidates[0].evidenceQuote = "渠道政策将在一月五日调整";
        submission.candidates[0].promotion!.urgency.decisionBy = "2025-12-31T16:00:00.000Z"; // Asia/Shanghai 已是 2026-01-01
        submission.candidates[0].promotion!.urgency.decisionByEvidence = { quote: "一月五日调整" };
        return submission;
      }, db, pool, [item]);
      try {
        expect(await radar.runManual()).toMatchObject({ status: "completed", createdSignals: 1 });
        expect((await db.query("SELECT urgency FROM issues")).rows[0].urgency).toMatchObject({
          decisionByEvidence: { quote: "一月五日调整", window: "2026-01-05" },
        });
      } finally {
        await app.close();
      }
    });
  });

  it.each([
    ["an unparsable decision window", (candidate: TRadarCandidateSubmission) => { candidate.candidates[0].promotion!.urgency.decisionBy = "六月一日"; }],
    ["a red level without a reason", (candidate: TRadarCandidateSubmission) => { delete candidate.candidates[0].promotion!.urgency.reason; }],
    ["an unsupported CEO decision kind", (candidate: TRadarCandidateSubmission) => { (candidate.candidates[0].promotion as { decisionKind: string }).decisionKind = "ceo_mood"; }],
    ["an invalid location", (candidate: TRadarCandidateSubmission) => { (candidate.candidates[0].promotion as { location: unknown }).location = { level: "battlefield" }; }],
    ["a calendar date that does not exist", (candidate: TRadarCandidateSubmission) => { candidate.candidates[0].promotion!.urgency.decisionByEvidence = { quote: "政策在二月三十日调整" }; }],
  ])("rejects %s", async (_label, mutate) => {
    await createTestDb(async ({ db, pool }) => {
      await migrate(db);
      const { radar, app } = await setup((sources) => {
        const submission = promotionCandidate(sources);
        mutate(submission);
        return submission;
      }, db, pool);
      try {
        const result = await radar.runManual();
        expect(result.status).toBe("completed");
        expect(Number((await db.query("SELECT count(*) AS count FROM issues")).rows[0].count)).toBe(0);
      } finally {
        await app.close();
      }
    });
  });
});
