import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { projectRadarCard, signalImportance } from "../src/signals.js";
import { createTestDb } from "./helpers.js";

/* 首页雷达卡的「信号流」：雷达卡 payload 带最新信号（最多 6 条，未忽略，按重要度再按发布时间倒序，与雷达页「按重要程度」同一口径）。 */

type Seed = {
  id: string;
  title: string;
  publishedAt: string;
  score: unknown;
  sourceType?: "web" | "wechat-account" | "outlet";
  sourceRef?: unknown;
  url?: string;
  read?: boolean;
  dismissed?: boolean;
};

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const score = (impact: number, urgency: number) => ({ relevance: 3, impact, urgency });
const providers = { web: true, wechat: true, outlets: true };

async function insert(db: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, seed: Seed) {
  await db.query(
    `INSERT INTO signals
       (id, version, source_type, source_fingerprint, source_title, source_url, published_at, excerpt,
        source_ref, anchor_id, location, summary, strategic_impact, evidence_quote, unknowns, score, read_at, dismissed_at)
     VALUES ($1, 1, $2, $3, $4, $5, $6, '原文', $7::jsonb, 'anchor-1', '{"type":"company"}'::jsonb, '摘要', '影响', '原文', '[]'::jsonb, $8::jsonb,
             CASE WHEN $9 THEN now() ELSE NULL END, CASE WHEN $10 THEN now() ELSE NULL END)`,
    [
      seed.id, seed.sourceType ?? "web", seed.id.replace(/-/g, "").padEnd(64, "0"), seed.title, seed.url ?? "https://www.example.com/a",
      seed.publishedAt, JSON.stringify(seed.sourceRef ?? { type: "web-search", provider: "bocha" }), JSON.stringify(seed.score),
      seed.read ?? false, seed.dismissed ?? false,
    ],
  );
}

describe("雷达卡最新信号", () => {
  it("重要度：impact + urgency ≥7 为高、≥4 为中、其余为低；未评估为 null", () => {
    expect(signalImportance(score(4, 3), null)).toBe("high");
    expect(signalImportance(score(2, 2), null)).toBe("medium");
    expect(signalImportance(score(1, 2), null)).toBe("low");
    expect(signalImportance(null, null)).toBeNull();
    // 旧版导入写入的 0/0/0 占位不是评估结果
    expect(signalImportance(score(0, 0), { imported: true })).toBeNull();
  });

  it("最多 6 条、不含已忽略；按重要度（impact + urgency，与雷达页同一口径）高→低（未评估最后），同分按发布时间新→旧；带发布方与已读状态", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const seeds: Seed[] = [
        { id: uuid(1), title: "高分旧", publishedAt: "2026-10-01T02:00:00Z", score: score(5, 4) },
        { id: uuid(2), title: "高分新", publishedAt: "2026-10-08T02:00:00Z", score: score(4, 4), sourceType: "outlet",
          sourceRef: { type: "outlet", outletId: "qbitai", outletName: "量子位" }, read: true },
        { id: uuid(3), title: "中分", publishedAt: "2026-10-09T02:00:00Z", score: score(3, 2), sourceType: "wechat-account",
          sourceRef: { type: "wechat-account", provider: "wechat-mcp", accountId: "a", accountName: "晚点LatePost" } },
        { id: uuid(4), title: "低分最新", publishedAt: "2026-10-10T01:00:00Z", score: score(1, 1) },
        { id: uuid(5), title: "未评估最新", publishedAt: "2026-10-10T02:00:00Z", score: null },
        { id: uuid(6), title: "已忽略的高分", publishedAt: "2026-10-09T05:00:00Z", score: score(5, 5), dismissed: true },
        { id: uuid(7), title: "中分旧", publishedAt: "2026-09-20T02:00:00Z", score: score(2, 3) },
        { id: uuid(8), title: "低分旧", publishedAt: "2026-09-01T02:00:00Z", score: score(0, 1) },
      ];
      for (const seed of seeds) await insert(db, seed);

      const card = await projectRadarCard((sql, params) => db.query(sql, params), providers);
      const latest = (card.payload as { latestSignals: unknown[] }).latestSignals;
      expect(latest).toHaveLength(6);
      expect(latest.map((item) => (item as { title: string }).title)).toEqual(["高分旧", "高分新", "中分", "中分旧", "低分最新", "低分旧"]);
      expect(latest[1]).toEqual({
        id: uuid(2), title: "高分新", source: "量子位", publishedAt: "2026-10-08T02:00:00.000Z", importance: "high", read: true, origin: "scan",
      });
      expect(latest[2]).toMatchObject({ source: "晚点LatePost", importance: "medium", read: false });
      // 检索来源写站点域名（去掉 www.）
      expect(latest[0]).toMatchObject({ source: "example.com", importance: "high" });
      expect(latest[4]).toMatchObject({ importance: "low" });
    });
  });

  it("不足 6 条时未评估的也列上，排在最后；没有信号时是空数组", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const empty = await projectRadarCard((sql, params) => db.query(sql, params), providers);
      expect((empty.payload as { latestSignals: unknown[] }).latestSignals).toEqual([]);

      await insert(db, { id: uuid(11), title: "未评估", publishedAt: "2026-10-10T02:00:00Z", score: null });
      await insert(db, { id: uuid(12), title: "低分", publishedAt: "2026-10-01T02:00:00Z", score: score(0, 0) });
      const card = await projectRadarCard((sql, params) => db.query(sql, params), providers);
      const latest = (card.payload as { latestSignals: { title: string; importance: string | null }[] }).latestSignals;
      expect(latest.map((item) => [item.title, item.importance])).toEqual([["低分", "low"], ["未评估", null]]);
    });
  });

  it("资料包预载的信号（source_ref.imported = true）不进信号流、不计入首页未读数：首页决策面只放实时扫描到的信号；预载信号仍在雷达页", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      await insert(db, { id: uuid(21), title: "预载高分", publishedAt: "2026-10-10T02:00:00Z", score: score(5, 5),
        sourceRef: { type: "web", imported: true, scoreStatus: "assessed" } });
      await insert(db, { id: uuid(22), title: "预载未评估", publishedAt: "2026-10-11T02:00:00Z", score: null,
        sourceRef: { type: "web", imported: true, scoreStatus: "unassessed" } });
      const onlyPreloaded = await projectRadarCard((sql, params) => db.query(sql, params), providers);
      const payload = onlyPreloaded.payload as { latestSignals: unknown[]; latestUnreadCount: number; unreadCount: number };
      expect(payload.latestSignals).toEqual([]);
      expect(payload.latestUnreadCount).toBe(0);
      // 雷达页的未读数照旧算全部信号
      expect(payload.unreadCount).toBe(2);

      await insert(db, { id: uuid(23), title: "扫描到的", publishedAt: "2026-10-09T02:00:00Z", score: score(2, 1) });
      await insert(db, { id: uuid(24), title: "扫描到已读", publishedAt: "2026-10-08T02:00:00Z", score: score(1, 1), read: true });
      const card = await projectRadarCard((sql, params) => db.query(sql, params), providers);
      const mixed = card.payload as { latestSignals: { title: string; origin: string }[]; latestUnreadCount: number };
      expect(mixed.latestSignals.map((item) => item.title)).toEqual(["扫描到的", "扫描到已读"]);
      expect(mixed.latestSignals.every((item) => item.origin === "scan")).toBe(true);
      expect(mixed.latestUnreadCount).toBe(1);
    });
  });
});
