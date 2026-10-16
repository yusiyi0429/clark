import { v7 } from "uuid";
import type { QueryResult } from "pg";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

/** Business binding, rather than Pi's replaceable session id, owns the UUID7. */
export async function traceThread(
  q: Query,
  businessKey: string,
): Promise<string> {
  const result = await q(
    `INSERT INTO trace_threads(business_key,thread_id) VALUES($1,$2)
    ON CONFLICT(business_key) DO UPDATE SET business_key=EXCLUDED.business_key RETURNING thread_id`,
    [businessKey, v7()],
  );
  return result.rows[0].thread_id;
}

/** One atomic increment per execution; retries never rewrite an earlier root trace. */
export async function traceAttempt(
  q: Query,
  threadId: string,
  logicalTurnId: string,
  inputDigest?: string,
): Promise<number> {
  const result = await q(
    `INSERT INTO trace_turns(thread_id,logical_turn_id,attempt,input_digest) VALUES($1,$2,1,$3)
    ON CONFLICT(thread_id,logical_turn_id) DO UPDATE SET attempt=trace_turns.attempt+1
    RETURNING attempt`,
    [threadId, logicalTurnId, inputDigest ?? null],
  );
  return result.rows[0].attempt;
}
