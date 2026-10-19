import type { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import { WeeklyReviewDraftCandidate, type TWeeklyReviewBody, type TWeeklyReviewField, type TWeeklyReviewGenerationStep } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { citationProblem, mergeGeneratedReview, withSources } from "./personalReviewGeneration.js";
import type { WeeklyReviewAgent } from "./weeklyReviewAgent.js";
import { allowedWeeklyCitations, buildWeeklyReviewDraftInput, templateProblem } from "./weeklyReviewGeneration.js";
import {
  appendRevision, ensureWeeklyReviewDrafts, getWeeklyReviewRow, pendingWeeklySteps, recoverStaleWeeklyDrafts, requestWeeklyReviewDraft,
  WEEKLY_REVIEW_FIELDS, weekStartOf, type WeeklyReviewRow,
} from "./weeklyReviews.js";

/**
 * 周复盘生成服务（D-01）。
 *
 * 定时：每周五 15:00（上海时间）起，给每个在成员工作台里的人生成本周周复盘草稿；周五晚上、周末进程才起来的照样补上（同一周只建一次）。
 * 与其他后台任务一样是进程内 setInterval（createWeeklyReviewScheduler，每分钟一次）。
 *
 * 生成：读 Mission 卡 → 读 Mission 与 Task 进展 → 读会议结论 → 读采集记录 → 读上周复盘 → 起草，每步写进 generation_steps（页面轮询可见），
 * 同时回调 onStep。起草结果逐行核对出处（与个人复盘同一套 citationProblem）和模板格式（templateProblem），不合格重试，三次都不合格记失败；写回时保留本人改过的段落。
 *
 * 对话入口（由对话工作流接，不在这里改 piConversationRuntime / routes/conversations）：
 *   const { weeklyReviewId, done } = await ctx.weeklyReviewService.generateFor(personId, { onStep });
 *   // onStep(steps) 每一步变化时收到全部步骤；await done 后用 getWeeklyReviewRow 读结果，href 用 weeklyReviewHref(id, isCeo)。
 *   // 本周已提交时返回 { status: "submitted", done: Promise.resolve() }，不重新生成。
 */

export type WeeklyReviewStepListener = (steps: TWeeklyReviewGenerationStep[]) => void;
const INVALID = "invalid_weekly_review_candidate";
const FAILED = "weekly_review_generation_failed";
const OFFSET = 8 * 3_600_000;

/** 上海时间是不是已经到了本周五 15:00 之后（含周六、周日）。 */
export function weeklyGenerationDue(now: Date): boolean {
  const local = new Date(now.getTime() + OFFSET);
  const day = local.getUTCDay();
  return day === 6 || day === 0 || (day === 5 && local.getUTCHours() >= 15);
}

export function createWeeklyReviewService({ pool, agent, people, now = () => new Date(), retryDelayMs = 1500 }: {
  pool: Pool;
  agent: WeeklyReviewAgent;
  /** 要生成周复盘的人（成员工作台里的人）。 */
  people: () => string[];
  now?: () => Date;
  retryDelayMs?: number;
}) {
  const q: Query = pool.query.bind(pool);
  const running = new Map<string, Promise<void>>();
  const inflight = new Set<Promise<void>>();
  const listeners = new Map<string, Set<WeeklyReviewStepListener>>();

  function runOnce(id: string, version: number, onStep?: WeeklyReviewStepListener): Promise<void> {
    const key = `${id}:${version}`;
    if (onStep) listeners.set(key, new Set([...(listeners.get(key) ?? []), onStep]));
    const existing = running.get(key);
    if (existing) return existing;
    const promise = run(id, version, key).finally(() => { running.delete(key); listeners.delete(key); inflight.delete(promise); });
    running.set(key, promise);
    inflight.add(promise);
    return promise;
  }

  async function run(id: string, version: number, key: string): Promise<void> {
    const row = await getWeeklyReviewRow(q, id);
    if (!row || row.status !== "drafting" || row.version !== version) return;
    let steps = pendingWeeklySteps();
    const notify = () => { for (const listener of listeners.get(key) ?? []) { try { listener(steps.map((step) => ({ ...step }))); } catch { /* 显示失败不影响生成 */ } } };
    const publish = async () => {
      notify();
      await q("UPDATE weekly_reviews SET generation_steps=$3::jsonb WHERE id=$1 AND version=$2 AND status='drafting'", [id, version, JSON.stringify(steps)]);
    };
    const step = async (stepId: TWeeklyReviewGenerationStep["id"], status: TWeeklyReviewGenerationStep["status"], result?: string) => {
      steps = steps.map((item) => item.id === stepId ? { ...item, status, ...(result === undefined ? {} : { result }) } : item);
      await publish();
    };
    const current = async () => { const latest = await getWeeklyReviewRow(q, id); return latest?.status === "drafting" && latest.version === version; };
    try {
      await publish();
      const input = await buildWeeklyReviewDraftInput(q, row, step);
      const allowed = allowedWeeklyCitations(input);
      await step("draft", "running");
      let candidate: TWeeklyReviewBody | null = null;
      for (let attempt = 0; attempt < 3 && !candidate; attempt += 1) {
        if (!await current()) return;
        try {
          const generated = (await agent.generate(input)).candidate;
          if (!Value.Check(WeeklyReviewDraftCandidate, generated)) throw Object.assign(new Error("周复盘起草结果不符合严格 schema"), { code: INVALID });
          const problem = citationProblem(generated, allowed, input.missingRecords, WEEKLY_REVIEW_FIELDS) ?? templateProblem(generated);
          if (problem) throw Object.assign(new Error(problem), { code: INVALID });
          candidate = generated;
        } catch (error) {
          if (attempt === 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
      if (!candidate || !await current()) return;
      const { selfReview: body, kept } = mergeGeneratedReview<TWeeklyReviewField>(row.body, withSources(candidate, WEEKLY_REVIEW_FIELDS), row.edited_fields, WEEKLY_REVIEW_FIELDS);
      steps = steps.map((item) => item.id === "draft" ? { ...item, status: "done", ...(kept.length ? { result: `保留你改过的 ${kept.length} 段` } : {}) } : item);
      const changed = WEEKLY_REVIEW_FIELDS.filter((field) => !kept.includes(field));
      const previous = Object.fromEntries(changed.filter((field) => row.body?.[field].text).map((field) => [field, row.body![field].text]));
      const revisions = appendRevision(row.revisions, { at: now().toISOString(), kind: "generate", by: null, source: "co_agent", fields: changed, previous });
      const written = await q(`UPDATE weekly_reviews SET status='draft', body=$3::jsonb, draft_source='co_agent', draft_error=NULL, generation_steps=$4::jsonb,
        revisions=$5::jsonb, version=version+1, updated_at=$6 WHERE id=$1 AND version=$2 AND status='drafting'`,
      [id, version, JSON.stringify(body), JSON.stringify(steps), JSON.stringify(revisions), now()]);
      if (written.rowCount) notify();
    } catch (cause) {
      steps = steps.map((item) => item.status === "running" ? { ...item, status: "failed" } : item);
      const error = cause as Error & { code?: string };
      const failed = await q(`UPDATE weekly_reviews SET status='draft_failed', draft_error=$3::jsonb, generation_steps=$4::jsonb, version=version+1, updated_at=$5
        WHERE id=$1 AND version=$2 AND status='drafting'`,
      [id, version, JSON.stringify({ code: error.code === INVALID ? INVALID : FAILED, message: error.message || "周复盘生成失败", at: now().toISOString() }), JSON.stringify(steps), now()]);
      if (failed.rowCount) notify();
    }
  }

  const failed = (error: unknown) => console.error("weekly review draft failed", error);

  return {
    /** 启动（或接上进行中的）某一版的生成。 */
    start(id: string, version: number, onStep?: WeeklyReviewStepListener): Promise<void> { return runOnce(id, version, onStep); },

    /** 对话里「生成我的周复盘」：本周（或指定周一）没有就建；草稿、失败的重新生成并保留本人改过的段；已提交的不动。 */
    async generateFor(personId: string, options: { weekStart?: string; onStep?: WeeklyReviewStepListener } = {}) {
      const weekStart = options.weekStart ?? weekStartOf(now());
      const requested = await requestWeeklyReviewDraft(pool, personId, weekStart, now());
      const done = requested.status === "drafting" ? runOnce(requested.id, requested.version, options.onStep) : Promise.resolve();
      return { weeklyReviewId: requested.id, status: requested.status, done };
    },

    /** 定时：先把卡住的生成标为失败；到了周五 15:00 给还没有本周周复盘的人建草稿并生成；再接手本进程没在跑的生成。 */
    async runScheduled(at?: Date): Promise<{ weekStart: string; created: number }> {
      const current = at ?? now();
      await recoverStaleWeeklyDrafts(q, current);
      const weekStart = weekStartOf(current);
      const created = weeklyGenerationDue(current) ? await ensureWeeklyReviewDrafts(q, people(), weekStart, current) : [];
      const drafting = await q("SELECT id, version FROM weekly_reviews WHERE status='drafting'");
      for (const row of drafting.rows as Pick<WeeklyReviewRow, "id" | "version">[]) void runOnce(row.id, row.version).catch(failed);
      return { weekStart, created: created.length };
    },

    async idle(): Promise<void> { while (inflight.size) await Promise.allSettled([...inflight]); },
  };
}
export type WeeklyReviewService = ReturnType<typeof createWeeklyReviewService>;

/** tick 失败只记录，不抛出（定时器里的未处理拒绝会终止 API 进程）。 */
export function createWeeklyReviewScheduler(service: Pick<WeeklyReviewService, "runScheduled">, intervalMs = 60_000) {
  let timer: NodeJS.Timeout | undefined;
  const tick = () => Promise.resolve(service.runScheduled()).then(() => undefined,
    (cause: unknown) => void console.warn(`weekly review scheduled run failed: ${(cause as Error).message || String(cause)}`));
  return {
    tick,
    start() { if (timer) return; void tick(); timer = setInterval(() => { void tick(); }, intervalMs); timer.unref(); },
    close() { if (timer) clearInterval(timer); timer = undefined; },
  };
}
