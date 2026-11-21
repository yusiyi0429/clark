import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool } from "pg";
import type { Query } from "./meetingStore.js";
import type { PlanTaskSource } from "./planTasks.js";
import type { PlanTaskViewer } from "./planTaskAccess.js";
import { agreementSnapshot, checkTask, openPlanTask } from "./taskAgreements.js";
import { createDeliverableVersion, DeliverableError, parseDeliverableFields } from "./taskDeliverables.js";

/**
 * 约定与对表的三个 MCP 工具（设计 v0.2 第 9 节）：get_task_agreement、check_task 只读，和网页同一份；
 * add_deliverable_version 是写工具（在 MCP_WRITE_TOOLS 里），只在本人要求时交一版链接，交完自动参考评审。文件还是从网页传。
 * 成员和 CEO 都列；谁能看、谁能交由 taskAgreements.openPlanTask 判（交只有负责人）。
 */

const TaskInput = Type.Object({ taskId: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });
const AddVersionInput = Type.Object({
  taskId: Type.String({ minLength: 1, maxLength: 200 }),
  links: Type.Array(Type.String({ pattern: "^[Hh][Tt][Tt][Pp][Ss]?://", maxLength: 2000 }), { minItems: 1, maxItems: 5 }),
  note: Type.Optional(Type.String({ maxLength: 2000 })),
}, { additionalProperties: false });

export const agreementDefinitions: Tool[] = [
  { name: "get_task_agreement", description: "读一个 Task 的约定：每条验收标准用什么证明（proof）、谁来认（acceptor，空表示有证据就算数），这次不包括什么（exclusions）；source 是来自本体（world）、天枢 11 月的补充（tianshu）还是只有标准原文（none），basisChanged 是标准改过。taskId 取 list_my_items 里 missions[].tasks 的 taskId。Read a plan task's agreement: proof and acceptor per criterion, exclusions, and where it came from.", inputSchema: TaskInput as Tool["inputSchema"], annotations: { readOnlyHint: true } },
  { name: "check_task", description: "对表，和天枢网页上点「对表」一样：把约定和最新一版交付物的参考评审摆在一起，每条标出 evidenced 有证据、gap 差（gap 写差什么）、reviewing 评审中、no_deliverable 还没交付物、needs_acceptor 要别人确认之一；conclusion 是两种结论之一（还不能交 / 可以交），notices 是标准改过、约定没补全的提示，beyondScope 是约定外的建议、不算差。不调模型、不改任何东西；交付由本人在天枢点。Check a plan task against its agreement (same as the web).", inputSchema: TaskInput as Tool["inputSchema"], annotations: { readOnlyHint: true } },
  { name: "add_deliverable_version", description: "只在本人要求时用：给本人负责的 Task 交一版交付物，links 是做出来的东西的链接（http/https，最多 5 个），note 是附的一句话；沿用上一版的材料再加这些链接，交完自动参考评审，评完用 check_task 对表。文件请本人在天枢网页上传。这不是交付，交付由本人在天枢点。Only when I ask: submit a new deliverable version (links) for a task I'm responsible for; review starts automatically.", inputSchema: AddVersionInput as Tool["inputSchema"] },
];
export const agreementToolNames = new Set(agreementDefinitions.map((tool) => tool.name));

export type AgreementToolDeps = { pool: Pool; q: Query; now: () => Date; planTasks: PlanTaskSource; names: Map<string, string>; publicOrigin?: string;
  /** 交版本用：材料卷和评审队列（app.deliverables）。 */
  deliverables: { storageDir: string; enqueueReview: (versionId: string) => Promise<void> } };
type ToolResult = { value: unknown; error?: string };

/** 执行一个约定工具：返回结果，或带错误码的失败（调用方包成 MCP 结果）。参数不合法时返回 null，由调用方报 INVALID_INPUT。 */
export async function callAgreementTool(deps: AgreementToolDeps, viewer: PlanTaskViewer, tool: string, args: unknown): Promise<ToolResult | null> {
  try {
    if (tool === "get_task_agreement" || tool === "check_task") {
      if (!Value.Check(TaskInput, args)) return null;
      const { access, agreement } = await openPlanTask(deps.q, deps.planTasks, viewer, deps.now(), args.taskId, deps.names);
      return { value: tool === "get_task_agreement" ? agreement : await checkTask(deps.q, access, agreement, deps.now()) };
    }
    if (tool !== "add_deliverable_version" || !Value.Check(AddVersionInput, args)) return null;
    const { access, agreement } = await openPlanTask(deps.q, deps.planTasks, viewer, deps.now(), args.taskId, deps.names);
    if (!access.canEdit) throw new DeliverableError(403, "FORBIDDEN", "这个 Task 由负责人交付");
    // 沿用上一版的全部材料（和网页上默认勾着的一样），同一个链接不重复放。
    const kept = (await deps.q(`SELECT i.id, i.url FROM deliverable_items i JOIN deliverable_versions v ON v.id=i.version_id
      WHERE v.task_id=$1 AND v.number=(SELECT max(number) FROM deliverable_versions WHERE task_id=$1) ORDER BY i.position`, [args.taskId])).rows as { id: string; url: string | null }[];
    const links = args.links.map((link) => link.trim());
    const fields = parseDeliverableFields(new Map([["links", JSON.stringify(links)], ["statement", args.note ?? ""],
      ["keep", JSON.stringify(kept.filter((item) => !item.url || !links.includes(item.url)).map((item) => item.id))]]));
    const version = await createDeliverableVersion(deps.pool, access, [], fields, deps.deliverables.storageDir, agreementSnapshot(agreement));
    void deps.deliverables.enqueueReview(version.id);
    return { value: { versionId: version.id, number: version.number, items: version.items.map(({ kind, name, url }) => ({ kind, name, url })), review: version.review.status,
      message: `已交第 ${version.number} 版，参考评审在跑，评完用 check_task 对表；交付请本人在天枢点`,
      href: `${(deps.publicOrigin ?? "").replace(/\/$/, "")}/me?planTask=${encodeURIComponent(args.taskId)}` } };
  } catch (cause) {
    if (cause instanceof DeliverableError) return { value: { code: cause.code, message: cause.message }, error: cause.code };
    throw cause;
  }
}
