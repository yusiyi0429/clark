import type { PoolClient, QueryResult } from "pg";
import type { TIssueLocation } from "@warmap/contracts";
import { attachSignalToIssue } from "./radar.js";
import { issueTitleSimilarity, ISSUE_DUPLICATE_THRESHOLD, sameIssueScope, supplementarySignalsOf } from "./radarDedupe.js";

/**
 * 清理已经产生的近重复雷达议题：同一战场、标题相似度达到阈值的待决策雷达议题两两成对，
 * 建议保留较早的一条，把较晚一条的信号合并过去，较晚一条移出决策面并记录原因。
 * 只有 merge 会写库；find 只读。由 scripts/radar-dedupe-issues.ts 调用，默认只打印。
 */

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

export type DuplicateIssueRef = { id: string; title: string; createdAt: string };
export type DuplicateRadarIssuePair = { keep: DuplicateIssueRef; drop: DuplicateIssueRef; similarity: number };

type IssueRow = { id: string; title: string; location: TIssueLocation; created_at: Date };

export async function findDuplicateRadarIssuePairs(query: Query, threshold = ISSUE_DUPLICATE_THRESHOLD): Promise<DuplicateRadarIssuePair[]> {
  const names = (await query("SELECT name, code FROM battlefield_config")).rows as { name: string; code: string | null }[];
  const companyNames = names.flatMap((row) => [row.name, row.code ?? ""]);
  const issues = (await query(
    "SELECT id, title, location, created_at FROM issues WHERE origin = 'radar' AND status = 'pending' ORDER BY created_at, id",
  )).rows as IssueRow[];
  const pairs: DuplicateRadarIssuePair[] = [];
  const kept: IssueRow[] = [];
  const ref = (row: IssueRow): DuplicateIssueRef => ({ id: row.id, title: row.title, createdAt: row.created_at.toISOString() });
  for (const issue of issues) {
    let best: { row: IssueRow; similarity: number } | null = null;
    for (const earlier of kept) {
      if (!sameIssueScope(issue.location, earlier.location)) continue;
      const similarity = issueTitleSimilarity(issue.title, earlier.title, companyNames);
      if (similarity >= threshold && (!best || similarity > best.similarity)) best = { row: earlier, similarity };
    }
    if (best) pairs.push({ keep: ref(best.row), drop: ref(issue), similarity: Math.round(best.similarity * 100) / 100 });
    else kept.push(issue);
  }
  return pairs;
}

export function duplicateDismissReason(keepTitle: string): string {
  return `与「${keepTitle}」重复，已合并`.slice(0, 500);
}

/** 合并一对：较晚议题的信号（原始信号 + 已挂靠的补充信号）挂到保留议题，较晚议题移出决策面。单事务。 */
export async function mergeDuplicateRadarIssue(client: Pick<PoolClient, "query">, pair: DuplicateRadarIssuePair): Promise<{ merged: boolean; movedSignals: number }> {
  await client.query("BEGIN");
  try {
    const rows = (await client.query(
      "SELECT id, title, status, origin_ref FROM issues WHERE id = ANY($1::uuid[]) FOR UPDATE",
      [[pair.keep.id, pair.drop.id]],
    )).rows as { id: string; title: string; status: string; origin_ref: unknown }[];
    const keep = rows.find((row) => row.id === pair.keep.id);
    const drop = rows.find((row) => row.id === pair.drop.id);
    if (!keep || !drop || keep.status !== "pending" || drop.status !== "pending") {
      await client.query("ROLLBACK");
      return { merged: false, movedSignals: 0 };
    }
    const originSignalId = (drop.origin_ref as { signalId?: unknown } | null)?.signalId;
    const signals = (await client.query(
      `SELECT id, source_title, source_url, evidence_quote, summary FROM signals
        WHERE promoted_issue_id = $1 OR id::text = $2 ORDER BY collected_at, id`,
      [drop.id, typeof originSignalId === "string" ? originSignalId : ""],
    )).rows as { id: string; source_title: string; source_url: string; evidence_quote: string; summary: string }[];
    const now = new Date().toISOString();
    for (const signal of signals) {
      await attachSignalToIssue(client, {
        issueId: keep.id,
        signalId: signal.id,
        promotionFingerprint: null,
        supplement: {
          signalId: signal.id, sourceTitle: signal.source_title, sourceUrl: signal.source_url,
          evidenceQuote: signal.evidence_quote, summary: signal.summary, attachedAt: now, via: "merge",
        },
      });
    }
    // 较晚议题自己挂靠过、但信号已不指向它的补充依据也一并带过去
    for (const supplement of supplementarySignalsOf(drop.origin_ref)) {
      if (signals.some((signal) => signal.id === supplement.signalId)) continue;
      await attachSignalToIssue(client, { issueId: keep.id, signalId: supplement.signalId, promotionFingerprint: null, supplement: { ...supplement, via: "merge" } });
    }
    await client.query(
      `UPDATE issues
          SET status = 'dismissed', dismissed_at = now(), dismiss_reason = $2,
              dismiss_fingerprint = $3, version = version + 1, updated_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [drop.id, duplicateDismissReason(keep.title), `radar-dedupe:${keep.id}`],
    );
    await client.query("COMMIT");
    return { merged: true, movedSignals: signals.length };
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw cause;
  }
}
