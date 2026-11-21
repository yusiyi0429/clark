import { letterOfSub } from "./subSessionLetters.js";
import { withMeetingWorkBrief } from "./meetingWorkHandoffs.js";
import { randomUUID } from "node:crypto";
import type { TCreateTopicRequest, TDeliverableInclusion, TPatchTopicRequest, TResearchTopicView, TTopicBriefResponse, TTopicDetailResponse, TTopicVersionSummary,
  TTopicVersionView } from "@warmap/contracts";
import { latestRuns, recentRuns, runBrief, runViews } from "./localDevices.js";
import type { Query } from "./meetingStore.js";
import { UUID_PATTERN } from "./meetingStore.js";
import { criticRoles, ownRole, roleBrief, roleRef, rolesById } from "./roles.js";
import { nextVersions } from "./taskCards.js";
import { requestStarts } from "./sessionStarts.js";
import type { OwnTask } from "./taskDeliverables.js";

/**
 * 调研专题（V2 设计第 9 节）：在本机由 Claude Code 跑，先交提纲、本人同意后再写，每改一次存一个新版本；评审会的「分歧和建议」也存成一版。
 * 版本由本机经同步报上来（localSync.ts）；对话全文只在本机，云端不存。只归档，不删。只有本人看得到。
 */

export class TopicError extends Error {
  constructor(public readonly status: 400 | 404, public readonly code: string, message: string) { super(message); }
}

type TopicRow = { id: string; owner_id: string; title: string; plan_task_id: string | null; mission_id: string | null; role_id: string | null; status: "active" | "archived";
  created_at: Date; updated_at: Date; last_version_at: Date | null; free: boolean; first_message: string | null; project_id: string | null };
type VersionRow = { id: string; topic_id: string; number: number; kind: "outline" | "draft" | "review"; label: string; body: string; note: string | null;
  feishu_url: string | null; created_at: Date };
type LatestRow = { topic_id: string; number: number; kind: VersionRow["kind"]; label: string };

/** 本人的专题；不是本人的当找不到。 */
async function ownTopic(q: Query, ownerId: string, id: string): Promise<TopicRow> {
  const row = UUID_PATTERN.test(id) ? (await q("SELECT * FROM research_topics WHERE id=$1 AND owner_id=$2", [id, ownerId])).rows[0] as TopicRow | undefined : undefined;
  if (!row) throw new TopicError(404, "NOT_FOUND", "找不到这个专题");
  return row;
}

async function topicViews(q: Query, rows: TopicRow[]): Promise<TResearchTopicView[]> {
  const ids = rows.map((row) => row.id);
  const latest = new Map(ids.length ? ((await q(`SELECT DISTINCT ON (topic_id) topic_id,number,kind,label FROM topic_versions WHERE topic_id=ANY($1::uuid[])
    ORDER BY topic_id,number DESC`, [ids])).rows as LatestRow[]).map((row) => [row.topic_id, row]) : []);
  const runs = await latestRuns(q, "topic_id", ids, "topic");
  const roles = await rolesById(q, rows.map((row) => row.role_id));
  return rows.map((row) => {
    const version = latest.get(row.id), run = runs.get(row.id), role = row.role_id ? roles.get(row.role_id) : undefined;
    return { id: row.id, title: row.title, status: row.status, planTaskId: row.plan_task_id, missionId: row.mission_id, role: role ? roleRef(role) : null,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), lastVersionAt: row.last_version_at?.toISOString() ?? null,
      latestVersion: version ? { number: version.number, kind: version.kind, label: version.label } : null, run: run ? runBrief(run) : null,
      ...(row.free ? { free: true as const } : {}) };
  });
}

/** GET /api/me/topics：新动静的在前。 */
export async function listTopics(q: Query, ownerId: string, status: "active" | "archived"): Promise<TResearchTopicView[]> {
  return topicViews(q, (await q("SELECT * FROM research_topics WHERE owner_id=$1 AND status=$2 AND trashed_at IS NULL ORDER BY COALESCE(last_version_at,updated_at) DESC,id",
    [ownerId, status])).rows as TopicRow[]);
}

/**
 * 自由子会话的标题（第 68 条）：第一句话的第一行全文，不加省略号（任何地方不出省略号；左栏右端淡出、页头换行）。
 * 标题字段最多 60 个字（research_topics 的约束、契约的 maxLength 按 UTF-16 算）：超出的只留前面放得下的整字，不切坏半个字。
 */
export function freeTitle(firstMessage: string): string {
  const line = firstMessage.split(/\r?\n/).map((text) => text.trim()).find(Boolean) ?? "新的子会话";
  let title = "";
  for (const char of line) {
    if (title.length + char.length > 60) break;
    title += char;
  }
  return title;
}

/**
 * POST /api/me/topics：planTask 是本人 Mission 下的这个 Task（读不到 404）；岗位要是本人没归档的。不是自由子会话时 title 必带。
 * 自由子会话（第 68 条，free）：在本人没归档的项目里建，标题取第一句话，记下第一句话当交代，登记要开工（同伙伴的 open_topic），
 * 那台电脑上开着的网页认领开工。缺 projectId、firstMessage，或带了 title、planTaskId、roleId 都 400。
 */
export async function createTopic(q: Query, ownerId: string, input: TCreateTopicRequest, planTask: (taskId: string) => Promise<OwnTask | null>, now: Date): Promise<TResearchTopicView> {
  if (input.free) {
    if (!input.projectId || !input.firstMessage?.trim() || input.title !== undefined || input.planTaskId || input.roleId)
      throw new TopicError(400, "INVALID_INPUT", "自由子会话带项目和第一句话，不带标题、Task、技能");
    const project = (await q("SELECT archived_at FROM projects WHERE id=$1 AND owner_id=$2", [input.projectId, ownerId])).rows[0] as { archived_at: Date | null } | undefined;
    if (!project || project.archived_at) throw new TopicError(404, "PROJECT_NOT_FOUND", "找不到这个项目");
    const id = randomUUID();
    await q(`INSERT INTO research_topics(id,owner_id,title,project_id,free,first_message,created_at,updated_at) VALUES($1,$2,$3,$4,true,$5,$6,$6)`,
      [id, ownerId, freeTitle(input.firstMessage), input.projectId, input.firstMessage.trim(), now]);
    await requestStarts(q, { ownerId, origin: "web", now, items: [{ kind: "topic", topicId: id, planTaskId: null }] });
    return (await topicViews(q, [await ownTopic(q, ownerId, id)]))[0];
  }
  if (!input.title?.trim()) throw new TopicError(400, "TITLE_REQUIRED", "专题要有标题");
  const own = input.planTaskId ? await planTask(input.planTaskId) : null;
  if (input.planTaskId && !own) throw new TopicError(404, "TASK_NOT_FOUND", "找不到这个 Task");
  if (input.roleId) await ownRole(q, ownerId, input.roleId);
  const id = randomUUID();
  await q(`INSERT INTO research_topics(id,owner_id,title,plan_task_id,mission_id,role_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
    [id, ownerId, input.title.trim(), own?.task.taskId ?? null, own?.task.missionId ?? null, input.roleId ?? null, now]);

  return (await topicViews(q, [await ownTopic(q, ownerId, id)]))[0];
}

/** PATCH /api/me/topics/:id：改标题、归档或取消归档、换岗位。 */
export async function patchTopic(q: Query, ownerId: string, id: string, input: TPatchTopicRequest, now: Date): Promise<TResearchTopicView> {
  if (!Object.keys(input).length) throw new TopicError(400, "INVALID_INPUT", "至少改一样");
  const row = await ownTopic(q, ownerId, id);
  if (input.roleId) await ownRole(q, ownerId, input.roleId);
  await q("UPDATE research_topics SET title=$2,status=$3,role_id=$4,updated_at=$5 WHERE id=$1", [id, input.title?.trim() ?? row.title, input.status ?? row.status,
    input.roleId === undefined ? row.role_id : input.roleId, now]);
  return (await topicViews(q, [await ownTopic(q, ownerId, id)]))[0];
}

/** 各版本进交付物到哪了：准备中的写下一版的号，进了某一版的写那一版。 */
async function inclusions(q: Query, topic: TopicRow, versionIds: string[]): Promise<Map<string, TDeliverableInclusion>> {
  if (!versionIds.length) return new Map();
  const rows = (await q(`SELECT p.topic_version_id::text AS id,p.version_id,v.number FROM deliverable_pending_items p LEFT JOIN deliverable_versions v ON v.id=p.version_id
    WHERE p.topic_version_id=ANY($1::uuid[])`, [versionIds])).rows as { id: string; version_id: string | null; number: number | null }[];
  const next = topic.plan_task_id ? (await nextVersions(q, [topic.plan_task_id])).get(topic.plan_task_id)! : 1;
  return new Map(rows.map((row) => [row.id, row.version_id ? { state: "included" as const, versionNumber: row.number! } : { state: "pending" as const, versionNumber: next }]));
}
const summary = (row: VersionRow, included: Map<string, TDeliverableInclusion>): TTopicVersionSummary => ({ id: row.id, number: row.number, kind: row.kind,
  label: row.label, note: row.note, feishuUrl: row.feishu_url, createdAt: row.created_at.toISOString(), deliverable: included.get(row.id) ?? null });

/** GET /api/me/topics/:id：各版本（不带正文，新的在前）、最新一版带正文、最近 5 次本机执行。task 是挂的 Task 的名字，读不到为 null。 */
export async function readTopic(q: Query, ownerId: string, id: string, planTask: (taskId: string) => Promise<OwnTask | null>): Promise<TTopicDetailResponse> {
  const row = await ownTopic(q, ownerId, id);
  const versions = (await q("SELECT * FROM topic_versions WHERE topic_id=$1 ORDER BY number DESC", [id])).rows as VersionRow[];
  const included = await inclusions(q, row, versions.map((version) => version.id));
  const own = row.plan_task_id ? await planTask(row.plan_task_id) : null;
  return { topic: (await topicViews(q, [row]))[0], letter: (await letterOfSub(q, "topic", id))?.letter ?? null,
    task: own ? { taskId: own.task.taskId, name: own.task.name } : null,
    versions: versions.map((version) => summary(version, included)),
    current: versions[0] ? { ...summary(versions[0], included), body: versions[0].body } : null,
    runs: await runViews(q, await recentRuns(q, { topicId: id }, 5)) };
}

/** GET /api/me/topics/:id/versions/:number */
export async function readTopicVersion(q: Query, ownerId: string, id: string, number: number): Promise<TTopicVersionView> {
  const row = await ownTopic(q, ownerId, id);
  const version = (await q("SELECT * FROM topic_versions WHERE topic_id=$1 AND number=$2", [id, number])).rows[0] as VersionRow | undefined;
  if (!version) throw new TopicError(404, "NOT_FOUND", "没有这一版");
  return { ...summary(version, await inclusions(q, row, [version.id])), body: version.body };
}

/**
 * GET /api/me/topics/:id/brief：开专题时交给本机的交代。markdown 写专题标题；挂了 Task 的写 Mission、Task 和它的标准；有版本时写最新一版的号。
 * 约定（V1）合进来以后补。role 是专题的岗位，critics 是评审会的挑刺岗位（本人点的，或本人的前 3 个）。
 */
export async function topicBrief(q: Query, ownerId: string, id: string, picked: string[] | undefined, planTask: (taskId: string) => Promise<OwnTask | null>):
  Promise<TTopicBriefResponse> {
  const row = await ownTopic(q, ownerId, id);
  // 自由子会话（第 68 条）：交代就是本人说的第一句话原话，网页原样当第一句发出去（开工的文件夹已经是项目的，不再带项目名）；没有提纲、版本、评审会。
  if (row.free) return { ...await withMeetingWorkBrief(q, ownerId, "topic", id, row.first_message ?? row.title), title: row.title, latestVersion: null, role: null, critics: [] };
  const own = row.plan_task_id ? await planTask(row.plan_task_id) : null;
  const mission = row.mission_id ? (await q("SELECT title FROM missions WHERE id=$1", [row.mission_id])).rows[0] as { title: string } | undefined : undefined;
  const latest = (await q("SELECT max(number)::int AS n FROM topic_versions WHERE topic_id=$1", [id])).rows[0].n as number | null;
  const role = row.role_id ? (await rolesById(q, [row.role_id])).get(row.role_id) : undefined;
  const critics = await criticRoles(q, ownerId, picked);
  const lines = [
    `# 调研专题：${row.title}`, "",
    ...(mission ? [`- Mission：${mission.title}`] : []),
    ...(own ? [`- Task：${own.task.name}`] : []),
    ...(role ? [`- 技能：${role.name}`] : []),
    ...(latest ? [`- 已经存到第 ${latest} 版，接着这一版改`] : []),
    ...(own?.criteria.length ? ["", "## 这个 Task 的标准", "", ...own.criteria.map((text, index) => `${index + 1}. ${text}`)] : []),
  ];
  return { ...await withMeetingWorkBrief(q, ownerId, "topic", id, lines.join("\n")), title: row.title, latestVersion: latest, role: role ? roleBrief(role) : null, critics: critics.map(roleBrief) };
}
