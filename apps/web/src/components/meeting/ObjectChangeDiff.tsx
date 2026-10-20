"use client";

import type { TMeetingCardTargetOption } from "@warmap/contracts";
import { Select } from "@/components/ui/Select";
import type { CardContent } from "./meetingCardModel";
import { InlineText } from "./InlineText";
import c from "./meeting-card.module.css";

type Change = CardContent["objectChanges"][number];
type ObjectChangeDiffProps = {
  change: Change;
  editable: boolean;
  /** 修改中：和确认版不同（左侧蓝线）。 */
  changed: boolean;
  /** 「依据：第 N 段」。 */
  basis: string | null;
  options: TMeetingCardTargetOption[];
  onAfter?: (text: string) => void;
  onLeave?: () => void;
  onTarget?: (option: TMeetingCardTargetOption) => void;
};

const brief = (text: string) => (text.length > 60 ? `${text.slice(0, 60)}…` : text);

/**
 * 一处对象修改（GitHub 式的改前 / 改后）：目标「对象名 · 组件类型」，改前灰色划线、改后可改，手机上上下排；
 * 目标未定是红色标签，能编辑的人从挂点对象的文字组件里选目标；目标版本变过是黄色「目标已变」。
 */
export function ObjectChangeDiff({ change, editable, changed, basis, options, onAfter, onLeave, onTarget }: ObjectChangeDiffProps) {
  const stale = "stale" in change && change.stale;
  const undecided = change.targetRef === null;
  const name = change.targetTitle ?? "目标未定";
  return (
    <article className={c.change} aria-label={name} data-changed={changed ? "" : undefined}>
      <header className={c.changeHead}>
        {change.targetTitle ? <span className={c.target}>{change.targetTitle}</span> : null}
        {undecided ? <span className={c.flag} data-tone="fail">目标未定</span> : null}
        {stale ? <span className={c.flag} data-tone="warn">目标已变</span> : null}
        {undecided && editable && onTarget ? (
          <Select aria-label="选目标" placeholder="选目标" size="compact" className={c.targetPicker} value="" disabled={!options.length}
            options={options.map((option) => ({ value: option.targetRef, label: option.title, description: brief(option.text) }))}
            onChange={(value) => { const option = options.find((item) => item.targetRef === value); if (option) onTarget(option); }} />
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
          <InlineText value={change.after.text} editable={editable} label={`${name} 改后`} invalid={!change.after.text.trim()} onChange={onAfter} onBlur={onLeave} />
        </div>
      </div>
      {basis ? <p className={c.basis}>{basis}</p> : null}
    </article>
  );
}
