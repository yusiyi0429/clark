"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { getLocalTimeZone, parseDate, today } from "@internationalized/date";
import { ArrowLeft, ArrowRight, ArrowUpRight, CalendarDays, Check, ChevronLeft, ChevronRight, CircleHelp } from "lucide-react";
import { Button as AriaButton, Calendar, CalendarCell, CalendarGrid, CalendarGridBody, CalendarGridHeader, CalendarHeaderCell, Dialog, DialogTrigger, Heading, I18nProvider, Popover } from "react-aria-components";
import { TianshuPortalTheme } from "ts-design";
import { Button } from "ts-design/primitives";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { ExecutionItemsTour } from "@/components/tours/ExecutionItemsTour";
import c from "./create-task.module.css";

type Plan = components["schemas"]["MonthPlanResponse"];
type Step = "what" | "mission" | "when";
const cards: [] = [];
const STEP_LABEL: Record<Step, string> = { what: "做什么", mission: "推进哪个 Mission", when: "时间与完成标准" };
const READ_FAILED = "暂时读不到你的 Mission，可以先作为独立事项开启。请稍后重试。";
const todayIso = () => today(getLocalTimeZone()).toString();
const WEEKDAY = "日一二三四五六";
/** 10月12日 周一；不在今年才带年份。 */
const dayLabel = (iso: string) => {
  const date = parseDate(iso);
  const year = date.year === today(getLocalTimeZone()).year ? "" : `${date.year}年`;
  return `${year}${date.month}月${date.day}日 周${WEEKDAY[date.toDate("UTC").getUTCDay()]}`;
};

/** 一个日期：一枚快捷项（开始是「今天」，截止是「还没想好」），一枚「选日期」点开同款样式的月历。 */
function DateChoice({ label, value, quick, min, max, onChange }: {
  label: string; value: string; quick: { value: string; label: string }; min?: string; max?: string; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const custom = value !== quick.value;
  return <div className={c.field} role="group" aria-label={label}>
    <span className={c.label}>{label}</span>
    <div className={c.chips}>
      <button type="button" className={c.chip} data-on={!custom || undefined} aria-pressed={!custom} onClick={() => onChange(quick.value)}>{quick.label}</button>
      <DialogTrigger isOpen={open} onOpenChange={setOpen}>
        <AriaButton className={c.chip} data-on={custom || undefined}><CalendarDays size={14} aria-hidden />{custom ? dayLabel(value) : "选日期"}</AriaButton>
        <Popover className={c.popover} placement="bottom start" offset={8}>
          <TianshuPortalTheme><Dialog className={c.dialog} aria-label={`选择${label}日期`}>
            <I18nProvider locale="zh-CN">
              <Calendar value={value ? parseDate(value) : null} minValue={min ? parseDate(min) : undefined} maxValue={max ? parseDate(max) : undefined} onChange={(date) => { onChange(date.toString()); setOpen(false); }}>
                <header className={c.calHead}>
                  <Heading className={c.calTitle} />
                  <AriaButton slot="previous" className={c.calNav}><ChevronLeft size={16} aria-hidden /></AriaButton>
                  <AriaButton slot="next" className={c.calNav}><ChevronRight size={16} aria-hidden /></AriaButton>
                </header>
                <CalendarGrid className={c.calGrid}>
                  <CalendarGridHeader>{(day) => <CalendarHeaderCell className={c.calWeekday}>{day}</CalendarHeaderCell>}</CalendarGridHeader>
                  <CalendarGridBody>{(date) => <CalendarCell date={date} className={c.calDay}>{date.day}</CalendarCell>}</CalendarGridBody>
                </CalendarGrid>
              </Calendar>
            </I18nProvider>
          </Dialog></TianshuPortalTheme>
        </Popover>
      </DialogTrigger>
    </div>
  </div>;
}

/**
 * 新建执行事项：一步一问，整个左侧是这一步的舞台（样式跟首次引导的演示动画一致）。
 * ① 做什么 → ② 推进哪个 Mission（本月没有 Mission 时跳过）→ ③ 什么时候做（不选就是今天开始、截止还没想好）。
 */
export function CreateTaskScreen() {
  const workspace = useWorkspace();
  useRegisterDetail({ scope: "global", label: "开启执行事项", mark: null, cards });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<Step>("what");
  const [title, setTitle] = useState("");
  const [linked, setLinked] = useState(false);
  const [missionId, setMissionId] = useState("");
  const [startDate, setStartDate] = useState(todayIso);
  const [dueDate, setDueDate] = useState("");
  const [doneDefinition, setDoneDefinition] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const clientId = useRef<string | null>(null);
  const change = (set: (value: string) => void, value: string) => { set(value); setError(""); clientId.current = null; };

  useEffect(() => {
    let live = true;
    void browserApi.GET("/api/me/plan").then(({ data }) => {
      if (!live) return;
      if (data) setPlan(data);
      else setError(READ_FAILED);
    }).catch(() => { if (live) setError(READ_FAILED); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const missions = plan?.editable ? plan.groups.filter((group) => group.missionId).map((group) => ({ id: group.missionId!, title: group.title, battlefield: group.battlefieldName })) : [];
  const steps: Step[] = !loading && missions.length === 0 ? ["what", "when"] : ["what", "mission", "when"];
  // 读完发现没有 Mission 时，停在第二步的人直接落到最后一步。
  const current: Step = steps.includes(step) ? step : "when";
  const index = steps.indexOf(current);
  const chosen = linked ? missions.find((mission) => mission.id === missionId) : undefined;

  const toggle = () => {
    const next = !linked;
    setLinked(next); setError(""); clientId.current = null;
    // 打开时默认选第一个（只有一个就是它）；关掉就是独立事项。
    setMissionId(next ? missionId || missions[0]?.id || "" : "");
  };
  const go = (to: Step) => { setError(""); setStep(to); };

  const create = async () => {
    if (startDate && dueDate && startDate > dueDate) return setError("计划开始不能晚于截止日期。");
    setBusy(true); setError("");
    clientId.current ??= crypto.randomUUID();
    try {
      const { data, error: failure } = await browserApi.POST("/api/me/tasks", { body: {
        clientId: clientId.current, title: title.trim(), missionId: chosen?.id ?? null, startDate,
        ...(dueDate ? { dueDate } : {}),
        ...(doneDefinition.trim() ? { doneDefinition: doneDefinition.trim() } : {}),
      } });
      if (data) { window.dispatchEvent(new Event("member-tasks-changed")); workspace.navigate(`/me/tasks/${encodeURIComponent(data.id)}`); }
      else setError(failure?.message ?? "没建成，请重试。输入已经保留。");
    } catch { setError("没建成，网络断了。输入已经保留，请重试。"); }
    finally { setBusy(false); }
  };
  // 回车 = 下一步；最后一步才真正开启。
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return go("what");
    if (index < steps.length - 1) return go(steps[index + 1]);
    void create();
  };

  return <DetailFrame title="开启执行事项" subtitle="我的工作台" onBack={workspace.close} actions={<Button variant="ghost" isIconOnly className={c.help} aria-label="查看执行事项使用说明" onPress={() => setTourOpen(true)}><CircleHelp size={17} aria-hidden /></Button>}>
    <form className={c.flow} onSubmit={submit} noValidate>
      <ol className={c.steps} aria-label={`第 ${index + 1} 步，共 ${steps.length} 步`}>
        {steps.map((item, position) => <li key={item} data-state={position < index ? "done" : position === index ? "current" : "next"}>
          {position < index
            ? <button type="button" onClick={() => go(item)} aria-label={`回到：${STEP_LABEL[item]}`}><span className={c.dot}><Check size={11} strokeWidth={3} aria-hidden /></span><span>{STEP_LABEL[item]}</span></button>
            : <span className={c.stepLabel}><span className={c.dot}>{position + 1}</span><span>{STEP_LABEL[item]}</span></span>}
        </li>)}
      </ol>

      {current !== "what" ? <button type="button" className={c.recap} onClick={() => go("what")}>
        <span>{title.trim()}</span>{current === "when" && chosen ? <small>推进 · {chosen.title}</small> : null}
      </button> : null}

      <div className={c.stage} key={current}>
        {current === "what" ? <>
          <h2 className={c.question}>这件事是什么？</h2>
          <label className={c.titleField}>
            <span className={c.srOnly}>执行事项标题</span>
            <input name="title" className={c.titleInput} value={title} onChange={(event) => change(setTitle, event.target.value)} placeholder="整理 Q3 流失客户名单" maxLength={120} autoFocus autoComplete="off" />
          </label>
          <p className={c.hint}>用一句短话说清要完成的事，回车继续。</p>
        </> : null}

        {current === "mission" ? <>
          <h2 className={c.question}>推进哪个 Mission？</h2>
          <p className={c.hint}>挂上之后，这件事会出现在那个 Mission 的进展里；不挂就是独立事项。</p>
          <div className={c.link}>
            <div className={c.switchRow}>
              <span className={c.switchText}>
                <span id="create-task-link">挂在 Mission 下</span>
                <small>{loading ? "正在读取你的 Mission…" : linked ? "推进下面选中的 Mission" : "现在是独立事项"}</small>
              </span>
              <button type="button" role="switch" aria-checked={linked} aria-labelledby="create-task-link" className={c.switch} disabled={loading} onClick={toggle} autoFocus><span aria-hidden /></button>
            </div>
            {linked && missions.length > 1 ? <div className={c.missions} role="radiogroup" aria-label="选择 Mission">
              {missions.map((mission) => <label key={mission.id} className={c.mission} data-selected={missionId === mission.id || undefined}>
                <input type="radio" name="create-task-mission" value={mission.id} checked={missionId === mission.id} onChange={() => change(setMissionId, mission.id)} />
                <span className={c.missionText}><span>{mission.title}</span><small>{mission.battlefield}</small></span>
              </label>)}
            </div> : null}
            {linked && missions.length === 1 ? <p className={c.only}>{missions[0].title}<small>{missions[0].battlefield}</small></p> : null}
          </div>
        </> : null}

        {current === "when" ? <>
          <h2 className={c.question}>什么时候做？</h2>
          <div className={c.twoFields}>
            <DateChoice label="开始" value={startDate} quick={{ value: todayIso(), label: "今天" }} max={dueDate || undefined} onChange={(value) => change(setStartDate, value)} />
            <DateChoice label="截止" value={dueDate} quick={{ value: "", label: "还没想好" }} min={startDate} onChange={(value) => change(setDueDate, value)} />
          </div>
          <label className={c.field}>
            <span className={c.label}>完成标准<small className={c.optional}>可不填 · 一行一条，验收时逐条对照</small></span>
            <textarea className={c.input} rows={3} value={doneDefinition} onChange={(event) => change(setDoneDefinition, event.target.value)} placeholder={"例如：一页结论\n支撑结论的依据"} maxLength={500} />
          </label>
        </> : null}
      </div>

      {error ? <p className={c.error} role="alert">{error}</p> : null}
      <div className={c.actions}>
        {index > 0 ? <button type="button" className={c.back} onClick={() => go(steps[index - 1])}><ArrowLeft size={15} aria-hidden />上一步</button> : <span />}
        {current === "when"
          ? <Button variant="primary" type="submit" isDisabled={busy || !title.trim()} className={c.primary}>{busy ? "正在开启…" : "开启执行事项"}<ArrowUpRight size={15} aria-hidden /></Button>
          : <Button variant="primary" type="submit" isDisabled={!title.trim()} className={c.primary}>下一步<ArrowRight size={15} aria-hidden /></Button>}
      </div>
    </form>
    {tourOpen ? <ExecutionItemsTour isOpen onExit={() => setTourOpen(false)} /> : null}
  </DetailFrame>;
}
