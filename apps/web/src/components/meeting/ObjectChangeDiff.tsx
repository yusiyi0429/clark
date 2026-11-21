"use client";

import { Trash2 } from "lucide-react";
import type { TMeetingCardTargetOption } from "@warmap/contracts";
import { Select } from "@/components/ui/Select";
import type { CardContent } from "./meetingCardModel";
import { CardItemMenu } from "./CardItemMenu";
import { InlineText } from "./InlineText";
import c from "./meeting-card.module.css";
import { useNoEllipsis } from "@/lib/home/noEllipsis";

type Change = CardContent["objectChanges"][number];
type ObjectChangeDiffProps = {
  change: Change;
  /** 修改中和确认版比：changed 左侧蓝线，deleted 整条划线。 */
  state: "same" | "changed" | "deleted";
  /** 确认版里的改后内容（改过时划线显示在新的上方）。 */
  wasAfter?: string | null;
  editable: boolean;
  /** 确认、放弃修改进行中：暂时不能改。 */
  locked?: boolean;
  /** 「依据：第 N 段」。 */
  basis: string | null;
  options: TMeetingCardTargetOption[];
  onAfter?: (text: string) => void;
  onLeave?: () => void;
  onTarget?: (option: TMeetingCardTargetOption) => void;
  onDelete?: () => void;
};

const brief = (text: string) => (text.length > 60 ? `${text.slice(0, 60)}…` : text);

/**
 * 一处对象修改（GitHub 式的改前 / 改后）：目标「对象名 · 组件类型」，改前灰色划线、改后可改，手机上上下排；
 * 目标未定是红色标签，能编辑的人从挂点对象的文字组件里选目标；目标版本变过是黄色「目标已变」；右侧「⋯」删除。
 */
export function ObjectChangeDiff({ change, state, wasAfter, editable, locked, basis, options, onAfter, onLeave, onTarget, onDelete }: ObjectChangeDiffProps) {
  const whole = useNoEllipsis();
  const live = editable && state !== "deleted";
  const stale = "stale" in change && change.stale;
  const undecided = change.targetRef === null;
  const name = change.targetTitle ?? "目标未定";
  return (
    <article className={c.change} aria-label={name} data-changed={state === "changed" ? "" : undefined} data-deleted={state === "deleted" ? "" : undefined}>
      <header className={c.changeHead}>
        {change.targetTitle ? <span className={c.target}>{change.targetTitle}</span> : null}
        {undecided ? <span className={c.flag} data-tone="fail">目标未定</span> : null}
        {stale && state !== "deleted" ? <span className={c.flag} data-tone="warn">目标已变</span> : null}
        {undecided && live && onTarget ? (
          <Select aria-label="选目标" placeholder="选目标" size="compact" className={c.targetPicker} value="" disabled={locked || !options.length}
            options={options.map((option) => ({ value: option.targetRef, label: option.title, description: whole ? option.text : brief(option.text) }))}
            onChange={(value) => { const option = options.find((item) => item.targetRef === value); if (option) onTarget(option); }} />
        ) : null}
        {live && onDelete ? (
          <span className={c.changeMenu}>
            <CardItemMenu label="修改操作" disabled={locked} items={[
              { label: "删除", icon: <Trash2 size={15} strokeWidth={1.8} aria-hidden />, danger: true, onPick: onDelete },
            ]} />
          </span>
        ) : null}
      </header>
      <div className={c.diff} data-single={change.before ? undefined : ""}>
        {change.before ? (
          <div className={c.side} data-side="before">
            <span className={c.sideLabel}>改前</span>
            <del className={c.text}>{change.before.text}</del>
          </div>
        ) : null}
        <div className={c.side} data-side="after">
          <span className={c.sideLabel}>改后</span>
          {state === "changed" && wasAfter !== null && wasAfter !== undefined && wasAfter !== change.after.text ? <del className={c.was}>{wasAfter}</del> : null}
          <InlineText value={change.after.text} editable={live} readOnly={locked} label={`${name} 改后`} invalid={!change.after.text.trim()} onChange={onAfter} onBlur={onLeave} />
        </div>
      </div>
      {basis ? <p className={c.basis}>{basis}</p> : null}
    </article>
  );
}
