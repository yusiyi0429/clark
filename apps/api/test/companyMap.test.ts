import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TReadScope } from "@warmap/contracts";
import { createCompanyMap, defaultFocus, scopeLabel } from "../src/companyMap.js";
import { migrate } from "../src/migrate.js";
import { canReadProgress } from "../src/progressAccess.js";
import { createTestDb } from "./helpers.js";

/**
 * 三层取用（已定设计 5a）：Mission 卡全员可读；进展与复盘 CEO 能看全部，其他人只看同一战场的，看不到的只记 filtered 条数；
 * 跨对象读取发范围标签，本人改过的范围优先。
 * 人：甲 CEO；乙、丙在增长战场；丁在品牌战场。月份 2026-09、2026-10。
 */
const CEO = "p-ceo", YI = "p-yi", BING = "p-bing", DING = "p-ding";
const PEOPLE = [
  { personId: CEO, displayName: "甲" }, { personId: YI, displayName: "乙" },
  { personId: BING, displayName: "丙" }, { personId: DING, displayName: "丁" },
];
const NOW = new Date("2026-10-18T04:00:00Z");

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;

async function seed(q: Q) {
  await q("UPDATE battlefield_config SET owner_id = $1, code = 'G' WHERE id = 'growth'", [YI]);
  await q("INSERT INTO battlefield_config (id, version, name, six_month_outcome, owner_id, code) VALUES ('brand', 1, '品牌战场', '品牌半年目标', $1, 'B')", [DING]);
  const mission = async (id: string, owner: string, period: string, battlefield: string) => q(`INSERT INTO missions
      (id, version, code, period, title, owner_id, capability_id, battlefield_ids, outcome, source_ref, source_document_id, source_revision, source_title)
    VALUES ($1, 1, $1, $2, $3, $4, 'method', $5::jsonb, '目标结果', 'fixture://m', 'fixture', 1, 'fixture')`, [id, period, `${id} 标题`, owner, JSON.stringify([battlefield])]);
  await mission("m-yi-10", YI, "2026-10", "growth");
  await mission("m-bing-10", BING, "2026-10", "growth");
  await mission("m-bing-09", BING, "2026-09", "growth");
  await mission("m-ding-10", DING, "2026-10", "brand");
  const task = async (owner: string, missionId: string, title: string) => {
    const id = randomUUID();
    await q(`INSERT INTO tasks (id, title, status, owner_id, created_by, mission_id, step_order) VALUES ($1, $2, 'in_progress', $3, 'self', $4, 1)`, [id, title, owner, missionId]);
    return id;
  };
  const progress = (taskId: string, author: string, body: string, at: string) =>
    q("INSERT INTO task_progress (id, task_id, author_id, source, body, created_at) VALUES ($1, $2, $3, 'web', $4, $5)", [randomUUID(), taskId, author, body, at]);
  const bingTask = await task(BING, "m-bing-10", "丙的执行事项");
  const dingTask = await task(DING, "m-ding-10", "丁的执行事项");
  await progress(bingTask, BING, "丙写了接口文档", "2026-10-12T02:00:00Z");
  await progress(dingTask, DING, "丁做完了品牌物料", "2026-10-13T02:00:00Z");
  await progress(dingTask, DING, "丁约好了渠道", "2026-10-14T02:00:00Z");
  await q(`INSERT INTO weekly_reviews (id, person_id, week_start, status, body, submitted_at, created_at, updated_at)
    VALUES ($1, $2, '2026-10-05', 'submitted', $3::jsonb, now(), now(), now())`, [randomUUID(), DING, JSON.stringify({
    overall: { text: "丁本周推进品牌", sources: [] }, progress: { text: "物料完成", sources: [] }, issues: { text: "", sources: [] },
    implications: { text: "", sources: [] }, actions: { text: "", sources: [] } })]);
  // 丙：已提交一份、本周还有一份没提交的草稿（别人看不到草稿正文）。
  const weekly = (person: string, week: string, status: "submitted" | "draft", text: string) => q(`INSERT INTO weekly_reviews (id, person_id, week_start, status, body, submitted_at, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, now(), now())`, [randomUUID(), person, week, status, JSON.stringify({
    overall: { text, sources: [] }, progress: { text: "", sources: [] }, issues: { text: "", sources: [] }, implications: { text: "", sources: [] }, actions: { text: "", sources: [] } }),
    status === "submitted" ? new Date() : null]);
  await weekly(BING, "2026-10-05", "submitted", "丙本周写完接口文档");
  await weekly(BING, "2026-10-12", "draft", "丙还没提交的草稿");
  return { bingTask, dingTask };
}

const mapFor = (q: Q, personId: string, role: "ceo" | "member", extra: Partial<Parameters<typeof createCompanyMap>[0]> = {}) => {
  const scopes: TReadScope[] = [];
  const map = createCompanyMap({ q: q as never, viewer: { personId, role }, people: PEOPLE, now: () => NOW,
    focus: defaultFocus("global", null, { personId, role }, NOW), onScope: (scope) => scopes.push(scope), ...extra });
  return { map, scopes };
};

describe("三层取用的权限与范围标签", () => {
  it("成员读不到其他战场的进展，filtered 是被过滤的条数；CEO 全部看得到", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const q: Q = (sql, params) => db.query(sql, params);
      await seed(q);

      const member = mapFor(q, YI, "member");
      const read = await member.map.readProgress({ people: "all" });
      const names = (read.people as { person: string }[]).map((group) => group.person);
      expect(names).toContain("丙");
      expect(names).not.toContain("丁");
      // 丁的一件执行事项 + 两条进展，都在品牌战场。
      expect(read.filtered).toBe(3);
      expect(JSON.stringify(read)).not.toContain("品牌物料");

      const reviews = await member.map.readReviews({ people: "all", kind: "weekly" });
      expect(reviews.weekly).toEqual([]);
      expect(reviews.filtered).toBe(1);

      const ceo = mapFor(q, CEO, "ceo");
      const all = await ceo.map.readProgress({ people: "all" });
      expect(all.filtered).toBe(0);
      expect((all.people as { person: string }[]).map((group) => group.person).sort()).toEqual(["丁", "丙"].sort());
      expect(JSON.stringify(all)).toContain("丁约好了渠道");

      expect(await canReadProgress(q as never, { personId: YI, role: "member" }, { personId: BING, period: "2026-10" })).toBe(true);
      expect(await canReadProgress(q as never, { personId: YI, role: "member" }, { personId: DING, period: "2026-10" })).toBe(false);
      expect(await canReadProgress(q as never, { personId: YI, role: "member" }, { personId: YI, period: "2026-10" })).toBe(true);
      expect(await canReadProgress(q as never, { personId: CEO, role: "ceo" }, { personId: DING, period: "2026-10" })).toBe(true);
    });
  }, 60_000);

  it("周复盘正文：已提交的 CEO 能看全部，其他人只看同一战场；没提交的草稿只有本人能看", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const q: Q = (sql, params) => db.query(sql, params);
      await seed(q);
      const texts = (read: { weekly: unknown[] }) => (read.weekly as { person: string; text: string }[]).map((item) => `${item.person}:${item.text}`).sort();

      const ceo = await mapFor(q, CEO, "ceo").map.readReviews({ people: "all", kind: "weekly" });
      expect(texts(ceo)).toEqual(["丁:本周总体判断
丁本周推进品牌

关键进展与 Evidence
物料完成", "丙:本周总体判断
丙本周写完接口文档"].sort());
      expect(ceo.filtered).toBe(0);
      expect(JSON.stringify(ceo)).not.toContain("还没提交");

      const peer = await mapFor(q, YI, "member").map.readReviews({ people: "all", kind: "weekly" });
      expect(texts(peer)).toEqual(["丙:本周总体判断
丙本周写完接口文档"]);
      expect(peer.filtered).toBe(1);

      const self = await mapFor(q, BING, "member").map.readReviews({ people: "me", kind: "weekly" });
      expect(texts(self)).toContain("丙:本周总体判断
丙还没提交的草稿");
    });
  }, 60_000);

  it("Mission 卡全员可读，跨对象读取发范围标签；本人改过的范围优先", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const q: Q = (sql, params) => db.query(sql, params);
      await seed(q);

      const member = mapFor(q, YI, "member");
      const cards = await member.map.readMissionCards({ people: "all", from: "2026-09", to: "2026-10" });
      expect((cards.missions as { title: string }[]).map((mission) => mission.title).sort())
        .toEqual(["m-bing-09 标题", "m-bing-10 标题", "m-ding-10 标题", "m-yi-10 标题"].sort());
      expect(cards.filtered).toBe(0);
      expect(member.scopes.at(-1)?.label).toBe("全员 · 9–10 月");
      expect(member.scopes.at(-1)?.params).toEqual({ people: "all", from: "2026-09", to: "2026-10" });

      // 只读自己、只一个月：页面默认焦点之内，不发标签。
      const quiet = mapFor(q, YI, "member");
      await quiet.map.readMissionCards({});
      expect(quiet.scopes).toEqual([]);

      // 本人把范围改成「丙 · 9 月」：模型给的范围被覆盖。
      const overridden = mapFor(q, YI, "member", { override: { people: [BING], from: "2026-09", to: "2026-09" } });
      const narrowed = await overridden.map.readMissionCards({ people: "all", from: "2026-07", to: "2026-10" });
      expect((narrowed.missions as { title: string }[]).map((mission) => mission.title)).toEqual(["m-bing-09 标题"]);
      expect(overridden.scopes.at(-1)?.label).toBe("丙 · 9 月");

      // 对不上的人名单独列出。
      const unknown = await member.map.readMissionCards({ people: ["戊"] });
      expect(unknown.unknownPeople).toEqual(["戊"]);
      expect(unknown.missions).toEqual([]);
    });
  }, 60_000);

  it("沿公司地图走：战场向下是本月 Mission，看不到的执行事项记 filtered", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const q: Q = (sql, params) => db.query(sql, params);
      await seed(q);
      const member = mapFor(q, YI, "member");
      const down = await member.map.readObjectTree({ from: "battlefield:增长战场", direction: "down", period: "2026-10" }) as { items: { title: string }[] };
      expect(down.items.map((item) => item.title).sort()).toEqual(["m-bing-10 标题", "m-yi-10 标题"]);
      const tasks = await member.map.readObjectTree({ from: "mission:m-ding-10", direction: "down" }) as { items: unknown[]; filtered: number };
      expect(tasks.items).toEqual([]);
      expect(tasks.filtered).toBe(1);
      const up = await member.map.readObjectTree({ from: `person:丙`, direction: "up", period: "2026-10" }) as { items: { title: string }[] };
      expect(up.items.map((item) => item.title)).toEqual(["增长战场"]);
    });
  }, 60_000);

  it("范围标签的写法", () => {
    const names = new Map(PEOPLE.map((person) => [person.personId, person.displayName]));
    expect(scopeLabel({ people: null, from: "2026-07", to: "2026-10", viewerId: YI }, names)).toBe("全员 · 7–10 月");
    expect(scopeLabel({ people: [YI], from: "2026-10", to: "2026-10", viewerId: YI }, names)).toBe("我 · 10 月");
    expect(scopeLabel({ people: [YI, BING, DING], from: "2025-11", to: "2026-02", viewerId: CEO }, names)).toBe("乙、丙等 3 人 · 2025.11–2026.2");
    expect(scopeLabel({ people: null, battlefieldName: "增长战场", from: "2026-10", to: "2026-10", viewerId: YI }, names)).toBe("增长战场 · 10 月");
  });
});
