import type { QueryResult } from "pg";
import type { TStrategyConfigResponse } from "@warmap/contracts";

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

/** 公司长期目标（LTCO）：跨月稳定的长期配置，MVP 只有一行 default。 */
export async function getStrategyConfig(q: Query): Promise<TStrategyConfigResponse> {
  const result = await q("SELECT version, ltco FROM company_strategy_config WHERE id = 'default'");
  const row = result.rows[0] as TStrategyConfigResponse | undefined;
  return row ?? { version: 1, ltco: "" };
}

/** CEO 更新 LTCO：version+1 留痕；这是长期配置，不进入 MonthlyPlan 的当月结果。 */
export async function updateStrategyConfig(q: Query, ltco: string): Promise<TStrategyConfigResponse> {
  const result = await q(
    "UPDATE company_strategy_config SET ltco = $1, version = version + 1, updated_at = now() WHERE id = 'default' RETURNING version, ltco",
    [ltco],
  );
  return result.rows[0] as TStrategyConfigResponse;
}
