import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { buildMissionCardReviewInput, validateMissionCardReviewReport, type MissionCardReviewAgent, type MissionCardReviewInput } from "./missionCardReview.js";
import { getMissionRoundRow } from "./missionRounds.js";

/** 持久化状态与快照，后台生成；退回/旧版本的结果不得再成为当前报告。 */
export function createMissionCardReviewQueue(options: { pool: Pool; agent: MissionCardReviewAgent; now: () => Date; onError: (error: unknown) => void }) {
  const running = new Map<string, Promise<void>>(), abort = new AbortController();
  const q = options.pool.query.bind(options.pool);
  async function process(reviewId: string) {
    const client = await options.pool.connect();
    let input: MissionCardReviewInput | null = null, token: string | null = null;
    try {
      await client.query("BEGIN");
      const found = (await client.query("SELECT round_id FROM mission_round_reviews WHERE id=$1", [reviewId])).rows[0];
      if (!found) { await client.query("COMMIT"); return; }
      await client.query("SELECT id FROM mission_rounds WHERE id=$1 FOR UPDATE", [found.round_id]);
      const row = (await client.query("SELECT * FROM mission_round_reviews WHERE id=$1 FOR UPDATE", [reviewId])).rows[0];
      const round = await getMissionRoundRow(client.query.bind(client), found.round_id);
      if (!round || round.status !== "reviewing" || row.superseded_at || row.window_seq !== round.window_seq
        || row.agent_status !== "queued" && !(row.agent_status === "running" && row.agent_started_at < new Date(options.now().getTime() - 10 * 60_000))) {
        await client.query("COMMIT"); return;
      }
      input = row.agent_input ?? await buildMissionCardReviewInput(client.query.bind(client), round);
      token = randomUUID();
      await client.query("UPDATE mission_round_reviews SET agent_status='running',agent_started_at=$2,agent_error=NULL,agent_input=$3::jsonb,agent_run_id=$4 WHERE id=$1",
        [reviewId, options.now(), JSON.stringify(input), token]);
      await client.query("COMMIT");
    } catch (cause) {
      await client.query("ROLLBACK").catch(() => undefined);
      await q(`WITH failed AS (
        UPDATE mission_round_reviews v SET agent_status='failed',agent_error=$2 FROM mission_rounds r
        WHERE v.id=$1 AND v.superseded_at IS NULL AND r.id=v.round_id AND r.status='reviewing' AND r.window_seq=v.window_seq
          AND (v.agent_status='queued' OR (v.agent_status='running' AND v.agent_started_at<$3)) RETURNING v.round_id
      ) UPDATE mission_rounds r SET version=r.version+1,updated_at=$4 FROM failed WHERE r.id=failed.round_id`,
        [reviewId, "无法形成完整确认快照，请退回未完成人后重新确认", new Date(options.now().getTime() - 10 * 60_000), options.now()]);
      options.onError(cause); return;
    } finally { client.release(); }
    if (!input || !token) return;
    try {
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(5 * 60_000)]);
      const result = await Promise.race([options.agent.generate(input, signal, q), new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })]);
      if (signal.aborted) throw signal.reason;
      if (!validateMissionCardReviewReport(input, result.candidate)) throw new Error("Review 来源或格式无效");
      const completed = await q(`UPDATE mission_round_reviews v SET agent_status='completed',agent_report=$3::jsonb,agent_error=NULL,agent_completed_at=$4
        FROM mission_rounds r WHERE v.id=$1 AND v.agent_run_id=$2 AND v.agent_status='running' AND v.superseded_at IS NULL
          AND r.id=v.round_id AND r.status='reviewing' AND r.window_seq=v.window_seq`, [reviewId, token, JSON.stringify(result.candidate), options.now()]);
      if (completed.rowCount) await q("UPDATE mission_rounds SET version=version+1,updated_at=$2 WHERE id=$1 AND status='reviewing' AND window_seq=$3", [input.roundId, options.now(), input.round]);
    } catch (cause) {
      const failed = await q("UPDATE mission_round_reviews SET agent_status=$3,agent_error=$4 WHERE id=$1 AND agent_run_id=$2 AND agent_status='running' AND superseded_at IS NULL",
        [reviewId, token, abort.signal.aborted ? "queued" : "failed", abort.signal.aborted ? null : "Co-Agent Review 暂未完成，请重试；已确认正文和备注均已保留"]);
      if (failed.rowCount && !abort.signal.aborted) await q("UPDATE mission_rounds SET version=version+1,updated_at=$2 WHERE id=$1 AND status='reviewing' AND window_seq=$3", [input.roundId, options.now(), input.round]);
    }
  }
  function enqueue(id: string): Promise<void> {
    if (abort.signal.aborted) return Promise.resolve();
    const existing = running.get(id); if (existing) return existing;
    const work = process(id).catch(options.onError).finally(() => { running.delete(id); });
    running.set(id, work); return work;
  }
  async function recover() {
    const rows = await q(`SELECT v.id FROM mission_round_reviews v JOIN mission_rounds r ON r.id=v.round_id
      WHERE v.superseded_at IS NULL AND r.status='reviewing' AND r.window_seq=v.window_seq
      AND (v.agent_status='queued' OR (v.agent_status='running' AND v.agent_started_at<$1))`, [new Date(options.now().getTime() - 10 * 60_000)]);
    for (const row of rows.rows) void enqueue(row.id);
  }
  return { recover, async close() { abort.abort(); await Promise.all(running.values()); } };
}
