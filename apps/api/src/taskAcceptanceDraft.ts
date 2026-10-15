import { Type } from "@sinclair/typebox";
import type { Pool } from "pg";
import type { TTaskAcceptanceDraft } from "@warmap/contracts";
import { runCandidateAgent } from "./candidateAgentRuntime.js";
import type { AppEnv } from "./app.js";
import type { Query } from "./meetingStore.js";
import { taskStandards } from "./tasks.js";
import { ADDRESS_STYLE } from "./promptStyle.js";

/** 起草验收看到的东西：完成标准、材料正文摘录、最近的进展；只读。 */
export type AcceptanceDraftInput = {
  title: string;
  standards: { index: number; text: string }[];
  materials: { id: string; name: string; format: string; url: string | null; excerpt: string }[];
  progress: { author: string; source: string; at: string; body: string; links: string[] }[];
  judgment: string | null;
  meetingQuote: string | null;
};
export type TaskAcceptanceAgent = {
  draft(input: AcceptanceDraftInput, ref: { taskId: string; personId: string }, signal: AbortSignal): Promise<TTaskAcceptanceDraft>;
};

const Candidate = Type.Object({
  standards: Type.Array(Type.Object({
    index: Type.Integer({ minimum: 0, maximum: 49 }),
    met: Type.Boolean(),
    evidence: Type.String({ minLength: 1, maxLength: 300 }),
    materialId: Type.Union([Type.String(), Type.Null()]),
  }, { additionalProperties: false }), { maxItems: 50 }),
  verdict: Type.String({ minLength: 1, maxLength: 200 }),
  deliverableMaterialIds: Type.Array(Type.String(), { maxItems: 30 }),
}, { additionalProperties: false });

export const TASK_ACCEPTANCE_PROMPT = `你替推进人起草一件执行事项的验收，只调用 submit_candidate 提交 {standards, verdict, deliverableMaterialIds}。
- 对输入 standards 里的每一条完成标准（按 index）判断是否已经达到。只依据输入里的材料摘录和进展；找不到依据就判没达到，不推测、不编造。
- evidence 写一句依据：引用材料名或进展里的原话。依据来自某份材料时 materialId 填那份材料的 id，否则填 null。
- verdict 用一句中文写这件事交付了什么，不超过 80 字，只写事实，不写套话。
- deliverableMaterialIds 选应作为交付结果的材料（最终版文档、成品链接）；草稿和参考资料不选，拿不准就不选。
- 没有完成标准时 standards 交空数组，只写 verdict 和交付结果。

${ADDRESS_STYLE}`;

export function createTaskAcceptanceAgent(pool: Pool, env: AppEnv): TaskAcceptanceAgent {
  return { async draft(input, ref, signal) {
    const result = await runCandidateAgent({
      query: pool.query.bind(pool), kind: "task-acceptance-draft", objectRef: { type: "task", id: ref.taskId }, personId: ref.personId,
      input, prompt: TASK_ACCEPTANCE_PROMPT, schema: Candidate, baseUrl: env.piBaseUrl, apiKey: env.piApiKey,
      modelId: env.lightModel, modelSlot: "light", signal,
    });
    return result.candidate;
  } };
}

const EXCERPT_CHARS = 6_000;
const TOTAL_CHARS = 30_000;
const plainText = (html: string) => html.replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** 推进人打开验收时的草稿：没有推进人身份返回 not_found；已完成或已退回返回 closed；模型失败或超时返回 null（手填照样能验收）。 */
export async function draftTaskAcceptance(pool: Pool, agent: TaskAcceptanceAgent, taskId: string, ownerId: string,
  names: Map<string, string>, timeoutMs = 30_000): Promise<TTaskAcceptanceDraft | "not_found" | "closed" | null> {
  const q: Query = (sql, params) => pool.query(sql, params);
  const task = (await q(`SELECT t.title,t.status,t.done_definition,t.judgment,t.source_quote FROM tasks t WHERE t.id::text=$1 AND t.owner_id=$2`,
    [taskId, ownerId])).rows[0] as { title: string; status: string; done_definition: string | null; judgment: string | null; source_quote: string | null } | undefined;
  if (!task) return "not_found";
  if (task.status === "done" || task.status === "returned") return "closed";
  const standards = taskStandards(task.done_definition);
  const rows = (await q(`SELECT m.id::text,m.file_name,m.format,m.url,r.body FROM object_materials m
    JOIN material_revisions r ON r.material_id=m.id AND r.version=m.current_version
    WHERE m.object_type='task' AND m.object_id=$1 AND m.deleted_at IS NULL ORDER BY m.created_at,m.id`, [taskId])).rows as
    { id: string; file_name: string; format: string; url: string | null; body: string }[];
  let budget = TOTAL_CHARS;
  const materials = rows.map((row) => {
    const text = row.format === "link" ? "" : row.format === "html" ? plainText(row.body) : row.body;
    const excerpt = text.slice(0, Math.max(0, Math.min(EXCERPT_CHARS, budget)));
    budget -= excerpt.length;
    return { id: row.id, name: row.file_name, format: row.format, url: row.url, excerpt };
  });
  const progress = ((await q(`SELECT author_id,source,body,links,created_at FROM task_progress WHERE task_id=$1
    ORDER BY created_at DESC,id DESC LIMIT 20`, [taskId])).rows as { author_id: string; source: string; body: string; links: { url: string }[]; created_at: Date }[])
    .map((row) => ({ author: names.get(row.author_id) ?? row.author_id, source: row.source, at: row.created_at.toISOString(), body: row.body, links: row.links.map((link) => link.url) }));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("acceptance draft timed out")), timeoutMs);
  try {
    const draft = await Promise.race([
      agent.draft({ title: task.title, standards: standards.map((text, index) => ({ index, text })), materials, progress,
        judgment: task.judgment, meetingQuote: task.source_quote }, { taskId, personId: ownerId }, abort.signal),
      new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("acceptance draft timed out")), { once: true })),
    ]);
    // 只留指向这件事真实存在的标准和材料的判断；其余丢掉，不让一条坏数据废掉整份草稿。
    const ids = new Set(rows.map((row) => row.id));
    const seen = new Set<number>();
    return {
      verdict: draft.verdict?.trim() || null,
      standards: draft.standards.filter((check) => {
        if (check.index >= standards.length || seen.has(check.index)) return false;
        seen.add(check.index);
        return true;
      }).map((check) => ({ index: check.index, met: check.met, evidence: check.evidence?.trim() || null,
          materialId: check.materialId && ids.has(check.materialId) ? check.materialId : null })),
      deliverableMaterialIds: [...new Set(draft.deliverableMaterialIds)].filter((id) => ids.has(id)),
    };
  } catch { return null; }
  finally { clearTimeout(timer); }
}
