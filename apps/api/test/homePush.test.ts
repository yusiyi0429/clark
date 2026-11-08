import { afterEach, describe, expect, it } from "vitest";
import type { TWaitingItem, TWorkHomeResponse } from "@warmap/contracts";
import { HOME_PUSH_KIND, homePushJobs, pushNotice } from "../src/homePush.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";

let t: TestApp | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

const UNLINKED = "person-unlinked";
const item = (fields: Partial<TWaitingItem> & Pick<TWaitingItem, "id" | "kind" | "title">): TWaitingItem => ({ source: null, at: null, open: { kind: "card", id: "c-1" },
  taskId: null, sessionId: null, deviceId: null, deviceName: null, dueAt: null, answer: "open", person: null, month: null, ...fields });
const minutes = (iso: string, delta: number) => new Date(Date.parse(iso) + delta * 60_000).toISOString();

/** 每人的「等你」由测试直接给；返回每次 tick 新发的飞书通知。 */
function pusher(waiting: Map<string, TWaitingItem[]>) {
  return async (iso: string) => {
    const before = (await t!.sql("SELECT count(*)::int AS n FROM jobs WHERE kind='feishu.notify'"))[0].n as number;
    const jobs = homePushJobs({ pool: t!.pool, now: () => new Date(iso), people: () => [TEST_MEMBER.personId, TEST_CEO.personId, UNLINKED],
      readHome: async (personId) => ({ waiting: waiting.get(personId) ?? [] }) as unknown as TWorkHomeResponse });
    await jobs.handlers[HOME_PUSH_KIND]({}, {} as never);
    return (await t!.sql("SELECT payload FROM jobs WHERE kind='feishu.notify' ORDER BY id OFFSET $1", [before])).map((row) => row.payload as
      { personId: string; title: string; body: string; links: { label: string; path: string }[] });
  };
}

describe("飞书推送（新首页 13.2）", () => {
  it("开关存在服务端、缺省开；网页上打开天枢记下时间", async () => {
    t = await createTestApp();
    const cookie = await t.memberCookie();
    const call = (method: "GET" | "PUT", payload?: object) => t!.app.inject({ method, url: "/api/me/notification-settings", headers: { cookie, origin: t!.publicOrigin },
      ...(payload ? { payload } : {}) });
    expect((await call("GET")).json()).toEqual({ feishu: true });
    expect((await call("PUT", { feishu: false })).json()).toEqual({ feishu: false });
    expect((await call("GET")).json()).toEqual({ feishu: false });
    expect((await call("PUT", { feishu: "no" })).statusCode).toBe(400);
    expect((await t.sql("SELECT feishu, web_seen_at IS NOT NULL AS seen FROM person_settings WHERE person_id=$1", [TEST_MEMBER.personId]))).toEqual([{ feishu: false, seen: true }]);
  });

  it("外观存在服务端（17.2）：缺省跟随系统，改了读回来一样；改外观不动通知开关；不认识的值 400；没登录 401", async () => {
    t = await createTestApp();
    const cookie = await t.memberCookie();
    const call = (method: "GET" | "PUT", payload?: object, withCookie = true) => t!.app.inject({ method, url: "/api/me/appearance",
      headers: { ...(withCookie ? { cookie } : {}), origin: t!.publicOrigin }, ...(payload ? { payload } : {}) });
    expect((await call("GET")).json()).toEqual({ appearance: "system" });
    expect((await call("PUT", { appearance: "dark" })).json()).toEqual({ appearance: "dark" });
    expect((await call("GET")).json()).toEqual({ appearance: "dark" });
    expect((await t.app.inject({ method: "GET", url: "/api/me/notification-settings", headers: { cookie, origin: t.publicOrigin } })).json()).toEqual({ feishu: true });
    expect((await call("PUT", { appearance: "blue" })).statusCode).toBe(400);
    expect((await call("GET", undefined, false)).statusCode).toBe(401);
  });

  it("只推三类里的两类（CEO 拍板在原来那条）：不在天枢时的受阻、额度、批准等了 10 分钟；离截止不到 24 小时的确认。同一件不推第二次，10 分钟里的合成一条", async () => {
    t = await createTestApp();
    await t.sql("INSERT INTO feishu_identities (person_id, open_id) VALUES ($1,'ou_member'),($2,'ou_ceo')", [TEST_MEMBER.personId, TEST_CEO.personId]);
    await t.sql("INSERT INTO person_settings(person_id,feishu) VALUES($1,false)", [TEST_CEO.personId]);
    const T0 = "2026-11-07T02:00:00.000Z"; // 上海 10:00
    const verdict = item({ id: "verdict:card:c-1", kind: "verdict", title: "验收两次没过", source: "做登录页 · 对话质量达标", at: minutes(T0, -30) });
    const question = item({ id: "question:card:c-2", kind: "question", title: "等你回复", at: minutes(T0, -30), open: { kind: "card", id: "c-2" } });
    const approval = item({ id: "approval:topic:p-1", kind: "approval", title: "等你批准", source: "行业报告", at: minutes(T0, -5), open: { kind: "topic", id: "p-1" } });
    const laterCard = item({ id: "mission_card:mc-1", kind: "mission_card", title: "确认我的任务", dueAt: minutes(T0, 30 * 60), open: { kind: "mission_card", id: "mc-1" } });
    const review = item({ id: "month:review:2026-10", kind: "month", title: "复盘 10 月", dueAt: minutes(T0, 20 * 60), open: { kind: "month", id: "2026-10" },
      month: { step: "review", period: "2026-10" } });
    const waiting = new Map([[TEST_MEMBER.personId, [verdict, question, approval, laterCard, review]], [TEST_CEO.personId, [verdict]], [UNLINKED, [verdict]]]);
    const tick = pusher(waiting);

    // 本人不在天枢：受阻、离截止 20 小时的复盘推；等你回复不推，批准才等了 5 分钟、Mission Card 离截止还有 30 小时不推。关了的、没关联飞书的不推。
    const first = await tick(T0);
    expect(first).toEqual([{ personId: TEST_MEMBER.personId, title: "2 件等你",
      body: "验收两次没过 · 做登录页 · 对话质量达标\n复盘 10 月（11月8日 06:00 截止）",
      links: [{ label: "验收两次没过", path: "/me/work/cards/c-1" }, { label: "复盘 10 月", path: "/me/work/month/2026-10" }] }]);
    // 5 分钟后批准等满 10 分钟，但离上一条不到 10 分钟：攒着；同一件不推第二次。
    expect(await tick(minutes(T0, 5))).toEqual([]);
    expect(await tick(minutes(T0, 10))).toEqual([{ personId: TEST_MEMBER.personId, title: "等你批准", body: "等你批准 · 行业报告",
      links: [{ label: "打开天枢", path: "/me/work/topics/p-1" }] }]);
    expect(await tick(minutes(T0, 30))).toEqual([]);

    // 本人在天枢里（2 分钟前打开过）：新的受阻不推；离截止不到 24 小时的确认照推。
    const T1 = minutes(T0, 8 * 60);
    await t.sql("INSERT INTO person_settings(person_id,web_seen_at) VALUES($1,$2) ON CONFLICT (person_id) DO UPDATE SET web_seen_at=EXCLUDED.web_seen_at",
      [TEST_MEMBER.personId, minutes(T1, -2)]);
    waiting.set(TEST_MEMBER.personId, [{ ...verdict, id: "verdict:card:c-9" }, laterCard]);
    expect((await tick(T1)).map((notice) => [notice.title, notice.links[0].path])).toEqual([["确认我的任务", "/me/mission-cards/mc-1"]]);
  });

  it("22:00 到 08:00 不推，08:00 把那时还在等的合成一条（夜里已经处理掉的不推）", async () => {
    t = await createTestApp();
    await t.sql("INSERT INTO feishu_identities (person_id, open_id) VALUES ($1,'ou_member')", [TEST_MEMBER.personId]);
    const quota = item({ id: "quota:d-1", kind: "quota", title: "Claude 订阅额度用完 · 09:00 恢复", source: "2 件停着", dueAt: "2026-11-08T01:00:00.000Z",
      open: { kind: "connections", id: "this_computer" } });
    const verdict = item({ id: "verdict:card:c-1", kind: "verdict", title: "验收两次没过", at: "2026-11-07T14:30:00.000Z" });
    const waiting = new Map([[TEST_MEMBER.personId, [quota, verdict]]]);
    const tick = pusher(waiting);
    expect(await tick("2026-11-07T14:30:00.000Z")).toEqual([]); // 上海 22:30
    expect(await tick("2026-11-07T23:59:00.000Z")).toEqual([]); // 上海 07:59
    waiting.set(TEST_MEMBER.personId, [quota]); // 受阻那张夜里处理掉了
    expect(await tick("2026-11-08T00:00:00.000Z")).toEqual([{ personId: TEST_MEMBER.personId, title: "Claude 订阅额度用完 · 09:00 恢复",
      body: "Claude 订阅额度用完 · 09:00 恢复 · 2 件停着", links: [{ label: "打开天枢", path: "/me/work/settings/connections" }] }]);
  });

  it("一条里超过 5 件：前 5 件各一个链接，再加一个打开天枢", () => {
    const items = Array.from({ length: 6 }, (_, index) => item({ id: `verdict:card:c-${index}`, kind: "verdict", title: `第 ${index + 1} 件`, open: { kind: "card", id: `c-${index}` } }));
    const notice = pushNotice(TEST_MEMBER.personId, items);
    expect([notice.title, notice.links.length, notice.links.at(-1)]).toEqual(["6 件等你", 6, { label: "打开天枢", path: "/me/work" }]);
  });
});
