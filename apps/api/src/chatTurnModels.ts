import type { TConversationModel } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";

/**
 * 走 Chat 的每一轮实际用的来源和模型（迁移 256）：转流时从 Chat 的 usage 事件记下（一轮调了几次取最后一次），读历史时按 runId 取回。
 * 只有来源和模型名。
 */
export async function recordTurnModel(q: Query, ownerId: string, runId: string, used: TConversationModel, now: Date): Promise<void> {
  await q(`INSERT INTO chat_turn_models(run_id,owner_id,provider,model,recorded_at) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT (run_id) DO UPDATE SET provider=EXCLUDED.provider,model=EXCLUDED.model,recorded_at=EXCLUDED.recorded_at`,
  [runId, ownerId, used.provider, used.model, now]);
}

export async function turnModels(q: Query, ownerId: string, runIds: string[]): Promise<Map<string, TConversationModel>> {
  if (!runIds.length) return new Map();
  const rows = (await q("SELECT run_id,provider,model FROM chat_turn_models WHERE owner_id=$1 AND run_id=ANY($2::text[])", [ownerId, runIds])).rows as
    { run_id: string; provider: string; model: string }[];
  return new Map(rows.map((row) => [row.run_id, { provider: row.provider, model: row.model }]));
}
