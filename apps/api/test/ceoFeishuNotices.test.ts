import { afterEach, describe, expect, it } from "vitest";
import { CEO_FEISHU_NOTICES_KIND, ceoFeishuNoticeJobs, inM2Window, m2WindowMonth } from "../src/ceoFeishuNotices.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";

let t: TestApp | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

const people = () => [
  { personId: TEST_CEO.personId, displayName: "测试甲", roles: ["ceo"] },
  { personId: TEST_MEMBER.personId, displayName: "测试乙", roles: ["dri"] },
] as never;

async function tickAt(iso: string) {
  const pool = { query: async (text: string, params?: unknown[]) => ({ rows: await t!.sql(text, params), rowCount: 0 }) } as never;
  const jobs = ceoFeishuNoticeJobs({ pool, people, now: () => new Date(iso) });
  await jobs.handlers[CEO_FEISHU_NOTICES_KIND]({}, {} as never);
  return (await t!.sql("SELECT dedupe_key, payload FROM jobs WHERE kind = 'feishu.notify' ORDER BY id")) as { dedupe_key: string; payload: { personId: string; title: string; links: { path: string }[] } }[];
}

describe("一号位要动手的事主动发飞书", () => {
  it("复盘与拆解时段：月末倒数第 3 天到次月 7 日，次月那几天算上个月的", () => {
    expect([inM2Window("2026-10-28"), inM2Window("2026-10-29"), inM2Window("2026-11-07"), inM2Window("2026-11-08")]).toEqual([false, true, true, false]);
    expect([m2WindowMonth("2026-10-30"), m2WindowMonth("2026-11-03"), m2WindowMonth("2027-01-02")]).toEqual(["2026-10", "2026-10", "2026-12"]);
  });

  it("时段里发一次复盘与拆解、红色待判断议题每条一次，只发一号位；夜里不发，重复看不重发", async () => {
    t = await createTestApp();
    const issue = (title: string, level: string, createdAt: string) => t!.sql(`INSERT INTO issues (id, version, origin, origin_ref, title, location, urgency, status, research, created_at)
      VALUES (gen_random_uuid(), 1, 'radar', '{}'::jsonb, $1, '{"level":"company"}'::jsonb, $2::jsonb, 'pending', '{"status":"idle"}'::jsonb, $3)`,
    [title, JSON.stringify({ level }), createdAt]);
    await issue("要不要提前锁定数据源", "red", "2026-10-29T01:00:00Z");
    await issue("灰色的不发", "gray", "2026-10-29T01:00:00Z");
    await issue("太早的不发", "red", "2026-10-20T01:00:00Z");
    expect(await tickAt("2026-10-29T15:00:00Z")).toEqual([]); // 上海 23 点
    const sent = await tickAt("2026-10-29T02:00:00Z"); // 上海 10 点
    expect(sent.map((row) => [row.payload.personId, row.payload.title])).toEqual([[TEST_CEO.personId, "复盘与拆解开始了"], [TEST_CEO.personId, "有议题需要尽快判断"]]);
    expect(sent[1].payload.links[0].path).toMatch(/^\/issues\//);
    expect(sent[0]).toMatchObject({ dedupe_key: `feishu.notify:ceo-m2:${TEST_CEO.personId}:2026-10`, payload: { title: "复盘与拆解开始了", links: [{ path: "/m2/" }] } });
    expect(await tickAt("2026-10-30T02:00:00Z")).toHaveLength(2);
    // 「偏好」里关了飞书通知：不再发。
    await t.sql("DELETE FROM jobs");
    await t.sql("INSERT INTO person_notify(person_id,feishu) VALUES($1,false)", [TEST_CEO.personId]);
    expect(await tickAt("2026-10-30T02:00:00Z")).toEqual([]);
  });

  it("周五到周一：本人那份周复盘起草好了等确认才发，周一看的是上一周", async () => {
    t = await createTestApp();
    await t.sql(`INSERT INTO weekly_reviews (id, person_id, week_start, status, created_at, updated_at) VALUES (gen_random_uuid(), $1, '2026-10-19', 'draft', now(), now())`, [TEST_CEO.personId]);
    const monday = await tickAt("2026-10-26T02:00:00Z");
    expect(monday.map((row) => row.payload.title)).toEqual(["周复盘等你确认"]);
    expect(monday[0].payload.links[0].path).toMatch(/^\/weekly-reviews\//);
    await t.sql("DELETE FROM jobs");
    expect(await tickAt("2026-10-27T02:00:00Z")).toEqual([]); // 周二不发
  });
});
