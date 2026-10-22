import type { TWeeklyReviewBody, TWeeklyReviewGenerationStep } from "@warmap/contracts";
import { canReadMeetingCard } from "./meetingCard.js";
import { meetingCardFacts } from "./meetingCardRead.js";
import type { MeetingRow, Query } from "./meetingStore.js";
import { CITATION_SCHEME } from "./sourceCitations.js";
import { distinctLabels, readCollectorProgress, type Cited } from "./personalReviewGeneration.js";
import { addDays, weekPeriod, weeklyReviewText, weekWindow, type WeeklyReviewRow } from "./weeklyReviews.js";

/**
 * 周复盘生成的输入（D-01）：本人本周的五类记录，每条带 cite（照抄进正文的出处地址）和 label（出处名称），
 * 出处写法、核对与个人复盘生成同一套（personalReviewGeneration.ts 的 citationProblem / withSources / mergeGeneratedReview）。
 * 读 Mission 卡 → 读 Mission 与 Task 进展 → 读会议结论 → 读采集记录 → 读上周复盘，每读完一类报一步。
 */

const MISSING_RECORDS = "缺少记录";
const PROGRESS_LIMIT = 120;
const COLLECTOR_LIMIT = 120;
const MEETING_LIMIT = 30;
const TEXT_CHARS = 1200;

export type WeeklyReviewMissing = "Mission 卡" | "Mission 与 Task 进展" | "会议结论" | "采集记录" | "上周复盘";
export type WeeklyReviewDraftInput = {
  personId: string;
  /** 本周周一、周日（上海日期）；period 是这一周按周五算的月份。 */
  weekStart: string;
  weekEnd: string;
  period: string;
  /** 本月 Mission 卡：对照基准。 */
  missions: (Cited & { id: string; code: string; title: string; outcome: string; successEvidence: unknown; milestones: unknown })[];
  /** 本人这个月 Mission 下的执行事项（Task）和本人负责的其他执行事项，带当前状态。 */
  tasks: (Cited & { id: string; title: string; status: string; missionCode: string | null; dueDate: string | null; doneDefinition: string | null })[];
  /** 本周写的进展：本人写的，或写在本人负责事项上的（采集器整理后自动写进去的在 collectorRecords 里）。 */
  progress: (Cited & { date: string; taskTitle: string; missionCode: string | null; author: string; body: string })[];
  /** 本周参加的会议：已确认的结论，和会后提取的摘要。 */
  meetings: (Cited & { date: string; title: string; conclusions: string[]; summary: string })[];
  /** 采集器原文经服务端整理后的进展。 */
  collectorRecords: (Cited & { source: string; startedAt: string; endedAt: string; text: string; placement: string; repo: string | null; taskTitle: string | null })[];
  /** 上一周已提交的周复盘。 */
  previousReview: (Cited & { weekStart: string; text: string }) | null;
  missingRecords: WeeklyReviewMissing[];
};

const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" }).format(date).replace("-", "/");
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const shortDay = (iso: string) => iso.slice(5).replace("-", "/");

export const CURRENT_HANDLING = ["继续推进", "责任范围内调整", "需要升级处理"] as const;
export const JUDGMENT_CHANGES = ["被验证", "被削弱", "被否定", "仍待验证", "无重大判断变化"] as const;
/** 正文篇幅上限（去掉出处标记后的字数）：模板要求 1,500 字左右，超过这么多就退回重写。 */
export const WEEKLY_REVIEW_MAX_CHARS = 2200;
const plainText = (text: string) => text.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, "");
const contentLines = (text: string) => text.split("\n").map((line) => line.trim()).filter((line) => line && !line.includes(MISSING_RECORDS) && !/^[-*\d.、\s]*无[。.]?$/.test(line));

/** 公司现行模板（《DRI 周复盘使用说明》）的格式核对；返回问题描述，没有问题返回 null。 */
export function templateProblem(body: TWeeklyReviewBody): string | null {
  const status = plainText(body.overall.text).split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  if (!/^状态[:：]\s*[绿黄红]\s*[｜|]/.test(status)) return "本周总体判断第一行要写「状态：绿 / 黄 / 红｜一句话判断」";
  if (contentLines(body.progress.text).length > 3) return "关键进展与 Evidence 最多 3 条";
  if (contentLines(body.issues.text).length > 2) return "最重要的问题及 Why 最多 2 条";
  if (!JUDGMENT_CHANGES.some((word) => body.implications.text.includes(word))) return `判断变化要写明${JUDGMENT_CHANGES.join(" / ")}`;
  const handling = plainText(body.actions.text).trim().replace(/^[-*\d.、\s]+/, "");
  if (!CURRENT_HANDLING.some((word) => handling.startsWith(word)) || CURRENT_HANDLING.filter((word) => handling.includes(word)).length > 1) {
    return `当前处理只选一个：${CURRENT_HANDLING.join(" / ")}，写在开头`;
  }
  const length = Object.values(body).reduce((sum, section) => sum + plainText(section.text).length, 0);
  return length > WEEKLY_REVIEW_MAX_CHARS ? `篇幅 ${length} 字，超过 ${WEEKLY_REVIEW_MAX_CHARS} 字` : null;
}

export function weeklyRecords(input: WeeklyReviewDraftInput): Cited[] {
  return [...input.missions, ...input.tasks, ...input.progress, ...input.meetings, ...input.collectorRecords,
    ...(input.previousReview ? [input.previousReview] : [])];
}
export const allowedWeeklyCitations = (input: WeeklyReviewDraftInput) => new Set(weeklyRecords(input).map((record) => record.cite));

type Step = (id: TWeeklyReviewGenerationStep["id"], status: TWeeklyReviewGenerationStep["status"], result?: string) => Promise<void>;

export async function buildWeeklyReviewDraftInput(q: Query, row: Pick<WeeklyReviewRow, "person_id" | "week_start">, step: Step): Promise<WeeklyReviewDraftInput> {
  const personId = row.person_id, weekStart = row.week_start, period = weekPeriod(weekStart);
  const { start, end } = weekWindow(weekStart);

  await step("missions", "running");
  const missions = (await q(`SELECT id, code, title, outcome, success_evidence AS "successEvidence", milestones
    FROM missions WHERE period=$1 AND owner_id=$2 ORDER BY code, id`, [period, personId])).rows as WeeklyReviewDraftInput["missions"];
  for (const mission of missions) Object.assign(mission, { cite: `${CITATION_SCHEME}mission:${mission.id}`, label: `Mission ${mission.code} ${clip(mission.title, 24)}` });
  await step("missions", "done", missions.length ? `${missions.length} 张` : MISSING_RECORDS);

  await step("progress", "running");
  const tasks = (await q(`SELECT t.id::text AS id, t.title, t.status, m.code AS "missionCode", to_char(t.due_date,'YYYY-MM-DD') AS "dueDate",
      t.done_definition AS "doneDefinition"
    FROM tasks t LEFT JOIN missions m ON m.id=t.mission_id
    WHERE (m.period=$1 AND m.owner_id=$2) OR (t.owner_id=$2 AND (t.status <> 'done' OR t.updated_at >= $3))
    ORDER BY m.code NULLS LAST, t.step_order NULLS LAST, t.created_at, t.id LIMIT 80`, [period, personId, start])).rows as WeeklyReviewDraftInput["tasks"];
  for (const task of tasks) Object.assign(task, { cite: `${CITATION_SCHEME}task:${task.id}`, label: `执行事项 · ${clip(task.title, 24)}` });
  const progressRows = (await q(`SELECT p.id::text AS id, p.created_at AS "createdAt", t.title AS "taskTitle", m.code AS "missionCode", p.author_id AS author, p.body
    FROM task_progress p JOIN tasks t ON t.id=p.task_id LEFT JOIN missions m ON m.id=t.mission_id
    WHERE p.created_at >= $1 AND p.created_at < $2 AND (p.author_id=$3 OR t.owner_id=$3)
      AND NOT EXISTS (SELECT 1 FROM collector_progress c WHERE c.task_progress_id=p.id)
    ORDER BY p.created_at, p.id LIMIT ${PROGRESS_LIMIT}`, [start, end, personId])).rows as
    { id: string; createdAt: Date; taskTitle: string; missionCode: string | null; author: string; body: string }[];
  const progress = progressRows.map((item) => ({ cite: `${CITATION_SCHEME}progress:${item.id}`, label: `${day(item.createdAt)} 进展 · ${clip(item.taskTitle, 24)}`,
    date: item.createdAt.toISOString(), taskTitle: item.taskTitle, missionCode: item.missionCode, author: item.author, body: clip(item.body, TEXT_CHARS) }));
  await step("progress", "done", progress.length ? `${progress.length} 条进展，${tasks.length} 件执行事项` : tasks.length ? `${tasks.length} 件执行事项，本周没有进展` : MISSING_RECORDS);

  await step("meetings", "running");
  const meetingRows = (await q(`SELECT id::text AS id, title, scheduled_at AS "scheduledAt", outcome, lead_dri_id, created_by, attendees_actual, participants FROM meetings
    WHERE scheduled_at >= $1 AND scheduled_at < $2 AND outcome->>'status' = 'ready'
      AND (lead_dri_id=$3 OR ceo_participant_id=$3 OR participants @> jsonb_build_array(jsonb_build_object('personId', $3::text)))
    ORDER BY scheduled_at, id LIMIT ${MEETING_LIMIT}`, [start, end, personId])).rows as
    (Pick<MeetingRow, "lead_dri_id" | "created_by" | "attendees_actual" | "participants"> &
      { id: string; title: string; scheduledAt: Date; outcome: { summary?: string; items?: { text: string; review: { status: string } | null }[] } })[];
  const meetings: WeeklyReviewDraftInput["meetings"] = [];
  for (const meeting of meetingRows) {
    // 有会议卡的会只读确认版（本人读得了会议卡时），只有草稿不算结论；旧会议照旧读已确认的条目。
    const card = await meetingCardFacts(q, meeting.id);
    const confirmed = card?.status === "confirmed" && canReadMeetingCard(meeting, { personId, isCeo: false }) ? card : null;
    const conclusions = card ? confirmed?.sections.map((section) => `${section.heading}：${section.body}`) ?? []
      : (meeting.outcome.items ?? []).filter((item) => item.review?.status === "confirmed").map((item) => item.text);
    const summary = clip((card ? confirmed?.summary : meeting.outcome.summary) ?? "", TEXT_CHARS);
    if (conclusions.length || summary) meetings.push({ cite: `${CITATION_SCHEME}meeting:${meeting.id}`, label: `${day(meeting.scheduledAt)} 会议 · ${clip(meeting.title, 20)}`,
      date: meeting.scheduledAt.toISOString(), title: meeting.title, conclusions, summary });
  }
  const concluded = meetings.filter((meeting) => meeting.conclusions.length).length;
  await step("meetings", "done", meetings.length ? `${meetings.length} 场${concluded < meetings.length ? `，${concluded} 场有已确认的结论` : ""}` : MISSING_RECORDS);

  await step("collector", "running");
  const collector = await readCollectorProgress(q, personId, start, end, COLLECTOR_LIMIT);
  await step("collector", "done", !collector.total ? MISSING_RECORDS
    : collector.total > collector.records.length ? `${collector.total} 条，取最近 ${collector.records.length} 条` : `${collector.total} 条`);

  await step("previous", "running");
  const previousWeek = addDays(weekStart, -7);
  const previous = (await q(`SELECT id::text AS id, body FROM weekly_reviews WHERE person_id=$1 AND week_start=$2 AND status='submitted'`,
    [personId, previousWeek])).rows[0] as { id: string; body: TWeeklyReviewBody } | undefined;
  const previousReview = previous ? { cite: `${CITATION_SCHEME}weekly-review:${previous.id}`, label: `${shortDay(previousWeek)} 周复盘`,
    weekStart: previousWeek, text: weeklyReviewText(previous.body) } : null;
  await step("previous", "done", previousReview ? shortDay(previousWeek) : MISSING_RECORDS);

  const input: WeeklyReviewDraftInput = {
    personId, weekStart, weekEnd: addDays(weekStart, 6), period, missions, tasks, progress, meetings, collectorRecords: collector.records, previousReview,
    missingRecords: [
      ...(missions.length ? [] : ["Mission 卡" as const]),
      ...(progress.length ? [] : ["Mission 与 Task 进展" as const]),
      ...(meetings.length ? [] : ["会议结论" as const]),
      ...(collector.total ? [] : ["采集记录" as const]),
      ...(previousReview ? [] : ["上周复盘" as const]),
    ],
  };
  distinctLabels(weeklyRecords(input));
  return input;
}
