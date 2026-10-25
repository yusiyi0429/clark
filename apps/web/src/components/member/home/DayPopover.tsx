"use client";

/**
 * 月历上点一天弹出的「这一天」浮层（样稿 calendar-day-v1），挂在那一天的格子下面（anchor）；外观、开合、Esc 和点外面关同会议页的编辑浮层（ts-design Popover）。
 * - 看：「10 月 26 日 周一」，右边小字「今天」或「还有 N 个工作日」；下面按 关口 / 我的节点 / 这天截止 三组列出，空的组不出；最下面「＋ 加节点」。
 *   关口和节点分两行：上面节点名，下面灰色小字 Mission 名，都折行全显示。
 *   我的节点点一下原地改名或删；这天截止的执行事项点进去是详情。
 * - 加节点：Mission 按名字列出（带色点，只有一个 Mission 时不列），默认选聚焦的那个；再填节点名称。
 * 名字 ≤10 字，Enter 提交（拼字中的 Enter 不算），空名字不提交。按钮都是深灰：确认和「开启执行事项」同一个样子，删除是深灰字。
 */
import type { ReactNode, RefObject } from "react";
import { Check } from "lucide-react";
import { TianshuPortalTheme } from "ts-design";
import { Button, Popover } from "ts-design/primitives";
import type { THomePlanActivity, THomePlanDay, THomePlanGate, THomePlanMark, THomePlanMission } from "@warmap/contracts";
import { tone } from "./planFormat";
import s from "@/styles/home-plan.module.css";

export type DayMode = { kind: "view" } | { kind: "add"; missionId: string; label: string } | { kind: "edit"; id: string; label: string };

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** 「10 月 26 日 周一」。 */
const dayTitle = (date: string) =>
  `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日 周${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]}`;

/** 右上角小字：今天写「今天」；以后的日子写还有几个工作日到这天（不算今天、算这天）；过去的不写。 */
function untilText(date: string, today: string, days: THomePlanDay[]): string | null {
  if (date === today) return "今天";
  if (date < today) return null;
  const left = days.filter((day) => day.workday && day.date > today && day.date <= date).length;
  return left > 0 ? `还有 ${left} 个工作日` : null;
}

function NameField({ value, action, onChange, onSubmit }: { value: string; action: string; onChange: (value: string) => void; onSubmit: () => void }) {
  return (
    <div className={s.nameRow}>
      <input className={s.input} data-mark-name value={value} maxLength={10} placeholder="节点名称" aria-label="节点名称" autoFocus
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          onSubmit();
        }} />
      <Button size="sm" variant="ghost" isIconOnly className={s.plainButton} aria-label={action} isDisabled={!value.trim()} onPress={onSubmit}><Check size={15} aria-hidden /></Button>
    </div>
  );
}

function Group({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section className={s.dayGroup} aria-label={name}>
      <h3>{name}</h3>
      {children}
    </section>
  );
}

export function DayPopover({ date, mode, today, days, gates, marks, deadlines, missions, defaultMissionId, anchor, onMode, onSubmitAdd, onSubmitEdit, onDelete, onOpenItem, onClose }: {
  date: string;
  mode: DayMode;
  today: string;
  days: THomePlanDay[];
  /** 这一天的关口、我的节点、截止的执行事项（没做完的）。 */
  gates: THomePlanGate[];
  marks: THomePlanMark[];
  deadlines: THomePlanActivity[];
  /** 本月 Mission；没有时不出「＋ 加节点」。 */
  missions: THomePlanMission[];
  /** 「＋ 加节点」默认选的 Mission：聚焦的那个，「全部」时第一个。 */
  defaultMissionId: string;
  anchor: RefObject<Element | null>;
  onMode: (mode: DayMode) => void;
  onSubmitAdd: () => void;
  onSubmitEdit: () => void;
  onDelete: (id: string) => void;
  onOpenItem: (id: string, origin: Element) => void;
  onClose: () => void;
}) {
  const titleOf = (missionId: string) => missions.find((mission) => mission.missionId === missionId)?.title ?? "";
  const colorOf = (missionId: string) => missions.find((mission) => mission.missionId === missionId)?.color ?? "var(--ink-faint)";
  const adding = mode.kind === "add" ? mode : null;
  const until = untilText(date, today, days);
  return (
    <Popover isOpen onOpenChange={(open) => { if (!open) onClose(); }}>
      <Popover.Content triggerRef={anchor} placement="bottom" offset={6} className={s.float}>
        <TianshuPortalTheme>
          <Popover.Dialog className={`${s.dialog} ${s.dayDialog}`} data-mark-pop={mode.kind === "view" ? "day" : mode.kind} aria-label={dayTitle(date)}>
            <div className={s.popHead}>
              <b className={s.dayTitle}>{dayTitle(date)}{adding && " · 加节点"}</b>
              {!adding && until && <small className={s.popDate}>{until}</small>}
            </div>
            {adding ? <>
              {missions.length > 1 && (
                <div className={s.picks} role="radiogroup" aria-label="Mission">
                  {missions.map((mission) => (
                    <button key={mission.missionId} type="button" role="radio" className={s.pick} data-pick={mission.missionId}
                      aria-checked={adding.missionId === mission.missionId} style={tone(mission.color)}
                      onClick={() => onMode({ ...adding, missionId: mission.missionId })}>
                      <span className={s.dot} aria-hidden="true" />{mission.title}
                    </button>
                  ))}
                </div>
              )}
              <NameField value={adding.label} action="加上" onChange={(label) => onMode({ ...adding, label })} onSubmit={onSubmitAdd} />
            </> : <>
              {gates.length > 0 && (
                <Group name="关口">
                  {gates.map((gate, at) => (
                    <div key={`gate-${at}`} className={s.dayLine} data-day-gate style={tone(colorOf(gate.missionId))}>
                      <i className={s.gateIcon} aria-hidden="true" /><span className={s.dayText}><span>{gate.label}</span><small>{titleOf(gate.missionId)}</small></span>
                    </div>
                  ))}
                </Group>
              )}
              {marks.length > 0 && (
                <Group name="我的节点">
                  {marks.map((mark) => mode.kind === "edit" && mode.id === mark.id ? (
                    <div key={mark.id} className={s.dayEdit}>
                      <NameField value={mode.label} action="存好" onChange={(label) => onMode({ ...mode, label })} onSubmit={onSubmitEdit} />
                      <Button size="sm" variant="ghost" className={s.popDelete} data-delete onPress={() => onDelete(mark.id)}>删除</Button>
                    </div>
                  ) : (
                    <button key={mark.id} type="button" className={s.dayLine} data-day-mark={mark.id} style={tone(colorOf(mark.missionId))}
                      onClick={() => onMode({ kind: "edit", id: mark.id, label: mark.label })}>
                      <i className={s.markIcon} aria-hidden="true" /><span className={s.dayText}><span>{mark.label}</span><small>{titleOf(mark.missionId)}</small></span>
                    </button>
                  ))}
                </Group>
              )}
              {deadlines.length > 0 && (
                <Group name="这天截止">
                  {deadlines.map(({ item }) => (
                    <button key={item.id} type="button" className={s.dayLine} data-day-item={item.id} onClick={(event) => onOpenItem(item.id, event.currentTarget)}>
                      <span>{item.title}</span><small aria-hidden="true">›</small>
                    </button>
                  ))}
                </Group>
              )}
              {mode.kind === "view" && missions.length > 0 && (
                <button type="button" className={s.dayAdd} data-day-add onClick={() => onMode({ kind: "add", missionId: defaultMissionId, label: "" })}>＋ 加节点</button>
              )}
            </>}
          </Popover.Dialog>
        </TianshuPortalTheme>
      </Popover.Content>
    </Popover>
  );
}
