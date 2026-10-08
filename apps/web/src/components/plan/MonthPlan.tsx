"use client";

import { useContext, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { TMonthPlanResponse, TTaskView } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { useConfirm } from "@/components/ConfirmDialog";
import { WorkspaceContext, useWorkspace } from "@/components/shell/WorkspaceContext";
import { dateFromPointer, draftFromPlan, planChanges, saveBody, type PlanGroup, type Step } from "./planDraft";
import s from "./month-plan.module.css";

const statusText: Record<TTaskView["status"], string> = { not_started: "未启动", in_progress: "进行中", done: "完成", returned: "退回" };
const short = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const shiftDay = (date: string, delta: number) => new Date(Date.parse(`${date}T00:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);

export function useMonthPlan(period: string, enabled: boolean) {
  const [plan, setPlan] = useState<TMonthPlanResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    browserApi.GET("/api/me/plan", { params: { query: { period } } }).then(({ data, response, error: failure }) => {
      if (!active) return;
      if (!response.ok || !data) throw new Error(failure?.message ?? "本月计划暂时无法读取");
      setPlan(data); setError("");
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "本月计划暂时无法读取"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [period, enabled]);
  return { plan, setPlan, error, loading };
}

export function LinkedTaskRows({ tasks, viewerId }: { tasks: TTaskView[]; viewerId?: string | null }) {
  const workspace = useContext(WorkspaceContext);
  const [showDone, setShowDone] = useState(false);
  // 完成的收进「已完成」，默认折叠，展开后淡色显示。
  const done = tasks.filter(task => task.status === "done");
  const row = (task: TTaskView) => <div key={task.id} className={s.taskRow} data-done={task.status === "done" || undefined}>
    <div className={s.taskMain}>{viewerId === undefined || viewerId === task.owner.personId || task.collaborators.some(person => person.personId === viewerId) ?
      <button type="button" className={s.taskLink} data-target={`/me/tasks/${encodeURIComponent(task.id)}`} onClick={event => workspace?.navigate(`/me/tasks/${encodeURIComponent(task.id)}`, event.currentTarget)}>{task.title}<ArrowUpRight size={15} aria-hidden="true" /></button> : <strong className={s.taskLink}>{task.title}</strong>}
      <p>{task.mission ? "" : "独立事项 · "}{task.dueDate ? `${short(task.dueDate)} 前` : "未定截止日期"} · {[task.owner, ...task.collaborators].map(person => person.name).join("、")}</p>
      {task.latestProgress ? <p className={s.latestProgress} title={task.latestProgress.body.slice(0, 60)}>最新进展 · {({ web: "网页", codex: "Codex", claude: "Claude Code", github: "GitHub", other: "外部工具" })[task.latestProgress.source]} · {short(task.latestProgress.createdAt.slice(0, 10))} · {task.latestProgress.body.slice(0, 60)}</p> : null}</div>
    <span className={s.taskStatus}>{statusText[task.status]}</span>
  </div>;
  return <div className={s.taskList} aria-label="关联的执行事项">
    {tasks.length ? tasks.filter(task => task.status !== "done").map(row) : <p className={s.muted}>还没有关联的执行事项。可以在本月计划里加一步。</p>}
    {done.length ? <>
      <button type="button" className={s.doneToggle} aria-expanded={showDone} onClick={() => setShowDone(value => !value)}><ChevronRight size={14} aria-hidden="true" />已完成 {done.length}</button>
      {showDone ? done.map(row) : null}
    </> : null}
  </div>;
}

type Tip = { group: number; index: number; x: number; y: number; below: boolean };
export function MonthPlan({ plan, onSaved, onDirtyChange }: { plan: TMonthPlanResponse; onSaved: (value: TMonthPlanResponse) => void; onDirtyChange: (dirty: boolean) => void }) {
  const workspace = useWorkspace();
  const [draft, setDraft] = useState(() => draftFromPlan(plan));
  const [baseline, setBaseline] = useState(() => draftFromPlan(plan));
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [adding, setAdding] = useState<number | null>(null);
  const [active, setActive] = useState<{ group: number; index: number } | null>(null);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const root = useRef<HTMLElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const drag = useRef<{ group: number; index: number; mode: "draw" | "move" | "startDate" | "dueDate"; anchor: string; start: string; due: string } | null>(null);
  const { ask, dialog } = useConfirm();
  const [year, month] = plan.period.split("-").map(Number);
  const days = new Date(year, month, 0).getDate();
  const dayNumbers = Array.from({ length: days }, (_, index) => index + 1);
  const weekend = (day: number) => [0, 6].includes(new Date(year, month - 1, day).getDay());
  const dayOf = (date: string) => Number(date.slice(8, 10));
  const visibleDay = (date: string) => date < plan.firstDay ? 1 : date > plan.lastDay ? days : dayOf(date);
  const todayDay = plan.today.startsWith(plan.period) ? dayOf(plan.today) : null;
  const changes = planChanges(baseline, draft);
  const dirty = changes.added + changes.adjusted > 0;
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  useEffect(() => {
    if (!active) return;
    const close = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Element && (!event.target.closest(`[data-edit-row="${active.group}-${active.index}"]`) ||
        !event.target.closest(`.${s.inlineEdit},.${s.labelLink}`))) setActive(null);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [active]);
  useEffect(() => {
    if (!tip) return;
    const close = (event: Event) => {
      const track = root.current?.querySelector(`[data-tip-group="${tip.group}"]`);
      if (!(event.target instanceof Node) || !track?.contains(event.target)) setTip(null);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [tip]);
  const edit = (group: number, index: number, patch: Partial<Step>) => { setNotice(""); setDraft(current => current.map((row, g) => g === group ? { ...row, items: row.items.map((item, i) => i === index ? { ...item, ...patch } : item) } : row)); };
  const reorder = (group: number, index: number, direction: -1 | 1) => { setNotice(""); setDraft(current => current.map((row, g) => {
    if (g !== group || index + direction < 0 || index + direction >= row.items.length) return row;
    const items = [...row.items]; [items[index], items[index + direction]] = [items[index + direction], items[index]];
    return { ...row, items };
  })); };
  const add = (group: number) => {
    const title = titles[group]?.trim();
    if (!title) { setError("先填写步骤标题"); return; }
    if (title.length > 120) { setError("步骤标题最多 120 字"); return; }
    if (draft[group].items.length >= 100) { setError("每组最多 100 项"); return; }
    setDraft(current => current.map((row, index) => index === group ? { ...row, items: [...row.items, { clientId: crypto.randomUUID(), title, startDate: "", dueDate: "", status: "not_started" }] } : row));
    setTitles(current => ({ ...current, [group]: "" })); setError(""); setNotice("");
  };
  const remove = async (group: number, index: number, item: Step) => {
    if (!item.taskId) { setDraft(current => current.map((row, g) => g === group ? { ...row, items: row.items.filter((_, i) => i !== index) } : row)); setActive(null); return; }
    if (!(await ask(`删除「${item.title}」？此操作会立即删除执行事项。`, "删除一步"))) return;
    try {
      const { response, error: failure } = await browserApi.DELETE("/api/me/tasks/{id}", { params: { path: { id: item.taskId }, query: { version: item.version! } } });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); throw new Error("事项版本已变化，请刷新后再操作。当前未保存的改动已保留，请决定如何处理。"); }
        throw new Error(failure?.message ?? "删除失败，请重试");
      }
      const omit = (groups: PlanGroup[]) => groups.map((row, g) => g === group ? { ...row, items: row.items.filter(step => step.taskId !== item.taskId) } : row);
      setDraft(omit); setBaseline(omit); setActive(null); setNotice("已删除一步"); setError("");
      onSaved({ ...plan, groups: plan.groups.map((row, g) => {
        if (g !== group) return row;
        const items = row.items.filter(step => step.id !== item.taskId);
        return { ...row, items: items.map((step, order) => step.mission ? { ...step, mission: { ...step.mission, step: order + 1, steps: items.length } } : step) };
      }) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "删除失败，请重试"); }
  };
  const valid = () => draft.every(group => group.items.every(item => item.title.trim() && item.title.trim().length <= 120 &&
    (!item.startDate || /^\d{4}-\d{2}-\d{2}$/.test(item.startDate)) && (!item.dueDate || /^\d{4}-\d{2}-\d{2}$/.test(item.dueDate)) &&
    (!item.startDate || !item.dueDate || item.startDate <= item.dueDate)));
  const save = async () => {
    if (!valid()) { setError("请检查标题和日期：开始不能晚于截止。"); return; }
    setSaving(true); setError("");
    try {
      const { data, response, error: failure } = await browserApi.PUT("/api/me/plan", { body: saveBody(plan.period, baseline, draft) });
      if (!response.ok || !data) {
        if (response.status === 409 && failure?.code === "PLAN_STALE") { setConflict(true); throw new Error("这一步已经在别处移走或删了。当前草稿已保留，请刷新计划。"); }
        throw new Error(failure?.message ?? "保存失败，请重试");
      }
      const next = draftFromPlan(data); setDraft(next); setBaseline(next); onSaved(data); setNotice("已保存"); setConflict(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试"); }
    finally { setSaving(false); }
  };
  const reload = async () => {
    if (!(await ask("刷新会丢弃当前未保存的改动，确定刷新计划？", "刷新计划"))) return;
    try {
      const { data, response, error: failure } = await browserApi.GET("/api/me/plan", { params: { query: { period: plan.period } } });
      if (!response.ok || !data) throw new Error(failure?.message ?? "刷新失败，请重试");
      const next = draftFromPlan(data); setDraft(next); setBaseline(next); onSaved(data); setError(""); setConflict(false); setNotice("已刷新到最新计划");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "刷新失败，请重试"); }
  };
  const place = (start: number, end: number) => ({ left: `${(start - 1) / days * 100}%`, width: `${(end - start + 1) / days * 100}%` });
  const showTip = (element: HTMLElement, group: number, index: number) => {
    const mark = element.querySelector<HTMLElement>(`[data-index="${index}"]`);
    const box = root.current?.getBoundingClientRect();
    if (!mark || !box) return;
    const dot = mark.getBoundingClientRect();
    window.clearTimeout(hideTimer.current);
    setTip({ group, index, x: Math.min(Math.max(dot.left + dot.width / 2 - box.left, 110), box.width - 110), y: dot.top - box.top < 120 ? dot.bottom - box.top + 8 : dot.top - box.top - 8, below: dot.top - box.top < 120 });
  };
  const nearest = (element: HTMLElement, x: number) => {
    let best = 0, distance = Infinity;
    element.querySelectorAll<HTMLElement>("[data-index]").forEach(dot => { const box = dot.getBoundingClientRect(); const gap = Math.abs(box.left + box.width / 2 - x); if (gap < distance) { distance = gap; best = Number(dot.dataset.index); } });
    return best;
  };
  const pointerDay = (event: PointerEvent<HTMLElement>) => { const box = event.currentTarget.getBoundingClientRect(); return dateFromPointer(event.clientX, box.left, box.width, plan.period); };
  const startDrag = (event: PointerEvent<HTMLElement>, group: number, index: number, item: Step) => {
    if (!plan.editable || event.button !== 0) return;
    const target = event.target as HTMLElement;
    const edge = target.closest<HTMLElement>("[data-edge]")?.dataset.edge;
    const mode = edge === "startDate" || edge === "dueDate" ? edge : target.closest(`.${s.bar}`) ? "move" : "draw";
    const anchor = pointerDay(event);
    drag.current = { group, index, mode, anchor, start: item.startDate, due: item.dueDate };
    if (mode === "draw") edit(group, index, { startDate: anchor, dueDate: anchor });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state) return;
    const date = pointerDay(event);
    if (state.mode === "draw") edit(state.group, state.index, { startDate: date < state.anchor ? date : state.anchor, dueDate: date > state.anchor ? date : state.anchor });
    else if (state.mode === "startDate") edit(state.group, state.index, { startDate: state.due && date > state.due ? state.due : date });
    else if (state.mode === "dueDate") edit(state.group, state.index, { dueDate: state.start && date < state.start ? state.start : date });
    else if (state.start && state.due) {
      const delta = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${state.anchor}T00:00:00Z`)) / 86400000);
      edit(state.group, state.index, { startDate: shiftDay(state.start, delta), dueDate: shiftDay(state.due, delta) });
    }
  };
  const discard = () => { setDraft(baseline); setActive(null); setError(""); setConflict(false); setNotice(""); };
  const tipGroup = tip && draft[tip.group];
  const tipMark = tip && tipGroup?.milestones.filter(mark => mark.date?.startsWith(plan.period))[tip.index];
  return <section className={s.gantt} ref={root} aria-label="本月计划甘特图" style={{ "--ts-border": "var(--hairline)", "--ts-surface": "var(--surface)", "--ts-text": "var(--ink)", "--ts-text-muted": "var(--ink-faint)" } as CSSProperties}>
    {!plan.editable && <p className={s.closed}>{plan.closedReason}</p>}
    {error && <p role="alert" className={s.error}>{error}{conflict && <Button variant="ghost" onPress={() => void reload()}>刷新计划</Button>}</p>}{notice && <p role="status" className={s.notice}>{notice}</p>}
    <div className={s.scroll} role="region" tabIndex={0} aria-label={`${year} 年 ${month} 月执行事项时间轴`} onScroll={() => setTip(null)}>
      <div className={s.inner} style={{ "--days": days } as CSSProperties}>
        <div className={s.head} aria-hidden="true"><span className={s.corner}>{year} 年 {month} 月</span><span className={s.days}>{dayNumbers.map(day => <span key={day} data-weekend={weekend(day) || undefined} data-today={day === todayDay || undefined}>{day}</span>)}</span></div>
        <div className={s.body}>
          <div className={s.backdrop} aria-hidden="true">{dayNumbers.filter(weekend).map(day => <span key={day} className={s.weekend} style={{ left: `${(day - 1) / days * 100}%`, width: `${100 / days}%` }} />)}{todayDay && <span className={s.today} style={{ left: `${(todayDay - .5) / days * 100}%` }} />}</div>
          {draft.map((group, g) => {
            const marks = group.milestones.filter(mark => mark.date?.startsWith(plan.period));
            const dates = group.items.flatMap(item => [item.startDate, item.dueDate]).filter(Boolean);
            return <section className={s.group} key={group.missionId ?? "independent"} aria-label={group.title}>
              <div className={s.groupHead}><div className={s.groupLabel}><strong>{group.title}</strong><small>{group.battlefieldName ? `${group.battlefieldName} · ` : ""}{group.items.length} {group.missionId ? "步" : "件"}{group.milestones.length ? ` · ${marks.length} 个里程碑${group.milestones.length > marks.length ? `，${group.milestones.length - marks.length} 个未定日期` : ""}` : ""}</small></div>
                <div className={s.groupTrack} data-tip-group={g} tabIndex={marks.length ? 0 : undefined} aria-label={marks.length ? `${group.title}的里程碑，左右方向键切换` : undefined}
                  onPointerEnter={event => marks.length && showTip(event.currentTarget, g, nearest(event.currentTarget, event.clientX))}
                  onPointerMove={event => marks.length && showTip(event.currentTarget, g, nearest(event.currentTarget, event.clientX))}
                  onPointerDown={event => marks.length && showTip(event.currentTarget, g, nearest(event.currentTarget, event.clientX))}
                  onPointerLeave={event => { if (event.pointerType !== "touch") hideTimer.current = window.setTimeout(() => setTip(null), 120); }}
                  onFocus={event => marks.length && showTip(event.currentTarget, g, 0)}
                  onKeyDown={event => { if (event.key === "Escape") { setTip(null); return; } if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); showTip(event.currentTarget, g, Math.max(0, Math.min(marks.length - 1, (tip?.group === g ? tip.index : 0) + (event.key === "ArrowRight" ? 1 : -1)))); } }}>
                  {dates.length > 0 && <span className={s.span} style={place(Math.min(...dates.map(visibleDay)), Math.max(...dates.map(visibleDay)))} />}
                  {marks.map((mark, index) => <span key={`${mark.date}-${index}`} className={s.milestone} data-index={index} data-active={tip?.group === g && tip.index === index || undefined} style={{ left: `${(dayOf(mark.date!) - .5) / days * 100}%` }} />)}
                </div></div>
              {group.items.map((item, index) => <div className={s.row} key={item.taskId ?? item.clientId} data-done={item.status === "done" || undefined} data-edit-row={`${g}-${index}`}>
                <div className={s.label}><button type="button" className={s.labelLink} aria-expanded={plan.editable ? active?.group === g && active.index === index : undefined}
                  onClick={event => plan.editable ? setActive(active?.group === g && active.index === index ? null : { group: g, index }) : item.taskId && workspace.navigate(`/me/tasks/${encodeURIComponent(item.taskId)}`, event.currentTarget)}
                  onKeyDown={event => { if (event.key === "Escape") { setActive(null); event.currentTarget.blur(); } }}>{item.title}</button><small>{statusText[item.status]}</small></div>
                <div className={s.track} role="group" aria-label={`${item.title}：${item.startDate || "未选开始"} 至 ${item.dueDate || "未选截止"}`}
                  onPointerDown={event => startDrag(event, g, index, item)} onPointerMove={moveDrag}
                  onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
                  onPointerCancel={() => { drag.current = null; }}>
                  {item.startDate && item.dueDate && item.startDate <= plan.lastDay && item.dueDate >= plan.firstDay ? <span className={s.bar} style={place(visibleDay(item.startDate), visibleDay(item.dueDate))}>
                    {plan.editable && <><span className={s.edge} data-edge="startDate" role="presentation" /><span className={s.edge} data-edge="dueDate" role="presentation" /></>}
                  </span> : (item.startDate || item.dueDate) && (item.startDate || item.dueDate) >= plan.firstDay && (item.startDate || item.dueDate) <= plan.lastDay ?
                    <span className={s.dateMark} style={{ left: `${(visibleDay((item.startDate || item.dueDate)) - .5) / days * 100}%` }} aria-hidden="true" /> :
                    <span className={s.none}>{item.status === "done" ? "" : item.startDate || item.dueDate ? "日期在本月外" : plan.editable ? "拖动定日期" : "未定日期"}</span>}
                </div>
                {plan.editable && active?.group === g && active.index === index && <div className={s.inlineEdit} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setActive(null); } }}>
                  <label>标题<input value={item.title} maxLength={120} onChange={event => edit(g, index, { title: event.target.value })} /></label>
                  <label>开始<input type="date" value={item.startDate} onChange={event => edit(g, index, { startDate: event.target.value })} /></label>
                  <label>截止<input type="date" value={item.dueDate} onChange={event => edit(g, index, { dueDate: event.target.value })} /></label>
                  <div className={s.stepActions}>{group.missionId && <><button type="button" disabled={index === 0} onClick={() => { reorder(g, index, -1); setActive({ group: g, index: index - 1 }); }}>上移</button><button type="button" disabled={index === group.items.length - 1} onClick={() => { reorder(g, index, 1); setActive({ group: g, index: index + 1 }); }}>下移</button></>}
                    {(!item.taskId || item.status === "not_started" && item.source !== "meeting") && <button type="button" onClick={() => void remove(g, index, item)}>删除</button>}
                    {item.taskId && <button type="button" onClick={event => workspace.navigate(`/me/tasks/${encodeURIComponent(item.taskId!)}`, event.currentTarget)}>打开事项 <ArrowUpRight size={13} aria-hidden="true" /></button>}
                  </div>
                </div>}
              </div>)}
              {plan.editable && <div className={s.addRow}><div className={s.addLabel}>{adding === g ? <input autoFocus value={titles[g] ?? ""} maxLength={120} placeholder={group.missionId ? "步骤标题" : "事项标题"}
                onChange={event => setTitles(current => ({ ...current, [g]: event.target.value }))}
                onKeyDown={event => { if (event.key === "Enter") add(g); if (event.key === "Escape") { setAdding(null); setTitles(current => ({ ...current, [g]: "" })); } }} /> :
                <button type="button" onClick={() => setAdding(g)}>＋ {group.missionId ? "加一步" : "加一件"}</button>}</div><div /></div>}
            </section>;
          })}
        </div>
      </div>
    </div>
    {tipMark && <div className={s.tip} role="status" data-below={tip?.below || undefined} style={{ left: tip?.x, top: tip?.y }}><p><strong>{short(tipMark.date!)}</strong><span>里程碑</span></p><p>{tipMark.text}</p><small>{tipGroup?.title}</small></div>}
    <p className={s.legend}>{todayDay && <span><i className={s.todayKey} />今天</span>}<span><i data-state="current" />个人任务里程碑</span><span>拖动定日期；日期在本月之外时按月裁切显示</span></p>
    {plan.editable && dirty && <div className={s.saveLine}><Button variant="primary" isDisabled={saving} onPress={() => void save()}>{saving ? "正在保存…" : `保存计划 · 新增 ${changes.added} 步，调整 ${changes.adjusted} 步`}</Button><button type="button" onClick={discard}>放弃改动</button></div>}
    {dialog}
  </section>;
}
