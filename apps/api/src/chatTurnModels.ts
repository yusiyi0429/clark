import type { TConversationModel, TLocalFallbackReason } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";

/**
 * 走 Chat 的每一轮实际用的来源和模型（迁移 256）：转流时从 Chat 的 usage 事件记下（一轮调了几次取最后一次），读历史时按 runId 取回。
 * 只有来源和模型名。项目对话这一轮本该在本机、没跑成改在云端的，同一行记 fallback（迁移 265，17.2 第 38 条）。
 * scopeKind 记这一轮是伙伴对话还是项目对话，给使用计数分开数（迁移 278，第 70 条）。
 */
export async function recordTurnModel(q: Query, ownerId: string, runId: string, used: TConversationModel, now: Date, scopeKind?: "buddy" | "project"): Promise<void> {
  await q(`INSERT INTO chat_turn_models(run_id,owner_id,provider,model,recorded_at,scope_kind) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT (run_id) DO UPDATE SET provider=EXCLUDED.provider,model=EXCLUDED.model,recorded_at=EXCLUDED.recorded_at,
      scope_kind=COALESCE(EXCLUDED.scope_kind,chat_turn_models.scope_kind)`,
  [runId, ownerId, used.provider, used.model, now, scopeKind ?? null]);
}

export async function recordTurnFallback(q: Query, ownerId: string, runId: string, fallback: TLocalFallbackReason, now: Date): Promise<void> {
  await q(`INSERT INTO chat_turn_models(run_id,owner_id,fallback,recorded_at) VALUES($1,$2,$3,$4)
    ON CONFLICT (run_id) DO UPDATE SET fallback=EXCLUDED.fallback`, [runId, ownerId, fallback, now]);
}

export async function turnModels(q: Query, ownerId: string, runIds: string[]): Promise<Map<string, { model?: TConversationModel; fallback?: TLocalFallbackReason }>> {
  if (!runIds.length) return new Map();
  const rows = (await q("SELECT run_id,provider,model,fallback FROM chat_turn_models WHERE owner_id=$1 AND run_id=ANY($2::text[])", [ownerId, runIds])).rows as
    { run_id: string; provider: string | null; model: string | null; fallback: TLocalFallbackReason | null }[];
  return new Map(rows.map((row) => [row.run_id, { ...(row.provider && row.model ? { model: { provider: row.provider, model: row.model } } : {}),
    ...(row.fallback ? { fallback: row.fallback } : {}) }]));
}
