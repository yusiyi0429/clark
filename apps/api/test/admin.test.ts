import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { TAdminOverviewResponse } from "@warmap/contracts";
import { parseAdminPersonIds } from "../src/admin.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";

/** 三人名单：测试甲（CEO，管理员）、乙（DRI）、丙（参与人）。 */
const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const THIRD = "person-fixture-003";
/** 2026-10-16 是周五，北京时间 10:00。 */
const NOW = new Date("2026-10-16T02:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

let t: TestApp | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

async function setup() {
  t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED, adminPersonIds: [TEST_CEO.personId] }, undefined, { monthlyNow: () => NOW });
  return { t, admin: await t.loginCookie(), member: await t.memberCookie() };
}
const get = (cookie: string | null, url: string) => t!.app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });
const act = (cookie: string | null, payload: Record<string, unknown>) =>
  t!.app.inject({ method: "POST", url: "/api/admin/actions", headers: { ...(cookie ? { cookie } : {}), origin: t!.publicOrigin }, payload });
const overview = async (cookie: string) => {
  const response = await get(cookie, "/api/admin/overview");
  expect(response.statusCode).toBe(200);
  return response.json() as TAdminOverviewResponse;
};
const counter = (view: TAdminOverviewResponse, key: string) => view.counters.find((item) => item.key === key);

/** 乙：采集器周一 10:00 之后没同步（工作日 96 小时，红）；丙：采集器正常，飞书要重新授权（红）；甲：没装采集器，飞书该提醒重新授权（黄）。 */
async function seedRuntime(app: TestApp) {
  const health = (person: string, device: string, lastSuccess: Date | null, firstSeen: Date) => app.sql(
    `INSERT INTO collector_health (person_id, device_id, source, device_name, platform, collector_version, first_seen_at, last_attempt_at, last_success_at,
      coverage_until, last_new_evidence_at, source_status, error_code) VALUES ($1, $2, 'codex', '工作机', 'windows', '0.1.0', $3, $4, $4, $4, $4, 'ok', NULL)`,
    [person, device, firstSeen, lastSuccess]);
  await health(TEST_MEMBER.personId, "dev-member-0001", new Date("2026-10-12T02:00:00Z"), new Date("2026-10-01T02:00:00Z"));
  await health(THIRD, "dev-third-00001", hoursAgo(1), new Date("2026-10-01T02:00:00Z"));
  // 没装的来源不算。
  await app.sql(`INSERT INTO collector_health (person_id, device_id, source, device_name, platform, collector_version, first_seen_at, last_attempt_at,
    source_status) VALUES ($1, 'dev-third-00001', 'claude', '工作机', 'windows', '0.1.0', $2, $2, 'not_found')`, [THIRD, new Date("2026-09-01T02:00:00Z")]);

  await app.sql("INSERT INTO feishu_identities (person_id, open_id) VALUES ($1, 'ou_a'), ($2, 'ou_b'), ($3, 'ou_c')", [TEST_CEO.personId, TEST_MEMBER.personId, THIRD]);
  await app.sql(`INSERT INTO feishu_user_tokens (person_id, key_version, ciphertext, access_expires_at, authorized_at, last_refreshed_at, status, reauth_reminder_at) VALUES
    ($1, 1, 'x', $4, '2025-11-20T02:00:00Z', $4, 'active', $4),
    ($2, 1, 'x', $4, '2026-10-15T02:00:00Z', NULL, 'active', NULL),
    ($3, 1, 'x', $4, '2026-09-01T02:00:00Z', NULL, 'reauth_required', NULL)`, [TEST_CEO.personId, TEST_MEMBER.personId, THIRD, hoursAgo(2)]);

  // 乙最近一份周复盘写本体失败了一个对象；更早一份写成功。
  const review = (week: string, submitted: Date, status: string, sync: unknown[]) => app.sql(
    `INSERT INTO weekly_reviews (id, person_id, week_start, status, submitted_at, world_sync_status, world_sync, created_at, updated_at)
     VALUES ($1, $2, $3, 'submitted', $4, $5, $6::jsonb, $4, $4)`, [randomUUID(), TEST_MEMBER.personId, week, submitted, status, JSON.stringify(sync)]);
  await review("2026-10-05", new Date("2026-10-09T10:00:00Z"), "done", [{ target: "mission:a", status: "committed" }]);
  await review("2026-10-12", hoursAgo(20), "failed", [{ target: "mission:a", status: "committed" }, { target: "task:b", status: "failed", code: "INVALID_STATE" }]);

  await app.sql(`INSERT INTO jobs (kind, dedupe_key, status, attempts, last_error, updated_at) VALUES
    ('feishu.refresh', 'ok', 'done', 1, NULL, $1), ('feishu.refresh', 'retry', 'pending', 2, 'timeout', $1), ('feishu.event', 'dead', 'dead', 5, 'boom', $1)`, [hoursAgo(1)]);

  const ledger = (key: string, status: string, code: string | null, at: Date) => app.sql(
    `INSERT INTO world_sync_ledger (instance, action_type, idempotency_key, target_ref, status, error_code, request_digest, request_body, created_at)
     VALUES ('mvp', 'record_external_event', $1, 'mission:a', $2, $3, 'd', '{}'::jsonb, $4)`, [key, status, code, at]);
  await ledger("key-replayed-0000001", "failed", "INVALID_STATE", hoursAgo(5));
  await ledger("key-replayed-0000001", "committed", null, hoursAgo(4));
  await ledger("key-failed-000000001", "failed", "CONTRACT_MISMATCH", hoursAgo(3));
  await ledger("key-network-00000001", "network_error", "NETWORK_ERROR", hoursAgo(2));
  // 会议写本体最后一次仍连不上：待核验。
  await ledger("key-unverified-00001", "unverified", "NETWORK_ERROR", hoursAgo(1.5));
  // 会后事件指向会议；测试里不建整场会，绕过外键只插这一行。
  const client = await app.pool.connect();
  try {
    await client.query("SET session_replication_role = replica");
    await client.query(`INSERT INTO world_meeting_events (instance, meeting_id, meeting_version, snapshot, content_digest, status, error_code, created_at)
      VALUES ('mvp', $1, 1, '{}'::jsonb, 'd', 'failed', 'INVALID_REQUEST', $2)`, [randomUUID(), hoursAgo(6)]);
  } finally {
    await client.query("SET session_replication_role = DEFAULT");
    client.release();
  }

  const run = (status: string, snapshot: unknown, started: Date) => app.sql(
    `INSERT INTO agent_runs (id, kind, status, model_slot, prompt_hash, input_snapshot, started_at, completed_at) VALUES ($1, 'conversation', $2, 'light', 'h', $3::jsonb, $4, $4)`,
    [randomUUID(), status, JSON.stringify(snapshot), started]);
  await run("succeeded", { viewerId: TEST_MEMBER.personId, userMessage: "不该出现的正文", qualitySignals: [{ signal: "memory_mark_unknown_id", ids: ["m1", "m2"] }] }, hoursAgo(3));
  await run("failed", { viewerId: THIRD, userMessage: "不该出现的正文" }, hoursAgo(2));
  await run("succeeded", { viewerId: THIRD }, hoursAgo(1));
  await run("succeeded", { viewerId: THIRD, qualitySignals: [{ signal: "memory_mark_unknown_id", ids: ["old"] }] }, hoursAgo(24 * 10));
}

describe("管理员视图", () => {
  it("TIANSHU_ADMIN_PERSON_IDS 去空格、去重", () => {
    expect(parseAdminPersonIds(" a, b ,,a ")).toEqual(["a", "b"]);
    expect(parseAdminPersonIds(undefined)).toEqual([]);
  });

  it("只有管理员能看能做；其他人和没登录的一律 404，会话里标出谁是管理员", async () => {
    const { admin, member } = await setup();
    expect((await get(member, "/api/admin/overview")).statusCode).toBe(404);
    expect((await get(null, "/api/admin/overview")).statusCode).toBe(404);
    // 请求体不合法也先是 404：不暴露接口存在。
    expect((await act(member, { action: "nope" })).statusCode).toBe(404);
    expect((await act(member, { action: "acknowledge", clientId: randomUUID(), subject: { type: "job", id: "1" } })).statusCode).toBe(404);
    expect(await t!.sql("SELECT * FROM admin_incidents")).toEqual([]);
    expect((await get(admin, "/api/admin/overview")).statusCode).toBe(200);
    expect((await get(admin, "/api/auth/session")).json().admin).toBe(true);
    expect((await get(member, "/api/auth/session")).json().admin).toBeUndefined();
  }, 30_000);

  it("计数、人 × 来源的状态与排序、失败列表、质量信号都按运行数据算，不带对话正文", async () => {
    const { t: app, admin } = await setup();
    await seedRuntime(app);
    const view = await overview(admin);

    expect(view.counters).toEqual([
      { key: "collector_gap", value: 1, status: "red" },
      { key: "feishu_auth", value: 2, status: "red" },
      { key: "meeting_stuck", value: 0, status: "none" },
      { key: "delivery_failed", value: 0, status: "none" },
      // 待核验列出来，但不算「本体写入失败」。
      { key: "world_failed", value: 3, status: "red" },
      { key: "job_failed", value: 2, status: "red" },
    ]);

    // 都有红的乙、丙里，丙的飞书授权最久没成功（9/1），排最前；只有黄的甲在后。
    expect(view.people.map((person) => [person.displayName, person.collector.status, person.feishu.status, person.world.status])).toEqual([
      ["测试丙", "green", "red", "none"],
      ["测试乙", "red", "green", "red"],
      ["测试甲", "none", "yellow", "none"],
    ]);
    const second = view.people[1];
    // 飞书授权给的是满 365 天要重新授权的那天，不是每次续期都往后挪 7 天的续期凭证到期时间。
    expect(second.feishu.reauthDueAt).toBe("2027-10-15T02:00:00.000Z");
    expect(second.feishu).not.toHaveProperty("refreshExpiresAt");
    expect(second.collector.lastSuccessAt).toBe("2026-10-12T02:00:00.000Z");
    expect(second.collector.devices).toHaveLength(1);
    expect(second.world).toMatchObject({ lastWeek: "2026-10-12", syncStatus: "failed", failedTargets: 1, lastSuccessAt: "2026-10-09T10:00:00.000Z" });
    expect(view.people[0].collector.devices.map((device) => device.source)).toEqual(["codex"]);

    expect(view.issues.map((issue) => [issue.subject.type, issue.name, issue.status, issue.retryable])).toEqual([
      ["job", "feishu.event", "red", true],
      ["world_write", "record_external_event", "red", false],
      ["world_write", "meeting_event", "red", false],
      ["job", "feishu.refresh", "yellow", false],
      ["world_write", "record_external_event", "yellow", false],
      ["world_write", "record_external_event", "yellow", false],
    ]);
    // 待核验和网络错分开显示。
    expect(view.issues.filter((issue) => issue.subject.type === "world_write" && issue.status === "yellow").map((issue) => [issue.subject.id, issue.code]))
      .toEqual([["key-unverified-00001", "待核验"], ["key-network-00000001", "NETWORK_ERROR"]]);
    expect(view.issues.map((issue) => issue.subject.id)).not.toContain("key-replayed-0000001");

    expect(view.quality.map((item) => [item.signal, item.personName, item.count])).toEqual([
      ["run_failed", "测试丙", 1],
      ["memory_mark_unknown_id", "测试乙", 2],
    ]);
    expect(JSON.stringify(view)).not.toContain("不该出现的正文");
  }, 30_000);

  it("提醒走送达通道、已接手 / 已解决、重试 dead 任务都留痕；同一 clientId 重放不重复执行", async () => {
    const { t: app, admin, member } = await setup();
    await seedRuntime(app);
    const [dead] = await app.sql("SELECT id::text FROM jobs WHERE status = 'dead'");

    // 提醒：本人在「请求」里收到，发起人是管理员。
    const remind = { action: "remind", clientId: randomUUID(), personId: TEST_MEMBER.personId, source: "collector", title: "本机采集器 96 小时没同步", body: "最近一次成功：10/12 10:00" };
    const reminded = await act(admin, remind);
    expect(reminded.statusCode).toBe(200);
    expect((reminded.json() as TAdminOverviewResponse).people.find((person) => person.personId === TEST_MEMBER.personId)!.collector.remindedAt).not.toBeNull();
    expect((await act(admin, remind)).statusCode).toBe(200);
    const inbox = (await get(member, "/api/me/requests?box=inbox")).json().items as { title: string; initiatorName: string; myStatus: string }[];
    expect(inbox).toEqual([expect.objectContaining({ title: "本机采集器 96 小时没同步", initiatorName: "测试甲", myStatus: "pending" })]);
    expect(await app.sql("SELECT kind, object_type FROM notifications WHERE person_id = $1", [TEST_MEMBER.personId])).toEqual([{ kind: "request_received", object_type: "request" }]);
    expect((await act(admin, { ...remind, clientId: randomUUID(), personId: TEST_CEO.personId })).statusCode).toBe(400);

    // 已接手：失败列表上显示谁接手；人 × 来源的一格同样。
    const ack = await act(admin, { action: "acknowledge", clientId: randomUUID(), subject: { type: "job", id: dead.id } });
    expect((ack.json() as TAdminOverviewResponse).issues.find((issue) => issue.subject.id === dead.id)!.acknowledged).toMatchObject({ actorName: "测试甲" });
    const cell = await act(admin, { action: "acknowledge", clientId: randomUUID(), subject: { type: "collector", id: TEST_MEMBER.personId } });
    expect((cell.json() as TAdminOverviewResponse).people.find((person) => person.personId === TEST_MEMBER.personId)!.collector.acknowledged).toMatchObject({ actorName: "测试甲" });

    // 已解决：这次失败不再列出，计数跟着少。
    const resolved = (await act(admin, { action: "resolve", clientId: randomUUID(), subject: { type: "world_write", id: "key-failed-000000001" } })).json() as TAdminOverviewResponse;
    expect(resolved.issues.map((issue) => issue.subject.id)).not.toContain("key-failed-000000001");
    expect(counter(resolved, "world_failed")).toEqual({ key: "world_failed", value: 2, status: "red" });

    // 重试：dead 回到 pending、次数清零；重放不再重跑；已经不是 dead 的 409。
    const retry = { action: "retry", clientId: randomUUID(), subject: { type: "job", id: dead.id } };
    const retried = (await act(admin, retry)).json() as TAdminOverviewResponse;
    expect(retried.issues.map((issue) => issue.subject.id)).not.toContain(dead.id);
    expect(counter(retried, "job_failed")).toEqual({ key: "job_failed", value: 1, status: "yellow" });
    expect(await app.sql("SELECT status, attempts, last_error FROM jobs WHERE id = $1", [dead.id])).toEqual([{ status: "pending", attempts: 0, last_error: null }]);
    await app.sql("UPDATE jobs SET attempts = 3 WHERE id = $1", [dead.id]);
    expect((await act(admin, retry)).statusCode).toBe(200);
    expect((await app.sql("SELECT attempts FROM jobs WHERE id = $1", [dead.id]))[0].attempts).toBe(3);
    expect((await act(admin, { ...retry, clientId: randomUUID() })).json().code).toBe("JOB_NOT_DEAD");

    const trail = await app.sql("SELECT action, subject_type, subject_id, actor_id, request_id IS NOT NULL AS has_request, detail FROM admin_incidents ORDER BY created_at");
    expect(trail).toEqual([
      { action: "remind", subject_type: "collector", subject_id: TEST_MEMBER.personId, actor_id: TEST_CEO.personId, has_request: true, detail: {} },
      { action: "acknowledge", subject_type: "job", subject_id: dead.id, actor_id: TEST_CEO.personId, has_request: false, detail: {} },
      { action: "acknowledge", subject_type: "collector", subject_id: TEST_MEMBER.personId, actor_id: TEST_CEO.personId, has_request: false, detail: {} },
      { action: "resolve", subject_type: "world_write", subject_id: "key-failed-000000001", actor_id: TEST_CEO.personId, has_request: false, detail: {} },
      { action: "retry", subject_type: "job", subject_id: dead.id, actor_id: TEST_CEO.personId, has_request: false, detail: { kind: "feishu.event", attempts: 5, lastError: "boom" } },
    ]);
  }, 30_000);
});
