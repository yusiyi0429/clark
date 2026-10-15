import { Pool } from "pg";
import { duplicateDismissReason, findDuplicateRadarIssuePairs, mergeDuplicateRadarIssue } from "../src/radarIssueCleanup.js";

/**
 * 列出某个库里同一战场的近重复雷达议题对，并给出合并建议：保留较早的一条，较晚一条的信号合并过去，
 * 较晚一条移出决策面，原因记为「与「<保留议题>」重复，已合并」。
 * 在 apps/api 下执行：`DATABASE_URL=… pnpm exec tsx scripts/radar-dedupe-issues.ts`
 * - 默认 dry-run：只读查询并打印，不写库；
 * - 只有显式加 `--execute` 才合并写库（每对一个事务；议题已不在待决策就跳过）。
 */
const execute = process.argv.includes("--execute");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("missing env DATABASE_URL");

const pool = new Pool({ connectionString: databaseUrl });
try {
  const pairs = await findDuplicateRadarIssuePairs((sql, params) => pool.query(sql, params));
  if (pairs.length === 0) console.log("没有发现同战场近重复的雷达议题");
  for (const pair of pairs) {
    console.log(`相似度 ${pair.similarity.toFixed(2)}`);
    console.log(`  保留  ${pair.keep.createdAt}  ${pair.keep.id}  ${pair.keep.title}`);
    console.log(`  合并  ${pair.drop.createdAt}  ${pair.drop.id}  ${pair.drop.title}`);
    console.log(`  移出原因：${duplicateDismissReason(pair.keep.title)}`);
  }
  if (!execute) {
    console.log(`共 ${pairs.length} 对，dry-run 未写入；确认后加 --execute 执行`);
  } else {
    const client = await pool.connect();
    try {
      let merged = 0;
      for (const pair of pairs) {
        const result = await mergeDuplicateRadarIssue(client, pair);
        if (result.merged) merged += 1;
        console.log(`${result.merged ? "已合并" : "已跳过（议题已不在待决策）"}  ${pair.drop.title} → ${pair.keep.title}  信号 ${result.movedSignals} 条`);
      }
      console.log(`共 ${pairs.length} 对，合并 ${merged} 对`);
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
