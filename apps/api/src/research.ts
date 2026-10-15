import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import { ResearchDoc, type TResearchDoc } from "@warmap/contracts";
import { getIssueRow, TRIGGER_NOT_STARTED, type IssueRow } from "./issues.js";
import { findForbiddenPhrase } from "./promptStyle.js";

export type ResearchInput = {
  issue: {
    id: string;
    title: string;
    origin: IssueRow["origin"];
    originRef: unknown;
    location: unknown;
    urgency: unknown;
  };
};

export type ResearchRunner = (input: ResearchInput, signal: AbortSignal) => Promise<unknown>;

export type ResearchService = {
  /** 创建后触发唯一深度预研；不阻塞 Issue 展示。 */
  start(issueId: string): Promise<void>;
  /** 执行已由 Action 置为 running 的 run（显式重跑用）。 */
  executeRun(issueId: string, runId: string): Promise<void>;
  /** 等待所有在途 run settle，供进程关闭使用。 */
  idle(): Promise<void>;
};

export const RESEARCH_FAILED = "research_failed";
export const INVALID_RESEARCH_DOC = "invalid_research_doc";

/** 「还没有预研」的几种失败：导入时没带预研、创建后没触发、进程重启打断。模型真跑失败的不在其中。 */
export const RESUMABLE_RESEARCH_CODES = ["IMPORTED_WITHOUT_RESEARCH", TRIGGER_NOT_STARTED, "research_interrupted"] as const;

/**
 * 场次启动后补跑预研（演示环境，由 app 在 onReady 调用）：待决议题里还没有预研的（pending，或上面几种失败），
 * 按创建顺序、最多 concurrency 个同时在后台跑；已有预研的、模型真跑失败的不动。stopped() 为真后不再开新的。
 * 返回补跑的议题数；一条失败不影响其他条，失败照常显示为可重新预研。
 */
export async function resumeResearch(
  q: (sql: string, params?: unknown[]) => Promise<{ rows: { id: string }[] }>,
  service: Pick<ResearchService, "start">,
  { concurrency = 3, stopped = () => false }: { concurrency?: number; stopped?: () => boolean } = {},
): Promise<number> {
  const rows = (await q(
    `SELECT id FROM issues
      WHERE status = 'pending'
        AND (research->'doc' IS NULL OR jsonb_typeof(research->'doc') = 'null')
        AND (research->>'status' = 'pending'
             OR (research->>'status' = 'failed' AND research->'error'->>'code' = ANY($1::text[])))
      ORDER BY created_at, id`,
    [[...RESUMABLE_RESEARCH_CODES]],
  )).rows;
  let next = 0;
  const worker = async () => {
    while (next < rows.length && !stopped()) {
      const { id } = rows[next++];
      await service.start(id).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), rows.length) }, worker));
  return rows.length;
}

/** 只检查用户可见的散文字段；evidence 逐字引文与 sources 不受限。 */
function findForbiddenPhraseInResearchDoc(doc: TResearchDoc): string | null {
  const fields = [doc.summary, ...doc.options.flatMap((option) => option.consequences), ...doc.unknowns];
  for (const text of fields) {
    const hit = findForbiddenPhrase(text);
    if (hit) return hit;
  }
  return null;
}

/**
 * 预研生命周期：pending/failed/ready → running（version 条件）→ ready 或 failed。
 * 成功整份写 doc；失败只写 error，不自动 retry 或升档；旧 run 不能覆盖新 run。
 */
export const RESEARCH_TIMEOUT_MS = 180_000;

export function createResearchService({
  pool,
  runner,
  researchTimeoutMs = RESEARCH_TIMEOUT_MS,
}: {
  pool: Pool;
  runner: ResearchRunner;
  /** 单次预研的硬超时。 */
  researchTimeoutMs?: number;
}): ResearchService {
  const q = pool.query.bind(pool);
  const inflight = new Set<Promise<void>>();

  function track(promise: Promise<void>): Promise<void> {
    inflight.add(promise);
    const settle = () => inflight.delete(promise);
    promise.then(settle, settle);
    return promise;
  }

  async function execute(issueId: string, runId: string): Promise<void> {
    const row = await getIssueRow(q, issueId);
    if (!row || row.status !== "pending" || row.research.status !== "running" || row.research.runId !== runId) return;
    try {
      // 模型调用可能一直不返回：超时即失败，让卡上重新出现「重新预研」，不会永远卡在 running。
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error("预研超时，请重试"), { code: RESEARCH_FAILED }));
        }, researchTimeoutMs);
      });
      const candidate = await Promise.race([
        runner(
          {
            issue: {
              id: row.id,
              title: row.title,
              origin: row.origin,
              originRef: row.origin_ref,
              location: row.location,
              urgency: row.urgency,
            },
          },
          controller.signal,
        ),
        timeout,
      ]).finally(() => clearTimeout(timer));
      if (!Value.Check(ResearchDoc, candidate)) {
        throw Object.assign(new Error("ResearchDoc candidate 不符合严格 schema"), { code: INVALID_RESEARCH_DOC });
      }
      const forbidden = findForbiddenPhraseInResearchDoc(candidate);
      if (forbidden) {
        throw Object.assign(new Error(`ResearchDoc 出现翻案句：${forbidden}`), { code: INVALID_RESEARCH_DOC });
      }
      await q(
        `UPDATE issues
            SET research = research || jsonb_build_object('status', 'ready', 'doc', $2::jsonb, 'error', NULL, 'startedAt', NULL),
                version = version + 1,
                updated_at = now()
          WHERE id = $1 AND research->>'status' = 'running' AND research->>'runId' = $3`,
        [issueId, JSON.stringify(candidate), runId],
      );
    } catch (cause) {
      const error = cause as Error & { code?: string };
      await q(
        `UPDATE issues
            SET research = research || jsonb_build_object(
                  'status', 'failed',
                  'error', jsonb_build_object('code', $3::text, 'message', $4::text, 'at', $5::text),
                  'startedAt', NULL
                ),
                version = version + 1,
                updated_at = now()
          WHERE id = $1 AND research->>'status' = 'running' AND research->>'runId' = $2`,
        [
          issueId,
          runId,
          error.code === INVALID_RESEARCH_DOC ? INVALID_RESEARCH_DOC : RESEARCH_FAILED,
          error.message || "预研运行失败",
          new Date().toISOString(),
        ],
      ).catch(() => undefined);
    }
  }

  return {
    start(issueId: string): Promise<void> {
      return track(startRun(issueId));
    },
    executeRun(issueId: string, runId: string): Promise<void> {
      return track(execute(issueId, runId));
    },
    async idle(): Promise<void> {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };

  /**
   * 只允许在 Issue 创建后调用一次（无并发写入者）；显式重跑必须走 issue.retry_research
   * Action —— 那里有行锁、version 条件与 fingerprint 幂等，这里不重复实现。
   */
  async function startRun(issueId: string): Promise<void> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    // 只有确实从非 running 状态转过来才执行；已有 run 在跑时不产生第二个 run
    const transition = await q(
      `UPDATE issues
          SET research = jsonb_build_object(
                'status', 'running',
                'runId', $2::text,
                'startedAt', $3::text,
                'previousRunIds', COALESCE(research->'previousRunIds', '[]'::jsonb),
                'error', NULL
              ),
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND status = 'pending' AND research->>'status' <> 'running'`,
      [issueId, runId, startedAt],
    );
    if (transition.rowCount !== 1) return;
    await execute(issueId, runId);
  }
}
