"use client";

/** clark round-panel 的单行入口与五步展开；移除演示节拍，规则汇总直接展示事实。 */
import { useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { TPersonalMissionCardPayload } from "@warmap/contracts";
import type { CardAction } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import s from "./round-line.module.css";

export function RoundLine({ payload, actions, viewerId, pending, onAction, onSelectCard, onViewGoals }: {
  payload: TPersonalMissionCardPayload;
  actions: Pick<CardAction, "actionId" | "actionType" | "label">[];
  viewerId: string | null;
  pending: boolean;
  onAction: (action: Pick<CardAction, "actionId" | "actionType" | "label">) => void;
  onSelectCard: (id: string) => void;
  onViewGoals: () => void;
}) {
  const { round, card, confirmation } = payload;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const key = `tkos:mission-round-explained:${viewerId ?? "person"}:${round.roundId}`;
    try {
      if (!localStorage.getItem(key)) { setOpen(true); localStorage.setItem(key, "1"); }
    } catch { setOpen(true); }
  }, [round.roundId, viewerId]);
  const draft = round.phase === "draft";
  const discussing = round.phase === "open";
  const closed = round.phase === "closed";
  const reviewing = round.phase === "reviewing";
  const confirmed = round.phase === "confirmed";
  const count = round.cards.length;
  const decider = round.approver ? "你" : round.deciderName;
  const line = draft ? (round.approver ? `${count} 张草稿已整理 · 可以统一开放讨论` : `草稿已整理 · 等${round.deciderName}统一开放讨论`)
    : discussing ? `讨论中 · ${round.approver ? `全战场 ${round.counts.feedback}` : `这张卡 ${payload.feedback.length}`} 条意见`
    : closed ? "讨论已截止 · 正在汇总公开意见"
    : reviewing ? `候选版本就绪 · ${round.counts.pending ? `${round.counts.pending} 条等${decider}处理` : `等${decider}确认`}`
    : `已确定${confirmation ? ` · ${confirmation.byName} ${monthDayTime(confirmation.at)}` : ""}`;
  const openAction = draft && round.approver ? actions.find((action) => action.actionType === "mission-round.open") : undefined;
  const reopenAction = reviewing && round.approver ? actions.find((action) => action.actionType === "mission-round.reopen") : undefined;
  const steps = [
    { done: true, current: false, title: `月度计划已签发${round.goals ? ` · ${monthDayTime(round.goals.signedAt)}` : ""}`, description: "本轮依据已签发的本月目标；统一开放时冻结目标版本。" },
    { done: true, current: false, title: `草稿${round.approver ? ` · ${count} 张` : ""}${round.placeholder ? " · 占位（Co-Agent 起草未接入）" : ""}`, description: round.placeholder ? "沿用 9 月个人卡整理为讨论候选，仍需核对结果、时间与协作边界。" : "草稿已经保存，尚未成为已确定的个人承诺。" },
    { done: !draft && !discussing, current: discussing, title: draft ? "全战场统一开放 48 小时讨论" : `第 ${round.round} 轮讨论 · ${monthDayTime(round.closesAt)} 截止`, description: "在字段上评论、划词引用、提修改建议；刷新和换人都不会重置窗口。" },
    { done: reviewing || confirmed, current: closed, title: "集中 Review · 规则汇总", description: "截止时收下公开意见并列出同字段冲突与依赖，私聊不进入集中 Review。" },
    { done: confirmed, current: reviewing, title: confirmed ? "本月 Mission Card 已确定" : `由${round.deciderName}逐条处理并统一确认`, description: "采纳先形成候选版本，全战场一次确认后才成为本月承诺。" },
  ];
  return <section className={s.line} data-open={open || undefined} aria-label="本轮">
    <div className={s.row}><span className={s.dot} aria-hidden /><p className={s.text}><span>本轮</span>{line}</p>
      {openAction ? <Button variant="primary" className={s.primary} isDisabled={pending} onPress={() => onAction(openAction)}>{pending ? "正在开放…" : "统一开放 48 小时讨论"}</Button> : null}
      <Button variant="ghost" isIconOnly className={s.toggle} aria-expanded={open} aria-controls={`round-${round.roundId}`} aria-label={open ? "收起本轮详情" : "展开本轮详情"} onPress={() => setOpen(!open)}><ChevronDown size={18} aria-hidden /></Button>
    </div>
    {open ? <div className={s.detail} id={`round-${round.roundId}`}>
      <ol className={s.steps} aria-label="本月制定的五步">{steps.map((step, index) => <li key={index} data-state={step.done ? "done" : step.current ? "current" : "next"}><span className={s.mark} aria-hidden>{step.done ? <Check size={14} /> : index + 1}</span><div><strong>{step.title}</strong><p>{step.description}</p></div></li>)}</ol>
      {round.approver && count > 1 ? <section className={s.section} aria-label="全战场每张卡"><h3>全战场 · 每张卡的意见</h3><div className={s.people}>{round.cards.map((row) => <Button key={row.cardId} variant="ghost" className={s.person} aria-current={row.cardId === card.cardId ? "page" : undefined} onPress={() => onSelectCard(row.cardId)} aria-label={`打开${row.ownerName}的 Mission Card · ${row.line}`}><span className={s.initial} aria-hidden>{row.ownerName.slice(0, 1)}</span><span>{row.ownerName}</span><span className={s.count} data-pending={row.pending > 0 || undefined}>{row.line}</span></Button>)}</div></section> : null}
      {round.goals ? <section className={s.section}><Button variant="ghost" className={s.secondary} onPress={onViewGoals}>查看目标</Button><p>这一轮按这版六个月目标与本月目标制定，开放后不再覆盖依据。</p></section> : null}
      {reviewing || confirmed ? <section className={s.section} aria-label="集中 Review 规则汇总"><h3>集中 Review</h3><p>收下{round.approver ? ` ${count} 张卡、` : "本轮 "}{round.counts.feedback} 条公开意见（私聊不收） · 同一字段 {round.counts.conflicts} 处冲突 · 按依赖原文列出 {round.counts.dependencies} 条。</p><p>规则汇总 · 未做语义判断</p>{reopenAction ? <Button variant="ghost" className={s.secondary} isDisabled={pending} onPress={() => onAction(reopenAction)}>重新开启 48 小时</Button> : null}</section> : null}
      {confirmation ? <section className={s.section} aria-label="确认记录"><h3>确认记录</h3><p>{confirmation.byName} {monthDayTime(confirmation.at)} 确认本月 Mission Card。</p><p>跨人员依赖与协作核对：{confirmation.note}</p></section> : null}
      <p className={s.foot}>{draft ? "开放由拍板人决定；尚未开放时不收公开意见。" : discussing ? "想让大家看到的话，请发到事项群组。与 Agent 的私聊仅自己可见。" : confirmed ? "公开意见与来源保留可查，已确定后不再收留言。" : "截止后仍可评论与引用；留言会单独标注，不进这一轮集中 Review。"}</p>
    </div> : null}
    {round.closesAt && !confirmed ? <p className={s.deadline}>讨论截止 <time dateTime={round.closesAt}>{monthDayTime(round.closesAt)}</time><span> · 拍板人 {round.deciderName}</span>{discussing && Date.parse(round.closesAt) - Date.parse(round.serverNow) < 21_600_000 ? <strong> · 最后 6 小时</strong> : null}</p> : null}
  </section>;
}
