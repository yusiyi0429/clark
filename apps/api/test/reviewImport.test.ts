import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import type { TMonthlyReviewSelfReview, TMonthlyReviewSummaryCandidate } from "@warmap/contracts";
import { loadPeople } from "../src/companyMemory.js";
import type { MonthlyDraftAgent, MonthlyDraftAgentInput } from "../src/monthlyDraft.js";
import { importMonthlyReviews, ReviewImportFile, type TReviewImportFile } from "../src/monthlyReviewImport.js";
import type { MonthlyReviewAgents, MonthlyReviewDraftInput, MonthlyReviewSummaryInput } from "../src/monthlyReviewService.js";
import { migrate } from "../src/migrate.js";
import { PERSONAL_REVIEW_DRAFT_PROMPT } from "../src/personalReviewAgent.js";
import type { PersonalReviewDraftInput } from "../src/personalReviews.js";
import { citedReview } from "./personalReviewFixtures.js";
import { createTestApp, createTestDb, TEST_CEO, TEST_MEMBER } from "./helpers.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = join(root, "apps/api/node_modules/tsx/dist/cli.mjs");
const script = join(root, "apps/api/scripts/import-reviews.ts");
const ADMIN_URL = process.env.TEST_PG_URL ?? "postgres://postgres:postgres@localhost:54329/postgres";

const NOW = new Date("2026-10-08T01:30:00Z"); // 上海 10/8 09:30
const CYCLE_START = "2026-10-08T09:00:00+08:00";
const IMPORTED = "person-import-003";
const FEISHU = "https://tokenking.feishu.cn/wiki/test-period-review";

const field = (text: string, sources = [FEISHU]) => ({ text, sources });
const feishuReview = (prefix: string): TMonthlyReviewSelfReview => ({
  overall: field(`${prefix}：部分达成`), judgments: field(`${prefix}：1. 方法收敛`), nextFocus: field(`${prefix}：真实验证`), escalations: field(""),
});
const coAgentReview = (prefix: string): TMonthlyReviewSelfReview => ({
  overall: field(`${prefix}完成了交付`, []), judgments: field("1. 交付节奏落后", []), nextFocus: field("十月补齐交付", []), escalations: field("", []),
});
const MATERIALS = [
  { title: "测试乙｜DRI周度复盘｜2026年9月", sourceRef: "https://tokenking.feishu.cn/wiki/weekly", markdown: "# 9 月第 3 周\n交付推进到验收" },
  { title: "测试乙｜2026年9月 Mission Card", sourceRef: "https://tokenking.feishu.cn/wiki/card", markdown: "## 04-1 交付验收" },
];
const importFile = (): TReviewImportFile => ({
  period: "2026-09", exportedAt: "2026-10-07T09:55:09+08:00", source: "飞书知识库「业务域」", mappingRule: "按标题归栏",
  personalReviews: [{ personId: IMPORTED, sourceRef: FEISHU, sourceTitle: "测试丙｜9 月 Period Review", selfReview: feishuReview("测试丙") }],
  draftFromMaterials: [{ personId: TEST_MEMBER.personId, materials: MATERIALS }],
  capabilityReviews: [{ capabilityCode: "03", fromPersonId: IMPORTED }],
});

type Sql = (text: string, params?: unknown[]) => Promise<unknown>;
/** 战场 01；能力域 03（直接取测试丙的个人复盘）、04（Co-Agent 起草）、06（没有 9 月 Mission，不进这一轮）。 */
async function seedRegistry(sql: Sql) {
  await sql("UPDATE battlefield_config SET code = '01', name = '灯塔项目', owner_id = $1 WHERE id = 'growth'", [TEST_MEMBER.personId]);
  await sql(`INSERT INTO capability_config (id, version, code, sort_order, name, six_month_outcome, owner_id) VALUES
    ('cap-method', 1, '03', 3, 'Method', '方法沉淀', $1), ('cap-agents', 1, '04', 4, 'Agents', 'Agent 产品化', $2), ('cap-empty', 1, '06', 6, '空能力域', '无', '')`,
  [IMPORTED, TEST_MEMBER.personId]);
}

/** missions:import 的结果：测试乙在能力域 04、测试丙在能力域 03，都在战场 01。 */
async function seedMissions(sql: Sql) {
  for (const [owner, capability] of [[TEST_MEMBER.personId, "cap-agents"], [IMPORTED, "cap-method"]]) {
    await sql(`INSERT INTO missions (id, version, code, period, title, owner_id, capability_id, battlefield_ids, outcome, why, success_evidence, milestones,
      boundaries, source_ref, source_document_id, source_revision, source_title)
      VALUES ($1, 1, $1, '2026-09', '本人承诺', $2, $3, '["growth"]', '承诺结果', '原因', '["验收证据"]', '["里程碑"]', '边界', 'test', 'test', 1, 'test')`,
    [`mission-${owner}`, owner, capability]);
  }
}

async function peopleSeed(dir: string): Promise<string> {
  const path = join(dir, "company-people.json");
  await writeFile(path, JSON.stringify({ schemaVersion: "company-people.v1", people: [
    { personId: TEST_CEO.personId, displayName: "测试甲", roles: ["ceo"] },
    { personId: TEST_MEMBER.personId, displayName: "测试乙", roles: ["dri", "participant"] },
    { personId: IMPORTED, displayName: "测试丙", roles: ["dri", "participant"] },
  ] }));
  return path;
}

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "warmap-review-import-"));
  try { await fn(dir); } finally {
    if (!resolve(dir).startsWith(join(resolve(tmpdir()), "warmap-review-import-"))) throw new Error("Unexpected temporary directory");
    await rm(dir, { recursive: true, force: true });
  }
}

describe("reviews:import CLI", () => {
  it("真实导出文件符合导入契约", () => {
    const file = JSON.parse(readFileSync(join(root, "seed/imports/reviews-2026-09.json"), "utf8"));
    expect(Value.Check(ReviewImportFile, file), [...Value.Errors(ReviewImportFile, file)][0]?.path).toBe(true);
  });

  // 空库迁移加五次 CLI 启动，超过 Vitest 默认的 5 秒。
  it("缺 Mission 时整批不写；--dry-run 不写；正式导入可重复运行", async () => {
    const help = spawnSync(process.execPath, [cli, script, "--help"], { cwd: root, encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("reviews:import <reviews.json> --cycle-start");
    await withTempDir(async (dir) => createTestDb(async ({ db, database }) => {
      await migrate(db);
      const file = join(dir, "reviews.json");
      await writeFile(file, JSON.stringify(importFile()));
      const env = { ...process.env, DATABASE_URL: ADMIN_URL.replace(/\/postgres$/, `/${database}`), COMPANY_PEOPLE_SEED: await peopleSeed(dir) };
      const run = (...flags: string[]) => spawnSync(process.execPath, [cli, script, file, "--cycle-start", CYCLE_START, ...flags], { cwd: root, encoding: "utf8", env });
      const rows = async () => (await db.query(`SELECT * FROM (
        SELECT 'review' AS kind, id::text, version, status, origin AS detail, updated_at FROM monthly_reviews
        UNION ALL SELECT 'personal', id::text, version, status, draft_source, updated_at FROM personal_reviews
        UNION ALL SELECT 'item', id::text, version, status, confirmation_source, updated_at FROM monthly_review_items) r ORDER BY kind, id`)).rows;

      await seedRegistry(db.query.bind(db));
      const missing = run();
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("2026-09 还没有 Mission：先运行 missions:import");
      expect(await rows()).toEqual([]);

      await seedMissions(db.query.bind(db));
      const dry = run("--dry-run");
      expect(dry.status, dry.stderr).toBe(0);
      expect(dry.stdout).toContain("校验通过（--dry-run，没有写入）：1 份个人复盘导入为已提交，1 份交给 Co-Agent 起草，1 项复盘导入并确认");
      expect(await rows()).toEqual([]);

      const first = run();
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain("交给 Co-Agent 按 2 份材料起草");
      expect(first.stdout).toContain("完成：1 份个人复盘导入为已提交");
      expect(first.stdout).toContain("起草由运行中的 API 服务接手");
      const written = await rows();
      expect(written).toHaveLength(6);
      expect((await db.query("SELECT origin, cycle_started_at FROM monthly_reviews")).rows).toEqual([{ origin: "import", cycle_started_at: new Date(CYCLE_START) }]);

      const again = run();
      expect(again.status, again.stderr).toBe(0);
      for (const text of ["已导入过", "已导入，跳过", "材料已导入，跳过", "已确认，跳过"]) expect(again.stdout).toContain(text);
      expect(again.stdout).toContain("完成：0 份个人复盘导入为已提交，0 份交给 Co-Agent 起草，0 项复盘导入并确认");
      expect(await rows()).toEqual(written);
    }));
  }, 60_000);
});

type Calls = { personal: PersonalReviewDraftInput[]; personalOut: TMonthlyReviewSelfReview[]; draft: MonthlyReviewDraftInput[]; summarize: MonthlyReviewSummaryInput[]; plan: MonthlyDraftAgentInput[] };
const SUMMARY: TMonthlyReviewSummaryCandidate = {
  overall: "九月方法收敛，交付有差距", judgments: [{ title: "判断 1", body: "依据 1" }], nextFocus: ["补齐交付"],
  ltcoSuggestion: { change: false, proposedLtco: "三年成为行业第一", rationale: "战略没有变化", units: [] },
};

async function setup(dir: string) {
  const calls: Calls = { personal: [], personalOut: [], draft: [], summarize: [], plan: [] };
  const failing = new Set<string>();
  const agents: MonthlyReviewAgents = {
    personal: { async generate(input) {
      calls.personal.push(input);
      calls.personalOut.push(citedReview(input, input.importedMaterials.length ? "按材料" : "自动"));
      return { candidate: calls.personalOut.at(-1) };
    } },
    draft: { async generate(input) {
      calls.draft.push(input);
      if (failing.has(input.subject.id)) throw new Error("模型超时");
      return { candidate: coAgentReview(input.subject.name) };
    } },
    assess: { async generate() { return { candidate: { overall: "不应评估导入的复盘", deviations: [], questions: [] } }; } },
    summarize: { async generate(input) { calls.summarize.push(input); return { candidate: SUMMARY }; } },
  };
  const planAgent: MonthlyDraftAgent = { async generate(input) {
    calls.plan.push(input);
    return { candidate: { companyOutcome: "十月公司结果", battlefields: [], capabilities: [], todos: [] } };
  } };
  const seed = await peopleSeed(dir);
  const t = await createTestApp({ companyPeopleSeed: seed }, undefined,
    { monthlyReviewAgents: agents, monthlyReviewRetryDelayMs: 0, monthlyDraftAgent: planAgent, monthlyNow: () => NOW });
  await t.sql("UPDATE company_strategy_config SET ltco = '三年成为行业第一' WHERE id = 'default'");
  await seedRegistry(t.sql);
  await seedMissions(t.sql);
  const ceo = await t.loginCookie(), member = await t.memberCookie();
  const people = loadPeople(seed);
  const runImport = async () => {
    const client = await t.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await importMonthlyReviews(client.query.bind(client), importFile(), people, new Date(CYCLE_START), NOW);
      await client.query(result.problems.length ? "ROLLBACK" : "COMMIT");
      return result;
    } finally { client.release(); }
  };
  const get = async (cookie: string, url: string) => (await t.app.inject({ method: "GET", url, headers: { cookie } })).json();
  const post = (cookie: string, url: string, actionId: string, input?: unknown) =>
    t.app.inject({ method: "POST", url, headers: { cookie, origin: t.publicOrigin }, payload: { actionId, ...(input === undefined ? {} : { input }) } });
  const actionOf = (payload: { actions: { actionType: string; actionId: string }[] }, actionType: string) => {
    const found = payload.actions.find((action) => action.actionType === actionType);
    expect(found, `应提供 ${actionType}`).toBeTruthy();
    return found!.actionId;
  };
  const item = async (subjectId: string) => (await t.sql("SELECT * FROM monthly_review_items WHERE subject_id = $1", [subjectId]))[0];
  const personal = async (personId: string) => (await t.sql("SELECT * FROM personal_reviews WHERE person_id = $1", [personId]))[0];
  return { t, calls, failing, ceo, member, runImport, get, post, actionOf, item, personal };
}

describe("导入飞书复盘后的完整流程", () => {
  it("导入 → 服务端接手按材料起草 → 交齐后起草并自动确认 → 公司复盘 → LTO 决定后按复盘重新生成计划", async () => {
    await withTempDir(async (dir) => {
      const c = await setup(dir);
      try {
        // 线上状态：9 月复盘已由调度器开启，个人复盘由 Co-Agent 自动起草过；部署前的旧版本还建过能力域项。
        await c.t.monthlyReviews!.open("2026-09");
        await c.t.monthlyReviews!.idle();
        expect(c.calls.personal).toHaveLength(2);
        const reviewId = (await c.t.sql("SELECT id FROM monthly_reviews"))[0].id as string;
        for (const capability of ["cap-agents", "cap-empty"]) await c.t.sql(`INSERT INTO monthly_review_items
          (id, review_id, version, subject_type, subject_id, owner_id, owner_unassigned, target, status, draft_run, self_review, assessment, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, 3, 'capability', $2, $3, false, NULL, 'draft', '{"runId":"old-run","error":null}', $4, '{"status":"none","runId":null,"result":null,"error":null}', $5, $5)`,
        [reviewId, capability, TEST_CEO.personId, JSON.stringify(coAgentReview("九月底旧稿")), NOW]);

        const imported = await c.runImport();
        expect(imported.problems).toEqual([]);
        expect(imported.report).toContainEqual({ 对象: "月度复盘", 名称: "9 月", 结果: "沿用已开启的复盘，标为导入" });
        expect(await c.t.sql("SELECT origin, cycle_started_at FROM monthly_reviews")).toEqual([{ origin: "import", cycle_started_at: new Date(CYCLE_START) }]);
        // 飞书原文导入为已提交（覆盖本人没碰过的 Co-Agent 自动稿）；能力域 03 直接取这份四栏，确认来源记为导入、没有确认人。
        expect(await c.personal(IMPORTED)).toMatchObject({ status: "submitted", draft_source: "import", self_review: feishuReview("测试丙"), submitted_at: NOW, action_fingerprints: [] });
        expect(await c.item("cap-method")).toMatchObject({ status: "confirmed", confirmation_source: "import", self_review: feishuReview("测试丙"), confirmed_at: NOW, history: [] });
        // 按材料起草的人只写下 drafting，CLI 不调模型；旧的复盘项清掉旧稿等交齐，没有 9 月 Mission 的能力域不动。
        expect(await c.personal(TEST_MEMBER.personId)).toMatchObject({ status: "drafting", imported_materials: MATERIALS, action_fingerprints: [] });
        expect(c.calls.personal).toHaveLength(2);
        for (const subject of ["growth", "cap-agents"]) expect(await c.item(subject)).toMatchObject({ status: "waiting", self_review: null, confirmation_source: null });
        expect(await c.item("cap-empty")).toMatchObject({ status: "draft", version: 3 });

        // 运行中的 API 服务每分钟接手：按材料起草一次，重复检查不再起第二份。
        await c.t.monthlyReviews!.runScheduled();
        await c.t.monthlyReviews!.runScheduled();
        await c.t.monthlyReviews!.idle();
        expect(c.calls.personal).toHaveLength(3);
        expect(c.calls.personal[2]).toMatchObject({ personId: TEST_MEMBER.personId, importedMaterials: MATERIALS });
        expect(PERSONAL_REVIEW_DRAFT_PROMPT).toContain("材料是周复盘与任务卡，不是本人写的月度复盘");
        expect(c.calls.personalOut[2].overall.text).toContain("按材料");
        expect(await c.personal(TEST_MEMBER.personId)).toMatchObject({ status: "draft", draft_source: "co_agent", self_review: c.calls.personalOut[2] });
        const memberReview = (await c.get(c.member, `/api/personal-reviews/${(await c.personal(TEST_MEMBER.personId)).id}`)).review;
        expect(memberReview).toMatchObject({ materialCount: 2, draftSource: "co_agent" });
        // 导入的复盘不走负责人提交：负责人没有复盘项待办
        expect((await c.get(c.member, "/api/me/monthly-reviews")).notices.map((notice: { kind: string }) => notice.kind)).toEqual(["personal_todo"]);

        // 本人提交后交齐：战场与能力域 04 起草；04 起草失败时保持现状，复盘停在收集阶段，CEO 重新起草后自动确认并进入公司复盘。
        c.failing.add("cap-agents");
        expect((await c.post(c.member, "/api/personal-reviews/actions/execute", c.actionOf(memberReview, "personal-review.submit"))).statusCode).toBe(200);
        await c.t.monthlyReviews!.idle();
        expect(await c.item("growth")).toMatchObject({ status: "confirmed", confirmation_source: "import", self_review: coAgentReview("灯塔项目"), history: [] });
        expect(await c.item("cap-agents")).toMatchObject({ status: "draft_failed" });
        expect((await c.t.sql("SELECT status FROM monthly_reviews"))[0].status).toBe("collecting");
        const growthInput = c.calls.draft.find((input) => input.subject.id === "growth")!;
        expect(growthInput.personalReviews).toEqual(expect.arrayContaining([
          expect.objectContaining({ personId: IMPORTED, status: "submitted", selfReview: feishuReview("测试丙") }),
          expect.objectContaining({ personId: TEST_MEMBER.personId, status: "submitted", selfReview: c.calls.personalOut[2] }),
        ]));
        c.failing.clear();
        const failed = (await c.get(c.ceo, `/api/monthly-review-items/${(await c.item("cap-agents")).id}`)).item;
        expect((await c.post(c.ceo, "/api/monthly-reviews/actions/execute", c.actionOf(failed, "monthly-review-item.retry_draft"))).statusCode).toBe(200);
        await c.t.monthlyReviews!.idle();
        const agentsItem = (await c.get(c.ceo, `/api/monthly-review-items/${(await c.item("cap-agents")).id}`)).item;
        expect(agentsItem).toMatchObject({ status: "confirmed", confirmationSource: "import", actions: [], history: [], assessment: { status: "none" } });
        expect(c.calls.draft.filter((input) => input.subject.id === "cap-empty")).toEqual([]);

        let overview = (await c.get(c.ceo, "/api/monthly-reviews/2026-09")).review;
        expect(overview).toMatchObject({ status: "summarizing", summary: { status: "ready", overall: SUMMARY.overall } });
        expect(overview.items.filter((row: { confirmationSource: string | null }) => row.confirmationSource === "import").map((row: { subjectId: string }) => row.subjectId).sort())
          .toEqual(["cap-agents", "cap-method", "growth"]);
        expect(c.calls.summarize).toHaveLength(1);
        expect(c.calls.summarize[0].items.map((entry) => entry.subjectId).sort()).toEqual(["cap-agents", "cap-method", "growth"]);

        // 10/1 调度器已经生成过没有复盘输入的 10 月草案：CEO 没动过，LTO 决定后按复盘重新生成。
        await c.t.monthlyPlans!.createForPeriod("2026-10");
        await c.t.monthlyPlans!.idle();
        expect(c.calls.plan[0].previousReview).toBeNull();
        expect((await c.post(c.ceo, "/api/monthly-reviews/actions/execute", c.actionOf(overview, "monthly-review.confirm_summary"))).statusCode).toBe(200);
        overview = (await c.get(c.ceo, "/api/monthly-reviews/2026-09")).review;
        const decided = await c.t.app.inject({ method: "POST", url: "/api/monthly-reviews/actions/execute", headers: { cookie: c.ceo, origin: c.t.publicOrigin },
          payload: { actionId: c.actionOf(overview, "monthly-review.decide_ltco"), input: { decision: "keep" } } });
        expect(decided.json().review).toMatchObject({ status: "closed", ltco: { decision: { decision: "keep", planExisted: false } } });
        await c.t.monthlyPlans!.idle();
        expect(c.calls.plan).toHaveLength(2);
        expect(c.calls.plan[1].previousReview).toMatchObject({ period: "2026-09", judgments: SUMMARY.judgments });
        expect(c.calls.plan[1].previousReview!.items.map((entry) => entry.subjectId).sort()).toEqual(["cap-agents", "cap-empty", "cap-method", "growth"]);
      } finally { await c.t.monthlyReviews!.idle(); await c.t.close(); }
    });
  }, 60_000);

  it("本人改过、已被 CEO 跳过的个人复盘不覆盖", async () => {
    await withTempDir(async (dir) => {
      const c = await setup(dir);
      try {
        await c.t.monthlyReviews!.open("2026-09");
        await c.t.monthlyReviews!.idle();
        const own = (await c.get(c.member, `/api/personal-reviews/${(await c.personal(TEST_MEMBER.personId)).id}`)).review;
        expect((await c.post(c.member, "/api/personal-reviews/actions/execute", c.actionOf(own, "personal-review.update"),
          { fields: [{ field: "overall", text: "本人在天枢里改的" }] })).statusCode).toBe(200);
        const other = (await c.get(c.ceo, `/api/personal-reviews/${(await c.personal(IMPORTED)).id}`)).review;
        expect((await c.post(c.ceo, "/api/personal-reviews/actions/execute", c.actionOf(other, "personal-review.skip"))).statusCode).toBe(200);
        const before = await c.t.sql("SELECT * FROM personal_reviews ORDER BY person_id");

        const imported = await c.runImport();
        expect(imported.problems).toEqual([]);
        expect(imported.report).toEqual(expect.arrayContaining([
          { 对象: "个人复盘", 名称: "测试丙", 结果: "CEO 已不等，跳过" },
          { 对象: "个人复盘", 名称: "测试乙", 结果: "本人已改过，跳过" },
          { 对象: "能力域复盘", 名称: "03 Method", 结果: "导入并确认" },
        ]));
        expect(await c.t.sql("SELECT * FROM personal_reviews ORDER BY person_id")).toEqual(before);
      } finally { await c.t.monthlyReviews!.idle(); await c.t.close(); }
    });
  }, 60_000);

  it("个人复盘已经交齐时，导入清掉单元旧稿并把复盘项交给服务端起草、自动确认", async () => {
    await withTempDir(async (dir) => {
      const c = await setup(dir);
      try {
        await c.t.monthlyReviews!.open("2026-09");
        await c.t.monthlyReviews!.idle();
        for (const personId of [IMPORTED, TEST_MEMBER.personId]) {
          const row = (await c.get(c.ceo, `/api/personal-reviews/${(await c.personal(personId)).id}`)).review;
          expect((await c.post(c.ceo, "/api/personal-reviews/actions/execute", c.actionOf(row, "personal-review.skip"))).statusCode).toBe(200);
        }
        await c.t.monthlyReviews!.idle();
        // 交齐时还不是导入的复盘：战场项起草后停在草稿，等负责人提交。
        expect(await c.item("growth")).toMatchObject({ status: "draft" });
        const drafts = c.calls.draft.length;

        const imported = await c.runImport();
        expect(imported.problems).toEqual([]);
        expect(imported.report).toContainEqual({ 对象: "复盘项", 名称: "—", 结果: "个人复盘已交齐，交给 Co-Agent 起草" });
        for (const subject of ["growth", "cap-agents"]) expect(await c.item(subject)).toMatchObject({ status: "drafting", self_review: null });
        expect(c.calls.draft).toHaveLength(drafts);

        await c.t.monthlyReviews!.runScheduled();
        await c.t.monthlyReviews!.idle();
        for (const subject of ["growth", "cap-agents"]) expect(await c.item(subject)).toMatchObject({ status: "confirmed", confirmation_source: "import" });
        expect(c.calls.draft).toHaveLength(drafts + 2);
        expect((await c.t.sql("SELECT status, summary->>'status' AS summary FROM monthly_reviews"))[0]).toEqual({ status: "summarizing", summary: "ready" });
      } finally { await c.t.monthlyReviews!.idle(); await c.t.close(); }
    });
  }, 60_000);
});
