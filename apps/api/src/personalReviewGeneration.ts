import type { TMonthlyReviewField, TPersonalReviewGenerationStep, TWeeklyReviewBody } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { CITATION_SCHEME } from "./sourceCitations.js";
import { weekRange } from "./weeklyProgress.js";
import { weeklyReviewText } from "./weeklyReviews.js";
import { PERSONAL_REVIEW_FIELDS, readPersonalReviewMaterials, type PersonalReviewRow } from "./personalReviews.js";

/**
 * 个人复盘生成：读 Mission 卡 → 读每周复盘 → 读采集记录 → 起草。
 * 每条输入记录带 cite（照抄进正文的出处地址，与对话里的出处同一套 `[名称](cite:<ref>)` 写法）和 label（出处名称）；
 * 起草结果逐行核对出处，只认这次输入里真有的记录；本人保存过的段落在写回时保留。
 */

type StepId = TPersonalReviewGenerationStep["id"];
export type PersonalReviewStepListener = (steps: TPersonalReviewGenerationStep[]) => void;

const MISSING_RECORDS = "缺少记录";
/** 采集记录取当月最近这么多条，每条截到这么长：一个月的工作段可能上百条，整段塞给模型会超长。 */
const COLLECTOR_LIMIT = 150;
const COLLECTOR_TEXT_CHARS = 500;
const SOURCE_NAMES: Record<string, string> = { codex: "Codex", claude: "Claude Code" };

export type Cited = { cite: string; label: string };
type WeeklyEntry = Cited & { date: string; missionTitle: string; taskTitle: string; author: string; body: string };
export type PersonalReviewDraftInput = {
  period: string;
  personId: string;
  missions: (Cited & Record<string, unknown> & { id: string; code: string; title: string; outcome: string })[];
  /**
   * 按 ISO 周（北京时间）整理：那一周本人已提交周复盘的，review 是周复盘全文、entries 为空（优先用周复盘）；
   * 没有周复盘的周，entries 是那一周的执行事项进展。review 和 entries 都空表示那一周没有记录。只列已经开始的周。
   */
  weeklyReviews: { week: string; from: string; to: string; review?: Cited & { text: string }; entries: WeeklyEntry[] }[];
  /** 采集器原文经服务端整理后的进展（collector_progress），当月开始的，按时间排列；taskTitle 是归到的执行事项。 */
  collectorRecords: (Cited & { source: string; startedAt: string; endedAt: string; text: string; placement: string; repo: string | null; taskTitle: string | null })[];
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

/**
 * 当月每一周：本人已提交的周复盘优先（含 10 月从飞书导入的）；没有周复盘的周，读本人那一周写的进展或写在本人负责事项上的进展
 * （采集器整理后自动写进执行事项的那几条不在这里，它们在采集记录里）。当月已开始的周即使没有记录也列出来。
 */
export async function readWeeklyReviews(q: Query, row: Pick<PersonalReviewRow, "period" | "person_id">, now: Date): Promise<PersonalReviewDraftInput["weeklyReviews"]> {
  const { start, end, catchup } = monthWindow(row.period);
  const rows = (await q(`SELECT p.id::text AS id, p.created_at AS "createdAt", COALESCE(m.title,'') AS "missionTitle", t.title AS "taskTitle",
      p.author_id AS author, p.body
    FROM task_progress p JOIN tasks t ON t.id=p.task_id LEFT JOIN missions m ON m.id=t.mission_id
    WHERE p.created_at >= $1 AND p.created_at < $2 AND (p.author_id=$4 OR t.owner_id=$4)
      AND (p.created_at < $3 OR m.period=$5 OR t.mission_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM collector_progress c WHERE c.task_progress_id=p.id)
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
  const listed = [...weeks.values()];
  const reviews = listed.length ? (await q(`SELECT id::text AS id, to_char(week_start,'YYYY-MM-DD') AS "weekStart", body FROM weekly_reviews
    WHERE person_id=$1 AND status='submitted' AND week_start = ANY($2::date[])`, [row.person_id, listed.map((week) => week.from)])).rows as
    { id: string; weekStart: string; body: TWeeklyReviewBody }[] : [];
  for (const review of reviews) {
    const week = listed.find((item) => item.from === review.weekStart)!;
    week.review = { cite: `${CITATION_SCHEME}weekly-review:${review.id}`, label: `${review.weekStart.slice(5).replace("-", "/")} 周复盘`, text: weeklyReviewText(review.body) };
  }
  for (const entry of rows) {
    const week = weekOf(entry.createdAt);
    if (week.review) continue;
    week.entries.push({ cite: `${CITATION_SCHEME}progress:${entry.id}`, label: `${day(entry.createdAt)} 进展 · ${clip(entry.taskTitle, 24)}`,
      date: entry.createdAt.toISOString(), missionTitle: entry.missionTitle, taskTitle: entry.taskTitle, author: entry.author, body: entry.body });
  }
  return [...weeks.values()].sort((a, b) => a.from.localeCompare(b.from));
}

/** 本人当月（北京时间）开始的采集记录整理结果：取最近 COLLECTOR_LIMIT 条，按时间正序。原文只在整理时用，这里不读。 */
export async function readCollectorRecords(q: Query, row: Pick<PersonalReviewRow, "period" | "person_id">): Promise<{ total: number; records: PersonalReviewDraftInput["collectorRecords"] }> {
  const { start, end } = monthWindow(row.period);
  return readCollectorProgress(q, row.person_id, start, end, COLLECTOR_LIMIT);
}

/** 采集记录整理结果（collector_progress）在 [start, end) 开始的，取最近 limit 条按时间正序；月度、周复盘共用。 */
export async function readCollectorProgress(q: Query, personId: string, start: Date, end: Date, limit: number): Promise<{ total: number; records: PersonalReviewDraftInput["collectorRecords"] }> {
  const params = [personId, start, end];
  const total = Number((await q("SELECT count(*)::int AS n FROM collector_progress WHERE person_id=$1 AND started_at >= $2 AND started_at < $3", params)).rows[0].n);
  const rows = (await q(`SELECT c.id::text AS id, c.source, c.started_at AS "startedAt", c.ended_at AS "endedAt", c.text, c.placement, c.repo, t.title AS "taskTitle"
    FROM collector_progress c LEFT JOIN tasks t ON t.id=c.task_id
    WHERE c.person_id=$1 AND c.started_at >= $2 AND c.started_at < $3 ORDER BY c.started_at DESC, c.id LIMIT ${Number(limit)}`, params)).rows as
    { id: string; source: string; startedAt: Date; endedAt: Date; text: string; placement: string; repo: string | null; taskTitle: string | null }[];
  return { total, records: rows.reverse().map((item) => ({
    cite: `${CITATION_SCHEME}collector:${item.id}`, label: `${day(item.startedAt)} ${SOURCE_NAMES[item.source] ?? item.source} 记录`,
    source: item.source, startedAt: item.startedAt.toISOString(), endedAt: item.endedAt.toISOString(),
    text: clip(item.text, COLLECTOR_TEXT_CHARS), placement: item.placement, repo: item.repo, taskTitle: item.taskTitle,
  })) };
}

/** 同名出处加序号区分：本人改段落时出处在编辑框里只显示名称，名称要能还原回唯一的地址。周复盘生成同样用它。 */
export function distinctLabels(records: Cited[]): void {
  const seen = new Map<string, number>();
  for (const record of records) {
    const count = (seen.get(record.label) ?? 0) + 1;
    seen.set(record.label, count);
    if (count > 1) record.label = `${record.label}（${count}）`;
  }
}

/** 读三类记录（每周复盘里已提交的周复盘优先），每读完一类报一步；随后由调用方起草。 */
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
  const recorded = weeklyReviews.filter((week) => week.review || week.entries.length).length;
  const reviewed = weeklyReviews.filter((week) => week.review).length;
  await step("weekly", "done", recorded ? `${weeklyReviews.length} 周里 ${recorded} 周有记录${reviewed ? `，${reviewed} 周有周复盘` : ""}` : MISSING_RECORDS);

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
  distinctLabels(citedRecords(input));
  return input;
}

const citedRecords = (input: PersonalReviewDraftInput): Cited[] => [...input.missions,
  ...input.weeklyReviews.flatMap((week) => [...(week.review ? [week.review] : []), ...week.entries]), ...input.collectorRecords,
  ...input.attachments, ...input.messages, ...input.importedMaterials];
export function allowedCitations(input: PersonalReviewDraftInput): Set<string> {
  return new Set(citedRecords(input).map((record) => record.cite));
}

const LINK = /\[([^\]\n]+)\]\(([^()\s]+)\)/g;
const linksIn = (text: string) => [...text.matchAll(LINK)].map((match) => match[2]);
/** 不需要出处的行：如实写的「缺少记录」、待上层决策事项的「无」。 */
const exempt = (line: string) => line.includes(MISSING_RECORDS) || /^[-*\d.、\s]*无[。.]?$/.test(line.trim());

/** 整段只写缺少记录：这次确实缺了某类记录，这一段不挂任何出处，每一行都在说缺了什么（如「状态：黄｜缺少本周进展……」）。 */
const missingOnly = (text: string, missing: readonly string[]) => missing.length > 0 && text.includes("缺少") && !linksIn(text).length
  && text.split("\n").every((line) => !line.trim() || line.includes("缺少") || exempt(line));

/** 正文里的出处地址（cite:… 或网址），按出现顺序。 */
export const citationsIn = linksIn;

/** 段落化的复盘：个人复盘四栏、周复盘六段，每段 {text, sources}。 */
type Sections<F extends string> = Record<F, { text: string; sources: string[] }>;
const MONTHLY_FIELDS: readonly TMonthlyReviewField[] = PERSONAL_REVIEW_FIELDS;

/**
 * 出处核对：每一行都要有出处（或是「缺少记录」「无」），出处只能是输入里的记录；缺了哪类记录就必须写「缺少记录」。返回问题描述，没有问题返回 null。
 * 整段只写缺少记录的段落（missingOnly）整段放行，也算写了「缺少记录」；挂了出处的段落仍逐行核对。
 * fields 缺省是个人复盘的四栏；周复盘传自己的六段。
 */
export function citationProblem<F extends string = TMonthlyReviewField>(review: Sections<F>, allowed: Set<string>, missing: readonly string[],
  fields: readonly F[] = MONTHLY_FIELDS as readonly string[] as readonly F[]): string | null {
  for (const field of fields) {
    const text = review[field].text;
    const unknown = linksIn(text).find((href) => !allowed.has(href));
    if (unknown) return `${field} 引用了输入里没有的出处 ${unknown}`;
    if (missingOnly(text, missing)) continue;
    const bare = text.split("\n").find((line) => line.trim() && !linksIn(line).length && !exempt(line));
    if (bare) return `${field} 有一句没有出处：${clip(bare.trim(), 40)}`;
  }
  if (missing.length && !fields.some((field) => review[field].text.includes(MISSING_RECORDS) || missingOnly(review[field].text, missing))) {
    return `缺少${missing.join("、")}，草稿里没有写「${MISSING_RECORDS}」`;
  }
  return null;
}

/** sources 按正文里的出处生成：内部依据去掉 cite: 前缀，网址原样，最多 10 条。 */
export function withSources<F extends string = TMonthlyReviewField>(review: Sections<F>,
  fields: readonly F[] = MONTHLY_FIELDS as readonly string[] as readonly F[]): Sections<F> {
  return Object.fromEntries(fields.map((field) => [field, {
    text: review[field].text,
    sources: [...new Set(linksIn(review[field].text).map((href) => href.startsWith(CITATION_SCHEME) ? href.slice(CITATION_SCHEME.length) : href))].slice(0, 10),
  }])) as Sections<F>;
}

/** 本人保存过、而且没有清空的段落保留原文；其余段落换成新生成的。 */
export function mergeGeneratedReview<F extends string = TMonthlyReviewField>(existing: Sections<F> | null, generated: Sections<F>,
  edited: readonly F[], fields: readonly F[] = MONTHLY_FIELDS as readonly string[] as readonly F[]): { selfReview: Sections<F>; kept: F[] } {
  const kept = fields.filter((field) => edited.includes(field) && existing?.[field].text.trim());
  return { kept, selfReview: Object.fromEntries(fields.map((field) => [field, kept.includes(field) ? existing![field] : generated[field]])) as Sections<F> };
}
