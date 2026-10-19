/**
 * 管理员视图截图用的一次性 API：本机 54329 测试库建一个临时库，造六个人的运行数据，监听 4600。
 * 不读 .env，不调模型、不连飞书和本体。测试口令只在这里：孙铭泽 sunm / 2580（管理员、CEO），刘人豪 liur / 3690（管理员、成员），陈思远 chens / 4826（成员）。
 * 跑法（在 apps/api 下）：node node_modules/tsx/dist/cli.mjs ../../.scratch/admin-view/evidence/fixture-server.mts
 */
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TEST_PG_URL = "postgres://postgres:postgres@localhost:54329/postgres";
const { createTestApp } = await import("../../../apps/api/test/helpers.js");
const { hashSecret } = await import("../../../apps/api/src/session.js");

const people = [
  { personId: "sun-mingze", displayName: "孙铭泽", roles: ["ceo", "dri"], loginId: "sunm", passcode: "2580" },
  { personId: "liu-renhao", displayName: "刘人豪", roles: ["dri", "participant"], loginId: "liur", passcode: "3690" },
  { personId: "chen-siyuan", displayName: "陈思远", roles: ["dri", "participant"], loginId: "chens", passcode: "4826" },
  { personId: "li-jujie", displayName: "李巨杰", roles: ["participant"] },
  { personId: "zhou-yutong", displayName: "周雨桐", roles: ["participant"] },
  { personId: "zhao-yifan", displayName: "赵一凡", roles: ["dri", "participant"] },
];
const dir = await mkdtemp(join(tmpdir(), "warmap-admin-view-"));
const seed = join(dir, "people.json");
await writeFile(seed, JSON.stringify({ schemaVersion: "company-people.v1", people: people.map(({ personId, displayName, roles }) => ({ personId, displayName, roles })) }));

const t = await createTestApp({
  companyPeopleSeed: seed,
  adminPersonIds: ["sun-mingze", "liu-renhao"],
  publicOrigin: "http://127.0.0.1:3600",
  extraOrigins: ["http://localhost:3600"],
});
const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3_600_000);

for (const person of people) {
  if (person.loginId) await t.sql("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE)", [person.personId, person.loginId, hashSecret(person.passcode!)]);
  await t.sql("INSERT INTO person_onboarding (person_id, completed_at) VALUES ($1, now())", [person.personId]);
}

const health = (person: string, device: string, name: string, platform: string, source: string, success: Date | null, first: Date, status = "ok", code: string | null = null) => t.sql(
  `INSERT INTO collector_health (person_id, device_id, source, device_name, platform, collector_version, first_seen_at, last_attempt_at, last_success_at,
    coverage_until, last_new_evidence_at, source_status, error_code) VALUES ($1, $2, $3, $4, $5, '0.1.0', $6, $7, $8, $8, $8, $9, $10)`,
  [person, device, source, name, platform, first, ago(0.4), success, status, code]);
await health("sun-mingze", "dev-sun-000001", "MacBook Pro", "macos", "codex", ago(0.3), ago(24 * 20));
await health("sun-mingze", "dev-sun-000001", "MacBook Pro", "macos", "claude", ago(0.3), ago(24 * 20));
await health("liu-renhao", "dev-liu-000001", "办公台式机", "windows", "codex", ago(1.2), ago(24 * 12));
await health("chen-siyuan", "dev-chen-00001", "ThinkPad", "windows", "codex", ago(24 * 6), ago(24 * 15));
await health("chen-siyuan", "dev-chen-00001", "ThinkPad", "windows", "claude", null, ago(24 * 15), "error", "PERMISSION_DENIED");
await health("li-jujie", "dev-li-0000001", "MacBook Air", "macos", "claude", ago(30), ago(24 * 9));
await health("zhao-yifan", "dev-zhao-00001", "工作机", "linux", "codex", ago(2), ago(24 * 7));

await t.sql(`INSERT INTO feishu_identities (person_id, open_id) VALUES ('sun-mingze','ou_1'),('liu-renhao','ou_2'),('chen-siyuan','ou_3'),('li-jujie','ou_4'),('zhao-yifan','ou_6')`);
await t.sql(`INSERT INTO feishu_user_tokens (person_id, key_version, ciphertext, access_expires_at, authorized_at, last_refreshed_at, status, reauth_reminder_at) VALUES
  ('sun-mingze', 1, 'x', $1, $2, $1, 'active', NULL),
  ('liu-renhao', 1, 'x', $1, $3, $1, 'active', $1),
  ('chen-siyuan', 1, 'x', $1, $4, NULL, 'reauth_required', NULL),
  ('li-jujie', 1, 'x', $1, $2, $1, 'active', NULL),
  ('zhao-yifan', 1, 'x', $1, $2, $5, 'active', NULL)`, [ago(1.5), ago(24 * 20), ago(24 * 331), ago(24 * 40), ago(3)]);

const review = (person: string, week: string, submitted: Date, status: string, sync: unknown[]) => t.sql(
  `INSERT INTO weekly_reviews (id, person_id, week_start, status, submitted_at, world_sync_status, world_sync, created_at, updated_at)
   VALUES ($1, $2, $3, 'submitted', $4, $5, $6::jsonb, $4, $4)`, [randomUUID(), person, week, submitted, status, JSON.stringify(sync)]);
await review("sun-mingze", "2026-10-12", ago(26), "done", [{ target: "mission:a", status: "committed" }]);
await review("liu-renhao", "2026-10-12", ago(25), "done", [{ target: "mission:b", status: "committed" }]);
await review("chen-siyuan", "2026-10-05", ago(24 * 8), "done", [{ target: "mission:c", status: "committed" }]);
await review("chen-siyuan", "2026-10-12", ago(27), "failed", [{ target: "mission:c", status: "committed" }, { target: "task:d", status: "failed", code: "CONTRACT_MISMATCH" }, { target: "task:e", status: "failed", code: "INVALID_STATE" }]);
await review("zhao-yifan", "2026-10-12", ago(3), "pending", []);

await t.sql(`INSERT INTO jobs (kind, dedupe_key, status, attempts, last_error, updated_at) VALUES
  ('feishu.event', 'event:om_1', 'dead', 5, 'feishu 99991663: tenant access token invalid', $1),
  ('feishu.refresh', 'refresh:chen-siyuan', 'pending', 3, 'feishu 20037: refresh token expired', $2),
  ('feishu.refresh', 'refresh:sun-mingze', 'done', 1, NULL, $2)`, [ago(5), ago(0.7)]);
const ledger = (key: string, action: string, target: string, status: string, code: string | null, at: Date) => t.sql(
  `INSERT INTO world_sync_ledger (instance, action_type, idempotency_key, target_ref, status, error_code, request_digest, request_body, created_at)
   VALUES ('mvp', $1, $2, $3, $4, $5, 'd', '{}'::jsonb, $6)`, [action, key, target, status, code, at]);
await ledger("weekly-review-chen-task-d-0001", "write_state_snapshot", "obj_task_d81c", "failed", "CONTRACT_MISMATCH", ago(27));
await ledger("weekly-review-chen-task-e-0001", "record_external_event", "obj_task_e2a0", "failed", "INVALID_STATE", ago(27));
await ledger("meeting-confirm-1015-000001", "record_external_event", "obj_mission_7f3", "network_error", "NETWORK_ERROR", ago(2));

const run = (kind: string, status: string, snapshot: unknown, started: Date) => t.sql(
  `INSERT INTO agent_runs (id, kind, status, model_slot, prompt_hash, input_snapshot, started_at, completed_at) VALUES ($1, $2, $3, 'light', 'h', $4::jsonb, $5, $5)`,
  [randomUUID(), kind, status, JSON.stringify(snapshot), started]);
await run("conversation", "succeeded", { viewerId: "liu-renhao", qualitySignals: [{ signal: "memory_mark_unknown_id", ids: ["m1", "m2"] }] }, ago(1.6));
await run("conversation", "failed", { viewerId: "chen-siyuan" }, ago(4));
await run("conversation", "succeeded", { viewerId: "sun-mingze", qualitySignals: [{ signal: "memory_mark_unknown_id", ids: ["m9"] }] }, ago(30));

await t.app.listen({ port: 4600, host: "127.0.0.1" });
console.log("admin fixture ready on 4600");
const stop = async () => { await t.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// Windows 下后台进程收不到 SIGINT：在本目录放一个 stop 文件也会收尾（删掉临时库）。
const stopFile = new URL("./stop", import.meta.url);
setInterval(() => { if (existsSync(stopFile)) { rmSync(stopFile); void stop(); } }, 1000);
