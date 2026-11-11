"use client";

/**
 * 月份页（「今天」行的「复盘」「12 月待敲定」chip、等你里月份那一行点进来，设计 10.4、10.5、5.4.6）：文档类页面，没有主按钮，要拿的主意都在选项框里。
 * - 上半：这个月每件 Task 一行（和左栏 Task 行同一个样子），小字「约定 2/3 · 交付第 2 版 · 进行中 1」，延续来的再加「延续自 10 月的 X」；
 *   本人确认完成的行首一个勾、整行变淡；已经延续出去的不再问，下面一行「已延续到 X」（点了进那件）。
 *   其余的下面接一个选项框「继续做（推荐）/ 改一改再做 / 到此为止 / 自己说…」，答完收成一行。点 Task 行进它的管线。
 * - 下半：下个月 Co-Agent 的草稿，按 Mission 分组；延续来的小字写「延续自 11 月的 X · X 现在的状态」。
 * - 底部两个动作：「和伙伴过一遍」（进总管线，伙伴已经读过草稿）、「去 M2 签复盘」（整页去 M2，ArrowUpRight）。
 * 数据见 useMonthPage（接口等 B2）。
 * 复盘期间（GET …/review 有这个月的复盘）月份页就是复盘页（MonthReview，设计第三版），上面这些不画；第一版的「怎么办」随旧答案一起等本人定（B 的清单第 1 条）。
 */
import { ArrowUpRight, Check } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { DecisionBox, FailedLine, type DecisionOption } from "@/components/work/DecisionBox";
import { BUDDY_HREF, monthLabel, taskHref } from "@/lib/home/derive";
import { useEffect } from "react";
import type { MonthPageProps } from "./index";
import { MonthReviewView, ReviewHeadTrail } from "./MonthReview";
import { headText, useMonthReview, type MonthReview, type ReviewActions } from "./useMonthReview";
import { ICON, Loading, Section } from "./parts";
import { CHOICE_LABEL, answerText, monthSummary, nextPeriod, settled, useMonthPage, type MonthAnswer, type MonthChoice, type MonthPageData, type MonthTask } from "./useMonthPage";
import h from "@/styles/home.module.css";
import p from "@/styles/home-pages.module.css";

const CHOICES: MonthChoice[] = ["continue", "revise", "stop"];
const OPTIONS: DecisionOption[] = CHOICES.map((choice, index) => ({ label: CHOICE_LABEL[choice], recommended: index === 0 }));

const openM2 = () => window.location.assign("/m2/");

export function MonthPage({ go, period, onHead }: MonthPageProps) {
  const { review, failed, retry, actions } = useMonthReview(period);
  if (failed !== null) return <FailedLine reason={failed} onRetry={retry} />;
  if (review === undefined) return <Loading />;
  if (review) return <ReviewPage review={review} actions={actions} go={go} onHead={onHead} />;
  return <MonthTasks go={go} period={period} />;
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

function MonthTasks({ go, period }: { go: (href: string) => void; period: string }) {
  const { data, failed, retry, decide } = useMonthPage(period);
  if (failed !== null) return <><FailedLine reason={failed} onRetry={retry} /><MonthFoot go={go} /></>;
  if (!data) return <Loading />;
  return <MonthView data={data} go={go} decide={decide} />;
}

/** 按 Mission 分组，顺序照数据给的。 */
function byMission<T>(items: T[], title: (item: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(title(item), [...(groups.get(title(item)) ?? []), item]);
  return [...groups];
}

export function MonthView({ data, go, decide }: { data: MonthPageData; go: (href: string) => void; decide: (taskId: string, answer: MonthAnswer) => Promise<void> }) {
  const next = monthLabel(nextPeriod(data.period));
  const draft = data.draft;
  return (
    <>
      {data.tasks.length ? (
        <Section title={`${monthLabel(data.period)}的 Task`} testId="month-tasks">
          <div>
            {byMission(data.tasks, (task) => task.missionTitle).map(([mission, tasks]) => (
              <div key={mission}>
                <p className={p.groupTitle}>{mission}</p>
                {tasks.map((task) => <MonthTaskRow key={task.taskId} task={task} next={next} go={go} decide={decide} />)}
              </div>
            ))}
          </div>
        </Section>
      ) : null}
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

function MonthTaskRow({ task, next, go, decide }: { task: MonthTask; next: string; go: (href: string) => void; decide: (taskId: string, answer: MonthAnswer) => Promise<void> }) {
  const done = task.done || task.settlement?.kind === "completed";
  const to = task.settlement?.kind === "continued" ? task.settlement.to : null;
  const from = task.continuedFrom;
  return (
    <div className={p.monthTask} data-done={done ? "" : undefined} data-testid="month-task">
      <button type="button" className={h.taskLine} onClick={() => go(taskHref(task.taskId))}>
        <span className={h.slotState}>{done ? <Check {...ICON} aria-label="已完成" /> : null}</span>
        <span className={h.taskText}>
          <span className={h.taskName}>{task.name}</span>
          <span className={h.taskSub}>{[monthSummary(task), from ? `延续自${from.period ? ` ${monthLabel(from.period)}` : ""}的${from.name}` : null].filter(Boolean).join(" · ")}</span>
        </span>
      </button>
      {to ? (
        <p className={h.line} data-testid="month-continued"><button type="button" className={h.lineLink} onClick={() => go(taskHref(to.taskId))}>已延续到{to.period ? ` ${monthLabel(to.period)}` : ""}的{to.name}</button></p>
      ) : null}
      {settled(task) ? null : (
        <DecisionBox kind="question" testId="month-decision" title={`${next}怎么办`} options={OPTIONS} autoFocus={false}
          resolved={task.answer ? answerText(task.answer) : undefined}
          onPick={([index], note) => decide(task.taskId, { choice: CHOICES[index ?? 0]!, note: note ?? null })}
          other={{ maxLength: 200, onSubmit: (text) => decide(task.taskId, { choice: null, note: text }) }} />
      )}
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
