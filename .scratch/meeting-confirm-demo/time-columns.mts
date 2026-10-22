/**
 * 诊断：读会议时新加的两段子查询各花多少时间（不改任何东西，只读）。
 *   cd apps/api && node node_modules/tsx/dist/cli.mjs ../../.scratch/meeting-confirm-demo/time-columns.mts <数据库 URL>
 */
import { createRequire } from "node:module";
import { meetingColumns } from "../../apps/api/src/meetingStore.js";

const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const { Pool } = require("pg") as typeof import("pg");
const pool = new Pool({ connectionString: process.argv[2], max: 1 });
const full = meetingColumns();
// 去掉新加的挂点候选列；决定列换回原来的写法（不带 targets）。
const noAnchors = full.replace(/, jsonb_build_array\([\s\S]*AS world_anchor_groups$/, "");
const oldDecisions = noAnchors.replace(/\(SELECT COALESCE\(jsonb_agg\(to_jsonb\(d\) \|\|[\s\S]*?AS decisions/,
  "(SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.tier DESC, d.ordinal), '[]'::jsonb) FROM meeting_decisions d WHERE d.meeting_id = meetings.id) AS decisions");

async function time(label: string, columns: string) {
  const runs: number[] = [];
  for (let i = 0; i < 20; i++) {
    const started = performance.now();
    await pool.query(`SELECT ${columns} FROM meetings`);
    runs.push(performance.now() - started);
  }
  runs.sort((a, b) => a - b);
  console.log(label.padEnd(28), `median ${runs[10].toFixed(1)}ms  min ${runs[0].toFixed(1)}ms`);
}
const count = (await pool.query("SELECT count(*)::int AS n FROM meetings")).rows[0].n;
console.log(`meetings: ${count}`);
await time("main 原样（不含两段）", oldDecisions);
await time("+ 决定带 targets", noAnchors);
await time("+ 挂点候选（现在）", full);
const plan = (await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT ${full} FROM meetings`)).rows.map((row) => row["QUERY PLAN"]);
console.log(plan.filter((line: string) => /actual time|Planning|Execution/.test(line)).slice(0, 12).join("\n"));
await pool.end();
