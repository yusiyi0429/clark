import { describe, expect, it } from "vitest";
import type { TRadarCandidateSubmission, TRadarSourceItem } from "@warmap/contracts";
import { createRadarService, type RadarAssessor, type RadarExistingIssue } from "../src/radar.js";
import {
  articleTitleCore,
  ISSUE_DUPLICATE_THRESHOLD,
  issueTitleSimilarity,
  sameArticle,
  SUPPLEMENT_TITLE_PREFIX,
} from "../src/radarDedupe.js";
import { findDuplicateRadarIssuePairs, mergeDuplicateRadarIssue } from "../src/radarIssueCleanup.js";
import { getIssueRow, projectIssueCard } from "../src/issues.js";
import { migrate } from "../src/migrate.js";
import { createTestDb } from "./helpers.js";

const NOW = new Date("2026-05-02T03:00:00.000Z");
const ANCHORS = [{ id: "anchor-market", title: "市场定价", query: "竞争对手 最新定价", location: { type: "battlefield", id: "growth" } }];
const SOURCES = { sites: [{ id: "site-web", name: "公开 Web", enabled: true, domains: ["example.com"] }], wechatAccounts: [] };
const COMPANY = ["词元云集", "TK", "AIDC", "房懂懂", "FDD"];
const GROWTH = { level: "battlefield" as const, battlefieldId: "growth" };

function webItem(title: string, url: string, excerpt = "原文写道竞争对手下调了套餐价格。"): TRadarSourceItem {
  return {
    sourceType: "web", title, url, publishedAt: "2026-05-01T08:00:00.000Z", excerpt,
    sourceRef: { type: "web-search", provider: "recorded-web", query: "竞争对手 最新定价" },
  };
}

type CandidateSpec = { question: string; attachToIssueId?: string; location?: typeof GROWTH | { level: "company"; relatedBattlefieldIds: string[] } };

function candidateFor(sourceFingerprint: string, spec: CandidateSpec): TRadarCandidateSubmission["candidates"][number] {
  return {
    sourceFingerprint, anchorId: "anchor-market", summary: "竞争对手下调套餐价格", strategicImpact: "需要重新判断定价",
    evidenceQuote: "竞争对手下调了套餐价格", unknowns: [], score: { relevance: 5, impact: 4, urgency: 3 },
    promotion: {
      decisionKind: "company_direction", decisionQuestion: spec.question, options: ["调整", "保持观察"],
      location: spec.location ?? GROWTH, urgency: { level: "gray" },
    },
    ...(spec.attachToIssueId ? { attachToIssueId: spec.attachToIssueId } : {}),
  };
}

/** 一轮扫描：给定来源与每条来源的候选；记录送进研判的 existingIssues。 */
async function scan(pool: import("pg").Pool, items: TRadarSourceItem[], specs: CandidateSpec[], seen?: RadarExistingIssue[][]) {
  const assessor: RadarAssessor = {
    async assess({ sources, existingIssues }) {
      seen?.push(existingIssues ?? []);
      return { candidates: sources.map((source) => candidateFor(source.sourceFingerprint, specs[items.findIndex((item) => item.title === source.title)])) };
    },
  };
  const radar = createRadarService({ pool, web: { configured: true, async search() { return items; } }, assessor, now: () => NOW });
  return radar.runManual();
}

async function setup(db: import("pg").PoolClient) {
  await migrate(db);
  await db.query("UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb WHERE id = 'default'", [
    JSON.stringify(ANCHORS), JSON.stringify(SOURCES),
  ]);
}

describe("议题标题相似度（确定性兜底）", () => {
  it("同一决策问题换个说法达到阈值，不同决策问题达不到", () => {
    expect(ISSUE_DUPLICATE_THRESHOLD).toBe(0.6);
    const same = issueTitleSimilarity("词元云集是否调整 TokenOps 定价重点？", "词元云集是否调整 TokenOps 定价策略？", COMPANY);
    expect(same).toBeGreaterThanOrEqual(ISSUE_DUPLICATE_THRESHOLD);
    // 公司名和英文产品名不应把不同问题拉成相似
    expect(issueTitleSimilarity("词元云集是否调整 TokenOps 差异化方向？", "词元云集是否调整 TokenOps 定价重点？", COMPANY)).toBeLessThan(ISSUE_DUPLICATE_THRESHOLD);
    expect(issueTitleSimilarity("AIDC 首项目是否按液冷预留设计？", "AIDC 是否把供电确定性设为项目准入条件？", COMPANY)).toBeLessThan(ISSUE_DUPLICATE_THRESHOLD);
    expect(issueTitleSimilarity("词元云集是否优先建设任务级计量？", "词元云集是否优先建设任务级计量", COMPANY)).toBe(1);
  });
});

describe("同一篇文章判定", () => {
  it("去掉站点名与标签后比较；短标题不做标题去重", () => {
    expect(articleTitleCore("算力基建的战争,才刚刚在液冷赛道上演|服务器|机房|机柜|液冷|算力_手机网易网")).toBe("算力基建的战争,才刚刚在液冷赛道上演");
    expect(articleTitleCore("大厂混战持续:模型能力快速普及后,AI办公靠什么拉开差距?-虎嗅网")).toBe("大厂混战持续:模型能力快速普及后,ai办公靠什么拉开差距?");
    expect(sameArticle("算力基建的战争,才刚刚在液冷赛道上演|服务器|机房_手机网易网", "算力基建的战争，才刚刚在液冷赛道上演_网易订阅")).toBe(true);
    expect(sameArticle("液冷赛道迎来爆发期_新浪财经", "算力基建的战争,才刚刚在液冷赛道上演")).toBe(false);
    expect(sameArticle("快讯_新浪", "快讯_网易")).toBe(false);
  });
});

describe("雷达升级前查重", () => {
  it("模型判定同一决策问题（attachToIssueId）：不新建议题，信号作为补充依据挂上，议题页依据显示「雷达补充：<信号标题>」", async () => {
    await createTestDb(async ({ db, pool }) => {
      await setup(db);
      expect(await scan(pool, [webItem("竞品下调企业套餐价格引发行业关注", "https://example.com/a")], [{ question: "是否调整渠道策略？" }]))
        .toMatchObject({ status: "completed", createdSignals: 1 });
      const [issue] = (await db.query("SELECT id, version FROM issues")).rows;
      // 预研已产出文档：补充依据要并进「判断的依据」
      await db.query(`UPDATE issues SET research = $2::jsonb WHERE id = $1`, [issue.id, JSON.stringify({
        status: "ready", runId: null, previousRunIds: [], error: null,
        doc: { summary: "s", options: [{ id: "A", label: "调整", consequences: ["c"] }, { id: "B", label: "观察", consequences: ["c"] }],
          evidence: [{ quote: "原始引文", sourceTitle: "原始来源" }], unknowns: [], sources: [] },
      })]);

      const seen: RadarExistingIssue[][] = [];
      // 措辞明显不同（相似度兜底不会命中），只靠模型判重
      expect(await scan(pool, [webItem("另一家厂商跟进降价 渠道返点同步收紧", "https://example.com/b")],
        [{ question: "是否收紧代理商返点比例？", attachToIssueId: issue.id }], seen)).toMatchObject({ createdSignals: 1 });
      expect(seen[0]).toEqual([expect.objectContaining({ id: issue.id, title: "是否调整渠道策略？", location: GROWTH })]);
      expect(Number((await db.query("SELECT count(*) FROM issues")).rows[0].count)).toBe(1);
      const signal = (await db.query("SELECT id, promoted_issue_id FROM signals WHERE source_url = 'https://example.com/b'")).rows[0];
      expect(signal.promoted_issue_id).toBe(issue.id);
      const row = (await getIssueRow((sql, params) => db.query(sql, params), issue.id))!;
      expect(row.version).toBe(issue.version + 1);
      expect((row.origin_ref as { supplementarySignals: unknown[] }).supplementarySignals).toEqual([expect.objectContaining({
        signalId: signal.id, sourceTitle: "另一家厂商跟进降价 渠道返点同步收紧", via: "model",
      })]);
      const card = projectIssueCard(row, "test-secret");
      const evidence = (card.payload as { research: { doc: { evidence: { quote: string; sourceTitle: string; sourceUrl?: string }[] } } }).research.doc.evidence;
      expect(evidence).toEqual([
        { quote: "原始引文", sourceTitle: "原始来源" },
        { quote: "竞争对手下调了套餐价格", sourceTitle: `${SUPPLEMENT_TITLE_PREFIX}另一家厂商跟进降价 渠道返点同步收紧`, sourceUrl: "https://example.com/b" },
      ]);
    });
  });

  it("模型漏判时按同战场标题相似度兜底挂靠；不同决策问题、不同战场照常新建", async () => {
    await createTestDb(async ({ db, pool }) => {
      await setup(db);
      await db.query("INSERT INTO battlefield_config (id, version, name, six_month_outcome, code) VALUES ('tk', 1, '词元云集', '算力运营', 'TK')");
      await scan(pool, [webItem("竞品下调企业套餐价格引发行业关注", "https://example.com/a")], [{ question: "是否调整 TokenOps 定价重点？" }]);
      const result = await scan(pool, [
        webItem("另一家厂商跟进降价 渠道返点同步收紧", "https://example.com/b"),
        webItem("海外市场团队扩编计划曝光细节", "https://example.com/c"),
        webItem("定价策略专题研讨会纪要全文发布", "https://example.com/d"),
      ], [
        { question: "是否调整 TokenOps 定价策略？" },
        { question: "是否扩建海外销售团队？" },
        { question: "是否调整 TokenOps 定价策略？", location: { level: "battlefield", battlefieldId: "tk" } as never },
      ]);
      expect(result).toMatchObject({ createdSignals: 3 });
      const issues = (await db.query("SELECT title, location FROM issues ORDER BY created_at, title")).rows;
      expect(issues.map((issue) => issue.title).sort()).toEqual(["是否扩建海外销售团队？", "是否调整 TokenOps 定价策略？", "是否调整 TokenOps 定价重点？"].sort());
      const original = (await db.query("SELECT id, origin_ref FROM issues WHERE title = '是否调整 TokenOps 定价重点？'")).rows[0];
      expect(original.origin_ref.supplementarySignals).toEqual([expect.objectContaining({ via: "similarity", sourceUrl: "https://example.com/b" })]);
      expect((await db.query("SELECT promoted_issue_id FROM signals WHERE source_url = 'https://example.com/b'")).rows[0].promoted_issue_id).toBe(original.id);
    });
  });
});

describe("信号层同文去重", () => {
  it("同一篇文章不同 URL（转载 / 移动版）本轮只留一条，下一轮再出现也不再入库", async () => {
    await createTestDb(async ({ db, pool }) => {
      await setup(db);
      const first = await scan(pool, [
        webItem("算力基建的战争,才刚刚在液冷赛道上演|服务器|机房|机柜_手机网易网", "https://m.example.com/liquid"),
        webItem("算力基建的战争，才刚刚在液冷赛道上演_网易订阅", "https://www.example.com/liquid"),
      ], [{ question: "是否按液冷预留首项目设计？" }, { question: "是否按液冷预留首项目设计？" }]);
      expect(first).toMatchObject({ createdSignals: 1 });
      const second = await scan(pool, [webItem("算力基建的战争,才刚刚在液冷赛道上演-新浪科技", "https://tech.example.com/liquid")],
        [{ question: "是否按液冷预留首项目设计？" }]);
      expect(second).toMatchObject({ createdSignals: 0 });
      expect(Number((await db.query("SELECT count(*) FROM signals")).rows[0].count)).toBe(1);
      expect(Number((await db.query("SELECT count(*) FROM issues")).rows[0].count)).toBe(1);
    });
  });
});

describe("近重复雷达议题清理", () => {
  it("dry-run 只列出同战场近重复对，不写库；merge 保留较早一条，合并信号，较晚一条移出并记录原因", async () => {
    await createTestDb(async ({ db, pool }) => {
      await setup(db);
      // 模拟修复前已经产生的重复：直接插入两条近重复议题与各自信号
      await scan(pool, [webItem("竞品下调企业套餐价格引发行业关注", "https://example.com/a")], [{ question: "是否调整 TokenOps 定价重点？" }]);
      await scan(pool, [webItem("海外市场团队扩编计划曝光细节", "https://example.com/c")], [{ question: "是否扩建海外销售团队？" }]);
      const keep = (await db.query("SELECT id, version FROM issues WHERE title = '是否调整 TokenOps 定价重点？'")).rows[0];
      const dropId = "00000000-0000-4000-8000-0000000000d1";
      const dropSignal = "00000000-0000-4000-8000-0000000000e1";
      await db.query(
        `INSERT INTO signals (id, version, source_type, source_fingerprint, source_title, source_url, published_at, excerpt,
           source_ref, anchor_id, location, summary, strategic_impact, evidence_quote, unknowns, score)
         VALUES ($1, 1, 'web', $2, '另一家厂商跟进降价', 'https://example.com/b', now(), '原文', '{"type":"web-search","provider":"x","query":"q"}',
           'anchor-market', '{"type":"battlefield","id":"growth"}', '跟进降价', '影响', '原文', '[]', '{"relevance":4,"impact":3,"urgency":2}')`,
        [dropSignal, "f".repeat(64)],
      );
      await db.query(
        `INSERT INTO issues (id, version, origin, origin_ref, title, location, urgency, status, research, created_at)
         VALUES ($1, 1, 'radar', $2::jsonb, '是否调整 TokenOps 定价策略？', $3::jsonb, '{"level":"gray"}', 'pending',
           '{"status":"pending","previousRunIds":[]}', now() + interval '1 minute')`,
        [dropId, JSON.stringify({ signalId: dropSignal }), JSON.stringify(GROWTH)],
      );
      await db.query("UPDATE signals SET promoted_issue_id = $2 WHERE id = $1", [dropSignal, dropId]);

      const query = (sql: string, params?: unknown[]) => db.query(sql, params);
      const pairs = await findDuplicateRadarIssuePairs(query);
      expect(pairs).toEqual([expect.objectContaining({
        keep: expect.objectContaining({ id: keep.id, title: "是否调整 TokenOps 定价重点？" }),
        drop: expect.objectContaining({ id: dropId, title: "是否调整 TokenOps 定价策略？" }),
      })]);
      // dry-run 只读：再查一次结果不变，没有任何议题被移出
      expect(await findDuplicateRadarIssuePairs(query)).toEqual(pairs);
      expect(Number((await db.query("SELECT count(*) FROM issues WHERE status = 'dismissed'")).rows[0].count)).toBe(0);

      const client = await pool.connect();
      try {
        expect(await mergeDuplicateRadarIssue(client, pairs[0])).toEqual({ merged: true, movedSignals: 1 });
        // 已合并的一对再执行一次直接跳过
        expect(await mergeDuplicateRadarIssue(client, pairs[0])).toEqual({ merged: false, movedSignals: 0 });
      } finally {
        client.release();
      }
      const dropped = (await db.query("SELECT status, dismiss_reason FROM issues WHERE id = $1", [dropId])).rows[0];
      expect(dropped).toEqual({ status: "dismissed", dismiss_reason: "与「是否调整 TokenOps 定价重点？」重复，已合并" });
      const kept = (await db.query("SELECT status, version, origin_ref FROM issues WHERE id = $1", [keep.id])).rows[0];
      expect(kept.status).toBe("pending");
      expect(kept.version).toBe(keep.version + 1);
      expect(kept.origin_ref.supplementarySignals).toEqual([expect.objectContaining({ signalId: dropSignal, via: "merge", sourceTitle: "另一家厂商跟进降价" })]);
      expect((await db.query("SELECT promoted_issue_id FROM signals WHERE id = $1", [dropSignal])).rows[0].promoted_issue_id).toBe(keep.id);
      expect(await findDuplicateRadarIssuePairs(query)).toEqual([]);
    });
  });
});
