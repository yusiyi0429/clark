import type { TMonthlyReviewField, TMonthlyReviewSelfReview, TPersonalReviewGenerationStep } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { CITATION_SCHEME } from "./sourceCitations.js";
import { weekRange } from "./weeklyProgress.js";
import { PERSONAL_REVIEW_FIELDS, readPersonalReviewMaterials, type PersonalReviewRow } from "./personalReviews.js";

/**
 * 个人复盘生成：读 Mission 卡 → 读每周复盘 → 读采集记录 → 起草。
 * 每条输入记录带 cite（照抄进正文的出处地址，与对话里的出处同一套 `[名称](cite:<ref>)` 写法）和 label（出处名称）；
 * 起草结果逐行核对出处，只认这次输入里真有的记录；本人保存过的段落在写回时保留。
 */

type StepId = TPersonalReviewGenerationStep["id"];
export type PersonalReviewStepListener = (steps: TPersonalReviewGenerationStep[]) => void;

const MISSING_RECORDS = "缺少记录";
/** 采集记录取当月最近这么多条，摘要截到这么长：一个月的工作段可能上百条，整段塞给模型会超长。 */
const COLLECTOR_LIMIT = 150;
const COLLECTOR_SUMMARY_CHARS = 500;
const SOURCE_NAMES: Record<string, string> = { codex: "Codex", claude: "Claude Code" };

type Cited = { cite: string; label: string };
type WeeklyEntry = Cited & { date: string; missionTitle: string; taskTitle: string; author: string; body: string };
export type PersonalReviewDraftInput = {
  period: string;
  personId: string;
  missions: (Cited & Record<string, unknown> & { id: string; code: string; title: string; outcome: string })[];
  /** 按 ISO 周（北京时间）整理的执行事项进展；entries 为空表示那一周没有记录。只列已经开始的周。 */
  weeklyReviews: { week: string; from: string; to: string; entries: WeeklyEntry[] }[];
  /** 本机采集器从 Codex、Claude Code 收来的工作段摘要，当月开始的，按时间排列。 */
  collectorRecords: (Cited & { source: string; startedAt: string; endedAt: string; summary: string; links: unknown; taskHint: string | null })[];
  attachments: (Cited & { id: string; fileName: string; extractedText: string | null })[];
  messages: (Cited & { conversationId: string; sequence: number; content: string; createdAt: string })[];
  importedMaterials: (Cited & { title: string; sourceRef: string; markdown: string })[];
  /** 这次没有任何记录的类别，草稿里要如实写「缺少记录」。 */
  missingRecords: ("Mission 卡" | "每周复盘" | "采集记录")[];
};

const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" }).format(date).replace("-", "/");
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const monthWindow = (period: string) => {
  const [year, month] = period.split("-").map(Number);
  // 北京时间当月 1 日 0 点到次月 1 日 0 点；周进展允许次月首周补记（与单元复盘同一口径）。
  return { start: new Date(Date.UTC(year, month - 1, 1, -8)), end: new Date(Date.UTC(year, month, 1, -8)), catchup: new Date(Date.UTC(year, month, 8, -8)) };
};

/** 本人当月写的进展，或写在本人负责事项上的进展；按周分组，当月已开始的周即使没有记录也列出来。 */
export async function readWeeklyReviews(q: Query, row: Pick<PersonalReviewRow, "period" | "person_id">, now: Date): Promise<PersonalReviewDraftInput["weeklyReviews"]> {
  const { start, end, catchup } = monthWindow(row.period);
  const rows = (await q(`SELECT p.id::text AS id, p.created_at AS "createdAt", COALESCE(m.title,'') AS "missionTitle", t.title AS "taskTitle",
      p.author_id AS author, p.body
    FROM task_progress p JOIN tasks t ON t.id=p.task_id LEFT JOIN missions m ON m.id=t.mission_id
    WHERE p.created_at >= $1 AND p.created_at < $2 AND (p.author_id=$4 OR t.owner_id=$4)
      AND (p.created_at < $3 OR m.period=$5 OR t.mission_id IS NULL)
    ORDER BY p.created_at, p.id LIMIT 200`, [start, catchup, end, row.person_id, row.period])).rows as
    { id: string; createdAt: Date; missionTitle: string; taskTitle: string; author: string; body: string }[];
  const weeks = new Map<string, PersonalReviewDraftInput["weeklyReviews"][number]>();
  const weekOf = (at: Date) => {
    const range = weekRange(undefined, at);
    const week = weeks.get(range.week) ?? { week: range.week, from: range.from.slice(0, 10), to: range.to.slice(0, 10), entries: [] };
    weeks.set(range.week, week);
    return week;
  };
  for (let at = start; at < end && at <= now; at = new Date(Date.parse(weekRange(undefined, at).to))) weekOf(at);
  for (const entry of rows) {
    weekOf(entry.createdAt).entries.push({ cite: `${CITATION_SCHEME}progress:${entry.id}`, label: `${day(entry.createdAt)} 进展 · ${clip(entry.taskTitle, 24)}`,
      date: entry.createdAt.toISOString(), missionTitle: entry.missionTitle, taskTitle: entry.taskTitle, author: entry.author, body: entry.body });
  }
  return [...weeks.values()].sort((a, b) => a.from.localeCompare(b.from));
}

/** 本人当月（北京时间）开始的采集记录：取最近 COLLECTOR_LIMIT 条，按时间正序。 */
export async function readCollectorRecords(q: Query, row: Pick<PersonalReviewRow, "period" | "person_id">): Promise<{ total: number; records: PersonalReviewDraftInput["collectorRecords"] }> {
  const { start, end } = monthWindow(row.period);
  const params = [row.person_id, start, end];
  const total = Number((await q("SELECT count(*)::int AS n FROM collector_items WHERE person_id=$1 AND started_at >= $2 AND started_at < $3", params)).rows[0].n);
  const rows = (await q(`SELECT id::text AS id, source, started_at AS "startedAt", ended_at AS "endedAt", summary, links, task_hint AS "taskHint"
    FROM collector_items WHERE person_id=$1 AND started_at >= $2 AND started_at < $3 ORDER BY started_at DESC, id LIMIT ${COLLECTOR_LIMIT}`, params)).rows as
    { id: string; source: string; startedAt: Date; endedAt: Date; summary: string; links: unknown; taskHint: string | null }[];
  return { total, records: rows.reverse().map((item) => ({
    cite: `${CITATION_SCHEME}collector:${item.id}`, label: `${day(item.startedAt)} ${SOURCE_NAMES[item.source] ?? item.source} 记录`,
    source: item.source, startedAt: item.startedAt.toISOString(), endedAt: item.endedAt.toISOString(),
    summary: clip(item.summary, COLLECTOR_SUMMARY_CHARS), links: item.links, taskHint: item.taskHint,
  })) };
}

/** 同名出处加序号区分：本人改段落时出处在编辑框里只显示名称，名称要能还原回唯一的地址。 */
function distinctLabels(input: PersonalReviewDraftInput): void {
  const seen = new Map<string, number>();
  const records: Cited[] = [...input.missions, ...input.weeklyReviews.flatMap((week) => week.entries), ...input.collectorRecords,
    ...input.attachments, ...input.messages, ...input.importedMaterials];
  for (const record of records) {
    const count = (seen.get(record.label) ?? 0) + 1;
    seen.set(record.label, count);
    if (count > 1) record.label = `${record.label}（${count}）`;
  }
}

/** 读三类记录，每读完一类报一步；随后由调用方起草。 */
export async function buildPersonalReviewDraftInput(q: Query, row: PersonalReviewRow, storageDir: string, now: Date,
  step: (id: StepId, status: TPersonalReviewGenerationStep["status"], result?: string) => Promise<void>): Promise<PersonalReviewDraftInput> {
  await step("missions", "running");
  const missions = (await q(`SELECT id,code,title,outcome,time_boundary AS "timeBoundary",tradeoffs,why,success_evidence AS "successEvidence",milestones,boundaries,
    key_path AS "keyPath",resources,dependencies,human_agent_split AS "humanAgentSplit",risk,retrospect
    FROM missions WHERE period=$1 AND owner_id=$2 ORDER BY code,id`, [row.period, row.person_id])).rows as PersonalReviewDraftInput["missions"];
  for (const mission of missions) Object.assign(mission, { cite: `${CITATION_SCHEME}mission:${mission.id}`, label: `Mission ${mission.code} ${clip(mission.title, 24)}` });
  await step("missions", "done", missions.length ? `${missions.length} 张` : MISSING_RECORDS);

  await step("weekly", "running");
  const weeklyReviews = await readWeeklyReviews(q, row, now);
  const recorded = weeklyReviews.filter((week) => week.entries.length).length;
  await step("weekly", "done", recorded ? `${weeklyReviews.length} 周里 ${recorded} 周有记录` : MISSING_RECORDS);

  await step("collector", "running");
  const collector = await readCollectorRecords(q, row);
  await step("collector", "done", !collector.total ? MISSING_RECORDS
    : collector.total > collector.records.length ? `${collector.total} 条，取最近 ${collector.records.length} 条` : `${collector.total} 条`);

  const materials = await readPersonalReviewMaterials(q, row, storageDir);
  const input: PersonalReviewDraftInput = {
    period: row.period, personId: row.person_id, missions, weeklyReviews, collectorRecords: collector.records,
    attachments: materials.attachments.map((item) => ({ ...item, cite: `${CITATION_SCHEME}attachment:${item.id}`, label: item.fileName })),
    messages: materials.messages.map((item) => ({ ...item, cite: `${CITATION_SCHEME}message:${item.conversationId}#${item.sequence}`,
      label: `${day(new Date(item.createdAt))} 复盘对话` })),
    importedMaterials: materials.importedMaterials.map((item) => ({ ...item,
      cite: /^https?:\/\//.test(item.sourceRef) ? item.sourceRef : `${CITATION_SCHEME}${item.sourceRef}`, label: item.title })),
    missingRecords: [
      ...(missions.length ? [] : ["Mission 卡" as const]),
      ...(recorded ? [] : ["每周复盘" as const]),
      ...(collector.total ? [] : ["采集记录" as const]),
    ],
  };
  distinctLabels(input);
  return input;
}

export function allowedCitations(input: PersonalReviewDraftInput): Set<string> {
  return new Set([...input.missions, ...input.weeklyReviews.flatMap((week) => week.entries), ...input.collectorRecords,
    ...input.attachments, ...input.messages, ...input.importedMaterials].map((record) => record.cite));
}

const LINK = /\[([^\]\n]+)\]\(([^()\s]+)\)/g;
const linksIn = (text: string) => [...text.matchAll(LINK)].map((match) => match[2]);
/** 不需要出处的行：如实写的「缺少记录」、待上层决策事项的「无」。 */
const exempt = (line: string) => line.includes(MISSING_RECORDS) || /^[-*\d.、\s]*无[。.]?$/.test(line.trim());

/** 出处核对：每一行都要有出处（或是「缺少记录」「无」），出处只能是输入里的记录；缺了哪类记录就必须写「缺少记录」。返回问题描述，没有问题返回 null。 */
export function citationProblem(review: TMonthlyReviewSelfReview, allowed: Set<string>, missing: readonly string[]): string | null {
  for (const field of PERSONAL_REVIEW_FIELDS) {
    const text = review[field].text;
    const unknown = linksIn(text).find((href) => !allowed.has(href));
    if (unknown) return `${field} 引用了输入里没有的出处 ${unknown}`;
    const bare = text.split("\n").find((line) => line.trim() && !linksIn(line).length && !exempt(line));
    if (bare) return `${field} 有一句没有出处：${clip(bare.trim(), 40)}`;
  }
  if (missing.length && !PERSONAL_REVIEW_FIELDS.some((field) => review[field].text.includes(MISSING_RECORDS))) {
    return `缺少${missing.join("、")}，草稿里没有写「${MISSING_RECORDS}」`;
  }
  return null;
}

/** sources 按正文里的出处生成：内部依据去掉 cite: 前缀，网址原样，最多 10 条。 */
export function withSources(review: TMonthlyReviewSelfReview): TMonthlyReviewSelfReview {
  return Object.fromEntries(PERSONAL_REVIEW_FIELDS.map((field) => [field, {
    text: review[field].text,
    sources: [...new Set(linksIn(review[field].text).map((href) => href.startsWith(CITATION_SCHEME) ? href.slice(CITATION_SCHEME.length) : href))].slice(0, 10),
  }])) as TMonthlyReviewSelfReview;
}

/** 本人保存过、而且没有清空的段落保留原文；其余段落换成新生成的。 */
export function mergeGeneratedReview(existing: TMonthlyReviewSelfReview | null, generated: TMonthlyReviewSelfReview,
  edited: readonly TMonthlyReviewField[]): { selfReview: TMonthlyReviewSelfReview; kept: TMonthlyReviewField[] } {
  const kept = PERSONAL_REVIEW_FIELDS.filter((field) => edited.includes(field) && existing?.[field].text.trim());
  return { kept, selfReview: Object.fromEntries(PERSONAL_REVIEW_FIELDS.map((field) => [field, kept.includes(field) ? existing![field] : generated[field]])) as TMonthlyReviewSelfReview };
}
