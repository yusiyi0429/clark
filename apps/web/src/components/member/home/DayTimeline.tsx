"use client";

/**
 * 成员首页的本月时间轴：一天一格，只管画和把操作交出去，不取数。
 *
 * - 格子：还没到的工作日深蓝、休息日浅蓝，过去的统一灰；今天加一圈描边，下面写「今天」。
 *   格子下面只标 1 号、逢 5、今天和月末；再下面一道括线圈出本周（截到本月以内），写「本周还剩 N 个工作日」；showWeek=false 时不画本周。
 * - 格子上方按日期放签定关口（实心菱形）和计划点（空心圆），颜色是所属 Mission 的颜色；同一天的并排放。
 *   名字只在 title 和读屏文字里。聚焦某个 Mission 时，其他 Mission 的点淡掉。
 * - 计划点：按住拖到别的格子（按整格吸附，松手时改日期；拖出格子那一带或按 Esc 就放回原处）；右键或手指长按删除。点格子加计划点。
 *   签定关口只读，没有任何指针处理器。哪个回调没传，对应的操作就关掉。
 * - 容器窄于 560px 时换成一根细线：今天、本周底带、点的位置按比例画。两套 DOM 都渲染，container query 显隐。
 */
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import type { THomePlanDay, THomePlanGate, THomePlanMark } from "@warmap/contracts";
import s from "@/styles/day-timeline.module.css";

/** 手指按住这么久不挪开算长按。 */
const LONG_PRESS_MS = 500;
/** 按下后挪开超过这么多像素就不再算长按。 */
const LONG_PRESS_SLOP = 6;
/** 拖动时指针离开点和格子那一带（上下）超过这么多像素，就算拖出去了。 */
const DROP_SLOP = 8;

export type DayTimelineProps = {
  days: THomePlanDay[];
  today: string;
  weekStart: string;
  weekEnd: string;
  /** false 时不画本周（括线、细线上的本周底带和字），比如回退显示上个月时。默认画。 */
  showWeek?: boolean;
  gates: THomePlanGate[];
  marks: THomePlanMark[];
  colorOf: (missionId: string) => string;
  /** 聚焦的 Mission；null 是「全部」。 */
  focus: string | null;
  onAddMark?: (date: string) => void;
  onMoveMark?: (id: string, date: string) => void;
  onDeleteMark?: (id: string) => void;
};

/**
 * 本周还剩几个工作日：从今天（含）数到本周日，只数 days 里的日子（即截到月末）。
 * 工作日直接用 days 上按节假日日历算好的标记，前端不另存假期表。
 */
export function workdaysLeftThisWeek(days: THomePlanDay[], today: string, weekEnd: string): number {
  return days.filter((day) => day.workday && day.date >= today && day.date <= weekEnd).length;
}

type Marker = { key: string; kind: "gate" | "mark"; missionId: string; date: string; title: string; mark?: THomePlanMark };
type Gesture = { id: string; from: string; to: string; list: Element; x: number; y: number; timer?: ReturnType<typeof setTimeout>; deleted: boolean };

const month = (date: string) => Number(date.slice(5, 7));
const dayOfMonth = (date: string) => Number(date.slice(8, 10));
const shortDate = (date: string) => `${month(date)}/${dayOfMonth(date)}`;
const pct = (fraction: number) => `${(fraction * 100).toFixed(2)}%`;
const tone = (color: string) => ({ "--c": color }) as CSSProperties;

export function DayTimeline({ days, today, weekStart, weekEnd, showWeek = true, gates, marks, colorOf, focus, onAddMark, onMoveMark, onDeleteMark }: DayTimelineProps) {
  const gesture = useRef<Gesture | null>(null);
  const [drop, setDrop] = useState<{ id: string; date: string } | null>(null);

  const count = days.length;
  const markers: Marker[] = [
    ...gates.map((gate, index) => ({ key: `gate-${index}`, kind: "gate" as const, missionId: gate.missionId, date: gate.date, title: `${shortDate(gate.date)} ${gate.label}` })),
    ...marks.map((mark) => ({ key: mark.id, kind: "mark" as const, missionId: mark.missionId, date: mark.date, title: `${shortDate(mark.date)} ${mark.label}`, mark })),
  ];
  const dimmed = (missionId: string) => (focus !== null && missionId !== focus) || undefined;

  const todayIndex = days.findIndex((day) => day.date === today);
  const weekIndexes = showWeek ? days.flatMap((day, index) => (day.date >= weekStart && day.date <= weekEnd ? [index] : [])) : [];
  const week = weekIndexes.length
    ? {
        first: weekIndexes[0],
        last: weekIndexes.at(-1)!,
        // 本周被月初或月末截断时，括线下的字贴着没截断的那头，免得伸出时间轴。
        edge: weekStart < days[0].date ? "start" : weekEnd > days[count - 1].date ? "end" : undefined,
      }
    : null;
  const passed = todayIndex >= 0 ? (todayIndex + 0.5) / count : today > days[count - 1].date ? 1 : 0;
  const dragged = drop ? marks.find((mark) => mark.id === drop.id) : undefined;

  const finish = () => {
    const current = gesture.current;
    if (current) clearTimeout(current.timer);
    gesture.current = null;
    setDrop(null);
    return current;
  };
  const remove = (id: string) => {
    const current = gesture.current;
    if (current?.id === id) {
      // 长按删过一次，随后系统弹的菜单（contextmenu）不再删。
      if (current.deleted) return;
      current.deleted = true;
      clearTimeout(current.timer);
      setDrop(null);
    }
    onDeleteMark?.(id);
  };

  // 卸载时停掉还没到点的长按，免得 500ms 后对已经不在的点调删除。
  useEffect(() => () => clearTimeout(gesture.current?.timer), []);
  // 拖到别的日子时按 Esc：放回原处，这一下拖动作废。
  useEffect(() => {
    if (!drop) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish();
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [drop]);

  const handlersFor = (mark: THomePlanMark) => {
    if (!onMoveMark && !onDeleteMark) return {};
    return {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        const list = event.currentTarget.closest("ol")!;
        event.currentTarget.setPointerCapture(event.pointerId);
        const next: Gesture = { id: mark.id, from: mark.date, to: mark.date, list, x: event.clientX, y: event.clientY, deleted: false };
        // 鼠标按住不动是在想往哪拖，不算长按；鼠标用右键删。
        if (onDeleteMark && event.pointerType !== "mouse") next.timer = setTimeout(() => remove(mark.id), LONG_PRESS_MS);
        gesture.current = next;
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const current = gesture.current;
        if (!current || current.deleted) return;
        if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > LONG_PRESS_SLOP) clearTimeout(current.timer);
        if (!onMoveMark) return;
        const { left, right, top, bottom } = current.list.getBoundingClientRect();
        // 格子那一排（含上方的点和下方的日期）左右出界、上下离开超过 DROP_SLOP：算拖出去，落点回到原来那天。
        const outside = event.clientX < left || event.clientX >= right || event.clientY < top - DROP_SLOP || event.clientY > bottom + DROP_SLOP;
        const to = outside ? current.from : days[Math.floor(((event.clientX - left) / (right - left)) * count)].date;
        if (to === current.to) return;
        current.to = to;
        setDrop(to === current.from ? null : { id: current.id, date: to });
      },
      onPointerUp: () => {
        const ended = finish();
        if (ended && !ended.deleted && ended.to !== ended.from) onMoveMark?.(ended.id, ended.to);
      },
      onPointerCancel: () => {
        finish();
      },
      // 正常松手时 pointerup 已经收尾，这里是空操作；被别处夺走捕获时作废这一下。
      onLostPointerCapture: () => {
        finish();
      },
      ...(onDeleteMark && {
        onContextMenu: (event: MouseEvent<HTMLElement>) => {
          event.preventDefault();
          remove(mark.id);
        },
      }),
    };
  };

  const shape = (marker: Marker, interactive: boolean) => (
    <span
      key={marker.key}
      className={marker.kind === "gate" ? s.gate : s.mark}
      data-kind={interactive ? marker.kind : undefined}
      data-dim={dimmed(marker.missionId)}
      data-movable={interactive && marker.mark && onMoveMark ? true : undefined}
      data-dragging={interactive && marker.mark && drop?.id === marker.mark.id ? true : undefined}
      role="img"
      aria-label={`${marker.kind === "gate" ? "签定关口" : "计划点"} ${marker.title}`}
      title={marker.title}
      style={tone(colorOf(marker.missionId))}
      {...(interactive && marker.mark ? handlersFor(marker.mark) : {})}
    />
  );

  return (
    <div className={s.timeline} role="group" aria-label="本月时间轴" style={{ "--days": count } as CSSProperties}>
      <div className={s.days} data-view="days">
        <ol className={s.grid}>
          {days.map((day, index) => {
            const state = day.date === today ? "today" : day.date < today ? "past" : "future";
            const name = `${month(day.date)}月${dayOfMonth(day.date)}日`;
            const onDay = markers.filter((marker) => marker.date === day.date);
            const ghost = dragged && drop?.date === day.date ? dragged : undefined;
            const number = dayOfMonth(day.date);
            const labelled = number === 1 || number % 5 === 0 || state === "today" || index === count - 1;
            return (
              <li
                key={day.date}
                className={s.day}
                data-day={day.date}
                data-state={state}
                data-workday={day.workday}
                aria-label={`${name}${state === "today" ? " 今天" : ""} ${day.workday ? "工作日" : "休息日"}`}
              >
                {onAddMark && <button type="button" className={s.hit} aria-label={`加计划点 ${name}`} onClick={() => onAddMark(day.date)} />}
                {(onDay.length > 0 || ghost) && (
                  <span className={s.marks}>
                    {onDay.map((marker) => shape(marker, true))}
                    {ghost && <span className={s.mark} data-ghost aria-hidden="true" style={tone(colorOf(ghost.missionId))} />}
                  </span>
                )}
                {labelled && (
                  <span className={s.num} data-today={state === "today" || undefined}>
                    {state === "today" ? "今天" : number}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
        {week && (
          <div className={s.braceRow}>
            <div className={s.brace} data-week data-edge={week.edge} style={{ gridColumn: `${week.first + 1} / ${week.last + 2}` }}>
              <span className={s.bracket} />
              <span className={s.braceText}>本周还剩 {workdaysLeftThisWeek(days, today, weekEnd)} 个工作日</span>
            </div>
          </div>
        )}
      </div>

      <div className={s.line} data-view="line">
        {week && <span className={s.band} data-week style={{ left: pct(week.first / count), width: pct((week.last - week.first + 1) / count) }} />}
        {/* 本周被月初或月末截断时，「本周」跟着那头的日期写，不另放，免得和日期叠在一起。 */}
        <span className={s.lab} data-at="start">
          {shortDate(days[0].date)}
          {week?.edge === "start" && <span className={s.weekLab}>本周</span>}
        </span>
        {week && !week.edge && <span className={`${s.lab} ${s.weekLab}`} style={{ left: pct((week.first + week.last + 1) / 2 / count) }}>本周</span>}
        <span className={s.lab} data-at="end">
          {week?.edge === "end" && <span className={s.weekLab}>本周</span>}
          {shortDate(days[count - 1].date)}
        </span>
        <span className={s.track} />
        <span className={s.past} style={{ width: pct(passed) }} />
        {todayIndex >= 0 && <span className={s.now} data-today style={{ left: pct(passed) }} />}
        {days.map((day, index) => {
          const onDay = markers.filter((marker) => marker.date === day.date);
          return onDay.length > 0 && (
            <span key={day.date} className={s.lineMarks} style={{ left: pct((index + 0.5) / count) }}>
              {onDay.map((marker) => shape(marker, false))}
            </span>
          );
        })}
      </div>
    </div>
  );
}
