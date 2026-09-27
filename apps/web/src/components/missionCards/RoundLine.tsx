"use client";

/** clark round-panel 的单行入口与五步展开；移除演示节拍，规则汇总直接展示事实。 */
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { TPersonalMissionCardPayload } from "@warmap/contracts";
import type { CardAction } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import { roundStatusText } from "./roundStatusText";
import s from "./round-line.module.css";

export function RoundLine({ payload, actions, viewerId, pending, onAction, onViewGoals, onStartProcessing, note = "", onNoteChange, error }: {
  payload: TPersonalMissionCardPayload;
  actions: Pick<CardAction, "actionId" | "actionType" | "label">[];
  viewerId: string | null;
  pending: boolean;
  onAction: (action: Pick<CardAction, "actionId" | "actionType" | "label">, input?: { note: string }) => void;
  onViewGoals: () => void;
  onStartProcessing?: () => void;
  note?: string;
  onNoteChange?: (note: string) => void;
  error?: string;
}) {
  const { round, card, confirmation } = payload;
  const [open, setOpen] = useState(false);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const focusNote = useRef(false);
  useEffect(() => { if (open && focusNote.current) { noteInput.current?.focus(); noteInput.current?.scrollIntoView({ block: "center" }); focusNote.current = false; } }, [open]);
  useEffect(() => {
    const key = `tkos:mission-round-explained:${viewerId ?? "person"}:${round.roundId}:${round.round}:${round.phase}`;
    try {
      if (!localStorage.getItem(key)) { setOpen(true); localStorage.setItem(key, "1"); }
    } catch { setOpen(true); }
  }, [round.roundId, round.round, round.phase, viewerId]);
  const drafting = round.phase === "drafting";
  const draft = round.phase === "draft";
  const discussing = round.phase === "open";
  const closed = round.phase === "closed";
  const reviewing = round.phase === "reviewing";
  const confirmed = round.phase === "confirmed";
  const count = round.counts.cards;
  const applied = payload.corrections.filter((item) => item.status === "applied").length;
  const line = roundStatusText(round, { cardId: card.cardId, feedbackCount: payload.feedback.length, confirmation, corrected: applied });
  // 集中 Review 处理意见；已确定后拍板人处理更正申请（canApply 已含月份未过）。
  const startable = (reviewing && round.approver && round.counts.pending > 0) || (confirmed && payload.correctionAccess.canApply && round.counts.corrections > 0);
  const openAction = draft && round.approver ? actions.find((action) => action.actionType === "mission-round.open") : undefined;
  const reopenAction = reviewing && round.approver ? actions.find((action) => action.actionType === "mission-round.reopen") : undefined;
  const confirmAction = reviewing && round.approver && !round.counts.pending ? actions.find((action) => action.actionType === "mission-round.confirm") : undefined;
  const showNote = () => { if (open) { noteInput.current?.focus(); noteInput.current?.scrollIntoView({ block: "center" }); } else { focusNote.current = true; setOpen(true); } };
  const steps = [
    { done: true, current: false, title: `月度计划已签发${round.goals ? ` · ${monthDayTime(round.goals.signedAt)}` : ""}`, description: "本轮依据已签发的本月目标；统一开放时冻结目标版本。" },
    { done: !drafting, current: drafting, title: drafting ? "Co-Agent 正在起草" : `草稿${round.approver ? ` · ${count} 张` : ""}${round.placeholder ? " · 占位" : ""}`, description: drafting ? "每人一张卡，完成后可统一开放讨论。" : round.draftOrigin === "agent" ? "Co-Agent 起草 · 待大家讨论修改。" : `沿用 ${Number(round.period.slice(5)) === 1 ? 12 : Number(round.period.slice(5)) - 1} 月个人卡整理为讨论候选。` },
    { done: !drafting && !draft && !discussing, current: discussing, title: drafting || draft ? "全战场统一开放 48 小时讨论" : `第 ${round.round} 轮讨论 · ${monthDayTime(round.closesAt)} 截止`, description: "在字段上评论、划词引用、提修改建议；刷新和换人都不会重置窗口。" },
    { done: reviewing || confirmed, current: closed, title: "集中 Review · 规则汇总", description: "截止时收下公开意见并列出同字段冲突与依赖，私聊不进入集中 Review。" },
    { done: confirmed, current: reviewing, title: confirmed ? "本月 Mission Card 已确定" : `由${round.deciderName}逐条处理并统一确认`, description: "采纳先形成候选版本，全战场一次确认后才成为本月承诺。" },
  ];
  return <section className={s.line} data-open={open || undefined} aria-label="本轮">
    <div className={s.row}><span className={s.dot} aria-hidden /><p className={s.text}><span>本轮</span>{line}</p>
      {openAction ? <Button variant="primary" className={s.primary} isDisabled={pending} onPress={() => onAction(openAction)}>{pending ? "正在开放…" : "统一开放 48 小时讨论"}</Button> : null}
      {startable ? <Button variant="primary" className={s.primary} isDisabled={pending} onPress={onStartProcessing}>从第一条开始</Button> : null}
      {confirmAction ? <Button variant="primary" className={s.primary} isDisabled={pending} onPress={showNote}>确认前核对</Button> : null}
      <Button variant="ghost" isIconOnly className={s.toggle} aria-expanded={open} aria-controls={`round-${round.roundId}`} aria-label={open ? "收起本轮详情" : "展开本轮详情"} onPress={() => setOpen(!open)}><ChevronDown size={18} aria-hidden /></Button>
    </div>
    {open ? <div className={s.detail} id={`round-${round.roundId}`}>
      {reviewing || confirmed ? <section className={s.summary} aria-label="集中 Review 规则汇总"><h3>集中 Review · 第 {round.round} 轮</h3><ol className={s.steps} aria-label="集中 Review 的三步结果">{[`收下 ${count} 张卡、${round.counts.feedback} 条公开意见（私聊不收）`, `同一字段 ${round.counts.conflicts} 处冲突${round.counts.conflicts ? " · 只能采纳其中一条" : ""}`, `按依赖原文列出 ${round.counts.dependencies} 条`].map((text) => <li key={text} data-state="done"><span className={s.mark} aria-hidden><Check size={14} /></span><span>{text}</span></li>)}</ol><p className={s.foot}>规则汇总 · 未做语义判断</p>{round.counts.late ? <p className={s.foot}>截止后留言 {round.counts.late} 条 · 不在这一轮</p> : null}</section> : <ol className={s.steps} aria-label="本月制定的五步">{steps.map((step, index) => <li key={index} data-state={step.done ? "done" : step.current ? "current" : "next"}><span className={s.mark} aria-hidden>{step.done ? <Check size={14} /> : index + 1}</span><div><strong>{step.title}</strong><p>{step.description}</p></div></li>)}</ol>}
      {round.goals ? <section className={s.section}><Button variant="ghost" className={s.secondary} onPress={onViewGoals}>查看目标</Button><p>这一轮按这版六个月目标与本月目标制定，开放后不再覆盖依据。</p></section> : null}
      {reopenAction ? <section className={s.section} aria-label="全战场逐条处理"><h3>全战场 · 逐条处理</h3>{round.counts.conflicts ? <p>同一字段有多条修改建议时只能采纳一条；其余建议仍需逐条处理。</p> : null}<Button variant="ghost" className={s.secondary} isDisabled={pending} onPress={() => onAction(reopenAction)}>重新开启 48 小时</Button></section> : null}
      {confirmAction ? <section className={s.section} aria-label="确认本月 Mission Card"><h3>确认前核对</h3><p>确认是全战场一次，共 {count} 张卡。请对照各卡的依赖原文，核对跨人员的交接、冲突与协作安排。</p><div className={s.note}><label htmlFor={`round-note-${round.roundId}`}>跨人员依赖、冲突与协作的核对结论</label><textarea ref={noteInput} id={`round-note-${round.roundId}`} rows={4} maxLength={2000} value={note} disabled={pending} onChange={(event) => onNoteChange?.(event.target.value)} aria-describedby={`round-note-hint-${round.roundId}`} /><p id={`round-note-hint-${round.roundId}`}>{note.length}/2000 · 本结论仅用于这一轮；重新开放后需要重写。</p></div>{error ? <p role="alert" className={s.error}>{error}</p> : null}<Button variant="primary" className={s.confirm} isDisabled={pending || !note.trim() || note.length > 2000} onPress={() => onAction(confirmAction, { note: note.trim() })}>{pending ? "正在确认…" : "确认本月 Mission Card"}</Button></section> : null}
      {confirmation ? <section className={s.section} aria-label="确认记录"><h3>确认记录</h3><p>{confirmation.byName} {monthDayTime(confirmation.at)} 确认本月 Mission Card。</p><p>跨人员依赖与协作核对：{confirmation.note}</p></section> : null}
      <p className={s.foot}>{draft ? "开放由拍板人决定；尚未开放时不收公开意见。" : discussing ? "想让大家看到的话，请发到事项群组。与 Agent 的私聊仅自己可见。" : confirmed ? "公开意见与来源保留可查，已确定后不再收留言。" : "截止后仍可评论与引用；留言会单独标注，不进这一轮集中 Review。"}</p>
    </div> : null}
    {round.closesAt && !confirmed ? <p className={s.deadline}>讨论截止 <time dateTime={round.closesAt}>{monthDayTime(round.closesAt)}</time><span> · 拍板人 {round.deciderName}</span>{discussing && Date.parse(round.closesAt) - Date.parse(round.serverNow) < 21_600_000 ? <strong> · 最后 6 小时</strong> : null}</p> : null}
  </section>;
}
