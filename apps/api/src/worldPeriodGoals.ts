import type { Pool } from "pg";
import type { Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import { WorldClient, WorldError, worldErrorCode, worldTarget, type WorldAction, type WorldHead } from "./worldClient.js";
import { battlefieldIdOf } from "./worldReader.js";

type SignedPlan = { id: string; period: string; confirmed_at: Date };
type WorldEvent = Record<string, unknown>;

const shanghai = (at: Date) => new Date(at.getTime() + 8 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "+08:00");
const lifecycleOf = (head: WorldHead) => (head.lifecycle ?? {}) as { status?: string; event_id?: string };
const signRecordId = (plan: Pick<SignedPlan, "id">) => `tianshu:plan-sign:${plan.id}`;
const recordedBy = (event: WorldEvent, at: Date) => typeof event.recorded_at === "string" && new Date(event.recorded_at).getTime() <= at.getTime();
async function eventsOf(client: WorldClient, id: string): Promise<WorldEvent[]> {
  const read = await client.getEvents(id);
  return read.events ?? read.items ?? [];
}

/**
 * 只代确认 CEO 签发时的那一版：已承诺期间正式内容不能改，推出「已承诺」的承诺事件记在签发之前，当前版本就是签发时的那一版；
 * 或者这条承诺就是天枢按这次签发代 RU DRI 记的（承诺的是签发时那一版草稿）。
 * 签发之后另行承诺（含退回后重新承诺）的不代确认，交 CEO 本人。
 */
async function committedForSign(client: WorldClient, goal: WorldHead, plan: SignedPlan): Promise<boolean> {
  const eventId = lifecycleOf(goal).event_id;
  if (!eventId) return false;
  const commit = (await eventsOf(client, goal.object_id)).find((event) => event.event_id === eventId);
  if (!commit) return false;
  return recordedBy(commit, plan.confirmed_at) || (commit.external_confirmation as { external_record_id?: string } | null | undefined)?.external_record_id === signRecordId(plan);
}

/** 只代承诺签发时的那一版草稿：推出草稿的事件（建对象或退回）和每次修订都记在签发之前；签发之后改过、退回的交 RU DRI 本人。 */
async function draftAtSign(client: WorldClient, goal: WorldHead, signedAt: Date): Promise<boolean> {
  const eventId = lifecycleOf(goal).event_id;
  if (!eventId) return false;
  const shaping = (await eventsOf(client, goal.object_id)).filter((event) => event.event_id === eventId || event.kind === "object.revised");
  return shaping.some((event) => event.event_id === eventId) && shaping.every((event) => recordedBy(event, signedAt));
}

/**
 * 各域的 RU DRI：本体里该域挂天枢战场（外部引用 battlefield:<id>）的责任单元，取天枢里这个战场的 DRI。
 * 同一域对上不止一位就记 null，不猜。
 */
async function unitDris(client: WorldClient, q: Query): Promise<Map<string, string | null>> {
  const owners = new Map((await q("SELECT id, owner_id FROM battlefield_config")).rows.map((row) => [row.id as string, row.owner_id as string]));
  const dris = new Map<string, string | null>();
  for (const unit of await client.listObjects({ type: "ResponsibilityUnit" })) {
    const battlefieldId = battlefieldIdOf(unit);
    const owner = battlefieldId ? owners.get(battlefieldId) : undefined;
    if (!unit.domain_id || !owner) continue;
    dris.set(unit.domain_id, dris.has(unit.domain_id) && dris.get(unit.domain_id) !== owner ? null : owner);
  }
  return dris;
}

/** 一个目标版本一个键：同一版本只试一次，网络失败按这个键重放；目标重新承诺（版本变了）才再试。 */
export const periodGoalKey = (planId: string, goal: Pick<WorldHead, "object_id" | "object_version">) =>
  `tianshu:plan-sign:${planId}:${goal.object_id}:${goal.object_version}`;
/** 代承诺的键：同代确认，另标 commit。 */
const periodGoalCommitKey = (planId: string, goal: Pick<WorldHead, "object_id" | "object_version">) =>
  `tianshu:plan-sign:${planId}:commit:${goal.object_id}:${goal.object_version}`;

/** 代记那次签发：外部记录取签发记录，外部确认时刻取原签发时刻。 */
const onBehalfOf = (plan: SignedPlan, principalId: string) =>
  ({ principal_id: principalId, external_record_id: signRecordId(plan), external_confirmed_at: shanghai(plan.confirmed_at) });

/** 契约 0.3 第 10.3、14 节：代 RU DRI 承诺周期目标（门族），不带候选（承诺签发时那一版草稿）；代记不带写入声明。 */
export function periodGoalCommitAction(goal: WorldHead, plan: SignedPlan, principalId: string, key: string): WorldAction {
  return {
    action_type: "world_commit_period_goal", contract_version: goal.contract_version, target: worldTarget(goal), expected_versions: [],
    idempotency_key: key,
    reason: `天枢 ${plan.period} 月度计划签发`,
    params: { on_behalf_of: onBehalfOf(plan, principalId) },
  };
}

/** 契约 0.3 第 10.3、14 节：代 CEO 确认周期目标（门族），on_behalf_of 记那次签发、外部确认时刻取原签发时刻；代记不带写入声明。 */
export function periodGoalConfirmAction(goal: WorldHead, plan: SignedPlan, principalId: string, key: string): WorldAction {
  return {
    action_type: "world_confirm_period_goal", contract_version: goal.contract_version, target: worldTarget(goal), expected_versions: [],
    idempotency_key: key,
    reason: `天枢 ${plan.period} 月度计划签发`,
    params: { outcome: "accepted", on_behalf_of: onBehalfOf(plan, principalId) },
  };
}

/**
 * 最近一份已签发的月度计划（只代记当月）→ 本体同周期、各单元的周期目标：
 * 先把签发时那一版草稿代 RU DRI（天枢里挂这个域的战场 DRI）承诺，再把「已承诺」、承诺在签发之前或就是这次代记的目标代 CEO 确认
 * （CEO 取人员名单里 ceo 角色的人）。签发后立即跑一次，另定时补跑（签发时本体不通、部署前已签发）。
 * 结果看 world_sync_ledger：成功或失败（委托没登记 / 失效、版本对不上等）的版本不再自动重试，失败照台账进管理员视图的失败列表；
 * 网络失败下一轮按原幂等键重放。
 */
export function createWorldPeriodGoalService(pool: Pool, client: WorldClient, ceoId: () => string | undefined, intervalMs = 10 * 60_000) {
  const q: Query = pool.query.bind(pool);
  let tail = Promise.resolve();
  let closed = false;
  const submit = (run: () => Promise<void>) => {
    if (closed) return;
    tail = tail.then(run).catch((error) => logEvent({ event: "world.period_goal", status: "failed", errorCode: worldErrorCode(error) }));
  };
  const settled = async (key: string) => {
    const last = (await q("SELECT status FROM world_sync_ledger WHERE instance = $1 AND idempotency_key = $2 ORDER BY id DESC LIMIT 1", [client.instance, key])).rows[0];
    return last?.status === "committed" || last?.status === "failed";
  };
  /** 代 RU DRI 承诺草稿；返回是否写进了至少一条。 */
  async function commitDrafts(plan: SignedPlan, goals: WorldHead[]): Promise<boolean> {
    const drafts = goals.filter((goal) => lifecycleOf(goal).status === "draft");
    if (!drafts.length) return false;
    const dris = await unitDris(client, q);
    let committed = false;
    for (const listed of drafts) {
      const log = (status: string, errorCode?: string) =>
        logEvent({ event: "world.period_goal", actionType: "world_commit_period_goal", objectRef: `period-goal:${listed.object_id}`, status, errorCode });
      const dri = listed.domain_id ? dris.get(listed.domain_id) : undefined;
      const principal = dri ? client.config.people[dri] : undefined;
      if (!principal) { log("skipped", "NO_UNIT_DRI"); continue; }
      const key = periodGoalCommitKey(plan.id, listed);
      if (await settled(key)) continue;
      try {
        if (!await draftAtSign(client, listed, plan.confirmed_at)) { log("skipped", "CHANGED_AFTER_SIGN"); continue; }
        await client.write(key, async () => {
          // 版本过期时 WorldClient 会重取再写；草稿已不是签发时那一版就停，不承诺新版本。
          const head = await client.getHead(listed.object_id);
          if (lifecycleOf(head).status !== "draft" || head.object_version !== listed.object_version) {
            throw new WorldError(409, "INVALID_STATE", `周期目标 ${head.object_id} 已不是签发时那一版草稿`);
          }
          return periodGoalCommitAction(head, plan, principal, key);
        });
        committed = true;
        log("committed");
      } catch (error) {
        log("failed", worldErrorCode(error));
      }
    }
    return committed;
  }
  async function sync() {
    const plan = (await q("SELECT id, period, confirmed_at FROM monthly_plans WHERE status = 'confirmed' AND confirmed_at IS NOT NULL ORDER BY period DESC LIMIT 1")).rows[0] as SignedPlan | undefined;
    if (!plan) return;
    const ceo = ceoId();
    const principal = ceo ? client.config.people[ceo] : undefined;
    if (!principal) throw new WorldError(409, "INVALID_STATE", "人员名单里的 CEO 没有对应的本体主体");
    // 不按域筛：委托没覆盖的域由本体拒（403），如实记失败。
    const list = () => client.listObjects({ type: "PeriodGoal", period: plan.period });
    const listedGoals = await list();
    const goals = (await commitDrafts(plan, listedGoals) ? await list() : listedGoals)
      .filter((goal) => lifecycleOf(goal).status === "committed");
    for (const listed of goals) {
      const key = periodGoalKey(plan.id, listed);
      if (await settled(key)) continue;
      try {
        if (!await committedForSign(client, listed, plan)) {
          logEvent({ event: "world.period_goal", objectRef: `period-goal:${listed.object_id}`, status: "skipped", errorCode: "COMMITTED_AFTER_SIGN" });
          continue;
        }
        await client.write(key, async () => {
          // 版本过期时 WorldClient 会重取再写；目标已不是签发时那一版就停，不确认新版本。
          const head = await client.getHead(listed.object_id);
          if (lifecycleOf(head).status !== "committed" || head.object_version !== listed.object_version) {
            throw new WorldError(409, "INVALID_STATE", `周期目标 ${head.object_id} 已不是签发时已承诺的那一版`);
          }
          return periodGoalConfirmAction(head, plan, principal, key);
        });
        logEvent({ event: "world.period_goal", objectRef: `period-goal:${listed.object_id}`, status: "committed" });
      } catch (error) {
        logEvent({ event: "world.period_goal", objectRef: `period-goal:${listed.object_id}`, status: "failed", errorCode: worldErrorCode(error) });
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
