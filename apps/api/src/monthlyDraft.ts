import { randomUUID } from "node:crypto";
import type { Pool, QueryResult } from "pg";
import { Value } from "@sinclair/typebox/value";
import { MonthlyDraftCandidate, type TMonthlyDraftCandidate, type TMonthlyPlanFeedback, type TMonthlyPlanTodo } from "@warmap/contracts";
import type { CompanyMemoryRepository } from "./companyMemory.js";
import { companyPeriod, getMonthlyPlanRow, projectMonthlyFeedback, type MonthlyPlanRow, type StoredMonthlyFeedback } from "./monthlyPlans.js";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

const MONTHLY_DRAFT_FAILED = "monthly_draft_failed";
const INVALID_MONTHLY_DRAFT = "invalid_monthly_candidate";
const MONTHLY_DRAFT_INTERRUPTED = "monthly_draft_interrupted";

/** Draft Agent 只读输入：已确认方向、上月复盘、DRI 反馈与相关 CompanyMemory 段落。 */
export type MonthlyDraftAgentInput = {
  period: string;
  confirmedDirections: { issueId: string; title: string; decisionText: string; optionId: string | null }[];
  previousPlan: {
    period: string;
    companyOutcome: string;
    battlefields: unknown;
    todos: unknown;
    feedback: TMonthlyPlanFeedback[];
  } | null;
  driFeedback: TMonthlyPlanFeedback[];
  companyMemory: { sectionId: string; title: string; sourceRef: string; passages: { id: string; text: string; sourceRef: string }[] }[];
};

export type MonthlyDraftAgent = {
  promptHash?: string;
  modelSlot?: "light" | "heavy";
  generate(input: MonthlyDraftAgentInput, signal?: AbortSignal): Promise<{ candidate: unknown; runId?: string }>;
};

export type MonthlyPlanService = {
  /** 为当前 period 最多创建一个 draft；重复触发与启动补跑都只返回一次 created。 */
  runScheduled(at?: Date): Promise<{ period: string; status: "created" | "skipped"; planId?: string }>;
  /** 执行已由 Action 置为 running 的 run（显式重试用）。 */
  executeRun(planId: string, runId: string): Promise<void>;
  /** 启动恢复：崩溃留下的未完成草案标为可见 failed，等待 CEO 显式重试。 */
  recoverInterrupted(): Promise<number>;
  /** 等待所有在途 run settle，供进程关闭使用。 */
  idle(): Promise<void>;
};

function emptyNegotiation() {
  return { edits: [], checkedItemIds: [], feedback: [], note: "" };
}

function emptyGeneration(pendingSince: string) {
  return { status: "pending", pendingSince, runId: null, previousRunIds: [], error: null, generatedAt: null };
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * MonthlyPlan 生命周期：period 唯一 draft → running → ready 或 failed。
 * Agent 输出必须通过严格 candidate 与 owner 校验；失败只写 error，不自动重试、不生成空计划。
 */
export function createMonthlyPlanService({
  pool,
  agent,
  companyMemory,
  now = () => new Date(),
}: {
  pool: Pool;
  agent: MonthlyDraftAgent;
  companyMemory: CompanyMemoryRepository;
  now?: () => Date;
}): MonthlyPlanService {
  const q = pool.query.bind(pool);
  const inflight = new Set<Promise<void>>();

  function track(promise: Promise<void>): Promise<void> {
    inflight.add(promise);
    const settle = () => inflight.delete(promise);
    promise.then(settle, settle);
    return promise;
  }

  async function buildInput(row: MonthlyPlanRow): Promise<MonthlyDraftAgentInput> {
    const decided = await q(
      `SELECT id, title, receipts FROM issues
        WHERE status = 'decided'
        ORDER BY updated_at DESC LIMIT 20`,
    );
    const confirmedDirections = (
      decided.rows as { id: string; title: string; receipts: { decisionText: string; optionId?: string; revokedAt?: string }[] }[]
    ).flatMap((issue) =>
      issue.receipts
        .filter((receipt) => !receipt.revokedAt)
        .map((receipt) => ({ issueId: issue.id, title: issue.title, decisionText: receipt.decisionText, optionId: receipt.optionId ?? null })),
    );

    const previousResult = await q(
      `SELECT period, company_outcome, battlefields, todos, negotiation FROM monthly_plans
        WHERE period < $1 ORDER BY period DESC LIMIT 1`,
      [row.period],
    );
    const previous = previousResult.rows[0] as
      | { period: string; company_outcome: string; battlefields: unknown; todos: unknown; negotiation: { feedback: StoredMonthlyFeedback[] } }
      | undefined;
    const previousPlan = previous
      ? {
          period: previous.period,
          companyOutcome: previous.company_outcome,
          battlefields: previous.battlefields,
          todos: previous.todos,
          feedback: previous.negotiation.feedback.map(projectMonthlyFeedback),
        }
      : null;

    // 按已确认方向标题检索相关 CompanyMemory 段落，只读注入，不开放业务库遍历
    const memory: MonthlyDraftAgentInput["companyMemory"] = [];
    for (const direction of confirmedDirections.slice(0, 5)) {
      for (const match of companyMemory.searchSections(direction.title, 2)) {
        if (memory.some((section) => section.sectionId === match.id)) continue;
        const passages = companyMemory.getPassages(match.id, undefined, 2);
        memory.push({
          sectionId: match.id,
          title: match.title,
          sourceRef: match.sourceRef,
          passages: passages.passages.map((passage) => ({ id: passage.id, text: passage.text, sourceRef: passage.sourceRef })),
        });
      }
    }

    return {
      period: row.period,
      confirmedDirections,
      previousPlan,
      driFeedback: [
        ...(previousPlan?.feedback ?? []),
        ...row.negotiation.feedback.map(projectMonthlyFeedback),
      ],
      companyMemory: memory.slice(0, 6),
    };
  }

  async function execute(planId: string, runId: string): Promise<void> {
    const row = await getMonthlyPlanRow(q, planId);
    if (!row || row.status === "confirmed" || row.generation.status !== "running" || row.generation.runId !== runId) return;
    try {
      const input = await buildInput(row);
      const generated = await agent.generate(input, new AbortController().signal);
      if (!Value.Check(MonthlyDraftCandidate, generated.candidate)) {
        throw Object.assign(new Error("MonthlyDraft candidate 不符合严格 schema"), { code: INVALID_MONTHLY_DRAFT });
      }
      const candidate = generated.candidate as TMonthlyDraftCandidate;
      const people = new Set(companyMemory.searchPeople(undefined).map((person) => person.personId));
      const badOwner = candidate.todos.find((todo) => !people.has(todo.ownerId));
      if (badOwner) {
        throw Object.assign(new Error(`todo ownerId 不在 company-people.v1: ${badOwner.ownerId}`), { code: INVALID_MONTHLY_DRAFT });
      }
      const todos: TMonthlyPlanTodo[] = candidate.todos.map((todo) => ({ id: `todo-${randomUUID()}`, ...todo }));
      await q(
        `UPDATE monthly_plans
            SET company_outcome = $2,
                battlefields = $3::jsonb,
                todos = $4::jsonb,
                generation = generation || jsonb_build_object('status', 'ready', 'error', NULL, 'generatedAt', $5::text),
                version = version + 1,
                updated_at = now()
          WHERE id = $1 AND status <> 'confirmed'
            AND generation->>'status' = 'running' AND generation->>'runId' = $6`,
        [
          planId,
          candidate.companyOutcome,
          JSON.stringify(uniqueBy(candidate.battlefields, (battlefield) => battlefield.battlefieldId)),
          JSON.stringify(todos),
          now().toISOString(),
          runId,
        ],
      );
    } catch (cause) {
      const error = cause as Error & { code?: string };
      await q(
        `UPDATE monthly_plans
            SET generation = generation || jsonb_build_object(
                  'status', 'failed',
                  'error', jsonb_build_object('code', $3::text, 'message', $4::text, 'at', $5::text)
                ),
                version = version + 1,
                updated_at = now()
          WHERE id = $1 AND generation->>'status' = 'running' AND generation->>'runId' = $2`,
        [
          planId,
          runId,
          error.code === INVALID_MONTHLY_DRAFT ? INVALID_MONTHLY_DRAFT : MONTHLY_DRAFT_FAILED,
          error.message || "月度草案生成失败",
          now().toISOString(),
        ],
      ).catch(() => undefined);
    }
  }

  /** 只有确实从非 running 状态转过来才执行；已有 run 在跑时不产生第二个 run。 */
  async function start(planId: string): Promise<void> {
    const runId = randomUUID();
    const startedAt = now().toISOString();
    const transition = await q(
      `UPDATE monthly_plans
          SET generation = jsonb_build_object(
                'status', 'running',
                'pendingSince', $2::text,
                'runId', $3::text,
                'previousRunIds', COALESCE(generation->'previousRunIds', '[]'::jsonb),
                'error', NULL,
                'generatedAt', NULL
              ),
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND status <> 'confirmed' AND generation->>'status' <> 'running'`,
      [planId, startedAt, runId],
    );
    if (transition.rowCount !== 1) return;
    await execute(planId, runId);
  }

  return {
    async runScheduled(at?: Date) {
      const period = companyPeriod(at ?? now());
      const planId = randomUUID();
      const client = await pool.connect();
      let created = false;
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["monthly-plan:create"]);
        const inserted = await client.query(
          `INSERT INTO monthly_plans
             (id, version, period, status, company_outcome, battlefields, todos, negotiation, generation)
           VALUES ($1, 1, $2, 'draft', '', '[]'::jsonb, '[]'::jsonb, $3::jsonb, $4::jsonb)
           ON CONFLICT (period) DO NOTHING
           RETURNING id`,
          [planId, period, JSON.stringify(emptyNegotiation()), JSON.stringify(emptyGeneration(now().toISOString()))],
        );
        created = inserted.rowCount === 1;
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      if (created) {
        // 调度触发的启动失败不能静默：没有 plan 级错误状态时至少留下日志
        void track(start(planId)).catch((err) => console.error("monthly draft start failed", err));
      }
      return { period, status: created ? ("created" as const) : ("skipped" as const), ...(created ? { planId } : {}) };
    },
    executeRun(planId: string, runId: string): Promise<void> {
      return track(execute(planId, runId));
    },
    async recoverInterrupted(): Promise<number> {
      const at = now();
      // 单进程 runner：启动时任何未完成的 generation 都是中断，不自动重跑
      const result = await q(
        `UPDATE monthly_plans
            SET generation = jsonb_set(
                  jsonb_set(generation, '{status}', '"failed"'),
                  '{error}',
                  jsonb_build_object('code', $1::text, 'message', '草案生成在进程重启前未完成，请显式重试', 'at', $2::text)
                ),
                version = version + 1,
                updated_at = now()
          WHERE status <> 'confirmed'
            AND generation->>'status' IN ('pending', 'running')`,
        [MONTHLY_DRAFT_INTERRUPTED, at.toISOString()],
      );
      return result.rowCount ?? 0;
    },
    async idle(): Promise<void> {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}
