/**
 * Ticket 01p browser integration fixture. Run with the existing apps/api tsx.
 * Never loads .env and never connects to the shared 5432 development database.
 * Accounts are TEST_CEO / TEST_MEMBER from apps/api/test/helpers.ts; do not log them.
 * CEO must change its fixture passcode on first login. All people and business data
 * below are explicitly synthetic fixtures, stored in this process's disposable DB.
 *
 * Voiceprint conversion and Tencent are SIMULATED dependencies. Browser microphone,
 * MediaRecorder, multipart upload, API consent checks and DB persistence remain real.
 * This verifies the browser integration, not Tencent accuracy or real audio conversion.
 * Launch Chrome with --use-fake-device-for-media-stream,--use-fake-ui-for-media-stream.
 *
 * Stop cleanly by sending `close\n` to stdin, SIGINT or SIGTERM. The helper closes
 * Fastify and its pools, then drops only the database it created. Forced process
 * termination cannot run cleanup; the ready line identifies that database for cleanup.
 *
 * Screenshot states can be changed with SQL in the reported database ONLY:
 *   DELETE FROM person_onboarding; -- revisit welcome without invalidating sessions
 *   UPDATE monthly_plans SET status='confirmed', confirmed_at=now();
 *   UPDATE monthly_plans SET status='draft', confirmed_at=NULL;
 *   DELETE FROM person_voiceprints; -- show voiceprint un-enrolled again
 *   DELETE FROM missions; -- show the member's Mission empty state
 * The fixed fixture period is the Shanghai month at startup.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { VoiceprintDeps } from "../../../../apps/api/src/voiceprints.js";
import type { TestApp } from "../../../../apps/api/test/helpers.js";

const PORT = 4500;
const PUBLIC_ORIGIN = "http://localhost:3500";

// Public, repository-defined TEST_PG_URL default; no secret file or ambient URL is read.
// Set before the dynamic helper import because helpers captures this URL at module load.
process.env.TEST_PG_URL = "postgres://postgres:postgres@localhost:54329/postgres";

const writeReady = process.stdout.write.bind(process.stdout);
// API observability writes directly to stdout. This fixture intentionally emits only
// its port/database ready record; no HTTP bodies, credentials, cookies or provider data.
const discardOutput = ((_chunk: unknown, encoding?: unknown, callback?: () => void) => {
  if (typeof encoding === "function") encoding();
  else callback?.();
  return true;
}) as typeof process.stdout.write;
process.stdout.write = discardOutput;
process.stderr.write = discardOutput;

let app: TestApp | undefined;
let shutdown: Promise<void> | undefined;
let settle: (() => void) | undefined;

function close() {
  shutdown ??= (async () => {
    await app?.close();
    process.stdin.pause();
    settle?.();
  })();
  return shutdown;
}

async function main() {
  const { createTestApp, testEnv, TEST_CEO, TEST_MEMBER } = await import("../../../../apps/api/test/helpers.js");
  const { companyPeriod } = await import("../../../../apps/api/src/monthlyPlans.js");
  // Only the current isolated fixture process sees this test configuration mutation.
  testEnv.publicOrigin = PUBLIC_ORIGIN;
  const now = new Date();
  const period = companyPeriod(now);
  const voiceprints: VoiceprintDeps = {
    configured: () => process.env.ONBOARDING_FIXTURE_VOICE !== "off",
    requireConfig: () => ({ groupId: "onboarding-browser-fixture" }),
    async toPcm(_input, output) {
      // Deterministic 20 s PCM fixture, as in voiceprint.test.ts; no external ffmpeg.
      await writeFile(output, Buffer.alloc(20 * 32_000));
    },
    async enroll() { return `browser-fixture-${randomUUID()}`; },
    async update() {},
    async remove() {},
    async groupVerify() { return []; },
  };

  app = await createTestApp({ companyName: "星海科技（示例）" }, undefined, {
    voiceprintDeps: voiceprints,
    monthlyNow: () => new Date(now),
  });
  const [{ database }] = await app.sql("SELECT current_database() AS database");
  if (typeof database !== "string" || !/^warmap_test_[a-f0-9]{12}$/.test(database)) {
    throw new Error("Unexpected disposable database name");
  }

  await app.sql("UPDATE member_access SET must_change = TRUE WHERE person_id = $1", [TEST_CEO.personId]);
  await app.sql("UPDATE company_strategy_config SET ltco = $1 WHERE id = 'default'", [
    "未来六个月，让产品在三个核心场景形成可复制的增长，成为客户每天愿意使用的工作伙伴。",
  ]);
  await app.sql(
    "UPDATE battlefield_config SET code = '01', name = '客户增长', owner_id = $1, six_month_outcome = '建立稳定的客户增长路径', sort_order = 1 WHERE id = 'growth'",
    [TEST_MEMBER.personId],
  );
  await app.sql(
    `INSERT INTO battlefield_config (id, version, code, name, owner_id, six_month_outcome, sort_order)
     VALUES ('experience', 1, '02', '产品体验', $1, '让关键工作顺畅完成', 2),
            ('delivery', 1, '03', '客户交付', $2, '让交付质量稳定且可信', 3)`,
    [TEST_CEO.personId, TEST_MEMBER.personId],
  );
  await app.sql(
    `INSERT INTO capability_config (id, version, code, name, six_month_outcome, sort_order)
     VALUES ('product', 1, '01', '产品与设计', '以清晰体验承接复杂工作', 1),
            ('engineering', 1, '02', '工程与数据', '建立可信、稳定的技术能力', 2)`,
  );

  const battlefields = [
    { battlefieldId: "growth", outcome: "完成三家目标客户的场景验证，确认可复制的增长路径" },
    { battlefieldId: "experience", outcome: "让首次登录到开始工作的核心路径顺畅、清晰" },
    { battlefieldId: "delivery", outcome: "形成一份客户交付清单，明确每一步的负责人和验收证据" },
  ];
  const negotiation = { edits: [], checkedItemIds: [], feedback: [], note: "示例计划正在核对中" };
  const generation = {
    status: "ready", pendingSince: null, runId: null, previousRunIds: [],
    error: null, generatedAt: now.toISOString(),
  };
  await app.sql(
    `INSERT INTO monthly_plans
       (id, version, period, status, company_outcome, battlefields, capabilities, todos, negotiation, generation)
     VALUES ($1, 1, $2, 'negotiating', $3, $4::jsonb, $5::jsonb, '[]', $6::jsonb, $7::jsonb)`,
    [randomUUID(), period, "把目标变成可核对的当月结果", JSON.stringify(battlefields),
      JSON.stringify([{ capabilityId: "product", outcome: "验证首次使用的完整体验" }]),
      JSON.stringify(negotiation), JSON.stringify(generation)],
  );
  for (const [index, title, battlefieldId] of [
    [1, "完成目标客户的首轮场景访谈", "growth"],
    [2, "验证新客户从了解产品到首次使用的路径", "growth"],
    [3, "整理客户反馈，明确下一轮产品改进", "growth"],
    [4, "建立一份可以复用的客户交付清单", "delivery"],
  ] as const) {
    await app.sql(
      `INSERT INTO missions (id, version, code, period, title, owner_id, capability_id,
         battlefield_ids, outcome, source_ref, source_document_id, source_revision, source_title)
       VALUES ($1, 1, $2, $3, $4, $5, 'product', $6::jsonb, $7, 'fixture://onboarding', 'onboarding-browser', 1, '引导浏览器测试资料')`,
      [`browser-mission-${index}`, `M0${index}`, period, title, TEST_MEMBER.personId,
        JSON.stringify([battlefieldId]), `${title}，留下可以核对的结果与证据。`],
    );
  }

  const stopped = new Promise<void>((resolve) => { settle = resolve; });
  const stop = () => { void close().catch(() => { process.exitCode = 1; settle?.(); }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.setEncoding("utf8");
  let command = "";
  process.stdin.on("data", (chunk: string) => {
    command += chunk;
    const lines = command.split(/\r?\n/);
    command = lines.pop() ?? "";
    if (lines.some((line) => line.trim() === "close")) stop();
  });
  await app.app.listen({ port: PORT, host: "127.0.0.1" });
  writeReady(`${JSON.stringify({ ready: true, port: PORT, database })}\n`);
  await stopped;
}

void main().catch(async () => {
  process.exitCode = 1;
  await close().catch(() => undefined);
});
