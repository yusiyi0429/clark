import { Pool, type PoolClient } from "pg";
import { createArticleFetcher, fullTextKeepsQuotes } from "../src/articleText.js";

/**
 * 一次性回填：给采集时还没有逐条记下 source_ref.fullText 的旧行补上原文完整度。
 * 在 apps/api 下执行：`pnpm exec tsx --env-file=.env scripts/backfill-source-fulltext.ts [--dry-run] [--refetch-web] [--limit=50]`
 * - 公众号（signals.source_type = 'wechat-account'）：read_article 读到的正文是多段长文，digest 是 120 字以内的一段导语；
 *   原文含换行或超过 140 字记 fullText = true，否则记 false。只写标记，不动原文；
 * - 量子位等目录标 fullText 的发布方：旧行由 isFullTextSource 按目录推断，不需要回填；
 * - `--refetch-web`：检索条目（公司 signals 与个人 person_radar_signals，source_ref.type = 'web-search'）重抓原文页，
 *   全文逐字包含 evidence_quote（公司信号升级出的议题若有 red 截止日引文，也要包含）才换成全文并标 fullText；
 *   否则保留检索摘要、不写标记。公司信号顺带换成正文配图（有图时）；个人信号表没有配图列。每次至多 --limit 条；
 * - 可重复执行：已有标记的行不再处理；单事务，公司信号有变化时 version + 1。
 */
const dryRun = process.argv.includes("--dry-run");
const refetchWeb = process.argv.includes("--refetch-web");
const limit = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.slice("--limit=".length) ?? 50);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("missing env DATABASE_URL");
if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit 必须是正整数");

type Row = { id: string; source_url: string; source_title: string; excerpt: string; evidence_quote: string; red_quote: string | null };

async function markWechat(client: PoolClient, report: Record<string, string>[]) {
  const rows = (await client.query<{ id: string; excerpt: string }>(
    `SELECT id, excerpt FROM signals
      WHERE source_type = 'wechat-account' AND NOT (source_ref ? 'fullText')
      ORDER BY collected_at, id FOR UPDATE`,
  )).rows;
  for (const row of rows) {
    const fullText = row.excerpt.includes("\n") || Array.from(row.excerpt).length > 140;
    if (!dryRun) {
      await client.query(
        "UPDATE signals SET source_ref = source_ref || jsonb_build_object('fullText', $2::boolean), version = version + 1, updated_at = now() WHERE id = $1",
        [row.id, fullText],
      );
    }
    report.push({ 表: "signals", id: row.id, 来源: "公众号", 字数: String(row.excerpt.length), 结果: `${dryRun ? "将标" : "已标"} fullText=${fullText}` });
  }
}

async function refetch(client: PoolClient, table: "signals" | "person_radar_signals", report: Record<string, string>[]) {
  const fetcher = createArticleFetcher();
  const rows = (await client.query<Row>(
    table === "signals"
      ? `SELECT s.id, s.source_url, s.source_title, s.excerpt, s.evidence_quote, i.urgency->'decisionByEvidence'->>'quote' AS red_quote
           FROM signals s LEFT JOIN issues i ON i.id = s.promoted_issue_id
          WHERE s.source_ref->>'type' = 'web-search' AND NOT (s.source_ref ? 'fullText')
          ORDER BY s.collected_at DESC, s.id LIMIT $1 FOR UPDATE OF s`
      : `SELECT id, source_url, source_title, excerpt, evidence_quote, NULL AS red_quote FROM person_radar_signals
          WHERE source_ref->>'type' = 'web-search' AND NOT (source_ref ? 'fullText')
          ORDER BY collected_at DESC, id LIMIT $1 FOR UPDATE`,
    [limit],
  )).rows;
  for (const row of rows) {
    const article = await fetcher(row.source_url, { title: row.source_title }) ?? undefined;
    const quotes = [row.evidence_quote, ...(row.red_quote ? [row.red_quote] : [])];
    const adopt = fullTextKeepsQuotes(row.excerpt, article, quotes);
    if (adopt && !dryRun) {
      if (table === "signals") {
        await client.query(
          `UPDATE signals SET excerpt = $2, source_ref = source_ref || '{"fullText": true}'::jsonb,
                  source_images = CASE WHEN jsonb_array_length($3::jsonb) > 0 THEN $3::jsonb ELSE source_images END,
                  version = version + 1, updated_at = now()
            WHERE id = $1`,
          [row.id, article.text, JSON.stringify(article.images)],
        );
      } else {
        await client.query(
          `UPDATE person_radar_signals SET excerpt = $2, source_ref = source_ref || '{"fullText": true}'::jsonb, updated_at = now() WHERE id = $1`,
          [row.id, article.text],
        );
      }
    }
    report.push({
      表: table,
      id: row.id,
      来源: "检索",
      字数: adopt ? `${row.excerpt.length} → ${article.text.length}` : String(row.excerpt.length),
      结果: adopt ? (dryRun ? "将换成全文" : "已换成全文") : !article ? "跳过：原文页抓不到全文" : "跳过：全文不含引文或比摘要短",
    });
  }
}

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const report: Record<string, string>[] = [];
  await markWechat(client, report);
  if (refetchWeb) {
    await refetch(client, "signals", report);
    await refetch(client, "person_radar_signals", report);
  }
  await client.query(dryRun ? "ROLLBACK" : "COMMIT");
  if (report.length) console.table(report);
  else console.log("没有需要回填的行。");
  if (dryRun) console.log("--dry-run：未写入。");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
