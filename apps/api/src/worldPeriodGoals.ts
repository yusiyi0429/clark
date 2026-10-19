import type { Pool } from "pg";
import type { Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import { WorldClient, WorldError, worldErrorCode, worldTarget, type WorldAction, type WorldHead } from "./worldClient.js";

type SignedPlan = { id: string; period: string; confirmed_at: Date };

const shanghai = (at: Date) => new Date(at.getTime() + 8 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "+08:00");
const lifecycleStatus = (head: WorldHead): string | undefined => (head.lifecycle as { status?: string } | null)?.status;

/** 一个目标版本一个键：同一版本只试一次，网络失败按这个键重放；目标重新承诺（版本变了）才再试。 */
export const periodGoalKey = (planId: string, goal: Pick<WorldHead, "object_id" | "object_version">) =>
  `tianshu:plan-sign:${planId}:${goal.object_id}:${goal.object_version}`;

/** 契约 0.3 第 10.3、14 节：代 CEO 确认周期目标（门族），on_behalf_of 记那次签发、外部确认时刻取原签发时刻；代记不带写入声明。 */
export function periodGoalConfirmAction(goal: WorldHead, plan: SignedPlan, principalId: string, key: string): WorldAction {
  return {
    action_type: "world_confirm_period_goal", contract_version: goal.contract_version, target: worldTarget(goal), expected_versions: [],
    idempotency_key: key,
    reason: `天枢 ${plan.period} 月度计划签发`,
    params: {
      outcome: "accepted",
      on_behalf_of: { principal_id: principalId, external_record_id: `tianshu:plan-sign:${plan.id}`, external_confirmed_at: shanghai(plan.confirmed_at) },
    },
  };
}

/**
 * 已签发的月度计划 → 本体同周期、company / E&O 域里「已承诺」的周期目标，代 CEO 确认（CEO 取人员名单里 ceo 角色的人）。
 * 签发后立即跑一次；本体晚于签发才承诺的目标由定时补跑接上。结果看 world_sync_ledger：成功或失败（委托没登记 / 失效等）的版本不再自动重试，
 * 失败照台账进管理员视图的失败列表；网络失败下一轮按原幂等键重放。
 */
export function createWorldPeriodGoalService(pool: Pool, client: WorldClient, ceoId: () => string | undefined, intervalMs = 10 * 60_000) {
  const q: Query = pool.query.bind(pool);
  let tail = Promise.resolve();
  let closed = false;
  const submit = (run: () => Promise<void>) => {
    if (closed) return;
    tail = tail.then(run).catch((error) => logEvent({ event: "world.period_goal", status: "failed", errorCode: worldErrorCode(error) }));
  };
  async function sync() {
    const plans = (await q("SELECT id, period, confirmed_at FROM monthly_plans WHERE status = 'confirmed' AND confirmed_at IS NOT NULL ORDER BY period")).rows as SignedPlan[];
    if (!plans.length) return;
    const ceo = ceoId();
    const principal = ceo ? client.config.people[ceo] : undefined;
    if (!principal) throw new WorldError(409, "INVALID_STATE", "人员名单里的 CEO 没有对应的本体主体");
    const domains = new Set([client.config.domains.company, client.config.domains.eo]);
    for (const plan of plans) {
      const goals = (await client.listObjects({ type: "PeriodGoal", period: plan.period }))
        .filter((goal) => goal.domain_id && domains.has(goal.domain_id) && lifecycleStatus(goal) === "committed");
      for (const listed of goals) {
        const key = periodGoalKey(plan.id, listed);
        const last = (await q("SELECT status FROM world_sync_ledger WHERE instance = $1 AND idempotency_key = $2 ORDER BY id DESC LIMIT 1", [client.instance, key])).rows[0];
        if (last?.status === "committed" || last?.status === "failed") continue;
        try {
          await client.write(key, async () => {
            const head = await client.getHead(listed.object_id);
            if (lifecycleStatus(head) !== "committed") throw new WorldError(409, "INVALID_STATE", `周期目标 ${head.object_id} 不在已承诺状态`);
            return periodGoalConfirmAction(head, plan, principal, key);
          });
          logEvent({ event: "world.period_goal", objectRef: `period-goal:${listed.object_id}`, status: "committed" });
        } catch (error) {
          logEvent({ event: "world.period_goal", objectRef: `period-goal:${listed.object_id}`, status: "failed", errorCode: worldErrorCode(error) });
        }
      }
    }
  }
  const timer = setInterval(() => submit(sync), intervalMs);
  timer.unref();
  submit(sync);
  return {
    /** 签发提交后调用；不阻塞签发返回。 */
    schedule(): void { submit(sync); },
    async idle(): Promise<void> { await tail; },
    async close(): Promise<void> { closed = true; clearInterval(timer); await tail; },
  };
}
export type WorldPeriodGoalService = ReturnType<typeof createWorldPeriodGoalService>;
