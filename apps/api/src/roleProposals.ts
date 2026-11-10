import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Query } from "./meetingStore.js";
import { roleProposalProblem, type RoleProposalAgent, type RoleProposalInput } from "./roleProposalAgent.js";
import type { RoleRow } from "./roles.js";
import type { HandbackRow } from "./taskCards.js";
import { taskStandards } from "./tasks.js";

/**
 * 提岗位修改（V2 设计第 19.4 节）的排队和落库：本人推翻验收（不论哪个方向）或同一张卡第二次没过时，在那个事务里记一条 drafting，
 * 提交后排一个轻模型作业（roleProposalAgent.ts）写出改哪个岗位、哪一段、改成什么；写完是 open，等本人采纳或不要。
 * 一张卡最多提一条（task_id 唯一），同一岗位同时最多 3 条待确认；作业没写成的标 failed，不给本人看。重启后 drafting 的接着写。
 */

const MAX_OPEN_PER_ROLE = 3;
const RUN_TIMEOUT_MS = 2 * 60_000;
const COLUMN = { dutiesMd: "duties_md", practiceMd: "practice_md", acceptanceMd: "acceptance_md" } as const;

/** 能改的岗位：卡的岗位；推翻时再加本人自己的验收员岗位（预设不能改）。 */
async function candidateRoles(q: Query, taskId: string, ownerId: string, sourceKind: "overrule" | "second_fail"): Promise<RoleRow[]> {
  const card = (await q(`SELECT r.* FROM tasks t JOIN roles r ON r.id=t.role_id WHERE t.id=$1 AND r.owner_id=$2 AND r.archived_at IS NULL`, [taskId, ownerId])).rows as RoleRow[];
  const reviewer = sourceKind === "overrule" ? (await q(`SELECT * FROM roles WHERE owner_id=$1 AND kind='reviewer' AND archived_at IS NULL ORDER BY created_at LIMIT 1`,
    [ownerId])).rows as RoleRow[] : [];
  return [...card, ...reviewer.filter((role) => !card.some((item) => item.id === role.id))];
}

const openCount = async (q: Query, roleId: string, except?: string) => Number((await q(`SELECT count(*) AS n FROM role_proposals
  WHERE role_id=$1 AND status IN ('drafting','open') AND id IS DISTINCT FROM $2`, [roleId, except ?? null])).rows[0].n);

/** 在调用方的事务里记一条要写的岗位修改；没有能改的岗位、这张卡提过了、岗位待确认的已经满 3 条时不记。返回要排队的 id。 */
export async function requestRoleProposal(client: PoolClient, input: { taskId: string; ownerId: string; sourceKind: "overrule" | "second_fail"; sourceId: string;
  reason: string | null }): Promise<string | null> {
  const q: Query = client.query.bind(client);
  const [role] = await candidateRoles(q, input.taskId, input.ownerId, input.sourceKind);
  if (!role || await openCount(q, role.id) >= MAX_OPEN_PER_ROLE) return null;
  const id = randomUUID();
  const inserted = await client.query(`INSERT INTO role_proposals(id,role_id,owner_id,task_id,source_kind,source_id,base_version,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (task_id) DO NOTHING`, [id, role.id, input.ownerId, input.taskId, input.sourceKind, input.sourceId, role.version, input.reason]);
  return inserted.rowCount ? id : null;
}

type ProposalRow = { id: string; owner_id: string; task_id: string; source_kind: "overrule" | "second_fail"; source_id: string; reason: string | null };

export function createRoleProposalQueue(options: { pool: Pool; agent: RoleProposalAgent; onError: (cause: unknown) => void }) {
  const running = new Map<string, Promise<void>>(), abort = new AbortController();
  const q: Query = options.pool.query.bind(options.pool);
  const failed = (id: string) => q("UPDATE role_proposals SET status='failed' WHERE id=$1 AND status='drafting'", [id]);

  async function draft(id: string) {
    const row = (await q("SELECT * FROM role_proposals WHERE id=$1 AND status='drafting'", [id])).rows[0] as ProposalRow | undefined;
    if (!row) return;
    try {
      const roles = await candidateRoles(q, row.task_id, row.owner_id, row.source_kind);
      const card = (await q("SELECT title,brief,done_definition FROM tasks WHERE id=$1", [row.task_id])).rows[0] as { title: string; brief: string | null; done_definition: string | null };
      const handback = (await q("SELECT * FROM card_handbacks WHERE id=$1", [row.source_id])).rows[0] as HandbackRow | undefined;
      if (!roles.length || !card || !handback) { await failed(id); return; }
      const input: RoleProposalInput = {
        sourceKind: row.source_kind, reason: row.reason,
        card: { title: card.title, brief: card.brief, standards: taskStandards(card.done_definition) },
        acceptance: { outcome: handback.outcome, criteria: (handback.result?.criteria ?? []).map((item) => ({ index: item.index, text: handback.criteria[item.index - 1] ?? "",
          verdict: item.verdict, reason: item.reason, fix: item.fix })) },
        roles: roles.map((role) => ({ id: role.id, name: role.name, kind: role.kind, dutiesMd: role.duties_md, practiceMd: role.practice_md, acceptanceMd: role.acceptance_md })),
      };
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]);
      const candidate = await Promise.race([options.agent.propose(input, { proposalId: id, personId: row.owner_id, signal }), new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })]);
      const problem = roleProposalProblem(candidate, input);
      if (problem) throw new Error(problem);
      const role = roles.find((item) => item.id === candidate.roleId)!;
      if (await openCount(q, role.id, id) >= MAX_OPEN_PER_ROLE) { await failed(id); return; }
      await q(`UPDATE role_proposals SET role_id=$2,base_version=$3,field=$4,proposed_text=$5,why=$6,status='open' WHERE id=$1 AND status='drafting'`,
        [id, role.id, role.version, COLUMN[candidate.field], candidate.proposedText.trim(), candidate.why.trim().slice(0, 200)]);
    } catch (cause) {
      // 关闭时留在 drafting，下次启动接着写；其余这次不提了。
      if (abort.signal.aborted) return;
      await failed(id);
      options.onError(cause);
    }
  }

  function enqueue(id: string): Promise<void> {
    if (abort.signal.aborted) return Promise.resolve();
    const existing = running.get(id); if (existing) return existing;
    const job = draft(id).catch(options.onError).finally(() => { running.delete(id); });
    running.set(id, job); return job;
  }
  return {
    enqueue,
    async recover() {
      for (const { id } of (await q("SELECT id FROM role_proposals WHERE status='drafting'")).rows) void enqueue(id);
    },
    async idle() { while (running.size) await Promise.all(running.values()); },
    async close() { abort.abort(); await Promise.all(running.values()); },
  };
}
export type RoleProposalQueue = ReturnType<typeof createRoleProposalQueue>;
