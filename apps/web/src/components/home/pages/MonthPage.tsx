"use client";

/**
 * 月份页（「本月」、等你里月份那一行点进来，设计 10.4、10.5；11/19 改成 DRI 的根据地，.scratch/month-page-20261119/design.md）：文档类页面，没有主按钮。
 * 这一页只回答：我这个月答应了什么、哪件该动手了、每件到哪了。一种字号，层级只靠深浅和字重。
 * - 每个 Mission 一块：Mission 名加重，右边「完成数/总数」，有延期、取消时「· 延期 N · 取消 N」；下面淡色一句成果（和标题一样时不写）。
 * - Mission 里按验收时间点分段，段头「11/18 验收 · 已过 1 天」，过了、段里还有没交的标橙。
 * - 每件 Task 一行，行尾只写有的：达到了几条「1/3」，再加最多一个词（等你 N / 受阻 N / 进行中 N / 交付第 N 版，取第一个有的）。
 *   完成的行首一个勾、整行变淡；延续来的写「延续自 10 月的 X」，已经延续出去的下面一行「已延续到 X」（点了进那件）。
 * - 点行展开、再点收起：每条完成标准一行，达到的打勾；下面一行验收时间点、去向、项目名（点了进这件 Task 的管线；没挂的「挂到」和「详情」）。
 * - 下半：下个月 Co-Agent 的草稿，按 Mission 分组（接口等溪南，现在没有）。
 * 数据见 useMonthPage。
 * 复盘期间（月份已经过去，或本月最后两天，同服务端）月份页就是复盘页（MonthReview，设计第三版，读 GET …/review），上面这些不画。
 */
import { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { FailedLine } from "@/components/work/DecisionBox";
import { BUDDY_HREF, monthLabel, projectHref, taskHref } from "@/lib/home/derive";
import { monthHref } from "../pageKeys";
import type { MonthExtras } from "./monthLive";
import type { MonthPageProps } from "./index";
import { MonthReviewView, ReviewHeadTrail } from "./MonthReview";
import { dispositionText, headText, useMonthReview, type MonthReview, type ReviewActions } from "./useMonthReview";
import { ICON, Loading, Section } from "./parts";
import { nextPeriod, useMonthPage, type MonthPageData, type MonthTask } from "./useMonthPage";
import h from "@/styles/home.module.css";
import p from "@/styles/home-pages.module.css";

export function MonthPage({ go, period, today = null, onHead, extras }: MonthPageProps) {
  const { review, failed, retry, actions } = useMonthReview(period, today);
  if (failed !== null) return <FailedLine reason={failed} onRetry={retry} />;
  if (review === undefined) return <Loading />;
  if (review) return <ReviewPage review={review} actions={actions} go={go} onHead={onHead} />;
  return <MonthTasks go={go} period={period} today={today} onHead={onHead} extras={extras} />;
}

const FIRST_PERIOD = "2026-10";
function prevPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

/**
 * 页头右边翻月（11/16 重新设计第 6 节）：「‹ ›」翻到上个月、下个月；不在当月时多一个「回到本月」。
 * 往前最早到 2026-10（天枢 10/28 上线），往后最多到当月的下一个月（草稿）；「没有内容的月份不能翻」要多一次请求，第一版不做。
 */
export function MonthNav({ period, today, go }: { period: string; today: string | null; go: (href: string) => void }) {
  const current = today?.slice(0, 7) ?? period;
  return (
    <span className={p.monthNav}>
      {period !== current ? <HeroButton variant="ghost" size="sm" onPress={() => go(monthHref(current))}>回到本月</HeroButton> : null}
      <HeroButton variant="ghost" size="sm" isIconOnly aria-label="上个月" isDisabled={period <= FIRST_PERIOD} onPress={() => go(monthHref(prevPeriod(period)))}><ChevronLeft {...ICON} /></HeroButton>
      <HeroButton variant="ghost" size="sm" isIconOnly aria-label="下个月" isDisabled={period >= nextPeriod(current)} onPress={() => go(monthHref(nextPeriod(period)))}><ChevronRight {...ICON} /></HeroButton>
    </span>
  );
}

/** 复盘页：页头换成「11 月复盘」，右边「截止 … · 待确认 … · 延期 …」和「与伙伴讨论」。 */
function ReviewPage({ review, actions, go, onHead }: { review: MonthReview; actions: ReviewActions; go: (href: string) => void; onHead: MonthPageProps["onHead"] }) {
  const title = `${monthLabel(review.period)}复盘`;
  const text = headText(review);
  useEffect(() => {
    onHead?.({ title, trail: <ReviewHeadTrail text={text} onDiscuss={() => go(BUDDY_HREF)} /> });
  }, [onHead, title, text, go]);
  useEffect(() => () => onHead?.(null), [onHead]);
  return <MonthReviewView review={review} actions={actions} />;
}

function MonthTasks({ go, period, today, onHead, extras }: { go: (href: string) => void; period: string; today: string | null; onHead: MonthPageProps["onHead"]; extras: MonthPageProps["extras"] }) {
  const { data, failed, retry } = useMonthPage(period);
  useEffect(() => {
    onHead?.({ title: monthLabel(period), trail: <MonthNav period={period} today={today} go={go} /> });
  }, [onHead, period, today, go]);
  useEffect(() => () => onHead?.(null), [onHead]);
  if (failed !== null) return <FailedLine reason={failed} onRetry={retry} />;
  if (!data) return <Loading />;
  return <MonthView data={data} go={go} extras={extras} today={today} />;
}

const DAY_MS = 86_400_000;
/** 「2026-11-18」→「11/18」。 */
const shortDate = (date: string) => date.slice(5).replace("-", "/");
/** 离验收时间点还有几天（过了是负的）；不知道今天为 null。 */
const daysTo = (date: string, today: string | null) => (today ? Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS) : null);
/** 段头「11/18 验收 · 剩 2 天」：今天写「今天」，过了写「已过 N 天」。 */
function segmentLabel(date: string, today: string | null): string {
  const days = daysTo(date, today);
  const gate = `${shortDate(date)} 验收`;
  return days === null ? gate : `${gate} · ${days > 0 ? `剩 ${days} 天` : days === 0 ? "今天" : `已过 ${-days} 天`}`;
}

const isDone = (task: MonthTask) => task.done || task.settlement?.kind === "completed";

/**
 * 行尾：有达到的写「1/3」；后面最多一个词，按顺序取第一个有的：「等你 2」「受阻 1」「进行中 1」「交付第 2 版」。都没有为空串。
 * waiting 来自首页数据（只有当月有）。
 */
export function rowTrail(task: Pick<MonthTask, "criteria" | "blocked" | "running" | "version">, waiting: number): string {
  const met = task.criteria.filter((criterion) => criterion.met).length;
  const word = waiting ? `等你 ${waiting}` : task.blocked ? `受阻 ${task.blocked}` : task.running ? `进行中 ${task.running}` : task.version ? `交付第 ${task.version} 版` : null;
  return [met ? `${met}/${task.criteria.length}` : null, word].filter(Boolean).join(" · ");
}

/** 一个 Mission 里按验收时间点分段：日期早的段在前，没有日期的段在最后；段内有等你的在前，其次受阻、进行中，已完成的最后。 */
export function bySegments(tasks: MonthTask[], waitingOf: (task: MonthTask) => number): { date: string | null; tasks: MonthTask[] }[] {
  const groups = new Map<string | null, MonthTask[]>();
  for (const task of tasks) groups.set(task.dueDate, [...(groups.get(task.dueDate) ?? []), task]);
  const rank = (task: MonthTask) => (isDone(task) ? 9 : waitingOf(task) ? 0 : task.blocked ? 1 : task.running ? 2 : 3);
  return [...groups].sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([date, list]) => ({ date, tasks: [...list].sort((x, y) => rank(x) - rank(y)) }));
}

/** 按 Mission 分组，顺序照数据给的。 */
function byMission<T>(items: T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups.values()];
}

/** Mission 行右边：「1/8」，有延期、取消时「1/8 · 延期 1 · 取消 1」（完成的 Task 数 / 总数）。 */
function missionCount(tasks: MonthTask[]): string {
  const deferred = tasks.filter((task) => task.disposition === "deferred").length;
  const cancelled = tasks.filter((task) => task.disposition === "cancelled").length;
  return [`${tasks.filter(isDone).length}/${tasks.length}`, deferred ? `延期 ${deferred}` : null, cancelled ? `取消 ${cancelled}` : null].filter(Boolean).join(" · ");
}

/** extras（只有当月有，来自首页数据）：每件 Task 等你几件、挂着的项目，没挂的「挂到」。 */
export function MonthView({ data, go, extras, today = null }: { data: MonthPageData; go: (href: string) => void; extras?: (task: { taskId: string; missionId: string }) => MonthExtras; today?: string | null }) {
  const draft = data.draft;
  const extraOf = (task: MonthTask) => extras?.({ taskId: task.taskId, missionId: task.missionId });
  return (
    <>
      {data.tasks.length ? byMission(data.tasks, (task) => task.missionId).map((tasks) => (
        <MissionBlock key={tasks[0]!.missionId} tasks={tasks} go={go} extraOf={extraOf} today={today} />
      )) : <p className={h.waitEmpty} data-testid="month-empty">{monthLabel(data.period)}还没有 Mission</p>}
      {draft && draft.missions.some((mission) => mission.tasks.length) ? (
        <Section title={`${monthLabel(draft.period)}的草稿`} testId="month-draft">
          <div>
            {draft.missions.filter((mission) => mission.tasks.length).map((mission) => (
              <div key={mission.id}>
                <p className={p.groupTitle}>{mission.title}</p>
                {mission.tasks.map((task) => (
                  <div key={task.id} className={p.draftRow} data-testid="draft-row">
                    <span className={h.slotState} />
                    <span className={h.taskText}>
                      <span className={h.taskName}>{task.name}</span>
                      {task.continuesFrom ? (
                        <span className={h.taskSub}>延续自 {monthLabel(task.continuesFrom.period)}的{task.continuesFrom.name}{task.continuesFrom.summary ? ` · ${task.continuesFrom.summary}` : ""}</span>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Section>
      ) : null}
    </>
  );
}

function MissionBlock({ tasks, go, extraOf, today }: { tasks: MonthTask[]; go: (href: string) => void; extraOf: (task: MonthTask) => MonthExtras | undefined; today: string | null }) {
  const { missionTitle: title, missionOutcome: outcome } = tasks[0]!;
  const waitingOf = (task: MonthTask) => extraOf(task)?.waiting ?? 0;
  return (
    <section className={p.monthMission} aria-label={title} data-testid="month-mission">
      <div className={p.monthMissionHead}>
        <h2 className={p.monthMissionName}>{title}</h2>
        <span className={p.monthFaint}>{missionCount(tasks)}</span>
      </div>
      {outcome && outcome !== title ? <p className={p.monthOutcome}>{outcome}</p> : null}
      {bySegments(tasks, waitingOf).map((segment) => {
        const days = segment.date ? daysTo(segment.date, today) : null;
        const overdue = days !== null && days < 0 && segment.tasks.some((task) => !isDone(task) && task.disposition === "current");
        return (
          <div key={segment.date ?? "none"}>
            {segment.date ? <p className={p.segmentTitle} data-testid="month-segment" data-overdue={overdue ? "" : undefined}>{segmentLabel(segment.date, today)}</p> : null}
            {segment.tasks.map((task) => <MonthTaskRow key={task.taskId} task={task} go={go} extra={extraOf(task)} />)}
          </div>
        );
      })}
    </section>
  );
}

/** 一件 Task：点行展开看完成标准和验收时间点、去向、项目，再点收起。 */
export function MonthTaskRow({ task, go, extra }: { task: MonthTask; go: (href: string) => void; extra?: MonthExtras }) {
  const [open, setOpen] = useState(false);
  const done = isDone(task);
  const to = task.settlement?.kind === "continued" ? task.settlement.to : null;
  const from = task.continuedFrom;
  const trail = rowTrail(task, extra?.waiting ?? 0);
  const project = extra?.project ?? null;
  return (
    <div className={p.monthTask} data-testid="month-task" data-done={done ? "" : undefined}>
      <button type="button" className={p.monthTaskLine} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={h.slotState}>{done ? <Check {...ICON} aria-label="已完成" /> : null}</span>
        <span className={p.monthTaskText}>
          <span>{task.name}</span>
          {from ? <span className={p.monthFaint}>延续自{from.period ? ` ${monthLabel(from.period)}` : ""}的{from.name}</span> : null}
        </span>
        {trail ? <span className={p.monthTrail} data-testid="task-status">{trail}</span> : null}
      </button>
      {open ? (
        <div className={p.monthDetail} data-testid="month-detail">
          {task.criteria.length ? (
            <ul className={p.monthCriteria}>
              {task.criteria.map((criterion, index) => (
                <li key={index} className={p.monthCriterion} data-testid="month-criterion">
                  <span className={h.slotState}>{criterion.met ? <Check {...ICON} aria-label="达到" /> : null}</span>
                  <span>{criterion.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className={p.monthFacts}>
            {task.dueDate ? <span>验收 {shortDate(task.dueDate)}</span> : null}
            <span>{dispositionText(task)}</span>
            {project ? <button type="button" className={p.monthLink} onClick={() => go(projectHref(project.projectId))}>{project.name}</button> : (
              <>
                {extra?.attach ?? null}
                <button type="button" className={p.monthLink} onClick={() => go(taskHref(task.taskId))}>详情</button>
              </>
            )}
          </div>
        </div>
      ) : null}
      {to ? (
        <p className={h.line} data-testid="month-continued"><button type="button" className={h.lineLink} onClick={() => go(taskHref(to.taskId))}>已延续到{to.period ? ` ${monthLabel(to.period)}` : ""}的{to.name}</button></p>
      ) : null}
    </div>
  );
}
