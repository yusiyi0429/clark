"use client";

/**
 * 标题右边那颗状态钮（用户 2026-09-30）：每个人的卡就像会议页的一份材料，拍板人在这里下拉切换每个人，下拉单里带每人状态。
 * 审核中只有两种状态：审核中（蓝字）、已完成审核（绿色对号 + 绿字）；其他阶段照服务端那一行写，不上色。
 * 不能切人的人（普通成员）只看到自己这张卡的状态，没有下拉。
 */
import { useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { TianshuPortalTheme } from "ts-design";
import { Button, Popover } from "ts-design/primitives";
import type { TMissionCardRow, TMissionRoundSummary } from "@warmap/contracts";
import t from "@/styles/material-tabs.module.css";
import p from "./people-menu.module.css";

type Row = Pick<TMissionCardRow, "cardId" | "ownerName" | "line" | "ownerConfirmedAt" | "placeholder"> & { contentVisible?: boolean };
function state(round: Pick<TMissionRoundSummary, "phase">, row: Row): "wait" | "done" | undefined {
  return round.phase === "confirmed" ? undefined : row.ownerConfirmedAt ? "done" : ["open", "closed"].includes(round.phase) ? "wait" : undefined;
}
function stateText(round: Pick<TMissionRoundSummary, "phase">, row: Row): string {
  const tone = state(round, row);
  return tone === "done" ? "本人已确认" : tone === "wait" ? "待本人确认" : row.line;
}
function Status({ round, row }: { round: Pick<TMissionRoundSummary, "phase">; row: Row }) {
  const tone = state(round, row);
  return <span className={p.status} data-state={tone}>{tone === "done" ? <Check size={14} strokeWidth={2.4} aria-hidden /> : <span className={p.dot} aria-hidden />}<span className={p.statusText}>{stateText(round, row)}</span></span>;
}

export function PeopleMenu({ round, cardId, onSelect, children }: { round: TMissionRoundSummary; cardId: string; onSelect: (cardId: string) => void; children?: ReactNode | ((onClose: () => void) => ReactNode) }) {
  const [open, setOpen] = useState(false);
  const current = round.cards.find((row) => row.cardId === cardId);
  if (!current) return null;
  if (!round.approver && round.cards.length < 2) return <span className={p.still} aria-label={`${current.ownerName}：${stateText(round, current)}`}><Status round={round} row={current} /></span>;
  const done = round.cards.filter((row) => row.ownerConfirmedAt).length;
  return <Popover isOpen={open} onOpenChange={setOpen}>
    <Button variant="ghost" className={`${t.trigger} ${p.trigger}`} aria-label={`${current.ownerName}：${stateText(round, current)}，查看任务准备进度`}>
      <Status round={round} row={current} />
      <ChevronDown size={14} strokeWidth={2} aria-hidden className={t.chevron} />
    </Button>
    <Popover.Content placement="bottom start" offset={6} className={t.popover}>
      <TianshuPortalTheme>
        <Popover.Dialog className={`${t.menu} ${p.menu}`} aria-label="任务准备进度与操作">
          {round.phase !== "confirmed" ? <p className={p.progress}>本人已确认 <strong>{done}</strong> / {round.counts.cards}</p> : null}
          {round.cards.map((row) => (
            <Button key={row.cardId} variant="ghost" className={`${t.item} ${p.item}`} aria-current={row.cardId === cardId || undefined}
              isDisabled={row.contentVisible === false}
              aria-label={`${row.contentVisible === false ? "本人确认后可查看" : "打开"}${row.ownerName}的任务 · ${stateText(round, row)}`} onPress={() => { setOpen(false); if (row.cardId !== cardId && row.contentVisible !== false) onSelect(row.cardId); }}>
              <span className={p.initial} aria-hidden>{row.ownerName.slice(0, 1)}</span>
              <span className={`${t.label} ${p.name}`}>{row.ownerName}{row.placeholder ? <em>占位</em> : null}</span>
              <Status round={round} row={row} />
              {row.cardId === cardId ? <Check size={15} strokeWidth={2} aria-hidden className={t.check} /> : <span className={p.checkSpace} aria-hidden />}
            </Button>
          ))}
          {children ? <div className={p.operations}>{typeof children === "function" ? children(() => setOpen(false)) : children}</div> : null}
        </Popover.Dialog>
      </TianshuPortalTheme>
    </Popover.Content>
  </Popover>;
}
