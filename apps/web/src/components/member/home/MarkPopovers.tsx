"use client";

/**
 * 时间轴下面的两个小浮层，挂在点的那一天的格子下面（triggerRef）；外观、开合、Esc 和点外面关都照会议页的编辑浮层（ts-design Popover）。
 * - 加计划点：日期、（「全部」视图下）一排 Mission 色点选挂到哪个 Mission、名字输入框（≤10 字，Enter 提交，拼字中的 Enter 不算）。
 * - 删计划点：「M/D 名字」和一个「删除」。
 */
import type { ReactNode, RefObject } from "react";
import { Check } from "lucide-react";
import { TianshuPortalTheme } from "ts-design";
import { Button, Popover } from "ts-design/primitives";
import type { THomePlanMark, THomePlanMission } from "@warmap/contracts";
import { shortDate, tone } from "./planFormat";
import s from "@/styles/mission-plan-card.module.css";

export type MarkDraft = { date: string; missionId: string; label: string };

function MarkFloat({ anchor, label, kind, onClose, children }: {
  anchor: RefObject<Element | null>;
  label: string;
  kind: "add" | "delete";
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Popover isOpen onOpenChange={(open) => { if (!open) onClose(); }}>
      {/* 落在格子下面的日期那一行之下。 */}
      <Popover.Content triggerRef={anchor} placement="bottom" offset={22} className={s.float}>
        <TianshuPortalTheme>
          <Popover.Dialog className={s.dialog} data-mark-pop={kind} aria-label={label}>{children}</Popover.Dialog>
        </TianshuPortalTheme>
      </Popover.Content>
    </Popover>
  );
}

export function AddMarkPopover({ draft, missions, anchor, onChange, onSubmit, onClose }: {
  draft: MarkDraft;
  /** 「全部」视图下可选的 Mission；聚焦时为 null，直接挂聚焦的那个。 */
  missions: THomePlanMission[] | null;
  anchor: RefObject<Element | null>;
  onChange: (draft: MarkDraft) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <MarkFloat anchor={anchor} kind="add" label={`加计划点 ${shortDate(draft.date)}`} onClose={onClose}>
      <span className={s.popDate}>{shortDate(draft.date)}</span>
      {missions && (
        <div className={s.picks} role="radiogroup" aria-label="Mission">
          {missions.map((mission) => (
            <button key={mission.missionId} type="button" role="radio" className={s.pick} data-pick={mission.missionId}
              aria-checked={draft.missionId === mission.missionId} aria-label={mission.title} title={mission.title}
              style={tone(mission.color)} onClick={() => onChange({ ...draft, missionId: mission.missionId })} />
          ))}
        </div>
      )}
      <div className={s.nameRow}>
        <input className={s.input} data-mark-name value={draft.label} maxLength={10} placeholder="名字" aria-label="名字" autoFocus
          onChange={(event) => onChange({ ...draft, label: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            onSubmit();
          }} />
        <Button size="sm" isIconOnly aria-label="加上" isDisabled={!draft.label.trim()} onPress={onSubmit}><Check size={15} aria-hidden /></Button>
      </div>
    </MarkFloat>
  );
}

export function DeleteMarkPopover({ mark, anchor, onDelete, onClose }: {
  mark: THomePlanMark;
  anchor: RefObject<Element | null>;
  onDelete: () => void;
  onClose: () => void;
}) {
  const name = `${shortDate(mark.date)} ${mark.label}`;
  return (
    <MarkFloat anchor={anchor} kind="delete" label={`计划点 ${name}`} onClose={onClose}>
      <div className={s.deleteRow}>
        <span className={s.popDate}>{name}</span>
        <Button size="sm" variant="danger-soft" data-delete onPress={onDelete}>删除</Button>
      </div>
    </MarkFloat>
  );
}
