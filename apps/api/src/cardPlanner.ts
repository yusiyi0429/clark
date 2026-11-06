import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { Type, type Static } from "@sinclair/typebox";
import { runCandidateAgent, type CandidateThinkingLevel } from "./candidateAgentRuntime.js";
import type { Query } from "./meetingStore.js";
import { ADDRESS_STYLE } from "./promptStyle.js";
import type { OwnTask } from "./taskDeliverables.js";

/**
 * 拆卡（V2 设计第 8 节）：伙伴把一个 Task 拆成 3–8 张草稿卡，本人挑着放进看板。后台作业，写法照交付物评审的队列：
 * 进程内 Map，启动时和每分钟 recover；run_token 防旧的一次覆盖新的，running 超过 10 分钟重排；单次 5 分钟超时。
 */

export const CARD_PLAN_PROMPT = `# 角色

你是本人的伙伴。本人要把一个 Task 拆成几张卡（执行事项），每张卡交给一个执行方去做：claude_code 是在本人电脑上由 Claude Code 干，交回后由 Agent 按完成标准验收；self 是本人自己做。你出 3 到 8 张草稿卡，本人挑着放进看板。

# 输入

一个 JSON：task 是 Task 的名字、完成定义和标准（criteria，编号从 1 起）；mission 是所属 Mission 的名字和验收时间点（milestones）；existing 是这个 Task 下已有的卡（标题、对第几条、状态）；hint 是本人说的想怎么拆，有时没有。

# 怎么拆

- 每张卡是一件能交回、能验收的事，一两天内做得完。按标准拆：一条标准可以拆成几张，几条小标准也可以合成一张。
- 已有的卡做了的不再拆；标题不能和已有的卡一样，草稿之间也不能一样。
- criterionIndex：这张卡对的是第几条标准，哪条都对不上的写 null。
- title：要交付的结果，不超过 30 字，不写「完成……」「推进……」这类空话。
- brief：交代，写清要做什么、从哪里入手、产出写成什么（文件名、格式），不超过 600 字。
- standards：可检查的完成标准，每条一句，1 到 5 条，要能凭产出、链接、截图或改动核对。
- executor：能在电脑上靠文件、代码、网页完成的给 claude_code；要本人当面沟通、拍板、线下办的给 self。
- modelTier：要深想、长写、改代码的给 strong，一般的给 normal，整理、改格式、搬运的给 light。
- why：一句话说为什么这么拆，不超过 40 字。
- 有 hint 时照 hint 拆。

用 submit_candidate 提交，散文不会被保存。

${ADDRESS_STYLE}`;

const CardPlanCandidate = Type.Object({
  cards: Type.Array(Type.Object({
    title: Type.String({ minLength: 1, maxLength: 60 }),
    brief: Type.String({ maxLength: 1200 }),
    standards: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { minItems: 1, maxItems: 5 }),
    criterionIndex: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    executor: Type.Union([Type.Literal("claude_code"), Type.Literal("self")]),
    modelTier: Type.Union([Type.Literal("strong"), Type.Literal("normal"), Type.Literal("light")]),
    why: Type.String({ minLength: 1, maxLength: 100 }),
  }, { additionalProperties: false }), { minItems: 3, maxItems: 8 }),
}, { additionalProperties: false });
export type TCardPlanCandidate = Static<typeof CardPlanCandidate>;

export type CardPlanInput = {
  task: { name: string; doneDefinition: string | null; criteria: { index: number; text: string }[] };
  mission: { title: string; milestones: string[] };
  existing: { title: string; criterionIndex: number | null; status: string }[];
  hint?: string;
};
export type CardPlanAgent = { plan(input: CardPlanInput, options: { planId: string; personId: string; signal: AbortSignal }): Promise<TCardPlanCandidate> };

const normalTitle = (title: string) => title.replace(/\s+/g, "").toLowerCase();

/** 业务校验：编号在标准范围内；完成标准合起来放得进一件执行事项（500 字）；不和已有的卡、也不和彼此重名。 */
export function cardPlanProblem(candidate: TCardPlanCandidate, criteriaCount: number, existingTitles: string[]): string | null {
  const seen = new Set(existingTitles.map(normalTitle));
  for (const [position, card] of candidate.cards.entries()) {
    const n = position + 1;
    if (card.criterionIndex !== null && card.criterionIndex > criteriaCount)
      return criteriaCount ? `第 ${n} 张的 criterionIndex 只能是 1 到 ${criteriaCount} 或 null` : `这个 Task 没有标准，第 ${n} 张的 criterionIndex 写 null`;
    if (card.standards.map((line) => line.trim()).filter(Boolean).join("\n").length > 500) return `第 ${n} 张的完成标准合起来超过 500 字，写短一些`;
    if (!card.standards.some((line) => line.trim())) return `第 ${n} 张至少要有一条完成标准`;
    if (seen.has(normalTitle(card.title))) return `第 ${n} 张「${card.title}」和已有的卡或前面的草稿重名`;
    seen.add(normalTitle(card.title));
  }
  return null;
}

const THINKING_LEVELS = new Set<CandidateThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
export type BoardModelOptions = { query: Query; baseUrl: string; apiKey: string; modelId: string; thinking?: string };
export const boardModel = (options: BoardModelOptions) => {
  const level = options.thinking?.trim().toLowerCase() as CandidateThinkingLevel | undefined;
  return { query: options.query, baseUrl: options.baseUrl, apiKey: options.apiKey, modelId: options.modelId,
    thinkingLevel: level && THINKING_LEVELS.has(level) ? level : "medium" as const };
};

export function createCardPlanAgent(options: BoardModelOptions): CardPlanAgent {
  return {
    async plan(input, { planId, personId, signal }) {
      return (await runCandidateAgent({ ...boardModel(options), kind: "card_plan", objectRef: { type: "card_plan", id: planId }, personId, input,
        prompt: CARD_PLAN_PROMPT, schema: CardPlanCandidate, signal, maxModelCalls: 4,
        validate: (candidate) => cardPlanProblem(candidate, input.task.criteria.length, input.existing.map((card) => card.title)) })).candidate;
    },
  };
}

const RUN_TIMEOUT_MS = 5 * 60_000;
const STALE_MS = 10 * 60_000;
const PLAN_FAILED = "拆卡没做完，可以重试";

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
      const input: CardPlanInput = {
        task: { name: own.task.name, doneDefinition: own.task.doneDefinition, criteria: own.criteria.map((text, index) => ({ index: index + 1, text })) },
        mission: { title: mission?.title ?? "", milestones: mission?.milestones ?? [] }, existing: [...existing, ...openDrafts], ...(row.hint ? { hint: row.hint } : {}),
      };
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]);
      const candidate = await Promise.race([options.agent.plan(input, { planId, personId: row.owner_id, signal }), new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })]);
      const problem = cardPlanProblem(candidate, input.task.criteria.length, input.existing.map((card) => card.title));
      if (problem) throw new Error(problem);
      const client = await options.pool.connect();
      try {
        await client.query("BEGIN");
        const done = await client.query(`UPDATE card_plans SET status='done',finished_at=$3 WHERE ${guard}`, [planId, token, options.now()]);
        if (done.rowCount) for (const [position, card] of candidate.cards.entries())
          await client.query(`INSERT INTO card_drafts(id,plan_id,plan_task_id,owner_id,position,title,brief,done_definition,criterion_index,executor,model_tier,why)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [randomUUID(), planId, row.plan_task_id, row.owner_id, position, card.title.trim().slice(0, 120),
            card.brief.trim().slice(0, 4000), card.standards.map((line) => line.trim()).filter(Boolean).join("\n"), card.criterionIndex, card.executor, card.modelTier,
            card.why.trim().slice(0, 200)]);
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
