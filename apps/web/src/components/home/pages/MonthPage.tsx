"use client";

/**
 * 月份页（「本月」、等你里月份那一行点进来，设计 10.4、10.5；11/19 改成 DRI 的根据地，.scratch/month-page-20261119/design.md）：文档类页面，没有主按钮。
 * 这一页只回答：我这个月答应了什么、哪件该动手了、每件到哪了。一种字号，层级只靠深浅和字重。
 * - 每个 Mission 一块：Mission 名加重，右边「完成数/总数」，有延期、取消时「· 延期 N · 取消 N」；下面淡色一句成果（和标题一样时不写）。
 * - Mission 里按验收时间点分段，段头「11/18 验收 · 已过 1 天」，过了、段里还有没交的标橙。
 * - 每件 Task 一行，行尾只写有的：达到了几条「1/3」，再加最多一个词（等你 N / 受阻 N / 进行中 N / 交付第 N 版，取第一个有的）。
 *   完成的行首一个勾、整行变淡；延续来的写「延续自 10 月的 X」，已经延续出去的下面一行「已延续到 X」（点了进那件）。
 * - 点行展开、再点收起：每条完成标准一行，达到的打勾；下面一行验收时间点、去向、项目名（点了进这件 Task 的管线；没挂的「挂到」和「详情」）。
 *   验收时间点就地改（项目详情那个小日期选择，按 Task 存），改了行上淡色「原 11/18」（原值是 Mission 节点算的，改回一样就不写）；
 *   去向就地定（复盘页的去向下拉，同一个接口，月中也能定）。没成写「失败 · 重试」，不弹 toast。
 * - 定了延期、取消的从上面挪到最下面「延期和取消」：一件一行，名字、去向下拉。
 * - 名字、完成标准就地改（复盘页备注框的样子：平时是字，悬停有底，聚焦出框；回车或离开保存，Esc 取消；清空一条再存就是删；「+ 加一条」）。
 *   天枢里先生效、不写本体：行上淡色「未进本体」，改过的标准一种底色、下面淡色「原 〈原文〉」，展开里「未进本体 · 恢复」。
 * - Mission 末尾「+ 添一件」：写个名字回车，在这个 Mission 下新建一件天枢里的 Task（也写「未进本体」，没有本体原文，不出「恢复」；不要了选「已取消」）。
 * - 下半：下个月 Co-Agent 的草稿，按 Mission 分组（接口等溪南，现在没有）。
 * 数据见 useMonthPage。
 * 复盘期间（月份已经过去，或本月最后两天，同服务端）月份页就是复盘页（MonthReview，设计第三版，读 GET …/review），上面这些不画。
 */
import { useEffect, useRef, useState } from "react";
import { DatePicker } from "@/components/ui/DatePicker";
import { Check, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { FailedLine } from "@/components/work/DecisionBox";
import { BUDDY_HREF, monthLabel, projectHref, taskHref } from "@/lib/home/derive";
import { monthHref } from "../pageKeys";
import type { MonthExtras } from "./monthLive";
import type { MonthPageProps } from "./index";
import { DispositionPick, MonthReviewView, ReviewHeadTrail } from "./MonthReview";
import { dispositionText, headText, useMonthReview, type MonthReview, type ReviewActions } from "./useMonthReview";
import { ICON, Loading, Section } from "./parts";
import { monthSource, nextPeriod, useMonthPage, type MonthActions, type MonthPageData, type MonthTask } from "./useMonthPage";
import h from "@/styles/home.module.css";
import p from "@/styles/home-pages.module.css";

export function MonthPage({ go, period, today = null, onHead, extras, onChanged }: MonthPageProps) {
  const { review, failed, retry, actions } = useMonthReview(period, today);
  if (failed !== null) return <FailedLine reason={failed} onRetry={retry} />;
  if (review === undefined) return <Loading />;
  if (review) return <ReviewPage review={review} actions={actions} go={go} onHead={onHead} />;
  return <MonthTasks go={go} period={period} today={today} onHead={onHead} extras={extras} onChanged={onChanged} />;
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

function MonthTasks({ go, period, today, onHead, extras, onChanged }: { go: (href: string) => void; period: string; today: string | null; onHead: MonthPageProps["onHead"];
  extras: MonthPageProps["extras"]; onChanged: MonthPageProps["onChanged"] }) {
  const { data, failed, retry, actions } = useMonthPage(period, monthSource, onChanged);
  useEffect(() => {
    onHead?.({ title: monthLabel(period), trail: <MonthNav period={period} today={today} go={go} /> });
  }, [onHead, period, today, go]);
  useEffect(() => () => onHead?.(null), [onHead]);
  if (failed !== null) return <FailedLine reason={failed} onRetry={retry} />;
  if (!data) return <Loading />;
  return <MonthView data={data} go={go} extras={extras} today={today} actions={actions} />;
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

/**
 * extras（只有当月有，来自首页数据）：每件 Task 等你几件、挂着的项目，没挂的「挂到」。
 * actions：就地改验收时间点、定去向；没有（只读的预览、测试）时那两样只写字。
 */
export function MonthView({ data, go, extras, today = null, actions }: { data: MonthPageData; go: (href: string) => void; extras?: (task: { taskId: string; missionId: string }) => MonthExtras;
  today?: string | null; actions?: MonthActions }) {
  const draft = data.draft;
  const extraOf = (task: MonthTask) => extras?.({ taskId: task.taskId, missionId: task.missionId });
  const aside = data.tasks.filter((task) => task.disposition !== "current");
  return (
    <>
      {data.tasks.length ? byMission(data.tasks, (task) => task.missionId).map((tasks) => (
        <MissionBlock key={tasks[0]!.missionId} tasks={tasks} period={data.period} go={go} extraOf={extraOf} today={today} actions={actions} />
      )) : <p className={h.waitEmpty} data-testid="month-empty">{monthLabel(data.period)}还没有 Mission</p>}
      {aside.length ? (
        <section className={p.monthMission} aria-label="延期和取消" data-testid="month-set-aside">
          <div className={p.monthMissionHead}><h2 className={p.monthMissionName}>延期和取消</h2></div>
          {aside.map((task) => (
            <div key={task.taskId} className={p.monthAside} data-testid="month-aside-row">
              <span className={p.monthAsideName}>{task.name}</span>
              {actions ? <DispositionPick task={{ ...task, canChange: true }} period={data.period} actions={actions} /> : <span className={p.monthFaint}>{dispositionText(task)}</span>}
            </div>
          ))}
        </section>
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
    </>
  );
}

export function MissionBlock({ tasks, period, go, extraOf, today, actions }: { tasks: MonthTask[]; period: string; go: (href: string) => void; extraOf: (task: MonthTask) => MonthExtras | undefined;
  today: string | null; actions?: MonthActions }) {
  const { missionTitle: title, missionOutcome: outcome } = tasks[0]!;
  const waitingOf = (task: MonthTask) => extraOf(task)?.waiting ?? 0;
  return (
    <section className={p.monthMission} aria-label={title} data-testid="month-mission">
      <div className={p.monthMissionHead}>
        <h2 className={p.monthMissionName}>{title}</h2>
        <span className={p.monthFaint}>{missionCount(tasks)}</span>
      </div>
      {outcome && outcome !== title ? <p className={p.monthOutcome}>{outcome}</p> : null}
      {bySegments(tasks.filter((task) => task.disposition === "current"), waitingOf).map((segment) => {
        const days = segment.date ? daysTo(segment.date, today) : null;
        const overdue = days !== null && days < 0 && segment.tasks.some((task) => !isDone(task) && task.disposition === "current");
        return (
          <div key={segment.date ?? "none"}>
            {segment.date ? <p className={p.segmentTitle} data-testid="month-segment" data-overdue={overdue ? "" : undefined}>{segmentLabel(segment.date, today)}</p> : null}
            {segment.tasks.map((task) => <MonthTaskRow key={task.taskId} task={task} period={period} go={go} extra={extraOf(task)} actions={actions} />)}
          </div>
        );
      })}
      {actions ? (
        <div className={p.monthAddTask}>
          <AddLine text="添一件" label="添一件" placeholder="Task 名" onSave={async (name) => { if (name.trim()) await actions.addTask(tasks[0]!.missionId, name.trim()); }} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * 一件 Task：点行展开看完成标准和验收时间点、去向、项目，再点收起。
 * 有 actions 时展开里就地改：名字（展开后行上的名字变成可改的字）、每条标准、「+ 加一条」、改过的「恢复」。
 */
export function MonthTaskRow({ task, period, go, extra, actions }: { task: MonthTask; period: string; go: (href: string) => void; extra?: MonthExtras; actions?: MonthActions }) {
  const [open, setOpen] = useState(false);
  const done = isDone(task);
  const to = task.settlement?.kind === "continued" ? task.settlement.to : null;
  const from = task.continuedFrom;
  const trail = rowTrail(task, extra?.waiting ?? 0);
  const project = extra?.project ?? null;
  const texts = task.criteria.map((criterion) => criterion.text);
  const saveCriteria = (criteria: string[]) => actions!.setGoal(task.taskId, { criteria: criteria.map((text) => text.trim()).filter(Boolean) });
  const saveName = async (text: string) => { if (text.trim()) await actions!.setGoal(task.taskId, { name: text.trim() }); };
  const restore = () => task.edited ? actions?.setGoal(task.taskId, { name: task.edited.name ?? task.name, criteria: task.edited.criteria ?? texts }) : undefined;
  const marks = (
    <>
      {task.dueDate && task.missionDueDate && task.dueDate !== task.missionDueDate ? <span className={p.monthFaint}>原 {shortDate(task.missionDueDate)}</span> : null}
      {task.edited || task.added ? <span className={p.monthFaint}>未进本体</span> : null}
      {from ? <span className={p.monthFaint}>延续自{from.period ? ` ${monthLabel(from.period)}` : ""}的{from.name}</span> : null}
    </>
  );
  const slot = <span className={h.slotState}>{done ? <Check {...ICON} aria-label="已完成" /> : null}</span>;
  const status = trail ? <span className={p.monthTrail} data-testid="task-status">{trail}</span> : null;
  return (
    <div className={p.monthTask} data-testid="month-task" data-done={done ? "" : undefined} data-open={open ? "" : undefined}>
      {open && actions ? (
        // 展开着、能改：名字变成可改的字；点这一行别的地方（或行首）收起。
        <div className={p.monthTaskLine} data-testid="month-task-line" onClick={(event) => { if (!(event.target as HTMLElement).closest("textarea, input")) setOpen(false); }}>
          <button type="button" className={p.monthFold} aria-expanded aria-label="收起" onClick={(event) => { event.stopPropagation(); setOpen(false); }}>{slot}</button>
          <span className={p.monthTaskText}>
            <InlineText value={task.name} label="Task 名" required changed={task.edited?.name != null} onSave={saveName} />
            {marks}
          </span>
          {status}
        </div>
      ) : (
        <button type="button" className={p.monthTaskLine} data-testid="month-task-line" aria-expanded={open} onClick={() => setOpen(!open)}>
          {slot}
          <span className={p.monthTaskText}>
            <span>{task.name}</span>
            {marks}
          </span>
          {status}
        </button>
      )}
      {open ? (
        <div className={p.monthDetail} data-testid="month-detail">
          {task.criteria.length || actions ? (
            <ul className={p.monthCriteria}>
              {task.criteria.map((criterion, index) => (
                <li key={index} className={p.monthCriterion} data-testid="month-criterion" data-changed={criterion.changed ? "" : undefined}>
                  <span className={h.slotState}>{criterion.met ? <Check {...ICON} aria-label="达到" /> : null}</span>
                  <span className={p.monthCriterionText}>
                    {actions ? <InlineText value={criterion.text} label={`第 ${index + 1} 条完成标准`} changed={criterion.changed}
                      onSave={(text) => saveCriteria(texts.map((value, at) => (at === index ? text : value)))} /> : <span>{criterion.text}</span>}
                    {criterion.original ? <span className={p.monthFaint}>原 {criterion.original}</span> : null}
                  </span>
                </li>
              ))}
              {actions ? (
                <li className={p.monthCriterion}>
                  <span className={h.slotState} />
                  <AddLine text="加一条" label="加一条完成标准" placeholder="完成标准" onSave={(text) => saveCriteria([...texts, text])} />
                </li>
              ) : null}
            </ul>
          ) : null}
          <div className={p.monthFacts}>
            {actions ? <DueDatePick task={task} actions={actions} /> : task.dueDate ? <span>验收 {shortDate(task.dueDate)}</span> : null}
            {actions ? <DispositionPick task={{ ...task, canChange: true }} period={period} actions={actions} /> : <span>{dispositionText(task)}</span>}
            {project ? <button type="button" className={p.monthLink} onClick={() => go(projectHref(project.projectId))}>{project.name}</button> : (
              <>
                {extra?.attach ?? null}
                <button type="button" className={p.monthLink} onClick={() => go(taskHref(task.taskId))}>详情</button>
              </>
            )}
            {task.edited || task.added ? (
              <span>未进本体{actions && task.edited ? <> · <button type="button" className={p.monthLink} onClick={() => void restore()}>恢复</button></> : null}</span>
            ) : null}
          </div>
        </div>
      ) : null}
      {to ? (
        <p className={h.line} data-testid="month-continued"><button type="button" className={h.lineLink} onClick={() => go(taskHref(to.taskId))}>已延续到{to.period ? ` ${monthLabel(to.period)}` : ""}的{to.name}</button></p>
      ) : null}
    </div>
  );
}

type Failure = { reason: string; retry: () => void };
/**
 * 就地改的字（复盘页备注框的样子）：平时是字，悬停有底，聚焦出框，放不下换行；回车或离开保存，Esc 取消。
 * 没改不存；required 的清空了不存、换回原来的；没成写「失败 · 重试」，不弹 toast。changed：和本体不一样的一种底色。
 */
function InlineText({ value, label, placeholder, required = false, changed = false, autoFocus = false, onSave, onDone }: { value: string; label: string; placeholder?: string;
  required?: boolean; changed?: boolean; autoFocus?: boolean; onSave: (text: string) => Promise<void>; onDone?: () => void }) {
  const [text, setText] = useState(value);
  const [failed, setFailed] = useState<Failure | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setText(value); }, [value]);
  const commit = () => {
    if (text.trim() === value.trim() || (required && !text.trim())) { setText(value); onDone?.(); return; }
    const once = () => {
      setFailed(null);
      void onSave(text).then(() => onDone?.(), (error: unknown) => setFailed({ reason: error instanceof Error ? error.message : "", retry: once }));
    };
    once();
  };
  return (
    <>
      <textarea ref={ref} className={p.monthEdit} rows={1} value={text} placeholder={placeholder} aria-label={label} maxLength={500} autoFocus={autoFocus}
        data-changed={changed ? "" : undefined} onChange={(event) => setText(event.target.value.replace(/\n/g, ""))} onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); ref.current?.blur(); }
          if (event.key === "Escape") { event.preventDefault(); setText(value); window.requestAnimationFrame(() => ref.current?.blur()); }
        }} />
      {failed ? <FailedLine inline reason={failed.reason} onRetry={failed.retry} /> : null}
    </>
  );
}

/** 「+ 加一条」「+ 添一件」（复盘页「+ 添加」的样子）：点了变成空的输入框，回车加上；空着离开就收回去。 */
function AddLine({ text, label, placeholder, onSave }: { text: string; label: string; placeholder: string; onSave: (text: string) => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  if (!adding) return <button type="button" className={p.monthAdd} onClick={() => setAdding(true)}><Plus size={14} strokeWidth={1.8} aria-hidden />{text}</button>;
  return <InlineText value="" label={label} placeholder={placeholder} required autoFocus onSave={onSave} onDone={() => setAdding(false)} />;
}

/** 展开里的「验收」：项目详情那个小日期选择（按 Task 存）；改过的能清掉、退回 Mission 的节点。没成写「失败 · 重试」。 */
function DueDatePick({ task, actions }: { task: MonthTask; actions: MonthActions }) {
  const [failed, setFailed] = useState<{ reason: string; retry: () => void } | null>(null);
  const change = (value: string) => {
    const once = () => {
      setFailed(null);
      void actions.setDueDate(task.taskId, value || null).catch((error: unknown) => setFailed({ reason: error instanceof Error ? error.message : "", retry: once }));
    };
    once();
  };
  return (
    <span className={p.monthDue} data-testid="month-due">
      <span>验收</span>
      <DatePicker label="验收" size="compact" value={task.dueDate ?? ""} clearable={task.dueDate !== task.missionDueDate} onChange={change} />
      {failed ? <FailedLine inline reason={failed.reason} onRetry={failed.retry} /> : null}
    </span>
  );
}
