/** External controls for the one known 04b disposable browser fixture.
 * No environment/config files or real credentials are read. This does not stop servers.
 * inspect is read-only. close-round and clean run only when explicitly invoked.
 */
import { lstat, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DATABASE = "warmap_test_fbbf518b5f07";
const FIXTURE_DIRECTORY = "warmap-04b-browser-mn4JXb";
const API_PID = 26976;
const ADMIN_URL = "postgres://postgres:postgres@localhost:54329/postgres";
const { Pool } = createRequire(new URL("../../../../apps/api/package.json", import.meta.url))("pg");
const report = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const command = process.argv[2];
if (!/^(inspect|close-round|clean)$/.test(command ?? "") || process.argv.length !== 3) {
  process.stderr.write("Usage: browser-control.ts inspect|close-round|clean\n");
  process.exitCode = 2;
} else void main().catch((error) => {
  report({ failed: true, command, reason: error instanceof Error ? error.message : "Control failed" });
  process.exitCode = 1;
});

async function main() {
  if (DATABASE !== "warmap_test_fbbf518b5f07" || !/^warmap_test_[a-f0-9]{12}$/.test(DATABASE)) throw new Error("Unexpected database target");
  if (command === "clean") return clean();
  const pool = new Pool({ connectionString: ADMIN_URL.replace(/\/postgres$/, `/${DATABASE}`), max: 2 });
  try {
    const current = (await pool.query("SELECT current_database() AS database")).rows[0].database;
    if (current !== DATABASE) throw new Error("Connected database does not match the fixture");
    if (command === "close-round") {
      const deadline = (await pool.query("SELECT max(closes_at) AS deadline FROM mission_rounds WHERE status='open'")).rows[0].deadline;
      if (deadline) {
        const { closeDueRounds } = await import("../../../../apps/api/src/missionRounds.js");
        const closedAt = new Date(deadline);
        const closed = await closeDueRounds(pool, closedAt);
        report({ cutoffApplied: true, closed, snapshotClock: closedAt.toISOString(), applicationClockChanged: false,
          note: "外部控制只推进截止快照；运行中 API 的固定应用时钟保持不变。后续留言时间不用于验证截止边界。" });
      } else report({ cutoffApplied: false, closed: 0, reason: "没有开放中的轮次" });
    }
    const counts = (await pool.query(`SELECT
      (SELECT count(*)::int FROM mission_rounds) AS rounds,
      (SELECT count(*)::int FROM personal_mission_cards) AS cards,
      (SELECT count(*)::int FROM missions) AS missions_total,
      (SELECT count(*)::int FROM missions WHERE personal_mission_card_id IS NOT NULL) AS card_missions,
      (SELECT count(*)::int FROM mission_card_feedback) AS feedback,
      (SELECT count(*)::int FROM mission_round_reviews) AS reviews,
      (SELECT bool_and(placeholder) FROM missions WHERE personal_mission_card_id IS NOT NULL) AS all_card_missions_placeholder`)).rows[0];
    const rounds = (await pool.query("SELECT id,status,window_seq,opened_at,closes_at FROM mission_rounds ORDER BY created_at")).rows;
    const cards = (await pool.query("SELECT id AS card_id,owner_id FROM personal_mission_cards ORDER BY sort_order,id")).rows;
    const feedback = (await pool.query(`SELECT seq,kind,author_id,mission_id,field,basis,source_version,late,created_at,
      left(body,120) AS body_preview,quote IS NOT NULL AS has_quote,original IS NOT NULL AS has_original,
      proposed IS NOT NULL AS has_proposed FROM mission_card_feedback ORDER BY seq`)).rows;
    const reviews = (await pool.query("SELECT window_seq,snapshot_at,taken_at,jsonb_array_length(feedback_ids) AS feedback_count FROM mission_round_reviews ORDER BY window_seq")).rows;
    report({ inspect: true, database: DATABASE, counts, rounds, cards, feedback, reviews });
  } finally { await pool.end(); }
}

async function listening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); done(true); });
    socket.once("error", () => { socket.destroy(); done(false); });
    socket.setTimeout(1500, () => { socket.destroy(); done(true); });
  });
}

async function clean() {
  let alive = false;
  try { process.kill(API_PID, 0); alive = true; } catch (error) { if ((error as { code?: string }).code !== "ESRCH") throw error; }
  if (alive || await listening(4500)) throw new Error("API process or port 4500 is still active; stop this fixture before cleaning");
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    const connections = (await admin.query("SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname=$1", [DATABASE])).rows[0].total;
    if (connections !== 0) throw new Error("The fixture database still has connections; cleanup refused");
    // Exact constant only. Do not accept a database name from argv, the environment or a file.
    await admin.query('DROP DATABASE IF EXISTS "warmap_test_fbbf518b5f07"');
    const remaining = (await admin.query("SELECT count(*)::int AS total FROM pg_database WHERE datname=$1", [DATABASE])).rows[0].total;
    if (remaining !== 0) throw new Error("Fixture database was not removed");
  } finally { await admin.end(); }

  const target = resolve(join(tmpdir(), FIXTURE_DIRECTORY));
  const expected = resolve(join(tmpdir(), "warmap-04b-browser-mn4JXb"));
  if (target !== expected || !target.startsWith(`${resolve(tmpdir())}\\warmap-04b-browser-`)) throw new Error("Unexpected fixture directory target");
  try {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(target)).toLowerCase() !== target.toLowerCase()) throw new Error("Fixture directory is not the expected physical directory");
    const entries = await readdir(target);
    if (entries.some((entry) => entry !== "people.json")) throw new Error("Unexpected files in fixture directory; cleanup refused");
    // Remove only the known file, then the empty directory; never recursively traverse a path.
    await rm(join(target, "people.json"), { force: true });
    await rmdir(target);
  } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
  report({ cleaned: true, database: DATABASE, remaining: 0, fixtureDirectory: target });
}
