"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Quote, Trash2 } from "lucide-react";
import type { TMeetingCardSection, TMeetingSource } from "@warmap/contracts";
import { excerptSpan, excerptTurns, type RecordTurn } from "./meetingCardModel";
import { CardItemMenu } from "./CardItemMenu";
import { InlineText } from "./InlineText";
import c from "./meeting-card.module.css";

type SectionField = "heading" | "body";

type RecordSectionProps = {
  /** 当前第几段（「依据：第 N 段」按这个数）；删掉的段没有编号。 */
  number: number | null;
  section: Pick<TMeetingCardSection, "id" | "heading" | "body"> & { sourceRefs?: TMeetingCardSection["sourceRefs"] };
  /** 修改中和确认版比：changed 左侧蓝线，deleted 划线。 */
  state: "same" | "changed" | "deleted";
  /** 确认版里的这一段：标题或正文改了时，原文划线显示在新文字上方。 */
  was?: Pick<TMeetingCardSection, "heading" | "body"> | null;
  /** 「+ 加一段」刚加、标题和正文还没写全的那段（带占位字、自动聚焦）；离开过一次后空着的那项标红。 */
  fresh?: boolean;
  touched?: boolean;
  editable: boolean;
  /** 确认、放弃修改进行中：暂时不能改。 */
  locked?: boolean;
  sources: TMeetingSource[];
  turns: RecordTurn[];
  speakerName: (speakerId: string) => string | null;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  canDelete?: boolean;
  onChange?: (field: SectionField, value: string) => void;
  /** 焦点离开这一段（标题、正文都不在编辑了）。 */
  onLeave?: () => void;
  onMove?: (delta: -1 | 1) => void;
  onDelete?: () => void;
};

/**
 * 一段正文：标题 + 正文就地编辑；下面一行灰字是出处（来源标题 · 原话时段），点开是那几句原话（逐字稿里找得到时）；
 * 右侧「⋯」上移、下移、删除。修改中和确认版不同的段落左侧一条蓝线（data-changed），原文划线显示在新文字上方；删掉的段落整段划线。
 */
export function RecordSection(props: RecordSectionProps) {
  const { number, section, state, was, fresh, touched, editable, locked, sources, turns, speakerName, canMoveUp, canMoveDown, canDelete, onChange, onLeave, onMove, onDelete } = props;
  const [open, setOpen] = useState(false);
  const refs = section.sourceRefs ?? [];
  const quoted = refs.flatMap((ref) => excerptTurns(ref.locator, turns) ?? []);
  const titles = [...new Set(refs.map((ref) => sources.find((source) => source.id === ref.sourceId)?.title).filter(Boolean))].join("、");
  const sourceLine = [titles, excerptSpan(quoted)].filter(Boolean).join(" · ");
  const live = editable && state !== "deleted";
  const label = number ? `第 ${number} 段` : undefined;
  const flagEmpty = !fresh || touched;
  const wasHeading = state === "changed" && was && was.heading !== section.heading ? was.heading : null;
  const wasBody = state === "changed" && was && was.body !== section.body ? was.body : null;

  return (
    <section
      className={c.section}
      aria-label={label}
      data-changed={state === "changed" ? "" : undefined}
      data-deleted={state === "deleted" ? "" : undefined}
      onBlur={live && onLeave ? (event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onLeave(); } : undefined}
    >
      <span className={c.sectionNo} aria-hidden="true">{number ?? ""}</span>
      <div className={c.sectionMain}>
        {wasHeading ? <del className={`${c.was} ${c.heading}`}>{wasHeading}</del> : null}
        <InlineText as="h4" className={c.heading} value={section.heading} editable={live} readOnly={locked} single label={`${label ?? ""}标题`}
          placeholder={fresh ? "标题" : undefined} invalid={flagEmpty && !section.heading.trim()} autoFocus={fresh && !section.heading}
          onChange={(value) => onChange?.("heading", value)} />
        {wasBody ? <del className={`${c.was} ${c.body}`}>{wasBody}</del> : null}
        <InlineText className={c.body} value={section.body} editable={live} readOnly={locked} label={`${label ?? ""}正文`}
          placeholder={fresh ? "正文" : undefined} invalid={flagEmpty && !section.body.trim()} onChange={(value) => onChange?.("body", value)} />
        {sourceLine ? (
          quoted.length ? (
            <button type="button" className={c.source} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
              <Quote size={12} strokeWidth={2} aria-hidden="true" />
              <span>{sourceLine}</span>
              <ChevronDown size={13} strokeWidth={2} aria-hidden="true" className={c.chevron} />
            </button>
          ) : (
            <p className={c.source}><Quote size={12} strokeWidth={2} aria-hidden="true" /><span>{sourceLine}</span></p>
          )
        ) : null}
        {open && quoted.length ? (
          <ol className={c.excerpt}>
            {quoted.map((turn) => (
              <li key={turn.id}>
                {speakerName(turn.speakerId) ? <span className={c.speaker}>{speakerName(turn.speakerId)}</span> : null}
                <p>{turn.text}</p>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      {live && onMove && onDelete ? (
        <CardItemMenu label="段落操作" disabled={locked} items={[
          { label: "上移", icon: <ArrowUp size={15} strokeWidth={1.8} aria-hidden />, disabled: !canMoveUp, onPick: () => onMove(-1) },
          { label: "下移", icon: <ArrowDown size={15} strokeWidth={1.8} aria-hidden />, disabled: !canMoveDown, onPick: () => onMove(1) },
          { label: "删除", icon: <Trash2 size={15} strokeWidth={1.8} aria-hidden />, disabled: !canDelete, danger: true, onPick: onDelete },
        ]} />
      ) : null}
    </section>
  );
}
