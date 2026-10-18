import type { Pool, QueryResult } from "pg";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  MonthlyReviewAssessment,
  MonthlyReviewDraftCandidate,
  MonthlyReviewSummaryCandidate,
  type TMonthlyPlanFeedback,
  type TMonthlyPlanTodo,
  type TMonthlyReviewSelfReview,
  type TMonthlyReviewSubjectType,
  type TMonthlyReviewSummaryCandidate,
} from "@warmap/contracts";
import type { CompanyMemoryRepository } from "./companyMemory.js";
import { ltoWindow } from "./monthlyCycle.js";
import { ensurePersonalReviews, getPersonalReview, pendingGenerationSteps, recoverStalePersonalReviewDrafts,
  PERSONAL_REVIEW_FIELDS, type PersonalReviewDraftInput, type PersonalReviewDraftRun } from "./personalReviews.js";
import { allowedCitations, buildPersonalReviewDraftInput, citationProblem, mergeGeneratedReview, withSources,
  type PersonalReviewStepListener } from "./personalReviewGeneration.js";
import { listConfirmedDirections, type MonthlyDraftAgentInput } from "./monthlyDraft.js";
import { companyPeriod, projectMonthlyFeedback, type StoredMonthlyFeedback } from "./monthlyPlans.js";
import {
  confirmImportedDraft,
  createMonthlyReview,
  getMonthlyReviewItem,
  getMonthlyReviewRow,
  leadOf,
  listMonthlyReviewItems,
  readLtco,
  type MonthlyReviewItemRecord,
} from "./monthlyReviews.js";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

const INVALID_CANDIDATE = "invalid_monthly_review_candidate";
const GENERATION_FAILED = "monthly_review_generation_failed";
const INTERRUPTED = "monthly_review_interrupted";

type Subject = { type: TMonthlyReviewSubjectType; id: string; code: string; name: string; sixMonthOutcome: string };

/** 起草与评估共用的材料：被复盘月份计划里的相关待办与反馈、同期 Mission 复盘沉淀、按名称检索的企业知识。 */
export type MonthlyReviewMaterials = {
  planTodos: TMonthlyPlanTodo[];
  driFeedback: TMonthlyPlanFeedback[];
  missions: { missionId: string; code: string; title: string; outcome: string; retrospect: string }[];
  weeklyProgress: { date: string; missionTitle: string; taskTitle: string; author: string; body: string }[];
  personalReviews: { personId: string; status: string; selfReview: TMonthlyReviewSelfReview | null; note: string | null }[];
  comments: { author: string; body: string; createdAt: string }[];
  companyMemory: { sectionId: string; title: string; passageId: string; text: string; sourceRef: string }[];
};
export type MonthlyReviewDraftInput = { period: string; subject: Subject; target: string | null } & MonthlyReviewMaterials;
export type MonthlyReviewAssessInput = MonthlyReviewDraftInput & {
  selfReview: TMonthlyReviewSelfReview;
  /** 同期其他已提交项：只给名称与自评首句。 */
  peers: { subjectName: string; lead: string | null }[];
};
export type MonthlyReviewSummaryInput = {
  period: string;
  ltco: string;
  ltoWindow: { start: string; end: string };
  items: { subjectType: TMonthlyReviewSubjectType; subjectId: string; subjectName: string; target: string | null; selfReview: TMonthlyReviewSelfReview | null; comments: MonthlyReviewMaterials["comments"] }[];
  battlefields: { battlefieldId: string; name: string; sixMonthOutcome: string }[];
  capabilities: { capabilityId: string; name: string; sixMonthOutcome: string }[];
  confirmedDirections: MonthlyDraftAgentInput["confirmedDirections"];
};

export type MonthlyReviewAgent<I> = {
  promptHash?: string;
  modelSlot?: "light" | "heavy";
  generate(input: I, signal?: AbortSignal): Promise<{ candidate: unknown; runId?: string }>;
};

export type MonthlyReviewAgents = {
  draft: MonthlyReviewAgent<MonthlyReviewDraftInput>;
  assess: MonthlyReviewAgent<MonthlyReviewAssessInput>;
  summarize: MonthlyReviewAgent<MonthlyReviewSummaryInput>;
  personal?: MonthlyReviewAgent<PersonalReviewDraftInput>;
};

export type MonthlyReviewService = {
  /**
   * 公司日到了当月倒数第 3 天（Asia/Shanghai）才为当月创建复盘；重复触发只创建一次。
   * 每次还接手别的进程（导入复盘的 CLI）只写下状态、本进程还没在跑的起草。
   */
  runScheduled(at?: Date): Promise<{ period: string; status: "created" | "skipped" | "not_due"; reviewId?: string }>;
  /** 创建（或返回已有的）复盘，并为新建的项启动起草。 */
  open(period: string): Promise<{ created: boolean; reviewId: string }>;
  startDraft(itemId: string, runId: string): Promise<void>;
  startAssessment(itemId: string, runId: string): Promise<void>;
  startSummary(reviewId: string, runId: string): Promise<void>;
  /**
   * onStep：每一步状态变化时收到全部步骤（读 Mission 卡 → 读每周复盘 → 读采集记录 → 起草），同时写进个人复盘。
   * storageDir、agent 不给时用创建服务时配置的那一份。
   */
  startPersonalDraft(reviewId: string, version: number, storageDir?: string, agent?: MonthlyReviewAgent<PersonalReviewDraftInput>,
    onStep?: PersonalReviewStepListener): Promise<void>;
  /** 启动恢复：进程重启前没跑完的起草、评估、汇总标为可见 failed，等待手动重试。 */
  recoverInterrupted(): Promise<number>;
  idle(): Promise<void>;
};

/** 上海公司日：年、月、日与当月天数。 */
function companyDay(now: Date): { day: number; lastDay: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  return { day: Number(parts.day), lastDay: new Date(Date.UTC(year, month, 0)).getUTCDate() };
}

function failure(cause: unknown, fallback: string): { code: string; message: string } {
  const error = cause as Error & { code?: string };
  return { code: error.code === INVALID_CANDIDATE ? INVALID_CANDIDATE : GENERATION_FAILED, message: error.message || fallback };
}

function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: INVALID_CANDIDATE });
}

/**
 * 月末复盘生成服务：起草、偏差评估、公司复盘汇总三个 run。
 * 每个 run 按 runId 条件写回，旧 run 不能覆盖新结果；失败或不合法输出最多自动重试两次。
 */
export function createMonthlyReviewService({
  pool,
  agents,
  companyMemory,
  now = () => new Date(),
  retryDelayMs = 1500,
  personalDraft,
}: {
  pool: Pool;
  agents: MonthlyReviewAgents;
  companyMemory: CompanyMemoryRepository;
  now?: () => Date;
  retryDelayMs?: number;
  personalDraft: { storageDir: string; agent: MonthlyReviewAgent<PersonalReviewDraftInput> };
}): MonthlyReviewService {
  const q: Query = pool.query.bind(pool);
  const inflight = new Set<Promise<void>>();
  const running = new Map<string, Promise<void>>();

  function track(promise: Promise<void>): Promise<void> {
    inflight.add(promise);
    const settle = () => inflight.delete(promise);
    promise.then(settle, settle);
    return promise;
  }

  /** 同一个 run 在本进程只跑一份：动作后立即启动的和调度器接手的按 key 去重。 */
  function runOnce(key: string, run: () => Promise<void>): Promise<void> {
    const existing = running.get(key);
    if (existing) return existing;
    const promise = track(run());
    running.set(key, promise);
    const settle = () => running.delete(key);
    promise.then(settle, settle);
    return promise;
  }
  const startDraft = (itemId: string, runId: string) => runOnce(`draft:${itemId}:${runId}`, () => runDraft(itemId, runId));
  const startSummary = (reviewId: string, runId: string) => track(runSummary(reviewId, runId));
  const startPersonalDraft = (reviewId: string, version: number, storageDir = personalDraft.storageDir, agent = personalDraft.agent,
    onStep?: PersonalReviewStepListener) =>
    runOnce(`personal:${reviewId}:${version}`, () => runPersonalDraft(reviewId, version, storageDir, agent, onStep));

  async function comments(itemId: string): Promise<MonthlyReviewMaterials["comments"]> {
    return (await q(`SELECT author_id AS author, body, created_at AS "createdAt" FROM monthly_review_comments
      WHERE item_id = $1 ORDER BY created_at, id`, [itemId])).rows.map((row) => ({
      author: row.author as string, body: row.body as string, createdAt: (row.createdAt as Date).toISOString(),
    }));
  }

  async function generateWithRetry<I>(agent: MonthlyReviewAgent<I>, input: I, schema: TSchema,
    isCurrent: () => Promise<boolean>, label: string, validate?: (candidate: unknown) => void): Promise<unknown | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!await isCurrent()) return null;
      try {
        const generated = await agent.generate(input, new AbortController().signal);
        if (!Value.Check(schema, generated.candidate)) throw invalid(`${label}结果不符合严格 schema`);
        validate?.(generated.candidate);
        return generated.candidate;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
    return null;
  }

  async function materials(item: MonthlyReviewItemRecord): Promise<MonthlyReviewDraftInput> {
    const battlefield = item.subject_type === "battlefield";
    const plan = (await q("SELECT todos, negotiation FROM monthly_plans WHERE period = $1", [item.period])).rows[0] as
      | { todos: TMonthlyPlanTodo[]; negotiation: { feedback: StoredMonthlyFeedback[] } }
      | undefined;
    // 能力域在计划待办和反馈里没有归属字段，只给战场过滤
    const planTodos = battlefield ? (plan?.todos ?? []).filter((todo) => todo.battlefieldId === item.subject_id) : [];
    const todoIds = new Set(planTodos.map((todo) => todo.id));
    const driFeedback = battlefield
      ? (plan?.negotiation.feedback ?? [])
        .filter((feedback) => feedback.battlefieldId === item.subject_id || (feedback.todoId !== undefined && todoIds.has(feedback.todoId)))
        .map(projectMonthlyFeedback)
      : [];
    const missions = (await q(
      `SELECT id AS "missionId", code, title, outcome, retrospect FROM missions
        WHERE period = $1 AND ${battlefield ? "battlefield_ids @> jsonb_build_array($2::text)" : "capability_id = $2"}
        ORDER BY code, id`,
      [item.period, item.subject_id],
    )).rows as MonthlyReviewMaterials["missions"];
    const [year, month] = item.period.split("-").map(Number);
    const start = new Date(Date.UTC(year, month - 1, 1, -8)).toISOString();
    const end = new Date(Date.UTC(year, month, 8, -8)).toISOString();
    const weeklyProgress = (await q(`SELECT to_char(p.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS date,
      m.title AS "missionTitle", t.title AS "taskTitle", p.author_id AS author, p.body
      FROM task_progress p JOIN tasks t ON t.id = p.task_id JOIN missions m ON m.id = t.mission_id
      WHERE p.created_at >= $1 AND p.created_at < $2 AND m.period = $3 AND
        ${battlefield ? "m.battlefield_ids @> jsonb_build_array($4::text)" : "m.capability_id = $4"}
      ORDER BY p.created_at DESC, p.id DESC LIMIT 60`, [start, end, item.period, item.subject_id])).rows as MonthlyReviewMaterials["weeklyProgress"];
    const memory: MonthlyReviewMaterials["companyMemory"] = [];
    for (const section of companyMemory.searchSections(item.subject_name, 4)) {
      for (const passage of companyMemory.getPassages(section.id, item.subject_name, 4).passages) {
        if (memory.length < 4) memory.push({ sectionId: section.id, title: section.title, passageId: passage.id, text: passage.text, sourceRef: passage.sourceRef });
      }
    }
    return {
      period: item.period,
      subject: { type: item.subject_type, id: item.subject_id, code: item.subject_code, name: item.subject_name, sixMonthOutcome: item.six_month_outcome },
      target: item.target,
      planTodos,
      driFeedback,
      missions,
      weeklyProgress,
      personalReviews: (await q(`SELECT p.person_id AS "personId",p.status,p.self_review AS "selfReview",
        CASE WHEN p.status='skipped' THEN '未提交' ELSE NULL END AS note FROM personal_reviews p
        WHERE p.monthly_review_id=$1 AND p.status IN ('submitted','skipped') AND EXISTS (
          SELECT 1 FROM missions m WHERE m.owner_id=p.person_id AND m.period=p.period AND
          ${battlefield ? "m.battlefield_ids @> jsonb_build_array($2::text)" : "m.capability_id=$2"}) ORDER BY p.person_id`,
      [item.review_id, item.subject_id])).rows.map((row) => ({ ...row, selfReview: row.status === "submitted" ? row.selfReview : null })) as MonthlyReviewMaterials["personalReviews"],
      comments: await comments(item.id),
      companyMemory: memory,
    };
  }

  async function runDraft(itemId: string, runId: string): Promise<void> {
    const item = await getMonthlyReviewItem(q, itemId);
    if (!item || !["drafting", "draft", "returned"].includes(item.status) || item.draft_run.runId !== runId) return;
    const suggest = item.draft_run.suggestions === true;
    if (item.status !== "drafting" && !suggest) return;
    try {
      const candidate = await generateWithRetry(agents.draft, await materials(item), MonthlyReviewDraftCandidate,
        async () => { const current = await getMonthlyReviewItem(q, itemId); return !!current && (suggest ? ["draft", "returned"].includes(current.status) : current.status === "drafting") && current.draft_run.runId === runId; }, "复盘起草");
      if (candidate === null) return;
      if (suggest) {
        const selfReview = candidate as TMonthlyReviewSelfReview;
        const suggestions = PERSONAL_REVIEW_FIELDS.map((field) => ({ field, text: selfReview[field].text,
          rationale: "个人复盘已交齐，根据新增材料建议改写", createdAt: now().toISOString() }));
        await q(`UPDATE monthly_review_items SET suggestions=$3::jsonb,draft_run=jsonb_build_object('runId',NULL,'error',NULL),
          version=version+1,updated_at=$4 WHERE id=$1 AND status IN ('draft','returned') AND draft_run->>'runId'=$2`,
        [itemId, runId, JSON.stringify(suggestions), now()]);
        return;
      }
      if ((await q("SELECT origin FROM monthly_reviews WHERE id = $1", [item.review_id])).rows[0]?.origin === "import") {
        const effects = await confirmImportedDraft(pool, item.review_id, itemId, runId, candidate as TMonthlyReviewSelfReview, now());
        for (const effect of effects) if (effect.type === "summary") void startSummary(effect.reviewId, effect.runId).catch((err) => console.error("monthly review summary failed", err));
        return;
      }
      await q(
        `UPDATE monthly_review_items
            SET status = 'draft', self_review = $2::jsonb, draft_run = jsonb_build_object('runId', $3::text, 'error', NULL),
                version = version + 1, updated_at = $4
          WHERE id = $1 AND status = 'drafting' AND draft_run->>'runId' = $3`,
        [itemId, JSON.stringify(candidate), runId, now().toISOString()],
      );
    } catch (cause) {
      const error = failure(cause, "复盘起草失败");
      const at = now().toISOString();
      if (suggest) {
        await q(`UPDATE monthly_review_items SET draft_run=draft_run || jsonb_build_object('error',$3::jsonb),
          version=version+1,updated_at=$4 WHERE id=$1 AND status IN ('draft','returned') AND draft_run->>'runId'=$2`,
        [itemId, runId, JSON.stringify({ ...error, at }), at]).catch(() => undefined);
        return;
      }
      await q(
        `UPDATE monthly_review_items
            SET status = 'draft_failed',
                draft_run = jsonb_build_object('runId', $2::text, 'error', jsonb_build_object('code', $3::text, 'message', $4::text, 'at', $5::text)),
                version = version + 1, updated_at = $5::timestamptz
          WHERE id = $1 AND status = 'drafting' AND draft_run->>'runId' = $2`,
        [itemId, runId, error.code, error.message, at],
      ).catch(() => undefined);
    }
  }

  async function runAssessment(itemId: string, runId: string): Promise<void> {
    const item = await getMonthlyReviewItem(q, itemId);
    if (!item || item.assessment.status !== "running" || item.assessment.runId !== runId || !item.self_review) return;
    try {
      const peers = (await listMonthlyReviewItems(q, item.review_id))
        .filter((peer) => peer.id !== item.id && (peer.status === "submitted" || peer.status === "confirmed"))
        .map((peer) => ({ subjectName: peer.subject_name, lead: leadOf(peer.self_review) }));
      const input: MonthlyReviewAssessInput = { ...(await materials(item)), selfReview: item.self_review, peers };
      const candidate = await generateWithRetry(agents.assess, input, MonthlyReviewAssessment,
        async () => { const current = await getMonthlyReviewItem(q, itemId); return current?.assessment.status === "running" && current.assessment.runId === runId; }, "偏差评估");
      if (candidate === null) return;
      await q(
        `UPDATE monthly_review_items
            SET assessment = jsonb_build_object('status', 'ready', 'runId', $2::text, 'result', $3::jsonb, 'error', NULL),
                version = version + 1, updated_at = $4
          WHERE id = $1 AND assessment->>'status' = 'running' AND assessment->>'runId' = $2`,
        [itemId, runId, JSON.stringify(candidate), now().toISOString()],
      );
    } catch (cause) {
      const error = failure(cause, "偏差评估失败");
      await q(
        `UPDATE monthly_review_items
            SET assessment = jsonb_build_object('status', 'failed', 'runId', $2::text, 'result', NULL,
                  'error', jsonb_build_object('code', $3::text, 'message', $4::text, 'at', $5::text)),
                version = version + 1, updated_at = $5::timestamptz
          WHERE id = $1 AND assessment->>'status' = 'running' AND assessment->>'runId' = $2`,
        [itemId, runId, error.code, error.message, now().toISOString()],
      ).catch(() => undefined);
    }
  }

  async function runSummary(reviewId: string, runId: string): Promise<void> {
    const review = await getMonthlyReviewRow(q, reviewId);
    if (!review || review.status !== "summarizing" || review.summary.status !== "running" || review.summary.runId !== runId) return;
    try {
      const items = (await listMonthlyReviewItems(q, reviewId)).filter((item) => item.status === "confirmed");
      const input: MonthlyReviewSummaryInput = {
        period: review.period,
        ltco: await readLtco(q),
        ltoWindow: ltoWindow(review.period),
        items: await Promise.all(items.map(async (item) => ({
          subjectType: item.subject_type, subjectId: item.subject_id, subjectName: item.subject_name, target: item.target, selfReview: item.self_review,
          comments: await comments(item.id),
        }))),
        battlefields: (await q(`SELECT id AS "battlefieldId", name, six_month_outcome AS "sixMonthOutcome" FROM battlefield_config ORDER BY sort_order, code, id`))
          .rows as MonthlyReviewSummaryInput["battlefields"],
        capabilities: (await q(`SELECT id AS "capabilityId", name, six_month_outcome AS "sixMonthOutcome" FROM capability_config ORDER BY sort_order, code, id`))
          .rows as MonthlyReviewSummaryInput["capabilities"],
        confirmedDirections: await listConfirmedDirections(q),
      };
      const subjects = new Set(input.battlefields.map((unit) => `battlefield:${unit.battlefieldId}`));
      const generated = await generateWithRetry(agents.summarize, input, MonthlyReviewSummaryCandidate,
        async () => { const current = await getMonthlyReviewRow(q, reviewId); return current?.summary.status === "running" && current.summary.runId === runId; }, "公司复盘汇总",
        (output) => {
          const candidate = output as TMonthlyReviewSummaryCandidate;
          if (candidate.ltcoSuggestion.units.some((unit) => !subjects.has(`${unit.subjectType}:${unit.subjectId}`))) throw invalid("公司复盘汇总引用了不存在的单元");
        });
      if (generated === null) return;
      const candidate = generated as TMonthlyReviewSummaryCandidate;
      await q(
        `UPDATE monthly_reviews
            SET summary = summary || jsonb_build_object('status', 'ready', 'error', NULL, 'overall', $3::text, 'judgments', $4::jsonb, 'nextFocus', $5::jsonb),
                ltco_suggestion = $6::jsonb, version = version + 1, updated_at = $7
          WHERE id = $1 AND status = 'summarizing' AND summary->>'status' = 'running' AND summary->>'runId' = $2`,
        [reviewId, runId, candidate.overall, JSON.stringify(candidate.judgments), JSON.stringify(candidate.nextFocus), JSON.stringify(candidate.ltcoSuggestion), now().toISOString()],
      );
    } catch (cause) {
      const error = failure(cause, "公司复盘汇总失败");
      await q(
        `UPDATE monthly_reviews
            SET summary = summary || jsonb_build_object('status', 'failed',
                  'error', jsonb_build_object('code', $3::text, 'message', $4::text, 'at', $5::text)),
                version = version + 1, updated_at = $5::timestamptz
          WHERE id = $1 AND status = 'summarizing' AND summary->>'status' = 'running' AND summary->>'runId' = $2`,
        [reviewId, runId, error.code, error.message, now().toISOString()],
      ).catch(() => undefined);
    }
  }

  async function open(period: string): Promise<{ created: boolean; reviewId: string }> {
    const creation = await createMonthlyReview(pool, period, now(), companyMemory.searchPeople(undefined));
    startPersonalRuns(creation.personalRuns);
    // 每项独立起草，失败互不影响
    for (const run of creation.itemRuns) {
      void startDraft(run.itemId, run.runId).catch((err) => console.error("monthly review draft failed", err));
    }
    return { created: creation.created, reviewId: creation.reviewId };
  }

  /** 导入 CLI 等别的进程只在事务里写下 drafting：收集中的这些起草由本进程启动，已在跑的按 key 跳过。 */
  async function resumeDrafts(): Promise<void> {
    const failed = (err: unknown) => console.error("monthly review draft failed", err);
    const items = await q(`SELECT i.id, i.draft_run->>'runId' AS "runId" FROM monthly_review_items i JOIN monthly_reviews r ON r.id = i.review_id
      WHERE r.status = 'collecting' AND i.status = 'drafting' AND i.draft_run->>'runId' IS NOT NULL`);
    for (const row of items.rows) void startDraft(row.id, row.runId).catch(failed);
    const personal = await q(`SELECT p.id, p.version FROM personal_reviews p JOIN monthly_reviews r ON r.id = p.monthly_review_id
      WHERE r.status = 'collecting' AND p.status = 'drafting'`);
    for (const row of personal.rows) void startPersonalDraft(row.id, row.version).catch(failed);
  }

  /**
   * 个人复盘生成：读 Mission 卡 → 读每周复盘 → 读采集记录 → 起草，每步写进 generation_steps（不改版本，页面轮询即可看到）。
   * 起草结果逐行核对出处，不合格按失败重试；写回时保留本人改过的段落。
   */
  async function runPersonalDraft(reviewId: string, version: number, storageDir: string, agent: MonthlyReviewAgent<PersonalReviewDraftInput>,
    onStep?: PersonalReviewStepListener): Promise<void> {
    const row = await getPersonalReview(q, reviewId);
    if (!row || row.status !== "drafting" || row.version !== version) return;
    let steps = pendingGenerationSteps();
    const publish = async () => {
      onStep?.(steps.map((step) => ({ ...step })));
      await q("UPDATE personal_reviews SET generation_steps=$3::jsonb WHERE id=$1 AND version=$2 AND status='drafting'", [reviewId, version, JSON.stringify(steps)]);
    };
    const step = async (id: (typeof steps)[number]["id"], status: (typeof steps)[number]["status"], result?: string) => {
      steps = steps.map((item) => item.id === id ? { ...item, status, ...(result === undefined ? {} : { result }) } : item);
      await publish();
    };
    try {
      await publish();
      const input = await buildPersonalReviewDraftInput(q, row, storageDir, now(), step);
      const allowed = allowedCitations(input);
      await step("draft", "running");
      const candidate = await generateWithRetry(agents.personal ?? agent, input, MonthlyReviewDraftCandidate,
        async () => { const current = await getPersonalReview(q, reviewId); return current?.status === "drafting" && current.version === version; }, "个人复盘起草",
        (output) => { const problem = citationProblem(output as TMonthlyReviewSelfReview, allowed, input.missingRecords); if (problem) throw invalid(problem); });
      if (candidate === null) return;
      const { selfReview, kept } = mergeGeneratedReview(row.self_review, withSources(candidate as TMonthlyReviewSelfReview), row.edited_fields);
      steps = steps.map((item) => item.id === "draft" ? { ...item, status: "done", ...(kept.length ? { result: `保留你改过的 ${kept.length} 段` } : {}) } : item);
      const written = await q(`UPDATE personal_reviews SET status='draft',self_review=$3::jsonb,draft_source='co_agent',draft_error=NULL,generation_steps=$5::jsonb,
        version=version+1,updated_at=$4 WHERE id=$1 AND version=$2 AND status='drafting'`, [reviewId, version, JSON.stringify(selfReview), now(), JSON.stringify(steps)]);
      if (written.rowCount) onStep?.(steps.map((item) => ({ ...item })));
    } catch (cause) {
      steps = steps.map((item) => item.status === "running" ? { ...item, status: "failed" } : item);
      const failed = await q(`UPDATE personal_reviews SET status='draft_failed',draft_error=$3::jsonb,generation_steps=$5::jsonb,version=version+1,updated_at=$4
        WHERE id=$1 AND version=$2 AND status='drafting'`, [reviewId, version, JSON.stringify({ ...failure(cause, "个人复盘起草失败"), at: now().toISOString() }), now(), JSON.stringify(steps)]);
      if (failed.rowCount) onStep?.(steps.map((item) => ({ ...item })));
    }
  }

  function startPersonalRuns(runs: PersonalReviewDraftRun[]): void {
    for (const run of runs) void startPersonalDraft(run.personalReviewId, run.version)
      .catch((err) => console.error("personal review draft failed", err));
  }

  return {
    async runScheduled(at?: Date) {
      const current = at ?? now();
      await recoverStalePersonalReviewDrafts(q, current);
      const collecting = (await q("SELECT id FROM monthly_reviews WHERE status='collecting' ORDER BY period")).rows;
      for (const review of collecting) startPersonalRuns(await ensurePersonalReviews(pool, review.id, companyMemory.searchPeople(undefined), current));
      await resumeDrafts();
      const period = companyPeriod(current);
      const { day, lastDay } = companyDay(current);
      if (day < lastDay - 2) return { period, status: "not_due" as const };
      const opened = await open(period);
      return { period, status: opened.created ? ("created" as const) : ("skipped" as const), reviewId: opened.reviewId };
    },
    open,
    startDraft,
    startAssessment: (itemId, runId) => track(runAssessment(itemId, runId)),
    startSummary,
    startPersonalDraft,
    async recoverInterrupted(): Promise<number> {
      const params = [INTERRUPTED, "生成在进程重启前未完成，请重试", now().toISOString()];
      const error = "jsonb_build_object('code', $1::text, 'message', $2::text, 'at', $3::text)";
      const drafts = await q(
        `UPDATE monthly_review_items
            SET status = 'draft_failed', draft_run = jsonb_build_object('runId', draft_run->'runId', 'error', ${error}),
                version = version + 1, updated_at = $3::timestamptz
          WHERE status = 'drafting'`,
        params,
      );
      const assessments = await q(
        `UPDATE monthly_review_items
            SET assessment = assessment || jsonb_build_object('status', 'failed', 'error', ${error}),
                version = version + 1, updated_at = $3::timestamptz
          WHERE assessment->>'status' IN ('pending', 'running')`,
        params,
      );
      const summaries = await q(
        `UPDATE monthly_reviews
            SET summary = summary || jsonb_build_object('status', 'failed', 'error', ${error}),
                version = version + 1, updated_at = $3::timestamptz
          WHERE summary->>'status' IN ('pending', 'running')`,
        params,
      );
      return (drafts.rowCount ?? 0) + (assessments.rowCount ?? 0) + (summaries.rowCount ?? 0) + await recoverStalePersonalReviewDrafts(q, now());
    },
    async idle(): Promise<void> {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}
