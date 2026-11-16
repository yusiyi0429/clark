"use client";

/**
 * 月份页（「今天」行的「复盘」「12 月待敲定」chip、等你里月份那一行点进来，设计 10.4、10.5、5.4.6）：文档类页面，没有主按钮。
 * - 上半：这个月每件 Task 一行（和左栏 Task 行同一个样子），小字「约定 2/3 · 交付第 2 版 · 进行中 1」，延续来的再加「延续自 10 月的 X」；
 *   本人确认完成的行首一个勾、整行变淡；已经延续出去的下面一行「已延续到 X」（点了进那件）。点 Task 行进它的管线。
 * - 下半：下个月 Co-Agent 的草稿，按 Mission 分组；延续来的小字写「延续自 11 月的 X · X 现在的状态」。
 * - 底部两个动作：「和伙伴过一遍」（进总管线，伙伴已经读过草稿）、「去 M2 签复盘」（整页去 M2，ArrowUpRight）。
 * 数据见 useMonthPage（接口等 B2）。
 * 复盘期间（月份已经过去，或本月最后两天，同服务端）月份页就是复盘页（MonthReview，设计第三版，读 GET …/review），上面这些不画。
 * 第一版的「怎么办」（继续做 / 改一改再做 / 到此为止）随旧答案一起删了（本人 11/11 定，去向和评定都在复盘页）。
 */
import { ArrowUpRight, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { FailedLine } from "@/components/work/DecisionBox";
import { BUDDY_HREF, monthLabel, taskHref } from "@/lib/home/derive";
import { monthHref } from "../pageKeys";
import type { MonthExtras } from "./monthLive";
import { useEffect } from "react";
import type { MonthPageProps } from "./index";
import { MonthReviewView, ReviewHeadTrail } from "./MonthReview";
import { headText, useMonthReview, type MonthReview, type ReviewActions } from "./useMonthReview";
import { ICON, Loading, Section } from "./parts";
import { monthSummary, nextPeriod, useMonthPage, type MonthPageData, type MonthTask } from "./useMonthPage";
import h from "@/styles/home.module.css";
import p from "@/styles/home-pages.module.css";


const openM2 = () => window.location.assign("/m2/");

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
  if (failed !== null) return <><FailedLine reason={failed} onRetry={retry} /><MonthFoot go={go} /></>;
  if (!data) return <Loading />;
  return <MonthView data={data} go={go} extras={extras} today={today} />;
}

const DAY_MS = 86_400_000;
/** 段头「11/18 验收 · 剩 2 天」：今天写「今天」，过了写「已过」。 */
function segmentLabel(gate: string, period: string, today: string | null): string {
  const match = /^(\d{2})\/(\d{2})/.exec(gate);
  if (!match || !today) return gate;
  const days = Math.round((Date.UTC(Number(period.slice(0, 4)), Number(match[1]) - 1, Number(match[2])) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  return `${gate} · ${days > 0 ? `剩 ${days} 天` : days === 0 ? "今天" : "已过"}`;
}

/** 一个 Mission 里按验收时间点分段：日期早的段在前，没有日期的段在最后；段内有等你的在前，其次有新结果的、在跑的、未开始的，已完成的最后（第 66 条）。 */
export function bySegments(tasks: MonthTask[], extrasOf: (task: MonthTask) => MonthExtras): { gate: string | null; tasks: MonthTask[] }[] {
  const groups = new Map<string | null, MonthTask[]>();
  for (const task of tasks) {
    const gate = extrasOf(task).gate;
    groups.set(gate, [...(groups.get(gate) ?? []), task]);
  }
  const rank = (task: MonthTask) => (task.done ? 9 : extrasOf(task).status?.rank ?? 3);
  return [...groups].sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([gate, list]) => ({ gate, tasks: [...list].sort((x, y) => rank(x) - rank(y)) }));
}

/** 按 Mission 分组，顺序照数据给的。 */
function byMission<T>(items: T[], title: (item: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(title(item), [...(groups.get(title(item)) ?? []), item]);
  return [...groups];
}

/**
 * extras（只有当月有，来自首页数据）：每件 Task 的验收时间点、现状、项目那一格；有它时 Mission 里按验收时间点分段，标题下一行写「8 件 Task · 完成 0 · 下次验收 11/18」。
 */
export function MonthView({ data, go, extras, today = null }: { data: MonthPageData; go: (href: string) => void; extras?: (task: { taskId: string; missionId: string }) => MonthExtras; today?: string | null }) {
  const draft = data.draft;
  const extrasOf = (task: MonthTask) => extras?.({ taskId: task.taskId, missionId: task.missionId }) ?? { gate: null, status: null, project: null };
  const nextGate = extras ? data.tasks.filter((task) => !task.done).map((task) => extrasOf(task).gate).filter((gate): gate is string => !!gate).sort()[0] ?? null : null;
  const summary = [`${data.tasks.length} 件 Task`, `完成 ${data.tasks.filter((task) => task.done).length}`, nextGate ? `下次验收 ${nextGate.replace(/ 验收$/, "")}` : null].filter(Boolean).join(" · ");
  return (
    <>
      {data.tasks.length ? (
        <Section title={`${monthLabel(data.period)}的 Task`} testId="month-tasks">
          <p className={p.monthSummary} data-testid="month-summary">{summary}</p>
          <div>
            {byMission(data.tasks, (task) => task.missionTitle).map(([mission, tasks]) => (
              <div key={mission}>
                <p className={p.groupTitle}>{mission}</p>
                {extras ? bySegments(tasks, extrasOf).map((segment) => (
                  <div key={segment.gate ?? "none"}>
                    {segment.gate ? <p className={p.segmentTitle} data-testid="month-segment">{segmentLabel(segment.gate, data.period, today)}</p> : null}
                    {segment.tasks.map((task) => <MonthTaskRow key={task.taskId} task={task} go={go} extra={extrasOf(task)} />)}
                  </div>
                )) : tasks.map((task) => <MonthTaskRow key={task.taskId} task={task} go={go} />)}
              </div>
            ))}
          </div>
        </Section>
      ) : <p className={h.waitEmpty} data-testid="month-empty">{monthLabel(data.period)}还没有 Mission</p>}
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
      <MonthFoot go={go} />
    </>
  );
}

function MonthTaskRow({ task, go, extra }: { task: MonthTask; go: (href: string) => void; extra?: MonthExtras }) {
  const done = task.done || task.settlement?.kind === "completed";
  const to = task.settlement?.kind === "continued" ? task.settlement.to : null;
  const from = task.continuedFrom;
  const status = extra?.status ?? null;
  return (
    <div className={p.monthTask} data-done={done ? "" : undefined} data-testid="month-task">
      <div className={p.monthTaskLine}>
        <button type="button" className={h.taskLine} onClick={() => go(taskHref(task.taskId))}>
          <span className={h.slotState}>{done ? <Check {...ICON} aria-label="已完成" /> : null}</span>
          <span className={h.taskText}>
            <span className={h.taskName}>{task.name}</span>
            <span className={h.taskSub}>{[monthSummary(task), from ? `延续自${from.period ? ` ${monthLabel(from.period)}` : ""}的${from.name}` : null].filter(Boolean).join(" · ")}</span>
          </span>
          {status?.text ? <span className={h.taskGate} title={status.text} data-testid="task-status">{status.waiting ? <span className={h.count}><i aria-hidden /></span> : null}{status.text}</span> : null}
        </button>
        {extra?.project ?? null}
      </div>
      {to ? (
        <p className={h.line} data-testid="month-continued"><button type="button" className={h.lineLink} onClick={() => go(taskHref(to.taskId))}>已延续到{to.period ? ` ${monthLabel(to.period)}` : ""}的{to.name}</button></p>
      ) : null}
    </div>
  );
}

function MonthFoot({ go }: { go: (href: string) => void }) {
  return (
    <div className={p.foot} data-testid="month-foot">
      <HeroButton variant="tertiary" size="sm" onPress={() => go(BUDDY_HREF)}>和伙伴过一遍</HeroButton>
      <HeroButton variant="tertiary" size="sm" onPress={openM2}>去 M2 签复盘<ArrowUpRight {...ICON} /></HeroButton>
    </div>
  );
}
