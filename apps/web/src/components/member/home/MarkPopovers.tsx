"use client";

/**
 * 月历上的两个小浮层，挂在那一天的格子下面（triggerRef）；外观、开合、Esc 和点外面关都照会议页的编辑浮层（ts-design Popover）。
 * - 加计划点：日期、（「全部」视图下）一排 Mission 色点选挂到哪个 Mission、名字输入框。
 * - 改计划点：「M/D」和「删除」，下面是改名字的输入框。
 * 名字 ≤10 字，Enter 提交（拼字中的 Enter 不算），空名字不提交。
 */
import type { ReactNode, RefObject } from "react";
import { Check } from "lucide-react";
import { TianshuPortalTheme } from "ts-design";
import { Button, Popover } from "ts-design/primitives";
import type { THomePlanMark, THomePlanMission } from "@warmap/contracts";
import { shortDate, tone } from "./planFormat";
import s from "@/styles/home-plan.module.css";

export type MarkDraft = { date: string; missionId: string; label: string };

function MarkFloat({ anchor, label, kind, onClose, children }: {
  anchor: RefObject<Element | null>;
  label: string;
  kind: "add" | "edit";
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Popover isOpen onOpenChange={(open) => { if (!open) onClose(); }}>
      <Popover.Content triggerRef={anchor} placement="bottom" offset={6} className={s.float}>
        <TianshuPortalTheme>
          <Popover.Dialog className={s.dialog} data-mark-pop={kind} aria-label={label}>{children}</Popover.Dialog>
        </TianshuPortalTheme>
      </Popover.Content>
    </Popover>
  );
}

function NameField({ value, action, onChange, onSubmit }: { value: string; action: string; onChange: (value: string) => void; onSubmit: () => void }) {
  return (
    <div className={s.nameRow}>
      <input className={s.input} data-mark-name value={value} maxLength={10} placeholder="名字" aria-label="名字" autoFocus
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          onSubmit();
        }} />
      <Button size="sm" isIconOnly aria-label={action} isDisabled={!value.trim()} onPress={onSubmit}><Check size={15} aria-hidden /></Button>
    </div>
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
      <NameField value={draft.label} action="加上" onChange={(label) => onChange({ ...draft, label })} onSubmit={onSubmit} />
    </MarkFloat>
  );
}

export function EditMarkPopover({ mark, label, anchor, onChange, onSubmit, onDelete, onClose }: {
  mark: THomePlanMark;
  /** 输入框里正在改的名字。 */
  label: string;
  anchor: RefObject<Element | null>;
  onChange: (label: string) => void;
  onSubmit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <MarkFloat anchor={anchor} kind="edit" label={`计划点 ${shortDate(mark.date)} ${mark.label}`} onClose={onClose}>
      <div className={s.popHead}>
        <span className={s.popDate}>{shortDate(mark.date)}</span>
        <Button size="sm" variant="danger-soft" data-delete onPress={onDelete}>删除</Button>
      </div>
      <NameField value={label} action="存好" onChange={onChange} onSubmit={onSubmit} />
    </MarkFloat>
  );
}
