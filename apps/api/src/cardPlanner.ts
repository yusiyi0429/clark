import { randomUUID } from "node:crypto";
import { checkedWords, latestSplitWords, localPlanSequence } from "./sourceWords.js";
import type { Pool, PoolClient } from "pg";
import type { TLocalCardPlan } from "@warmap/contracts";
import { cardPlanProblem, type CardPlanAgent, type CardPlanInput } from "./cardPlanAgent.js";
import type { Query } from "./meetingStore.js";
import { isPlannerRole, type RoleRow } from "./roles.js";
import type { OwnTask } from "./taskDeliverables.js";

/**
 * 拆卡（V2 设计第 8 节）的排队和存草稿：伙伴（cardPlanAgent.ts 的作业）把一个 Task 拆成 3–8 张草稿卡，本人挑着放进看板。
 * 写法照交付物评审的队列：进程内 Map，启动时和每分钟 recover；run_token 防旧的一次覆盖新的，running 超过 10 分钟重排；单次 5 分钟超时。
 */

const RUN_TIMEOUT_MS = 5 * 60_000;
const STALE_MS = 10 * 60_000;
const PLAN_FAILED = "拆卡没做完，可以重试";
const DUTIES_CHARS = 200;

type PlanRow = { id: string; plan_task_id: string; mission_id: string; owner_id: string; hint: string | null };

/** planTask：按推进人读这个 Task（本人 Mission 下的），读不到时这次拆卡算失败。 */
export function createCardPlanQueue(options: { pool: Pool; agent: CardPlanAgent; now: () => Date; onError: (cause: unknown) => void;
  planTask: (ownerId: string, planTaskId: string) => Promise<OwnTask | null> }) {
  const running = new Map<string, Promise<void>>(), abort = new AbortController();
  const q: Query = options.pool.query.bind(options.pool);
  const stale = () => new Date(options.now().getTime() - STALE_MS);

  async function plan(planId: string) {
    const token = randomUUID();
    const row = (await q(`UPDATE card_plans SET status='running',run_token=$2,started_at=$3,finished_at=NULL,error=NULL
      WHERE id=$1 AND (status='queued' OR (status='running' AND (run_token IS NULL OR started_at<$4))) RETURNING *`,
    [planId, token, options.now(), stale()])).rows[0] as PlanRow | undefined;
    if (!row) return;
    const guard = "id=$1 AND run_token=$2 AND status='running'";
    try {
      const own = await options.planTask(row.owner_id, row.plan_task_id);
      if (!own) throw new Error("读不到这个 Task");
      const mission = (await q("SELECT title,milestones FROM missions WHERE id=$1", [row.mission_id])).rows[0] as { title: string; milestones: string[] } | undefined;
      const existing = (await q(`SELECT title,criterion_index,status FROM tasks WHERE plan_task_id=$1 AND owner_id=$2 AND status<>'returned' ORDER BY created_at`,
        [row.plan_task_id, row.owner_id])).rows.map((item) => ({ title: item.title as string, criterionIndex: item.criterion_index as number | null, status: item.status as string }));
      const openDrafts = (await q("SELECT title FROM card_drafts WHERE plan_task_id=$1 AND owner_id=$2 AND status='open'", [row.plan_task_id, row.owner_id]))
        .rows.map((item) => ({ title: item.title as string, criterionIndex: null, status: "draft" }));
      // 本人团队里干活的岗位，和还没加的干活预设（没有合适岗位时建议加哪个）。
      const roles = ((await q(`SELECT * FROM roles WHERE kind='worker' AND archived_at IS NULL AND (owner_id=$1 OR owner_id IS NULL) ORDER BY created_at,preset_key`,
        [row.owner_id])).rows as RoleRow[]).filter((role) => !isPlannerRole(role));
      const team = roles.filter((role) => role.owner_id === row.owner_id);
      const added = new Set(team.flatMap((role) => role.preset_key ? [role.preset_key] : []));
      const input: CardPlanInput = {
        task: { name: own.task.name, doneDefinition: own.task.doneDefinition, criteria: own.criteria.map((text, index) => ({ index: index + 1, text })) },
        mission: { title: mission?.title ?? "", milestones: mission?.milestones ?? [] }, existing: [...existing, ...openDrafts],
        roles: team.map((role) => ({ id: role.id, name: role.name, duties: role.duties_md.slice(0, DUTIES_CHARS) })),
        presets: roles.filter((role) => role.owner_id === null && !added.has(role.preset_key!))
          .map((role) => ({ key: role.preset_key!, name: role.name, duties: role.duties_md.slice(0, DUTIES_CHARS) })),
        ...(row.hint ? { hint: row.hint } : {}),
      };
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]);
      const candidate = await Promise.race([options.agent.plan(input, { planId, personId: row.owner_id, signal }), new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })]);
      const problem = cardPlanProblem(candidate, input);
      if (problem) throw new Error(problem);
      const tierOf = (card: (typeof candidate.cards)[number]) => roles.find((role) => role.id === card.roleId)?.model_tier
        ?? roles.find((role) => role.owner_id === null && role.preset_key === card.suggestPresetKey)?.model_tier ?? "normal";
      const client = await options.pool.connect();
      try {
        await client.query("BEGIN");
        const done = await client.query(`UPDATE card_plans SET status='done',finished_at=$3 WHERE ${guard}`, [planId, token, options.now()]);
        if (done.rowCount) for (const [position, card] of candidate.cards.entries())
          await client.query(`INSERT INTO card_drafts(id,plan_id,plan_task_id,owner_id,position,title,brief,done_definition,criterion_index,executor,model_tier,why,role_id,suggest_preset_key)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [randomUUID(), planId, row.plan_task_id, row.owner_id, position, card.title.trim().slice(0, 120),
            card.brief.trim().slice(0, 4000), card.standards.map((line) => line.trim()).filter(Boolean).join("\n"), card.criterionIndex, card.executor, tierOf(card),
            card.why.trim().slice(0, 200), card.roleId, card.roleId ? null : card.suggestPresetKey]);
        await client.query("COMMIT");
      } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
      finally { client.release(); }
    } catch (cause) {
      // 关闭时放回队列，下次启动接着拆；其余算这次没拆完。
      await q(abort.signal.aborted ? `UPDATE card_plans SET status='queued',run_token=NULL WHERE ${guard}`
        : `UPDATE card_plans SET status='failed',error=$3,finished_at=$4 WHERE ${guard}`,
      abort.signal.aborted ? [planId, token] : [planId, token, PLAN_FAILED, options.now()]);
      if (!abort.signal.aborted) options.onError(cause);
    }
  }

  function enqueue(planId: string): Promise<void> {
    if (abort.signal.aborted) return Promise.resolve();
    const existing = running.get(planId); if (existing) return existing;
    const job = plan(planId).catch(options.onError).finally(() => { running.delete(planId); });
    running.set(planId, job); return job;
  }
  return {
    enqueue,
    async recover() {
      const rows = await q(`SELECT id FROM card_plans WHERE status='queued' OR (status='running' AND (run_token IS NULL OR started_at<$1))`, [stale()]);
      for (const { id } of rows.rows) void enqueue(id);
    },
    async idle() { while (running.size) await Promise.all(running.values()); },
    async close() { abort.abort(); await Promise.all(running.values()); },
  };
}
export type CardPlanQueue = ReturnType<typeof createCardPlanQueue>;

/**
 * 本机规划员报上来的计划和派活单（同步条目 card_plan，V2 第 21 节）：一次规划会话一行 card_plans（source=local，run_id），落下就是拆完的。
 * 本人让它改、再出一次（revision 更大）时换上新的计划，上一次还没处理的草稿收起来，新草稿接在后面；晚到的旧一次不收（返回 false）。
 * 岗位按本人团队里的 id、名字或预设 key 对，对不上再按预设的 key 或名字建议加哪个；对约定第几条超出范围的当没对上。
 */
/** 派活单挂哪：拆 Task 的带 taskId、missionId 和验收标准；拆项目（16.3）的只带 projectId，criteria 为空（对约定第几条一律不存）。
 * 每件的原话（16.8）按这个 Task 或项目最近一次登记拆卡存下的原话核对（sourceWords.ts 的 checkedWords）。 */
export type PlanTarget = { taskId: string | null; missionId: string | null; projectId: string | null; criteria: string[] };

/** currentSequence：同步时读的项目对话现在最后一条，第一次建派活单、不是照登记开的时候记它（见 localPlanSequence）。 */
export async function saveLocalCardPlan(client: PoolClient, input: { ownerId: string; runId: string; target: PlanTarget; plan: TLocalCardPlan; at: Date;
  currentSequence?: number | null }): Promise<boolean> {
  const { ownerId, runId, target, plan, at } = input;
  const existing = (await client.query("SELECT id,revision FROM card_plans WHERE run_id=$1 FOR UPDATE", [runId])).rows[0] as { id: string; revision: number } | undefined;
  if (existing && existing.revision >= plan.revision) return false;
  // 可空的文字经接口校验会变成空串（Fastify 的类型转换），空串当没写。
  const steps = plan.steps.map(({ title, detail }) => ({ title: title.trim(), detail: detail?.trim() || null }));
  const values = [plan.revision, plan.summary.trim(), JSON.stringify(steps), JSON.stringify(plan.risks), plan.modelLabel.trim() || null, plan.roleId, plan.roleVersion, at];
  const planId = existing?.id ?? randomUUID();
  if (existing) {
    await client.query(`UPDATE card_plans SET revision=$2,summary=$3,steps=$4::jsonb,risks=$5::jsonb,model_label=$6,role_id=$7,role_version=$8,finished_at=$9 WHERE id=$1`,
      [planId, ...values]);
    await client.query("UPDATE card_drafts SET status='dismissed',decided_at=$2 WHERE plan_id=$1 AND status='open'", [planId, at]);
  } else {
    // 开拆那一下的序号（17.2 第 29 条）：照登记开的用登记记的，直接开的用现在项目对话的最后一条。
    await client.query(`INSERT INTO card_plans(id,plan_task_id,mission_id,owner_id,status,source,run_id,revision,summary,steps,risks,model_label,role_id,role_version,finished_at,project_id,
      after_sequence) VALUES($1,$2,$3,$4,'done','local',$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15)`,
    [planId, target.taskId, target.missionId, ownerId, runId, ...values, target.taskId ? null : target.projectId,
      await localPlanSequence(client.query.bind(client), ownerId, target, planId, input.currentSequence ?? null)]);
  }
  const roles = (await client.query(`SELECT * FROM roles WHERE kind='worker' AND archived_at IS NULL AND (owner_id=$1 OR owner_id IS NULL) ORDER BY created_at,preset_key`,
    [ownerId])).rows as RoleRow[];
  const roleOf = (ref: string | null) => {
    const name = ref?.trim();
    if (!name) return { roleId: null, preset: null };
    const mine = roles.find((role) => role.owner_id === ownerId && (role.id === name || role.name === name || role.preset_key === name));
    if (mine) return { roleId: mine.id, preset: null };
    return { roleId: null, preset: roles.find((role) => role.owner_id === null && (role.preset_key === name || role.name === name))?.preset_key ?? null };
  };
  const start = (await client.query("SELECT coalesce(max(position)+1,0)::int AS n FROM card_drafts WHERE plan_id=$1", [planId])).rows[0].n as number;
  const originals = await latestSplitWords(client.query.bind(client), ownerId, target);
  // 本人对用什么模型的要求原话（第 69 条）：登记上带的，原样拷到这次的每张草稿上。
  const modelWords = ((await client.query(`SELECT model_words FROM card_split_requests WHERE owner_id=$1 AND ${target.taskId ? "plan_task_id=$2" : "project_id=$2 AND plan_task_id IS NULL"}
    ORDER BY created_at DESC,id DESC LIMIT 1`, [ownerId, target.taskId ?? target.projectId])).rows[0]?.model_words as string | null | undefined) ?? null;
  // 先后（after）是这次派活单里的位置（从 1 起），存成那几张草稿的 id。
  const ids = plan.cards.map(() => randomUUID());
  for (const [position, card] of plan.cards.entries()) {
    const { roleId, preset } = roleOf(card.role);
    const index = card.criterionIndex && target.criteria[card.criterionIndex - 1] ? card.criterionIndex : null;
    await client.query(`INSERT INTO card_drafts(id,plan_id,plan_task_id,owner_id,position,title,brief,done_definition,criterion_index,executor,model_tier,why,role_id,suggest_preset_key,
      after_draft_ids,project_id,source_words,model_words) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'claude_code',$10,$11,$12,$13,$14::uuid[],$15,$16::jsonb,$17)`, [ids[position], planId, target.taskId, ownerId, start + position, card.title.trim(),
      card.brief.trim(), standardLines(card.doneDefinition), index, card.modelTier, card.why?.trim() || null, roleId, preset,
      [...new Set(card.after ?? [])].map((after) => ids[after - 1]), target.taskId ? null : target.projectId, JSON.stringify(checkedWords(originals, card.sourceWords)),
      modelWords]);
  }
  return true;
}

/** 完成标准按行去空白、去空行。 */
export const standardLines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
