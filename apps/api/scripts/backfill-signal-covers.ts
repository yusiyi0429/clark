import { Pool } from "pg";
import { createCoverImageFetcher, fetchCovers } from "../src/signalCover.js";

/**
 * 给已入库、还没有配图的 Signal 补原文封面：按 source_url 抓原文页的 og:image / twitter:image / 正文首图，
 * 写成 source_images = [{ src, after: 0 }]。
 * 在 apps/api 下执行：`DATABASE_URL=… pnpm exec tsx scripts/backfill-signal-covers.ts [--dry-run]`
 * - 只动 source_images 这一列（不改 version、updated_at 或其他字段）；已有配图的行不碰；
 * - 抓不到图（超时、无 og、只有站点 logo/默认分享图）的行保持 []；
 * - 可重复执行：条件里带 source_images = '[]'，并发写入或重跑都不会覆盖已有配图。
 */
const dryRun = process.argv.includes("--dry-run");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("missing env DATABASE_URL");

const pool = new Pool({ connectionString: databaseUrl });
try {
  const rows = (await pool.query<{ id: string; source_url: string }>(
    "SELECT id, source_url FROM signals WHERE source_images = '[]'::jsonb ORDER BY collected_at DESC",
  )).rows;
  const covers = await fetchCovers(rows.map((row) => row.source_url), createCoverImageFetcher(), { concurrency: 4 });
  let updated = 0;
  for (const row of rows) {
    const cover = covers.get(row.source_url);
    console.log(`${cover ? "有图" : "无图"}  ${row.source_url}${cover ? `\n      → ${cover}` : ""}`);
    if (!cover || dryRun) continue;
    const result = await pool.query(
      "UPDATE signals SET source_images = $2::jsonb WHERE id = $1 AND source_images = '[]'::jsonb",
      [row.id, JSON.stringify([{ src: cover, after: 0 }])],
    );
    updated += result.rowCount ?? 0;
  }
  console.log(`共 ${rows.length} 条无图信号，找到封面 ${covers.size > 0 ? rows.filter((row) => covers.has(row.source_url)).length : 0} 条，${dryRun ? "试运行未写入" : `写入 ${updated} 条`}`);
} finally {
  await pool.end();
}
