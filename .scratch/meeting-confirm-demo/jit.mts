import { createRequire } from "node:module";
import { meetingColumns } from "../../apps/api/src/meetingStore.js";
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const { Pool } = require("pg") as typeof import("pg");
const pool = new Pool({ connectionString: process.argv[2], max: 1 });
const sql = `SELECT ${meetingColumns()} FROM meetings`;
const show = async (label: string) => {
  const plan = (await pool.query(`EXPLAIN (ANALYZE, FORMAT TEXT) ${sql}`)).rows.map((r) => r["QUERY PLAN"] as string);
  console.log(label, plan.filter((l) => /JIT|Timing|Functions|Options|Execution Time|Planning Time/.test(l)).map((l) => l.trim()).join(" | "));
};
console.log("jit settings:", (await pool.query("SELECT current_setting('jit') jit, current_setting('jit_above_cost') above, current_setting('jit_optimize_above_cost') opt")).rows[0]);
await show("jit on :");
await pool.query("SET jit = off");
await show("jit off:");
await pool.end();
