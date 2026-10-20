"use client";

import { Trash2 } from "lucide-react";
import type { TMeetingActionItem } from "@warmap/contracts";
import { DatePicker } from "@/components/ui/DatePicker";
import { dateLabel } from "@/components/ui/pickerFormat";
import { Select } from "@/components/ui/Select";
import { CardItemMenu } from "./CardItemMenu";
import { InlineText } from "./InlineText";
import c from "./meeting-card.module.css";

export type MeetingPerson = { personId: string; displayName: string };
type ItemField = "text" | "ownerPersonId" | "dueDate";

type ActionItemRowProps = {
  /** 第几条；修改中删掉的没有编号。 */
  number: number | null;
  item: TMeetingActionItem;
  /** 修改中和确认时的快照比：changed 左侧蓝线，deleted 划线。 */
  state: "same" | "changed" | "deleted";
  /** 快照里的这一条：事项改了时原文划线显示在新文字上方。 */
  was?: TMeetingActionItem | null;
  editable: boolean;
  /** 确认、放弃修改进行中：暂时不能改。 */
  locked?: boolean;
  /** 负责人从这场会的参会人里选。 */
  people: MeetingPerson[];
  /** 「依据：第 N 段」。 */
  basis: string | null;
  onChange?: (field: ItemField, value: string | null) => void;
  /** 焦点离开这一条。 */
  onLeave?: () => void;
  onDelete?: () => void;
};

/**
 * 一条行动项（天枢本地，拍板 4）：事项就地编辑，推成执行事项的后面标「已派」；下面一行负责人、日期、依据；右侧「⋯」删除。
 * 只读的人只看文字。
 */
export function ActionItemRow({ number, item, state, was, editable, locked, people, basis, onChange, onLeave, onDelete }: ActionItemRowProps) {
  const live = editable && state !== "deleted";
  const label = number ? `第 ${number} 条` : undefined;
  const wasText = state === "changed" && was && was.text !== item.text ? was.text : null;
  const owner = people.find((person) => person.personId === item.ownerPersonId)?.displayName ?? null;
  return (
    <div
      className={c.item}
      role="group"
      aria-label={label}
      data-changed={state === "changed" ? "" : undefined}
      data-deleted={state === "deleted" ? "" : undefined}
      onBlur={live && onLeave ? (event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onLeave(); } : undefined}
    >
      <span className={c.sectionNo} aria-hidden="true">{number ?? ""}</span>
      <div className={c.itemMain}>
        {wasText ? <del className={`${c.was} ${c.itemText}`}>{wasText}</del> : null}
        <div className={c.itemHead}>
          <InlineText className={c.itemText} value={item.text} editable={live} readOnly={locked} label={`${label ?? ""}事项`} placeholder="事项"
            autoFocus={live && !item.text && !item.taskId} onChange={(value) => onChange?.("text", value)} />
          {item.taskId ? <span className={c.flag} data-tone="done">已派</span> : null}
        </div>
        <div className={c.itemMeta}>
          {live ? (
            <Select aria-label={`${label ?? ""}负责人`} placeholder="负责人" size="compact" className={c.ownerPicker} value={item.ownerPersonId ?? ""} disabled={locked}
              options={people.map((person) => ({ value: person.personId, label: person.displayName }))} onChange={(value) => onChange?.("ownerPersonId", value || null)} />
          ) : owner ? <span>{owner}</span> : null}
          {live ? (
            <DatePicker label="日期" size="compact" clearable value={item.dueDate ?? ""} disabled={locked} onChange={(value) => onChange?.("dueDate", value || null)} />
          ) : item.dueDate ? <span>{dateLabel(item.dueDate)}</span> : null}
          {basis ? <span className={c.basis}>{basis}</span> : null}
        </div>
      </div>
      {live && onDelete ? (
        <CardItemMenu label="行动项操作" disabled={locked} items={[
          { label: "删除", icon: <Trash2 size={15} strokeWidth={1.8} aria-hidden />, danger: true, onPick: onDelete },
        ]} />
      ) : null}
    </div>
  );
}
