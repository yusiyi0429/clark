"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Ellipsis, Quote, Trash2 } from "lucide-react";
import type { TMeetingCardSection, TMeetingSource } from "@warmap/contracts";
import { TianshuPortalTheme } from "ts-design";
import { Button, Popover } from "ts-design/primitives";
import { excerptSpan, excerptTurns, type RecordTurn } from "./meetingCardModel";
import { InlineText } from "./InlineText";
import t from "@/styles/material-tabs.module.css";
import c from "./meeting-card.module.css";

type SectionState = "same" | "changed" | "deleted";
type SectionField = "heading" | "body";

type RecordSectionProps = {
  /** 当前第几段（「依据：第 N 段」按这个数）；删掉的段没有编号。 */
  number: number | null;
  section: Pick<TMeetingCardSection, "id" | "heading" | "body"> & { sourceRefs?: TMeetingCardSection["sourceRefs"] };
  state: SectionState;
  /** 「+ 加一段」刚加、标题和正文还没写全的那段（带占位字、自动聚焦）。 */
  fresh?: boolean;
  editable: boolean;
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
 * 右侧「⋯」上移、下移、删除。修改中和确认版不同的段落左侧一条蓝线（data-changed），删掉的段落划线显示。
 */
export function RecordSection({ number, section, state, fresh, editable, sources, turns, speakerName, canMoveUp, canMoveDown, canDelete, onChange, onLeave, onMove, onDelete }: RecordSectionProps) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const refs = section.sourceRefs ?? [];
  const quoted = refs.flatMap((ref) => excerptTurns(ref.locator, turns) ?? []);
  const titles = [...new Set(refs.map((ref) => sources.find((source) => source.id === ref.sourceId)?.title).filter(Boolean))].join("、");
  const span = excerptSpan(quoted);
  const sourceLine = [titles, span].filter(Boolean).join(" · ");
  const live = editable && state !== "deleted";
  const label = number ? `第 ${number} 段` : undefined;
  const pick = (run: () => void) => { setMenu(false); run(); };

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
        <InlineText as="h4" className={c.heading} value={section.heading} editable={live} single label={`${label ?? ""}标题`}
          placeholder={fresh ? "标题" : undefined} invalid={!fresh && !section.heading.trim()} autoFocus={fresh && !section.heading}
          onChange={(value) => onChange?.("heading", value)} />
        <InlineText className={c.body} value={section.body} editable={live} label={`${label ?? ""}正文`}
          placeholder={fresh ? "正文" : undefined} invalid={!fresh && !section.body.trim()} onChange={(value) => onChange?.("body", value)} />
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
        <Popover isOpen={menu} onOpenChange={setMenu}>
          <Button variant="ghost" className={c.more} aria-label="段落操作">
            <Ellipsis size={16} strokeWidth={1.8} aria-hidden />
          </Button>
          <Popover.Content placement="bottom end" offset={4} className={t.popover}>
            <TianshuPortalTheme>
              <Popover.Dialog aria-label="段落操作" className={`${t.menu} ${c.menu}`}>
                <Button variant="ghost" className={`${t.item} ${c.menuRow}`} isDisabled={!canMoveUp} onPress={() => pick(() => onMove(-1))}>
                  <ArrowUp size={15} strokeWidth={1.8} aria-hidden /><span className={t.label}>上移</span>
                </Button>
                <Button variant="ghost" className={`${t.item} ${c.menuRow}`} isDisabled={!canMoveDown} onPress={() => pick(() => onMove(1))}>
                  <ArrowDown size={15} strokeWidth={1.8} aria-hidden /><span className={t.label}>下移</span>
                </Button>
                <Button variant="ghost" className={`${t.item} ${c.menuRow}`} data-danger="" isDisabled={!canDelete} onPress={() => pick(onDelete)}>
                  <Trash2 size={15} strokeWidth={1.8} aria-hidden /><span className={t.label}>删除</span>
                </Button>
              </Popover.Dialog>
            </TianshuPortalTheme>
          </Popover.Content>
        </Popover>
      ) : null}
    </section>
  );
}
